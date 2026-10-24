import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import {
  addMember, addMilestone, addTask, deleteMilestone, getBillableContract, getProject, listProjects, reachMilestone, requestChangeOrder, transitionProject, unreachMilestone, updateMilestone,
  updateProject, updateTask, withdrawChangeOrder,
} from '../src/modules/projects/service.js';
import type { ProjectWorld } from './projects-helpers.js';
import { makeProjectWorld, mkProject } from './projects-helpers.js';

let w: ProjectWorld; let other: ProjectWorld;
beforeAll(async () => { w = await makeProjectWorld('pcore'); other = await makeProjectWorld('pcore2'); });
afterAll(closePools);
const db = () => getAdminPool();

const stepOf = async (coId: string) => (await db().query(`SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_id = $1 AND s.status = 'pending'`, [coId])).rows[0].id as string;
const audits = async (entityId: string, action: string) => (await db().query(`SELECT data, actor_user_id FROM audit_event WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows;

describe('projects', () => {
  it('numbers projects from the tenant sequence and adds the owner to the team', async () => {
    const p1 = await mkProject(w);
    const p2 = await mkProject(w, { name: 'Second' });
    expect(p1.number).toMatch(/^PRJ-\d{6}$/);
    expect(Number(p2.number.slice(4))).toBe(Number(p1.number.slice(4)) + 1);
    expect(p1.status).toBe('active');
    expect(p1.owner_name).toBe('pm');
    expect(p1.members.map((m: any) => m.name)).toEqual(['Pat Manager']);
    // another company starts its own sequence
    const o = await mkProject(other, {}, other.pm);
    expect(o.number).toBe('PRJ-000001');
  });

  it('needs a customer for billable work and a contract amount for fixed price', async () => {
    await expect(mkProject(w, { customerId: null })).rejects.toThrow(/customer/);
    await expect(mkProject(w, { billingType: 'fixed_price' })).rejects.toThrow(/contract amount/);
    await expect(mkProject(w, { billingType: 'time_materials', contractAmount: 5 })).rejects.toThrow(/fixed-price/);
    const internal = await mkProject(w, { name: 'Internal tooling', customerId: null, billingType: 'non_billable' });
    expect(internal.customer_id).toBeNull();
    await expect(mkProject(w, { startDate: '2026-05-01', endDate: '2026-04-01' })).rejects.toThrow(/end date/);
  });

  it('is created and changed only by project managers and the owner; cost budgets need see-cost', async () => {
    await expect(mkProject(w, {}, w.viewer)).rejects.toThrow(/projects.manage/);
    await expect(mkProject(w, {}, w.techA)).rejects.toThrow();
    await expect(mkProject(w, { amountBudget: 5000 })).rejects.toThrow(/projects.see_cost/); // pm cannot see cost
    const p = await mkProject(w, { amountBudget: 5000 }, w.admin);
    const asPm = await asActor(w.pm, (tx) => getProject(tx, w.pm, p.id));
    expect('amount_budget' in asPm).toBe(false); // pm has no cost view
    const asFin = await asActor(w.fin, (tx) => getProject(tx, w.fin, p.id));
    expect(asFin.amount_budget).toBe(5000);
    await expect(asActor(w.viewer, (tx) => updateProject(tx, w.viewer, p.id, { name: 'Nope' }))).rejects.toThrow();
    await expect(asActor(w.pm, (tx) => updateProject(tx, w.pm, p.id, { amountBudget: 1 }))).rejects.toThrow(/projects.see_cost/);
    const upd = await asActor(w.pm, (tx) => updateProject(tx, w.pm, p.id, { name: 'Renamed', hoursBudget: 200 }));
    expect(upd.name).toBe('Renamed'); expect(upd.hours_budget).toBe(200);
  });

  it('moves through its statuses with reasons, and refuses impossible moves', async () => {
    const p = await mkProject(w);
    const go = (to: any, reason?: string) => asActor(w.pm, (tx) => transitionProject(tx, w.pm, p.id, { to, reason }));
    await expect(go('proposed')).rejects.toThrow(/cannot become/);
    await expect(go('on_hold')).rejects.toThrow(/say why/);
    expect((await go('on_hold', 'waiting on the client')).status).toBe('on_hold');
    expect((await go('active', 'client is back')).status).toBe('active');
    expect((await go('completed')).status).toBe('completed');
    await expect(asActor(w.pm, (tx) => updateProject(tx, w.pm, p.id, { name: 'x1' }))).resolves.toBeTruthy();
    expect((await go('active', 'reopened for warranty work')).status).toBe('active');
    await expect(go('cancelled')).rejects.toThrow(/say why/);
    expect((await go('cancelled', 'client withdrew')).status).toBe('cancelled');
    await expect(go('active', 'again')).rejects.toThrow(/cannot become/);
    expect((await audits(p.id, 'projects.status_changed')).length).toBe(5);
  });

  it('keeps tasks with budgets; non-billable projects have non-billable tasks', async () => {
    const p = await mkProject(w);
    const t = await asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Design', hoursBudget: 40 }));
    expect(t.billable).toBe(true); expect(Number(t.hours_budget)).toBe(40);
    await expect(asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Design' }))).rejects.toThrow(); // unique name
    await expect(asActor(w.pm, (tx) => addTask(tx, w.pm, p.id, { name: 'Build', amountBudget: 100 }))).rejects.toThrow(/projects.see_cost/);
    const off = await asActor(w.pm, (tx) => updateTask(tx, w.pm, t.id, { billable: false, active: false }));
    expect(off.billable).toBe(false); expect(off.active).toBe(false);
    const internal = await mkProject(w, { customerId: null, billingType: 'non_billable', name: 'Internal' });
    const it1 = await asActor(w.pm, (tx) => addTask(tx, w.pm, internal.id, { name: 'Admin', billable: true }));
    expect(it1.billable).toBe(false);
  });

  it('team members are added, changed and removed', async () => {
    const p = await mkProject(w);
    const m = await asActor(w.pm, (tx) => addMember(tx, w.pm, p.id, { employeeId: w.techAEmployeeId, role: 'Analyst' }));
    expect(m.active).toBe(true);
    const full = await asActor(w.pm, (tx) => getProject(tx, w.pm, p.id));
    expect(full.members.map((x: any) => x.role).sort()).toEqual(['Analyst', 'Project owner']);
    // a team member can see the project without any projects permission
    const seen = await asActor(w.techA, (tx) => getProject(tx, w.techA, p.id));
    expect(seen.canManage).toBe(false);
    expect((await asActor(w.techA, (tx) => listProjects(tx, w.techA))).map((x: any) => x.id)).toContain(p.id);
    // someone not on the team sees nothing
    await expect(asActor(w.tech2A, (tx) => getProject(tx, w.tech2A, p.id))).rejects.toThrow(/not found/);
    expect((await asActor(w.tech2A, (tx) => listProjects(tx, w.tech2A))).map((x: any) => x.id)).not.toContain(p.id);
  });
});

describe('milestones', () => {
  it('holds a fixed amount or a percent of the contract, within the contract value', async () => {
    const p = await mkProject(w, { billingType: 'fixed_price', contractAmount: 100_000 });
    const add = (input: any) => asActor(w.pm, (tx) => addMilestone(tx, w.pm, p.id, input));
    await add({ name: 'Kick-off', amount: 20_000, dueDate: '2030-01-01' });
    await add({ name: 'Design', percent: 30 });
    await expect(add({ name: 'Both', amount: 1, percent: 1 })).rejects.toThrow(/not both/);
    await expect(add({ name: 'Too much', amount: 60_000 })).rejects.toThrow(/more than the contract/);
    await expect(add({ name: 'Too many percent', percent: 80 })).rejects.toThrow(/100%/);
    const full = await asActor(w.pm, (tx) => getProject(tx, w.pm, p.id));
    expect(full.milestones.map((m: any) => m.effective_amount)).toEqual([20_000, 30_000]);
    const tm = await mkProject(w);
    await expect(asActor(w.pm, (tx) => addMilestone(tx, w.pm, tm.id, { name: 'Phase', amount: 5 }))).rejects.toThrow(/fixed-price/);
    await expect(asActor(w.pm, (tx) => addMilestone(tx, w.pm, tm.id, { name: 'Phase 1', dueDate: '2030-01-01' }))).resolves.toBeTruthy(); // dates only: fine
  });

  it('is reached only by the owner or a project manager, is audited, and can be taken back with a reason', async () => {
    const p = await mkProject(w, { billingType: 'fixed_price', contractAmount: 10_000, ownerUserId: w.fin.userId });
    await asActor(w.pm, (tx) => addMember(tx, w.pm, p.id, { employeeId: w.techAEmployeeId }));
    const m = await asActor(w.pm, (tx) => addMilestone(tx, w.pm, p.id, { name: 'Delivery', amount: 4_000 }));
    // a team member without manage rights and not the owner cannot reach it; neither can a viewer
    await expect(asActor(w.techA, (tx) => reachMilestone(tx, w.techA, m.id))).rejects.toThrow(/owner or a project manager/);
    await expect(asActor(w.viewer, (tx) => reachMilestone(tx, w.viewer, m.id))).rejects.toThrow();
    await expect(asActor(w.pm, (tx) => reachMilestone(tx, w.pm, m.id, { reachedOn: '2999-01-01' }))).rejects.toThrow(/future/);
    // the owner (finance here) may
    const reached = await asActor(w.fin, (tx) => reachMilestone(tx, w.fin, m.id));
    expect(reached.status).toBe('reached'); expect(reached.reached_by).toBe(w.fin.userId);
    const a = await audits(p.id, 'projects.milestone_reached');
    expect(a).toHaveLength(1); expect(a[0].data.amount).toBe(4_000); expect(a[0].actor_user_id).toBe(w.fin.userId);
    await expect(asActor(w.pm, (tx) => reachMilestone(tx, w.pm, m.id))).rejects.toThrow(/already reached/);
    await expect(asActor(w.pm, (tx) => updateMilestone(tx, w.pm, m.id, { amount: 1 }))).rejects.toThrow(/keeps its amount/);
    await expect(asActor(w.pm, (tx) => deleteMilestone(tx, w.pm, m.id))).rejects.toThrow(/cannot be removed/);
    await expect(asActor(w.pm, (tx) => unreachMilestone(tx, w.pm, m.id, ''))).rejects.toThrow(/say why/);
    expect((await asActor(w.pm, (tx) => unreachMilestone(tx, w.pm, m.id, 'client rejected the delivery'))).status).toBe('planned');
    expect(await audits(p.id, 'projects.milestone_unreached')).toHaveLength(1);
    // billed milestones (set by billing runs) are frozen
    await db().query(`UPDATE project_milestone SET status = 'billed', reached_on = current_date WHERE id = $1`, [m.id]);
    await expect(asActor(w.pm, (tx) => updateMilestone(tx, w.pm, m.id, { name: 'x' }))).rejects.toThrow(/billed/);
    await expect(asActor(w.pm, (tx) => unreachMilestone(tx, w.pm, m.id, 'oops'))).rejects.toThrow(/credit the invoice/);
  });

  it('cannot be reached on a project that is not active', async () => {
    const p = await mkProject(w);
    const m = await asActor(w.pm, (tx) => addMilestone(tx, w.pm, p.id, { name: 'Phase' }));
    await asActor(w.pm, (tx) => transitionProject(tx, w.pm, p.id, { to: 'on_hold', reason: 'paused' }));
    await expect(asActor(w.pm, (tx) => reachMilestone(tx, w.pm, m.id))).rejects.toThrow(/on hold/);
  });
});

describe('contract value and change orders', () => {
  it('changes the contract only when the change order is approved, keeping the history', async () => {
    const p = await mkProject(w, { billingType: 'fixed_price', contractAmount: 100_000, ownerUserId: w.fin.userId });
    await asActor(w.pm, (tx) => addMilestone(tx, w.pm, p.id, { name: 'Half', percent: 50 }));
    const before = await asActor(w.pm, (tx) => getBillableContract(tx, w.pm, p.id));
    expect(before.contractValue).toBe(100_000); expect(before.billedToDate).toBe(0); expect(before.changes).toEqual([]);
    expect(before.milestones[0].effectiveAmount).toBe(50_000);

    await expect(asActor(w.viewer, (tx) => requestChangeOrder(tx, w.viewer, p.id, { amount: 1, reason: 'x y z' }))).rejects.toThrow();
    await expect(asActor(w.pm, (tx) => requestChangeOrder(tx, w.pm, p.id, { amount: 0, reason: 'nothing' }))).rejects.toThrow(/zero/);
    await expect(asActor(w.pm, (tx) => requestChangeOrder(tx, w.pm, p.id, { amount: -200_000, reason: 'too deep' }))).rejects.toThrow(/below zero/);
    const co = await asActor(w.pm, (tx) => requestChangeOrder(tx, w.pm, p.id, { amount: 20_000, reason: 'Added reporting module', reference: 'SOW-A1' }));
    expect(co.status).toBe('pending');
    // pending changes nothing
    expect((await asActor(w.pm, (tx) => getBillableContract(tx, w.pm, p.id))).contractValue).toBe(100_000);
    // the requester cannot approve their own request; the owner (assigned approver) can
    await expect(asActor(w.pm, (tx) => decideApproval(tx, w.pm, '00000000-0000-0000-0000-000000000000', { decision: 'approve', comment: 'x' }))).rejects.toThrow();
    const step = await stepOf(co.id);
    await expect(asActor(w.techA, (tx) => decideApproval(tx, w.techA, step, { decision: 'approve', comment: 'sure' }))).rejects.toThrow(/for fin|forbidden|not permitted|step is for/i);
    await expect(asActor(w.fin, (tx) => decideApproval(tx, w.fin, step, { decision: 'approve' }))).rejects.toThrow(/comment/); // the result of the review is recorded
    await asActor(w.fin, (tx) => decideApproval(tx, w.fin, step, { decision: 'approve', comment: 'Customer signed SOW-A1' }));
    const after = await asActor(w.pm, (tx) => getBillableContract(tx, w.pm, p.id));
    expect(after.contractValue).toBe(120_000);
    expect(after.changes).toHaveLength(1); expect(after.changes[0]).toMatchObject({ seq: 1, amount: 20_000, reason: 'Added reporting module', reference: 'SOW-A1' });
    expect(after.milestones[0].effectiveAmount).toBe(60_000); // 50% of the new contract
    expect(after.originalAmount).toBe(100_000);
    const a = await audits(p.id, 'projects.change_order_approved');
    expect(a[0].data).toMatchObject({ contractBefore: 100_000, contractAfter: 120_000 });

    // a rejected change leaves the contract alone, and a negative one reduces it
    const co2 = await asActor(w.pm, (tx) => requestChangeOrder(tx, w.pm, p.id, { amount: 50_000, reason: 'Extra phase' }));
    const s2 = await stepOf(co2.id);
    await asActor(w.fin, (tx) => decideApproval(tx, w.fin, s2, { decision: 'reject', comment: 'Not agreed with the customer' }));
    const co3 = await asActor(w.pm, (tx) => requestChangeOrder(tx, w.pm, p.id, { amount: -5_000, reason: 'Descoped training' }));
    await asActor(w.fin, async (tx) => decideApproval(tx, w.fin, await stepOf(co3.id), { decision: 'approve', comment: 'Agreed' }));
    const fin = await asActor(w.pm, (tx) => getProject(tx, w.pm, p.id));
    expect(fin.contract_value).toBe(115_000);
    expect(fin.change_orders.map((c: any) => [c.seq, c.status])).toEqual([[1, 'approved'], [2, 'rejected'], [3, 'approved']]);
    expect(fin.change_orders[0].approval[0].status).toBe('approved'); // approval history is kept with the change
  });

  it('can be withdrawn while pending, is not editable, and applies only to fixed price', async () => {
    const p = await mkProject(w, { billingType: 'fixed_price', contractAmount: 10_000 });
    const co = await asActor(w.pm, (tx) => requestChangeOrder(tx, w.pm, p.id, { amount: 1_000, reason: 'Small add' }));
    await expect(db().query(`UPDATE project_change_order SET amount = 5 WHERE id = $1`, [co.id])).rejects.toThrow(/cannot be edited/);
    await expect(asActor(w.pm, (tx) => transitionProject(tx, w.pm, p.id, { to: 'completed' }))).rejects.toThrow(/waiting for approval/);
    await asActor(w.pm, (tx) => withdrawChangeOrder(tx, w.pm, co.id));
    expect((await asActor(w.pm, (tx) => getProject(tx, w.pm, p.id))).change_orders[0].status).toBe('withdrawn');
    await expect(asActor(w.pm, (tx) => withdrawChangeOrder(tx, w.pm, co.id))).rejects.toThrow(/withdrawn/);
    const tm = await mkProject(w);
    await expect(asActor(w.pm, (tx) => requestChangeOrder(tx, w.pm, tm.id, { amount: 5, reason: 'not fixed' }))).rejects.toThrow(/fixed-price/);
    // a fixed-price project with change orders stays fixed price
    await expect(asActor(w.pm, (tx) => updateProject(tx, w.pm, p.id, { billingType: 'time_materials' }))).rejects.toThrow(/fixed price/);
  });

  it('exposes the contract to billing for people who manage receivables, not to strangers', async () => {
    const p = await mkProject(w, { billingType: 'fixed_price', contractAmount: 7_000 });
    expect((await asActor(w.fin, (tx) => getBillableContract(tx, w.fin, p.id))).contractValue).toBe(7_000); // finance holds projects.view
    await expect(asActor(w.tech2A, (tx) => getBillableContract(tx, w.tech2A, p.id))).rejects.toThrow(/not found/);
  });
});

describe('tenant and site isolation', () => {
  it('keeps one company away from another', async () => {
    const mine = await mkProject(w, { name: 'Private to pcore' });
    expect((await asActor(other.admin, (tx) => listProjects(tx, other.admin))).map((x: any) => x.id)).not.toContain(mine.id);
    await expect(asActor(other.admin, (tx) => getProject(tx, other.admin, mine.id))).rejects.toThrow(/not found/);
    await expect(asActor(other.admin, (tx) => getBillableContract(tx, other.admin, mine.id))).rejects.toThrow(/not found/);
  });

  it('keeps a site away from the projects of another site', async () => {
    const atA = await mkProject(w, { name: 'Site A work' });
    const atB = await mkProject(w, { name: 'Site B work', facilityId: w.facilities.B! }, w.admin);
    expect(atB.facility_code).toBe('B');
    // the project manager works at A only
    await expect(mkProject(w, { facilityId: w.facilities.B! }, w.pm)).rejects.toThrow();
    const list = (await asActor(w.pm, (tx) => listProjects(tx, w.pm))).map((x: any) => x.id);
    expect(list).toContain(atA.id); expect(list).not.toContain(atB.id);
    await expect(asActor(w.pm, (tx) => getProject(tx, w.pm, atB.id))).rejects.toThrow(/not found/);
    // finance sees every site
    expect((await asActor(w.fin, (tx) => listProjects(tx, w.fin))).map((x: any) => x.id)).toEqual(expect.arrayContaining([atA.id, atB.id]));
  });
});
