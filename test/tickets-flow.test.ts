import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createCustomer, saveContact } from '../src/modules/crm/service.js';
import { whatIsLate } from '../src/modules/late/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { setReminder } from '../src/modules/reminders/settings.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { addDays, submitTimesheet, weekStartOf } from '../src/modules/time/service.js';
import {
  addEntry, assignMany, assignTicket, changeStatus, createTicket, getTicket, listTickets, logTime, removeTime, updateTicket,
} from '../src/modules/tickets/service.js';
import { addHoliday, listServiceLevels, saveCalendar, saveCannedReply, saveCategory, saveServiceLevel } from '../src/modules/tickets/setup.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let manager: Actor; let agent: Actor; let agent2: Actor; let viewer: Actor; let agentB: Actor; let agentUserId: string;
let acme: string; let globex: string; let acmeContact: string;
let fid: string; let fidB: string;
let seq = 0;
const today = () => new Date().toISOString().slice(0, 10);
const A = <T>(who: Actor, fn: (tx: any) => Promise<T>) => asActor(who, fn);
const days24x7 = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), ['00:00', '24:00']]));
const mk = (over: Record<string, unknown> = {}) => A(agent, (tx) => createTicket(tx, agent, { facilityId: fid, customerId: acme, subject: `Printer is down ${++seq}`, ...over } as any));
const row = async (id: string) => (await db().query('SELECT * FROM ticket WHERE id = $1', [id])).rows[0];
const notices = async (userId: string, kind?: string) => (await db().query(`SELECT * FROM notification WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at`, [userId, kind ?? null])).rows;
async function user(key: string, role: string, facility: string, employeeId?: string) {
  const u = await createUserWithToken(db(), w.tenantId, { email: `${key}-${Date.now()}@tk.example`, displayName: key, roles: [{ role, facility }], employeeId });
  return { actor: (await loadActor(w.tenantId, u.userId))!, id: u.userId };
}

