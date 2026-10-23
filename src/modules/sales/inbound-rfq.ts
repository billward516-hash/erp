import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { createQuote, type QuoteLineInput } from './service.js';

/**
 * Requests for quote received from customers (SC-005 B). They arrive by email with files attached, so the record is made by hand:
 * who asked, their reference, what they want, the date a reply is due and who owns the answer. The owner decides to bid or not (a
 * no-bid needs a reason), builds the quote from the request, and the status follows the quote: sent is "quoted", accepted is "won",
 * declined is "lost". A due board and daily reminders keep the deadline in front of the owner.
 */
const SUBJECT = 'inbound_rfq';
const OPEN = ['received', 'bid'];

async function lock(tx: Tx, id: string) {
  const r = await one(tx, 'SELECT * FROM inbound_rfq WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw notFound('customer request for quote');
  return r;
}

/** The status of a request that has a quote follows that quote. */
async function syncFromQuotes(tx: Tx, ids?: string[]) {
  await tx.query(`UPDATE inbound_rfq r SET
      status = CASE q.status WHEN 'accepted' THEN 'won' WHEN 'declined' THEN 'lost' ELSE 'quoted' END,
      quoted_at = coalesce(r.quoted_at, now())
    FROM quote q WHERE q.id = r.quote_id AND q.status IN ('sent', 'accepted', 'declined') AND r.status IN ('bid', 'quoted')
      AND r.status <> CASE q.status WHEN 'accepted' THEN 'won' WHEN 'declined' THEN 'lost' ELSE 'quoted' END ${ids ? 'AND r.id = ANY ($1)' : ''}`, ids ? [ids] : []);
}

export interface InboundRfqInput {
  facilityId: string; customerId: string; contactId?: string | null; customerRef?: string | null; subject: string; scope?: string | null;
  source?: 'email' | 'portal' | 'phone' | 'meeting' | 'other'; receivedOn?: string; responseDue: string; ownerUserId?: string | null;
}

export async function createInboundRfq(tx: Tx, actor: Actor, input: InboundRfqInput) {
  requirePermission(actor, 'sales.quote', input.facilityId);
  if (!input.subject?.trim()) throw invalid('say what the customer is asking for');
  const c = await one(tx, 'SELECT id, active FROM customer WHERE id = $1', [input.customerId]);
  if (!c || !c.active) throw invalid('customer not found or inactive');
  if (input.contactId && !(await one(tx, 'SELECT 1 FROM contact WHERE id = $1 AND customer_id = $2', [input.contactId, input.customerId]))) throw invalid('contact is not at this customer');
  const received = input.receivedOn ?? new Date().toISOString().slice(0, 10);
  if (input.responseDue < received) throw invalid('the reply date cannot be before the day the request arrived');
  const owner = input.ownerUserId ?? actor.userId;
  if (!(await one(tx, `SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [owner]))) throw invalid('owner not found');
  const number = `CRFQ-${String(await nextSequence(tx, actor.tenantId, 'inbound_rfq')).padStart(6, '0')}`;
  const r = await one(tx, `INSERT INTO inbound_rfq (tenant_id, facility_id, number, customer_id, contact_id, customer_ref, subject, scope, source, received_on, response_due, owner_user_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.customerId, input.contactId ?? null, input.customerRef?.trim() || null, input.subject.trim(), input.scope?.trim() || null,
    input.source ?? 'email', received, input.responseDue, owner, actor.userId]);
  await audit(tx, actor, { action: 'inbound_rfq.received', entityType: SUBJECT, entityId: r.id, facilityId: r.facility_id, data: { number, customerId: input.customerId, responseDue: input.responseDue } });
  if (owner !== actor.userId) await notify(tx, actor.tenantId, [owner], { kind: 'reminder.review_due', title: `${number} from a customer is yours to answer by ${input.responseDue}`, link: `/sales/rfq/${r.id}`, subjectType: SUBJECT, subjectId: r.id, dedupeKey: `crfq-assigned:${r.id}:${owner}` });
  return r;
}

const SELECT = `SELECT r.*, c.name AS customer_name, f.code AS facility_code, u.display_name AS owner_name, q.number AS quote_number, q.status AS quote_status,
    (r.response_due - current_date) AS days_left, (r.status IN ('received', 'bid') AND r.response_due < current_date) AS overdue
  FROM inbound_rfq r JOIN customer c ON c.id = r.customer_id JOIN facility f ON f.id = r.facility_id JOIN app_user u ON u.id = r.owner_user_id LEFT JOIN quote q ON q.id = r.quote_id`;

export async function listInboundRfqs(tx: Tx, actor: Actor, q: { status?: string; open?: boolean; mine?: boolean } = {}) {
  if (!can(actor, 'sales.view')) requirePermission(actor, 'sales.view');
  await syncFromQuotes(tx);
  const rows = await many(tx, `${SELECT} ORDER BY (r.status IN ('received', 'bid')) DESC, r.response_due, r.created_at DESC LIMIT 500`);
  return rows.filter((r) => (!q.status || r.status === q.status) && (!q.open || OPEN.includes(r.status)) && (!q.mine || r.owner_user_id === actor.userId));
}

/** Open requests grouped by how close the reply date is: the board a sales manager looks at each morning. */
export async function inboundRfqBoard(tx: Tx, actor: Actor) {
  const open = await listInboundRfqs(tx, actor, { open: true });
  const group = (f: (r: any) => boolean) => open.filter(f);
  return {
    overdue: group((r) => r.days_left < 0), today: group((r) => r.days_left === 0), thisWeek: group((r) => r.days_left > 0 && r.days_left <= 7),
    later: group((r) => r.days_left > 7), awaitingDecision: open.filter((r) => r.status === 'received').length,
  };
}

export async function getInboundRfq(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'sales.view');
  await syncFromQuotes(tx, [id]);
  const r = await one(tx, `${SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw notFound('customer request for quote');
  const contact = r.contact_id ? await one(tx, 'SELECT name, email, phone FROM contact WHERE id = $1', [r.contact_id]) : null;
  return { ...r, contact };
}

export async function updateInboundRfq(tx: Tx, actor: Actor, id: string, patch: { subject?: string; scope?: string | null; customerRef?: string | null; responseDue?: string; ownerUserId?: string; contactId?: string | null }) {
  const r = await lock(tx, id);
  requirePermission(actor, 'sales.quote', r.facility_id);
  if (!OPEN.includes(r.status)) throw conflict(`the request is ${r.status}`);
  if (patch.responseDue && patch.responseDue < r.received_on.toISOString().slice(0, 10)) throw invalid('the reply date cannot be before the day the request arrived');
  if (patch.ownerUserId && !(await one(tx, `SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [patch.ownerUserId]))) throw invalid('owner not found');
  await tx.query(`UPDATE inbound_rfq SET subject = coalesce($2, subject), scope = CASE WHEN $3 THEN $4 ELSE scope END, customer_ref = CASE WHEN $5 THEN $6 ELSE customer_ref END,
      response_due = coalesce($7, response_due), owner_user_id = coalesce($8, owner_user_id), contact_id = CASE WHEN $9 THEN $10 ELSE contact_id END WHERE id = $1`,
  [id, patch.subject?.trim() || null, patch.scope !== undefined, patch.scope ?? null, patch.customerRef !== undefined, patch.customerRef ?? null, patch.responseDue ?? null, patch.ownerUserId ?? null, patch.contactId !== undefined, patch.contactId ?? null]);
  await audit(tx, actor, { action: 'inbound_rfq.updated', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { responseDue: patch.responseDue ?? null, ownerChanged: !!patch.ownerUserId } });
  return getInboundRfq(tx, actor, id);
}

