/**
 * Specification check for one analyte result (D-184D). Limits are inclusive and either may be absent (a one-sided
 * specification: "not more than" or "not less than"). An analyte with neither limit is only reported, never passed or failed.
 */
export type Outcome = 'pass' | 'fail' | 'reported';

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

export function evaluate(value: number, low: number | string | null | undefined, high: number | string | null | undefined): Outcome {
  const lo = num(low), hi = num(high);
  if (!Number.isFinite(value)) throw new Error('a result must be a finite number');
  if (lo == null && hi == null) return 'reported';
  if (lo != null && value < lo) return 'fail';
  if (hi != null && value > hi) return 'fail';
  return 'pass';
}

/** The limits as printed: "1 to 2", "at most 5", "at least 0.5", or "no limit". */
export function limitText(low: number | string | null | undefined, high: number | string | null | undefined): string {
  const lo = num(low), hi = num(high);
  if (lo != null && hi != null) return `${lo} to ${hi}`;
  if (hi != null) return `at most ${hi}`;
  if (lo != null) return `at least ${lo}`;
  return 'no limit';
}
