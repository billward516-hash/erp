import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** People and access (D-183A): users, roles, tokens; permissions, lockout, hash-only tokens, escalation, isolation. */
const db = () => getAdminPool();
let app: FastifyInstance; let w: World; let other: World;
let limitedToken: string; let limitedId: string; let siteAdminToken: string;

const call = async (token: string | undefined, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as any, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: body as any });
  let json: any = null;
  try { json = r.body ? JSON.parse(r.body) : null; } catch { /* no body */ }
  return { status: r.statusCode, body: json, raw: r.body };
};
const userId = async (token: string) => (await call(token, 'GET', '/api/me')).body.userId as string;
const audited = async (tenantId: string, action: string, entityId?: string) =>
  (await db().query('SELECT data FROM audit_event WHERE tenant_id = $1 AND action = $2 AND ($3::uuid IS NULL OR entity_id = $3) ORDER BY id', [tenantId, action, entityId ?? null])).rows.map((r) => r.data);

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('access');
  other = await makeWorld('access-other');
  // An administrator who holds only a few permissions (a custom role that includes tenant.admin).
  await db().query(`INSERT INTO role (tenant_id, key, name, permissions, custom) VALUES ($1, 'custom_limited_admin', 'Limited admin', ARRAY['tenant.admin','org.view','employees.view'], true)`, [w.tenantId]);
  const lim = await createUserWithToken(db(), w.tenantId, { email: `limited@${w.tenantId}.example`, displayName: 'Limited Admin', roles: [{ role: 'custom_limited_admin', facility: null }] });
  limitedToken = lim.token; limitedId = lim.userId;
  // An administrator for plant A only.
  siteAdminToken = (await createUserWithToken(db(), w.tenantId, { email: `sitea@${w.tenantId}.example`, displayName: 'Plant A Admin', roles: [{ role: 'admin', facility: w.facilities.A! }] })).token;
});
afterAll(async () => { await app.close(); await closePools(); });

describe('who may use the screens', () => {
  it('only tenant administrators reach any of the routes', async () => {
    for (const who of ['managerA', 'techA', 'exec']) {
      const t = w.tokens[who]!;
      for (const [m, u, b] of [['GET', '/api/admin-users'], ['POST', '/api/admin-users', { displayName: 'X', email: 'x@y.example' }], ['GET', '/api/admin-roles'],
        ['POST', '/api/admin-roles', { name: 'Mine', permissions: ['org.view'] }], ['GET', '/api/admin-tokens'], ['POST', '/api/admin-tokens', { userId: w.admin.userId, label: 'x' }]] as const) {
        const r = await call(t, m, u, b);
        expect(r.status, `${who} ${m} ${u}`).toBe(403);
      }
    }
    expect((await call(undefined, 'GET', '/api/admin-users')).status).toBe(401);
    expect((await call(w.tokens.admin, 'GET', '/api/admin-users')).status).toBe(200);
  });

  it('Lite keeps Users and Tokens and refuses Roles', async () => {
    const n = `lite-${process.pid}-${Date.now() % 100000}`;
    const t = await provisionTenant(db(), { slug: n, name: 'Lite Co', legalEntity: 'Lite Co', facilities: [{ code: 'HQ', name: 'HQ', timezone: 'America/Chicago' }], edition: 'lite' });
    const a = await createUserWithToken(db(), t.tenantId, { email: `o@${n}.example`, displayName: 'Owner', roles: [{ role: 'admin', facility: null }] });
    expect((await call(a.token, 'GET', '/api/admin-users')).status).toBe(200);
    expect((await call(a.token, 'GET', '/api/admin-tokens')).status).toBe(200);
    const roles = await call(a.token, 'GET', '/api/admin-roles');
    expect(roles.status).toBe(403);
    expect(roles.body.error.code).toBe('edition');
    // The five-user cap still holds when people are added here.
    for (let i = 0; i < 4; i++) expect((await call(a.token, 'POST', '/api/admin-users', { displayName: `P${i}`, email: `p${i}@${n}.example` })).status).toBe(201);
    const sixth = await call(a.token, 'POST', '/api/admin-users', { displayName: 'P5', email: `p5@${n}.example` });
    expect(sixth.status).toBe(422);
    expect(sixth.body.error.message).toMatch(/licence/);
  });
});