/** Bid or no bid. A no-bid needs a reason, so the pattern (too small, outside our range, no capacity) can be read later. */
export async function decideInboundRfq(tx: Tx, actor: Actor, id: string, input: { decision: 'bid' | 'no_bid'; reason?: string | null }) {
  const r = await lock(tx, id);
  requirePermission(actor, 'sales.quote', r.facility_id);
  if (r.status !== 'received') throw conflict(`the request is already ${r.status}`);
  if (input.decision === 'no_bid' && (input.reason?.trim().length ?? 0) < 3) throw invalid('say why we are not bidding');
  await tx.query('UPDATE inbound_rfq SET status = $2, decision_reason = $3, decided_by = $4, decided_at = now() WHERE id = $1', [id, input.decision, input.reason?.trim() || null, actor.userId]);
  await audit(tx, actor, { action: `inbound_rfq.${input.decision}`, entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { reason: input.reason ?? null } });
  return getInboundRfq(tx, actor, id);
}

/** Starts the draft quote that answers the request (the usual pricing approval then applies) and links it. */
export async function quoteFromInboundRfq(tx: Tx, actor: Actor, id: string, input: { lines: QuoteLineInput[]; title?: string; validUntil?: string | null; paymentTerms?: string | null; notes?: string | null; opportunityId?: string | null }) {
  const r = await lock(tx, id);
  requirePermission(actor, 'sales.quote', r.facility_id);
  if (!['received', 'bid'].includes(r.status)) throw conflict(`the request is ${r.status}`);
  if (r.quote_id) throw conflict('a quote has already been started for this request');
  const quote = await createQuote(tx, actor, { facilityId: r.facility_id, customerId: r.customer_id, contactId: r.contact_id, opportunityId: input.opportunityId ?? r.opportunity_id,
    title: input.title ?? `Quote for ${r.customer_ref ?? r.number}: ${r.subject}`.slice(0, 200), validUntil: input.validUntil, paymentTerms: input.paymentTerms,
    notes: input.notes ?? `In reply to ${r.customer_ref ? `your request ${r.customer_ref}` : `request ${r.number}`}.`, lines: input.lines });
  await tx.query(`UPDATE inbound_rfq SET quote_id = $2, status = 'bid', decided_by = coalesce(decided_by, $3), decided_at = coalesce(decided_at, now()), opportunity_id = coalesce(opportunity_id, $4) WHERE id = $1`, [id, quote.id, actor.userId, quote.opportunity_id]);
  await audit(tx, actor, { action: 'inbound_rfq.quote_started', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { quoteId: quote.id, quote: quote.number } });
  return { quoteId: quote.id, quoteNumber: quote.number };
}

