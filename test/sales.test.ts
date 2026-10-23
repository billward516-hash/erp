import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createCustomer, getCustomer, logActivity, saveContact, saveOpportunity } from '../src/modules/crm/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { createPart } from '../src/modules/parts/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import {
  acceptQuote, cancelOrder, createQuote, declineQuote, getOrder, getQuote, quoteSentPdf, reviseQuote, saveItem, sendQuote, shipOrder, submitQuote, updateQuote,
} from '../src/modules/sales/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
let w: World;
let rep: Actor; let mgr: Actor;
let acme: any; let pump: any; let svc: any; let store: string;
const mk = async (role: string, key: string) => {
  const u = await createUserWithToken(getAdminPool(), w.tenantId, { email: `${key}-${Date.now()}@s.example`, displayName: key, roles: [{ role, facility: null }] });
  return (await loadActor(w.tenantId, u.userId))!;
};
const signAs = async (who: Actor, subjectId: string, decision: 'approve' | 'reject' = 'approve', comment?: string) => {
  const step = (await asActor(who, (tx) => myApprovalQueue(tx, who))).find((q) => q.subject_id === subjectId);
  if (!step) throw new Error('no step');
  return asActor(who, (tx) => decideApproval(tx, who, step.step_id, { decision, comment: comment ?? null }));
};
const status = async (id: string) => (await getAdminPool().query('SELECT status, revision FROM quote WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  w = await makeWorld('sales');
  rep = await mk('sales_rep', 'rep');
  mgr = await mk('sales_manager', 'mgr');
  store = (await asActor(w.admin, (tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-FG', name: 'Finished goods' }))).id;
  const part = await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'PMP-200', description: 'Coolant pump assembly' }));
  await asActor(w.admin, (tx) => receive(tx, w.admin, { locationId: store, partId: part.id, qty: 5, unitCost: 600 }));
  ({ pump, svc } = await asActor(w.admin, async (tx) => ({
    pump: await saveItem(tx, w.admin, { code: 'PMP-200', description: 'Coolant pump assembly, rebuilt', listPrice: 1000, unitCost: 600, partId: part.id }),
    svc: await saveItem(tx, w.admin, { code: 'SVC-INSTALL', description: 'On-site installation (per hour)', kind: 'service', uom: 'HR', listPrice: 120, unitCost: 55 }),
  })));
});
afterAll(closePools);

describe('customers, contacts and opportunities', () => {
  it('keeps one primary contact per customer and asks why an opportunity was lost', async () => {
    acme = await asActor(rep, (tx) => createCustomer(tx, rep, { code: 'ACME', name: 'Acme Plastics', paymentTerms: 'Net 30', billingAddress: '12 Mill St, Dayton OH' }));
    expect(acme).toMatchObject({ kind: 'prospect', owner_user_id: rep.userId });
    await asActor(rep, async (tx) => {
      await saveContact(tx, rep, { customerId: acme.id, name: 'Jo Park', email: 'jo@acme.example', isPrimary: true });
      await saveContact(tx, rep, { customerId: acme.id, name: 'Sam Lee', email: 'sam@acme.example', isPrimary: true });
    });
    const c = await asActor(rep, (tx) => getCustomer(tx, rep, acme.id));
    expect(c.contacts.map((x: any) => [x.name, x.is_primary])).toEqual([['Sam Lee', true], ['Jo Park', false]]);
    await expect(asActor(rep, (tx) => saveOpportunity(tx, rep, { customerId: acme.id, title: 'x', stage: 'lost' }))).rejects.toThrow(/why the opportunity was lost/);
    await expect(asActor(w.techA, (tx) => createCustomer(tx, w.techA, { code: 'X', name: 'x' }))).rejects.toThrow(/crm.manage/);
  });
});

