import type { Actor } from '../src/platform/auth/actor.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import type { BlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { approveInvoice, captureInvoice, recordPayment as payBill } from '../src/modules/ap/service.js';
import { createInvoice, issueInvoice, recordPayment as receivePayment } from '../src/modules/ar/service.js';
import { createCreditMemo, issueCreditMemo } from '../src/modules/ar/credit-memos.js';
import { categorizeBankLine, listAccounts, matchBankLine, reviewQueue, saveAccount, saveRule, setupBooks } from '../src/modules/books/service.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createReport, markPaid, saveLine, submitReport } from '../src/modules/expenses/service.js';
import { postAnnouncement } from '../src/modules/intranet/service.js';
import { expenseRules, installTemplates, saveExpensePolicy } from '../src/modules/policies/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import { log, runImportContent } from './seed-lib.js';

/**
 * Kessler Tool & Repair: a three-person repair shop on the Lite edition (D-135) with the built-in books. Two months of
 * invoices, bills, an expense report and a bank statement in the bank's own CSV layout, partly reviewed.
 */
export async function seedKessler(blobs: BlobStore) {
  const db = getAdminPool();
  const t = await provisionTenant(db, { slug: 'kessler', name: 'Kessler Tool & Repair', legalEntity: 'Kessler Tool & Repair LLC', edition: 'lite',
    facilities: [{ code: 'SHOP', name: 'Kessler shop', timezone: 'America/Chicago', kind: 'office' }] });
  const tokens: Record<string, string> = {};
  const mk = async (key: string, email: string, name: string, roles: { role: string; facility: string | null }[]) => {
    const u = await createUserWithToken(db, t.tenantId, { email, displayName: name, roles });
    tokens[key] = u.token;
    return (await loadActor(t.tenantId, u.userId))!;
  };
  const kai = await mk('kai (Lite: owner, Kessler)', 'kai@kessler.example', 'Kai Kessler', [{ role: 'admin', facility: null }]);
  const rosa = await mk('rosa (Lite: bookkeeper, Kessler)', 'rosa@kessler.example', 'Rosa Diaz', [{ role: 'bookkeeper', facility: null }]);
  const jo = await mk('jo (Lite: technician, Kessler)', 'jo@kessler.example', 'Jo Marsh', [{ role: 'operator', facility: t.facilities.SHOP! }]);
  const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  log('Kessler (Lite): books, invoices, bills, expenses');
  await asActor(kai, (tx) => setupBooks(tx, kai, { startDate: d(60), bankName: 'Checking', bankLast4: '4412', openingBalance: 18_500 }));
  const acct = Object.fromEntries((await asActor(kai, (tx) => listAccounts(tx, kai))).map((a) => [a.code, a.id]));
  await asActor(kai, (tx) => saveAccount(tx, kai, { code: '6560', name: 'Vehicle fuel', type: 'expense', subtype: 'expense' }));
  const fuel = (await asActor(kai, (tx) => listAccounts(tx, kai))).find((a) => a.code === '6560')!.id;
  const cust = await asActor(rosa, async (tx) => ({
    bright: await createCustomer(tx, rosa, { code: 'BRT', name: 'Bright Path Builders', kind: 'customer', paymentTerms: 'Net 30' }),
    dental: await createCustomer(tx, rosa, { code: 'LVD', name: 'Lakeview Dental', kind: 'customer', paymentTerms: 'Net 15' }),
    river: await createCustomer(tx, rosa, { code: 'RSA', name: 'Riverside Apartments', kind: 'customer', paymentTerms: 'Net 30' }),
  }));
  const invoice = async (c: string, date: string, lines: { description: string; qty: number; unitPrice: number; accountKey?: string }[], tax = 0) => asActor(rosa, async (tx) => {
    const i = await createInvoice(tx, rosa, { customerId: c, lines, taxAmount: tax });
    await issueInvoice(tx, rosa, blobs, i.id, { invoiceDate: date });
    return i;
  });
  const i1 = await invoice(cust.bright.id, d(45), [{ description: 'Compressor rebuild', qty: 1, unitPrice: 1450 }, { description: 'Seal kit and filters', qty: 1, unitPrice: 400, accountKey: 'sales_revenue' }]);
  const i2 = await invoice(cust.river.id, d(52), [{ description: 'Boiler pump service call', qty: 4, unitPrice: 95 }, { description: 'Pump coupling', qty: 1, unitPrice: 600, accountKey: 'sales_revenue' }]);
  await invoice(cust.dental.id, d(18), [{ description: 'Vacuum pump overhaul', qty: 1, unitPrice: 2150 }, { description: 'Replacement vanes', qty: 1, unitPrice: 340, accountKey: 'sales_revenue' }], 21.25);
  await asActor(rosa, (tx) => receivePayment(tx, rosa, { customerId: cust.bright.id, receivedOn: d(24), amount: 1850, method: 'check', reference: '20418', allocations: [{ invoiceId: i1.id, amount: 1850 }] }));
  // A coupling sent back unused (wrong size): credited against its invoice, which it reduces (D-146).
  await asActor(rosa, async (tx) => {
    const cm = await createCreditMemo(tx, rosa, { customerId: cust.river.id, invoiceId: i2.id, reason: 'Pump coupling returned unused (wrong size)',
      lines: [{ description: 'Pump coupling', qty: 1, unitPrice: 600 }] });
    await issueCreditMemo(tx, rosa, blobs, cm.id, { memoDate: d(40) });
  });
  const sup = await asActor(rosa, async (tx) => ({
    grainger: await createSupplier(tx, rosa, { code: 'GRN', name: 'Grainger', paymentTerms: 'Net 30' }),
    edison: await createSupplier(tx, rosa, { code: 'OHE', name: 'Ohio Edison', paymentTerms: 'Net 20' }),
    insurer: await createSupplier(tx, rosa, { code: 'ACI', name: 'Acme Commercial Insurance', paymentTerms: 'Net 30' }),
  }));
  const bill = async (s: string, no: string, date: string, lines: { description: string; qty: number; unitPrice: number; accountKey: string }[]) => {
    const b = await asActor(rosa, (tx) => captureInvoice(tx, rosa, null, { supplierId: s, facilityId: t.facilities.SHOP!, invoiceNumber: no, invoiceDate: date, lines }));
    await asActor(kai, (tx) => approveInvoice(tx, kai, b.id));
    return b;
  };
  const b1 = await bill(sup.grainger.id, '9284471', d(40), [{ description: 'Shop supplies and abrasives', qty: 1, unitPrice: 412.55, accountKey: 'supplies_expense' }]);
  const b2 = await bill(sup.edison.id, 'OE-0921', d(33), [{ description: 'Electricity, September', qty: 1, unitPrice: 286.4, accountKey: 'utilities_expense' }]);
  await bill(sup.insurer.id, 'ACI-77120', d(12), [{ description: 'General liability, quarterly', qty: 1, unitPrice: 1240, accountKey: 'other_expense' }]);
  await asActor(rosa, (tx) => payBill(tx, rosa, b1.id, { paidOn: d(30), amount: 412.55, reference: 'ACH' }));
  await asActor(rosa, (tx) => payBill(tx, rosa, b2.id, { paidOn: d(20), amount: 286.4, reference: 'ACH' }));
  await asActor(kai, async (tx) => {
    await saveExpensePolicy(tx, kai, { receiptRequiredOver: 75, mileageRate: 0.7, submitWithinDays: 60 });
    await installTemplates(tx, kai);
    await postAnnouncement(tx, kai, { title: 'Our books are now in the intranet', body: 'Rosa enters bills and invoices here; submit mileage and parts runs as expense reports.', kind: 'news', pinned: true });
  });
  const cats = Object.fromEntries((await asActor(jo, (tx) => expenseRules(tx))).categories.map((c: any) => [c.code, c.id]));
  const rep = await asActor(jo, async (tx) => {
    const r = await createReport(tx, jo, { title: 'Parts runs, September', purpose: 'Same-day parts for customer jobs' });
    await saveLine(tx, jo, r.id, { spentOn: d(28), categoryId: cats.MILEAGE, miles: 64, description: 'Shop to Grainger Toledo and back' });
    await saveLine(tx, jo, r.id, { spentOn: d(28), categoryId: cats.PARKING, merchant: 'Toledo meter', amount: 4 });
    await submitReport(tx, jo, r.id);
    return r;
  });
  const step = (await asActor(kai, (tx) => myApprovalQueue(tx, kai))).find((q) => q.subject_id === rep.id)!;
  await asActor(kai, (tx) => decideApproval(tx, kai, step.step_id, { decision: 'approve' }));
  await asActor(rosa, (tx) => markPaid(tx, rosa, rep.id, { paidOn: d(21), method: 'direct_deposit', reference: 'Zelle' }));

  log('Kessler (Lite): bank statement in the bank\'s own CSV layout');
  const fmt = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  const rows: [number, string, number, string?][] = [
    [44, 'ZELLE PAYMENT TO LAKESIDE PROPERTIES RENT', -2200], [41, 'GOOGLE *WORKSPACE KESSLER', -18], [38, 'SHELL OIL 57442', -62.18], [30, 'ACH GRAINGER 9284471', -412.55],
    [29, 'MONTHLY SERVICE FEE', -15], [24, 'MOBILE DEPOSIT CHECK 20418', 1850, '20418'], [21, 'ZELLE TO JO MARSH', -48.8], [20, 'ACH OHIO EDISON', -286.4],
    [14, 'ZELLE PAYMENT TO LAKESIDE PROPERTIES RENT', -2200], [11, 'GOOGLE *WORKSPACE KESSLER', -18], [9, 'SHELL OIL 57442', -58.4], [6, 'MOBILE DEPOSIT', 450], [1, 'MONTHLY SERVICE FEE', -15],
  ];
  let bal = 18_500;
  const csv = ['Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #', ...rows.map(([n, desc, amt, chk]) => {
    bal = Math.round((bal + amt) * 100) / 100;
    return `${amt > 0 ? 'CREDIT' : 'DEBIT'},${fmt(d(n))},"${desc}",${amt.toFixed(2)},${amt > 0 ? 'DEPOSIT' : 'ACH_DEBIT'},${bal.toFixed(2)},${chk ?? ''}`;
  })];
  await runImportContent(rosa, { fileName: 'Chk_4412_Activity.csv', content: Buffer.from(csv.join('\n')), target: 'bank_transactions', sourceSystem: 'firstbank-checking-csv',
    profile: 'kessler/profiles/bank-statement.json' });
  await asActor(rosa, async (tx) => {
    // Rules for the regulars, then the payments already in the books matched, and the older lines categorized.
    await saveRule(tx, rosa, { contains: 'LAKESIDE PROPERTIES', direction: 'out', accountId: acct['6250']!, payee: 'Lakeside Properties' });
    await saveRule(tx, rosa, { contains: 'WORKSPACE', direction: 'out', accountId: acct['6350']!, payee: 'Google' });
    await saveRule(tx, rosa, { contains: 'SERVICE FEE', direction: 'out', accountId: acct['6100']! });
    const q = await reviewQueue(tx, rosa, { status: 'unreviewed' });
    for (const x of q) if (x.matches?.length && !x.description.includes('SHELL')) await matchBankLine(tx, rosa, x.id, x.matches[0].id);
    for (const x of q.filter((y) => y.posted_on < d(25) && y.suggested_account_id)) await categorizeBankLine(tx, rosa, x.id, { accountId: x.suggested_account_id });
    const firstFuel = q.find((y) => y.description.startsWith('SHELL') && y.posted_on === d(38));
    if (firstFuel) await categorizeBankLine(tx, rosa, firstFuel.id, { accountId: fuel });
  });
  const left = (await db.query(`SELECT count(*)::int AS n FROM bank_txn WHERE tenant_id = $1 AND status = 'unreviewed'`, [t.tenantId])).rows[0].n;
  log(`  books: 3 invoices (1 paid), 3 bills (2 paid), 1 expense report reimbursed; ${left} bank lines left to review`);
  return { tokens };
}
