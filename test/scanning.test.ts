import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createPart } from '../src/modules/parts/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Barcode identity, labels, scan-driven issue and blind cycle counts (SC-006 A). */
let app: FastifyInstance; let w: World; let part: string; let part2: string; let loc: string; let loc2: string;
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('scan');
  await asActor(w.admin, async (tx) => {
    part = (await createPart(tx, w.admin, { partNumber: 'BRG-6204', description: 'Bearing 6204', uom: 'EA' })).id;
    part2 = (await createPart(tx, w.admin, { partNumber: 'SEAL-22', description: 'Shaft seal', uom: 'EA' })).id;
    loc = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'MAIN', name: 'Main storeroom' })).id;
    loc2 = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'CRIB', name: 'Tool crib' })).id;
    await receive(tx, w.admin, { locationId: loc, partId: part, qty: 40, unitCost: 8 });
    await receive(tx, w.admin, { locationId: loc, partId: part2, qty: 10, unitCost: 3 });
    await createSupplier(tx, w.admin, { code: 'S1', name: 'Atlas', paymentTerms: 'Net 30' });
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
const resolve = (code: string, token = w.tokens.admin) => call(token, 'GET', `/api/scan/resolve?code=${encodeURIComponent(code)}`);

describe('scan resolution', () => {
  it('knows our part numbers, mapped supplier codes, locations and prefixed labels, and refuses the rest', async () => {
    expect((await call(w.tokens.admin, 'POST', `/api/parts/${part}/barcodes`, { code: '012345678905', kind: 'upc', qtyPerScan: 1 })).statusCode).toBe(201);
    expect((await call(w.tokens.admin, 'POST', `/api/parts/${part}/barcodes`, { code: 'CARTON-6204-10', kind: 'carton', qtyPerScan: 10 })).statusCode).toBe(201);
    expect((await call(w.tokens.admin, 'POST', `/api/parts/${part2}/barcodes`, { code: '012345678905' })).statusCode).toBe(409); // already on the bearing
    expect((await call(w.tokens.admin, 'POST', `/api/parts/${part2}/barcodes`, { code: 'L:HACK' })).statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'POST', `/api/parts/${part2}/barcodes`, { code: 'main' })).statusCode).toBe(409); // a location code
    const byNumber = (await resolve('brg-6204')).json();
    expect(byNumber).toMatchObject({ kind: 'part', partNumber: 'BRG-6204', via: 'part_number', qtyPerScan: 1 });
    expect(byNumber.onHand[0]).toMatchObject({ location: 'MAIN', qty: 40 });
    expect((await resolve('CARTON-6204-10')).json()).toMatchObject({ kind: 'part', via: 'barcode', qtyPerScan: 10, partNumber: 'BRG-6204' });
    expect((await resolve('L:main')).json()).toMatchObject({ kind: 'location', code: 'MAIN' });
    expect((await resolve('CRIB')).json()).toMatchObject({ kind: 'location', code: 'CRIB' });
    const unknown = await resolve('999-NOT-A-THING');
    expect(unknown.statusCode).toBe(404); expect(unknown.json().error.code).toBe('unknown_code');
  });
  it('is invisible across companies', async () => {
    const other = await makeWorld('scan2');
    expect((await resolve('BRG-6204', other.tokens.admin)).statusCode).toBe(404);
  });
});

describe('labels', () => {
  it('prints a label sheet with a barcode for parts, locations and lots', async () => {
    for (const [kind, ids] of [['part', [part, part2]], ['location', [loc, loc2]]] as const) {
      const r = await call(w.tokens.admin, 'POST', '/api/labels/pdf', { kind, ids });
      expect(r.statusCode, r.body).toBe(200); expect(r.rawPayload.slice(0, 4).toString()).toBe('%PDF');
    }
    expect((await call(w.tokens.admin, 'POST', '/api/labels/pdf', { kind: 'part', ids: ['00000000-0000-4000-8000-000000000000'] })).statusCode).toBe(404);
  });
});

describe('issue by scan', () => {
  it('issues to a reference through the ledger, refuses an empty reference and more than is on hand', async () => {
    expect((await call(w.tokens.admin, 'POST', '/api/inventory/issues', { locationId: loc, partId: part, qty: 5, reference: '' })).statusCode).toBe(422);
    const ok = await call(w.tokens.admin, 'POST', '/api/inventory/issues', { locationId: loc, partId: part, qty: 5, reference: 'JOB-1042' });
    expect(ok.statusCode, ok.body).toBe(201); expect(ok.json().balanceAfter).toBe(35);
    expect((await call(w.tokens.admin, 'POST', '/api/inventory/issues', { locationId: loc, partId: part, qty: 99, reference: 'JOB-1042' })).statusCode).toBe(422);
    const led = (await call(w.tokens.admin, 'GET', `/api/inventory/ledger?partId=${part}`)).json();
    expect(led.find((r: any) => r.txn_type === 'issue')).toMatchObject({ reference: 'JOB-1042' });
  });
});

describe('cycle counts', () => {
  it('lists what is due by frequency, opens a blind count for it and stamps the date when posted', async () => {
    expect((await call(w.tokens.admin, 'GET', '/api/inventory/counts-due')).json()).toEqual([]);
    await call(w.tokens.admin, 'PUT', '/api/inventory/settings', { locationId: loc, partId: part, cycleCountDays: 30 });
    await call(w.tokens.admin, 'PUT', '/api/inventory/settings', { locationId: loc, partId: part2, cycleCountDays: 90 });
    const due = (await call(w.tokens.admin, 'GET', '/api/inventory/counts-due')).json();
    expect(due).toHaveLength(1); expect(due[0].parts.map((p: any) => p.partNumber).sort()).toEqual(['BRG-6204', 'SEAL-22']);
    const opened = await call(w.tokens.admin, 'POST', `/api/inventory/counts-due/${loc}/open`, {});
    expect(opened.statusCode, opened.body).toBe(201); expect(opened.json().blind).toBe(true);
    const sheet = (await call(w.tokens.admin, 'GET', `/api/inventory/counts/${opened.json().id}`)).json();
    expect(sheet.lines.every((l: any) => l.expected_qty === null)).toBe(true); // blind: the book figure is hidden
    const rec = await call(w.tokens.admin, 'POST', `/api/inventory/counts/${opened.json().id}/lines`, { lines: [{ partId: part, countedQty: 34 }, { partId: part2, countedQty: 10 }] });
    expect(rec.statusCode, rec.body).toBeLessThan(300);
    const posted = await call(w.tokens.admin, 'POST', `/api/inventory/counts/${opened.json().id}/post`, {});
    expect(posted.json().variances).toEqual([expect.objectContaining({ partNumber: 'BRG-6204', expected: 35, counted: 34, delta: -1 })]);
    expect((await call(w.tokens.admin, 'GET', '/api/inventory/counts-due')).json()).toEqual([]); // counted just now, so nothing is due
    const stamp = await getAdminPool().query('SELECT count(*)::int AS n FROM inventory_balance WHERE tenant_id = $1 AND last_counted_at IS NOT NULL', [w.tenantId]);
    expect(stamp.rows[0].n).toBe(2);
    await getAdminPool().query(`UPDATE inventory_balance SET last_counted_at = now() - interval '45 days' WHERE tenant_id = $1 AND part_id = $2`, [w.tenantId, part]);
    expect((await call(w.tokens.admin, 'GET', '/api/inventory/counts-due')).json()[0].parts.map((p: any) => p.partNumber)).toEqual(['BRG-6204']); // 30-day part is due again, 90-day part is not
  });
});
