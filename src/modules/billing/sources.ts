import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { retainerItemsDue } from '../retainers/service.js';
import type { BillingSettings, RateRow } from './rates.js';
import { billedHours, money, resolveRate, roleKeyOf } from './rates.js';

/**
 * What can be billed (SC-009 a2). Every source is read here, once, so the billing run, the unbilled-work report and the reminders agree:
 *  - time: approved (or exported) timesheet hours with billable on, a project that bills time and materials, not yet claimed;
 *  - expenses: approved or paid expense lines flagged billable against a project (read through `expenseLines`, which answers nothing until
 *    the expense line has its project and billable columns);
 *  - milestones: reached fixed-price milestones not yet claimed;
 *  - percent complete: the earned part of a fixed-price contract not yet claimed;
 *  - retainer periods due and not yet charged.
 */
export type ItemKind = 'time' | 'expense' | 'milestone' | 'percent' | 'retainer';
export interface Scope { facilityIds: string[]; customerId: string | null; projectId: string | null; from: string | null; to: string | null }
export interface Item {
  key: string; kind: ItemKind;
  /** time/expense/milestone: the source row; percent: the project; retainer: the plan. */
  sourceId: string; periodStart: string | null;
  facilityId: string | null; projectId: string | null; projectNumber: string | null; projectName: string | null; taskId: string | null; taskName: string | null;
  date: string; who: string | null; note: string | null;
  recordedHours: number | null; hours: number | null;
  qty: number; unitPrice: number; listAmount: number;
  rateId: string | null; rateWhy: string | null;
  defaultDescription: string;
  held: boolean; holdReason: string | null; blocked: string | null;
  /** retainer only */
  retainerPeriodEnd?: string; retainerPlanNumber?: string;
}
export interface Excluded { reason: string; entries: number; hours: number }

const CLAIM_FREE = (kind: string, id: string) => `NOT EXISTS (SELECT 1 FROM billing_claim c WHERE c.source_kind = '${kind}' AND c.source_id = ${id} AND c.released_at IS NULL)`;

export async function timeItems(tx: Tx, s: Scope, settings: BillingSettings, rates: RateRow[]): Promise<{ items: Item[]; excluded: Excluded[] }> {
  const where = `x.billable AND ts.status IN ('approved', 'exported') AND p.facility_id = ANY ($1) AND ($2::uuid IS NULL OR p.customer_id = $2) AND ($3::uuid IS NULL OR p.id = $3)
      AND ($4::date IS NULL OR x.work_date >= $4) AND ($5::date IS NULL OR x.work_date <= $5) AND ${CLAIM_FREE('time', 'x.id')}`;
  const args = [s.facilityIds, s.customerId, s.projectId, s.from, s.to];
  const rows = await many(tx, `SELECT x.id, x.work_date, x.hours::float AS hours, x.note, p.id AS project_id, p.number AS project_number, p.name AS project_name, p.customer_id, p.facility_id,
      pt.id AS task_id, pt.name AS task_name, ts.employee_id, e.first_name || ' ' || e.last_name AS who, e.job_title, h.reason AS hold_reason
    FROM time_entry x JOIN timesheet ts ON ts.id = x.timesheet_id JOIN employee e ON e.id = ts.employee_id JOIN project p ON p.id = x.project_id
      LEFT JOIN project_task pt ON pt.id = x.project_task_id LEFT JOIN billing_hold h ON h.source_kind = 'time' AND h.source_id = x.id
    WHERE ${where} AND p.billing_type = 'time_materials' AND p.customer_id IS NOT NULL
    ORDER BY p.number, pt.sort_no NULLS FIRST, pt.name NULLS FIRST, x.work_date, e.last_name`, args);
  const items = rows.map((r): Item => {
    const rate = resolveRate(rates, { projectId: r.project_id, customerId: r.customer_id, employeeId: r.employee_id, roleKey: roleKeyOf(r.job_title), date: r.work_date });
    const hours = billedHours(r.hours, settings.roundHoursTo);
    return {
      key: `time:${r.id}`, kind: 'time', sourceId: r.id, periodStart: null, facilityId: r.facility_id, projectId: r.project_id, projectNumber: r.project_number, projectName: r.project_name,
      taskId: r.task_id, taskName: r.task_name, date: r.work_date, who: r.who, note: r.note, recordedHours: r.hours, hours, qty: hours, unitPrice: rate?.amount ?? 0,
      listAmount: rate ? money(hours * rate.amount) : 0, rateId: rate?.rateId ?? null, rateWhy: rate?.why ?? null,
      defaultDescription: `${r.project_number}${r.task_name ? ` / ${r.task_name}` : ''}: ${r.who}, ${r.work_date}${r.note ? ` - ${r.note}` : ''}`,
      held: !!r.hold_reason, holdReason: r.hold_reason ?? null, blocked: rate ? null : 'No bill rate applies. Add a rate for this project, customer, person, role or the company default.',
    };
  });
  // Hours that are flagged billable but sit on a project whose contract covers them: shown so they are not mistaken for missing work.
  const ex = await many(tx, `SELECT CASE WHEN p.billing_type = 'non_billable' THEN 'The project is non-billable' WHEN p.billing_type = 'fixed_price' THEN 'Fixed-price project: hours are covered by the contract price'
        WHEN p.billing_type = 'retainer' THEN 'Retainer project: hours are covered by the retainer' ELSE 'The project has no customer to bill' END AS reason, count(*)::int AS entries, coalesce(sum(x.hours), 0)::float AS hours
    FROM time_entry x JOIN timesheet ts ON ts.id = x.timesheet_id JOIN project p ON p.id = x.project_id
    WHERE ${where} AND NOT (p.billing_type = 'time_materials' AND p.customer_id IS NOT NULL) GROUP BY 1 ORDER BY 1`, args);
  return { items, excluded: ex };
}

