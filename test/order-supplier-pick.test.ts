import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools } from '../src/platform/db/pool.js';
import { one } from '../src/platform/db/tx.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createOrdersFromRequest, createPurchaseRequest, createSupplier, getPurchaseRequest, submitPurchaseRequest } from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** A request line with no supplier gets one when the order is placed (D-183C). */
let w: World; let acme: any; let prId: string; let lineId: string;
beforeAll(async () => {
  w = await makeWorld('ordsup');
  acme = await asActor(w.admin, (tx) => createSupplier(tx, w.admin, { code: 'ACME', name: 'Acme Supply' }));
  const pr = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Gaskets, buyer picks the supplier', lines: [{ description: 'Gasket set', qty: 4, uom: 'EA', estUnitPrice: 12 }] }));
  prId = pr.id;
  await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, prId));
  const step = (await asActor(w.managerA, (tx) => myApprovalQueue(tx, w.managerA))).find((q) => q.subject_id === prId)!;
  await asActor(w.managerA, (tx) => decideApproval(tx, w.managerA, step.step_id, { decision: 'approve', comment: 'ok' }));
  lineId = (await asActor(w.buyer, (tx) => getPurchaseRequest(tx, w.buyer, prId))).lines[0].id;
});
afterAll(closePools);

describe('choosing the supplier when ordering', () => {
  it('a line without a supplier is refused, then ordered once the buyer names one; the choice is kept and audited', async () => {
    await expect(asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, prId))).rejects.toThrow(/choose a supplier for line 1/);
    const r = await asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, prId, { lines: [{ requestLineId: lineId, supplierId: acme.id }] }));
    expect(r.orders).toHaveLength(1);
    expect((await asActor(w.admin, (tx) => one(tx, 'SELECT supplier_id FROM purchase_request_line WHERE id = $1', [lineId]))).supplier_id).toBe(acme.id);
    expect((await asActor(w.admin, (tx) => one(tx, `SELECT data FROM audit_event WHERE entity_id = $1 AND action = 'purchase_request.supplier_chosen'`, [prId]))).data).toMatchObject({ line: 1, supplier: 'ACME' });
  });
});
