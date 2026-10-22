import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { one } from '../src/platform/db/tx.js';
import { createLocation, postTxn, receive, transfer } from '../src/modules/inventory/service.js';
import { getLot, listLots, setLotHold, setTracking, traceForward } from '../src/modules/inventory/lot-service.js';
import { createPart } from '../src/modules/parts/service.js';
import { shipOrder } from '../src/modules/sales/service.js';
import { addPart, createWorkOrder, returnPart } from '../src/modules/maintenance/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { setPartUnit } from '../src/modules/parts/service.js';
import { createOrdersFromRequest, createPurchaseRequest, createSupplier, receiveOrder, submitPurchaseRequest } from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Lot and serial tracking (D-147) on the stock ledger. */
const db = () => getAdminPool();
let w: World; let store: string; let line: string;
let resin: any; let bracket: any; let pump: any; let plain: any;
const daysFrom = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** Lots of a part with stock at one storeroom, and how much. */
const lotQty = async (part: string, loc: string) => Object.fromEntries((await asActor(w.admin, (tx) => listLots(tx, w.admin, { partId: part })))
  .map((l) => [l.number, l.locations.find((x: any) => x.location_id === loc)?.qty ?? 0]).filter(([, q]) => q > 0));
const as = <T>(fn: (tx: any) => Promise<T>) => asActor(w.admin, fn);

beforeAll(async () => {
  w = await makeWorld('lots');
  ({ store, line } = await as(async (tx) => ({
    store: (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-STORE', name: 'Storeroom' })).id,
    line: (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-LINE', name: 'Line side' })).id,
  })));
  ({ resin, bracket, pump, plain } = await as(async (tx) => ({
    resin: await createPart(tx, w.admin, { partNumber: 'RES-A', description: 'Epoxy resin A', uom: 'KG', unitCost: 12 }),
    bracket: await createPart(tx, w.admin, { partNumber: 'BRK-1', description: 'Bonded bracket', unitCost: 30 }),
    pump: await createPart(tx, w.admin, { partNumber: 'PMP-7', description: 'Dosing pump', unitCost: 900 }),
    plain: await createPart(tx, w.admin, { partNumber: 'RAG-1', description: 'Rags' }),
  })));
});
afterAll(closePools);

describe('switching tracking on', () => {
  it('existing stock must be counted into lots exactly; untracked parts are unaffected', async () => {
    await as((tx) => receive(tx, w.admin, { locationId: store, partId: resin.id, qty: 30, unitCost: 12 }));
    await expect(as((tx) => setTracking(tx, w.admin, resin.id, { tracking: 'lot', shelfLifeDays: 180, existing: [{ locationId: store, lot: 'OLD-1', qty: 20 }] })))
      .rejects.toThrow(/A-STORE holds 30 KG; count it into lots \(20 given\)/);
    await as((tx) => setTracking(tx, w.admin, resin.id, { tracking: 'lot', shelfLifeDays: 180, existing: [{ locationId: store, lot: 'OLD-1', qty: 30, expiresOn: daysFrom(5) }] }));
    await as((tx) => setTracking(tx, w.admin, bracket.id, { tracking: 'lot' }));
    await as((tx) => setTracking(tx, w.admin, pump.id, { tracking: 'serial' }));
    await expect(as((tx) => setTracking(tx, w.admin, resin.id, { tracking: 'none' }))).rejects.toThrow(/tracking goes off only at zero stock/);
    await as((tx) => receive(tx, w.admin, { locationId: store, partId: plain.id, qty: 5 }));
    expect(await lotQty(resin.id, store)).toEqual({ 'OLD-1': 30 });
  });
});

describe('movements carry their lots', () => {
  it('a receipt names its lot (expiry from shelf life), serials are one each and unique in stock', async () => {
    await expect(as((tx) => receive(tx, w.admin, { locationId: store, partId: resin.id, qty: 50, unitCost: 11 }))).rejects.toThrow(/RES-A is tracked by lot: say which lot these are/);
    await as((tx) => receive(tx, w.admin, { locationId: store, partId: resin.id, qty: 50, unitCost: 11, lots: [{ lot: 'R-2210', qty: 50, supplierLot: 'HX-99812' }] }));
    const r = (await as((tx) => listLots(tx, w.admin, { partId: resin.id }))).find((l) => l.number === 'R-2210')!;
    expect(String(r.expires_on).slice(0, 10)).toBe(daysFrom(180));
    expect(r.supplier_lot).toBe('HX-99812');
    await expect(as((tx) => receive(tx, w.admin, { locationId: store, partId: pump.id, qty: 2, lots: [{ lot: 'SN-1', qty: 2 }] }))).rejects.toThrow(/each serial number is one unit/);
    await as((tx) => receive(tx, w.admin, { locationId: store, partId: pump.id, qty: 2, lots: [{ lot: 'SN-1', qty: 1 }, { lot: 'SN-2', qty: 1 }] }));
    await expect(as((tx) => receive(tx, w.admin, { locationId: store, partId: pump.id, qty: 1, lots: [{ lot: 'SN-2', qty: 1 }] }))).rejects.toThrow(/serial number SN-2 of PMP-7 is already in stock/);
  });

  it('issues take the first-expiring lot unless one is named; returns go back to the lots issued', async () => {
    const asset = await as((tx) => createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'MIX-1', name: 'Mixer' }));
    const wo = await as((tx) => createWorkOrder(tx, w.admin, { assetId: asset.id, title: 'Reline mixer', woType: 'corrective', priority: 3 }));
    const used = await as((tx) => addPart(tx, w.admin, wo.id, { partId: resin.id, qtyUsed: 35, locationId: store }));
    expect(await lotQty(resin.id, store)).toEqual({ 'R-2210': 45 }); // OLD-1 expires first: all 30, then 5 of R-2210
    await as((tx) => returnPart(tx, w.admin, used.id, 8));
    expect(await lotQty(resin.id, store)).toEqual({ 'OLD-1': 3, 'R-2210': 50 }); // back to the lots issued, last first: 5 to R-2210, then 3 to OLD-1
    const named = await as((tx) => addPart(tx, w.admin, wo.id, { partId: resin.id, qtyUsed: 3, locationId: store, lots: [{ lot: 'OLD-1', qty: 3 }] }));
    expect(named).toBeTruthy();
    expect(await lotQty(resin.id, store)).toEqual({ 'R-2210': 50 });
  });

  it('held and expired lots are never issued or shipped, but can be moved', async () => {
    await as((tx) => receive(tx, w.admin, { locationId: store, partId: resin.id, qty: 10, lots: [{ lot: 'R-OLD', qty: 10, expiresOn: daysFrom(-3) }] }));
    const r2210 = (await as((tx) => listLots(tx, w.admin, { partId: resin.id }))).find((l) => l.number === 'R-2210')!;
    await as((tx) => setLotHold(tx, w.admin, r2210.id, { hold: true, reason: 'Viscosity out of spec' }));
    await expect(as((tx) => postTxn(tx, w.admin, { locationId: store, partId: resin.id, type: 'issue', qty: -1 })))
      .rejects.toThrow(/only 0 of RES-A at A-STORE can be used; R-OLD is expired on \S+, R-2210 is on hold \(Viscosity out of spec\)/);
    await expect(as((tx) => postTxn(tx, w.admin, { locationId: store, partId: resin.id, type: 'issue', qty: -1, lots: [{ lot: 'R-OLD', qty: 1 }] }))).rejects.toThrow(/R-OLD of RES-A is expired on/);
    // Moving held stock to the line (or a quarantine shelf) is allowed, and the same lot arrives.
    await as((tx) => transfer(tx, w.admin, { fromLocationId: store, toLocationId: line, partId: resin.id, qty: 4, lots: [{ lot: 'R-2210', qty: 4 }] }));
    expect(await lotQty(resin.id, line)).toEqual({ 'R-2210': 4 });
    await as((tx) => setLotHold(tx, w.admin, r2210.id, { hold: false }));
  });
});

