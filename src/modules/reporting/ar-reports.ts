import { z } from 'zod';
import { many, one } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const BUCKETS = ['Current', '1–30 days overdue', '31–60 days overdue', '61–90 days overdue', 'Over 90 days overdue'] as const;
const bucketOf = (daysOver: number) => (daysOver <= 0 ? 0 : daysOver <= 30 ? 1 : daysOver <= 60 ? 2 : daysOver <= 90 ? 3 : 4);

export const arAgingReport: ReportDefinition = {
  id: 'ar-aging',
  name: 'Accounts receivable aging',
  description: 'What customers owe by how overdue it is, days sales outstanding, promises to pay, shipments not yet invoiced, and orders on credit hold.',
  permission: 'ar.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'ar.view', params.facilityId);
    const rows = await many(tx, `
      SELECT i.id, i.number, f.code AS facility, c.name AS customer, o.number AS order_number, i.invoice_date, i.due_date, i.status,
             ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.freight_amount + i.tax_amount)::float AS total,
             (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id)::float AS paid,
             (current_date - i.due_date) AS days_over,
             (SELECT min(t.due_on) FROM activity t WHERE t.invoice_id = i.id AND t.kind = 'task' AND t.done_at IS NULL) AS promised_by,
             (SELECT max(a.created_at) FROM activity a WHERE a.invoice_id = i.id AND a.kind = 'collection') AS last_contact
      FROM customer_invoice i JOIN facility f ON f.id = i.facility_id JOIN customer c ON c.id = i.customer_id LEFT JOIN sales_order o ON o.id = i.order_id
      WHERE i.facility_id = ANY ($1) AND i.status IN ('issued', 'partially_paid')
      ORDER BY i.due_date`, [scope.ids]);
    // Days sales outstanding over the last 90 days: open receivables / invoiced in the period × 90.
    const billed = Number((await one(tx, `SELECT coalesce(sum((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.freight_amount + i.tax_amount), 0)::float AS s
      FROM customer_invoice i WHERE i.facility_id = ANY ($1) AND i.status <> 'void' AND i.status <> 'draft' AND i.invoice_date > current_date - 90`, [scope.ids])).s);
    const uninvoiced = await one(tx, `SELECT count(DISTINCT o.id)::int AS orders, coalesce(sum((l.qty_shipped - l.qty_invoiced) * l.unit_price), 0)::float AS amount
      FROM sales_order o JOIN sales_order_line l ON l.order_id = o.id WHERE o.facility_id = ANY ($1) AND l.qty_shipped > l.qty_invoiced`, [scope.ids]);
    const holds = await many(tx, `SELECT o.number, c.name AS customer FROM sales_order o JOIN customer c ON c.id = o.customer_id
      WHERE o.facility_id = ANY ($1) AND o.credit_hold AND o.status IN ('open', 'partially_shipped')`, [scope.ids]);
    const today = new Date().toISOString().slice(0, 10);
    const enriched = rows.map((r) => {
      const balance = Math.round((r.total - r.paid) * 100) / 100;
      const promise = r.promised_by ? (r.promised_by < today ? `Broken: promised by ${r.promised_by}` : `Promised by ${r.promised_by}`) : null;
      return { ...r, balance, bucket: BUCKETS[bucketOf(r.days_over)], days_over: r.days_over > 0 ? r.days_over : null, promise };
    });
    const totals = BUCKETS.map((b) => enriched.filter((r) => r.bucket === b).reduce((s, r) => s + r.balance, 0));
    const open = enriched.reduce((s, r) => s + r.balance, 0);
    const overdue = open - totals[0]!;
    const over60 = totals[2]! + totals[3]! + totals[4]!;
    const dso = billed > 0 ? Math.round((open / billed) * 90) : null;
    const broken = enriched.filter((r) => r.promise?.startsWith('Broken'));
    const promised = enriched.filter((r) => r.promise && !r.promise.startsWith('Broken'));
    const noContact = enriched.filter((r) => r.days_over != null && r.days_over > 30 && !r.last_contact);
    const byCustomer = new Map<string, number>();
    for (const r of enriched) if (r.days_over != null) byCustomer.set(r.customer, (byCustomer.get(r.customer) ?? 0) + r.balance);
    const topLate = [...byCustomer.entries()].sort((a, b) => b[1] - a[1])[0];
    const headline = !rows.length ? 'No open customer invoices in scope'
      : overdue > 0 ? `${usd(overdue)} of ${usd(open)} receivables overdue${topLate ? `; ${topLate[0]} owes the most past due` : ''}`
      : `${usd(open)} receivables open, none overdue`;
    const insights: string[] = [];
    if (rows.length) insights.push(`Aging: ${BUCKETS.map((b, i) => `${b} ${usd(totals[i]!)}`).filter((_, i) => totals[i]).join('; ')}.`);
    if (broken.length) insights.push(`${plural(broken.length, 'promise')} to pay broken: ${broken.slice(0, 3).map((r) => `${r.number} (${r.customer})`).join(', ')}.`);
    if (promised.length) insights.push(`${plural(promised.length, 'invoice')} with a promise to pay, ${usd(promised.reduce((s, r) => s + r.balance, 0))} expected.`);
    if (noContact.length) insights.push(`${plural(noContact.length, 'invoice')} over 30 days late with no collections contact logged.`);
    if (uninvoiced.amount > 0) insights.push(`${usd(uninvoiced.amount)} shipped but not invoiced on ${plural(uninvoiced.orders, 'order')}.`);
    if (holds.length) insights.push(`${plural(holds.length, 'order')} on credit hold: ${holds.slice(0, 3).map((h) => `${h.number} (${h.customer})`).join(', ')}.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Open receivables', value: Math.round(open), type: 'currency', status: 'neutral' },
        { label: 'Overdue', value: Math.round(overdue), type: 'currency', status: overdue ? 'bad' : 'good' },
        { label: 'Over 60 days', value: Math.round(over60), type: 'currency', status: over60 ? 'bad' : 'good' },
        { label: 'Days sales outstanding', value: dso ?? 0, type: 'integer', status: dso == null ? 'neutral' : dso > 45 ? 'watch' : 'good' },
        { label: 'Shipped, not invoiced', value: Math.round(uninvoiced.amount), type: 'currency', status: uninvoiced.amount ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'customer', label: 'Customer', type: 'text', width: 1.6 },
        { key: 'number', label: 'Invoice', type: 'text', width: 0.9 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'order_number', label: 'Order', type: 'text', width: 0.8 },
        { key: 'invoice_date', label: 'Invoice date', type: 'date', width: 0.8 },
        { key: 'due_date', label: 'Due', type: 'date', width: 0.8 },
        { key: 'days_over', label: 'Days overdue', type: 'integer', width: 0.6 },
        { key: 'bucket', label: 'Aging', type: 'text', width: 1.1 },
        { key: 'promise', label: 'Promise to pay', type: 'text', width: 1.2 },
        { key: 'total', label: 'Invoiced', type: 'currency', unit: 'USD', width: 0.8 },
        { key: 'balance', label: 'Balance', type: 'currency', unit: 'USD', width: 0.8 },
      ],
      rows: enriched,
      exceptions: enriched.map((r, i) => (r.days_over != null && r.days_over > 30 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/customer-invoices/{id}' },
      notes: [
        'Open = issued and not fully paid. With an accounting connection, payments come from the accounting system on each sync; with a file export they are recorded here.',
        'Due dates come from the payment terms on the order (e.g. Net 30 from the invoice date; Net 30 when the terms are not recognized).',
        `Days sales outstanding = open receivables ÷ amount invoiced in the last 90 days × 90${billed ? '' : ' (nothing invoiced in the period, so not computed)'}.`,
        'The accounting system remains the book of record for receivables balances and the general ledger.',
      ],
      source: 'Customer invoices, payments, collections notes and sales orders (live query)',
    };
  },
};
