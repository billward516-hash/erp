import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersForEmployees, usersWithPermission } from '../../platform/notify/notify.js';
import { transfer } from '../inventory/service.js';
import { assertCalibrated } from '../quality/calibration.js';
import { requireLicensed } from './service.js';

/**
 * Trucks and tools (SC-002 F4). Each vehicle has a stock location of its own, made with the vehicle. Parts used on a visit come off
 * that location through the normal stock ledger, so a truck cannot go below zero. A truck has a minimum and a par level per part: what
 * is at or under the minimum is on the restock list, and a restock is an ordinary transfer from a storeroom. Tools are assets of class
 * tool; one can be checked out to a technician only while its calibration is current, and a tool that goes out of calibration while on
 * a truck alerts its holder and the dispatchers.
 */
export async function ensureTruckLocation(tx: Tx, actor: Actor, vehicleId: string) {
  const v = await one(tx, `SELECT a.id, a.asset_tag, a.name, a.facility_id, p.truck_location_id FROM asset a JOIN vehicle_profile p ON p.asset_id = a.id WHERE a.id = $1 AND a.asset_class = 'vehicle'`, [vehicleId]);
  if (!v) throw notFound('vehicle');
  if (v.truck_location_id) return v.truck_location_id as string;
  const code = `TRK-${String(v.asset_tag).toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`.slice(0, 40);
  const l = await one(tx, `INSERT INTO stock_location (tenant_id, facility_id, code, name, kind) VALUES ($1, $2, $3, $4, 'truck') ON CONFLICT (tenant_id, code) DO UPDATE SET name = stock_location.name RETURNING id`, [actor.tenantId, v.facility_id, code, `${v.name} stock`]);
  await tx.query('UPDATE vehicle_profile SET truck_location_id = $2 WHERE asset_id = $1', [vehicleId, l.id]);
  return l.id as string;
}

async function truck(tx: Tx, actor: Actor, vehicleId: string, perm: 'fieldservice.view' | 'fieldservice.manage' = 'fieldservice.view') {
  const v = await one(tx, `SELECT a.id, a.asset_tag, a.name, a.facility_id, p.truck_location_id, l.code AS location_code FROM asset a JOIN vehicle_profile p ON p.asset_id = a.id LEFT JOIN stock_location l ON l.id = p.truck_location_id WHERE a.id = $1`, [vehicleId]);
  if (!v) throw notFound('vehicle');
  requirePermission(actor, perm, v.facility_id);
  return v;
}

export async function truckStock(tx: Tx, actor: Actor, vehicleId: string) {
  const v = await truck(tx, actor, vehicleId);
  if (!v.truck_location_id) return { vehicle: v, parts: [] };
  const parts = await many(tx, `SELECT b.part_id, p.part_number, p.description, p.uom, b.qty_on_hand::float AS qty, b.reorder_point::float AS min, b.reorder_qty::float AS par,
      (b.reorder_point IS NOT NULL AND b.qty_on_hand <= b.reorder_point) AS low FROM inventory_balance b JOIN part p ON p.id = b.part_id WHERE b.location_id = $1 ORDER BY p.part_number`, [v.truck_location_id]);
  return { vehicle: v, parts };
}

/** Minimum (restock when at or under) and par (restock up to) for a part on a truck. */
export async function setTruckLevel(tx: Tx, actor: Actor, vehicleId: string, partId: string, input: { min: number; par: number }) {
  const v = await truck(tx, actor, vehicleId, 'fieldservice.manage');
  if (!v.truck_location_id) throw invalid('the vehicle has no truck stock yet');
  if (!(input.min >= 0) || !(input.par > input.min)) throw invalid('the par level must be above the minimum');
  if (!(await one(tx, 'SELECT 1 FROM part WHERE id = $1', [partId]))) throw notFound('part');
  await tx.query(`INSERT INTO inventory_balance (tenant_id, facility_id, location_id, part_id, reorder_point, reorder_qty) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (location_id, part_id) DO UPDATE SET reorder_point = EXCLUDED.reorder_point, reorder_qty = EXCLUDED.reorder_qty, updated_at = now()`, [actor.tenantId, v.facility_id, v.truck_location_id, partId, input.min, input.par]);
  await audit(tx, actor, { action: 'truck.level_set', entityType: 'asset', entityId: vehicleId, facilityId: v.facility_id, data: { partId, ...input } });
}

