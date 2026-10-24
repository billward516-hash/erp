import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { unbilledWork } from '../billing/service.js';
import { loadPlans } from '../retainers/service.js';
import { INTERVAL_LABEL, lastCoveredDay, mrrOn, nextInvoiceDate, pausedOn, plusDays, addMonths, amountOn } from '../retainers/schedule.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const r2 = (n: number) => Math.round(n * 100) / 100;
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Unbilled work (WIP) by project, with billed against contract for fixed-price work. */
export const billingWipReport: ReportDefinition = {
  id: 'billing-wip',
  name: 'Unbilled work and billed against contract',
  description: 'Approved billable time, expenses, reached milestones and earned fixed-price work not yet invoiced, by project, with how long it has waited and billed against contract value.',
  permission: 'billing.view',
  params: z.object({ facilityId: z.string().uuid().optional(), customerId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'billing.view', params.facilityId);
    const w = await unbilledWork(tx, actor, { facilityId: params.facilityId, customerId: params.customerId });
    const on = todayStr();
    const rows = w.rows.map((r) => ({ ...r, age_days: r.oldest ? daysBetween(r.oldest, on) : null, billed_pct: r.contractValue ? r.billedToDate / r.contractValue : null }));
    const old = rows.filter((r) => r.age_days !== null && r.age_days > 30);
    const oldValue = old.reduce((s, r) => s + r.total, 0);
    const top = rows[0];
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !w.totals.total ? 'No approved work is waiting to be billed' : `${usd(w.totals.total)} of approved work is waiting to be billed on ${plural(w.totals.projects, 'project')}${oldValue ? `; ${usd(oldValue)} of it has waited more than 30 days` : ''}`,
      kpis: [{ label: 'Unbilled work', value: Math.round(w.totals.total), type: 'currency', status: w.totals.total ? 'watch' : 'good' }, { label: 'Unbilled hours', value: w.totals.hours, type: 'hours', status: 'neutral' },
        { label: 'Waiting over 30 days', value: Math.round(oldValue), type: 'currency', status: oldValue ? 'bad' : 'good' }, { label: 'On hold', value: Math.round(w.totals.held), type: 'currency', status: w.totals.held ? 'watch' : 'neutral' },
        { label: 'Hours with no rate', value: r2(rows.reduce((s, r) => s + r.blockedHours, 0)), type: 'hours', status: w.totals.blockedItems ? 'bad' : 'good' }],
      insights: [
        ...(top && top.total ? [`Most waiting: ${top.number} ${top.name}, ${usd(top.total)}${top.customerName ? ` (${top.customerName})` : ''}.`] : []),
        ...(w.totals.blockedItems ? [`${plural(w.totals.blockedItems, 'entry')} cannot be priced because no rate applies; add a rate and they appear here.`] : []),
        ...w.excluded.map((e) => `${e.reason}: ${plural(e.entries, 'billable entry')}, ${r2(e.hours)} hours, not billed by the hour.`),
        ...(w.expenseColumns ? [] : ['Billable expenses are not included: expense lines do not yet carry a project and a billable flag.']),
      ].slice(0, 5),
      columns: [{ key: 'number', label: 'Project', type: 'text', width: 0.8 }, { key: 'name', label: 'Name', type: 'text', width: 1.5 }, { key: 'customerName', label: 'Customer', type: 'text', width: 1.3 },
        { key: 'timeHours', label: 'Hours', type: 'hours', width: 0.6 }, { key: 'timeValue', label: 'Time', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'expenseValue', label: 'Expenses', type: 'currency', unit: 'USD', width: 0.8 },
        { key: 'milestoneValue', label: 'Milestones', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'percentValue', label: 'Percent complete', type: 'currency', unit: 'USD', width: 0.9 },
        { key: 'total', label: 'Unbilled', type: 'currency', unit: 'USD', width: 0.9 }, { key: 'age_days', label: 'Oldest (days)', type: 'integer', width: 0.6 }, { key: 'heldValue', label: 'On hold', type: 'currency', unit: 'USD', width: 0.7 },
        { key: 'contractValue', label: 'Contract', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'billedToDate', label: 'Billed to date', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'billed_pct', label: 'Billed of contract', type: 'percent', width: 0.7 }],
      rows, exceptions: rows.map((r, i) => (r.age_days !== null && r.age_days > 30 ? i : -1)).filter((i) => i >= 0),
      charts: rows.some((r) => r.total) ? [{ kind: 'bars', title: 'Unbilled work by project', category: { key: 'number', label: 'Project' }, series: [{ key: 'total', label: 'Unbilled' }], valueType: 'currency', data: rows.filter((r) => r.total).slice(0, 10).map((r) => ({ number: r.number, total: r.total })) }] : [],
      drillDown: { rowKey: 'projectId', path: '/billing?tab=unbilled&project={projectId}' },
      notes: ['Unbilled work counts approved timesheet hours with billable on (at the bill rate in force on the work date), approved billable expenses, reached milestones and the earned part of percent-complete contracts, none yet on an invoice or written off.',
        'Held entries and entries with no rate are listed apart and are not in the unbilled total. Hours on fixed-price and retainer projects are covered by the contract and are not billed by the hour.',
        'Billed to date is what live (not voided) billing runs put on invoices, net of write-downs. Contract value is the fixed-price terms set on the Billing page.'],
      source: 'Timesheets, expenses, billing runs and fixed-price terms (live query)',
    };
  },
};

