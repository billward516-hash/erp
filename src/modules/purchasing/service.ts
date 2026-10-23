import { notify } from '../../platform/notify/notify.js';
import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { approvalHistory, closePendingRequests, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import type { StageInput } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { postTxn } from '../inventory/service.js';
import type { LotSpec } from '../inventory/lots.js';
import { normalizeUom, partUnits, requireFactor } from '../inventory/uom.js';

export const SUBJECT = 'purchase_request';
registerApprovalSubject(SUBJECT, {
  link: (id) => `/purchasing/requests/${id}`,
  describe: async (tx, id) => {
    const r = await one(tx, `SELECT r.number, r.title, (SELECT coalesce(sum(l.qty * l.est_unit_price), 0)::float FROM purchase_request_line l WHERE l.request_id = r.id) AS total
      FROM purchase_request r WHERE r.id = $1`, [id]);
    return r ? `${r.number} ${r.title} ($${Number(r.total).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : 'purchase request';
  },
});
const PURPOSE = 'purchase.approve';
/** A buyer may order at a price up to this much above the approved total before re-approval is needed. */
export const PRICE_TOLERANCE = 0.1;
const money = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Suppliers and prices
// ---------------------------------------------------------------------------
export interface SupplierInput { code: string; name: string; contactName?: string | null; email?: string | null; phone?: string | null; paymentTerms?: string | null; currency?: string; customFields?: Record<string, unknown> }

export async function createSupplier(tx: Tx, actor: Actor, input: SupplierInput) {
  requirePermission(actor, 'purchasing.manage');
  if (await one(tx, 'SELECT 1 FROM supplier WHERE lower(code) = lower($1)', [input.code])) throw conflict(`supplier ${input.code} already exists`);
  const s = await one(tx, `INSERT INTO supplier (tenant_id, code, name, contact_name, email, phone, payment_terms, currency, custom_fields)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
  [actor.tenantId, input.code, input.name, input.contactName ?? null, input.email ?? null, input.phone ?? null, input.paymentTerms ?? null, input.currency ?? 'USD', input.customFields ?? {}]);
  await audit(tx, actor, { action: 'supplier.created', entityType: 'supplier', entityId: s.id, data: { code: s.code, name: s.name } });
  return s;
}

export async function updateSupplier(tx: Tx, actor: Actor, id: string, patch: Partial<SupplierInput> & { active?: boolean }) {
  requirePermission(actor, 'purchasing.manage');
  const cur = await one(tx, 'SELECT * FROM supplier WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw notFound('supplier');
  const cols: Record<string, unknown> = {
    name: patch.name, contact_name: patch.contactName, email: patch.email, phone: patch.phone, payment_terms: patch.paymentTerms, currency: patch.currency, active: patch.active,
    custom_fields: patch.customFields ? { ...cur.custom_fields, ...patch.customFields } : undefined,
  };
  const sets: string[] = []; const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(cols)) if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return cur;
  const s = await one(tx, `UPDATE supplier SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  await audit(tx, actor, { action: 'supplier.updated', entityType: 'supplier', entityId: id, data: { changed: Object.keys(cols).filter((k) => cols[k] !== undefined) } });
  return s;
}

export async function listSuppliers(tx: Tx, actor: Actor, q: { q?: string } = {}) {
  requirePermission(actor, 'purchasing.view');
  return many(tx, `SELECT s.*, (SELECT count(*)::int FROM supplier_part sp WHERE sp.supplier_id = s.id) AS parts,
      (SELECT count(*)::int FROM purchase_order o WHERE o.supplier_id = s.id AND o.status IN ('open', 'partially_received')) AS open_orders
    FROM supplier s WHERE ($1::text IS NULL OR s.code ILIKE '%' || $1 || '%' OR s.name ILIKE '%' || $1 || '%') ORDER BY s.name`, [q.q ?? null]);
}

export async function getSupplier(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'purchasing.view');
  const s = await one(tx, 'SELECT * FROM supplier WHERE id = $1', [id]);
  if (!s) throw notFound('supplier');
  const parts = await many(tx, `SELECT sp.*, sp.uom AS price_uom, p.part_number, p.description, p.uom FROM supplier_part sp JOIN part p ON p.id = sp.part_id WHERE sp.supplier_id = $1 ORDER BY p.part_number`, [id]);
  const orders = await many(tx, `SELECT o.id, o.number, o.status, o.expected_on, o.created_at, f.code AS facility_code,
      (SELECT coalesce(sum(l.qty_ordered * l.unit_price), 0)::float FROM purchase_order_line l WHERE l.order_id = o.id) AS total
    FROM purchase_order o JOIN facility f ON f.id = o.facility_id WHERE o.supplier_id = $1 ORDER BY o.created_at DESC LIMIT 50`, [id]);
  return { ...s, parts, orders };
}

export async function setSupplierPrice(tx: Tx, actor: Actor, supplierId: string, partId: string,
  input: { unitPrice?: number | null; leadTimeDays?: number | null; supplierPartNumber?: string | null; preferred?: boolean; uom?: string | null }) {
  requirePermission(actor, 'purchasing.manage');
  if (!(await one(tx, 'SELECT 1 FROM supplier WHERE id = $1', [supplierId]))) throw notFound('supplier');
  const part = await one(tx, 'SELECT id, part_number, uom FROM part WHERE id = $1', [partId]);
  if (!part) throw notFound('part');
  // The supplier's selling unit (D-143) must convert to the stock unit; the stock unit itself is stored as NULL.
  const uom = input.uom == null ? undefined : normalizeUom(input.uom) === part.uom ? null : normalizeUom(input.uom);
  if (uom) requireFactor(uom, part, (await partUnits(tx, [partId])).get(partId));
  if (input.preferred) await tx.query('UPDATE supplier_part SET preferred = false WHERE part_id = $1 AND supplier_id <> $2 AND preferred', [partId, supplierId]);
  await tx.query(`INSERT INTO supplier_part (tenant_id, supplier_id, part_id, supplier_part_number, unit_price, lead_time_days, preferred, uom)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $9)
      ON CONFLICT (supplier_id, part_id) DO UPDATE SET
        supplier_part_number = coalesce(EXCLUDED.supplier_part_number, supplier_part.supplier_part_number),
        unit_price = coalesce(EXCLUDED.unit_price, supplier_part.unit_price),
        lead_time_days = coalesce(EXCLUDED.lead_time_days, supplier_part.lead_time_days),
        preferred = coalesce($8::boolean, supplier_part.preferred),
        uom = CASE WHEN $10 THEN EXCLUDED.uom ELSE supplier_part.uom END, updated_at = now()`,
  [actor.tenantId, supplierId, partId, input.supplierPartNumber ?? null, input.unitPrice ?? null, input.leadTimeDays ?? null, input.preferred ?? false,
    input.preferred ?? null, uom ?? null, uom !== undefined]);
  await audit(tx, actor, { action: 'supplier.price_set', entityType: 'supplier', entityId: supplierId, data: { partId, ...input } });
}

/** Preferred (else cheapest) supplier offer for each part. */
async function bestOffers(tx: Tx, partIds: string[]) {
  const rows = await many(tx, `SELECT DISTINCT ON (sp.part_id) sp.part_id, sp.supplier_id, sp.unit_price, sp.uom, sp.lead_time_days
    FROM supplier_part sp JOIN supplier s ON s.id = sp.supplier_id WHERE sp.part_id = ANY ($1) AND s.active
    ORDER BY sp.part_id, sp.preferred DESC, sp.unit_price ASC NULLS LAST`, [partIds]);
  return new Map(rows.map((r) => [r.part_id as string, r]));
}

// ---------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------
export interface RequestLineInput {
  partId?: string | null; description?: string | null; qty: number; uom?: string | null; estUnitPrice?: number | null;
  supplierId?: string | null; locationId?: string | null; workOrderId?: string | null;
}
export interface RequestInput {
  facilityId: string; title: string; justification?: string | null; spendType?: 'opex' | 'capex'; neededBy?: string | null; workOrderId?: string | null;
  lines: RequestLineInput[];
}

async function writeLines(tx: Tx, actor: Actor, requestId: string, facilityId: string, lines: RequestLineInput[]) {
  if (!lines.length) throw invalid('a purchase request needs at least one line');
  const partIds = lines.map((l) => l.partId).filter((x): x is string => !!x);
  const parts = new Map((await many(tx, 'SELECT id, part_number, description, uom, unit_cost, active FROM part WHERE id = ANY ($1)', [partIds])).map((p) => [p.id, p]));
  const offers = await bestOffers(tx, partIds);
  const units = await partUnits(tx, partIds);
  await tx.query('DELETE FROM purchase_request_line WHERE request_id = $1', [requestId]);
  for (const [i, l] of lines.entries()) {
    const part = l.partId ? parts.get(l.partId) : undefined;
    if (l.partId && (!part || !part.active)) throw invalid(`line ${i + 1}: part not found or inactive`);
    if (!part && !l.description?.trim()) throw invalid(`line ${i + 1}: describe the item or choose a part`);
    if (!(l.qty > 0)) throw invalid(`line ${i + 1}: quantity must be positive`);
    if (l.locationId) {
      const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [l.locationId]);
      if (!loc || loc.facility_id !== facilityId) throw invalid(`line ${i + 1}: receive into a storeroom at the request's facility`);
    }
    if (l.supplierId && !(await one(tx, 'SELECT 1 FROM supplier WHERE id = $1 AND active', [l.supplierId]))) throw invalid(`line ${i + 1}: supplier not found or inactive`);
    const offer = part ? offers.get(part.id) : undefined;
    const supplierId = l.supplierId ?? offer?.supplier_id ?? null;
    const sameSupplierOffer = offer && offer.supplier_id === supplierId ? offer : undefined;
    // Units (D-143): the line's unit converts to the part's stock unit; prices convert from the unit they are quoted in.
    const uom = normalizeUom(l.uom ?? part?.uom ?? 'EA');
    const perUnit = part ? requireFactor(uom, part, units.get(part.id)) : 1;
    const offerPrice = sameSupplierOffer?.unit_price != null ? Number(sameSupplierOffer.unit_price) / requireFactor(sameSupplierOffer.uom ?? part!.uom, part!, units.get(part!.id)) : null;
    const stockPrice = offerPrice ?? (part?.unit_cost != null ? Number(part.unit_cost) : null);
    const price = l.estUnitPrice ?? (stockPrice != null ? Math.round(stockPrice * perUnit * 10_000) / 10_000 : null);
    await tx.query(`INSERT INTO purchase_request_line (tenant_id, request_id, line_no, part_id, description, qty, uom, est_unit_price, supplier_id, location_id, work_order_id, stock_per_unit)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [actor.tenantId, requestId, i + 1, part?.id ?? null, l.description?.trim() || `${part!.part_number} ${part!.description}`, l.qty, uom,
      price, supplierId, l.locationId ?? null, l.workOrderId ?? null, perUnit]);
  }
}

export async function createPurchaseRequest(tx: Tx, actor: Actor, input: RequestInput) {
  requirePermission(actor, 'purchasing.request', input.facilityId);
  if (input.workOrderId) {
    const wo = await one(tx, 'SELECT facility_id FROM work_order WHERE id = $1', [input.workOrderId]);
    if (!wo || wo.facility_id !== input.facilityId) throw invalid('work order not found at this facility');
  }
  const number = `PR-${String(await nextSequence(tx, actor.tenantId, 'pr')).padStart(6, '0')}`;
  const r = await one(tx, `INSERT INTO purchase_request (tenant_id, facility_id, number, title, justification, spend_type, needed_by, work_order_id, requested_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.title, input.justification ?? null, input.spendType ?? 'opex', input.neededBy ?? null, input.workOrderId ?? null, actor.userId]);
  await writeLines(tx, actor, r.id, input.facilityId, input.lines.map((l) => ({ ...l, workOrderId: l.workOrderId ?? input.workOrderId ?? null })));
  await audit(tx, actor, { action: 'purchase_request.created', entityType: SUBJECT, entityId: r.id, facilityId: r.facility_id, data: { number, title: r.title, lines: input.lines.length } });
  return r;
}

async function lockRequest(tx: Tx, id: string) {
  const r = await one(tx, 'SELECT * FROM purchase_request WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw notFound('purchase request');
  return r;
}
const canEditRequest = (actor: Actor, r: any) => r.requested_by === actor.userId || can(actor, 'purchasing.manage', r.facility_id);

/**
 * Edits the request. Any edit after submission is a material change: the revision goes up, pending or
 * given approvals are superseded, and the request returns to draft for resubmission.
 */
export async function updatePurchaseRequest(tx: Tx, actor: Actor, id: string,
  patch: { title?: string; justification?: string | null; spendType?: 'opex' | 'capex'; neededBy?: string | null; lines?: RequestLineInput[] }) {
  const r = await lockRequest(tx, id);
  requirePermission(actor, 'purchasing.request', r.facility_id);
  if (!canEditRequest(actor, r)) throw invalid('only the requester or a buyer can edit this request');
  if (!['draft', 'pending_approval', 'approved', 'rejected'].includes(r.status)) throw conflict(`request is ${r.status}`);
  if (r.status === 'approved' && (await one(tx, `SELECT 1 FROM purchase_order_line l JOIN purchase_request_line rl ON rl.id = l.request_line_id
      JOIN purchase_order o ON o.id = l.order_id WHERE rl.request_id = $1 AND o.status <> 'cancelled'`, [id]))) {
    throw conflict('lines of this request are already on a purchase order; cancel the order first or raise a new request');
  }
  const material = r.status !== 'draft';
  await tx.query(`UPDATE purchase_request SET title = coalesce($2, title), justification = CASE WHEN $3 THEN $4 ELSE justification END,
      spend_type = coalesce($5, spend_type), needed_by = CASE WHEN $6 THEN $7::date ELSE needed_by END,
      revision = revision + $8, status = 'draft', approved_total = NULL, approved_at = NULL WHERE id = $1`,
  [id, patch.title ?? null, patch.justification !== undefined, patch.justification ?? null, patch.spendType ?? null, patch.neededBy !== undefined, patch.neededBy ?? null, material ? 1 : 0]);
  if (patch.lines) await writeLines(tx, actor, id, r.facility_id, patch.lines);
  if (material) await closePendingRequests(tx, actor, SUBJECT, id, 'superseded', `revision ${r.revision + 1}`);
  await audit(tx, actor, { action: 'purchase_request.revised', entityType: SUBJECT, entityId: id, facilityId: r.facility_id,
    data: { revision: r.revision + (material ? 1 : 0), material, linesReplaced: !!patch.lines } });
  return getPurchaseRequest(tx, actor, id);
}

async function requestTotal(tx: Tx, id: string) {
  const lines = await many(tx, 'SELECT line_no, qty, est_unit_price FROM purchase_request_line WHERE request_id = $1 ORDER BY line_no', [id]);
  const unpriced = lines.filter((l) => l.est_unit_price == null);
  return { lines, unpriced, total: money(lines.reduce((s, l) => s + Number(l.qty) * Number(l.est_unit_price ?? 0), 0)) };
}

/** Approval route for a request: matching rules grouped into stages (one step per role per stage). */
export async function approvalRoute(tx: Tx, facilityId: string, spendType: string, total: number): Promise<StageInput[]> {
  const rules = await many(tx, `SELECT stage, role_key, label FROM purchase_approval_rule
    WHERE active AND min_amount <= $1 AND (spend_type IS NULL OR spend_type = $2) AND (facility_id IS NULL OR facility_id = $3)
    ORDER BY stage, min_amount DESC, label`, [total, spendType, facilityId]);
  const stages = new Map<number, Map<string, string>>();
  for (const r of rules) {
    const st = stages.get(r.stage) ?? new Map<string, string>();
    if (!st.has(r.role_key)) st.set(r.role_key, r.label);
    stages.set(r.stage, st);
  }
  return [...stages.keys()].sort((a, b) => a - b).map((k) => ({ steps: [...stages.get(k)!].map(([roleKey, label]) => ({ roleKey, label })) }));
}

export async function submitPurchaseRequest(tx: Tx, actor: Actor, id: string) {
  const r = await lockRequest(tx, id);
  requirePermission(actor, 'purchasing.request', r.facility_id);
  if (!canEditRequest(actor, r)) throw invalid('only the requester or a buyer can submit this request');
  if (r.status !== 'draft') throw conflict(`request is ${r.status}`);
  const { unpriced, total } = await requestTotal(tx, id);
  if (unpriced.length) throw invalid(`every line needs an estimated price before approval (line ${unpriced.map((l) => l.line_no).join(', ')})`);
  const stages = await approvalRoute(tx, r.facility_id, r.spend_type, total);
  if (!stages.length) throw invalid('no approval rule matches this request; ask an administrator to configure purchase approval rules');
  await createApprovalRequest(tx, actor, { facilityId: r.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: r.revision, purpose: PURPOSE, stages });
  await tx.query(`UPDATE purchase_request SET status = 'pending_approval', submitted_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'purchase_request.submitted', entityType: SUBJECT, entityId: id, facilityId: r.facility_id,
    data: { total, revision: r.revision, route: stages.map((s) => s.steps.map((x) => x.roleKey)) } });
  return { total, route: stages };
}

/** Approval engine callback (same transaction as the decision). */
export async function onApprovalDecided(tx: Tx, actor: Actor, subjectId: string, purpose: string, status: string) {
  if (purpose !== PURPOSE || status === 'pending') return;
  const r = await lockRequest(tx, subjectId);
  if (status === 'approved') {
    const { total } = await requestTotal(tx, subjectId);
    await tx.query(`UPDATE purchase_request SET status = 'approved', approved_total = $2, approved_at = now() WHERE id = $1`, [subjectId, total]);
    await audit(tx, actor, { action: 'purchase_request.approved', entityType: SUBJECT, entityId: subjectId, facilityId: r.facility_id, data: { total, revision: r.revision } });
  } else if (status === 'rejected') {
    await tx.query(`UPDATE purchase_request SET status = 'rejected' WHERE id = $1`, [subjectId]);
    await audit(tx, actor, { action: 'purchase_request.rejected', entityType: SUBJECT, entityId: subjectId, facilityId: r.facility_id, data: { revision: r.revision } });
  }
}

export async function cancelPurchaseRequest(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await lockRequest(tx, id);
  requirePermission(actor, 'purchasing.request', r.facility_id);
  if (!canEditRequest(actor, r)) throw invalid('only the requester or a buyer can cancel this request');
  if (['cancelled', 'closed'].includes(r.status)) throw conflict(`request is ${r.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  if (await one(tx, `SELECT 1 FROM purchase_order_line l JOIN purchase_request_line rl ON rl.id = l.request_line_id JOIN purchase_order o ON o.id = l.order_id
      WHERE rl.request_id = $1 AND o.status <> 'cancelled'`, [id])) throw conflict('lines are on a purchase order; cancel the order first');
  await tx.query(`UPDATE purchase_request SET status = 'cancelled' WHERE id = $1`, [id]);
  await closePendingRequests(tx, actor, SUBJECT, id, 'cancelled', reason);
  await audit(tx, actor, { action: 'purchase_request.cancelled', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { reason } });
}

export async function getPurchaseRequest(tx: Tx, actor: Actor, id: string) {
  const r = await one(tx, `SELECT r.*, f.code AS facility_code, u.display_name AS requested_by_name, w.number AS work_order_number
    FROM purchase_request r JOIN facility f ON f.id = r.facility_id JOIN app_user u ON u.id = r.requested_by LEFT JOIN work_order w ON w.id = r.work_order_id
    WHERE r.id = $1`, [id]);
  if (!r) throw notFound('purchase request');
  requirePermission(actor, 'purchasing.view', r.facility_id);
  const lines = await many(tx, `SELECT l.*, p.part_number, s.code AS supplier_code, s.name AS supplier_name, sl.code AS location_code, w.number AS work_order_number,
      (l.qty * l.est_unit_price)::float AS est_total,
      (SELECT json_build_object('id', o.id, 'number', o.number, 'status', o.status, 'qty_received', pl.qty_received)
         FROM purchase_order_line pl JOIN purchase_order o ON o.id = pl.order_id WHERE pl.request_line_id = l.id AND o.status <> 'cancelled' LIMIT 1) AS po
    FROM purchase_request_line l LEFT JOIN part p ON p.id = l.part_id LEFT JOIN supplier s ON s.id = l.supplier_id
    LEFT JOIN stock_location sl ON sl.id = l.location_id LEFT JOIN work_order w ON w.id = l.work_order_id
    WHERE l.request_id = $1 ORDER BY l.line_no`, [id]);
  const total = money(lines.reduce((s, l) => s + (l.est_total ?? 0), 0));
  const route = r.status === 'draft' ? await approvalRoute(tx, r.facility_id, r.spend_type, total) : null;
  return { ...r, lines, total, route, approvals: await approvalHistory(tx, SUBJECT, id) };
}

export async function listPurchaseRequests(tx: Tx, actor: Actor, q: { status?: string; mine?: boolean; facilityId?: string } = {}) {
  requirePermission(actor, 'purchasing.view', q.facilityId);
  const rows = await many(tx, `SELECT r.id, r.number, r.title, r.status, r.spend_type, r.needed_by, r.created_at, r.revision, r.facility_id, f.code AS facility_code,
      u.display_name AS requested_by_name,
      (SELECT coalesce(sum(l.qty * l.est_unit_price), 0)::float FROM purchase_request_line l WHERE l.request_id = r.id) AS total,
      (SELECT count(*)::int FROM purchase_request_line l WHERE l.request_id = r.id) AS lines
    FROM purchase_request r JOIN facility f ON f.id = r.facility_id JOIN app_user u ON u.id = r.requested_by
    WHERE ($1::text IS NULL OR r.status = $1) AND (NOT $2 OR r.requested_by = $3) AND ($4::uuid IS NULL OR r.facility_id = $4)
    ORDER BY r.created_at DESC LIMIT 200`, [q.status ?? null, q.mine ?? false, actor.userId, q.facilityId ?? null]);
  return rows.filter((r) => can(actor, 'purchasing.view', r.facility_id));
}

/** Stock already coming for a part at a facility, in its stock unit: open PO quantities plus approved/pending request lines not yet ordered. */
export async function incomingByPart(tx: Tx, facilityId: string, partIds: string[]) {
  const rows = await many(tx, `
    SELECT part_id, sum(on_order)::float AS on_order, sum(requested)::float AS requested FROM (
      SELECT l.part_id, (l.qty_ordered - l.qty_received) * l.stock_per_unit AS on_order, 0 AS requested
        FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
        WHERE o.facility_id = $1 AND o.status IN ('open', 'partially_received') AND l.part_id = ANY ($2)
      UNION ALL
      SELECT rl.part_id, 0, rl.qty * rl.stock_per_unit FROM purchase_request_line rl JOIN purchase_request r ON r.id = rl.request_id
        WHERE r.facility_id = $1 AND r.status IN ('draft', 'pending_approval', 'approved') AND rl.part_id = ANY ($2)
          AND NOT EXISTS (SELECT 1 FROM purchase_order_line pl JOIN purchase_order o ON o.id = pl.order_id WHERE pl.request_line_id = rl.id AND o.status <> 'cancelled')
    ) x GROUP BY part_id`, [facilityId, partIds]);
  return new Map(rows.map((r) => [r.part_id as string, { onOrder: r.on_order as number, requested: r.requested as number }]));
}

/** Facility storeroom to receive a part into: where it is already stocked (highest reorder point first). */
export async function defaultStoreroom(tx: Tx, facilityId: string, partId: string) {
  const r = await one(tx, `SELECT b.location_id FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id
    WHERE b.facility_id = $1 AND b.part_id = $2 AND l.active ORDER BY b.reorder_point DESC NULLS LAST, l.code LIMIT 1`, [facilityId, partId]);
  return (r?.location_id as string | undefined) ?? null;
}

/**
 * Drafts a request for a work order's planned parts that the site cannot cover: planned − used − on hand
 * at the facility − already on order or requested. Non-stock parts are requested in full.
 */
export async function requestForWorkOrder(tx: Tx, actor: Actor, workOrderId: string) {
  const wo = await one(tx, 'SELECT id, number, title, facility_id, due_at FROM work_order WHERE id = $1', [workOrderId]);
  if (!wo) throw notFound('work order');
  requirePermission(actor, 'purchasing.request', wo.facility_id);
  // Parts used without a planned line (or a substitute for a planned part) count against what was planned (D-161).
  const planned = await many(tx, `WITH l AS (SELECT coalesce(x.substitute_for_part_id, x.part_id) AS part_id, x.qty_planned, x.qty_used FROM work_order_part x WHERE x.work_order_id = $1)
    SELECT l.part_id, (sum(l.qty_planned) - sum(l.qty_used))::float AS need,
      coalesce((SELECT sum(b.qty_on_hand) FROM inventory_balance b WHERE b.part_id = l.part_id AND b.facility_id = $2), 0)::float AS on_hand
    FROM l GROUP BY l.part_id HAVING sum(l.qty_planned) > sum(l.qty_used)`, [workOrderId, wo.facility_id]);
  const incoming = await incomingByPart(tx, wo.facility_id, planned.map((p) => p.part_id));
  const lines: RequestLineInput[] = [];
  for (const p of planned) {
    const inc = incoming.get(p.part_id);
    const short = Math.round((p.need - p.on_hand - (inc?.onOrder ?? 0) - (inc?.requested ?? 0)) * 1000) / 1000;
    if (short > 0) lines.push({ partId: p.part_id, qty: short, locationId: await defaultStoreroom(tx, wo.facility_id, p.part_id), workOrderId });
  }
  if (!lines.length) throw invalid('nothing to request: planned parts are covered by stock on hand or already on order');
  return createPurchaseRequest(tx, actor, {
    facilityId: wo.facility_id, title: `Parts for ${wo.number}: ${wo.title}`, workOrderId, lines,
    neededBy: wo.due_at ? new Date(wo.due_at).toISOString().slice(0, 10) : null,
    justification: `Planned parts for ${wo.number} not covered by stock on hand or open orders.`,
  });
}

// ---------------------------------------------------------------------------
// Purchase orders and receiving
// ---------------------------------------------------------------------------

/**
 * Creates one purchase order per supplier from an approved request's unordered lines. The buyer may set
 * the actual price; the request's ordered total may not exceed the approved total by more than the
 * tolerance (above that, revise the request for re-approval).
 */
export async function createOrdersFromRequest(tx: Tx, actor: Actor, requestId: string,
  input: { lines?: { requestLineId: string; unitPrice?: number; qty?: number; supplierId?: string | null }[]; expectedOn?: string | null; notes?: string | null } = {}) {
  const r = await lockRequest(tx, requestId);
  requirePermission(actor, 'purchasing.manage', r.facility_id);
  if (r.status !== 'approved') throw conflict(`request is ${r.status}; only approved requests can be ordered`);
  const open = await many(tx, `SELECT l.* FROM purchase_request_line l WHERE l.request_id = $1
    AND NOT EXISTS (SELECT 1 FROM purchase_order_line pl JOIN purchase_order o ON o.id = pl.order_id WHERE pl.request_line_id = l.id AND o.status <> 'cancelled')
    ORDER BY l.line_no`, [requestId]);
  const pick = input.lines ? open.filter((l) => input.lines!.some((x) => x.requestLineId === l.id)) : open;
  if (input.lines && pick.length !== input.lines.length) throw invalid('some lines are not on this request or are already ordered');
  if (!pick.length) throw conflict('every line of this request is already ordered');
  // The buyer may name the supplier of a line that has none (the choice does not change the approved amount); it is kept on the line and audited.
  for (const l of pick.filter((x) => !x.supplier_id)) {
    const sid = input.lines?.find((x) => x.requestLineId === l.id)?.supplierId;
    if (!sid) continue;
    const sup = await one(tx, 'SELECT id, code, active FROM supplier WHERE id = $1', [sid]);
    if (!sup || !sup.active) throw invalid(`line ${l.line_no}: choose an active supplier`);
    await tx.query('UPDATE purchase_request_line SET supplier_id = $2 WHERE id = $1', [l.id, sid]);
    l.supplier_id = sid;
    await audit(tx, actor, { action: 'purchase_request.supplier_chosen', entityType: 'purchase_request', entityId: requestId, facilityId: r.facility_id, data: { line: l.line_no, supplier: sup.code } });
  }
  const noSupplier = pick.filter((l) => !l.supplier_id);
  if (noSupplier.length) throw invalid(`choose a supplier for line ${noSupplier.map((l) => l.line_no).join(', ')} first`);
  const priced = pick.map((l) => {
    const o = input.lines?.find((x) => x.requestLineId === l.id);
    const qty = o?.qty ?? Number(l.qty);
    if (!(qty > 0) || qty > Number(l.qty)) throw invalid(`line ${l.line_no}: order between 0 and ${l.qty}`);
    return { ...l, orderQty: qty, unitPrice: o?.unitPrice ?? Number(l.est_unit_price) };
  });
  const already = await one<{ t: number }>(tx, `SELECT coalesce(sum(pl.qty_ordered * pl.unit_price), 0)::float AS t FROM purchase_order_line pl
    JOIN purchase_order o ON o.id = pl.order_id JOIN purchase_request_line l ON l.id = pl.request_line_id WHERE l.request_id = $1 AND o.status <> 'cancelled'`, [requestId]);
  const ordered = money(already!.t + priced.reduce((s, l) => s + l.orderQty * l.unitPrice, 0));
  const limit = money(Number(r.approved_total) * (1 + PRICE_TOLERANCE));
  if (ordered > limit) {
    throw invalid(`ordering ${ordered.toFixed(2)} would exceed the approved ${Number(r.approved_total).toFixed(2)} by more than ${PRICE_TOLERANCE * 100}%; revise the request for re-approval`);
  }
  const bySupplier = new Map<string, typeof priced>();
  for (const l of priced) bySupplier.set(l.supplier_id, [...(bySupplier.get(l.supplier_id) ?? []), l]);
  const orders = [];
  for (const [supplierId, lines] of bySupplier) {
    const number = `PO-${String(await nextSequence(tx, actor.tenantId, 'po')).padStart(6, '0')}`;
    const lead = await one<{ d: number | null }>(tx, `SELECT max(lead_time_days) AS d FROM supplier_part WHERE supplier_id = $1 AND part_id = ANY ($2)`,
      [supplierId, lines.map((l) => l.part_id).filter(Boolean)]);
    const expected = input.expectedOn ?? (lead?.d != null ? new Date(Date.now() + lead.d * 86_400_000).toISOString().slice(0, 10) : r.needed_by);
    const o = await one(tx, `INSERT INTO purchase_order (tenant_id, facility_id, number, supplier_id, expected_on, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [actor.tenantId, r.facility_id, number, supplierId, expected, input.notes ?? null, actor.userId]);
    for (const [i, l] of lines.entries()) {
      await tx.query(`INSERT INTO purchase_order_line (tenant_id, order_id, line_no, request_line_id, part_id, description, qty_ordered, unit_price, location_id, uom, stock_per_unit)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [actor.tenantId, o.id, i + 1, l.id, l.part_id, l.description, l.orderQty, l.unitPrice, l.location_id, l.uom, l.stock_per_unit]);
    }
    await audit(tx, actor, { action: 'purchase_order.created', entityType: 'purchase_order', entityId: o.id, facilityId: o.facility_id,
      data: { number, supplierId, request: r.number, total: money(lines.reduce((s, l) => s + l.orderQty * l.unitPrice, 0)) } });
    orders.push({ id: o.id as string, number });
  }
  // A request is closed once every line is on an order (partial quantities count as ordered).
  const remaining = await one(tx, `SELECT count(*)::int AS n FROM purchase_request_line l WHERE l.request_id = $1
    AND NOT EXISTS (SELECT 1 FROM purchase_order_line pl JOIN purchase_order o ON o.id = pl.order_id WHERE pl.request_line_id = l.id AND o.status <> 'cancelled')`, [requestId]);
  if (!remaining.n) await tx.query(`UPDATE purchase_request SET status = 'closed' WHERE id = $1`, [requestId]);
  return { orders, orderedTotal: ordered, approvedTotal: Number(r.approved_total) };
}

async function lockOrder(tx: Tx, id: string) {
  const o = await one(tx, 'SELECT * FROM purchase_order WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('purchase order');
  return o;
}

export async function cancelOrder(tx: Tx, actor: Actor, id: string, reason: string) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'purchasing.manage', o.facility_id);
  if (o.status !== 'open') throw conflict(o.status === 'cancelled' ? 'order is already cancelled' : 'goods were received on this order; it cannot be cancelled');
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE purchase_order SET status = 'cancelled' WHERE id = $1`, [id]);
  // Its request lines become orderable again.
  await tx.query(`UPDATE purchase_request SET status = 'approved' WHERE status = 'closed' AND id IN (
    SELECT rl.request_id FROM purchase_order_line pl JOIN purchase_request_line rl ON rl.id = pl.request_line_id WHERE pl.order_id = $1)`, [id]);
  await audit(tx, actor, { action: 'purchase_order.cancelled', entityType: 'purchase_order', entityId: id, facilityId: o.facility_id, data: { number: o.number, reason } });
}

/**
 * Records a delivery. Stocked lines go into a storeroom at the order's facility through the stock ledger
 * (receipt at the order price); lines without a storeroom are direct charges and only update the order.
 */
export async function receiveOrder(tx: Tx, actor: Actor, id: string, input: { lines: { orderLineId: string; qty: number; locationId?: string | null; lots?: LotSpec[] | null }[]; packingSlip?: string | null }) {
  const o = await lockOrder(tx, id);
  requirePermission(actor, 'purchasing.receive', o.facility_id);
  if (!['open', 'partially_received'].includes(o.status)) throw conflict(`order is ${o.status}`);
  if (!input.lines.length) throw invalid('nothing to receive');
  const received = [];
  for (const r of input.lines) {
    const l = await one(tx, 'SELECT * FROM purchase_order_line WHERE id = $1 AND order_id = $2 FOR UPDATE', [r.orderLineId, id]);
    if (!l) throw invalid('line is not on this order');
    const open = Number(l.qty_ordered) - Number(l.qty_received);
    if (!(r.qty > 0) || r.qty > open + 1e-9) throw invalid(`line ${l.line_no}: receive between 0 and ${open} (over-deliveries go back to the supplier or onto a new order)`);
    const locationId = r.locationId ?? l.location_id;
    let txnId: number | null = null;
    if (locationId) {
      if (!l.part_id) throw invalid(`line ${l.line_no} is not a catalog part and cannot go into a storeroom`);
      const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [locationId]);
      if (!loc || loc.facility_id !== o.facility_id) throw invalid(`line ${l.line_no}: receive into a storeroom at the order's facility`);
      // The ledger is in the part's stock unit: 3 BOX of 10 is 30 EA, at a tenth of the box price each.
      const per = Number(l.stock_per_unit);
      txnId = (await postTxn(tx, actor, { locationId, partId: l.part_id, type: 'receipt', qty: Math.round(r.qty * per * 1000) / 1000, unitCost: Number(l.unit_price) / per, reference: o.number,
        // Lot quantities are given in order units, like the receipt; the ledger holds stock units (D-143, D-147).
        lots: r.lots?.map((x) => ({ ...x, qty: Math.round(x.qty * per * 1000) / 1000 })), supplierId: o.supplier_id })).txnId;
    } else if (l.part_id && (await one(tx, 'SELECT 1 FROM inventory_balance WHERE part_id = $1 AND facility_id = $2', [l.part_id, o.facility_id]))) {
      throw invalid(`line ${l.line_no}: this part is stocked at this facility; choose the storeroom it goes into`);
    }
    await tx.query('UPDATE purchase_order_line SET qty_received = qty_received + $2 WHERE id = $1', [l.id, r.qty]);
    await tx.query(`INSERT INTO po_receipt (tenant_id, order_line_id, qty, location_id, inventory_txn_id, packing_slip, received_by, stock_qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.tenantId, l.id, r.qty, locationId ?? null, txnId, input.packingSlip ?? null, actor.userId, Math.round(r.qty * Number(l.stock_per_unit) * 1000) / 1000]);
    received.push({ lineNo: l.line_no, qty: r.qty, stocked: !!txnId });
  }
  const left = await one(tx, 'SELECT count(*)::int AS n FROM purchase_order_line WHERE order_id = $1 AND qty_received < qty_ordered', [id]);
  const status = left.n ? 'partially_received' : 'received';
  await tx.query('UPDATE purchase_order SET status = $2 WHERE id = $1', [id, status]);
  // Tell the people who asked for these items that they arrived (and where).
  const askers = await many(tx, `SELECT DISTINCT r.requested_by, r.number, w.number AS wo FROM purchase_order_line pl JOIN purchase_request_line rl ON rl.id = pl.request_line_id
    JOIN purchase_request r ON r.id = rl.request_id LEFT JOIN work_order w ON w.id = coalesce(rl.work_order_id, r.work_order_id)
    WHERE pl.id = ANY ($1)`, [input.lines.map((l) => l.orderLineId)]);
  for (const a of askers) {
    await notify(tx, actor.tenantId, [a.requested_by], { kind: 'purchasing.received', title: `Delivery received on ${o.number} for ${a.number}${a.wo ? ` (${a.wo})` : ''}`,
      body: status === 'received' ? 'Everything on the order has arrived.' : 'Part of the order has arrived.', link: `/purchasing/orders/${id}`,
      subjectType: 'purchase_order', subjectId: id, dedupeKey: `po-received:${id}:${a.requested_by}:${Date.now()}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'purchase_order.received', entityType: 'purchase_order', entityId: id, facilityId: o.facility_id,
    data: { number: o.number, lines: received, packingSlip: input.packingSlip ?? null, status } });
  return { status, received };
}