/** Every truck's shortfalls with what the storerooms at the same site could supply. */
export async function restockList(tx: Tx, actor: Actor) {
  requirePermission(actor, 'fieldservice.view');
  const rows = await many(tx, `SELECT a.id AS vehicle_id, a.asset_tag, a.facility_id, b.part_id, p.part_number, p.description, b.qty_on_hand::float AS qty, b.reorder_point::float AS min, b.reorder_qty::float AS par,
      (b.reorder_qty - b.qty_on_hand)::float AS needed,
      coalesce((SELECT sum(x.qty_on_hand) FROM inventory_balance x JOIN stock_location sl ON sl.id = x.location_id WHERE x.part_id = b.part_id AND sl.facility_id = a.facility_id AND sl.kind <> 'truck'), 0)::float AS in_storerooms
    FROM vehicle_profile vp JOIN asset a ON a.id = vp.asset_id JOIN inventory_balance b ON b.location_id = vp.truck_location_id JOIN part p ON p.id = b.part_id
    WHERE b.reorder_point IS NOT NULL AND b.qty_on_hand <= b.reorder_point AND b.reorder_qty IS NOT NULL ORDER BY a.asset_tag, p.part_number`);
  return rows.filter((r) => can(actor, 'fieldservice.view', r.facility_id)).map((r) => ({ ...r, canSupply: Math.min(r.needed, r.in_storerooms) }));
}

