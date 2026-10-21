import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const purchasingStatusReport: ReportDefinition = {
  id: 'purchasing-status',
  name: 'Purchasing status',
  description: 'Requests waiting for approval or ordering, open and late purchase orders, committed spend and supplier on-time delivery.',
  permission: 'purchasing.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(366).default(90) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'purchasing.view', params.facilityId);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - params.days * 86_400_000).toISOString().slice(0, 10);
    const requests = await many(tx, `
      SELECT r.id, r.number, f.code AS facility, r.title, r.status, r.spend_type, u.display_name AS requested_by, r.needed_by,
             round(extract(epoch FROM now() - coalesce(r.submitted_at, r.created_at)) / 86400.0)::int AS age_days,
             (SELECT coalesce(sum(l.qty * l.est_unit_price), 0)::float FROM purchase_request_line l WHERE l.request_id = r.id) AS amount,
             (SELECT string_agg(DISTINCT s.label, ', ') FROM approval_request a JOIN approval_step s ON s.request_id = a.id
               WHERE a.subject_id = r.id AND a.status = 'pending' AND s.status = 'pending'
                 AND s.stage = (SELECT min(x.stage) FROM approval_step x WHERE x.request_id = a.id AND x.status = 'pending')) AS waiting_on
      FROM purchase_request r JOIN facility f ON f.id = r.facility_id JOIN app_user u ON u.id = r.requested_by
      WHERE r.facility_id = ANY ($1) AND r.status IN ('pending_approval', 'approved')`, [scope.ids]);
    const orders = await many(tx, `
      SELECT o.id, o.number, f.code AS facility, s.name AS supplier, o.status, o.expected_on,
             round(extract(epoch FROM now() - o.created_at) / 86400.0)::int AS age_days,
             (SELECT coalesce(sum(l.qty_ordered * l.unit_price), 0)::float FROM purchase_order_line l WHERE l.order_id = o.id) AS amount,
             (SELECT coalesce(sum((l.qty_ordered - l.qty_received) * l.unit_price), 0)::float FROM purchase_order_line l WHERE l.order_id = o.id) AS open_amount,
             (o.expected_on < current_date) AS late
      FROM purchase_order o JOIN facility f ON f.id = o.facility_id JOIN supplier s ON s.id = o.supplier_id
      WHERE o.facility_id = ANY ($1) AND o.status IN ('open', 'partially_received')`, [scope.ids]);
    const period = (await many(tx, `
      SELECT coalesce(sum(l.qty_ordered * l.unit_price), 0)::float AS committed, count(DISTINCT o.id)::int AS orders
      FROM purchase_order o JOIN purchase_order_line l ON l.order_id = o.id
      WHERE o.facility_id = ANY ($1) AND o.status <> 'cancelled' AND o.created_at::date BETWEEN $2 AND $3`, [scope.ids, from, to]))[0]!;
    // On-time delivery: orders completed in the period whose last receipt was on or before the expected date.
    const deliveries = await many(tx, `
      SELECT o.number, s.name AS supplier, o.expected_on, max(x.received_at)::date AS done_on
      FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id JOIN purchase_order_line l ON l.order_id = o.id JOIN po_receipt x ON x.order_line_id = l.id
      WHERE o.facility_id = ANY ($1) AND o.status = 'received' AND o.expected_on IS NOT NULL
      GROUP BY o.id, o.number, s.name, o.expected_on HAVING max(x.received_at)::date BETWEEN $2 AND $3`, [scope.ids, from, to]);
    const onTime = deliveries.filter((d) => d.done_on <= d.expected_on).length;
    const otd = deliveries.length ? onTime / deliveries.length : null;

    const STAGE: Record<string, string> = { pending_approval: 'Awaiting approval', approved: 'Approved, not ordered', open: 'Ordered', partially_received: 'Partly received' };
    const rows = [
      ...requests.map((r) => ({ ...r, kind: 'Request', stage: STAGE[r.status], supplier: null, due: r.needed_by, late: false, drill: `/api/purchase-requests/${r.id}` })),
      ...orders.map((o) => ({ ...o, kind: 'Order', stage: STAGE[o.status], title: null, waiting_on: null, due: o.expected_on, amount: o.open_amount, drill: `/api/purchase-orders/${o.id}` })),
    ].sort((a, b) => Number(b.late) - Number(a.late) || b.age_days - a.age_days);
    const awaiting = requests.filter((r) => r.status === 'pending_approval');
    const toOrder = requests.filter((r) => r.status === 'approved');
    const late = orders.filter((o) => o.late);
    const openValue = orders.reduce((s, o) => s + o.open_amount, 0);
    const headline = !rows.length && !period.orders ? 'No purchasing activity in scope'
      : late.length ? `${plural(late.length, 'purchase order')} late; ${plural(awaiting.length, 'request')} awaiting approval`
      : `${plural(awaiting.length, 'request')} awaiting approval, ${plural(orders.length, 'order')} open (${usd(openValue)} to receive)`;
    const insights: string[] = [];
    if (awaiting.length) {
      const oldest = awaiting.reduce((a, b) => (b.age_days > a.age_days ? b : a));
      insights.push(`Oldest request awaiting approval: ${oldest.number} (${usd(oldest.amount)}), ${plural(oldest.age_days, 'day')}, waiting on ${oldest.waiting_on ?? 'approval'}.`);
    }
    if (toOrder.length) insights.push(`${plural(toOrder.length, 'approved request')} not yet ordered, worth ${usd(toOrder.reduce((s, r) => s + r.amount, 0))}.`);
    if (late.length) insights.push(`Late deliveries: ${late.slice(0, 3).map((o) => `${o.number} from ${o.supplier} (due ${o.expected_on})`).join('; ')}.`);
    if (otd !== null) insights.push(`Supplier on-time delivery ${pct(otd)} (${onTime} of ${deliveries.length} orders completed in the period).`);
    insights.push(`${usd(period.committed)} committed on ${plural(period.orders, 'purchase order')} in the last ${params.days} days.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      period: { from, to }, scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Awaiting approval', value: awaiting.length, type: 'integer', note: usd(awaiting.reduce((s, r) => s + r.amount, 0)), status: 'neutral' },
        { label: 'Approved, not ordered', value: toOrder.length, type: 'integer', status: toOrder.length ? 'watch' : 'good' },
        { label: 'Late orders', value: late.length, type: 'integer', status: late.length ? 'bad' : 'good' },
        { label: 'Supplier on-time delivery', value: otd, type: 'percent', note: `last ${params.days} days`, status: otd === null ? 'neutral' : otd >= 0.9 ? 'good' : otd >= 0.75 ? 'watch' : 'bad' },
        { label: 'Committed spend', value: Math.round(period.committed), type: 'currency', note: `last ${params.days} days`, status: 'neutral' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'kind', label: 'Type', type: 'text', width: 0.6 },
        { key: 'number', label: 'Number', type: 'text', width: 0.9 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'stage', label: 'Stage', type: 'text', width: 1.1 },
        { key: 'title', label: 'Request', type: 'text', width: 2 },
        { key: 'supplier', label: 'Supplier', type: 'text', width: 1.3 },
        { key: 'waiting_on', label: 'Waiting on', type: 'text', width: 1.2 },
        { key: 'amount', label: 'Amount (open)', type: 'currency', unit: 'USD', width: 0.9 },
        { key: 'due', label: 'Needed / expected', type: 'date', width: 0.9 },
        { key: 'age_days', label: 'Age', type: 'integer', unit: 'days', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.late ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'drill', path: '{drill}' },
      notes: [
        'Requests: submitted and waiting for sign-off, or approved and waiting for the buyer to order. Request amounts are estimates.',
        'Orders: amount still to be received at the order price. Late = expected date has passed and the order is not fully received.',
        'On-time delivery counts orders fully received in the period, comparing the last receipt with the expected date.',
        'Invoices and payments are in the accounting system; this report shows commitments, not spend posted to the ledger.',
      ],
      source: 'Purchase requests, purchase orders and receipts (live query)',
    };
  },
};
