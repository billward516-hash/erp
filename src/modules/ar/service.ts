import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import type { OutboxEvent, PaymentUpdate } from '../../platform/integration/adapter.js';
import { emit } from '../../platform/integration/outbox.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { termsDays } from '../ap/service.js';
import { creditExposure } from './credit.js';
import { renderInvoicePdf } from './invoice-pdf.js';

const SUBJECT = 'customer_invoice';
const money = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Invoice totals and what is still owed. */
async function amounts(tx: Tx, id: string) {
  const r = await one(tx, `SELECT ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id))::float AS subtotal,
      i.freight_amount::float AS freight, i.tax_amount::float AS tax, (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id)::float AS paid
    FROM customer_invoice i WHERE i.id = $1`, [id]);
  const total = money(r.subtotal + r.freight + r.tax);
  return { subtotal: money(r.subtotal), freight: r.freight, tax: r.tax, total, paid: money(r.paid), balance: money(total - r.paid) };
}

/** Drafts an invoice for everything shipped and not yet invoiced on the order. */
export async function draftInvoiceFromOrder(tx: Tx, actor: Actor, orderId: string) {
  const o = await one(tx, 'SELECT * FROM sales_order WHERE id = $1', [orderId]);
  if (!o) throw notFound('sales order');
  requirePermission(actor, 'ar.manage', o.facility_id);
  if (await one(tx, `SELECT 1 FROM customer_invoice WHERE order_id = $1 AND status = 'draft'`, [orderId])) throw conflict('a draft invoice for this order already exists; finish or void it first');
  const lines = await many(tx, `SELECT id, description, uom, unit_price, (qty_shipped - qty_invoiced) AS open FROM sales_order_line
    WHERE order_id = $1 AND qty_shipped > qty_invoiced ORDER BY line_no`, [orderId]);
  if (!lines.length) throw invalid('nothing has shipped that is not already invoiced');
  const inv = await one(tx, `INSERT INTO customer_invoice (tenant_id, facility_id, customer_id, order_id, payment_terms, customer_po, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [actor.tenantId, o.facility_id, o.customer_id, orderId, o.payment_terms, o.customer_po, actor.userId]);
  for (const [i, l] of lines.entries()) {
    await tx.query(`INSERT INTO customer_invoice_line (tenant_id, invoice_id, line_no, order_line_id, description, qty, uom, unit_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.tenantId, inv.id, i + 1, l.id, l.description, l.open, l.uom, l.unit_price]);
  }
  await audit(tx, actor, { action: 'ar.invoice_drafted', entityType: SUBJECT, entityId: inv.id, facilityId: o.facility_id, data: { order: o.number, lines: lines.length } });
  return inv;
}

async function lockInvoice(tx: Tx, id: string) {
  const i = await one(tx, 'SELECT * FROM customer_invoice WHERE id = $1 FOR UPDATE', [id]);
  if (!i) throw notFound('invoice');
  return i;
}

/** Drafts can bill less than shipped (e.g. a partial invoice) and add freight, tax and notes. */
export async function updateDraft(tx: Tx, actor: Actor, id: string, input: { freightAmount?: number; taxAmount?: number; notes?: string | null; lines?: { lineId: string; qty: number }[] }) {
  const i = await lockInvoice(tx, id);
  requirePermission(actor, 'ar.manage', i.facility_id);
  if (i.status !== 'draft') throw conflict(`invoice is ${i.status}`);
  await tx.query(`UPDATE customer_invoice SET freight_amount = coalesce($2, freight_amount), tax_amount = coalesce($3, tax_amount), notes = CASE WHEN $4 THEN $5 ELSE notes END WHERE id = $1`,
    [id, input.freightAmount ?? null, input.taxAmount ?? null, input.notes !== undefined, input.notes ?? null]);
  for (const l of input.lines ?? []) {
    if (l.qty <= 0) await tx.query('DELETE FROM customer_invoice_line WHERE id = $1 AND invoice_id = $2', [l.lineId, id]);
    else await tx.query('UPDATE customer_invoice_line SET qty = $3 WHERE id = $1 AND invoice_id = $2', [l.lineId, id, l.qty]);
  }
  if (!(await one(tx, 'SELECT 1 FROM customer_invoice_line WHERE invoice_id = $1', [id]))) throw invalid('an invoice needs at least one line');
}

