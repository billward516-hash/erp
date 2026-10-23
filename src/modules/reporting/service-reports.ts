import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

/**
 * Service performance (SC-002 F5), last 90 days: how often visits are done by their due date, how often a call-out is fixed on the
 * first visit, and what each technician did: visits, hours on site, call-outs, repairs found. These are the measures a service
 * company is judged on by its customers.
 */
export const servicePerformanceReport: ReportDefinition = {
  id: 'service-performance',
  name: 'Service performance',
  description: 'Last 90 days: visits done by their due date, call-outs fixed first time, hours on site and repairs found, by technician.',
  permission: 'fieldservice.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'fieldservice.view', params.facilityId);
    const done = await many(tx, `SELECT v.id, v.kind, v.due_on, v.completed_at::date AS done_on, e.id AS tech_id, e.first_name || ' ' || e.last_name AS tech, r.labor_hours::float AS hours, r.first_time_fix,
        jsonb_array_length(r.recommended_repairs) AS repairs, ((v.completed_at::date) <= v.due_on) AS on_time
      FROM service_visit v JOIN service_report r ON r.visit_id = v.id JOIN employee e ON e.id = v.technician_id
      WHERE v.facility_id = ANY ($1) AND v.status = 'completed' AND v.completed_at >= current_date - 90`, [scope.ids]);
    const open = await many(tx, `SELECT count(*)::int AS n, count(*) FILTER (WHERE due_on < current_date)::int AS overdue FROM service_visit WHERE facility_id = ANY ($1) AND status IN ('planned', 'scheduled', 'dispatched', 'in_progress')`, [scope.ids]);
    const sched = done.filter((d) => d.kind === 'scheduled'), calls = done.filter((d) => d.kind === 'callout' && d.first_time_fix != null);
    const onTime = pct(sched.filter((d) => d.on_time).length, sched.length), ftf = pct(calls.filter((d) => d.first_time_fix).length, calls.length);
    const by = new Map<string, { tech: string; visits: number; calls: number; hours: number; repairs: number; onTime: number; sched: number }>();
    for (const d of done) {
      const g = by.get(d.tech_id) ?? { tech: d.tech, visits: 0, calls: 0, hours: 0, repairs: 0, onTime: 0, sched: 0 };
      g.visits++; g.hours += d.hours ?? 0; g.repairs += d.repairs; if (d.kind === 'callout') g.calls++; else { g.sched++; if (d.on_time) g.onTime++; }
      by.set(d.tech_id, g);
    }
    const rows = [...by.values()].map((g) => ({ technician: g.tech, visits: g.visits, callouts: g.calls, hours: r1(g.hours), hours_per_visit: g.visits ? r1(g.hours / g.visits) : null, on_time_pct: g.sched ? Math.round((g.onTime / g.sched) * 100) : null, repairs_found: g.repairs }))
      .sort((a, b) => b.visits - a.visits);
    const o = open[0]!;
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !done.length ? 'No service visits were completed in the last 90 days' : `${plural(done.length, 'visit')} done in 90 days; ${onTime == null ? 'no scheduled visits' : `${onTime}% of scheduled visits on time`}${ftf == null ? '' : `, ${ftf}% of call-outs fixed first time`}; ${o.overdue} open visit${o.overdue === 1 ? '' : 's'} overdue`,
      kpis: [{ label: 'Visits completed', value: done.length, type: 'integer', status: 'neutral' }, { label: 'Scheduled visits on time', value: onTime, type: 'percent', status: onTime == null ? 'neutral' : onTime < 85 ? 'bad' : onTime < 95 ? 'watch' : 'good' },
        { label: 'Call-outs fixed first time', value: ftf, type: 'percent', status: ftf == null ? 'neutral' : ftf < 70 ? 'bad' : ftf < 85 ? 'watch' : 'good' }, { label: 'Open visits overdue', value: o.overdue, type: 'integer', status: o.overdue ? 'bad' : 'good' },
        { label: 'Repairs found to quote', value: done.reduce((s, d) => s + d.repairs, 0), type: 'integer', status: 'neutral' }],
      insights: [rows[0] ? `Most visits: ${rows[0].technician}, ${rows[0].visits} (${rows[0].hours} hours on site).` : 'No visits to compare yet.'],
      columns: [{ key: 'technician', label: 'Technician', type: 'text', width: 1.6 }, { key: 'visits', label: 'Visits', type: 'integer', width: 0.6 }, { key: 'callouts', label: 'Call-outs', type: 'integer', width: 0.6 }, { key: 'hours', label: 'Hours on site', type: 'number', width: 0.8 },
        { key: 'hours_per_visit', label: 'Hours per visit', type: 'number', width: 0.8 }, { key: 'on_time_pct', label: 'Scheduled on time', type: 'percent', width: 0.9 }, { key: 'repairs_found', label: 'Repairs found', type: 'integer', width: 0.7 }],
      rows: rows.map((r) => ({ ...r, on_time_pct: r.on_time_pct == null ? null : r.on_time_pct / 100 })), exceptions: [],
      notes: ['On time = completed on or before the visit’s due date. First-time fix counts call-outs where the technician marked the problem resolved on the report.'],
      source: 'Service visits and reports (live query)',
    };
  },
};

