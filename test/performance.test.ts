import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { withTx } from '../src/platform/db/tx.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import {
  acknowledgeReview, addGoal, getReview, hrAction, listPerformance, nextReviewDue, openDueReviews, saveAssessment, saveSettings, shareReview, submitSelfAssessment, updateGoal,
} from '../src/modules/performance/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Performance reviews (D-155). */
let app: FastifyInstance; let w: World; let boss: Actor; let hr: Actor; let bossToken: string;
const db = () => getAdminPool();
const sys = (tenantId: string) => ({ tenantId, userId: null, facilityIds: [], allFacilities: true });
const settings = { enabled: true, intervalMonths: 12, anchor: 'calendar' as const, calendarMonth: 3, firstReviewMonths: 3, checkinMonths: 3, selfAssessment: true, openDaysBefore: 21 };
const S = { ...settings, configured: true };

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('perf');
  const mgrEmp = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, hire_date) VALUES ($1, $2, 'M-1', 'Morgan', 'Boss', '2015-01-05') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
  const b = await createUserWithToken(db(), w.tenantId, { email: `boss@${w.tenantId}.example`, displayName: 'Morgan Boss', roles: [{ role: 'maintenance_manager', facility: w.facilities.A! }], employeeId: mgrEmp });
  boss = (await loadActor(w.tenantId, b.userId))!; bossToken = b.token;
  const h = await createUserWithToken(db(), w.tenantId, { email: `hr@${w.tenantId}.example`, displayName: 'Hana HR', roles: [{ role: 'hr_manager', facility: null }] });
  hr = (await loadActor(w.tenantId, h.userId))!;
  // techA reports to Morgan, hired long ago; tech2A has no manager.
  await db().query(`UPDATE employee SET manager_employee_id = $2, hire_date = '2018-06-01' WHERE id = $1`, [w.techAEmployeeId, mgrEmp]);
  await db().query(`UPDATE employee SET hire_date = '2019-02-01' WHERE id = $1`, [w.tech2AEmployeeId]);
});
afterAll(async () => { await app.close(); await closePools(); });

describe('when reviews fall due', () => {
  it('calendar cycle: everyone at the end of the review month, then every interval', () => {
    expect(nextReviewDue(S, { hire_date: '2018-06-01' }, null, '2027-02-20')).toBe('2027-03-31');
    expect(nextReviewDue(S, { hire_date: '2018-06-01' }, '2027-03-31', '2027-04-02')).toBe('2028-03-31');
    expect(nextReviewDue({ ...S, intervalMonths: 6 }, { hire_date: '2018-06-01' }, '2027-03-31', '2027-04-02')).toBe('2027-09-30');
  });
  it('hire anniversaries, and a first review a few months after hire', () => {
    expect(nextReviewDue({ ...S, anchor: 'hire_date' }, { hire_date: '2018-06-10' }, null, '2027-02-20')).toBe('2027-06-30');
    expect(nextReviewDue(S, { hire_date: '2027-01-15' }, null, '2027-02-20')).toBe('2027-04-30');
  });
});

describe('the programme', () => {
  it('only HR sets it up; nothing opens until it is', async () => {
    expect((await withTx(sys(w.tenantId), (tx) => openDueReviews(tx, w.tenantId, '2027-03-15'))).opened).toBe(0);
    await expect(asActor(boss, (tx) => saveSettings(tx, boss, settings))).rejects.toThrow(/performance.manage/);
    await expect(asActor(hr, (tx) => saveSettings(tx, hr, { ...settings, checkinMonths: 12 }))).rejects.toThrow(/more often than reviews/);
    await asActor(hr, (tx) => saveSettings(tx, hr, settings));
  });

  it('opens each review three weeks before it is due, once, with the manager as reviewer (or none, for HR to assign)', async () => {
    const before = await withTx(sys(w.tenantId), (tx) => openDueReviews(tx, w.tenantId, '2027-03-01'));
    expect(before.opened).toBe(0); // 30 days before 31 March
    const r = await withTx(sys(w.tenantId), (tx) => openDueReviews(tx, w.tenantId, '2027-03-15'));
    expect(r.opened).toBeGreaterThanOrEqual(3); // techA, tech2A, Morgan
    expect((await withTx(sys(w.tenantId), (tx) => openDueReviews(tx, w.tenantId, '2027-03-16'))).opened).toBe(0);
    const rows = (await db().query(`SELECT employee_id, reviewer_user_id, kind, due_on FROM performance_review WHERE tenant_id = $1`, [w.tenantId])).rows;
    expect(rows.find((x) => x.employee_id === w.techAEmployeeId)).toMatchObject({ reviewer_user_id: boss.userId, kind: 'review', due_on: '2027-03-31' });
    expect(rows.find((x) => x.employee_id === w.tech2AEmployeeId)!.reviewer_user_id).toBeNull();
  });
});

