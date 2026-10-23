import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';

/**
 * Lot and serial tracking around the ledger (D-147): switching a part on, browsing lots, holds, and tracing a lot
 * backward (what it was made from, which supplier lot) and forward (what it went into, which customers received it).
 */
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Turns tracking on or off for a part. Stock already on hand must be counted into lots in the same step (each
 * storeroom's quantity exactly), so per-lot balances add up from the first moment; tracking goes off only at zero stock.
 */
export async function setTracking(tx: Tx, actor: Actor, partId: string, input: { tracking: 'none' | 'lot' | 'serial'; shelfLifeDays?: number | null;
  existing?: { locationId: string; lot: string; qty: number; expiresOn?: string | null }[] }) {
  requirePermission(actor, 'parts.manage');
  const p = await one(tx, 'SELECT * FROM part WHERE id = $1 FOR UPDATE', [partId]);
  if (!p) throw notFound('part');
  // Stock at every site (D-161), not only those this user can see: tracking is per part, for the whole company.
  const stock = await many(tx, `SELECT location_id, facility_id, code, facility_code, qty::float AS qty FROM part_stock_locations($1)`, [partId]);
  const unseen = stock.filter((s) => !can(actor, 'inventory.manage', s.facility_id));
  if (unseen.length && input.tracking !== p.tracking) {
    throw conflict(`${p.part_number} has stock at ${[...new Set(unseen.map((s) => s.facility_code))].join(', ')}, where you do not manage inventory; someone covering every site with stock must switch tracking`);
  }
  if (input.shelfLifeDays !== undefined) await tx.query('UPDATE part SET shelf_life_days = $2 WHERE id = $1', [partId, input.shelfLifeDays]);
  if (input.tracking === p.tracking) return { tracking: p.tracking };
  if (p.tracking !== 'none' && input.tracking !== 'none') throw invalid('switch tracking off (at zero stock) before changing between lots and serial numbers');
  if (input.tracking === 'none') {
    if (stock.length) throw conflict(`${p.part_number} has stock at ${stock.map((s) => s.code).join(', ')}; tracking goes off only at zero stock`);
  } else if (stock.length) {
    const given = input.existing ?? [];
    for (const s of stock) {
      const mine = given.filter((g) => g.locationId === s.location_id);
      const sum = r3(mine.reduce((a, g) => a + g.qty, 0));
      if (Math.abs(sum - s.qty) > 0.0005) throw invalid(`${s.code} holds ${s.qty} ${p.uom}; count it into ${input.tracking === 'serial' ? 'serial numbers' : 'lots'} (${sum} given)`);
    }
    if (given.some((g) => !stock.some((s) => s.location_id === g.locationId))) throw invalid('lots were given for a storeroom with no stock of this part');
    for (const g of given) {
      if (input.tracking === 'serial' && g.qty !== 1) throw invalid(`each serial number is one unit (${g.lot} has ${g.qty})`);
      const s = stock.find((x) => x.location_id === g.locationId)!;
      let lot = await one(tx, 'SELECT id FROM stock_lot WHERE part_id = $1 AND lower(number) = lower($2)', [partId, g.lot.trim()]);
      if (lot && input.tracking === 'serial') throw invalid(`serial number ${g.lot} is listed twice`);
      lot ??= await one(tx, `INSERT INTO stock_lot (tenant_id, part_id, number, kind, expires_on, made_on, source, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'opening', $7) RETURNING id`,
        [actor.tenantId, partId, g.lot.trim(), input.tracking, g.expiresOn ?? null, today(), actor.userId]);
      await tx.query(`INSERT INTO lot_balance (tenant_id, facility_id, location_id, lot_id, qty) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (location_id, lot_id) DO UPDATE SET qty = lot_balance.qty + EXCLUDED.qty`, [actor.tenantId, s.facility_id, g.locationId, lot.id, g.qty]);
    }
  }
  await tx.query('UPDATE part SET tracking = $2 WHERE id = $1', [partId, input.tracking]);
  await audit(tx, actor, { action: 'part.tracking_set', entityType: 'part', entityId: partId, data: { from: p.tracking, to: input.tracking, countedInto: input.existing?.length ?? 0 } });
  return { tracking: input.tracking };
}

/** Lots with stock (or all, for one part), with where they are, expiry and status. */
export async function listLots(tx: Tx, actor: Actor, q: { partId?: string; q?: string; status?: string; expiringDays?: number; all?: boolean } = {}) {
  requirePermission(actor, 'inventory.view');
  const rows = await many(tx, `SELECT l.id, l.number, l.kind, l.status, l.hold_reason, l.expires_on, l.made_on, l.supplier_lot, l.source, p.id AS part_id, p.part_number, p.description, p.uom,
      s.name AS supplier, po.number AS production_order,
      coalesce((SELECT sum(lb.qty) FROM lot_balance lb WHERE lb.lot_id = l.id), 0)::float AS on_hand,
      (SELECT json_agg(json_build_object('location_id', lb.location_id, 'location', sl.code, 'facility_id', lb.facility_id, 'qty', lb.qty::float) ORDER BY sl.code)
        FROM lot_balance lb JOIN stock_location sl ON sl.id = lb.location_id WHERE lb.lot_id = l.id AND lb.qty > 0) AS locations
    FROM stock_lot l JOIN part p ON p.id = l.part_id LEFT JOIN supplier s ON s.id = l.supplier_id LEFT JOIN production_order po ON po.id = l.production_order_id
    WHERE ($1::uuid IS NULL OR l.part_id = $1) AND ($2::text IS NULL OR l.number ILIKE '%' || $2 || '%' OR l.supplier_lot ILIKE '%' || $2 || '%' OR p.part_number ILIKE '%' || $2 || '%')
      AND ($3::text IS NULL OR l.status = $3) AND ($4::int IS NULL OR (l.expires_on IS NOT NULL AND l.expires_on <= current_date + $4))
    ORDER BY l.expires_on NULLS LAST, p.part_number, l.number LIMIT 500`, [q.partId ?? null, q.q?.trim() || null, q.status ?? null, q.expiringDays ?? null]);
  return rows.filter((r) => q.all || q.partId || q.q || r.on_hand > 0).map((r) => ({
    ...r, locations: (r.locations ?? []).filter((x: any) => can(actor, 'inventory.view', x.facility_id)),
    expired: !!r.expires_on && String(r.expires_on).slice(0, 10) < today(),
  }));
}

export async function setLotHold(tx: Tx, actor: Actor, id: string, input: { hold: boolean; reason?: string | null; nonconformanceId?: string | null }) {
  requirePermission(actor, 'inventory.manage');
  const l = await one(tx, 'SELECT l.*, p.part_number FROM stock_lot l JOIN part p ON p.id = l.part_id WHERE l.id = $1 FOR UPDATE OF l', [id]);
  if (!l) throw notFound('lot');
  if (l.status === 'scrapped') throw conflict(`${l.number} was scrapped`);
  if (input.hold && !input.reason?.trim()) throw invalid('give the reason for the hold');
  await tx.query(`UPDATE stock_lot SET status = $2, hold_reason = $3, nonconformance_id = coalesce($4, CASE WHEN $2 = 'available' THEN NULL ELSE nonconformance_id END) WHERE id = $1`,
    [id, input.hold ? 'hold' : 'available', input.hold ? input.reason!.trim() : null, input.nonconformanceId ?? null]);
  await audit(tx, actor, { action: input.hold ? 'lot.held' : 'lot.released', entityType: 'stock_lot', entityId: id, data: { lot: l.number, part: l.part_number, reason: input.reason ?? null, nonconformanceId: input.nonconformanceId ?? null } });
}

/**
 * One lot's story: where it came from (receipt and supplier lot, or the production order and the component lots it
 * consumed), every movement, and where it went (production orders and the lots they made, shipments to customers).
 */
export async function getLot(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'inventory.view');
  const lot = (await listLots(tx, actor, { all: true, q: undefined, partId: (await one(tx, 'SELECT part_id FROM stock_lot WHERE id = $1', [id]))?.part_id })).find((x) => x.id === id);
  if (!lot) throw notFound('lot');
  const movements = await many(tx, `SELECT t.id, t.created_at, t.txn_type, tl.qty::float AS qty, sl.code AS location, t.reference, t.reason, w.id AS work_order_id, w.number AS work_order,
      po.id AS production_order_id, po.number AS production_order, u.display_name AS by, t.facility_id
    FROM inventory_txn_lot tl JOIN inventory_txn t ON t.id = tl.txn_id JOIN stock_location sl ON sl.id = t.location_id JOIN app_user u ON u.id = t.created_by
    LEFT JOIN work_order w ON w.id = t.work_order_id LEFT JOIN production_order po ON po.id = t.production_order_id WHERE tl.lot_id = $1 ORDER BY t.id`, [id]);
  // Backward: what a production lot was made from (component lots issued to its order, net of returns).
  const madeFrom = lot.production_order ? await many(tx, `SELECT l.id, l.number, p.part_number, p.description, p.uom, l.supplier_lot, s.name AS supplier, -sum(tl.qty)::float AS qty
      FROM inventory_txn t JOIN inventory_txn_lot tl ON tl.txn_id = t.id JOIN stock_lot l ON l.id = tl.lot_id JOIN part p ON p.id = l.part_id LEFT JOIN supplier s ON s.id = l.supplier_id
      WHERE t.production_order_id = (SELECT production_order_id FROM stock_lot WHERE id = $1) AND t.txn_type IN ('production_issue', 'production_return')
      GROUP BY l.id, p.part_number, p.description, p.uom, s.name HAVING -sum(tl.qty) > 0 ORDER BY p.part_number, l.number`, [id]) : [];
  // Forward: production orders that consumed it, and the lots those orders made.
  const wentInto = await many(tx, `SELECT po.id, po.number, p.part_number, p.description, -sum(tl.qty)::float AS qty,
      (SELECT json_agg(json_build_object('id', ol.id, 'number', ol.number)) FROM stock_lot ol WHERE ol.production_order_id = po.id) AS made_lots
    FROM inventory_txn t JOIN inventory_txn_lot tl ON tl.txn_id = t.id JOIN production_order po ON po.id = t.production_order_id JOIN part p ON p.id = po.part_id
    WHERE tl.lot_id = $1 AND t.txn_type IN ('production_issue', 'production_return') GROUP BY po.id, p.part_number, p.description HAVING -sum(tl.qty) > 0`, [id]);
  const shipped = await many(tx, `SELECT sh.number AS shipment, sh.shipped_on, so.id AS order_id, so.number AS order_number, c.id AS customer_id, c.name AS customer, -tl.qty::float AS qty
    FROM inventory_txn_lot tl JOIN shipment_line shl ON shl.inventory_txn_id = tl.txn_id JOIN shipment sh ON sh.id = shl.shipment_id JOIN sales_order so ON so.id = sh.order_id
    JOIN customer c ON c.id = so.customer_id WHERE tl.lot_id = $1 ORDER BY sh.shipped_on`, [id]);
  const usedOn = await many(tx, `SELECT w.id, w.number, a.asset_tag, a.name AS asset, -sum(tl.qty)::float AS qty FROM inventory_txn t JOIN inventory_txn_lot tl ON tl.txn_id = t.id
    JOIN work_order w ON w.id = t.work_order_id JOIN asset a ON a.id = w.asset_id WHERE tl.lot_id = $1 AND t.txn_type IN ('issue', 'return')
    GROUP BY w.id, a.asset_tag, a.name HAVING -sum(tl.qty) > 0`, [id]);
  return { ...lot, movements: movements.filter((m) => can(actor, 'inventory.view', m.facility_id)), madeFrom, wentInto, shipped, usedOn };
}

/**
 * Where a lot ended up, following production one level at a time until nothing more was made from it: every
 * customer who received it or anything made from it (the recall list, brief §12.7 basic traceability).
 */
export async function traceForward(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'inventory.view');
  const seen = new Set<string>(); const queue = [id]; const customers = new Map<string, any>(); const lots: any[] = [];
  while (queue.length && seen.size < 500) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const l = await getLot(tx, actor, cur);
    lots.push({ id: l.id, number: l.number, part_number: l.part_number, on_hand: l.on_hand });
    for (const s of l.shipped) {
      const c = customers.get(s.customer_id) ?? { customer_id: s.customer_id, customer: s.customer, shipments: [] as any[] };
      c.shipments.push({ shipment: s.shipment, shipped_on: s.shipped_on, order_number: s.order_number, lot: l.number, part_number: l.part_number, qty: s.qty });
      customers.set(s.customer_id, c);
    }
    for (const w of l.wentInto) for (const m of w.made_lots ?? []) queue.push(m.id);
  }
  return { lots, customers: [...customers.values()] };
}
