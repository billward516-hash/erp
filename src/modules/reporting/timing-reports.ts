import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const r1 = (n: number) => Math.round(n * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Payment behavior (SC-005 C): how late each customer actually pays, and how late the company pays each supplier. Measured on
 * invoices and bills that were paid in the last 12 months: days from invoice to payment, days beyond the due date, and the
 * share paid late. A customer paying 20 days late on average is a different conversation from one that is 3 days late.
 */
export const paymentBehaviorReport: ReportDefinition = {
  id: 'payment-behavior',
  name: 'Payment behavior',
  description: 'How late each customer pays and how late we pay each supplier: days to pay, days beyond terms and the share paid late, over the last twelve months.',
  permission: 'ar.view',
  params: z.object({ facilityId: z.string().uuid().optional(), side: z.enum(['customers', 'suppliers']).default('customers') }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, params.side === 'suppliers' ? 'ap.view' : 'ar.view', params.facilityId);
    const customers = params.side === 'customers';
    const rows = customers
      ? await many(tx, `SELECT c.id AS party_id, c.name AS party, i.id, i.due_date, i.invoice_date, max(p.received_on) AS paid_on,
            ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.tax_amount + i.freight_amount)::float AS amount
          FROM customer_invoice i JOIN customer c ON c.id = i.customer_id JOIN payment_allocation a ON a.invoice_id = i.id JOIN customer_payment p ON p.id = a.payment_id
          WHERE i.facility_id = ANY ($1) AND i.status = 'paid' AND i.due_date IS NOT NULL GROUP BY c.id, c.name, i.id HAVING max(p.received_on) >= current_date - 365`, [scope.ids])
      : await many(tx, `SELECT s.id AS party_id, s.name AS party, i.id, i.due_date, i.invoice_date, i.paid_at::date AS paid_on,
            ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM supplier_invoice_line l WHERE l.invoice_id = i.id) + i.tax_amount + i.freight_amount)::float AS amount
          FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id
          WHERE i.facility_id = ANY ($1) AND i.status = 'paid' AND i.due_date IS NOT NULL AND i.paid_at >= current_date - 365`, [scope.ids]);
    const day = (d: unknown) => Date.parse(`${new Date(d as string).toISOString().slice(0, 10)}T00:00:00Z`) / 86_400_000;
    const by = new Map<string, { party: string; n: number; late: number; toPay: number[]; beyond: number[]; amount: number; lateAmount: number }>();
    for (const r of rows) {
      const g = by.get(r.party_id) ?? { party: r.party, n: 0, late: 0, toPay: [] as number[], beyond: [] as number[], amount: 0, lateAmount: 0 };
      const beyond = day(r.paid_on) - day(r.due_date);
      g.n++; g.amount += r.amount; g.toPay.push(day(r.paid_on) - day(r.invoice_date)); g.beyond.push(beyond);
      if (beyond > 0) { g.late++; g.lateAmount += r.amount; }
      by.set(r.party_id, g);
    }
    const out = [...by.values()].map((g) => ({ party: g.party, paid: g.n, amount: Math.round(g.amount), days_to_pay: r1(avg(g.toPay)!), days_beyond: r1(avg(g.beyond)!), worst: Math.max(...g.beyond),
      pct_late: Math.round((g.late / g.n) * 100), late_amount: Math.round(g.lateAmount) })).sort((a, b) => b.days_beyond - a.days_beyond);
    const all = rows.map((r) => day(r.paid_on) - day(r.due_date));
    const lateShare = all.length ? Math.round((all.filter((d) => d > 0).length / all.length) * 100) : 0;
    const word = customers ? 'customers pay' : 'we pay suppliers';
    const worst = out[0];
    const headline = !rows.length ? `No ${customers ? 'invoices' : 'bills'} were paid in the last twelve months`
      : `${customers ? 'Customers' : 'We'} pay on average ${r1(avg(all)!)} days ${avg(all)! > 0 ? 'after' : 'before'} the due date; ${lateShare}% are paid late`;
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [{ label: customers ? 'Invoices paid' : 'Bills paid', value: rows.length, type: 'integer', status: 'neutral' },
        { label: 'Average days beyond terms', value: all.length ? r1(avg(all)!) : null, type: 'number', status: all.length && avg(all)! > 5 ? 'bad' : all.length && avg(all)! > 0 ? 'watch' : 'good' },
        { label: 'Paid late', value: lateShare, type: 'percent', status: lateShare > 40 ? 'bad' : lateShare > 15 ? 'watch' : 'good' }],
      insights: [worst && worst.days_beyond > 0 ? `Slowest ${customers ? 'payer' : 'to be paid by us'}: ${worst.party}, ${worst.days_beyond} days beyond terms on average over ${plural(worst.paid, customers ? 'invoice' : 'bill')}.` : `No ${word} late on average.`,
        out.filter((o) => o.pct_late >= 50).length ? `${plural(out.filter((o) => o.pct_late >= 50).length, customers ? 'customer' : 'supplier')} pay${out.filter((o) => o.pct_late >= 50).length === 1 ? 's' : ''} late more than half the time.` : 'Nobody pays late more than half the time.'],
      columns: [{ key: 'party', label: customers ? 'Customer' : 'Supplier', type: 'text', width: 1.6 }, { key: 'paid', label: 'Paid', type: 'integer', width: 0.5 }, { key: 'amount', label: 'Amount paid', type: 'currency', unit: 'USD', width: 0.9 },
        { key: 'days_to_pay', label: 'Days to pay', type: 'number', width: 0.6 }, { key: 'days_beyond', label: 'Days beyond terms', type: 'number', width: 0.7 }, { key: 'worst', label: 'Worst', type: 'integer', width: 0.5 },
        { key: 'pct_late', label: 'Paid late', type: 'percent', width: 0.6 }, { key: 'late_amount', label: 'Paid late (amount)', type: 'currency', unit: 'USD', width: 0.9 }],
      rows: out, exceptions: out.map((o, i) => (o.days_beyond > 5 ? i : -1)).filter((i) => i >= 0),
      notes: ['Only fully paid items count. Days beyond terms = the date the last payment arrived minus the due date; negative means early. Customers: the payment date is when the money was recorded. Suppliers: the date the bill was marked paid.',
        'The due date comes from the invoice or bill; where terms were not recognized no due date exists and the item is left out.'],
      source: 'Paid customer invoices with their payments, or paid supplier bills (live query)',
    };
  },
};

