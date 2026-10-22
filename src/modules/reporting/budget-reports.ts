import { z } from 'zod';
import { one } from '../../platform/db/tx.js';
import { budgetVsActual } from '../budgets/service.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Budget against actual for the approved budget of a fiscal year (D-133): answer first, then the lines over or heading over. */
export const budgetVsActualReport: ReportDefinition = {
  id: 'budget-vs-actual',
  name: 'Budget against actual',
  description: 'Spend to date against the approved budget by site, department and category, with open commitments, a forecast for the year and lines over or heading over budget.',
  permission: 'budgets.view',
  params: z.object({ fiscalYear: z.coerce.number().int().min(2000).max(2100).optional(), asOf: z.string().date().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const year = params.fiscalYear ?? new Date().getUTCFullYear();
    const b = await one(tx, `SELECT id FROM budget WHERE fiscal_year = $1 AND status IN ('approved', 'closed') ORDER BY status = 'approved' DESC, approved_at DESC LIMIT 1`, [year]);
    const base = { reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: [], description: 'All sites you can see' }, filters: { ...params, fiscalYear: year } };
    if (!b) {
      return { ...base, headline: `No approved budget for ${year}`, kpis: [], insights: ['Approve a budget for the year to compare spend with it.'], columns: [], rows: [], exceptions: [], notes: [],
        source: 'Budgets' } as ReportResult;
    }
    const v = await budgetVsActual(tx, actor, b.id, { asOf: params.asOf });
    const t = v.totals;
    const over = v.rows.filter((r) => r.status === 'over'); const watch = v.rows.filter((r) => r.status === 'watch'); const unbudgeted = v.rows.filter((r) => r.unbudgeted);
    const name = (r: any) => `${r.facility}${r.department ? ` ${r.department}` : ''} ${r.category.toLowerCase()}`;
    const headline = v.elapsed === 0 ? `${v.budget.name}: ${money(t.budgetYear)} budgeted; the year has not started`
      : `${money(t.actualYtd)} spent against ${money(t.budgetYtd)} budgeted to date (${t.variancePct == null ? '—' : `${t.variancePct > 0 ? '+' : ''}${t.variancePct}%`}); forecast ${money(t.forecast)} for the year against ${money(t.budgetYear)}`;
    const insights: string[] = [];
    if (over.length) insights.push(`Over budget to date: ${over.slice(0, 4).map((r) => `${name(r)} (${money(r.actualYtd + r.committed)} with commitments vs ${money(r.budgetYtd)})`).join('; ')}.`);
    if (watch.length) insights.push(`Heading over for the year: ${watch.slice(0, 4).map((r) => `${name(r)} (run rate ${money(r.runRate)} vs ${money(r.budgetYear)})`).join('; ')}.`);
    if (unbudgeted.length) insights.push(`${plural(unbudgeted.length, 'line')} with spend and no budget: ${unbudgeted.slice(0, 4).map(name).join(', ')}.`);
    if (t.committed) insights.push(`${money(t.committed)} committed on open purchase orders (non-stock), not yet spent.`);
    const rows = v.rows.map((r) => ({ facility: r.facility, department: r.department ?? '—', category: r.category, budget_year: r.budgetYear, budget_ytd: r.budgetYtd, actual_ytd: r.actualYtd,
      committed: r.committed, variance: r.variance, variance_pct: r.variancePct == null ? null : r.variancePct / 100, forecast: r.forecast, status: r.unbudgeted ? 'unbudgeted' : r.status }));
    return {
      ...base, headline, period: { from: v.months[0]!, to: v.asOf },
      kpis: [
        { label: 'Budget for the year', value: Math.round(t.budgetYear), type: 'currency', status: 'neutral' },
        { label: 'Spent to date', value: Math.round(t.actualYtd), type: 'currency', status: t.status === 'over' ? 'bad' : t.status === 'watch' ? 'watch' : 'good' },
        { label: 'Committed', value: Math.round(t.committed), type: 'currency', status: 'neutral' },
        { label: 'Forecast for the year', value: Math.round(t.forecast), type: 'currency', status: t.forecast > t.budgetYear ? 'watch' : 'good' },
        { label: 'Lines over budget', value: over.length, type: 'integer', status: over.length ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.4 }, { key: 'department', label: 'Department', type: 'text', width: 0.8 }, { key: 'category', label: 'Category', type: 'text', width: 1.2 },
        { key: 'budget_year', label: 'Budget (year)', type: 'currency', width: 0.7 }, { key: 'budget_ytd', label: 'Budget to date', type: 'currency', width: 0.7 },
        { key: 'actual_ytd', label: 'Actual to date', type: 'currency', width: 0.7 }, { key: 'committed', label: 'Committed', type: 'currency', width: 0.6 },
        { key: 'variance', label: 'Variance', type: 'currency', width: 0.6 }, { key: 'variance_pct', label: 'Variance %', type: 'percent', width: 0.5 },
        { key: 'forecast', label: 'Forecast (year)', type: 'currency', width: 0.7 }, { key: 'status', label: 'Status', type: 'text', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (['over', 'unbudgeted'].includes(r.status) ? i : -1)).filter((i) => i >= 0),
      notes: [
        `Months to date: ${v.elapsed} of 12 (the current month is still open). Forecast = actual to date plus the budget for the months left; run rate = actual to date scaled to twelve months.`,
        'Actual spend: supplier invoices (inventory purchases excluded), stock issued from storerooms at cost (to work orders as maintenance, otherwise production materials), approved expense reports and imported history. Commitments: open purchase-order lines for non-stock items.',
        'Over: actual plus commitments more than 5% beyond the budget to date. Heading over: the forecast more than 2% beyond the year\'s budget, or after three months the run rate more than 5% beyond it.',
      ],
      source: `${v.budget.name} (approved budget) and the spend records (live query)`,
    } as ReportResult;
  },
};
