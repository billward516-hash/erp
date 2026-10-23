import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { discover, verifyIdToken } from '../src/platform/auth/sso.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { getSso, saveSso } from '../src/modules/sso/service.js';
import { startMockIdp, type MockIdp } from '../scripts/mock-oidc.js';

/** Single sign-on (D-140) against the MOCK identity provider, which behaves like a real one for the parts checked. */
const db = () => getAdminPool();
let app: FastifyInstance; let idp: MockIdp;
let tenantId: string; let admin: Actor; let adminToken: string; let domain: string;

beforeAll(async () => {
  app = buildApp();
  const n = `sso-${process.pid}-${Date.now() % 100000}`;
  domain = `${n}.example`;
  const t = await provisionTenant(db(), { slug: n, name: 'Ridge Works', legalEntity: 'Ridge Works Inc', facilities: [{ code: 'P1', name: 'Plant 1', timezone: 'America/Chicago' }] });
  tenantId = t.tenantId;
  const a = await createUserWithToken(db(), tenantId, { email: `ada@${domain}`, displayName: 'Ada Admin', roles: [{ role: 'admin', facility: null }] });
  await createUserWithToken(db(), tenantId, { email: `ben@${domain}`, displayName: 'Ben Builder', roles: [{ role: 'technician', facility: t.facilities.P1! }] });
  admin = (await loadActor(tenantId, a.userId))!; adminToken = a.token;
  idp = await startMockIdp({ people: [
    { sub: 'idp-ada', email: `ada@${domain}`, name: 'Ada Admin' },
    { sub: 'idp-ben', email: `BEN@${domain}`, name: 'Ben Builder', emailVerified: false },
    { sub: 'idp-zed', email: `zed@${domain}`, name: 'Zed Stranger' },
  ] });
});
afterAll(async () => { await app.close(); await idp.close(); await closePools(); });

/** Runs a browser sign-in: our start → provider → our callback; returns where the browser lands. */
async function signIn(query: string, who?: string) {
  const start = await app.inject({ method: 'GET', url: `/auth/sso/start?${query}` });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string, 'http://app');
  if (!to.href.startsWith(idp.issuer)) return { ...decodeFragment(start.headers.location as string), callback: undefined };
  if (who) to.searchParams.set('user', who);
  const atIdp = await fetch(to, { redirect: 'manual' });
  const back = new URL(atIdp.headers.get('location')!);
  const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
  return { ...decodeFragment(cb.headers.location as string), callback: `${back.pathname}${back.search}` };
}
function decodeFragment(loc: string) {
  const [path, frag] = loc.split('#');
  const p = new URLSearchParams(frag ?? '');
  return { path, token: p.get('token'), next: p.get('next'), error: p.get('error') };
}

describe('single sign-on settings', () => {
  it('stores the client secret encrypted, never shows it, and checks the provider before enabling', async () => {
    await expect(asActor(admin, (tx) => saveSso(tx, admin, { issuer: 'http://localhost:1', clientId: 'x', emailDomains: [domain], enabled: true }))).rejects.toThrow();
    const r = await asActor(admin, (tx) => saveSso(tx, admin, { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, emailDomains: [`@${domain.toUpperCase()}`], enabled: true }));
    expect(r.settings).toMatchObject({ issuer: idp.issuer, has_secret: true, email_domains: [domain], enabled: true });
    expect(JSON.stringify(r)).not.toContain(idp.clientSecret);
    const raw = (await db().query('SELECT client_secret_enc FROM tenant_sso WHERE tenant_id = $1', [tenantId])).rows[0].client_secret_enc as Buffer;
    expect(raw.toString('latin1')).not.toContain(idp.clientSecret);
    // Turning API tokens off before you have signed in with single sign-on would lock you out.
    await expect(asActor(admin, (tx) => saveSso(tx, admin, { issuer: idp.issuer, clientId: idp.clientId, emailDomains: [domain], enabled: true, allowTokens: false }))).rejects.toThrow(/sign in once/);
  });

  it('a work-email domain belongs to one company', async () => {
    const other = await provisionTenant(db(), { slug: `${tenantId.slice(0, 8)}-o`, name: 'Other', legalEntity: 'Other LLC', facilities: [{ code: 'X', name: 'X', timezone: 'UTC' }] });
    const u = await createUserWithToken(db(), other.tenantId, { email: 'root@other.example', displayName: 'Root', roles: [{ role: 'admin', facility: null }] });
    const oa = (await loadActor(other.tenantId, u.userId))!;
    await expect(asActor(oa, (tx) => saveSso(tx, oa, { issuer: idp.issuer, clientId: 'c', emailDomains: [domain], enabled: true }))).rejects.toThrow(/already used by another company/);
  });
});

