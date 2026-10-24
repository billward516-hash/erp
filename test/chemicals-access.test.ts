import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { createLocation } from '../src/modules/inventory/service.js';
import { createContainer, getContainer, listContainers, moveContainer, setChemicalPart } from '../src/modules/chemicals/service.js';
import { createPreparation, getPreparation } from '../src/modules/chemicals/preparations.js';
import { setFeature } from '../src/modules/features/service.js';
import { forgetEdition } from '../src/platform/edition.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { chemicalWorld, daysFrom } from './chemicals-fixtures.js';

/** Permissions, editions, features, tenant and site isolation for chemicals (SC-007 C). */
const db = () => getAdminPool();
let app: FastifyInstance; let w: World; let c: Awaited<ReturnType<typeof chemicalWorld>>; let boxA: string; let boxB: string; let prepA: string;
const admin = <T>(fn: (tx: any) => Promise<T>) => asActor(w.admin, fn);
const h = (who: string) => ({ authorization: `Bearer ${w.tokens[who]}` });
const call = (who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: any) => app.inject({ method, url, headers: h(who), payload });

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('chem-x'); c = await chemicalWorld(w);
  boxA = (await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: c.store.id, lot: 'HCL-X1', qty: 3, receiveIntoStock: true, expiresOn: daysFrom(300) }))).containers[0].id;
  boxB = (await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: c.storeB.id, lot: 'HCL-X2', qty: 3, receiveIntoStock: true, expiresOn: daysFrom(300) }))).containers[0].id;
  prepA = (await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Access buffer', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 10, components: [{ containerId: boxA, qty: 0.1 }] }))).id;
});
afterAll(async () => { await app.close(); await closePools(); });

describe('permissions', () => {
  it('a technician may look but not change anything', async () => {
    expect((await call('techA', 'GET', '/api/chemicals/containers')).statusCode).toBe(200);
    expect((await call('techA', 'POST', `/api/chemicals/containers/${boxA}/open`, {})).statusCode).toBe(403);
    expect((await call('techA', 'POST', `/api/chemicals/containers/${boxA}/use`, { qty: 0.1, reference: 'x' })).statusCode).toBe(403);
    expect((await call('techA', 'POST', `/api/chemicals/containers/${boxA}/dispose`, { note: 'nope nope' })).statusCode).toBe(403);
    expect((await call('techA', 'PUT', `/api/chemicals/parts/${c.acid.id}`, { isChemical: true })).statusCode).toBe(403);
    expect((await call('techA', 'POST', '/api/chemicals/storage-groups', { code: 'X', name: 'Nope' })).statusCode).toBe(403);
    expect((await call('techA', 'PUT', '/api/chemicals/limits', { locationId: c.store.id, hazardClass: 'corrosive', limitQty: 1, uom: 'L' })).statusCode).toBe(403);
    expect((await call('techA', 'PUT', '/api/chemicals/settings', { sdsMaxAgeYears: 5 })).statusCode).toBe(403);
    expect((await call('techA', 'POST', `/api/chemicals/preparations/${prepA}/discard`, { note: 'nope nope' })).statusCode).toBe(403);
    expect((await call('techA', 'POST', '/api/chemicals/labels/pdf', { kind: 'container', ids: [boxA] })).headers['content-type']).toBe('application/pdf');
  });

  it('a user with no chemical permission sees nothing at all', async () => {
    for (const url of ['/api/chemicals/overview', '/api/chemicals/containers', '/api/chemicals/preparations', '/api/chemicals/settings', '/api/chemicals/storage-groups']) {
      expect((await call('operatorB', 'GET', url)).statusCode).toBe(403);
    }
  });

  it('the plant manager can work chemicals but only an override holder can override', async () => {
    const fresh = (await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: c.store.id, lot: 'HCL-X3', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(300) }))).containers[0].id;
    const r = await call('managerA', 'POST', `/api/chemicals/containers/${fresh}/open`, {});
    expect(r.statusCode).toBe(200);
    const bad = await call('managerA', 'POST', `/api/chemicals/containers/${boxA}/move`, { toLocationId: c.storeB.id });
    expect(bad.statusCode).toBe(404); // plant B's locations are not visible to the plant A manager
    const roles = (await db().query(`SELECT key, 'chemicals.override' = ANY (permissions) AS can FROM role WHERE tenant_id = $1 AND key IN ('admin', 'ehs_reviewer', 'maintenance_manager', 'quality_manager', 'technician')`, [w.tenantId])).rows;
    expect(Object.fromEntries(roles.map((x) => [x.key, x.can]))).toEqual({ admin: true, ehs_reviewer: true, maintenance_manager: false, quality_manager: false, technician: false });
  });

  it('the pair list, hazard classes and starter note come with the NOT certified label', async () => {
    const groups = (await call('techA', 'GET', '/api/chemicals/storage-groups')).json();
    expect(groups.starterNote).toMatch(/NOT certified/);
    expect(groups.pairs.map((p: any) => [p.code_a, p.code_b].sort().join('/')).sort()).toEqual(['ACID/BASE', 'FLAM/OXID']);
    const s = (await call('techA', 'GET', '/api/chemicals/settings')).json();
    expect(s.hazardClasses.map((x: any) => x.code)).toEqual(['flammable', 'oxidizer', 'corrosive', 'toxic', 'compressed_gas', 'health_hazard', 'environmental', 'explosive']);
    expect(s.sdsMaxAgeYears).toBe(3);
  });
});

