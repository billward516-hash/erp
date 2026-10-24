/**
 * Project arithmetic (SC-009 P1), kept free of the database so the rules can be tested and read in one place.
 *
 * - Hours and cost count approved timesheet hours only (the same hours a billing run may bill), so a project's figures do not move
 *   when a draft is edited. Hours waiting for approval are shown separately.
 * - A person's cost rate is the latest one whose effective date is on or before the day the work was done.
 * - The amount budget is a cost budget (labor plus expenses). Fees and rates belong to billing (slice P2).
 */
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round1 = (n: number) => Math.round(n * 10) / 10;

export interface CostRate { effective_from: string; hourly_cost: number }

/** The rate in force on a day: the latest effective date that is not after it; null when the person had no rate yet. */
export function rateInForce(rates: CostRate[], day: string): number | null {
  let best: CostRate | null = null;
  for (const r of rates) if (r.effective_from <= day && (!best || r.effective_from > best.effective_from)) best = r;
  return best ? Number(best.hourly_cost) : null;
}

/** Cost of worked hours, each at the rate in force on its own day. Hours with no rate are counted separately, never guessed. */
export function laborCost(entries: { work_date: string; hours: number }[], rates: CostRate[]) {
  let cost = 0; let unrated = 0;
  for (const e of entries) {
    const r = rateInForce(rates, e.work_date);
    if (r == null) unrated += e.hours; else cost += e.hours * r;
  }
  return { cost: round2(cost), unratedHours: round2(unrated) };
}

/** Budget against actual. `used` is the share of the budget spent (null when there is no budget); remaining may be negative. */
export function variance(budget: number | null | undefined, actual: number) {
  if (budget == null) return { budget: null, actual: round2(actual), remaining: null, used: null as number | null };
  return { budget: round2(budget), actual: round2(actual), remaining: round2(budget - actual), used: budget > 0 ? round2(actual / budget) : (actual > 0 ? null : 0) };
}

export type BudgetLevel = 'ok' | 'alert' | 'over';
/** `alert` from the company's threshold (default 90%) up to the budget; `over` once the budget is passed. */
export function budgetLevel(used: number | null, alertPct = 90): BudgetLevel {
  if (used == null) return 'ok';
  if (used > 1 + 1e-9) return 'over';
  if (used >= alertPct / 100 - 1e-9) return 'alert';
  return 'ok';
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Hours a week at the recent pace, and the day the remaining budget runs out at that pace (null when it cannot be said). */
export function burn(recentHours: number, recentDays: number, remainingHours: number | null, today: string) {
  const perWeek = recentDays > 0 ? round2((recentHours / recentDays) * 7) : 0;
  let projectedFinish: string | null = null;
  if (remainingHours != null && remainingHours > 0 && recentHours > 0) projectedFinish = addDays(today, Math.ceil(remainingHours / (recentHours / recentDays)));
  return { perWeek, projectedFinish };
}

/** Contract value: the original amount plus every approved change order (signed). */
export function contractValue(original: number | null, approvedChanges: number[]) {
  if (original == null) return approvedChanges.length ? round2(approvedChanges.reduce((s, a) => s + a, 0)) : null;
  return round2(original + approvedChanges.reduce((s, a) => s + a, 0));
}

/** A milestone's amount: its own fixed amount, else its percent of the current contract value. */
export function milestoneAmount(m: { amount: number | null; percent: number | null }, contract: number | null) {
  if (m.amount != null) return round2(m.amount);
  if (m.percent != null && contract != null) return round2((contract * m.percent) / 100);
  return null;
}

export interface Warning { code: string; level: 'watch' | 'bad'; text: string }
/** Over-budget and schedule warnings for the project page and the daily check. */
export function warnings(p: { hours: ReturnType<typeof variance>; cost: ReturnType<typeof variance> | null; alertPct: number; status: string; endDate: string | null; today: string;
  overdueMilestones: number; unratedHours: number | null }): Warning[] {
  const out: Warning[] = [];
  const h = budgetLevel(p.hours.used, p.alertPct);
  if (h === 'over') out.push({ code: 'hours_over', level: 'bad', text: `Over the hours budget by ${Math.abs(p.hours.remaining ?? 0)} h.` });
  else if (h === 'alert') out.push({ code: 'hours_alert', level: 'watch', text: `${Math.round((p.hours.used ?? 0) * 100)}% of the hours budget is used (${p.hours.remaining} h left).` });
  if (p.cost) {
    const c = budgetLevel(p.cost.used, p.alertPct);
    if (c === 'over') out.push({ code: 'cost_over', level: 'bad', text: `Over the cost budget by ${Math.abs(p.cost.remaining ?? 0)}.` });
    else if (c === 'alert') out.push({ code: 'cost_alert', level: 'watch', text: `${Math.round((p.cost.used ?? 0) * 100)}% of the cost budget is used.` });
  }
  if (p.status === 'active' && p.endDate && p.endDate < p.today) out.push({ code: 'past_end', level: 'watch', text: `The planned end date (${p.endDate}) has passed and the project is still active.` });
  if (p.overdueMilestones) out.push({ code: 'milestones_late', level: 'bad', text: `${p.overdueMilestones} milestone${p.overdueMilestones === 1 ? ' is' : 's are'} past due.` });
  if (p.unratedHours) out.push({ code: 'unrated', level: 'watch', text: `${p.unratedHours} h have no cost rate in force on the day they were worked, so they cost nothing here until a rate is set.` });
  return out;
}
