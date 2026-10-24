/**
 * Retainer schedule arithmetic (pure, no database). Periods are calendar months, quarters or years. A plan that starts mid-period,
 * or ends (term end or cancellation) mid-period, is charged for the days it covers when the plan prorates (by days covered over days
 * in the period), and the full amount when it does not. A period that starts while the plan is paused is skipped and never billed later.
 * The amount of a period is the amount in force on the first day it covers; a change takes effect at a period start.
 */
export type Interval = 'month' | 'quarter' | 'year';
export const INTERVAL_MONTHS: Record<Interval, number> = { month: 1, quarter: 3, year: 12 };
export const INTERVAL_LABEL: Record<Interval, string> = { month: 'month', quarter: 'quarter', year: 'year' };

const money = (n: number) => Math.round((n + 1e-9 * Math.sign(n)) * 100) / 100;
const parts = (d: string) => [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))] as const;
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Adds whole months; a date at the end of its month stays at the end of the month, and other days are clamped to the month's length. */
export function addMonths(d: string, n: number) {
  const [y, m, day] = parts(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const eom = day === lastDayOf(y, m);
  return iso(ny, nm, eom ? lastDayOf(ny, nm) : Math.min(day, lastDayOf(ny, nm)));
}

export function periodStartOf(d: string, interval: Interval) {
  const [y, m] = parts(d);
  if (interval === 'month') return iso(y, m, 1);
  if (interval === 'quarter') return iso(y, m - ((m - 1) % 3), 1);
  return iso(y, 1, 1);
}
export const nextPeriodStart = (start: string, interval: Interval) => addMonths(start, INTERVAL_MONTHS[interval]);
export const periodEndOf = (start: string, interval: Interval) => plusDays(nextPeriodStart(start, interval), -1);

export function periodLabel(start: string, end: string, interval: Interval) {
  const [y, m] = parts(start);
  if (interval === 'month') return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
  if (interval === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return `${y}`;
}

export interface PlanFacts {
  startDate: string; endDate: string | null; cancelOn: string | null; interval: Interval; prorate: boolean;
  amounts: { effectiveFrom: string; amount: number }[];
  pauses: { from: string; to: string | null }[];
}
export interface Period {
  start: string; end: string; coveredFrom: string; coveredTo: string; amount: number; prorated: boolean; label: string;
  skipped: 'paused' | null;
}

/** The last day the plan covers: the earlier of the term end and a cancellation date. */
export function lastCoveredDay(p: Pick<PlanFacts, 'endDate' | 'cancelOn'>) {
  const ends = [p.endDate, p.cancelOn].filter((x): x is string => !!x);
  return ends.length ? ends.reduce((a, b) => (a < b ? a : b)) : null;
}
export function amountOn(p: Pick<PlanFacts, 'amounts'>, date: string) {
  const rows = p.amounts.filter((a) => a.effectiveFrom <= date).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return rows[0]?.amount ?? p.amounts.slice().sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0]?.amount ?? 0;
}
export const pausedOn = (p: Pick<PlanFacts, 'pauses'>, date: string) => p.pauses.some((x) => x.from <= date && (x.to === null || date < x.to));

/** Every period of the plan that starts on or before `asOf` (at most `limit` periods; plans are far smaller than the cap). */
export function periodsThrough(p: PlanFacts, asOf: string, limit = 600): Period[] {
  const out: Period[] = [];
  const last = lastCoveredDay(p);
  let start = periodStartOf(p.startDate, p.interval);
  for (let i = 0; i < limit && start <= asOf; i++, start = nextPeriodStart(start, p.interval)) {
    if (last && start > last) break;
    const end = periodEndOf(start, p.interval);
    const coveredFrom = start < p.startDate ? p.startDate : start;
    if (coveredFrom > asOf) break; // billing for a period begins on the first day it covers, not the first day of the calendar period
    const coveredTo = last && last < end ? last : end;
    const full = coveredFrom === start && coveredTo === end;
    const base = amountOn(p, coveredFrom);
    const days = daysBetween(coveredFrom, coveredTo) + 1, whole = daysBetween(start, end) + 1;
    const prorated = !full && p.prorate;
    out.push({ start, end, coveredFrom, coveredTo, amount: prorated ? money((base * days) / whole) : money(base), prorated, label: periodLabel(start, end, p.interval),
      skipped: pausedOn(p, start) ? 'paused' : null });
  }
  return out;
}

export interface ChargeFacts { periodStart: string; status: 'generated' | 'released' }
/** Periods that should have been charged by `asOf` and have no live charge. A period whose charge was released is due again, but only by hand. */
export function duePeriods(p: PlanFacts, charges: ChargeFacts[], asOf: string) {
  const by = new Map(charges.map((c) => [c.periodStart, c.status]));
  return periodsThrough(p, asOf).filter((x) => !x.skipped && by.get(x.start) !== 'generated').map((x) => ({ ...x, released: by.get(x.start) === 'released' }));
}

/** The next date an invoice is due: the first day covered by a period that is not skipped and not charged (may be in the past when the plan is behind). */
export function nextInvoiceDate(p: PlanFacts, charges: ChargeFacts[], today: string): string | null {
  const by = new Set(charges.map((c) => c.periodStart));
  const horizon = plusDays(today, 800);
  for (const x of periodsThrough(p, horizon)) if (!x.skipped && !by.has(x.start)) return x.coveredFrom;
  return null;
}

export const monthlyEquivalent = (amount: number, interval: Interval) => amount / INTERVAL_MONTHS[interval];

/** Monthly recurring revenue contributed on a date: zero before the start, after the last covered day, or while paused. */
export function mrrOn(p: PlanFacts, date: string) {
  const last = lastCoveredDay(p);
  if (date < p.startDate || (last && date > last) || pausedOn(p, date)) return 0;
  return monthlyEquivalent(amountOn(p, date), p.interval);
}
