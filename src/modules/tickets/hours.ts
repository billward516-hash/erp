/**
 * Business-hours arithmetic for ticket service levels (SC-009 P4). Pure functions, no database: a calendar names a time zone, the hours
 * the business is open on each weekday and the days it is closed. "Business minutes" are minutes inside those hours on open days.
 *
 * Each day has at most one window ("09:00" to "17:00", or to "24:00" for an evening that runs to midnight). A day that is a holiday,
 * or has no window, counts as closed. Windows are measured as real elapsed time, so a window that spans a daylight-saving change is one
 * hour shorter or longer that day.
 */
export type DayWindow = [start: string, end: string] | null;
export interface BusinessCalendar {
  timeZone: string;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  days: Record<number, DayWindow>;
  /** Closed dates, 'YYYY-MM-DD' in the calendar's own time zone. */
  holidays: ReadonlySet<string>;
}

const MIN = 60_000;
/** Stops a calendar with no open day (or one only closed by holidays) from looping forever. */
const MAX_EMPTY_DAYS = 800;

export const DEFAULT_DAYS: Record<number, DayWindow> = { 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'], 4: ['09:00', '17:00'], 5: ['09:00', '17:00'], 6: null, 7: null };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}
export function isTimeZone(tz: string) {
  try { formatter(tz); return true; } catch { return false; }
}

function localParts(tz: string, ms: number) {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
/** Offset of the zone from UTC at an instant, in ms (positive east of Greenwich). */
function offsetMs(tz: string, ms: number) {
  const p = localParts(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** The calendar date in the zone at an instant. */
export function localDate(tz: string, ms: number) {
  const p = localParts(tz, ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
export function addDaysYmd(ymd: string, n: number) {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date. */
export function isoWeekday(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}
/** The instant a wall-clock time (minutes after midnight, up to 1440) happens on a date in the zone. */
export function zonedInstant(tz: string, ymd: string, minutes: number) {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + minutes * MIN;
  const first = wall - offsetMs(tz, wall);
  return wall - offsetMs(tz, first);
}
const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number) as [number, number]; return h * 60 + m; };

/** The open window on a date as instants, or null when closed. */
export function windowOn(cal: BusinessCalendar, ymd: string): [number, number] | null {
  if (cal.holidays.has(ymd)) return null;
  const w = cal.days[isoWeekday(ymd)];
  if (!w) return null;
  const open = zonedInstant(cal.timeZone, ymd, toMinutes(w[0]));
  const close = zonedInstant(cal.timeZone, ymd, toMinutes(w[1]));
  return close > open ? [open, close] : null;
}

/** Open windows in order from the date of `ms` forward (or, when `backward`, from that date back). Ends only by the caller stopping. */
function* windows(cal: BusinessCalendar, ms: number, backward: boolean): Generator<[number, number]> {
  let day = localDate(cal.timeZone, ms);
  let empty = 0;
  for (;;) {
    const w = windowOn(cal, day);
    if (w) { empty = 0; yield w; } else if (++empty > MAX_EMPTY_DAYS) throw new Error('the business-hours calendar has no open day');
    day = addDaysYmd(day, backward ? -1 : 1);
  }
}

/** Business minutes between two instants (zero when the end is not after the start). */
export function businessMinutesBetween(cal: BusinessCalendar, from: Date | number, to: Date | number): number {
  const a = +from; const b = +to;
  if (!(b > a)) return 0;
  let total = 0;
  for (const [open, close] of windows(cal, a, false)) {
    if (open >= b) break;
    const s = Math.max(open, a); const e = Math.min(close, b);
    if (e > s) total += (e - s) / MIN;
  }
  return total;
}

/**
 * The instant that is `minutes` business minutes after `from` (before it, for a negative number). Starting outside business hours,
 * counting begins when the business next opens (or, going back, when it last closed).
 */
export function addBusinessMinutes(cal: BusinessCalendar, from: Date | number, minutes: number): Date {
  const start = +from;
  if (minutes === 0) return new Date(start);
  if (minutes > 0) {
    let left = minutes;
    for (const [open, close] of windows(cal, start, false)) {
      const s = Math.max(open, start);
      if (close <= s) continue;
      const room = (close - s) / MIN;
      if (left <= room) return new Date(s + left * MIN);
      left -= room;
    }
    throw new Error('unreachable');
  }
  let left = -minutes;
  for (const [open, close] of windows(cal, start, true)) {
    const e = Math.min(close, start);
    if (open >= e) continue;
    const room = (e - open) / MIN;
    if (left <= room) return new Date(e - left * MIN);
    left -= room;
  }
  throw new Error('unreachable');
}

/** Whether an instant falls inside business hours. */
export function isBusinessTime(cal: BusinessCalendar, at: Date | number) {
  const ms = +at;
  const w = windowOn(cal, localDate(cal.timeZone, ms));
  return !!w && ms >= w[0] && ms < w[1];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Checks and normalises the weekly hours a person typed: keys 1 to 7, each null (closed) or ["HH:MM", "HH:MM"] with the end after the start. */
export function parseDays(raw: unknown): Record<number, DayWindow> {
  if (!raw || typeof raw !== 'object') throw new Error('give the opening hours for each weekday');
  const out: Record<number, DayWindow> = {};
  for (let d = 1; d <= 7; d++) {
    const v = (raw as Record<string, unknown>)[String(d)];
    if (v == null) { out[d] = null; continue; }
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string') throw new Error(`day ${d}: use a start and an end time`);
    const [s, e] = v as [string, string];
    if (!HHMM.test(s) || !(HHMM.test(e) || e === '24:00')) throw new Error(`day ${d}: times are written HH:MM (the end may be 24:00)`);
    if (toMinutes(e) <= toMinutes(s)) throw new Error(`day ${d}: the end must be after the start`);
    out[d] = [s, e];
  }
  if (!Object.values(out).some(Boolean)) throw new Error('at least one weekday must be open');
  return out;
}
