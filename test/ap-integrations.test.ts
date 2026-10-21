import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { approveInvoice, captureInvoice, getInvoice, invoiceDraftFromOrder, invoiceFile, recordPayment, termsDays, voidInvoice } from '../src/modules/ap/service.js';
import { createLocation } from '../src/modules/inventory/service.js';
import { setAccountMapping } from '../src/modules/integrations/accounts.js';
import {
  createConnection, disconnect, downloadExportFile, listDeliveries, listExportFiles, mockPayBill, mockSimulateOutage, retryDelivery, runSync,
} from '../src/modules/integrations/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import {
  createOrdersFromRequest, createPurchaseRequest, createSupplier, receiveOrder, setSupplierPrice, submitPurchaseRequest,
} from '../src/modules/purchasing/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
let w: World;
let clerk: Actor;
let supplier: any; let po: any;
const db = () => getAdminPool();
/** Makes every pending delivery due now (instead of waiting for the backoff). */
const due = () => db().query(`UPDATE sync_delivery SET next_attempt_at = now() WHERE tenant_id = $1 AND status = 'pending'`, [w.tenantId]);
const invStatus = async (id: string) => (await db().query('SELECT status FROM supplier_invoice WHERE id = $1', [id])).rows[0].status;

beforeAll(async () => {
  w = await makeWorld('ap');
  const u = await createUserWithToken(db(), w.tenantId, { email: `clerk-${Date.now()}@ap.example`, displayName: 'AP Clerk', roles: [{ role: 'ap_clerk', facility: null }] });
  clerk = (await loadActor(w.tenantId, u.userId))!;
  const store = (await asActor(w.admin, (tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-ST', name: 'Storeroom' }))).id;
  const part = await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'BRG-1', description: 'Bearing' }));
  supplier = await asActor(w.buyer, (tx) => createSupplier(tx, w.buyer, { code: 'KOV', name: 'Koval Bearing', paymentTerms: '2% 10 Net 30' }));
  await asActor(w.buyer, (tx) => setSupplierPrice(tx, w.buyer, supplier.id, part.id, { unitPrice: 20, preferred: true }));
  const pr = await asActor(w.techA, (tx) => createPurchaseRequest(tx, w.techA, { facilityId: w.facilities.A!, title: 'Bearings', lines: [{ partId: part.id, qty: 10, locationId: store },
    { description: 'Bearing puller rental', qty: 1, estUnitPrice: 60, supplierId: supplier.id }] }));
  await asActor(w.techA, (tx) => submitPurchaseRequest(tx, w.techA, pr.id));
  const step = (await asActor(w.managerA, (tx) => myApprovalQueue(tx, w.managerA))).find((q) => q.subject_id === pr.id);
  await asActor(w.managerA, (tx) => decideApproval(tx, w.managerA, step.step_id, { decision: 'approve' }));
  po = (await asActor(w.buyer, (tx) => createOrdersFromRequest(tx, w.buyer, pr.id))).orders[0];
  const lines = (await asActor(w.buyer, (tx) => invoiceDraftFromOrder(tx, w.buyer, po.id))).lines;
  await asActor(w.managerA, (tx) => receiveOrder(tx, w.managerA, po.id, { lines: [{ orderLineId: lines[0].po_line_id, qty: 6 }, { orderLineId: lines[1].po_line_id, qty: 1 }] }));
});
afterAll(closePools);

