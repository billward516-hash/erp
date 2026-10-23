import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { createDelegation, myApprovalQueue, revokeDelegation } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createLocation, receive, setStockSettings } from '../src/modules/inventory/service.js';
import { addPart, createWorkOrder, getWorkOrder } from '../src/modules/maintenance/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { requestFromReorder } from '../src/modules/purchasing/reorder.js';
import {
  cancelOrder, createOrdersFromRequest, createPurchaseRequest, createSupplier, getOrder, getPurchaseRequest, receiveOrder, requestForWorkOrder,
  setSupplierPrice, submitPurchaseRequest, updatePurchaseRequest,
} from '../src/modules/purchasing/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

let w: World;
let store: string;
let acme: any; let bolt: any;
let filter: any; let belt: any;
const today = new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const queueFor = async (who: any) => asActor(who, (tx) => myApprovalQueue(tx, who));
/** Signs the single pending step of a request that `who` can see. */
const sign = async (who: any, prId: string, decision: 'approve' | 'reject' = 'approve', comment?: string) => {
  const step = (await queueFor(who)).find((q) => q.subject_id === prId);
  if (!step) throw new Error('no step for this person');
  return asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision, comment: comment ?? null }));
};
const status = async (id: string) => (await asActor(w.admin, (tx) => one(tx, 'SELECT status, revision, approved_total FROM purchase_request WHERE id = $1', [id])));
const onHand = async (part: string) => Number((await asActor(w.admin, (tx) => one(tx, 'SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [store, part])))?.qty_on_hand ?? 0);

beforeAll(async () => {
  w = await makeWorld('pur');
  store = (await asActor(w.admin, (tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-STORE', name: 'Storeroom' }))).id;
  ({ filter, belt } = await asActor(w.admin, async (tx) => ({
    filter: await createPart(tx, w.admin, { partNumber: 'FLT-1', description: 'Hydraulic filter', unitCost: 40 }),
    belt: await createPart(tx, w.admin, { partNumber: 'BLT-1', description: 'V-belt' }),
  })));
  ({ acme, bolt } = await asActor(w.buyer, async (tx) => ({
    acme: await createSupplier(tx, w.buyer, { code: 'ACME', name: 'Acme Industrial Supply', email: 'orders@acme.example', paymentTerms: 'Net 30' }),
    bolt: await createSupplier(tx, w.buyer, { code: 'BOLT', name: 'Bolt Power Transmission' }),
  })));
});
afterAll(closePools);

describe('suppliers and prices', () => {
  it('a part has at most one preferred supplier; requests default to it', async () => {
    await asActor(w.buyer, async (tx) => {
      await setSupplierPrice(tx, w.buyer, acme.id, filter.id, { unitPrice: 42, leadTimeDays: 5, supplierPartNumber: 'AC-937399', preferred: true });
      await setSupplierPrice(tx, w.buyer, bolt.id, filter.id, { unitPrice: 39 });
      await setSupplierPrice(tx, w.buyer, bolt.id, belt.id, { unitPrice: 15, leadTimeDays: 10, preferred: true });
    });
    // Updating a price without saying "preferred" keeps the flag.
    await asActor(w.buyer, (tx) => setSupplierPrice(tx, w.buyer, acme.id, filter.id, { unitPrice: 43 }));
    const pref = await asActor(w.admin, (tx) => many(tx, 'SELECT supplier_id FROM supplier_part WHERE part_id = $1 AND preferred', [filter.id]));
    expect(pref.map((p) => p.supplier_id)).toEqual([acme.id]);
    await expect(asActor(w.techA, (tx) => createSupplier(tx, w.techA, { code: 'X', name: 'x' }))).rejects.toThrow(/purchasing.manage/);
  });
});

describe('purchase request approval', () => {
  let small: any;

  it('a small request needs only the budget owner; the requester cannot approve their own', async () => {
    small = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, {
      facilityId: w.facilities.A!, title: 'Filters for HPU', lines: [{ partId: filter.id, qty: 10, locationId: store }, { partId: belt.id, qty: 4 }],
    }));
    const pr = await asActor(w.techA, (tx) => getPurchaseRequest(tx, w.techA, small.id));
    expect(pr.lines.map((l: any) => [l.part_number, l.est_unit_price, l.supplier_code])).toEqual([['FLT-1', 43, 'ACME'], ['BLT-1', 15, 'BOLT']]);
    expect(pr.total).toBe(490);
    expect(pr.route).toEqual([{ steps: [{ roleKey: 'maintenance_manager', label: 'Budget owner approval' }] }]);
    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, small.id));
    expect((await queueFor(w.techA)).find((q) => q.subject_id === small.id)).toBeUndefined();
    await expect(sign(w.opsA, small.id)).rejects.toThrow(/no step/);
    await sign(w.managerA, small.id);
    expect(await status(small.id)).toMatchObject({ status: 'approved', approved_total: 490 });
  });

  it('large capital requests route through plant manager and finance, with distinct signers', async () => {
    const big = await asActor(w.managerA, (tx) => createPurchaseRequest(tx, w.managerA, {
      facilityId: w.facilities.A!, title: 'Spare spindle cartridge', spendType: 'capex', justification: 'No spare on site; 6-week lead time',
      lines: [{ description: 'Spindle cartridge, rebuilt', qty: 1, estUnitPrice: 18500, supplierId: acme.id }],
    }));
    const r = await asActor(w.managerA, (tx) => submitPurchaseRequest(tx, w.managerA, big.id));
    expect(r.route.map((s) => s.steps.map((x) => x.roleKey))).toEqual([['maintenance_manager'], ['operations_manager'], ['finance_approver']]);
    // managerA raised it, so another maintenance manager signs (dualA), who then may not also sign as plant manager.
    await expect(sign(w.managerA, big.id)).rejects.toThrow(/no step/);
    await sign(w.dualA, big.id);
    expect((await queueFor(w.dualA)).find((q) => q.subject_id === big.id)).toBeUndefined();
    await expect(sign(w.finance, big.id)).rejects.toThrow(/no step/); // stage 3 waits for stage 2
    await sign(w.opsA, big.id);
    await expect(sign(w.finance, big.id, 'reject')).rejects.toThrow(/comment/);
    await sign(w.finance, big.id, 'reject', 'Capital plan for this quarter is spent; resubmit in January');
    expect(await status(big.id)).toMatchObject({ status: 'rejected' });
  });

  it('editing an approved request is a material change: approvals are superseded and it must be resubmitted', async () => {
    await asActor(w.techA, (tx) => updatePurchaseRequest(tx, w.techA, small.id, { lines: [{ partId: filter.id, qty: 12, locationId: store }, { partId: belt.id, qty: 4 }] }));
    expect(await status(small.id)).toMatchObject({ status: 'draft', revision: 2, approved_total: null });
    const pr = await asActor(w.managerA, (tx) => getPurchaseRequest(tx, w.managerA, small.id));
    expect(pr.approvals.map((a: any) => a.status)).toEqual(['superseded']);
    await expect(asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, small.id))).rejects.toThrow(/request is draft/);
    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, small.id));
    await sign(w.managerA, small.id);
    expect(await status(small.id)).toMatchObject({ status: 'approved', approved_total: 576 });
  });

  it('delegation lets a stand-in sign for an absent approver, recorded on the step, until revoked', async () => {
    const d = await asActor(w.managerA, (tx) => createDelegation(tx, w.managerA, { delegateUserId: w.tech2A.userId, startsOn: today, endsOn: plusDays(7), reason: 'Vacation' }));
    const pr = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Belts', lines: [{ partId: belt.id, qty: 2 }] }));
    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, pr.id));
    const q = (await queueFor(w.tech2A)).find((x) => x.subject_id === pr.id);
    expect(q.on_behalf_of).toMatchObject({ id: w.managerA.userId });
    await sign(w.tech2A, pr.id);
    const steps = await asActor(w.admin, (tx) => many(tx, `SELECT s.decided_by, s.on_behalf_of FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_id = $1`, [pr.id]));
    expect(steps).toEqual([{ decided_by: w.tech2A.userId, on_behalf_of: w.managerA.userId }]);
    // A delegate cannot approve the delegator's own request.
    const own = await asActor(w.managerA, (tx) => createPurchaseRequest(tx, w.managerA, { facilityId: w.facilities.A!, title: 'Own', lines: [{ partId: belt.id, qty: 1 }] }));
    await asActor(w.managerA, (tx) => submitPurchaseRequest(tx, w.managerA, own.id));
    expect((await queueFor(w.tech2A)).find((x) => x.subject_id === own.id)).toBeUndefined();
    await asActor(w.managerA, (tx) => revokeDelegation(tx, w.managerA, d.id));
    const pr2 = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Belts 2', lines: [{ partId: belt.id, qty: 1 }] }));
    await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, pr2.id));
    expect((await queueFor(w.tech2A)).find((x) => x.subject_id === pr2.id)).toBeUndefined();
  });
});