describe('quotes', () => {
  let q1: any; let opp: any;

  it('a quote within pricing limits is ready to send; sending stores the exact PDF and moves the opportunity to proposal', async () => {
    opp = await asActor(rep, (tx) => saveOpportunity(tx, rep, { customerId: acme.id, title: 'Line 3 pump replacement', stage: 'qualified', amount: 2000 }));
    q1 = await asActor(rep, (tx) => createQuote(tx, rep, { facilityId: w.facilities.A!, customerId: acme.id, opportunityId: opp.id, title: 'Pump replacement, line 3',
      lines: [{ itemId: pump.id, qty: 2, unitPrice: 950 }, { itemId: svc.id, qty: 4 }] }));
    const v = await asActor(rep, (tx) => getQuote(tx, rep, q1.id));
    expect(v).toMatchObject({ total: 2380, reasons: [], payment_terms: 'Net 30' });
    expect(v.lines.map((l: any) => l.uom)).toEqual(['EA', 'HR']); // units carried from the catalog onto the quote
    expect(v.margin).toBeCloseTo(1 - (1200 + 220) / 2380, 5);
    expect(await asActor(rep, (tx) => submitQuote(tx, rep, q1.id))).toMatchObject({ status: 'approved' });
    const sent = await asActor(rep, (tx) => sendQuote(tx, rep, blobs, q1.id, { sentTo: 'sam@acme.example' }));
    expect(sent).toMatchObject({ revision: 1, total: 2380 });
    const pdf = await asActor(rep, (tx) => quoteSentPdf(tx, rep, blobs, q1.id));
    expect(pdf.content.subarray(0, 5).toString()).toBe('%PDF-');
    const o = await asActor(rep, (tx) => one(tx, 'SELECT stage, amount FROM opportunity WHERE id = $1', [opp.id]));
    expect(o).toMatchObject({ stage: 'proposal', amount: 2380 });
    const acts = await asActor(rep, (tx) => many(tx, `SELECT kind, summary FROM activity WHERE quote_id = $1`, [q1.id]));
    expect(acts).toEqual([{ kind: 'email', summary: expect.stringMatching(/^Sent Q-\d+ rev 1 \(2380.00\) to sam@acme.example/) }]);
  });

  it('a deep discount or thin margin needs a sales manager; a rejection sends it back to draft', async () => {
    const q = await asActor(rep, (tx) => createQuote(tx, rep, { facilityId: w.facilities.A!, customerId: acme.id, title: 'Spare pumps', lines: [{ itemId: pump.id, qty: 3, unitPrice: 720 }] }));
    const r = await asActor(rep, (tx) => submitQuote(tx, rep, q.id));
    expect(r).toMatchObject({ status: 'pending_approval', reasons: ['line 1: 28% below list price (over 15%)', 'gross margin 16.7% on costed lines (under 20%)'] });
    await expect(asActor(rep, (tx) => sendQuote(tx, rep, blobs, q.id))).rejects.toThrow(/waiting for pricing approval/);
    expect((await asActor(mgr, (tx) => myApprovalQueue(tx, mgr))).some((s) => s.subject_id === q.id)).toBe(true);
    await signAs(mgr, q.id, 'reject', 'Hold 800 minimum on rebuilt pumps');
    expect(await status(q.id)).toMatchObject({ status: 'draft' });
    await asActor(rep, (tx) => updateQuote(tx, rep, q.id, { lines: [{ itemId: pump.id, qty: 3, unitPrice: 860 }] }));
    expect(await asActor(rep, (tx) => submitQuote(tx, rep, q.id))).toMatchObject({ status: 'approved', reasons: [] });
  });

  it('a revision supersedes what was sent; acceptance needs the current revision, sent and not expired', async () => {
    await asActor(rep, (tx) => reviseQuote(tx, rep, q1.id, 'Customer asked for 6 hours of installation'));
    expect(await status(q1.id)).toEqual({ status: 'draft', revision: 2 });
    await expect(asActor(rep, (tx) => acceptQuote(tx, rep, q1.id, {}))).rejects.toThrow(/quote is draft/);
    await asActor(rep, async (tx) => {
      await updateQuote(tx, rep, q1.id, { lines: [{ itemId: pump.id, qty: 2, unitPrice: 950 }, { itemId: svc.id, qty: 6 }] });
      await submitQuote(tx, rep, q1.id);
      await sendQuote(tx, rep, blobs, q1.id, {});
    });
    // Both revisions keep their own PDF.
    expect((await asActor(rep, (tx) => quoteSentPdf(tx, rep, blobs, q1.id, 1))).name).toMatch(/-rev1\.pdf$/);
    const expired = await asActor(rep, async (tx) => {
      const q = await createQuote(tx, rep, { facilityId: w.facilities.A!, customerId: acme.id, title: 'Old', validUntil: '2026-01-31', lines: [{ itemId: svc.id, qty: 1 }] });
      await submitQuote(tx, rep, q.id);
      await sendQuote(tx, rep, blobs, q.id, {});
      return q;
    });
    await expect(asActor(rep, (tx) => acceptQuote(tx, rep, expired.id, {}))).rejects.toThrow(/expired on 2026-01-31/);
    await expect(asActor(rep, (tx) => declineQuote(tx, rep, expired.id, ''))).rejects.toThrow(/why the customer declined/);
    await asActor(rep, (tx) => declineQuote(tx, rep, expired.id, 'Went with in-house rebuild'));
  });

  it('acceptance creates the sales order, wins the opportunity and makes the prospect a customer', async () => {
    const so = await asActor(rep, (tx) => acceptQuote(tx, rep, q1.id, { customerPo: 'PO-77812', requestedDate: '2026-11-15' }));
    expect(so).toMatchObject({ customer_po: 'PO-77812', status: 'open', ship_to: '12 Mill St, Dayton OH' });
    const order = await asActor(rep, (tx) => getOrder(tx, rep, so.id));
    expect(order.lines.map((l: any) => [l.description, l.qty, l.unit_price])).toEqual([['Coolant pump assembly, rebuilt', 2, 950], ['On-site installation (per hour)', 6, 120]]);
    expect(order.total).toBe(2620);
    const o = await asActor(rep, (tx) => one(tx, 'SELECT stage, probability, amount FROM opportunity WHERE id = $1', [opp.id]));
    expect(o).toMatchObject({ stage: 'won', probability: 100, amount: 2620 });
    expect((await asActor(rep, (tx) => getCustomer(tx, rep, acme.id))).kind).toBe('customer');
  });
});