/**
 * Issues the invoice: number, date and due date (from the customer's terms) are fixed, invoiced quantities
 * are checked against what shipped, the PDF is stored with its hash, and the invoice is queued for accounting.
 */
export async function issueInvoice(tx: Tx, actor: Actor, blobs: BlobStore, id: string, input: { invoiceDate?: string } = {}) {
  const i = await lockInvoice(tx, id);
  requirePermission(actor, 'ar.manage', i.facility_id);
  if (i.status !== 'draft') throw conflict(`invoice is ${i.status}`);
  await tx.query('SELECT 1 FROM sales_order_line WHERE id IN (SELECT order_line_id FROM customer_invoice_line WHERE invoice_id = $1) FOR UPDATE', [id]);
  const lines = await many(tx, `SELECT il.id, il.qty, il.order_line_id, ol.qty_shipped, ol.qty_invoiced, ol.line_no FROM customer_invoice_line il
    LEFT JOIN sales_order_line ol ON ol.id = il.order_line_id WHERE il.invoice_id = $1`, [id]);
  for (const l of lines) {
    if (l.order_line_id && Number(l.qty) > Number(l.qty_shipped) - Number(l.qty_invoiced) + 1e-9) {
      throw conflict(`order line ${l.line_no}: only ${Number(l.qty_shipped) - Number(l.qty_invoiced)} shipped and not yet invoiced`);
    }
  }
  for (const l of lines) if (l.order_line_id) await tx.query('UPDATE sales_order_line SET qty_invoiced = qty_invoiced + $2 WHERE id = $1', [l.order_line_id, l.qty]);
  const invoiceDate = input.invoiceDate ?? today();
  const days = termsDays(i.payment_terms);
  const number = `INV-${String(await nextSequence(tx, actor.tenantId, 'invoice')).padStart(6, '0')}`;
  await tx.query(`UPDATE customer_invoice SET number = $2, invoice_date = $3, due_date = $4, status = 'issued', issued_by = $5, issued_at = now() WHERE id = $1`,
    [id, number, invoiceDate, addDays(invoiceDate, days ?? 30), actor.userId]);
  const view = await getInvoice(tx, actor, id);
  const stored = await blobs.put(actor.tenantId, await renderInvoicePdf(view));
  await tx.query('UPDATE customer_invoice SET blob_key = $2, sha256 = $3 WHERE id = $1', [id, stored.key, stored.sha256]);
  await emit(tx, actor, { topic: 'ar.invoice.issued', aggregateType: SUBJECT, aggregateId: id, payload: await invoicePayload(tx, id), idempotencyKey: `invoice:${id}:issued` });
  await tx.query(`INSERT INTO activity (tenant_id, customer_id, invoice_id, kind, summary, done_at, owner_user_id, created_by) VALUES ($1, $2, $3, 'note', $4, now(), $5, $5)`,
    [actor.tenantId, i.customer_id, id, `Invoice ${number} issued for ${view.total.toFixed(2)}, due ${view.due_date}`, actor.userId]);
  await audit(tx, actor, { action: 'ar.invoice_issued', entityType: SUBJECT, entityId: id, facilityId: i.facility_id,
    data: { number, total: view.total, dueDate: view.due_date, termsRecognized: days != null, sha256: stored.sha256 } });
  return { number, total: view.total, dueDate: view.due_date as string };
}

/** Accounting payload: lines carry an account key (product or service revenue) mapped at delivery. */
async function invoicePayload(tx: Tx, id: string) {
  const i = await one(tx, `SELECT i.*, c.code AS customer_code, c.name AS customer_name, c.billing_address, f.code AS facility_code, o.number AS order_number
    FROM customer_invoice i JOIN customer c ON c.id = i.customer_id JOIN facility f ON f.id = i.facility_id LEFT JOIN sales_order o ON o.id = i.order_id WHERE i.id = $1`, [id]);
  const lines = await many(tx, `SELECT l.line_no, l.description, l.qty::float AS qty, l.unit_price::float AS unit_price, l.account_key, coalesce(it.kind, 'product') AS kind
    FROM customer_invoice_line l LEFT JOIN sales_order_line ol ON ol.id = l.order_line_id LEFT JOIN sales_item it ON it.id = ol.item_id WHERE l.invoice_id = $1 ORDER BY l.line_no`, [id]);
  const a = await amounts(tx, id);
  return {
    invoiceId: id, invoiceNumber: i.number, invoiceDate: i.invoice_date, dueDate: i.due_date, currency: 'USD', customerPo: i.customer_po, orderNumber: i.order_number,
    customer: { id: i.customer_id, code: i.customer_code, name: i.customer_name, billingAddress: i.billing_address }, facility: { code: i.facility_code },
    lines: lines.map((l) => ({ lineNo: l.line_no, description: l.description, qty: l.qty, unitPrice: l.unit_price, amount: money(l.qty * l.unit_price), accountKey: l.account_key ?? (l.kind === 'service' ? 'service_revenue' : 'sales_revenue') })),
    freightAmount: a.freight, taxAmount: a.tax, total: a.total,
  };
}