describe('purchase orders and receiving', () => {
  let prId: string;
  let orders: { id: string; number: string }[];

  it('orders split by supplier; the ordered total may not exceed the approved total by more than 10%', async () => {
    prId = (await asActor(w.admin, (tx) => one(tx, `SELECT id FROM purchase_request WHERE title = 'Filters for HPU'`))).id;
    const pr = await asActor(w.buyer, (tx) => getPurchaseRequest(tx, w.buyer, prId));
    const [l1, l2] = pr.lines;
    await expect(asActor(w.managerA, (tx) => createOrdersFromRequest(tx, w.managerA, prId))).rejects.toThrow(/purchasing.manage/);
    await expect(asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, prId, { lines: [{ requestLineId: l1.id, unitPrice: 50 }, { requestLineId: l2.id }] })))
      .rejects.toThrow(/exceed the approved 576.00 by more than 10%/);
    const r = await asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, prId, { lines: [{ requestLineId: l1.id, unitPrice: 46 }, { requestLineId: l2.id }] }));
    orders = r.orders;
    expect(orders).toHaveLength(2);
    expect(r.orderedTotal).toBe(612);
    expect(await status(prId)).toMatchObject({ status: 'closed' });
    const acmeOrder = await asActor(w.buyer, (tx) => getOrder(tx, w.buyer, orders[0]!.id));
    expect(acmeOrder).toMatchObject({ supplier_code: 'ACME', expected_on: plusDays(5), total: 552 });
    expect(acmeOrder.lines[0]).toMatchObject({ supplier_part_number: 'AC-937399', location_code: 'A-STORE' });
  });

  it('cancelling an order with nothing received frees its request lines', async () => {
    const boltOrder = orders[1]!;
    await asActor(w.buyer, (tx) => cancelOrder(tx, w.buyer, boltOrder.id, 'Supplier cannot ship this month'));
    expect(await status(prId)).toMatchObject({ status: 'approved' });
    const again = await asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, prId));
    expect(again.orders).toHaveLength(1);
    orders[1] = again.orders[0]!;
  });

  it('receipts post to the stock ledger at the order price; over-receipt and stocked parts without a storeroom are refused', async () => {
    const acmeOrder = await asActor(w.buyer, (tx) => getOrder(tx, w.buyer, orders[0]!.id));
    const line = acmeOrder.lines[0];
    await expect(asActor(w.techA, (tx) => receiveOrder(tx, w.techA, acmeOrder.id, { lines: [{ orderLineId: line.id, qty: 1 }] }))).rejects.toThrow(/purchasing.receive/);
    await expect(asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, acmeOrder.id, { lines: [{ orderLineId: line.id, qty: 13 }] }))).rejects.toThrow(/between 0 and 12/);
    const r1 = await asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, acmeOrder.id, { lines: [{ orderLineId: line.id, qty: 8 }], packingSlip: 'PS-1001' }));
    expect(r1.status).toBe('partially_received');
    expect(await onHand(filter.id)).toBe(8);
    const txn = await asActor(w.admin, (tx) => one(tx, `SELECT txn_type, unit_cost, reference FROM inventory_txn WHERE part_id = $1 ORDER BY id DESC LIMIT 1`, [filter.id]));
    expect(txn).toMatchObject({ txn_type: 'receipt', unit_cost: 46, reference: acmeOrder.number });
    expect(Number((await asActor(w.admin, (tx) => one(tx, 'SELECT unit_cost FROM part WHERE id = $1', [filter.id]))).unit_cost)).toBe(46);
    await expect(asActor(w.buyer, (tx) => cancelOrder(tx, w.buyer, acmeOrder.id, 'changed mind'))).rejects.toThrow(/cannot be cancelled/);
    const r2 = await asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, acmeOrder.id, { lines: [{ orderLineId: line.id, qty: 4 }] }));
    expect(r2.status).toBe('received');
    // Belts now stocked at A-STORE (via a receipt), so receiving the Bolt order without a storeroom is refused.
    await asActor(w.managerA, (tx) => receive(tx, w.managerA, { locationId: store, partId: belt.id, qty: 1 }));
    const boltOrder = await asActor(w.buyer, (tx) => getOrder(tx, w.buyer, orders[1]!.id));
    await expect(asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, boltOrder.id, { lines: [{ orderLineId: boltOrder.lines[0].id, qty: 4 }] })))
      .rejects.toThrow(/choose the storeroom/);
    await asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, boltOrder.id, { lines: [{ orderLineId: boltOrder.lines[0].id, qty: 4, locationId: store }] }));
    expect(await onHand(belt.id)).toBe(5);
    await expect(getAdminPool().query('UPDATE po_receipt SET qty = 1 WHERE tenant_id = $1', [w.tenantId])).rejects.toThrow(/append-only/);
  });
});

