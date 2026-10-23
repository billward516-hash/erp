import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { setTracking } from '../src/modules/inventory/lot-service.js';
import { createPart } from '../src/modules/parts/service.js';
import { closeOrder, completeShort, createOrder, createRevision, getOrder, issueMaterials, releaseOrder, releaseRevision, returnMaterial, saveRevision, saveWorkCenter } from '../src/modules/production/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Returning unused material to stock, and the close check for material left on the order (D-183C). */
const db = () => getAdminPool();
let app: FastifyInstance; let w: World; let sup: Actor; let op: Actor; let supTok = ''; let opTok = '';
let bar: string; let resin: string; let store: string; let other: string; let fg: string; let wc: string; let hsg: string;

beforeAll(async () => {
  app = buildApp(); w = await makeWorld('prodret');
  const mk = async (email: string, role: string) => { const u = await createUserWithToken(db(), w.tenantId, { email, displayName: email, roles: [{ role, facility: w.facilities.A! }] }); return { actor: (await loadActor(w.tenantId, u.userId))!, token: u.token }; };
  ({ actor: sup, token: supTok } = await mk('retsup@p.example', 'production_supervisor'));
  ({ actor: op, token: opTok } = await mk('retop@p.example', 'operator'));
  await asActor(w.admin, async (tx) => {
    bar = (await createPart(tx, w.admin, { partNumber: 'R-BAR', description: 'Bar', uom: 'IN' })).id;
    resin = (await createPart(tx, w.admin, { partNumber: 'R-RESIN', description: 'Resin', uom: 'KG' })).id;
    hsg = (await createPart(tx, w.admin, { partNumber: 'R-HSG', description: 'Housing', uom: 'EA' })).id;
    store = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'R-RM', name: 'Raw' })).id;
    other = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'R-RM2', name: 'Raw 2' })).id;
    fg = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'R-FG', name: 'FG' })).id;
    await setTracking(tx, w.admin, resin, { tracking: 'lot' });
    await receive(tx, w.admin, { locationId: store, partId: bar, qty: 100, unitCost: 1 });
    await receive(tx, w.admin, { locationId: store, partId: resin, qty: 30, unitCost: 2, lots: [{ lot: 'RES-1', qty: 10 }, { lot: 'RES-2', qty: 20 }] });
  });
  await asActor(sup, async (tx) => {
    wc = (await saveWorkCenter(tx, sup, { facilityId: w.facilities.A!, code: 'RWC', name: 'Cell' })).id;
    const r = await createRevision(tx, sup, { partId: hsg });
    await saveRevision(tx, sup, r.id, { materials: [{ partId: bar, qtyPer: 2 }, { partId: resin, qtyPer: 1 }], operations: [{ opNo: 10, workCenterId: wc, description: 'Make' }] });
    await releaseRevision(tx, sup, r.id);
  });
});
afterAll(async () => { await app.close(); await closePools(); });

const auth = (t: string, key?: string) => ({ authorization: `Bearer ${t}`, ...(key ? { 'idempotency-key': key } : {}) });
const load = (id: string) => asActor(sup, (tx) => getOrder(tx, sup, id));
const lotQty = async (lot: string, loc: string) => Number((await db().query(`SELECT coalesce(sum(lb.qty), 0)::float AS q FROM lot_balance lb JOIN stock_lot l ON l.id = lb.lot_id WHERE l.number = $1 AND lb.location_id = $2`, [lot, loc])).rows[0].q);

