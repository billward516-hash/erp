import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';
import type { CostRate } from './engine.js';
import { burn, contractValue, laborCost, rateInForce, round1, round2, variance, warnings } from './engine.js';
import { alertPct, canSeeCost, loadProject, today } from './service.js';

/**
 * Cost rates and project costing (SC-009 P1). Cost rates are readable and editable only with `projects.see_cost`, checked per
 * employee site. Every figure that derives from a rate (cost, margin, budget in money) is built here only when the caller may
 * see cost; otherwise the field is absent from the response, not hidden by the screen.
 */

// ---------------------------------------------------------------------------
// Cost rates
// ---------------------------------------------------------------------------

export async function listCostRates(tx: Tx, actor: Actor, employeeId?: string) {
  requirePermission(actor, 'projects.see_cost');
  const rows = await many(tx, `SELECT r.id, r.employee_id, e.employee_number, e.first_name || ' ' || e.last_name AS employee_name, e.facility_id, r.effective_from::text AS effective_from,
      r.hourly_cost::float AS hourly_cost, u.display_name AS set_by, r.created_at
    FROM employee_cost_rate r JOIN employee e ON e.id = r.employee_id JOIN app_user u ON u.id = r.created_by
    WHERE ($1::uuid IS NULL OR r.employee_id = $1) ORDER BY e.last_name, e.first_name, r.effective_from DESC`, [employeeId ?? null]);
  return rows.filter((r) => can(actor, 'projects.see_cost', r.facility_id));
}

/** Everyone active with the rate in force today (or none), for the cost-rate screen. */
export async function costRateOverview(tx: Tx, actor: Actor) {
  requirePermission(actor, 'projects.see_cost');
  const rows = await many(tx, `SELECT e.id AS employee_id, e.employee_number, e.first_name || ' ' || e.last_name AS name, e.job_title, e.facility_id, f.code AS facility_code,
      (SELECT r.hourly_cost::float FROM employee_cost_rate r WHERE r.employee_id = e.id AND r.effective_from <= current_date ORDER BY r.effective_from DESC LIMIT 1) AS current_rate,
      (SELECT r.effective_from::text FROM employee_cost_rate r WHERE r.employee_id = e.id AND r.effective_from <= current_date ORDER BY r.effective_from DESC LIMIT 1) AS since,
      (SELECT min(r.effective_from)::text FROM employee_cost_rate r WHERE r.employee_id = e.id AND r.effective_from > current_date) AS next_change
    FROM employee e LEFT JOIN facility f ON f.id = e.facility_id WHERE e.status = 'active' ORDER BY e.last_name, e.first_name`);
  return rows.filter((r) => can(actor, 'projects.see_cost', r.facility_id));
}

