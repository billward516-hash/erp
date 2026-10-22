import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { emit } from '../../platform/integration/outbox.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { ACCOUNT_KEYS } from '../integrations/accounts.js';
import { postTxn } from '../inventory/service.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { amounts, lockInvoice, paymentsManual, refreshStatus } from './service.js';

/**
 * Credit memos, customer returns and refunds (D-146). A memo is drafted with a reason (and the invoice it corrects,
 * when there is one), issued (numbered, stored as a PDF, returned goods put back into stock, sent to the books or the
 * accounting file), then applied to open invoices, refunded, or kept as credit. Issued memos never change: a mistake is
 * voided while nothing is applied or refunded.
 */
const SUBJECT = 'customer_credit_memo';
const money = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export interface CreditLineInput { description: string; qty: number; unitPrice: number; accountKey?: string; partId?: string | null; locationId?: string | null }

async function manualOnly(tx: Tx) {
  if (!(await paymentsManual(tx))) throw invalid('credit memos are issued in the connected accounting system and come back with its payments');
}

/** What the memo is worth, what is applied to invoices, refunded, and left. */
export async function memoAmounts(tx: Tx, id: string) {
  const r = await one(tx, `SELECT (SELECT coalesce(sum(qty * unit_price), 0) FROM customer_credit_memo_line WHERE memo_id = m.id)::float AS subtotal, m.tax_amount::float AS tax,
      (SELECT coalesce(sum(amount), 0) FROM payment_allocation WHERE credit_memo_id = m.id)::float AS applied,
      (SELECT coalesce(sum(amount), 0) FROM customer_refund WHERE credit_memo_id = m.id)::float AS refunded
    FROM customer_credit_memo m WHERE m.id = $1`, [id]);
  const total = money(r.subtotal + r.tax);
  return { subtotal: money(r.subtotal), tax: r.tax, total, applied: money(r.applied), refunded: money(r.refunded), remaining: money(total - r.applied - r.refunded) };
}

async function lockMemo(tx: Tx, id: string) {
  const m = await one(tx, 'SELECT * FROM customer_credit_memo WHERE id = $1 FOR UPDATE', [id]);
  if (!m) throw notFound('credit memo');
  return m;
}

/** The income accounts of the invoice a memo corrects, by line description (first line's as the fallback). */
async function invoiceAccounts(tx: Tx, invoiceId: string | null) {
  if (!invoiceId) return { byDescription: new Map<string, string>(), first: null as string | null };
  const rows = await many(tx, `SELECT lower(l.description) AS d, coalesce(l.account_key, CASE WHEN it.kind = 'service' THEN 'service_revenue' ELSE 'sales_revenue' END) AS key
    FROM customer_invoice_line l LEFT JOIN sales_order_line ol ON ol.id = l.order_line_id LEFT JOIN sales_item it ON it.id = ol.item_id WHERE l.invoice_id = $1 ORDER BY l.line_no`, [invoiceId]);
  return { byDescription: new Map(rows.map((r) => [r.d as string, r.key as string])), first: (rows[0]?.key as string | undefined) ?? null };
}