export const billingRunsReport: ReportDefinition = {
  id: 'billing-runs',
  name: 'Billing runs',
  description: 'Billing runs in a period: customer, project, what was invoiced, written down and written off.',
  permission: 'billing.view',
  params: z.object({ facilityId: z.string().uuid().optional(), from: z.string().date().optional(), to: z.string().date().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'billing.view', params.facilityId);
    const to = params.to ?? todayStr(), from = params.from ?? plusDays(to, -90);
    const rows = await many(tx, `SELECT r.id, r.number, f.code AS facility, c.name AS customer, p.number AS project, r.period_from, r.period_to, r.status, i.number AS invoice, u.display_name AS prepared_by, r.created_at::date AS created_on,
        coalesce((SELECT sum(k.amount) FROM billing_claim k WHERE k.run_id = r.id AND k.released_at IS NULL AND k.status = 'billed'), 0)::float AS billed,
        coalesce((SELECT sum(k.writedown) FROM billing_claim k WHERE k.run_id = r.id AND k.released_at IS NULL AND k.status = 'billed'), 0)::float AS written_down,
        coalesce((SELECT sum(k.list_amount) FROM billing_claim k WHERE k.run_id = r.id AND k.released_at IS NULL AND k.status = 'written_off'), 0)::float AS written_off,
        (SELECT count(*)::int FROM billing_claim k WHERE k.run_id = r.id AND k.released_at IS NULL) AS items
      FROM billing_run r JOIN facility f ON f.id = r.facility_id JOIN customer c ON c.id = r.customer_id LEFT JOIN project p ON p.id = r.project_id LEFT JOIN customer_invoice i ON i.id = r.invoice_id JOIN app_user u ON u.id = r.created_by
      WHERE r.facility_id = ANY ($1) AND r.created_at::date BETWEEN $2 AND $3 ORDER BY r.created_at DESC`, [scope.ids, from, to]);
    const billed = rows.reduce((s, r) => s + r.billed, 0), down = rows.reduce((s, r) => s + r.written_down, 0), off = rows.reduce((s, r) => s + r.written_off, 0);
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from, to }, scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length ? 'No billing runs in this period' : `${plural(rows.filter((r) => r.status === 'invoiced').length, 'billing run')} invoiced ${usd(billed)}${down + off ? `; ${usd(down)} written down and ${usd(off)} written off` : ', nothing written down or off'}`,
      kpis: [{ label: 'Runs', value: rows.length, type: 'integer', status: 'neutral' }, { label: 'Invoiced', value: Math.round(billed), type: 'currency', status: 'neutral' }, { label: 'Written down', value: Math.round(down), type: 'currency', status: down ? 'watch' : 'good' },
        { label: 'Written off', value: Math.round(off), type: 'currency', status: off ? 'bad' : 'good' }, { label: 'Still open', value: rows.filter((r) => r.status === 'open').length, type: 'integer', status: 'neutral' }],
      insights: [`${usd(billed + down + off)} of work was priced; ${down + off ? `${Math.round(((down + off) / (billed + down + off)) * 100)}% was written down or off` : 'all of it was billed'}.`],
      columns: [{ key: 'number', label: 'Run', type: 'text', width: 0.8 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.5 }, { key: 'project', label: 'Project', type: 'text', width: 0.8 }, { key: 'period_from', label: 'From', type: 'date', width: 0.8 },
        { key: 'period_to', label: 'To', type: 'date', width: 0.8 }, { key: 'status', label: 'Status', type: 'text', width: 0.7 }, { key: 'invoice', label: 'Invoice', type: 'text', width: 0.8 }, { key: 'items', label: 'Items', type: 'integer', width: 0.5 },
        { key: 'billed', label: 'Invoiced', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'written_down', label: 'Written down', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'written_off', label: 'Written off', type: 'currency', unit: 'USD', width: 0.8 },
        { key: 'prepared_by', label: 'Prepared by', type: 'text', width: 1 }],
      rows, exceptions: rows.map((r, i) => (r.written_off > 0 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/billing/runs/{id}' },
      notes: ['Invoiced is what the run put on its draft invoice, net of write-downs; a voided invoice releases its work and the run opens again, so it shows no invoiced amount. Write-offs stay until someone reverses them.'],
      source: 'Billing runs and the claims that stamp their work (live query)',
    };
  },
};

