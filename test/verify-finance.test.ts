import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { approveInvoice, captureInvoice, recordPayment as payBill } from '../src/modules/ap/service.js';
import { amounts, createInvoice, issueInvoice, recordPayment } from '../src/modules/ar/service.js';
import { createCreditMemo, issueCreditMemo, refundCredit } from '../src/modules/ar/credit-memos.js';
import { saveAccount, setupBooks } from '../src/modules/books/service.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import { activateLease, createLease, renewLease, saveRentalUnit } from '../src/modules/leasing/service.js';
import { saveSite } from '../src/modules/sites/service.js';
import { createPayrollExport, weekStartOf } from '../src/modules/time/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Finance findings from the verification pass (D-161). */
const db = () => getAdminPool();
const blobs = new LocalBlobStore(path.join(os.tmpdir(), `erp-vfyfin-${process.pid}`));
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let app: FastifyInstance; let w: World; let customer: any; let supplier: any; let clerkA: Actor;
const acct = async (code: string) => (await db().query('SELECT id FROM ledger_account WHERE tenant_id = $1 AND code = $2', [w.tenantId, code])).rows[0].id as string;
const invoice = (lines: any[], date = day(-5)) => asActor(w.admin, async (tx) => {
  const i = await createInvoice(tx, w.admin, { customerId: customer.id, facilityId: w.facilities.A!, lines });
  await issueInvoice(tx, w.admin, blobs, i.id, { invoiceDate: date });
  return i;
});

beforeAll(async () => {
  app = buildApp({ blobs }); // registers the inline delivery to the books
  w = await makeWorld('vfyfin');
  const u = await createUserWithToken(db(), w.tenantId, { email: `clerk-${Date.now()}@vf.example`, displayName: 'Clerk A', roles: [{ role: 'ap_clerk', facility: w.facilities.A! }] });
  clerkA = (await loadActor(w.tenantId, u.userId))!;
  customer = await asActor(w.admin, (tx) => createCustomer(tx, w.admin, { code: 'ACME', name: 'Acme Fabrication', kind: 'customer', paymentTerms: 'Net 30' }));
  supplier = await asActor(w.admin, (tx) => createSupplier(tx, w.admin, { code: 'MSC', name: 'MSC Industrial', paymentTerms: 'Net 30' }));
});
afterAll(async () => { await app.close(); await closePools(); });

describe('opening items', () => {
  it('credit a customer still holds when the books start lowers receivables', async () => {
    await invoice([{ description: 'Machining', qty: 10, unitPrice: 50 }], day(-40));
    const m = await asActor(w.admin, (tx) => createCreditMemo(tx, w.admin, { customerId: customer.id, facilityId: w.facilities.A!, reason: 'Goodwill credit',
      lines: [{ description: 'Goodwill', qty: 1, unitPrice: 60, accountKey: 'sales_revenue' }] }));
    await asActor(w.admin, (tx) => issueCreditMemo(tx, w.admin, blobs, m.id, { memoDate: day(-35) }));
    await asActor(w.admin, (tx) => refundCredit(tx, w.admin, m.id, { amount: 20, paidOn: day(-34), method: 'check' }));
    const s = await asActor(w.admin, (tx) => setupBooks(tx, w.admin, { startDate: day(-30), openingBalance: 1000 }));
    expect(s.openItems).toMatchObject({ posted: 2, receivable: 460 }); // 500 owed less the 40 of credit left
  });
});

describe('receivables', () => {
  it('the receivable the books post equals the invoice total, to the cent', async () => {
    const i = await invoice([1, 2, 3].map((n) => ({ description: `Part ${n}`, qty: 1, unitPrice: 1.005 })));
    const total = (await asActor(w.admin, (tx) => amounts(tx, i.id))).total;
    const posted = (await db().query(`SELECT sum(l.debit)::float AS d, sum(l.credit)::float AS c FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
      WHERE e.tenant_id = $1 AND e.idempotency_key = $2`, [w.tenantId, `invoice:${i.id}:issued`])).rows[0];
    expect(posted).toEqual({ d: total, c: total });
  });

  it('payments are kept to the cent, name each invoice once and pay from a bank account', async () => {
    const i = await invoice([{ description: 'Brackets', qty: 4, unitPrice: 25 }]);
    const base = { customerId: customer.id, receivedOn: day(-1), method: 'check' as const };
    const [ar, bank] = [await acct('1100'), await acct('1000')];
    await expect(asActor(w.admin, (tx) => recordPayment(tx, w.admin, { ...base, amount: 20, allocations: [{ invoiceId: i.id, amount: 10 }, { invoiceId: i.id, amount: 10 }] })))
      .rejects.toThrow(/appears once/);
    await expect(asActor(w.admin, (tx) => recordPayment(tx, w.admin, { ...base, amount: 10, allocations: [{ invoiceId: i.id, amount: 10 }], bankAccountId: ar })))
      .rejects.toThrow(/bank or card account/);
    const p = await asActor(w.admin, (tx) => recordPayment(tx, w.admin, { ...base, amount: 10.004, allocations: [{ invoiceId: i.id, amount: 10.004 }], bankAccountId: bank }));
    expect(Number(p.amount)).toBe(10);
  });

  it('two credit memos against one invoice issued at once cannot credit more than it billed', async () => {
    const i = await invoice([{ description: 'Housing', qty: 1, unitPrice: 100 }]);
    const memo = () => asActor(w.admin, (tx) => createCreditMemo(tx, w.admin, { customerId: customer.id, invoiceId: i.id, reason: 'Returned', lines: [{ description: 'Housing', qty: 1, unitPrice: 70 }] }));
    const [a, b] = [await memo(), await memo()];
    const r = await Promise.allSettled([a, b].map((m) => asActor(w.admin, (tx) => issueCreditMemo(tx, w.admin, blobs, m.id))));
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already credited/);
  });
});