/** True once expense lines carry a project and a billable flag (added with the projects module). Until then there is nothing to read. */
let expenseColumns: boolean | undefined;
export async function expenseColumnsExist(tx: Tx) {
  if (expenseColumns !== true) {
    const r = await tx.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expense_line' AND column_name IN ('project_id', 'billable')`);
    expenseColumns = r.rows[0].n === 2;
  }
  return expenseColumns;
}
/** Test hook: the answer is cached once positive; tests that add the columns reset it. */
export function forgetExpenseColumns() { expenseColumns = undefined; }

export async function expenseLines(tx: Tx, s: Scope): Promise<Item[]> {
  if (!(await expenseColumnsExist(tx))) return [];
  const rows = await many(tx, `SELECT l.id, l.spent_on, l.amount::float AS amount, l.description, l.merchant, cat.name AS category, r.number AS report_number, u.display_name AS who,
      p.id AS project_id, p.number AS project_number, p.name AS project_name, p.facility_id, h.reason AS hold_reason
    FROM expense_line l JOIN expense_report r ON r.id = l.report_id JOIN expense_category cat ON cat.id = l.category_id JOIN app_user u ON u.id = r.user_id
      JOIN project p ON p.id = l.project_id LEFT JOIN billing_hold h ON h.source_kind = 'expense' AND h.source_id = l.id
    WHERE l.billable AND r.status IN ('approved', 'paid') AND p.billing_type <> 'non_billable' AND p.customer_id IS NOT NULL AND p.facility_id = ANY ($1)
      AND ($2::uuid IS NULL OR p.customer_id = $2) AND ($3::uuid IS NULL OR p.id = $3) AND ($4::date IS NULL OR l.spent_on >= $4) AND ($5::date IS NULL OR l.spent_on <= $5)
      AND ${CLAIM_FREE('expense', 'l.id')}
    ORDER BY p.number, l.spent_on`, [s.facilityIds, s.customerId, s.projectId, s.from, s.to]);
  return rows.map((r): Item => ({
    key: `expense:${r.id}`, kind: 'expense', sourceId: r.id, periodStart: null, facilityId: r.facility_id, projectId: r.project_id, projectNumber: r.project_number, projectName: r.project_name,
    taskId: null, taskName: null, date: r.spent_on, who: r.who, note: r.description, recordedHours: null, hours: null, qty: 1, unitPrice: money(r.amount), listAmount: money(r.amount), rateId: null, rateWhy: null,
    defaultDescription: `${r.project_number} expense: ${r.category}${r.merchant ? `, ${r.merchant}` : ''}, ${r.spent_on} (${r.report_number})`,
    held: !!r.hold_reason, holdReason: r.hold_reason ?? null, blocked: null,
  }));
}

