import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { applyCredit, createCreditMemo, getCreditMemo, issueCreditMemo, refundCredit, voidCreditMemo } from '../src/modules/ar/credit-memos.js';
import { createInvoice, getInvoice, issueInvoice, recordPayment } from '../src/modules/ar/service.js';
import { setupBooks, trialBalance } from '../src/modules/books/service.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createLocation } from '../src/modules/inventory/service.js';
import { createConnection, runSync } from '../src/modules/integrations/service.js';
import { createPart } from '../src/modules/parts/service.js';

/** Credit memos, customer returns and refunds (D-146), posted by the built-in books. */
const db = () => getAdminPool();
const blobs = new LocalBlobStore('./.storage/test');
let app: FastifyInstance;
let tenantId: string; let facility: string; let admin: Actor;
let customer: any; let widget: any; let store: string; let invoice: any;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const row = async (code: string) => (await asActor(admin, (tx) => trialBalance(tx, admin))).rows.find((r) => r.code === code);
const onHand = async () => Number((await db().query('SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [store, widget.id])).rows[0]?.qty_on_hand ?? 0);

async function tenant(slug: string) {
  const t = await provisionTenant(db(), { slug, name: 'Ridge Works', legalEntity: 'Ridge Works Inc', facilities: [{ code: 'P1', name: 'Plant 1', timezone: 'America/Chicago' }] });
  const u = await createUserWithToken(db(), t.tenantId, { email: `admin@${slug}.example`, displayName: 'Ada Admin', roles: [{ role: 'admin', facility: null }] });
  return { t, a: (await loadActor(t.tenantId, u.userId))! };
}

beforeAll(async () => {
  app = buildApp({ blobs });
  const { t, a } = await tenant(`cm-${process.pid}-${Date.now() % 100000}`);
  tenantId = t.tenantId; facility = t.facilities.P1!; admin = a;
  await asActor(admin, (tx) => setupBooks(tx, admin, { startDate: daysAgo(60), openingBalance: 5000 }));
  customer = await asActor(admin, (tx) => createCustomer(tx, admin, { code: 'ACME', name: 'Acme Fabrication', kind: 'customer', paymentTerms: 'Net 30' }));
  ({ widget, store } = await asActor(admin, async (tx) => ({
    widget: await createPart(tx, admin, { partNumber: 'WID-1', description: 'Widget', unitCost: 40 }),
    store: (await createLocation(tx, admin, { facilityId: facility, code: 'MAIN', name: 'Main storeroom' })).id,
  })));
  invoice = await asActor(admin, async (tx) => {
    const i = await createInvoice(tx, admin, { customerId: customer.id, facilityId: facility, lines: [{ description: 'Widgets', qty: 3, unitPrice: 100 }], taxAmount: 24 });
    await issueInvoice(tx, admin, blobs, i.id, { invoiceDate: daysAgo(20) });
    return i;
  });
});
afterAll(async () => { await app.close(); await closePools(); });

describe('credit memos with the built-in books', () => {
  let ret: any;
  it('a return credits the invoice it corrects, puts the goods back into stock, and posts the mirror of the invoice', async () => {
    ret = await asActor(admin, (tx) => createCreditMemo(tx, admin, { customerId: customer.id, invoiceId: invoice.id, reason: 'One widget returned damaged in transit', taxAmount: 8,
      lines: [{ description: 'Widget returned', qty: 1, unitPrice: 100, partId: widget.id, locationId: store }] }));
    const r = await asActor(admin, (tx) => issueCreditMemo(tx, admin, blobs, ret.id));
    expect(r).toMatchObject({ number: expect.stringMatching(/^CM-\d{6}$/), total: 108, applied: 108 });
    expect(await onHand()).toBe(1);
    const inv = await asActor(admin, (tx) => getInvoice(tx, admin, invoice.id));
    expect(inv).toMatchObject({ status: 'partially_paid', balance: 216 });
    expect(inv.payments).toEqual([expect.objectContaining({ method: 'credit', reference: r.number, amount: 108 })]);
    expect((await row('1100'))!.debit).toBe(216);
    expect((await row('4100'))!.credit).toBe(200); // 300 billed as service income, 100 credited back to the same account
    expect(await row('4000')).toBeUndefined();
    expect((await row('2200'))!.credit).toBe(16);
    const pdf = await db().query('SELECT sha256 FROM customer_credit_memo WHERE id = $1', [ret.id]);
    expect(pdf.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an invoice cannot be credited beyond what it billed; issued memos never change', async () => {
    const big = await asActor(admin, (tx) => createCreditMemo(tx, admin, { customerId: customer.id, invoiceId: invoice.id, reason: 'Too much', lines: [{ description: 'x', qty: 1, unitPrice: 250 }] }));
    await expect(asActor(admin, (tx) => issueCreditMemo(tx, admin, blobs, big.id))).rejects.toThrow(/the invoice billed 324.00; 108.00 is already credited/);
    await expect(asActor(admin, (tx) => voidCreditMemo(tx, admin, ret.id, 'Changed my mind'))).rejects.toThrow(/108.00 of this credit is applied or refunded/);
  });

  it('a goodwill credit is applied in part, refunded in part, and the receivable and bank agree', async () => {
    const gw = await asActor(admin, (tx) => createCreditMemo(tx, admin, { customerId: customer.id, reason: 'Goodwill for the late delivery', lines: [{ description: 'Goodwill', qty: 1, unitPrice: 50, accountKey: 'other_expense' }] }));
    await asActor(admin, (tx) => issueCreditMemo(tx, admin, blobs, gw.id));
    await expect(asActor(admin, (tx) => applyCredit(tx, admin, gw.id, { invoiceId: invoice.id, amount: 60 }))).rejects.toThrow(/apply between 0 and 50.00/);
    await asActor(admin, (tx) => applyCredit(tx, admin, gw.id, { invoiceId: invoice.id, amount: 30 }));
    await expect(asActor(admin, (tx) => refundCredit(tx, admin, gw.id, { amount: 25, paidOn: daysAgo(1), method: 'check' }))).rejects.toThrow(/20.00 of credit left/);
    await asActor(admin, (tx) => refundCredit(tx, admin, gw.id, { amount: 20, paidOn: daysAgo(1), method: 'check', reference: '1102' }));
    expect(await asActor(admin, (tx) => getCreditMemo(tx, admin, gw.id))).toMatchObject({ total: 50, applied: 30, refunded: 20, remaining: 0 });
    await asActor(admin, (tx) => recordPayment(tx, admin, { customerId: customer.id, receivedOn: daysAgo(1), amount: 186, method: 'ach', allocations: [{ invoiceId: invoice.id, amount: 186 }] }));
    expect((await asActor(admin, (tx) => getInvoice(tx, admin, invoice.id))).status).toBe('paid');
    const tb = await asActor(admin, (tx) => trialBalance(tx, admin));
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.code === '1100')).toBeUndefined(); // nothing owed either way
    expect(tb.rows.find((r) => r.code === '1000')!.debit).toBe(5000 + 186 - 20);
    expect(tb.rows.find((r) => r.code === '6900')!.debit).toBe(50);
  });

  it('voiding an issued memo with nothing applied reverses its posting and takes the returned goods back out', async () => {
    const m = await asActor(admin, (tx) => createCreditMemo(tx, admin, { customerId: customer.id, reason: 'Return logged twice', lines: [{ description: 'Widget', qty: 1, unitPrice: 100, partId: widget.id, locationId: store }] }));
    await asActor(admin, (tx) => issueCreditMemo(tx, admin, blobs, m.id));
    expect(await onHand()).toBe(2);
    await asActor(admin, (tx) => voidCreditMemo(tx, admin, m.id, 'Duplicate of an earlier return'));
    expect(await onHand()).toBe(1);
    const entries = (await db().query(`SELECT reverses_id IS NOT NULL AS reversal FROM journal_entry WHERE tenant_id = $1 AND source_id = $2 ORDER BY created_at`, [tenantId, m.id])).rows;
    expect(entries.map((e) => e.reversal)).toEqual([false, true]);
    expect((await asActor(admin, (tx) => trialBalance(tx, admin))).balanced).toBe(true);
  });
});

describe('credit memos with other accounting connections', () => {
  it('go out in their own file with a file export, and are refused with an API connection', async () => {
    const { t, a } = await tenant(`cmx-${process.pid}-${Date.now() % 100000}`);
    const c = await asActor(a, (tx) => createCustomer(tx, a, { code: 'BRT', name: 'Bright Path', kind: 'customer' }));
    await asActor(a, (tx) => createConnection(tx, a, { provider: 'file_export' }));
    await asActor(a, (tx) => tx.query(`INSERT INTO account_mapping (tenant_id, account_key, external_code) VALUES ($1, 'sales_revenue', '4000')`, [t.tenantId]));
    const m = await asActor(a, (tx) => createCreditMemo(tx, a, { customerId: c.id, facilityId: t.facilities.P1, reason: 'Price correction', lines: [{ description: 'Price adjustment', qty: 1, unitPrice: 75 }] }));
    await asActor(a, (tx) => issueCreditMemo(tx, a, blobs, m.id));
    await runSync(a);
    const f = (await db().query(`SELECT kind, content FROM export_file WHERE tenant_id = $1`, [t.tenantId])).rows;
    expect(f.map((x) => x.kind)).toEqual(['ar_credit_memos']);
    expect(f[0].content).toMatch(/CREATE,BRT,Bright Path,CM-\d{6}/);
    const { a: b } = await tenant(`cmy-${process.pid}-${Date.now() % 100000}`);
    await asActor(b, (tx) => createConnection(tx, b, { provider: 'mock_accounting' }));
    const c2 = await asActor(b, (tx) => createCustomer(tx, b, { code: 'X', name: 'X', kind: 'customer' }));
    await expect(asActor(b, (tx) => createCreditMemo(tx, b, { customerId: c2.id, reason: 'Anything', lines: [{ description: 'x', qty: 1, unitPrice: 1 }] }))).rejects.toThrow(/issued in the connected accounting system/);
  });
});