/** Closes a request with no quote outcome of its own: the customer withdrew it, or it was lost without a quote. */
export async function closeInboundRfq(tx: Tx, actor: Actor, id: string, input: { outcome: 'cancelled' | 'lost'; reason: string }) {
  const r = await lock(tx, id);
  requirePermission(actor, 'sales.quote', r.facility_id);
  if (!OPEN.includes(r.status) && r.status !== 'quoted') throw conflict(`the request is already ${r.status}`);
  if (input.reason.trim().length < 3) throw invalid('give a reason');
  await tx.query('UPDATE inbound_rfq SET status = $2, outcome_reason = $3 WHERE id = $1', [id, input.outcome, input.reason.trim()]);
  await audit(tx, actor, { action: `inbound_rfq.${input.outcome}`, entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { reason: input.reason } });
  return getInboundRfq(tx, actor, id);
}

/** Daily: tells the owner two days before, on the day, and every day after the reply date, once a day each. */
export async function remindInboundRfqs(tx: Tx, tenantId: string) {
  await syncFromQuotes(tx);
  const rows = await many(tx, `SELECT r.id, r.number, r.owner_user_id, r.response_due, (r.response_due - current_date) AS left, c.name AS customer
    FROM inbound_rfq r JOIN customer c ON c.id = r.customer_id WHERE r.status IN ('received', 'bid') AND r.response_due <= current_date + 2`);
  for (const r of rows) {
    const when = r.left < 0 ? `is ${-r.left} day${r.left === -1 ? '' : 's'} past the reply date` : r.left === 0 ? 'must be answered today' : `is due in ${r.left} day${r.left === 1 ? '' : 's'}`;
    await notify(tx, tenantId, [r.owner_user_id], { kind: 'reminder.review_due', title: `${r.number} from ${r.customer} ${when}`, link: `/sales/rfq/${r.id}`, subjectType: SUBJECT, subjectId: r.id,
      dedupeKey: `crfq-due:${r.id}:${new Date().toISOString().slice(0, 10)}` });
  }
  return rows.length;
}
