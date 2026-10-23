import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { AppError, invalid } from '../../platform/errors.js';

/**
 * Lots and serials (D-147). Called by postTxn for parts with tracking on: every movement names the lots it moves, the
 * per-lot balances move with it, and they always add up to the storeroom balance.
 * - Into stock: the lots must be given (a receipt names the supplier's lot or the serials). Returns without lots go
 *   back to the lots last issued to the same work or production order; a finished-goods receipt without a lot gets
 *   the production order's number.
 * - Out of stock: the named lots, or else first-expiring then oldest, usable lots before held or expired ones. Issues and
 *   shipments never take lots on hold or past their expiry; other movements (transfers, counts, adjustments) may when
 *   named or when nothing usable is left, so held stock can be moved or scrapped.
 */
export interface LotSpec { lot: string; qty: number; expiresOn?: string | null; supplierLot?: string | null; madeOn?: string | null }
export interface LotMove { lotId: string; lot: string; qty: number }

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Movements that use stock for its purpose: they never take held or expired lots. */
const CONSUMING = new Set(['issue', 'production_issue', 'shipment']);
const SOURCE: Record<string, string> = { receipt: 'receipt', production_receipt: 'production', opening: 'opening', return: 'return', production_return: 'return', count: 'count', adjustment: 'adjustment' };

interface Ctx {
  txnId: number; type: string; qty: number;
  part: { id: string; part_number: string; tracking: 'lot' | 'serial'; shelf_life_days: number | null };
  location: { id: string; code: string; facility_id: string };
  lots?: LotSpec[] | null; supplierId?: string | null; productionOrderId?: string | null; workOrderId?: string | null; productionOrderNumber?: string | null;
}

export async function applyLots(tx: Tx, actor: Actor, c: Ctx): Promise<LotMove[]> {
  const label = c.part.tracking === 'serial' ? 'serial number' : 'lot';
  let moves: LotMove[];
  if (c.qty > 0) moves = await inbound(tx, actor, c, label);
  else moves = await outbound(tx, c, label);
  for (const m of moves) {
    if (m.qty < 0) await tx.query('UPDATE lot_balance SET qty = qty + $3 WHERE location_id = $1 AND lot_id = $2', [c.location.id, m.lotId, m.qty]);
    else await tx.query(`INSERT INTO lot_balance (tenant_id, facility_id, location_id, lot_id, qty) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (location_id, lot_id) DO UPDATE SET qty = lot_balance.qty + EXCLUDED.qty`, [actor.tenantId, c.location.facility_id, c.location.id, m.lotId, m.qty]);
    await tx.query('INSERT INTO inventory_txn_lot (tenant_id, facility_id, txn_id, lot_id, qty) VALUES ($1, $2, $3, $4, $5)', [actor.tenantId, c.location.facility_id, c.txnId, m.lotId, m.qty]);
  }
  // Per-lot balances always add up to the storeroom balance.
  const chk = await one(tx, `SELECT (SELECT coalesce(sum(lb.qty), 0) FROM lot_balance lb JOIN stock_lot l ON l.id = lb.lot_id WHERE lb.location_id = $1 AND l.part_id = $2)::float AS lots,
    (SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2)::float AS onhand`, [c.location.id, c.part.id]);
  if (Math.abs(chk.lots - chk.onhand) > 0.0005) throw new AppError(500, 'lot_mismatch', `${c.part.part_number} at ${c.location.code}: lots hold ${chk.lots} but the storeroom holds ${chk.onhand}`);
  return moves;
}

