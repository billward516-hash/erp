import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import { createWorkOrder } from '../src/modules/maintenance/service.js';
import { actionPriority, capaForRow, createFmea, evaluateRow, getFmea, priorityOf, reviseFmea, saveRows, submitFmea } from '../src/modules/quality/fmea.js';
import { addAction, completeAction } from '../src/modules/quality/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let qm: Actor;
let press: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const approve = async (who: Actor, subjectId: string) => {
  const step = (await asActor(who, (tx) => myApprovalQueue(tx, who))).find((q) => q.subject_id === subjectId);
  if (!step) throw new Error('no approval step');
  return asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision: 'approve', comment: null }));
};

beforeAll(async () => {
  w = await makeWorld('fmea');
  const u = await createUserWithToken(db(), w.tenantId, { email: `qm-${Date.now()}@f.example`, displayName: 'QM', roles: [{ role: 'quality_manager', facility: w.facilities.A! }] });
  qm = (await loadActor(w.tenantId, u.userId))!;
  press = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'PRESS-4', name: 'Hydraulic press' }))).id;
  // Two corrective work orders in the last year for the same failure code.
  for (const t of ['Ram drift', 'Ram drift again']) {
    const wo = await asActor(w.managerA, (tx) => createWorkOrder(tx, w.managerA, { assetId: press, title: t, woType: 'corrective' }));
    await db().query(`UPDATE work_order SET failure_code = 'HYD-SEAL' WHERE id = $1`, [wo.id]);
  }
});
afterAll(closePools);

describe('action priority', () => {
  it('follows the AIAG-VDA table: severity first, then occurrence, then detection', () => {
    const cases: [number, number, number, string][] = [
      [10, 10, 10, 'H'], [9, 4, 1, 'M'], [9, 2, 5, 'M'], [9, 3, 3, 'L'], [9, 1, 10, 'L'], [8, 5, 8, 'H'], [8, 5, 5, 'M'], [8, 2, 8, 'M'], [8, 6, 1, 'M'],
      [5, 8, 5, 'H'], [5, 8, 3, 'M'], [5, 6, 1, 'L'], [5, 4, 8, 'M'], [5, 4, 5, 'L'], [3, 9, 9, 'M'], [3, 9, 3, 'L'], [3, 5, 10, 'L'], [1, 10, 10, 'L'],
    ];
    expect(cases.map(([s, o, d]) => actionPriority(s, o, d))).toEqual(cases.map((c) => c[3]));
    // Where RPN and AP disagree: a severity-9 mode with RPN 81 stays low only because occurrence and detection are both good.
    expect([priorityOf('rpn', 100, 9, 3, 3), priorityOf('rpn', 100, 5, 5, 5), priorityOf('rpn', 100, 4, 4, 4)]).toEqual(['M', 'H', 'M']);
  });
});