async function writeLines(tx: Tx, actor: Actor, memoId: string, facilityId: string, lines: CreditLineInput[]) {
  if (!lines.length) throw invalid('a credit memo needs at least one line');
  // A line without an account credits the income the corrected invoice recorded.
  const inv = await invoiceAccounts(tx, (await one(tx, 'SELECT invoice_id FROM customer_credit_memo WHERE id = $1', [memoId]))?.invoice_id ?? null);
  await tx.query('DELETE FROM customer_credit_memo_line WHERE memo_id = $1', [memoId]);
  for (const [i, l] of lines.entries()) {
    if (!(l.qty > 0) || !(l.unitPrice >= 0)) throw invalid(`line ${i + 1}: quantity must be positive and the price not negative`);
    const key = l.accountKey ?? inv.byDescription.get(l.description.trim().toLowerCase()) ?? inv.first ?? 'sales_revenue';
    if (!ACCOUNT_KEYS[key]) throw invalid(`line ${i + 1}: unknown account ${key}`);
    if (l.locationId) {
      if (!l.partId) throw invalid(`line ${i + 1}: choose the part that comes back into stock`);
      const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [l.locationId]);
      if (!loc || loc.facility_id !== facilityId) throw invalid(`line ${i + 1}: return into a storeroom at the memo's site`);
    }
    await tx.query(`INSERT INTO customer_credit_memo_line (tenant_id, memo_id, line_no, description, qty, unit_price, account_key, part_id, location_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [actor.tenantId, memoId, i + 1, l.description.trim(), l.qty, l.unitPrice, key, l.partId ?? null, l.locationId ?? null]);
  }
}

export async function createCreditMemo(tx: Tx, actor: Actor, input: { customerId: string; invoiceId?: string | null; facilityId?: string | null; reason: string; taxAmount?: number;
  lines: CreditLineInput[] }) {
  await manualOnly(tx);
  if (!(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw notFound('customer');
  let facilityId = input.facilityId ?? null;
  if (input.invoiceId) {
    const inv = await one(tx, 'SELECT customer_id, facility_id, status FROM customer_invoice WHERE id = $1', [input.invoiceId]);
    if (!inv || inv.customer_id !== input.customerId) throw invalid('the invoice belongs to another customer');
    if (['draft', 'void'].includes(inv.status)) throw conflict(`the invoice is ${inv.status}; a ${inv.status} invoice needs no credit`);
    facilityId = inv.facility_id;
  }
  facilityId ??= (await one(tx, `SELECT f.id FROM facility f WHERE f.active ORDER BY f.code LIMIT 1`))?.id;
  requirePermission(actor, 'ar.manage', facilityId);
  if (!input.reason?.trim() || input.reason.trim().length < 3) throw invalid('give the reason for the credit');
  const m = await one(tx, `INSERT INTO customer_credit_memo (tenant_id, facility_id, customer_id, invoice_id, reason, tax_amount, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, facilityId, input.customerId, input.invoiceId ?? null, input.reason.trim(), input.taxAmount ?? 0, actor.userId]);
  await writeLines(tx, actor, m.id, facilityId!, input.lines);
  await audit(tx, actor, { action: 'ar.credit_memo_created', entityType: SUBJECT, entityId: m.id, facilityId, data: { customerId: input.customerId, invoiceId: input.invoiceId ?? null, reason: m.reason } });
  return m;
}

export async function updateCreditMemo(tx: Tx, actor: Actor, id: string, input: { reason?: string; taxAmount?: number; lines?: CreditLineInput[] }) {
  const m = await lockMemo(tx, id);
  requirePermission(actor, 'ar.manage', m.facility_id);
  if (m.status !== 'draft') throw conflict(`credit memo is ${m.status}; issued memos never change (void and reissue)`);
  if (input.reason != null) await tx.query('UPDATE customer_credit_memo SET reason = $2 WHERE id = $1', [id, input.reason.trim()]);
  if (input.taxAmount != null) await tx.query('UPDATE customer_credit_memo SET tax_amount = $2 WHERE id = $1', [id, input.taxAmount]);
  if (input.lines) await writeLines(tx, actor, id, m.facility_id, input.lines);
}

export async function getCreditMemo(tx: Tx, actor: Actor, id: string) {
  const m = await one(tx, `SELECT m.*, c.code AS customer_code, c.name AS customer_name, c.billing_address, f.code AS facility_code, f.name AS facility_name, i.number AS invoice_number
    FROM customer_credit_memo m JOIN customer c ON c.id = m.customer_id JOIN facility f ON f.id = m.facility_id LEFT JOIN customer_invoice i ON i.id = m.invoice_id WHERE m.id = $1`, [id]);
  if (!m) throw notFound('credit memo');
  requirePermission(actor, 'ar.view', m.facility_id);
  const lines = await many(tx, `SELECT l.*, l.qty::float AS qty, l.unit_price::float AS unit_price, (l.qty * l.unit_price)::float AS amount, p.part_number, p.uom, sl.code AS location_code
    FROM customer_credit_memo_line l LEFT JOIN part p ON p.id = l.part_id LEFT JOIN stock_location sl ON sl.id = l.location_id WHERE l.memo_id = $1 ORDER BY l.line_no`, [id]);
  const applications = await many(tx, `SELECT a.amount::float AS amount, a.applied_on, i.id AS invoice_id, i.number AS invoice_number FROM payment_allocation a JOIN customer_invoice i ON i.id = a.invoice_id
    WHERE a.credit_memo_id = $1 ORDER BY a.id`, [id]);
  const refunds = await many(tx, 'SELECT amount::float AS amount, paid_on, method, reference FROM customer_refund WHERE credit_memo_id = $1 ORDER BY created_at', [id]);
  return { ...m, ...(await memoAmounts(tx, id)), lines, applications, refunds };
}