describe('users', () => {
  it('lists the company\'s users with their grants and nobody else\'s', async () => {
    const r = await call(w.tokens.admin, 'GET', '/api/admin-users');
    const names = r.body.users.map((u: any) => u.displayName);
    expect(names).toContain('managerA');
    const m = r.body.users.find((u: any) => u.displayName === 'managerA');
    expect(m.grants).toEqual([expect.objectContaining({ role: 'maintenance_manager', facility: 'A' })]);
    expect(m.status).toBe('active');
    expect(r.body.roles.some((x: any) => x.key === 'admin')).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(other.tenantId);
    const theirs = await call(other.tokens.admin, 'GET', '/api/admin-users');
    expect(theirs.body.users.map((u: any) => u.id)).not.toContain(m.id);
  });

  it('creates a person without the import, once, and audits it', async () => {
    const email = `New.Person@${w.tenantId}.example`;
    const r = await call(w.tokens.admin, 'POST', '/api/admin-users', { displayName: ' New Person ', email });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: email.toLowerCase(), displayName: 'New Person', status: 'active' });
    expect((await call(w.tokens.admin, 'POST', '/api/admin-users', { displayName: 'Again', email: email.toUpperCase() })).status).toBe(409);
    expect((await call(w.tokens.admin, 'POST', '/api/admin-users', { displayName: 'Bad', email: 'not-an-email' })).status).toBe(422);
    expect((await audited(w.tenantId, 'user.created', r.body.id))[0]).toMatchObject({ email: email.toLowerCase() });
    // A new person holds nothing until given a role, and cannot sign in without a credential.
    const list = await call(w.tokens.admin, 'GET', '/api/admin-users');
    expect(list.body.users.find((u: any) => u.id === r.body.id).grants).toEqual([]);
    expect((await call(w.tokens.admin, 'PATCH', `/api/admin-users/${r.body.id}`, { displayName: 'Renamed Person' })).status).toBe(204);
  });

  it('a disabled user is locked out at once: tokens fail, sessions end, and enabling restores them', async () => {
    const c = await createUserWithToken(db(), w.tenantId, { email: `leaver@${w.tenantId}.example`, displayName: 'Leaver', roles: [{ role: 'technician', facility: w.facilities.A! }] });
    const session = 'erp_session-' + Math.random().toString(36).slice(2);
    await db().query('SELECT sso_issue_session($1, $2, $3, 12)', [w.tenantId, c.userId, hashToken(session), ]);
    expect((await call(c.token, 'GET', '/api/me')).status).toBe(200);
    expect((await call(session, 'GET', '/api/me')).status).toBe(200);

    expect((await call(w.tokens.admin, 'POST', `/api/admin-users/${w.admin.userId}/disable`)).status).toBe(422); // not yourself
    const off = await call(w.tokens.admin, 'POST', `/api/admin-users/${c.userId}/disable`);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ status: 'disabled', sessionsEnded: 1 });
    expect((await call(c.token, 'GET', '/api/me')).status).toBe(401);
    expect((await call(session, 'GET', '/api/me')).status).toBe(401);
    expect((await db().query(`SELECT revoked_at FROM api_token WHERE token_hash = $1`, [hashToken(session)])).rows[0].revoked_at).not.toBeNull();
    // Single sign-on does not resolve a disabled user either (by subject or by email).
    await db().query(`INSERT INTO tenant_sso (tenant_id, issuer, client_id, enabled, updated_by) VALUES ($1, 'https://idp.example', 'c', true, $2) ON CONFLICT DO NOTHING`, [w.tenantId, w.admin.userId]);
    expect((await db().query(`SELECT * FROM sso_resolve_user($1, 'https://idp.example', 'sub-x', $2, true)`, [w.tenantId, `leaver@${w.tenantId}.example`])).rowCount).toBe(0);
    // A disabled user cannot be handed a new token.
    const blocked = await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: c.userId, label: 'nope' });
    expect(blocked.status).toBe(422);

    expect((await call(w.tokens.admin, 'POST', `/api/admin-users/${c.userId}/enable`)).body.status).toBe('active');
    expect((await call(c.token, 'GET', '/api/me')).status).toBe(200); // the API token was suspended, not destroyed
    expect((await call(session, 'GET', '/api/me')).status).toBe(401); // the ended session stays ended
    expect((await audited(w.tenantId, 'user.disabled', c.userId))[0]).toMatchObject({ sessionsEnded: 1 });
    expect(await audited(w.tenantId, 'user.enabled', c.userId)).toHaveLength(1);
  });

  it('links and unlinks the single sign-on identity; an identity belongs to one user', async () => {
    const a = await createUserWithToken(db(), w.tenantId, { email: `sso-a@${w.tenantId}.example`, displayName: 'Sso A', roles: [] });
    const b = await createUserWithToken(db(), w.tenantId, { email: `sso-b@${w.tenantId}.example`, displayName: 'Sso B', roles: [] });
    const ident = { issuer: 'https://old-idp.example/', subject: `sub-${Date.now()}` };
    expect((await call(w.tokens.admin, 'POST', `/api/admin-users/${a.userId}/sso-link`, ident)).status).toBe(204);
    const row = (await db().query('SELECT sso_issuer, sso_subject FROM app_user WHERE id = $1', [a.userId])).rows[0];
    expect(row).toEqual({ sso_issuer: 'https://old-idp.example', sso_subject: ident.subject });
    expect((await call(w.tokens.admin, 'POST', `/api/admin-users/${a.userId}/sso-link`, ident)).status).toBe(409); // already linked
    expect((await call(w.tokens.admin, 'POST', `/api/admin-users/${b.userId}/sso-link`, ident)).status).toBe(409); // identity taken
    // The failed attempt left B untouched and the connection usable.
    expect((await db().query('SELECT sso_subject FROM app_user WHERE id = $1', [b.userId])).rows[0].sso_subject).toBeNull();
    const list = await call(w.tokens.admin, 'GET', '/api/admin-users');
    expect(list.body.users.find((u: any) => u.id === a.userId).sso).toEqual({ issuer: 'https://old-idp.example', subject: ident.subject });

    expect((await call(w.tokens.admin, 'POST', `/api/admin-users/${a.userId}/sso-unlink`)).status).toBe(204);
    expect((await call(w.tokens.admin, 'POST', `/api/admin-users/${a.userId}/sso-unlink`)).status).toBe(409);
    // After the provider changed, the same person is found again by verified email and linked to the new identity.
    await db().query(`INSERT INTO tenant_sso (tenant_id, issuer, client_id, enabled, link_by_email, updated_by) VALUES ($1, 'https://idp.example', 'c', true, true, $2) ON CONFLICT (tenant_id) DO UPDATE SET link_by_email = true, enabled = true`, [w.tenantId, w.admin.userId]);
    const again = await db().query(`SELECT * FROM sso_resolve_user($1, 'https://new-idp.example', 'new-sub', $2, true)`, [w.tenantId, `sso-a@${w.tenantId}.example`]);
    expect(again.rows[0]).toMatchObject({ user_id: a.userId, how: 'email' });
    expect(await audited(w.tenantId, 'user.sso_unlinked', a.userId)).toHaveLength(1);
    expect(await audited(w.tenantId, 'user.sso_linked', a.userId)).toHaveLength(1);
  });

  it('keeps companies apart: another company\'s user cannot be seen, changed, linked or given a role', async () => {
    const theirs = other.admin.userId;
    for (const [m, u, b] of [['POST', `/api/admin-users/${theirs}/disable`], ['POST', `/api/admin-users/${theirs}/enable`], ['PATCH', `/api/admin-users/${theirs}`, { displayName: 'Hacked' }],
      ['POST', `/api/admin-users/${theirs}/sso-link`, { issuer: 'https://x.example', subject: 's' }], ['POST', `/api/admin-users/${theirs}/sso-unlink`]] as const) {
      expect((await call(w.tokens.admin, m, u, b)).status, `${m} ${u}`).toBe(404);
    }
    expect((await call(w.tokens.admin, 'POST', '/api/user-grants', { userId: theirs, roleKey: 'technician' })).status).toBe(404);
    expect((await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: theirs, label: 'x' })).status).toBe(404);
    expect((await db().query('SELECT status, display_name FROM app_user WHERE id = $1', [theirs])).rows[0]).toMatchObject({ status: 'active', display_name: 'admin' });
  });
});