beforeAll(async () => {
  w = await makeWorld('tickets');
  fid = w.facilities.A!; fidB = w.facilities.B!;
  const emp = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, 'S100', 'Sasha', 'Agent', 'Support') RETURNING id`, [w.tenantId, fid])).rows[0].id;
  const a = await user('agent', 'support_agent', fid, emp); agent = a.actor; agentUserId = a.id;
  agent2 = (await user('agent2', 'support_agent', fid)).actor;
  manager = (await user('sm', 'support_manager', fid)).actor;
  viewer = (await user('viewer', 'executive', fid)).actor;
  agentB = (await user('agentB', 'support_agent', fidB)).actor;
  await A(w.admin, async (tx) => {
    acme = (await createCustomer(tx, w.admin, { code: 'ACME', name: 'Acme Ltd', kind: 'customer' })).id;
    globex = (await createCustomer(tx, w.admin, { code: 'GLOBEX', name: 'Globex', kind: 'customer' })).id;
    acmeContact = (await saveContact(tx, w.admin, { customerId: acme, name: 'Wile Coyote', email: 'wile@acme.example' })).id;
  });
  // Round-the-clock hours at site A keep the live tests simple; the arithmetic itself is tested in tickets-hours.
  await A(manager, (tx) => saveCalendar(tx, manager, fid, { timeZone: 'America/New_York', days: days24x7 }));
  for (const [priority, first, res] of [['urgent', 15, 120], ['high', 60, 480], ['normal', 240, 2400], ['low', null, 4800]] as const) {
    await A(manager, (tx) => saveServiceLevel(tx, manager, { name: `${priority} standard`, priority, firstResponseMinutes: first, resolutionMinutes: res }));
  }
});
afterAll(closePools);

describe('who may do what', () => {
  it('view, work and manage are separate, per site', async () => {
    await expect(A(viewer, (tx) => createTicket(tx, viewer, { facilityId: fid, customerId: acme, subject: 'x' }))).rejects.toThrow(/tickets.work/);
    const t = await mk();
    await expect(A(viewer, (tx) => addEntry(tx, viewer, t.id, { kind: 'note', body: 'hi' }))).rejects.toThrow(/tickets.work/);
    expect((await A(viewer, (tx) => getTicket(tx, viewer, t.id))).can).toEqual({ work: false, manage: false });
    // an agent at another site cannot even see it (row-level security), and cannot create one here
    await expect(A(agentB, (tx) => getTicket(tx, agentB, t.id))).rejects.toThrow(/not found/);
    await expect(A(agentB, (tx) => createTicket(tx, agentB, { facilityId: fid, customerId: acme, subject: 'x' }))).rejects.toThrow();
    expect((await A(agentB, (tx) => listTickets(tx, agentB, { view: 'all' }))).rows.find((r: any) => r.id === t.id)).toBeUndefined();
  });

  it('only people who manage tickets change service levels, hours, categories, canned replies and assign others', async () => {
    await expect(A(agent, (tx) => saveServiceLevel(tx, agent, { name: 'x', priority: 'low' }))).rejects.toThrow(/tickets.manage/);
    await expect(A(agent, (tx) => saveCalendar(tx, agent, fid, { timeZone: 'UTC', days: days24x7 }))).rejects.toThrow(/tickets.manage/);
    await expect(A(agent, (tx) => saveCategory(tx, agent, { name: 'Billing' }))).rejects.toThrow(/tickets.manage/);
    await expect(A(agent, (tx) => saveCannedReply(tx, agent, { title: 'Hello', body: 'Hi' }))).rejects.toThrow(/tickets.manage/);
    await expect(A(agent, (tx) => addHoliday(tx, agent, { facilityId: fid, day: '2026-12-25', name: 'Christmas' }))).rejects.toThrow(/tickets.manage/);
    const t = await mk();
    await expect(A(agent, (tx) => assignTicket(tx, agent, t.id, agent2.userId))).rejects.toThrow(/tickets.manage/);
    await A(agent, (tx) => assignTicket(tx, agent, t.id, agent.userId));              // taking it yourself is work
    await A(manager, (tx) => assignTicket(tx, manager, t.id, agent2.userId));         // handing it to someone else is management
    expect((await row(t.id)).assignee_user_id).toBe(agent2.userId);
    await expect(A(manager, (tx) => assignTicket(tx, manager, t.id, w.buyer.userId))).rejects.toThrow(/cannot work tickets/);
  });

  it('company lists work: categories and canned replies are unique and editable', async () => {
    const c = await A(manager, (tx) => saveCategory(tx, manager, { name: 'Printing' }));
    await expect(A(manager, (tx) => saveCategory(tx, manager, { name: 'Printing' }))).rejects.toThrow(/already exists/);
    await A(manager, (tx) => saveCannedReply(tx, manager, { title: 'Got it', body: 'Thanks, we are looking into it.' }));
    const t = await mk({ categoryId: c.id });
    expect((await A(agent, (tx) => getTicket(tx, agent, t.id))).category_name).toBe('Printing');
  });

  it('service levels: one active row per priority and customer', async () => {
    await expect(A(manager, (tx) => saveServiceLevel(tx, manager, { name: 'dup', priority: 'high', firstResponseMinutes: 30 }))).rejects.toThrow(/already an active service level/);
    await expect(A(manager, (tx) => saveServiceLevel(tx, manager, { name: 'bad', priority: 'low', customerId: acme, firstResponseMinutes: 600, resolutionMinutes: 60 }))).rejects.toThrow(/cannot be due after/);
    expect((await A(agent, (tx) => listServiceLevels(tx, agent))).length).toBeGreaterThanOrEqual(4);
  });
});

describe('numbering, targets and the first reply', () => {
  it('numbers tickets TCK-000001 onward per company and copies the targets when raised', async () => {
    const t = await mk({ priority: 'high' });
    expect(t.number).toMatch(/^TCK-\d{6}$/);
    const n = Number(t.number.slice(4));
    expect((await mk()).number).toBe(`TCK-${String(n + 1).padStart(6, '0')}`);
    const r = await row(t.id);
    expect(r).toMatchObject({ status: 'new', first_response_target_min: 60, resolution_target_min: 480, at_risk_pct: 80 });
    expect(+r.first_response_due_at - +r.created_at).toBe(60 * 60_000);                // round-the-clock hours: an hour
    expect(+r.resolution_due_at - +r.created_at).toBe(480 * 60_000);
    // editing the policy afterwards does not move a promise already made
    const level = (await A(manager, (tx) => listServiceLevels(tx, manager))).find((l: any) => l.priority === 'high');
    await A(manager, (tx) => saveServiceLevel(tx, manager, { id: level.id, name: level.name, priority: 'high', firstResponseMinutes: 30, resolutionMinutes: 240 }));
    expect((await row(t.id)).first_response_target_min).toBe(60);
    expect((await row(await (await mk({ priority: 'high' })).id)).first_response_target_min).toBe(30);
    await A(manager, (tx) => saveServiceLevel(tx, manager, { id: level.id, name: level.name, priority: 'high', firstResponseMinutes: 60, resolutionMinutes: 480 }));
  });

  it('a customer-specific service level overrides the company one for that customer', async () => {
    const o = await A(manager, (tx) => saveServiceLevel(tx, manager, { name: 'Globex premium', priority: 'normal', customerId: globex, firstResponseMinutes: 10, resolutionMinutes: 60 }));
    expect((await row((await mk({ customerId: globex })).id)).first_response_target_min).toBe(10);
    expect((await row((await mk({ customerId: acme })).id)).first_response_target_min).toBe(240);
    await A(manager, (tx) => saveServiceLevel(tx, manager, { id: o.id, name: o.name, priority: 'normal', customerId: globex, firstResponseMinutes: 10, resolutionMinutes: 60, active: false }));
  });

  it('the first reply the customer can see answers the first-response target; an internal note does not', async () => {
    const t = await mk();
    await A(agent, (tx) => addEntry(tx, agent, t.id, { kind: 'note', body: 'Looks like the toner.' }));
    expect((await row(t.id)).first_responded_at).toBeNull();
    const e = await A(agent, (tx) => addEntry(tx, agent, t.id, { kind: 'reply', body: 'Hello, we are on it.' }));
    expect(e.status).toBe('open');                                                    // a new ticket opens with its first reply
    const r = await row(t.id);
    expect(r.first_responded_at).not.toBeNull();
    expect(r.first_response_missed).toBe(false);
    const d = await A(agent, (tx) => getTicket(tx, agent, t.id));
    expect(d.entries.map((x: any) => [x.kind, x.customer_visible])).toEqual([['event', false], ['note', false], ['reply', true], ['event', false]]);
    expect(d.sla.firstResponse).toMatchObject({ state: 'met', label: 'Met' });
    expect(d.entries.find((x: any) => x.kind === 'reply')).toMatchObject({ author_name: 'agent' });
  });

  it('the conversation is append-only', async () => {
    const t = await mk();
    await A(agent, (tx) => addEntry(tx, agent, t.id, { kind: 'note', body: 'first' }));
    await expect(A(agent, (tx) => tx.query(`UPDATE ticket_entry SET body = 'edited' WHERE ticket_id = $1`, [t.id]))).rejects.toThrow(/permission denied/);
    await expect(A(agent, (tx) => tx.query('DELETE FROM ticket_entry WHERE ticket_id = $1', [t.id]))).rejects.toThrow(/permission denied/);
  });
});

describe('statuses and who may move a ticket', () => {
  it('follows the allowed moves and refuses the rest', async () => {
    const t = await mk();
    await expect(A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'closed' }))).rejects.toThrow(/cannot become closed/);
    await expect(A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'reopened' }))).rejects.toThrow(/cannot become reopened/);
    await expect(A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'new' }))).rejects.toThrow(/back to new/);
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'open' }));
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'waiting_third_party', note: 'with the vendor' }));
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'waiting_customer' }));
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'resolved', note: 'fixed' }));
    await expect(A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'open' }))).rejects.toThrow(/cannot become open/);
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'closed' }));
    await expect(A(agent, (tx) => addEntry(tx, agent, t.id, { kind: 'reply', body: 'late' }))).rejects.toThrow(/closed/);
    await expect(A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'reopened' }))).rejects.toThrow(/tickets.manage/);   // closed: only a manager reopens
    await A(manager, (tx) => changeStatus(tx, manager, t.id, { status: 'reopened' }));
    const r = await row(t.id);
    expect(r).toMatchObject({ status: 'reopened', reopened_count: 1, closed_at: null, resolved_at: null });
    const d = await A(agent, (tx) => getTicket(tx, agent, t.id));
    expect(d.entries.map((e: any) => e.body).join('\n')).toMatch(/Status changed from Waiting on customer to Resolved by agent: fixed/);
    expect(d.next).toEqual(['open', 'waiting_customer', 'waiting_third_party', 'resolved']);
  });

  it('a resolved ticket can be reopened by whoever works tickets', async () => {
    const t = await mk();
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'resolved' }));
    expect((await row(t.id)).first_responded_at).not.toBeNull();                       // resolving counts as the answer
    await A(agent2, (tx) => changeStatus(tx, agent2, t.id, { status: 'reopened' }));
    expect((await row(t.id)).status).toBe('reopened');
  });

  it('waiting pauses the clock and a customer reply starts it again and tells the assignee', async () => {
    const t = await mk({ priority: 'normal' });
    await A(manager, (tx) => assignTicket(tx, manager, t.id, agent.userId));
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'waiting_customer' }));
    let r = await row(t.id);
    expect(r.sla_running_since).toBeNull();
    expect(r.resolution_due_at).toBeNull();
    const before = (await notices(agentUserId, 'ticket.customer_reply')).length;
    await A(agent2, (tx) => addEntry(tx, agent2, t.id, { kind: 'customer_reply', body: 'It still jams on page two.' }));
    r = await row(t.id);
    expect(r.status).toBe('open');
    expect(r.sla_running_since).not.toBeNull();
    expect(r.resolution_due_at).not.toBeNull();
    expect((await notices(agentUserId, 'ticket.customer_reply')).length).toBe(before + 1);
    // the person who typed it in is not told about their own entry
    await A(agent, (tx) => addEntry(tx, agent, t.id, { kind: 'customer_reply', body: 'Also, the tray.' }));
    expect((await notices(agentUserId, 'ticket.customer_reply')).length).toBe(before + 1);
    // a customer reply on a resolved ticket reopens it
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'resolved' }));
    await A(agent2, (tx) => addEntry(tx, agent2, t.id, { kind: 'customer_reply', body: 'Not fixed.' }));
    expect(await row(t.id)).toMatchObject({ status: 'reopened', reopened_count: 1 });
  });

  it('changing the priority recomputes the targets from the minutes already used', async () => {
    const t = await mk({ priority: 'low' });
    expect((await row(t.id)).resolution_target_min).toBe(4800);
    await A(agent, (tx) => updateTicket(tx, agent, t.id, { priority: 'urgent' }));
    expect(await row(t.id)).toMatchObject({ priority: 'urgent', first_response_target_min: 15, resolution_target_min: 120 });
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'resolved' }));
    await expect(A(agent, (tx) => updateTicket(tx, agent, t.id, { priority: 'low' }))).rejects.toThrow(/reopen/);
  });
});

describe('assignment and notifications', () => {
  it('tells the assignee about an assignment, but not the person who made it', async () => {
    const t = await mk();
    const before = (await notices(agentUserId, 'ticket.assigned')).length;
    await A(manager, (tx) => assignTicket(tx, manager, t.id, agent.userId));
    expect((await notices(agentUserId, 'ticket.assigned')).length).toBe(before + 1);
    expect((await row(t.id)).status).toBe('open');                                      // assigning opens a new ticket
    const mine = await A(agent, (tx) => assignTicket(tx, agent, t.id, agent.userId));  // no change: no second notice, no second entry
    expect(mine.assignee_user_id).toBe(agent.userId);
    expect((await notices(agentUserId, 'ticket.assigned')).length).toBe(before + 1);
    const t2 = await mk({ assigneeUserId: agent.userId });                               // raising a ticket for yourself notifies nobody
    expect((await notices(agentUserId, 'ticket.assigned')).length).toBe(before + 1);
    expect((await row(t2.id)).status).toBe('open');
  });

  it('bulk assignment reports each ticket on its own', async () => {
    const [a, b, c] = [await mk(), await mk(), await mk()];
    await A(agent, (tx) => changeStatus(tx, agent, c.id, { status: 'resolved' }));
    const out = await A(manager, (tx) => assignMany(tx, manager, [a.id, b.id, c.id], agent2.userId));
    expect(out.assigned).toBe(2);
    expect(out.failed).toEqual([{ id: c.id, message: expect.stringMatching(/resolved/) }]);
    expect((await row(a.id)).assignee_user_id).toBe(agent2.userId);
    expect((await row(c.id)).assignee_user_id).toBeNull();
    await expect(A(agent, (tx) => assignMany(tx, agent, [a.id], agent2.userId))).resolves.toMatchObject({ assigned: 0, failed: [{ id: a.id }] });
  });
});

describe('breach, at risk and the queue', () => {
  it('shows at-risk and breached with text labels, filters the queue and counts it', async () => {
    const risky = await mk({ priority: 'high' }); const late = await mk({ priority: 'high' }); const fine = await mk({ priority: 'high' });
    // Time passing is simulated by moving the stored due times: the arithmetic that sets them is covered in tickets-hours.
    await db().query(`UPDATE ticket SET first_response_risk_at = now() - interval '1 minute', first_response_due_at = now() + interval '10 minutes' WHERE id = $1`, [risky.id]);
    await db().query(`UPDATE ticket SET first_response_risk_at = now() - interval '2 hours', first_response_due_at = now() - interval '1 hour' WHERE id = $1`, [late.id]);
    const breached = await A(agent, (tx) => listTickets(tx, agent, { view: 'breached' }));
    expect(breached.rows.map((r: any) => r.id)).toContain(late.id);
    expect(breached.rows.map((r: any) => r.id)).not.toContain(risky.id);
    const atRisk = await A(agent, (tx) => listTickets(tx, agent, { view: 'at_risk' }));
    expect(atRisk.rows.map((r: any) => r.id)).toContain(risky.id);
    expect(atRisk.rows.map((r: any) => r.id)).not.toContain(late.id);
    expect(atRisk.rows.find((r: any) => r.id === risky.id).sla.firstResponse).toMatchObject({ state: 'at_risk', label: 'At risk' });
    expect(breached.rows.find((r: any) => r.id === late.id).sla).toMatchObject({ overall: 'breached', overallLabel: 'Breached' });
    expect((await A(agent, (tx) => getTicket(tx, agent, fine.id))).sla.overallLabel).toBe('On track');
    expect(breached.counts.breached).toBeGreaterThanOrEqual(1);
    // answering the late ticket takes it out of the breached list, and the answer is recorded as missed
    await A(agent, (tx) => addEntry(tx, agent, late.id, { kind: 'reply', body: 'Sorry for the wait.' }));
    expect((await row(late.id)).first_response_missed).toBe(false);                    // judged on the minutes used (a few seconds), not on the moved dates
    expect((await A(agent, (tx) => listTickets(tx, agent, { view: 'breached' }))).rows.map((r: any) => r.id)).not.toContain(late.id);
  });

  it('filters by mine, unassigned, customer, priority and text, and sorts by priority', async () => {
    const m = await mk({ priority: 'urgent', customerId: globex, subject: 'Zebra stripes unique' });
    await A(agent, (tx) => assignTicket(tx, agent, m.id, agent.userId));
    expect((await A(agent, (tx) => listTickets(tx, agent, { view: 'mine' }))).rows.every((r: any) => r.assignee_user_id === agent.userId)).toBe(true);
    expect((await A(agent, (tx) => listTickets(tx, agent, { view: 'unassigned' }))).rows.every((r: any) => !r.assignee_user_id)).toBe(true);
    expect((await A(agent, (tx) => listTickets(tx, agent, { customerId: globex, priority: 'urgent' }))).rows.map((r: any) => r.id)).toContain(m.id);
    expect((await A(agent, (tx) => listTickets(tx, agent, { q: 'zebra stripes' }))).rows.map((r: any) => r.id)).toEqual([m.id]);
    const byPriority = (await A(agent, (tx) => listTickets(tx, agent, { sort: 'priority' }))).rows.map((r: any) => r.priority);
    const rank = (p: string) => ['urgent', 'high', 'normal', 'low'].indexOf(p);
    expect(byPriority.map(rank)).toEqual([...byPriority.map(rank)].sort((x, y) => x - y));
  });

  it('daily alerts go to the assignee and the managers once per target, however often the sweep runs', async () => {
    const t = await mk({ priority: 'high', assigneeUserId: agent.userId });
    await db().query(`UPDATE ticket SET first_response_due_at = now() - interval '30 minutes', first_response_risk_at = now() - interval '50 minutes',
      resolution_risk_at = now() - interval '1 minute', resolution_due_at = now() + interval '5 minutes' WHERE id = $1`, [t.id]);
    const mgr = manager.userId;
    const count = async (kind: string, user: string) => (await notices(user, kind)).filter((n: any) => n.subject_id === t.id).length;
    await runReminders(w.tenantId, today()); await runReminders(w.tenantId, today());
    expect(await count('ticket.breach', agentUserId)).toBe(1);
    expect(await count('ticket.breach', mgr)).toBe(1);
    expect(await count('ticket.at_risk', agentUserId)).toBe(1);                         // the resolution timer is at risk; the first-response timer is already breached
    expect(await count('ticket.at_risk', mgr)).toBe(1);
    expect((await notices(agentUserId, 'ticket.breach')).find((n: any) => n.subject_id === t.id).title).toMatch(/first response/);
    // later the resolution also slips: one more notice, for the other timer; still nothing repeated
    await db().query(`UPDATE ticket SET resolution_due_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    await runReminders(w.tenantId, today()); await runReminders(w.tenantId, today());
    expect(await count('ticket.breach', agentUserId)).toBe(2);
    // a person who muted nothing else, and the company switch: turn the reminder off and a new breach stays quiet
    await A(w.admin, (tx) => setReminder(tx, w.admin, 'ticket_breach', { enabled: false, repeat: 'once' }));
    const t2 = await mk({ priority: 'high', assigneeUserId: agent.userId });
    await db().query(`UPDATE ticket SET first_response_due_at = now() - interval '30 minutes' WHERE id = $1`, [t2.id]);
    await runReminders(w.tenantId, today());
    expect(await count('ticket.breach', agentUserId)).toBe(2);
    expect((await notices(agentUserId, 'ticket.breach')).filter((n: any) => n.subject_id === t2.id)).toHaveLength(0);
    await A(w.admin, (tx) => setReminder(tx, w.admin, 'ticket_breach', { enabled: true, repeat: 'once' }));
  });

  it('a waiting ticket nobody has chased is flagged after the lead days', async () => {
    const t = await mk({ assigneeUserId: agent.userId });
    await A(agent, (tx) => changeStatus(tx, agent, t.id, { status: 'waiting_customer' }));
    await runReminders(w.tenantId, today());
    expect((await notices(agentUserId, 'ticket.waiting')).filter((n: any) => n.subject_id === t.id)).toHaveLength(0);
    await db().query(`UPDATE ticket SET status_changed_at = now() - interval '9 days' WHERE id = $1`, [t.id]);
    await runReminders(w.tenantId, today()); await runReminders(w.tenantId, today());
    expect((await notices(agentUserId, 'ticket.waiting')).filter((n: any) => n.subject_id === t.id)).toHaveLength(1);
  });

  it('What is late lists breached tickets and tickets waiting too long, for those who may see them', async () => {
    const t = await mk({ priority: 'high' });
    await db().query(`UPDATE ticket SET first_response_due_at = now() - interval '3 days' WHERE id = $1`, [t.id]);
    const w2 = await mk(); await A(agent, (tx) => changeStatus(tx, agent, w2.id, { status: 'waiting_third_party' }));
    await db().query(`UPDATE ticket SET status_changed_at = now() - interval '20 days' WHERE id = $1`, [w2.id]);
    const late = await A(manager, (tx) => whatIsLate(tx, manager));
    const breached = late.sections.find((s) => s.key === 'tickets-breached')!;
    expect(breached.rows.map((r) => r.href)).toContain(`/tickets/${t.id}`);
    expect(breached.rows.find((r) => r.href === `/tickets/${t.id}`)).toMatchObject({ daysLate: 3, detail: expect.stringMatching(/First response overdue/) });
    expect(late.sections.find((s) => s.key === 'tickets-waiting')!.rows.find((r) => r.href === `/tickets/${w2.id}`)).toMatchObject({ daysLate: 20 });
    const none = await A(w.operatorB, (tx) => whatIsLate(tx, w.operatorB));
    expect(none.sections.find((s) => s.key.startsWith('tickets'))).toBeUndefined();
  });
});