export async function listCreditMemos(tx: Tx, actor: Actor, q: { customerId?: string; open?: boolean } = {}) {
  requirePermission(actor, 'ar.view');
  const rows = await many(tx, `SELECT m.id, m.number, m.status, m.memo_date, m.reason, m.facility_id, c.id AS customer_id, c.name AS customer_name, i.number AS invoice_number
    FROM customer_credit_memo m JOIN customer c ON c.id = m.customer_id LEFT JOIN customer_invoice i ON i.id = m.invoice_id
    WHERE ($1::uuid IS NULL OR m.customer_id = $1) ORDER BY m.created_at DESC LIMIT 200`, [q.customerId ?? null]);
  const out = [];
  for (const r of rows) {
    if (!can(actor, 'ar.view', r.facility_id)) continue;
    const a = await memoAmounts(tx, r.id);
    if (q.open && (r.status !== 'issued' || a.remaining <= 0.004)) continue;
    out.push({ ...r, ...a });
  }
  return out;
}

async function payload(tx: Tx, id: string) {
  const m = await one(tx, `SELECT m.*, c.code AS customer_code, c.name AS customer_name, f.code AS facility_code, i.number AS invoice_number
    FROM customer_credit_memo m JOIN customer c ON c.id = m.customer_id JOIN facility f ON f.id = m.facility_id LEFT JOIN customer_invoice i ON i.id = m.invoice_id WHERE m.id = $1`, [id]);
  const lines = await many(tx, 'SELECT line_no, description, qty::float AS qty, unit_price::float AS unit_price, account_key FROM customer_credit_memo_line WHERE memo_id = $1 ORDER BY line_no', [id]);
  const a = await memoAmounts(tx, id);
  // Shaped like an invoice payload, so the accounting adapters reuse their line handling.
  return {
    invoiceId: id, invoiceNumber: m.number, invoiceDate: m.memo_date, currency: 'USD', appliesTo: m.invoice_number, reason: m.reason,
    customer: { id: m.customer_id, code: m.customer_code, name: m.customer_name }, facility: { code: m.facility_code },
    lines: lines.map((l) => ({ lineNo: l.line_no, description: l.description, qty: l.qty, unitPrice: l.unit_price, amount: money(l.qty * l.unit_price), accountKey: l.account_key })),
    freightAmount: 0, taxAmount: a.tax, total: a.total,
  };
}

/**
 * Issues the memo: numbered and dated, stored as a PDF, returned goods put back into their storeroom, sent to the books
 * (or the accounting file), and, when it corrects an invoice still open, applied to that invoice up to its balance.
 */
