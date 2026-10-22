import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import {
  confirmReview, createPlan, getPlan, recordExercise, revisePlan, saveContacts, savePlanBody, scheduleExercise, submitPlan,
} from '../src/modules/continuity/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { addAction } from '../src/modules/quality/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let press: string; let weld: string; let supplier: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const approve = async (who: Actor, subjectId: string) => {
  const step = (await asActor(who, (tx) => myApprovalQueue(tx, who))).find((q) => q.subject_id === subjectId);
  if (!step) throw new Error('no approval step');
  return asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision: 'approve', comment: null }));
};
const texts = (p: any) => p.gaps.map((g: any) => `${g.severity}: ${g.text}`);

beforeAll(async () => {
  w = await makeWorld('bcp');
  press = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'PRESS-1', name: 'Transfer press' }))).id;
  weld = (await db().query(`INSERT INTO qualification (tenant_id, code, name) VALUES ($1, 'DIE-SET', 'Press die setter') RETURNING id`, [w.tenantId])).rows[0].id;
  await db().query('INSERT INTO employee_qualification (tenant_id, employee_id, qualification_id, granted_by) VALUES ($1, $2, $3, $4)', [w.tenantId, w.techAEmployeeId, weld, w.admin.userId]);
  supplier = (await db().query(`INSERT INTO supplier (tenant_id, code, name) VALUES ($1, 'DIES', 'Midwest Die Co') RETURNING id`, [w.tenantId])).rows[0].id;
  const part = (await db().query(`INSERT INTO part (tenant_id, part_number, description) VALUES ($1, 'DIE-220', 'Progressive die insert') RETURNING id`, [w.tenantId])).rows[0].id;
  await db().query('INSERT INTO supplier_part (tenant_id, supplier_id, part_id) VALUES ($1, $2, $3)', [w.tenantId, supplier, part]);
});
afterAll(closePools);