describe('receiving on a purchase order', () => {
  it('names the supplier lot per line, in order units; the lot remembers the supplier', async () => {
    const gloves = await as((tx) => createPart(tx, w.admin, { partNumber: 'GLV-L', description: 'Gloves', unitCost: 0.3 }));
    await as((tx) => setPartUnit(tx, w.admin, gloves.id, { uom: 'BX', perUnit: 100 }));
    await as((tx) => setTracking(tx, w.admin, gloves.id, { tracking: 'lot', shelfLifeDays: 730 }));
    const sup = await asActor(w.buyer, (tx) => createSupplier(tx, w.buyer, { code: 'GRN', name: 'Grainger' }));
    const pr = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Gloves', lines: [{ partId: gloves.id, qty: 3, uom: 'BX', locationId: store, supplierId: sup.id, estUnitPrice: 30 }] }));
    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, pr.id));
    const step = (await asActor(w.managerA, (tx) => myApprovalQueue(tx, w.managerA))).find((x) => x.subject_id === pr.id)!;
    await asActor(w.managerA, (tx) => decideApproval(tx, w.managerA, step.step_id, { decision: 'approve' }));
    const { orders } = await asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, pr.id));
    const ol = (await db().query('SELECT id FROM purchase_order_line WHERE order_id = $1', [orders[0]!.id])).rows[0];
    await expect(asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, orders[0]!.id, { lines: [{ orderLineId: ol.id, qty: 3 }] }))).rejects.toThrow(/GLV-L is tracked by lot/);
    await asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, orders[0]!.id, { lines: [{ orderLineId: ol.id, qty: 3, lots: [{ lot: 'G-77', qty: 2 }, { lot: 'G-78', qty: 1 }] }] }));
    const lots = await as((tx) => listLots(tx, w.admin, { partId: gloves.id }));
    expect(lots.map((l) => [l.number, l.on_hand, l.supplier])).toEqual([['G-77', 200, 'Grainger'], ['G-78', 100, 'Grainger']]);
  });
});