describe('signing in', () => {
  let session: string;
  it('finds the company from the work email, links the user by verified email and opens a session', async () => {
    const r = await signIn(`email=ada@${domain}&returnTo=/work-orders`);
    expect(r).toMatchObject({ path: '/signed-in', next: '/work-orders', error: null });
    session = r.token!;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${session}` } });
    expect(me.json()).toMatchObject({ displayName: 'Ada Admin', tenantId });
    expect((await db().query(`SELECT sso_subject FROM app_user WHERE tenant_id = $1 AND email = $2`, [tenantId, `ada@${domain}`])).rows[0].sso_subject).toBe('idp-ada');
    const tok = (await db().query(`SELECT kind, expires_at > now() + interval '11 hours' AS long_enough, expires_at < now() + interval '13 hours' AS short_enough FROM api_token WHERE label = 'Single sign-on session' AND tenant_id = $1`, [tenantId])).rows[0];
    expect(tok).toEqual({ kind: 'session', long_enough: true, short_enough: true });
    expect((await asActor(admin, (tx) => getSso(tx, admin))).youAreLinked).toBe(true);
  });

  it('a state works once, and a return path cannot leave the site', async () => {
    const r = await signIn(`email=ada@${domain}&returnTo=//evil.example/x`);
    expect(r.next).toBe('/');
    const again = await app.inject({ method: 'GET', url: r.callback! });
    expect(decodeFragment(again.headers.location as string).error).toMatch(/expired or was already used/);
  });

  it('refuses people who are not users, and emails the provider has not verified', async () => {
    expect((await signIn(`company=${(await db().query('SELECT slug FROM tenant WHERE id = $1', [tenantId])).rows[0].slug}`, 'idp-zed')).error).toMatch(/is not a user of Ridge Works/);
    expect((await signIn(`email=ben@${domain}`)).error).toMatch(/did not confirm the email address/);
    expect((await signIn('email=someone@unknown.example')).error).toMatch(/not set up for unknown.example/);
  });

  it('signing out ends the session; API tokens can be turned off once the admin has signed in', async () => {
    await asActor(admin, (tx) => saveSso(tx, admin, { issuer: idp.issuer, clientId: idp.clientId, emailDomains: [domain], enabled: true, allowTokens: false }));
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${adminToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/session/sign-out', headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(401);
    await asActor(admin, (tx) => saveSso(tx, admin, { issuer: idp.issuer, clientId: idp.clientId, emailDomains: [domain], enabled: true, allowTokens: true }));
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${adminToken}` } })).statusCode).toBe(200);
  });
});

describe('ID token checks', () => {
  const now = Math.floor(Date.now() / 1000);
  const good = () => ({ iss: idp.issuer, aud: idp.clientId, sub: 's', nonce: 'n', iat: now, exp: now + 300 });
  const check = async (token: string) => verifyIdToken(token, { issuer: idp.issuer, clientId: idp.clientId, nonce: 'n', jwksUri: (await discover(idp.issuer)).jwks_uri });
  it('accepts a well-formed token and rejects each kind of bad one', async () => {
    await expect(check(idp.sign(good()))).resolves.toMatchObject({ sub: 's' });
    await expect(check(idp.sign({ ...good(), aud: 'someone-else' }))).rejects.toThrow(/different application/);
    await expect(check(idp.sign({ ...good(), iss: 'https://evil.example' }))).rejects.toThrow(/different issuer/);
    await expect(check(idp.sign({ ...good(), exp: now - 3600 }))).rejects.toThrow(/expired/);
    await expect(check(idp.sign({ ...good(), nonce: 'other' }))).rejects.toThrow(/does not belong to this sign-in/);
    await expect(check(idp.sign(good(), { kid: 'unknown' }))).rejects.toThrow(/key the provider does not publish/);
    const t = idp.sign(good()).split('.');
    const forged = Buffer.from(JSON.stringify({ ...good(), sub: 'admin' })).toString('base64url');
    await expect(check(`${t[0]}.${forged}.${t[2]}`)).rejects.toThrow(/signature does not verify/);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${t[1]}.`;
    await expect(check(none)).rejects.toThrow(/signed with none are not accepted/);
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${t[1]}.${t[2]}`;
    await expect(check(hs)).rejects.toThrow(/HS256 are not accepted/);
  });
});