async function inbound(tx: Tx, actor: Actor, c: Ctx, label: string): Promise<LotMove[]> {
  let specs = c.lots?.filter((s) => s.qty) ?? [];
  if (!specs.length && (c.type === 'return' || c.type === 'production_return') && (c.workOrderId || c.productionOrderId)) {
    specs = await lastIssued(tx, c);
  }
  if (!specs.length && c.type === 'production_receipt' && c.part.tracking === 'lot' && c.productionOrderNumber) specs = [{ lot: c.productionOrderNumber, qty: c.qty }];
  if (!specs.length) throw invalid(`${c.part.part_number} is tracked by ${label}: say which ${label}${c.part.tracking === 'serial' ? 's' : ''} ${c.qty === 1 ? 'this is' : 'these are'}`);
  const sum = r3(specs.reduce((s, x) => s + x.qty, 0));
  if (Math.abs(sum - c.qty) > 0.0005) throw invalid(`${c.part.part_number}: the ${label}s add up to ${sum}, not ${c.qty}`);
  const seen = new Set<string>();
  const moves: LotMove[] = [];
  for (const s of specs) {
    const number = s.lot.trim();
    if (!number) throw invalid(`${c.part.part_number}: a ${label} is blank`);
    if (seen.has(number.toLowerCase())) throw invalid(`${c.part.part_number}: ${label} ${number} is listed twice`);
    seen.add(number.toLowerCase());
    if (c.part.tracking === 'serial' && s.qty !== 1) throw invalid(`${c.part.part_number}: each serial number is one unit (${number} has ${s.qty})`);
    if (s.qty <= 0) throw invalid(`${c.part.part_number}: ${label} ${number} needs a positive quantity`);
    let lot = await one(tx, 'SELECT * FROM stock_lot WHERE part_id = $1 AND lower(number) = lower($2) FOR UPDATE', [c.part.id, number]);
    if (lot) {
      if (lot.status === 'scrapped') throw invalid(`${label} ${lot.number} of ${c.part.part_number} was scrapped`);
      if (c.part.tracking === 'serial') {
        const held = Number((await one(tx, 'SELECT lot_stock_total($1) AS q', [lot.id])).q); // at any site (D-161)
        if (held > 0) throw invalid(`serial number ${lot.number} of ${c.part.part_number} is already in stock`);
      }
      if (s.expiresOn && lot.expires_on && String(lot.expires_on).slice(0, 10) !== s.expiresOn) throw invalid(`${label} ${lot.number} already expires on ${String(lot.expires_on).slice(0, 10)}`);
    } else {
      if (c.type === 'transfer_in') throw invalid(`${label} ${number} of ${c.part.part_number} does not exist`);
      const made = s.madeOn ?? today();
      const expires = s.expiresOn ?? (c.part.shelf_life_days ? addDays(made, c.part.shelf_life_days) : null);
      lot = await one(tx, `INSERT INTO stock_lot (tenant_id, part_id, number, kind, expires_on, made_on, supplier_id, supplier_lot, source, production_order_id, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [actor.tenantId, c.part.id, number, c.part.tracking, expires, made, c.supplierId ?? null, s.supplierLot ?? null, SOURCE[c.type] ?? 'adjustment',
        c.type === 'production_receipt' ? c.productionOrderId ?? null : null, actor.userId]);
    }
    moves.push({ lotId: lot.id, lot: lot.number, qty: r3(s.qty) });
  }
  return moves;
}

/** The lots issued to this work or production order from this storeroom and not yet returned: last issued first (within one issue, the later-expiring lot, which FEFO took last). */
async function lastIssued(tx: Tx, c: Ctx): Promise<LotSpec[]> {
  const rows = await many(tx, `SELECT l.number, -sum(tl.qty)::float AS net, max(t.id) AS last FROM inventory_txn_lot tl JOIN inventory_txn t ON t.id = tl.txn_id JOIN stock_lot l ON l.id = tl.lot_id
    WHERE t.part_id = $1 AND t.location_id = $2 AND t.txn_type IN ('issue', 'return', 'production_issue', 'production_return')
      AND (($3::uuid IS NOT NULL AND t.work_order_id = $3) OR ($4::uuid IS NOT NULL AND t.production_order_id = $4))
    GROUP BY l.number HAVING -sum(tl.qty) > 0 ORDER BY last DESC, max(l.expires_on) DESC NULLS FIRST`, [c.part.id, c.location.id, c.workOrderId ?? null, c.productionOrderId ?? null]);
  let left = c.qty; const out: LotSpec[] = [];
  for (const r of rows) { if (left <= 0) break; const q = r3(Math.min(left, r.net)); out.push({ lot: r.number, qty: q }); left = r3(left - q); }
  return left > 0.0005 ? [] : out;
}

async function outbound(tx: Tx, c: Ctx, label: string): Promise<LotMove[]> {
  const need = r3(-c.qty);
  const consuming = CONSUMING.has(c.type);
  const usable = (l: any) => !consuming || (l.status === 'available' && (!l.expires_on || String(l.expires_on).slice(0, 10) >= today()));
  const why = (l: any) => (l.status !== 'available' ? `on hold${l.hold_reason ? ` (${l.hold_reason})` : ''}` : `expired on ${String(l.expires_on).slice(0, 10)}`);
  const stock = await many(tx, `SELECT l.id, l.number, l.status, l.hold_reason, l.expires_on, lb.qty::float AS qty FROM lot_balance lb JOIN stock_lot l ON l.id = lb.lot_id
    WHERE lb.location_id = $1 AND l.part_id = $2 AND lb.qty > 0 ORDER BY l.expires_on NULLS LAST, l.made_on, l.created_at, l.number FOR UPDATE OF lb`, [c.location.id, c.part.id]);
  if (c.lots?.length) {
    const moves: LotMove[] = [];
    const taken = new Map<string, number>(); // a lot named twice is checked against its stock once, in total (D-161)
    for (const s of c.lots.filter((x) => x.qty)) {
      const l = stock.find((x) => x.number.toLowerCase() === s.lot.trim().toLowerCase());
      if (!l) throw invalid(`${label} ${s.lot} of ${c.part.part_number} is not in stock at ${c.location.code}`);
      if (!usable(l)) throw invalid(`${label} ${l.number} of ${c.part.part_number} is ${why(l)}`);
      const total = r3((taken.get(l.id) ?? 0) + s.qty);
      if (total > l.qty + 0.0005) throw invalid(`only ${l.qty} of ${label} ${l.number} at ${c.location.code}`);
      taken.set(l.id, total);
      moves.push({ lotId: l.id, lot: l.number, qty: -r3(s.qty) });
    }
    const sum = r3(-moves.reduce((s, m) => s + m.qty, 0));
    if (Math.abs(sum - need) > 0.0005) throw invalid(`${c.part.part_number}: the ${label}s add up to ${sum}, not ${need}`);
    return moves;
  }
  // Usable lots first (first to expire), so a transfer or kit staging never strands good stock behind expired or held
  // lots; moves that may take those reach them only when nothing usable is left.
  const good = (l: any) => l.status === 'available' && (!l.expires_on || String(l.expires_on).slice(0, 10) >= today());
  const order = [...stock.filter(good), ...stock.filter((l) => !good(l) && usable(l))];
  const moves: LotMove[] = []; let left = need;
  for (const l of order) {
    if (left <= 0.0005) break;
    const q = r3(Math.min(left, l.qty));
    moves.push({ lotId: l.id, lot: l.number, qty: -q }); left = r3(left - q);
  }
  if (left > 0.0005) {
    const blocked = stock.filter((l) => !usable(l));
    throw new AppError(422, 'insufficient_stock', `only ${r3(need - left)} of ${c.part.part_number} at ${c.location.code} can be used${blocked.length ? `; ${blocked.map((l) => `${l.number} is ${why(l)}`).join(', ')}` : ''}`);
  }
  return moves;
}
