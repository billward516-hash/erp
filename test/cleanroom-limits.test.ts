import { describe, expect, it } from 'vitest';
import { classLimit, classLimits, effectiveLimits, judge, worstLevel } from '../src/modules/cleanroom/limits.js';

/** SC-007 A: the generator reproduces the ISO 14644-1 class limits (per cubic metre); the company still confirms them against its own copy of the standard. */
const table = (n: number) => Object.fromEntries(classLimits(n).map((l) => [l.channel, l.limit]));

describe('ISO 14644-1 class limits from Cn = 10^N x (0.1/D)^2.08', () => {
  it('matches the known table values for ISO 5 and ISO 6', () => {
    expect(table(5)).toEqual({ p0_1: 100000, p0_2: 23700, p0_3: 10200, p0_5: 3520, p1: 832, p5: 29 });
    expect(table(6)).toEqual({ p0_1: 1000000, p0_2: 237000, p0_3: 102000, p0_5: 35200, p1: 8320, p5: 293 });
  });
  it('matches ISO 7, 8 and 9, which give no value below 0.5 um', () => {
    expect(table(7)).toEqual({ p0_1: null, p0_2: null, p0_3: null, p0_5: 352000, p1: 83200, p5: 2930 });
    expect(table(8)).toEqual({ p0_1: null, p0_2: null, p0_3: null, p0_5: 3520000, p1: 832000, p5: 29300 });
    expect(table(9)).toEqual({ p0_1: null, p0_2: null, p0_3: null, p0_5: 35200000, p1: 8320000, p5: 293000 });
  });
  it('matches the low classes, which round to whole particles, and leaves blank cells unlimited', () => {
    expect(table(1)).toEqual({ p0_1: 10, p0_2: 2, p0_3: null, p0_5: null, p1: null, p5: null });
    expect(table(2)).toEqual({ p0_1: 100, p0_2: 24, p0_3: 10, p0_5: 4, p1: null, p5: null });
    expect(table(3)).toEqual({ p0_1: 1000, p0_2: 237, p0_3: 102, p0_5: 35, p1: 8, p5: null });
    expect(table(4)).toEqual({ p0_1: 10000, p0_2: 2370, p0_3: 1020, p0_5: 352, p1: 83, p5: null });
  });
  it('gives nothing for a class outside 1 to 9', () => {
    expect(classLimit(0, 'p0_5')).toBeNull();
    expect(classLimit(10, 'p0_5')).toBeNull();
    expect(classLimit(5.5, 'p0_5')).toBeNull();
  });
});

describe('alert and action thresholds', () => {
  it('alert defaults to 80% of the action limit and a point can replace either', () => {
    const l = effectiveLimits(5, 80, 'p0_5');
    expect(l).toMatchObject({ actionHigh: 3520, alertHigh: 2816, source: 'class' });
    expect(effectiveLimits(5, 90, 'p0_5').alertHigh).toBe(3168);
    expect(effectiveLimits(5, 80, 'p0_5', { alert_low: null, alert_high: 1000, action_low: null, action_high: null })).toMatchObject({ actionHigh: 3520, alertHigh: 1000, source: 'point' });
    expect(effectiveLimits(5, 80, 'p0_5', { alert_low: null, alert_high: null, action_low: null, action_high: 5000 })).toMatchObject({ actionHigh: 5000, alertHigh: 4000 });
  });
  it('a size the class has no limit for is not limited, until a point sets one', () => {
    expect(effectiveLimits(7, 80, 'p0_3')).toMatchObject({ actionHigh: null, alertHigh: null, source: 'none' });
    expect(judge('p0_3', 5_000_000, effectiveLimits(7, 80, 'p0_3'))).toBeNull();
    expect(effectiveLimits(7, 80, 'p0_3', { alert_low: null, alert_high: null, action_low: null, action_high: 20000 }).alertHigh).toBe(16000);
  });
  it('pressure, temperature and humidity are limited only by a range a point sets', () => {
    expect(effectiveLimits(5, 80, 'dp').source).toBe('none');
    const dp = effectiveLimits(5, 80, 'dp', { alert_low: 12, alert_high: null, action_low: 10, action_high: null });
    expect(judge('dp', 15, dp)).toBeNull();
    expect(judge('dp', 11, dp)).toMatchObject({ level: 'alert', side: 'low', limit: 12 });
    expect(judge('dp', 9.5, dp)).toMatchObject({ level: 'action', side: 'low', limit: 10 });
  });
  it('over the alert limit is an alert, over the action limit an action, and exactly on a limit is not over it', () => {
    const l = effectiveLimits(5, 80, 'p0_5');
    expect(judge('p0_5', 2816, l)).toBeNull();
    expect(judge('p0_5', 2817, l)).toMatchObject({ level: 'alert', limit: 2816 });
    expect(judge('p0_5', 3520, l)).toMatchObject({ level: 'alert' });
    expect(judge('p0_5', 3521, l)).toMatchObject({ level: 'action', limit: 3520 });
    expect(worstLevel([])).toBe('ok');
    expect(worstLevel([judge('p0_5', 3000, l)!])).toBe('alert');
    expect(worstLevel([judge('p0_5', 3000, l)!, judge('p0_5', 4000, l)!])).toBe('action');
  });
});
