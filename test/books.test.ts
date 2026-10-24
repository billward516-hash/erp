import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { forgetEdition } from '../src/platform/edition.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { approveInvoice, captureInvoice, recordPayment as payBill } from '../src/modules/ap/service.js';
import { createInvoice, issueInvoice, recordPayment as receivePayment, voidInvoice } from '../src/modules/ar/service.js';
import { postingFor } from '../src/modules/books/posting.js';
import {
  addBankLine, balanceSheet, categorizeBankLine, excludeBankLine, finishReconciliation, getReconciliation, listAccounts, manualEntry, matchBankLine, overview, profitAndLoss, reviewQueue,
  ruleFor, saveSettings, setCleared, setupBooks, startReconciliation, trialBalance,
} from '../src/modules/books/service.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createReport, markPaid, saveLine, submitReport } from '../src/modules/expenses/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import { expenseRules, saveExpensePolicy } from '../src/modules/policies/service.js';

describe('posting rules (pure)', () => {
  it('an issued invoice debits receivables and credits income, freight and sales tax', () => {
    const p = postingFor('ar.invoice.issued', { invoiceNumber: 'INV-1', invoiceDate: '2026-10-01', customer: { name: 'Acme' }, freightAmount: 20, taxAmount: 8,
      lines: [{ description: 'Service call', qty: 2, unitPrice: 50, amount: 100, accountKey: 'service_revenue' }] })!;
    expect(p.lines.map((l) => [l.key, l.debit ?? 0, l.credit ?? 0])).toEqual([['accounts_receivable', 128, 0], ['service_revenue', 0, 100], ['freight_income', 0, 20], ['sales_tax_payable', 0, 8]]);
  });
  it('an approved expense report debits each expense and credits the employee', () => {
    const p = postingFor('expense.report.approved', { invoiceNumber: 'EXP-1', invoiceDate: '2026-10-02', supplier: { name: 'Kai' },
      lines: [{ description: 'Hotel', amount: 150, accountKey: 'travel_expense' }, { description: 'Lunch', amount: 30.55, accountKey: 'meals_entertainment' }] })!;
    expect(p.lines.map((l) => [l.key, l.debit ?? 0, l.credit ?? 0])).toEqual([['travel_expense', 150, 0], ['meals_entertainment', 30.55, 0], ['employee_reimbursement', 0, 180.55]]);
  });
  it('bank rules: direction, priority and the longest match', () => {
    const rules = [{ id: 'a', contains: 'shell', direction: 'out', account_id: 'fuel', priority: 100 }, { id: 'b', contains: 'shell oil refund', direction: 'in', account_id: 'other', priority: 100 },
      { id: 'c', contains: 'fee', direction: 'any', account_id: 'bank_fees', priority: 10 }];
    expect(ruleFor(rules, 'SHELL OIL 4411', -45)?.account_id).toBe('fuel');
    expect(ruleFor(rules, 'Shell Oil Refund', 12)?.account_id).toBe('other');
    expect(ruleFor(rules, 'Monthly fee shell', -5)?.account_id).toBe('bank_fees');
    expect(ruleFor(rules, 'Payroll', -500)).toBeNull();
  });
});

const db = () => getAdminPool();
const blobs = new LocalBlobStore('./.storage/test');
let app: FastifyInstance;
let tenantId: string; let facility: string;
let owner: Actor; let ownerToken: string;
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = buildApp({ blobs });
  const n = `lite-${process.pid}-${Date.now() % 100000}`;
  const t = await provisionTenant(db(), { slug: n, name: 'Kessler Tool', legalEntity: 'Kessler Tool LLC', edition: 'lite', facilities: [{ code: 'SHOP', name: 'Shop', timezone: 'America/Chicago', kind: 'office' }] });
  tenantId = t.tenantId; facility = t.facilities.SHOP!;
  const u = await createUserWithToken(db(), tenantId, { email: `kai@${n}.example`, displayName: 'Kai Kessler', roles: [{ role: 'admin', facility: null }] });
  owner = (await loadActor(tenantId, u.userId))!; ownerToken = u.token;
  forgetEdition();
});
afterAll(async () => { await app.close(); await closePools(); });

