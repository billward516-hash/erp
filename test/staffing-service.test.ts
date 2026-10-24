import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { getReport } from '../src/modules/reporting/registry.js';
import {
  benchAndOver, cancelTimeOff, createAssignment, createHoliday, decideTimeOff, forecast, getSettings, groupUtilization, listAssignments, listTimeOff, loadTargets, overview,
  personDetail, previewAssignment, removeAssignment, requestTimeOff, saveSettings, saveTarget, savePattern, setTracking, updateAssignment, utilizationFor, utilizationView,
  visiblePeople, assignmentHistory,
} from '../src/modules/staffing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Staffing and utilization (D-188C): assignments with conflicts and an audit trail, capacity from holidays and time off, utilization from approved billable time, scoping. */
const db = () => getAdminPool();
const W1 = '2026-11-02'; // a Monday
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
let app: FastifyInstance; let w: World; let w2: World; let hr: Actor; let hrEmp: string;
let proj: string; let projInternal: string; let projB: string; let projDone: string;
let cy: string; let di: string; let bea: string; let uma: string; let vic: string; let wes: string; let eve: string;
const E: Record<string, string> = {};

async function newEmployee(world: World, num: string, first: string, last: string, facility: string, title = 'Consultant') {
  return (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [world.tenantId, facility, num, first, last, title])).rows[0].id as string;
}
async function newProject(world: World, facility: string, number: string, status = 'active', billing = 'time_materials') {
  return (await db().query(`INSERT INTO project (tenant_id, facility_id, number, name, status, billing_type, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [world.tenantId, facility, number, `Project ${number}`, status, billing, world.admin.userId])).rows[0].id as string;
}
/** A timesheet for the week with entries (hours, billable); the status is set after the entries (approved weeks are frozen). */
async function sheet(world: World, employeeId: string, facility: string, weekStart: string, status: string, entries: { day: number; hours: number; billable: boolean; project?: string }[]) {
  const t = (await db().query(`INSERT INTO timesheet (tenant_id, facility_id, employee_id, week_start) VALUES ($1, $2, $3, $4) RETURNING id`, [world.tenantId, facility, employeeId, weekStart])).rows[0].id;
  for (const e of entries) {
    await db().query(`INSERT INTO time_entry (tenant_id, timesheet_id, work_date, earning_code, hours, source, project_id, billable, created_by) VALUES ($1, $2, $3, 'REG', $4, $5, $6, $7, $8)`,
      [world.tenantId, t, addDays(weekStart, e.day), e.hours, e.project ? 'project' : 'manual', e.project ?? null, e.billable, world.admin.userId]);
  }
  if (status !== 'draft') await db().query(`UPDATE timesheet SET status = $2 WHERE id = $1`, [t, status]);
  return t as string;
}
const base = (employeeId: string, over: Record<string, unknown> = {}) => ({ projectId: proj, employeeId, hoursPerWeek: 20, startDate: W1, endDate: addDays(W1, 13), ...over }) as any;
const as = (a: Actor) => <T>(fn: (tx: any) => Promise<T>) => asActor(a, fn);

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('stf'); w2 = await makeWorld('stf2');
  const A = w.facilities.A!; const B = w.facilities.B!;
  hrEmp = await newEmployee(w, 'H1', 'Hana', 'Reyes', A, 'HR Manager');
  hr = (await loadActor(w.tenantId, (await createUserWithToken(db(), w.tenantId, { email: `hr@${w.tenantId}.example`, displayName: 'Hana', roles: [{ role: 'hr_manager', facility: A }], employeeId: hrEmp })).userId))!;
  cy = await newEmployee(w, 'S1', 'Cy', 'Adler', A); di = await newEmployee(w, 'S2', 'Di', 'Brandt', A);
  bea = await newEmployee(w, 'S3', 'Bea', 'Cole', B);
  uma = await newEmployee(w, 'S4', 'Uma', 'Dunn', A); vic = await newEmployee(w, 'S5', 'Vic', 'Evans', A, 'Analyst'); wes = await newEmployee(w, 'S6', 'Wes', 'Fox', A);
  eve = await newEmployee(w, 'S7', 'Eve', 'Gray', A, 'Office manager');
  proj = await newProject(w, A, 'P-100'); projInternal = await newProject(w, A, 'P-101', 'active', 'non_billable'); projB = await newProject(w, B, 'P-200'); projDone = await newProject(w, A, 'P-300', 'completed');
  E.other = await newEmployee(w2, 'X1', 'Zed', 'Other', w2.facilities.A!);
});
afterAll(async () => { await app.close(); await closePools(); });

describe('assignments', () => {
  let first: string; let second: string;
  it('books a person onto a project for hours per week, tentative by default, and shows it on the grid', async () => {
    const r = await as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(cy)));
    first = r.assignment.id;
    expect(r.warnings).toEqual([]);
    expect(r.assignment).toMatchObject({ state: 'tentative', billable: true, hours_per_week: 20, project_number: 'P-100' });
    const o = await as(w.opsA)((tx) => overview(tx, w.opsA, { from: W1, weeks: 3 }));
    const row = o.rows.find((x) => x.person.id === cy)!;
    expect(row.cells.map((c) => [c.weekStart, c.booked, c.status])).toEqual([[W1, 20, 'partial'], [addDays(W1, 7), 20, 'partial'], [addDays(W1, 14), 0, 'unbooked']]);
    expect(row.cells[0]).toMatchObject({ tentative: 20, confirmed: 0, label: 'Part booked' });
  });
  it('the default billable flag follows the project: an internal non-billable project books non-billable', async () => {
    const r = await as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(di, { projectId: projInternal, hoursPerWeek: 5 })));
    expect(r.assignment.billable).toBe(false);
  });
  it('warns about over-allocation without blocking, and stores the override reason', async () => {
    const pre = await as(w.opsA)((tx) => previewAssignment(tx, w.opsA, base(cy, { projectId: projInternal, hoursPerWeek: 30, state: 'confirmed' })));
    expect(pre.warnings).toHaveLength(2);
    expect(pre.warnings[0]).toMatchObject({ weekStart: W1, available: 40, alreadyBooked: 20, added: 30, total: 50, over: 10 });
    const r = await as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(cy, { projectId: projInternal, hoursPerWeek: 30, state: 'confirmed', overrideReason: 'Launch week; Dee covers support' })));
    second = r.assignment.id;
    expect(r.warnings).toHaveLength(2);
    expect(r.assignment.override_reason).toBe('Launch week; Dee covers support');
    const o = await as(w.opsA)((tx) => overview(tx, w.opsA, { from: W1, weeks: 1 }));
    expect(o.rows.find((x) => x.person.id === cy)!.cells[0]).toMatchObject({ booked: 50, over: 10, status: 'over', label: 'Over-allocated', confirmed: 30, tentative: 20 });
    // Without a reason it is still saved (a warning is not a block); the reason is simply empty.
    const r2 = await as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(cy, { projectId: projInternal, hoursPerWeek: 5, startDate: W1, endDate: W1 })));
    expect(r2.warnings).toHaveLength(1);
    expect(r2.assignment.override_reason).toBeNull();
    await as(w.opsA)((tx) => removeAssignment(tx, w.opsA, r2.assignment.id));
  });
  it('moving and editing an assignment is kept in an audit trail, and a removed one stays in the history', async () => {
    const moved = await as(w.opsA)((tx) => updateAssignment(tx, w.opsA, first, { employeeId: di, startDate: addDays(W1, 7), state: 'confirmed' }));
    expect(moved.assignment).toMatchObject({ employee_id: di, start_date: addDays(W1, 7), state: 'confirmed' });
    await as(w.opsA)((tx) => updateAssignment(tx, w.opsA, first, { hoursPerWeek: 25 }));
    const h = await as(w.opsA)((tx) => assignmentHistory(tx, w.opsA, first));
    expect(h.map((e: any) => e.action)).toEqual(['staffing.assignment_created', 'staffing.assignment_moved', 'staffing.assignment_edited']);
    expect(h[1].data.changed).toMatchObject({ employeeId: { from: cy, to: di }, startDate: { from: W1, to: addDays(W1, 7) } });
    await as(w.opsA)((tx) => removeAssignment(tx, w.opsA, first, 'Project paused'));
    expect((await as(w.opsA)((tx) => listAssignments(tx, w.opsA, { employeeId: di, includePast: true }))).map((a: any) => a.id)).not.toContain(first);
    const h2 = await as(w.opsA)((tx) => assignmentHistory(tx, w.opsA, first));
    expect(h2.at(-1)).toMatchObject({ action: 'staffing.assignment_removed', data: { reason: 'Project paused' } });
    await expect(as(w.opsA)((tx) => updateAssignment(tx, w.opsA, first, { hoursPerWeek: 1 }))).rejects.toThrow(/removed/);
    expect(second).toBeTruthy();
  });
  it('refuses nonsense: a finished project, an end before the start, hours out of range', async () => {
    await expect(as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(vic, { projectId: projDone })))).rejects.toThrow(/completed/);
    await expect(as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(vic, { endDate: addDays(W1, -1) })))).rejects.toThrow(/before the start/);
    await expect(as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(vic, { hoursPerWeek: 0 })))).rejects.toThrow(/hours per week/);
  });
});

describe('who may see and change what', () => {
  it('a person with only "view own" sees only themselves; a manager sees the site; nobody sees another site\'s people', async () => {
    expect((await as(w.techA)((tx) => visiblePeople(tx, w.techA))).map((p) => p.id)).toEqual([w.techAEmployeeId]);
    const ops = (await as(w.opsA)((tx) => visiblePeople(tx, w.opsA))).map((p) => p.id);
    expect(ops).toEqual(expect.arrayContaining([w.techAEmployeeId, w.tech2AEmployeeId, cy, di]));
    expect(ops).not.toContain(bea);
    expect((await as(w.exec)((tx) => visiblePeople(tx, w.exec))).map((p) => p.id)).toContain(bea);
    expect(await as(w.operatorB)((tx) => visiblePeople(tx, w.operatorB))).toEqual([]);
    await expect(as(w.techA)((tx) => personDetail(tx, w.techA, w.tech2AEmployeeId, {}))).rejects.toThrow(/person not found/);
    expect((await as(w.techA)((tx) => personDetail(tx, w.techA, w.techAEmployeeId, { from: W1, weeks: 2 }))).person.id).toBe(w.techAEmployeeId);
  });
  it('a manager sees the people who report to them, through the chain, and still not strangers', async () => {
    await db().query('UPDATE employee SET manager_employee_id = $1 WHERE id = $2', [w.techAEmployeeId, w.tech2AEmployeeId]);
    await db().query('UPDATE employee SET manager_employee_id = $1 WHERE id = $2', [w.tech2AEmployeeId, eve]);
    const ids = (await as(w.techA)((tx) => visiblePeople(tx, w.techA))).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([w.techAEmployeeId, w.tech2AEmployeeId, eve]));
    expect(ids).not.toContain(cy);
    expect((await as(w.techA)((tx) => overview(tx, w.techA, { from: W1, weeks: 1, managerId: w.techAEmployeeId }))).rows.map((r) => r.person.id)).toEqual([w.tech2AEmployeeId]);
  });
  it('changing anything needs the manage permission at the person\'s site and the project\'s site', async () => {
    await expect(as(w.techA)((tx) => createAssignment(tx, w.techA, base(w.techAEmployeeId)))).rejects.toThrow(/staffing.manage/);
    await expect(as(w.exec)((tx) => createAssignment(tx, w.exec, base(bea, { projectId: projB })))).rejects.toThrow(/staffing.manage/); // can view teams, not manage
    await expect(as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(bea)))).rejects.toThrow(/employee not found/); // people at other sites are not even visible
    await expect(as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(vic, { projectId: projB })))).rejects.toThrow(/project not found/); // project at B is not even visible
    await expect(as(w.techA)((tx) => saveSettings(tx, w.techA, { targetPct: 50 }))).rejects.toThrow(/staffing.manage/);
    await expect(as(w.opsA)((tx) => saveSettings(tx, w.opsA, { targetPct: 50 }))).rejects.toThrow(/company-wide/); // a site manager does not set company numbers
    await expect(as(w.opsA)((tx) => createHoliday(tx, w.opsA, { date: '2026-12-25', name: 'Christmas' }))).rejects.toThrow(/company-wide/);
    await expect(as(w.opsA)((tx) => saveTarget(tx, w.opsA, { jobTitle: 'Consultant', targetPct: 70 }))).rejects.toThrow(/company-wide/);
  });
  it('another company sees nothing of this one and cannot touch its assignments', async () => {
    expect((await as(w2.admin)((tx) => visiblePeople(tx, w2.admin))).map((p) => p.id)).not.toContain(cy);
    const mine = (await as(w.opsA)((tx) => listAssignments(tx, w.opsA, { includePast: true }))).map((a: any) => a.id);
    expect(mine.length).toBeGreaterThan(0);
    await expect(as(w2.admin)((tx) => updateAssignment(tx, w2.admin, mine[0], { hoursPerWeek: 1 }))).rejects.toThrow(/not found/);
    await expect(as(w2.admin)((tx) => createAssignment(tx, w2.admin, base(cy)))).rejects.toThrow(/not found/);
    expect(await as(w2.admin)((tx) => listAssignments(tx, w2.admin, { includePast: true }))).toEqual([]);
  });
});

describe('capacity from holidays, time off and working patterns', () => {
  const cell = async (who: Actor, id: string, week = W1) => (await as(who)((tx) => overview(tx, who, { from: week, weeks: 1 }))).rows.find((r) => r.person.id === id)!.cells[0]!;
  it('a site holiday takes the day off for that site only; a company-wide one for everyone', async () => {
    const hw = addDays(W1, 35); const thu = addDays(hw, 3);
    await as(w.opsA)((tx) => createHoliday(tx, w.opsA, { date: thu, name: 'Site day', facilityId: w.facilities.A! }));
    expect(await cell(w.opsA, vic, hw)).toMatchObject({ holiday: 8, available: 32 });
    await expect(as(w.opsA)((tx) => createHoliday(tx, w.opsA, { date: thu, name: 'Again', facilityId: w.facilities.A! }))).rejects.toThrow(/already a holiday/);
    expect(await cell(w.exec, bea, hw)).toMatchObject({ holiday: 0, available: 40 });
    await as(w.admin)((tx) => createHoliday(tx, w.admin, { date: addDays(hw, 4), name: 'Half day', hoursOff: 4 }));
    expect(await cell(w.exec, bea, hw)).toMatchObject({ holiday: 4, available: 36 });
    expect(await cell(w.opsA, vic, hw)).toMatchObject({ holiday: 12, available: 28 });
    // A full-time booking in a holiday week shrinks with the holidays and is not a conflict.
    const r = await as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(vic, { hoursPerWeek: 40, startDate: hw, endDate: addDays(hw, 6) })));
    expect(r.warnings).toEqual([]);
    expect(await cell(w.opsA, vic, hw)).toMatchObject({ booked: 28, available: 28, status: 'full' });
    await as(w.opsA)((tx) => removeAssignment(tx, w.opsA, r.assignment.id));
  });
  it('a request waits for a decision, is not counted until approved, and cannot be decided by its own maker', async () => {
    const week = addDays(W1, 14);
    const req = await as(hr)((tx) => requestTimeOff(tx, hr, { fromDate: week, toDate: addDays(week, 1), kind: 'vacation' }));
    expect(req).toMatchObject({ status: 'requested', employee_name: 'Hana Reyes' });
    expect(await cell(hr, hrEmp, week)).toMatchObject({ timeOff: 0, available: 40 });
    await expect(as(hr)((tx) => decideTimeOff(tx, hr, req.id, { decision: 'approve' }))).rejects.toThrow(/another manager/);
    await expect(as(w.techA)((tx) => decideTimeOff(tx, w.techA, req.id, { decision: 'approve' }))).rejects.toThrow(/staffing.manage/);
    await as(w.opsA)((tx) => decideTimeOff(tx, w.opsA, req.id, { decision: 'approve', comment: 'Enjoy' }));
    expect(await cell(w.opsA, hrEmp, week)).toMatchObject({ timeOff: 16, available: 24 });
    await expect(as(w.opsA)((tx) => decideTimeOff(tx, w.opsA, req.id, { decision: 'reject' }))).rejects.toThrow(/already approved/);
    await as(hr)((tx) => cancelTimeOff(tx, hr, req.id));
    expect(await cell(w.opsA, hrEmp, week)).toMatchObject({ timeOff: 0, available: 40 });
  });
  it('a rejected request counts for nothing; a manager entering time off for someone records it as approved; part days subtract hours', async () => {
    const week = addDays(W1, 21);
    const req = await as(w.techA)((tx) => requestTimeOff(tx, w.techA, { fromDate: week, toDate: week }));
    await as(w.opsA)((tx) => decideTimeOff(tx, w.opsA, req.id, { decision: 'reject', comment: 'Release day' }));
    expect(await cell(w.opsA, w.techAEmployeeId, week)).toMatchObject({ timeOff: 0 });
    const direct = await as(w.opsA)((tx) => requestTimeOff(tx, w.opsA, { employeeId: w.tech2AEmployeeId, fromDate: week, toDate: addDays(week, 2), hoursPerDay: 4, kind: 'training' }));
    expect(direct.status).toBe('approved');
    expect(await cell(w.opsA, w.tech2AEmployeeId, week)).toMatchObject({ timeOff: 12, available: 28 });
    await expect(as(w.techA)((tx) => requestTimeOff(tx, w.techA, { employeeId: w.tech2AEmployeeId, fromDate: week, toDate: week }))).rejects.toThrow(/staffing.manage/);
    await expect(as(w.techA)((tx) => requestTimeOff(tx, w.techA, { fromDate: week, toDate: addDays(week, -1) }))).rejects.toThrow(/before the first/);
  });
  it('reuses field service time off for technicians as full days off', async () => {
    const week = addDays(W1, 28);
    await db().query(`INSERT INTO technician_time_off (tenant_id, employee_id, from_date, to_date, reason, created_by) VALUES ($1, $2, $3, $4, 'Leave', $5)`, [w.tenantId, di, week, addDays(week, 1), w.admin.userId]);
    expect(await cell(w.opsA, di, week)).toMatchObject({ timeOff: 16, available: 24 });
    expect((await as(w.opsA)((tx) => listTimeOff(tx, w.opsA, { employeeId: di }))).filter((t: any) => t.source === 'field_service')).toHaveLength(1);
  });
  it('a working pattern changes the hours from its effective date; the company default week is a setting', async () => {
    await expect(as(w.opsA)((tx) => savePattern(tx, w.opsA, { employeeId: uma, effectiveFrom: W1, hours: [8, 8, 8] }))).rejects.toThrow(/seven values/);
    await as(w.opsA)((tx) => savePattern(tx, w.opsA, { employeeId: uma, effectiveFrom: addDays(W1, 7), hours: [6, 6, 6, 6, 0, 0, 0] }));
    expect(await cell(w.opsA, uma, addDays(W1, 7))).toMatchObject({ scheduled: 24, available: 24 });
    expect((await cell(w.opsA, uma, W1)).scheduled).toBe(40);
    await expect(as(w.opsA)((tx) => savePattern(tx, w.opsA, { employeeId: bea, effectiveFrom: W1, hours: [8, 8, 8, 8, 8, 0, 0] }))).rejects.toThrow(/employee not found/);
    const s = await as(w.admin)((tx) => saveSettings(tx, w.admin, { defaultHours: [9, 9, 9, 9, 0, 0, 0] }));
    expect(s.defaultHours).toEqual([9, 9, 9, 9, 0, 0, 0]);
    expect((await cell(w.opsA, eve, addDays(W1, 56))).scheduled).toBe(36);
    await as(w.admin)((tx) => saveSettings(tx, w.admin, { defaultHours: [8, 8, 8, 8, 8, 0, 0] }));
    const detail = await as(w.opsA)((tx) => personDetail(tx, w.opsA, uma, { from: W1, weeks: 2 }));
    expect(detail.patterns).toHaveLength(1);
  });
});

describe('utilization from approved billable time', () => {
  const P1 = '2026-09-07'; const P2 = '2026-09-14'; const TODAY = '2026-10-24';
  beforeAll(async () => {
    const A = w.facilities.A!;
    // Uma: week 1 approved (24 billable, 8 not billable), week 2 submitted (16 billable that must not count yet).
    await sheet(w, uma, A, P1, 'approved', [{ day: 0, hours: 6, billable: true, project: proj }, { day: 1, hours: 6, billable: true, project: proj }, { day: 2, hours: 6, billable: true, project: proj }, { day: 3, hours: 6, billable: true, project: proj }, { day: 4, hours: 8, billable: false }]);
    await sheet(w, uma, A, P2, 'submitted', [{ day: 0, hours: 8, billable: true, project: proj }, { day: 1, hours: 8, billable: true, project: proj }]);
    // Wes: approved, nothing billable. Vic: no timesheet at all.
    await sheet(w, wes, A, P1, 'approved', [{ day: 0, hours: 8, billable: false, project: projInternal }, { day: 1, hours: 8, billable: false }]);
    await sheet(w, wes, A, P2, 'approved', [{ day: 0, hours: 8, billable: false }]);
  });
  const people = async () => (await as(w.opsA)((tx) => visiblePeople(tx, w.opsA))).filter((p) => [uma, wes, vic].includes(p.id));
  const run = async (from: string, to: string, today = TODAY) => as(w.opsA)(async (tx) => utilizationFor(tx, await people(), { from, to }, await getSettings(tx), await loadTargets(tx), today));

  it('counts only approved billable hours; submitted hours are shown as pending, and a person with no approved time has no utilization', async () => {
    const rows = await run(P1, addDays(P2, 6));
    const u = rows.find((r) => r.id === uma)!;
    expect(u).toMatchObject({ available: 80, billable: 24, otherWorked: 8, pendingBillable: 16, utilization: 0.3, hasData: true, approvedSheets: 1 });
    expect(rows.find((r) => r.id === wes)).toMatchObject({ billable: 0, utilization: 0, hasData: true });
    expect(rows.find((r) => r.id === vic)).toMatchObject({ billable: 0, utilization: null, hasData: false, available: 80 });
  });
  it('time that is not billable never counts, even on a project', async () => {
    expect((await run(P1, addDays(P1, 6))).find((r) => r.id === wes)!.billable).toBe(0);
  });
  it('cuts the period at yesterday, and uses holidays and time off in what is available', async () => {
    const rows = await run(P1, '2026-09-30', '2026-09-10'); // today is Thursday 10 Sept: Monday to Wednesday have passed
    expect(rows.find((r) => r.id === uma)!.available).toBe(24);
    expect((await run(P1, P1, P1)).find((r) => r.id === uma)!.available).toBe(0); // the period has not started
    await db().query(`INSERT INTO employee_time_off (tenant_id, facility_id, employee_id, from_date, to_date, kind, status, requested_by) VALUES ($1, $2, $3, $4, $4, 'vacation', 'approved', $5)`, [w.tenantId, w.facilities.A, uma, addDays(P1, 4), w.admin.userId]);
    expect((await run(P1, addDays(P1, 6))).find((r) => r.id === uma)).toMatchObject({ available: 32, timeOff: 8, utilization: 0.75 });
    await db().query(`DELETE FROM employee_time_off WHERE employee_id = $1`, [uma]);
  });
  it('resolves targets: a person\'s own, then their job title\'s, then the company\'s', async () => {
    await as(w.admin)((tx) => saveTarget(tx, w.admin, { jobTitle: 'consultant', targetPct: 80 }));
    await as(w.opsA)((tx) => saveTarget(tx, w.opsA, { employeeId: vic, targetPct: 50 }));
    const rows = await run(P1, addDays(P2, 6));
    expect(rows.find((r) => r.id === uma)).toMatchObject({ target: 80, targetSource: 'role' });
    expect(rows.find((r) => r.id === vic)).toMatchObject({ target: 50, targetSource: 'person' });
    expect(rows.find((r) => r.id === uma)!.gap).toBeCloseTo(0.3 - 0.8, 5);
    await as(w.admin)((tx) => saveTarget(tx, w.admin, { employeeId: wes, targetPct: 10 }));
    await as(w.admin)((tx) => saveTarget(tx, w.admin, { employeeId: wes, targetPct: 20 })); // saving again replaces
    expect((await run(P1, addDays(P2, 6))).find((r) => r.id === wes)).toMatchObject({ target: 20, targetSource: 'person' });
    await expect(as(w.admin)((tx) => saveTarget(tx, w.admin, { targetPct: 50 }))).rejects.toThrow(/either a person or a job title/);
    const list = await as(w.opsA)(async (tx) => (await import('../src/modules/staffing/service.js')).listTargets(tx, w.opsA));
    expect(list.company).toBe(75);
    expect(list.targets).toHaveLength(3);
  });
  it('team figures use only people who have approved time, with an available-hours weighted target', async () => {
    const rows = await run(P1, addDays(P2, 6));
    const all = groupUtilization(rows.map((r) => ({ ...r, facility_code: 'all' })), 'site')[0]!;
    expect(all).toMatchObject({ people: 3, peopleWithData: 2, available: 160, billable: 24, pendingBillable: 16 });
    expect(all.utilization).toBeCloseTo(0.15, 5);
    expect(all.target).toBeCloseTo((80 * 80 + 20 * 80) / 160, 5);
    const byRole = groupUtilization(rows, 'role');
    expect(byRole.find((g) => g.key === 'consultant')).toMatchObject({ people: 2, peopleWithData: 2 });
    expect(byRole.find((g) => g.key === 'analyst')).toMatchObject({ utilization: null, peopleWithData: 0 });
    expect(groupUtilization(rows, 'person').map((g) => g.label)).toEqual(['Uma Dunn', 'Vic Evans', 'Wes Fox']);
  });
  it('someone not staffed on projects is left out; honest empty state when nobody has approved time', async () => {
    await as(w.opsA)((tx) => setTracking(tx, w.opsA, wes, { staffed: false, reason: 'Founder' }));
    const v = await as(w.opsA)((tx) => utilizationView(tx, w.opsA, { from: P1, to: addDays(P2, 6) }));
    expect(v.rows.map((r) => r.id)).not.toContain(wes);
    expect(v.anyData).toBe(true);
    const empty = await as(w2.admin)((tx) => utilizationView(tx, w2.admin, { from: P1, to: addDays(P2, 6) }));
    expect(empty).toMatchObject({ anyData: false });
    await as(w.opsA)((tx) => setTracking(tx, w.opsA, wes, { staffed: true }));
  });
  it('a person sees their own utilization, and their reports\', and nobody else\'s', async () => {
    const mine = await as(w.techA)((tx) => utilizationView(tx, w.techA, { from: P1, to: P2 }));
    expect(mine.rows.map((r) => r.id)).toContain(w.techAEmployeeId);
    expect(mine.rows.map((r) => r.id)).not.toContain(uma);
  });
});

describe('bench, over-allocation and the forecast', () => {
  beforeAll(async () => { await as(w.opsA)((tx) => createAssignment(tx, w.opsA, base(cy, { hoursPerWeek: 20, startDate: W1, endDate: addDays(W1, 6), overrideReason: 'Escalation' }))); });
  it('lists people booked under the bench threshold and the over-allocated weeks', async () => {
    const people = (await as(w.opsA)((tx) => visiblePeople(tx, w.opsA))).filter((p) => [cy, di, vic].includes(p.id));
    const settings = await as(w.opsA)((tx) => getSettings(tx));
    const r = await as(w.admin)((tx) => benchAndOver(tx, people, W1, 2, settings));
    expect(r.over.map((o) => [o.person.id, o.weekStart])).toEqual(expect.arrayContaining([[cy, W1]]));
    expect(r.bench.map((b) => b.person.id)).toContain(vic);
    expect(r.bench.map((b) => b.person.id)).not.toContain(cy);
  });
  it('totals capacity and booked hours by week, and adds free and over person by person', async () => {
    const people = (await as(w.opsA)((tx) => visiblePeople(tx, w.opsA))).filter((p) => [cy, vic].includes(p.id));
    const settings = await as(w.opsA)((tx) => getSettings(tx));
    const weeks = await as(w.admin)((tx) => forecast(tx, people, W1, 2, settings));
    // Week 1: Cy has 30 h confirmed and 20 h tentative against 40 h; Vic is free. Free and over are not netted against each other.
    expect(weeks[0]).toMatchObject({ weekStart: W1, capacity: 80, booked: 50, confirmed: 30, tentative: 20, free: 40, over: 10, overPeople: 1, plannedUtilization: 0.625 });
    expect(weeks[1]).toMatchObject({ capacity: 80, booked: 30, free: 50, over: 0, overPeople: 0 });
  });
});

describe('reports', () => {
  it('run in every format for a manager, and say plainly when there is nothing to show', async () => {
    for (const id of ['utilization', 'bench-and-overbooking', 'staffing-forecast']) {
      for (const [format, type] of [['csv', 'text/csv'], ['xlsx', 'spreadsheetml'], ['pdf', 'application/pdf']] as const) {
        const res = await app.inject({ method: 'GET', url: `/api/reports/${id}?format=${format}&from=${W1}`, headers: { authorization: `Bearer ${w.tokens.admin}` } });
        expect(res.statusCode, `${id} ${format}: ${res.body.slice(0, 200)}`).toBe(200);
        expect(String(res.headers['content-type'])).toContain(type);
      }
    }
    const empty = await app.inject({ method: 'GET', url: `/api/reports/utilization?from=2026-09-07&to=2026-09-20`, headers: { authorization: `Bearer ${w2.tokens.admin}` } });
    expect(empty.json().headline).toMatch(/No approved timesheets|No people/);
    const u = await app.inject({ method: 'GET', url: `/api/reports/utilization?from=2026-09-07&to=2026-09-20&by=role`, headers: { authorization: `Bearer ${w.tokens.admin}` } });
    expect(u.json().headline).toMatch(/^Utilization \d/);
    expect(u.json().rows.find((r: any) => r.label === 'Consultant')).toMatchObject({ billable: 24 });
    const bench = await app.inject({ method: 'GET', url: `/api/reports/bench-and-overbooking?from=${W1}&weeks=2`, headers: { authorization: `Bearer ${w.tokens.admin}` } });
    expect(bench.json().rows.some((r: any) => r.kind === 'Over-allocated' && r.person === 'Cy Adler')).toBe(true);
    expect(bench.json().rows.some((r: any) => r.kind === 'Bench')).toBe(true);
    const fc = await app.inject({ method: 'GET', url: `/api/reports/staffing-forecast?from=${W1}`, headers: { authorization: `Bearer ${w.tokens.admin}` } });
    expect(fc.json().rows).toHaveLength(13);
  });
  it('a report shows only the people the reader may see', async () => {
    const def = getReport('staffing-forecast')!;
    const out = await asActor(w.techA, (tx) => def.run(tx, w.techA, def.params.parse({ from: W1, weeks: 2 })));
    expect(out.scope.facilities).toEqual(['A']);
    expect(out.rows[0]).toMatchObject({ people: 3 }); // themselves and the two people under them
  });
});

describe('daily reminders', () => {
  it('warns managers once about over-allocation next week, people with nothing booked and utilization below target at month end', async () => {
    const today = addDays(W1, -5); // Wednesday before the over-booked week
    const first = await runReminders(w.tenantId, today);
    expect(first.staffing_overbooked).toBeGreaterThan(0);
    expect(first.staffing_unbooked).toBeGreaterThan(0);
    const n = await db().query(`SELECT user_id, title, body FROM notification WHERE tenant_id = $1 AND kind = 'reminder.staffing_overbooked'`, [w.tenantId]);
    expect(n.rows.some((r) => r.user_id === w.opsA.userId && /Cy Adler/.test(r.body))).toBe(true);
    expect(n.rows.every((r) => r.user_id !== w.techA.userId)).toBe(true);
    const again = await runReminders(w.tenantId, today);
    expect(again.staffing_overbooked ?? 0).toBe(0);
    expect(again.staffing_unbooked ?? 0).toBe(0);
    // Not the last day of the month: no utilization reminder. On the last day: once, naming people under target.
    expect(first.utilization_low ?? 0).toBe(0);
    const eom = await runReminders(w.tenantId, '2026-09-30');
    expect(eom.utilization_low).toBeGreaterThan(0);
    const low = await db().query(`SELECT body FROM notification WHERE tenant_id = $1 AND kind = 'reminder.utilization_low' AND user_id = $2`, [w.tenantId, w.opsA.userId]);
    expect(low.rows[0].body).toMatch(/Uma Dunn: \d+% against 80%/);
    expect((await runReminders(w.tenantId, '2026-09-30')).utilization_low ?? 0).toBe(0);
  });
  it('is switched off with the feature', async () => {
    await db().query(`INSERT INTO tenant_feature (tenant_id, feature_key, mode, role_keys, updated_by) VALUES ($1, 'utilization', 'off', '{}', $2) ON CONFLICT (tenant_id, feature_key) DO UPDATE SET mode = 'off'`, [w2.tenantId, w2.admin.userId]);
    const { forgetFeatures } = await import('../src/platform/features.js');
    forgetFeatures(w2.tenantId);
    const c = await runReminders(w2.tenantId, addDays(W1, -5));
    expect(c.staffing_unbooked ?? 0).toBe(0);
  });
});

describe('the API', () => {
  const call = (who: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens[who]}` }, payload: payload as any });
  it('serves the grid, saves an assignment with its warnings, and refuses by permission', async () => {
    const g = await call('opsA', 'GET', `/api/staffing/overview?from=${W1}&weeks=2`);
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().weeks).toHaveLength(2);
    expect(g.json().canManage).toBe(true);
    expect((await call('techA', 'GET', `/api/staffing/overview?from=${W1}`)).json().canManage).toBe(false);
    const body = { projectId: proj, employeeId: cy, hoursPerWeek: 40, startDate: W1, endDate: addDays(W1, 6), state: 'confirmed', overrideReason: 'Customer escalation' };
    const pre = await call('opsA', 'POST', '/api/staffing/assignments/preview', body);
    expect(pre.json().warnings.length).toBeGreaterThan(0);
    const made = await call('opsA', 'POST', '/api/staffing/assignments', body);
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().warnings.length).toBeGreaterThan(0);
    const id = made.json().assignment.id;
    expect((await call('techA', 'PATCH', `/api/staffing/assignments/${id}`, { hoursPerWeek: 10 })).statusCode).toBe(403);
    expect((await call('opsA', 'PATCH', `/api/staffing/assignments/${id}`, { hoursPerWeek: 10, employeeId: vic })).json().warnings).toEqual([]);
    expect((await call('opsA', 'GET', `/api/staffing/assignments/${id}/history`)).json()).toHaveLength(2);
    expect((await call('opsA', 'DELETE', `/api/staffing/assignments/${id}`)).statusCode).toBe(204);
    expect((await call('opsA', 'POST', '/api/staffing/assignments', { ...body, hoursPerWeek: 500 })).statusCode).toBe(422);
    expect((await call('opsA', 'GET', `/api/staffing/projects/${proj}?from=${W1}&weeks=2`)).json().project.number).toBe('P-100');
  });
  it('is refused where the feature is off for the user', async () => {
    await db().query(`INSERT INTO tenant_feature (tenant_id, feature_key, mode, role_keys, updated_by) VALUES ($1, 'utilization', 'roles', '{admin}', $2) ON CONFLICT (tenant_id, feature_key) DO UPDATE SET mode = 'roles', role_keys = '{admin}'`, [w.tenantId, w.admin.userId]);
    const { forgetFeatures } = await import('../src/platform/features.js');
    forgetFeatures(w.tenantId);
    const r = await call('techA', 'GET', `/api/staffing/overview?from=${W1}`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('feature_off');
    await db().query(`DELETE FROM tenant_feature WHERE tenant_id = $1 AND feature_key = 'utilization'`, [w.tenantId]);
    forgetFeatures(w.tenantId);
  });
});
