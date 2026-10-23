import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createSupplier, importOpenOrderLine } from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Payment behavior, PO aging and quote aging (SC-005 C). */
let app: FastifyInstance; let w: World; let cust: string; let sup: string; let part: string;
const db = () => getAdminPool();
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('timing');
  await asActor(w.admin, async (tx) => {
    cust = (await createCustomer(tx, w.admin, { code: 'SLOW', name: 'Slow Payer Inc', kind: 'customer', paymentTerms: 'Net 30' })).id;
    await createCustomer(tx, w.admin, { code: 'FAST', name: 'Fast Payer Inc', kind: 'customer', paymentTerms: 'Net 30' });
    sup = (await createSupplier(tx, w.admin, { code: 'LATE', name: 'Late Supply', paymentTerms: 'Net 30' })).id;
    part = (await createPart(tx, w.admin, { partNumber: 'P-1', description: 'Thing', uom: 'EA' })).id;
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const report = async (id: string, q = '') => { const r = await app.inject({ method: 'GET', url: `/api/reports/${id}${q}`, headers: { authorization: `Bearer ${w.tokens.admin}` } }); expect(r.statusCode, r.body).toBe(200); return r.json(); };

describe('payment behavior', () => {
  it('measures days beyond terms per customer, and how late we pay suppliers', async () => {
    const mk = async (customerId: string, invDate: number, dueDate: number, paidDate: number, amount: number) => {
      const i = (await db().query(`INSERT INTO customer_invoice (tenant_id, facility_id, number, customer_id, status, invoice_date, due_date, created_by) VALUES ($1, $2, $3, $4, 'paid', $5, $6, $7) RETURNING id`,
        [w.tenantId, w.facilities.A, `T-${Math.random().toString(36).slice(2, 8)}`, customerId, day(invDate), day(dueDate), w.admin.userId])).rows[0].id;
      await db().query(`INSERT INTO customer_invoice_line (tenant_id, invoice_id, line_no, description, qty, unit_price) VALUES ($1, $2, 1, 'x', 1, $3)`, [w.tenantId, i, amount]);
      const p = (await db().query(`INSERT INTO customer_payment (tenant_id, customer_id, received_on, amount, method, recorded_by) VALUES ($1, $2, $3, $4, 'ach', $5) RETURNING id`, [w.tenantId, customerId, day(paidDate), amount, w.admin.userId])).rows[0].id;
      await db().query(`INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, $4)`, [w.tenantId, p, i, amount]);
    };
    const fast = (await db().query(`SELECT id FROM customer WHERE tenant_id = $1 AND code = 'FAST'`, [w.tenantId])).rows[0].id;
    await mk(cust, -90, -60, -40, 1000); // 20 days late
    await mk(cust, -60, -30, -10, 500);  // 20 days late
    await mk(fast, -60, -30, -35, 800);  // 5 days early
    const r = await report('payment-behavior', '?side=customers');
    const slow = r.rows.find((x: any) => x.party === 'Slow Payer Inc');
    expect(slow).toMatchObject({ paid: 2, days_beyond: 20, worst: 20, pct_late: 100, amount: 1500 });
    expect(r.rows.find((x: any) => x.party === 'Fast Payer Inc')).toMatchObject({ days_beyond: -5, pct_late: 0 });
    expect(r.rows[0].party).toBe('Slow Payer Inc');
    expect(r.headline).toMatch(/pay on average .* days after the due date; 67% are paid late/);
    // Suppliers: we paid a bill 12 days after it was due.
    const b = (await db().query(`INSERT INTO supplier_invoice (tenant_id, facility_id, supplier_id, invoice_number, invoice_date, due_date, status, paid_at, paid_amount, captured_by) VALUES ($1, $2, $3, 'B-1', $4, $5, 'paid', $6, 300, $7) RETURNING id`,
      [w.tenantId, w.facilities.A, sup, day(-60), day(-30), day(-18), w.admin.userId])).rows[0].id;
    await db().query(`INSERT INTO supplier_invoice_line (tenant_id, invoice_id, line_no, description, qty, unit_price, account_key) VALUES ($1, $2, 1, 'x', 1, 300, 'other_expense')`, [w.tenantId, b]);
    const s = await report('payment-behavior', '?side=suppliers');
    expect(s.rows).toEqual([expect.objectContaining({ party: 'Late Supply', days_beyond: 12, pct_late: 100 })]);
  });
});

describe('purchase order aging', () => {
  it('buckets open orders by days past the promised date and totals the value still to arrive', async () => {
    const line = (n: string, due: number, qty: number, rec: number, price: number) => asActor(w.admin, (tx) => importOpenOrderLine(tx, w.admin, { orderNumber: n, supplierId: sup, facilityId: w.facilities.A!, partId: part, description: 'Thing', qty, qtyReceived: rec, unitPrice: price, expectedOn: day(due) }));
    await line('PO-OLD', -45, 10, 0, 10);  // 45 days late, 100 to arrive
    await line('PO-SOON', -3, 10, 5, 20); // 3 days late, 100 to arrive
    await line('PO-NEXT', 10, 4, 0, 25);  // not yet due, 100
    const r = await report('po-aging');
    expect(r.rows.map((x: any) => [x.number, x.aging, x.open_value])).toEqual([['PO-OLD', '31–60 days late', 100], ['PO-SOON', '1–7 days late', 100], ['PO-NEXT', 'Not yet due', 100]]);
    expect(r.headline).toMatch(/2 purchase orders \(\$200 of \$300 still to arrive\) past the promised date/);
    expect(r.insights.join(' ')).toMatch(/Most value late: Late Supply/);
  });
});

describe('quote aging', () => {
  it('lists quotes waiting, expiring and expired, and the typical days to accept', async () => {
    const q = async (n: string, sentAgo: number, validIn: number, status: string, decidedAgo: number | null, amount: number) => {
      const id = (await db().query(`INSERT INTO quote (tenant_id, facility_id, number, customer_id, title, status, sent_at, valid_until, decided_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7), $8, CASE WHEN $9::int IS NULL THEN NULL ELSE now() - make_interval(days => $9::int) END, $10) RETURNING id`,
        [w.tenantId, w.facilities.A, n, cust, `Job ${n}`, status, sentAgo, day(validIn), decidedAgo, w.admin.userId])).rows[0].id;
      await db().query(`INSERT INTO quote_line (tenant_id, quote_id, line_no, description, qty, unit_price) VALUES ($1, $2, 1, 'x', 1, $3)`, [w.tenantId, id, amount]);
    };
    await q('Q-EXP', 40, -5, 'sent', null, 1000);
    await q('Q-SOON', 10, 6, 'sent', null, 2000);
    await q('Q-OK', 3, 25, 'sent', null, 500);
    await q('Q-WON', 20, 10, 'accepted', 10, 800);   // accepted 10 days after sending
    await q('Q-LOST', 30, 10, 'declined', 5, 900);
    const r = await report('quote-aging');
    expect(r.rows.map((x: any) => [x.number, x.stage])).toEqual([['Q-EXP', 'Expired, no decision'], ['Q-SOON', 'Expires within 14 days'], ['Q-OK', 'Waiting']]);
    expect(r.headline).toMatch(/1 quote \(\$1,000\) expired without a decision; \$3,500 waiting/);
    expect(r.kpis.find((k: any) => k.label === 'Typical days to accept').value).toBe(10);
  });
});

describe('what is late', () => {
  it('collects everything past its date for a person who may see it, with owners, and nothing for someone who may not', async () => {
    await db().query(`INSERT INTO customer_invoice (tenant_id, facility_id, number, customer_id, status, invoice_date, due_date, created_by) VALUES ($1, $2, 'LATE-1', $3, 'issued', $4, $5, $6)`,
      [w.tenantId, w.facilities.A, cust, day(-70), day(-40), w.admin.userId]).then(async () => {
      const id = (await db().query(`SELECT id FROM customer_invoice WHERE number = 'LATE-1'`)).rows[0].id;
      await db().query(`INSERT INTO customer_invoice_line (tenant_id, invoice_id, line_no, description, qty, unit_price) VALUES ($1, $2, 1, 'x', 1, 750)`, [w.tenantId, id]);
    });
    const r = await app.inject({ method: 'GET', url: '/api/what-is-late', headers: { authorization: `Bearer ${w.tokens.admin}` } });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    const sec = (k: string) => b.sections.find((s: any) => s.key === k);
    expect(sec('invoices')).toMatchObject({ count: 1, amount: 750, rows: [expect.objectContaining({ label: 'LATE-1 · Slow Payer Inc', daysLate: 40 })] });
    expect(sec('orders').count).toBe(2); // PO-OLD and PO-SOON
    expect(sec('quotes').rows[0]).toMatchObject({ label: 'Q-EXP · Slow Payer Inc', daysLate: 5 });
    expect(b.answer).toMatch(/items are past their date/);
    const tech = await app.inject({ method: 'GET', url: '/api/what-is-late', headers: { authorization: `Bearer ${w.tokens.techA}` } });
    expect(tech.json().sections.map((s: any) => s.key)).not.toEqual(expect.arrayContaining(['invoices', 'bills', 'quotes']));
  });
});