export async function voidInvoice(tx: Tx, actor: Actor, id: string, reason: string) {
  const i = await lockInvoice(tx, id);
  requirePermission(actor, 'ar.manage', i.facility_id);
  if (!['draft', 'issued'].includes(i.status)) throw conflict(i.status === 'void' ? 'invoice is already void' : 'payments are applied to this invoice; reverse them in accounting first');
  if (!reason?.trim()) throw invalid('a reason is required');
  if (i.status === 'issued') {
    await tx.query(`UPDATE sales_order_line ol SET qty_invoiced = ol.qty_invoiced - il.qty FROM customer_invoice_line il WHERE il.invoice_id = $1 AND il.order_line_id = ol.id`, [id]);
    await emit(tx, actor, { topic: 'ar.invoice.voided', aggregateType: SUBJECT, aggregateId: id, payload: { ...(await invoicePayload(tx, id)), reason }, idempotencyKey: `invoice:${id}:voided` });
  }
  await tx.query(`UPDATE customer_invoice SET status = 'void', void_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'ar.invoice_voided', entityType: SUBJECT, entityId: id, facilityId: i.facility_id, data: { reason, number: i.number } });
}

async function refreshStatus(tx: Tx, invoiceId: string) {
  const a = await amounts(tx, invoiceId);
  await tx.query(`UPDATE customer_invoice SET status = $2 WHERE id = $1 AND status IN ('issued', 'partially_paid')`, [invoiceId, a.balance <= 0.004 ? 'paid' : a.paid > 0 ? 'partially_paid' : 'issued']);
}

/** Payments are typed in here unless an API accounting connection is active (then they come from accounting). */
async function paymentsManual(tx: Tx) {
  const conn = await one(tx, 'SELECT provider FROM integration_connection WHERE active');
  return !conn || conn.provider === 'file_export';
}

/**
 * Records a customer payment and applies it to open invoices. Typed in only when no API accounting
 * connection is active (with one, payments come from accounting). The allocations must add up to the payment.
 */
export async function recordPayment(tx: Tx, actor: Actor, input: { customerId: string; receivedOn: string; amount: number; method: 'check' | 'ach' | 'wire' | 'card' | 'other';
  reference?: string | null; allocations: { invoiceId: string; amount: number }[] }) {
  requirePermission(actor, 'ar.manage');
  if (!(await paymentsManual(tx))) throw invalid('payments come from the connected accounting system; run a sync to update');
  if (!(input.amount > 0)) throw invalid('amount must be positive');
  const sum = money(input.allocations.reduce((s, a) => s + a.amount, 0));
  if (Math.abs(sum - input.amount) > 0.004) throw invalid(`apply the whole payment: ${input.amount.toFixed(2)} received, ${sum.toFixed(2)} applied`);
  const p = await one(tx, `INSERT INTO customer_payment (tenant_id, customer_id, received_on, amount, method, reference, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, input.customerId, input.receivedOn, input.amount, input.method, input.reference ?? null, actor.userId]);
  for (const a of input.allocations) {
    const inv = await lockInvoice(tx, a.invoiceId);
    requirePermission(actor, 'ar.manage', inv.facility_id);
    if (inv.customer_id !== input.customerId) throw invalid(`invoice ${inv.number} belongs to another customer`);
    if (!['issued', 'partially_paid'].includes(inv.status)) throw conflict(`invoice ${inv.number ?? '(draft)'} is ${inv.status}`);
    const bal = (await amounts(tx, a.invoiceId)).balance;
    if (a.amount > bal + 0.004) throw invalid(`invoice ${inv.number}: only ${bal.toFixed(2)} is owed`);
    await tx.query('INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, $4)', [actor.tenantId, p.id, a.invoiceId, a.amount]);
    await refreshStatus(tx, a.invoiceId);
  }
  await audit(tx, actor, { action: 'ar.payment_recorded', entityType: 'customer', entityId: input.customerId, data: { paymentId: p.id, amount: input.amount, method: input.method, reference: input.reference ?? null } });
  return p;
}