describe('demand into purchasing', () => {
  it('a work order requests only what stock and open orders do not cover, and shows the purchase', async () => {
    const asset = await asActor(w.managerA, (tx) => createAsset(tx, w.managerA, { facilityId: w.facilities.A!, assetTag: 'HPU-9', name: 'HPU' }));
    const wo = await asActor(w.managerA, async (tx) => {
      const o = await createWorkOrder(tx, w.managerA, { assetId: asset.id, title: 'Rebuild HPU', dueAt: `${plusDays(10)}T17:00:00Z` });
      await addPart(tx, w.managerA, o.id, { partId: filter.id, qtyPlanned: 15 });
      await addPart(tx, w.managerA, o.id, { partId: belt.id, qtyPlanned: 2 });
      return o;
    });
    const pr = await asActor(w.techA, (tx) => requestForWorkOrder(tx, w.techA, wo.id));
    const full = await asActor(w.techA, (tx) => getPurchaseRequest(tx, w.techA, pr.id));
    // Filters: 15 planned − 12 on hand = 3. Belts: 5 on hand covers 2.
    expect(full.lines.map((l: any) => [l.part_number, l.qty, l.location_code, l.work_order_number])).toEqual([['FLT-1', 3, 'A-STORE', wo.number]]);
    expect(full).toMatchObject({ needed_by: plusDays(10), work_order_number: wo.number });
    await expect(asActor(w.techA, (tx) => requestForWorkOrder(tx, w.techA, wo.id))).rejects.toThrow(/already on order/);
    const view = await asActor(w.techA, (tx) => getWorkOrder(tx, w.techA, wo.id));
    expect(view.purchases).toEqual([expect.objectContaining({ request_number: pr.number, part_number: 'FLT-1', order_number: null })]);
  });

  it('the reorder report counts stock on order and requested; a replenishment request can be drafted from it', async () => {
    await asActor(w.managerA, (tx) => setStockSettings(tx, w.managerA, store, belt.id, { reorderPoint: 12, reorderQty: 10 }));
    let ro = await asActor(w.managerA, (tx) => getReport('inventory-reorder')!.run(tx, w.managerA, getReport('inventory-reorder')!.params.parse({})));
    // 5 on hand + 4 on requests not yet ordered (Belts, Own, Belts 2) = 9, below the reorder point of 12.
    expect(ro.rows.find((r) => r.part_number === 'BLT-1')).toMatchObject({ on_hand: 5, on_order: 0, requested: 4, suggested_qty: 10 });
    const pr = await asActor(w.managerA, (tx) => requestFromReorder(tx, w.managerA, { facilityId: w.facilities.A! }));
    const full = await asActor(w.managerA, (tx) => getPurchaseRequest(tx, w.managerA, pr.id));
    expect(full.lines.map((l: any) => [l.part_number, l.qty, l.supplier_code])).toEqual([['BLT-1', 10, 'BOLT']]);
    ro = await asActor(w.managerA, (tx) => getReport('inventory-reorder')!.run(tx, w.managerA, getReport('inventory-reorder')!.params.parse({})));
    // Position is now 19, above the reorder point.
    expect(ro.rows.find((r) => r.part_number === 'BLT-1')).toBeUndefined();
  });

  it('purchasing status shows what waits for approval and ordering', async () => {
    const r = await asActor(w.exec, (tx) => getReport('purchasing-status')!.run(tx, w.exec, getReport('purchasing-status')!.params.parse({})));
    expect(r.kpis.find((k) => k.label === 'Approved, not ordered')!.value).toBe(1); // the delegated "Belts" request
    expect(r.rows.some((x) => x.stage === 'Awaiting approval' && x.waiting_on === 'Budget owner approval')).toBe(true);
    expect(r.insights.join(' ')).toMatch(/committed on 2 purchase orders/);
  });
});