describe('sales orders and shipments', () => {
  it('stocked items ship from a storeroom through the stock ledger; services record quantity only; over-shipping is refused', async () => {
    const so = (await asActor(rep, (tx) => one(tx, 'SELECT id, number FROM sales_order LIMIT 1')));
    const order = await asActor(w.admin, (tx) => getOrder(tx, w.admin, so.id));
    const [pumpLine, svcLine] = order.lines;
    expect(pumpLine.stock).toEqual([{ location_id: store, location: 'A-FG', on_hand: 5 }]);
    await expect(asActor(rep, (tx) => shipOrder(tx, rep, so.id, { lines: [{ orderLineId: pumpLine.id, qty: 1 }] }))).rejects.toThrow(/sales.orders/);
    await expect(asActor(w.admin, (tx) => shipOrder(tx, w.admin, so.id, { lines: [{ orderLineId: pumpLine.id, qty: 1 }] }))).rejects.toThrow(/choose the storeroom/);
    await expect(asActor(w.admin, (tx) => shipOrder(tx, w.admin, so.id, { lines: [{ orderLineId: pumpLine.id, qty: 3, locationId: store }] }))).rejects.toThrow(/only 2 left/);
    const r = await asActor(w.admin, (tx) => shipOrder(tx, w.admin, so.id, { carrier: 'UPS', tracking: '1Z999', lines: [{ orderLineId: pumpLine.id, qty: 2, locationId: store }] }));
    expect(r.status).toBe('partially_shipped');
    const txn = await asActor(w.admin, (tx) => one(tx, `SELECT txn_type, qty, balance_after, reference FROM inventory_txn WHERE txn_type = 'shipment'`));
    expect(txn).toMatchObject({ txn_type: 'shipment', qty: -2, balance_after: 3, reference: `${so.number} ${r.shipment}` });
    await expect(asActor(w.admin, (tx) => cancelOrder(tx, w.admin, so.id, 'customer changed mind'))).rejects.toThrow(/something has shipped/);
    expect((await asActor(w.admin, (tx) => shipOrder(tx, w.admin, so.id, { lines: [{ orderLineId: svcLine.id, qty: 6 }] }))).status).toBe('shipped');
    // The rep who wrote the quote hears about shipments.
    expect((await asActor(rep, (tx) => many(tx, `SELECT title FROM notification WHERE user_id = $1 AND kind = 'sales.shipped'`, [rep.userId]))).map((n) => n.title))
      .toEqual(expect.arrayContaining([expect.stringMatching(/partly shipped/), expect.stringMatching(/shipped complete/)]));
    await expect(getAdminPool().query(`DELETE FROM shipment_line WHERE tenant_id = $1`, [w.tenantId])).rejects.toThrow(/append-only/);
  });
});