/** Contract profitability: what each agreement earned in the last 12 months against the labor and parts it consumed. */
export const serviceContractsReport: ReportDefinition = {
  id: 'service-contracts',
  name: 'Service contracts',
  description: 'Each service agreement: covered units, visits done and overdue, revenue billed in the last 12 months, labor and parts consumed, and margin.',
  permission: 'fieldservice.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'fieldservice.view', params.facilityId);
    const rows = await many(tx, `SELECT a.id, a.number, c.name AS customer, a.billing_model, a.status, a.starts_on, a.ends_on,
        (SELECT count(*)::int FROM service_plan p WHERE p.agreement_id = a.id AND p.active) AS units,
        (SELECT count(*)::int FROM service_visit v WHERE v.agreement_id = a.id AND v.status = 'completed' AND v.completed_at >= current_date - 365) AS visits,
        (SELECT count(*)::int FROM service_visit v WHERE v.agreement_id = a.id AND v.status IN ('planned', 'scheduled', 'dispatched', 'in_progress') AND v.due_on < current_date) AS overdue,
        (coalesce((SELECT sum(b.amount) FROM service_billing b WHERE b.agreement_id = a.id AND b.period >= current_date - 365), 0)
          + coalesce((SELECT sum((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = r.invoice_id)) FROM service_report r JOIN service_visit v ON v.id = r.visit_id WHERE v.agreement_id = a.id AND r.invoice_id IS NOT NULL AND r.submitted_at >= current_date - 365), 0))::float AS revenue,
        coalesce((SELECT sum(l.hours * coalesce(l.hourly_rate, 0)) FROM work_order_labor l JOIN service_visit v ON v.work_order_id = l.work_order_id WHERE v.agreement_id = a.id AND l.work_date >= current_date - 365), 0)::float AS labor_cost,
        coalesce((SELECT sum(p.qty_used * coalesce(p.unit_cost, 0)) FROM work_order_part p JOIN service_visit v ON v.work_order_id = p.work_order_id WHERE v.agreement_id = a.id AND v.completed_at >= current_date - 365), 0)::float AS parts_cost,
        coalesce((SELECT sum(l.hours) FROM work_order_labor l JOIN service_visit v ON v.work_order_id = l.work_order_id WHERE v.agreement_id = a.id AND l.work_date >= current_date - 365), 0)::float AS hours
      FROM service_agreement a JOIN customer c ON c.id = a.customer_id WHERE a.facility_id = ANY ($1) AND a.status IN ('active', 'suspended', 'ended') ORDER BY a.number`, [scope.ids]);
    const out = rows.map((r) => { const cost = r.labor_cost + r.parts_cost; return { agreement: r.number, customer: r.customer, billing: r.billing_model === 'monthly' ? 'Flat monthly' : 'Per visit', status: r.status, units: r.units, visits: r.visits, overdue: r.overdue, revenue: Math.round(r.revenue), hours: r1(r.hours), cost: Math.round(cost), margin: Math.round(r.revenue - cost), margin_pct: r.revenue ? (r.revenue - cost) / r.revenue : null }; });
    const rev = out.reduce((s, r) => s + r.revenue, 0), cost = out.reduce((s, r) => s + r.cost, 0);
    const loss = out.filter((r) => r.revenue > 0 && r.margin < 0);
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length ? 'No service agreements yet' : `${plural(rows.length, 'agreement')}: ${usd(rev)} billed in 12 months against ${usd(cost)} of recorded labor and parts${loss.length ? `; ${plural(loss.length, 'agreement')} losing money` : ''}`,
      kpis: [{ label: 'Agreements', value: rows.length, type: 'integer', status: 'neutral' }, { label: 'Billed (12 months)', value: Math.round(rev), type: 'currency', status: 'neutral' }, { label: 'Labor and parts', value: Math.round(cost), type: 'currency', status: 'neutral' },
        { label: 'Losing money', value: loss.length, type: 'integer', status: loss.length ? 'bad' : 'good' }, { label: 'Visits overdue', value: out.reduce((s, r) => s + r.overdue, 0), type: 'integer', status: out.some((r) => r.overdue) ? 'bad' : 'good' }],
      insights: [...(loss.length ? [`Losing money: ${loss.slice(0, 3).map((r) => `${r.agreement} ${r.customer} (${usd(r.margin)})`).join('; ')}.`] : ['No agreement is losing money on recorded costs.'])],
      columns: [{ key: 'agreement', label: 'Agreement', type: 'text', width: 0.9 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.5 }, { key: 'billing', label: 'Billing', type: 'text', width: 0.9 }, { key: 'units', label: 'Units', type: 'integer', width: 0.5 },
        { key: 'visits', label: 'Visits', type: 'integer', width: 0.5 }, { key: 'overdue', label: 'Overdue', type: 'integer', width: 0.6 }, { key: 'revenue', label: 'Billed', type: 'currency', unit: 'USD', width: 0.9 }, { key: 'hours', label: 'Hours', type: 'number', width: 0.6 },
        { key: 'cost', label: 'Labor and parts', type: 'currency', unit: 'USD', width: 0.9 }, { key: 'margin', label: 'Margin', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'margin_pct', label: 'Margin %', type: 'percent', width: 0.7 }],
      rows: out, exceptions: out.map((r, i) => (r.revenue > 0 && r.margin < 0) || r.overdue > 0 ? i : -1).filter((i) => i >= 0),
      notes: ['Billed = flat monthly fees plus invoiced visits in the last 12 months. Labor cost uses the hourly rate recorded on each work-order entry (blank rates count as zero); parts at the work order’s unit cost.'],
      source: 'Service agreements, billing, work orders (live query)',
    };
  },
};