export async function setCostRate(tx: Tx, actor: Actor, input: { employeeId: string; effectiveFrom: string; hourlyCost: number }) {
  const e = await one(tx, 'SELECT id, facility_id FROM employee WHERE id = $1', [input.employeeId]);
  if (!e) throw notFound('employee');
  requirePermission(actor, 'projects.see_cost', e.facility_id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw invalid('the effective date looks like 2027-01-01');
  if (!Number.isFinite(input.hourlyCost) || input.hourlyCost < 0 || input.hourlyCost > 100_000) throw invalid('the hourly cost is zero or more');
  const prior = await one(tx, 'SELECT hourly_cost::float AS hourly_cost FROM employee_cost_rate WHERE employee_id = $1 AND effective_from = $2', [input.employeeId, input.effectiveFrom]);
  const r = await one(tx, `INSERT INTO employee_cost_rate (tenant_id, employee_id, effective_from, hourly_cost, created_by) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (employee_id, effective_from) DO UPDATE SET hourly_cost = EXCLUDED.hourly_cost, created_by = EXCLUDED.created_by, created_at = now() RETURNING id`,
  [actor.tenantId, input.employeeId, input.effectiveFrom, round2(input.hourlyCost), actor.userId]);
  // The audit trail is readable by more people than may see cost, so it records that a rate was set, not the figure.
  await audit(tx, actor, { action: 'projects.cost_rate_set', entityType: 'employee_cost_rate', entityId: r.id, facilityId: e.facility_id, data: { employeeId: input.employeeId, effectiveFrom: input.effectiveFrom, replaced: !!prior } });
  return one(tx, `SELECT id, employee_id, effective_from::text AS effective_from, hourly_cost::float AS hourly_cost FROM employee_cost_rate WHERE id = $1`, [r.id]);
}

/** Rates by employee, for the people whose hours are being costed. */
export async function ratesOf(tx: Tx, employeeIds: string[]) {
  const map = new Map<string, CostRate[]>();
  if (!employeeIds.length) return map;
  for (const r of await many(tx, `SELECT employee_id, effective_from::text AS effective_from, hourly_cost::float AS hourly_cost FROM employee_cost_rate WHERE employee_id = ANY ($1)`, [employeeIds])) {
    (map.get(r.employee_id) ?? map.set(r.employee_id, []).get(r.employee_id)!).push({ effective_from: r.effective_from, hourly_cost: r.hourly_cost });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Raw material for figures
// ---------------------------------------------------------------------------

export interface TimeRow { project_id: string; project_task_id: string | null; billable: boolean; employee_id: string; employee_name: string; work_date: string; hours: number; approved: boolean }

/** Time booked to projects: approved hours count as actual, the rest (draft, submitted, sent back) as waiting. */
export async function timeRows(tx: Tx, projectIds: string[], range: { from?: string; to?: string } = {}): Promise<TimeRow[]> {
  if (!projectIds.length) return [];
  return many(tx, `SELECT x.project_id, x.project_task_id, x.billable, t.employee_id, e.first_name || ' ' || e.last_name AS employee_name, x.work_date::text AS work_date, x.hours::float AS hours,
      (t.status IN ('approved', 'exported')) AS approved
    FROM time_entry x JOIN timesheet t ON t.id = x.timesheet_id JOIN employee e ON e.id = t.employee_id
    WHERE x.project_id = ANY ($1) AND ($2::date IS NULL OR x.work_date >= $2) AND ($3::date IS NULL OR x.work_date <= $3)`, [projectIds, range.from ?? null, range.to ?? null]);
}

/** Approved and paid expense lines named for a project. */
export async function expenseRows(tx: Tx, projectIds: string[]) {
  if (!projectIds.length) return [];
  return many(tx, `SELECT l.project_id, l.amount::float AS amount, l.billable, l.spent_on::text AS spent_on
    FROM expense_line l JOIN expense_report r ON r.id = l.report_id WHERE l.project_id = ANY ($1) AND r.status IN ('approved', 'paid')`, [projectIds]);
}

let billedColumn: { at: number; has: boolean } | null = null;
/**
 * Amounts invoiced to the project. Slice P2 may add `project_id` to invoice lines; until that column exists this is 0. Read defensively
 * because P2 owns the column: nothing here creates it.
 */
export async function billedByProject(tx: Tx, projectIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!projectIds.length) return out;
  if (!billedColumn || Date.now() - billedColumn.at > 60_000) {
    billedColumn = { at: Date.now(), has: !!(await one(tx, `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customer_invoice_line' AND column_name = 'project_id'`)) };
  }
  if (!billedColumn.has) return out;
  for (const r of await many(tx, `SELECT l.project_id, sum(l.qty * l.unit_price)::float AS amount FROM customer_invoice_line l JOIN customer_invoice i ON i.id = l.invoice_id
      WHERE l.project_id = ANY ($1) AND i.status IN ('issued', 'partially_paid', 'paid') GROUP BY l.project_id`, [projectIds])) out.set(r.project_id, round2(r.amount));
  return out;
}

const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));

// ---------------------------------------------------------------------------
// The project's figures
// ---------------------------------------------------------------------------

/**
 * Budget against actual, cost, billed, margin, burn and warnings for one project. Without `projects.see_cost` the cost, margin and money
 * budget fields are not in the response at all.
 */