describe('pipeline, follow-ups and customer import', () => {
  it('the pipeline report weights open opportunities and counts the win rate', async () => {
    await asActor(rep, async (tx) => {
      await saveOpportunity(tx, rep, { customerId: acme.id, title: 'Plant 2 coolant system', stage: 'negotiation', amount: 40000 });
      await saveOpportunity(tx, rep, { customerId: acme.id, title: 'Service contract', stage: 'lead', amount: 10000 });
    });
    const def = getReport('sales-pipeline')!;
    const r = await asActor(mgr, (tx) => def.run(tx, mgr, def.params.parse({})));
    expect(r.kpis.find((k) => k.label === 'Weighted pipeline')!.value).toBe(31000);
    expect(r.kpis.find((k) => k.label === 'Win rate')!.value).toBe(0.5); // q1 accepted, the expired one declined
    expect(r.kpis.find((k) => k.label === 'Booked')!.value).toBe(2620);
  });

  it('follow-up tasks need a due date and are reminded to their owner', async () => {
    await expect(asActor(rep, (tx) => logActivity(tx, rep, { customerId: acme.id, kind: 'task', summary: 'Call back' }))).rejects.toThrow(/due date/);
    await asActor(rep, (tx) => logActivity(tx, rep, { customerId: acme.id, kind: 'task', summary: 'Call Sam about plant 2 layout', dueOn: '2026-01-02' }));
    const counts = await runReminders(w.tenantId);
    expect(counts.crm_task_due).toBe(1);
  });

  it('imports a CRM export with the primary contact on each row', async () => {
    const file = Buffer.from('Record ID,Company name,Lifecycle Stage,Industry,Contact,Job Title,Email,Terms\r\n9001,Bolt Fabrication,Customer,Metal fabrication,Ana Gomez,Purchasing manager,ana@bolt.example,Net 45\r\n9002,Cedar Foods,Lead,Food processing,,,,\r\n');
    const mapping = { fields: { external_id: { source: 'Record ID' }, code: { template: 'C-{Record ID}' }, name: { source: 'Company name' }, kind: { source: 'Lifecycle Stage' },
      industry: { source: 'Industry' }, contact_name: { source: 'Contact' }, contact_title: { source: 'Job Title' }, contact_email: { source: 'Email' }, payment_terms: { source: 'Terms' } } };
    const s = await stageImport(rep, { target: 'customers', sourceSystem: 'hubspot', fileName: 'companies.csv', content: file, mapping });
    expect(s.stats).toMatchObject({ total: 2, errors: 0 });
    await commitImport(rep, s.batchId);
    const bolt = await asActor(rep, (tx) => one(tx, `SELECT c.kind, c.payment_terms, ct.name, ct.is_primary FROM customer c JOIN contact ct ON ct.customer_id = c.id WHERE c.code = 'C-9001'`));
    expect(bolt).toEqual({ kind: 'customer', payment_terms: 'Net 45', name: 'Ana Gomez', is_primary: true });
    const again = await stageImport(rep, { target: 'customers', sourceSystem: 'hubspot', fileName: 'companies.csv', content: file, mapping });
    expect(again.preview.every((p: any) => p.action === 'update')).toBe(true);
  });
});