export async function getOrder(tx: Tx, actor: Actor, id: string) {
  const o = await one(tx, `SELECT o.*, f.code AS facility_code, f.name AS facility_name, s.code AS supplier_code, s.name AS supplier_name, s.contact_name, s.email AS supplier_email,
      s.phone AS supplier_phone, s.payment_terms, s.currency, u.display_name AS created_by_name,
      (o.status IN ('open', 'partially_received') AND o.expected_on < current_date) AS late
    FROM purchase_order o JOIN facility f ON f.id = o.facility_id JOIN supplier s ON s.id = o.supplier_id JOIN app_user u ON u.id = o.created_by WHERE o.id = $1`, [id]);
  if (!o) throw notFound('purchase order');
  requirePermission(actor, 'purchasing.view', o.facility_id);
  const lines = await many(tx, `SELECT l.*, p.uom AS stock_uom, p.tracking, p.shelf_life_days, p.part_number, sp.supplier_part_number, sl.code AS location_code, r.id AS request_id, r.number AS request_number,
      w.id AS work_order_id, w.number AS work_order_number, (l.qty_ordered * l.unit_price)::float AS line_total
    FROM purchase_order_line l JOIN purchase_request_line rl ON rl.id = l.request_line_id JOIN purchase_request r ON r.id = rl.request_id
    LEFT JOIN part p ON p.id = l.part_id LEFT JOIN supplier_part sp ON sp.part_id = l.part_id AND sp.supplier_id = $2
    LEFT JOIN stock_location sl ON sl.id = l.location_id LEFT JOIN work_order w ON w.id = rl.work_order_id
    WHERE l.order_id = $1 ORDER BY l.line_no`, [id, o.supplier_id]);
  const receipts = await many(tx, `SELECT x.id, x.qty, x.received_at, x.packing_slip, l.line_no, sl.code AS location_code, u.display_name AS received_by
    FROM po_receipt x JOIN purchase_order_line l ON l.id = x.order_line_id LEFT JOIN stock_location sl ON sl.id = x.location_id JOIN app_user u ON u.id = x.received_by
    WHERE l.order_id = $1 ORDER BY x.id`, [id]);
  return { ...o, lines, receipts, total: money(lines.reduce((s, l) => s + l.line_total, 0)) };
}

