import { ASSET_STATES, computeUtilization } from '../assets/utilization.js';
import type { AssetState, StateInterval } from '../assets/utilization.js';

/**
 * SEMI E10-style grouping of the platform's asset states (D-184B). The platform keeps its six states; this maps them to the six
 * E10 time groups for reporting. It is a mapping for reading the state history the way E10 describes tool time, not a claim that
 * the platform is certified to SEMI E10, and the company confirms the mapping suits its own definitions.
 *
 *   running                       -> productive          (operated, producing)
 *   available, idle               -> standby             (able to run, not running)
 *   available/running/idle flagged engineering -> engineering   (trials, process work, qualification runs)
 *   planned_downtime              -> scheduled downtime  (PM, planned repair, setup)
 *   unplanned_downtime            -> unscheduled downtime
 *   out_of_service                -> non-scheduled time  (not scheduled for use: installation, rebuild, shutdown)
 * Time with no state record is reported as "not recorded", never assigned to a group.
 */
export const E10_GROUPS = ['productive', 'standby', 'engineering', 'scheduled_downtime', 'unscheduled_downtime', 'non_scheduled'] as const;
export type E10Group = (typeof E10_GROUPS)[number];
export const E10_LABEL: Record<E10Group, string> = {
  productive: 'Productive', standby: 'Standby', engineering: 'Engineering', scheduled_downtime: 'Scheduled downtime', unscheduled_downtime: 'Unscheduled downtime', non_scheduled: 'Non-scheduled',
};
export const E10_OF_STATE: Record<AssetState, E10Group> = {
  running: 'productive', available: 'standby', idle: 'standby', planned_downtime: 'scheduled_downtime', unplanned_downtime: 'unscheduled_downtime', out_of_service: 'non_scheduled',
};
export const e10GroupOf = (state: AssetState, engineering = false): E10Group => (engineering && ['available', 'running', 'idle'].includes(state) ? 'engineering' : E10_OF_STATE[state]);

export interface ToolStateInterval extends StateInterval { engineering?: boolean }
export interface ToolStates {
  calendarHours: number;
  recordedHours: number;
  unrecordedHours: number;
  hours: Record<E10Group, number>;
  /** Each group's share of the calendar window; null when the window has no length. */
  percentOfCalendar: Record<E10Group, number | null>;
  /** Share of recorded time (the six groups sum to 1). */
  percentOfRecorded: Record<E10Group, number | null>;
  coverage: number | null;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Hours in each E10 group over a window, from state intervals (reuses the utilization clipping of open intervals to now). */
export function computeToolStates(intervals: ToolStateInterval[], from: Date, to: Date, opts: { now?: Date } = {}): ToolStates {
  const plain = computeUtilization(intervals.filter((i) => !i.engineering), from, to, opts);
  const eng = computeUtilization(intervals.filter((i) => i.engineering), from, to, opts);
  const hours = Object.fromEntries(E10_GROUPS.map((g) => [g, 0])) as Record<E10Group, number>;
  for (const s of ASSET_STATES) hours[E10_OF_STATE[s]] += plain.hoursByState[s];
  for (const s of ASSET_STATES) hours.engineering += eng.hoursByState[s];
  for (const g of E10_GROUPS) hours[g] = round(hours[g]);
  const recorded = round(E10_GROUPS.reduce((a, g) => a + hours[g], 0));
  const calendar = plain.calendarHours;
  const share = (n: number, d: number) => (d > 0 ? round(n / d, 4) : null);
  return {
    calendarHours: calendar, recordedHours: recorded, unrecordedHours: round(calendar - recorded), hours,
    percentOfCalendar: Object.fromEntries(E10_GROUPS.map((g) => [g, share(hours[g], calendar)])) as Record<E10Group, number | null>,
    percentOfRecorded: Object.fromEntries(E10_GROUPS.map((g) => [g, share(hours[g], recorded)])) as Record<E10Group, number | null>,
    coverage: share(recorded, calendar),
  };
}
