import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** The practice copy (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('rehearse'); });
afterAll(async () => { await app.close(); await closePools(); });
const as = (token: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe('practice copy', () => {
  it('is made by an administrator from the real sites, is separate from the real company, and can be deleted completely', async () => {
    expect((await as(w.tokens.managerA!, 'POST', '/api/implementation/rehearsal', { mode: 'blank' })).statusCode).toBe(403);
    const r = await as(w.tokens.admin!, 'POST', '/api/implementation/rehearsal', { mode: 'blank' });
    expect(r.statusCode, r.body).toBe(201);
    const token = r.json().accessToken as string;
    expect((await as(w.tokens.admin!, 'POST', '/api/implementation/rehearsal', { mode: 'blank' })).statusCode).toBe(409);
    const info = (await as(w.tokens.admin!, 'GET', '/api/implementation/rehearsal')).json();
    expect(info).toMatchObject({ exists: true, mode: 'blank' });
    // In the practice company: the same sites, an administrator, nothing from the real company.
    const me = (await as(token, 'GET', '/api/me')).json();
    expect(me.tenantName).toMatch(/\(practice copy\)/);
    const sites = (await as(token, 'GET', '/api/facilities')).json();
    expect(sites.map((s: any) => s.code).sort()).toEqual(['A', 'B']);
    expect(sites.map((s: any) => s.id)).not.toContain(w.facilities.A);
    expect((await as(token, 'GET', '/api/implementation/rehearsal')).json()).toMatchObject({ practiceCopy: true });
    expect((await as(token, 'POST', '/api/implementation/rehearsal', { mode: 'blank' })).statusCode).toBe(409);
    // Loading something there does not change the real company.
    const before = Number((await getAdminPool().query('SELECT count(*)::int AS n FROM employee WHERE tenant_id = $1', [w.tenantId])).rows[0].n);
    const csv = 'Employee number,First name,Last name\nP1,Pat,Practice\n';
    const st = await as(token, 'POST', '/api/imports/stage', { target: 'employees', sourceSystem: 'rehearsal', fileName: 'e.csv', facilityId: sites[0].id, contentBase64: Buffer.from(csv).toString('base64') });
    expect(st.statusCode, st.body).toBe(201);
    const cm = await as(token, 'POST', `/api/imports/${st.json().batchId}/commit`, {}); expect(cm.statusCode, cm.body).toBe(200);
    expect(Number((await getAdminPool().query('SELECT count(*)::int AS n FROM employee WHERE tenant_id = $1', [w.tenantId])).rows[0].n)).toBe(before);
    // Delete: the practice company is gone entirely; the real one is untouched.
    expect((await as(w.tokens.admin!, 'DELETE', '/api/implementation/rehearsal')).statusCode).toBe(204);
    expect((await as(token, 'GET', '/api/me')).statusCode).toBe(401);
    const slug = (await getAdminPool().query('SELECT slug FROM tenant WHERE id = $1', [w.tenantId])).rows[0].slug as string;
    expect(Number((await getAdminPool().query('SELECT count(*)::int AS n FROM tenant WHERE slug = $1', [`${slug}-practice`])).rows[0].n)).toBe(0);
    expect((await as(w.tokens.admin!, 'GET', '/api/implementation/rehearsal')).json()).toMatchObject({ exists: false });
    expect((await as(w.tokens.admin!, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('with sample data, the practice copy arrives loaded with the sample company\'s files', async () => {
    const r = await as(w.tokens.admin!, 'POST', '/api/implementation/rehearsal', { mode: 'sample' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().loaded).toMatchObject({ employees: expect.any(Number), assets: expect.any(Number), parts: expect.any(Number), suppliers: expect.any(Number), customers: expect.any(Number) });
    expect(r.json().loaded.assets).toBeGreaterThan(10);
    const token = r.json().accessToken as string;
    const sites = (await as(token, 'GET', '/api/facilities')).json();
    expect(sites.map((s: any) => s.code).sort()).toEqual(['DAY', 'FTW']);
    expect((await as(token, 'GET', '/api/assets?limit=5')).json().length).toBeGreaterThan(0);
    expect((await as(w.tokens.admin!, 'DELETE', '/api/implementation/rehearsal')).statusCode).toBe(204);
  });
});
