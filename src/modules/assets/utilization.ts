/**
 * Deterministic utilization/availability calculation from asset state intervals.
 *
 * Definitions (configurable basis, see docs/ARCHITECTURE.md §Utilization):
 *   calendar time   = the reporting window
 *   recorded time   = portion of the window covered by state records (coverage)
 *   scheduled time  = recorded time − planned downtime − out-of-service time
 *   availability    = (scheduled − unplanned downtime) / scheduled
 *   utilization     = running / basis, where basis is 'calendar' or 'scheduled'
 *
 * Gaps with no state record are reported as `unrecordedHours`, never treated as running or idle,
 * and ratios are null (not 0) when their denominator is zero. OEE is intentionally not computed:
 * it requires validated performance and quality data this slice does not capture.
 */
export const ASSET_STATES = ['available', 'running', 'idle', 'planned_downtime', 'unplanned_downtime', 'out_of_service'] as const;
export type AssetState = (typeof ASSET_STATES)[number];

export interface StateInterval {
  state: AssetState;
  startedAt: Date;
  endedAt: Date | null;
}

export interface UtilizationResult {
  windowStart: string;
  windowEnd: string;
  calendarHours: number;
  recordedHours: number;
  unrecordedHours: number;
  coverage: number | null;
  hoursByState: Record<AssetState, number>;
  scheduledHours: number;
  availability: number | null;
  utilization: number | null;
  basis: 'calendar' | 'scheduled';
  unplannedStops: number;
}

const HOUR = 3_600_000;
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

export function computeUtilization(
  intervals: StateInterval[],
  windowStart: Date,
  windowEnd: Date,
  opts: { basis?: 'calendar' | 'scheduled'; now?: Date } = {},
): UtilizationResult {
  if (windowEnd <= windowStart) throw new Error('window end must be after start');
  const basis = opts.basis ?? 'scheduled';
  const now = opts.now ?? new Date();
  const hoursByState = Object.fromEntries(ASSET_STATES.map((s) => [s, 0])) as Record<AssetState, number>;
  let unplannedStops = 0;
  // An open interval runs until "now", never into the future.
  const effectiveEnd = new Date(Math.min(windowEnd.getTime(), Math.max(now.getTime(), windowStart.getTime())));

  for (const iv of intervals) {
    const start = Math.max(iv.startedAt.getTime(), windowStart.getTime());
    const end = Math.min((iv.endedAt ?? effectiveEnd).getTime(), effectiveEnd.getTime());
    if (end <= start) continue;
    hoursByState[iv.state] += (end - start) / HOUR;
    if (iv.state === 'unplanned_downtime' && iv.startedAt >= windowStart) unplannedStops++;
  }

  const calendarHours = (windowEnd.getTime() - windowStart.getTime()) / HOUR;
  const recordedHours = Object.values(hoursByState).reduce((a, b) => a + b, 0);
  const scheduledHours = recordedHours - hoursByState.planned_downtime - hoursByState.out_of_service;
  const ratio = (num: number, den: number) => (den > 0 ? round(num / den, 4) : null);
  const basisHours = basis === 'calendar' ? calendarHours : scheduledHours;

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    calendarHours: round(calendarHours),
    recordedHours: round(recordedHours),
    unrecordedHours: round(calendarHours - recordedHours),
    coverage: ratio(recordedHours, calendarHours),
    hoursByState: Object.fromEntries(Object.entries(hoursByState).map(([k, v]) => [k, round(v)])) as Record<AssetState, number>,
    scheduledHours: round(scheduledHours),
    availability: ratio(scheduledHours - hoursByState.unplanned_downtime, scheduledHours),
    utilization: ratio(hoursByState.running, basisHours),
    basis,
    unplannedStops,
  };
}