/** Purchase orders still open, by how far past the supplier's promise date they are and how long since they were placed. */
export const poAgingReport: ReportDefinition = {
  id: 'po-aging',
  name: 'Purchase order aging',
  description: 'Open purchase order lines by days past the promised date and by age since the order was placed, with the value still to arrive, by supplier.',
  permission: 'purchasing.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'purchasing.view', params.facilityId);
    const rows = await many(tx, `SELECT o.id, o.number, f.code AS facility, s.name AS supplier, o.expected_on, o.created_at::date AS ordered_on, (current_date - o.created_at::date) AS age,
        (current_date - o.expected_on) AS days_over, o.status,
        sum((l.qty_ordered - l.qty_received) * l.unit_price)::float AS open_value, count(*)::int AS open_lines
      FROM purchase_order o JOIN purchase_order_line l ON l.order_id = o.id JOIN supplier s ON s.id = o.supplier_id JOIN facility f ON f.id = o.facility_id
      WHERE o.facility_id = ANY ($1) AND o.status IN ('open', 'partially_received') AND l.qty_received < l.qty_ordered
      GROUP BY o.id, f.code, s.name ORDER BY o.expected_on NULLS LAST`, [scope.ids]);
    const bucket = (d: number | null) => (d == null ? 'No promise date' : d <= 0 ? 'Not yet due' : d <= 7 ? '1–7 days late' : d <= 30 ? '8–30 days late' : d <= 60 ? '31–60 days late' : 'Over 60 days late');
    const order = ['Not yet due', '1–7 days late', '8–30 days late', '31–60 days late', 'Over 60 days late', 'No promise date'];
    const enriched = rows.map((r) => ({ ...r, aging: bucket(r.days_over), days_over: r.days_over != null && r.days_over > 0 ? r.days_over : null }));
    const total = enriched.reduce((s, r) => s + r.open_value, 0);
    const late = enriched.filter((r) => r.days_over != null);
    const lateValue = late.reduce((s, r) => s + r.open_value, 0);
    const bySupplier = new Map<string, { n: number; value: number }>();
    for (const r of late) { const g = bySupplier.get(r.supplier) ?? { n: 0, value: 0 }; g.n++; g.value += r.open_value; bySupplier.set(r.supplier, g); }
    const worst = [...bySupplier.entries()].sort((a, b) => b[1].value - a[1].value)[0];
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length ? 'No purchase orders are waiting for deliveries' : late.length ? `${plural(late.length, 'purchase order')} (${usd(lateValue)} of ${usd(total)} still to arrive) past the promised date` : `${plural(rows.length, 'purchase order')} open (${usd(total)}), none past the promised date`,
      kpis: [{ label: 'Open orders', value: rows.length, type: 'integer', status: 'neutral' }, { label: 'Value still to arrive', value: Math.round(total), type: 'currency', status: 'neutral' },
        { label: 'Past promised date', value: late.length, type: 'integer', status: late.length ? 'bad' : 'good' }, { label: 'Value past promised date', value: Math.round(lateValue), type: 'currency', status: lateValue ? 'bad' : 'good' }],
      insights: [`Aging: ${order.map((b) => `${b} ${usd(enriched.filter((r) => r.aging === b).reduce((s, r) => s + r.open_value, 0))}`).filter((_, i) => enriched.some((r) => r.aging === order[i])).join('; ')}.`,
        ...(worst ? [`Most value late: ${worst[0]}, ${plural(worst[1].n, 'order')}, ${usd(worst[1].value)}.`] : []),
        ...(enriched.filter((r) => r.age > 90).length ? [`${plural(enriched.filter((r) => r.age > 90).length, 'order')} placed more than 90 days ago and still open; confirm they are still wanted.`] : [])],
      columns: [{ key: 'number', label: 'PO', type: 'text', width: 0.8 }, { key: 'supplier', label: 'Supplier', type: 'text', width: 1.6 }, { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'ordered_on', label: 'Ordered', type: 'date', width: 0.8 }, { key: 'age', label: 'Age (days)', type: 'integer', width: 0.6 }, { key: 'expected_on', label: 'Promised', type: 'date', width: 0.8 },
        { key: 'days_over', label: 'Days late', type: 'integer', width: 0.6 }, { key: 'aging', label: 'Aging', type: 'text', width: 1.1 }, { key: 'open_lines', label: 'Open lines', type: 'integer', width: 0.5 },
        { key: 'open_value', label: 'Value to arrive', type: 'currency', unit: 'USD', width: 0.9 }],
      rows: enriched, exceptions: enriched.map((r, i) => (r.days_over != null ? i : -1)).filter((i) => i >= 0), drillDown: { rowKey: 'id', path: '/api/purchase-orders/{id}' },
      notes: ['Open = not fully received and not cancelled. Value to arrive = quantity not yet received × order price. The promised date is the one on the order; orders without one are shown but cannot be late.'],
      source: 'Purchase orders and receipts (live query)',
    };
  },
};

