import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { forgetEdition } from '../src/platform/edition.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { approveInvoice, captureInvoice, recordPayment as payBill } from '../src/modules/ap/service.js';
import { createInvoice, issueInvoice, recordPayment as receivePayment, voidInvoice } from '../src/modules/ar/service.js';
import { ACCOUNT_KEYS } from '../src/modules/integrations/accounts.js';
import { DEFAULT_CHART } from '../src/modules/books/chart.js';
import { balanceSheet, bringInOpenItems, setupBooks, trialBalance } from '../src/modules/books/service.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';

/**
 * The built-in books in the Standard edition (D-139): the same books, switched on by a company that already has
 * invoices and bills in the platform, with separation of duties as usual and opening balances from its old system.
 */
const db = () => getAdminPool();
const blobs = new LocalBlobStore('./.storage/test');
let app: Awaited<ReturnType<typeof buildApp>>;
let tenantId: string; let facility: string;
let admin: Actor; let finance: Actor;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const csv = (s: string) => Buffer.from(s.replace(/\n/g, '\r\n'));
const row = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => tb.rows.find((r) => r.code === code);

beforeAll(async () => {
  app = buildApp({ blobs }); // registers the inline delivery to the books
  const n = `std-books-${process.pid}-${Date.now() % 100000}`;
  const t = await provisionTenant(db(), { slug: n, name: 'Ridge Works', legalEntity: 'Ridge Works Inc', facilities: [{ code: 'P1', name: 'Plant 1', timezone: 'America/Chicago' }] });
  tenantId = t.tenantId; facility = t.facilities.P1!;
  const a = await createUserWithToken(db(), tenantId, { email: `admin@${n}.example`, displayName: 'Ada Admin', roles: [{ role: 'admin', facility: null }] });
  const f = await createUserWithToken(db(), tenantId, { email: `fin@${n}.example`, displayName: 'Finn Finance', roles: [{ role: 'finance_approver', facility: null }] });
  admin = (await loadActor(tenantId, a.userId))!; finance = (await loadActor(tenantId, f.userId))!;
  forgetEdition();
});
afterAll(async () => { await app.close(); await closePools(); });