export async function listOrders(tx: Tx, actor: Actor, q: { status?: string; openOnly?: boolean; supplierId?: string; facilityId?: string } = {}) {
  requirePermission(actor, 'purchasing.view', q.facilityId);
  const rows = await many(tx, `SELECT o.id, o.number, o.status, o.expected_on, o.created_at, o.facility_id, f.code AS facility_code, s.name AS supplier_name,
      (SELECT coalesce(sum(l.qty_ordered * l.unit_price), 0)::float FROM purchase_order_line l WHERE l.order_id = o.id) AS total,
      (o.status IN ('open', 'partially_received') AND o.expected_on < current_date) AS late
    FROM purchase_order o JOIN facility f ON f.id = o.facility_id JOIN supplier s ON s.id = o.supplier_id
    WHERE ($1::text IS NULL OR o.status = $1) AND (NOT $2 OR o.status IN ('open', 'partially_received')) AND ($3::uuid IS NULL OR o.supplier_id = $3)
      AND ($4::uuid IS NULL OR o.facility_id = $4)
    ORDER BY o.created_at DESC LIMIT 200`, [q.status ?? null, q.openOnly ?? false, q.supplierId ?? null, q.facilityId ?? null]);
  return rows.filter((r) => can(actor, 'purchasing.view', r.facility_id));
}

