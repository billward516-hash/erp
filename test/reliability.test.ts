import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { computeReliability, mergeStops } from '../src/modules/assets/reliability.js';
import type { FailureWorkOrder } from '../src/modules/assets/reliability.js';
import { assetReliability, createAsset } from '../src/modules/assets/service.js';
import type { StateInterval } from '../src/modules/assets/utilization.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const H = 3_600_000;
const t0 = new Date('2026-01-01T00:00:00Z');
const at = (h: number) => new Date(t0.getTime() + h * H);
const iv = (state: StateInterval['state'], from: number, to: number | null): StateInterval => ({ state, startedAt: at(from), endedAt: to == null ? null : at(to) });
const wo = (createdH: number, code: string | null, repairH: number | null = 2, status = 'completed'): FailureWorkOrder =>
  ({ createdAt: at(createdH), startedAt: repairH == null ? null : at(createdH), completedAt: repairH == null ? null : at(createdH + repairH), failureCode: code, status });

describe('reliability calculation', () => {
  it('merges back-to-back downtime records into one failure and computes MTBF and MTTR over uptime', () => {
    // 200 h window: run 90, down 4 (recorded as 3 + 1 with a reason change), run 50, planned stop 10, run 30, down 6, run 10.
    const intervals = [iv('running', 0, 90), iv('unplanned_downtime', 90, 93), iv('unplanned_downtime', 93, 94), iv('running', 94, 144),
      iv('planned_downtime', 144, 154), iv('running', 154, 184), iv('unplanned_downtime', 184, 190), iv('running', 190, 200)];
    expect(mergeStops(intervals, at(0), at(200))).toHaveLength(2);
    const r = computeReliability(intervals, [], at(0), at(200), { now: at(300) });
    // Uptime = 200 − 10 planned − 10 unplanned = 180 h over 2 failures; repair = 10 h over 2.
    expect(r).toMatchObject({ basis: 'state', failures: 2, mtbfHours: 90, mttrHours: 5, uptimeHours: 180, downtimeHours: 10, availability: 0.9474 });
  });

  it('measures over the time observed, not the calendar; with too little history falls back to work orders, labelled', () => {
    // A week of records in a 30-day window still gives a state basis; MTBF is over the 168 recorded hours.
    const week = [iv('running', 0, 80), iv('unplanned_downtime', 80, 82), iv('running', 82, 168)];
    expect(computeReliability(week, [], at(0), at(720), { now: at(720) })).toMatchObject({ basis: 'state', failures: 1, mtbfHours: 166, coverage: 0.2333 });
    const fewHours = [iv('running', 0, 20)];
    const wos = [wo(10, 'HYD'), wo(300, 'HYD', 4), wo(500, 'ELEC', 0.001), wo(600, 'ELEC', null, 'cancelled')];
    // 3 failures (the cancelled one does not count) over 720 calendar hours; the 3-second "repair" is not a repair time.
    expect(computeReliability(fewHours, wos, at(0), at(720), { now: at(720) })).toMatchObject({ basis: 'work_orders', failures: 3, mtbfHours: 240, mttrHours: 3 });
    expect(computeReliability([], [], at(0), at(720))).toMatchObject({ basis: 'none', failures: 0, mtbfHours: null, mttrHours: null });
  });

  it('counts repeats of a failure code within 30 days, looking back before the window', () => {
    const wos = [wo(-100, 'SEAL'), wo(50, 'SEAL'), wo(400, 'SEAL'), wo(1500, 'SEAL'), wo(60, 'TOOL')];
    const r = computeReliability([], wos, at(0), at(2000), { now: at(2000) });
    expect(r.failureCodes).toEqual([{ code: 'SEAL', count: 3 }, { code: 'TOOL', count: 1 }]);
    // 50 h repeats −100 h, 400 h repeats 50 h; 1500 h is more than 30 days after 400 h.
    expect(r.repeats).toEqual([{ code: 'SEAL', count: 2 }]);
  });

  it('no failures means no MTBF (not zero, not infinite)', () => {
    expect(computeReliability([iv('running', 0, 500)], [], at(0), at(500), { now: at(500) })).toMatchObject({ basis: 'state', failures: 0, mtbfHours: null, mttrHours: null, uptimeHours: 500 });
  });
});

describe('reliability report and asset view', () => {
  let w: World; let lathe: string; let mill: string;
  const db = () => getAdminPool();
  const ago = (d: number, h = 0) => new Date(Date.now() - d * 86_400_000 + h * H);
  /** Running with a 2 h unplanned stop every `every` days from `fromDay` to `toDay` days ago. */
  const history = async (assetId: string, fromDay: number, toDay: number, every: number) => {
    for (let d = fromDay; d > toDay; d -= every) {
      await db().query(`INSERT INTO asset_state_event (tenant_id, facility_id, asset_id, state, started_at, ended_at, source) VALUES
        ($1, $2, $3, 'running', $4, $5, 'import'), ($1, $2, $3, 'unplanned_downtime', $5, $6, 'import')`,
      [w.tenantId, w.facilities.A, assetId, ago(d), ago(d - every, -2), ago(d - every)]);
    }
  };
  beforeAll(async () => {
    w = await makeWorld('rel');
    lathe = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'LATHE-1', name: 'Lathe' }))).id;
    mill = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'MILL-1', name: 'Mill' }))).id;
    await history(lathe, 60, 30, 6); // 5 stops in the previous 30 days
    await history(lathe, 30, 0, 3);  // 10 stops in the last 30 days: getting worse
    await history(mill, 60, 0, 15);
    for (const d of [20, 10]) {
      await db().query(`INSERT INTO work_order (tenant_id, facility_id, number, asset_id, wo_type, title, status, failure_code, created_at)
        VALUES ($1, $2, $3, $4, 'corrective', 'Chuck jaw slipping', 'completed', 'CHUCK', $5)`, [w.tenantId, w.facilities.A, `WO-R${d}`, lathe, ago(d)]);
    }
  });
  afterAll(closePools);

  it('names the bad actor, its MTBF trend and repeat failures', async () => {
    const def = getReport('reliability')!;
    const r = await asActor(w.managerA, (tx) => def.run(tx, w.managerA, def.params.parse({ days: 30 })));
    expect(r.headline).toMatch(/^LATHE-1 is the worst actor: 10 failures in 30 days, MTBF 70 h \(was 142 h\); 12 failures across 2 assets$/);
    const row = r.rows.find((x) => x.asset_tag === 'LATHE-1')!;
    expect(row).toMatchObject({ failures: 10, prev_failures: 5, mttr_h: 2, top_code: 'CHUCK (2)', repeat_codes: 'CHUCK', basis: 'State history' });
    expect(r.insights.join(' ')).toMatch(/MTBF fell by a quarter or more on LATHE-1 \(142 → 70 h\)/);
    expect(r.exceptions).toEqual([0]);
  });

  it('the asset view gives the same figures, the previous period and twelve months', async () => {
    const v = await asActor(w.managerA, (tx) => assetReliability(tx, w.managerA, lathe, 30));
    expect([v.current.failures, v.current.mtbfHours, v.previous.failures, v.months.length]).toEqual([10, 70, 5, 12]);
    await expect(asActor(w.operatorB, (tx) => assetReliability(tx, w.operatorB, lathe, 30))).rejects.toThrow();
  });
});
