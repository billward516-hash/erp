import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { applyState } from '../assets/service.js';
import { postTxn } from '../inventory/service.js';
import { assertAssetQualified } from '../learning/qualifications.js';
import { assertCalibrated } from '../quality/calibration.js';
import { createPurchaseRequest, defaultStoreroom, incomingByPart } from '../purchasing/service.js';

const ORDER = 'production_order';
const REVISION = 'product_revision';
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const money = (n: number) => Math.round(n * 100) / 100;
const OPEN = ['released', 'in_progress'];

// ---------------------------------------------------------------------------
// Work centers
// ---------------------------------------------------------------------------

export async function listWorkCenters(tx: Tx, actor: Actor, q: { facilityId?: string } = {}) {
  requirePermission(actor, 'production.view');
  const rows = await many(tx, `SELECT w.*, f.code AS facility_code,
      coalesce((SELECT json_agg(json_build_object('id', a.id, 'tag', a.asset_tag, 'name', a.name, 'state', a.operational_state) ORDER BY a.asset_tag)
        FROM work_center_asset x JOIN asset a ON a.id = x.asset_id WHERE x.work_center_id = w.id), '[]') AS assets,
      (SELECT count(*)::int FROM production_operation op JOIN production_order o ON o.id = op.order_id
        WHERE op.work_center_id = w.id AND op.status <> 'done' AND o.status IN ('released', 'in_progress')) AS queued
    FROM work_center w JOIN facility f ON f.id = w.facility_id WHERE ($1::uuid IS NULL OR w.facility_id = $1) ORDER BY f.code, w.code`, [q.facilityId ?? null]);
  return rows.filter((r) => can(actor, 'production.view', r.facility_id));
}

export async function saveWorkCenter(tx: Tx, actor: Actor, input: { id?: string; facilityId: string; code: string; name: string; active?: boolean; assetIds?: string[] }) {
  requirePermission(actor, 'production.manage', input.facilityId);
  if (!input.code?.trim() || !input.name?.trim()) throw invalid('code and name are required');
  for (const a of input.assetIds ?? []) {
    const asset = await one(tx, 'SELECT facility_id FROM asset WHERE id = $1', [a]);
    if (!asset || asset.facility_id !== input.facilityId) throw invalid('machines must be assets at the same facility');
  }
  let w;
  if (input.id) {
    w = await one(tx, `UPDATE work_center SET code = $2, name = $3, active = coalesce($4, active) WHERE id = $1 AND facility_id = $5 RETURNING *`,
      [input.id, input.code.trim(), input.name.trim(), input.active ?? null, input.facilityId]);
    if (!w) throw notFound('work center');
  } else {
    if (await one(tx, 'SELECT 1 FROM work_center WHERE facility_id = $1 AND lower(code) = lower($2)', [input.facilityId, input.code.trim()])) throw conflict(`work center ${input.code} already exists`);
    w = await one(tx, 'INSERT INTO work_center (tenant_id, facility_id, code, name) VALUES ($1, $2, $3, $4) RETURNING *', [actor.tenantId, input.facilityId, input.code.trim(), input.name.trim()]);
  }
  if (input.assetIds) {
    await tx.query('DELETE FROM work_center_asset WHERE work_center_id = $1', [w.id]);
    for (const a of input.assetIds) await tx.query('INSERT INTO work_center_asset (tenant_id, work_center_id, asset_id) VALUES ($1, $2, $3)', [actor.tenantId, w.id, a]);
  }
  await audit(tx, actor, { action: input.id ? 'work_center.updated' : 'work_center.created', entityType: 'work_center', entityId: w.id, facilityId: w.facility_id,
    data: { code: w.code, assets: input.assetIds ?? null } });
  return w;
}

export async function listScrapReasons(tx: Tx) {
  return many(tx, 'SELECT code, label FROM scrap_reason WHERE active ORDER BY CASE code WHEN \'OTHER\' THEN 1 ELSE 0 END, label');
}

// ---------------------------------------------------------------------------
// Product revisions (bill of materials + routing)
// ---------------------------------------------------------------------------

export interface MaterialInput { partId: string; qtyPer: number; scrapPct?: number; opNo?: number | null; notes?: string | null }
export interface OperationInput { opNo: number; workCenterId: string; description: string; setupMinutes?: number; runMinutesPerUnit?: number; documentId?: string | null }

export async function listProducts(tx: Tx, actor: Actor) {
  requirePermission(actor, 'production.view');
  return many(tx, `SELECT p.id AS part_id, p.part_number, p.description, p.uom,
      (SELECT json_build_object('id', r.id, 'revision', r.revision, 'released_at', r.released_at) FROM product_revision r WHERE r.part_id = p.id AND r.status = 'released') AS released,
      (SELECT json_build_object('id', r.id, 'revision', r.revision) FROM product_revision r WHERE r.part_id = p.id AND r.status = 'draft') AS draft,
      (SELECT count(*)::int FROM production_order o WHERE o.part_id = p.id AND o.status IN ('planned', 'released', 'in_progress')) AS open_orders
    FROM part p WHERE EXISTS (SELECT 1 FROM product_revision r WHERE r.part_id = p.id) ORDER BY p.part_number`);
}