describe('return unused material', () => {
  let mo: any; let barLine: any; let resinLine: any;
  it('shows issued, returned and what is left over per line', async () => {
    mo = await asActor(sup, (tx) => createOrder(tx, sup, { facilityId: w.facilities.A!, partId: hsg, qty: 10, outputLocationId: fg }));
    await asActor(sup, (tx) => releaseOrder(tx, sup, mo.id));
    let o = await load(mo.id);
    barLine = o.materials.find((m: any) => m.part_number === 'R-BAR'); resinLine = o.materials.find((m: any) => m.part_number === 'R-RESIN');
    await asActor(op, (tx) => issueMaterials(tx, op, mo.id, [{ materialId: barLine.id, locationId: store, qty: 30 }, { materialId: resinLine.id, locationId: store, qty: 12 }]));
    // Nothing has been made, so everything issued is still "left over".
    o = await load(mo.id);
    expect(o.materials.map((m: any) => [m.part_number, m.qty_issued_gross, m.qty_returned, m.qty_issued])).toEqual([['R-BAR', 30, 0, 30], ['R-RESIN', 12, 0, 12]]);
    expect(o.unreturned.map((l: any) => l.partNumber)).toEqual(['R-BAR', 'R-RESIN']);
  });

  it('returns a plain part to any storeroom of the site, with a reason, and keeps the books straight', async () => {
    await expect(asActor(op, (tx) => returnMaterial(tx, op, mo.id, { materialId: barLine.id, locationId: other, qty: 31 }))).rejects.toThrow(/return between 0 and the 30 issued/);
    await asActor(op, (tx) => returnMaterial(tx, op, mo.id, { materialId: barLine.id, locationId: other, qty: 10, reason: 'Cut longer than needed' }));
    const o = await load(mo.id);
    const b = o.materials.find((m: any) => m.part_number === 'R-BAR');
    expect([b.qty_issued_gross, b.qty_returned, b.qty_issued]).toEqual([30, 10, 20]);
    const bal = await db().query(`SELECT qty_on_hand::float AS q FROM inventory_balance WHERE location_id = $1 AND part_id = $2`, [other, bar]);
    expect(bal.rows[0].q).toBe(10);
    const row = await db().query(`SELECT reason FROM inventory_txn WHERE production_order_id = $1 AND txn_type = 'production_return'`, [mo.id]);
    expect(row.rows[0].reason).toBe('Cut longer than needed');
  });

  it('a lot-tracked part goes back as the lot last issued, or as the lot named', async () => {
    // 12 kg went out of RES-1 and RES-2; with no lot named, the return goes back into a lot that was issued.
    await asActor(op, (tx) => returnMaterial(tx, op, mo.id, { materialId: resinLine.id, locationId: store, qty: 1 }));
    expect((await lotQty('RES-1', store)) + (await lotQty('RES-2', store))).toBe(19); // one of the lots issued from here, whichever the rule picks
    await asActor(op, (tx) => returnMaterial(tx, op, mo.id, { materialId: resinLine.id, locationId: other, qty: 2, lots: [{ lot: 'RES-1', qty: 2 }] }));
    expect(await lotQty('RES-1', other)).toBe(2);
    await expect(asActor(op, (tx) => returnMaterial(tx, op, mo.id, { materialId: resinLine.id, locationId: other, qty: 1, lots: [{ lot: 'RES-1', qty: 2 }] }))).rejects.toThrow(/add up to 2, not 1/);
  });

  it('is checked for permission: the API refuses a viewer and replays an idempotent return once', async () => {
    const viewer = await createUserWithToken(db(), w.tenantId, { email: 'retview@p.example', displayName: 'V', roles: [{ role: 'executive', facility: w.facilities.A! }] });
    const denied = await app.inject({ method: 'POST', url: `/api/production-orders/${mo.id}/return`, headers: auth(viewer.token), payload: { materialId: barLine.id, locationId: store, qty: 1 } });
    expect(denied.statusCode).toBe(403);
    const body = { materialId: barLine.id, locationId: store, qty: 1, reason: 'Short cut' };
    const first = await app.inject({ method: 'POST', url: `/api/production-orders/${mo.id}/return`, headers: auth(opTok, 'return-key-0001'), payload: body });
    const again = await app.inject({ method: 'POST', url: `/api/production-orders/${mo.id}/return`, headers: auth(opTok, 'return-key-0001'), payload: body });
    expect([first.statusCode, again.statusCode, again.headers['idempotent-replay']]).toEqual([204, 204, 'true']);
    const b = (await load(mo.id)).materials.find((m: any) => m.part_number === 'R-BAR');
    expect(b.qty_returned).toBe(11);
  });
});

