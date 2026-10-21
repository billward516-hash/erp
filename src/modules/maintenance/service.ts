import { assertWeekOpen } from '../time/service.js';
import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import type { Permission } from '../../platform/auth/permissions.js';
import { audit, auditHistory } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { recordState } from '../assets/service.js';
import { assertAssetQualified } from '../learning/qualifications.js';
import { postTxn } from '../inventory/service.js';
import { advancePlanOnCompletion } from '../pm/schedule.js';

export const WO_STATUSES = ['planned', 'scheduled', 'in_progress', 'on_hold', 'completed', 'verified', 'closed', 'cancelled'] as const;
export type WoStatus = (typeof WO_STATUSES)[number];

/** Allowed transitions and the permission each requires. */
export const TRANSITIONS: Record<WoStatus, Partial<Record<WoStatus, Permission>>> = {
  planned: { scheduled: 'work_orders.manage', in_progress: 'work_orders.execute', on_hold: 'work_orders.manage', cancelled: 'work_orders.manage' },
  scheduled: { planned: 'work_orders.manage', in_progress: 'work_orders.execute', on_hold: 'work_orders.manage', cancelled: 'work_orders.manage' },
  in_progress: { on_hold: 'work_orders.execute', completed: 'work_orders.execute' },
  on_hold: { in_progress: 'work_orders.execute', scheduled: 'work_orders.manage', cancelled: 'work_orders.manage' },
  // Verification is the return-to-service authorization; a failed verification reopens the work.
  completed: { verified: 'work_orders.verify', in_progress: 'work_orders.verify' },
  verified: { closed: 'work_orders.manage' },
  closed: {},
  cancelled: {},
};

export const OPEN_STATUSES: WoStatus[] = ['planned', 'scheduled', 'in_progress', 'on_hold', 'completed'];