export async function createRevision(tx: Tx, actor: Actor, input: { partId: string; notes?: string | null; blank?: boolean }) {
  requirePermission(actor, 'production.manage');
  const part = await one(tx, 'SELECT id, part_number FROM part WHERE id = $1 AND active', [input.partId]);
  if (!part) throw notFound('part');
  if (await one(tx, `SELECT 1 FROM product_revision WHERE part_id = $1 AND status = 'draft'`, [input.partId])) throw conflict(`${part.part_number} already has a draft revision; edit or release it`);
  const next = Number((await one(tx, 'SELECT coalesce(max(revision), 0) + 1 AS n FROM product_revision WHERE part_id = $1', [input.partId])).n);
  const r = await one(tx, `INSERT INTO product_revision (tenant_id, part_id, revision, notes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [actor.tenantId, input.partId, next, input.notes ?? null, actor.userId]);
  // A new revision starts as a copy of the released one.
  const from = input.blank ? null : await one(tx, `SELECT id FROM product_revision WHERE part_id = $1 AND status = 'released'`, [input.partId]);
  if (from) {
    await tx.query(`INSERT INTO product_material (tenant_id, revision_id, line_no, part_id, qty_per, scrap_pct, op_no, notes)
      SELECT tenant_id, $2, line_no, part_id, qty_per, scrap_pct, op_no, notes FROM product_material WHERE revision_id = $1`, [from.id, r.id]);
    await tx.query(`INSERT INTO product_operation (tenant_id, revision_id, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit, document_id)
      SELECT tenant_id, $2, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit, document_id FROM product_operation WHERE revision_id = $1`, [from.id, r.id]);
  }
  await audit(tx, actor, { action: 'product_revision.created', entityType: REVISION, entityId: r.id, data: { part: part.part_number, revision: next, copiedFrom: from?.id ?? null } });
  return r;
}

/** True when `target` is reachable from `start` through current (draft or released) product structures. */
async function reaches(tx: Tx, start: string, target: string) {
  const r = await one(tx, `WITH RECURSIVE walk(part_id) AS (
      SELECT $1::uuid
      UNION SELECT m.part_id FROM walk w JOIN product_revision r ON r.part_id = w.part_id AND r.status IN ('draft', 'released')
        JOIN product_material m ON m.revision_id = r.id)
    SELECT 1 FROM walk WHERE part_id = $2 LIMIT 1`, [start, target]);
  return !!r;
}

/** Replaces a draft revision's materials and operations (the editor saves the whole structure). */
export async function saveRevision(tx: Tx, actor: Actor, id: string, input: { notes?: string | null; materials: MaterialInput[]; operations: OperationInput[] }) {
  requirePermission(actor, 'production.manage');
  const r = await one(tx, 'SELECT r.*, p.part_number FROM product_revision r JOIN part p ON p.id = r.part_id WHERE r.id = $1 FOR UPDATE OF r', [id]);
  if (!r) throw notFound('product revision');
  if (r.status !== 'draft') throw conflict('released revisions cannot change; create a new revision');
  const ops = new Set<number>();
  for (const o of input.operations) {
    if (!(o.opNo > 0) || ops.has(o.opNo)) throw invalid(`operation numbers must be positive and unique (${o.opNo})`);
    ops.add(o.opNo);
    if (!o.description?.trim()) throw invalid(`operation ${o.opNo}: describe the work`);
    if (!(await one(tx, 'SELECT 1 FROM work_center WHERE id = $1 AND active', [o.workCenterId]))) throw invalid(`operation ${o.opNo}: work center not found`);
    if ((o.setupMinutes ?? 0) < 0 || (o.runMinutesPerUnit ?? 0) < 0) throw invalid(`operation ${o.opNo}: times cannot be negative`);
  }
  const parts = new Set<string>();
  for (const [i, m] of input.materials.entries()) {
    if (m.partId === r.part_id) throw invalid(`line ${i + 1}: a part cannot contain itself`);
    if (parts.has(m.partId)) throw invalid(`line ${i + 1}: the same part is listed twice; combine the quantities`);
    parts.add(m.partId);
    if (!(m.qtyPer > 0)) throw invalid(`line ${i + 1}: quantity per unit must be positive`);
    if ((m.scrapPct ?? 0) < 0 || (m.scrapPct ?? 0) >= 100) throw invalid(`line ${i + 1}: scrap allowance must be 0–99%`);
    if (m.opNo != null && !ops.has(m.opNo)) throw invalid(`line ${i + 1}: operation ${m.opNo} is not in the routing`);
    const p = await one(tx, 'SELECT part_number FROM part WHERE id = $1 AND active', [m.partId]);
    if (!p) throw invalid(`line ${i + 1}: part not found or inactive`);
    if (await reaches(tx, m.partId, r.part_id)) throw invalid(`line ${i + 1}: ${p.part_number} is made from ${r.part_number}, so it cannot also go into it (circular structure)`);
  }
  await tx.query('DELETE FROM product_material WHERE revision_id = $1', [id]);
  await tx.query('DELETE FROM product_operation WHERE revision_id = $1', [id]);
  for (const [i, m] of input.materials.entries()) {
    await tx.query(`INSERT INTO product_material (tenant_id, revision_id, line_no, part_id, qty_per, scrap_pct, op_no, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.tenantId, id, i + 1, m.partId, m.qtyPer, m.scrapPct ?? 0, m.opNo ?? null, m.notes ?? null]);
  }
  for (const o of [...input.operations].sort((a, b) => a.opNo - b.opNo)) {
    await tx.query(`INSERT INTO product_operation (tenant_id, revision_id, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit, document_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [actor.tenantId, id, o.opNo, o.workCenterId, o.description.trim(), o.setupMinutes ?? 0, o.runMinutesPerUnit ?? 0, o.documentId ?? null]);
  }
  if (input.notes !== undefined) await tx.query('UPDATE product_revision SET notes = $2 WHERE id = $1', [id, input.notes]);
  await audit(tx, actor, { action: 'product_revision.saved', entityType: REVISION, entityId: id, data: { materials: input.materials.length, operations: input.operations.length } });
  return getRevision(tx, actor, id);
}

/** Releases a draft: it becomes the revision new production orders use, and the previous one goes obsolete. */
export async function releaseRevision(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'production.manage');
  const r = await one(tx, 'SELECT r.*, p.part_number FROM product_revision r JOIN part p ON p.id = r.part_id WHERE r.id = $1 FOR UPDATE OF r', [id]);
  if (!r) throw notFound('product revision');
  if (r.status !== 'draft') throw conflict(`revision is ${r.status}`);
  if (!(await one(tx, 'SELECT 1 FROM product_operation WHERE revision_id = $1', [id]))) throw invalid('add at least one operation (the routing) before releasing');
  const prev = await one(tx, `UPDATE product_revision SET status = 'obsolete' WHERE part_id = $1 AND status = 'released' RETURNING revision`, [r.part_id]);
  await tx.query(`UPDATE product_revision SET status = 'released', released_by = $2, released_at = now() WHERE id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'product_revision.released', entityType: REVISION, entityId: id, data: { part: r.part_number, revision: r.revision, supersedes: prev?.revision ?? null } });
  return { revision: r.revision as number, supersedes: (prev?.revision as number | undefined) ?? null };
}

/** Standard material cost and minutes for one unit, from current part costs. */
function rollUp(materials: any[], operations: any[], batch = 1) {
  const material = materials.reduce((s, m) => s + m.qty_per * (1 + m.scrap_pct / 100) * (m.unit_cost ?? 0), 0);
  const minutes = operations.reduce((s, o) => s + o.run_minutes_per_unit + o.setup_minutes / batch, 0);
  return { materialCost: Math.round(material * 10000) / 10000, minutesPerUnit: Math.round(minutes * 1000) / 1000, uncosted: materials.filter((m) => m.unit_cost == null).map((m) => m.part_number) };
}

