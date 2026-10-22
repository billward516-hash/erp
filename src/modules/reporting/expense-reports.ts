import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Expense spend and the approval pipeline (D-131): by category and department, exceptions, waiting and unpaid. */
export const expenseSummaryReport: ReportDefinition = {
  id: 'expense-summary',
  name: 'Employee expenses',
  description: 'Expense spend by category and department over the period, policy exceptions approved, reports waiting for approval and approved reports not yet reimbursed.',
  permission: 'expenses.view_all',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(730).default(90) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'expenses.view_all', params.facilityId);
    const days = params.days;
    const reports = await many(tx, `SELECT r.id, r.number, r.title, r.status, r.total::float AS total, r.submitted_at, r.approved_at, f.code AS facility, coalesce(d.name, 'No department') AS department,
        u.display_name AS claimant, (SELECT count(*)::int FROM expense_line l WHERE l.report_id = r.id AND l.explanation IS NOT NULL) AS explained,
        extract(day FROM now() - r.submitted_at)::int AS waiting_days
      FROM expense_report r JOIN facility f ON f.id = r.facility_id LEFT JOIN department d ON d.id = r.department_id JOIN app_user u ON u.id = r.user_id
      WHERE r.facility_id = ANY ($1) AND r.status NOT IN ('draft', 'cancelled') AND (r.submitted_at > now() - make_interval(days => $2) OR r.status IN ('submitted', 'approved'))
      ORDER BY r.submitted_at DESC`, [scope.ids, days]);
    const spent = reports.filter((r) => ['approved', 'paid'].includes(r.status) && r.approved_at && new Date(r.approved_at).getTime() > Date.now() - days * 86_400_000);
    const byCat = await many(tx, `SELECT c.name, sum(l.amount)::float AS amount FROM expense_line l JOIN expense_report r ON r.id = l.report_id JOIN expense_category c ON c.id = l.category_id
      WHERE r.facility_id = ANY ($1) AND r.status IN ('approved', 'paid') AND r.approved_at > now() - make_interval(days => $2) GROUP BY c.name ORDER BY 2 DESC`, [scope.ids, days]);
    const total = spent.reduce((s, r) => s + r.total, 0);
    const waiting = reports.filter((r) => r.status === 'submitted');
    const unpaid = reports.filter((r) => r.status === 'approved');
    const exceptions = spent.reduce((s, r) => s + r.explained, 0);
    const byDept = new Map<string, number>();
    for (const r of spent) byDept.set(r.department, (byDept.get(r.department) ?? 0) + r.total);
    const depts = [...byDept.entries()].sort((a, b) => b[1] - a[1]);
    const headline = spent.length ? `${money(total)} of expenses approved in ${days} days${byCat[0] ? `, most on ${byCat[0].name.toLowerCase()} (${money(byCat[0].amount)})` : ''}; ${plural(waiting.length, 'report')} waiting for approval`
      : `No expenses approved in ${days} days; ${plural(waiting.length, 'report')} waiting for approval`;
    const insights: string[] = [];
    if (byCat.length > 1) insights.push(`By category: ${byCat.slice(0, 4).map((c) => `${c.name} ${money(c.amount)}`).join(', ')}.`);
    if (depts.length) insights.push(`By department: ${depts.slice(0, 4).map(([d, a]) => `${d} ${money(a)}`).join(', ')}.`);
    if (exceptions) insights.push(`${plural(exceptions, 'expense')} approved with a policy exception explained by the claimant (over a limit, missing receipt, late or a possible duplicate).`);
    const slow = waiting.filter((r) => (r.waiting_days ?? 0) > 7);
    if (slow.length) insights.push(`Waiting more than a week for approval: ${slow.map((r) => r.number).join(', ')}.`);
    if (unpaid.length) insights.push(`${plural(unpaid.length, 'approved report')} not yet reimbursed (${money(unpaid.reduce((s, r) => s + r.total, 0))}).`);
    const rows = reports.map((r) => ({ id: r.id, number: r.number, facility: r.facility, department: r.department, claimant: r.claimant, title: r.title, status: r.status,
      submitted: r.submitted_at ? new Date(r.submitted_at).toISOString().slice(0, 10) : null, total: r.total, exceptions: r.explained }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      period: { from: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: `Approved (${days} d)`, value: Math.round(total), type: 'currency', status: 'neutral' },
        { label: 'Waiting for approval', value: waiting.length, type: 'integer', status: slow.length ? 'watch' : 'neutral' },
        { label: 'Approved, not reimbursed', value: unpaid.length, type: 'integer', status: unpaid.length ? 'watch' : 'good' },
        { label: 'Policy exceptions explained', value: exceptions, type: 'integer', status: 'neutral' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'Report', type: 'text', width: 0.7 }, { key: 'facility', label: 'Site', type: 'text', width: 0.4 }, { key: 'department', label: 'Department', type: 'text', width: 0.8 },
        { key: 'claimant', label: 'Claimant', type: 'text', width: 0.8 }, { key: 'title', label: 'Title', type: 'text', width: 1.4 }, { key: 'status', label: 'Status', type: 'text', width: 0.6 },
        { key: 'submitted', label: 'Submitted', type: 'date', width: 0.6 }, { key: 'total', label: 'Total', type: 'currency', width: 0.6 }, { key: 'exceptions', label: 'Exceptions', type: 'integer', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.status === 'submitted' && (reports[i]!.waiting_days ?? 0) > 7 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/expenses/{id}' },
      notes: [
        'Approved spend counts reports approved in the period (paid or not), at the amounts claimed.',
        'Exceptions are lines the expense policy flagged (over a limit, no receipt, late, possible duplicate) that the claimant explained and the approvers accepted.',
        'Rows needing attention: reports waiting more than seven days for approval.',
      ],
      source: 'Expense reports, their lines and approvals (live query)',
    };
  },
};
