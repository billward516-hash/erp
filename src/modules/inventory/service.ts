import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';

export type TxnType = 'receipt' | 'issue' | 'return' | 'adjustment' | 'count' | 'transfer_out' | 'transfer_in' | 'opening' | 'shipment'
  | 'production_issue' | 'production_return' | 'production_receipt';

export async function createLocation(tx: Tx, actor: Actor, input: { facilityId: string; code: string; name: string }) {
  requirePermission(actor, 'inventory.manage', input.facilityId);
  if (await one(tx, 'SELECT 1 FROM stock_location WHERE code = $1', [input.code])) throw conflict(`location ${input.code} already exists`);
  const l = await one(tx, 'INSERT INTO stock_location (tenant_id, facility_id, code, name) VALUES ($1, $2, $3, $4) RETURNING *',
    [actor.tenantId, input.facilityId, input.code, input.name]);
  await audit(tx, actor, { action: 'inventory.location_created', entityType: 'stock_location', entityId: l.id, facilityId: l.facility_id, data: { code: l.code } });
  return l;
}

export async function getLocation(tx: Tx, locationId: string) {
  const l = await one(tx, 'SELECT * FROM stock_location WHERE id = $1', [locationId]);
  if (!l) throw notFound('stock location');
  if (!l.active) throw invalid(`location ${l.code} is inactive`);
  return l;
}

/**
 * The only way stock changes: lock the balance row, apply the signed quantity, refuse to go negative,
 * append the ledger row with the resulting balance. Receipts at a cost update the part's moving
 * average cost (operational costing; the accounting system remains the book of record).
 */