export async function issueCreditMemo(tx: Tx, actor: Actor, blobs: BlobStore, id: string, input: { memoDate?: string } = {}) {
  const m = await lockMemo(tx, id);
  requirePermission(actor, 'ar.manage', m.facility_id);
  await manualOnly(tx);
  if (m.status !== 'draft') throw conflict(`credit memo is ${m.status}`);
  const a = await memoAmounts(tx, id);
  if (a.total <= 0) throw invalid('the credit memo has no value');
  if (m.invoice_id) {
    // An invoice cannot be credited beyond what it billed.
    const inv = await amounts(tx, m.invoice_id);
    const prior = Number((await one(tx, `SELECT coalesce(sum((SELECT coalesce(sum(qty * unit_price), 0) FROM customer_credit_memo_line l WHERE l.memo_id = x.id) + x.tax_amount), 0) AS t
      FROM customer_credit_memo x WHERE x.invoice_id = $1 AND x.status = 'issued'`, [m.invoice_id])).t);
    if (a.total + prior > inv.total + 0.004) throw invalid(`the invoice billed ${inv.total.toFixed(2)}; ${prior.toFixed(2)} is already credited`);
  }
  const memoDate = input.memoDate ?? today();
  if (memoDate > today()) throw invalid('the memo date is in the future');
  const number = `CM-${String(await nextSequence(tx, actor.tenantId, 'credit_memo')).padStart(6, '0')}`;
  await tx.query(`UPDATE customer_credit_memo SET number = $2, memo_date = $3, status = 'issued', issued_by = $4, issued_at = now() WHERE id = $1`, [id, number, memoDate, actor.userId]);
  // Returned goods go back into stock at the part's current cost (the books do not value inventory, D-136).
  const returns = await many(tx, 'SELECT id, part_id, location_id, qty::float AS qty FROM customer_credit_memo_line WHERE memo_id = $1 AND location_id IS NOT NULL', [id]);
  for (const r of returns) {
    const t = await postTxn(tx, actor, { locationId: r.location_id, partId: r.part_id, type: 'return', qty: r.qty, reference: `${number} customer return` });
    await tx.query('UPDATE customer_credit_memo_line SET inventory_txn_id = $2 WHERE id = $1', [r.id, t.txnId]);
  }
  const view = await getCreditMemo(tx, actor, id);
  const stored = await blobs.put(actor.tenantId, await renderInvoicePdf({ ...view, kind: 'credit_memo', invoice_date: memoDate, subtotal: view.subtotal, tax: view.tax, freight: 0 }));
  await tx.query('UPDATE customer_credit_memo SET blob_key = $2, sha256 = $3 WHERE id = $1', [id, stored.key, stored.sha256]);
  await emit(tx, actor, { topic: 'ar.credit_memo.issued', aggregateType: SUBJECT, aggregateId: id, payload: await payload(tx, id), idempotencyKey: `credit:${id}:issued` });
  await tx.query(`INSERT INTO activity (tenant_id, customer_id, invoice_id, kind, summary, done_at, owner_user_id, created_by) VALUES ($1, $2, $3, 'note', $4, now(), $5, $5)`,
    [actor.tenantId, m.customer_id, m.invoice_id, `Credit memo ${number} issued for ${a.total.toFixed(2)}: ${m.reason}`, actor.userId]);
  await audit(tx, actor, { action: 'ar.credit_memo_issued', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { number, total: a.total, returns: returns.length, sha256: stored.sha256 } });
  let applied = 0;
  if (m.invoice_id) {
    const inv = await one(tx, 'SELECT status FROM customer_invoice WHERE id = $1', [m.invoice_id]);
    const bal = (await amounts(tx, m.invoice_id)).balance;
    if (['issued', 'partially_paid'].includes(inv.status) && bal > 0) {
      applied = money(Math.min(bal, a.total));
      await applyCredit(tx, actor, id, { invoiceId: m.invoice_id, amount: applied });
    }
  }
  return { number, total: a.total, applied };
}

/** Applies unapplied credit to an open invoice of the same customer. Nothing posts: receivables simply move. */
export async function applyCredit(tx: Tx, actor: Actor, id: string, input: { invoiceId: string; amount: number }) {
  const m = await lockMemo(tx, id);
  requirePermission(actor, 'ar.manage', m.facility_id);
  if (m.status !== 'issued') throw conflict(`credit memo is ${m.status}`);
  const inv = await lockInvoice(tx, input.invoiceId);
  requirePermission(actor, 'ar.manage', inv.facility_id);
  if (inv.customer_id !== m.customer_id) throw invalid(`invoice ${inv.number} belongs to another customer`);
  if (!['issued', 'partially_paid'].includes(inv.status)) throw conflict(`invoice ${inv.number ?? '(draft)'} is ${inv.status}`);
  const left = (await memoAmounts(tx, id)).remaining; const bal = (await amounts(tx, input.invoiceId)).balance;
  if (!(input.amount > 0) || input.amount > Math.min(left, bal) + 0.004) throw invalid(`apply between 0 and ${Math.min(left, bal).toFixed(2)} (credit left ${left.toFixed(2)}, invoice owes ${bal.toFixed(2)})`);
  await tx.query('INSERT INTO payment_allocation (tenant_id, credit_memo_id, invoice_id, amount) VALUES ($1, $2, $3, $4)', [actor.tenantId, id, input.invoiceId, money(input.amount)]);
  await refreshStatus(tx, input.invoiceId);
  await audit(tx, actor, { action: 'ar.credit_applied', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { invoice: inv.number, amount: money(input.amount) } });
}

