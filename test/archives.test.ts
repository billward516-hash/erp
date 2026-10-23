import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { config } from '../src/config.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { runArchives } from '../src/modules/archives/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Company archives and restore (D-165). */
let app: FastifyInstance; let w: World; let other: World;
const db = () => getAdminPool();
beforeAll(async () => { app = buildApp(); w = await makeWorld('archives'); other = await makeWorld('archives-other'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
const customer = async (t: string, code: string, name: string) => (await db().query(`INSERT INTO customer (tenant_id, code, name, kind) VALUES ($1, $2, $3, 'customer') RETURNING id`, [t, code, name])).rows[0].id as string;

describe('taking archives', () => {
  it('is for administrators; an archive is a checksummed gzip of every company table, without secrets or drafts', async () => {
    expect((await call(w.tokens.finance, 'POST', '/api/archives', {})).statusCode).toBe(403);
    expect((await call(w.tokens.finance, 'GET', '/api/archives')).statusCode).toBe(403);
    await customer(w.tenantId, 'ARC-1', 'Archived Customer');
    const made = await call(w.tokens.admin, 'POST', '/api/archives', { note: 'Before the price change' });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ kind: 'manual', status: 'ready', table_count: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const file = await call(w.tokens.admin, 'GET', `/api/archives/${made.json().id}/download`);
    expect(file.statusCode).toBe(200);
    const lines = gunzipSync(file.rawPayload).toString('utf8').split('\n');
    const head = JSON.parse(lines[0]!);
    expect(head).toMatchObject({ format: 'erp-company-archive/1', tenant: { id: w.tenantId }, kind: 'manual' });
    const names = head.tables.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['customer', 'facility', 'app_user', 'audit_event']));
    for (const secret of ['api_token', 'sso_login', 'form_draft', 'tenant_sso', 'idempotency_record']) expect(names).not.toContain(secret);
    expect(JSON.parse(lines[1 + names.indexOf('customer')]!).map((c: any) => c.name)).toContain('Archived Customer');
    // Only this company's rows are in it.
    expect(lines.slice(1).every((l) => !l.includes(other.tenantId))).toBe(true);
    const o = (await call(w.tokens.admin, 'GET', '/api/archives')).json();
    expect(o.answer).toMatch(/^Last archive today; the next is due in 30 days\. 1 kept\.$/);
  });

  it('the daily job archives once the interval has passed and keeps only the latest N', async () => {
    const blobs = new LocalBlobStore(config.storageDir);
    expect((await runArchives(blobs, w.tenantId)).created).toBeNull(); // the manual archive above is recent
    expect((await call(w.tokens.admin, 'PUT', '/api/archives/settings', { intervalDays: 30, keepCount: 2 })).statusCode).toBe(200);
    expect((await call(w.tokens.admin, 'PUT', '/api/archives/settings', { intervalDays: 0, keepCount: 2 })).statusCode).toBe(422);
    const later = (days: number) => new Date(Date.now() + days * 86_400_000);
    expect((await runArchives(blobs, w.tenantId, later(31))).created).toBeTruthy();
    await db().query(`UPDATE company_archive SET created_at = created_at - interval '40 days' WHERE tenant_id = $1`, [w.tenantId]);
    expect((await runArchives(blobs, w.tenantId)).created).toBeTruthy();
    await db().query(`UPDATE company_archive SET created_at = created_at - interval '40 days' WHERE tenant_id = $1`, [w.tenantId]);
    const third = await runArchives(blobs, w.tenantId);
    expect(third).toMatchObject({ created: expect.any(String), removed: 1 });
    const kept = (await db().query(`SELECT count(*)::int AS n FROM company_archive WHERE tenant_id = $1 AND kind = 'scheduled' AND status = 'ready'`, [w.tenantId])).rows[0].n;
    expect(kept).toBe(2);
  });
});

describe('bringing records back', () => {
  it('shows what was deleted or changed since, and restores a record with the records that belong to it', async () => {
    const c = await customer(w.tenantId, 'ARC-2', 'Lakeshore Housings');
    await db().query(`INSERT INTO contact (tenant_id, customer_id, name, email) VALUES ($1, $2, 'Jo Buyer', 'jo@lakeshore.example'), ($1, $2, 'Sam Quality', 'sam@lakeshore.example')`, [w.tenantId, c]);
    const changed = await customer(w.tenantId, 'ARC-3', 'Original Name');
    const a = (await call(w.tokens.admin, 'POST', '/api/archives', {})).json();
    await db().query('DELETE FROM contact WHERE customer_id = $1', [c]);
    await db().query('DELETE FROM customer WHERE id = $1', [c]);
    await db().query(`UPDATE customer SET name = 'Renamed Later' WHERE id = $1`, [changed]);
    const contents = (await call(w.tokens.admin, 'GET', `/api/archives/${a.id}/contents`)).json();
    expect(contents.tables.find((t: any) => t.name === 'customer')).toMatchObject({ label: 'Customer' });
    expect(contents.tables.map((t: any) => t.name)).not.toContain('app_user');
    const rows = (await call(w.tokens.admin, 'GET', `/api/archives/${a.id}/rows?table=customer&q=ARC-`)).json();
    expect(rows.rows.map((r: any) => [r.values.code, r.state])).toEqual(expect.arrayContaining([['ARC-2', 'deleted'], ['ARC-3', 'changed']]));
    expect(rows.counts).toMatchObject({ deleted: 1, changed: 1 });
    // A contact alone cannot come back while its customer is gone; with its children the customer brings both contacts.
    const contacts = (await call(w.tokens.admin, 'GET', `/api/archives/${a.id}/rows?table=contact&q=lakeshore`)).json();
    const alone = await call(w.tokens.admin, 'POST', `/api/archives/${a.id}/restore`, { table: 'contact', keys: [contacts.rows[0].key] });
    expect(alone.statusCode).toBe(422);
    expect(alone.json().error.message).toMatch(/refers to a record that no longer exists/);
    const back = await call(w.tokens.admin, 'POST', `/api/archives/${a.id}/restore`, { table: 'customer', keys: [{ id: c }, { id: changed }], withChildren: true });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().restored).toMatchObject({ customer: 2, contact: 2 });
    expect((await db().query('SELECT name FROM customer WHERE id = ANY ($1) ORDER BY code', [[c, changed]])).rows.map((r) => r.name)).toEqual(['Lakeshore Housings', 'Original Name']);
    expect((await db().query('SELECT count(*)::int AS n FROM contact WHERE customer_id = $1', [c])).rows[0].n).toBe(2);
    // Users, tokens and the audit trail are not record types an archive restores.
    expect((await call(w.tokens.admin, 'POST', `/api/archives/${a.id}/restore`, { table: 'app_user', keys: [{ id: w.admin.userId }] })).statusCode).toBe(422);
    expect((await call(w.tokens.finance, 'POST', `/api/archives/${a.id}/restore`, { table: 'customer', keys: [{ id: c }] })).statusCode).toBe(403);
  });
});