/** Integration callback: accounting reports a payment on an invoice we sent it. Idempotent per external payment. */
export async function onInvoicePaid(tx: Tx, actor: Actor, invoiceId: string, pay: PaymentUpdate) {
  const inv = await lockInvoice(tx, invoiceId);
  const ext = `${pay.externalId}:${pay.paidOn}:${pay.amount}`;
  if (await one(tx, 'SELECT 1 FROM customer_payment WHERE external_id = $1', [ext])) return false;
  const bal = (await amounts(tx, invoiceId)).balance;
  const amt = money(Math.min(pay.amount, bal));
  if (amt <= 0) return false;
  const p = await one(tx, `INSERT INTO customer_payment (tenant_id, customer_id, received_on, amount, method, reference, source, external_id) VALUES ($1, $2, $3, $4, 'other', $5, 'accounting', $6) RETURNING id`,
    [actor.tenantId, inv.customer_id, pay.paidOn, amt, pay.reference, ext]);
  await tx.query('INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, $4)', [actor.tenantId, p.id, invoiceId, amt]);
  await refreshStatus(tx, invoiceId);
  await audit(tx, actor, { action: 'ar.payment_synced', entityType: SUBJECT, entityId: invoiceId, facilityId: inv.facility_id, data: { amount: amt, reference: pay.reference } });
  return true;
}

export async function onInvoiceDelivered(tx: Tx, actor: Actor, e: OutboxEvent, externalId: string) {
  await audit(tx, actor, { action: 'ar.invoice_exported', entityType: SUBJECT, entityId: e.aggregate_id, data: { externalId } });
}

export async function getInvoice(tx: Tx, actor: Actor, id: string) {
  const i = await one(tx, `SELECT i.*, c.code AS customer_code, c.name AS customer_name, c.billing_address, f.code AS facility_code, f.name AS facility_name, o.number AS order_number,
      (SELECT ct.name FROM contact ct WHERE ct.customer_id = c.id AND ct.is_primary AND ct.active) AS contact_name,
      (SELECT ct.email FROM contact ct WHERE ct.customer_id = c.id AND ct.is_primary AND ct.active) AS contact_email
    FROM customer_invoice i JOIN customer c ON c.id = i.customer_id JOIN facility f ON f.id = i.facility_id LEFT JOIN sales_order o ON o.id = i.order_id WHERE i.id = $1`, [id]);
  if (!i) throw notFound('invoice');
  requirePermission(actor, 'ar.view', i.facility_id);
  const lines = await many(tx, `SELECT id, line_no, description, uom, qty::float AS qty, unit_price::float AS unit_price, (qty * unit_price)::float AS amount
    FROM customer_invoice_line WHERE invoice_id = $1 ORDER BY line_no`, [id]);
  const payments = await many(tx, `SELECT p.received_on, p.method, p.reference, p.source, a.amount::float AS amount FROM payment_allocation a JOIN customer_payment p ON p.id = a.payment_id
    WHERE a.invoice_id = $1 ORDER BY p.received_on`, [id]);
  const notes = await many(tx, `SELECT a.kind, a.summary, a.due_on, a.created_at, u.display_name AS by FROM activity a JOIN app_user u ON u.id = a.created_by
    WHERE a.invoice_id = $1 ORDER BY a.created_at DESC`, [id]);
  const sync = await many(tx, `SELECT e.topic, d.status, d.external_id, d.last_error, d.delivered_at, c.label AS connection, c.is_mock FROM outbox_event e
    JOIN sync_delivery d ON d.outbox_id = e.id JOIN integration_connection c ON c.id = d.connection_id WHERE e.aggregate_id = $1 ORDER BY e.id`, [id]);
  const a = await amounts(tx, id);
  return { ...i, blob_key: undefined, lines, payments, notes, sync, ...a, overdue: ['issued', 'partially_paid'].includes(i.status) && i.due_date < today(), paymentsManual: await paymentsManual(tx) };
}

