import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { dueNow, recentRuns, runDaily } from '../src/platform/jobs/daily.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** The built-in daily job (D-171). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('dailyjob'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` } });

describe('when it is due', () => {
  it('runs once the hour has passed, and only once a day', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 24, h, 30));
    expect(dueNow(at(5), 6, '2026-10-23')).toBe(false); // before the hour
    expect(dueNow(at(6), 6, '2026-10-23')).toBe(true);
    expect(dueNow(at(14), 6, '2026-10-24')).toBe(false); // already ran today
    expect(dueNow(at(14), 6, null)).toBe(true);
  });
});

describe('running it', () => {
  it('is claimed by one run per day across instances; a person can force a re-run; each company gets its own summary', async () => {
    const day = '2031-03-15';
    const [a, b] = await Promise.all([runDaily({ today: day }), runDaily({ today: day })]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // two instances start together: exactly one runs
    const first = (a ?? b)!;
    expect(first.tenants[w.tenantId]).toMatchObject({ ok: true, slug: expect.any(String), reminders: expect.anything(), retention: expect.anything(), archives: expect.anything(), documents: { promoted: 0 } });
    expect(await runDaily({ today: day })).toBeNull();
    expect(await runDaily({ today: day, force: true, trigger: 'manual' })).not.toBeNull();
    const row = (await getAdminPool().query(`SELECT status, trigger FROM job_run WHERE job = 'daily' AND run_date = $1`, [day])).rows;
    expect(row).toEqual([{ status: 'done', trigger: 'manual' }]);
    const mine = (await recentRuns(w.tenantId)).find((r) => r.runDate === day)!;
    expect(mine.mine).toMatchObject({ ok: true });
    expect(Object.keys(mine)).not.toContain('result'); // a company sees only its own summary
  });

  it('administrators see the history and can run their own company\'s steps now; others cannot', async () => {
    expect((await call(w.tokens.techA, 'GET', '/api/job-runs')).statusCode).toBe(403);
    const list = (await call(w.tokens.admin, 'GET', '/api/job-runs')).json();
    expect(list).toMatchObject({ enabled: false, runs: expect.any(Array) }); // switched off under test
    expect(list.answer).toMatch(/switched off on this server/);
    expect((await call(w.tokens.techA, 'POST', '/api/job-runs/run-now')).statusCode).toBe(403);
    const now = await call(w.tokens.admin, 'POST', '/api/job-runs/run-now');
    expect(now.statusCode, now.body).toBe(200);
    expect(now.json()).toMatchObject({ ok: true });
  });
});

describe('notices follow feature visibility (D-171)', () => {
  it('nobody is told to sign off a record of a feature they cannot see', async () => {
    const q = (sql: string, p: unknown[] = []) => getAdminPool().query(sql, p);
    const lines = [{ section: 'revenue', label: 'Savings', method: 'fixed_monthly', amount: 1000 }, { section: 'capital', label: 'Kit', method: 'one_time', amount: 20000 }];
    const post = (token: string | undefined, url: string, body: unknown) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: body as any });
    const waiting = async (title: string) => (await q(`SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND user_id = $2 AND kind = 'approval.waiting' AND title LIKE $3`, [w.tenantId, w.admin.userId, `%${title}%`])).rows[0].n;
    // Business cases are shown only to finance approvers: the owner (an administrator) is not asked to approve one.
    await q(`INSERT INTO tenant_feature (tenant_id, feature_key, mode, role_keys, updated_by) VALUES ($1, 'proforma', 'roles', ARRAY['finance_approver'], $2)`, [w.tenantId, w.admin.userId]);
    const { forgetFeatures } = await import('../src/platform/features.js'); forgetFeatures(w.tenantId);
    const a = (await post(w.tokens.finance, '/api/proformas', { title: 'Hidden from the owner', kind: 'other', startMonth: '2027-01', lines })).json();
    expect((await post(w.tokens.finance, `/api/proformas/${a.id}/submit`, {})).statusCode).toBe(200);
    expect(await waiting('Hidden from the owner')).toBe(0);
    // Shown to everyone again: the owner is told.
    await q(`DELETE FROM tenant_feature WHERE tenant_id = $1 AND feature_key = 'proforma'`, [w.tenantId]); forgetFeatures(w.tenantId);
    const b = (await post(w.tokens.finance, '/api/proformas', { title: 'Visible to the owner', kind: 'other', startMonth: '2027-01', lines })).json();
    await post(w.tokens.finance, `/api/proformas/${b.id}/submit`, {});
    expect(await waiting('Visible to the owner')).toBe(1);
  });
});
