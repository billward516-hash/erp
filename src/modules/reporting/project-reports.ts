import { z } from 'zod';
import { can } from '../../platform/auth/actor.js';
import { many } from '../../platform/db/tx.js';
import { billedByProject, expenseRows, groupBy, ratesOf, timeRows } from '../projects/costing.js';
import type { CostRate } from '../projects/engine.js';
import { budgetLevel, laborCost, round2, variance } from '../projects/engine.js';
import { alertPct } from '../projects/service.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Project status (SC-009 P1): each project's hours against its budget, share complete by hours, what is waiting for approval and,
 * for people who may see cost, cost, billed and margin. Cost columns exist only when the viewer may see cost at some project's site;
 * for other projects in the same report their cells are blank.
 */
export const projectStatusReport: ReportDefinition = {
  id: 'project-status',
  name: 'Project status',
  description: 'Each project: hours against budget, percent complete by hours, hours waiting for approval, overdue milestones; with cost, billed and margin for people who may see cost.',
  permission: 'projects.view',
  params: z.object({ facilityId: z.string().uuid().optional(), status: z.enum(['open', 'active', 'on_hold', 'completed', 'cancelled', 'all']).default('open'), customerId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'projects.view', params.facilityId);
    const statuses = params.status === 'all' ? ['proposed', 'active', 'on_hold', 'completed', 'cancelled'] : params.status === 'open' ? ['proposed', 'active', 'on_hold'] : [params.status];
    const projects = await many(tx, `SELECT p.id, p.facility_id, p.number, p.name, p.status, p.billing_type, p.end_date::text AS end_date, c.name AS customer, u.display_name AS owner,
        p.hours_budget::float AS hours_budget, p.amount_budget::float AS amount_budget,
        (SELECT sum(t.hours_budget)::float FROM project_task t WHERE t.project_id = p.id) AS task_hours, (SELECT sum(t.amount_budget)::float FROM project_task t WHERE t.project_id = p.id) AS task_amount,
        (SELECT count(*)::int FROM project_milestone m WHERE m.project_id = p.id AND m.status = 'planned' AND m.due_date < current_date) AS late_milestones
      FROM project p LEFT JOIN customer c ON c.id = p.customer_id LEFT JOIN app_user u ON u.id = p.owner_user_id
      WHERE p.facility_id = ANY ($1) AND p.status = ANY ($2) AND ($3::uuid IS NULL OR p.customer_id = $3) ORDER BY p.number`, [scope.ids, statuses, params.customerId ?? null]);
    const ids = projects.map((p) => p.id);
    const time = await timeRows(tx, ids);
    const seeAny = projects.some((p) => can(actor, 'projects.see_cost', p.facility_id));
    const costIds = projects.filter((p) => can(actor, 'projects.see_cost', p.facility_id)).map((p) => p.id);
    const expenses = await expenseRows(tx, costIds);
    const approvedOf = (id: string) => time.filter((t) => t.project_id === id && t.approved);
    const rates = await ratesOf(tx, seeAny ? [...new Set(time.filter((t) => costIds.includes(t.project_id) && t.approved).map((t) => t.employee_id))] : []);
    const billed = seeAny ? await billedByProject(tx, costIds) : new Map<string, number>();
    const alert = await alertPct(tx);
    const rows = projects.map((p) => {
      const budget = p.hours_budget ?? p.task_hours;
      const actual = sum(approvedOf(p.id).map((t) => t.hours));
      const v = variance(budget, actual);
      const row: Record<string, unknown> = { project: `${p.number} ${p.name}`, id: p.id, customer: p.customer ?? 'Internal', status: p.status.replace('_', ' '), owner: p.owner, budget_hours: v.budget, actual_hours: actual,
        waiting_hours: sum(time.filter((t) => t.project_id === p.id && !t.approved).map((t) => t.hours)), complete: v.used, late_milestones: p.late_milestones, level: budgetLevel(v.used, alert) };
      if (seeAny) {
        if (can(actor, 'projects.see_cost', p.facility_id)) {
          let labor = 0;
          for (const [emp, es] of groupBy(approvedOf(p.id), (t) => t.employee_id)) labor += laborCost(es, rates.get(emp) ?? ([] as CostRate[])).cost;
          const cost = round2(labor + sum(expenses.filter((e) => e.project_id === p.id).map((e) => e.amount)));
          const b = billed.get(p.id) ?? 0;
          Object.assign(row, { cost, billed: b, margin: round2(b - cost), margin_pct: b ? round2((b - cost) / b) : null, cost_budget: p.amount_budget ?? p.task_amount });
        } else Object.assign(row, { cost: null, billed: null, margin: null, margin_pct: null, cost_budget: null });
      }
      return row;
    });
    const over = rows.filter((r) => r.level === 'over'); const near = rows.filter((r) => r.level === 'alert');
    const totalActual = sum(rows.map((r) => r.actual_hours as number)); const totalBudget = sum(rows.filter((r) => r.budget_hours != null).map((r) => r.budget_hours as number));
    const cols: ReportResult['columns'] = [
      { key: 'project', label: 'Project', type: 'text', width: 2 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.3 }, { key: 'status', label: 'Status', type: 'text', width: 0.8 },
      { key: 'owner', label: 'Owner', type: 'text', width: 1 }, { key: 'budget_hours', label: 'Budget hours', type: 'hours', width: 0.8 }, { key: 'actual_hours', label: 'Actual hours', type: 'hours', width: 0.8 },
      { key: 'complete', label: 'Complete by hours', type: 'percent', width: 0.8 }, { key: 'waiting_hours', label: 'Waiting approval', type: 'hours', width: 0.8 }, { key: 'late_milestones', label: 'Late milestones', type: 'integer', width: 0.7 },
    ];
    if (seeAny) cols.push({ key: 'cost', label: 'Cost', type: 'currency', unit: 'USD', width: 0.9 }, { key: 'billed', label: 'Billed', type: 'currency', unit: 'USD', width: 0.9 },
      { key: 'margin', label: 'Margin', type: 'currency', unit: 'USD', width: 0.9 }, { key: 'margin_pct', label: 'Margin %', type: 'percent', width: 0.7 });
    const loss = seeAny ? rows.filter((r) => typeof r.billed === 'number' && (r.billed as number) > 0 && (r.margin as number) < 0) : [];
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length ? 'No projects in scope' : `${plural(rows.length, 'project')}: ${totalActual} h booked${totalBudget ? ` against ${totalBudget} h budgeted` : ''}; ${over.length ? `${over.length} over the hours budget` : 'none over the hours budget'}${near.length ? `, ${near.length} near it` : ''}`,
      kpis: [{ label: 'Projects', value: rows.length, type: 'integer', status: 'neutral' }, { label: 'Hours booked (approved)', value: totalActual, type: 'hours', status: 'neutral' },
        { label: 'Over hours budget', value: over.length, type: 'integer', status: over.length ? 'bad' : 'good' }, { label: `At ${alert}% of budget or more`, value: near.length, type: 'integer', status: near.length ? 'watch' : 'good' },
        { label: 'Overdue milestones', value: sum(rows.map((r) => r.late_milestones as number)), type: 'integer', status: rows.some((r) => r.late_milestones) ? 'bad' : 'good' },
        ...(seeAny ? [{ label: 'Cost to date', value: sum(rows.map((r) => (r.cost as number | null) ?? 0)), type: 'currency' as const, status: 'neutral' as const }] : [])],
      insights: [
        ...(over.length ? [`Over the hours budget: ${over.slice(0, 3).map((r) => String(r.project)).join('; ')}.`] : []),
        ...(near.length ? [`Close to the budget (${alert}% or more used): ${near.slice(0, 3).map((r) => String(r.project)).join('; ')}.`] : []),
        ...(loss.length ? [`Billed less than they cost so far: ${loss.slice(0, 3).map((r) => `${String(r.project)} (${usd(r.margin as number)})`).join('; ')}.`] : []),
      ],
      columns: cols, rows, exceptions: rows.map((r, i) => (r.level !== 'ok' || (r.late_milestones as number) > 0 ? i : -1)).filter((i) => i >= 0),
      notes: ['Hours are approved timesheet hours; hours still waiting for approval are shown separately. Complete by hours = actual ÷ budget hours (the project budget, or the sum of its task budgets); over 100% means over budget.',
        ...(seeAny ? ['Cost = approved hours at the cost rate in force on the day worked, plus approved and paid expenses named for the project. Billed = issued invoice lines tied to the project (zero until billing runs are in use). Margin = billed − cost, so a project not yet billed shows a negative margin.'] : []),
        `The alert share is ${alert}% of the hours budget (changed on the Projects page).`],
      source: 'Projects, timesheets, expenses and invoices (live query)', drillDown: { rowKey: 'id', path: '/api/projects/{id}' },
    };
  },
};