describe('roles', () => {
  it('shows the starter roles read-only and the full permission list', async () => {
    const r = await call(w.tokens.admin, 'GET', '/api/admin-roles');
    expect(r.status).toBe(200);
    const tech = r.body.roles.find((x: any) => x.key === 'technician');
    expect(tech).toMatchObject({ custom: false, name: 'Maintenance Technician' });
    expect(tech.permissions).toContain('work_orders.execute');
    expect(r.body.permissions.map((p: any) => p.key)).toContain('tenant.admin');
    expect(r.body.permissions.every((p: any) => p.held)).toBe(true); // the corporate administrator holds everything
    // Starter roles cannot be changed or removed, through the screen's routes or by guessing keys.
    expect((await call(w.tokens.admin, 'PUT', `/api/admin-roles/${tech.id}`, { name: 'Technician', permissions: ['org.view', 'tenant.admin'] })).status).toBe(403);
    expect((await call(w.tokens.admin, 'DELETE', `/api/admin-roles/${tech.id}`)).status).toBe(403);
    expect((await db().query(`SELECT permissions FROM role WHERE id = $1`, [tech.id])).rows[0].permissions).not.toContain('tenant.admin');
  });

  it('creates, edits and deletes a custom role; a grant of it works like any other', async () => {
    const make = await call(w.tokens.admin, 'POST', '/api/admin-roles', { name: 'Gate Reader', description: 'Reads assets and WOs', permissions: ['assets.view', 'work_orders.view', 'assets.view'] });
    expect(make.status).toBe(201);
    expect(make.body.key).toBe('custom_gate_reader');
    expect((await call(w.tokens.admin, 'POST', '/api/admin-roles', { name: 'gate reader', permissions: ['org.view'] })).status).toBe(409); // names are unique
    expect((await call(w.tokens.admin, 'POST', '/api/admin-roles', { name: 'Bad', permissions: ['not.a.permission'] })).status).toBe(422);
    expect((await call(w.tokens.admin, 'POST', '/api/admin-roles', { name: 'Empty', permissions: [] })).status).toBe(422);

    const person = await createUserWithToken(db(), w.tenantId, { email: `gate@${w.tenantId}.example`, displayName: 'Gate', roles: [] });
    expect((await call(person.token, 'GET', '/api/assets')).status).toBe(403);
    const grant = await call(w.tokens.admin, 'POST', '/api/user-grants', { userId: person.userId, roleKey: 'custom_gate_reader', facilityId: w.facilities.A });
    expect(grant.status).toBe(201);
    expect((await call(person.token, 'GET', '/api/assets')).status).toBe(200);

    // Editing applies to everyone who holds it, on their next request.
    expect((await call(w.tokens.admin, 'PUT', `/api/admin-roles/${make.body.id}`, { name: 'Gate Reader', permissions: ['work_orders.view'] })).status).toBe(200);
    expect((await call(person.token, 'GET', '/api/assets')).status).toBe(403);
    const updated = (await audited(w.tenantId, 'role.updated', make.body.id))[0];
    expect(updated).toMatchObject({ added: [], removed: ['assets.view'] });

    // In use: refused. Free: deleted.
    const inUse = await call(w.tokens.admin, 'DELETE', `/api/admin-roles/${make.body.id}`);
    expect(inUse.status).toBe(409);
    expect((await call(w.tokens.admin, 'DELETE', `/api/user-grants/${grant.body.id}`)).status).toBe(204);
    expect((await call(w.tokens.admin, 'PUT', '/api/features/news', { mode: 'roles', roleKeys: ['custom_gate_reader'] })).status).toBe(204);
    expect((await call(w.tokens.admin, 'DELETE', `/api/admin-roles/${make.body.id}`)).status).toBe(409); // named in feature visibility
    expect((await call(w.tokens.admin, 'PUT', '/api/features/news', { mode: 'all' })).status).toBe(204);
    expect((await call(w.tokens.admin, 'DELETE', `/api/admin-roles/${make.body.id}`)).status).toBe(204);
    expect(await audited(w.tenantId, 'role.created', make.body.id)).toHaveLength(1);
    expect(await audited(w.tenantId, 'role.deleted', make.body.id)).toHaveLength(1);
  });

  it('keeps custom roles of one company out of another and the key rule in the database', async () => {
    await call(other.tokens.admin, 'POST', '/api/admin-roles', { name: 'Their Secret Role', permissions: ['org.view'] });
    const mine = await call(w.tokens.admin, 'GET', '/api/admin-roles');
    expect(mine.body.roles.map((r: any) => r.name)).not.toContain('Their Secret Role');
    const theirs = (await call(other.tokens.admin, 'GET', '/api/admin-roles')).body.roles.find((r: any) => r.custom);
    expect((await call(w.tokens.admin, 'PUT', `/api/admin-roles/${theirs.id}`, { name: 'Taken', permissions: ['org.view'] })).status).toBe(404);
    expect((await call(w.tokens.admin, 'DELETE', `/api/admin-roles/${theirs.id}`)).status).toBe(404);
    await expect(db().query(`INSERT INTO role (tenant_id, key, name, permissions, custom) VALUES ($1, 'custom_sneaky', 'Sneaky', '{}', false)`, [w.tenantId])).rejects.toThrow(/role_custom_key/);
    await expect(db().query(`INSERT INTO role (tenant_id, key, name, permissions, custom) VALUES ($1, 'technician2', 'T2', '{}', true)`, [w.tenantId])).rejects.toThrow(/role_custom_key/);
  });
});

