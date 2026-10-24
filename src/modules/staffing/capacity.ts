/**
 * Capacity and booking arithmetic (D-188C), kept free of the database so it can be tested on its own.
 *
 * Hours a person can work on a day = their pattern for that weekday, less the company holiday, less approved time off.
 * A week runs Monday to Sunday (the same week the timesheets use). Dates are ISO `YYYY-MM-DD` strings.
 */
export const DEFAULT_HOURS = [8, 8, 8, 8, 8, 0, 0];

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 0 = Monday ... 6 = Sunday. */
export const weekdayIndex = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
export const weekStartOf = (day: string) => addDays(day, -weekdayIndex(day));
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export const weeksFrom = (weekStart: string, count: number) => Array.from({ length: count }, (_, i) => addDays(weekStartOf(weekStart), 7 * i));

export interface PatternRow { effectiveFrom: string; hours: number[] }
export interface TimeOffRow { from: string; to: string; hoursPerDay: number | null }
/** What one person's hours depend on. `holidays` maps a date to the hours off (null: the whole scheduled day). */
export interface PersonCalendar {
  defaultHours: number[];
  patterns: PatternRow[];
  holidays: Map<string, number | null>;
  timeOff: TimeOffRow[];
}

/** The pattern in force on a date: the latest one that started on or before it, else the company default. */
export function patternOn(cal: PersonCalendar, day: string): number[] {
  let found: PatternRow | undefined;
  for (const p of cal.patterns) if (p.effectiveFrom <= day && (!found || p.effectiveFrom > found.effectiveFrom)) found = p;
  return found ? found.hours : cal.defaultHours;
}

export interface DayHours { scheduled: number; holiday: number; timeOff: number; available: number }
export function dayHours(cal: PersonCalendar, day: string): DayHours {
  const scheduled = patternOn(cal, day)[weekdayIndex(day)] ?? 0;
  let holiday = 0;
  if (cal.holidays.has(day)) { const off = cal.holidays.get(day); holiday = Math.min(scheduled, off == null ? scheduled : off); }
  const afterHoliday = scheduled - holiday;
  // Overlapping time off is not added twice: the largest claim on the day wins.
  let off = 0;
  for (const t of cal.timeOff) if (t.from <= day && day <= t.to) off = Math.max(off, Math.min(afterHoliday, t.hoursPerDay == null ? afterHoliday : t.hoursPerDay));
  return { scheduled: round2(scheduled), holiday: round2(holiday), timeOff: round2(off), available: round2(afterHoliday - off) };
}

/** Totals over an inclusive date range. */
export function rangeHours(cal: PersonCalendar, from: string, to: string): DayHours {
  const sum: DayHours = { scheduled: 0, holiday: 0, timeOff: 0, available: 0 };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const h = dayHours(cal, d);
    sum.scheduled += h.scheduled; sum.holiday += h.holiday; sum.timeOff += h.timeOff; sum.available += h.available;
  }
  return { scheduled: round2(sum.scheduled), holiday: round2(sum.holiday), timeOff: round2(sum.timeOff), available: round2(sum.available) };
}

export interface Booking { hoursPerWeek: number; start: string; end: string; state: 'tentative' | 'confirmed' }

/**
 * Hours an assignment puts on a week. The planned hours per week are spread over the days the person is scheduled to work,
 * so a booking that starts on Wednesday takes the share of the week from Wednesday on. A company holiday is not a working day
 * for anyone, so it shrinks the booking in the same proportion; personal time off does not (it stays a conflict to resolve).
 */
export function bookedInWeek(cal: PersonCalendar, b: Booking, weekStart: string): number {
  const weekEnd = addDays(weekStart, 6);
  const from = b.start > weekStart ? b.start : weekStart;
  const to = b.end < weekEnd ? b.end : weekEnd;
  if (to < from) return 0;
  const whole = rangeHours(cal, weekStart, weekEnd).scheduled;
  if (whole <= 0) return 0;
  const part = rangeHours(cal, from, to);
  return round2((b.hoursPerWeek * (part.scheduled - part.holiday)) / whole);
}

export type CellStatus = 'over' | 'full' | 'partial' | 'unbooked' | 'off';
export const STATUS_LABEL: Record<CellStatus, string> = {
  over: 'Over-allocated', full: 'Fully booked', partial: 'Part booked', unbooked: 'Unbooked', off: 'Not working',
};
export function classify(available: number, booked: number, toleranceH = 0.5): CellStatus {
  if (booked > available + toleranceH) return 'over';
  if (available <= 0 && booked <= 0) return 'off';
  if (booked <= 0) return 'unbooked';
  if (available - booked <= toleranceH) return 'full';
  return 'partial';
}

export interface WeekCell {
  weekStart: string; scheduled: number; holiday: number; timeOff: number; available: number;
  confirmed: number; tentative: number; booked: number; free: number; over: number; status: CellStatus; label: string;
}
export function weekCell(cal: PersonCalendar, bookings: Booking[], weekStart: string, toleranceH = 0.5): WeekCell {
  const h = rangeHours(cal, weekStart, addDays(weekStart, 6));
  let confirmed = 0; let tentative = 0;
  for (const b of bookings) { const x = bookedInWeek(cal, b, weekStart); if (b.state === 'confirmed') confirmed += x; else tentative += x; }
  confirmed = round2(confirmed); tentative = round2(tentative);
  const booked = round2(confirmed + tentative);
  const status = classify(h.available, booked, toleranceH);
  return { weekStart, ...h, confirmed, tentative, booked, free: round2(Math.max(0, h.available - booked)), over: round2(Math.max(0, booked - h.available)), status, label: STATUS_LABEL[status] };
}

/** Billable hours over available hours; null when there is nothing available to divide by. */
export const utilizationOf = (billable: number, available: number) => (available > 0 ? billable / available : null);

export interface TargetRow { kind: 'employee' | 'job_title'; employeeId: string | null; jobTitle: string | null; targetPct: number }
/** A person's target: their own, else their job title's (any capitalisation), else the company's. */
export function resolveTarget(person: { id: string; jobTitle: string | null }, targets: TargetRow[], companyPct: number): { pct: number; source: 'person' | 'role' | 'company' } {
  const own = targets.find((t) => t.kind === 'employee' && t.employeeId === person.id);
  if (own) return { pct: own.targetPct, source: 'person' };
  const title = person.jobTitle?.trim().toLowerCase();
  const role = title ? targets.find((t) => t.kind === 'job_title' && t.jobTitle?.trim().toLowerCase() === title) : undefined;
  if (role) return { pct: role.targetPct, source: 'role' };
  return { pct: companyPct, source: 'company' };
}