/** Quotes by how long they have waited for a decision, those about to expire, and how fast they are decided. */
export const quoteAgingReport: ReportDefinition = {
  id: 'quote-aging',
  name: 'Quote aging',
  description: 'Quotes waiting for a decision by age, quotes expiring soon or already expired, and how long customers take to decide.',
  permission: 'sales.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'sales.view', params.facilityId);
    const rows = await many(tx, `SELECT q.id, q.number, f.code AS facility, c.name AS customer, q.title, q.status, q.sent_at::date AS sent_on, q.valid_until, u.display_name AS owner,
        (current_date - q.sent_at::date) AS days_waiting, (q.valid_until - current_date) AS days_left,
        (SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM quote_line l WHERE l.quote_id = q.id)::float AS amount
      FROM quote q JOIN customer c ON c.id = q.customer_id JOIN facility f ON f.id = q.facility_id LEFT JOIN app_user u ON u.id = q.created_by
      WHERE q.facility_id = ANY ($1) AND q.status = 'sent' ORDER BY q.valid_until NULLS LAST`, [scope.ids]);
    const decided = await many(tx, `SELECT status, (decided_at::date - sent_at::date) AS days FROM quote WHERE facility_id = ANY ($1) AND status IN ('accepted', 'declined') AND sent_at IS NOT NULL AND decided_at IS NOT NULL AND decided_at >= now() - interval '12 months'`, [scope.ids]);
    const accepted = decided.filter((d) => d.status === 'accepted');
    const stage = (r: any) => (r.days_left != null && r.days_left < 0 ? 'Expired, no decision' : r.days_left != null && r.days_left <= 14 ? 'Expires within 14 days' : r.days_waiting > 30 ? 'Waiting over 30 days' : 'Waiting');
    const enriched = rows.map((r) => ({ ...r, stage: stage(r), days_left: r.days_left })).sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999));
    const expired = enriched.filter((r) => r.stage === 'Expired, no decision');
    const soon = enriched.filter((r) => r.stage === 'Expires within 14 days');
    const value = enriched.reduce((s, r) => s + r.amount, 0);
    const medianAccept = accepted.length ? [...accepted.map((a) => a.days)].sort((a, b) => a - b)[Math.floor(accepted.length / 2)] : null;
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length ? 'No quotes are waiting for a decision' : expired.length ? `${plural(expired.length, 'quote')} (${usd(expired.reduce((s, r) => s + r.amount, 0))}) expired without a decision; ${usd(value)} waiting in all`
        : `${plural(rows.length, 'quote')} waiting (${usd(value)}), ${soon.length ? `${soon.length} expiring within 14 days` : 'none expiring soon'}`,
      kpis: [{ label: 'Quotes waiting', value: rows.length, type: 'integer', status: 'neutral' }, { label: 'Value waiting', value: Math.round(value), type: 'currency', status: 'neutral' },
        { label: 'Expiring in 14 days', value: soon.length, type: 'integer', status: soon.length ? 'watch' : 'good' }, { label: 'Expired, no decision', value: expired.length, type: 'integer', status: expired.length ? 'bad' : 'good' },
        { label: 'Typical days to accept', value: medianAccept, type: 'integer', status: 'neutral', note: `${decided.length} decided in 12 months` }],
      insights: [medianAccept != null ? `Accepted quotes took a median of ${medianAccept} days from sending; ${decided.length ? Math.round((accepted.length / decided.length) * 100) : 0}% of decided quotes were accepted.` : 'No quotes were decided in the last twelve months.',
        ...(enriched.filter((r) => r.days_waiting > 30 && !expired.includes(r)).length ? [`${plural(enriched.filter((r) => r.days_waiting > 30 && !expired.includes(r)).length, 'quote')} sent more than 30 days ago: follow up.`] : [])],
      columns: [{ key: 'number', label: 'Quote', type: 'text', width: 0.8 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.6 }, { key: 'title', label: 'Subject', type: 'text', width: 1.6 }, { key: 'owner', label: 'Owner', type: 'text', width: 1 },
        { key: 'sent_on', label: 'Sent', type: 'date', width: 0.8 }, { key: 'days_waiting', label: 'Days waiting', type: 'integer', width: 0.6 }, { key: 'valid_until', label: 'Valid until', type: 'date', width: 0.8 },
        { key: 'days_left', label: 'Days left', type: 'integer', width: 0.6 }, { key: 'stage', label: 'State', type: 'text', width: 1.2 }, { key: 'amount', label: 'Amount', type: 'currency', unit: 'USD', width: 0.9 }],
      rows: enriched, exceptions: enriched.map((r, i) => (r.stage !== 'Waiting' ? i : -1)).filter((i) => i >= 0), drillDown: { rowKey: 'id', path: '/api/quotes/{id}' },
      notes: ['Only quotes sent and not yet accepted or declined are listed. Days left = valid-until date minus today (negative = expired). Amount = quantity × price on the quote lines, before tax.'],
      source: 'Quotes and quote lines (live query)',
    };
  },
};

