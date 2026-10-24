import type { BusinessCalendar } from './hours.js';
import { addBusinessMinutes, businessMinutesBetween } from './hours.js';

/**
 * The service-level clock of one ticket (SC-009 P4), as pure arithmetic over a business-hours calendar.
 *
 * - The clock runs while the ticket is new, open or reopened, pauses while it waits on the customer or a third party, and stops when it
 *   is resolved or closed. Only business minutes count (see hours.ts).
 * - `elapsed` is the business minutes counted up to `runningSince`; the first-response timer measures elapsed since the ticket was
 *   raised, the resolution timer elapsed since the last (re)opening (`resolutionBase`).
 * - Due times (and the "at risk" moments, at `atRiskPct` of a target) are recomputed on every change of status or targets and stored,
 *   so a list can filter them in SQL. While the clock is paused a timer has no due time, unless it had already run out.
 * - The first-response timer stops at the first reply the customer can see (resolving counts as an answer too). A reopened ticket gets a
 *   fresh resolution timer; the first-response result is not reopened.
 */
export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATUSES = ['new', 'open', 'waiting_customer', 'waiting_third_party', 'resolved', 'closed', 'reopened'] as const;
export type Status = (typeof STATUSES)[number];
export const RUNNING = new Set<string>(['new', 'open', 'reopened']);
export const PAUSED = new Set<string>(['waiting_customer', 'waiting_third_party']);
export const STOPPED = new Set<string>(['resolved', 'closed']);
export const OPEN_STATUSES = ['new', 'open', 'waiting_customer', 'waiting_third_party', 'reopened'] as const;

export interface Targets { firstResponse: number | null; resolution: number | null; atRiskPct: number }
export interface ClockState {
  status: Status;
  runningSince: Date | null;
  elapsed: number;
  resolutionBase: number;
  targets: Targets;
  firstRespondedAt: Date | null; firstResponseMissed: boolean | null;
  resolvedAt: Date | null; resolutionMissed: boolean | null;
  firstDueAt: Date | null; firstRiskAt: Date | null;
  resolutionDueAt: Date | null; resolutionRiskAt: Date | null;
}
export interface ClockEvent {
  status?: Status;
  /** New targets (a priority change); the timers are recomputed against the minutes already used. */
  targets?: Targets;
  /** A reply the customer can see was sent now. */
  responded?: boolean;
}

export const blankClock = (targets: Targets): ClockState => ({
  status: 'new', runningSince: null, elapsed: 0, resolutionBase: 0, targets, firstRespondedAt: null, firstResponseMissed: null, resolvedAt: null, resolutionMissed: null,
  firstDueAt: null, firstRiskAt: null, resolutionDueAt: null, resolutionRiskAt: null,
});

/** Business minutes used so far (the clock's elapsed total at `now`). */
export function usedMinutes(cal: BusinessCalendar, s: ClockState, now: Date) {
  return s.elapsed + (s.runningSince ? businessMinutesBetween(cal, s.runningSince, now) : 0);
}

/** One timer's due and at-risk moments from the minutes already used. */
function plan(cal: BusinessCalendar, target: number | null, pct: number, used: number, running: boolean, now: Date): [Date | null, Date | null] {
  if (target == null) return [null, null];
  const left = target - used;
  const riskLeft = (target * pct) / 100 - used;
  if (running) return [addBusinessMinutes(cal, now, left), addBusinessMinutes(cal, now, riskLeft)];
  // Paused: nothing is due while the clock is stopped, unless the time had already run out before it paused.
  return [left > 0 ? null : addBusinessMinutes(cal, now, left), riskLeft > 0 ? null : addBusinessMinutes(cal, now, riskLeft)];
}

/** Moves the clock to `now` with an event (a status change, new targets, a reply) and returns the new state. */
export function advance(cal: BusinessCalendar, s: ClockState, ev: ClockEvent, now: Date): ClockState {
  const used = usedMinutes(cal, s, now);
  const status = ev.status ?? s.status;
  const next: ClockState = { ...s, status, elapsed: used, targets: ev.targets ?? s.targets };
  if (STOPPED.has(s.status) && RUNNING.has(status)) {
    next.resolutionBase = used; next.resolvedAt = null; next.resolutionMissed = null;
    next.resolutionDueAt = null; next.resolutionRiskAt = null;
  }
  const stopping = STOPPED.has(status);
  if ((ev.responded || stopping) && !next.firstRespondedAt) {
    next.firstRespondedAt = now;
    next.firstResponseMissed = next.targets.firstResponse != null && used > next.targets.firstResponse;
  }
  if (stopping && !next.resolvedAt) {
    next.resolvedAt = now;
    next.resolutionMissed = next.targets.resolution != null && used - next.resolutionBase > next.targets.resolution;
  }
  const running = RUNNING.has(status);
  next.runningSince = running ? now : null;
  if (stopping) return next;
  if (!next.firstRespondedAt) [next.firstDueAt, next.firstRiskAt] = plan(cal, next.targets.firstResponse, next.targets.atRiskPct, used, running, now);
  [next.resolutionDueAt, next.resolutionRiskAt] = plan(cal, next.targets.resolution, next.targets.atRiskPct, used - next.resolutionBase, running, now);
  return next;
}

export type TimerState = 'none' | 'met' | 'missed' | 'breached' | 'at_risk' | 'paused' | 'on_track';
export const TIMER_LABEL: Record<TimerState, string> = { none: 'No target', met: 'Met', missed: 'Missed', breached: 'Breached', at_risk: 'At risk', paused: 'Paused', on_track: 'On track' };

/** Where one timer stands now. Breached = still open and past its due time; missed = answered or resolved too late. */
export function timerState(t: { target: number | null; done: boolean; missed: boolean | null; due: Date | null; risk: Date | null; paused: boolean }, now: Date): TimerState {
  if (t.target == null) return 'none';
  if (t.done) return t.missed ? 'missed' : 'met';
  if (t.due && +t.due < +now) return 'breached';
  if (t.risk && +t.risk <= +now) return 'at_risk';
  return t.paused ? 'paused' : 'on_track';
}
