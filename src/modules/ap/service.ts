import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import type { OutboxEvent, PaymentUpdate } from '../../platform/integration/adapter.js';
import { emit } from '../../platform/integration/outbox.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';

const SUBJECT = 'supplier_invoice';
/** Price above the order price that still counts as matching (rounding, small surcharges). */
export const PRICE_TOLERANCE = 0.02;
const money = (n: number) => Math.round(n * 100) / 100;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Days until due from common payment-terms text: "Net 30", "2% 10 Net 30", "COD", "Due on receipt". Unknown → null. */
export function termsDays(terms: string | null | undefined): number | null {
  if (!terms) return null;
  const t = terms.toLowerCase();
  const net = /net\s*(\d{1,3})/.exec(t);
  if (net) return Number(net[1]);
  if (/\b(cod|cia|due on receipt|upon receipt|on receipt)\b/.test(t)) return 0;
  const days = /^(\d{1,3})\s*days?$/.exec(t.trim());
  return days ? Number(days[1]) : null;
}

export interface InvoiceLineInput { poLineId?: string | null; description?: string | null; qty: number; unitPrice: number; accountKey?: string | null }
export interface InvoiceInput {
  supplierId: string; facilityId?: string | null; purchaseOrderId?: string | null; invoiceNumber: string; invoiceDate: string; dueDate?: string | null;
  taxAmount?: number; freightAmount?: number; lines: InvoiceLineInput[];
}

/** Default account for a line: received into a storeroom → inventory; capital request → capital projects; else expense. */
async function defaultAccount(tx: Tx, poLineId: string | null | undefined) {
  if (!poLineId) return 'maintenance_expense';
  const l = await one(tx, `SELECT pl.location_id, r.spend_type FROM purchase_order_line pl JOIN purchase_request_line rl ON rl.id = pl.request_line_id
    JOIN purchase_request r ON r.id = rl.request_id WHERE pl.id = $1`, [poLineId]);
  return l?.spend_type === 'capex' ? 'capital_projects' : l?.location_id ? 'inventory' : 'maintenance_expense';
}

export async function captureInvoice(tx: Tx, actor: Actor, blobs: BlobStore | null, input: InvoiceInput, file?: { name: string; mime: string; content: Buffer } | null) {
  const supplier = await one(tx, 'SELECT id, code, name, payment_terms FROM supplier WHERE id = $1', [input.supplierId]);
  if (!supplier) throw notFound('supplier');
  let facilityId = input.facilityId ?? null;
  let po: any = null;
  if (input.purchaseOrderId) {
    po = await one(tx, 'SELECT id, number, facility_id, supplier_id, status FROM purchase_order WHERE id = $1', [input.purchaseOrderId]);
    if (!po) throw notFound('purchase order');
    if (po.supplier_id !== supplier.id) throw invalid(`${po.number} is with a different supplier`);
    if (po.status === 'cancelled') throw invalid(`${po.number} is cancelled`);
    facilityId = po.facility_id;
  }
  if (!facilityId) throw invalid('choose the facility the invoice is for (or the purchase order)');
  requirePermission(actor, 'ap.manage', facilityId);
  if (!input.invoiceNumber?.trim()) throw invalid('invoice number is required');
  const dup = await one(tx, `SELECT id FROM supplier_invoice WHERE supplier_id = $1 AND lower(invoice_number) = lower($2) AND status <> 'void'`, [supplier.id, input.invoiceNumber.trim()]);
  if (dup) throw conflict(`invoice ${input.invoiceNumber} from ${supplier.name} is already captured`, { invoiceId: dup.id });
  if (!input.lines.length) throw invalid('an invoice needs at least one line');
  const terms = termsDays(supplier.payment_terms);
  const dueDate = input.dueDate ?? (terms != null ? addDays(input.invoiceDate, terms) : null);
  let stored: { key: string; sha256: string } | null = null;
  if (file) {
    if (!blobs) throw invalid('file storage unavailable');
    stored = await blobs.put(actor.tenantId, file.content);
  }
  const inv = await one(tx, `INSERT INTO supplier_invoice (tenant_id, facility_id, supplier_id, purchase_order_id, invoice_number, invoice_date, due_date,
      tax_amount, freight_amount, file_blob_key, file_name, file_mime, file_sha256, captured_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
  [actor.tenantId, facilityId, supplier.id, po?.id ?? null, input.invoiceNumber.trim(), input.invoiceDate, dueDate, input.taxAmount ?? 0, input.freightAmount ?? 0,
    stored?.key ?? null, file?.name ?? null, file?.mime ?? null, stored?.sha256 ?? null, actor.userId]);
  for (const [i, l] of input.lines.entries()) {
    let description = l.description?.trim();
    if (l.poLineId) {
      const pl = await one(tx, 'SELECT order_id, description FROM purchase_order_line WHERE id = $1', [l.poLineId]);
      if (!pl || pl.order_id !== po?.id) throw invalid(`line ${i + 1} is not on ${po?.number ?? 'the purchase order'}`);
      description ||= pl.description;
    }
    if (!description) throw invalid(`line ${i + 1}: describe the charge`);
    if (!(l.qty > 0) || !(l.unitPrice >= 0)) throw invalid(`line ${i + 1}: quantity must be positive and price not negative`);
    await tx.query(`INSERT INTO supplier_invoice_line (tenant_id, invoice_id, line_no, po_line_id, description, qty, unit_price, account_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.tenantId, inv.id, i + 1, l.poLineId ?? null, description, l.qty, l.unitPrice, l.accountKey ?? (await defaultAccount(tx, l.poLineId))]);
  }
  await audit(tx, actor, { action: 'ap.invoice_captured', entityType: SUBJECT, entityId: inv.id, facilityId,
    data: { supplier: supplier.code, invoiceNumber: inv.invoice_number, po: po?.number ?? null, dueDate, file: file?.name ?? null } });
  return inv;
}