describe('FMEA workflow', () => {
  let f: any; let fm: any;
  it('rows are validated and prioritised by the FMEA\'s method; failure codes only on equipment FMEAs', async () => {
    await expect(asActor(w.techA, (tx) => createFmea(tx, w.techA, { facilityId: w.facilities.A!, kind: 'equipment', title: 'x', scope: 'y', assetId: press }))).rejects.toThrow(/quality.manage/);
    await expect(asActor(qm, (tx) => createFmea(tx, qm, { facilityId: w.facilities.A!, kind: 'equipment', title: 'Press', scope: 'Hydraulics' }))).rejects.toThrow(/needs the asset/);
    f = await asActor(qm, (tx) => createFmea(tx, qm, { facilityId: w.facilities.A!, kind: 'equipment', title: 'PRESS-4 hydraulic system', scope: 'Pump, valves, cylinder seals', assetId: press, team: 'QM, maintenance lead, setter' }));
    expect(f).toMatchObject({ number: expect.stringMatching(/^FMEA-\d{4}$/), revision: 1, method: 'ap', status: 'draft' });
    await expect(asActor(qm, (tx) => saveRows(tx, qm, f.id, [{ item: 'Cylinder', failureMode: 'x', effect: 'y', severity: 11, cause: 'z', occurrence: 1, detection: 1 }]))).rejects.toThrow(/1 to 10/);
    const v = await asActor(qm, (tx) => saveRows(tx, qm, f.id, [
      { item: 'Main cylinder', failureMode: 'Rod seal leak', effect: 'Ram drifts down during setup; crush hazard', severity: 9, cause: 'Seal wear, contaminated oil', occurrence: 2,
        preventionControls: 'Oil filtration', detectionControls: 'Operator checks drift weekly', detection: 6, failureCode: 'HYD-SEAL' },
      { item: 'Pump', failureMode: 'Low pressure', effect: 'Short stroke, scrap', severity: 5, cause: 'Worn pump', occurrence: 3, detection: 3 },
    ]));
    expect(v.rows.map((r: any) => [r.seq, r.priority, r.rpn, r.observed_12m])).toEqual([[1, 'M', 108, 2], [2, 'L', 45, null]]);
    expect(v.rows[0].occurrence_check).toMatch(/happened 2 times in 12 months; occurrence 2 may be too low/);
    const p = await asActor(qm, (tx) => createFmea(tx, qm, { facilityId: w.facilities.A!, kind: 'process', title: 'Bracket bending', scope: 'Op 20', method: 'rpn', rpnThreshold: 100 }));
    await expect(asActor(qm, (tx) => saveRows(tx, qm, p.id, [{ item: 'Bend', failureMode: 'Crack', effect: 'Scrap', severity: 5, cause: 'Die', occurrence: 5, detection: 5, failureCode: 'X' }]))).rejects.toThrow(/equipment FMEAs/);
    fm = p;
  });

  it('high-priority rows need an action before review; the quality reviewer approves; approved rows are frozen', async () => {
    await asActor(qm, (tx) => saveRows(tx, qm, f.id, [
      { item: 'Main cylinder', failureMode: 'Rod seal leak', effect: 'Ram drifts down during setup; crush hazard', severity: 9, cause: 'Seal wear, contaminated oil', occurrence: 5,
        preventionControls: 'Oil filtration', detectionControls: 'Operator checks drift weekly', detection: 6, failureCode: 'HYD-SEAL' },
      { item: 'Pump', failureMode: 'Low pressure', effect: 'Short stroke, scrap', severity: 5, cause: 'Worn pump', occurrence: 3, detection: 3 },
    ]));
    await expect(asActor(qm, (tx) => submitFmea(tx, qm, f.id))).rejects.toThrow(/row 1 needs a recommended action/);
    const v = await asActor(qm, (tx) => getFmea(tx, qm, f.id));
    const act = await asActor(qm, (tx) => addAction(tx, qm, { subjectType: 'fmea', subjectId: f.id, fmeaRowId: v.rows[0].id, title: 'Add drift test to the weekly PM and a pilot check valve', ownerUserId: w.managerA.userId, dueDate: day(14) }));
    await asActor(qm, (tx) => submitFmea(tx, qm, f.id));
    await approve(w.qualityA, f.id);
    const a = await asActor(qm, (tx) => getFmea(tx, qm, f.id));
    expect(a).toMatchObject({ status: 'approved', review_due: day(365) });
    await expect(asActor(qm, (tx) => saveRows(tx, qm, f.id, []))).rejects.toThrow(/new revision/);
    await expect(db().query('UPDATE fmea_row SET severity = 3 WHERE fmea_id = $1', [f.id])).rejects.toThrow(/cannot change/);
    // After-action evaluation waits for the actions and can't lower risk by pretending the effect changed.
    await expect(asActor(qm, (tx) => evaluateRow(tx, qm, a.rows[0].id, { severity: 9, occurrence: 2, detection: 3 }))).rejects.toThrow(/finish the row's actions/);
    await asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act.id, 'Pilot check valve fitted; drift test added to PM-PRESS-W'));
    await expect(asActor(qm, (tx) => evaluateRow(tx, qm, a.rows[0].id, { severity: 10, occurrence: 2, detection: 3 }))).rejects.toThrow(/do not raise severity/);
    expect(await asActor(qm, (tx) => evaluateRow(tx, qm, a.rows[0].id, { severity: 9, occurrence: 2, detection: 3 }))).toEqual({ priority: 'L' });
  });

  it('a new revision starts from the after-action scores and supersedes the old one when approved', async () => {
    const r2 = await asActor(qm, (tx) => reviseFmea(tx, qm, f.id, 'Periodic review'));
    const v = await asActor(qm, (tx) => getFmea(tx, qm, r2.id));
    expect(v.rows.map((r: any) => [r.severity, r.occurrence, r.detection, r.priority])).toEqual([[9, 2, 3, 'L'], [5, 3, 3, 'L']]);
    await asActor(qm, (tx) => submitFmea(tx, qm, r2.id));
    await approve(w.qualityA, r2.id);
    const revs = (await asActor(qm, (tx) => getFmea(tx, qm, r2.id))).revisions.map((x: any) => [x.revision, x.status]);
    expect(revs).toEqual([[2, 'approved'], [1, 'superseded']]);
  });

  it('a failure mode can open a linked corrective action; the RPN method uses the threshold', async () => {
    await asActor(qm, (tx) => saveRows(tx, qm, fm.id, [{ item: 'Bend', failureMode: 'Crack at bend radius', effect: 'Scrap', severity: 5, cause: 'Worn die', occurrence: 5, detection: 5 }]));
    const v = await asActor(qm, (tx) => getFmea(tx, qm, fm.id));
    expect(v.rows[0]).toMatchObject({ priority: 'H', rpn: 125 });
    const c = await asActor(qm, (tx) => capaForRow(tx, qm, v.rows[0].id, { ownerUserId: w.managerA.userId }));
    expect(c).toMatchObject({ source: 'fmea', priority: 'high', title: expect.stringMatching(/row 1: Crack at bend radius/) });
    // The corrective action counts as the response to the high-priority row.
    await asActor(qm, (tx) => submitFmea(tx, qm, fm.id));
  });

  it('the risk register shows open high-priority modes and modes happening more than rated', async () => {
    const def = getReport('fmea-risk')!;
    const r = await asActor(qm, (tx) => def.run(tx, qm, def.params.parse({})));
    expect(r.headline).toBe('1 high-priority failure mode open across 2 FMEAs');
    expect(r.insights.join(' ')).toMatch(/1 FMEA in draft or review/);
  });
});
