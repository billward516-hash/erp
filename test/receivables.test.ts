import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import {
  collectionsQueue, customerAccount, draftInvoiceFromOrder, getInvoice, invoicePdf, issueInvoice, listInvoices, logCollection, recordPayment, sendPaymentReminder,
  toInvoice, updateDraft, voidInvoice,
} from '../src/modules/ar/service.js';
import { createCustomer, saveContact } from '../src/modules/crm/service.js';
import { setAccountMapping } from '../src/modules/integrations/accounts.js';
import { createConnection, disconnect, downloadExportFile, listExportFiles, mockPayBill, runSync } from '../src/modules/integrations/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { createPart } from '../src/modules/parts/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { acceptQuote, createQuote, getOrder, releaseCreditHold, saveItem, sendQuote, shipOrder, submitQuote } from '../src/modules/sales/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
const db = () => getAdminPool();
let w: World;
let rep: Actor; let clerk: Actor;
let acme: any; let tiny: any; let pump: any; let svc: any; let store: string;
let so: any; let inv1: any;

const mk = async (role: string, key: string) => {
  const u = await createUserWithToken(getAdminPool(), w.tenantId, { email: `${key}-${Date.now()}@ar.example`, displayName: key, roles: [{ role, facility: null }] });
  return (await loadActor(w.tenantId, u.userId))!;
};
/** Quote → send → accept, as the sales rep. */
const sell = async (customerId: string, lines: any[], extra: { customerPo?: string } = {}) => asActor(rep, async (tx) => {
  const q = await createQuote(tx, rep, { facilityId: w.facilities.A!, customerId, title: 'Order', lines });
  await submitQuote(tx, rep, q.id);
  await sendQuote(tx, rep, blobs, q.id, {});
  return acceptQuote(tx, rep, q.id, extra);
});
const invStatus = async (id: string) => (await db().query('SELECT status FROM customer_invoice WHERE id = $1', [id])).rows[0].status;

beforeAll(async () => {
  w = await makeWorld('ar');
  rep = await mk('sales_rep', 'rep');
  clerk = await mk('ar_clerk', 'clerk');
  store = (await asActor(w.admin, (tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-FG', name: 'Finished goods' }))).id;
  const part = await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'PMP-200', description: 'Coolant pump assembly' }));
  await asActor(w.admin, (tx) => receive(tx, w.admin, { locationId: store, partId: part.id, qty: 20, unitCost: 600 }));
  ({ pump, svc } = await asActor(w.admin, async (tx) => ({
    pump: await saveItem(tx, w.admin, { code: 'PMP-200', description: 'Coolant pump assembly, rebuilt', listPrice: 1000, unitCost: 600, partId: part.id }),
    svc: await saveItem(tx, w.admin, { code: 'SVC-INSTALL', description: 'On-site installation (per hour)', kind: 'service', uom: 'HR', listPrice: 120, unitCost: 55 }),
  })));
  ({ acme, tiny } = await asActor(rep, async (tx) => {
    const acme = await createCustomer(tx, rep, { code: 'ACME', name: 'Acme Plastics', paymentTerms: 'Net 30', billingAddress: '12 Mill St, Dayton OH' });
    await saveContact(tx, rep, { customerId: acme.id, name: 'Sam Lee', email: 'ap@acme.example', isPrimary: true });
    const tiny = await createCustomer(tx, rep, { code: 'TINY', name: 'Tiny Tool Co', paymentTerms: 'Net 15', creditLimit: 1500 });
    return { acme, tiny };
  }));
  so = await sell(acme.id, [{ itemId: pump.id, qty: 4, unitPrice: 1000 }, { itemId: svc.id, qty: 5 }], { customerPo: 'PO-5512' });
});
afterAll(closePools);