export async function restockTruck(tx: Tx, actor: Actor, vehicleId: string, input: { fromLocationId: string; lines: { partId: string; qty: number }[] }) {
  const v = await truck(tx, actor, vehicleId);
  if (!v.truck_location_id) throw invalid('the vehicle has no truck stock yet');
  if (!input.lines.length) throw invalid('nothing to move');
  const ref = `RESTOCK-${v.asset_tag}-${new Date().toISOString().slice(0, 10)}`;
  for (const l of input.lines) await transfer(tx, actor, { fromLocationId: input.fromLocationId, toLocationId: v.truck_location_id, partId: l.partId, qty: l.qty, reference: ref });
  await audit(tx, actor, { action: 'truck.restocked', entityType: 'asset', entityId: vehicleId, facilityId: v.facility_id, data: { lines: input.lines.length, reference: ref } });
  return { reference: ref, lines: input.lines.length };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export async function checkoutTool(tx: Tx, actor: Actor, toolId: string, input: { employeeId?: string | null; vehicleId?: string | null; note?: string | null }) {
  const t = await one(tx, `SELECT id, asset_tag, name, facility_id, asset_class, operational_state FROM asset WHERE id = $1`, [toolId]);
  if (!t) throw notFound('tool');
  if (t.asset_class !== 'tool') throw invalid(`${t.asset_tag} is not a tool`);
  const employeeId = input.employeeId ?? actor.employeeId;
  if (!employeeId) throw invalid('choose who is taking the tool');
  if (employeeId !== actor.employeeId) requirePermission(actor, 'fieldservice.manage', t.facility_id); else requirePermission(actor, 'fieldservice.execute', t.facility_id);
  await requireLicensed(tx, t.facility_id);
  if (t.operational_state === 'out_of_service') throw conflict(`${t.asset_tag} is out of service`);
  await assertCalibrated(tx, toolId); // names the tool and its due date
  const failed = await one(tx, `SELECT r.as_left FROM calibration_record r JOIN calibration_plan p ON p.id = r.plan_id WHERE p.asset_id = $1 ORDER BY r.performed_on DESC, r.created_at DESC LIMIT 1`, [toolId]);
  if (failed?.as_left === 'failed') throw conflict(`${t.asset_tag} failed its last calibration`);
  const open = await one(tx, `SELECT e.first_name, e.last_name FROM tool_checkout c JOIN employee e ON e.id = c.employee_id WHERE c.asset_id = $1 AND c.returned_at IS NULL`, [toolId]);
  if (open) throw conflict(`${t.asset_tag} is already out with ${open.first_name} ${open.last_name}`);
  if (input.vehicleId && !(await one(tx, `SELECT 1 FROM asset WHERE id = $1 AND asset_class = 'vehicle'`, [input.vehicleId]))) throw invalid('choose a vehicle');
  const c = await one(tx, `INSERT INTO tool_checkout (tenant_id, facility_id, asset_id, employee_id, vehicle_id, checked_out_by, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [actor.tenantId, t.facility_id, toolId, employeeId, input.vehicleId ?? null, actor.userId, input.note ?? null]);
  await audit(tx, actor, { action: 'tool.checked_out', entityType: 'asset', entityId: toolId, facilityId: t.facility_id, data: { employeeId, vehicleId: input.vehicleId ?? null } });
  return c;
}

export async function returnTool(tx: Tx, actor: Actor, toolId: string, note?: string | null) {
  const c = await one(tx, 'SELECT c.*, a.asset_tag FROM tool_checkout c JOIN asset a ON a.id = c.asset_id WHERE c.asset_id = $1 AND c.returned_at IS NULL FOR UPDATE OF c', [toolId]);
  if (!c) throw conflict('that tool is not checked out');
  if (c.employee_id !== actor.employeeId) requirePermission(actor, 'fieldservice.manage', c.facility_id);
  await tx.query('UPDATE tool_checkout SET returned_at = now(), returned_by = $2, note = coalesce($3, note) WHERE id = $1', [c.id, actor.userId, note ?? null]);
  await audit(tx, actor, { action: 'tool.returned', entityType: 'asset', entityId: toolId, facilityId: c.facility_id, data: {} });
}

export async function listToolCheckouts(tx: Tx, actor: Actor, q: { open?: boolean } = {}) {
  requirePermission(actor, 'fieldservice.view');
  const rows = await many(tx, `SELECT c.id, c.asset_id, a.asset_tag, a.name AS tool_name, c.employee_id, e.first_name, e.last_name, c.vehicle_id, v.asset_tag AS vehicle_tag, c.checked_out_at, c.returned_at, c.facility_id,
      cp.next_due AS calibration_due, (cp.next_due IS NOT NULL AND cp.next_due < current_date) AS calibration_overdue
    FROM tool_checkout c JOIN asset a ON a.id = c.asset_id JOIN employee e ON e.id = c.employee_id LEFT JOIN asset v ON v.id = c.vehicle_id LEFT JOIN calibration_plan cp ON cp.asset_id = c.asset_id AND cp.active
    WHERE (NOT $1 OR c.returned_at IS NULL) ORDER BY c.checked_out_at DESC LIMIT 300`, [q.open ?? false]);
  return rows.filter((r) => can(actor, 'fieldservice.view', r.facility_id));
}

export async function listTools(tx: Tx, actor: Actor) {
  requirePermission(actor, 'fieldservice.view');
  const rows = await many(tx, `SELECT a.id, a.asset_tag, a.name, a.facility_id, a.operational_state, cp.next_due AS calibration_due,
      (cp.next_due IS NOT NULL AND cp.next_due < current_date) AS calibration_overdue,
      (SELECT e.first_name || ' ' || e.last_name FROM tool_checkout c JOIN employee e ON e.id = c.employee_id WHERE c.asset_id = a.id AND c.returned_at IS NULL) AS held_by
    FROM asset a LEFT JOIN calibration_plan cp ON cp.asset_id = a.id AND cp.active WHERE a.asset_class = 'tool' AND a.lifecycle_status = 'active' ORDER BY a.asset_tag`);
  return rows.filter((r) => can(actor, 'fieldservice.view', r.facility_id));
}

/** Daily: a tool that went out of calibration while checked out alerts its holder and the dispatchers, once per due date. */
export async function sweepToolCalibration(tx: Tx, tenantId: string) {
  const rows = await many(tx, `SELECT c.employee_id, a.id AS asset_id, a.asset_tag, a.facility_id, cp.next_due FROM tool_checkout c JOIN asset a ON a.id = c.asset_id JOIN calibration_plan cp ON cp.asset_id = a.id AND cp.active
    WHERE c.returned_at IS NULL AND cp.next_due < current_date`);
  let n = 0;
  for (const r of rows) {
    const holder = (await usersForEmployees(tx, [r.employee_id])).get(r.employee_id);
    const managers = await usersWithPermission(tx, 'fieldservice.manage', r.facility_id);
    n += await notify(tx, tenantId, [holder, ...managers], { kind: 'service.tool_calibration', title: `${r.asset_tag} is out of calibration and still checked out`, body: `Due ${new Date(r.next_due).toISOString().slice(0, 10)}. Stop using it and return it for calibration.`,
      link: '/service/tools', subjectType: 'asset', subjectId: r.asset_id, dedupeKey: `tool-cal:${r.asset_id}:${new Date(r.next_due).toISOString().slice(0, 10)}` });
  }
  void forbidden;
  return n;
}