/** Pays unapplied credit back to the customer (the money moves outside the platform). */
export async function refundCredit(tx: Tx, actor: Actor, id: string, input: { amount: number; paidOn: string; method: 'check' | 'ach' | 'wire' | 'card' | 'other'; reference?: string | null; bankAccountId?: string | null }) {
  const m = await lockMemo(tx, id);
  requirePermission(actor, 'ar.manage', m.facility_id);
  await manualOnly(tx);
  if (m.status !== 'issued') throw conflict(`credit memo is ${m.status}`);
  const left = (await memoAmounts(tx, id)).remaining;
  if (!(input.amount > 0) || input.amount > left + 0.004) throw invalid(`refund between 0 and the ${left.toFixed(2)} of credit left`);
  if (input.paidOn > today()) throw invalid('the refund date is in the future');
  const r = await one(tx, 'INSERT INTO customer_refund (tenant_id, credit_memo_id, amount, paid_on, method, reference, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [actor.tenantId, id, money(input.amount), input.paidOn, input.method, input.reference ?? null, actor.userId]);
  const cust = await one(tx, 'SELECT id, code, name FROM customer WHERE id = $1', [m.customer_id]);
  await emit(tx, actor, { topic: 'ar.refund.paid', aggregateType: 'customer_refund', aggregateId: r.id, idempotencyKey: `refund:${r.id}`,
    payload: { refundId: r.id, creditMemoNumber: m.number, customer: cust, amount: money(input.amount), paidOn: input.paidOn, method: input.method, reference: input.reference ?? null, bankAccountId: input.bankAccountId ?? null } });
  await audit(tx, actor, { action: 'ar.refund_paid', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { amount: money(input.amount), paidOn: input.paidOn, method: input.method } });
}

/** Voids a memo while nothing is applied or refunded; returned goods go back out of stock. */
export async function voidCreditMemo(tx: Tx, actor: Actor, id: string, reason: string) {
  const m = await lockMemo(tx, id);
  requirePermission(actor, 'ar.manage', m.facility_id);
  if (m.status === 'void') throw conflict('credit memo is already void');
  if (!reason?.trim()) throw invalid('a reason is required');
  const a = await memoAmounts(tx, id);
  if (a.applied > 0 || a.refunded > 0) throw conflict(`${(a.applied + a.refunded).toFixed(2)} of this credit is applied or refunded; it cannot be voided`);
  if (m.status === 'issued') {
    const returns = await many(tx, 'SELECT part_id, location_id, qty::float AS qty FROM customer_credit_memo_line WHERE memo_id = $1 AND inventory_txn_id IS NOT NULL', [id]);
    for (const r of returns) await postTxn(tx, actor, { locationId: r.location_id, partId: r.part_id, type: 'adjustment', qty: -r.qty, reference: `${m.number} voided`, reason: `Credit memo ${m.number} voided: ${reason}` });
    await emit(tx, actor, { topic: 'ar.credit_memo.voided', aggregateType: SUBJECT, aggregateId: id, payload: { ...(await payload(tx, id)), reason }, idempotencyKey: `credit:${id}:voided` });
  }
  await tx.query(`UPDATE customer_credit_memo SET status = 'void', void_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'ar.credit_memo_voided', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { number: m.number, reason } });
}

export async function creditMemoPdf(tx: Tx, actor: Actor, blobs: BlobStore, id: string) {
  const m = await getCreditMemo(tx, actor, id);
  if (m.blob_key) return { name: `${m.number}.pdf`, content: await blobs.get(m.blob_key) };
  return { name: 'credit-memo-draft.pdf', content: await renderInvoicePdf({ ...m, kind: 'credit_memo', preview: true, invoice_date: m.memo_date, freight: 0 }) };
}