/** Project time (SC-009 P1): hours by person, task, project, week or month, with the billable share. Never shows cost. */
export const projectTimeReport: ReportDefinition = {
  id: 'project-time',
  name: 'Project time',
  description: 'Hours booked to projects by person, task, project or period, and how much of it is billable. Hours only; no cost.',
  permission: 'projects.view',
  params: z.object({ facilityId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), from: z.string().date().optional(), to: z.string().date().optional(),
    by: z.enum(['person', 'task', 'project', 'week', 'month']).default('person') }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'projects.view', params.facilityId);
    const to = params.to ?? today();
    const from = params.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
    const projects = await many(tx, `SELECT p.id, p.number, p.name FROM project p WHERE p.facility_id = ANY ($1) AND ($2::uuid IS NULL OR p.id = $2)`, [scope.ids, params.projectId ?? null]);
    const rows = await timeRows(tx, projects.map((p) => p.id), { from, to });
    const tasks = new Map((await many(tx, `SELECT id, name FROM project_task WHERE project_id = ANY ($1)`, [projects.map((p) => p.id)])).map((t) => [t.id as string, t.name as string]));
    const pname = new Map(projects.map((p) => [p.id as string, `${p.number} ${p.name}`]));
    const weekOf = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10); };
    const keyOf = (r: (typeof rows)[number]) => params.by === 'person' ? r.employee_name : params.by === 'task' ? (r.project_task_id ? `${pname.get(r.project_id)}: ${tasks.get(r.project_task_id)}` : `${pname.get(r.project_id)}: not on a task`)
      : params.by === 'project' ? pname.get(r.project_id)! : params.by === 'week' ? weekOf(r.work_date) : r.work_date.slice(0, 7);
    const out = [...groupBy(rows, keyOf)].map(([k, rs]) => {
      const a = rs.filter((r) => r.approved);
      const hours = sum(a.map((r) => r.hours)); const bill = sum(a.filter((r) => r.billable).map((r) => r.hours));
      return { group: k, hours, billable_hours: bill, non_billable_hours: round2(hours - bill), billable_share: hours ? round2(bill / hours) : null, waiting_hours: sum(rs.filter((r) => !r.approved).map((r) => r.hours)) };
    }).sort((a, b) => (params.by === 'week' || params.by === 'month' ? (a.group < b.group ? -1 : 1) : b.hours - a.hours));
    const hours = sum(out.map((r) => r.hours)); const bill = sum(out.map((r) => r.billable_hours));
    const label = ({ person: 'Person', task: 'Task', project: 'Project', week: 'Week of', month: 'Month' } as Record<string, string>)[params.by]!;
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from, to }, scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !out.length ? 'No project hours in this period' : `${hours} approved hours on projects, ${hours ? Math.round((bill / hours) * 100) : 0}% billable${sum(out.map((r) => r.waiting_hours)) ? `; ${sum(out.map((r) => r.waiting_hours))} h still waiting for approval` : ''}`,
      kpis: [{ label: 'Hours (approved)', value: hours, type: 'hours', status: 'neutral' }, { label: 'Billable hours', value: bill, type: 'hours', status: 'neutral' },
        { label: 'Billable share', value: hours ? round2(bill / hours) : null, type: 'percent', status: 'neutral' }, { label: 'Waiting for approval', value: sum(out.map((r) => r.waiting_hours)), type: 'hours', status: 'neutral' }],
      insights: out[0] && params.by !== 'week' && params.by !== 'month' ? [`Most hours: ${out[0].group}, ${out[0].hours} h.`] : [],
      columns: [{ key: 'group', label, type: 'text', width: 2.2 }, { key: 'hours', label: 'Hours', type: 'hours', width: 0.8 }, { key: 'billable_hours', label: 'Billable', type: 'hours', width: 0.8 },
        { key: 'non_billable_hours', label: 'Non-billable', type: 'hours', width: 0.8 }, { key: 'billable_share', label: 'Billable share', type: 'percent', width: 0.8 }, { key: 'waiting_hours', label: 'Waiting approval', type: 'hours', width: 0.8 }],
      rows: out, exceptions: [],
      notes: ['Hours are by the day worked. Approved hours count; hours on submitted, draft or sent-back timesheets are shown separately. Billable follows the flag set when the hours were booked.'],
      source: 'Timesheets (live query)',
      ...(out.length && (params.by === 'week' || params.by === 'month') ? { charts: [{ kind: 'columns' as const, title: 'Hours by period', category: { key: 'group', label }, series: [{ key: 'billable_hours', label: 'Billable' }, { key: 'non_billable_hours', label: 'Non-billable' }], valueType: 'hours' as const, data: out }] } : {}),
    };
  },
};
