import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { getRetention, runRetention, setRetention } from '../src/modules/retention/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Data retention (D-151). */
let app: FastifyInstance; let w: World; let other: World;
const db = () => getAdminPool();
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function batch(t: World, status: string, createdDaysAgo: number, rows = 3) {
  const b = (await db().query(`INSERT INTO import_batch (tenant_id, target, source_system, file_name, file_sha256, format, mapping, status, created_at, committed_at)
    VALUES ($1, 'assets', 'test', 'old.csv', md5(random()::text), 'csv', '{}', $2, $3, $4) RETURNING id`,
  [t.tenantId, status, ago(createdDaysAgo), status === 'committed' ? ago(createdDaysAgo) : null])).rows[0].id;
  for (let i = 1; i <= rows; i++) await db().query(`INSERT INTO import_row (tenant_id, batch_id, row_number, raw, status) VALUES ($1, $2, $3, '{"Name":"x"}', 'valid')`, [t.tenantId, b, i]);
  return b as string;
}
async function note(t: World, readDaysAgo: number | null, createdDaysAgo: number) {
  await db().query(`INSERT INTO notification (tenant_id, user_id, kind, title, created_at, read_at) VALUES ($1, $2, 'test', 'Old', $3, $4)`,
    [t.tenantId, t.admin.userId, ago(createdDaysAgo), readDaysAgo === null ? null : ago(readDaysAgo)]);
}
async function email(t: World, status: string, daysAgo: number) {
  await db().query(`INSERT INTO email_message (tenant_id, user_id, to_address, subject, body_text, dedupe_key, status, created_at, sent_at) VALUES ($1, $2, 'a@b.example', 'Digest', 'body', md5(random()::text), $3, $4, $5)`,
    [t.tenantId, t.admin.userId, status, ago(daysAgo), status === 'sent' ? ago(daysAgo) : null]);
}
const count = async (sql: string, t: World) => Number((await db().query(sql, [t.tenantId])).rows[0].n);

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('ret');
  other = await makeWorld('ret-other');
});
afterAll(async () => { await app.close(); await closePools(); });

describe('the Data retention screen', () => {
  it('shows the defaults, what is never removed, and is for administrators only', async () => {
    const r = await asActor(w.admin, (tx) => getRetention(tx, w.admin));
    expect(r.categories.map((c) => [c.key, c.days])).toEqual([['import_rows', 90], ['notifications_read', 180], ['notifications_unread', 365], ['emails', 90], ['form_drafts', 90], ['tokens', 30]]);
    expect(r.kept.join(' ')).toMatch(/audit log/);
    expect((await app.inject({ method: 'GET', url: '/api/retention', headers: { authorization: `Bearer ${w.tokens.techA}` } })).statusCode).toBe(403);
  });

  it('keeps periods within limits and audits each change', async () => {
    await expect(asActor(w.admin, (tx) => setRetention(tx, w.admin, 'emails', 3))).rejects.toThrow(/7 to 3650 days/);
    await expect(asActor(w.admin, (tx) => setRetention(tx, w.admin, 'audit', 30))).rejects.toThrow(/not found/);
    await asActor(w.admin, (tx) => setRetention(tx, w.admin, 'emails', 30));
    expect((await asActor(w.admin, (tx) => getRetention(tx, w.admin))).categories.find((c) => c.key === 'emails')).toMatchObject({ days: 30, updatedBy: expect.any(String) });
    expect(await count(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'retention.period_set'`, w)).toBe(1);
  });
});

describe('the daily sweep', () => {
  it('removes only what is past its period, previews it first, and leaves other companies alone', async () => {
    const oldDone = await batch(w, 'committed', 100);
    const recentDone = await batch(w, 'committed', 10);
    const abandoned = await batch(w, 'validated', 120, 2);
    await batch(other, 'committed', 400);
    await note(w, 200, 210); await note(w, 10, 210); await note(w, null, 400); await note(w, null, 100);
    await email(w, 'sent', 40); await email(w, 'sent', 5); await email(w, 'queued', 400);
    await db().query(`UPDATE api_token SET expires_at = $2 WHERE tenant_id = $1 AND user_id = $3`, [w.tenantId, ago(40), w.exec.userId]);

    const preview = await asActor(w.admin, (tx) => getRetention(tx, w.admin));
    const due = Object.fromEntries(preview.categories.map((c) => [c.key, c.due]));
    expect(due).toEqual({ import_rows: 5, notifications_read: 1, notifications_unread: 1, emails: 1, form_drafts: 0, tokens: 1 });
    expect(preview.categories[0]!.abandonedImports).toBe(1);

    const removed = await runRetention(w.tenantId);
    expect(removed).toMatchObject({ import_rows: 5, abandoned_imports: 1, notifications_read: 1, notifications_unread: 1, emails: 1, tokens: 1 });

    // Summaries stay; the recent import keeps its rows; the unfinished one is cancelled.
    const batches = (await db().query('SELECT id, status, rows_purged_at FROM import_batch WHERE id = ANY ($1)', [[oldDone, recentDone, abandoned]])).rows;
    expect(batches.find((b) => b.id === oldDone).rows_purged_at).not.toBeNull();
    expect(batches.find((b) => b.id === recentDone).rows_purged_at).toBeNull();
    expect(batches.find((b) => b.id === abandoned)).toMatchObject({ status: 'cancelled' });
    expect(await count('SELECT count(*)::int AS n FROM import_row WHERE tenant_id = $1', w)).toBe(3);
    expect(await count(`SELECT count(*)::int AS n FROM email_message WHERE tenant_id = $1 AND status = 'queued'`, w)).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM import_row WHERE tenant_id = $1', other)).toBe(3);

    // The sweep is recorded on the screen and in the audit log, which retention never touches.
    const after = await asActor(w.admin, (tx) => getRetention(tx, w.admin));
    expect(after.categories.every((c) => c.due === 0)).toBe(true);
    expect(after.runs[0]!.removed).toMatchObject({ import_rows: 5 });
    expect(await count(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'retention.swept'`, w)).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { authorization: `Bearer ${w.tokens.admin}` } })).json()).toMatchObject({ intact: true });

    // An import whose rows are gone says so instead of an empty problems file.
    const p = await app.inject({ method: 'GET', url: `/api/imports/${oldDone}/problems.csv`, headers: { authorization: `Bearer ${w.tokens.admin}` } });
    expect(p.statusCode).toBe(410);
    expect(p.json().error.message).toMatch(/data retention setting/);
  });

  it('a second sweep the same day removes nothing and audits nothing', async () => {
    expect(await runRetention(w.tenantId)).toEqual({});
    expect(await count(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'retention.swept'`, w)).toBe(1);
  });
});