describe('tracing', () => {
  let order: any; let so: any; let soLine: any;
  it('a production lot knows what it was made from; a component lot knows what it went into and which customers got it', async () => {
    // A minimal production order (the production flow itself is tested elsewhere).
    const rev = (await db().query(`INSERT INTO product_revision (tenant_id, part_id, revision, status, created_by) VALUES ($1, $2, 1, 'released', $3) RETURNING id`, [w.tenantId, bracket.id, w.admin.userId])).rows[0];
    order = (await db().query(`INSERT INTO production_order (tenant_id, facility_id, number, part_id, revision_id, qty, status, created_by) VALUES ($1, $2, 'MO-LOT1', $3, $4, 20, 'released', $5) RETURNING id`,
      [w.tenantId, w.facilities.A, bracket.id, rev.id, w.admin.userId])).rows[0];
    await as((tx) => postTxn(tx, w.admin, { locationId: store, partId: resin.id, type: 'production_issue', qty: -6, productionOrderId: order.id, reference: 'MO-LOT1' }));
    await as((tx) => postTxn(tx, w.admin, { locationId: store, partId: resin.id, type: 'production_return', qty: 1, productionOrderId: order.id, reference: 'MO-LOT1' }));
    await as((tx) => postTxn(tx, w.admin, { locationId: store, partId: bracket.id, type: 'production_receipt', qty: 20, productionOrderId: order.id, reference: 'MO-LOT1' }));
    const made = (await as((tx) => listLots(tx, w.admin, { partId: bracket.id })))[0]!;
    expect(made).toMatchObject({ number: 'MO-LOT1', production_order: 'MO-LOT1', on_hand: 20 }); // named after the order
    const lot = await as((tx) => getLot(tx, w.admin, made.id));
    expect(lot.madeFrom.map((m: any) => [m.part_number, m.number, m.qty])).toEqual([['RES-A', 'R-2210', 5]]);

    // Ship 12 brackets to a customer.
    const cust = (await db().query(`INSERT INTO customer (tenant_id, code, name, kind) VALUES ($1, 'ACME', 'Acme', 'customer') RETURNING id`, [w.tenantId])).rows[0];
    const item = (await db().query(`INSERT INTO sales_item (tenant_id, code, description, part_id) VALUES ($1, 'BRK-1', 'Bracket', $2) RETURNING id`, [w.tenantId, bracket.id])).rows[0];
    so = (await db().query(`INSERT INTO sales_order (tenant_id, facility_id, number, customer_id, created_by) VALUES ($1, $2, 'SO-LOT1', $3, $4) RETURNING id`, [w.tenantId, w.facilities.A, cust.id, w.admin.userId])).rows[0];
    soLine = (await db().query(`INSERT INTO sales_order_line (tenant_id, order_id, line_no, item_id, description, qty, unit_price) VALUES ($1, $2, 1, $3, 'Bracket', 12, 55) RETURNING id`, [w.tenantId, so.id, item.id])).rows[0];
    await asActor(w.admin, (tx) => shipOrder(tx, w.admin, so.id, { lines: [{ orderLineId: soLine.id, qty: 12, locationId: store }] }));

    const r2210 = (await as((tx) => listLots(tx, w.admin, { partId: resin.id }))).find((l) => l.number === 'R-2210')!;
    const fwd = await as((tx) => getLot(tx, w.admin, r2210.id));
    expect(fwd.wentInto.map((x: any) => [x.number, x.qty, x.made_lots.map((m: any) => m.number)])).toEqual([['MO-LOT1', 5, ['MO-LOT1']]]);
    const recall = await as((tx) => traceForward(tx, w.admin, r2210.id));
    expect(recall.customers).toEqual([expect.objectContaining({ customer: 'Acme', shipments: [expect.objectContaining({ lot: 'MO-LOT1', part_number: 'BRK-1', qty: 12, order_number: 'SO-LOT1' })] })]);
    expect(fwd.usedOn).toEqual([]); // what R-2210 gave the mixer job came back
    const old1 = (await as((tx) => listLots(tx, w.admin, { partId: resin.id }))).find((l) => l.number === 'OLD-1')!;
    expect((await as((tx) => getLot(tx, w.admin, old1.id))).usedOn.map((u: any) => [u.asset_tag, u.qty])).toEqual([['MIX-1', 30]]);
  });

  it('per-lot stock always adds up to the storeroom balance', async () => {
    const r = await db().query(`SELECT b.location_id, b.part_id, b.qty_on_hand::float AS q, coalesce((SELECT sum(lb.qty) FROM lot_balance lb JOIN stock_lot l ON l.id = lb.lot_id
      WHERE lb.location_id = b.location_id AND l.part_id = b.part_id), 0)::float AS lots FROM inventory_balance b JOIN part p ON p.id = b.part_id WHERE p.tracking <> 'none' AND b.tenant_id = $1`, [w.tenantId]);
    expect(r.rows.length).toBeGreaterThan(2);
    for (const x of r.rows) expect(x.lots).toBeCloseTo(x.q, 6);
  });
});