describe('closing with material left on the order', () => {
  let mo: any;
  it('is refused with the list until the material is returned, or a reason is given', async () => {
    mo = await asActor(sup, (tx) => createOrder(tx, sup, { facilityId: w.facilities.A!, partId: hsg, qty: 5, outputLocationId: fg }));
    await asActor(sup, (tx) => releaseOrder(tx, sup, mo.id));
    const o = await load(mo.id);
    const barLine = o.materials.find((m: any) => m.part_number === 'R-BAR'); const resinLine = o.materials.find((m: any) => m.part_number === 'R-RESIN');
    await asActor(sup, (tx) => issueMaterials(tx, sup, mo.id, [{ materialId: barLine.id, locationId: store, qty: 10 }, { materialId: resinLine.id, locationId: store, qty: 5 }]));
    await asActor(sup, (tx) => completeShort(tx, sup, mo.id, 'Customer cancelled the rest'));
    const res = await app.inject({ method: 'POST', url: `/api/production-orders/${mo.id}/close`, headers: auth(supTok), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/R-BAR 10 IN, R-RESIN 5 KG/);
    expect(res.json().error.details.unreturned).toHaveLength(2);
    await asActor(sup, (tx) => returnMaterial(tx, sup, mo.id, { materialId: barLine.id, locationId: store, qty: 10 }));
    // Resin is still out: a short reason is not enough, the reason must say something.
    await expect(asActor(sup, (tx) => closeOrder(tx, sup, mo.id, { unreturnedReason: 'x' }))).rejects.toThrow(/still issued/);
    await expect(asActor(sup, (tx) => closeOrder(tx, sup, mo.id))).rejects.toThrow(/R-RESIN 5 KG/);
    const ok = await app.inject({ method: 'POST', url: `/api/production-orders/${mo.id}/close`, headers: auth(supTok), payload: { unreturnedReason: 'Resin is in the open drum on the line' } });
    expect(ok.statusCode).toBe(204);
    const closed = await db().query(`SELECT data FROM audit_event WHERE entity_id = $1 AND action = 'production_order.closed'`, [mo.id]);
    expect(closed.rows[0].data.unreturnedReason).toBe('Resin is in the open drum on the line');
    expect(closed.rows[0].data.unreturned).toHaveLength(1);
    await expect(asActor(sup, (tx) => returnMaterial(tx, sup, mo.id, { materialId: resinLine.id, locationId: store, qty: 1 }))).rejects.toThrow(/order is closed/);
  });

  it('closes cleanly when everything issued is accounted for', async () => {
    const o2 = await asActor(sup, (tx) => createOrder(tx, sup, { facilityId: w.facilities.A!, partId: hsg, qty: 2, outputLocationId: fg }));
    await asActor(sup, (tx) => releaseOrder(tx, sup, o2.id));
    const lines = (await load(o2.id)).materials;
    await asActor(sup, (tx) => issueMaterials(tx, sup, o2.id, [{ materialId: lines[0].id, locationId: store, qty: 4 }]));
    await asActor(sup, (tx) => returnMaterial(tx, sup, o2.id, { materialId: lines[0].id, locationId: store, qty: 4 }));
    await asActor(sup, (tx) => completeShort(tx, sup, o2.id, 'Cancelled before start'));
    expect((await load(o2.id)).unreturned).toEqual([]);
    await asActor(sup, (tx) => closeOrder(tx, sup, o2.id));
    expect((await db().query('SELECT status FROM production_order WHERE id = $1', [o2.id])).rows[0].status).toBe('closed');
  });
});
