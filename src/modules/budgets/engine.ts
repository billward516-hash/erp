/**
 * Budget arithmetic (docs/ARCHITECTURE.md §12x, D-133, D-134). Pure and deterministic: the same inputs give the same
 * proposal, allocation, reconciliation and variance. Money is kept in whole cents and rounded with the largest-remainder
 * method so parts always add up to their total.
 */
export type Months = number[]; // 12 values, fiscal month 1..12

const cents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;
export const sum = (xs: number[]) => fromCents(xs.reduce((s, x) => s + cents(x), 0));

/** Splits `total` across weights so the parts add up exactly to the total (to the cent). Equal parts when weights are all zero. */
export function allocate(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const w = weights.some((x) => x > 0) ? weights.map((x) => Math.max(0, x)) : weights.map(() => 1);
  const W = w.reduce((s, x) => s + x, 0);
  const t = cents(total);
  const raw = w.map((x) => (t * x) / W);
  const base = raw.map(Math.floor);
  let left = t - base.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; base[i]! += 1; left--; }
  return base.map(fromCents);
}

/** The share of each fiscal month in history (seasonality); flat when there is no history. */
export function seasonality(history: Months): number[] {
  const total = history.reduce((s, x) => s + Math.max(0, x), 0);
  return total > 0 ? history.map((x) => Math.max(0, x) / total) : history.map(() => 1 / 12);
}

/** An annual amount spread over the months like history, or evenly. */
export const spread = (annual: number, history?: Months) => allocate(annual, history ? seasonality(history) : Array(12).fill(1));

/** Next year's months from the last twelve months of history, changed by a percentage (inflation, volume). */
export const proposeFromHistory = (history: Months, changePct = 0) => spread(sum(history) * (1 + changePct / 100), history);

export interface HistoryStats { total: number; average: number; trailing3: number; peakMonth: number; trendPct: number | null; months: Months }
/** History of one category: total, monthly average, last-quarter run rate, peak month and the change of the second half on the first. */
export function historyStats(months: Months): HistoryStats {
  const total = sum(months);
  const h1 = sum(months.slice(0, 6)); const h2 = sum(months.slice(6));
  let peak = 0; months.forEach((m, i) => { if (m > months[peak]!) peak = i; });
  return { total, average: Math.round((total / 12) * 100) / 100, trailing3: sum(months.slice(9)) * 4, peakMonth: peak + 1, trendPct: h1 > 0 ? Math.round(((h2 - h1) / h1) * 1000) / 10 : null, months };
}

export interface Cell { facilityId: string; departmentId: string | null; categoryId: string; annual: number }
export interface Target { facilityId: string | null; departmentId: string | null; categoryId: string | null; amount: number }
export interface ReconRow { facilityId: string | null; departmentId: string | null; categoryId: string | null; target: number; bottomUp: number; gap: number; gapPct: number | null; status: 'over' | 'under' | 'ok' }

/**
 * Compares each top-down target with the bottom-up lines it covers (a target with no site, department or category
 * covers all of them). Over: bottom-up exceeds the target by more than the tolerance; under: below by more.
 */
export function reconcile(targets: Target[], cells: Cell[], tolerancePct = 2): ReconRow[] {
  return targets.map((t) => {
    const covered = cells.filter((c) => (t.facilityId == null || c.facilityId === t.facilityId) && (t.departmentId == null || c.departmentId === t.departmentId)
      && (t.categoryId == null || c.categoryId === t.categoryId));
    const bottomUp = sum(covered.map((c) => c.annual));
    const gap = fromCents(cents(bottomUp) - cents(t.amount));
    const gapPct = t.amount > 0 ? Math.round((gap / t.amount) * 1000) / 10 : null;
    const status = gapPct == null ? (bottomUp > 0 ? 'over' : 'ok') : gapPct > tolerancePct ? 'over' : gapPct < -tolerancePct ? 'under' : 'ok';
    return { facilityId: t.facilityId, departmentId: t.departmentId, categoryId: t.categoryId, target: t.amount, bottomUp, gap, gapPct, status };
  });
}

export interface Variance { budgetYtd: number; actualYtd: number; committed: number; variance: number; variancePct: number | null; budgetYear: number; forecast: number; runRate: number; status: 'over' | 'watch' | 'ok' }
/**
 * Budget against actual for the fiscal months elapsed (1..elapsed). Forecast for the year = actual to date plus the
 * budget for the months left; run rate = actual to date scaled to twelve months. Over: actual plus commitments beyond
 * the budget to date by more than 5%; watch: the forecast or run rate beyond the year's budget.
 */
export function variance(budget: Months, actual: Months, elapsed: number, committed = 0): Variance {
  const e = Math.max(0, Math.min(12, elapsed));
  const budgetYtd = sum(budget.slice(0, e)); const actualYtd = sum(actual.slice(0, e)); const budgetYear = sum(budget);
  const v = fromCents(cents(actualYtd) - cents(budgetYtd));
  const forecast = sum([actualYtd, ...budget.slice(e)]);
  const runRate = e > 0 ? Math.round((actualYtd / e) * 12 * 100) / 100 : 0;
  const pct = budgetYtd > 0 ? Math.round((v / budgetYtd) * 1000) / 10 : null;
  const status = budgetYtd > 0 && actualYtd + committed > budgetYtd * 1.05 ? 'over' : forecast > budgetYear * 1.02 || (e >= 3 && runRate > budgetYear * 1.05) ? 'watch' : 'ok';
  return { budgetYtd, actualYtd, committed, variance: v, variancePct: pct, budgetYear, forecast, runRate, status };
}

/** Fiscal month (1..12) of a date for a fiscal year starting in `startMonth`; null outside the fiscal year. */
export function fiscalMonth(date: string, fiscalYear: number, startMonth: number): number | null {
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7));
  // The fiscal year is named for the calendar year it ends in when it does not start in January.
  const startYear = startMonth === 1 ? fiscalYear : fiscalYear - 1;
  const idx = (y - startYear) * 12 + (m - startMonth);
  return idx >= 0 && idx < 12 ? idx + 1 : null;
}

/** First day of each fiscal month, as YYYY-MM-01. */
export function fiscalMonths(fiscalYear: number, startMonth: number): string[] {
  const startYear = startMonth === 1 ? fiscalYear : fiscalYear - 1;
  return Array.from({ length: 12 }, (_, i) => { const t = startMonth - 1 + i; return `${startYear + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`; });
}