describe('the page counters', () => {
  it('count containers and problems for the sites the reader may see', async () => {
    const all = (await call('admin', 'GET', '/api/chemicals/overview')).json();
    const mineA = (await call('managerA', 'GET', '/api/chemicals/overview')).json();
    expect(all.chemicalParts).toBe(4);
    expect(all.noSds).toBe(4); // none of the fixture parts has a sheet
    expect(all.containers).toBeGreaterThanOrEqual(3);
    expect(mineA.containers).toBeLessThan(all.containers); // plant B's container is not counted for the plant A manager
    expect(all.settings).toEqual({ sdsMaxAgeYears: 3, receiptContainers: true });
  });
});

describe('site isolation', () => {
  it('the plant A manager sees plant A containers and preparations only', async () => {
    const list = await asActor(w.managerA, (tx) => listContainers(tx, w.managerA, { status: 'all' }));
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map((x) => x.facility_code))).toEqual(new Set(['A']));
    await expect(asActor(w.managerA, (tx) => getContainer(tx, w.managerA, boxB))).rejects.toMatchObject({ status: 404 });
    await expect(asActor(w.managerA, (tx) => moveContainer(tx, w.managerA, boxB, { toLocationId: c.store.id }))).rejects.toMatchObject({ status: 404 });
    expect((await call('managerA', 'GET', `/api/chemicals/containers/${boxB}`)).statusCode).toBe(404);
    expect((await call('managerA', 'GET', `/api/chemicals/containers?facilityId=${w.facilities.B}`)).statusCode).toBe(403);
    expect((await call('exec', 'GET', '/api/chemicals/containers?status=all')).json().map((x: any) => x.facility_code).sort()).toContain('B');
  });

  it('a preparation cannot use another site\'s container', async () => {
    await expect(asActor(w.managerA, (tx) => createPreparation(tx, w.managerA, { facilityId: w.facilities.A!, name: 'Cross', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: boxB, qty: 0.1 }] }))).rejects.toThrow(/not found/);
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Cross', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: boxB, qty: 0.1 }] }))).rejects.toThrow(/another site/);
    await expect(asActor(w.operatorB, (tx) => getPreparation(tx, w.operatorB, prepA))).rejects.toMatchObject({ status: 403 });
  });

  it('plant B\'s manager cannot place or limit anything at plant A', async () => {
    const bMgr = await createUserWithToken(db(), w.tenantId, { email: `mgrB@${w.tenantId}.example`, displayName: 'mgrB', roles: [{ role: 'maintenance_manager', facility: w.facilities.B! }] });
    const { loadActor } = await import('../src/platform/auth/actor.js');
    const b = (await loadActor(w.tenantId, bMgr.userId))!;
    await expect(asActor(b, (tx) => createContainer(tx, b, { partId: c.acid.id, locationId: c.store.id, lot: 'HCL-X1', qty: 1, receiveIntoStock: true }))).rejects.toThrow(/not found|missing permission/);
    expect((await asActor(b, (tx) => listContainers(tx, b, { status: 'all' }))).map((x) => x.facility_code)).toEqual(['B']);
  });
});

