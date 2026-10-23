import { describe, expect, it } from 'vitest';
import { CONSTANTS, attributeCenter, attributePoint, capability, computeLimits, evaluate, evaluateAttribute, points } from '../src/modules/spc/engine.js';
import { splitValues } from '../src/modules/imports/targets/spc.js';

const L = { center: 0, ucl: 3, lcl: -3, rangeCenter: 1, rangeUcl: 10, rangeLcl: 0, sigma: 1, subgroups: 25 };
const rules = (x: number[], r: (number | null)[] = x.map(() => 0)) => evaluate(x, r, L).map((s) => [s.index, s.rule]);

describe('control limits', () => {
  it('X̄–R: X̄̄ ± A2·R̄, D3/D4·R̄, σ = R̄/d2 (n = 2, hand-computed)', () => {
    // Means 2, 2, 4 → X̄̄ 2.666667; ranges 2, 0, 2 → R̄ 1.333333.
    expect(computeLimits([[1, 3], [2, 2], [3, 5]], 2)).toEqual({ center: 2.666667, ucl: 5.173333, lcl: 0.16, rangeCenter: 1.333333, rangeUcl: 4.356, rangeLcl: 0, sigma: 1.18203310, subgroups: 3 });
  });

  it('individuals and moving range: X̄ ± 2.66·MR̄, MR limit 3.267·MR̄, σ = MR̄/1.128', () => {
    // Moving ranges 2, 1, 4 → MR̄ 2.333333; X̄ 12.
    expect(computeLimits([[10], [12], [11], [15]], 1)).toEqual({ center: 12, ucl: 18.206667, lcl: 5.793333, rangeCenter: 2.333333, rangeUcl: 7.623, rangeLcl: 0, sigma: 2.06855792, subgroups: 4 });
    expect(points([[10], [12]]).r).toEqual([null, 2]);
  });

  it('uses the published constants (ASTM / AIAG SPC manual) and is consistent: A2 = 3 / (d2 √n)', () => {
    for (const [n, c] of Object.entries(CONSTANTS)) expect(c.A2).toBeCloseTo(3 / (c.d2 * Math.sqrt(Number(n))), 2);
    expect(CONSTANTS[5]).toEqual({ A2: 0.577, D3: 0, D4: 2.114, d2: 2.326 });
    expect(() => computeLimits([[1, 2, 3]], 2)).toThrow(/subgroups of|must have 2/);
  });
});

describe('rules', () => {
  it('a point beyond a control limit; a range beyond its limit', () => {
    expect(rules([0, 3.5, -3.2])).toEqual([[1, 'beyond_limits'], [2, 'beyond_limits']]);
    expect(evaluate([0, 0], [1, 12], L).map((s) => [s.index, s.rule, s.chart])).toEqual([[1, 'range_beyond', 'r']]);
  });
  it('9 in a row on one side, reported once per run; a point on the center line breaks it', () => {
    expect(rules(Array(10).fill(0.5))).toEqual([[8, 'run_of_9']]);
    expect(rules([...Array(5).fill(-0.5), 0, ...Array(5).fill(-0.5)])).toEqual([]);
  });
  it('6 in a row rising or falling', () => {
    expect(rules([-1, -0.8, -0.6, 0.1, 0.4, 0.9])).toEqual([[5, 'trend_of_6']]);
    expect(rules([0.5, 0.4, 0.3, 0.2, 0.3, 0.1])).toEqual([]);
  });
  it('2 of 3 beyond 2σ on the same side, once per cluster', () => {
    expect(rules([2.5, 0, 2.2])).toEqual([[2, 'two_of_three']]);
    expect(rules([2.5, 2.5, 2.5])).toEqual([[1, 'two_of_three']]);
    expect(rules([2.5, 0, -2.5])).toEqual([]);
  });
  it('reports only from the requested point, while earlier points still count toward runs', () => {
    expect(evaluate(Array(9).fill(0.5), Array(9).fill(0), L, 8).map((s) => s.rule)).toEqual(['run_of_9']);
    expect(evaluate([4, 0], [0, 0], L, 1)).toEqual([]);
  });
});

