import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { emit } from '../src/platform/integration/outbox.js';
import { runDaily, runDailyForTenant, recentRuns } from '../src/platform/jobs/daily.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { sweepTempChanges } from '../src/modules/moc/temp-changes.js';
import { createChange } from '../src/modules/moc/service.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createConnection } from '../src/modules/integrations/service.js';
import { syncTenant } from '../src/modules/integrations/scheduled.js';
import { listReminders, setReminder } from '../src/modules/reminders/settings.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** D-183B: the accounting sync inside the daily job, a manual run that is recorded, and one coherent series of expiry notices. */
let app: FastifyInstance;
const db = () => getAdminPool();
const todayIso = () => new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
beforeAll(() => { app = buildApp(); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
/** A mail sender that accepts everything, so the daily job never touches the file system or network. */
const quiet = { name: 'test (accepts all)', send: async () => undefined };

describe('the accounting sync in the daily job', () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld('jobsync'); });

  it('does nothing, and says so, for a company with no accounting connection', async () => {
    expect(await syncTenant(w.tenantId)).toEqual({ skipped: 'no accounting connection' });
    const r = await runDailyForTenant(w.tenantId, undefined, { sender: quiet });
    expect(r).toMatchObject({ ok: true, sync: { skipped: 'no accounting connection' } });
  });

  it('runs the sync for a connected company, records it, and is safe to run again', async () => {
    await asActor(w.admin, (tx) => createConnection(tx, w.admin, { provider: 'mock_accounting' }));
    // An event that the mock system does not handle is parked as skipped; the point is that the sync ran and recorded it.
    await asActor(w.admin, (tx) => emit(tx, w.admin, { topic: 'test.unhandled', aggregateType: 'test', aggregateId: w.admin.userId, payload: {}, idempotencyKey: 'sync-sched-1' }));
    const first = await runDailyForTenant(w.tenantId, undefined, { sender: quiet });
    expect(first.ok).toBe(true);
    expect(first.sync).toMatchObject({ provider: 'mock_accounting', skipped: 1, delivered: 0, failed: 0, dead: 0, mock: true });
    const again = await runDailyForTenant(w.tenantId, undefined, { sender: quiet });
    expect(again.sync).toMatchObject({ skipped: 0, delivered: 0 }); // nothing is delivered or skipped twice
    const rows = (await db().query(`SELECT status FROM sync_delivery WHERE tenant_id = $1`, [w.tenantId])).rows;
    expect(rows).toEqual([{ status: 'skipped' }]);
    const audits = (await db().query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'integration.sync_run'`, [w.tenantId])).rows[0].n;
    expect(audits).toBeGreaterThanOrEqual(2);
  });

  it('works with the built-in books too', async () => {
    const x = await makeWorld('jobbooks');
    await asActor(x.admin, (tx) => createConnection(tx, x.admin, { provider: 'native_books' }));
    const r = await runDailyForTenant(x.tenantId, undefined, { sender: quiet });
    expect(r.sync).toMatchObject({ provider: 'native_books', failed: 0, dead: 0 });
    expect(r.ok).toBe(true);
  });

  it('a sync that cannot run fails that step only, shows on the Scheduled jobs page, and tells the administrators once a day', async () => {
    const x = await makeWorld('jobsyncfail');
    await asActor(x.admin, (tx) => createConnection(tx, x.admin, { provider: 'mock_accounting' }));
    // The person who connected it, and everyone else, lose the right to manage the connection: the sync cannot run as anyone.
    await db().query(`UPDATE role SET permissions = array_remove(permissions, 'integrations.manage') WHERE tenant_id = $1`, [x.tenantId]);
    const a = await runDailyForTenant(x.tenantId, undefined, { sender: quiet });
    expect(a.ok).toBe(false);
    expect(a.syncError).toEqual(expect.any(String));
    expect(a).toHaveProperty('retention'); // the other steps still ran
    expect(a).toHaveProperty('documents');
    await runDailyForTenant(x.tenantId, undefined, { sender: quiet });
    const told = (await db().query(`SELECT user_id FROM notification WHERE tenant_id = $1 AND kind = 'reminder.sync_failed' AND dedupe_key LIKE 'sync-run-failed:%'`, [x.tenantId])).rows;
    expect(told.map((t) => t.user_id)).toEqual([x.admin.userId]); // once, to the administrator, despite two failing runs the same day
    // The manual run and the page show the failure in words.
    const run = (await call(x.tokens.admin, 'POST', '/api/job-runs/run-now')).json();
    expect(run).toMatchObject({ ok: false });
    expect(run.steps.find((s: any) => s.step === 'sync')).toMatchObject({ ok: false, text: expect.any(String) });
    const page = (await call(x.tokens.admin, 'GET', '/api/job-runs')).json();
    expect(page.runs[0]).toMatchObject({ trigger: 'manual', status: 'failed' });
    expect(page.runs[0].steps.find((s: any) => s.step === 'sync')).toMatchObject({ ok: false });
    // Leave nothing behind that would make a later whole-database run of the daily job fail.
    await db().query(`UPDATE integration_connection SET active = false WHERE tenant_id = $1`, [x.tenantId]);
    expect((await runDailyForTenant(x.tenantId, undefined, { sender: quiet })).ok).toBe(true);
  });
});

describe('run it now', () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld('runnow'); });

  it('writes a job_run row marked as run by a person, and answers with what each step did', async () => {
    expect((await call(w.tokens.techA, 'POST', '/api/job-runs/run-now')).statusCode).toBe(403);
    const res = await call(w.tokens.admin, 'POST', '/api/job-runs/run-now');
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ ok: true, runId: expect.any(String) });
    expect(r.steps.map((s: any) => s.step)).toEqual(['retainers', 'reminders', 'digests', 'sync', 'retention', 'archives', 'documents']);
    expect(r.steps.every((s: any) => s.ok && typeof s.text === 'string' && s.text.length > 0)).toBe(true);
    const row = (await db().query(`SELECT trigger, status, tenant_id, started_by, finished_at, result FROM job_run WHERE id = $1`, [r.runId])).rows[0];
    expect(row).toMatchObject({ trigger: 'manual', status: 'done', tenant_id: w.tenantId, started_by: w.admin.userId });
    expect(row.finished_at).not.toBeNull();
    expect(row.result.tenants[w.tenantId]).toMatchObject({ ok: true });
    // Another manual run the same day is another row (the scheduled day's lock is not involved).
    const r2 = (await call(w.tokens.admin, 'POST', '/api/job-runs/run-now')).json();
    expect(r2.runId).not.toBe(r.runId);
    expect((await db().query(`SELECT count(*)::int AS n FROM job_run WHERE tenant_id = $1 AND trigger = 'manual'`, [w.tenantId])).rows[0].n).toBe(2);
  });

  it('shows in the history as run by a person, to that company only, and does not stop the scheduled run for the day', async () => {
    const page = (await call(w.tokens.admin, 'GET', '/api/job-runs')).json();
    expect(page.runs.filter((x: any) => x.trigger === 'manual' && x.startedBy)).toHaveLength(2);
    expect(page.runs[0]).toMatchObject({ trigger: 'manual', startedBy: 'admin', status: 'done', steps: expect.any(Array) });
    expect(page.mail).toMatchObject({ configured: false, queued: expect.any(Number), failed: expect.any(Number) });
    const other = await makeWorld('runnow2');
    expect((await recentRuns(other.tenantId)).filter((x) => x.trigger === 'manual')).toHaveLength(0);
    // A scheduled run on a given day still claims its row even though manual rows exist for that day.
    const scheduled = await runDaily({ today: '2031-04-01' });
    expect(scheduled).not.toBeNull();
    expect(await runDaily({ today: '2031-04-01' })).toBeNull();
    const rls = (await db().query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'job_run'`)).rows[0];
    expect(rls.relrowsecurity).toBe(true);
  });
});