/** Customer requests for quote: how fast we answer, how often on time, and how many we win, by where the request came from. */
export const rfqResponseReport: ReportDefinition = {
  id: 'rfq-response',
  name: 'Customer quote requests',
  description: 'Requests received from customers: days to send a quote, share answered by the reply date, requests still open or late, bid decisions and win rate by source.',
  permission: 'sales.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'sales.view', params.facilityId);
    await tx.query(`UPDATE inbound_rfq r SET status = CASE q.status WHEN 'accepted' THEN 'won' WHEN 'declined' THEN 'lost' ELSE 'quoted' END, quoted_at = coalesce(r.quoted_at, now())
      FROM quote q WHERE q.id = r.quote_id AND q.status IN ('sent', 'accepted', 'declined') AND r.status IN ('bid', 'quoted')`);
    const rows = await many(tx, `SELECT r.id, r.number, r.source, r.status, c.name AS customer, r.received_on, r.response_due, r.quoted_at::date AS quoted_on,
        (r.quoted_at::date - r.received_on) AS days_to_quote, (r.quoted_at::date <= r.response_due) AS on_time, (r.status IN ('received', 'bid') AND r.response_due < current_date) AS late_open
      FROM inbound_rfq r JOIN customer c ON c.id = r.customer_id WHERE r.facility_id = ANY ($1) AND r.received_on >= current_date - 365 ORDER BY r.received_on DESC`, [scope.ids]);
    const answered = rows.filter((r) => r.quoted_on != null);
    const decided = rows.filter((r) => ['won', 'lost'].includes(r.status));
    const won = rows.filter((r) => r.status === 'won').length;
    const noBid = rows.filter((r) => r.status === 'no_bid').length;
    const open = rows.filter((r) => ['received', 'bid'].includes(r.status));
    const lateOpen = rows.filter((r) => r.late_open).length;
    const onTime = answered.length ? Math.round((answered.filter((r) => r.on_time).length / answered.length) * 100) : null;
    const avgDays = avg(answered.map((r) => r.days_to_quote));
    const winRate = decided.length ? Math.round((won / decided.length) * 100) : null;
    const bySource = new Map<string, { n: number; quoted: number; won: number; decided: number }>();
    for (const r of rows) {
      const g = bySource.get(r.source) ?? { n: 0, quoted: 0, won: 0, decided: 0 };
      g.n++; if (r.quoted_on) g.quoted++; if (r.status === 'won') g.won++; if (['won', 'lost'].includes(r.status)) g.decided++;
      bySource.set(r.source, g);
    }
    const table = rows.map((r) => ({ number: r.number, customer: r.customer, source: r.source, received_on: r.received_on, response_due: r.response_due, quoted_on: r.quoted_on, days_to_quote: r.days_to_quote,
      status: r.late_open ? `${r.status} (late)` : r.status }));
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length ? 'No customer requests for quote in the last twelve months'
        : `${plural(rows.length, 'customer request')} in twelve months; ${onTime == null ? 'none quoted yet' : `${onTime}% answered by the reply date`}${lateOpen ? `; ${lateOpen} open and late` : ''}`,
      kpis: [{ label: 'Requests received', value: rows.length, type: 'integer', status: 'neutral' },
        { label: 'Answered by reply date', value: onTime, type: 'percent', status: onTime == null ? 'neutral' : onTime < 70 ? 'bad' : onTime < 90 ? 'watch' : 'good' },
        { label: 'Average days to quote', value: avgDays == null ? null : r1(avgDays), type: 'number', status: 'neutral' },
        { label: 'Open and late', value: lateOpen, type: 'integer', status: lateOpen ? 'bad' : 'good' },
        { label: 'Win rate', value: winRate, type: 'percent', status: 'neutral' }],
      insights: [`${plural(open.length, 'request')} still open, ${plural(noBid, 'request')} declined as no-bid.`,
        ...[...bySource.entries()].filter(([, g]) => g.decided >= 2).map(([s, g]) => `Requests by ${s}: ${Math.round((g.won / g.decided) * 100)}% won of ${g.decided} decided.`)],
      columns: [{ key: 'number', label: 'Request', type: 'text', width: 0.9 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.6 }, { key: 'source', label: 'Source', type: 'text', width: 0.6 },
        { key: 'received_on', label: 'Received', type: 'date', width: 0.8 }, { key: 'response_due', label: 'Reply by', type: 'date', width: 0.8 }, { key: 'quoted_on', label: 'Quoted', type: 'date', width: 0.8 },
        { key: 'days_to_quote', label: 'Days to quote', type: 'integer', width: 0.6 }, { key: 'status', label: 'Status', type: 'text', width: 0.8 }],
      rows: table, exceptions: table.map((r, i) => (String(r.status).includes('late') ? i : -1)).filter((i) => i >= 0),
      notes: ['Days to quote run from the day the request arrived to the day its quote was sent. A request is answered on time when its quote was sent on or before the reply date. Win rate counts requests whose quote was accepted or declined.'],
      source: 'Customer requests for quote and their quotes (live query)',
    };
  },
};

