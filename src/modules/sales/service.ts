import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { approvalHistory, closePendingRequests, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { advanceOpportunity } from '../crm/service.js';
import { postTxn } from '../inventory/service.js';
import type { LotSpec } from '../inventory/lots.js';
import { renderQuotePdf } from './quote-pdf.js';
import { creditExposure } from '../ar/credit.js';
import { usersWithPermission } from '../../platform/notify/notify.js';

const QUOTE = 'quote';
const PURPOSE = 'quote.approve';
/** Quotes need a sales manager's approval above this discount from list price… */
export const MAX_DISCOUNT = 0.15;
/** …or below this gross margin (on lines with a known cost). */
export const MIN_MARGIN = 0.2;
const money = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

registerApprovalSubject(QUOTE, {
  link: (id) => `/sales/quotes/${id}`,
  describe: async (tx, id) => {
    const q = await one(tx, `SELECT q.number, q.revision, c.name, (SELECT coalesce(sum(l.qty * l.unit_price), 0)::float FROM quote_line l WHERE l.quote_id = q.id) AS total
      FROM quote q JOIN customer c ON c.id = q.customer_id WHERE q.id = $1`, [id]);
    return q ? `${q.number} rev ${q.revision} for ${q.name} ($${Number(q.total).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : 'quote';
  },
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
export async function saveItem(tx: Tx, actor: Actor, input: { id?: string; code: string; description: string; kind?: 'product' | 'service'; uom?: string; listPrice?: number | null; unitCost?: number | null; partId?: string | null; active?: boolean }) {
  requirePermission(actor, 'sales.orders');
  const vals = [input.code, input.description, input.kind ?? 'product', input.uom ?? 'EA', input.listPrice ?? null, input.unitCost ?? null, input.partId ?? null, input.active ?? true];
  const it = input.id
    ? await one(tx, `UPDATE sales_item SET code = $2, description = $3, kind = $4, uom = $5, list_price = $6, unit_cost = $7, part_id = $8, active = $9 WHERE id = $1 RETURNING *`, [input.id, ...vals])
    : await one(tx, `INSERT INTO sales_item (tenant_id, code, description, kind, uom, list_price, unit_cost, part_id, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING *`, [actor.tenantId, ...vals]);
  if (!it) throw input.id ? notFound('item') : conflict(`item ${input.code} already exists`);
  await audit(tx, actor, { action: 'sales_item.saved', entityType: 'sales_item', entityId: it.id, data: { code: it.code, listPrice: it.list_price } });
  return it;
}

export async function listItems(tx: Tx, actor: Actor) {
  requirePermission(actor, 'sales.view');
  return many(tx, `SELECT i.*, p.part_number FROM sales_item i LEFT JOIN part p ON p.id = i.part_id ORDER BY i.code`);
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------
export interface QuoteLineInput { itemId?: string | null; description?: string | null; qty: number; unitPrice?: number | null; uom?: string | null }
export interface QuoteInput {
  facilityId: string; customerId: string; contactId?: string | null; opportunityId?: string | null; title: string; validUntil?: string | null;
  paymentTerms?: string | null; notes?: string | null; lines: QuoteLineInput[];
  leadTime?: string | null; deliveryTerms?: string | null; inclusions?: string | null; exclusions?: string | null;
}

async function writeQuoteLines(tx: Tx, actor: Actor, quoteId: string, lines: QuoteLineInput[]) {
  if (!lines.length) throw invalid('a quote needs at least one line');
  await tx.query('DELETE FROM quote_line WHERE quote_id = $1', [quoteId]);
  for (const [i, l] of lines.entries()) {
    const item = l.itemId ? await one(tx, 'SELECT * FROM sales_item WHERE id = $1 AND active', [l.itemId]) : null;
    if (l.itemId && !item) throw invalid(`line ${i + 1}: item not found or inactive`);
    const description = l.description?.trim() || item?.description;
    if (!description) throw invalid(`line ${i + 1}: describe the item or choose one from the catalog`);
    const price = l.unitPrice ?? (item?.list_price != null ? Number(item.list_price) : null);
    if (price == null || price < 0) throw invalid(`line ${i + 1}: enter a price`);
    if (!(l.qty > 0)) throw invalid(`line ${i + 1}: quantity must be positive`);
    await tx.query(`INSERT INTO quote_line (tenant_id, quote_id, line_no, item_id, description, qty, uom, list_price, unit_price, unit_cost)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [actor.tenantId, quoteId, i + 1, item?.id ?? null, description, l.qty, l.uom ?? item?.uom ?? 'EA', item?.list_price ?? null, price, item?.unit_cost ?? null]);
  }
}

export async function createQuote(tx: Tx, actor: Actor, input: QuoteInput) {
  requirePermission(actor, 'sales.quote', input.facilityId);
  const c = await one(tx, 'SELECT id, payment_terms, active FROM customer WHERE id = $1', [input.customerId]);
  if (!c || !c.active) throw invalid('customer not found or inactive');
  if (input.contactId && !(await one(tx, 'SELECT 1 FROM contact WHERE id = $1 AND customer_id = $2', [input.contactId, input.customerId]))) throw invalid('contact is not at this customer');
  if (input.opportunityId && !(await one(tx, 'SELECT 1 FROM opportunity WHERE id = $1 AND customer_id = $2', [input.opportunityId, input.customerId]))) throw invalid('opportunity is not for this customer');
  const number = `Q-${String(await nextSequence(tx, actor.tenantId, 'quote')).padStart(6, '0')}`;
  const q = await one(tx, `INSERT INTO quote (tenant_id, facility_id, number, customer_id, contact_id, opportunity_id, title, valid_until, valid_until_original, payment_terms, notes, created_by, lead_time, delivery_terms, inclusions, exclusions)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.customerId, input.contactId ?? null, input.opportunityId ?? null, input.title,
    input.validUntil ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), input.paymentTerms ?? c.payment_terms ?? null, input.notes ?? null, actor.userId,
    input.leadTime?.trim() || null, input.deliveryTerms?.trim() || null, input.inclusions?.trim() || null, input.exclusions?.trim() || null]);
  await writeQuoteLines(tx, actor, q.id, input.lines);
  await audit(tx, actor, { action: 'quote.created', entityType: QUOTE, entityId: q.id, facilityId: q.facility_id, data: { number, customerId: input.customerId } });
  return q;
}

async function lockQuote(tx: Tx, id: string) {
  const q = await one(tx, 'SELECT * FROM quote WHERE id = $1 FOR UPDATE', [id]);
  if (!q) throw notFound('quote');
  return q;
}

/** Totals and the reasons (if any) the quote needs a sales manager's approval. */
export async function quoteEconomics(tx: Tx, quoteId: string) {
  const lines = await many(tx, `SELECT line_no, item_id, description, uom, qty::float AS qty, unit_price::float AS unit_price, list_price::float AS list_price, unit_cost::float AS unit_cost
    FROM quote_line WHERE quote_id = $1 ORDER BY line_no`, [quoteId]);
  const total = money(lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
  const costed = lines.filter((l) => l.unit_cost != null);
  const costedRevenue = costed.reduce((s, l) => s + l.qty * l.unit_price, 0);
  const cost = costed.reduce((s, l) => s + l.qty * l.unit_cost, 0);
  const margin = costedRevenue > 0 ? (costedRevenue - cost) / costedRevenue : null;
  const reasons: string[] = [];
  for (const l of lines) {
    if (l.list_price && l.unit_price < l.list_price * (1 - MAX_DISCOUNT) - 1e-9) {
      reasons.push(`line ${l.line_no}: ${Math.round((1 - l.unit_price / l.list_price) * 100)}% below list price (over ${MAX_DISCOUNT * 100}%)`);
    }
  }
  if (margin !== null && margin < MIN_MARGIN - 1e-9) reasons.push(`gross margin ${(margin * 100).toFixed(1)}% on costed lines (under ${MIN_MARGIN * 100}%)`);
  return { lines: lines.map((l) => ({ ...l, amount: money(l.qty * l.unit_price), discount: l.list_price ? 1 - l.unit_price / l.list_price : null })), total, margin, reasons };
}

export async function updateQuote(tx: Tx, actor: Actor, id: string, patch: Partial<Omit<QuoteInput, 'facilityId' | 'customerId'>>) {
  const q = await lockQuote(tx, id);
  requirePermission(actor, 'sales.quote', q.facility_id);
  if (q.status !== 'draft') throw conflict(`quote is ${q.status}; revise it to make changes`);
  await tx.query(`UPDATE quote SET title = coalesce($2, title), contact_id = CASE WHEN $3 THEN $4 ELSE contact_id END, valid_until = coalesce($5, valid_until),
      payment_terms = CASE WHEN $6 THEN $7 ELSE payment_terms END, notes = CASE WHEN $8 THEN $9 ELSE notes END,
      lead_time = CASE WHEN $10 THEN $11 ELSE lead_time END, delivery_terms = CASE WHEN $12 THEN $13 ELSE delivery_terms END,
      inclusions = CASE WHEN $14 THEN $15 ELSE inclusions END, exclusions = CASE WHEN $16 THEN $17 ELSE exclusions END,
      valid_until_original = CASE WHEN $5::date IS NOT NULL THEN $5::date ELSE valid_until_original END WHERE id = $1`,
  [id, patch.title ?? null, patch.contactId !== undefined, patch.contactId ?? null, patch.validUntil ?? null, patch.paymentTerms !== undefined, patch.paymentTerms ?? null,
    patch.notes !== undefined, patch.notes ?? null, patch.leadTime !== undefined, patch.leadTime?.trim() || null, patch.deliveryTerms !== undefined, patch.deliveryTerms?.trim() || null,
    patch.inclusions !== undefined, patch.inclusions?.trim() || null, patch.exclusions !== undefined, patch.exclusions?.trim() || null]);
  if (patch.lines) await writeQuoteLines(tx, actor, id, patch.lines);
  await audit(tx, actor, { action: 'quote.updated', entityType: QUOTE, entityId: id, facilityId: q.facility_id, data: { revision: q.revision, linesReplaced: !!patch.lines } });
  return getQuote(tx, actor, id);
}

/**
 * Finishes a draft. Within the discount and margin limits it is ready to send at once; otherwise it goes
 * to a sales manager through the approval engine, with the reasons recorded on the quote.
 */
export async function submitQuote(tx: Tx, actor: Actor, id: string) {
  const q = await lockQuote(tx, id);
  requirePermission(actor, 'sales.quote', q.facility_id);
  if (q.status !== 'draft') throw conflict(`quote is ${q.status}`);
  const e = await quoteEconomics(tx, id);
  if (!e.lines.length) throw invalid('the quote has no lines');
  if (!e.reasons.length) {
    await tx.query(`UPDATE quote SET status = 'approved', approval_reasons = '{}' WHERE id = $1`, [id]);
  } else {
    await tx.query(`UPDATE quote SET status = 'pending_approval', approval_reasons = $2 WHERE id = $1`, [id, e.reasons]);
    await createApprovalRequest(tx, actor, { facilityId: q.facility_id, subjectType: QUOTE, subjectId: id, subjectRevision: q.revision, purpose: PURPOSE,
      stages: [{ steps: [{ roleKey: 'sales_manager', label: 'Pricing approval' }] }] });
  }
  await audit(tx, actor, { action: 'quote.submitted', entityType: QUOTE, entityId: id, facilityId: q.facility_id, data: { total: e.total, margin: e.margin, reasons: e.reasons } });
  return { status: e.reasons.length ? 'pending_approval' : 'approved', reasons: e.reasons, total: e.total };
}

export async function onQuoteApprovalDecided(tx: Tx, actor: Actor, subjectId: string, purpose: string, status: string) {
  if (purpose !== PURPOSE || status === 'pending') return;
  const q = await lockQuote(tx, subjectId);
  // A rejected quote goes back to draft so the rep can rework pricing; the rejection stays in the history.
  await tx.query(`UPDATE quote SET status = $2 WHERE id = $1`, [subjectId, status === 'approved' ? 'approved' : 'draft']);
  await audit(tx, actor, { action: `quote.${status}`, entityType: QUOTE, entityId: subjectId, facilityId: q.facility_id, data: { revision: q.revision } });
}

/** Sends the approved quote: the PDF is rendered once, stored with its hash and kept as the record of what the customer saw. */
export async function sendQuote(tx: Tx, actor: Actor, blobs: BlobStore, id: string, input: { sentTo?: string | null } = {}) {
  const q = await lockQuote(tx, id);
  requirePermission(actor, 'sales.quote', q.facility_id);
  if (q.status !== 'approved') throw conflict(q.status === 'pending_approval' ? 'the quote is waiting for pricing approval' : `quote is ${q.status}`);
  const view = await getQuote(tx, actor, id);
  const pdf = await renderQuotePdf(view);
  const stored = await blobs.put(actor.tenantId, pdf);
  const sentTo = input.sentTo ?? view.contact_email ?? null;
  await tx.query(`INSERT INTO quote_sent (tenant_id, quote_id, revision, sent_to, total, blob_key, sha256, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor.tenantId, id, q.revision, sentTo, view.total, stored.key, stored.sha256, actor.userId]);
  await tx.query(`UPDATE quote SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
  await tx.query(`INSERT INTO activity (tenant_id, customer_id, opportunity_id, quote_id, kind, summary, done_at, owner_user_id, created_by)
    VALUES ($1, $2, $3, $4, 'email', $5, now(), $6, $6)`, [actor.tenantId, q.customer_id, q.opportunity_id, id, `Sent ${q.number} rev ${q.revision} (${view.total.toFixed(2)})${sentTo ? ` to ${sentTo}` : ''}`, actor.userId]);
  await advanceOpportunity(tx, q.opportunity_id, 'proposal', view.total);
  await audit(tx, actor, { action: 'quote.sent', entityType: QUOTE, entityId: id, facilityId: q.facility_id, data: { revision: q.revision, total: view.total, sentTo, sha256: stored.sha256 } });
  return { revision: q.revision, total: view.total, sha256: stored.sha256 };
}

/** New revision: back to draft; any approval for the previous revision no longer counts. */
export async function reviseQuote(tx: Tx, actor: Actor, id: string, reason: string) {
  const q = await lockQuote(tx, id);
  requirePermission(actor, 'sales.quote', q.facility_id);
  if (!['pending_approval', 'approved', 'sent', 'declined'].includes(q.status)) throw conflict(`quote is ${q.status}`);
  if (!reason?.trim()) throw invalid('say what changes in the new revision');
  await tx.query(`UPDATE quote SET status = 'draft', revision = revision + 1, approval_reasons = '{}', decline_reason = NULL WHERE id = $1`, [id]);
  await closePendingRequests(tx, actor, QUOTE, id, 'superseded', `revision ${q.revision + 1}: ${reason}`);
  await audit(tx, actor, { action: 'quote.revised', entityType: QUOTE, entityId: id, facilityId: q.facility_id, data: { revision: q.revision + 1, reason } });
}

/**
 * Records the customer's acceptance of the revision they were sent and creates the sales order from it.
 * Expired quotes must be revised first (prices may have changed).
 */
export interface AcceptInput {
  customerPo?: string | null; requestedDate?: string | null; acceptedByName?: string | null; acceptedByTitle?: string | null; acceptedOn?: string | null;
  method?: 'purchase_order' | 'signed_quote' | 'email' | 'verbal' | 'portal'; note?: string | null;
}
export async function acceptQuote(tx: Tx, actor: Actor, id: string, input: AcceptInput) {
  const q = await lockQuote(tx, id);
  requirePermission(actor, 'sales.quote', q.facility_id);
  if (q.status !== 'sent') throw conflict(q.status === 'approved' ? 'send the quote before recording acceptance' : `quote is ${q.status}`);
  if (q.valid_until && q.valid_until < today()) throw invalid(`this quote expired on ${q.valid_until}; extend its validity (with a reason) or revise it before accepting`);
  const method = input.method ?? (input.customerPo ? 'purchase_order' : 'email');
  if (method === 'purchase_order' && !input.customerPo?.trim()) throw invalid('enter the customer purchase order number');
  const acceptedOn = input.acceptedOn ?? today();
  if (acceptedOn > today()) throw invalid('the acceptance date cannot be in the future');
  const sentRow = await one(tx, 'SELECT sent_at::date AS d FROM quote_sent WHERE quote_id = $1 AND revision = $2', [id, q.revision]);
  if (sentRow && acceptedOn < new Date(sentRow.d).toISOString().slice(0, 10)) throw invalid('the quote cannot have been accepted before it was sent');
  const sent = await one(tx, 'SELECT total FROM quote_sent WHERE quote_id = $1 AND revision = $2', [id, q.revision]);
  const e = await quoteEconomics(tx, id);
  const cust = await one(tx, 'SELECT shipping_address, billing_address FROM customer WHERE id = $1', [q.customer_id]);
  await tx.query(`UPDATE quote SET status = 'accepted', decided_at = now(), customer_po = $2, accepted_by_name = $3, accepted_by_title = $4, accepted_on = $5, accepted_method = $6,
      accepted_revision = $7, accepted_total = $8, acceptance_note = $9 WHERE id = $1`,
  [id, input.customerPo?.trim() || null, input.acceptedByName?.trim() || null, input.acceptedByTitle?.trim() || null, acceptedOn, method, q.revision, e.total, input.note?.trim() || null]);
  await tx.query(`UPDATE customer SET kind = 'customer' WHERE id = $1`, [q.customer_id]);
  const number = `SO-${String(await nextSequence(tx, actor.tenantId, 'so')).padStart(6, '0')}`;
  const so = await one(tx, `INSERT INTO sales_order (tenant_id, facility_id, number, customer_id, quote_id, customer_po, requested_date, ship_to, payment_terms, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
  [actor.tenantId, q.facility_id, number, q.customer_id, id, input.customerPo ?? null, input.requestedDate ?? null, cust?.shipping_address ?? cust?.billing_address ?? null, q.payment_terms, actor.userId]);
  await tx.query(`INSERT INTO sales_order_line (tenant_id, order_id, line_no, item_id, description, qty, uom, unit_price)
    SELECT tenant_id, $2, line_no, item_id, description, qty, uom, unit_price FROM quote_line WHERE quote_id = $1`, [id, so.id]);
  await advanceOpportunity(tx, q.opportunity_id, 'won', e.total);
  // Credit check: an order that takes the customer over their limit is held until finance releases it.
  const credit = await creditExposure(tx, q.customer_id);
  if (credit.over) {
    const note = `Exposure ${credit.exposure.toFixed(2)} (open invoices ${credit.openAr.toFixed(2)} + uninvoiced orders ${credit.uninvoicedOrders.toFixed(2)}) is over the credit limit of ${credit.limit!.toFixed(2)}`;
    await tx.query('UPDATE sales_order SET credit_hold = true, credit_hold_note = $2 WHERE id = $1', [so.id, note]);
    await notify(tx, actor.tenantId, await usersWithPermission(tx, 'ar.credit', q.facility_id), { kind: 'sales.credit_hold', title: `${number} is on credit hold`,
      body: note, link: `/sales/orders/${so.id}`, subjectType: 'sales_order', subjectId: so.id, dedupeKey: `credit-hold:${so.id}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'quote.accepted', entityType: QUOTE, entityId: id, facilityId: q.facility_id, data: { revision: q.revision, total: e.total, sentTotal: sent ? Number(sent.total) : null, order: number, method, acceptedBy: input.acceptedByName ?? null, acceptedOn } });
  await audit(tx, actor, { action: 'sales_order.created', entityType: 'sales_order', entityId: so.id, facilityId: so.facility_id, data: { number, quote: q.number, total: e.total } });
  return so;
}

export async function declineQuote(tx: Tx, actor: Actor, id: string, reason: string) {
  const q = await lockQuote(tx, id);
  requirePermission(actor, 'sales.quote', q.facility_id);
  if (q.status !== 'sent') throw conflict(`quote is ${q.status}`);
  if (!reason?.trim()) throw invalid('record why the customer declined (price, lead time, went elsewhere…)');
  await tx.query(`UPDATE quote SET status = 'declined', decided_at = now(), decline_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'quote.declined', entityType: QUOTE, entityId: id, facilityId: q.facility_id, data: { reason } });
}

/**
 * Extends how long a sent quote stays open. The customer was sent a date, so every change is kept (old date, new date, why, who), and
 * the sent PDF stays as it was. Prices are not re-checked: revise the quote instead when they may have changed.
 */
export async function extendQuoteValidity(tx: Tx, actor: Actor, id: string, input: { validUntil: string; reason: string }) {
  const q = await lockQuote(tx, id);
  requirePermission(actor, 'sales.quote', q.facility_id);
  if (!['approved', 'sent'].includes(q.status)) throw conflict(`quote is ${q.status}`);
  if (input.reason.trim().length < 3) throw invalid('say why the quote is being extended');
  if (input.validUntil < today()) throw invalid('the new date must be today or later');
  if (q.valid_until && input.validUntil <= q.valid_until) throw invalid('the new date must be later than the current one');
  await tx.query('INSERT INTO quote_validity_change (tenant_id, quote_id, revision, from_date, to_date, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [actor.tenantId, id, q.revision, q.valid_until, input.validUntil, input.reason.trim(), actor.userId]);
  await tx.query('UPDATE quote SET valid_until = $2 WHERE id = $1', [id, input.validUntil]);
  await audit(tx, actor, { action: 'quote.validity_extended', entityType: QUOTE, entityId: id, facilityId: q.facility_id, data: { from: q.valid_until, to: input.validUntil, reason: input.reason } });
  return getQuote(tx, actor, id);
}

/**
 * The one series of notices about a sent quote running out (D-183B): its owner is told `lead` days ahead (default 7), 2 days ahead and the
 * day after it lapses, once each. This is the only quote-expiry mechanism; the reminder catalogue's "Quotes about to expire" switch and
 * lead days control it (see runReminders), so the owner never gets a second notice for the same quote. Returns how many were created.
 */
export async function remindQuoteExpiry(tx: Tx, tenantId: string, opts: { lead?: number; today?: string } = {}) {
  const rows = await many(tx, `SELECT q.id, q.number, q.created_by, (q.valid_until - coalesce($1::date, current_date)) AS left, c.name AS customer FROM quote q JOIN customer c ON c.id = q.customer_id
    WHERE q.status = 'sent' AND (q.valid_until - coalesce($1::date, current_date)) IN ($2::int, 2, -1)`, [opts.today ?? null, opts.lead ?? 7]);
  let created = 0;
  for (const r of rows) {
    const when = r.left < 0 ? 'expired yesterday with no decision' : `expires in ${r.left} days`;
    created += await notify(tx, tenantId, [r.created_by], { kind: 'reminder.quote_expiring', title: `Quote ${r.number} to ${r.customer} ${when}`, body: r.left < 0 ? 'Extend it, revise it, or record the outcome.' : 'Follow up with the customer, or extend it if they need longer.',
      link: `/sales/quotes/${r.id}`, subjectType: QUOTE, subjectId: r.id, dedupeKey: `quote-expiry:${r.id}:${r.left}` });
  }
  return created;
}

export async function getQuote(tx: Tx, actor: Actor, id: string) {
  const q = await one(tx, `SELECT q.*, c.code AS customer_code, c.name AS customer_name, c.billing_address, ct.name AS contact_name, ct.email AS contact_email,
      f.code AS facility_code, f.name AS facility_name, f.address AS facility_address, (SELECT name FROM tenant LIMIT 1) AS company_name, o.title AS opportunity_title, u.display_name AS created_by_name, u.email AS created_by_email
    FROM quote q JOIN customer c ON c.id = q.customer_id JOIN facility f ON f.id = q.facility_id LEFT JOIN contact ct ON ct.id = q.contact_id
    LEFT JOIN opportunity o ON o.id = q.opportunity_id JOIN app_user u ON u.id = q.created_by WHERE q.id = $1`, [id]);
  if (!q) throw notFound('quote');
  requirePermission(actor, 'sales.view', q.facility_id);
  const e = await quoteEconomics(tx, id);
  const sent = await many(tx, `SELECT s.revision, s.sent_to, s.total::float AS total, s.sent_at, s.sha256, u.display_name AS sent_by FROM quote_sent s JOIN app_user u ON u.id = s.sent_by
    WHERE s.quote_id = $1 ORDER BY s.revision DESC`, [id]);
  const order = await one(tx, 'SELECT id, number, status FROM sales_order WHERE quote_id = $1', [id]);
  const validity = await many(tx, `SELECT v.revision, v.from_date, v.to_date, v.reason, v.changed_at, u.display_name AS changed_by FROM quote_validity_change v JOIN app_user u ON u.id = v.changed_by WHERE v.quote_id = $1 ORDER BY v.changed_at`, [id]);
  const days_left = q.valid_until ? Math.round((Date.parse(`${new Date(q.valid_until).toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000) : null;
  return { ...q, ...e, sent, order, validity, days_left, approvals: await approvalHistory(tx, QUOTE, id), expired: !!q.valid_until && q.valid_until < today() && ['approved', 'sent'].includes(q.status) };
}

export async function quoteSentPdf(tx: Tx, actor: Actor, blobs: BlobStore, id: string, revision?: number) {
  const q = await one(tx, 'SELECT facility_id, number, revision FROM quote WHERE id = $1', [id]);
  if (!q) throw notFound('quote');
  requirePermission(actor, 'sales.view', q.facility_id);
  const s = await one(tx, 'SELECT blob_key, revision FROM quote_sent WHERE quote_id = $1 AND revision = $2', [id, revision ?? q.revision]);
  if (!s) throw notFound('sent quote (this revision has not been sent)');
  return { name: `${q.number}-rev${s.revision}.pdf`, content: await blobs.get(s.blob_key) };
}

/** Preview of the current draft (not stored). */
export async function quotePreviewPdf(tx: Tx, actor: Actor, id: string) {
  return renderQuotePdf({ ...(await getQuote(tx, actor, id)), preview: true });
}

export async function listQuotes(tx: Tx, actor: Actor, q: { status?: string; customerId?: string; open?: boolean } = {}) {
  requirePermission(actor, 'sales.view');
  const rows = await many(tx, `SELECT q.id, q.number, q.revision, q.title, q.status, q.valid_until, q.created_at, q.sent_at, q.facility_id, f.code AS facility_code,
      c.id AS customer_id, c.name AS customer_name, u.display_name AS created_by_name,
      (SELECT coalesce(sum(l.qty * l.unit_price), 0)::float FROM quote_line l WHERE l.quote_id = q.id) AS total,
      (q.valid_until < current_date AND q.status IN ('approved', 'sent')) AS expired, (q.valid_until - current_date) AS days_left,
      q.accepted_on, q.accepted_by_name, q.accepted_method, q.customer_po,
      (SELECT count(*)::int FROM quote_validity_change v WHERE v.quote_id = q.id) AS extensions
    FROM quote q JOIN customer c ON c.id = q.customer_id JOIN facility f ON f.id = q.facility_id JOIN app_user u ON u.id = q.created_by
    WHERE ($1::text IS NULL OR q.status = $1) AND ($2::uuid IS NULL OR q.customer_id = $2) AND (NOT $3 OR q.status IN ('draft', 'pending_approval', 'approved', 'sent'))
    ORDER BY q.created_at DESC LIMIT 300`, [q.status ?? null, q.customerId ?? null, q.open ?? false]);
  return rows.filter((r) => can(actor, 'sales.view', r.facility_id));
}

// ---------------------------------------------------------------------------
// Sales orders and shipments
// ---------------------------------------------------------------------------
export async function getOrder(tx: Tx, actor: Actor, id: string) {
  const o = await one(tx, `SELECT o.*, c.code AS customer_code, c.name AS customer_name, f.code AS facility_code, q.number AS quote_number,
      (o.status IN ('open', 'partially_shipped') AND o.promised_date < current_date) AS late
    FROM sales_order o JOIN customer c ON c.id = o.customer_id JOIN facility f ON f.id = o.facility_id LEFT JOIN quote q ON q.id = o.quote_id WHERE o.id = $1`, [id]);
  if (!o) throw notFound('sales order');
  requirePermission(actor, 'sales.view', o.facility_id);
  const lines = await many(tx, `SELECT l.*, l.qty::float AS qty, l.qty_shipped::float AS qty_shipped, l.qty_invoiced::float AS qty_invoiced, l.unit_price::float AS unit_price, (l.qty * l.unit_price)::float AS amount,
      i.code AS item_code, i.kind AS item_kind, i.part_id, p.part_number, p.tracking,
      EXISTS (SELECT 1 FROM product_revision r WHERE r.part_id = i.part_id AND r.status = 'released') AS makeable,
      (SELECT json_agg(json_build_object('id', mo.id, 'number', mo.number, 'status', mo.status, 'qty', mo.qty::float) ORDER BY mo.created_at)
         FROM production_order mo WHERE mo.sales_order_line_id = l.id AND mo.status <> 'cancelled') AS production,
      (SELECT json_agg(json_build_object('location_id', b.location_id, 'location', sl.code, 'on_hand', b.qty_on_hand::float) ORDER BY sl.code)
         FROM inventory_balance b JOIN stock_location sl ON sl.id = b.location_id WHERE b.part_id = i.part_id AND b.facility_id = $2) AS stock
    FROM sales_order_line l LEFT JOIN sales_item i ON i.id = l.item_id LEFT JOIN part p ON p.id = i.part_id WHERE l.order_id = $1 ORDER BY l.line_no`, [id, o.facility_id]);
  const shipments = await many(tx, `SELECT s.*, u.display_name AS created_by_name,
      (SELECT json_agg(json_build_object('line_no', ol.line_no, 'qty', sl.qty::float, 'location', loc.code) ORDER BY ol.line_no) FROM shipment_line sl
        JOIN sales_order_line ol ON ol.id = sl.order_line_id LEFT JOIN stock_location loc ON loc.id = sl.location_id WHERE sl.shipment_id = s.id) AS lines
    FROM shipment s JOIN app_user u ON u.id = s.created_by WHERE s.order_id = $1 ORDER BY s.shipped_on, s.created_at`, [id]);
  const invoices = await many(tx, `SELECT i.id, i.number, i.status, i.invoice_date, i.due_date,
      ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.freight_amount + i.tax_amount)::float AS total
    FROM customer_invoice i WHERE i.order_id = $1 ORDER BY i.created_at`, [id]);
  return { ...o, lines, shipments, invoices, total: money(lines.reduce((s, l) => s + l.amount, 0)) };
}

/** Finance releases an order held for credit, recording why it is acceptable. */
export async function releaseCreditHold(tx: Tx, actor: Actor, id: string, note: string) {
  const o = await one(tx, 'SELECT facility_id, credit_hold, number FROM sales_order WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('sales order');
  requirePermission(actor, 'ar.credit', o.facility_id);
  if (!o.credit_hold) throw conflict('the order is not on credit hold');
  if (!note?.trim()) throw invalid('say why it can ship (e.g. payment received, limit raised, prepaid)');
  await tx.query('UPDATE sales_order SET credit_hold = false, credit_hold_note = $2 WHERE id = $1', [id, `Released: ${note}`]);
  await audit(tx, actor, { action: 'sales_order.credit_released', entityType: 'sales_order', entityId: id, facilityId: o.facility_id, data: { note } });
}

export async function setPromisedDate(tx: Tx, actor: Actor, id: string, promisedDate: string) {
  const o = await one(tx, 'SELECT facility_id, status FROM sales_order WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('sales order');
  requirePermission(actor, 'sales.orders', o.facility_id);
  if (['shipped', 'cancelled'].includes(o.status)) throw conflict(`order is ${o.status}`);
  await tx.query('UPDATE sales_order SET promised_date = $2 WHERE id = $1', [id, promisedDate]);
  await audit(tx, actor, { action: 'sales_order.promised', entityType: 'sales_order', entityId: id, facilityId: o.facility_id, data: { promisedDate } });
}

/**
 * Records a shipment. Catalog items linked to a part stocked at the order's facility leave a storeroom
 * through the stock ledger ('shipment' movement); services and non-stock items just record the quantity.
 */
export async function shipOrder(tx: Tx, actor: Actor, id: string, input: { shippedOn?: string; carrier?: string | null; tracking?: string | null;
  lines: { orderLineId: string; qty: number; locationId?: string | null; lots?: LotSpec[] | null }[] }) {
  const o = await one(tx, 'SELECT * FROM sales_order WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('sales order');
  requirePermission(actor, 'sales.orders', o.facility_id);
  if (!['open', 'partially_shipped'].includes(o.status)) throw conflict(`order is ${o.status}`);
  if (o.credit_hold) throw conflict(`the order is on credit hold: ${o.credit_hold_note ?? 'over the credit limit'}. Finance must release it before shipping`);
  const lines = input.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw invalid('nothing to ship');
  const number = `SH-${String(await nextSequence(tx, actor.tenantId, 'shipment')).padStart(6, '0')}`;
  const sh = await one(tx, `INSERT INTO shipment (tenant_id, order_id, number, shipped_on, carrier, tracking, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, id, number, input.shippedOn ?? today(), input.carrier ?? null, input.tracking ?? null, actor.userId]);
  for (const r of lines) {
    const l = await one(tx, `SELECT l.*, i.part_id FROM sales_order_line l LEFT JOIN sales_item i ON i.id = l.item_id WHERE l.id = $1 AND l.order_id = $2 FOR UPDATE OF l`, [r.orderLineId, id]);
    if (!l) throw invalid('line is not on this order');
    const open = Number(l.qty) - Number(l.qty_shipped);
    if (r.qty > open + 1e-9) throw invalid(`line ${l.line_no}: only ${open} left to ship`);
    let txnId: number | null = null;
    const stocked = l.part_id && (await one(tx, 'SELECT 1 FROM inventory_balance WHERE part_id = $1 AND facility_id = $2', [l.part_id, o.facility_id]));
    if (stocked) {
      if (!r.locationId) throw invalid(`line ${l.line_no}: this item is stocked here; choose the storeroom it ships from`);
      const loc = await one(tx, 'SELECT facility_id FROM stock_location WHERE id = $1', [r.locationId]);
      if (!loc || loc.facility_id !== o.facility_id) throw invalid(`line ${l.line_no}: ship from a storeroom at the order's facility`);
      txnId = (await postTxn(tx, actor, { locationId: r.locationId, partId: l.part_id, type: 'shipment', qty: -r.qty, reference: `${o.number} ${number}`, lots: r.lots })).txnId;
    }
    await tx.query('UPDATE sales_order_line SET qty_shipped = qty_shipped + $2 WHERE id = $1', [l.id, r.qty]);
    await tx.query(`INSERT INTO shipment_line (tenant_id, shipment_id, order_line_id, qty, location_id, inventory_txn_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor.tenantId, sh.id, l.id, r.qty, stocked ? r.locationId : null, txnId]);
  }
  const left = await one(tx, 'SELECT count(*)::int AS n FROM sales_order_line WHERE order_id = $1 AND qty_shipped < qty', [id]);
  const status = left.n ? 'partially_shipped' : 'shipped';
  await tx.query('UPDATE sales_order SET status = $2 WHERE id = $1', [id, status]);
  await audit(tx, actor, { action: 'sales_order.shipped', entityType: 'sales_order', entityId: id, facilityId: o.facility_id, data: { shipment: number, lines: lines.length, status } });
  const q = o.quote_id ? await one(tx, 'SELECT created_by FROM quote WHERE id = $1', [o.quote_id]) : null;
  await notify(tx, actor.tenantId, [q?.created_by], { kind: 'sales.shipped', title: `${o.number} ${status === 'shipped' ? 'shipped complete' : 'partly shipped'} (${number})`,
    link: `/sales/orders/${id}`, subjectType: 'sales_order', subjectId: id, dedupeKey: `so-shipped:${sh.id}` }, actor.userId);
  return { shipment: number, status };
}

export async function cancelOrder(tx: Tx, actor: Actor, id: string, reason: string) {
  const o = await one(tx, 'SELECT * FROM sales_order WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('sales order');
  requirePermission(actor, 'sales.orders', o.facility_id);
  if (o.status !== 'open') throw conflict(o.status === 'cancelled' ? 'order is already cancelled' : 'something has shipped; cancel the remaining lines with the customer and close by invoicing what shipped');
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE sales_order SET status = 'cancelled' WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'sales_order.cancelled', entityType: 'sales_order', entityId: id, facilityId: o.facility_id, data: { reason } });
}

export async function listOrders(tx: Tx, actor: Actor, q: { open?: boolean; customerId?: string } = {}) {
  requirePermission(actor, 'sales.view');
  const rows = await many(tx, `SELECT o.id, o.number, o.status, o.customer_po, o.requested_date, o.promised_date, o.created_at, o.facility_id, f.code AS facility_code,
      c.name AS customer_name, (SELECT coalesce(sum(l.qty * l.unit_price), 0)::float FROM sales_order_line l WHERE l.order_id = o.id) AS total,
      (o.status IN ('open', 'partially_shipped') AND o.promised_date < current_date) AS late
    FROM sales_order o JOIN customer c ON c.id = o.customer_id JOIN facility f ON f.id = o.facility_id
    WHERE (NOT $1 OR o.status IN ('open', 'partially_shipped')) AND ($2::uuid IS NULL OR o.customer_id = $2)
    ORDER BY o.created_at DESC LIMIT 300`, [q.open ?? false, q.customerId ?? null]);
  return rows.filter((r) => can(actor, 'sales.view', r.facility_id));
}
