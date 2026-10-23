import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools } from '../src/platform/db/pool.js';
import { one } from '../src/platform/db/tx.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createLocation } from '../src/modules/inventory/service.js';
import { factorBetween, normalizeUom } from '../src/modules/inventory/uom.js';
import { createPart, deletePartUnit, listPartUnits, setPartUnit } from '../src/modules/parts/service.js';
import {
  createOrdersFromRequest, createPurchaseRequest, createSupplier, getPurchaseRequest, incomingByPart, receiveOrder, setSupplierPrice, submitPurchaseRequest,
} from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

describe('unit conversions (pure)', () => {
  it('converts standard units of one kind, the part\'s own units, and standard units through them', () => {
    expect(factorBetween('GAL', 'L', new Map())).toBeCloseTo(3.785411784, 9);
    expect(factorBetween('ft', 'IN', new Map())).toBeCloseTo(12, 9);
    expect(factorBetween('BOX', 'EA', new Map([['BX', 10]]))).toBe(10);
    expect(factorBetween('DZ', 'EA', new Map())).toBe(12);
    expect(factorBetween('L', 'DR', new Map([['GAL', 1 / 55]]))).toBeCloseTo(1 / (55 * 3.785411784), 9); // a drum of 55 gallons, ordered by the litre
    expect(factorBetween('KG', 'EA', new Map())).toBeNull();
    expect(['each', 'Pcs', 'gallons', 'Case', ''].map(normalizeUom)).toEqual(['EA', 'EA', 'GAL', 'CS', 'EA']);
  });
});

let w: World; let store: string; let gloves: any; let oil: any; let supplier: any;
const csv = (s: string) => Buffer.from(s.replace(/\n/g, '\r\n'));
const onHand = async (part: string) => Number((await asActor(w.admin, (tx) => one(tx, 'SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [store, part])))?.qty_on_hand ?? 0);

beforeAll(async () => {
  w = await makeWorld('uom');
  store = (await asActor(w.admin, (tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-STORE', name: 'Storeroom' }))).id;
  ({ gloves, oil } = await asActor(w.admin, async (tx) => ({
    gloves: await createPart(tx, w.admin, { partNumber: 'GLV-9', description: 'Nitrile gloves, L', uom: 'each', unitCost: 0.4 }),
    oil: await createPart(tx, w.admin, { partNumber: 'OIL-46', description: 'Hydraulic oil ISO 46', uom: 'gal' }),
  })));
  supplier = await asActor(w.buyer, (tx) => createSupplier(tx, w.buyer, { code: 'GRN', name: 'Grainger' }));
});
afterAll(closePools);

describe('buying in one unit and stocking in another', () => {
  it('a part keeps its own units; fixed conversions are refused as own units', async () => {
    expect(gloves.uom).toBe('EA');
    await asActor(w.admin, (tx) => setPartUnit(tx, w.admin, gloves.id, { uom: 'box', perUnit: 100 }));
    await expect(asActor(w.admin, (tx) => setPartUnit(tx, w.admin, oil.id, { uom: 'L', perUnit: 0.26 }))).rejects.toThrow(/fixed factor already/);
    await asActor(w.admin, (tx) => setPartUnit(tx, w.admin, oil.id, { uom: 'DR', perUnit: 55 }));
    const units = await asActor(w.admin, (tx) => listPartUnits(tx, w.admin, oil.id));
    expect(units.own).toEqual([{ uom: 'DR', perUnit: 55, suppliers: [] }]);
    expect(units.standard.find((u) => u.uom === 'L')!.perUnit).toBeCloseTo(0.264172, 5);
  });

  it('a supplier price per box becomes the request price per box, and per each where asked in each', async () => {
    await expect(asActor(w.buyer, (tx) => setSupplierPrice(tx, w.buyer, supplier.id, gloves.id, { unitPrice: 30, uom: 'CS' }))).rejects.toThrow(/no conversion from CS/);
    await asActor(w.buyer, (tx) => setSupplierPrice(tx, w.buyer, supplier.id, gloves.id, { unitPrice: 32, uom: 'BOX', preferred: true }));
    await expect(asActor(w.admin, (tx) => deletePartUnit(tx, w.admin, gloves.id, 'BX'))).rejects.toThrow(/Grainger prices this part per BX/);
    const pr = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Gloves', lines: [
      { partId: gloves.id, qty: 3, uom: 'box', locationId: store }, { partId: gloves.id, qty: 50, locationId: store }] }));
    const view = await asActor(w.techA, (tx) => getPurchaseRequest(tx, w.techA, pr.id));
    expect(view.lines.map((l: any) => [l.qty, l.uom, l.est_unit_price])).toEqual([[3, 'BX', 32], [50, 'EA', 0.32]]);
    await expect(asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'x', lines: [{ partId: gloves.id, qty: 1, uom: 'KG' }] })))
      .rejects.toThrow(/GLV-9 is stocked in EA; it has no conversion from KG/);
    // Requested but not yet ordered counts in stock units: 300 + 50 each.
    expect((await asActor(w.admin, (tx) => incomingByPart(tx, w.facilities.A!, [gloves.id]))).get(gloves.id)).toEqual({ onOrder: 0, requested: 350 });

    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, pr.id));
    const step = (await asActor(w.managerA, (tx) => myApprovalQueue(tx, w.managerA))).find((s) => s.subject_id === pr.id)!;
    await asActor(w.managerA, (tx) => decideApproval(tx, w.managerA, step.step_id, { decision: 'approve' }));
    const { orders } = await asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, pr.id));
    const lines = (await asActor(w.admin, (tx) => tx.query('SELECT id, uom, stock_per_unit::float AS per, qty_ordered::float AS qty FROM purchase_order_line WHERE order_id = $1 ORDER BY line_no', [orders[0]!.id]))).rows;
    expect(lines.map((l) => [l.qty, l.uom, l.per])).toEqual([[3, 'BX', 100], [50, 'EA', 1]]);
    expect((await asActor(w.admin, (tx) => incomingByPart(tx, w.facilities.A!, [gloves.id]))).get(gloves.id)).toEqual({ onOrder: 350, requested: 0 });

    // Two boxes arrive: 200 each into stock at a hundredth of the box price.
    await asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, orders[0]!.id, { lines: [{ orderLineId: lines[0].id, qty: 2 }] }));
    expect(await onHand(gloves.id)).toBe(200);
    const txn = await asActor(w.admin, (tx) => one(tx, `SELECT qty::float AS qty, unit_cost::float AS unit_cost FROM inventory_txn WHERE part_id = $1 AND txn_type = 'receipt'`, [gloves.id]));
    expect(txn).toEqual({ qty: 200, unit_cost: 0.32 });
    const receipt = await asActor(w.admin, (tx) => one(tx, 'SELECT qty::float AS qty, stock_qty::float AS stock_qty FROM po_receipt WHERE order_line_id = $1', [lines[0].id]));
    expect(receipt).toEqual({ qty: 2, stock_qty: 200 });
    expect((await asActor(w.admin, (tx) => incomingByPart(tx, w.facilities.A!, [gloves.id]))).get(gloves.id)!.onOrder).toBe(150);
    // A later change to the box size does not rewrite the order: the last box still brings 100.
    await asActor(w.admin, (tx) => setPartUnit(tx, w.admin, gloves.id, { uom: 'BX', perUnit: 50 }));
    await asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, orders[0]!.id, { lines: [{ orderLineId: lines[0].id, qty: 1 }] }));
    expect(await onHand(gloves.id)).toBe(300);
  });
});