export async function getRevision(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'production.view');
  const r = await one(tx, `SELECT r.*, p.part_number, p.description AS part_description, p.uom, u.display_name AS created_by_name, ru.display_name AS released_by_name
    FROM product_revision r JOIN part p ON p.id = r.part_id JOIN app_user u ON u.id = r.created_by LEFT JOIN app_user ru ON ru.id = r.released_by WHERE r.id = $1`, [id]);
  if (!r) throw notFound('product revision');
  const materials = await many(tx, `SELECT m.id, m.line_no, m.part_id, p.part_number, p.description, p.uom, m.qty_per::float AS qty_per, m.scrap_pct::float AS scrap_pct, m.op_no, m.notes,
      p.unit_cost::float AS unit_cost, (SELECT r2.revision FROM product_revision r2 WHERE r2.part_id = m.part_id AND r2.status = 'released') AS made_rev
    FROM product_material m JOIN part p ON p.id = m.part_id WHERE m.revision_id = $1 ORDER BY m.line_no`, [id]);
  const operations = await many(tx, `SELECT o.id, o.op_no, o.work_center_id, w.code AS work_center, w.name AS work_center_name, f.code AS facility_code, o.description,
      o.setup_minutes::float AS setup_minutes, o.run_minutes_per_unit::float AS run_minutes_per_unit, o.document_id, d.title AS document_title
    FROM product_operation o JOIN work_center w ON w.id = o.work_center_id JOIN facility f ON f.id = w.facility_id LEFT JOIN document d ON d.id = o.document_id
    WHERE o.revision_id = $1 ORDER BY o.op_no`, [id]);
  const revisions = await many(tx, 'SELECT id, revision, status, released_at FROM product_revision WHERE part_id = $1 ORDER BY revision DESC', [r.part_id]);
  const usedIn = await many(tx, `SELECT DISTINCT p.part_number, r2.id AS revision_id, r2.revision FROM product_material m JOIN product_revision r2 ON r2.id = m.revision_id
    JOIN part p ON p.id = r2.part_id WHERE m.part_id = $1 AND r2.status = 'released'`, [r.part_id]);
  return { ...r, materials, operations, revisions, usedIn, standard: rollUp(materials, operations) };
}

export async function productForPart(tx: Tx, actor: Actor, partId: string) {
  requirePermission(actor, 'production.view');
  const r = await one(tx, `SELECT id FROM product_revision WHERE part_id = $1 ORDER BY (status = 'draft') DESC, (status = 'released') DESC, revision DESC LIMIT 1`, [partId]);
  return r ? getRevision(tx, actor, r.id) : null;
}

// ---------------------------------------------------------------------------
// Production orders
// ---------------------------------------------------------------------------

async function lockOrder(tx: Tx, id: string) {
  const o = await one(tx, 'SELECT o.*, p.part_number FROM production_order o JOIN part p ON p.id = o.part_id WHERE o.id = $1 FOR UPDATE OF o', [id]);
  if (!o) throw notFound('production order');
  return o;
}