export async function postTxn(
  tx: Tx, actor: Actor,
  t: { locationId: string; partId: string; type: TxnType; qty: number; unitCost?: number | null; workOrderId?: string | null; countId?: string | null; productionOrderId?: string | null; reference?: string | null; reason?: string | null },
) {
  if (!t.qty) throw invalid('quantity must not be zero');
  const loc = await getLocation(tx, t.locationId);
  const part = await one(tx, 'SELECT id, part_number, unit_cost FROM part WHERE id = $1', [t.partId]);
  if (!part) throw notFound('part');
  await tx.query(`INSERT INTO inventory_balance (tenant_id, facility_id, location_id, part_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [actor.tenantId, loc.facility_id, loc.id, part.id]);
  const bal = await one(tx, 'SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2 FOR UPDATE', [loc.id, part.id]);
  const after = Math.round((Number(bal.qty_on_hand) + t.qty) * 1000) / 1000;
  if (after < 0) {
    throw new AppError(422, 'insufficient_stock', `only ${bal.qty_on_hand} of ${part.part_number} on hand at ${loc.code}`, { onHand: Number(bal.qty_on_hand), requested: -t.qty });
  }
  if (t.qty > 0 && t.unitCost != null && ['receipt', 'opening', 'production_receipt'].includes(t.type)) {
    const total = await one<{ q: number }>(tx, 'SELECT coalesce(sum(qty_on_hand), 0)::float AS q FROM inventory_balance WHERE part_id = $1', [part.id]);
    const prior = total!.q;
    const avg = part.unit_cost == null || prior <= 0 ? t.unitCost : (prior * Number(part.unit_cost) + t.qty * t.unitCost) / (prior + t.qty);
    await tx.query('UPDATE part SET unit_cost = $2 WHERE id = $1', [part.id, Math.round(avg * 10000) / 10000]);
  }
  await tx.query('UPDATE inventory_balance SET qty_on_hand = $3, updated_at = now() WHERE location_id = $1 AND part_id = $2', [loc.id, part.id, after]);
  const row = await one(
    tx,
    `INSERT INTO inventory_txn (tenant_id, facility_id, location_id, part_id, txn_type, qty, unit_cost, balance_after, work_order_id, count_id, reference, reason, created_by, production_order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, created_at`,
    [actor.tenantId, loc.facility_id, loc.id, part.id, t.type, t.qty, t.unitCost ?? part.unit_cost ?? null, after, t.workOrderId ?? null, t.countId ?? null,
      t.reference ?? null, t.reason ?? null, actor.userId, t.productionOrderId ?? null],
  );
  return { txnId: row.id as number, balanceAfter: after, location: loc, part };
}

export async function receive(tx: Tx, actor: Actor, input: { locationId: string; partId: string; qty: number; unitCost?: number | null; reference?: string | null }) {
  const loc = await getLocation(tx, input.locationId);
  requirePermission(actor, 'inventory.manage', loc.facility_id);
  if (!(input.qty > 0)) throw invalid('received quantity must be positive');
  const r = await postTxn(tx, actor, { ...input, type: 'receipt' });
  await audit(tx, actor, { action: 'inventory.received', entityType: 'part', entityId: input.partId, facilityId: loc.facility_id,
    data: { location: loc.code, qty: input.qty, unitCost: input.unitCost ?? null, reference: input.reference ?? null } });
  return r;
}

export async function adjust(tx: Tx, actor: Actor, input: { locationId: string; partId: string; qty: number; reason: string }) {
  const loc = await getLocation(tx, input.locationId);
  requirePermission(actor, 'inventory.manage', loc.facility_id);
  if (!input.reason || input.reason.trim().length < 5) throw invalid('adjustments need a reason');
  const r = await postTxn(tx, actor, { locationId: input.locationId, partId: input.partId, type: 'adjustment', qty: input.qty, reason: input.reason });
  await audit(tx, actor, { action: 'inventory.adjusted', entityType: 'part', entityId: input.partId, facilityId: loc.facility_id, data: { location: loc.code, qty: input.qty, reason: input.reason } });
  return r;
}

export async function transfer(tx: Tx, actor: Actor, input: { fromLocationId: string; toLocationId: string; partId: string; qty: number; reference?: string | null }) {
  if (input.fromLocationId === input.toLocationId) throw invalid('choose two different locations');
  if (!(input.qty > 0)) throw invalid('transfer quantity must be positive');
  const [from, to] = [await getLocation(tx, input.fromLocationId), await getLocation(tx, input.toLocationId)];
  requirePermission(actor, 'inventory.manage', from.facility_id);
  requirePermission(actor, 'inventory.manage', to.facility_id);
  const ref = input.reference ?? `TR-${Date.now().toString(36).toUpperCase()}`;
  await postTxn(tx, actor, { locationId: from.id, partId: input.partId, type: 'transfer_out', qty: -input.qty, reference: ref });
  await postTxn(tx, actor, { locationId: to.id, partId: input.partId, type: 'transfer_in', qty: input.qty, reference: ref });
  await audit(tx, actor, { action: 'inventory.transferred', entityType: 'part', entityId: input.partId, facilityId: from.facility_id, data: { from: from.code, to: to.code, qty: input.qty, reference: ref } });
  return { reference: ref };
}

export async function setStockSettings(tx: Tx, actor: Actor, locationId: string, partId: string,
  input: { reorderPoint?: number | null; reorderQty?: number | null; bin?: string | null }) {
  const loc = await getLocation(tx, locationId);
  requirePermission(actor, 'inventory.manage', loc.facility_id);
  await tx.query(`INSERT INTO inventory_balance (tenant_id, facility_id, location_id, part_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [actor.tenantId, loc.facility_id, loc.id, partId]);
  const cur = await one(tx, 'SELECT * FROM inventory_balance WHERE location_id = $1 AND part_id = $2 FOR UPDATE', [loc.id, partId]);
  await tx.query('UPDATE inventory_balance SET reorder_point = $3, reorder_qty = $4, bin = $5, updated_at = now() WHERE location_id = $1 AND part_id = $2',
    [loc.id, partId, input.reorderPoint !== undefined ? input.reorderPoint : cur.reorder_point, input.reorderQty !== undefined ? input.reorderQty : cur.reorder_qty,
      input.bin !== undefined ? input.bin : cur.bin]);
}

export async function listLocations(tx: Tx, actor: Actor) {
  requirePermission(actor, 'inventory.view');
  return many(tx, `SELECT l.*, f.code AS facility_code FROM stock_location l JOIN facility f ON f.id = l.facility_id ORDER BY f.code, l.code`);
}

export async function listBalances(tx: Tx, actor: Actor, q: { facilityId?: string; locationId?: string; q?: string; belowReorder?: boolean; partId?: string }) {
  requirePermission(actor, 'inventory.view', q.facilityId);
  const rows = await many(
    tx,
    `SELECT b.location_id, l.code AS location, b.facility_id, f.code AS facility_code, b.part_id, p.part_number, p.description, p.uom, p.unit_cost,
            b.qty_on_hand, b.bin, b.reorder_point, b.reorder_qty,
            (b.reorder_point IS NOT NULL AND b.qty_on_hand <= b.reorder_point) AS below_reorder,
            (SELECT max(t.created_at) FROM inventory_txn t WHERE t.location_id = b.location_id AND t.part_id = b.part_id) AS last_movement
     FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id JOIN part p ON p.id = b.part_id JOIN facility f ON f.id = b.facility_id
     WHERE ($1::uuid IS NULL OR b.facility_id = $1) AND ($2::uuid IS NULL OR b.location_id = $2) AND ($3::uuid IS NULL OR b.part_id = $3)
       AND ($4::text IS NULL OR p.part_number ILIKE '%' || $4 || '%' OR p.description ILIKE '%' || $4 || '%')
       AND (NOT $5 OR (b.reorder_point IS NOT NULL AND b.qty_on_hand <= b.reorder_point))
     ORDER BY f.code, l.code, p.part_number`,
    [q.facilityId ?? null, q.locationId ?? null, q.partId ?? null, q.q ?? null, q.belowReorder ?? false],
  );
  return rows.filter((r) => can(actor, 'inventory.view', r.facility_id));
}

export async function ledger(tx: Tx, actor: Actor, q: { partId?: string; locationId?: string; workOrderId?: string; limit?: number }) {
  requirePermission(actor, 'inventory.view');
  return many(
    tx,
    `SELECT t.id, t.created_at, t.txn_type, t.qty, t.unit_cost, t.balance_after, t.reference, t.reason, l.code AS location, p.part_number,
            w.number AS work_order, u.display_name AS by
     FROM inventory_txn t JOIN stock_location l ON l.id = t.location_id JOIN part p ON p.id = t.part_id JOIN app_user u ON u.id = t.created_by
     LEFT JOIN work_order w ON w.id = t.work_order_id
     WHERE ($1::uuid IS NULL OR t.part_id = $1) AND ($2::uuid IS NULL OR t.location_id = $2) AND ($3::uuid IS NULL OR t.work_order_id = $3)
     ORDER BY t.id DESC LIMIT $4`,
    [q.partId ?? null, q.locationId ?? null, q.workOrderId ?? null, Math.min(q.limit ?? 200, 1000)],
  );
}

// ---------------------------------------------------------------------------
// Cycle counts
// ---------------------------------------------------------------------------

/** Opens a count for a location; expected quantities are snapshotted now. */
export async function openCount(tx: Tx, actor: Actor, locationId: string, input: { partIds?: string[]; note?: string | null } = {}) {
  const loc = await getLocation(tx, locationId);
  requirePermission(actor, 'inventory.manage', loc.facility_id);
  if (await one(tx, `SELECT 1 FROM inventory_count WHERE location_id = $1 AND status = 'open'`, [locationId])) throw conflict(`a count is already open at ${loc.code}`);
  const c = await one(tx, 'INSERT INTO inventory_count (tenant_id, facility_id, location_id, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [actor.tenantId, loc.facility_id, loc.id, input.note ?? null, actor.userId]);
  const parts = input.partIds?.length
    ? await many(tx, `SELECT p.id, coalesce(b.qty_on_hand, 0) AS qty FROM part p LEFT JOIN inventory_balance b ON b.part_id = p.id AND b.location_id = $1 WHERE p.id = ANY ($2)`, [loc.id, input.partIds])
    : await many(tx, 'SELECT part_id AS id, qty_on_hand AS qty FROM inventory_balance WHERE location_id = $1', [loc.id]);
  if (!parts.length) throw invalid('nothing to count at this location');
  for (const p of parts) {
    await tx.query('INSERT INTO inventory_count_line (tenant_id, count_id, part_id, expected_qty) VALUES ($1, $2, $3, $4)', [actor.tenantId, c.id, p.id, p.qty]);
  }
  await audit(tx, actor, { action: 'inventory.count_opened', entityType: 'inventory_count', entityId: c.id, facilityId: loc.facility_id, data: { location: loc.code, lines: parts.length } });
  return c;
}

export async function recordCounts(tx: Tx, actor: Actor, countId: string, lines: { partId: string; countedQty: number }[]) {
  const c = await one(tx, 'SELECT * FROM inventory_count WHERE id = $1 FOR UPDATE', [countId]);
  if (!c) throw notFound('count');
  requirePermission(actor, 'inventory.manage', c.facility_id);
  if (c.status !== 'open') throw conflict(`count is ${c.status}`);
  for (const l of lines) {
    if (!(l.countedQty >= 0)) throw invalid('counted quantities cannot be negative');
    const r = await one(tx, `UPDATE inventory_count_line SET counted_qty = $3, counted_by = $4, counted_at = now() WHERE count_id = $1 AND part_id = $2 RETURNING part_id`,
      [countId, l.partId, l.countedQty, actor.userId]);
    if (!r) throw invalid('part is not on this count sheet');
  }
}

/**
 * Posts variances as 'count' transactions. Refuses when counted parts moved after the count was
 * opened (the expected snapshot would be stale) unless the caller confirms with acceptMovement,
 * in which case the adjustment is computed against the current on-hand quantity.
 */
export async function postCount(tx: Tx, actor: Actor, countId: string, opts: { acceptMovement?: boolean } = {}) {
  const c = await one(tx, 'SELECT c.*, l.code AS location FROM inventory_count c JOIN stock_location l ON l.id = c.location_id WHERE c.id = $1 FOR UPDATE OF c', [countId]);
  if (!c) throw notFound('count');
  requirePermission(actor, 'inventory.manage', c.facility_id);
  if (c.status !== 'open') throw conflict(`count is ${c.status}`);
  const lines = await many(tx, `SELECT cl.*, p.part_number, coalesce(b.qty_on_hand, 0) AS on_hand,
      EXISTS (SELECT 1 FROM inventory_txn t WHERE t.location_id = $2 AND t.part_id = cl.part_id AND t.created_at > $3) AS moved
    FROM inventory_count_line cl JOIN part p ON p.id = cl.part_id LEFT JOIN inventory_balance b ON b.part_id = cl.part_id AND b.location_id = $2
    WHERE cl.count_id = $1`, [countId, c.location_id, c.created_at]);
  const uncounted = lines.filter((l) => l.counted_qty == null);
  if (uncounted.length) throw invalid(`${uncounted.length} line(s) not counted yet: ${uncounted.slice(0, 5).map((l) => l.part_number).join(', ')}`);
  const moved = lines.filter((l) => l.moved);
  if (moved.length && !opts.acceptMovement) {
    throw new AppError(409, 'stock_moved', `stock moved after the count was opened for ${moved.map((l) => l.part_number).join(', ')}; recount or confirm to adjust against current quantities`, { moved: moved.map((l) => l.part_number) });
  }
  const variances = [];
  for (const l of lines) {
    const delta = Math.round((Number(l.counted_qty) - Number(l.on_hand)) * 1000) / 1000;
    if (delta !== 0) {
      await postTxn(tx, actor, { locationId: c.location_id, partId: l.part_id, type: 'count', qty: delta, countId, reason: `cycle count at ${c.location}` });
      variances.push({ partNumber: l.part_number, expected: Number(l.on_hand), counted: Number(l.counted_qty), delta });
    }
  }
  await tx.query(`UPDATE inventory_count SET status = 'posted', posted_by = $2, posted_at = now() WHERE id = $1`, [countId, actor.userId]);
  await audit(tx, actor, { action: 'inventory.count_posted', entityType: 'inventory_count', entityId: countId, facilityId: c.facility_id, data: { location: c.location, variances } });
  return { lines: lines.length, variances };
}

export async function getCount(tx: Tx, actor: Actor, countId: string) {
  const c = await one(tx, 'SELECT c.*, l.code AS location FROM inventory_count c JOIN stock_location l ON l.id = c.location_id WHERE c.id = $1', [countId]);
  if (!c) throw notFound('count');
  requirePermission(actor, 'inventory.view', c.facility_id);
  const lines = await many(tx, `SELECT cl.part_id, p.part_number, p.description, p.uom, cl.expected_qty, cl.counted_qty, b.bin FROM inventory_count_line cl
    JOIN part p ON p.id = cl.part_id LEFT JOIN inventory_balance b ON b.part_id = cl.part_id AND b.location_id = $2 WHERE cl.count_id = $1 ORDER BY b.bin NULLS LAST, p.part_number`, [countId, c.location_id]);
  return { ...c, lines };
}

export async function listCounts(tx: Tx, actor: Actor) {
  requirePermission(actor, 'inventory.view');
  return many(tx, `SELECT c.id, c.status, c.created_at, c.posted_at, l.code AS location, (SELECT count(*)::int FROM inventory_count_line x WHERE x.count_id = c.id) AS lines,
    (SELECT count(*)::int FROM inventory_count_line x WHERE x.count_id = c.id AND x.counted_qty IS NOT NULL) AS counted
    FROM inventory_count c JOIN stock_location l ON l.id = c.location_id ORDER BY c.created_at DESC LIMIT 50`);
}