/** Pre-fills an invoice from a purchase order: what was received and not yet invoiced, at the order price. */
export async function invoiceDraftFromOrder(tx: Tx, actor: Actor, poId: string) {
  const po = await one(tx, `SELECT o.id, o.number, o.facility_id, o.supplier_id, s.name AS supplier_name, s.payment_terms FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id WHERE o.id = $1`, [poId]);
  if (!po) throw notFound('purchase order');
  requirePermission(actor, 'ap.view', po.facility_id);
  const lines = await many(tx, `SELECT pl.id AS po_line_id, pl.line_no, pl.description, pl.unit_price::float AS unit_price, pl.qty_received::float AS received,
      coalesce((SELECT sum(il.qty) FROM supplier_invoice_line il JOIN supplier_invoice i ON i.id = il.invoice_id WHERE il.po_line_id = pl.id AND i.status <> 'void'), 0)::float AS invoiced
    FROM purchase_order_line pl WHERE pl.order_id = $1 ORDER BY pl.line_no`, [poId]);
  return { ...po, lines: lines.map((l) => ({ ...l, toInvoice: Math.max(0, Math.round((l.received - l.invoiced) * 1000) / 1000) })) };
}

/**
 * Basic match against the purchase order and receipts (informational, Category 1): per order line, the
 * quantity invoiced so far (all non-void invoices) against the quantity received, and the price against
 * the order price. Full three-way match with exception routing is Category 2.
 */
export async function matchCheck(tx: Tx, invoiceId: string) {
  const lines = await many(tx, `SELECT il.line_no, il.description, il.qty::float AS qty, il.unit_price::float AS unit_price, il.po_line_id,
      pl.unit_price::float AS po_price, pl.qty_ordered::float AS ordered, pl.qty_received::float AS received,
      (SELECT coalesce(sum(x.qty), 0) FROM supplier_invoice_line x JOIN supplier_invoice i ON i.id = x.invoice_id WHERE x.po_line_id = il.po_line_id AND i.status <> 'void')::float AS invoiced_total
    FROM supplier_invoice_line il LEFT JOIN purchase_order_line pl ON pl.id = il.po_line_id WHERE il.invoice_id = $1 ORDER BY il.line_no`, [invoiceId]);
  const issues: string[] = [];
  const out = lines.map((l) => {
    const flags: string[] = [];
    if (!l.po_line_id) flags.push('not on the purchase order');
    else {
      if (l.invoiced_total > l.received + 1e-9) flags.push(`invoiced ${l.invoiced_total} but received ${l.received}`);
      if (l.unit_price > l.po_price * (1 + PRICE_TOLERANCE) + 1e-9) flags.push(`price ${l.unit_price} above order price ${l.po_price}`);
    }
    flags.forEach((f) => issues.push(`line ${l.line_no}: ${f}`));
    return { ...l, amount: money(l.qty * l.unit_price), flags };
  });
  return { lines: out, issues, matched: !issues.length };
}