export async function createOrder(tx: Tx, actor: Actor, input: { facilityId: string; partId: string; qty: number; dueDate?: string | null; outputLocationId?: string | null;
  salesOrderLineId?: string | null; notes?: string | null }) {
  requirePermission(actor, 'production.manage', input.facilityId);
  if (!(input.qty > 0)) throw invalid('quantity must be positive');
  const rev = await one(tx, `SELECT r.id, p.part_number FROM product_revision r JOIN part p ON p.id = r.part_id WHERE r.part_id = $1 AND r.status = 'released'`, [input.partId]);
  if (!rev) throw invalid('the part has no released product revision (bill of materials and routing)');
  if (input.outputLocationId) {
    const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1 AND active', [input.outputLocationId]);
    if (!loc || loc.facility_id !== input.facilityId) throw invalid('finished goods go to a storeroom at the same facility');
  }
  if (input.salesOrderLineId) {
    const l = await one(tx, `SELECT it.part_id FROM sales_order_line l JOIN sales_order o ON o.id = l.order_id LEFT JOIN sales_item it ON it.id = l.item_id
      WHERE l.id = $1 AND o.status IN ('open', 'partially_shipped')`, [input.salesOrderLineId]);
    if (!l) throw invalid('sales order line not found or the order is closed');
    if (l.part_id !== input.partId) throw invalid('the sales order line is for a different part');
  }
  const number = `MO-${String(await nextSequence(tx, actor.tenantId, 'mo')).padStart(6, '0')}`;
  const o = await one(tx, `INSERT INTO production_order (tenant_id, facility_id, number, part_id, revision_id, qty, due_date, output_location_id, sales_order_line_id, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.partId, rev.id, input.qty, input.dueDate ?? null, input.outputLocationId ?? null, input.salesOrderLineId ?? null, input.notes ?? null, actor.userId]);
  await audit(tx, actor, { action: 'production_order.created', entityType: ORDER, entityId: o.id, facilityId: o.facility_id, data: { number, part: rev.part_number, qty: input.qty } });
  return o;
}

export async function updateOrder(tx: Tx, actor: Actor, id: string, input: { qty?: number; dueDate?: string | null; outputLocationId?: string | null; notes?: string | null }) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.manage', o.facility_id);
  if (input.qty !== undefined && o.status !== 'planned') throw conflict('quantity can change only before release');
  if (input.qty !== undefined && !(input.qty > 0)) throw invalid('quantity must be positive');
  if (input.outputLocationId) {
    const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1 AND active', [input.outputLocationId]);
    if (!loc || loc.facility_id !== o.facility_id) throw invalid('finished goods go to a storeroom at the same facility');
  }
  if (['completed', 'closed', 'cancelled'].includes(o.status)) throw conflict(`order is ${o.status}`);
  await tx.query(`UPDATE production_order SET qty = coalesce($2, qty), due_date = CASE WHEN $3 THEN $4::date ELSE due_date END,
      output_location_id = CASE WHEN $5 THEN $6::uuid ELSE output_location_id END, notes = CASE WHEN $7 THEN $8 ELSE notes END WHERE id = $1`,
  [id, input.qty ?? null, input.dueDate !== undefined, input.dueDate ?? null, input.outputLocationId !== undefined, input.outputLocationId ?? null, input.notes !== undefined, input.notes ?? null]);
  await audit(tx, actor, { action: 'production_order.updated', entityType: ORDER, entityId: id, facilityId: o.facility_id, data: input });
}

/**
 * Releases the order to the floor: the current released revision is pinned, and its materials (scaled to
 * the order quantity, with scrap allowance) and operations are copied onto the order. Shortages are
 * reported, not blocking: the floor can start operations that do not need the missing material.
 */
export async function releaseOrder(tx: Tx, actor: Actor, id: string) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.manage', o.facility_id);
  if (o.status !== 'planned') throw conflict(`order is ${o.status}`);
  const rev = await one(tx, `SELECT id, revision FROM product_revision WHERE part_id = $1 AND status = 'released'`, [o.part_id]);
  if (!rev) throw invalid('the part no longer has a released revision');
  const ops = await many(tx, `SELECT o.*, w.facility_id FROM product_operation o JOIN work_center w ON w.id = o.work_center_id WHERE o.revision_id = $1`, [rev.id]);
  if (ops.some((x) => x.facility_id !== o.facility_id)) throw invalid('the routing uses work centers at another facility; make it at that facility or revise the routing');
  await tx.query(`INSERT INTO production_material (tenant_id, order_id, line_no, part_id, qty_per, scrap_pct, qty_required)
    SELECT tenant_id, $2, line_no, part_id, qty_per, scrap_pct, round($3 * qty_per * (1 + scrap_pct / 100), 3) FROM product_material WHERE revision_id = $1`, [rev.id, id, o.qty]);
  await tx.query(`INSERT INTO production_operation (tenant_id, order_id, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit, document_id)
    SELECT tenant_id, $2, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit, document_id FROM product_operation WHERE revision_id = $1`, [rev.id, id]);
  await tx.query(`UPDATE production_order SET status = 'released', revision_id = $2, released_by = $3, released_at = now() WHERE id = $1`, [id, rev.id, actor.userId]);
  const shortages = (await materialStatus(tx, id, o.facility_id)).filter((m) => m.short > 0);
  await audit(tx, actor, { action: 'production_order.released', entityType: ORDER, entityId: id, facilityId: o.facility_id,
    data: { revision: rev.revision, shortages: shortages.map((s) => ({ part: s.part_number, short: s.short })) } });
  return { revision: rev.revision as number, shortages };
}

/** Each material's remaining need against what the site has, net of other open orders' remaining needs. */
async function materialStatus(tx: Tx, orderId: string, facilityId: string) {
  const rows = await many(tx, `SELECT m.id, m.line_no, m.part_id, p.part_number, p.description, p.uom, p.unit_cost::float AS unit_cost,
      EXISTS (SELECT 1 FROM product_revision r WHERE r.part_id = m.part_id AND r.status = 'released') AS made_in_house,
      m.qty_per::float AS qty_per, m.scrap_pct::float AS scrap_pct, m.qty_required::float AS qty_required, m.qty_issued::float AS qty_issued,
      coalesce((SELECT sum(b.qty_on_hand) FROM inventory_balance b WHERE b.part_id = m.part_id AND b.facility_id = $2), 0)::float AS on_hand,
      coalesce((SELECT sum(greatest(m2.qty_required - m2.qty_issued, 0)) FROM production_material m2 JOIN production_order o2 ON o2.id = m2.order_id
        WHERE m2.part_id = m.part_id AND o2.facility_id = $2 AND o2.id <> $1 AND o2.status IN ('released', 'in_progress')), 0)::float AS committed,
      (SELECT coalesce(json_agg(json_build_object('location_id', l.id, 'location', l.code, 'on_hand', b.qty_on_hand::float) ORDER BY b.qty_on_hand DESC), '[]')
        FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id WHERE b.part_id = m.part_id AND b.facility_id = $2 AND b.qty_on_hand > 0) AS stock
    FROM production_material m JOIN part p ON p.id = m.part_id WHERE m.order_id = $1 ORDER BY m.line_no`, [orderId, facilityId]);
  return rows.map((m) => {
    const remaining = r3(Math.max(0, m.qty_required - m.qty_issued));
    const available = r3(Math.max(0, m.on_hand - m.committed));
    return { ...m, remaining, available, short: r3(Math.max(0, remaining - available)) };
  });
}

/**
 * Drafts a purchase request for the bought materials the order is short (net of anything already on order or
 * requested). Parts made in house are left out: they need a production order, not a purchase.
 */
export async function requestShortages(tx: Tx, actor: Actor, id: string) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'purchasing.request', o.facility_id);
  if (!OPEN.includes(o.status)) throw conflict(`order is ${o.status}`);
  const all = (await materialStatus(tx, id, o.facility_id)).filter((m) => m.short > 0);
  const short = all.filter((m) => !m.made_in_house);
  if (all.length && !short.length) throw invalid(`${all.map((m) => m.part_number).join(', ')} ${all.length === 1 ? 'is' : 'are'} made in house; create a production order instead`);
  const incoming = await incomingByPart(tx, o.facility_id, short.map((s) => s.part_id));
  const lines = [];
  for (const s of short) {
    const inc = incoming.get(s.part_id);
    const qty = r3(s.short - (inc?.onOrder ?? 0) - (inc?.requested ?? 0));
    if (qty > 0) lines.push({ partId: s.part_id, qty, locationId: await defaultStoreroom(tx, o.facility_id, s.part_id) });
  }
  if (!lines.length) throw invalid('nothing to request: materials are covered by stock or already on order');
  return createPurchaseRequest(tx, actor, { facilityId: o.facility_id, title: `Materials for ${o.number}: ${o.part_number}`, lines, neededBy: o.due_date ?? null,
    justification: `Materials for production order ${o.number} not covered by stock on hand or open orders.` });
}

export async function cancelOrder(tx: Tx, actor: Actor, id: string, reason: string) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.manage', o.facility_id);
  if (!['planned', 'released'].includes(o.status)) throw conflict(`order is ${o.status}; work has started, so complete it short instead`);
  if (!reason?.trim()) throw invalid('a reason is required');
  if (await one(tx, 'SELECT 1 FROM production_material WHERE order_id = $1 AND qty_issued > 0', [id])) throw conflict('materials are issued to this order; return them first');
  await tx.query(`UPDATE production_order SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'production_order.cancelled', entityType: ORDER, entityId: id, facilityId: o.facility_id, data: { reason } });
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export async function issueMaterials(tx: Tx, actor: Actor, id: string, lines: { materialId: string; locationId: string; qty: number }[]) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.execute', o.facility_id);
  if (!OPEN.includes(o.status)) throw conflict(`order is ${o.status}`);
  if (!lines.length) throw invalid('nothing to issue');
  for (const l of lines) {
    if (!(l.qty > 0)) throw invalid('quantities must be positive');
    const m = await one(tx, 'SELECT * FROM production_material WHERE id = $1 AND order_id = $2 FOR UPDATE', [l.materialId, id]);
    if (!m) throw notFound('material line');
    const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [l.locationId]);
    if (!loc || loc.facility_id !== o.facility_id) throw invalid('issue from a storeroom at the order\'s facility');
    await postTxn(tx, actor, { locationId: l.locationId, partId: m.part_id, type: 'production_issue', qty: -l.qty, productionOrderId: id, reference: o.number });
    await tx.query('UPDATE production_material SET qty_issued = qty_issued + $2 WHERE id = $1', [m.id, l.qty]);
  }
  await audit(tx, actor, { action: 'production_order.materials_issued', entityType: ORDER, entityId: id, facilityId: o.facility_id, data: { lines } });
}