export async function invoicePdf(tx: Tx, actor: Actor, blobs: BlobStore, id: string) {
  const i = await one(tx, 'SELECT facility_id, number, blob_key FROM customer_invoice WHERE id = $1', [id]);
  if (!i) throw notFound('invoice');
  requirePermission(actor, 'ar.view', i.facility_id);
  if (i.blob_key) return { name: `${i.number}.pdf`, content: await blobs.get(i.blob_key) };
  return { name: 'invoice-draft.pdf', content: await renderInvoicePdf({ ...(await getInvoice(tx, actor, id)), preview: true }) };
}

export async function listInvoices(tx: Tx, actor: Actor, q: { status?: string; open?: boolean; customerId?: string } = {}) {
  requirePermission(actor, 'ar.view');
  const rows = await many(tx, `SELECT i.id, i.number, i.status, i.invoice_date, i.due_date, i.facility_id, f.code AS facility_code, c.id AS customer_id, c.name AS customer_name, o.number AS order_number,
      ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.freight_amount + i.tax_amount)::float AS total,
      (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id)::float AS paid,
      (i.status IN ('issued', 'partially_paid') AND i.due_date < current_date) AS overdue
    FROM customer_invoice i JOIN customer c ON c.id = i.customer_id JOIN facility f ON f.id = i.facility_id LEFT JOIN sales_order o ON o.id = i.order_id
    WHERE ($1::text IS NULL OR i.status = $1) AND (NOT $2 OR i.status IN ('draft', 'issued', 'partially_paid')) AND ($3::uuid IS NULL OR i.customer_id = $3)
    ORDER BY i.due_date NULLS FIRST, i.created_at DESC LIMIT 500`, [q.status ?? null, q.open ?? false, q.customerId ?? null]);
  return rows.filter((r) => can(actor, 'ar.view', r.facility_id)).map((r) => ({ ...r, balance: money(r.total - r.paid) }));
}