describe('the Lite edition', () => {
  it('allows one site and five users, enforced by the database', async () => {
    const le = (await db().query('SELECT id FROM legal_entity WHERE tenant_id = $1', [tenantId])).rows[0].id;
    await expect(db().query(`INSERT INTO facility (tenant_id, legal_entity_id, code, name) VALUES ($1, $2, 'B', 'Second')`, [tenantId, le])).rejects.toThrow(/the lite edition includes 1 site; upgrade/);
    for (let i = 2; i <= 5; i++) await createUserWithToken(db(), tenantId, { email: `u${i}@${tenantId}.example`, displayName: `User ${i}`, roles: [{ role: 'operator', facility }] });
    await expect(createUserWithToken(db(), tenantId, { email: `u6@${tenantId}.example`, displayName: 'User 6', roles: [] })).rejects.toThrow(/5 of 5 users are active, the most the lite edition includes/);
  });

  it('answers outside its areas with an upgrade message, and lists only its reports', async () => {
    const h = { authorization: `Bearer ${ownerToken}` };
    const assets = await app.inject({ method: 'GET', url: '/api/assets', headers: h });
    expect(assets.statusCode).toBe(403);
    expect(assets.json().error).toMatchObject({ code: 'edition', message: expect.stringMatching(/Standard edition/) });
    expect((await app.inject({ method: 'GET', url: '/api/reports/maintenance-backlog', headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/expenses', headers: h })).statusCode).toBe(200);
    const reports = (await app.inject({ method: 'GET', url: '/api/reports', headers: h })).json().map((r: any) => r.id).sort();
    expect(reports).toEqual(['ap-aging', 'ar-aging', 'balance-sheet', 'cash-flow', 'expense-summary', 'profit-and-loss']);
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json();
    expect(me).toMatchObject({ edition: 'lite', limits: { users: 5, sites: 1, usersActive: 5 } });
  });
});

describe('the built-in books for a sole owner', () => {
  let bank: string; let acct: Record<string, string>;
  it('sets up a chart, an opening balance and the books as the accounting connection', async () => {
    await asActor(owner, (tx) => setupBooks(tx, owner, { startDate: daysAgo(40), bankName: 'First Bank checking', bankLast4: '4412', openingBalance: 10_000 }));
    const accounts = await asActor(owner, (tx) => listAccounts(tx, owner));
    acct = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    bank = acct['1000']!;
    expect(accounts.find((a) => a.code === '1000')).toMatchObject({ name: 'First Bank checking', balance: 10_000 });
    expect((await db().query(`SELECT provider FROM integration_connection WHERE tenant_id = $1 AND active`, [tenantId])).rows[0].provider).toBe('native_books');
    await expect(asActor(owner, (tx) => setupBooks(tx, owner, {}))).rejects.toThrow(/already set up/);
  });

  let inv: any; let customer: any;
  it('an invoice posts when issued, its payment when received, and a void reverses it', async () => {
    customer = await asActor(owner, (tx) => createCustomer(tx, owner, { code: 'BRT', name: 'Bright Path Builders', kind: 'customer', paymentTerms: 'Net 30' }));
    inv = await asActor(owner, (tx) => createInvoice(tx, owner, { customerId: customer.id, lines: [{ description: 'Fixture repair', qty: 4, unitPrice: 95 }, { description: 'Parts', qty: 1, unitPrice: 120, accountKey: 'sales_revenue' }], taxAmount: 8.4 }));
    await asActor(owner, (tx) => issueInvoice(tx, owner, blobs, inv.id, { invoiceDate: daysAgo(20) }));
    let tb = await asActor(owner, (tx) => trialBalance(tx, owner));
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.code === '1100')).toMatchObject({ debit: 508.4 });
    expect(tb.rows.find((r) => r.code === '4100')).toMatchObject({ credit: 380 });
    expect(tb.rows.find((r) => r.code === '2200')).toMatchObject({ credit: 8.4 });
    await asActor(owner, (tx) => receivePayment(tx, owner, { customerId: customer.id, receivedOn: daysAgo(5), amount: 508.4, method: 'check', reference: '1047', allocations: [{ invoiceId: inv.id, amount: 508.4 }] }));
    tb = await asActor(owner, (tx) => trialBalance(tx, owner));
    expect(tb.rows.find((r) => r.code === '1100')).toBeUndefined(); // receivable settled
    expect(tb.rows.find((r) => r.code === '1000')!.debit).toBe(10_508.4);
    // A second invoice, issued then voided: the reversal leaves no trace in the balances.
    const v = await asActor(owner, (tx) => createInvoice(tx, owner, { customerId: customer.id, lines: [{ description: 'Wrong customer', qty: 1, unitPrice: 300 }] }));
    await asActor(owner, (tx) => issueInvoice(tx, owner, blobs, v.id));
    await asActor(owner, (tx) => voidInvoice(tx, owner, v.id, 'Billed the wrong customer'));
    const entries = (await db().query(`SELECT memo, reverses_id IS NOT NULL AS reversal FROM journal_entry WHERE tenant_id = $1 AND source_id = $2 ORDER BY created_at`, [tenantId, v.id])).rows;
    expect(entries.map((e) => e.reversal)).toEqual([false, true]);
    expect((await asActor(owner, (tx) => trialBalance(tx, owner))).rows.find((r) => r.code === '1100')).toBeUndefined();
  });

  it('the only person in the company approves their own bill and expenses (audited); payments post', async () => {
    const sup = await asActor(owner, (tx) => createSupplier(tx, owner, { code: 'GRN', name: 'Grainger', paymentTerms: 'Net 30' }));
    const bill = await asActor(owner, (tx) => captureInvoice(tx, owner, null, { supplierId: sup.id, facilityId: facility, invoiceNumber: 'G-77', invoiceDate: daysAgo(10), dueDate: daysAgo(-20),
      lines: [{ description: 'Shop supplies', qty: 1, unitPrice: 240, accountKey: 'supplies_expense' }] }));
    // Five users exist, but only the owner holds ap.manage, so they may approve what they captured.
    await asActor(owner, (tx) => approveInvoice(tx, owner, bill.id));
    await asActor(owner, (tx) => payBill(tx, owner, bill.id, { paidOn: daysAgo(3), amount: 240, reference: 'ACH 5531' }));
    await asActor(owner, (tx) => saveExpensePolicy(tx, owner, { receiptRequiredOver: 1000, mileageRate: 0.7 }));
    const cats = Object.fromEntries((await asActor(owner, (tx) => expenseRules(tx))).categories.map((c: any) => [c.code, c.id]));
    const rep = await asActor(owner, (tx) => createReport(tx, owner, { title: 'Supplier visit' }));
    await asActor(owner, (tx) => saveLine(tx, owner, rep.id, { spentOn: daysAgo(8), categoryId: cats.MILEAGE, miles: 100, description: 'Shop to Grainger and back' }));
    await asActor(owner, (tx) => submitReport(tx, owner, rep.id));
    const step = (await asActor(owner, (tx) => myApprovalQueue(tx, owner))).find((s) => s.subject_id === rep.id)!;
    expect(step.label).toBe('Owner approval');
    await asActor(owner, (tx) => decideApproval(tx, owner, step.step_id, { decision: 'approve' }));
    const audit = (await db().query(`SELECT data FROM audit_event WHERE tenant_id = $1 AND action = 'approval.approved' ORDER BY occurred_at DESC LIMIT 1`, [tenantId])).rows[0].data;
    expect(audit).toMatchObject({ selfApproved: true });
    await asActor(owner, (tx) => markPaid(tx, owner, rep.id, { paidOn: daysAgo(2), method: 'direct_deposit' }));
    const tb = await asActor(owner, (tx) => trialBalance(tx, owner));
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.code === '6300')!.debit).toBe(240);
    expect(tb.rows.find((r) => r.code === '6500')!.debit).toBe(70);
    expect(tb.rows.find((r) => r.code === '2000')).toBeUndefined(); // bill paid
    expect(tb.rows.find((r) => r.code === '2150')).toBeUndefined(); // reimbursed
    expect(tb.rows.find((r) => r.code === '1000')!.debit).toBe(10_198.4);
  });

  it('bank lines match recorded payments, categorize with rules, and reconcile to the cent', async () => {
    const line = async (d: number, description: string, amount: number) => asActor(owner, (tx) => addBankLine(tx, owner, { bankAccountId: bank, postedOn: daysAgo(d), description, amount, sourceSystem: 'firstbank-csv', ref: `${d}|${description}` }));
    await line(4, 'MOBILE DEPOSIT CHECK 1047', 508.4);
    await line(3, 'ACH GRAINGER 5531', -240);
    await line(2, 'MONTHLY SERVICE FEE', -15);
    await line(1, 'TRANSFER FROM SAVINGS', 1000);
    expect((await line(2, 'MONTHLY SERVICE FEE', -15)).created).toBe(false); // re-import adds nothing
    let q = await asActor(owner, (tx) => reviewQueue(tx, owner, { status: 'unreviewed' }));
    expect(q).toHaveLength(4);
    const dep = q.find((x) => x.amount === 508.4)!;
    expect(dep.matches.map((m: any) => m.party)).toEqual(['Bright Path Builders']);
    await asActor(owner, (tx) => matchBankLine(tx, owner, dep.id, dep.matches[0].id));
    const ach = q.find((x) => x.amount === -240)!;
    await asActor(owner, (tx) => matchBankLine(tx, owner, ach.id, ach.matches[0].id));
    const fee = q.find((x) => x.amount === -15)!;
    await expect(asActor(owner, (tx) => categorizeBankLine(tx, owner, fee.id, { accountId: acct['1100']! }))).rejects.toThrow(/from the invoice or bill/);
    await asActor(owner, (tx) => categorizeBankLine(tx, owner, fee.id, { accountId: acct['6100']!, remember: 'SERVICE FEE' }));
    // The rule now suggests the account for the next fee.
    const next = await line(0, 'MONTHLY SERVICE FEE OCT', -15);
    q = await asActor(owner, (tx) => reviewQueue(tx, owner, { status: 'unreviewed' }));
    expect(q.find((x) => x.id === next.id)).toMatchObject({ suggested_code: '6100' });
    await asActor(owner, (tx) => excludeBankLine(tx, owner, q.find((x) => x.amount === 1000)!.id, 'Savings transfer recorded by the accountant'));
    // Reconcile to a statement dated two days ago: opening 10,000 + 508.40 − 240 − 15 (the reimbursement is not on this statement).
    const rec = await asActor(owner, (tx) => startReconciliation(tx, owner, { bankAccountId: bank, statementDate: daysAgo(2), statementBalance: 10_253.4 }));
    let g = await asActor(owner, (tx) => getReconciliation(tx, owner, rec.id));
    expect(g.difference).toBe(10_000); // the opening balance entry is not cleared yet
    await expect(asActor(owner, (tx) => finishReconciliation(tx, owner, rec.id))).rejects.toThrow(/differs from the statement .* by 10000.00/);
    const opening = g.lines.find((l: any) => l.debit === 10_000)!;
    await asActor(owner, (tx) => setCleared(tx, owner, rec.id, { lineIds: [opening.id], cleared: true }));
    g = await asActor(owner, (tx) => getReconciliation(tx, owner, rec.id));
    expect(g).toMatchObject({ cleared: 10_253.4, difference: 0 });
    await asActor(owner, (tx) => finishReconciliation(tx, owner, rec.id));
  });

  it('statements balance; a closed period refuses entries; the overview answers', async () => {
    const pl = await asActor(owner, (tx) => profitAndLoss(tx, owner, { from: daysAgo(60), to: today }));
    expect(pl).toMatchObject({ income: 500, netIncome: 500 - 240 - 70 - 15 });
    const bs = await asActor(owner, (tx) => balanceSheet(tx, owner));
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets).toBe(10_000 + 500 + 8.4 - 240 - 70 - 15);
    await asActor(owner, (tx) => saveSettings(tx, owner, { closedThrough: daysAgo(7) }));
    await expect(asActor(owner, (tx) => manualEntry(tx, owner, { date: daysAgo(10), memo: 'Late adjustment', lines: [{ accountId: acct['6100']!, debit: 5 }, { accountId: bank, credit: 5 }] })))
      .rejects.toThrow(/closed through/);
    await expect(asActor(owner, (tx) => manualEntry(tx, owner, { date: today, memo: 'Unbalanced', lines: [{ accountId: acct['6100']!, debit: 5 }, { accountId: bank, credit: 4 }] })))
      .rejects.toThrow(/must be equal/);
    await expect(db().query(`UPDATE journal_line SET debit = 1 WHERE tenant_id = $1 AND debit > 0`, [tenantId])).rejects.toThrow(/cannot be changed/);
    const o = await asActor(owner, (tx) => overview(tx, owner)) as any;
    expect(o).toMatchObject({ active: true, toReview: 1, postingProblems: 0 });
    expect(o.bank[0]).toMatchObject({ name: 'First Bank checking', last4: '4412' });
  });
});
