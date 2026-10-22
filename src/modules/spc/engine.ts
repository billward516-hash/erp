/**
 * Statistical process control calculations (docs/ARCHITECTURE.md §12n). Pure and deterministic; unit-tested against
 * textbook constants and hand-computed examples.
 *
 *  - Subgroups of 2–10: X̄ and R charts. X̄ limits = X̄̄ ± A2·R̄; R limits D3·R̄, D4·R̄; within-subgroup σ = R̄ / d2.
 *  - Single readings (n = 1): individuals and moving range. Limits = X̄ ± 2.66·MR̄ (3 / d2 with d2 = 1.128);
 *    MR upper limit 3.267·MR̄; σ = MR̄ / 1.128.
 *  - Rules (Western Electric / Nelson, the four most used): a point beyond the control limits; 9 in a row on one side of
 *    the center line; 6 in a row steadily rising or falling; 2 of 3 in a row beyond 2σ on the same side. Ranges are
 *    checked against their upper limit only.
 *  - Capability: Cp, Cpk from within-subgroup σ (short term); Pp, Ppk from the overall sample standard deviation
 *    (long term). One-sided tolerances give only the k index. Normality is assumed, not tested, and said so.
 */

export const CONSTANTS: Record<number, { A2: number; D3: number; D4: number; d2: number }> = {
  2: { A2: 1.880, D3: 0, D4: 3.267, d2: 1.128 },
  3: { A2: 1.023, D3: 0, D4: 2.574, d2: 1.693 },
  4: { A2: 0.729, D3: 0, D4: 2.282, d2: 2.059 },
  5: { A2: 0.577, D3: 0, D4: 2.114, d2: 2.326 },
  6: { A2: 0.483, D3: 0, D4: 2.004, d2: 2.534 },
  7: { A2: 0.419, D3: 0.076, D4: 1.924, d2: 2.704 },
  8: { A2: 0.373, D3: 0.136, D4: 1.864, d2: 2.847 },
  9: { A2: 0.337, D3: 0.184, D4: 1.816, d2: 2.970 },
  10: { A2: 0.308, D3: 0.223, D4: 1.777, d2: 3.078 },
};
export const I_MR = { E2: 2.66, D4: 3.267, d2: 1.128 };
/** Subgroups needed before limits can be set from a baseline, and before capability is reported without a warning. */
export const MIN_SUBGROUPS_FOR_LIMITS = 20;
export const MIN_SUBGROUPS_FOR_CAPABILITY = 25;

export interface Limits { center: number; ucl: number; lcl: number; rangeCenter: number; rangeUcl: number; rangeLcl: number; sigma: number; subgroups: number }
export type Rule = 'beyond_limits' | 'run_of_9' | 'trend_of_6' | 'two_of_three' | 'range_beyond';
export interface Signal { index: number; rule: Rule; chart: 'x' | 'r'; detail: string }

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

/** The plotted points: subgroup means (or the readings) and ranges (or moving ranges; the first has none). */
export function points(subgroups: number[][]) {
  const n = subgroups[0]?.length ?? 1;
  if (n === 1) {
    const x = subgroups.map((s) => s[0]!);
    return { x, r: x.map((v, i) => (i === 0 ? null : Math.abs(v - x[i - 1]!))) };
  }
  return { x: subgroups.map(mean), r: subgroups.map((s) => Math.max(...s) - Math.min(...s)) as (number | null)[] };
}

/** Control limits from a baseline of complete subgroups of size n. */
export function computeLimits(subgroups: number[][], n: number): Limits {
  if (!subgroups.length) throw new Error('no subgroups');
  if (subgroups.some((s) => s.length !== n)) throw new Error(`every subgroup must have ${n} values`);
  const { x, r } = points(subgroups);
  const ranges = r.filter((v): v is number => v != null);
  if (!ranges.length) throw new Error('at least two readings are needed for a moving range');
  const xbar = mean(x); const rbar = mean(ranges);
  if (n === 1) {
    return { center: round(xbar), ucl: round(xbar + I_MR.E2 * rbar), lcl: round(xbar - I_MR.E2 * rbar), rangeCenter: round(rbar), rangeUcl: round(I_MR.D4 * rbar), rangeLcl: 0,
      sigma: round(rbar / I_MR.d2, 8), subgroups: subgroups.length };
  }
  const c = CONSTANTS[n];
  if (!c) throw new Error('subgroup size must be 1 to 10');
  return { center: round(xbar), ucl: round(xbar + c.A2 * rbar), lcl: round(xbar - c.A2 * rbar), rangeCenter: round(rbar), rangeUcl: round(c.D4 * rbar), rangeLcl: round(c.D3 * rbar),
    sigma: round(rbar / c.d2, 8), subgroups: subgroups.length };
}