describe('invoicing from shipments', () => {
  it('nothing to invoice until something ships; then the draft bills exactly the shipped, uninvoiced quantity', async () => {
    await expect(asActor(clerk, (tx) => draftInvoiceFromOrder(tx, clerk, so.id))).rejects.toThrow(/nothing has shipped/);
    const order = await asActor(w.admin, (tx) => getOrder(tx, w.admin, so.id));
    const [pumpLine, svcLine] = order.lines;
    await asActor(w.admin, (tx) => shipOrder(tx, w.admin, so.id, { lines: [{ orderLineId: pumpLine.id, qty: 3, locationId: store }, { orderLineId: svcLine.id, qty: 5 }] }));
    expect((await asActor(clerk, (tx) => toInvoice(tx, clerk))).map((r) => [r.number, r.amount])).toEqual([[so.number, 3600]]);
    await expect(asActor(rep, (tx) => draftInvoiceFromOrder(tx, rep, so.id))).rejects.toThrow(/ar.manage/);
    inv1 = await asActor(clerk, (tx) => draftInvoiceFromOrder(tx, clerk, so.id));
    const v = await asActor(clerk, (tx) => getInvoice(tx, clerk, inv1.id));
    expect(v).toMatchObject({ status: 'draft', number: null, customer_po: 'PO-5512', payment_terms: 'Net 30', total: 3600 });
    expect(v.lines.map((l: any) => [l.description, l.qty, l.uom, l.unit_price])).toEqual([['Coolant pump assembly, rebuilt', 3, 'EA', 1000], ['On-site installation (per hour)', 5, 'HR', 120]]);
    await expect(asActor(clerk, (tx) => draftInvoiceFromOrder(tx, clerk, so.id))).rejects.toThrow(/draft invoice for this order already exists/);
    // While a draft is open the order drops off the to-invoice list.
    expect(await asActor(clerk, (tx) => toInvoice(tx, clerk))).toEqual([]);
  });

  it('issuing numbers the invoice, sets the due date from terms, stores the PDF and queues it for accounting', async () => {
    await asActor(clerk, (tx) => updateDraft(tx, clerk, inv1.id, { freightAmount: 85, taxAmount: 0, notes: 'Thank you for your business.' }));
    const r = await asActor(clerk, (tx) => issueInvoice(tx, clerk, blobs, inv1.id, { invoiceDate: '2026-08-01' }));
    expect(r).toMatchObject({ number: expect.stringMatching(/^INV-\d{6}$/), total: 3685, dueDate: '2026-08-31' });
    const v = await asActor(clerk, (tx) => getInvoice(tx, clerk, inv1.id));
    expect(v).toMatchObject({ status: 'issued', overdue: true, balance: 3685, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const pdf = await asActor(clerk, (tx) => invoicePdf(tx, clerk, blobs, inv1.id));
    expect(pdf.name).toBe(`${r.number}.pdf`);
    expect(pdf.content.subarray(0, 5).toString()).toBe('%PDF-');
    const lines = await asActor(w.admin, (tx) => many(tx, 'SELECT qty_shipped::float AS s, qty_invoiced::float AS i FROM sales_order_line WHERE order_id = $1 ORDER BY line_no', [so.id]));
    expect(lines).toEqual([{ s: 3, i: 3 }, { s: 5, i: 5 }]);
    const ev = await asActor(w.admin, (tx) => one(tx, `SELECT topic, idempotency_key, payload FROM outbox_event WHERE aggregate_id = $1`, [inv1.id]));
    expect(ev).toMatchObject({ topic: 'ar.invoice.issued', idempotency_key: `invoice:${inv1.id}:issued` });
    expect(ev.payload.lines.map((l: any) => l.accountKey)).toEqual(['sales_revenue', 'service_revenue']);
    await expect(asActor(clerk, (tx) => issueInvoice(tx, clerk, blobs, inv1.id))).rejects.toThrow(/invoice is issued/);
    // The database will not let invoiced quantity exceed what shipped.
    await expect(db().query('UPDATE sales_order_line SET qty_invoiced = qty_shipped + 1 WHERE order_id = $1', [so.id])).rejects.toThrow(/invoiced_le_shipped/);
  });

  it('a draft cannot bill more than shipped once a second invoice gets there first; voiding gives the quantity back', async () => {
    const order = await asActor(w.admin, (tx) => getOrder(tx, w.admin, so.id));
    await asActor(w.admin, (tx) => shipOrder(tx, w.admin, so.id, { lines: [{ orderLineId: order.lines[0].id, qty: 1, locationId: store }] }));
    const d = await asActor(clerk, (tx) => draftInvoiceFromOrder(tx, clerk, so.id));
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, d.id, 'Raised by mistake'));
    const d2 = await asActor(clerk, (tx) => draftInvoiceFromOrder(tx, clerk, so.id));
    const r = await asActor(clerk, (tx) => issueInvoice(tx, clerk, blobs, d2.id, { invoiceDate: '2026-10-01' }));
    expect(r.total).toBe(1000);
    await asActor(clerk, (tx) => voidInvoice(tx, clerk, d2.id, 'Wrong price agreed'));
    expect(await invStatus(d2.id)).toBe('void');
    const pumpLine = await asActor(w.admin, (tx) => one(tx, 'SELECT qty_invoiced::float AS i FROM sales_order_line WHERE order_id = $1 AND line_no = 1', [so.id]));
    expect(pumpLine.i).toBe(3);
    const voided = await asActor(w.admin, (tx) => one(tx, `SELECT topic FROM outbox_event WHERE aggregate_id = $1 AND topic = 'ar.invoice.voided'`, [d2.id]));
    expect(voided).toBeTruthy();
    // A void draft never consumed a number.
    expect((await db().query('SELECT number FROM customer_invoice WHERE id = $1', [d.id])).rows[0].number).toBeNull();
  });
});

