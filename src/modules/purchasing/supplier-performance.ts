import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { createCapa } from '../quality/service.js';

/**
 * Supplier performance from records already kept (docs/ARCHITECTURE.md §12p, D-117): delivery from order lines and
 * their receipts, quality from nonconformances raised at receiving or against the supplier, price from order prices
 * against the supplier's quoted price and invoice prices against the order. Thresholds are stated, not hidden.
 */
export const THRESHOLDS = {
  onTime: { good: 0.95, watch: 0.85 },        // share of order lines received complete by the expected date
  ppm: { good: 1_000, watch: 10_000 },         // rejected parts per million received
  minLines: 5,                                 // fewer lines due than this: delivery "too few to rate"
};
type Tone = 'good' | 'watch' | 'poor' | 'none';
const rate = (v: number | null, t: { good: number; watch: number }, higherIsBetter: boolean): Tone =>
  v == null ? 'none' : higherIsBetter ? (v >= t.good ? 'good' : v >= t.watch ? 'watch' : 'poor') : (v <= t.good ? 'good' : v <= t.watch ? 'watch' : 'poor');
const worst = (xs: Tone[]): Tone => (xs.includes('poor') ? 'poor' : xs.includes('watch') ? 'watch' : xs.includes('good') ? 'good' : 'none');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function supplierScorecards(tx: Tx, actor: Actor, q: { from?: string; to?: string; facilityId?: string | null; supplierId?: string | null } = {}) {
  if (!can(actor, 'purchasing.view', q.facilityId ?? undefined) && !can(actor, 'quality.view', q.facilityId ?? undefined)) throw forbidden('purchasing.view');
  const to = q.to ?? today(); const from = q.from ?? addDays(to, -90);
  const f = q.facilityId ?? null; const s = q.supplierId ?? null;
  // Delivery: lines due in the period; completed when cumulative receipts reach the ordered quantity.
  const lines = await many(tx, `WITH r AS (
      SELECT order_line_id, received_at, sum(qty) OVER (PARTITION BY order_line_id ORDER BY received_at, id) AS cum FROM po_receipt)
    SELECT o.supplier_id, o.number, l.id, l.description, o.expected_on, l.qty_ordered::float AS qty,
      (SELECT min(r.received_at) FROM r WHERE r.order_line_id = l.id AND r.cum >= l.qty_ordered) AS completed_at
    FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
    WHERE o.status <> 'cancelled' AND o.expected_on BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR o.facility_id = $3) AND ($4::uuid IS NULL OR o.supplier_id = $4)`, [from, to, f, s]);
  // Delivery history imported from the previous system: complete when the received quantity reaches the ordered one.
  const legacy = await many(tx, `SELECT supplier_id, reference AS number, description, due_on AS expected_on, qty_ordered::float AS qty, qty_received::float AS received, qty_rejected::float AS rejected,
      received_on, CASE WHEN qty_received >= qty_ordered THEN received_on END AS completed_at
    FROM supplier_delivery_history WHERE ($3::uuid IS NULL OR facility_id = $3) AND ($4::uuid IS NULL OR supplier_id = $4) AND (due_on BETWEEN $1 AND $2 OR received_on BETWEEN $1 AND $2)`, [from, to, f, s]);
  for (const l of legacy) {
    const due = String(l.expected_on instanceof Date ? l.expected_on.toISOString() : l.expected_on).slice(0, 10);
    if (due >= from && due <= to) lines.push({ ...l, legacy: true });
  }
  const noDate = await many(tx, `SELECT o.supplier_id, count(*)::int AS n FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
    WHERE o.status <> 'cancelled' AND o.expected_on IS NULL AND o.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR o.facility_id = $3) GROUP BY 1`, [from, to, f]);
  const received = await many(tx, `SELECT o.supplier_id, sum(coalesce(r.stock_qty, r.qty))::float AS qty FROM po_receipt r JOIN purchase_order_line l ON l.id = r.order_line_id JOIN purchase_order o ON o.id = l.order_id
    WHERE r.received_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR o.facility_id = $3) GROUP BY 1`, [from, to, f]);
  const ncrs = await many(tx, `SELECT n.supplier_id, n.id, n.number, n.title, n.severity, n.status, n.source, coalesce(n.qty, 0)::float AS qty, n.created_at FROM nonconformance n
    WHERE n.supplier_id IS NOT NULL AND n.source IN ('receiving', 'supplier') AND n.status <> 'cancelled' AND n.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR n.facility_id = $3)
    ORDER BY n.created_at DESC`, [from, to, f]);
  const price = await many(tx, `SELECT o.supplier_id, count(*)::int AS lines,
      count(*) FILTER (WHERE sp.unit_price IS NOT NULL AND l.unit_price > sp.unit_price * 1.005)::int AS above_quote
    FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id LEFT JOIN supplier_part sp ON sp.supplier_id = o.supplier_id AND sp.part_id = l.part_id
    WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR o.facility_id = $3) GROUP BY 1`, [from, to, f]);
  const invoiced = await many(tx, `SELECT i.supplier_id, sum((il.unit_price - pl.unit_price) * il.qty)::float AS variance FROM supplier_invoice_line il
      JOIN supplier_invoice i ON i.id = il.invoice_id JOIN purchase_order_line pl ON pl.id = il.po_line_id
    WHERE i.status NOT IN ('void', 'disputed') AND i.invoice_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR i.facility_id = $3) GROUP BY 1`, [from, to, f]);
  const scars = await many(tx, `SELECT c.id, c.number, c.title, c.status, c.supplier_id, c.supplier_response_due, c.supplier_responded_at FROM corrective_action c
    WHERE c.supplier_id IS NOT NULL AND c.status NOT IN ('closed', 'cancelled') AND ($1::uuid IS NULL OR c.facility_id = $1)`, [f]);
  const suppliers = await many(tx, `SELECT id, code, name FROM supplier WHERE ($1::uuid IS NULL OR id = $1) ORDER BY name`, [s]);
  const now = today();
  const out = suppliers.map((sup) => {
    const L = lines.filter((x) => x.supplier_id === sup.id).map((x: any) => {
      const due = String(x.expected_on instanceof Date ? x.expected_on.toISOString() : x.expected_on).slice(0, 10);
      const done = x.completed_at ? new Date(x.completed_at).toISOString().slice(0, 10) : null;
      const state = done ? (done <= due ? 'on_time' : 'late') : due < now ? 'late_open' : 'not_due';
      const daysLate = state === 'late' ? (Date.parse(done!) - Date.parse(due)) / 86_400_000 : state === 'late_open' ? (Date.parse(now) - Date.parse(due)) / 86_400_000 : 0;
      return { order: x.number, description: x.description, due, completed: done, state, daysLate, legacy: !!x.legacy };
    });
    const rated = L.filter((x) => x.state !== 'not_due');
    const onTime = rated.length ? rated.filter((x) => x.state === 'on_time').length / rated.length : null;
    const late = rated.filter((x) => x.state !== 'on_time');
    const inPeriod = (d: any) => { const x = d == null ? null : String(d instanceof Date ? d.toISOString() : d).slice(0, 10); return !!x && x >= from && x <= to; };
    const legacyRecv = legacy.filter((x) => x.supplier_id === sup.id && inPeriod(x.received_on));
    const recv = (received.find((x) => x.supplier_id === sup.id)?.qty ?? 0) + legacyRecv.reduce((t, x) => t + x.received, 0);
    const N = ncrs.filter((x) => x.supplier_id === sup.id);
    const rejected = N.reduce((t, x) => t + x.qty, 0) + legacyRecv.reduce((t, x) => t + x.rejected, 0);
    // Lots rejected at receiving are usually held, not received into stock: they count as inspected too.
    const inspected = recv + N.filter((x) => x.source === 'receiving').reduce((t, x) => t + x.qty, 0);
    const ppm = inspected > 0 ? Math.round((rejected / inspected) * 1e6) : null;
    const P = price.find((x) => x.supplier_id === sup.id);
    const S = scars.filter((x) => x.supplier_id === sup.id).map((x) => ({ ...x, overdue: !x.supplier_responded_at && String(x.supplier_response_due instanceof Date ? x.supplier_response_due.toISOString() : x.supplier_response_due).slice(0, 10) < now }));
    const delivery: Tone = rated.length < THRESHOLDS.minLines ? 'none' : rate(onTime, THRESHOLDS.onTime, true);
    // Nonconformances with nothing received in the period: no rate can be computed, so it is a watch, not a rating.
    const quality: Tone = inspected > 0 && ppm != null ? rate(ppm, THRESHOLDS.ppm, false) : N.length ? 'watch' : 'none';
    const response: Tone = S.some((x) => x.overdue) ? 'poor' : S.length ? 'watch' : 'none';
    const active = L.length || recv || N.length || P?.lines;
    return {
      supplierId: sup.id, code: sup.code, name: sup.name, active: !!(active || legacyRecv.length), legacyLines: L.filter((x) => x.legacy).length,
      delivery: { linesDue: rated.length, onTime: onTime == null ? null : Math.round(onTime * 1000) / 1000, late: late.length, avgDaysLate: late.length ? Math.round((late.reduce((t, x) => t + x.daysLate, 0) / late.length) * 10) / 10 : null,
        openPastDue: rated.filter((x) => x.state === 'late_open').length, withoutDate: noDate.find((x) => x.supplier_id === sup.id)?.n ?? 0, tone: delivery, lateLines: late.slice(0, 10) },
      quality: { received: recv, inspected, rejected, ppm, ncrs: N.length, tone: quality, recentNcrs: N.slice(0, 5).map((x) => ({ id: x.id, number: x.number, title: x.title, severity: x.severity, status: x.status })) },
      price: { lines: P?.lines ?? 0, aboveQuote: P?.above_quote ?? 0, invoiceVariance: Math.round((invoiced.find((x) => x.supplier_id === sup.id)?.variance ?? 0) * 100) / 100 },
      scars: S.map((x) => ({ id: x.id, number: x.number, title: x.title, status: x.status, responseDue: x.supplier_response_due, responded: !!x.supplier_responded_at, overdue: x.overdue })),
      overall: worst([delivery, quality, response]),
    };
  });
  return { from, to, thresholds: THRESHOLDS, suppliers: out.filter((x) => x.active || q.supplierId).sort((a, b) => ORDER[a.overall] - ORDER[b.overall] || a.name.localeCompare(b.name)) };
}
const ORDER: Record<Tone, number> = { poor: 0, watch: 1, good: 2, none: 3 };