describe('supplier invoices', () => {
  let inv1: any;

  it('reads due dates from common payment terms', () => {
    expect([termsDays('Net 30'), termsDays('2% 10 Net 30'), termsDays('COD'), termsDays('Due on receipt'), termsDays('45 days'), termsDays('EOM'), termsDays(null)])
      .toEqual([30, 30, 0, 0, 45, null, null]);
  });

  it('captures from the order with received quantities, due date from terms, account by line, and refuses duplicates', async () => {
    const draft = await asActor(clerk, (tx) => invoiceDraftFromOrder(tx, clerk, po.id));
    expect(draft.lines.map((l: any) => [l.description, l.toInvoice, l.unit_price])).toEqual([['BRG-1 Bearing', 6, 20], ['Bearing puller rental', 1, 60]]);
    inv1 = await asActor(clerk, (tx) => captureInvoice(tx, clerk, blobs, {
      supplierId: supplier.id, purchaseOrderId: po.id, invoiceNumber: 'KB-1001', invoiceDate: '2026-10-01', freightAmount: 12.5,
      lines: draft.lines.map((l: any) => ({ poLineId: l.po_line_id, qty: l.toInvoice, unitPrice: l.unit_price })),
    }, { name: 'KB-1001.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-1.4 demo') }));
    expect(inv1.due_date).toBe('2026-10-31');
    const full = await asActor(clerk, (tx) => getInvoice(tx, clerk, inv1.id));
    expect(full.lines.map((l: any) => l.account_key)).toEqual(['inventory', 'maintenance_expense']);
    expect(full).toMatchObject({ matched: true, subtotal: 180, total: 192.5, has_file: true });
    expect((await asActor(clerk, (tx) => invoiceFile(tx, clerk, blobs, inv1.id))).content.toString()).toContain('%PDF');
    await expect(asActor(clerk, (tx) => captureInvoice(tx, clerk, blobs, { supplierId: supplier.id, facilityId: w.facilities.A, invoiceNumber: 'kb-1001', invoiceDate: '2026-10-02', lines: [{ description: 'x', qty: 1, unitPrice: 1 }] })))
      .rejects.toThrow(/already captured/);
    await expect(asActor(w.techA, (tx) => captureInvoice(tx, w.techA, blobs, { supplierId: supplier.id, facilityId: w.facilities.A, invoiceNumber: 'Z', invoiceDate: '2026-10-02', lines: [{ description: 'x', qty: 1, unitPrice: 1 }] })))
      .rejects.toThrow(/ap.manage/);
  });

  it('an invoice for more than was received, or above the order price, needs an explanation to approve; the capturer cannot approve', async () => {
    const poLineId = (await asActor(clerk, (tx) => invoiceDraftFromOrder(tx, clerk, po.id))).lines[0].po_line_id;
    const inv = await asActor(clerk, (tx) => captureInvoice(tx, clerk, blobs, {
      supplierId: supplier.id, purchaseOrderId: po.id, invoiceNumber: 'KB-1002', invoiceDate: '2026-10-05', lines: [{ poLineId, qty: 4, unitPrice: 21.5 }],
    }));
    const full = await asActor(clerk, (tx) => getInvoice(tx, clerk, inv.id));
    expect(full.issues).toEqual(['line 1: invoiced 10 but received 6', 'line 1: price 21.5 above order price 20']);
    await expect(asActor(clerk, (tx) => approveInvoice(tx, clerk, inv.id, { varianceNote: 'ok' }))).rejects.toThrow(/captured an invoice cannot approve/);
    await expect(asActor(w.finance, (tx) => approveInvoice(tx, w.finance, inv.id))).rejects.toThrow(/does not match the order/);
    await asActor(w.finance, (tx) => voidInvoice(tx, w.finance, inv.id, 'Supplier billed ahead of delivery; asked for a corrected invoice'));
    // A voided number can be captured again (the corrected invoice).
    expect(await invStatus(inv.id)).toBe('void');
  });

  it('approval puts the bill in the outbox exactly once', async () => {
    await asActor(w.finance, (tx) => approveInvoice(tx, w.finance, inv1.id));
    const events = await asActor(w.admin, (tx) => many(tx, `SELECT topic, idempotency_key, payload FROM outbox_event WHERE aggregate_id = $1`, [inv1.id]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ topic: 'ap.bill.approved', idempotency_key: `bill:${inv1.id}:approved`, payload: { total: 192.5, poNumber: po.number, supplier: { code: 'KOV' } } });
    await expect(db().query(`UPDATE outbox_event SET topic = 'x' WHERE tenant_id = $1`, [w.tenantId])).rejects.toThrow(/append-only/);
  });
});

