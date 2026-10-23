import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { carried, postTxn } from '../inventory/service.js';
import { addPart, attachProcedure, returnPart } from '../maintenance/service.js';

const KIT = 'kit';
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const OPEN_WO = ['planned', 'scheduled', 'in_progress', 'on_hold'];

/**
 * Stock reserved by kits that are still waiting in their storeroom (virtual kits). Staged kits are already in
 * staging locations, which never count as available.
 */
const RESERVED = `(SELECT coalesce(sum(kl.qty_reserved - kl.qty_staged), 0) FROM kit_line kl JOIN kit k ON k.id = kl.kit_id
  WHERE kl.from_location_id = b.location_id AND kl.part_id = b.part_id AND k.status = 'reserved')`;

/** Available = on hand in storerooms (not staging) − reserved by kits, per location. */
export async function availabilityByLocation(tx: Tx, facilityId: string, partId: string) {
  return many(tx, `SELECT b.location_id, l.code AS location, b.qty_on_hand::float AS on_hand, ${RESERVED}::float AS reserved, (b.qty_on_hand - ${RESERVED})::float AS available
    FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id
    WHERE b.facility_id = $1 AND b.part_id = $2 AND l.kind = 'storeroom' AND l.active ORDER BY (b.qty_on_hand - ${RESERVED}) DESC, l.code`, [facilityId, partId]);
}

/** Site-level availability for several parts (used by production and the reorder report). */
export async function availableAtSite(tx: Tx, facilityId: string, partIds: string[]) {
  const rows = await many(tx, `SELECT b.part_id, sum(b.qty_on_hand)::float AS on_hand, sum(${RESERVED})::float AS reserved
    FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id WHERE b.facility_id = $1 AND b.part_id = ANY ($2) AND l.kind = 'storeroom' GROUP BY b.part_id`, [facilityId, partIds]);
  return new Map(rows.map((r) => [r.part_id as string, { onHand: r.on_hand as number, reserved: r.reserved as number, available: r3(r.on_hand - r.reserved) }]));
}

// ---------------------------------------------------------------------------
// Equipment parts lists (spares per machine)
// ---------------------------------------------------------------------------