describe('continuity plans', () => {
  let plan: any;
  it('a plan names the critical process, its RTO and an owner with a different alternate', async () => {
    const base = { facilityId: w.facilities.A!, process: 'Stamping of HSG-220 housings', title: 'Press line continuity', rtoHours: 24 };
    await expect(asActor(w.techA, (tx) => createPlan(tx, w.techA, base))).rejects.toThrow(/continuity.manage/);
    await expect(asActor(w.ehsA, (tx) => createPlan(tx, w.ehsA, { ...base, alternateUserId: w.ehsA.userId }))).rejects.toThrow(/other than the owner/);
    plan = await asActor(w.ehsA, (tx) => createPlan(tx, w.ehsA, { ...base, criticality: 'critical', rpoHours: 4, alternateUserId: w.managerA.userId }));
    expect(plan).toMatchObject({ number: expect.stringMatching(/^BCP-\d{3}$/), revision: 1, status: 'draft' });
  });

  it('dependencies are checked against live records and gaps are shown before approval', async () => {
    await expect(asActor(w.ehsA, (tx) => savePlanBody(tx, w.ehsA, plan.id, { dependencies: [{ kind: 'asset', description: 'Press' }], scenarios: [] }))).rejects.toThrow(/choose the asset/);
    await db().query(`UPDATE asset SET operational_state = 'out_of_service' WHERE id = $1`, [press]);
    const v = await asActor(w.ehsA, (tx) => savePlanBody(tx, w.ehsA, plan.id, {
      dependencies: [
        { kind: 'asset', assetId: press, description: 'Only press with the 400 t bed' },
        { kind: 'skill', qualificationId: weld, description: 'Die changes', minHolders: 2 },
        { kind: 'person', employeeId: w.tech2AEmployeeId, description: 'Knows the die maintenance history' },
        { kind: 'supplier', supplierId: supplier, description: 'Die inserts' },
        { kind: 'other', description: 'Compressed air (plant system)', workaround: 'Rental compressor, 4 h delivery' },
      ],
      scenarios: [
        { scenario: 'Press breakdown (crown or clutch)', recoverySteps: '1. Call OEM service. 2. Move HSG-220 to Ohio plant on the 250 t press with the spare die.', recoveryOwnerUserId: w.managerA.userId, estRecoveryHours: 72 },
        { scenario: 'Die insert failure', recoverySteps: 'Swap to the spare insert from stores; order replacement.', recoveryOwnerUserId: w.managerA.userId, estRecoveryHours: 6 },
      ],
    }));
    expect(texts(v)).toEqual(expect.arrayContaining([
      'high: Scenario 1 (Press breakdown (crown or clutch)): estimated 72 h recovery exceeds the 24 h RTO',
      'high: PRESS-1 is out of service now and there is no workaround',
      'high: Only 1 current holder of Press die setter (the plan needs 2)',
      'high: Single point of failure: Luis Ortega, with no cover arranged',
      'watch: Midwest Die Co is the only source for 1 part and no second source is noted',
      'high: No call list',
    ]));
    expect(v.dependencies.map((d: any) => d.live_status)).toEqual(['out of service', '1 current holder: Priya Shah', 'active', 'sole source for 1 part', null]);
    // A second qualified setter closes the skills gap.
    await db().query('INSERT INTO employee_qualification (tenant_id, employee_id, qualification_id, granted_by) VALUES ($1, $2, $3, $4)', [w.tenantId, w.tech2AEmployeeId, weld, w.admin.userId]);
    expect(texts(await asActor(w.ehsA, (tx) => getPlan(tx, w.ehsA, plan.id))).join('\n')).not.toMatch(/Press die setter/);
  });

  it('needs a call list before approval by the plant manager; approved plans are frozen except the call list', async () => {
    await expect(asActor(w.ehsA, (tx) => submitPlan(tx, w.ehsA, plan.id))).rejects.toThrow(/call list/);
    await expect(asActor(w.ehsA, (tx) => saveContacts(tx, w.ehsA, plan.id, [{ name: 'OEM service', role: 'Press OEM', email: 'not-an-email' }]))).rejects.toThrow(/not valid/);
    await asActor(w.ehsA, (tx) => saveContacts(tx, w.ehsA, plan.id, [{ name: 'Schuler service desk', role: 'Press OEM 24/7', phone: '+1 555 0100' }]));
    await asActor(w.ehsA, (tx) => submitPlan(tx, w.ehsA, plan.id));
    await approve(w.opsA, plan.id);
    const a = await asActor(w.ehsA, (tx) => getPlan(tx, w.ehsA, plan.id));
    expect(a).toMatchObject({ status: 'approved' });
    expect(a.review_due).toBe(new Date(new Date(`${day(0)}T00:00:00Z`).setUTCMonth(new Date(`${day(0)}T00:00:00Z`).getUTCMonth() + 12)).toISOString().slice(0, 10));
    expect(texts(a)).toEqual(expect.arrayContaining(['high: Never exercised', 'watch: The 24 h RTO has not been demonstrated by a simulation or full test']));
    await expect(db().query('UPDATE continuity_scenario SET est_recovery_hours = 12 WHERE plan_id = $1', [plan.id])).rejects.toThrow(/cannot change/);
    await asActor(w.managerA, (tx) => saveContacts(tx, w.managerA, plan.id, [{ name: 'Schuler service desk', role: 'Press OEM 24/7', phone: '+1 555 0199' }]));
  });

  it('exercises: a timed recovery over the RTO is not met, findings need an action, a full test within the RTO demonstrates it', async () => {
    const sim = await asActor(w.ehsA, (tx) => scheduleExercise(tx, w.ehsA, plan.id, { kind: 'simulation', scheduledOn: day(-3), facilitatorUserId: w.managerA.userId }));
    await expect(asActor(w.managerA, (tx) => recordExercise(tx, w.managerA, sim.id, { conductedOn: day(-2), participants: 'Maintenance, production', outcome: 'met', achievedRecoveryHours: 30 }))).rejects.toThrow(/not met/);
    await expect(asActor(w.managerA, (tx) => recordExercise(tx, w.managerA, sim.id, { conductedOn: day(-2), participants: 'Maintenance, production', outcome: 'not_met', achievedRecoveryHours: 30 }))).rejects.toThrow(/findings/);
    await asActor(w.managerA, (tx) => recordExercise(tx, w.managerA, sim.id, { conductedOn: day(-2), participants: 'Maintenance, production', outcome: 'not_met', achievedRecoveryHours: 30,
      findings: 'Spare die was not at the Ohio plant; 6 h lost locating it.' }));
    await expect(db().query(`UPDATE continuity_exercise SET findings = 'x' WHERE id = $1`, [sim.id])).rejects.toThrow(/final/);
    let v = await asActor(w.ehsA, (tx) => getPlan(tx, w.ehsA, plan.id));
    expect(texts(v)).toEqual(expect.arrayContaining([expect.stringMatching(/^high: simulation on .* did not meet its objectives and has no action$/), 'watch: No timed exercise has recovered within the 24 h RTO']));
    await asActor(w.ehsA, (tx) => addAction(tx, w.ehsA, { subjectType: 'continuity_plan', subjectId: plan.id, continuityExerciseId: sim.id, title: 'Keep the spare die at the Ohio plant', ownerUserId: w.managerA.userId, dueDate: day(14) }));
    const full = await asActor(w.ehsA, (tx) => scheduleExercise(tx, w.ehsA, plan.id, { kind: 'full_test', scheduledOn: day(-1), facilitatorUserId: w.managerA.userId, scenarioId: v.scenarios[0].id }));
    await asActor(w.managerA, (tx) => recordExercise(tx, w.managerA, full.id, { conductedOn: day(-1), participants: 'Maintenance, production, logistics', outcome: 'met', achievedRecoveryHours: 20 }));
    v = await asActor(w.ehsA, (tx) => getPlan(tx, w.ehsA, plan.id));
    expect(v.readiness).toMatchObject({ lastExercise: day(-1), lastOutcome: 'met', demonstratedHours: 20, bestTimedHours: 20 });
    expect(texts(v).join('\n')).not.toMatch(/did not meet|Never exercised|not been demonstrated/);
  });

  it('a revision carries the plan over, moves open actions and supersedes the old revision; exercise history spans revisions', async () => {
    const r2 = await asActor(w.ehsA, (tx) => revisePlan(tx, w.ehsA, plan.id, 'Exercise findings: spare die location'));
    await expect(asActor(w.ehsA, (tx) => saveContacts(tx, w.ehsA, plan.id, []))).rejects.toThrow(/revision 2 is open/);
    const d = await asActor(w.ehsA, (tx) => getPlan(tx, w.ehsA, r2.id));
    expect([d.dependencies.length, d.scenarios.length, d.contacts[0].phone, d.actions.length, d.exercises.length]).toEqual([5, 2, '+1 555 0199', 1, 2]);
    await asActor(w.ehsA, (tx) => submitPlan(tx, w.ehsA, r2.id));
    await approve(w.opsA, r2.id);
    const v = await asActor(w.ehsA, (tx) => getPlan(tx, w.ehsA, r2.id));
    expect(v.revisions.map((x: any) => [x.revision, x.status])).toEqual([[2, 'approved'], [1, 'superseded']]);
    expect(v.readiness.demonstratedHours).toBe(20);
  });

  it('periodic review, reminders and the readiness report', async () => {
    const cur = (await db().query(`SELECT id FROM continuity_plan WHERE tenant_id = $1 AND status = 'approved'`, [w.tenantId])).rows[0].id;
    await expect(asActor(w.techA, (tx) => confirmReview(tx, w.techA, cur, 'ok'))).rejects.toThrow(/continuity.manage/);
    await db().query(`UPDATE continuity_plan SET review_due = current_date - 3 WHERE id = $1`, [cur]);
    expect(texts(await asActor(w.ehsA, (tx) => getPlan(tx, w.ehsA, cur)))).toContain(`watch: Review was due ${day(-3)}`);
    const counts = await runReminders(w.tenantId);
    expect(counts.continuity_review_due).toBe(2);
    const r = await asActor(w.ehsA, (tx) => confirmReview(tx, w.ehsA, cur, 'Called every contact; press back in service'));
    expect(r.reviewDue > day(300)).toBe(true);
    const def = getReport('continuity-readiness')!;
    const rep = await asActor(w.exec, (tx) => def.run(tx, w.exec, def.params.parse({})));
    expect(rep.headline).toBe('Recovery within the RTO shown in a timed exercise for 1 of 1 approved plan; 1 plan with high gaps');
    expect(rep.rows[0]).toMatchObject({ rto_hours: 24, demonstrated_hours: 20, high_gaps: 3 });
  });
});
