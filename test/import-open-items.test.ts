import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { recordPayment } from '../src/modules/ar/service.js';
import { setupBooks, trialBalance } from '../src/modules/books/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Open items brought from the previous system: invoices, bills, purchase orders (SC-003). */
let app: FastifyInstance; let w: World; let custId: string;
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('openitems');
  await asActor(w.admin, async (tx) => {
    custId = (await createCustomer(tx, w.admin, { code: 'LAKE', name: 'Lakeshore Hydraulics', kind: 'customer', paymentTerms: 'Net 30' })).id;
    await createSupplier(tx, w.admin, { code: 'ATLAS', name: 'Atlas Supply', paymentTerms: 'Net 30' });
    await createPart(tx, w.admin, { partNumber: 'BRG-6204', description: 'Bearing 6204', uom: 'EA' });
  });
  await asActor(w.admin, (tx) => setupBooks(tx, w.admin, { startDate: '2026-10-01', openingBalance: 0 }));
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
async function load(target: string, text: string, expectErrors = 0) {
  const s = await call('POST', '/api/imports/stage', { target, sourceSystem: 'test', fileName: `${target}.csv`, facilityId: w.facilities.A, contentBase64: Buffer.from(text).toString('base64') });
  expect(s.statusCode, s.body).toBe(201);
  const b = s.json();
  expect(b.stats.errors, JSON.stringify(b.problems)).toBe(expectErrors);
  if (expectErrors) return b;
  const c = await call('POST', `/api/imports/${b.batchId}/commit`, {});
  expect(c.statusCode, c.body).toBe(200);
  return c.json();
}
const balanceOf = async (key: string) => Number((await getAdminPool().query(`SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM journal_line l JOIN ledger_account a ON a.id = l.account_id WHERE l.tenant_id = $1 AND a.account_key = $2`, [w.tenantId, key])).rows[0].b);

describe('open items', () => {
  it('open invoices keep the customer\'s numbers, land in receivables against opening equity, and settle when paid', async () => {
    const bad = await load('open_customer_invoices', 'Invoice number,Customer code,Invoice date,Amount still owed\n9001,NOBODY,2026-09-01,100\n9002,LAKE,2026-09-01,0\n', 2);
    expect(bad.problems.flatMap((p: any) => p.messages.map((m: any) => m.message)).join(' ')).toMatch(/customer "NOBODY" not found/);
    const r = await load('open_customer_invoices', 'Invoice number,Customer code,Invoice date,Due date,Amount still owed\nA-1001,LAKE,2026-09-02,2026-10-02,1250.50\nA-1002,LAKE,2026-10-05,,800\n');
    expect(r.stats).toMatchObject({ created: 2 });
    const inv = (await getAdminPool().query(`SELECT number, status, due_date::text AS due FROM customer_invoice WHERE tenant_id = $1 ORDER BY number`, [w.tenantId])).rows;
    expect(inv).toEqual([{ number: 'A-1001', status: 'issued', due: '2026-10-02' }, { number: 'A-1002', status: 'issued', due: '2026-11-04' }]);
    expect(await balanceOf('accounts_receivable')).toBeCloseTo(2050.5, 2);
    // Reloading the same file does nothing; a different balance is refused.
    expect((await load('open_customer_invoices', 'Invoice number,Customer code,Invoice date,Amount still owed\nA-1001,LAKE,2026-09-02,1250.50\n')).stats).toMatchObject({ created: 0 });
    const changed = await call('POST', '/api/imports/stage', { target: 'open_customer_invoices', sourceSystem: 'test', fileName: 'x.csv', facilityId: w.facilities.A, contentBase64: Buffer.from('Invoice number,Customer code,Invoice date,Amount still owed\nA-1001,LAKE,2026-09-02,900\n').toString('base64') });
    const commit = await call('POST', `/api/imports/${changed.json().batchId}/commit`, { allowPartial: true });
    expect(JSON.stringify(commit.json())).toMatch(/already loaded for 1250.50|failed/);
    expect(await balanceOf('accounts_receivable')).toBeCloseTo(2050.5, 2);
    // A payment settles one.
    const id = (await getAdminPool().query(`SELECT id FROM customer_invoice WHERE tenant_id = $1 AND number = 'A-1001'`, [w.tenantId])).rows[0].id;
    await asActor(w.admin, (tx) => recordPayment(tx, w.admin, { customerId: custId, receivedOn: '2026-10-20', amount: 1250.5, method: 'check', allocations: [{ invoiceId: id, amount: 1250.5 }] }));
    expect((await getAdminPool().query(`SELECT status FROM customer_invoice WHERE id = $1`, [id])).rows[0].status).toBe('paid');
  });

  it('open bills post to payables against opening equity; nothing is queued for accounting', async () => {
    const before = Number((await getAdminPool().query(`SELECT count(*)::int AS n FROM outbox_event WHERE tenant_id = $1 AND topic LIKE 'ap.%'`, [w.tenantId])).rows[0].n);
    const r = await load('open_supplier_bills', 'Bill number,Supplier code,Bill date,Due date,Amount still owed\nS-77,ATLAS,2026-09-15,2026-10-15,430.25\nS-78,ATLAS,2026-10-01,,100\n');
    expect(r.stats).toMatchObject({ created: 2 });
    expect(await balanceOf('accounts_payable')).toBeCloseTo(-530.25, 2);
    expect(Number((await getAdminPool().query(`SELECT count(*)::int AS n FROM outbox_event WHERE tenant_id = $1 AND topic LIKE 'ap.%'`, [w.tenantId])).rows[0].n)).toBe(before);
    const tb = await asActor(w.admin, (tx) => trialBalance(tx, w.admin));
    const rows = (tb as any).rows ?? tb;
    const sum = (k: 'debit' | 'credit') => rows.reduce((s: number, r: any) => s + Number(r[k] ?? 0), 0);
    expect(Math.abs(sum('debit') - sum('credit'))).toBeLessThan(0.005);
  });

  it('open purchase orders keep the supplier\'s number; received quantities are history; receiving the rest works', async () => {
    const r = await load('open_purchase_orders', 'PO number,Supplier code,Part number,Description,Quantity ordered,Quantity received,Unit price,Due date\nP-5001,ATLAS,BRG-6204,,20,5,12.5,2026-11-10\nP-5001,ATLAS,,Freight and handling,1,0,45,2026-11-10\n');
    expect(r.stats.failed ?? 0).toBe(0);
    const po = (await getAdminPool().query(`SELECT o.number, o.status, count(l.*)::int AS lines, sum(l.qty_received)::float AS rec FROM purchase_order o JOIN purchase_order_line l ON l.order_id = o.id WHERE o.tenant_id = $1 GROUP BY o.id`, [w.tenantId])).rows;
    expect(po).toEqual([{ number: 'P-5001', status: 'partially_received', lines: 2, rec: 5 }]);
  });
});
