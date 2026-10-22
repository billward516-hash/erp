import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset } from '../src/modules/assets/service.js';
import { decide, getImprovement, listImprovements, markImplemented, measureResult, planImprovement, setBaseline, submitIdea, validateSavings } from '../src/modules/improve/service.js';
import { addAction, myActions } from '../src/modules/quality/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World; let site: string; let press: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** An unplanned stop of `hours` starting at noon UTC `daysAgo` days ago. */
const stop = async (daysAgo: number, hours: number) => {
  const s = new Date(`${day(-daysAgo)}T12:00:00Z`);
  await db().query(`INSERT INTO asset_state_event (tenant_id, facility_id, asset_id, state, started_at, ended_at, recorded_by) VALUES ($1, $2, $3, 'unplanned_downtime', $4, $5, $6)`,
    [w.tenantId, site, press, s, new Date(s.getTime() + hours * 3_600_000), w.admin.userId]);
};

beforeAll(async () => {
  w = await makeWorld('imp');
  site = w.facilities.A!;
  press = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site, assetTag: 'PR-1', name: 'Press' }))).id;
  // Before the change: 4 stops of 2.5 h in the 8 weeks to 31 days ago. After (from 30 days ago): one 2 h stop.
  for (const d of [80, 70, 50, 40]) await stop(d, 2.5);
  await stop(10, 2);
});
afterAll(closePools);

describe('continuous improvement', () => {
  it('runs from idea to validated savings, measuring downtime from the records before and after', async () => {
    await expect(asActor(w.exec, (tx) => submitIdea(tx, w.exec, { facilityId: site, title: 'x', problem: '', category: 'cost' }))).rejects.toThrow(/problem/);
    const m = await asActor(w.techA, (tx) => submitIdea(tx, w.techA, { facilityId: site, title: 'Grease the ram guides weekly', problem: 'Press PR-1 stops on ram binding', category: 'maintenance', assetId: press }));
    expect(m).toMatchObject({ stage: 'idea', number: expect.stringMatching(/^IMP-\d{6}$/) });
    expect((await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'improve.submitted'`, [w.managerA.userId])).rows[0].n).toBe(1);
    await expect(asActor(w.techA, (tx) => decide(tx, w.techA, m.id, { approve: true, ownerUserId: w.techA.userId }))).rejects.toThrow(/improve.manage/);
    await asActor(w.managerA, (tx) => decide(tx, w.managerA, m.id, { approve: true, ownerUserId: w.techA.userId, note: 'Go ahead' }));
    await asActor(w.techA, (tx) => planImprovement(tx, w.techA, m.id, { metricKind: 'asset_unplanned_downtime', targetValue: 0.5, estAnnualSavings: 12000, oneTimeCost: 300 }));
    // Baseline window: the 56 days ending 31 days ago → 10 h over 8 weeks = 1.25 h/week.
    const b = await asActor(w.techA, (tx) => setBaseline(tx, w.techA, m.id, { from: day(-86), to: day(-31) }));
    expect(b.value).toBe(1.25);
    await asActor(w.techA, (tx) => addAction(tx, w.techA, { subjectType: 'improvement', subjectId: m.id, title: 'Add ram guide greasing to the weekly PM', ownerUserId: w.techA.userId, dueDate: day(7) }));
    expect((await asActor(w.techA, (tx) => myActions(tx, w.techA))).map((a) => a.subject_number)).toContain(m.number);
    await asActor(w.techA, (tx) => markImplemented(tx, w.techA, m.id, { implementedOn: day(-30) }));
    // Result: 2 h over the 31 days since → 2 / (31/7) = 0.45 h/week.
    const r = await asActor(w.techA, (tx) => measureResult(tx, w.techA, m.id));
    expect(r.value).toBe(0.45);
    await expect(asActor(w.techA, (tx) => validateSavings(tx, w.techA, m.id, { amount: 9000, note: 'x' }))).rejects.toThrow(/improve.manage/);
    await expect(asActor(w.managerA, (tx) => validateSavings(tx, w.managerA, m.id, { amount: 9000, note: '' }))).rejects.toThrow(/how the savings/);
    await asActor(w.managerA, (tx) => validateSavings(tx, w.managerA, m.id, { amount: 9000, note: '0.8 h/week × 52 × $215/h press hour' }));
    const v = await asActor(w.techA, (tx) => getImprovement(tx, w.techA, m.id));
    expect(v).toMatchObject({ stage: 'closed', metric_name: 'Unplanned downtime', metric_unit: 'h/week', baseline_value: 1.25, result_value: 0.45, validated_savings: 9000,
      outcome: { change: -0.8, pct: -0.64, better: true, metTarget: true } });
  });

  it('declines need a reason; a result is not measured before four weeks; manual metrics take values', async () => {
    const a = await asActor(w.techA, (tx) => submitIdea(tx, w.techA, { facilityId: site, title: 'Paint the floor', problem: 'Dusty', category: 'workplace' }));
    await expect(asActor(w.managerA, (tx) => decide(tx, w.managerA, a.id, { approve: false }))).rejects.toThrow(/why/);
    await asActor(w.managerA, (tx) => decide(tx, w.managerA, a.id, { approve: false, note: 'Floor coating is in next year\'s capital plan' }));
    const b = await asActor(w.techA, (tx) => submitIdea(tx, w.techA, { facilityId: site, title: 'Shadow board for press tools', problem: 'Tool search at changeover', category: 'workplace', assetId: press }));
    await asActor(w.managerA, (tx) => decide(tx, w.managerA, b.id, { approve: true, ownerUserId: w.techA.userId }));
    await asActor(w.techA, (tx) => planImprovement(tx, w.techA, b.id, { metricKind: 'manual', metricName: 'Changeover time', metricUnit: 'min' }));
    await expect(asActor(w.techA, (tx) => setBaseline(tx, w.techA, b.id, {}))).rejects.toThrow(/enter the baseline/);
    await asActor(w.techA, (tx) => setBaseline(tx, w.techA, b.id, { value: 42 }));
    await asActor(w.techA, (tx) => markImplemented(tx, w.techA, b.id, {}));
    expect((await asActor(w.techA, (tx) => measureResult(tx, w.techA, b.id, { value: 25 }))).value).toBe(25);
    // A record-based metric implemented 10 days ago cannot be measured yet.
    const c = await asActor(w.techA, (tx) => submitIdea(tx, w.techA, { facilityId: site, title: 'Second guard sensor', problem: 'Nuisance trips', category: 'maintenance', assetId: press }));
    await asActor(w.managerA, (tx) => decide(tx, w.managerA, c.id, { approve: true, ownerUserId: w.techA.userId }));
    await asActor(w.techA, (tx) => planImprovement(tx, w.techA, c.id, { metricKind: 'asset_unplanned_downtime' }));
    await asActor(w.techA, (tx) => setBaseline(tx, w.techA, c.id, { from: day(-86), to: day(-31) }));
    await asActor(w.techA, (tx) => markImplemented(tx, w.techA, c.id, { implementedOn: day(-10) }));
    await expect(asActor(w.techA, (tx) => measureResult(tx, w.techA, c.id))).rejects.toThrow(/at least 28 days after the change \(18 to go\)/);
    const list = await asActor(w.managerA, (tx) => listImprovements(tx, w.managerA, { facilityId: site }));
    expect(list.map((x) => x.stage)).toEqual(['measuring', 'measuring', 'closed', 'rejected']);
  });
});