/** Uninvoiced shipments: orders with shipped quantity not yet billed. */
export async function toInvoice(tx: Tx, actor: Actor) {
  requirePermission(actor, 'ar.view');
  const rows = await many(tx, `SELECT o.id, o.number, o.facility_id, c.name AS customer_name, max(s.shipped_on) AS last_shipped,
      sum((l.qty_shipped - l.qty_invoiced) * l.unit_price)::float AS amount
    FROM sales_order o JOIN customer c ON c.id = o.customer_id JOIN sales_order_line l ON l.order_id = o.id LEFT JOIN shipment s ON s.order_id = o.id
    WHERE l.qty_shipped > l.qty_invoiced AND NOT EXISTS (SELECT 1 FROM customer_invoice d WHERE d.order_id = o.id AND d.status = 'draft')
    GROUP BY o.id, o.number, o.facility_id, c.name ORDER BY max(s.shipped_on)`);
  return rows.filter((r) => can(actor, 'ar.view', r.facility_id));
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** Customers with overdue invoices, oldest first, with the last collections contact and any promise to pay. */
export async function collectionsQueue(tx: Tx, actor: Actor) {
  requirePermission(actor, 'ar.view');
  const rows = await many(tx, `
    WITH open_inv AS (
      SELECT i.id, i.customer_id, i.facility_id, i.due_date,
             ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.freight_amount + i.tax_amount
              - (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id)) AS balance
      FROM customer_invoice i WHERE i.status IN ('issued', 'partially_paid'))
    SELECT c.id AS customer_id, c.name AS customer_name, c.phone, (array_agg(DISTINCT o.facility_id))[1] AS facility_id,
           sum(o.balance) FILTER (WHERE o.due_date < current_date)::float AS overdue, sum(o.balance)::float AS open_balance,
           count(*) FILTER (WHERE o.due_date < current_date)::int AS overdue_invoices, max(current_date - o.due_date) AS oldest_days,
           (SELECT max(a.created_at) FROM activity a WHERE a.customer_id = c.id AND a.kind = 'collection') AS last_contact,
           (SELECT min(a.due_on) FROM activity a WHERE a.customer_id = c.id AND a.kind = 'task' AND a.done_at IS NULL AND a.invoice_id IS NOT NULL) AS promised_by,
           (SELECT ct.name FROM contact ct WHERE ct.customer_id = c.id AND ct.is_primary AND ct.active) AS contact_name
    FROM open_inv o JOIN customer c ON c.id = o.customer_id
    GROUP BY c.id, c.name, c.phone HAVING sum(o.balance) FILTER (WHERE o.due_date < current_date) > 0
    ORDER BY max(current_date - o.due_date) DESC`);
  return rows.filter((r) => can(actor, 'ar.view', r.facility_id));
}

/** Logs a collections contact; a promise to pay becomes a follow-up task due that day. */
export async function logCollection(tx: Tx, actor: Actor, input: { customerId: string; invoiceId?: string | null; summary: string; promiseDate?: string | null }) {
  requirePermission(actor, 'ar.manage');
  if (!input.summary?.trim()) throw invalid('write what was said');
  await tx.query(`INSERT INTO activity (tenant_id, customer_id, invoice_id, kind, summary, done_at, owner_user_id, created_by) VALUES ($1, $2, $3, 'collection', $4, now(), $5, $5)`,
    [actor.tenantId, input.customerId, input.invoiceId ?? null, input.summary.trim(), actor.userId]);
  if (input.promiseDate) {
    await tx.query(`INSERT INTO activity (tenant_id, customer_id, invoice_id, kind, summary, due_on, owner_user_id, created_by) VALUES ($1, $2, $3, 'task', $4, $5, $6, $6)`,
      [actor.tenantId, input.customerId, input.invoiceId ?? null, `Check payment promised by ${input.promiseDate}`, input.promiseDate, actor.userId]);
  }
  await audit(tx, actor, { action: 'ar.collection_logged', entityType: 'customer', entityId: input.customerId, data: { invoiceId: input.invoiceId ?? null, promiseDate: input.promiseDate ?? null } });
}

/**
 * Queues a payment reminder email to the customer's primary contact (delivered by the mail adapter; only
 * the development adapter exists, D-045). At most one per invoice per day.
 */
export async function sendPaymentReminder(tx: Tx, actor: Actor, invoiceId: string) {
  const i = await getInvoice(tx, actor, invoiceId);
  requirePermission(actor, 'ar.manage', i.facility_id);
  if (!['issued', 'partially_paid'].includes(i.status)) throw conflict(`invoice is ${i.status}`);
  if (!i.contact_email) throw invalid('the customer has no primary contact with an email address');
  const late = i.due_date < today();
  const subject = `${late ? 'Past due' : 'Reminder'}: invoice ${i.number} for ${i.balance.toFixed(2)} USD`;
  const body = [`Dear ${i.contact_name ?? 'Accounts Payable'},`, '',
    late ? `Our records show invoice ${i.number} (dated ${i.invoice_date}) was due on ${i.due_date} and ${i.balance.toFixed(2)} USD remains unpaid.`
      : `This is a friendly reminder that invoice ${i.number} (dated ${i.invoice_date}) for ${i.balance.toFixed(2)} USD is due on ${i.due_date}.`,
    i.customer_po ? `Your purchase order: ${i.customer_po}.` : '', '',
    'If you have already sent payment, thank you, and please disregard this message. Otherwise, please let us know when to expect it.', '',
    `${i.facility_name}`].filter((x) => x !== null).join('\n');
  const r = await tx.query(`INSERT INTO email_message (tenant_id, customer_id, to_address, subject, body_text, kind, dedupe_key) VALUES ($1, $2, $3, $4, $5, 'payment_reminder', $6)
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [actor.tenantId, i.customer_id, i.contact_email, subject, body, `pay-reminder:${invoiceId}:${today()}`]);
  if (!r.rowCount) throw conflict('a reminder for this invoice was already queued today');
  await tx.query(`INSERT INTO activity (tenant_id, customer_id, invoice_id, kind, summary, done_at, owner_user_id, created_by) VALUES ($1, $2, $3, 'collection', $4, now(), $5, $5)`,
    [actor.tenantId, i.customer_id, invoiceId, `Payment reminder emailed to ${i.contact_email} for ${i.number}`, actor.userId]);
  return { to: i.contact_email as string, subject };
}

export async function customerAccount(tx: Tx, actor: Actor, customerId: string) {
  requirePermission(actor, 'ar.view');
  const credit = await creditExposure(tx, customerId);
  const invoices = await listInvoices(tx, actor, { customerId });
  const payments = await many(tx, `SELECT id, received_on, amount::float AS amount, method, reference, source FROM customer_payment WHERE customer_id = $1 ORDER BY received_on DESC LIMIT 50`, [customerId]);
  const customer = await one(tx, 'SELECT id, code, name, payment_terms, credit_limit::float AS credit_limit FROM customer WHERE id = $1', [customerId]);
  if (!customer) throw notFound('customer');
  return { customer, credit, invoices, payments, paymentsManual: await paymentsManual(tx) };
}
