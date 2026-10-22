import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { propertyLicence, saveSite } from '../src/modules/sites/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
const site = (code: string, kind: 'property' | 'plant' = 'property', extra: { id?: string; active?: boolean } = {}) =>
  asActor(w.admin, (tx) => saveSite(tx, w.admin, { code, name: code, kind, ...extra }));

beforeAll(async () => {
  w = await makeWorld('lic');
  // A small band so the test can fill it: the default is one band of 100.
  expect((await db().query('SELECT property_bands, property_band_size FROM tenant_license WHERE tenant_id = $1', [w.tenantId])).rows[0]).toEqual({ property_bands: 1, property_band_size: 100 });
  await db().query('UPDATE tenant_license SET property_band_size = 2 WHERE tenant_id = $1', [w.tenantId]);
});
afterAll(closePools);

describe('property licence (bands of properties)', () => {
  it('counts active properties only, refuses one past the band, and frees a place when a property is deactivated', async () => {
    const p1 = await site('P1'); await site('P2');
    await site('PLANT-2', 'plant'); // other kinds are not counted
    expect(await asActor(w.admin, (tx) => propertyLicence(tx))).toEqual({ used: 2, bands: 1, bandSize: 2, licensed: 2 });
    await expect(site('P3')).rejects.toThrow(/your licence covers 2 properties and 2 are active; add a band of 2/);
    await expect(site('PLANT-2B', 'plant')).resolves.toBeTruthy();
    await site('P1', 'property', { id: p1.id, active: false });
    const p3 = await site('P3');
    await expect(site('P1', 'property', { id: p1.id, active: true })).rejects.toThrow(/licence covers 2/);
    // Turning a plant into a property takes a place too.
    const plant = (await db().query(`SELECT id FROM facility WHERE tenant_id = $1 AND code = 'PLANT-2'`, [w.tenantId])).rows[0];
    await expect(site('PLANT-2', 'property', { id: plant.id })).rejects.toThrow(/licence covers 2/);
    // Editing a property already counted is not blocked.
    await expect(site('P3', 'property', { id: p3.id })).resolves.toBeTruthy();
  });

  it('the database enforces it on every path, and tenants cannot change their own licence', async () => {
    const le = (await db().query('SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1', [w.tenantId])).rows[0].id;
    await expect(db().query(`INSERT INTO facility (tenant_id, legal_entity_id, code, name, kind) VALUES ($1, $2, 'P9', 'P9', 'property')`, [w.tenantId, le])).rejects.toThrow(/property licence: 2 of 2/);
    await expect(asActor(w.admin, (tx) => tx.query('UPDATE tenant_license SET property_bands = 9'))).rejects.toThrow(/permission denied/);
    // A second band (control plane) makes room.
    await db().query('UPDATE tenant_license SET property_bands = 2 WHERE tenant_id = $1', [w.tenantId]);
    await expect(site('P4')).resolves.toBeTruthy();
    expect((await asActor(w.admin, (tx) => propertyLicence(tx))).licensed).toBe(4);
  });
});
