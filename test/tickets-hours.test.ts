import { describe, expect, it } from 'vitest';
import type { BusinessCalendar } from '../src/modules/tickets/hours.js';
import { DEFAULT_DAYS, addBusinessMinutes, businessMinutesBetween, isBusinessTime, parseDays } from '../src/modules/tickets/hours.js';
import type { ClockState, Targets } from '../src/modules/tickets/sla.js';
import { advance, blankClock, timerState, usedMinutes } from '../src/modules/tickets/sla.js';

/**
 * Business-hours arithmetic and the service-level clock, with no database. 2026-10-23 is a Friday and 2026-10-26 the Monday after;
 * New York is on daylight time (UTC-4) until Sunday 2026-11-01, then on standard time (UTC-5).
 */
const cal = (timeZone = 'America/New_York', holidays: string[] = [], days = DEFAULT_DAYS): BusinessCalendar => ({ timeZone, days, holidays: new Set(holidays) });
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();
const NY = cal();

describe('business minutes between two moments', () => {
  it('counts only the hours the business is open', () => {
    expect(businessMinutesBetween(NY, at('2026-10-23T13:00:00Z'), at('2026-10-23T21:00:00Z'))).toBe(480);        // Fri 09:00 to 17:00 EDT
    expect(businessMinutesBetween(NY, at('2026-10-23T11:00:00Z'), at('2026-10-23T23:00:00Z'))).toBe(480);        // before opening and after closing do not count
    expect(businessMinutesBetween(NY, at('2026-10-23T20:00:00Z'), at('2026-10-26T14:00:00Z'))).toBe(120);        // Fri 16:00 to Mon 10:00: an hour on each side of the weekend
    expect(businessMinutesBetween(NY, at('2026-10-24T14:00:00Z'), at('2026-10-25T20:00:00Z'))).toBe(0);          // all weekend
    expect(businessMinutesBetween(NY, at('2026-10-26T14:00:00Z'), at('2026-10-26T13:00:00Z'))).toBe(0);          // end before start
  });

  it('skips holidays', () => {
    // Monday 26 October closed: Friday 16:00 to Tuesday 10:00 is one hour on Friday and one on Tuesday
    expect(businessMinutesBetween(cal('America/New_York', ['2026-10-26']), at('2026-10-23T20:00:00Z'), at('2026-10-27T14:00:00Z'))).toBe(120);
    expect(businessMinutesBetween(NY, at('2026-10-26T04:00:00Z'), at('2026-11-02T04:00:00Z'))).toBe(5 * 480);    // a whole week
    expect(businessMinutesBetween(cal('America/New_York', ['2026-10-28']), at('2026-10-26T04:00:00Z'), at('2026-11-02T04:00:00Z'))).toBe(4 * 480);
  });

  it('reads the hours in the site’s time zone', () => {
    // The same instant, 20:00 UTC on Friday, is 16:00 in New York, 13:00 in Los Angeles and 01:30 on Saturday in Kolkata.
    const t = at('2026-10-23T20:00:00Z');
    expect(isBusinessTime(NY, t)).toBe(true);
    expect(isBusinessTime(cal('America/Los_Angeles'), t)).toBe(true);
    expect(isBusinessTime(cal('Asia/Kolkata'), t)).toBe(false);
    expect(businessMinutesBetween(cal('America/Los_Angeles'), t, at('2026-10-24T00:00:00Z'))).toBe(240);          // 13:00 to 17:00 PDT
    expect(businessMinutesBetween(cal('Asia/Kolkata'), at('2026-10-23T03:30:00Z'), at('2026-10-23T11:30:00Z'))).toBe(480); // 09:00 to 17:00 IST
    // 02:00 UTC Monday is still Sunday evening in New York, so it is not Monday's business day yet.
    expect(businessMinutesBetween(NY, at('2026-10-26T02:00:00Z'), at('2026-10-26T14:00:00Z'))).toBe(60);          // opens 09:00 EDT = 13:00Z
  });

  it('follows the clocks changing: a day around the end of daylight time is 25 hours long', () => {
    const allDay = cal('America/New_York', [], { ...DEFAULT_DAYS, 7: ['00:00', '24:00'] });
    expect(businessMinutesBetween(allDay, at('2026-11-01T04:00:00Z'), at('2026-11-02T05:00:00Z'))).toBe(25 * 60); // Sunday 1 November 00:00 EDT to Monday 00:00 EST
    // Friday 30 October 16:00 EDT + 8 hours: 1 hour Friday, then Monday 2 November on standard time (UTC-5): 09:00 + 7 hours = 16:00 EST = 21:00Z.
    expect(iso(addBusinessMinutes(NY, at('2026-10-30T20:00:00Z'), 480))).toBe('2026-11-02T21:00:00.000Z');
  });
});