export async function getProjectFigures(tx: Tx, actor: Actor, id: string) {
  const p = await loadProject(tx, actor, id);
  const cost = canSeeCost(actor, p.facility_id);
  const now = today();
  const tasks = await many(tx, `SELECT id, sort_no, name, billable, active, hours_budget::float AS hours_budget, amount_budget::float AS amount_budget FROM project_task WHERE project_id = $1 ORDER BY sort_no, name`, [id]);
  const rows = await timeRows(tx, [id]);
  const approved = rows.filter((r) => r.approved);
  const waiting = rows.filter((r) => !r.approved);
  const expenses = cost ? await expenseRows(tx, [id]) : [];
  const rates = cost ? await ratesOf(tx, [...new Set(approved.map((r) => r.employee_id))]) : new Map<string, CostRate[]>();
  const costOf = (rs: TimeRow[]) => {
    let c = 0; let unrated = 0;
    for (const [emp, es] of groupBy(rs, (r) => r.employee_id)) { const l = laborCost(es, rates.get(emp) ?? []); c += l.cost; unrated += l.unratedHours; }
    return { cost: round2(c), unrated: round2(unrated) };
  };

  const taskSumHours = tasks.some((t) => t.hours_budget != null) ? sum(tasks.map((t) => t.hours_budget ?? 0)) : null;
  const taskSumAmount = tasks.some((t) => t.amount_budget != null) ? sum(tasks.map((t) => t.amount_budget ?? 0)) : null;
  const hoursBudget = p.hours_budget ?? taskSumHours;
  const amountBudget = p.amount_budget ?? taskSumAmount;
  const actualHours = sum(approved.map((r) => r.hours));
  const hours = variance(hoursBudget, actualHours);

  const taskRows = tasks.map((t) => {
    const mine = approved.filter((r) => r.project_task_id === t.id);
    const row: Record<string, unknown> = { id: t.id, name: t.name, billable: t.billable, active: t.active, hours: variance(t.hours_budget, sum(mine.map((r) => r.hours))), waitingHours: sum(waiting.filter((r) => r.project_task_id === t.id).map((r) => r.hours)) };
    if (cost) { const c = costOf(mine); row.cost = variance(t.amount_budget, c.cost); row.unratedHours = c.unrated; }
    return row;
  });
  const noTask = approved.filter((r) => !r.project_task_id);
  if (noTask.length || waiting.some((r) => !r.project_task_id)) {
    const row: Record<string, unknown> = { id: null, name: 'Not on a task', billable: null, active: true, hours: variance(null, sum(noTask.map((r) => r.hours))), waitingHours: sum(waiting.filter((r) => !r.project_task_id).map((r) => r.hours)) };
    if (cost) { const c = costOf(noTask); row.cost = variance(null, c.cost); row.unratedHours = c.unrated; }
    taskRows.push(row);
  }

  const byPerson = [...groupBy(approved, (r) => r.employee_id)].map(([emp, rs]) => ({ employeeId: emp, name: rs[0]!.employee_name, hours: sum(rs.map((r) => r.hours)), billableHours: sum(rs.filter((r) => r.billable).map((r) => r.hours)) }))
    .sort((a, b) => b.hours - a.hours);
  const billableHours = sum(approved.filter((r) => r.billable).map((r) => r.hours));

  const recentFrom = new Date(Date.parse(`${now}T00:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10);
  const recent = sum(approved.filter((r) => r.work_date >= recentFrom && r.work_date <= now).map((r) => r.hours));
  const pace = burn(recent, 28, hours.remaining, now);

  const billed = (await billedByProject(tx, [id])).get(id) ?? 0;
  const approvedChanges = await many(tx, `SELECT amount::float AS amount FROM project_change_order WHERE project_id = $1 AND status = 'approved'`, [id]);
  const contract = p.billing_type === 'fixed_price' ? contractValue(p.contract_amount, approvedChanges.map((c) => c.amount)) : null;
  const overdueMilestones = (await one(tx, `SELECT count(*)::int AS n FROM project_milestone WHERE project_id = $1 AND status = 'planned' AND due_date < current_date`, [id]))!.n as number;

  const out: Record<string, unknown> = {
    projectId: id, number: p.number, status: p.status, billingType: p.billing_type, hours: { ...hours, waiting: sum(waiting.map((r) => r.hours)), billable: billableHours,
      nonBillable: round2(actualHours - billableHours), billableShare: actualHours ? round2(billableHours / actualHours) : null },
    tasks: taskRows, people: byPerson, burn: { hoursPerWeek: pace.perWeek, projectedFinish: pace.projectedFinish, basis: 'approved hours in the last 28 days' },
    contractValue: contract, billed, canSeeCost: cost, asOf: now,
  };
  let costFig: ReturnType<typeof variance> | null = null; let unrated: number | null = null;
  if (cost) {
    const labor = costOf(approved);
    const exp = sum(expenses.map((e) => e.amount));
    const total = round2(labor.cost + exp);
    costFig = variance(amountBudget, total);
    unrated = labor.unrated;
    const margin = round2(billed - total);
    out.cost = { labor: labor.cost, expenses: exp, billableExpenses: sum(expenses.filter((e) => e.billable).map((e) => e.amount)), total, unratedHours: labor.unrated, budget: costFig };
    out.margin = { amount: margin, pct: billed ? round2(margin / billed) : null, basis: 'billed to date less cost to date' };
    if (contract != null) {
      // Fixed price: what the project would earn if it finishes at the cost pace implied by hours used (only meaningful once some hours are used).
      const usedShare = hours.used;
      const projectedCost = usedShare && usedShare > 0 ? round2(total / usedShare) : null;
      out.projectedMargin = projectedCost == null ? null : { cost: projectedCost, amount: round2(contract - projectedCost), pct: contract ? round2((contract - projectedCost) / contract) : null, basis: 'contract value less cost projected to the full hours budget' };
    }
  }
  const alert = await alertPct(tx);
  out.alertPct = alert;
  out.warnings = warnings({ hours, cost: costFig, alertPct: alert, status: p.status, endDate: p.end_date, today: now, overdueMilestones, unratedHours: unrated });
  return out;
}

function groupBy<T>(xs: T[], key: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
  return m;
}
export { groupBy, round1 };
/** Tests add the invoice-line column the way slice P2 will; this forgets the cached answer. */
export const forgetBilledColumn = () => { billedColumn = null; };