describe('a review, step by step', () => {
  let id: string;
  it('the employee writes a self-assessment but cannot see the draft; the reviewer cannot be the one acknowledging', async () => {
    id = (await db().query(`SELECT id FROM performance_review WHERE employee_id = $1`, [w.techAEmployeeId])).rows[0].id;
    await asActor(w.techA, (tx) => submitSelfAssessment(tx, w.techA, id, 'Cut PM backlog on line 2; want to learn PLC fault finding'));
    await asActor(boss, (tx) => saveAssessment(tx, boss, id, { rating: 4, strengths: 'Reliable, thorough PMs', development: 'PLC diagnostics', summary: 'A strong year.' }));
    const seen = await asActor(w.techA, (tx) => getReview(tx, w.techA, id));
    expect(seen).toMatchObject({ role: 'employee', status: 'open', rating: null, summary: null, self_assessment: expect.stringMatching(/PM backlog/) });
    await expect(asActor(w.techA, (tx) => saveAssessment(tx, w.techA, id, { rating: 5 }))).rejects.toThrow(/reviewer writes/);
    await expect(asActor(boss, (tx) => acknowledgeReview(tx, boss, id))).rejects.toThrow(/only the employee/);
  });

  it('others cannot see it at all', async () => {
    await expect(asActor(w.tech2A, (tx) => getReview(tx, w.tech2A, id))).rejects.toThrow(/not found/);
    await expect(asActor(w.managerA, (tx) => getReview(tx, w.managerA, id))).rejects.toThrow(/not found/);
    expect((await asActor(hr, (tx) => getReview(tx, hr, id))).role).toBe('hr');
  });

  it('goals agreed, shared, acknowledged with a comment; then frozen', async () => {
    const g = await asActor(boss, (tx) => addGoal(tx, boss, id, { title: 'PLC fault-finding course', measure: 'Course passed, two faults found unaided', dueOn: '2027-09-30' }));
    await expect(asActor(w.techA, (tx) => updateGoal(tx, w.techA, id, g.id, { status: 'met' }))).rejects.toThrow(/reviewer records/);
    await asActor(boss, (tx) => shareReview(tx, boss, id));
    expect(await asActor(w.techA, (tx) => getReview(tx, w.techA, id))).toMatchObject({ status: 'shared', rating: 4, ratingLabel: 'Exceeds expectations' });
    await expect(asActor(w.techA, (tx) => submitSelfAssessment(tx, w.techA, id, 'late edit'))).rejects.toThrow(/closed/);
    await asActor(w.techA, (tx) => acknowledgeReview(tx, w.techA, id, 'Agreed; keen on the PLC course'));
    expect(await asActor(hr, (tx) => getReview(tx, hr, id))).toMatchObject({ status: 'completed', employee_comment: 'Agreed; keen on the PLC course' });
    await expect(asActor(boss, (tx) => saveAssessment(tx, boss, id, { rating: 2 }))).rejects.toThrow(/no longer be edited/);
    const audits = (await db().query(`SELECT action FROM audit_event WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`, [w.tenantId, id])).rows.map((r) => r.action);
    expect(audits).toEqual(['performance.self_assessed', 'performance.goal_added', 'performance.shared', 'performance.acknowledged']);
  });

  it('then a check-in opens three months later, and the next review a year on', async () => {
    const r = await withTx(sys(w.tenantId), (tx) => openDueReviews(tx, w.tenantId, '2027-06-20'));
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const next = (await db().query(`SELECT kind, due_on FROM performance_review WHERE employee_id = $1 AND status = 'open'`, [w.techAEmployeeId])).rows;
    expect(next).toEqual([{ kind: 'check_in', due_on: '2027-06-30' }]);
  });
});

describe('HR and reminders', () => {
  it('HR assigns a reviewer where there is no manager; nobody reviews themselves', async () => {
    const id = (await db().query(`SELECT id FROM performance_review WHERE employee_id = $1 AND status = 'open'`, [w.tech2AEmployeeId])).rows[0].id;
    await expect(asActor(hr, (tx) => hrAction(tx, hr, id, { action: 'assign', reviewerUserId: w.tech2A.userId }))).rejects.toThrow(/cannot review themselves/);
    await asActor(hr, (tx) => hrAction(tx, hr, id, { action: 'assign', reviewerUserId: boss.userId }));
    const team = await asActor(boss, (tx) => listPerformance(tx, boss));
    expect(team.team.map((r: any) => r.employee_id)).toContain(w.tech2AEmployeeId);
    expect(team.all).toBeNull();
    expect((await asActor(hr, (tx) => listPerformance(tx, hr))).counts).toBeTruthy();
  });

  it('reviewers are reminded, and HR once reviews are well overdue', async () => {
    await runReminders(w.tenantId, '2027-05-20');
    const n = (await db().query(`SELECT kind, user_id FROM notification WHERE tenant_id = $1 AND kind IN ('reminder.performance_due', 'reminder.performance_overdue')`, [w.tenantId])).rows;
    expect(n.some((x) => x.kind === 'reminder.performance_due' && x.user_id === boss.userId)).toBe(true);
    expect(n.some((x) => x.kind === 'reminder.performance_overdue' && x.user_id === hr.userId)).toBe(true);
  });

  it('over HTTP, a reviewer’s list', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/performance', headers: { authorization: `Bearer ${bossToken}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().hr).toBe(false);
  });
});

describe('managers from a payroll export', () => {
  it('a manager listed after their reports is still linked; unknown managers warn; nobody manages themselves', async () => {
    const file = Buffer.from('Emp No,Name,Reports To,Site\nP-2,"Lee, Sam",P-1,A\nP-1,"Kim, Ada",,A\nP-3,"Roe, Max",NOBODY,A\nP-4,"Ito, Kei",P-4,A\n');
    const staged = await stageImport(w.admin, { target: 'employees', sourceSystem: 'payroll', fileName: 'staff.csv', content: file });
    expect(staged.stats).toMatchObject({ errors: 1 });
    await commitImport(w.admin, staged.batchId, { allowPartial: true });
    const rows = (await db().query(`SELECT e.employee_number, m.employee_number AS manager FROM employee e LEFT JOIN employee m ON m.id = e.manager_employee_id
      WHERE e.tenant_id = $1 AND e.employee_number LIKE 'P-%' ORDER BY 1`, [w.tenantId])).rows;
    expect(rows).toEqual([{ employee_number: 'P-1', manager: null }, { employee_number: 'P-2', manager: 'P-1' }, { employee_number: 'P-3', manager: null }]);
  });
});