export async function returnMaterial(tx: Tx, actor: Actor, id: string, input: { materialId: string; locationId: string; qty: number; reason?: string | null }) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.execute', o.facility_id);
  if (['closed', 'cancelled'].includes(o.status)) throw conflict(`order is ${o.status}`);
  const m = await one(tx, 'SELECT * FROM production_material WHERE id = $1 AND order_id = $2 FOR UPDATE', [input.materialId, id]);
  if (!m) throw notFound('material line');
  if (!(input.qty > 0) || input.qty > Number(m.qty_issued) + 1e-9) throw invalid(`return between 0 and the ${Number(m.qty_issued)} issued`);
  const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [input.locationId]);
  if (!loc || loc.facility_id !== o.facility_id) throw invalid('return to a storeroom at the order\'s facility');
  await postTxn(tx, actor, { locationId: input.locationId, partId: m.part_id, type: 'production_return', qty: input.qty, productionOrderId: id, reference: o.number, reason: input.reason ?? null });
  await tx.query('UPDATE production_material SET qty_issued = qty_issued - $2 WHERE id = $1', [m.id, input.qty]);
  await audit(tx, actor, { action: 'production_order.material_returned', entityType: ORDER, entityId: id, facilityId: o.facility_id, data: input });
}

// ---------------------------------------------------------------------------
// Shop floor: operations
// ---------------------------------------------------------------------------

/** Units available to an operation: the previous operation's good output (the order quantity for the first). */
async function inputQty(tx: Tx, op: any, orderQty: number) {
  const prev = await one(tx, 'SELECT qty_good::float AS good, status FROM production_operation WHERE order_id = $1 AND op_no < $2 ORDER BY op_no DESC LIMIT 1', [op.order_id, op.op_no]);
  return prev ? { qty: prev.good as number, final: prev.status === 'done' } : { qty: Number(orderQty), final: true };
}

/**
 * Starts a run (or setup) of an operation: by the operator for themselves, or by a supervisor for an
 * operator. The operator must hold every 'operate' qualification of the machine; a machine that is down
 * or out of service cannot run. Live starts (no back-dated time) mark the machine as running.
 */
