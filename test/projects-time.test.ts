import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createReport, getReport, saveLine } from '../src/modules/expenses/service.js';
import { addMember, addTask, transitionProject, updateProject } from '../src/modules/projects/service.js';
import { addDays, addEntry, createPayrollExport, decideTimesheet, getOrCreateTimesheet, getTimesheet, removeEntry, submitTimesheet, teamWeek, timesheetProjectOptions } from '../src/modules/time/service.js';
import type { ProjectWorld } from './projects-helpers.js';
import { W1, makeProjectWorld, mkProject } from './projects-helpers.js';

let w: ProjectWorld;
beforeAll(async () => { w = await makeProjectWorld('ptime'); });
afterAll(closePools);

const sheet = (who: any, employeeId: string | undefined, week = W1) => asActor(who, (tx) => getOrCreateTimesheet(tx, who, { weekStart: week, employeeId }));
const add = (who: any, id: string, input: any) => asActor(who, (tx) => addEntry(tx, who, id, { earningCode: 'REG', workDate: addDays(W1, 1), hours: 4, ...input }));
const view = (who: any, id: string) => asActor(who, (tx) => getTimesheet(tx, who, id));

describe('time against projects', () => {
  it('lets a team member book hours with an optional task, as a project entry', async () => {
    const p = await mkProject(w, { name: 'Audit' });
    const t = await asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Fieldwork' }));
    await asActor(w.pm, (tx) => addMember(tx, w.pm, p.id, { employeeId: w.techAEmployeeId }));
    const ts = await sheet(w.techA, undefined);
    const e = await add(w.techA, ts.id, { projectId: p.id, taskId: t.id, note: 'site visit' });
    expect(e.source).toBe('project'); expect(e.project_id).toBe(p.id); expect(e.project_task_id).toBe(t.id); expect(e.billable).toBe(true);
    const v = await view(w.techA, ts.id);
    expect(v.entries[0]).toMatchObject({ project_number: p.number, project_task_name: 'Fieldwork', billable: true, source: 'project' });
    expect(v.projectHours).toBe(4); expect(v.total).toBe(4); expect(v.worked).toBe(4);
  });

  it('refuses people who are not on the team unless the project is open to all staff', async () => {
    const p = await mkProject(w, { name: 'Closed team' });
    const ts = await sheet(w.tech2A, undefined);
    await expect(add(w.tech2A, ts.id, { projectId: p.id })).rejects.toThrow(/not on the team/);
    // not even a project they cannot see leaks: an unknown id is a plain refusal
    await expect(add(w.tech2A, ts.id, { projectId: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/not found/);
    await asActor(w.pm, (tx) => updateProject(tx, w.pm, p.id, { openToAll: true }));
    const e = await add(w.tech2A, ts.id, { projectId: p.id });
    expect(e.source).toBe('project');
    // removed members lose the right again
    const q = await mkProject(w, { name: 'Removed' });
    const m = await asActor(w.pm, (tx) => addMember(tx, w.pm, q.id, { employeeId: w.tech2AEmployeeId }));
    await getAdminPool().query('UPDATE project_member SET active = false WHERE id = $1', [m.id]);
    await expect(add(w.tech2A, ts.id, { projectId: q.id })).rejects.toThrow(/not on the team/);
  });

  it('defaults billable from the task and project, and never lets non-billable work be billed', async () => {
    const p = await mkProject(w, { name: 'Billing defaults', openToAll: true });
    const free = await asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Pre-sales', billable: false }));
    const paid = await asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Delivery' }));
    const ts = await sheet(w.techA, undefined);
    expect((await add(w.techA, ts.id, { projectId: p.id })).billable).toBe(true);                       // project default
    expect((await add(w.techA, ts.id, { projectId: p.id, taskId: free.id })).billable).toBe(false);     // task default
    expect((await add(w.techA, ts.id, { projectId: p.id, taskId: free.id, billable: true })).billable).toBe(false); // cannot override upward
    expect((await add(w.techA, ts.id, { projectId: p.id, taskId: paid.id, billable: false })).billable).toBe(false); // may write off
    const internal = await mkProject(w, { name: 'Internal', customerId: null, billingType: 'non_billable', openToAll: true });
    expect((await add(w.techA, ts.id, { projectId: internal.id, billable: true })).billable).toBe(false);
    expect((await add(w.techA, ts.id, { projectId: internal.id })).billable).toBe(false);
    // a plain entry without a project stays a manual, non-billable entry
    const plain = await add(w.techA, ts.id, { note: 'training' });
    expect(plain).toMatchObject({ source: 'manual', billable: false, project_id: null });
    await expect(add(w.techA, ts.id, { billable: true })).rejects.toThrow(/choose the project/);
  });

  it('allows only active projects, tasks of the same project, and worked time', async () => {
    const a = await mkProject(w, { name: 'A', openToAll: true });
    const b = await mkProject(w, { name: 'B', openToAll: true });
    const bTask = await asActor(w.pm, (tx) => addTask(tx, w.pm, b.id, { name: 'Other task' }));
    const ts = await sheet(w.techA, undefined);
    await expect(add(w.techA, ts.id, { projectId: a.id, taskId: bTask.id })).rejects.toThrow(/active task of that project/);
    await expect(add(w.techA, ts.id, { projectId: a.id, earningCode: 'PTO' })).rejects.toThrow(/worked time/);
    await asActor(w.pm, (tx) => transitionProject(tx, w.pm, a.id, { to: 'on_hold', reason: 'paused' }));
    await expect(add(w.techA, ts.id, { projectId: a.id })).rejects.toThrow(/only to active projects/);
    const proposed = await mkProject(w, { name: 'Proposal', status: 'proposed', openToAll: true });
    await expect(add(w.techA, ts.id, { projectId: proposed.id })).rejects.toThrow(/only to active projects/);
  });

  it('offers a person only the projects they may book to', async () => {
    const mine = await mkProject(w, { name: 'Mine to book' });
    await asActor(w.pm, (tx) => addMember(tx, w.pm, mine.id, { employeeId: w.techAEmployeeId }));
    const shared = await mkProject(w, { name: 'Everyone', openToAll: true });
    const hidden = await mkProject(w, { name: 'Not for techA' });
    await asActor(w.pm, (tx) => addTask(tx, w.pm, mine.id, { name: 'Only task' }));
    const ts = await sheet(w.techA, undefined);
    const options = await asActor(w.techA, (tx) => timesheetProjectOptions(tx, w.techA, ts.id));
    const ids = options.map((o: any) => o.id);
    expect(ids).toContain(mine.id); expect(ids).toContain(shared.id); expect(ids).not.toContain(hidden.id);
    expect(options.find((o: any) => o.id === mine.id).tasks.map((t: any) => t.name)).toEqual(['Only task']);
    // someone else's timesheet is not readable by a colleague
    await expect(asActor(w.tech2A, (tx) => timesheetProjectOptions(tx, w.tech2A, ts.id))).rejects.toThrow();
  });
});

describe('weekly totals, approval and payroll are unchanged by project hours', () => {
  it('counts project hours in the week, the team view and the payroll file as regular hours', async () => {
    const p = await mkProject(w, { name: 'Payroll check', openToAll: true });
    const ts = await sheet(w.tech2A, undefined, addDays(W1, -14));
    const wk = addDays(W1, -14);
    await add(w.tech2A, ts.id, { workDate: wk, projectId: p.id, hours: 8 });
    await add(w.tech2A, ts.id, { workDate: addDays(wk, 1), projectId: p.id, hours: 6.5 });
    await add(w.tech2A, ts.id, { workDate: addDays(wk, 2), hours: 3, note: 'training' });
    const draft = await view(w.tech2A, ts.id);
    expect(draft.total).toBe(17.5); expect(draft.projectHours).toBe(14.5);
    expect(draft.days[0].hours).toBe(8);
    const team = await asActor(w.pm, (tx) => teamWeek(tx, w.pm, wk));
    expect(team.find((r: any) => r.employee_id === w.tech2AEmployeeId).hours).toBe(17.5);
    await asActor(w.tech2A, (tx) => submitTimesheet(tx, w.tech2A, ts.id));
    const submitted = await view(w.tech2A, ts.id);
    expect(submitted.total).toBe(17.5); expect(submitted.status).toBe('submitted');
    await expect(add(w.tech2A, ts.id, { projectId: p.id })).rejects.toThrow(/submitted/);
    await asActor(w.pm, (tx) => decideTimesheet(tx, w.pm, ts.id, { decision: 'approve' }));
    // the approved week cannot be edited, and project entries cannot be removed from it
    const entry = submitted.entries.find((e: any) => e.source === 'project');
    await expect(asActor(w.tech2A, (tx) => removeEntry(tx, w.tech2A, entry.id))).rejects.toThrow();
    const exp = await asActor(w.admin, (tx) => createPayrollExport(tx, w.admin, { from: wk, to: wk }));
    const csv = (await getAdminPool().query('SELECT content FROM payroll_export WHERE id = $1', [exp.id])).rows[0].content as string;
    const line = csv.split('\n').find((l) => l.includes('E101'))!;
    expect(line).toContain(',REG,17.5'); // project and manual hours both pay as regular hours
    expect(csv).not.toMatch(/project/i);
  });

  it('lets a draft project entry be removed', async () => {
    const p = await mkProject(w, { name: 'Remove me', openToAll: true });
    const ts = await sheet(w.techA, undefined, addDays(W1, -21));
    const e = await add(w.techA, ts.id, { workDate: addDays(W1, -21), projectId: p.id });
    await asActor(w.techA, (tx) => removeEntry(tx, w.techA, e.id));
    expect((await view(w.techA, ts.id)).entries).toHaveLength(0);
  });
});

describe('expense lines on projects', () => {
  it('names a project and a billable flag, with the same team rule', async () => {
    const p = await mkProject(w, { name: 'Travel project' });
    const closed = await mkProject(w, { name: 'Closed expenses' });
    await asActor(w.pm, (tx) => addMember(tx, w.pm, p.id, { employeeId: w.techAEmployeeId }));
    const cat = (await getAdminPool().query(`SELECT id FROM expense_category WHERE tenant_id = $1 AND code = 'SUPPLIES'`, [w.tenantId])).rows[0].id as string;
    const r = await asActor(w.techA, (tx) => createReport(tx, w.techA, { title: 'Client visit' }));
    const line = (input: any) => asActor(w.techA, (tx) => saveLine(tx, w.techA, r.id, { spentOn: new Date().toISOString().slice(0, 10), categoryId: cat, amount: 20, description: 'Printing', ...input }));
    expect(await line({})).toMatchObject({ project_id: null, billable: false });
    expect(await line({ projectId: p.id })).toMatchObject({ project_id: p.id, billable: false }); // never billed by accident
    expect(await line({ projectId: p.id, billable: true })).toMatchObject({ billable: true });
    await expect(line({ projectId: closed.id })).rejects.toThrow(/not on the team/);
    await expect(line({ billable: true })).rejects.toThrow(/choose the project/);
    const internal = await mkProject(w, { name: 'Internal expenses', customerId: null, billingType: 'non_billable', openToAll: true });
    expect(await line({ projectId: internal.id, billable: true })).toMatchObject({ billable: false });
    const shown = await asActor(w.techA, (tx) => getReport(tx, w.techA, r.id));
    expect(shown.lines.filter((l: any) => l.project_number).length).toBe(3);
  });
});