describe('business hours at the site', () => {
  it('a new calendar or holiday moves the due times of open tickets', async () => {
    const t = await mk({ priority: 'high' });
    const due0 = +(await row(t.id)).resolution_due_at;
    await A(manager, (tx) => saveCalendar(tx, manager, fid, { timeZone: 'America/New_York', days: { 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'], 4: ['09:00', '17:00'], 5: ['09:00', '17:00'], 6: null, 7: null } }));
    const due1 = +(await row(t.id)).resolution_due_at;
    expect(due1).toBeGreaterThanOrEqual(due0);                                           // never earlier than round the clock
    const h = await A(manager, (tx) => addHoliday(tx, manager, { facilityId: fid, day: '2099-01-01', name: 'Far away' }));
    expect(h.day).toBe('2099-01-01');
    await expect(A(manager, (tx) => addHoliday(tx, manager, { facilityId: fid, day: '2099-01-01', name: 'again' }))).rejects.toThrow(/already a holiday/);
    await expect(A(manager, (tx) => saveCalendar(tx, manager, fid, { timeZone: 'Mars/Olympus', days: days24x7 }))).rejects.toThrow(/time zone/);
    await expect(A(manager, (tx) => saveCalendar(tx, manager, fid, { timeZone: 'UTC', days: { 1: ['17:00', '09:00'] } }))).rejects.toThrow(/after the start/);
    await A(manager, (tx) => saveCalendar(tx, manager, fid, { timeZone: 'America/New_York', days: days24x7 }));
  });

  it('a manager at another site cannot change this site’s hours', async () => {
    const mB = (await user('smB', 'support_manager', fidB)).actor;
    await expect(A(mB, (tx) => saveCalendar(tx, mB, fid, { timeZone: 'UTC', days: days24x7 }))).rejects.toThrow(/tickets.manage/);
  });
});

describe('time on a ticket', () => {
  let project: string; let task: string;
  beforeAll(async () => {
    project = (await db().query(`INSERT INTO project (tenant_id, facility_id, number, name, customer_id, created_by) VALUES ($1, $2, 'PRJ-T1', 'Helpdesk retainer work', $3, $4) RETURNING id`, [w.tenantId, fid, acme, w.admin.userId])).rows[0].id;
    task = (await db().query(`INSERT INTO project_task (tenant_id, project_id, name, billable) VALUES ($1, $2, 'Support', true) RETURNING id`, [w.tenantId, project])).rows[0].id;
    await db().query(`INSERT INTO project_task (tenant_id, project_id, name, billable) VALUES ($1, $2, 'Internal', false)`, [w.tenantId, project]);
  });

  it('without a project the hours are plain manual time and cannot be billable', async () => {
    const t = await mk();
    await expect(A(agent, (tx) => logTime(tx, agent, t.id, { hours: 1, billable: true }))).rejects.toThrow(/needs a project/);
    const x = await A(agent, (tx) => logTime(tx, agent, t.id, { hours: 1.5, note: 'Swapped the toner', workDate: today() }));
    const e = (await db().query('SELECT * FROM time_entry WHERE id = $1', [x.timeEntryId])).rows[0];
    expect(e).toMatchObject({ source: 'manual', billable: false, project_id: null, earning_code: 'REG', created_by: agentUserId });
    expect(Number(e.hours)).toBe(1.5);
    expect(e.note).toBe(`${t.number}: Swapped the toner`);
    const sheet = (await db().query('SELECT * FROM timesheet WHERE id = $1', [e.timesheet_id])).rows[0];
    expect(sheet).toMatchObject({ week_start: weekStartOf(today()), employee_id: (await db().query('SELECT employee_id FROM app_user WHERE id = $1', [agentUserId])).rows[0].employee_id });
    expect((await A(agent, (tx) => getTicket(tx, agent, t.id))).timeTotal).toBe(1.5);
    // a ticket's hours are not logged by someone with no employee record
    await expect(A(manager, (tx) => logTime(tx, manager, t.id, { hours: 1 }))).rejects.toThrow(/not linked to an employee/);
  });

  it('with a project the hours are project time on the person’s timesheet, billable when asked', async () => {
    const t = await mk();
    await A(agent, (tx) => updateTicket(tx, agent, t.id, { projectId: project }));
    const x = await A(agent, (tx) => logTime(tx, agent, t.id, { hours: 2, billable: true, projectTaskId: task, workDate: today() }));
    expect((await db().query('SELECT source, billable, project_id, project_task_id FROM time_entry WHERE id = $1', [x.timeEntryId])).rows[0]).toEqual({ source: 'project', billable: true, project_id: project, project_task_id: task });
    await expect(A(agent, (tx) => logTime(tx, agent, t.id, { hours: 1, billable: true, projectTaskId: (task.replace(/.$/, '0')) }))).rejects.toThrow(/not on the ticket/);
    const internal = (await db().query(`SELECT id FROM project_task WHERE project_id = $1 AND name = 'Internal'`, [project])).rows[0].id;
    await expect(A(agent, (tx) => logTime(tx, agent, t.id, { hours: 1, billable: true, projectTaskId: internal }))).rejects.toThrow(/not billable/);
    const nonBillable = await A(agent, (tx) => logTime(tx, agent, t.id, { hours: 0.5, billable: false }));
    expect((await db().query('SELECT billable, source FROM time_entry WHERE id = $1', [nonBillable.timeEntryId])).rows[0]).toEqual({ billable: false, source: 'project' });
    // the project must belong to the ticket's customer
    const other = (await db().query(`INSERT INTO project (tenant_id, facility_id, number, name, customer_id, created_by) VALUES ($1, $2, 'PRJ-T2', 'Globex job', $3, $4) RETURNING id`, [w.tenantId, fid, globex, w.admin.userId])).rows[0].id;
    await expect(A(agent, (tx) => updateTicket(tx, agent, t.id, { projectId: other }))).rejects.toThrow(/different customer/);
  });

  it('flags retainer cover on the entry (a flag only), validates the hours and removes an entry with its time row', async () => {
    const t = await mk({ retainerCovered: true });
    await expect(A(agent, (tx) => logTime(tx, agent, t.id, { hours: 0 }))).rejects.toThrow(/hours/);
    await expect(A(agent, (tx) => logTime(tx, agent, t.id, { hours: 25 }))).rejects.toThrow(/hours/);
    const x = await A(agent, (tx) => logTime(tx, agent, t.id, { hours: 1, workDate: today() }));
    expect(x.covered_by_retainer).toBe(true);
    await expect(A(agent2, (tx) => removeTime(tx, agent2, t.id, x.id))).rejects.toThrow(/tickets.manage/);   // someone else's hours
    await A(agent, (tx) => removeTime(tx, agent, t.id, x.id));
    expect((await db().query('SELECT count(*)::int AS n FROM time_entry WHERE id = $1', [x.timeEntryId])).rows[0].n).toBe(0);
    expect((await db().query('SELECT count(*)::int AS n FROM ticket_time WHERE id = $1', [x.id])).rows[0].n).toBe(0);
  });

  it('a week that was submitted is closed to ticket time, as for any other hours', async () => {
    const t = await mk();
    const day = addDays(weekStartOf(today()), -14);
    const x = await A(agent, (tx) => logTime(tx, agent, t.id, { hours: 3, workDate: day }));
    await A(agent, (tx) => submitTimesheet(tx, agent, (x as any).timesheetId));
    await expect(A(agent, (tx) => logTime(tx, agent, t.id, { hours: 1, workDate: day }))).rejects.toThrow(/is submitted/);
    await expect(A(agent, (tx) => removeTime(tx, agent, t.id, x.id))).rejects.toThrow(/timesheet is submitted/);
  });
});

describe('isolation between companies', () => {
  it('another company sees nothing of these tickets', async () => {
    const w2 = await makeWorld('tickets-other');
    const t = await mk();
    await expect(A(w2.admin, (tx) => getTicket(tx, w2.admin, t.id))).rejects.toThrow(/not found/);
    expect((await A(w2.admin, (tx) => listTickets(tx, w2.admin, { view: 'all' }))).rows).toEqual([]);
    expect(await A(w2.admin, (tx) => listServiceLevels(tx, w2.admin))).toEqual([]);
  });
});

describe('reports', () => {
  it('service-level attainment and volume describe the data, in screen form', async () => {
    const sl = getReport('ticket-service-levels')!; const vol = getReport('ticket-volume')!;
    const r = await A(manager, (tx) => sl.run(tx, manager, sl.params.parse({ groupBy: 'priority' })));
    expect(r.columns.map((c) => c.key)).toEqual(['group', 'tickets', 'fr_met', 'fr_missed', 'fr_pct', 'rs_met', 'rs_missed', 'rs_pct']);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.map((x) => x.group)).toEqual(['urgent', 'high', 'normal', 'low'].filter((p) => r.rows.some((x) => x.group === p)));
    expect(r.rows.reduce((s, x) => s + (x.tickets as number), 0)).toBeGreaterThan(10);
    const byAssignee = await A(manager, (tx) => sl.run(tx, manager, sl.params.parse({ groupBy: 'assignee' })));
    expect(byAssignee.rows.some((x) => x.group === 'Unassigned')).toBe(true);
    const byCustomer = await A(manager, (tx) => sl.run(tx, manager, sl.params.parse({ groupBy: 'customer' })));
    expect(byCustomer.rows.map((x) => x.group)).toEqual(expect.arrayContaining(['Acme Ltd', 'Globex']));
    const v = await A(manager, (tx) => vol.run(tx, manager, vol.params.parse({ interval: 'week' })));
    expect(v.rows.length).toBeGreaterThanOrEqual(12);
    expect(v.rows.reduce((s, x) => s + (x.opened as number), 0)).toBeGreaterThan(10);
    expect(v.charts![0]!.data.reduce((s, x) => s + (x.tickets as number), 0)).toBeGreaterThan(0);
  });
});