describe('accounting sync (MOCK accounting system)', () => {
  let conn: any;
  let inv1: string;

  it('connecting is admin-only and is labeled as a mock; nothing syncs without a connection', async () => {
    await expect(runSync(w.admin)).rejects.toThrow(/no active accounting connection/);
    await expect(asActor(w.finance, (tx) => createConnection(tx, w.finance, { provider: 'mock_accounting' }))).rejects.toThrow(/integrations.manage/);
    conn = await asActor(w.admin, (tx) => createConnection(tx, w.admin, { provider: 'mock_accounting', backfill: 'all' }));
    expect(conn).toMatchObject({ is_mock: true, label: 'MOCK accounting system (demo only)' });
    await expect(asActor(w.admin, (tx) => createConnection(tx, w.admin, { provider: 'file_export' }))).rejects.toThrow(/already active/);
    inv1 = (await db().query(`SELECT id FROM supplier_invoice WHERE tenant_id = $1 AND invoice_number = 'KB-1001'`, [w.tenantId])).rows[0].id;
  });

  it('an unmapped account fails the delivery; after mapping, a retry delivers it and the invoice shows as in accounting', async () => {
    let r = await runSync(w.admin);
    expect(r).toMatchObject({ delivered: 0, failed: 1, mock: true });
    const [d] = await asActor(w.admin, (tx) => listDeliveries(tx, w.admin, conn.id));
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_error: 'account mapping missing for: inventory, maintenance_expense, freight' });
    await asActor(w.admin, async (tx) => {
      for (const [k, c] of [['inventory', '1400'], ['maintenance_expense', '6200'], ['capital_projects', '1750'], ['freight', '6210'], ['sales_tax', '6220']]) {
        await setAccountMapping(tx, w.admin, k!, { externalCode: c!, externalName: null });
      }
    });
    r = await runSync(w.admin);
    expect(r.delivered).toBe(0); // still waiting for its backoff
    await due();
    r = await runSync(w.admin);
    expect(r).toMatchObject({ delivered: 1 });
    expect(await invStatus(inv1)).toBe('exported');
    const bills = await asActor(w.admin, (tx) => many(tx, `SELECT external_id, payload FROM mock_accounting_record WHERE kind = 'bill'`));
    expect(bills).toHaveLength(1);
    expect(bills[0].payload.lines.map((l: any) => [l.account, l.amount])).toEqual([['1400', 120], ['6200', 60], ['6210', 12.5]]);
    // The vendor was created once in accounting and remembered in the external-ID crosswalk.
    const xref = await asActor(w.admin, (tx) => one(tx, `SELECT external_id FROM external_ref WHERE entity_type = 'supplier' AND entity_id = $1`, [supplier.id]));
    expect(xref.external_id).toBe('MOCK-V-0001');
  });

  it('a delivery that happened but was not recorded is retried without creating a duplicate', async () => {
    await db().query(`UPDATE sync_delivery SET status = 'pending', next_attempt_at = now() WHERE tenant_id = $1`, [w.tenantId]);
    await runSync(w.admin);
    expect((await asActor(w.admin, (tx) => many(tx, `SELECT 1 FROM mock_accounting_record WHERE kind = 'bill'`))).length).toBe(1);
  });

  it('repeated failures park the delivery as dead; after a manual retry it goes through', async () => {
    const inv = await asActor(clerk, (tx) => captureInvoice(tx, clerk, blobs, { supplierId: supplier.id, facilityId: w.facilities.A, invoiceNumber: 'KB-1003', invoiceDate: '2026-10-10',
      lines: [{ description: 'Expedited shipping, rush order', qty: 1, unitPrice: 85, accountKey: 'freight' }] }));
    await asActor(w.finance, (tx) => approveInvoice(tx, w.finance, inv.id, { varianceNote: 'Not on a PO: rush freight agreed by phone with Marcus' }));
    await asActor(w.admin, (tx) => mockSimulateOutage(tx, w.admin, conn.id, 10));
    for (let i = 0; i < 6; i++) { await due(); await runSync(w.admin); }
    const dead = await asActor(w.admin, (tx) => listDeliveries(tx, w.admin, conn.id, { status: 'dead' }));
    expect(dead).toEqual([expect.objectContaining({ invoice_number: 'KB-1003', attempts: 6, last_error: 'MOCK: simulated outage (503 Service Unavailable)' })]);
    const report = await asActor(w.finance, (tx) => getReport('ap-aging')!.run(tx, w.finance, {}));
    expect(report.kpis.find((k) => k.label === 'Sync failures')!.value).toBe(1);
    await asActor(w.admin, (tx) => mockSimulateOutage(tx, w.admin, conn.id, 0));
    await asActor(w.admin, (tx) => retryDelivery(tx, w.admin, dead[0].id));
    expect((await runSync(w.admin)).delivered).toBe(1);
    expect(await invStatus(inv.id)).toBe('exported');
  });

  it('payments come back from accounting; they cannot be typed in while an API connection is active', async () => {
    await expect(asActor(w.finance, (tx) => recordPayment(tx, w.finance, inv1, { paidOn: '2026-10-20', amount: 192.5 }))).rejects.toThrow(/come from the connected accounting system/);
    const bill = (await asActor(w.admin, (tx) => one(tx, `SELECT external_id FROM mock_accounting_record WHERE kind = 'bill' AND payload->>'invoiceId' = $1`, [inv1]))).external_id;
    await asActor(w.admin, (tx) => mockPayBill(tx, w.admin, conn.id, { externalId: bill, paidOn: '2026-10-20' }));
    expect((await runSync(w.admin)).payments).toBe(1);
    const full = await asActor(w.finance, (tx) => getInvoice(tx, w.finance, inv1));
    expect(full).toMatchObject({ status: 'paid', paid_at: '2026-10-20', paid_amount: 192.5 });
    await expect(asActor(w.finance, (tx) => voidInvoice(tx, w.finance, inv1, 'mistake'))).rejects.toThrow(/invoice is paid/);
  });

  it('voiding an invoice already in accounting voids the bill there too', async () => {
    const inv = (await db().query(`SELECT id FROM supplier_invoice WHERE tenant_id = $1 AND invoice_number = 'KB-1003'`, [w.tenantId])).rows[0].id;
    await asActor(w.finance, (tx) => voidInvoice(tx, w.finance, inv, 'Duplicate of the freight on KB-1001'));
    await runSync(w.admin);
    const bill = await asActor(w.admin, (tx) => one(tx, `SELECT status FROM mock_accounting_record WHERE kind = 'bill' AND payload->>'invoiceId' = $1`, [inv]));
    expect(bill.status).toBe('void');
  });
});