/** Monthly and annual recurring revenue from retainer and subscription plans, churn and renewals. */
export const recurringRevenueReport: ReportDefinition = {
  id: 'recurring-revenue',
  name: 'Recurring revenue',
  description: 'Monthly and annual recurring revenue from retainer and subscription plans, new and lost revenue over 90 days, and upcoming renewals.',
  permission: 'retainers.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'retainers.view', params.facilityId);
    const on = todayStr(), then = plusDays(on, -90);
    const plans = await loadPlans(tx, 'p.facility_id = ANY ($1)', [scope.ids]);
    let mrr = 0, mrrThen = 0, newMrr = 0, churned = 0, paused = 0;
    for (const l of plans) {
      const now = mrrOn(l.facts, on), before = mrrOn(l.facts, then);
      mrr += now; mrrThen += before;
      if (l.facts.startDate > then && l.facts.startDate <= on) newMrr += now;
      const last = lastCoveredDay(l.facts);
      if (before > 0 && last && last >= then && last < on) churned += before;
      if (pausedOn(l.facts, on) && l.facts.startDate <= on && (!last || last >= on)) paused++;
    }
    const active = plans.filter((l) => mrrOn(l.facts, on) > 0).length;
    const horizon = plusDays(on, 60);
    const rows = plans.filter((l) => {
      const last = lastCoveredDay(l.facts);
      return mrrOn(l.facts, on) > 0 || (pausedOn(l.facts, on) && (!last || last >= on)) || (last !== null && last >= then && last < on);
    }).map((l) => {
      const last = lastCoveredDay(l.facts);
      const state = l.row.status === 'paused' ? 'Paused' : last && last < on ? 'Ended' : l.row.cancel_on ? 'Ending' : 'Active';
      return { id: l.row.id, plan: l.row.number, customer: l.row.customer_name, description: l.row.description, interval: INTERVAL_LABEL[l.facts.interval], amount: amountOn(l.facts, on), mrr: r2(mrrOn(l.facts, on)), state,
        next_invoice: nextInvoiceDate(l.facts, l.charges, on), end_date: l.row.end_date, renewal: !l.row.end_date ? 'Open-ended' : l.row.auto_renew ? 'Renews automatically' : 'Ends unless renewed',
        days_to_end: l.row.end_date ? daysBetween(on, l.row.end_date) : null };
    }).sort((a, b) => b.mrr - a.mrr);
    const renewalsDue = rows.filter((r) => r.end_date && r.end_date >= on && r.end_date <= horizon && r.state !== 'Ended');
    // MRR at the end of each of the last six months, from the same arithmetic.
    const monthEnds = Array.from({ length: 6 }, (_, i) => {
      const first = `${addMonths(on, -(5 - i)).slice(0, 7)}-01`;
      return i === 5 ? on : plusDays(addMonths(first, 1), -1);
    });
    const trend = monthEnds.map((d) => ({ month: d.slice(0, 7), mrr: r2(plans.reduce((s, l) => s + mrrOn(l.facts, d), 0)) }));
    const churnRate = mrrThen > 0 ? churned / mrrThen : null;
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from: then, to: on }, scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !plans.length ? 'No retainer or subscription plans yet' : `${usd(mrr)} a month recurring (${usd(mrr * 12)} a year) from ${plural(active, 'plan')}${churned ? `; ${usd(churned)} a month lost in 90 days` : ''}${renewalsDue.length ? `; ${plural(renewalsDue.length, 'renewal')} in the next 60 days` : ''}`,
      kpis: [{ label: 'Monthly recurring revenue', value: Math.round(mrr), type: 'currency', status: 'neutral' }, { label: 'Annual recurring revenue', value: Math.round(mrr * 12), type: 'currency', status: 'neutral' },
        { label: 'New (90 days)', value: Math.round(newMrr), type: 'currency', status: 'neutral' }, { label: 'Lost (90 days)', value: Math.round(churned), type: 'currency', status: churned ? 'bad' : 'good' },
        { label: 'Churn (90 days)', value: churnRate, type: 'percent', note: 'Lost monthly revenue over monthly revenue 90 days ago', status: churnRate === null ? 'neutral' : churnRate > 0.1 ? 'bad' : churnRate > 0.03 ? 'watch' : 'good' },
        { label: 'Paused plans', value: paused, type: 'integer', status: paused ? 'watch' : 'neutral' }],
      insights: [`Monthly revenue was ${usd(mrrThen)} 90 days ago and is ${usd(mrr)} now (${usd(newMrr)} new, ${usd(churned)} lost${mrr - mrrThen - newMrr + churned ? `, ${usd(mrr - mrrThen - newMrr + churned)} from price changes, pauses and resumes` : ''}).`,
        ...(renewalsDue.length ? [`Renewals within 60 days: ${renewalsDue.slice(0, 3).map((r) => `${r.plan} ${r.customer} (${r.end_date})`).join('; ')}.`] : []), ...(paused ? [`${plural(paused, 'plan')} paused and not counted in monthly revenue.`] : [])].slice(0, 4),
      columns: [{ key: 'plan', label: 'Plan', type: 'text', width: 0.7 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.4 }, { key: 'description', label: 'For', type: 'text', width: 1.6 }, { key: 'interval', label: 'Billed', type: 'text', width: 0.6 },
        { key: 'amount', label: 'Amount', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'mrr', label: 'Monthly', type: 'currency', unit: 'USD', width: 0.8 }, { key: 'state', label: 'State', type: 'text', width: 0.6 },
        { key: 'next_invoice', label: 'Next invoice', type: 'date', width: 0.8 }, { key: 'end_date', label: 'Term ends', type: 'date', width: 0.8 }, { key: 'renewal', label: 'Renewal', type: 'text', width: 1.1 }],
      rows, exceptions: rows.map((r, i) => (r.state === 'Ended' || (r.days_to_end !== null && r.days_to_end >= 0 && r.days_to_end <= 60) ? i : -1)).filter((i) => i >= 0),
      charts: trend.some((t) => t.mrr) ? [{ kind: 'columns', title: 'Monthly recurring revenue at month end', category: { key: 'month', label: 'Month' }, series: [{ key: 'mrr', label: 'Monthly recurring revenue' }], valueType: 'currency', data: trend }] : [],
      drillDown: { rowKey: 'id', path: '/retainers/{id}' },
      notes: ['Monthly recurring revenue = each active plan’s amount in force today divided by its months (month 1, quarter 3, year 12). Annual = monthly × 12. Paused plans, plans not yet started and plans past their last day are not counted.',
        'Lost = monthly revenue 90 days ago of plans whose cancellation or term end fell in the last 90 days. Churn = lost ÷ monthly revenue 90 days ago. A pause is not churn. Amounts are as scheduled; they are not what customers have paid.'],
      source: 'Retainer plans, amount changes and pauses (live query)',
    };
  },
};
