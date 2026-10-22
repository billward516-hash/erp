import type { StateInterval } from './utilization.js';
import { computeUtilization } from './utilization.js';

/**
 * Deterministic reliability measures for one asset over a window (see docs/ARCHITECTURE.md §12i).
 *
 *   failure   = an unplanned stop: consecutive unplanned-downtime records (gap ≤ 5 min) merged into one event
 *               that starts inside the window
 *   MTTR      = unplanned downtime hours in the window / failures
 *   MTBF      = uptime hours (scheduled − unplanned downtime) / failures
 *
 * MTBF and MTTR are ratios over the time actually observed, so basis 'state' needs at least
 * `minObservedHours` of state records in the window (not full coverage; `coverage` is reported alongside).
 * Without that, basis 'work_orders' counts corrective work orders created in the window as failures, takes
 * MTTR from their start-to-completion time (ignoring repairs with under a minute recorded) and MTBF from
 * calendar hours: a rougher estimate, always labelled. With neither, the measures are null (never 0).
 * With no failures, MTBF is null and `uptimeHours` is the lower bound.
 */
export interface FailureWorkOrder {
  createdAt: Date; startedAt: Date | null; completedAt: Date | null; failureCode: string | null; status: string;
}
export interface ReliabilityResult {
  basis: 'state' | 'work_orders' | 'none';
  coverage: number | null;
  failures: number;
  mtbfHours: number | null;
  mttrHours: number | null;
  uptimeHours: number | null;
  downtimeHours: number | null;
  availability: number | null;
  failureCodes: { code: string; count: number }[];
  /** Failure codes that recurred within `repeatDays` of the previous work order with the same code. */
  repeats: { code: string; count: number }[];
}

const HOUR = 3_600_000;
const MERGE_GAP = 5 * 60_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export function mergeStops(intervals: StateInterval[], windowStart: Date, windowEnd: Date) {
  const down = intervals.filter((i) => i.state === 'unplanned_downtime').sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const stops: { start: Date; end: Date | null }[] = [];
  for (const d of down) {
    const last = stops[stops.length - 1];
    if (last && last.end && d.startedAt.getTime() - last.end.getTime() <= MERGE_GAP) last.end = d.endedAt;
    else stops.push({ start: d.startedAt, end: d.endedAt });
  }
  return stops.filter((s) => s.start >= windowStart && s.start < windowEnd);
}

export function computeReliability(intervals: StateInterval[], workOrders: FailureWorkOrder[], windowStart: Date, windowEnd: Date,
  opts: { minObservedHours?: number; repeatDays?: number; now?: Date } = {}): ReliabilityResult {
  const minObserved = opts.minObservedHours ?? 168;
  const repeatDays = opts.repeatDays ?? 30;
  const wos = workOrders.filter((w) => w.status !== 'cancelled' && w.createdAt >= windowStart && w.createdAt < windowEnd)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const codes = new Map<string, number>();
  const repeats = new Map<string, number>();
  const lastSeen = new Map<string, Date>();
  // Repeats look back before the window too, so a failure early in the window can repeat one just before it.
  for (const w of workOrders.filter((x) => x.status !== 'cancelled' && x.failureCode && x.createdAt < windowEnd).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const prev = lastSeen.get(w.failureCode!);
    if (w.createdAt >= windowStart) {
      codes.set(w.failureCode!, (codes.get(w.failureCode!) ?? 0) + 1);
      if (prev && w.createdAt.getTime() - prev.getTime() <= repeatDays * 86_400_000) repeats.set(w.failureCode!, (repeats.get(w.failureCode!) ?? 0) + 1);
    }
    lastSeen.set(w.failureCode!, w.createdAt);
  }
  const sorted = (m: Map<string, number>) => [...m].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const base = { failureCodes: sorted(codes), repeats: sorted(repeats) };

  const u = computeUtilization(intervals, windowStart, windowEnd, { now: opts.now });
  if (u.recordedHours >= minObserved) {
    const failures = mergeStops(intervals, windowStart, windowEnd).length;
    const down = u.hoursByState.unplanned_downtime;
    const uptime = u.scheduledHours - down;
    return { ...base, basis: 'state', coverage: u.coverage, failures, uptimeHours: r1(uptime), downtimeHours: r1(down), availability: u.availability,
      mtbfHours: failures ? r1(uptime / failures) : null, mttrHours: failures ? r1(down / failures) : null };
  }
  if (wos.length) {
    const repaired = wos.filter((w) => w.startedAt && w.completedAt && w.completedAt.getTime() - w.startedAt.getTime() >= 60_000);
    const repairH = repaired.map((w) => (w.completedAt!.getTime() - w.startedAt!.getTime()) / HOUR);
    const end = Math.min(windowEnd.getTime(), (opts.now ?? new Date()).getTime());
    const calendar = (end - windowStart.getTime()) / HOUR;
    return { ...base, basis: 'work_orders', coverage: u.coverage, failures: wos.length, uptimeHours: null, downtimeHours: repaired.length ? r1(repairH.reduce((s, x) => s + x, 0)) : null,
      availability: null, mtbfHours: r1(calendar / wos.length), mttrHours: repaired.length ? r1(repairH.reduce((s, x) => s + x, 0) / repaired.length) : null };
  }
  return { ...base, basis: 'none', coverage: u.coverage, failures: 0, uptimeHours: null, downtimeHours: null, availability: null, mtbfHours: null, mttrHours: null };
}