// ---------------------------------------------------------------------------
// Approval rules (tenant configuration)
// ---------------------------------------------------------------------------
export async function listApprovalRules(tx: Tx, actor: Actor) {
  requirePermission(actor, 'purchasing.view');
  return many(tx, `SELECT r.*, f.code AS facility_code FROM purchase_approval_rule r LEFT JOIN facility f ON f.id = r.facility_id ORDER BY r.stage, r.min_amount`);
}

export async function saveApprovalRule(tx: Tx, actor: Actor, input: { id?: string; facilityId?: string | null; spendType?: 'opex' | 'capex' | null; minAmount: number; stage: number; roleKey: string; label: string; active?: boolean }) {
  if (!actor.grants.some((g) => g.facilityId === null && g.permissions.has('tenant.admin'))) throw invalid('only an administrator can change approval rules');
  if (!(await one(tx, 'SELECT 1 FROM role WHERE key = $1', [input.roleKey]))) throw invalid(`unknown role ${input.roleKey}`);
  const vals = [input.facilityId ?? null, input.spendType ?? null, input.minAmount, input.stage, input.roleKey, input.label, input.active ?? true];
  const r = input.id
    ? await one(tx, `UPDATE purchase_approval_rule SET facility_id = $2, spend_type = $3, min_amount = $4, stage = $5, role_key = $6, label = $7, active = $8 WHERE id = $1 RETURNING *`, [input.id, ...vals])
    : await one(tx, `INSERT INTO purchase_approval_rule (tenant_id, facility_id, spend_type, min_amount, stage, role_key, label, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [actor.tenantId, ...vals]);
  if (!r) throw notFound('approval rule');
  await audit(tx, actor, { action: 'purchasing.rule_saved', entityType: 'purchase_approval_rule', entityId: r.id, data: input });
  return r;
}

/**
 * One line of an order still open at the previous system (SC-003), under the order number the supplier knows. The order is created
 * on its first line (with an approved request behind it so the usual receiving and invoice matching work) and later lines are added to it.
 * Quantities already received are recorded as history only; stock on hand is loaded separately as a count.
 */
export async function importOpenOrderLine(tx: Tx, actor: Actor, input: { orderNumber: string; supplierId: string; facilityId: string; partId?: string | null; description: string; qty: number; qtyReceived?: number;
  unitPrice: number; expectedOn?: string | null; locationId?: string | null }) {
  requirePermission(actor, 'purchasing.manage', input.facilityId);
  if (!(input.qty > 0) || !(input.unitPrice >= 0)) throw invalid('quantity must be positive and price not negative');
  const received = input.qtyReceived ?? 0;
  if (received < 0 || received > input.qty) throw invalid('received quantity must be between zero and the quantity ordered');
  let o = await one(tx, 'SELECT * FROM purchase_order WHERE lower(number) = lower($1) FOR UPDATE', [input.orderNumber.trim()]);
  if (o && (o.supplier_id !== input.supplierId || o.facility_id !== input.facilityId)) throw conflict(`order ${input.orderNumber} is with a different supplier or site`);
  if (!o) {
    const req = await one(tx, `INSERT INTO purchase_request (tenant_id, facility_id, number, title, spend_type, status, revision, approved_total, requested_by, submitted_at, approved_at)
      VALUES ($1, $2, $3, $4, 'opex', 'approved', 1, 0, $5, now(), now()) RETURNING id`,
    [actor.tenantId, input.facilityId, `PR-${String(await nextSequence(tx, actor.tenantId, 'pr')).padStart(6, '0')}`, `Open order ${input.orderNumber.trim()} from the previous system`, actor.userId]);
    o = await one(tx, `INSERT INTO purchase_order (tenant_id, facility_id, number, supplier_id, expected_on, notes, created_by) VALUES ($1, $2, $3, $4, $5, 'Brought over from the previous system', $6) RETURNING *`,
      [actor.tenantId, input.facilityId, input.orderNumber.trim(), input.supplierId, input.expectedOn ?? null, actor.userId]);
    (o as any)._request = req.id;
  }
  const request = (o as any)._request ?? (await one(tx, `SELECT l.request_id AS id FROM purchase_order_line pl JOIN purchase_request_line l ON l.id = pl.request_line_id WHERE pl.order_id = $1 LIMIT 1`, [o.id]))?.id;
  const dup = input.partId
    ? await one(tx, 'SELECT id FROM purchase_order_line WHERE order_id = $1 AND part_id = $2', [o.id, input.partId])
    : await one(tx, 'SELECT id FROM purchase_order_line WHERE order_id = $1 AND lower(description) = lower($2)', [o.id, input.description.trim()]);
  if (dup) return { id: o.id as string, created: false };
  const lineNo = ((await one(tx, 'SELECT coalesce(max(line_no), 0)::int AS n FROM purchase_order_line WHERE order_id = $1', [o.id])).n as number) + 1;
  const rl = await one(tx, `INSERT INTO purchase_request_line (tenant_id, request_id, line_no, part_id, description, qty, est_unit_price, supplier_id, location_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.tenantId, request, lineNo, input.partId ?? null, input.description.trim(), input.qty, input.unitPrice, input.supplierId, input.locationId ?? null]);
  await tx.query(`INSERT INTO purchase_order_line (tenant_id, order_id, line_no, request_line_id, part_id, description, qty_ordered, qty_received, unit_price, location_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [actor.tenantId, o.id, lineNo, rl.id, input.partId ?? null, input.description.trim(), input.qty, received, input.unitPrice, input.locationId ?? null]);
  await tx.query(`UPDATE purchase_request SET approved_total = coalesce(approved_total, 0) + $2 WHERE id = $1`, [request, Math.round(input.qty * input.unitPrice * 100) / 100]);
  const st = await one(tx, `SELECT count(*) FILTER (WHERE qty_received < qty_ordered)::int AS open, count(*) FILTER (WHERE qty_received > 0)::int AS some FROM purchase_order_line WHERE order_id = $1`, [o.id]);
  await tx.query('UPDATE purchase_order SET status = $2 WHERE id = $1', [o.id, st.open === 0 ? 'received' : st.some ? 'partially_received' : 'open']);
  await audit(tx, actor, { action: 'purchase_order.opening_line_imported', entityType: 'purchase_order', entityId: o.id, facilityId: input.facilityId, data: { number: input.orderNumber, lineNo, qty: input.qty, received } });
  return { id: o.id as string, created: lineNo === 1 };
}