describe('accounting sync (file export)', () => {
  it('writes approved bills to a downloadable CSV with mapped account codes; payments are then recorded by hand', async () => {
    const mock = (await db().query(`SELECT id FROM integration_connection WHERE tenant_id = $1 AND active`, [w.tenantId])).rows[0].id;
    await asActor(w.admin, (tx) => disconnect(tx, w.admin, mock));
    const conn = await asActor(w.admin, (tx) => createConnection(tx, w.admin, { provider: 'file_export' }));
    const inv = await asActor(clerk, (tx) => captureInvoice(tx, clerk, blobs, { supplierId: supplier.id, facilityId: w.facilities.A, invoiceNumber: 'KB-1004', invoiceDate: '2026-10-12',
      taxAmount: 4.2, lines: [{ description: 'Shop rags, 2 boxes', qty: 2, unitPrice: 30 }] }));
    await asActor(w.finance, (tx) => approveInvoice(tx, w.finance, inv.id, { varianceNote: 'Consumables bought without a PO' }));
    const r = await runSync(w.admin);
    expect(r).toMatchObject({ delivered: 1, mock: false });
    const [file] = await asActor(w.admin, (tx) => listExportFiles(tx, w.admin, conn.id));
    expect(file).toMatchObject({ kind: 'ap_bills', row_count: 2, downloaded_at: null });
    const csv = (await asActor(w.admin, (tx) => downloadExportFile(tx, w.admin, file.id))).content;
    expect(csv).toContain('CREATE,KOV,Koval Bearing,KB-1004,2026-10-12,2026-11-11,USD,,A,1,"Shop rags, 2 boxes",2,30,60,6200');
    expect(csv).toContain('Sales tax,1,4.2,4.2,6220');
    expect(await invStatus(inv.id)).toBe('exported');
    await asActor(w.finance, (tx) => recordPayment(tx, w.finance, inv.id, { paidOn: '2026-11-05', amount: 64.2, reference: 'ACH 88123' }));
    expect(await invStatus(inv.id)).toBe('paid');
  });

  it('other tenants see none of it', async () => {
    const other = await makeWorld('ap-other');
    expect(await asActor(other.admin, (tx) => many(tx, 'SELECT 1 FROM supplier_invoice UNION ALL SELECT 1 FROM outbox_event UNION ALL SELECT 1 FROM export_file'))).toHaveLength(0);
  });
});