async function lockInvoice(tx: Tx, id: string) {
  const i = await one(tx, 'SELECT * FROM supplier_invoice WHERE id = $1 FOR UPDATE', [id]);
  if (!i) throw notFound('invoice');
  return i;
}

async function billPayload(tx: Tx, id: string) {
  const i = await one(tx, `SELECT i.*, s.code AS supplier_code, s.name AS supplier_name, s.email AS supplier_email, s.payment_terms, f.code AS facility_code, f.name AS facility_name, o.number AS po_number
    FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id JOIN facility f ON f.id = i.facility_id LEFT JOIN purchase_order o ON o.id = i.purchase_order_id WHERE i.id = $1`, [id]);
  const lines = await many(tx, 'SELECT line_no, description, qty::float AS qty, unit_price::float AS unit_price, account_key FROM supplier_invoice_line WHERE invoice_id = $1 ORDER BY line_no', [id]);
  const ls = lines.map((l) => ({ lineNo: l.line_no, description: l.description, qty: l.qty, unitPrice: l.unit_price, amount: money(l.qty * l.unit_price), accountKey: l.account_key }));
  const subtotal = money(ls.reduce((s, l) => s + l.amount, 0));
  return {
    invoiceId: i.id, invoiceNumber: i.invoice_number, invoiceDate: i.invoice_date, dueDate: i.due_date, currency: i.currency,
    supplier: { id: i.supplier_id, code: i.supplier_code, name: i.supplier_name, email: i.supplier_email, paymentTerms: i.payment_terms },
    facility: { code: i.facility_code, name: i.facility_name }, poNumber: i.po_number, lines: ls,
    taxAmount: Number(i.tax_amount), freightAmount: Number(i.freight_amount), subtotal, total: money(subtotal + Number(i.tax_amount) + Number(i.freight_amount)),
  };
}

/**
 * Approval for payment. The approver is not the person who captured the invoice. An invoice that does
 * not match the order and receipts can be approved only with a note explaining why (recorded).
 * Approval queues the bill for the accounting system through the outbox.
 */
export async function approveInvoice(tx: Tx, actor: Actor, id: string, input: { varianceNote?: string | null } = {}) {
  const inv = await lockInvoice(tx, id);
  requirePermission(actor, 'ap.manage', inv.facility_id);
  if (!['captured', 'disputed'].includes(inv.status)) throw conflict(`invoice is ${inv.status}`);
  if (inv.captured_by === actor.userId) throw invalid('the person who captured an invoice cannot approve it');
  if (!inv.due_date) throw invalid('set a due date first (the supplier\'s payment terms are not recognized)');
  const m = await matchCheck(tx, id);
  if (!m.matched && !input.varianceNote?.trim()) throw invalid(`this invoice does not match the order: ${m.issues.join('; ')}. Add a note explaining why it should be paid.`);
  await tx.query(`UPDATE supplier_invoice SET status = 'approved', approved_by = $2, approved_at = now(), variance_note = $3, dispute_reason = NULL WHERE id = $1`,
    [id, actor.userId, m.matched ? null : input.varianceNote]);
  const payload = await billPayload(tx, id);
  await emit(tx, actor, { topic: 'ap.bill.approved', aggregateType: SUBJECT, aggregateId: id, payload, idempotencyKey: `bill:${id}:approved` });
  await audit(tx, actor, { action: 'ap.invoice_approved', entityType: SUBJECT, entityId: id, facilityId: inv.facility_id,
    data: { total: payload.total, matched: m.matched, issues: m.issues, varianceNote: input.varianceNote ?? null } });
  return { total: payload.total, matched: m.matched };
}

