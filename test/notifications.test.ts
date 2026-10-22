import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { createDelegation, myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import { assignTechnician, createWorkOrder } from '../src/modules/maintenance/service.js';
import type { MailSender } from '../src/modules/notifications/mail.js';
import { queueDigests, sendQueued } from '../src/modules/notifications/mail.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { listMine, markRead, setPreferences, unreadCount } from '../src/modules/notifications/service.js';
import { createPlan } from '../src/modules/pm/service.js';
import { createPurchaseRequest, submitPurchaseRequest } from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

let w: World;
let assetId: string;
const today = new Date().toISOString().slice(0, 10);
const mine = (who: Actor) => asActor(who, (tx) => listMine(tx, who));
const kinds = async (who: Actor) => (await mine(who)).map((n) => n.kind);
const sign = async (who: Actor, subjectId: string) => {
  const step = (await asActor(who, (tx) => myApprovalQueue(tx, who))).find((q) => q.subject_id === subjectId);
  return asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision: 'approve' }));
};

beforeAll(async () => {
  w = await makeWorld('ntf');
  assetId = (await asActor(w.managerA, (tx) => createAsset(tx, w.managerA, { facilityId: w.facilities.A!, assetTag: 'PMP-4', name: 'Coolant pump' }))).id;
});
afterAll(closePools);

describe('event notifications', () => {
  it('approvers are told when a request reaches their stage; the requester when it is decided', async () => {
    const pr = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Pump seal kit',
      lines: [{ description: 'Mechanical seal kit', qty: 1, estUnitPrice: 2800 }] }));
    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, pr.id));
    // Stage 1 (maintenance manager): managerA and dualA hold the role at A. Stage 2 (plant manager) not yet.
    expect((await mine(w.managerA))[0]).toMatchObject({ kind: 'approval.waiting', title: expect.stringMatching(/^Waiting for your sign-off: PR-\d+ Pump seal kit \(\$2,800\)/), link: '/approvals' });
    expect(await kinds(w.dualA)).toEqual(['approval.waiting']);
    expect(await kinds(w.opsA)).toEqual([]);
    expect(await kinds(w.techA)).toEqual([]);
    await sign(w.dualA, pr.id);
    // Stage 2 opens: opsA is told; dualA (already signed) is not told again for stage 2.
    expect(await kinds(w.opsA)).toEqual(['approval.waiting']);
    expect(await kinds(w.dualA)).toEqual(['approval.waiting']);
    await sign(w.opsA, pr.id);
    // Once signed, "waiting" notices close for everyone who was told (managerA never had to act on it).
    expect((await mine(w.managerA)).filter((n) => n.kind === 'approval.waiting' && !n.read_at)).toEqual([]);
    const decided = (await mine(w.techA))[0];
    expect(decided).toMatchObject({ kind: 'approval.decided', title: expect.stringMatching(/^Approved: PR-/), link: `/purchasing/requests/${pr.id}` });
  });

  it('a delegate is told about steps they can sign for someone away', async () => {
    await asActor(w.opsA, (tx) => createDelegation(tx, w.opsA, { delegateUserId: w.exec.userId, startsOn: today, endsOn: today, reason: 'Plant tour' }));
    const pr = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Spare motor',
      lines: [{ description: 'Motor 7.5 kW', qty: 1, estUnitPrice: 3100 }] }));
    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, pr.id));
    await sign(w.managerA, pr.id);
    expect((await mine(w.exec)).map((n) => n.title)).toEqual([expect.stringMatching(/Spare motor/)]);
  });

  it('work-order assignment tells the technician, not the person assigning; muted kinds are skipped', async () => {
    await asActor(w.tech2A, (tx) => setPreferences(tx, w.tech2A, { mutedKinds: ['work_order.assigned'] }));
    const wo = await asActor(w.managerA, async (tx) => {
      const o = await createWorkOrder(tx, w.managerA, { assetId, title: 'Seal leaking', dueAt: '2026-01-05T17:00:00Z' });
      await assignTechnician(tx, w.managerA, o.id, w.techAEmployeeId, 'lead');
      await assignTechnician(tx, w.managerA, o.id, w.tech2AEmployeeId);
      return o;
    });
    expect((await mine(w.techA)).find((n) => n.kind === 'work_order.assigned')).toMatchObject({ title: `Assigned to you: ${wo.number} Seal leaking`, link: `/work-orders/${wo.id}` });
    expect(await kinds(w.tech2A)).not.toContain('work_order.assigned');
    expect(await kinds(w.managerA)).not.toContain('work_order.assigned');
  });

  it('people read and clear only their own notifications', async () => {
    const before = await asActor(w.techA, (tx) => unreadCount(tx, w.techA));
    expect(before).toBe(2);
    const other = (await mine(w.managerA))[0];
    expect(await asActor(w.techA, (tx) => markRead(tx, w.techA, [other.id]))).toBe(0);
    expect(await asActor(w.techA, (tx) => markRead(tx, w.techA, 'all'))).toBe(2);
    expect(await asActor(w.techA, (tx) => unreadCount(tx, w.techA))).toBe(0);
  });
});