describe('nobody grants what they lack', () => {
  it('refuses a role definition with a permission the administrator does not hold, but allows tenant.admin', async () => {
    const r = await call(limitedToken, 'POST', '/api/admin-roles', { name: 'Overreach', permissions: ['org.view', 'books.manage'] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('escalation');
    expect(r.body.error.message).toContain('books.manage');
    const ok = await call(limitedToken, 'POST', '/api/admin-roles', { name: 'Another Admin', permissions: ['tenant.admin', 'org.view'] });
    expect(ok.status).toBe(201);
    // And cannot rewrite or delete a role that carries more than they hold.
    const big = await call(w.tokens.admin, 'POST', '/api/admin-roles', { name: 'Big Role', permissions: ['books.manage', 'org.view'] });
    expect((await call(limitedToken, 'PUT', `/api/admin-roles/${big.body.id}`, { name: 'Big Role', permissions: ['org.view'] })).status).toBe(403);
    expect((await call(limitedToken, 'DELETE', `/api/admin-roles/${big.body.id}`)).status).toBe(403);
  });

  it('refuses to grant a role carrying permissions the administrator lacks', async () => {
    const target = await createUserWithToken(db(), w.tenantId, { email: `t1@${w.tenantId}.example`, displayName: 'T1', roles: [] });
    const full = await call(limitedToken, 'POST', '/api/user-grants', { userId: target.userId, roleKey: 'admin' });
    expect(full.status).toBe(403);
    expect(full.body.error.code).toBe('escalation');
    expect((await call(limitedToken, 'POST', '/api/user-grants', { userId: target.userId, roleKey: 'technician', facilityId: w.facilities.A })).status).toBe(403);
    // A role made only of what they hold is fine.
    const mine = await call(limitedToken, 'POST', '/api/admin-roles', { name: 'Directory Reader', permissions: ['org.view', 'employees.view'] });
    expect((await call(limitedToken, 'POST', '/api/user-grants', { userId: target.userId, roleKey: mine.body.key })).status).toBe(201);
    expect((await db().query('SELECT count(*)::int AS n FROM user_role_assignment WHERE user_id = $1', [target.userId])).rows[0].n).toBe(1);
  });

  it('applies the same rule by site: a plant administrator grants at their plant, not elsewhere or everywhere', async () => {
    const target = await createUserWithToken(db(), w.tenantId, { email: `t2@${w.tenantId}.example`, displayName: 'T2', roles: [] });
    const g = (facilityId: string | null) => call(siteAdminToken, 'POST', '/api/user-grants', { userId: target.userId, roleKey: 'maintenance_manager', facilityId });
    expect((await g(w.facilities.B!)).status).toBe(403);
    expect((await g(null)).status).toBe(403);
    const ok = await g(w.facilities.A!);
    expect(ok.status).toBe(201);
    // Removing is held to the same rule: a plant administrator cannot take away a corporate grant.
    const corp = await call(w.tokens.admin, 'POST', '/api/user-grants', { userId: target.userId, roleKey: 'maintenance_manager', facilityId: null });
    expect((await call(siteAdminToken, 'DELETE', `/api/user-grants/${corp.body.id}`)).status).toBe(403);
    expect((await call(siteAdminToken, 'DELETE', `/api/user-grants/${ok.body.id}`)).status).toBe(204);
    expect((await call(w.tokens.admin, 'DELETE', `/api/user-grants/${corp.body.id}`)).status).toBe(204);
  });

  it('does not let an administrator who hid a feature lose the ability to grant its roles', async () => {
    expect((await call(w.tokens.admin, 'PUT', '/api/features/books', { mode: 'off' })).status).toBe(204);
    try {
      const target = await createUserWithToken(db(), w.tenantId, { email: `t3@${w.tenantId}.example`, displayName: 'T3', roles: [] });
      expect((await call(w.tokens.admin, 'POST', '/api/user-grants', { userId: target.userId, roleKey: 'bookkeeper' })).status).toBe(201);
    } finally {
      await call(w.tokens.admin, 'PUT', '/api/features/books', { mode: 'all' });
    }
  });
});

describe('API tokens', () => {
  it('shows a token once and stores only its hash; the token works and use is noted', async () => {
    const target = w.managerA.userId;
    const r = await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: target, label: 'Payroll export', expiresInDays: 30 });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^erp_/);
    const row = (await db().query('SELECT * FROM api_token WHERE id = $1', [r.body.id])).rows[0];
    expect(row.token_hash.equals(hashToken(r.body.token))).toBe(true);
    // The clear text exists nowhere in the row, the audit trail or the list.
    expect(JSON.stringify(row)).not.toContain(r.body.token);
    expect(JSON.stringify((await db().query('SELECT data FROM audit_event WHERE tenant_id = $1', [w.tenantId])).rows)).not.toContain(r.body.token);
    const listed = await call(w.tokens.admin, 'GET', '/api/admin-tokens');
    expect(listed.raw).not.toContain(r.body.token);
    expect(listed.raw).not.toMatch(/token_hash|tokenHash/);
    expect(listed.body.tokens.find((t: any) => t.id === r.body.id)).toMatchObject({ label: 'Payroll export', userName: 'managerA', state: 'active', lastUsedAt: null, createdBy: 'admin' });
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    expect((await call(r.body.token, 'GET', '/api/me')).body.userId).toBe(target);
    const after = (await call(w.tokens.admin, 'GET', '/api/admin-tokens')).body.tokens.find((t: any) => t.id === r.body.id);
    expect(after.lastUsedAt).not.toBeNull();
    expect((await audited(w.tenantId, 'token.issued', r.body.id))[0]).toMatchObject({ userId: target, label: 'Payroll export' });
  });

  it('refuses a repeat under an Idempotency-Key (the replay would store the token) and bad expiries', async () => {
    const key = { 'idempotency-key': 'abcdefgh-1234' };
    expect((await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: w.techA.userId, label: 'x' }, key)).status).toBe(400);
    expect((await db().query(`SELECT count(*)::int AS n FROM idempotency_record WHERE tenant_id = $1 AND body LIKE '%erp_%'`, [w.tenantId])).rows[0].n).toBe(0);
    const past = await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: w.techA.userId, label: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.status).toBe(422);
    expect((await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: w.techA.userId, label: '   ' })).status).toBe(422);
  });

  it('revokes a token at once, lists it as revoked, and ignores an expired one', async () => {
    const t = await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: w.techA.userId, label: 'Scanner' });
    expect(t.body.expiresAt).toBeNull();
    expect((await call(t.body.token, 'GET', '/api/me')).status).toBe(200);
    expect((await call(w.tokens.admin, 'POST', `/api/admin-tokens/${t.body.id}/revoke`)).status).toBe(204);
    expect((await call(t.body.token, 'GET', '/api/me')).status).toBe(401);
    expect((await call(w.tokens.admin, 'POST', `/api/admin-tokens/${t.body.id}/revoke`)).status).toBe(409);
    const def = await call(w.tokens.admin, 'GET', '/api/admin-tokens');
    expect(def.body.tokens.map((x: any) => x.id)).not.toContain(t.body.id);
    expect(def.body.hidden).toBeGreaterThan(0);
    const all = await call(w.tokens.admin, 'GET', '/api/admin-tokens?all=true');
    expect(all.body.tokens.find((x: any) => x.id === t.body.id)).toMatchObject({ state: 'revoked', revokedBy: 'admin' });
    expect(await audited(w.tenantId, 'token.revoked', t.body.id)).toHaveLength(1);

    const e = await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: w.techA.userId, label: 'Short', expiresInDays: 1 });
    await db().query(`UPDATE api_token SET created_at = now() - interval '3 days', expires_at = now() - interval '1 day' WHERE id = $1`, [e.body.id]);
    expect((await call(e.body.token, 'GET', '/api/me')).status).toBe(401);
    expect((await call(w.tokens.admin, 'GET', '/api/admin-tokens?all=1')).body.tokens.find((x: any) => x.id === e.body.id).state).toBe('expired');
  });

  it('will not issue a token that carries more access than the administrator holds, or cross companies', async () => {
    const r = await call(limitedToken, 'POST', '/api/admin-tokens', { userId: w.admin.userId, label: 'Borrowed power' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('escalation');
    expect((await call(siteAdminToken, 'POST', '/api/admin-tokens', { userId: w.exec.userId, label: 'corporate' })).status).toBe(403);
    expect((await call(siteAdminToken, 'POST', '/api/admin-tokens', { userId: w.techA.userId, label: 'plant A tech' })).status).toBe(201);
    expect((await call(limitedToken, 'POST', '/api/admin-tokens', { userId: limitedId, label: 'mine' })).status).toBe(201);
    const t = await call(other.tokens.admin, 'POST', '/api/admin-tokens', { userId: other.techA.userId, label: 'theirs' });
    expect((await call(w.tokens.admin, 'POST', `/api/admin-tokens/${t.body.id}/revoke`)).status).toBe(404);
    expect((await call(w.tokens.admin, 'GET', '/api/admin-tokens?all=1')).body.tokens.map((x: any) => x.id)).not.toContain(t.body.id);
    expect((await call(t.body.token, 'GET', '/api/me')).status).toBe(200);
  });

  it('records the use of a token at most once a minute', async () => {
    const t = await call(w.tokens.admin, 'POST', '/api/admin-tokens', { userId: w.techA.userId, label: 'Polling' });
    await call(t.body.token, 'GET', '/api/me');
    const first = (await db().query('SELECT last_used_at FROM api_token WHERE id = $1', [t.body.id])).rows[0].last_used_at;
    await call(t.body.token, 'GET', '/api/me');
    expect((await db().query('SELECT last_used_at FROM api_token WHERE id = $1', [t.body.id])).rows[0].last_used_at).toEqual(first);
  });
});