describe('adding business minutes', () => {
  it('runs across the weekend', () => {
    expect(iso(addBusinessMinutes(NY, at('2026-10-23T20:00:00Z'), 120))).toBe('2026-10-26T14:00:00.000Z');       // Fri 16:00 + 2h = Mon 10:00
    expect(iso(addBusinessMinutes(NY, at('2026-10-23T20:00:00Z'), 60))).toBe('2026-10-23T21:00:00.000Z');        // exactly at closing
    expect(iso(addBusinessMinutes(NY, at('2026-10-23T13:00:00Z'), 0))).toBe('2026-10-23T13:00:00.000Z');
  });

  it('starts counting when the business opens if the ticket arrives outside hours', () => {
    expect(iso(addBusinessMinutes(NY, at('2026-10-24T15:00:00Z'), 30))).toBe('2026-10-26T13:30:00.000Z');        // Saturday 11:00 + 30 min = Monday 09:30
    expect(iso(addBusinessMinutes(NY, at('2026-10-23T23:00:00Z'), 60))).toBe('2026-10-26T14:00:00.000Z');        // Friday 19:00 + 1h = Monday 10:00
    expect(iso(addBusinessMinutes(NY, at('2026-10-26T11:00:00Z'), 15))).toBe('2026-10-26T13:15:00.000Z');        // Monday 07:00 (before opening)
  });

  it('skips a holiday and a long weekend', () => {
    expect(iso(addBusinessMinutes(cal('America/New_York', ['2026-10-26']), at('2026-10-23T20:00:00Z'), 120))).toBe('2026-10-27T14:00:00.000Z'); // Tue 10:00
    expect(iso(addBusinessMinutes(cal('America/New_York', ['2026-10-26', '2026-10-27']), at('2026-10-23T20:00:00Z'), 120))).toBe('2026-10-28T14:00:00.000Z');
  });

  it('can go backwards, which is how a target that has already passed is dated', () => {
    expect(iso(addBusinessMinutes(NY, at('2026-10-26T14:00:00Z'), -120))).toBe('2026-10-23T20:00:00.000Z');       // Mon 10:00 - 2h = Fri 16:00
    expect(iso(addBusinessMinutes(NY, at('2026-10-24T15:00:00Z'), -30))).toBe('2026-10-23T20:30:00.000Z');       // Saturday back to Friday 16:30
    // the round trip holds for many offsets
    for (const m of [1, 59, 480, 481, 1000, 2400, 5000]) {
      const start = at('2026-10-27T15:17:00Z');
      expect(+addBusinessMinutes(NY, addBusinessMinutes(NY, start, m), -m)).toBe(+start);
    }
  });

  it('refuses a calendar with no open day', () => {
    expect(() => addBusinessMinutes(cal('UTC', [], { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null }), at('2026-10-26T10:00:00Z'), 5)).toThrow(/no open day/);
    expect(() => parseDays({ 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null })).toThrow(/at least one weekday/);
  });

  it('checks the hours people type', () => {
    expect(parseDays({ 1: ['08:00', '18:00'], 2: null, 3: null, 4: null, 5: null, 6: ['10:00', '24:00'], 7: null })[6]).toEqual(['10:00', '24:00']);
    expect(() => parseDays({ 1: ['17:00', '09:00'] })).toThrow(/after the start/);
    expect(() => parseDays({ 1: ['9:00', '17:00'] })).toThrow(/HH:MM/);
    expect(() => parseDays({ 1: ['09:00', '25:00'] })).toThrow(/HH:MM/);
  });
});

// ---------------------------------------------------------------------------
// The clock of one ticket
// ---------------------------------------------------------------------------

/** First response in 60 business minutes, resolution in 480 (one business day), at risk at 80%. */
const T: Targets = { firstResponse: 60, resolution: 480, atRiskPct: 80 };
const start = (c = NY, now = '2026-10-26T13:00:00Z', targets = T) => advance(c, blankClock(targets), { status: 'new' }, at(now));   // Monday 09:00 EDT