describe('quotes: one notice per milestone', () => {
  let w: World; let cust: string;
  const quoteNotices = async (quoteId: string) => (await db().query(`SELECT kind, dedupe_key, user_id FROM notification WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id`, [w.tenantId, quoteId])).rows;
  const sent = async (validUntil: string) => {
    const q = (await call(w.tokens.admin, 'POST', '/api/quotes', { facilityId: w.facilities.A, customerId: cust, title: 'Line 4 retrofit brackets', validUntil, lines: [{ description: 'Bracket, machined', qty: 100, unitPrice: 12.5 }] })).json();
    expect((await call(w.tokens.admin, 'POST', `/api/quotes/${q.id}/submit`)).statusCode).toBeLessThan(300);
    expect((await call(w.tokens.admin, 'POST', `/api/quotes/${q.id}/send`, {})).statusCode).toBeLessThan(300);
    return q.id as string;
  };
  beforeAll(async () => {
    w = await makeWorld('qseries');
    await asActor(w.admin, async (tx) => { cust = (await createCustomer(tx, w.admin, { code: 'ACME', name: 'Acme Corp', kind: 'customer', paymentTerms: 'Net 30' })).id; });
  });

  it('gives the owner exactly one notice at 7 days, one at 2 days and one the day after, however often the sweep runs', async () => {
    const id = await sent(day(30));
    const today = todayIso();
    const seen: number[] = [];
    for (const left of [20, 7, 5, 2, 1, -1]) {
      await db().query('UPDATE quote SET valid_until = $2 WHERE id = $1', [id, day(left)]);
      await runReminders(w.tenantId, today); await runReminders(w.tenantId, today); // the same day twice adds nothing
      seen.push((await quoteNotices(id)).length);
    }
    expect(seen).toEqual([0, 1, 1, 2, 2, 3]);
    const all = await quoteNotices(id);
    expect(all.map((n) => n.dedupe_key).sort()).toEqual([`quote-expiry:${id}:-1`, `quote-expiry:${id}:2`, `quote-expiry:${id}:7`].sort());
    expect(new Set(all.map((n) => n.kind))).toEqual(new Set(['reminder.quote_expiring']));
    expect(new Set(all.map((n) => n.user_id))).toEqual(new Set([w.admin.userId]));
  });

  it('the whole daily job adds no second notice for the same quote', async () => {
    const id = await sent(day(7));
    await runDailyForTenant(w.tenantId, undefined, { sender: quiet });
    await runDailyForTenant(w.tenantId, undefined, { sender: quiet });
    expect(await quoteNotices(id)).toHaveLength(1);
  });

  it('follows the company\'s reminder setting: lead days, off, and an old saved repeat that no longer applies', async () => {
    const id = await sent(day(10));
    const today = todayIso();
    await runReminders(w.tenantId, today);
    expect(await quoteNotices(id)).toHaveLength(0); // 10 days out is outside the default lead of 7
    await asActor(w.admin, (tx) => setReminder(tx, w.admin, 'quote_expiring', { enabled: true, leadDays: 10, repeat: 'once' }));
    await runReminders(w.tenantId, today);
    expect(await quoteNotices(id)).toHaveLength(1); // the lead is now 10
    await asActor(w.admin, (tx) => setReminder(tx, w.admin, 'quote_expiring', { enabled: false, leadDays: 10, repeat: 'once' }));
    const other = await sent(day(2));
    await runReminders(w.tenantId, today);
    expect(await quoteNotices(other)).toHaveLength(0); // switched off
    // A setting saved before this change, with a repeat the reminder no longer offers, still loads and still works.
    await db().query(`UPDATE tenant_reminder SET enabled = true, repeat = 'daily' WHERE tenant_id = $1 AND reminder_key = 'quote_expiring'`, [w.tenantId]);
    const list = await asActor(w.admin, (tx) => listReminders(tx, w.admin));
    expect(list.reminders.find((r) => r.key === 'quote_expiring')).toMatchObject({ enabled: true, repeat: 'once', leadDays: 10 });
    await runReminders(w.tenantId, today);
    expect(await quoteNotices(other)).toHaveLength(1);
  });
});