describe('units in imports', () => {
  it('a parts list with a purchase unit and pack size, then a price list priced per that unit', async () => {
    let staged = await stageImport(w.admin, { target: 'parts', sourceSystem: 'sheet', fileName: 'parts.csv',
      content: csv('Item,Description,UOM,Purch UM,Pack Qty\nRAG-1,Shop rags,lb,case,25\nTAPE-2,Duct tape,ea,box,\n') });
    expect(staged.stats).toMatchObject({ errors: 1 });
    await commitImport(w.admin, staged.batchId, { allowPartial: true });
    expect((await asActor(w.admin, (tx) => one(tx, `SELECT p.uom, u.uom AS pu, u.per_unit::float AS per FROM part p JOIN part_uom u ON u.part_id = p.id WHERE p.part_number = 'RAG-1'`))))
      .toEqual({ uom: 'LB', pu: 'CS', per: 25 });
    staged = await stageImport(w.buyer, { target: 'supplier_prices', sourceSystem: 'grainger', fileName: 'prices.csv',
      content: csv('Vendor,Item,Price,Per\nGRN,RAG-1,61.50,CS\nGRN,GLV-9,9.00,PK\n') });
    expect(staged.stats).toMatchObject({ errors: 1, toCreate: 1 });
    expect(JSON.stringify(staged.problems)).toMatch(/GLV-9 is stocked in EA with no conversion from PK/);
    await commitImport(w.buyer, staged.batchId, { allowPartial: true });
    expect((await asActor(w.admin, (tx) => one(tx, `SELECT sp.uom, sp.unit_price::float AS price FROM supplier_part sp JOIN part p ON p.id = sp.part_id WHERE p.part_number = 'RAG-1'`))))
      .toEqual({ uom: 'CS', price: 61.5 });
  });
});