describe('the built-in books in the Standard edition', () => {
  it('has an account in the starter chart for every platform account key, so every module can post', () => {
    const keys = new Set(DEFAULT_CHART.map((a) => a.key).filter(Boolean));
    expect(Object.keys(ACCOUNT_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });

  let open: any; let partly: any; let wrong: any; let bill: any; let customer: any;
  it('brings in what is still owed on invoices and bills recorded before the books started', async () => {
    customer = await asActor(admin, (tx) => createCustomer(tx, admin, { code: 'ACME', name: 'Acme Fabrication', kind: 'customer', paymentTerms: 'Net 30' }));
    const inv = (lines: any[], date: string) => asActor(admin, async (tx) => {
      const i = await createInvoice(tx, admin, { customerId: customer.id, facilityId: facility, lines });
      await issueInvoice(tx, admin, blobs, i.id, { invoiceDate: date });
      return i;
    });
    open = await inv([{ description: 'Machining', qty: 10, unitPrice: 50, accountKey: 'service_revenue' }], daysAgo(60));
    partly = await inv([{ description: 'Brackets', qty: 100, unitPrice: 3, accountKey: 'sales_revenue' }], daysAgo(50));
    wrong = await inv([{ description: 'Duplicate', qty: 1, unitPrice: 75 }], daysAgo(45));
    await asActor(admin, (tx) => receivePayment(tx, admin, { customerId: customer.id, receivedOn: daysAgo(40), amount: 100, method: 'check', allocations: [{ invoiceId: partly.id, amount: 100 }] }));
    const sup = await asActor(admin, (tx) => createSupplier(tx, admin, { code: 'MSC', name: 'MSC Industrial', paymentTerms: 'Net 30' }));
    bill = await asActor(admin, (tx) => captureInvoice(tx, admin, null, { supplierId: sup.id, facilityId: facility, invoiceNumber: 'M-901', invoiceDate: daysAgo(10), dueDate: daysAgo(-20),
      lines: [{ description: 'End mills', qty: 4, unitPrice: 62.5, accountKey: 'maintenance_expense' }], freightAmount: 15 }));
    // Standard keeps separation of duties: the admin who captured the bill cannot approve it.
    await expect(asActor(admin, (tx) => approveInvoice(tx, admin, bill.id))).rejects.toThrow();
    await asActor(finance, (tx) => approveInvoice(tx, finance, bill.id, { varianceNote: 'Tooling bought on a card order, no PO' }));

    const setup = await asActor(admin, (tx) => setupBooks(tx, admin, { startDate: daysAgo(30), openingBalance: 25_000 }));
    expect(setup.openItems).toEqual({ posted: 4, receivable: 775, payable: 265, reimbursement: 0 });
    const tb = await asActor(admin, (tx) => trialBalance(tx, admin));
    expect(tb.balanced).toBe(true);
    expect(row(tb, '1100')!.debit).toBe(775); // 500 + (300 - 100) + 75
    expect(row(tb, '2000')!.credit).toBe(265);
    // The bill is dated after the start, so it is brought in on its own date.
    const memos = (await db().query(`SELECT memo, entry_date::text AS d FROM journal_entry WHERE tenant_id = $1 AND source = 'ap_bill'`, [tenantId])).rows;
    expect(memos).toEqual([{ memo: 'Brought in: Bill M-901 (MSC Industrial)', d: daysAgo(10) }]);
    expect(await asActor(admin, (tx) => bringInOpenItems(tx, admin))).toEqual({ posted: 0, receivable: 0, payable: 0, reimbursement: 0 });
  });

  it('later payments settle the brought-in items and a void reverses one', async () => {
    await asActor(admin, (tx) => receivePayment(tx, admin, { customerId: customer.id, receivedOn: daysAgo(2), amount: 700, method: 'ach',
      allocations: [{ invoiceId: open.id, amount: 500 }, { invoiceId: partly.id, amount: 200 }] }));
    await asActor(admin, (tx) => voidInvoice(tx, admin, wrong.id, 'Billed twice'));
    await asActor(finance, (tx) => payBill(tx, finance, bill.id, { paidOn: daysAgo(1), amount: 265, reference: 'ACH 77' }));
    const tb = await asActor(admin, (tx) => trialBalance(tx, admin));
    expect(tb.balanced).toBe(true);
    expect(row(tb, '1100')).toBeUndefined();
    expect(row(tb, '2000')).toBeUndefined();
    expect(row(tb, '1000')!.debit).toBe(25_000 + 700 - 265);
  });

  it('imports the old system\'s trial balance in its own layout; again changes nothing; a corrected amount replaces it', async () => {
    // A QuickBooks-style export: title lines, "number · name" labels, debit and credit columns, a total line.
    const file = (equipment: string) => csv(`Ridge Works Inc\nTrial Balance\nAs of ${daysAgo(31)}\n\nAccount,Debit,Credit\n1510 · Shop equipment,${equipment},\n1100 · Accounts receivable,775.00,\n` +
      `2510 · Equipment loan,,30000.00\n3900 · Retained earnings,,12500.00\nTOTAL,${equipment},42500.00\n`);
    const mapping = { fields: { account: { source: 'Account' }, debit: { source: 'Debit' }, credit: { source: 'Credit' } } };
    let staged = await stageImport(admin, { target: 'opening_balances', sourceSystem: 'quickbooks', fileName: 'tb.csv', content: file('42500.00'), mapping });
    const problems = staged.problems.map((p: any) => p.messages.map((m: any) => m.message).join('; ')).join(' | ');
    expect(problems).toMatch(/control account/);
    expect(problems).toMatch(/no account "1510 · Shop equipment" in the chart/);
    // The new accounts need a type: add a column, as a customer would fix their file.
    const typed = (eq: string) => csv(`Account,Type,Debit,Credit\n1510 · Shop equipment,Fixed Asset,${eq},\n2510 · Equipment loan,Long Term Liability,,30000.00\n3900 · Retained earnings,Equity,,12500.00\n`);
    const tmap = { fields: { ...mapping.fields, type: { source: 'Type' } } };
    staged = await stageImport(admin, { target: 'opening_balances', sourceSystem: 'quickbooks', fileName: 'tb.csv', content: typed('42500.00'), mapping: tmap });
    expect(staged.stats).toMatchObject({ errors: 0, toCreate: 3 });
    await commitImport(admin, staged.batchId);
    let bs = await asActor(admin, (tx) => balanceSheet(tx, admin));
    expect(bs.balanced ?? true).toBe(true);
    let tb = await asActor(admin, (tx) => trialBalance(tx, admin));
    expect(tb.balanced).toBe(true);
    expect(row(tb, '1510')!.debit).toBe(42_500);
    // Again: nothing to do.
    staged = await stageImport(admin, { target: 'opening_balances', sourceSystem: 'quickbooks', fileName: 'tb.csv', content: typed('42500.00'), mapping: tmap });
    expect(staged.stats).toMatchObject({ toCreate: 0, toUpdate: 0 });
    // A corrected equipment figure replaces the earlier opening entry.
    staged = await stageImport(admin, { target: 'opening_balances', sourceSystem: 'quickbooks', fileName: 'tb.csv', content: typed('43000.00'), mapping: tmap });
    expect(staged.stats).toMatchObject({ toUpdate: 1 });
    await commitImport(admin, staged.batchId);
    tb = await asActor(admin, (tx) => trialBalance(tx, admin));
    expect(row(tb, '1510')!.debit).toBe(43_000);
    expect(tb.balanced).toBe(true);
    bs = await asActor(admin, (tx) => balanceSheet(tx, admin));
    expect(bs).toBeTruthy();
  });

  it('reads the sample QuickBooks Desktop export with its saved mapping', async () => {
    const { readFile } = await import('node:fs/promises');
    const profile = JSON.parse(await readFile('samples/imports/kessler/profiles/trial-balance-qbd.json', 'utf8'));
    const staged = await stageImport(admin, { target: 'opening_balances', sourceSystem: profile.sourceSystem, fileName: 'tb.csv',
      content: await readFile('samples/imports/kessler/prior_trial_balance_qbd.csv'), mapping: profile.mapping });
    expect(staged.stats).toMatchObject({ total: 9, errors: 2 }); // receivables and payables refused
    expect(staged.preview.find((p: any) => /Savings/.test(String(p.values?.account ?? p.source?.['Column 1'] ?? '')))).toBeTruthy();
  });
});