describe('temporary changes: one series per change', () => {
  let w: World; let doc: string; let tcId: string; let linked: string; let standalone: string;
  const forSubject = async (id: string) => (await db().query(`SELECT kind, dedupe_key, user_id FROM notification WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id`, [w.tenantId, id])).rows;
  const base = (title: string) => ({ consequences: 'Higher load', qmsImpact: 'Setup sheet change', resources: 'Parts on hand', responsibilities: 'Owner: the requester',
    facilityId: '', title, changeType: 'equipment' as const, description: 'Run HMC-9 with the portable chiller while the main chiller is repaired.', justification: 'Main chiller compressor failed; parts are 3 weeks out.' });
  beforeAll(async () => {
    w = await makeWorld('tcseries');
    doc = (await db().query(`INSERT INTO document (tenant_id, facility_id, doc_number, title, doc_type, owner_user_id) VALUES ($1, $2, 'SOP-200', 'Torque the nut', 'sop', $3) RETURNING id`, [w.tenantId, w.facilities.A, w.admin.userId])).rows[0].id;
    const v = (await db().query(`INSERT INTO document_version (tenant_id, document_id, revision, version_label, status, storage_key, file_name, mime_type, size_bytes, sha256, approved_at) VALUES ($1, $2, 1, 'A', 'approved', 'k', 'f.pdf', 'application/pdf', 1, 'x', now()) RETURNING id`, [w.tenantId, doc])).rows[0].id;
    await db().query('UPDATE document SET current_version_id = $2 WHERE id = $1', [doc, v]);
    const mk = (title: string) => asActor(w.managerA, (tx) => createChange(tx, w.managerA, { ...base(title), facilityId: w.facilities.A!, isTemporary: true, temporaryUntil: day(30) }));
    linked = (await mk('Bypass the chiller (authorises a temporary SOP change)')).id;
    standalone = (await mk('Portable heater on line 2')).id;
    tcId = (await db().query(`INSERT INTO temporary_change (tenant_id, facility_id, number, document_id, title, what_changes, reason, starts_on, expires_on, original_expires_on, status, owner_user_id, change_id, created_by, activated_at)
      VALUES ($1, $2, 'TC-00001', $3, 'Use the 36 mm socket', 'Use the 36 mm socket until the new one arrives', 'Back-order', $4, $5, $5, 'active', $6, $7, $6, now()) RETURNING id`,
    [w.tenantId, w.facilities.A, doc, day(-1), day(30), w.managerA.userId, linked])).rows[0].id;
  });

  it('alerts the owner once at 14, 7, 3, 1 and 0 days, and the change record tied to it stays quiet', async () => {
    const today = todayIso();
    const seen: number[] = [];
    for (const left of [20, 14, 10, 7, 3, 1, 0]) {
      await db().query('UPDATE temporary_change SET expires_on = $2, starts_on = LEAST(starts_on, $2) WHERE id = $1', [tcId, day(left)]);
      await db().query('UPDATE moc_change SET temporary_until = $2 WHERE id = $1', [linked, day(left)]);
      for (let i = 0; i < 2; i++) { await runReminders(w.tenantId, today); await asActor(w.admin, (tx) => sweepTempChanges(tx, w.tenantId)); } // twice: no repeats
      seen.push((await forSubject(tcId)).filter((n) => n.user_id === w.managerA.userId).length);
    }
    expect(seen).toEqual([0, 1, 1, 2, 3, 4, 5]);
    const owner = (await forSubject(tcId)).filter((n) => n.user_id === w.managerA.userId);
    expect(owner.map((n) => n.dedupe_key).sort()).toEqual([14, 7, 3, 1, 0].map((n) => `tc-exp:${tcId}:${n}`).sort());
    expect(new Set(owner.map((n) => n.kind))).toEqual(new Set(['reminder.temporary_change_ending']));
    // Nothing from the weekly catalogue reminder for the change record that the temporary SOP change already covers.
    expect(await forSubject(linked)).toEqual([]);
  });

  it('the weekly reminder still covers a temporary change record with no temporary SOP change of its own', async () => {
    const today = todayIso();
    await db().query('UPDATE moc_change SET temporary_until = $2 WHERE id = $1', [standalone, day(5)]);
    await runReminders(w.tenantId, today); await runReminders(w.tenantId, today);
    const n = await forSubject(standalone);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: 'reminder.temporary_change_ending' });
  });
});