describe('payables', () => {
  it('a bill is paid only in full, from a bank account', async () => {
    const bill = await asActor(w.admin, (tx) => captureInvoice(tx, w.admin, null, { supplierId: supplier.id, facilityId: w.facilities.A!, invoiceNumber: 'M-1', invoiceDate: day(-3),
      lines: [{ description: 'End mills', qty: 4, unitPrice: 25, accountKey: 'maintenance_expense' }], freightAmount: 5 }));
    await asActor(w.finance, (tx) => approveInvoice(tx, w.finance, bill.id, { varianceNote: 'no PO' }));
    const pay = (amount: number, bankAccountId?: string) => asActor(w.finance, (tx) => payBill(tx, w.finance, bill.id, { paidOn: day(-1), amount, bankAccountId }));
    await expect(pay(5000)).rejects.toThrow(/bill's total of 105\.00/);
    await expect(pay(50)).rejects.toThrow(/part payments/);
    await expect(pay(105, await acct('2000'))).rejects.toThrow(/bank or card account/);
    await pay(105, await acct('1000'));
    expect((await db().query('SELECT status, paid_amount::float AS a FROM supplier_invoice WHERE id = $1', [bill.id])).rows[0]).toEqual({ status: 'paid', a: 105 });
  });

  it('an invoice number already captured at a site the clerk cannot see is refused plainly; account keys must exist', async () => {
    const input = { supplierId: supplier.id, invoiceNumber: 'X-77', invoiceDate: day(-2), lines: [{ description: 'Gloves', qty: 1, unitPrice: 12 }] };
    await asActor(w.admin, (tx) => captureInvoice(tx, w.admin, null, { ...input, facilityId: w.facilities.B! }));
    await expect(asActor(clerkA, (tx) => captureInvoice(tx, clerkA, null, { ...input, facilityId: w.facilities.A! }))).rejects.toThrow(/already captured at another site/);
    await expect(asActor(clerkA, (tx) => captureInvoice(tx, clerkA, null, { ...input, invoiceNumber: 'X-78', facilityId: w.facilities.A!, lines: [{ ...input.lines[0]!, accountKey: 'toString' }] })))
      .rejects.toThrow(/unknown account/);
  });
});

describe('the books', () => {
  it('an account kind must fit its type, and codes are unique', async () => {
    await expect(asActor(w.admin, (tx) => saveAccount(tx, w.admin, { code: '6999', name: 'Odd', type: 'expense', subtype: 'bank' }))).rejects.toThrow(/an expense account is one of/);
    await expect(asActor(w.admin, (tx) => saveAccount(tx, w.admin, { code: '1000', name: 'Second checking', type: 'asset', subtype: 'bank' }))).rejects.toThrow(/already exists/);
  });
});

describe('payroll', () => {
  it('two exports of the same weeks at once: one writes the file, the other is refused', async () => {
    const week = weekStartOf(day(-14));
    const t = (await db().query(`INSERT INTO timesheet (tenant_id, facility_id, employee_id, week_start, status) VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
      [w.tenantId, w.facilities.A!, w.techAEmployeeId, week])).rows[0].id;
    await db().query(`INSERT INTO time_entry (tenant_id, timesheet_id, work_date, earning_code, hours, source, created_by) VALUES ($1, $2, $3, 'REG', 8, 'manual', $4)`,
      [w.tenantId, t, week, w.admin.userId]);
    await db().query(`UPDATE timesheet SET status = 'approved' WHERE id = $1`, [t]);
    const r = await Promise.allSettled([1, 2].map(() => asActor(w.admin, (tx) => createPayrollExport(tx, w.admin, { from: week, to: week }))));
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await db().query('SELECT count(*)::int AS n FROM payroll_export WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(1);
  });
});

describe('leases', () => {
  it('a renewal keeps the dates of the charges it carries over', async () => {
    const site = await asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'ELM', name: 'Elm Court', kind: 'property' }));
    const a = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site.id, assetTag: 'ELM-1', name: 'Unit 1', assetClass: 'space' }));
    const unit = await asActor(w.admin, (tx) => saveRentalUnit(tx, w.admin, { assetId: a.id, marketRent: 1000 }));
    const l = await asActor(w.admin, (tx) => createLease(tx, w.admin, { unitId: unit.id, startDate: day(-200), endDate: day(10), rentAmount: 1000, renter: { name: 'Jo Park' },
      charges: [{ description: 'Parking', amount: 40 }, { description: 'Pet rent', amount: 25, startsOn: day(30), endsOn: day(200) }, { description: 'Storage', amount: 15, endsOn: day(-5) }] }));
    await asActor(w.admin, (tx) => activateLease(tx, w.admin, l.id));
    const n = await asActor(w.admin, (tx) => renewLease(tx, w.admin, l.id, { endDate: day(375), rentAmount: 1050 }));
    const c = (await db().query(`SELECT description, starts_on::text AS s, ends_on::text AS e FROM lease_charge WHERE lease_id = $1 ORDER BY description`, [n.id])).rows;
    expect(c).toEqual([{ description: 'Parking', s: null, e: null }, { description: 'Pet rent', s: day(30), e: day(200) }]);
  });
});