describe('daily reminders and digest', () => {
  it('the sweep reminds the right people once, however often it runs', async () => {
    await asActor(w.managerA, (tx) => createPlan(tx, w.managerA, { assetId, code: 'PM-PMP4', title: 'Monthly pump check', triggerType: 'calendar', intervalDays: 30, firstDueOn: today }));
    const first = await runReminders(w.tenantId, today);
    expect(first).toMatchObject({ pm_due: 3, wo_overdue: 2 }); // planners at A: admin, managerA, dualA; both assigned technicians
    expect(first.timesheet_missing).toBeGreaterThanOrEqual(2);
    expect((await mine(w.managerA)).find((n) => n.kind === 'reminder.pm_due')).toMatchObject({ title: '1 PM plan due at A without a work order', body: 'PM-PMP4' });
    expect((await mine(w.techA)).find((n) => n.kind === 'reminder.wo_overdue')).toMatchObject({ title: expect.stringMatching(/^Overdue: WO-/) });
    const again = await runReminders(w.tenantId, today);
    expect(Object.values(again).reduce((s, n) => s + n, 0)).toBe(0);
  });

  it('queues one digest a day per person who wants email, and retries failed sends', async () => {
    await asActor(w.opsA, (tx) => setPreferences(tx, w.opsA, { emailDigest: false }));
    const queued = await queueDigests(w.tenantId, today);
    expect(queued).toBeGreaterThan(0);
    expect(await queueDigests(w.tenantId, today)).toBe(0);
    const rows = (await getAdminPool().query('SELECT user_id, to_address, subject, body_text FROM email_message WHERE tenant_id = $1', [w.tenantId])).rows;
    expect(rows.some((r) => r.user_id === w.opsA.userId)).toBe(false);
    const mgr = rows.find((r) => r.user_id === w.managerA.userId)!;
    expect(mgr.body_text).toContain('1 PM plan due at A without a work order');
    expect(mgr.body_text).toContain('http://localhost:3000/pm');
    const failing: MailSender = { name: 'failing', send: async () => { throw new Error('connection refused'); } };
    expect(await sendQueued(w.tenantId, failing)).toBe(0);
    const st = (await getAdminPool().query(`SELECT DISTINCT status, attempts, last_error FROM email_message WHERE tenant_id = $1`, [w.tenantId])).rows;
    expect(st).toEqual([{ status: 'queued', attempts: 1, last_error: 'connection refused' }]);
    const sent: string[] = [];
    expect(await sendQueued(w.tenantId, { name: 'capture', send: async (m) => { sent.push(m.to); } })).toBe(queued);
    expect(sent).toContain(`managerA@${sent[0]!.split('@')[1]}`);
  });
});
