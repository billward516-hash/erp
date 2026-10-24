import { describe, expect, it } from 'vitest';
import type { PersonCalendar } from '../src/modules/staffing/capacity.js';
import { bookedInWeek, classify, dayHours, rangeHours, resolveTarget, utilizationOf, weekCell, weekStartOf } from '../src/modules/staffing/capacity.js';

/** Capacity arithmetic (D-188C): working patterns, holidays, time off, partial weeks, over-allocation, targets. No database. */
const W = '2026-09-07'; // a Monday
const day = (n: number) => new Date(Date.parse(`${W}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cal = (over: Partial<PersonCalendar> = {}): PersonCalendar => ({ defaultHours: [8, 8, 8, 8, 8, 0, 0], patterns: [], holidays: new Map(), timeOff: [], ...over });

describe('available hours', () => {
  it('is the company default week when a person has no pattern of their own', () => {
    expect(rangeHours(cal(), W, day(6))).toEqual({ scheduled: 40, holiday: 0, timeOff: 0, available: 40 });
    expect(dayHours(cal(), day(5)).available).toBe(0); // Saturday
    expect(weekStartOf(day(3))).toBe(W);
  });

  it('follows the person\'s own pattern from its effective date, and the earlier pattern before it', () => {
    const c = cal({ patterns: [{ effectiveFrom: '2026-01-01', hours: [8, 8, 8, 8, 0, 0, 0] }, { effectiveFrom: day(3), hours: [4, 4, 4, 4, 4, 0, 0] }] });
    expect(rangeHours(c, W, day(2)).available).toBe(24); // Mon-Wed on the 8-hour, four-day pattern
    expect(dayHours(c, day(3)).scheduled).toBe(4); // Thursday: the new pattern has started
    expect(dayHours(c, day(4)).scheduled).toBe(4); // Friday, now a working day
    expect(rangeHours(c, W, day(6)).available).toBe(24 + 8);
    expect(rangeHours(cal({ patterns: [{ effectiveFrom: '2027-01-01', hours: [0, 0, 0, 0, 0, 0, 0] }] }), W, day(6)).available).toBe(40); // not yet in force
  });

  it('takes off a whole-day or part-day company holiday, and never goes below zero', () => {
    expect(rangeHours(cal({ holidays: new Map([[day(2), null]]) }), W, day(6))).toMatchObject({ holiday: 8, available: 32 });
    expect(rangeHours(cal({ holidays: new Map([[day(2), 4]]) }), W, day(6))).toMatchObject({ holiday: 4, available: 36 });
    expect(dayHours(cal({ holidays: new Map([[day(5), null]]) }), day(5))).toMatchObject({ holiday: 0, available: 0 }); // a holiday on a day off costs nothing
  });

  it('takes off time off after the holiday, whole or part days, without counting overlapping time off twice', () => {
    const c = cal({ holidays: new Map([[day(1), null]]), timeOff: [{ from: day(0), to: day(2), hoursPerDay: null }, { from: day(1), to: day(1), hoursPerDay: 8 }, { from: day(4), to: day(4), hoursPerDay: 3 }] });
    // Mon off (8), Tue holiday (8, so time off adds nothing), Wed off (8), Thu works, Fri 3 h off.
    expect(rangeHours(c, W, day(6))).toEqual({ scheduled: 40, holiday: 8, timeOff: 19, available: 13 });
  });
});

describe('booked hours', () => {
  const full = { hoursPerWeek: 40, start: '2026-01-01', end: '2026-12-31', state: 'confirmed' as const };
  it('puts the planned hours on a whole week as they are', () => {
    expect(bookedInWeek(cal(), full, W)).toBe(40);
    expect(bookedInWeek(cal(), full, day(7))).toBe(40);
    expect(bookedInWeek(cal(), { ...full, start: '2027-01-01' }, W)).toBe(0);
  });
  it('takes the share of a part week: starting on Wednesday, ending on Tuesday', () => {
    expect(bookedInWeek(cal(), { ...full, start: day(2) }, W)).toBe(24); // Wed-Fri = 3 of 5 days
    expect(bookedInWeek(cal(), { ...full, end: day(1) }, W)).toBe(16); // Mon-Tue
    expect(bookedInWeek(cal(), { ...full, start: day(5), end: day(6) }, W)).toBe(0); // a weekend only
    expect(bookedInWeek(cal(), { ...full, hoursPerWeek: 20, start: day(2), end: day(2) }, W)).toBe(4); // one day of a 20 h week
  });
  it('shrinks with a company holiday but not with personal time off', () => {
    expect(bookedInWeek(cal({ holidays: new Map([[day(3), null]]) }), full, W)).toBe(32);
    expect(bookedInWeek(cal({ timeOff: [{ from: day(0), to: day(1), hoursPerDay: null }] }), full, W)).toBe(40);
  });
});

describe('the week cell', () => {
  const b = (hoursPerWeek: number, state: 'tentative' | 'confirmed', start = '2026-01-01', end = '2026-12-31') => ({ hoursPerWeek, start, end, state });
  it('says unbooked, part booked, fully booked and over, with a text label each time', () => {
    expect(weekCell(cal(), [], W)).toMatchObject({ available: 40, booked: 0, status: 'unbooked', label: 'Unbooked', free: 40, over: 0 });
    expect(weekCell(cal(), [b(24, 'confirmed')], W)).toMatchObject({ booked: 24, status: 'partial', label: 'Part booked', free: 16 });
    expect(weekCell(cal(), [b(40, 'confirmed')], W)).toMatchObject({ status: 'full', label: 'Fully booked', free: 0 });
    expect(weekCell(cal(), [b(30, 'confirmed'), b(20, 'tentative')], W)).toMatchObject({ confirmed: 30, tentative: 20, booked: 50, over: 10, status: 'over', label: 'Over-allocated' });
  });
  it('is over-allocated when time off leaves less capacity than the booking, and "not working" when there is no capacity and no booking', () => {
    const off = cal({ timeOff: [{ from: day(0), to: day(1), hoursPerDay: null }] });
    expect(weekCell(off, [b(40, 'confirmed')], W)).toMatchObject({ available: 24, booked: 40, over: 16, status: 'over' });
    const away = cal({ timeOff: [{ from: day(0), to: day(6), hoursPerDay: null }] });
    expect(weekCell(away, [], W)).toMatchObject({ available: 0, status: 'off', label: 'Not working' });
  });
  it('a holiday week with a full-time booking is not a conflict', () => {
    expect(weekCell(cal({ holidays: new Map([[day(0), null]]) }), [b(40, 'confirmed')], W)).toMatchObject({ available: 32, booked: 32, status: 'full' });
  });
  it('ignores a half hour over by default and honours a different tolerance', () => {
    expect(classify(40, 40.4)).toBe('full');
    expect(classify(40, 40.6)).toBe('over');
    expect(classify(40, 41, 2)).toBe('full');
  });
});

describe('utilization and targets', () => {
  it('is billable over available, and nothing when nothing is available', () => {
    expect(utilizationOf(24, 32)).toBe(0.75);
    expect(utilizationOf(10, 0)).toBeNull();
    expect(utilizationOf(0, 40)).toBe(0);
  });
  it('resolves a person\'s target: their own, then their job title\'s, then the company\'s', () => {
    const targets = [{ kind: 'job_title' as const, employeeId: null, jobTitle: 'Senior Consultant', targetPct: 80 }, { kind: 'employee' as const, employeeId: 'e1', jobTitle: null, targetPct: 60 }];
    expect(resolveTarget({ id: 'e1', jobTitle: 'Senior Consultant' }, targets, 70)).toEqual({ pct: 60, source: 'person' });
    expect(resolveTarget({ id: 'e2', jobTitle: ' senior consultant ' }, targets, 70)).toEqual({ pct: 80, source: 'role' });
    expect(resolveTarget({ id: 'e3', jobTitle: 'Analyst' }, targets, 70)).toEqual({ pct: 70, source: 'company' });
    expect(resolveTarget({ id: 'e4', jobTitle: null }, targets, 70)).toEqual({ pct: 70, source: 'company' });
  });
});
