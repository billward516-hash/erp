import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, can, loadActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { FEATURES } from '../src/platform/features.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { listFeatures, setFeature } from '../src/modules/features/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Feature visibility by role (D-149). */
let app: FastifyInstance; let w: World;
const h = (who: string) => ({ authorization: `Bearer ${w.tokens[who]}` });
const get = (who: string, url: string) => app.inject({ method: 'GET', url, headers: h(who) });
const set = (key: string, mode: 'all' | 'roles' | 'off', roleKeys: string[] = []) => asActor(w.admin, (tx) => setFeature(tx, w.admin, key, { mode, roleKeys }));

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('feat');
  await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'LATHE-9', name: 'Lathe' }));
});
afterAll(async () => { await app.close(); await closePools(); });

describe('the Features screen', () => {
  it('lists every feature for administrators only, everyone by default', async () => {
    const r = await asActor(w.admin, (tx) => listFeatures(tx, w.admin));
    expect(r.features).toHaveLength(FEATURES.length);
    expect(r.features.every((f) => f.mode === 'all')).toBe(true);
    expect(r.roles.map((x) => x.key)).toContain('technician');
    expect((await get('techA', '/api/features')).statusCode).toBe(403);
  });

  it('refuses an empty or unknown role list', async () => {
    await expect(set('safety', 'roles', [])).rejects.toThrow(/choose at least one role/);
    await expect(set('safety', 'roles', ['nobody'])).rejects.toThrow(/unknown role nobody/);
  });
});

describe('a feature turned off', () => {
  it('is gone for everyone, administrators included, except on the Features screen', async () => {
    await set('leasing', 'off');
    for (const who of ['techA', 'admin']) {
      const me = (await get(who, '/api/me')).json();
      expect(me.hiddenFeatures).toContain('leasing');
      expect(me.hiddenNav).toContain('/leasing');
      expect(me.grants.some((g: any) => g.permissions.includes('leasing.view'))).toBe(false);
      const leases = await get(who, '/api/leases');
      expect(leases.statusCode).toBe(403);
      expect(leases.json().error).toMatchObject({ code: 'feature_off', message: expect.stringMatching(/Leasing is turned off for your role/) });
    }
    expect((await get('admin', '/api/reports')).json().map((r: any) => r.id)).not.toContain('rent-roll');
    expect((await get('admin', '/api/reports/rent-roll')).statusCode).toBe(403);
    expect((await get('admin', '/api/features')).json().features.find((f: any) => f.key === 'leasing')).toMatchObject({ mode: 'off' });
  });

  it('a feature hidden by navigation leaves search too', async () => {
    expect((await get('admin', '/api/search?q=lathe')).json().groups.map((g: any) => g.kind)).toContain('assets');
    await set('assets', 'off');
    expect((await get('admin', '/api/search?q=lathe')).json().groups.map((g: any) => g.kind)).not.toContain('assets');
    // Other features still use assets: the register's API stays, only its pages and reports go.
    expect((await get('admin', '/api/assets')).statusCode).toBe(200);
    expect((await get('admin', '/api/reports/asset-availability')).statusCode).toBe(403);
    await set('assets', 'all');
  });
});

describe('a feature shown to some roles', () => {
  it('stays for those roles and leaves the others, refused by the server and by permission', async () => {
    await set('safety', 'roles', ['ehs_reviewer']);
    expect((await get('ehsA', '/api/incidents')).statusCode).toBe(200);
    expect((await get('techA', '/api/incidents')).statusCode).toBe(403);
    const tech = (await loadActor(w.tenantId, w.techA.userId))!;
    expect(can(tech, 'safety.report')).toBe(false);
    expect(tech.hiddenFeatures).toContain('safety');
  });

  it('applies per role a person holds: the same person keeps it where they hold the role', async () => {
    await set('quality', 'roles', ['quality_reviewer']);
    const both = await createUserWithToken(getAdminPool(), w.tenantId, { email: `both@${w.tenantId}.example`, displayName: 'Both Roles',
      roles: [{ role: 'quality_reviewer', facility: w.facilities.A! }, { role: 'technician', facility: w.facilities.B! }] });
    const a = (await loadActor(w.tenantId, both.userId))!;
    expect(can(a, 'quality.view', w.facilities.A)).toBe(true);
    expect(can(a, 'quality.report', w.facilities.B)).toBe(false); // the technician role lost it at B
    expect(a.hiddenFeatures).not.toContain('quality');
    expect(can((await loadActor(w.tenantId, w.techA.userId))!, 'quality.report')).toBe(false);
  });

  it('back to everyone restores it, and every change is audited', async () => {
    await set('safety', 'all'); await set('quality', 'all'); await set('leasing', 'all');
    expect((await get('techA', '/api/incidents')).statusCode).toBe(200);
    expect((await get('admin', '/api/me')).json().hiddenFeatures).toEqual([]);
    const n = (await getAdminPool().query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'feature.visibility_set'`, [w.tenantId])).rows[0].n;
    expect(n).toBe(8); // leasing off, assets off and on, safety and quality to roles, and three back to everyone
  });
});

describe('the catalogue', () => {
  it('every feature names real permissions, and no two features own the same API area', async () => {
    const { PERMISSIONS } = await import('../src/platform/auth/permissions.js');
    const known = new Set<string>(PERMISSIONS as readonly string[]);
    expect(FEATURES.flatMap((f) => f.permissions).filter((p) => !known.has(p))).toEqual([]);
    const areas = FEATURES.flatMap((f) => f.areas);
    expect(areas.filter((a, i) => areas.indexOf(a) !== i)).toEqual([]);
    const { REPORTS } = await import('../src/modules/reporting/registry.js');
    const ids = new Set(REPORTS.map((r) => r.id));
    expect(FEATURES.flatMap((f) => f.reports).filter((r) => !ids.has(r))).toEqual([]);
  });
});