describe('tenant isolation', () => {
  it('another company sees none of it, by id or by list, and has its own starter lists', async () => {
    const t = await makeWorld('chem-other');
    const tc = await chemicalWorld(t);
    const tBox = (await asActor(t.admin, (tx) => createContainer(tx, t.admin, { partId: tc.acid.id, locationId: tc.store.id, lot: 'HCL-T1', qty: 1, receiveIntoStock: true }))).containers[0].id;
    await expect(asActor(t.admin, (tx) => getContainer(tx, t.admin, boxA))).rejects.toMatchObject({ status: 404 });
    await expect(admin((tx) => getContainer(tx, w.admin, tBox))).rejects.toMatchObject({ status: 404 });
    expect((await asActor(t.admin, (tx) => listContainers(tx, t.admin, { status: 'all' }))).map((x) => x.id)).toEqual([tBox]);
    await expect(asActor(t.admin, (tx) => getPreparation(tx, t.admin, prepA))).rejects.toMatchObject({ status: 404 });
    // Their storage-group pairs are theirs: removing one there does not touch ours.
    await db().query('DELETE FROM chemical_incompatibility WHERE tenant_id = $1', [t.tenantId]);
    expect((await db().query('SELECT count(*)::int AS n FROM chemical_incompatibility WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(2);
    // A part from another company is not a chemical here.
    await expect(admin((tx) => setChemicalPart(tx, w.admin, tc.acid.id, { isChemical: true }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('editions and features', () => {
  it('Lite does not include chemicals', async () => {
    const slug = `lite-chem-${Date.now() % 100000}`;
    const t = await provisionTenant(db(), { slug, name: 'Lite Co', legalEntity: 'Lite Co', facilities: [{ code: 'HQ', name: 'HQ', timezone: 'America/Chicago' }], edition: 'lite' });
    const u = await createUserWithToken(db(), t.tenantId, { email: `owner@${slug}.example`, displayName: 'owner', roles: [{ role: 'admin', facility: null }] });
    forgetEdition(t.tenantId);
    const r = await app.inject({ method: 'GET', url: '/api/chemicals/containers', headers: { authorization: `Bearer ${u.token}` } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error?.code ?? r.json().code).toBe('edition');
  });

  it('turning the feature off removes the screens and reports, not the stock', async () => {
    await admin((tx) => setFeature(tx, w.admin, 'chemicals', { mode: 'off', roleKeys: [] }));
    expect((await call('admin', 'GET', '/api/chemicals/containers')).statusCode).toBe(403);
    expect((await call('admin', 'GET', '/api/reports/hazardous-inventory')).statusCode).toBe(403);
    const me = (await call('admin', 'GET', '/api/me')).json();
    expect(me.hiddenNav).toContain('/chemicals');
    await admin((tx) => setFeature(tx, w.admin, 'chemicals', { mode: 'all', roleKeys: [] }));
    expect((await call('admin', 'GET', '/api/chemicals/containers')).statusCode).toBe(200);
  });

  it('the starter reminders and reports are in the catalogue', async () => {
    const cat = (await call('admin', 'GET', '/api/reports')).json();
    const ids = (Array.isArray(cat) ? cat : cat.reports).map((x: any) => x.id);
    for (const id of ['hazardous-inventory', 'chemical-expiry', 'chemical-exceptions']) expect(ids).toContain(id);
    const rem = (await call('admin', 'GET', '/api/reminder-settings')).json();
    const keys = rem.reminders.map((x: any) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['chemical_expiring', 'chemical_exceptions']));
    expect(rem.reminders.find((x: any) => x.key === 'chemical_expiring')).toMatchObject({ leadDays: 14, enabled: true });
  });
});

describe('receiving through the API', () => {
  it('a receipt of a chemical returns its containers; an ordinary part is unchanged', async () => {
    const l = (await admin((tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-API', name: 'API store' }))).id;
    const r = await call('admin', 'POST', '/api/inventory/receipts', { locationId: l, partId: c.base.id, qty: 4, lots: [{ lot: 'NAOH-API', qty: 4, expiresOn: daysFrom(200) }], containerSize: 2 });
    expect(r.statusCode).toBe(201);
    expect(r.json().containers).toHaveLength(2);
    const plain = await call('admin', 'POST', '/api/inventory/receipts', { locationId: l, partId: c.plain.id, qty: 4 });
    expect(plain.statusCode).toBe(201);
    expect(plain.json().containers).toBeUndefined();
    const refused = await call('admin', 'POST', '/api/inventory/receipts', { locationId: l, partId: c.acid.id, qty: 1, lots: [{ lot: 'HCL-API', qty: 1 }] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.message ?? refused.json().message).toMatch(/ACID.*BASE|BASE.*ACID/);
  });
});