/**
 * Rule violations, each reported at the point that completes the pattern. A long run reports once, when it reaches its
 * length, and again only after it is broken. `from` limits the reported points (earlier ones still count toward runs).
 */
export function evaluate(x: number[], r: (number | null)[], L: Limits, from = 0): Signal[] {
  const out: Signal[] = [];
  const s1 = (L.ucl - L.center) / 3; // 1σ of the plotted statistic
  const side = (v: number) => (v > L.center ? 1 : v < L.center ? -1 : 0);
  let run = 0; let runSide = 0; let trend = 0; let dir = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const at = (rule: Rule, chart: 'x' | 'r', detail: string) => { if (i >= from) out.push({ index: i, rule, chart, detail }); };
    if (v > L.ucl || v < L.lcl) at('beyond_limits', 'x', `${v > L.ucl ? 'above the upper' : 'below the lower'} control limit (${fmt(v)} vs ${fmt(v > L.ucl ? L.ucl : L.lcl)})`);
    // Run on one side of the center line (a point on the line breaks it).
    const sd = side(v);
    if (sd !== 0 && sd === runSide) run++; else { run = sd === 0 ? 0 : 1; runSide = sd; }
    if (run === 9) at('run_of_9', 'x', `9 points in a row ${runSide > 0 ? 'above' : 'below'} the center line`);
    // Trend: 6 points in a row each higher (or lower) than the one before = 5 consecutive steps.
    if (i > 0) {
      const d = Math.sign(v - x[i - 1]!);
      if (d !== 0 && d === dir) trend++; else { trend = d === 0 ? 0 : 1; dir = d; }
      if (trend === 5) at('trend_of_6', 'x', `6 points in a row steadily ${dir > 0 ? 'rising' : 'falling'}`);
    }
    // 2 of 3 beyond 2σ on the same side, the current point being one of them (and not already beyond 3σ alone).
    if (i >= 1) {
      const w = x.slice(Math.max(0, i - 2), i + 1);
      for (const sgn of [1, -1]) {
        const beyond = (y: number) => sgn * (y - L.center) > 2 * s1;
        const k = w.filter(beyond).length;
        if (beyond(v) && k >= 2) {
          // Report once per cluster: not if the previous window already qualified on this side with the previous point.
          const prev = x.slice(Math.max(0, i - 3), i);
          const prevHit = prev.length >= 2 && beyond(prev[prev.length - 1]!) && prev.filter(beyond).length >= 2;
          if (!prevHit) at('two_of_three', 'x', `2 of 3 points beyond 2σ ${sgn > 0 ? 'above' : 'below'} the center line`);
        }
      }
    }
    const rv = r[i];
    if (rv != null && rv > L.rangeUcl) at('range_beyond', 'r', `${x.length && r[0] === null ? 'moving range' : 'range'} ${fmt(rv)} above its control limit ${fmt(L.rangeUcl)}`);
  }
  return out;
}

function fmt(v: number) { return String(round(v, 6)); }

/** Sample standard deviation (n − 1). */
export function stdev(xs: number[]) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function capability(values: number[], sigmaWithin: number | null, spec: { lsl: number | null; usl: number | null }) {
  const { lsl, usl } = spec;
  const mu = values.length ? mean(values) : null;
  const sOverall = stdev(values);
  const idx = (s: number | null) => {
    if (mu == null || s == null || !(s > 0)) return { p: null, k: null };
    const upper = usl != null ? (usl - mu) / (3 * s) : null;
    const lower = lsl != null ? (mu - lsl) / (3 * s) : null;
    const k = upper != null && lower != null ? Math.min(upper, lower) : upper ?? lower;
    return { p: usl != null && lsl != null ? (usl - lsl) / (6 * s) : null, k };
  };
  const w = idx(sigmaWithin); const o = idx(sOverall);
  const r2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);
  return { mean: mu == null ? null : round(mu), sigmaWithin, sigmaOverall: sOverall == null ? null : round(sOverall, 8),
    cp: r2(w.p), cpk: r2(w.k), pp: r2(o.p), ppk: r2(o.k),
    outOfSpec: values.filter((v) => (usl != null && v > usl) || (lsl != null && v < lsl)).length, values: values.length };
}
