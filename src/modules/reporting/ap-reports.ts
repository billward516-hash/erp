import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const BUCKETS = ['Not yet due', '1–30 days overdue', '31–60 days overdue', '61–90 days overdue', 'Over 90 days overdue', 'No due date'] as const;
const bucketOf = (daysOver: number | null) => (daysOver == null ? 5 : daysOver <= 0 ? 0 : daysOver <= 30 ? 1 : daysOver <= 60 ? 2 : daysOver <= 90 ? 3 : 4);

export const apAgingReport: ReportDefinition = {
  id: 'ap-aging',
  name: 'Accounts payable aging',
  description: 'Unpaid supplier invoices by how overdue they are, what is due this week, invoices waiting for approval, and accounting sync problems.',
  permission: 'ap.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'ap.view', params.facilityId);
    const rows = await many(tx, `
      SELECT i.id, i.invoice_number, f.code AS facility, s.name AS supplier, o.number AS po_number, i.invoice_date, i.due_date, i.status,
             ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM supplier_invoice_line l WHERE l.invoice_id = i.id) + i.tax_amount + i.freight_amount)::float AS amount,
             (current_date - i.due_date) AS days_over
      FROM supplier_invoice i JOIN facility f ON f.id = i.facility_id JOIN supplier s ON s.id = i.supplier_id LEFT JOIN purchase_order o ON o.id = i.purchase_order_id
      WHERE i.facility_id = ANY ($1) AND i.status IN ('captured', 'approved', 'exported', 'disputed')
      ORDER BY i.due_date NULLS LAST`, [scope.ids]);
    const dead = (await many(tx, `SELECT count(*)::int AS n FROM sync_delivery d JOIN integration_connection c ON c.id = d.connection_id WHERE c.active AND d.status = 'dead'`))[0]!.n;
    const STATUS: Record<string, string> = { captured: 'Waiting for approval', approved: 'Approved, not yet in accounting', exported: 'In accounting, unpaid', disputed: 'Disputed with supplier' };
    const enriched = rows.map((r) => ({ ...r, bucket: BUCKETS[bucketOf(r.days_over)], stage: STATUS[r.status], days_over: r.days_over != null && r.days_over > 0 ? r.days_over : null }));
    const totals = BUCKETS.map((b) => enriched.filter((r) => r.bucket === b).reduce((s, r) => s + r.amount, 0));
    const open = enriched.reduce((s, r) => s + r.amount, 0);
    const overdue = totals.slice(1, 5).reduce((s, n) => s + n, 0);
    const week = enriched.filter((r) => r.due_date && r.days_over == null && rows.find((x) => x.id === r.id)!.days_over >= -7);
    const waiting = enriched.filter((r) => r.status === 'captured');
    const disputed = enriched.filter((r) => r.status === 'disputed');
    const headline = !rows.length ? 'No unpaid supplier invoices in scope'
      : overdue > 0 ? `${usd(overdue)} of ${usd(open)} payables overdue`
      : `${usd(open)} payables open, none overdue`;
    const insights: string[] = [];
    if (week.length) insights.push(`${plural(week.length, 'invoice')} due in the next 7 days, ${usd(week.reduce((s, r) => s + r.amount, 0))}.`);
    if (waiting.length) insights.push(`${plural(waiting.length, 'invoice')} waiting for approval (${usd(waiting.reduce((s, r) => s + r.amount, 0))}); unapproved invoices cannot be paid.`);
    if (disputed.length) insights.push(`${plural(disputed.length, 'invoice')} disputed with suppliers: ${disputed.slice(0, 3).map((r) => `${r.invoice_number} (${r.supplier})`).join(', ')}.`);
    const oldest = enriched.find((r) => r.days_over != null && r.days_over === Math.max(...enriched.map((x) => x.days_over ?? 0)));
    if (oldest) insights.push(`Most overdue: ${oldest.invoice_number} from ${oldest.supplier}, ${plural(oldest.days_over!, 'day')} past due.`);
    if (dead) insights.push(`${plural(dead, 'accounting sync item')} failed and need attention on the Integrations page.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Open payables', value: Math.round(open), type: 'currency', status: 'neutral' },
        { label: 'Overdue', value: Math.round(overdue), type: 'currency', status: overdue ? 'bad' : 'good' },
        { label: 'Due in 7 days', value: Math.round(week.reduce((s, r) => s + r.amount, 0)), type: 'currency', status: 'neutral' },
        { label: 'Waiting for approval', value: waiting.length, type: 'integer', status: waiting.length ? 'watch' : 'good' },
        { label: 'Sync failures', value: dead, type: 'integer', status: dead ? 'bad' : 'good' },
      ],
      insights: [`Aging: ${BUCKETS.map((b, i) => `${b} ${usd(totals[i]!)}`).filter((_, i) => totals[i]).join('; ')}.`, ...insights].slice(0, 5),
      columns: [
        { key: 'supplier', label: 'Supplier', type: 'text', width: 1.6 },
        { key: 'invoice_number', label: 'Invoice', type: 'text', width: 0.9 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'po_number', label: 'PO', type: 'text', width: 0.8 },
        { key: 'invoice_date', label: 'Invoice date', type: 'date', width: 0.8 },
        { key: 'due_date', label: 'Due', type: 'date', width: 0.8 },
        { key: 'days_over', label: 'Days overdue', type: 'integer', width: 0.6 },
        { key: 'bucket', label: 'Aging', type: 'text', width: 1.1 },
        { key: 'stage', label: 'Status', type: 'text', width: 1.4 },
        { key: 'amount', label: 'Amount', type: 'currency', unit: 'USD', width: 0.8 },
      ],
      rows: enriched,
      exceptions: enriched.map((r, i) => (r.days_over != null || r.status === 'disputed' ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/supplier-invoices/{id}' },
      notes: [
        'Open = captured, approved, sent to accounting or disputed, and not yet paid. Paid status comes from the accounting system when it is connected; with a file export it is recorded here by hand.',
        'Due dates come from the supplier\'s payment terms (e.g. Net 30 from the invoice date) unless set on the invoice. Early-payment discounts are not tracked.',
        'Amounts include tax and freight as invoiced. The accounting system remains the book of record for payables balances.',
      ],
      source: 'Supplier invoices and accounting sync status (live query)',
    };
  },
};