describe('vendor files', () => {
  it('imports a messy vendor list and a price list, idempotently', async () => {
    const vendors = Buffer.from('Vendor #,Vendor Name,Attn,E-mail,Terms,Status\r\nGRA,Grainger Industrial,Pat Lee,pat@grainger.example,Net 30,Active\r\nMSC,MSC Direct,,not-an-email,2% 10 Net 30,Active\r\nOLD,Old Bearings Co,,,,Inactive\r\n');
    const s1 = await stageImport(w.buyer, { target: 'suppliers', sourceSystem: 'quickbooks-vendors', fileName: 'vendors.csv', content: vendors });
    expect(s1.stats).toMatchObject({ total: 3, errors: 0, warnings: 1 });
    await commitImport(w.buyer, s1.batchId);
    const prices = Buffer.from('Vendor,Item,Vendor Item,Price,Lead Time,Primary\r\nGRA,FLT-1,4XY12,44.10,3,\r\nGRA,BLT-1,3AB45,14.80,2,X\r\nGRA,NOPE,1,1,1,\r\n');
    const s2 = await stageImport(w.buyer, { target: 'supplier_prices', sourceSystem: 'grainger-pricelist', fileName: 'prices.csv', content: prices });
    expect(s2.stats).toMatchObject({ total: 3, errors: 1 });
    await commitImport(w.buyer, s2.batchId, { allowPartial: true });
    const rows = await asActor(w.admin, (tx) => many(tx, `SELECT p.part_number, sp.unit_price, sp.preferred, s.code FROM supplier_part sp JOIN part p ON p.id = sp.part_id
      JOIN supplier s ON s.id = sp.supplier_id WHERE sp.preferred ORDER BY p.part_number`));
    // Grainger becomes the preferred belt supplier; Acme stays preferred for filters (blank "Primary" does not clear it).
    expect(rows.map((r) => [r.part_number, r.code])).toEqual([['BLT-1', 'GRA'], ['FLT-1', 'ACME']]);
    const inactive = await asActor(w.admin, (tx) => one(tx, `SELECT active FROM supplier WHERE code = 'OLD'`));
    expect(inactive.active).toBe(false);
    const again = await stageImport(w.buyer, { target: 'suppliers', sourceSystem: 'quickbooks-vendors', fileName: 'vendors.csv', content: vendors });
    expect(again.preview.every((p: any) => p.action === 'update')).toBe(true);
  });
});