describe('payments', () => {
  it('a payment must be applied in full, only to open invoices of that customer, and never above the balance', async () => {
    const base = { customerId: acme.id, receivedOn: '2026-09-10', method: 'check' as const, reference: 'CHK 4410' };
    await expect(asActor(clerk, (tx) => recordPayment(tx, clerk, { ...base, amount: 1000, allocations: [{ invoiceId: inv1.id, amount: 900 }] }))).rejects.toThrow(/apply the whole payment/);
    await expect(asActor(clerk, (tx) => recordPayment(tx, clerk, { ...base, amount: 5000, allocations: [{ invoiceId: inv1.id, amount: 5000 }] }))).rejects.toThrow(/only 3685.00 is owed/);
    await expect(asActor(clerk, (tx) => recordPayment(tx, clerk, { ...base, customerId: tiny.id, amount: 100, allocations: [{ invoiceId: inv1.id, amount: 100 }] }))).rejects.toThrow(/belongs to another customer/);
    await asActor(clerk, (tx) => recordPayment(tx, clerk, { ...base, amount: 2000, allocations: [{ invoiceId: inv1.id, amount: 2000 }] }));
    let v = await asActor(clerk, (tx) => getInvoice(tx, clerk, inv1.id));
    expect(v).toMatchObject({ status: 'partially_paid', paid: 2000, balance: 1685 });
    expect(v.payments).toEqual([expect.objectContaining({ method: 'check', reference: 'CHK 4410', amount: 2000, source: 'manual' })]);
    // Partially paid invoices cannot be voided; payments are append-only.
    await expect(asActor(clerk, (tx) => voidInvoice(tx, clerk, inv1.id, 'x y z'))).rejects.toThrow(/payments are applied/);
    await expect(db().query('DELETE FROM payment_allocation WHERE invoice_id = $1', [inv1.id])).rejects.toThrow(/append-only/);
    await asActor(clerk, (tx) => recordPayment(tx, clerk, { ...base, receivedOn: '2026-09-20', amount: 1685, method: 'ach', allocations: [{ invoiceId: inv1.id, amount: 1685 }] }));
    v = await asActor(clerk, (tx) => getInvoice(tx, clerk, inv1.id));
    expect(v).toMatchObject({ status: 'paid', balance: 0, overdue: false });
    await expect(asActor(clerk, (tx) => recordPayment(tx, clerk, { ...base, amount: 1, allocations: [{ invoiceId: inv1.id, amount: 1 }] }))).rejects.toThrow(/is paid/);
  });
});

describe('credit hold', () => {
  it('an order that takes the customer over their limit is held, finance is told, and only ar.credit can release it', async () => {
    const small = await sell(tiny.id, [{ itemId: pump.id, qty: 1, unitPrice: 1000 }]);
    expect(small.credit_hold).toBe(false);
    const big = await sell(tiny.id, [{ itemId: pump.id, qty: 1, unitPrice: 1000 }]);
    const held = await asActor(w.admin, (tx) => getOrder(tx, w.admin, big.id));
    expect(held).toMatchObject({ credit_hold: true, credit_hold_note: expect.stringMatching(/over the credit limit of 1500.00/) });
    const line = held.lines[0];
    await expect(asActor(w.admin, (tx) => shipOrder(tx, w.admin, big.id, { lines: [{ orderLineId: line.id, qty: 1, locationId: store }] }))).rejects.toThrow(/credit hold/);
    const note = await asActor(w.finance, (tx) => one(tx, `SELECT title FROM notification WHERE user_id = $1 AND kind = 'sales.credit_hold'`, [w.finance.userId]));
    expect(note.title).toBe(`${big.number} is on credit hold`);
    await expect(asActor(clerk, (tx) => releaseCreditHold(tx, clerk, big.id, 'customer paid'))).rejects.toThrow(/ar.credit/);
    await asActor(w.finance, (tx) => releaseCreditHold(tx, w.finance, big.id, 'Prepaid by card'));
    await asActor(w.admin, (tx) => shipOrder(tx, w.admin, big.id, { lines: [{ orderLineId: line.id, qty: 1, locationId: store }] }));
    const acct = await asActor(clerk, (tx) => customerAccount(tx, clerk, tiny.id));
    expect(acct.credit).toMatchObject({ limit: 1500, uninvoicedOrders: 2000, exposure: 2000, over: true });
  });
});

