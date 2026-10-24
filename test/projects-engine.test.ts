import { describe, expect, it } from 'vitest';
import { budgetLevel, burn, contractValue, laborCost, milestoneAmount, rateInForce, variance, warnings } from '../src/modules/projects/engine.js';

describe('cost rate in force', () => {
  const rates = [{ effective_from: '2026-01-01', hourly_cost: 50 }, { effective_from: '2026-07-01', hourly_cost: 60 }, { effective_from: '2025-01-01', hourly_cost: 40 }];
  it('uses the latest rate that is not after the day worked, whatever the order of the list', () => {
    expect(rateInForce(rates, '2026-06-30')).toBe(50);
    expect(rateInForce(rates, '2026-07-01')).toBe(60);
    expect(rateInForce(rates, '2025-12-31')).toBe(40);
    expect(rateInForce(rates, '2026-01-01')).toBe(50);
  });
  it('has no rate before the first effective date', () => {
    expect(rateInForce(rates, '2024-12-31')).toBeNull();
    expect(rateInForce([], '2026-01-01')).toBeNull();
  });
  it('costs each day at its own rate and counts unrated hours separately', () => {
    const r = laborCost([{ work_date: '2026-06-30', hours: 8 }, { work_date: '2026-07-01', hours: 4 }, { work_date: '2024-01-01', hours: 3 }], rates);
    expect(r).toEqual({ cost: 8 * 50 + 4 * 60, unratedHours: 3 });
  });
});

describe('budget against actual', () => {
  it('computes remaining and share used', () => {
    expect(variance(100, 40)).toEqual({ budget: 100, actual: 40, remaining: 60, used: 0.4 });
    expect(variance(100, 130)).toEqual({ budget: 100, actual: 130, remaining: -30, used: 1.3 });
  });
  it('has no share when there is no budget, and handles a zero budget', () => {
    expect(variance(null, 12)).toEqual({ budget: null, actual: 12, remaining: null, used: null });
    expect(variance(0, 0).used).toBe(0);
    expect(variance(0, 5).used).toBeNull();
  });
  it('alerts at the company share and is over only past the budget', () => {
    expect(budgetLevel(0.89)).toBe('ok');
    expect(budgetLevel(0.9)).toBe('alert');
    expect(budgetLevel(1)).toBe('alert');
    expect(budgetLevel(1.01)).toBe('over');
    expect(budgetLevel(0.8, 75)).toBe('alert');
    expect(budgetLevel(null)).toBe('ok');
  });
});

describe('burn and projected finish', () => {
  it('projects the day the remaining hours run out at the recent pace', () => {
    // 28 hours in 28 days = 1 h a day = 7 a week; 10 hours left runs out in 10 days.
    expect(burn(28, 28, 10, '2026-10-01')).toEqual({ perWeek: 7, projectedFinish: '2026-10-11' });
  });
  it('gives no finish when nothing was worked, nothing is left or there is no budget', () => {
    expect(burn(0, 28, 10, '2026-10-01').projectedFinish).toBeNull();
    expect(burn(10, 28, 0, '2026-10-01').projectedFinish).toBeNull();
    expect(burn(10, 28, -5, '2026-10-01').projectedFinish).toBeNull();
    expect(burn(10, 28, null, '2026-10-01').projectedFinish).toBeNull();
  });
});

describe('contract value and milestones', () => {
  it('adds signed approved changes to the original amount', () => {
    expect(contractValue(100_000, [15_000, -5_000])).toBe(110_000);
    expect(contractValue(100_000, [])).toBe(100_000);
    expect(contractValue(null, [])).toBeNull();
  });
  it('takes a milestone from its own amount, else its percent of the current contract', () => {
    expect(milestoneAmount({ amount: 2_500, percent: null }, 110_000)).toBe(2_500);
    expect(milestoneAmount({ amount: null, percent: 25 }, 110_000)).toBe(27_500);
    expect(milestoneAmount({ amount: null, percent: 25 }, null)).toBeNull();
  });
});

describe('warnings', () => {
  const base = { cost: null, alertPct: 90, status: 'active', endDate: null, today: '2026-10-24', overdueMilestones: 0, unratedHours: null };
  it('warns near and over the hours budget, late milestones and a passed end date', () => {
    expect(warnings({ ...base, hours: variance(100, 50) })).toEqual([]);
    expect(warnings({ ...base, hours: variance(100, 92) }).map((w) => w.code)).toEqual(['hours_alert']);
    expect(warnings({ ...base, hours: variance(100, 120), overdueMilestones: 2, endDate: '2026-10-01' }).map((w) => w.code)).toEqual(['hours_over', 'past_end', 'milestones_late']);
  });
  it('has no cost warnings unless cost figures were given', () => {
    expect(warnings({ ...base, hours: variance(100, 10), cost: variance(1000, 1100) }).map((w) => w.code)).toEqual(['cost_over']);
    expect(warnings({ ...base, hours: variance(100, 10) })).toEqual([]);
  });
});