export async function disputeInvoice(tx: Tx, actor: Actor, id: string, reason: string) {
  const inv = await lockInvoice(tx, id);
  requirePermission(actor, 'ap.manage', inv.facility_id);
  if (inv.status !== 'captured') throw conflict(`invoice is ${inv.status}; only captured invoices can be put on dispute`);
  if (!reason?.trim()) throw invalid('a reason is required (what the supplier must correct)');
  await tx.query(`UPDATE supplier_invoice SET status = 'disputed', dispute_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'ap.invoice_disputed', entityType: SUBJECT, entityId: id, facilityId: inv.facility_id, data: { reason } });
}

/** Void: a wrong or duplicate invoice. If it was already sent to accounting, the void is sent too. */
export async function voidInvoice(tx: Tx, actor: Actor, id: string, reason: string) {
  const inv = await lockInvoice(tx, id);
  requirePermission(actor, 'ap.manage', inv.facility_id);
  if (['paid', 'void'].includes(inv.status)) throw conflict(`invoice is ${inv.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE supplier_invoice SET status = 'void', dispute_reason = $2 WHERE id = $1`, [id, reason]);
  if (['approved', 'exported'].includes(inv.status)) {
    await emit(tx, actor, { topic: 'ap.bill.voided', aggregateType: SUBJECT, aggregateId: id, payload: { ...(await billPayload(tx, id)), reason }, idempotencyKey: `bill:${id}:voided` });
  }
  await audit(tx, actor, { action: 'ap.invoice_voided', entityType: SUBJECT, entityId: id, facilityId: inv.facility_id, data: { reason, wasStatus: inv.status } });
}

export async function setDueDate(tx: Tx, actor: Actor, id: string, dueDate: string) {
  const inv = await lockInvoice(tx, id);
  requirePermission(actor, 'ap.manage', inv.facility_id);
  if (!['captured', 'disputed'].includes(inv.status)) throw conflict('the due date is fixed once the invoice is approved');
  await tx.query('UPDATE supplier_invoice SET due_date = $2 WHERE id = $1', [id, dueDate]);
  await audit(tx, actor, { action: 'ap.invoice_due_date_set', entityType: SUBJECT, entityId: id, facilityId: inv.facility_id, data: { dueDate } });
}

/** Integration callback: the accounting system accepted the bill. */
export async function onBillDelivered(tx: Tx, actor: Actor, e: OutboxEvent, externalId: string) {
  await tx.query(`UPDATE supplier_invoice SET status = 'exported', exported_at = now() WHERE id = $1 AND status = 'approved'`, [e.aggregate_id]);
  await audit(tx, actor, { action: 'ap.invoice_exported', entityType: SUBJECT, entityId: e.aggregate_id, data: { externalId } });
}

/** Integration callback: the accounting system reports the bill paid (it is the system of record for payments). */
export async function onBillPaid(tx: Tx, actor: Actor, invoiceId: string, p: PaymentUpdate) {
  const r = await one(tx, `UPDATE supplier_invoice SET status = 'paid', paid_at = $2, paid_amount = $3, payment_reference = $4 WHERE id = $1 AND status = 'exported' RETURNING facility_id`,
    [invoiceId, p.paidOn, p.amount, p.reference]);
  if (r) await audit(tx, actor, { action: 'ap.invoice_paid', entityType: SUBJECT, entityId: invoiceId, facilityId: r.facility_id, data: { ...p, source: 'accounting sync' } });
}

/**
 * Payment recorded by hand — only when the accounting connection is a file export (or none). With an API
 * connection, payment status comes from accounting and cannot be typed in here.
 */
export async function recordPayment(tx: Tx, actor: Actor, id: string, input: { paidOn: string; amount: number; reference?: string | null }) {
  const inv = await lockInvoice(tx, id);
  requirePermission(actor, 'ap.manage', inv.facility_id);
  const conn = await one(tx, 'SELECT provider FROM integration_connection WHERE active');
  if (conn && conn.provider !== 'file_export') throw invalid('payments come from the connected accounting system; run a sync to update');
  if (!['approved', 'exported'].includes(inv.status)) throw conflict(`invoice is ${inv.status}`);
  if (!(input.amount > 0)) throw invalid('amount must be positive');
  await tx.query(`UPDATE supplier_invoice SET status = 'paid', paid_at = $2, paid_amount = $3, payment_reference = $4 WHERE id = $1`, [id, input.paidOn, input.amount, input.reference ?? null]);
  await audit(tx, actor, { action: 'ap.invoice_paid', entityType: SUBJECT, entityId: id, facilityId: inv.facility_id, data: { ...input, source: 'manual' } });
}

export async function getInvoice(tx: Tx, actor: Actor, id: string) {
  const i = await one(tx, `SELECT i.*, s.code AS supplier_code, s.name AS supplier_name, s.payment_terms, f.code AS facility_code, o.number AS po_number,
      cu.display_name AS captured_by_name, au.display_name AS approved_by_name
    FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id JOIN facility f ON f.id = i.facility_id LEFT JOIN purchase_order o ON o.id = i.purchase_order_id
    JOIN app_user cu ON cu.id = i.captured_by LEFT JOIN app_user au ON au.id = i.approved_by WHERE i.id = $1`, [id]);
  if (!i) throw notFound('invoice');
  requirePermission(actor, 'ap.view', i.facility_id);
  const match = await matchCheck(tx, id);
  const lines = await many(tx, 'SELECT id, line_no, account_key FROM supplier_invoice_line WHERE invoice_id = $1 ORDER BY line_no', [id]);
  const subtotal = money(match.lines.reduce((s, l) => s + l.amount, 0));
  const sync = await many(tx, `SELECT e.topic, d.status, d.attempts, d.last_error, d.external_id, d.delivered_at, c.label AS connection, c.is_mock
    FROM outbox_event e JOIN sync_delivery d ON d.outbox_id = e.id JOIN integration_connection c ON c.id = d.connection_id
    WHERE e.aggregate_id = $1 ORDER BY e.id`, [id]);
  return {
    ...i, file_blob_key: undefined, has_file: !!i.file_blob_key,
    lines: match.lines.map((l) => ({ ...l, account_key: lines.find((x) => x.line_no === l.line_no)?.account_key })),
    issues: match.issues, matched: match.matched, subtotal, total: money(subtotal + Number(i.tax_amount) + Number(i.freight_amount)), sync,
  };
}

export async function invoiceFile(tx: Tx, actor: Actor, blobs: BlobStore, id: string) {
  const i = await one(tx, 'SELECT facility_id, file_blob_key, file_name, file_mime FROM supplier_invoice WHERE id = $1', [id]);
  if (!i || !i.file_blob_key) throw notFound('invoice file');
  requirePermission(actor, 'ap.view', i.facility_id);
  return { name: i.file_name as string, mime: i.file_mime as string, content: await blobs.get(i.file_blob_key) };
}

export async function listInvoices(tx: Tx, actor: Actor, q: { status?: string; open?: boolean; supplierId?: string; purchaseOrderId?: string } = {}) {
  requirePermission(actor, 'ap.view');
  const rows = await many(tx, `SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.status, i.facility_id, f.code AS facility_code, s.name AS supplier_name, o.number AS po_number,
      ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM supplier_invoice_line l WHERE l.invoice_id = i.id) + i.tax_amount + i.freight_amount)::float AS total,
      (i.status NOT IN ('paid', 'void') AND i.due_date < current_date) AS overdue
    FROM supplier_invoice i JOIN facility f ON f.id = i.facility_id JOIN supplier s ON s.id = i.supplier_id LEFT JOIN purchase_order o ON o.id = i.purchase_order_id
    WHERE ($1::text IS NULL OR i.status = $1) AND (NOT $2 OR i.status NOT IN ('paid', 'void')) AND ($3::uuid IS NULL OR i.supplier_id = $3) AND ($4::uuid IS NULL OR i.purchase_order_id = $4)
    ORDER BY i.due_date NULLS FIRST, i.invoice_date LIMIT 500`, [q.status ?? null, q.open ?? false, q.supplierId ?? null, q.purchaseOrderId ?? null]);
  return rows.filter((r) => can(actor, 'ap.view', r.facility_id));
}
