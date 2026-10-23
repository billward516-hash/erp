/**
 * Lenient-but-honest value coercion for customer data. Every parser either returns a value or a
 * human-readable reason; nothing is guessed silently. Ambiguities (e.g. 03/04/2025) are resolved
 * at the column level by inferDateFormat and surfaced as warnings.
 */

export type Raw = string | number | boolean | Date | null | undefined;
export type Coerced<T> = { ok: true; value: T | null } | { ok: false; error: string };

const ok = <T>(value: T | null): Coerced<T> => ({ ok: true, value });
const fail = (error: string): Coerced<never> => ({ ok: false, error });

export const NULL_TOKENS = new Set(['', 'n/a', 'na', 'null', 'none', '-', '--', '?', '#n/a', 'tbd', 'unknown']);

export function isBlank(v: Raw): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return NULL_TOKENS.has(v.trim().toLowerCase());
  return false;
}

export function asText(v: Raw): string | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v!).trim();
}

// ---------------------------------------------------------------------------
// Numbers: "$1,234.50", "1.234,50", "(12.00)", "12 %", " 7 "
// ---------------------------------------------------------------------------
export function parseNumber(v: Raw, opts: { decimal?: '.' | ',' | 'auto' } = {}): Coerced<number> {
  if (isBlank(v)) return ok(null);
  if (typeof v === 'number') return Number.isFinite(v) ? ok(v) : fail('not a finite number');
  if (typeof v === 'boolean' || v instanceof Date) return fail(`expected a number, got ${String(v)}`);
  let s = String(v).trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/^[A-Z]{3}\s+/i, '').replace(/[$€£¥\s ]/g, '').replace(/%$/, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  const decimal = opts.decimal ?? 'auto';
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (decimal === ',' || (decimal === 'auto' && hasDot && hasComma && s.lastIndexOf(',') > s.lastIndexOf('.'))) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (decimal === 'auto' && hasComma && !hasDot && !/^\d{1,3}(,\d{3})+$/.test(s)) {
    // "12,5" with no thousands pattern: European decimal comma.
    s = s.replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return fail(`"${v}" is not a number`);
  const n = Number(s);
  return ok(negative ? -n : n);
}

// ---------------------------------------------------------------------------
// Booleans
// ---------------------------------------------------------------------------
const TRUE = new Set(['y', 'yes', 'true', 't', '1', 'x', '✓', '✔', 'on', 'active', 'enabled']);
const FALSE = new Set(['n', 'no', 'false', 'f', '0', 'off', 'inactive', 'disabled']);

export function parseBoolean(v: Raw, extra?: { true?: string[]; false?: string[] }): Coerced<boolean> {
  if (typeof v === 'boolean') return ok(v);
  if (isBlank(v)) return ok(null);
  const s = String(v).trim().toLowerCase();
  if (TRUE.has(s) || extra?.true?.map((x) => x.toLowerCase()).includes(s)) return ok(true);
  if (FALSE.has(s) || extra?.false?.map((x) => x.toLowerCase()).includes(s)) return ok(false);
  return fail(`"${v}" is not a yes/no value`);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
/**
 * Supported format patterns (case-insensitive tokens): YYYY / YY (year), MM / M (month number),
 * DD / D (day), MON (month name/abbrev). Separators are literal. Examples: "MM/DD/YYYY",
 * "DD.MM.YYYY", "YYYY-MM-DD", "DD-MON-YY", "MON D, YYYY", "YYYYMMDD". Also always accepted:
 * ISO-8601 timestamps, spreadsheet Date cells, and Excel serial day numbers.
 */
export const DEFAULT_DATE_FORMATS = [
  'YYYY-MM-DD', 'YYYY/MM/DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'MM/DD/YY', 'DD/MM/YY', 'MM-DD-YYYY', 'DD-MM-YYYY',
  'DD.MM.YYYY', 'DD.MM.YY', 'DD-MON-YYYY', 'DD-MON-YY', 'DD MON YYYY', 'MON DD, YYYY', 'MON DD YYYY', 'YYYYMMDD',
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface DateParts { y: number; m: number; d: number }

interface CompiledFormat { pattern: string; regex: RegExp; order: ('Y' | 'M' | 'D' | 'MON')[]; twoDigitYear: boolean }
const compiled = new Map<string, CompiledFormat>();

function compileFormat(pattern: string): CompiledFormat {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  const order: CompiledFormat['order'] = [];
  let twoDigitYear = false;
  let re = '';
  const tokenRe = /YYYY|YY|MON|MM|M|DD|D|./gi;
  for (const tok of pattern.match(tokenRe) ?? []) {
    const t = tok.toUpperCase();
    if (t === 'YYYY') { re += '(\\d{4})'; order.push('Y'); }
    else if (t === 'YY') { re += '(\\d{2})'; order.push('Y'); twoDigitYear = true; }
    else if (t === 'MON') { re += '([A-Za-z]{3,9})\\.?'; order.push('MON'); }
    else if (t === 'MM' || t === 'M') { re += pattern.length === 8 && !/[^A-Z]/i.test(pattern) ? '(\\d{2})' : '(\\d{1,2})'; order.push('M'); }
    else if (t === 'DD' || t === 'D') { re += pattern.length === 8 && !/[^A-Z]/i.test(pattern) ? '(\\d{2})' : '(\\d{1,2})'; order.push('D'); }
    else if (t === ' ') re += '\\s+';
    else re += tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const c = { pattern, regex: new RegExp(`^${re}$`, 'i'), order, twoDigitYear };
  compiled.set(pattern, c);
  return c;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1800 || y > 2200) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function matchDateFormat(s: string, pattern: string, pivotYear = 70): DateParts | null {
  const f = compileFormat(pattern);
  const m = f.regex.exec(s.trim());
  if (!m) return null;
  let y = 0, mo = 0, d = 0;
  f.order.forEach((tok, i) => {
    const g = m[i + 1]!;
    if (tok === 'Y') { y = Number(g); if (f.twoDigitYear) y += y < pivotYear ? 2000 : 1900; }
    else if (tok === 'M') mo = Number(g);
    else if (tok === 'D') d = Number(g);
    else { const idx = MONTHS.indexOf(g.slice(0, 3).toLowerCase()); mo = idx + 1; }
  });
  return validDate(y, mo, d) ? { y, m: mo, d } : null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const isoDate = (p: DateParts) => `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;

/** Excel's 1900 date system (including its fictitious 1900-02-29). */
export function excelSerialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));
}

function splitDateTime(s: string): { datePart: string; time: { h: number; mi: number; s: number } | null } {
  const m = /^(.*?)[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?$/.exec(s.trim());
  if (!m) return { datePart: s.trim(), time: null };
  let h = Number(m[2]);
  const ampm = m[5]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return { datePart: m[1]!, time: { h, mi: Number(m[3]), s: Number(m[4] ?? 0) } };
}

export function parseDate(v: Raw, formats: string[] = DEFAULT_DATE_FORMATS): Coerced<string> {
  if (isBlank(v)) return ok(null);
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? fail('invalid date') : ok(v.toISOString().slice(0, 10));
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return ok(excelSerialToDate(v).toISOString().slice(0, 10));
    v = String(v);
  }
  if (typeof v !== 'string') return fail(`"${String(v)}" is not a date`);
  const iso = /^(\d{4})-(\d{2})-(\d{2})T/.exec(v.trim());
  if (iso && validDate(+iso[1]!, +iso[2]!, +iso[3]!)) return ok(`${iso[1]}-${iso[2]}-${iso[3]}`);
  const { datePart } = splitDateTime(v);
  for (const f of formats) {
    const p = matchDateFormat(datePart, f);
    if (p) return ok(isoDate(p));
  }
  return fail(`"${v}" does not match expected date format${formats.length === 1 ? ` ${formats[0]}` : 's'}`);
}

/** Offset (ms) of an IANA zone from UTC at a given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** Interprets a wall-clock time in the given zone (e.g. the facility's) as a UTC instant. */
export function zonedToUtc(p: DateParts, t: { h: number; mi: number; s: number }, timeZone: string): Date {
  const guess = Date.UTC(p.y, p.m - 1, p.d, t.h, t.mi, t.s);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return new Date(guess - zoneOffsetMs(first, timeZone));
}

/**
 * Timestamps. Strings without an explicit offset are interpreted in `timeZone` (facility local time).
 * Date-only values become local midnight. Spreadsheet Date cells are already absolute instants.
 */
export function parseDateTime(v: Raw, opts: { formats?: string[]; timeZone: string }): Coerced<string> {
  if (isBlank(v)) return ok(null);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? fail('invalid date/time') : ok(v.toISOString());
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      // Excel serials are wall-clock values with no zone.
      const d = excelSerialToDate(v);
      return ok(zonedToUtc({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() },
        { h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }, opts.timeZone).toISOString());
    }
    v = String(v);
  }
  if (typeof v !== 'string') return fail(`"${String(v)}" is not a date/time`);
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? fail(`"${v}" is not a valid timestamp`) : ok(d.toISOString());
  }
  const { datePart, time } = splitDateTime(s);
  if (time && (time.h > 23 || time.mi > 59 || time.s > 59)) return fail(`"${v}" has an invalid time`);
  const date = parseDate(datePart, opts.formats);
  if (!date.ok) return date;
  if (date.value === null) return ok(null);
  const [y, m, d] = date.value.split('-').map(Number) as [number, number, number];
  return ok(zonedToUtc({ y, m, d }, time ?? { h: 0, mi: 0, s: 0 }, opts.timeZone).toISOString());
}

export interface DateInference {
  formats: string[];
  /** Set when more than one format parses every value but yields different dates. */
  ambiguous: { chosen: string; alternatives: string[] } | null;
  unparsed: number;
}

/**
 * Picks the date format(s) for a whole column. A column of "03/04/2025, 05/06/2025" parses as both
 * MM/DD and DD/MM; one value like "13/04/2025" disambiguates it. If still ambiguous, `preferOrder`
 * (US default 'MDY') decides and the caller reports the assumption as a warning.
 */
export function inferDateFormat(values: Raw[], preferOrder: 'MDY' | 'DMY' = 'MDY'): DateInference {
  const strings = values
    .filter((v): v is string => typeof v === 'string' && !isBlank(v) && !/^\d{4}-\d{2}-\d{2}T/.test(v.trim()))
    .map((v) => splitDateTime(v).datePart)
    .slice(0, 2000);
  if (!strings.length) return { formats: DEFAULT_DATE_FORMATS, ambiguous: null, unparsed: 0 };
  const scored = DEFAULT_DATE_FORMATS.map((f) => ({ f, hits: strings.filter((s) => matchDateFormat(s, f)).length }));
  const best = Math.max(...scored.map((s) => s.hits));
  if (best === 0) return { formats: DEFAULT_DATE_FORMATS, ambiguous: null, unparsed: strings.length };
  const top = scored.filter((s) => s.hits === best).map((s) => s.f);
  // Formats that agree on every value are interchangeable (e.g. MM/DD/YYYY vs MM-DD-YYYY never both match).
  const distinct = top.filter((f, i) => top.findIndex((g) => strings.every((s) => {
    const a = matchDateFormat(s, f); const b = matchDateFormat(s, g);
    return (a && isoDate(a)) === (b && isoDate(b));
  })) === i);
  const dmy = (f: string) => /^D/i.test(f);
  const sorted = [...distinct].sort((a, b) => (preferOrder === 'DMY' ? Number(dmy(b)) - Number(dmy(a)) : Number(dmy(a)) - Number(dmy(b))));
  const chosen = sorted[0]!;
  const alternatives = sorted.slice(1);
  return {
    // Chosen format first; other formats stay available for genuinely mixed columns.
    formats: [chosen, ...DEFAULT_DATE_FORMATS.filter((f) => f !== chosen && !alternatives.includes(f))],
    ambiguous: alternatives.length ? { chosen, alternatives } : null,
    unparsed: strings.length - best,
  };
}