export async function startOperation(tx: Tx, actor: Actor, operationId: string, input: { employeeId?: string | null; assetId?: string | null; kind?: 'setup' | 'run'; at?: Date } = {}) {
  const op = await one(tx, `SELECT op.*, o.facility_id, o.status AS order_status, o.qty AS order_qty, o.number FROM production_operation op JOIN production_order o ON o.id = op.order_id
    WHERE op.id = $1 FOR UPDATE OF op`, [operationId]);
  if (!op) throw notFound('operation');
  requirePermission(actor, 'production.execute', op.facility_id);
  await tx.query('SELECT 1 FROM production_order WHERE id = $1 FOR UPDATE', [op.order_id]);
  if (!OPEN.includes(op.order_status)) throw conflict(`order ${op.number} is ${op.order_status}`);
  if (op.status === 'done') throw conflict(`operation ${op.op_no} is finished`);
  const employeeId = input.employeeId ?? actor.employeeId;
  if (!employeeId) throw invalid('your user is not linked to an employee record; a supervisor can record the run for you');
  if (employeeId !== actor.employeeId) requirePermission(actor, 'production.manage', op.facility_id);
  const machines = await many(tx, 'SELECT asset_id FROM work_center_asset WHERE work_center_id = $1', [op.work_center_id]);
  if (machines.length && !input.assetId) throw invalid('choose the machine this runs on');
  if (input.assetId && !machines.some((m) => m.asset_id === input.assetId)) throw invalid('that machine is not part of this work center');
  if (input.assetId) {
    const a = await one(tx, 'SELECT asset_tag, operational_state FROM asset WHERE id = $1', [input.assetId]);
    if (['unplanned_downtime', 'out_of_service'].includes(a.operational_state)) throw conflict(`${a.asset_tag} is ${a.operational_state.replace(/_/g, ' ')}; it cannot run production until maintenance returns it to service`);
    await assertAssetQualified(tx, employeeId, input.assetId, 'operate');
    await assertCalibrated(tx, input.assetId);
    if (await one(tx, 'SELECT 1 FROM production_entry WHERE asset_id = $1 AND ended_at IS NULL', [input.assetId])) throw conflict(`${a.asset_tag} is already running another job; stop it first`);
  }
  if (await one(tx, 'SELECT 1 FROM production_entry WHERE employee_id = $1 AND ended_at IS NULL', [employeeId])) throw conflict('this operator already has a job running; stop it first');
  const at = input.at ?? new Date();
  if (at.getTime() > Date.now() + 60_000) throw invalid('start time cannot be in the future');
  const e = await one(tx, `INSERT INTO production_entry (tenant_id, facility_id, order_id, operation_id, employee_id, asset_id, kind, started_at, recorded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [actor.tenantId, op.facility_id, op.order_id, op.id, employeeId, input.assetId ?? null, input.kind ?? 'run', at, actor.userId]);
  await tx.query(`UPDATE production_operation SET status = 'in_progress' WHERE id = $1 AND status = 'pending'`, [op.id]);
  await tx.query(`UPDATE production_order SET status = 'in_progress' WHERE id = $1 AND status = 'released'`, [op.order_id]);
  if (input.assetId && !input.at) await applyState(tx, actor, input.assetId, { state: 'running', source: 'production', note: `${op.number} op ${op.op_no}` });
  await audit(tx, actor, { action: 'production.started', entityType: ORDER, entityId: op.order_id, facilityId: op.facility_id,
    data: { op: op.op_no, entryId: e.id, employeeId, assetId: input.assetId ?? null, kind: input.kind ?? 'run' } });
  return e;
}

/**
 * Stops a run and records what it produced. An operation cannot pass more units than it received from
 * the previous operation; scrap needs a reason code; rework counts good units that needed rework first.
 */
export async function stopOperation(tx: Tx, actor: Actor, entryId: string, input: { qtyGood?: number; qtyScrap?: number; qtyRework?: number; scrapReason?: string | null; note?: string | null; at?: Date }) {
  const e = await one(tx, 'SELECT * FROM production_entry WHERE id = $1 FOR UPDATE', [entryId]);
  if (!e) throw notFound('production entry');
  requirePermission(actor, 'production.execute', e.facility_id);
  if (e.ended_at) throw conflict('this run is already stopped');
  if (e.employee_id !== actor.employeeId) requirePermission(actor, 'production.manage', e.facility_id);
  const good = input.qtyGood ?? 0; const scrap = input.qtyScrap ?? 0; const rework = input.qtyRework ?? 0;
  if (good < 0 || scrap < 0 || rework < 0) throw invalid('quantities cannot be negative');
  if (rework > good) throw invalid('rework counts good units that needed rework, so it cannot exceed the good quantity');
  if (e.kind === 'setup' && good > 0) throw invalid('a setup does not produce good units; record first-piece scrap if any');
  if (scrap > 0) {
    if (!input.scrapReason) throw invalid('choose a scrap reason');
    if (!(await one(tx, 'SELECT 1 FROM scrap_reason WHERE code = $1 AND active', [input.scrapReason]))) throw invalid(`unknown scrap reason ${input.scrapReason}`);
  }
  const op = await one(tx, 'SELECT op.*, o.qty AS order_qty, o.number FROM production_operation op JOIN production_order o ON o.id = op.order_id WHERE op.id = $1 FOR UPDATE OF op', [e.operation_id]);
  const inp = await inputQty(tx, op, op.order_qty);
  const processed = r3(Number(op.qty_good) + Number(op.qty_scrap) + good + scrap);
  if (processed > inp.qty + 1e-9) {
    throw invalid(`operation ${op.op_no} has received ${inp.qty} units${op.op_no > 1 ? ' from the previous operation' : ' (the order quantity)'}; ${r3(Number(op.qty_good) + Number(op.qty_scrap))} are already reported`);
  }
  const at = input.at ?? new Date();
  if (at <= new Date(e.started_at)) throw invalid('the stop time must be after the start');
  await tx.query(`UPDATE production_entry SET ended_at = $2, qty_good = $3, qty_scrap = $4, qty_rework = $5, scrap_reason = $6, note = $7 WHERE id = $1`,
    [entryId, at, good, scrap, rework, scrap > 0 ? input.scrapReason : null, input.note ?? null]);
  const done = inp.final && processed >= inp.qty - 1e-9;
  await tx.query(`UPDATE production_operation SET qty_good = qty_good + $2, qty_scrap = qty_scrap + $3, qty_rework = qty_rework + $4, status = CASE WHEN $5 THEN 'done' ELSE status END WHERE id = $1`,
    [op.id, good, scrap, rework, done]);
  if (e.asset_id && !input.at) await applyState(tx, actor, e.asset_id, { state: 'idle', source: 'production', note: `${op.number} op ${op.op_no} stopped` });
  await audit(tx, actor, { action: 'production.stopped', entityType: ORDER, entityId: e.order_id, facilityId: e.facility_id,
    data: { op: op.op_no, entryId, good, scrap, rework, scrapReason: input.scrapReason ?? null } });
  return { operationDone: done, processed, input: inp.qty };
}

/** Closes an operation that will not process its remaining input (e.g. the rest were scrapped upstream or the order is short). */
export async function finishOperation(tx: Tx, actor: Actor, operationId: string) {
  const op = await one(tx, 'SELECT op.*, o.facility_id FROM production_operation op JOIN production_order o ON o.id = op.order_id WHERE op.id = $1 FOR UPDATE OF op', [operationId]);
  if (!op) throw notFound('operation');
  requirePermission(actor, 'production.manage', op.facility_id);
  if (await one(tx, 'SELECT 1 FROM production_entry WHERE operation_id = $1 AND ended_at IS NULL', [operationId])) throw conflict('a run is still open on this operation');
  const prev = await one(tx, `SELECT status FROM production_operation WHERE order_id = $1 AND op_no < $2 ORDER BY op_no DESC LIMIT 1`, [op.order_id, op.op_no]);
  if (prev && prev.status !== 'done') throw conflict('finish the previous operation first');
  await tx.query(`UPDATE production_operation SET status = 'done' WHERE id = $1`, [operationId]);
  await audit(tx, actor, { action: 'production.operation_finished', entityType: ORDER, entityId: op.order_id, facilityId: op.facility_id, data: { op: op.op_no } });
}

// ---------------------------------------------------------------------------
// Output, completion, close
// ---------------------------------------------------------------------------

async function standardUnitCost(tx: Tx, orderId: string) {
  const m = await many(tx, `SELECT m.qty_per::float AS qty_per, m.scrap_pct::float AS scrap_pct, p.unit_cost::float AS unit_cost, p.part_number FROM production_material m
    JOIN part p ON p.id = m.part_id WHERE m.order_id = $1`, [orderId]);
  return rollUp(m, []).materialCost;
}

/**
 * Receives good units from the last operation into finished-goods stock, valued at the standard material
 * cost of the pinned revision (labor and overhead are not absorbed: costing of record is in accounting).
 * Receiving the full quantity completes the order and tells whoever sold it.
 */
export async function receiveOutput(tx: Tx, actor: Actor, id: string, input: { qty: number; locationId?: string | null }) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.execute', o.facility_id);
  if (!OPEN.includes(o.status)) throw conflict(`order is ${o.status}`);
  if (!(input.qty > 0)) throw invalid('quantity must be positive');
  const last = await one(tx, 'SELECT qty_good::float AS good FROM production_operation WHERE order_id = $1 ORDER BY op_no DESC LIMIT 1', [id]);
  const ready = r3((last?.good ?? 0) - Number(o.qty_received));
  if (input.qty > ready + 1e-9) throw invalid(`only ${ready} finished units are reported by the last operation and not yet received`);
  const locationId = input.locationId ?? o.output_location_id;
  if (!locationId) throw invalid('choose the finished-goods storeroom');
  const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [locationId]);
  if (!loc || loc.facility_id !== o.facility_id) throw invalid('receive into a storeroom at the order\'s facility');
  const unitCost = await standardUnitCost(tx, id);
  await postTxn(tx, actor, { locationId, partId: o.part_id, type: 'production_receipt', qty: input.qty, unitCost: unitCost || null, productionOrderId: id, reference: o.number });
  const received = r3(Number(o.qty_received) + input.qty);
  const complete = received >= Number(o.qty) - 1e-9;
  await tx.query(`UPDATE production_order SET qty_received = $2, status = CASE WHEN $3 THEN 'completed' ELSE status END, completed_at = CASE WHEN $3 THEN now() ELSE completed_at END WHERE id = $1`,
    [id, received, complete]);
  if (complete) await onCompleted(tx, actor, o);
  await audit(tx, actor, { action: 'production_order.output_received', entityType: ORDER, entityId: id, facilityId: o.facility_id, data: { qty: input.qty, unitCost, received, complete } });
  return { received, complete };
}

async function onCompleted(tx: Tx, actor: Actor, o: any) {
  if (await one(tx, 'SELECT 1 FROM production_entry WHERE order_id = $1 AND ended_at IS NULL', [o.id])) throw conflict('stop the open runs on this order first');
  if (!o.sales_order_line_id) return;
  const so = await one(tx, `SELECT so.id, so.number, so.created_by, q.created_by AS quoted_by, c.name FROM sales_order_line l JOIN sales_order so ON so.id = l.order_id
    JOIN customer c ON c.id = so.customer_id LEFT JOIN quote q ON q.id = so.quote_id WHERE l.id = $1`, [o.sales_order_line_id]);
  if (!so) return;
  await notify(tx, actor.tenantId, [...new Set([so.created_by, so.quoted_by].filter(Boolean))], { kind: 'production.completed',
    title: `${o.number} finished: ${o.part_number} for ${so.number} (${so.name}) is ready to ship`, link: `/sales/orders/${so.id}`,
    subjectType: ORDER, subjectId: o.id, dedupeKey: `mo-done:${o.id}` }, actor.userId);
}

/** Completes an order with fewer units than ordered (the rest will not be made), with a reason. */
export async function completeShort(tx: Tx, actor: Actor, id: string, reason: string) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.manage', o.facility_id);
  if (!OPEN.includes(o.status)) throw conflict(`order is ${o.status}`);
  if (!reason?.trim()) throw invalid('say why the order ends short');
  await onCompleted(tx, actor, o);
  await tx.query(`UPDATE production_operation SET status = 'done' WHERE order_id = $1`, [id]);
  await tx.query(`UPDATE production_order SET status = 'completed', completed_at = now(), short_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'production_order.completed_short', entityType: ORDER, entityId: id, facilityId: o.facility_id, data: { received: Number(o.qty_received), qty: Number(o.qty), reason } });
}