describe('collections', () => {
  let late: any;
  it('overdue customers queue oldest first; a promise to pay becomes a follow-up; reminders email the primary contact once a day', async () => {
    const o = await sell(acme.id, [{ itemId: svc.id, qty: 10 }]);
    const order = await asActor(w.admin, (tx) => getOrder(tx, w.admin, o.id));
    await asActor(w.admin, (tx) => shipOrder(tx, w.admin, o.id, { lines: [{ orderLineId: order.lines[0].id, qty: 10 }] }));
    late = await asActor(clerk, (tx) => draftInvoiceFromOrder(tx, clerk, o.id));
    await asActor(clerk, (tx) => issueInvoice(tx, clerk, blobs, late.id, { invoiceDate: '2026-07-01' }));
    const q = await asActor(clerk, (tx) => collectionsQueue(tx, clerk));
    expect(q).toEqual([expect.objectContaining({ customer_name: 'Acme Plastics', overdue: 1200, overdue_invoices: 1, contact_name: 'Sam Lee', last_contact: null })]);
    await asActor(clerk, (tx) => logCollection(tx, clerk, { customerId: acme.id, invoiceId: late.id, summary: 'Spoke to Sam; check goes out Friday', promiseDate: '2026-10-30' }));
    const q2 = (await asActor(clerk, (tx) => collectionsQueue(tx, clerk)))[0];
    expect(q2.last_contact).toBeTruthy();
    expect(q2.promised_by).toBe('2026-10-30');
    const m = await asActor(clerk, (tx) => sendPaymentReminder(tx, clerk, late.id));
    expect(m).toMatchObject({ to: 'ap@acme.example', subject: expect.stringMatching(/^Past due: invoice INV-\d+ for 1200.00 USD$/) });
    await expect(asActor(clerk, (tx) => sendPaymentReminder(tx, clerk, late.id))).rejects.toThrow(/already queued today/);
    const mail = await asActor(w.admin, (tx) => one(tx, `SELECT user_id, customer_id, kind, body_text FROM email_message WHERE kind = 'payment_reminder'`));
    expect(mail).toMatchObject({ user_id: null, customer_id: acme.id, kind: 'payment_reminder', body_text: expect.stringMatching(/was due on 2026-07-31/) });
    const v = await asActor(clerk, (tx) => getInvoice(tx, clerk, late.id));
    expect(v.notes.map((n: any) => n.kind)).toEqual(expect.arrayContaining(['collection', 'task', 'note']));
  });

  it('the weekly reminder tells receivables staff about overdue invoices; a promise due links to the invoice', async () => {
    const counts = await runReminders(w.tenantId, '2026-10-30');
    expect(counts.receivables_overdue).toBeGreaterThanOrEqual(1);
    const n = await asActor(clerk, (tx) => many(tx, `SELECT kind, title, link FROM notification WHERE user_id = $1 ORDER BY kind`, [clerk.userId]));
    expect(n).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reminder.receivables_overdue', title: expect.stringMatching(/1 customer invoice at A overdue, 1200.00 USD/) }),
      expect.objectContaining({ kind: 'reminder.crm_task_due', link: `/receivables/${late.id}` }),
    ]));
  });

  it('the aging report buckets balances and flags shipped-not-invoiced value and credit holds', async () => {
    const def = getReport('ar-aging')!;
    const r = await asActor(clerk, (tx) => def.run(tx, clerk, def.params.parse({})));
    expect(r.rows.map((x: any) => [x.customer, x.balance, x.bucket])).toEqual([['Acme Plastics', 1200, '61–90 days overdue']]);
    expect(r.headline).toMatch(/1,200 of \$1,200 receivables overdue; Acme Plastics owes the most past due/);
    expect(r.kpis.find((k) => k.label === 'Shipped, not invoiced')!.value).toBe(2000);
    expect(r.insights.join(' ')).toMatch(/with a promise to pay/);
    expect(r.exceptions).toEqual([0]);
  });
});