/**
 * Asks a supplier for corrective action: a corrective action owned by someone here, addressed to the supplier, linked
 * to the nonconformances it covers, with the date the supplier's response (containment, root cause, actions) is due.
 * With an email on file for the supplier the request is queued through the mail adapter.
 */
export async function issueScar(tx: Tx, actor: Actor, input: { facilityId: string; supplierId: string; title: string; problem: string; ownerUserId: string; ncrIds?: string[]; responseDays?: number }) {
  requirePermission(actor, 'quality.manage', input.facilityId);
  const sup = await one(tx, 'SELECT id, code, name, email FROM supplier WHERE id = $1', [input.supplierId]);
  if (!sup) throw notFound('supplier');
  for (const id of input.ncrIds ?? []) {
    const n = await one(tx, 'SELECT supplier_id, capa_id, number FROM nonconformance WHERE id = $1', [id]);
    if (!n) throw notFound('nonconformance');
    if (n.supplier_id && n.supplier_id !== input.supplierId) throw invalid(`${n.number} is against a different supplier`);
    if (n.capa_id) throw conflict(`${n.number} is already covered by a corrective action`);
  }
  const days = input.responseDays ?? 14;
  if (!(days >= 1 && days <= 90)) throw invalid('the response is due in 1 to 90 days');
  const c = await createCapa(tx, actor, { facilityId: input.facilityId, title: input.title, problem: input.problem, source: 'supplier', priority: 'medium', ownerUserId: input.ownerUserId,
    ncrIds: input.ncrIds, supplierId: input.supplierId, supplierResponseDue: addDays(today(), days) });
  let emailed: string | null = null;
  if (sup.email) {
    const ncrList = input.ncrIds?.length ? (await many(tx, 'SELECT number, title, qty FROM nonconformance WHERE id = ANY ($1) ORDER BY number', [input.ncrIds])) : [];
    const body = [`${sup.name},`, '', `We are asking for corrective action under ${c.number}: ${c.title}.`, '', c.problem, '',
      ...(ncrList.length ? ['Nonconformances:', ...ncrList.map((n) => `  ${n.number} ${n.title}${n.qty ? ` (qty ${Number(n.qty)})` : ''}`), ''] : []),
      `Please reply by ${c.supplier_response_due instanceof Date ? c.supplier_response_due.toISOString().slice(0, 10) : c.supplier_response_due} with containment of suspect stock, the root cause, and the corrective actions with dates.`].join('\n');
    await tx.query(`INSERT INTO email_message (tenant_id, supplier_id, to_address, subject, body_text, kind, dedupe_key) VALUES ($1, $2, $3, $4, $5, 'scar', $6) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      [actor.tenantId, sup.id, sup.email, `Corrective action request ${c.number}: ${c.title}`, body, `scar:${c.id}`]);
    emailed = sup.email;
  }
  await audit(tx, actor, { action: 'scar.issued', entityType: 'corrective_action', entityId: c.id, facilityId: input.facilityId, data: { supplier: sup.code, number: c.number, emailed, ncrs: input.ncrIds ?? [] } });
  return { ...c, emailed };
}

/** Records the supplier's response as received (email, letter, 8D form); the owner then reviews it in the corrective action. */
export async function recordSupplierResponse(tx: Tx, actor: Actor, capaId: string, input: { response: string; rootCause?: string | null; containment?: string | null }) {
  const c = await one(tx, 'SELECT * FROM corrective_action WHERE id = $1 FOR UPDATE', [capaId]);
  if (!c) throw notFound('corrective action');
  requirePermission(actor, 'quality.manage', c.facility_id);
  if (!c.supplier_id) throw invalid('this corrective action is not addressed to a supplier');
  if (['closed', 'cancelled'].includes(c.status)) throw conflict(`the corrective action is ${c.status}`);
  if (!input.response?.trim()) throw invalid('record what the supplier sent');
  await tx.query(`UPDATE corrective_action SET supplier_response = $2, supplier_responded_at = coalesce(supplier_responded_at, now()),
      root_cause = coalesce($3, root_cause), containment = coalesce($4, containment) WHERE id = $1`, [capaId, input.response.trim(), input.rootCause?.trim() || null, input.containment?.trim() || null]);
  await notify(tx, actor.tenantId, [c.owner_user_id], { kind: 'quality.capa_assigned', title: `Supplier response received for ${c.number}`, body: input.response.trim().slice(0, 300),
    link: `/quality/capa/${c.id}`, subjectType: 'corrective_action', subjectId: c.id, dedupeKey: `scar-response:${c.id}:${Date.now()}` }, actor.userId);
  await audit(tx, actor, { action: 'scar.response_recorded', entityType: 'corrective_action', entityId: c.id, facilityId: c.facility_id, data: { late: c.supplier_response_due < today() } });
}