export async function createRequest(
  tx: Tx, actor: Actor,
  input: { assetId: string; symptom: string; severity: 'low' | 'medium' | 'high' | 'critical'; safetyImpact?: boolean; assetDown?: boolean },
) {
  const asset = await one(tx, 'SELECT id, facility_id FROM asset WHERE id = $1', [input.assetId]);
  if (!asset) throw notFound('asset');
  requirePermission(actor, 'work_orders.request', asset.facility_id);
  const req = await one(
    tx,
    `INSERT INTO maintenance_request (tenant_id, facility_id, asset_id, requested_by, symptom, severity, safety_impact, asset_down)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [actor.tenantId, asset.facility_id, asset.id, actor.userId, input.symptom, input.severity, input.safetyImpact ?? false, input.assetDown ?? false],
  );
  await audit(tx, actor, { action: 'maintenance_request.created', entityType: 'maintenance_request', entityId: req.id,
    facilityId: asset.facility_id, data: { assetId: asset.id, severity: input.severity, assetDown: req.asset_down } });
  return req;
}

export interface WorkOrderInput {
  assetId: string;
  title: string;
  description?: string | null;
  woType?: 'corrective' | 'preventive' | 'inspection' | 'other';
  priority?: 1 | 2 | 3 | 4;
  safetyNotes?: string | null;
  dueAt?: string | null;
  estimatedLaborHours?: number | null;
  requestId?: string | null;
}

export async function createWorkOrder(tx: Tx, actor: Actor, input: WorkOrderInput) {
  const asset = await one(tx, 'SELECT id, facility_id FROM asset WHERE id = $1', [input.assetId]);
  if (!asset) throw notFound('asset');
  requirePermission(actor, 'work_orders.manage', asset.facility_id);
  let request: any;
  if (input.requestId) {
    request = await one(tx, 'SELECT * FROM maintenance_request WHERE id = $1 FOR UPDATE', [input.requestId]);
    if (!request) throw notFound('maintenance request');
    if (request.status !== 'open') throw conflict(`request is already ${request.status}`);
    if (request.asset_id !== asset.id) throw invalid('request and work order must reference the same asset');
  }
  const number = `WO-${String(await nextSequence(tx, actor.tenantId, 'work_order')).padStart(6, '0')}`;
  const priority = input.priority ?? (request ? ({ critical: 1, high: 2, medium: 3, low: 4 } as const)[request.severity as 'low'] : 3);
  const wo = await one(
    tx,
    `INSERT INTO work_order (tenant_id, facility_id, number, asset_id, request_id, wo_type, priority, title, description,
       safety_notes, due_at, estimated_labor_hours, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [actor.tenantId, asset.facility_id, number, asset.id, input.requestId ?? null, input.woType ?? 'corrective', priority,
      input.title, input.description ?? null, input.safetyNotes ?? null, input.dueAt ?? null, input.estimatedLaborHours ?? null, actor.userId],
  );
  if (request) {
    await tx.query(`UPDATE maintenance_request SET status = 'converted' WHERE id = $1`, [request.id]);
    if (request.asset_down && can(actor, 'assets.record_state', asset.facility_id)) {
      const { eventId } = await recordState(tx, actor, asset.id, { state: 'unplanned_downtime', at: request.created_at,
        reasonCode: null, note: `${number}: ${request.symptom}`, source: 'work_order' });
      await tx.query('UPDATE work_order SET downtime_event_id = $2 WHERE id = $1', [wo.id, eventId]);
    }
  }
  await audit(tx, actor, { action: 'work_order.created', entityType: 'work_order', entityId: wo.id, facilityId: wo.facility_id,
    data: { number, assetId: asset.id, requestId: input.requestId ?? null, priority } });
  return wo;
}

async function lockWorkOrder(tx: Tx, id: string) {
  const wo = await one(tx, 'SELECT * FROM work_order WHERE id = $1 FOR UPDATE', [id]);
  if (!wo) throw notFound('work order');
  return wo;
}

export async function transitionWorkOrder(
  tx: Tx, actor: Actor, id: string,
  input: { to: WoStatus; note?: string; remedy?: string; findings?: string; failureCode?: string; causeCode?: string; returnToService?: boolean },
) {
  const wo = await lockWorkOrder(tx, id);
  const from = wo.status as WoStatus;
  const permission = TRANSITIONS[from][input.to];
  if (!permission) throw conflict(`cannot move work order from ${from} to ${input.to}`);
  requirePermission(actor, permission, wo.facility_id);

  const sets: string[] = ['status = $2'];
  const vals: unknown[] = [id, input.to];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  if (input.to === 'in_progress') {
    // Re-check at the start of work: a qualification may have expired or been revoked since assignment.
    const techs = await many(tx, 'SELECT employee_id FROM work_order_assignment WHERE work_order_id = $1', [id]);
    for (const t of techs) await assertAssetQualified(tx, t.employee_id, wo.asset_id, 'maintain');
    if (!wo.started_at) set('started_at', new Date());
  }
  if (input.to === 'completed') {
    const remedy = input.remedy ?? wo.remedy;
    if (wo.wo_type === 'corrective' && !remedy) throw invalid('corrective work orders require a remedy before completion');
    const labor = await one(tx, 'SELECT count(*)::int AS n FROM work_order_labor WHERE work_order_id = $1', [id]);
    if (!labor?.n) throw invalid('record at least one labor entry before completion');
    set('completed_at', new Date());
    set('completed_by', actor.userId);
  }
  if (input.to === 'verified') {
    if (wo.completed_by === actor.userId) throw invalid('verification must be performed by someone other than the person who completed the work');
    set('verified_at', new Date());
    set('verified_by', actor.userId);
  }
  if (input.to === 'in_progress' && from === 'completed') { set('completed_at', null); set('completed_by', null); }
  if (input.to === 'closed') set('closed_at', new Date());
  if (input.remedy !== undefined) set('remedy', input.remedy);
  if (input.findings !== undefined) set('findings', input.findings);
  if (input.failureCode !== undefined) set('failure_code', input.failureCode);
  if (input.causeCode !== undefined) set('cause_code', input.causeCode);

  const updated = await one(tx, `UPDATE work_order SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);

  // A verified preventive work order moves its PM plan to the next due date or reading.
  if (input.to === 'verified' && wo.pm_plan_id) await advancePlanOnCompletion(tx, { ...wo, completed_at: wo.completed_at ?? new Date() });

  // Return to service: verification ends WO-driven downtime by setting the asset available.
  if (input.to === 'verified' && input.returnToService !== false) {
    const asset = await one(tx, 'SELECT operational_state FROM asset WHERE id = $1', [wo.asset_id]);
    if (['unplanned_downtime', 'planned_downtime', 'out_of_service'].includes(asset.operational_state)) {
      await recordState(tx, actor, wo.asset_id, { state: 'available', note: `Returned to service via ${wo.number}`, source: 'work_order' });
    }
  }
  await audit(tx, actor, { action: 'work_order.status_changed', entityType: 'work_order', entityId: id, facilityId: wo.facility_id,
    data: { from, to: input.to, note: input.note ?? null } });
  return updated;
}

export async function assignTechnician(tx: Tx, actor: Actor, id: string, employeeId: string, role: 'lead' | 'technician' = 'technician') {
  const wo = await lockWorkOrder(tx, id);
  requirePermission(actor, 'work_orders.manage', wo.facility_id);
  if (!OPEN_STATUSES.includes(wo.status)) throw conflict(`work order is ${wo.status}`);
  const emp = await one(tx, 'SELECT id, status, facility_id FROM employee WHERE id = $1', [employeeId]);
  if (!emp || emp.status !== 'active') throw invalid('technician must be an active employee visible to you');
  // Restricted equipment: the technician must hold every 'maintain' qualification, current today.
  await assertAssetQualified(tx, employeeId, wo.asset_id, 'maintain');
  await tx.query(
    `INSERT INTO work_order_assignment (tenant_id, work_order_id, employee_id, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (work_order_id, employee_id) DO UPDATE SET role = excluded.role`,
    [actor.tenantId, id, employeeId, role],
  );
  await audit(tx, actor, { action: 'work_order.assigned', entityType: 'work_order', entityId: id, facilityId: wo.facility_id, data: { employeeId, role } });
}

export async function addLabor(
  tx: Tx, actor: Actor, id: string,
  input: { employeeId?: string; workDate: string; hours: number; hourlyRate?: number | null; note?: string },
) {
  const wo = await lockWorkOrder(tx, id);
  requirePermission(actor, 'work_orders.execute', wo.facility_id);
  if (!['in_progress', 'on_hold'].includes(wo.status)) throw conflict('labor can only be recorded while work is in progress or on hold');
  const employeeId = input.employeeId ?? actor.employeeId;
  if (!employeeId) throw invalid('employeeId is required (your user is not linked to an employee record)');
  if (employeeId !== actor.employeeId && !can(actor, 'work_orders.manage', wo.facility_id)) {
    throw invalid('only planners/managers may record labor for someone else');
  }
  await assertAssetQualified(tx, employeeId, wo.asset_id, 'maintain');
  await assertWeekOpen(tx, employeeId, input.workDate);
  const row = await one(
    tx,
    `INSERT INTO work_order_labor (tenant_id, work_order_id, employee_id, work_date, hours, hourly_rate, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [actor.tenantId, id, employeeId, input.workDate, input.hours, input.hourlyRate ?? null, input.note ?? null, actor.userId],
  );
  await audit(tx, actor, { action: 'work_order.labor_recorded', entityType: 'work_order', entityId: id, facilityId: wo.facility_id,
    data: { laborId: row.id, employeeId, hours: input.hours } });
  return row;
}

/** Adds a planned part line, or records actual usage (optionally as an approved substitute). */
/**
 * Adds a planned part line, or records actual usage (optionally as an approved substitute).
 * Usage of a stocked part is issued from a storeroom at the work order's facility through the stock
 * ledger, so on-hand quantities stay true. Non-stock items (no storeroom record at this facility,
 * e.g. bought for the job) are recorded without a stock movement.
 */
export async function addPart(
  tx: Tx, actor: Actor, id: string,
  input: { partId: string; qtyPlanned?: number; qtyUsed?: number; substituteForPartId?: string | null; note?: string; locationId?: string | null },
) {
  const wo = await lockWorkOrder(tx, id);
  const usage = (input.qtyUsed ?? 0) > 0;
  requirePermission(actor, usage ? 'work_orders.execute' : 'work_orders.manage', wo.facility_id);
  if (!OPEN_STATUSES.includes(wo.status) || wo.status === 'completed') throw conflict(`work order is ${wo.status}`);
  const part = await one(tx, 'SELECT id, unit_cost, active FROM part WHERE id = $1', [input.partId]);
  if (!part || !part.active) throw invalid('part not found or inactive');
  if (input.locationId) {
    const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [input.locationId]);
    if (!loc || loc.facility_id !== wo.facility_id) throw invalid('issue from a storeroom at the work order\'s facility');
  } else if (usage && (await one(tx, 'SELECT 1 FROM inventory_balance WHERE part_id = $1 AND facility_id = $2', [part.id, wo.facility_id]))) {
    throw invalid('this part is stocked at this facility; choose the storeroom it was taken from');
  }
  const row = await one(
    tx,
    `INSERT INTO work_order_part (tenant_id, work_order_id, part_id, substitute_for_part_id, qty_planned, qty_used, unit_cost, note, location_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, id, part.id, input.substituteForPartId ?? null, input.qtyPlanned ?? 0, input.qtyUsed ?? 0, part.unit_cost, input.note ?? null, input.locationId ?? null],
  );
  if (usage && input.locationId) {
    await postTxn(tx, actor, { locationId: input.locationId, partId: part.id, type: 'issue', qty: -(input.qtyUsed as number), workOrderId: id, reference: wo.number });
  }
  await audit(tx, actor, { action: usage ? 'work_order.part_used' : 'work_order.part_planned', entityType: 'work_order', entityId: id,
    facilityId: wo.facility_id, data: { lineId: row.id, partId: part.id, qtyPlanned: row.qty_planned, qtyUsed: row.qty_used,
      substituteForPartId: input.substituteForPartId ?? null, locationId: input.locationId ?? null } });
  return row;
}

/** Returns unused parts from a work order back to the storeroom they were issued from. */
export async function returnPart(tx: Tx, actor: Actor, lineId: string, qty: number) {
  const line = await one(tx, `SELECT x.*, w.facility_id, w.status, w.number FROM work_order_part x JOIN work_order w ON w.id = x.work_order_id WHERE x.id = $1 FOR UPDATE OF x`, [lineId]);
  if (!line) throw notFound('work order part line');
  requirePermission(actor, 'work_orders.execute', line.facility_id);
  if (['closed', 'cancelled'].includes(line.status)) throw conflict(`work order is ${line.status}`);
  if (!(qty > 0) || qty > Number(line.qty_used)) throw invalid(`you can return between 0 and ${line.qty_used}`);
  if (!line.location_id) throw invalid('this line was not issued from a storeroom');
  await tx.query('UPDATE work_order_part SET qty_used = qty_used - $2 WHERE id = $1', [lineId, qty]);
  await postTxn(tx, actor, { locationId: line.location_id, partId: line.part_id, type: 'return', qty, workOrderId: line.work_order_id, reference: line.number });
  await audit(tx, actor, { action: 'work_order.part_returned', entityType: 'work_order', entityId: line.work_order_id, facilityId: line.facility_id, data: { lineId, qty } });
}

/** Pins the exact approved procedure version used for this work (kept even after later revisions). */
export async function attachProcedure(tx: Tx, actor: Actor, id: string, documentVersionId: string) {
  const wo = await lockWorkOrder(tx, id);
  requirePermission(actor, 'work_orders.manage', wo.facility_id);
  const v = await one(tx, `SELECT v.id, v.status, d.restricted FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1`, [documentVersionId]);
  if (!v) throw notFound('document version');
  if (v.status !== 'approved') throw invalid('only approved procedure versions can be attached to work orders');
  await tx.query(
    `INSERT INTO work_order_document (tenant_id, work_order_id, document_version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [actor.tenantId, id, documentVersionId],
  );
  await audit(tx, actor, { action: 'work_order.procedure_attached', entityType: 'work_order', entityId: id, facilityId: wo.facility_id, data: { documentVersionId } });
}

export async function getWorkOrder(tx: Tx, actor: Actor, id: string) {
  const wo = await one(
    tx,
    `SELECT w.*, a.asset_tag, a.name AS asset_name, f.code AS facility_code,
            cu.display_name AS completed_by_name, vu.display_name AS verified_by_name
     FROM work_order w JOIN asset a ON a.id = w.asset_id JOIN facility f ON f.id = w.facility_id
     LEFT JOIN app_user cu ON cu.id = w.completed_by LEFT JOIN app_user vu ON vu.id = w.verified_by
     WHERE w.id = $1`,
    [id],
  );
  if (!wo) throw notFound('work order');
  requirePermission(actor, 'work_orders.view', wo.facility_id);
  const assignments = await many(tx, `SELECT e.id AS employee_id, e.employee_number, e.first_name || ' ' || e.last_name AS name, x.role
              FROM work_order_assignment x JOIN employee e ON e.id = x.employee_id WHERE x.work_order_id = $1`, [id]);
  const labor = await many(tx, `SELECT l.id, l.work_date, l.hours, l.hourly_rate, l.note, e.first_name || ' ' || e.last_name AS employee
              FROM work_order_labor l JOIN employee e ON e.id = l.employee_id WHERE l.work_order_id = $1 ORDER BY l.work_date`, [id]);
  const parts = await many(tx, `SELECT x.id, p.id AS part_id, p.part_number, p.description, p.uom, x.qty_planned, x.qty_used, x.unit_cost, sp.part_number AS substitute_for, x.location_id,
                (SELECT code FROM stock_location sl WHERE sl.id = x.location_id) AS location
              FROM work_order_part x JOIN part p ON p.id = x.part_id LEFT JOIN part sp ON sp.id = x.substitute_for_part_id
              WHERE x.work_order_id = $1 ORDER BY x.created_at`, [id]);
  // Purchasing for this job: request lines and their order/receipt state.
  const purchases = await many(tx, `SELECT rl.id, r.id AS request_id, r.number AS request_number, r.status AS request_status, rl.description, rl.qty, p.part_number,
                o.id AS order_id, o.number AS order_number, o.status AS order_status, o.expected_on, pl.qty_received
              FROM purchase_request_line rl JOIN purchase_request r ON r.id = rl.request_id LEFT JOIN part p ON p.id = rl.part_id
              LEFT JOIN purchase_order_line pl ON pl.request_line_id = rl.id AND EXISTS (SELECT 1 FROM purchase_order x WHERE x.id = pl.order_id AND x.status <> 'cancelled')
              LEFT JOIN purchase_order o ON o.id = pl.order_id
              WHERE (rl.work_order_id = $1 OR r.work_order_id = $1) AND r.status <> 'cancelled' ORDER BY r.created_at, rl.line_no`, [id]);
  const procedures = await many(tx, `SELECT v.id AS version_id, d.id AS document_id, d.doc_number, d.title, v.version_label, v.status
              FROM work_order_document x JOIN document_version v ON v.id = x.document_version_id JOIN document d ON d.id = v.document_id
              WHERE x.work_order_id = $1`, [id]);
  const history = await auditHistory(tx, 'work_order', id);
  const laborHours = labor.reduce((s, l) => s + Number(l.hours), 0);
  const laborCost = labor.every((l) => l.hourly_rate != null) ? labor.reduce((s, l) => s + l.hours * l.hourly_rate, 0) : null;
  const partsCost = parts.every((p) => p.unit_cost != null) ? parts.reduce((s, p) => s + p.qty_used * p.unit_cost, 0) : null;
  return {
    ...wo, assignments, labor, parts, procedures, history,
    purchases: can(actor, 'purchasing.view', wo.facility_id) ? purchases : [],
    // null = cost unknown because a rate/unit cost is missing (never silently treated as zero)
    costs: { laborHours, laborCost, partsCost, currency: 'USD' },
  };
}

export async function listWorkOrders(
  tx: Tx, actor: Actor,
  q: { facilityId?: string; status?: WoStatus[]; assetId?: string; openOnly?: boolean; assignedEmployeeId?: string; limit?: number },
) {
  requirePermission(actor, 'work_orders.view', q.facilityId);
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (q.facilityId) where.push(`w.facility_id = ${p(q.facilityId)}`);
  if (q.assetId) where.push(`w.asset_id = ${p(q.assetId)}`);
  if (q.status?.length) where.push(`w.status = ANY (${p(q.status)})`);
  if (q.openOnly) where.push(`w.status = ANY (${p(OPEN_STATUSES)})`);
  if (q.assignedEmployeeId) where.push(`EXISTS (SELECT 1 FROM work_order_assignment x WHERE x.work_order_id = w.id AND x.employee_id = ${p(q.assignedEmployeeId)})`);
  const rows = await many(
    tx,
    `SELECT w.id, w.number, w.facility_id, f.code AS facility_code, w.title, w.status, w.priority, w.wo_type, w.due_at,
            w.created_at, a.asset_tag, a.name AS asset_name, (w.due_at < now() AND w.status = ANY ($${params.length + 1})) AS overdue
     FROM work_order w JOIN asset a ON a.id = w.asset_id JOIN facility f ON f.id = w.facility_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY w.priority, w.due_at NULLS LAST, w.number LIMIT ${Math.min(q.limit ?? 200, 1000)}`,
    [...params, OPEN_STATUSES],
  );
  return rows.filter((r) => can(actor, 'work_orders.view', r.facility_id));
}