describe('accounting sync of customer invoices', () => {
  it('the file export writes a separate receivables file with revenue accounts', async () => {
    const c = await asActor(w.admin, (tx) => createConnection(tx, w.admin, { provider: 'file_export', backfill: 'all' }));
    await asActor(w.admin, async (tx) => {
      for (const [k, code] of [['sales_revenue', '4000'], ['service_revenue', '4100'], ['freight_income', '4900'], ['sales_tax_payable', '2200']]) await setAccountMapping(tx, w.admin, k!, { externalCode: code!, externalName: null });
    });
    const r = await runSync(w.admin);
    expect(r).toMatchObject({ delivered: 4, failed: 0 }); // three issued, one of them later voided
    const files = await asActor(w.admin, (tx) => listExportFiles(tx, w.admin, c.id));
    expect(files.map((f) => f.kind)).toEqual(['ar_invoices']);
    const f = await asActor(w.admin, (tx) => downloadExportFile(tx, w.admin, files[0].id));
    expect(f.file_name).toMatch(/^ar-invoices-/);
    expect(f.content.replace(/^\uFEFF/, '').split('\n')[0]).toMatch(/^Action,Customer code,Customer name,Invoice number/);
    expect(f.content).toMatch(/CREATE,ACME,Acme Plastics,INV-\d+,2026-08-01,2026-08-31,USD,PO-5512,SO-\d+,A,3,Freight,1,85,85,4900/);
    expect(f.content).toMatch(/VOID,ACME/);
    // Manual payments are allowed with a file export (accounting does not report back).
    await asActor(w.admin, (tx) => disconnect(tx, w.admin, c.id));
  });

  it('with the MOCK system, invoices are created against a customer record and payments come back on sync', async () => {
    const c = await asActor(w.admin, (tx) => createConnection(tx, w.admin, { provider: 'mock_accounting', backfill: 'all' }));
    await runSync(w.admin);
    const recs = await asActor(w.admin, (tx) => many(tx, `SELECT kind, external_id, status, payload FROM mock_accounting_record WHERE kind IN ('customer', 'invoice') ORDER BY kind, external_id`));
    expect(recs.filter((x) => x.kind === 'customer').map((x) => x.external_id)).toEqual(['MOCK-C-0001']);
    const invs = recs.filter((x) => x.kind === 'invoice');
    expect(invs.map((x) => x.status)).toEqual(['open', 'void', 'open']);
    expect(invs[0].payload).toMatchObject({ customerRef: 'MOCK-C-0001' });
    expect(invs[0].payload.lines.map((l: any) => l.account)).toEqual(['4000', '4100', '4900']);
    // With an API connection, payments are not typed in here.
    const late = (await asActor(clerk, (tx) => listInvoices(tx, clerk, { open: true })))[0];
    await expect(asActor(clerk, (tx) => recordPayment(tx, clerk, { customerId: acme.id, receivedOn: '2026-10-20', amount: 10, method: 'check', allocations: [{ invoiceId: late.id, amount: 10 }] })))
      .rejects.toThrow(/come from the connected accounting system/);
    const ext = invs.find((x) => x.payload.invoiceId === late.id)!.external_id;
    await asActor(w.admin, (tx) => mockPayBill(tx, w.admin, c.id, { externalId: ext, paidOn: '2026-10-21', amount: 500 }));
    expect((await runSync(w.admin)).payments).toBe(1);
    expect((await runSync(w.admin)).payments).toBe(0); // idempotent
    const v = await asActor(clerk, (tx) => getInvoice(tx, clerk, late.id));
    expect(v).toMatchObject({ status: 'partially_paid', balance: 700 });
    expect(v.payments).toEqual([expect.objectContaining({ source: 'accounting', amount: 500 })]);
    expect(v.sync.map((s: any) => [s.is_mock, s.status])).toEqual([[false, 'delivered'], [true, 'delivered']]);
  });
});