describe('the clock of a ticket', () => {
  it('computes the due and at-risk times when the ticket is raised', () => {
    const s = start();
    expect(s.status).toBe('new');
    expect(iso(s.firstDueAt!)).toBe('2026-10-26T14:00:00.000Z');       // 10:00
    expect(iso(s.firstRiskAt!)).toBe('2026-10-26T13:48:00.000Z');      // 80% of 60 = 48 minutes
    expect(iso(s.resolutionDueAt!)).toBe('2026-10-26T21:00:00.000Z');  // 17:00 the same day
    expect(iso(s.resolutionRiskAt!)).toBe('2026-10-26T19:24:00.000Z'); // 384 minutes in: 15:24
  });

  it('measures from the opening when the ticket arrives on a Friday evening, across the weekend', () => {
    const s = start(NY, '2026-10-23T22:00:00Z', { firstResponse: 120, resolution: 960, atRiskPct: 80 });  // Friday 18:00, after closing
    expect(iso(s.firstDueAt!)).toBe('2026-10-26T15:00:00.000Z');       // Monday 09:00 + 2h = 11:00
    expect(iso(s.resolutionDueAt!)).toBe('2026-10-27T21:00:00.000Z');  // two business days: Tuesday 17:00
  });

  it('pauses while waiting on the customer and picks up with the minutes that were left', () => {
    let s = start();
    s = advance(NY, s, { status: 'waiting_customer' }, at('2026-10-26T13:30:00Z'));       // 30 minutes used
    expect(s.runningSince).toBeNull();
    expect(s.firstDueAt).toBeNull();                                                      // nothing is due while paused
    expect(s.resolutionDueAt).toBeNull();
    expect(usedMinutes(NY, s, at('2026-10-28T15:00:00Z'))).toBe(30);                       // two days of waiting add nothing
    s = advance(NY, s, { status: 'open' }, at('2026-10-27T14:00:00Z'));                    // Tuesday 10:00
    expect(iso(s.firstDueAt!)).toBe('2026-10-27T14:30:00.000Z');                           // the 30 minutes left
    expect(iso(s.resolutionDueAt!)).toBe('2026-10-28T13:30:00.000Z');                      // 450 left: 420 on Tuesday, 30 on Wednesday: 09:30
  });

  it('a wait over a weekend and a holiday costs nothing, and a third-party wait pauses the same way', () => {
    const c = cal('America/New_York', ['2026-10-26']);
    let s = start(c, '2026-10-23T20:00:00Z');                                              // Friday 16:00 (60 minutes left in the day)
    s = advance(c, s, { status: 'waiting_third_party' }, at('2026-10-23T20:20:00Z'));      // 20 minutes used
    s = advance(c, s, { status: 'open' }, at('2026-10-28T13:00:00Z'));                     // Wednesday 09:00, after the weekend and the Monday holiday
    expect(usedMinutes(c, s, at('2026-10-28T13:00:00Z'))).toBe(20);
    expect(iso(s.firstDueAt!)).toBe('2026-10-28T13:40:00.000Z');                           // 40 left
  });

  it('keeps a target that ran out before the pause as already passed', () => {
    let s = start(NY, '2026-10-26T13:00:00Z', { firstResponse: 30, resolution: 480, atRiskPct: 80 });
    s = advance(NY, s, { status: 'waiting_customer' }, at('2026-10-26T13:45:00Z'));        // 45 minutes used against a 30-minute target
    expect(iso(s.firstDueAt!)).toBe('2026-10-26T13:30:00.000Z');                           // the moment it ran out
    expect(timerState({ target: 30, done: false, missed: null, due: s.firstDueAt, risk: s.firstRiskAt, paused: true }, at('2026-10-27T13:00:00Z'))).toBe('breached');
    expect(s.resolutionDueAt).toBeNull();                                                  // the resolution timer is merely paused
  });

  it('a reply the customer can see stops the first-response timer; late is missed, in time is met', () => {
    const early = advance(NY, start(), { responded: true, status: 'open' }, at('2026-10-26T13:45:00Z'));
    expect(early.firstRespondedAt).toEqual(at('2026-10-26T13:45:00Z'));
    expect(early.firstResponseMissed).toBe(false);
    const onTheDot = advance(NY, start(), { responded: true, status: 'open' }, at('2026-10-26T14:00:00Z'));
    expect(onTheDot.firstResponseMissed).toBe(false);                                      // exactly 60 minutes is still on time
    const late = advance(NY, start(), { responded: true, status: 'open' }, at('2026-10-26T14:01:00Z'));
    expect(late.firstResponseMissed).toBe(true);
    // the minutes before a weekend do not count against the reply that comes on Monday
    const fri = start(NY, '2026-10-23T20:30:00Z');                                          // Friday 16:30, 30 minutes left in the day
    const mon = advance(NY, fri, { responded: true, status: 'open' }, at('2026-10-26T13:20:00Z'));  // Monday 09:20: 30 + 20 = 50 minutes
    expect(mon.firstResponseMissed).toBe(false);
  });

  it('resolving without any reply counts as the answer, and judges the resolution target', () => {
    const s = advance(NY, start(), { status: 'resolved' }, at('2026-10-26T15:00:00Z'));    // 120 minutes in
    expect(s.firstRespondedAt).not.toBeNull();
    expect(s.firstResponseMissed).toBe(true);                                              // 120 > 60
    expect(s.resolutionMissed).toBe(false);                                                // 120 <= 480
    expect(s.runningSince).toBeNull();
    const late = advance(NY, start(), { status: 'resolved' }, at('2026-10-27T14:00:00Z')); // Tuesday 10:00 = 480 + 60
    expect(late.resolutionMissed).toBe(true);
  });

  it('reopening gives a fresh resolution timer and leaves the first-response result alone', () => {
    let s = advance(NY, start(), { responded: true, status: 'open' }, at('2026-10-26T13:30:00Z'));
    s = advance(NY, s, { status: 'resolved' }, at('2026-10-26T14:00:00Z'));                // 60 minutes used
    const missedBefore = s.firstResponseMissed;
    s = advance(NY, s, { status: 'reopened' }, at('2026-10-27T13:00:00Z'));                // Tuesday 09:00
    expect(s.resolvedAt).toBeNull();
    expect(s.resolutionBase).toBe(60);
    expect(iso(s.resolutionDueAt!)).toBe('2026-10-27T21:00:00.000Z');                      // a whole new 480 minutes
    expect(s.firstResponseMissed).toBe(missedBefore);
    expect(s.firstRespondedAt).toEqual(at('2026-10-26T13:30:00Z'));
  });

  it('a new priority brings new targets measured against the minutes already used', () => {
    let s = start(NY, '2026-10-26T13:00:00Z', { firstResponse: 480, resolution: 2400, atRiskPct: 80 });
    s = advance(NY, s, { targets: { firstResponse: 30, resolution: 120, atRiskPct: 80 } }, at('2026-10-26T14:00:00Z'));   // 60 minutes used
    expect(iso(s.firstDueAt!)).toBe('2026-10-26T13:30:00.000Z');                           // already in the past: breached
    expect(timerState({ target: 30, done: false, missed: null, due: s.firstDueAt, risk: s.firstRiskAt, paused: false }, at('2026-10-26T14:00:00Z'))).toBe('breached');
    expect(iso(s.resolutionDueAt!)).toBe('2026-10-26T15:00:00.000Z');                      // 60 more minutes
  });

  it('has no timers when no target is set', () => {
    const s = start(NY, '2026-10-26T13:00:00Z', { firstResponse: null, resolution: null, atRiskPct: 80 });
    expect(s.firstDueAt).toBeNull(); expect(s.resolutionDueAt).toBeNull();
    expect(timerState({ target: null, done: false, missed: null, due: null, risk: null, paused: false }, new Date())).toBe('none');
  });
});

describe('breach and at-risk states carry a text label', () => {
  const s: ClockState = start();
  const state = (now: string) => timerState({ target: 60, done: false, missed: null, due: s.firstDueAt, risk: s.firstRiskAt, paused: false }, at(now));
  it('moves from on track to at risk to breached as time passes', () => {
    expect(state('2026-10-26T13:30:00Z')).toBe('on_track');
    expect(state('2026-10-26T13:48:00Z')).toBe('at_risk');       // 80% used
    expect(state('2026-10-26T14:00:00Z')).toBe('at_risk');       // exactly at the target is not yet late
    expect(state('2026-10-26T14:00:01Z')).toBe('breached');
  });
  it('shows paused for a quiet paused timer and met or missed once judged', () => {
    expect(timerState({ target: 60, done: false, missed: null, due: null, risk: null, paused: true }, new Date())).toBe('paused');
    expect(timerState({ target: 60, done: true, missed: false, due: s.firstDueAt, risk: null, paused: false }, new Date())).toBe('met');
    expect(timerState({ target: 60, done: true, missed: true, due: s.firstDueAt, risk: null, paused: false }, new Date())).toBe('missed');
  });
});
