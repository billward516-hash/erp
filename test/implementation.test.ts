import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { CATALOGUE } from '../src/modules/implementation/catalogue.js';
import { TARGETS } from '../src/modules/imports/targets/registry.js';

/** Implementation planner (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('impl'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
const csv = (text: string, target: string, fileName = 'f.csv') => async () =>
  call(w.tokens.admin, 'POST', '/api/imports/stage', { target, sourceSystem: 'test', fileName, contentBase64: Buffer.from(text).toString('base64') });

describe('the implementation plan', () => {
  it('is built at the chosen depth; only administrators create it', async () => {
    expect((await call(w.tokens.managerA, 'POST', '/api/implementation', { depth: 'standard' })).statusCode).toBe(403);
    const r = await call(w.tokens.admin, 'POST', '/api/implementation', { depth: 'guided', targetGoLive: '2027-03-01' });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json();
    expect(p.plan).toMatchObject({ depth: 'guided', targetGoLive: expect.stringContaining('2027-03-01') });
    const keys = p.steps.map((s: any) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['sites', 'employees', 'users_roles', 'customers', 'cutover', 'go_live']));
    expect(keys).not.toContain('assets'); // standard and full only
    expect((await call(w.tokens.admin, 'POST', '/api/implementation', { depth: 'full' })).statusCode).toBe(409);
    // A deeper plan adds steps and keeps what exists.
    const full = (await call(w.tokens.admin, 'PUT', '/api/implementation/depth', { depth: 'full' })).json();
    expect(full.steps.map((s: any) => s.key)).toEqual(expect.arrayContaining(['assets', 'work_order_history', 'conn_payroll']));
    const back = (await call(w.tokens.admin, 'PUT', '/api/implementation/depth', { depth: 'guided' })).json();
    expect(back.steps.map((s: any) => s.key)).not.toContain('assets');
  });

  it('locks steps until what they depend on is done; an administrator can open one with a reason', async () => {
    await call(w.tokens.admin, 'PUT', '/api/implementation/depth', { depth: 'standard' });
    let p = (await call(w.tokens.admin, 'GET', '/api/implementation')).json();
    const by = (k: string) => p.steps.find((s: any) => s.key === k);
    expect(by('employees')).toMatchObject({ locked: true, waitingFor: ['Sites'] });
    expect(by('sites')).toMatchObject({ locked: false, status: 'todo' });
    const early = await call(w.tokens.admin, 'POST', '/api/implementation/steps/employees/start', {});
    expect(early.statusCode).toBe(422);
    expect(early.json().error.message).toMatch(/waits for Sites/);
    expect((await call(w.tokens.admin, 'POST', '/api/implementation/steps/employees/start', { overrideReason: 'sites are in the HR file' })).statusCode).toBe(200);
    p = (await call(w.tokens.admin, 'GET', '/api/implementation')).json();
    expect(by('employees')).toMatchObject({ status: 'in_progress', overrideReason: 'sites are in the HR file' });
  });

  it('a committed import moves its step to loaded by itself; the owner then verifies it', async () => {
    const stage = await csv('code,name,timezone\nNEW1,Newtown Plant,America/Chicago\n', 'sites')();
    expect(stage.statusCode, stage.body).toBe(201);
    const commit = await call(w.tokens.admin, 'POST', `/api/imports/${stage.json().batchId}/commit`, {});
    expect(commit.statusCode, commit.body).toBe(200);
    let p = (await call(w.tokens.admin, 'GET', '/api/implementation')).json();
    const sites = () => p.steps.find((s: any) => s.key === 'sites');
    expect(sites()).toMatchObject({ status: 'loaded', loadedCount: expect.any(Number) });
    expect(sites().loadedCount).toBeGreaterThan(0);
    // Verification is by the assignee or an administrator.
    expect((await call(w.tokens.techA, 'POST', '/api/implementation/steps/sites/verify', {})).statusCode).toBe(403);
    await call(w.tokens.admin, 'PATCH', '/api/implementation/steps/sites', { assigneeUserId: w.managerA.userId, expectedCount: 1 });
    expect((await call(w.tokens.managerA, 'GET', '/api/implementation/mine')).json().map((s: any) => s.key)).toContain('sites');
    const v = await call(w.tokens.managerA, 'POST', '/api/implementation/steps/sites/verify', { note: 'counted against the site list' });
    expect(v.statusCode, v.body).toBe(200);
    p = v.json();
    expect(sites()).toMatchObject({ status: 'verified' });
    expect(p.steps.find((s: any) => s.key === 'departments').locked).toBe(false);
  });

  it('a data step cannot be verified before anything is loaded; go-live needs every required step', async () => {
    const early = await call(w.tokens.admin, 'POST', '/api/implementation/steps/customers/verify', {});
    expect(early.statusCode).toBe(422);
    expect(early.json().error.message).toMatch(/load customers first/);
    expect((await call(w.tokens.admin, 'POST', '/api/implementation/steps/go_live/start', {})).statusCode).toBe(422); // waits for cutover
    const skip = await call(w.tokens.admin, 'POST', '/api/implementation/steps/departments/skip', { reason: 'x' });
    expect(skip.statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'POST', '/api/implementation/steps/departments/skip', { reason: 'one department only' })).statusCode).toBe(200);
    const p = (await call(w.tokens.admin, 'GET', '/api/implementation')).json();
    expect(p.readiness.canGoLive).toBe(false);
    expect(p.answer).toMatch(/required steps are verified/);
  });
});

describe('the step catalogue', () => {
  it('has a step for every import and an import for every data step; steps depend only on steps that exist', () => {
    const targets = new Set(TARGETS.map((t) => t.key));
    const stepTargets = new Set(CATALOGUE.filter((s) => s.target).map((s) => s.target!));
    expect([...targets].filter((k) => !stepTargets.has(k))).toEqual([]);
    expect([...stepTargets].filter((k) => !targets.has(k))).toEqual([]);
    const keys = new Set(CATALOGUE.map((s) => s.key));
    expect(CATALOGUE.flatMap((s) => s.dependsOn.filter((d) => !d.startsWith('*') && !keys.has(d)))).toEqual([]);
    expect(keys.size).toBe(CATALOGUE.length);
  });

  it('puts every step after the steps it depends on', () => {
    const at = new Map(CATALOGUE.map((s, i) => [s.key, i]));
    expect(CATALOGUE.flatMap((s) => s.dependsOn.filter((d) => !d.startsWith('*') && at.get(d)! > at.get(s.key)!).map((d) => `${s.key} before ${d}`))).toEqual([]);
  });
});