describe('capability', () => {
  it('Cp/Cpk from within σ, Pp/Ppk from the overall standard deviation; one-sided tolerances give only the k index', () => {
    // Mean 10, overall s = 1; tolerance 7–13 → all indexes 1.00.
    expect(capability([9, 10, 11], 1, { lsl: 7, usl: 13 })).toMatchObject({ mean: 10, cp: 1, cpk: 1, pp: 1, ppk: 1, outOfSpec: 0 });
    // Off-center: within σ 0.5, mean 10, tolerance 8.5–13 → Cp 1.5, Cpk min(1.0, 2.0) = 1.0.
    expect(capability([9, 10, 11], 0.5, { lsl: 8.5, usl: 13 })).toMatchObject({ cp: 1.5, cpk: 1, pp: 0.75, ppk: 0.5 });
    expect(capability([9, 10, 11], 1, { lsl: null, usl: 13 })).toMatchObject({ cp: null, cpk: 1, pp: null, ppk: 1 });
    expect(capability([9, 14], 1, { lsl: 7, usl: 13 }).outOfSpec).toBe(1);
  });
});

describe('measurement exports', () => {
  it('reads subgroups the way gauges and spreadsheets write them', () => {
    expect(['25.001 25.003 24.998', '25.001;25.003', '25.001|25.003', '25.001,25.003,24.998', '25,003', 25.1, 'x 1', ''].map(splitValues))
      .toEqual([[25.001, 25.003, 24.998], [25.001, 25.003], [25.001, 25.003], [25.001, 25.003, 24.998], [25.003], [25.1], null, null]);
  });
});

describe('attribute charts', () => {
  it('p: p̄ = Σd/Σn with limits that step with each sample size', () => {
    const S = [{ count: 2, n: 100 }, { count: 4, n: 100 }, { count: 3, n: 50 }];
    const pbar = attributeCenter('p', S); // 9 / 250
    expect(pbar).toBeCloseTo(0.036, 9);
    expect(attributePoint('p', pbar, S[2]!)).toMatchObject({ x: 0.06, center: 0.036, ucl: 0.115036, lcl: 0 });
    expect(attributePoint('p', pbar, S[0]!)).toMatchObject({ x: 0.02, ucl: 0.091887, lcl: 0 });
  });
  it('np, c and u', () => {
    // np: n = 50, p̄ = 6/150 = 0.04 → center 2, σ = √(50·0.04·0.96) = 1.3856
    const np = attributeCenter('np', [{ count: 2, n: 50 }, { count: 3, n: 50 }, { count: 1, n: 50 }]);
    expect(np).toBeCloseTo(2, 9);
    expect(attributePoint('np', np, { count: 3, n: 50 }, 50)).toMatchObject({ x: 3, center: 2, ucl: 6.156922, lcl: 0 });
    // c: c̄ = 4 → 4 ± 6
    expect(attributePoint('c', attributeCenter('c', [{ count: 3, n: 1 }, { count: 5, n: 1 }, { count: 4, n: 1 }]), { count: 11, n: 1 })).toMatchObject({ x: 11, center: 4, ucl: 10, lcl: 0 });
    // u: ū = 18 / 6.5; at n = 2, σ = √(ū/2)
    const u = attributeCenter('u', [{ count: 6, n: 2 }, { count: 3, n: 1.5 }, { count: 9, n: 3 }]);
    expect(attributePoint('u', u, { count: 6, n: 2 })).toMatchObject({ x: 3, center: 2.769231, ucl: 6.299321, lcl: 0 });
  });
  it('rules use each point\'s own limits', () => {
    const pts = [{ x: 0.09, center: 0.036, ucl: 0.0919, lcl: 0 }, { x: 0.1, center: 0.036, ucl: 0.115, lcl: 0 }, { x: 0.1, center: 0.036, ucl: 0.0919, lcl: 0 }];
    expect(evaluateAttribute(pts).map((x) => [x.index, x.rule])).toEqual([[2, 'beyond_limits']]);
  });
});