/** Closes a completed order: no more movements. The material variance (issued vs standard for what was made) is recorded. */
export async function closeOrder(tx: Tx, actor: Actor, id: string) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'production.manage', o.facility_id);
  if (o.status !== 'completed') throw conflict('complete the order before closing it');
  const v = await getOrder(tx, actor, id);
  await tx.query(`UPDATE production_order SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'production_order.closed', entityType: ORDER, entityId: id, facilityId: o.facility_id,
    data: { received: v.qty_received, materialVariance: v.metrics.materialVariance, firstPassYield: v.metrics.firstPassYield, hours: v.metrics.actualHours, standardHours: v.metrics.standardHours } });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOrder(tx: Tx, actor: Actor, id: string) {
  const o = await one(tx, `SELECT o.*, o.qty::float AS qty, o.qty_received::float AS qty_received, p.part_number, p.description AS part_description, p.uom, r.revision,
      f.code AS facility_code, l.code AS output_location, so.id AS sales_order_id, so.number AS sales_order_number, c.name AS customer_name, u.display_name AS created_by_name
    FROM production_order o JOIN part p ON p.id = o.part_id JOIN product_revision r ON r.id = o.revision_id JOIN facility f ON f.id = o.facility_id
    LEFT JOIN stock_location l ON l.id = o.output_location_id LEFT JOIN sales_order_line sl ON sl.id = o.sales_order_line_id LEFT JOIN sales_order so ON so.id = sl.order_id
    LEFT JOIN customer c ON c.id = so.customer_id JOIN app_user u ON u.id = o.created_by WHERE o.id = $1`, [id]);
  if (!o) throw notFound('production order');
  requirePermission(actor, 'production.view', o.facility_id);
  const materials = await materialStatus(tx, id, o.facility_id);
  const operations = await many(tx, `SELECT op.id, op.op_no, op.work_center_id, w.code AS work_center, w.name AS work_center_name, op.description, op.status, op.document_id, d.title AS document_title,
      op.setup_minutes::float AS setup_minutes, op.run_minutes_per_unit::float AS run_minutes_per_unit,
      op.qty_good::float AS qty_good, op.qty_scrap::float AS qty_scrap, op.qty_rework::float AS qty_rework,
      coalesce((SELECT sum(extract(epoch FROM (e.ended_at - e.started_at)) / 60) FROM production_entry e WHERE e.operation_id = op.id AND e.ended_at IS NOT NULL), 0)::float AS actual_minutes,
      (SELECT count(*)::int FROM production_entry e WHERE e.operation_id = op.id AND e.ended_at IS NULL) AS running,
      coalesce((SELECT json_agg(json_build_object('id', a.id, 'tag', a.asset_tag, 'state', a.operational_state) ORDER BY a.asset_tag) FROM work_center_asset x JOIN asset a ON a.id = x.asset_id WHERE x.work_center_id = op.work_center_id), '[]') AS machines
    FROM production_operation op JOIN work_center w ON w.id = op.work_center_id LEFT JOIN document d ON d.id = op.document_id WHERE op.order_id = $1 ORDER BY op.op_no`, [id]);
  let input = o.qty;
  for (const op of operations) { op.input = input; op.remaining = r3(Math.max(0, input - op.qty_good - op.qty_scrap)); input = op.qty_good; }
  const entries = await many(tx, `SELECT e.id, e.kind, e.started_at, e.ended_at, e.qty_good::float AS qty_good, e.qty_scrap::float AS qty_scrap, e.qty_rework::float AS qty_rework,
      e.scrap_reason, sr.label AS scrap_label, e.note, op.op_no, e.employee_id,
      (SELECT n.id FROM nonconformance n WHERE n.production_entry_id = e.id AND n.status <> 'cancelled') AS ncr_id,
      (SELECT n.number FROM nonconformance n WHERE n.production_entry_id = e.id AND n.status <> 'cancelled') AS ncr_number, emp.first_name || ' ' || emp.last_name AS operator, a.asset_tag, u.display_name AS recorded_by_name
    FROM production_entry e JOIN production_operation op ON op.id = e.operation_id JOIN employee emp ON emp.id = e.employee_id LEFT JOIN asset a ON a.id = e.asset_id
    LEFT JOIN scrap_reason sr ON sr.code = e.scrap_reason JOIN app_user u ON u.id = e.recorded_by WHERE e.order_id = $1 ORDER BY e.started_at DESC`, [id]);
  const movements = await many(tx, `SELECT t.created_at, t.txn_type, p.part_number, t.qty::float AS qty, t.unit_cost::float AS unit_cost, l.code AS location, u.display_name AS by
    FROM inventory_txn t JOIN part p ON p.id = t.part_id JOIN stock_location l ON l.id = t.location_id JOIN app_user u ON u.id = t.created_by
    WHERE t.production_order_id = $1 ORDER BY t.id DESC`, [id]);
  const made = operations.length ? operations[operations.length - 1].qty_good : 0;
  const firstOpIn = Number(o.qty);
  const totalScrap = operations.reduce((s, x) => s + x.qty_scrap, 0);
  const totalRework = operations.reduce((s, x) => s + x.qty_rework, 0);
  const actualHours = operations.reduce((s, x) => s + x.actual_minutes, 0) / 60;
  const standardHours = operations.reduce((s, x) => s + (x.qty_good + x.qty_scrap > 0 ? x.setup_minutes + x.run_minutes_per_unit * (x.qty_good + x.qty_scrap) : 0), 0) / 60;
  // Material variance: issued − standard for the units made (positive = more used than standard).
  for (const m of materials as any[]) { m.standard_for_made = r3(m.qty_per * (1 + m.scrap_pct / 100) * made); m.variance_qty = r3(m.qty_issued - m.standard_for_made); }
  const materialVariance = money(materials.reduce((s, m: any) => s + m.variance_qty * (m.unit_cost ?? 0), 0));
  const started = operations[0] ? operations[0].qty_good + operations[0].qty_scrap : 0;
  return {
    ...o, materials, operations, entries, movements,
    metrics: {
      made, totalScrap, totalRework,
      firstPassYield: started > 0 && made > 0 ? Math.round(((made - totalRework) / (made + totalScrap)) * 1000) / 10 : null,
      actualHours: Math.round(actualHours * 100) / 100, standardHours: Math.round(standardHours * 100) / 100,
      materialVariance, standardUnitCost: await standardUnitCost(tx, id), readyToReceive: r3(made - o.qty_received), firstOpInput: firstOpIn,
    },
    late: o.due_date && OPEN.concat('planned').includes(o.status) && o.due_date < new Date().toISOString().slice(0, 10),
  };
}

export async function listOrders(tx: Tx, actor: Actor, q: { status?: string; open?: boolean; partId?: string; facilityId?: string } = {}) {
  requirePermission(actor, 'production.view');
  const rows = await many(tx, `SELECT o.id, o.number, o.status, o.due_date, o.qty::float AS qty, o.qty_received::float AS qty_received, o.facility_id, f.code AS facility_code,
      p.part_number, p.description AS part_description, r.revision, so.number AS sales_order_number, c.name AS customer_name,
      (SELECT op.op_no || ' ' || w.code FROM production_operation op JOIN work_center w ON w.id = op.work_center_id WHERE op.order_id = o.id AND op.status <> 'done' ORDER BY op.op_no LIMIT 1) AS current_op,
      (SELECT qty_good::float FROM production_operation op WHERE op.order_id = o.id ORDER BY op.op_no DESC LIMIT 1) AS made,
      (SELECT coalesce(sum(qty_scrap), 0)::float FROM production_operation op WHERE op.order_id = o.id) AS scrap,
      (o.due_date < current_date AND o.status IN ('planned', 'released', 'in_progress')) AS late
    FROM production_order o JOIN part p ON p.id = o.part_id JOIN product_revision r ON r.id = o.revision_id JOIN facility f ON f.id = o.facility_id
    LEFT JOIN sales_order_line sl ON sl.id = o.sales_order_line_id LEFT JOIN sales_order so ON so.id = sl.order_id LEFT JOIN customer c ON c.id = so.customer_id
    WHERE ($1::text IS NULL OR o.status = $1) AND (NOT $2 OR o.status IN ('planned', 'released', 'in_progress', 'completed'))
      AND ($3::uuid IS NULL OR o.part_id = $3) AND ($4::uuid IS NULL OR o.facility_id = $4)
    ORDER BY o.due_date NULLS LAST, o.number LIMIT 500`, [q.status ?? null, q.open ?? false, q.partId ?? null, q.facilityId ?? null]);
  return rows.filter((r) => can(actor, 'production.view', r.facility_id));
}

/**
 * The shop-floor view for a work center: operations that have units waiting (released orders, earlier
 * operation output available), runs in progress, and the operator's own open run.
 */
export async function floorQueue(tx: Tx, actor: Actor, workCenterId: string) {
  const w = await one(tx, 'SELECT * FROM work_center WHERE id = $1', [workCenterId]);
  if (!w) throw notFound('work center');
  requirePermission(actor, 'production.view', w.facility_id);
  const ops = await many(tx, `SELECT op.id, op.op_no, op.description, op.status, op.document_id, d.title AS document_title, o.id AS order_id, o.number, o.due_date, o.qty::float AS order_qty,
      p.part_number, p.description AS part_description, op.qty_good::float AS qty_good, op.qty_scrap::float AS qty_scrap, op.run_minutes_per_unit::float AS run_minutes_per_unit,
      coalesce((SELECT prev.qty_good::float FROM production_operation prev WHERE prev.order_id = op.order_id AND prev.op_no < op.op_no ORDER BY prev.op_no DESC LIMIT 1), o.qty::float) AS input
    FROM production_operation op JOIN production_order o ON o.id = op.order_id JOIN part p ON p.id = o.part_id LEFT JOIN document d ON d.id = op.document_id
    WHERE op.work_center_id = $1 AND op.status <> 'done' AND o.status IN ('released', 'in_progress') ORDER BY o.due_date NULLS LAST, o.number, op.op_no`, [workCenterId]);
  const queue = ops.map((x) => ({ ...x, waiting: r3(x.input - x.qty_good - x.qty_scrap) })).filter((x) => x.waiting > 0 || x.status === 'in_progress');
  const running = await many(tx, `SELECT e.id, e.kind, e.started_at, e.employee_id, emp.first_name || ' ' || emp.last_name AS operator, a.asset_tag, op.op_no, o.number, p.part_number, e.operation_id
    FROM production_entry e JOIN production_operation op ON op.id = e.operation_id JOIN production_order o ON o.id = e.order_id JOIN part p ON p.id = o.part_id
    JOIN employee emp ON emp.id = e.employee_id LEFT JOIN asset a ON a.id = e.asset_id WHERE op.work_center_id = $1 AND e.ended_at IS NULL ORDER BY e.started_at`, [workCenterId]);
  const machines = await many(tx, `SELECT a.id, a.asset_tag, a.name, a.operational_state,
      (SELECT json_agg(q.code) FROM asset_qualification_requirement r JOIN qualification q ON q.id = r.qualification_id WHERE r.asset_id = a.id AND r.scope = 'operate') AS requires
    FROM work_center_asset x JOIN asset a ON a.id = x.asset_id WHERE x.work_center_id = $1 ORDER BY a.asset_tag`, [workCenterId]);
  const mine = actor.employeeId ? await one(tx, `SELECT e.id, e.kind, e.started_at, op.op_no, o.number, op.work_center_id FROM production_entry e JOIN production_operation op ON op.id = e.operation_id
    JOIN production_order o ON o.id = e.order_id WHERE e.employee_id = $1 AND e.ended_at IS NULL`, [actor.employeeId]) : null;
  return { workCenter: w, queue, running, machines, mine, scrapReasons: await listScrapReasons(tx) };
}