export async function listAssetParts(tx: Tx, actor: Actor, assetId: string) {
  const a = await one(tx, 'SELECT id, facility_id FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'assets.view', a.facility_id);
  const rows = await many(tx, `SELECT ap.part_id, p.part_number, p.description, p.uom, p.unit_cost::float AS unit_cost, ap.qty_installed::float AS qty_installed, ap.position, ap.critical,
      ap.min_on_hand::float AS min_on_hand, ap.notes,
      (SELECT string_agg(DISTINCT a2.asset_tag, ', ') FROM asset_part x JOIN asset a2 ON a2.id = x.asset_id WHERE x.part_id = ap.part_id AND x.asset_id <> ap.asset_id) AS also_used_on
    FROM asset_part ap JOIN part p ON p.id = ap.part_id WHERE ap.asset_id = $1 ORDER BY ap.critical DESC, p.part_number`, [assetId]);
  const avail = await availableAtSite(tx, a.facility_id, rows.map((r) => r.part_id));
  return rows.map((r) => {
    const s = avail.get(r.part_id) ?? { onHand: 0, reserved: 0, available: 0 };
    return { ...r, on_hand: s.onHand, available: s.available, below_min: r.critical && s.available < (r.min_on_hand ?? 1) };
  });
}

export async function saveAssetPart(tx: Tx, actor: Actor, assetId: string, input: { partId: string; qtyInstalled?: number; position?: string | null; critical?: boolean; minOnHand?: number | null; notes?: string | null }) {
  const a = await one(tx, 'SELECT facility_id, asset_tag FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'assets.manage', a.facility_id);
  if (!(await one(tx, 'SELECT 1 FROM part WHERE id = $1 AND active', [input.partId]))) throw invalid('part not found or inactive');
  if (input.qtyInstalled != null && !(input.qtyInstalled > 0)) throw invalid('quantity installed must be positive');
  await tx.query(`INSERT INTO asset_part (tenant_id, asset_id, part_id, qty_installed, position, critical, min_on_hand, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (asset_id, part_id) DO UPDATE SET qty_installed = EXCLUDED.qty_installed, position = EXCLUDED.position, critical = EXCLUDED.critical, min_on_hand = EXCLUDED.min_on_hand, notes = EXCLUDED.notes`,
  [actor.tenantId, assetId, input.partId, input.qtyInstalled ?? 1, input.position ?? null, input.critical ?? false, input.minOnHand ?? null, input.notes ?? null]);
  await audit(tx, actor, { action: 'asset.part_listed', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: input });
}

export async function removeAssetPart(tx: Tx, actor: Actor, assetId: string, partId: string) {
  const a = await one(tx, 'SELECT facility_id FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'assets.manage', a.facility_id);
  await tx.query('DELETE FROM asset_part WHERE asset_id = $1 AND part_id = $2', [assetId, partId]);
  await audit(tx, actor, { action: 'asset.part_unlisted', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { partId } });
}

/** Machines a part is installed on (for "where used" on the part and storeroom pages). */
export async function partWhereUsed(tx: Tx, actor: Actor, partId: string) {
  requirePermission(actor, 'parts.view');
  const rows = await many(tx, `SELECT a.id, a.asset_tag, a.name, a.facility_id, f.code AS facility_code, ap.qty_installed::float AS qty_installed, ap.position, ap.critical
    FROM asset_part ap JOIN asset a ON a.id = ap.asset_id JOIN facility f ON f.id = a.facility_id WHERE ap.part_id = $1 ORDER BY a.asset_tag`, [partId]);
  return rows.filter((r) => can(actor, 'assets.view', r.facility_id));
}

// ---------------------------------------------------------------------------
// Repair templates (repair BOM + labor estimate for a known job)
// ---------------------------------------------------------------------------

export async function listTemplates(tx: Tx, actor: Actor, q: { assetId?: string } = {}) {
  requirePermission(actor, 'work_orders.view');
  const asset = q.assetId ? await one(tx, 'SELECT id, category FROM asset WHERE id = $1', [q.assetId]) : null;
  return many(tx, `SELECT t.*, t.est_labor_hours::float AS est_labor_hours, a.asset_tag, d.title AS procedure_title,
      coalesce((SELECT json_agg(json_build_object('part_id', tp.part_id, 'part_number', p.part_number, 'description', p.description, 'qty', tp.qty::float, 'uom', p.uom, 'unit_cost', p.unit_cost::float) ORDER BY p.part_number)
        FROM repair_template_part tp JOIN part p ON p.id = tp.part_id WHERE tp.template_id = t.id), '[]') AS parts
    FROM repair_template t LEFT JOIN asset a ON a.id = t.asset_id LEFT JOIN document d ON d.id = t.procedure_document_id
    WHERE t.active AND ($1::uuid IS NULL OR t.asset_id = $1 OR (t.asset_id IS NULL AND lower(t.asset_category) = lower($2)))
    ORDER BY t.code`, [asset?.id ?? null, asset?.category ?? '']);
}

export async function saveTemplate(tx: Tx, actor: Actor, input: { id?: string; code: string; title: string; assetId?: string | null; assetCategory?: string | null;
  procedureDocumentId?: string | null; estLaborHours?: number | null; notes?: string | null; parts: { partId: string; qty: number }[] }) {
  requirePermission(actor, 'work_orders.manage');
  if (!input.code?.trim() || !input.title?.trim()) throw invalid('a code and a title are required');
  if (!input.assetId && !input.assetCategory?.trim()) throw invalid('the template applies to a machine or to an asset category');
  if (input.assetId) {
    const a = await one(tx, 'SELECT facility_id FROM asset WHERE id = $1', [input.assetId]);
    if (!a) throw notFound('asset');
    requirePermission(actor, 'work_orders.manage', a.facility_id);
  }
  const seen = new Set<string>();
  for (const p of input.parts) {
    if (seen.has(p.partId)) throw invalid('a part is listed twice; combine the quantities');
    seen.add(p.partId);
    if (!(p.qty > 0)) throw invalid('quantities must be positive');
  }
  const t = input.id
    ? await one(tx, `UPDATE repair_template SET code = $2, title = $3, asset_id = $4, asset_category = $5, procedure_document_id = $6, est_labor_hours = $7, notes = $8 WHERE id = $1 RETURNING *`,
      [input.id, input.code.trim(), input.title.trim(), input.assetId ?? null, input.assetCategory ?? null, input.procedureDocumentId ?? null, input.estLaborHours ?? null, input.notes ?? null])
    : await one(tx, `INSERT INTO repair_template (tenant_id, code, title, asset_id, asset_category, procedure_document_id, est_labor_hours, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, input.code.trim(), input.title.trim(), input.assetId ?? null, input.assetCategory ?? null, input.procedureDocumentId ?? null, input.estLaborHours ?? null, input.notes ?? null, actor.userId]);
  if (!t) throw notFound('repair template');
  await tx.query('DELETE FROM repair_template_part WHERE template_id = $1', [t.id]);
  for (const p of input.parts) await tx.query('INSERT INTO repair_template_part (tenant_id, template_id, part_id, qty) VALUES ($1, $2, $3, $4)', [actor.tenantId, t.id, p.partId, p.qty]);
  await audit(tx, actor, { action: 'repair_template.saved', entityType: 'repair_template', entityId: t.id, data: { code: t.code, parts: input.parts.length } });
  return t;
}

/**
 * Applies a repair template to a work order: its parts become planned parts (the reference BOM; actual
 * use is still recorded separately), the labor estimate fills in if empty, and its procedure is attached.
 */
export async function applyTemplate(tx: Tx, actor: Actor, workOrderId: string, templateId: string) {
  const wo = await one(tx, 'SELECT id, facility_id, asset_id, status, estimated_labor_hours FROM work_order WHERE id = $1', [workOrderId]);
  if (!wo) throw notFound('work order');
  requirePermission(actor, 'work_orders.manage', wo.facility_id);
  const t = (await listTemplates(tx, actor, { assetId: wo.asset_id })).find((x) => x.id === templateId);
  if (!t) throw invalid('the template does not apply to this work order\'s asset');
  const planned = new Map((await many(tx, 'SELECT part_id FROM work_order_part WHERE work_order_id = $1 AND qty_planned > 0', [workOrderId])).map((r) => [r.part_id as string, true]));
  let added = 0;
  for (const p of t.parts) {
    if (planned.has(p.part_id)) continue;
    await addPart(tx, actor, workOrderId, { partId: p.part_id, qtyPlanned: p.qty, note: `From repair template ${t.code}` });
    added++;
  }
  if (t.est_labor_hours != null && wo.estimated_labor_hours == null) await tx.query('UPDATE work_order SET estimated_labor_hours = $2 WHERE id = $1', [workOrderId, t.est_labor_hours]);
  if (t.procedure_document_id) {
    const doc = await one(tx, 'SELECT current_version_id FROM document WHERE id = $1', [t.procedure_document_id]);
    const already = doc?.current_version_id && await one(tx, 'SELECT 1 FROM work_order_document WHERE work_order_id = $1 AND document_version_id = $2', [workOrderId, doc.current_version_id]);
    if (doc?.current_version_id && !already) await attachProcedure(tx, actor, workOrderId, doc.current_version_id);
  }
  await tx.query('UPDATE work_order SET repair_template_id = $2 WHERE id = $1', [workOrderId, templateId]);
  await audit(tx, actor, { action: 'work_order.template_applied', entityType: 'work_order', entityId: workOrderId, facilityId: wo.facility_id, data: { template: t.code, partsAdded: added } });
  return { added };
}

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------

async function lockKit(tx: Tx, id: string) {
  const k = await one(tx, 'SELECT k.*, w.number AS wo_number, w.status AS wo_status FROM kit k JOIN work_order w ON w.id = k.work_order_id WHERE k.id = $1 FOR UPDATE OF k', [id]);
  if (!k) throw notFound('kit');
  return k;
}

/**
 * Builds the kit for a work order from its planned parts not yet used, reserving stock in the storeroom that
 * has the most available. Lines that cannot be fully reserved are short; the kit still exists so the gap shows.
 */
export async function createKit(tx: Tx, actor: Actor, workOrderId: string, input: { neededBy?: Date | null } = {}) {
  const wo = await one(tx, 'SELECT id, number, facility_id, status, due_at FROM work_order WHERE id = $1 FOR UPDATE', [workOrderId]);
  if (!wo) throw notFound('work order');
  requirePermission(actor, 'work_orders.manage', wo.facility_id);
  if (!OPEN_WO.includes(wo.status)) throw conflict(`work order is ${wo.status}`);
  if (await one(tx, `SELECT 1 FROM kit WHERE work_order_id = $1 AND status NOT IN ('closed', 'cancelled')`, [workOrderId])) throw conflict('this work order already has a kit');
  const lines = await many(tx, `SELECT x.id, x.part_id, (x.qty_planned - x.qty_used)::float AS need FROM work_order_part x
    WHERE x.work_order_id = $1 AND x.qty_planned > x.qty_used AND EXISTS (SELECT 1 FROM inventory_balance b WHERE b.part_id = x.part_id AND b.facility_id = $2)`, [workOrderId, wo.facility_id]);
  // Parts already used without a planned line (or as a substitute for one) come off the planned lines first (D-161).
  const direct = new Map((await many(tx, `SELECT coalesce(substitute_for_part_id, part_id) AS part_id, sum(qty_used)::float AS used FROM work_order_part
    WHERE work_order_id = $1 AND qty_planned = 0 AND qty_used > 0 GROUP BY 1`, [workOrderId])).map((r) => [r.part_id as string, r.used as number]));
  for (const l of lines) {
    const take = Math.min(l.need, direct.get(l.part_id) ?? 0);
    if (take > 0) { l.need = r3(l.need - take); direct.set(l.part_id, (direct.get(l.part_id) ?? 0) - take); }
  }
  lines.splice(0, lines.length, ...lines.filter((l) => l.need > 0));
  if (!lines.length) throw invalid('nothing to kit: no planned parts that are stocked at this site');
  const number = `KIT-${String(await nextSequence(tx, actor.tenantId, 'kit')).padStart(6, '0')}`;
  const neededBy = input.neededBy ?? (wo.due_at ? new Date(new Date(wo.due_at).getTime() - 86_400_000) : null);
  const k = await one(tx, `INSERT INTO kit (tenant_id, facility_id, number, work_order_id, needed_by, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [actor.tenantId, wo.facility_id, number, workOrderId, neededBy, actor.userId]);
  for (const l of lines) {
    const best = (await availabilityByLocation(tx, wo.facility_id, l.part_id))[0];
    const reserve = best ? r3(Math.max(0, Math.min(l.need, best.available))) : 0;
    await tx.query(`INSERT INTO kit_line (tenant_id, kit_id, work_order_part_id, part_id, qty_needed, from_location_id, qty_reserved) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actor.tenantId, k.id, l.id, l.part_id, l.need, reserve > 0 ? best!.location_id : best?.location_id ?? null, reserve]);
  }
  await audit(tx, actor, { action: 'kit.created', entityType: KIT, entityId: k.id, facilityId: k.facility_id, data: { number, workOrder: wo.number, lines: lines.length } });
  return k;
}

/** Tops up short lines from stock that has arrived since (receipts, returns), within the line's storeroom or the best one. */
export async function refreshKit(tx: Tx, actor: Actor, id: string) {
  const k = await lockKit(tx, id);
  requirePermission(actor, 'work_orders.manage', k.facility_id);
  if (k.status !== 'reserved') throw conflict(`kit is ${k.status}`);
  let filled = 0;
  for (const l of await many(tx, 'SELECT * FROM kit_line WHERE kit_id = $1 AND qty_reserved < qty_needed FOR UPDATE', [id])) {
    const avail = await availabilityByLocation(tx, k.facility_id, l.part_id);
    const loc = (l.qty_reserved > 0 ? avail.find((a) => a.location_id === l.from_location_id) : avail[0]);
    if (!loc || loc.available <= 0) continue;
    const add = r3(Math.min(Number(l.qty_needed) - Number(l.qty_reserved), loc.available));
    await tx.query('UPDATE kit_line SET qty_reserved = qty_reserved + $2, from_location_id = $3 WHERE id = $1', [l.id, add, loc.location_id]);
    filled++;
  }
  return { linesTopped: filled };
}

/**
 * Stages the kit: reserved stock moves from its storerooms into a staging location through the ledger (a
 * physical kit). Only fully reserved kits are staged, so a staged kit is always complete.
 */
export async function stageKit(tx: Tx, actor: Actor, id: string, stagingLocationId: string) {
  const k = await lockKit(tx, id);
  requirePermission(actor, 'inventory.manage', k.facility_id);
  if (k.status !== 'reserved') throw conflict(`kit is ${k.status}`);
  const loc = await one(tx, 'SELECT facility_id, kind, code FROM stock_location WHERE id = $1 AND active', [stagingLocationId]);
  if (!loc || loc.facility_id !== k.facility_id || loc.kind !== 'staging') throw invalid('choose a staging location at the kit\'s facility');
  const lines = await many(tx, 'SELECT * FROM kit_line WHERE kit_id = $1 FOR UPDATE', [id]);
  const short = lines.filter((l) => Number(l.qty_reserved) < Number(l.qty_needed));
  if (short.length) throw conflict(`the kit is short on ${short.length} line${short.length === 1 ? '' : 's'}; refresh it after stock arrives or issue it as a partial virtual kit`);
  for (const l of lines) {
    const moved = await postTxn(tx, actor, { locationId: l.from_location_id, partId: l.part_id, type: 'transfer_out', qty: -Number(l.qty_reserved), reference: k.number, workOrderId: k.work_order_id });
    await postTxn(tx, actor, { locationId: stagingLocationId, partId: l.part_id, type: 'transfer_in', qty: Number(l.qty_reserved), reference: k.number, workOrderId: k.work_order_id, lots: carried(moved.lots) });
    await tx.query('UPDATE kit_line SET qty_staged = qty_reserved WHERE id = $1', [l.id]);
  }
  await tx.query(`UPDATE kit SET status = 'staged', staging_location_id = $2, staged_by = $3, staged_at = now() WHERE id = $1`, [id, stagingLocationId, actor.userId]);
  await audit(tx, actor, { action: 'kit.staged', entityType: KIT, entityId: id, facilityId: k.facility_id, data: { staging: loc.code } });
}

/** Issues the kit to its work order: staged stock from the staging location, or reserved stock straight from the storeroom. */
export async function issueKit(tx: Tx, actor: Actor, id: string) {
  const k = await lockKit(tx, id);
  requirePermission(actor, 'work_orders.execute', k.facility_id);
  if (!['reserved', 'staged'].includes(k.status)) throw conflict(`kit is ${k.status}`);
  if (!OPEN_WO.includes(k.wo_status)) throw conflict(`work order is ${k.wo_status}`);
  let issued = 0;
  for (const l of await many(tx, 'SELECT * FROM kit_line WHERE kit_id = $1 FOR UPDATE', [id])) {
    const qty = Number(k.status === 'staged' ? l.qty_staged : l.qty_reserved);
    if (qty <= 0) continue;
    const from = k.status === 'staged' ? k.staging_location_id : l.from_location_id;
    await postTxn(tx, actor, { locationId: from, partId: l.part_id, type: 'issue', qty: -qty, workOrderId: k.work_order_id, reference: `${k.wo_number} ${k.number}` });
    await tx.query('UPDATE work_order_part SET qty_used = qty_used + $2, location_id = $3 WHERE id = $1', [l.work_order_part_id, qty, from]);
    await tx.query('UPDATE kit_line SET qty_issued = $2 WHERE id = $1', [l.id, qty]);
    issued++;
  }
  if (!issued) throw invalid('nothing reserved to issue');
  await tx.query(`UPDATE kit SET status = 'issued', issued_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'kit.issued', entityType: KIT, entityId: id, facilityId: k.facility_id, data: { lines: issued } });
}

/**
 * Returns unused kit parts after the job: back from the work order, and from the staging location to the
 * storeroom they came from. Then the kit closes.
 */
export async function returnAndClose(tx: Tx, actor: Actor, id: string, returns: { kitLineId: string; qty: number }[]) {
  const k = await lockKit(tx, id);
  requirePermission(actor, 'work_orders.execute', k.facility_id);
  if (k.status !== 'issued') throw conflict(k.status === 'closed' ? 'kit is already closed' : 'issue the kit first');
  for (const r of returns.filter((x) => x.qty > 0)) {
    const l = await one(tx, 'SELECT * FROM kit_line WHERE id = $1 AND kit_id = $2 FOR UPDATE', [r.kitLineId, id]);
    if (!l) throw notFound('kit line');
    if (r.qty > Number(l.qty_issued) - Number(l.qty_returned) + 1e-9) throw invalid(`return at most ${Number(l.qty_issued) - Number(l.qty_returned)}`);
    await returnPart(tx, actor, l.work_order_part_id, r.qty);
    if (k.staging_location_id && l.from_location_id) {
      const moved = await postTxn(tx, actor, { locationId: k.staging_location_id, partId: l.part_id, type: 'transfer_out', qty: -r.qty, reference: `${k.number} return`, workOrderId: k.work_order_id });
      await postTxn(tx, actor, { locationId: l.from_location_id, partId: l.part_id, type: 'transfer_in', qty: r.qty, reference: `${k.number} return`, workOrderId: k.work_order_id, lots: carried(moved.lots) });
    }
    await tx.query('UPDATE kit_line SET qty_returned = qty_returned + $2 WHERE id = $1', [l.id, r.qty]);
  }
  await tx.query(`UPDATE kit SET status = 'closed', closed_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'kit.closed', entityType: KIT, entityId: id, facilityId: k.facility_id, data: { returns } });
}

/** Cancels a kit before it is issued: reservations are released, staged stock goes back to its storerooms. */
export async function cancelKit(tx: Tx, actor: Actor, id: string, reason: string) {
  const k = await lockKit(tx, id);
  requirePermission(actor, 'work_orders.manage', k.facility_id);
  if (!['reserved', 'staged'].includes(k.status)) throw conflict(`kit is ${k.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  if (k.status === 'staged') {
    for (const l of await many(tx, 'SELECT * FROM kit_line WHERE kit_id = $1 AND qty_staged > 0', [id])) {
      const moved = await postTxn(tx, actor, { locationId: k.staging_location_id, partId: l.part_id, type: 'transfer_out', qty: -Number(l.qty_staged), reference: `${k.number} cancelled` });
      await postTxn(tx, actor, { locationId: l.from_location_id, partId: l.part_id, type: 'transfer_in', qty: Number(l.qty_staged), reference: `${k.number} cancelled`, lots: carried(moved.lots) });
    }
  }
  await tx.query(`UPDATE kit SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'kit.cancelled', entityType: KIT, entityId: id, facilityId: k.facility_id, data: { reason, wasStaged: k.status === 'staged' } });
}

export async function getKit(tx: Tx, actor: Actor, id: string) {
  const k = await one(tx, `SELECT k.*, w.number AS wo_number, w.title AS wo_title, w.status AS wo_status, w.due_at, a.asset_tag, f.code AS facility_code, sl.code AS staging_location
    FROM kit k JOIN work_order w ON w.id = k.work_order_id JOIN asset a ON a.id = w.asset_id JOIN facility f ON f.id = k.facility_id LEFT JOIN stock_location sl ON sl.id = k.staging_location_id
    WHERE k.id = $1`, [id]);
  if (!k) throw notFound('kit');
  requirePermission(actor, 'work_orders.view', k.facility_id);
  const lines = await many(tx, `SELECT kl.*, kl.qty_needed::float AS qty_needed, kl.qty_reserved::float AS qty_reserved, kl.qty_staged::float AS qty_staged, kl.qty_issued::float AS qty_issued,
      kl.qty_returned::float AS qty_returned, p.part_number, p.description, p.uom, l.code AS from_location, b.bin
    FROM kit_line kl JOIN part p ON p.id = kl.part_id LEFT JOIN stock_location l ON l.id = kl.from_location_id
    LEFT JOIN inventory_balance b ON b.location_id = kl.from_location_id AND b.part_id = kl.part_id WHERE kl.kit_id = $1 ORDER BY l.code NULLS LAST, b.bin NULLS LAST, p.part_number`, [id]);
  const stagingLocations = can(actor, 'inventory.manage', k.facility_id)
    ? await many(tx, `SELECT id, code, name FROM stock_location WHERE facility_id = $1 AND kind = 'staging' AND active ORDER BY code`, [k.facility_id]) : [];
  return { ...k, lines, short: lines.filter((l) => l.qty_reserved < l.qty_needed).length, stagingLocations };
}

export async function kitForWorkOrder(tx: Tx, actor: Actor, workOrderId: string) {
  const k = await one(tx, `SELECT id FROM kit WHERE work_order_id = $1 ORDER BY (status NOT IN ('closed', 'cancelled')) DESC, created_at DESC LIMIT 1`, [workOrderId]);
  return k ? getKit(tx, actor, k.id) : null;
}

/** Kits to work on, soonest needed first, with how many lines are short. */
export async function listKits(tx: Tx, actor: Actor, q: { facilityId?: string; open?: boolean } = {}) {
  requirePermission(actor, 'work_orders.view');
  const rows = await many(tx, `SELECT k.id, k.number, k.status, k.needed_by, k.facility_id, f.code AS facility_code, w.id AS work_order_id, w.number AS wo_number, w.title AS wo_title, a.asset_tag,
      (SELECT count(*)::int FROM kit_line l WHERE l.kit_id = k.id) AS lines,
      (SELECT count(*)::int FROM kit_line l WHERE l.kit_id = k.id AND l.qty_reserved < l.qty_needed) AS short
    FROM kit k JOIN work_order w ON w.id = k.work_order_id JOIN asset a ON a.id = w.asset_id JOIN facility f ON f.id = k.facility_id
    WHERE ($1::uuid IS NULL OR k.facility_id = $1) AND (NOT $2 OR k.status IN ('reserved', 'staged', 'issued'))
    ORDER BY k.needed_by NULLS LAST, k.number LIMIT 300`, [q.facilityId ?? null, q.open ?? false]);
  return rows.filter((r) => can(actor, 'work_orders.view', r.facility_id));
}