/** What happened to the quotes we sent in the last twelve months: accepted, declined, expired unanswered, still open, and why and how. */
export const quoteOutcomesReport: ReportDefinition = {
  id: 'quote-outcomes',
  name: 'Quote outcomes',
  description: 'Quotes sent in the last twelve months by outcome: accepted (with how and when), declined (with reasons), expired without an answer, still open, and how often validity was extended.',
  permission: 'sales.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'sales.view', params.facilityId);
    const rows = await many(tx, `SELECT q.number, c.name AS customer, q.title, q.status, q.sent_at::date AS sent_on, q.valid_until, q.accepted_on, q.accepted_by_name, q.accepted_method, q.customer_po, q.decline_reason,
        (SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM quote_line l WHERE l.quote_id = q.id)::float AS amount,
        (SELECT count(*)::int FROM quote_validity_change v WHERE v.quote_id = q.id) AS extensions,
        CASE WHEN q.status = 'accepted' THEN 'Accepted' WHEN q.status = 'declined' THEN 'Declined'
             WHEN q.status = 'sent' AND q.valid_until < current_date THEN 'Expired unanswered' WHEN q.status = 'sent' THEN 'Open' ELSE 'Other' END AS outcome,
        (coalesce(q.accepted_on, q.decided_at::date) - q.sent_at::date) AS days_to_decide
      FROM quote q JOIN customer c ON c.id = q.customer_id WHERE q.facility_id = ANY ($1) AND q.sent_at >= current_date - 365 ORDER BY q.sent_at DESC`, [scope.ids]);
    const by = (o: string) => rows.filter((r) => r.outcome === o);
    const sum = (xs: any[]) => xs.reduce((s, r) => s + r.amount, 0);
    const decided = by('Accepted').length + by('Declined').length + by('Expired unanswered').length;
    const winRate = decided ? Math.round((by('Accepted').length / decided) * 100) : null;
    const days = avg(rows.filter((r) => r.outcome === 'Accepted' && r.days_to_decide != null).map((r) => r.days_to_decide));
    const reasons = new Map<string, number>();
    for (const r of by('Declined')) reasons.set(r.decline_reason, (reasons.get(r.decline_reason) ?? 0) + 1);
    const extended = rows.filter((r) => r.extensions > 0);
    const methods = new Map<string, number>();
    for (const r of by('Accepted')) methods.set(r.accepted_method ?? 'not recorded', (methods.get(r.accepted_method ?? 'not recorded') ?? 0) + 1);
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length ? 'No quotes were sent in the last twelve months' : `${plural(rows.length, 'quote')} sent: ${by('Accepted').length} accepted (${usd(sum(by('Accepted')))}), ${by('Declined').length} declined, ${by('Expired unanswered').length} expired unanswered (${usd(sum(by('Expired unanswered')))}), ${by('Open').length} open`,
      kpis: [{ label: 'Quotes sent', value: rows.length, type: 'integer', status: 'neutral' }, { label: 'Win rate (decided)', value: winRate, type: 'percent', status: 'neutral' },
        { label: 'Accepted value', value: Math.round(sum(by('Accepted'))), type: 'currency', status: 'good' }, { label: 'Expired unanswered', value: by('Expired unanswered').length, type: 'integer', status: by('Expired unanswered').length ? 'watch' : 'good' },
        { label: 'Days to accept (avg)', value: days == null ? null : r1(days), type: 'number', status: 'neutral' }],
      insights: [...(reasons.size ? [`Declined because: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join('; ')}.`] : []),
        ...(methods.size ? [`Accepted by ${[...methods.entries()].map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ')}.`] : []),
        ...(extended.length ? [`${plural(extended.length, 'quote')} had validity extended; ${extended.filter((r) => r.outcome === 'Accepted').length} of them were accepted.`] : [])],
      columns: [{ key: 'number', label: 'Quote', type: 'text', width: 0.8 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.4 }, { key: 'sent_on', label: 'Sent', type: 'date', width: 0.8 },
        { key: 'valid_until', label: 'Valid until', type: 'date', width: 0.8 }, { key: 'amount', label: 'Value', type: 'currency', unit: 'USD', width: 0.9 }, { key: 'outcome', label: 'Outcome', type: 'text', width: 1 },
        { key: 'days_to_decide', label: 'Days to decide', type: 'integer', width: 0.6 }, { key: 'accepted_by_name', label: 'Accepted by', type: 'text', width: 1 }, { key: 'accepted_method', label: 'How', type: 'text', width: 0.8 },
        { key: 'extensions', label: 'Extensions', type: 'integer', width: 0.5 }, { key: 'decline_reason', label: 'Declined because', type: 'text', width: 1.4 }],
      rows, exceptions: rows.map((r, i) => (r.outcome === 'Expired unanswered' ? i : -1)).filter((i) => i >= 0),
      notes: ['Win rate counts accepted against accepted, declined and expired unanswered. Days to decide run from the day the quote was sent to the recorded acceptance date.'],
      source: 'Quotes (live query)',
    };
  },
};