export async function milestoneItems(tx: Tx, s: Scope): Promise<Item[]> {
  const rows = await many(tx, `SELECT m.id, m.name, m.amount::float AS amount, m.reached_on, p.id AS project_id, p.number AS project_number, p.name AS project_name, p.facility_id, h.reason AS hold_reason
    FROM billing_milestone m JOIN project p ON p.id = m.project_id JOIN billing_contract c ON c.project_id = p.id AND c.method = 'milestone'
      LEFT JOIN billing_hold h ON h.source_kind = 'milestone' AND h.source_id = m.id
    WHERE m.status = 'reached' AND p.facility_id = ANY ($1) AND p.customer_id IS NOT NULL AND ($2::uuid IS NULL OR p.customer_id = $2) AND ($3::uuid IS NULL OR p.id = $3)
      AND ($4::date IS NULL OR m.reached_on <= $4) AND ${CLAIM_FREE('milestone', 'm.id')}
    ORDER BY p.number, m.sort_no`, [s.facilityIds, s.customerId, s.projectId, s.to]);
  return rows.map((r): Item => ({
    key: `milestone:${r.id}`, kind: 'milestone', sourceId: r.id, periodStart: null, facilityId: r.facility_id, projectId: r.project_id, projectNumber: r.project_number, projectName: r.project_name,
    taskId: null, taskName: null, date: r.reached_on, who: null, note: null, recordedHours: null, hours: null, qty: 1, unitPrice: money(r.amount), listAmount: money(r.amount), rateId: null, rateWhy: null,
    defaultDescription: `${r.project_number} milestone: ${r.name} (reached ${r.reached_on})`, held: !!r.hold_reason, holdReason: r.hold_reason ?? null, blocked: null,
  }));
}

/** The earned part of a percent-complete contract that no claim covers yet. */
export async function percentItems(tx: Tx, s: Scope, today: string): Promise<Item[]> {
  const rows = await many(tx, `SELECT p.id AS project_id, p.number AS project_number, p.name AS project_name, p.facility_id, c.contract_value::float AS value, c.percent_complete::float AS pct,
      coalesce((SELECT sum(k.list_amount) FROM billing_claim k WHERE k.project_id = p.id AND k.source_kind = 'percent' AND k.released_at IS NULL), 0)::float AS consumed
    FROM billing_contract c JOIN project p ON p.id = c.project_id
    WHERE c.method = 'percent_complete' AND p.facility_id = ANY ($1) AND p.customer_id IS NOT NULL AND ($2::uuid IS NULL OR p.customer_id = $2) AND ($3::uuid IS NULL OR p.id = $3)
    ORDER BY p.number`, [s.facilityIds, s.customerId, s.projectId]);
  const out: Item[] = [];
  for (const r of rows) {
    const earned = money((r.value * r.pct) / 100);
    const due = money(earned - r.consumed);
    if (due < 0.01) continue;
    out.push({
      key: `percent:${r.project_id}`, kind: 'percent', sourceId: r.project_id, periodStart: null, facilityId: r.facility_id, projectId: r.project_id, projectNumber: r.project_number, projectName: r.project_name,
      taskId: null, taskName: null, date: s.to ?? today, who: null, note: null, recordedHours: null, hours: null, qty: 1, unitPrice: due, listAmount: due, rateId: null, rateWhy: null,
      defaultDescription: `${r.project_number} ${r.project_name}: ${r.pct}% complete of ${r.value.toFixed(2)} contract${r.consumed > 0 ? `, less ${r.consumed.toFixed(2)} billed earlier` : ''}`,
      held: false, holdReason: null, blocked: null,
    });
  }
  return out;
}

const KIND_ORDER: Record<ItemKind, number> = { time: 0, expense: 1, milestone: 2, percent: 3, retainer: 4 };

export async function collect(tx: Tx, s: Scope, settings: BillingSettings, rates: RateRow[], today: string, opts: { retainers?: boolean } = {}) {
  const t = await timeItems(tx, s, settings, rates);
  const items: Item[] = [...t.items, ...(await expenseLines(tx, s)), ...(await milestoneItems(tx, s)), ...(await percentItems(tx, s, today))];
  if (opts.retainers && s.customerId) items.push(...(await retainerItemsDue(tx, { facilityIds: s.facilityIds, customerId: s.customerId, projectId: s.projectId, to: s.to ?? today })));
  // Stable: inside a project the hours keep the order the query gave them (task order, date, person); then expenses, milestones, percent, retainers.
  items.sort((a, b) => (a.projectNumber ?? '~').localeCompare(b.projectNumber ?? '~') || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return { items, excluded: t.excluded };
}
