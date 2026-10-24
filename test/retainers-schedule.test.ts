import { describe, expect, it } from 'vitest';
import type { PlanFacts } from '../src/modules/retainers/schedule.js';
import { addMonths, duePeriods, mrrOn, nextInvoiceDate, periodEndOf, periodStartOf, periodsThrough } from '../src/modules/retainers/schedule.js';

const plan = (o: Partial<PlanFacts> = {}): PlanFacts => ({ startDate: '2026-01-01', endDate: null, cancelOn: null, interval: 'month', prorate: true, amounts: [{ effectiveFrom: o.startDate ?? '2026-01-01', amount: 3000 }], pauses: [], ...o });

describe('calendar periods', () => {
  it('months, quarters and years start on the calendar boundary', () => {
    expect(periodStartOf('2026-10-15', 'month')).toBe('2026-10-01');
    expect(periodStartOf('2026-11-30', 'quarter')).toBe('2026-10-01');
    expect(periodStartOf('2026-02-10', 'quarter')).toBe('2026-01-01');
    expect(periodStartOf('2026-07-04', 'year')).toBe('2026-01-01');
    expect(periodEndOf('2026-02-01', 'month')).toBe('2026-02-28');
    expect(periodEndOf('2028-02-01', 'month')).toBe('2028-02-29');
    expect(periodEndOf('2026-10-01', 'quarter')).toBe('2026-12-31');
    expect(periodEndOf('2026-01-01', 'year')).toBe('2026-12-31');
  });
  it('adding months keeps month-end dates at month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-02-28', 12)).toBe('2027-02-28');
    expect(addMonths('2026-12-31', 12)).toBe('2027-12-31');
    expect(addMonths('2026-03-15', -4)).toBe('2025-11-15');
  });
});

describe('proration of a partial first and last period', () => {
  it('a plan that starts mid-month pays for the days it covers; the next period is whole', () => {
    const p = periodsThrough(plan({ startDate: '2026-10-15' }), '2026-11-30');
    expect(p.map((x) => [x.label, x.coveredFrom, x.coveredTo, x.amount, x.prorated])).toEqual([['October 2026', '2026-10-15', '2026-10-31', 1645.16, true], ['November 2026', '2026-11-01', '2026-11-30', 3000, false]]);
  });
  it('quarters and years prorate by days in the period', () => {
    const q = periodsThrough(plan({ startDate: '2026-02-10', interval: 'quarter', amounts: [{ effectiveFrom: '2026-02-10', amount: 9000 }] }), '2026-02-10')[0]!;
    expect(q).toMatchObject({ label: 'Q1 2026', coveredFrom: '2026-02-10', coveredTo: '2026-03-31', prorated: true, amount: 5000 }); // 50 of 90 days
    const y = periodsThrough(plan({ startDate: '2026-07-01', endDate: '2027-03-31', interval: 'year', amounts: [{ effectiveFrom: '2026-07-01', amount: 12_000 }] }), '2027-06-01');
    expect(y.map((x) => [x.label, x.amount])).toEqual([['2026', 6049.32], ['2027', 2958.9]]); // 184/365 and 90/365
  });
  it('without proration a partial period is charged in full', () => {
    const p = periodsThrough(plan({ startDate: '2026-10-15', prorate: false }), '2026-10-31');
    expect(p[0]).toMatchObject({ amount: 3000, prorated: false });
  });
  it('a cancellation or term end mid-period prorates the last period and stops there', () => {
    const p = periodsThrough(plan({ cancelOn: '2026-03-10' }), '2026-12-31');
    expect(p.map((x) => x.label)).toEqual(['January 2026', 'February 2026', 'March 2026']);
    expect(p[2]).toMatchObject({ coveredTo: '2026-03-10', amount: 967.74, prorated: true }); // 10 of 31 days
    expect(periodsThrough(plan({ endDate: '2026-02-28', cancelOn: '2026-06-30' }), '2026-12-31')).toHaveLength(2); // the earlier of the two
  });
});

describe('amount changes, pauses, due periods', () => {
  it('a period uses the amount in force on its first day', () => {
    const p = plan({ amounts: [{ effectiveFrom: '2026-01-01', amount: 3000 }, { effectiveFrom: '2026-03-01', amount: 3500 }] });
    expect(periodsThrough(p, '2026-04-30').map((x) => x.amount)).toEqual([3000, 3000, 3500, 3500]);
  });
  it('periods that start inside a pause are skipped, not billed later', () => {
    const p = plan({ pauses: [{ from: '2026-02-10', to: '2026-04-01' }] });
    const through = periodsThrough(p, '2026-05-31');
    expect(through.map((x) => [x.label, x.skipped])).toEqual([['January 2026', null], ['February 2026', null], ['March 2026', 'paused'], ['April 2026', null], ['May 2026', null]]);
    expect(duePeriods(p, [{ periodStart: '2026-01-01', status: 'generated' }, { periodStart: '2026-02-01', status: 'generated' }], '2026-05-31').map((x) => x.label)).toEqual(['April 2026', 'May 2026']);
    expect(periodsThrough(plan({ pauses: [{ from: '2026-02-01', to: null }] }), '2026-06-30').filter((x) => !x.skipped).map((x) => x.label)).toEqual(['January 2026']);
  });
  it('a released period is due again but marked so the daily job leaves it alone', () => {
    const p = plan({ startDate: '2026-01-01', endDate: '2026-02-28' });
    const due = duePeriods(p, [{ periodStart: '2026-01-01', status: 'generated' }, { periodStart: '2026-02-01', status: 'released' }], '2026-06-01');
    expect(due.map((x) => [x.label, x.released])).toEqual([['February 2026', true]]);
  });
  it('the next invoice date is the first period without a live or released charge', () => {
    expect(nextInvoiceDate(plan(), [], '2026-03-10')).toBe('2026-01-01');
    expect(nextInvoiceDate(plan(), [{ periodStart: '2026-01-01', status: 'generated' }, { periodStart: '2026-02-01', status: 'generated' }, { periodStart: '2026-03-01', status: 'generated' }], '2026-03-10')).toBe('2026-04-01');
    expect(nextInvoiceDate(plan({ endDate: '2026-01-31' }), [{ periodStart: '2026-01-01', status: 'generated' }], '2026-03-10')).toBeNull();
  });
});

describe('monthly recurring revenue arithmetic', () => {
  it('normalises each interval to a month', () => {
    expect(mrrOn(plan(), '2026-05-05')).toBe(3000);
    expect(mrrOn(plan({ interval: 'quarter', amounts: [{ effectiveFrom: '2026-01-01', amount: 9000 }] }), '2026-05-05')).toBe(3000);
    expect(mrrOn(plan({ interval: 'year', amounts: [{ effectiveFrom: '2026-01-01', amount: 12_000 }] }), '2026-05-05')).toBe(1000);
  });
  it('counts nothing before the start, after the last day, or while paused; follows amount changes', () => {
    const p = plan({ startDate: '2026-02-01', cancelOn: '2026-08-31', pauses: [{ from: '2026-05-01', to: '2026-06-01' }], amounts: [{ effectiveFrom: '2026-02-01', amount: 3000 }, { effectiveFrom: '2026-07-01', amount: 3600 }] });
    expect([mrrOn(p, '2026-01-31'), mrrOn(p, '2026-02-01'), mrrOn(p, '2026-05-15'), mrrOn(p, '2026-06-01'), mrrOn(p, '2026-07-01'), mrrOn(p, '2026-08-31'), mrrOn(p, '2026-09-01')]).toEqual([0, 3000, 0, 3000, 3600, 3600, 0]);
  });
});
