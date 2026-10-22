import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const STAGES = ['lead', 'qualified', 'proposal', 'negotiation'];

export const salesPipelineReport: ReportDefinition = {
  id: 'sales-pipeline',
  name: 'Sales pipeline',
  description: 'Open opportunities by stage (weighted by probability), quotes awaiting a decision, win rate, orders booked and orders late to ship.',
  permission: 'crm.view',
  params: z.object({ days: z.coerce.number().int().min(7).max(366).default(90) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'sales.view');
    const from = new Date(Date.now() - params.days * 86_400_000).toISOString().slice(0, 10);
    const opps = await many(tx, `SELECT o.id, o.title, o.stage, coalesce(o.amount, 0)::float AS amount, o.probability, o.expected_close, c.name AS customer, u.display_name AS owner,
        (coalesce(o.amount, 0) * o.probability / 100.0)::float AS weighted, (o.expected_close < current_date) AS past_close,
        (SELECT max(a.created_at) FROM activity a WHERE a.opportunity_id = o.id OR (a.customer_id = o.customer_id AND a.opportunity_id IS NULL)) AS last_touch
      FROM opportunity o JOIN customer c ON c.id = o.customer_id LEFT JOIN app_user u ON u.id = o.owner_user_id
      WHERE o.stage NOT IN ('won', 'lost') ORDER BY array_position(ARRAY['negotiation','proposal','qualified','lead'], o.stage), o.expected_close NULLS LAST`);
    const quotes = await many(tx, `SELECT q.status, q.valid_until, (SELECT coalesce(sum(l.qty * l.unit_price), 0)::float FROM quote_line l WHERE l.quote_id = q.id) AS total
      FROM quote q WHERE q.facility_id = ANY ($1) AND (q.status = 'sent' OR (q.status IN ('accepted', 'declined') AND q.decided_at::date >= $2))`, [scope.ids, from]);
    const orders = await many(tx, `SELECT o.status, o.promised_date, o.created_at, (SELECT coalesce(sum(l.qty * l.unit_price), 0)::float FROM sales_order_line l WHERE l.order_id = o.id) AS total
      FROM sales_order o WHERE o.facility_id = ANY ($1) AND o.status <> 'cancelled'`, [scope.ids]);
    const awaiting = quotes.filter((q) => q.status === 'sent');
    const accepted = quotes.filter((q) => q.status === 'accepted');
    const declined = quotes.filter((q) => q.status === 'declined');
    const winRate = accepted.length + declined.length ? accepted.length / (accepted.length + declined.length) : null;
    const booked = orders.filter((o) => new Date(o.created_at).toISOString().slice(0, 10) >= from).reduce((s, o) => s + o.total, 0);
    const late = orders.filter((o) => ['open', 'partially_shipped'].includes(o.status) && o.promised_date && o.promised_date < new Date().toISOString().slice(0, 10));
    const weighted = opps.reduce((s, o) => s + o.weighted, 0);
    const byStage = STAGES.map((st) => ({ st, n: opps.filter((o) => o.stage === st).length, amt: opps.filter((o) => o.stage === st).reduce((s, o) => s + o.amount, 0) }));
    const stale = opps.filter((o) => !o.last_touch || Date.now() - new Date(o.last_touch).getTime() > 30 * 86_400_000);
    const headline = !opps.length && !awaiting.length ? 'No open opportunities or quotes'
      : `${usd(weighted)} weighted pipeline across ${plural(opps.length, 'open opportunity')}; ${plural(awaiting.length, 'quote')} awaiting a decision`;
    const insights: string[] = [`By stage: ${byStage.filter((b) => b.n).map((b) => `${b.st} ${b.n} (${usd(b.amt)})`).join(', ') || 'none'}.`];
    if (winRate !== null) insights.push(`Quote win rate ${pct(winRate)} over ${params.days} days (${accepted.length} won, ${declined.length} declined).`);
    if (awaiting.length) insights.push(`${usd(awaiting.reduce((s, q) => s + q.total, 0))} in sent quotes awaiting a decision.`);
    if (stale.length) insights.push(`${plural(stale.length, 'opportunity')} with no activity in 30 days: ${stale.slice(0, 3).map((o) => o.customer).join(', ')}${stale.length > 3 ? '…' : ''}.`);
    if (late.length) insights.push(`${plural(late.length, 'order')} past the promised ship date (${usd(late.reduce((s, o) => s + o.total, 0))}).`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from, to: new Date().toISOString().slice(0, 10) },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Weighted pipeline', value: Math.round(weighted), type: 'currency', note: `${usd(opps.reduce((s, o) => s + o.amount, 0))} unweighted`, status: 'neutral' },
        { label: 'Quotes awaiting decision', value: awaiting.length, type: 'integer', status: 'neutral' },
        { label: 'Win rate', value: winRate, type: 'percent', note: `quotes, last ${params.days} days`, status: winRate === null ? 'neutral' : winRate >= 0.3 ? 'good' : 'watch' },
        { label: 'Booked', value: Math.round(booked), type: 'currency', note: `orders, last ${params.days} days`, status: 'neutral' },
        { label: 'Orders late to ship', value: late.length, type: 'integer', status: late.length ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'customer', label: 'Customer', type: 'text', width: 1.5 },
        { key: 'title', label: 'Opportunity', type: 'text', width: 2 },
        { key: 'stage', label: 'Stage', type: 'text', width: 0.8 },
        { key: 'amount', label: 'Amount', type: 'currency', unit: 'USD', width: 0.9 },
        { key: 'probability', label: 'Prob.', type: 'integer', unit: '%', width: 0.5 },
        { key: 'weighted', label: 'Weighted', type: 'currency', unit: 'USD', width: 0.9 },
        { key: 'expected_close', label: 'Expected close', type: 'date', width: 0.9 },
        { key: 'last_touch', label: 'Last activity', type: 'date', width: 0.9 },
        { key: 'owner', label: 'Owner', type: 'text', width: 1 },
      ],
      rows: opps,
      exceptions: opps.map((o, i) => (o.past_close || stale.includes(o) ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Weighted = amount × probability. Probabilities default by stage (lead 10%, qualified 25%, proposal 50%, negotiation 75%) and can be set per opportunity.',
        'Win rate counts quotes accepted or declined in the period; quotes revised and re-sent count once.',
        'Rows marked need attention: expected close date has passed, or no logged activity in 30 days.',
      ],
      source: 'Opportunities, activities, quotes and sales orders (live query)',
    };
  },
};