describe('rolling the whole company back', () => {
  it('needs a second administrator, archives the present first, keeps users and the audit trail, and leaves other companies alone', async () => {
    const before = await customer(w.tenantId, 'RB-1', 'Exists at the archive');
    const a = (await call(w.tokens.admin, 'POST', '/api/archives', {})).json();
    // Work done after the archive: a new customer, a changed one, a new user, and a number taken.
    await customer(w.tenantId, 'RB-2', 'Created after the archive');
    await db().query(`UPDATE customer SET name = 'Changed after' WHERE id = $1`, [before]);
    const pf = (await call(w.tokens.finance, 'POST', '/api/proformas', { title: 'After the archive', kind: 'other', startMonth: '2027-01', useStarter: false })).json();
    const otherCount = (await db().query('SELECT count(*)::int AS n FROM customer WHERE tenant_id = $1', [other.tenantId])).rows[0].n;

    expect((await call(w.tokens.admin, 'POST', `/api/archives/${a.id}/rollback`, { reason: 'Bad import overwrote prices' })).json().error.message).toMatch(/second administrator/);
    const second = await createUserWithToken(db(), w.tenantId, { email: 'admin2@archives.example', displayName: 'Second Admin', roles: [{ role: 'admin', facility: null }] });
    const req = await call(w.tokens.admin, 'POST', `/api/archives/${a.id}/rollback`, { reason: 'Bad import overwrote prices' });
    expect(req.statusCode, req.body).toBe(201);
    expect((await call(w.tokens.admin, 'POST', `/api/archives/${a.id}/rollback`, { reason: 'Twice' })).statusCode).toBe(409);
    expect((await call(w.tokens.admin, 'POST', `/api/rollbacks/${req.json().id}/confirm`)).json().error.message).toMatch(/cannot confirm it/);
    const done = await call(second.token, 'POST', `/api/rollbacks/${req.json().id}/confirm`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ preRollbackArchiveId: expect.any(String), answer: expect.stringMatching(/^Rolled back to the archive of /) });

    const names = (await db().query(`SELECT code, name FROM customer WHERE tenant_id = $1 AND code LIKE 'RB-%' ORDER BY code`, [w.tenantId])).rows;
    expect(names).toEqual([{ code: 'RB-1', name: 'Exists at the archive' }]);
    expect((await db().query('SELECT 1 FROM proforma WHERE id = $1', [pf.id])).rowCount).toBe(0);
    // Kept as they are now: the second administrator, the number counter, and an intact audit trail that records the rollback.
    expect((await db().query('SELECT 1 FROM app_user WHERE id = $1', [second.userId])).rowCount).toBe(1);
    const next = (await call(w.tokens.finance, 'POST', '/api/proformas', { title: 'Numbered after the rollback', kind: 'other', startMonth: '2027-01', useStarter: false })).json();
    expect(next.number).not.toBe(pf.number);
    const chain = await db().connect();
    try {
      await chain.query('BEGIN'); await chain.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.tenantId]);
      expect((await chain.query('SELECT audit_verify_chain() AS broken')).rows[0].broken).toBeNull();
      expect((await chain.query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'company.rolled_back'`, [w.tenantId])).rows[0].n).toBe(1);
      await chain.query('ROLLBACK');
    } finally { chain.release(); }
    // The other company is untouched; the state before the rollback is itself an archive, so it can be undone.
    expect((await db().query('SELECT count(*)::int AS n FROM customer WHERE tenant_id = $1', [other.tenantId])).rows[0].n).toBe(otherCount);
    const list = (await call(w.tokens.admin, 'GET', '/api/archives')).json();
    expect(list.archives.find((x: any) => x.id === done.json().preRollbackArchiveId)).toMatchObject({ kind: 'pre_rollback' });
    expect(list.rollbacks[0]).toMatchObject({ status: 'done', requested_by_name: 'admin', confirmed_by_name: 'Second Admin' });
  });
});
