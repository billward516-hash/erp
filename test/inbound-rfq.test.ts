import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { remindInboundRfqs } from '../src/modules/sales/inbound-rfq.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Requests for quote received from customers (SC-005 B). */
let app: FastifyInstance; let w: World; let cust: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('crfq');
  await asActor(w.admin, async (tx) => { cust = (await createCustomer(tx, w.admin, { code: 'ACME', name: 'Acme Corp', kind: 'customer', paymentTerms: 'Net 30' })).id; });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
const make = async (over: any = {}) => (await call(w.tokens.admin, 'POST', '/api/customer-rfqs', { facilityId: w.facilities.A, customerId: cust, customerRef: 'RFQ-7781', subject: 'Machined brackets, 500 pcs', responseDue: day(5), ...over })).json();

describe('customer requests for quote', () => {
  it('is recorded with the customer reference and a reply date, and refuses an impossible date', async () => {
    expect((await call(w.tokens.techA, 'POST', '/api/customer-rfqs', { facilityId: w.facilities.A, customerId: cust, subject: 'Nope nope', responseDue: day(3) })).statusCode).toBe(403);
    const bad = await call(w.tokens.admin, 'POST', '/api/customer-rfqs', { facilityId: w.facilities.A, customerId: cust, subject: 'Backwards', receivedOn: day(0), responseDue: day(-2) });
    expect(bad.statusCode).toBe(422);
    const r = await make();
    expect(r).toMatchObject({ number: 'CRFQ-000001', status: 'received', customer_ref: 'RFQ-7781', source: 'email' });
  });

  it('needs a reason for a no-bid, and follows its quote from draft to sent to accepted', async () => {
    const a = await make({ subject: 'Out of our range' });
    expect((await call(w.tokens.admin, 'POST', `/api/customer-rfqs/${a.id}/decision`, { decision: 'no_bid' })).statusCode).toBe(422);
    const nb = await call(w.tokens.admin, 'POST', `/api/customer-rfqs/${a.id}/decision`, { decision: 'no_bid', reason: 'Outside our capacity' });
    expect(nb.json()).toMatchObject({ status: 'no_bid', decision_reason: 'Outside our capacity' });
    expect((await call(w.tokens.admin, 'POST', `/api/customer-rfqs/${a.id}/decision`, { decision: 'bid' })).statusCode).toBe(409);

    const b = await make({ subject: 'Brackets for the line 4 retrofit' });
    const q = await call(w.tokens.admin, 'POST', `/api/customer-rfqs/${b.id}/quote`, { lines: [{ description: 'Bracket, machined', qty: 500, unitPrice: 12.4 }] });
    expect(q.statusCode, q.body).toBe(201);
    const { quoteId } = q.json();
    expect((await call(w.tokens.admin, 'POST', `/api/customer-rfqs/${b.id}/quote`, { lines: [{ description: 'again', qty: 1, unitPrice: 1 }] })).statusCode).toBe(409);
    expect((await call(w.tokens.admin, 'GET', `/api/customer-rfqs/${b.id}`)).json()).toMatchObject({ status: 'bid', quote_id: quoteId });

    const db = getAdminPool();
    await db.query(`UPDATE quote SET status = 'sent' WHERE id = $1`, [quoteId]);
    expect((await call(w.tokens.admin, 'GET', `/api/customer-rfqs/${b.id}`)).json()).toMatchObject({ status: 'quoted' });
    await db.query(`UPDATE quote SET status = 'accepted' WHERE id = $1`, [quoteId]);
    expect((await call(w.tokens.admin, 'GET', `/api/customer-rfqs/${b.id}`)).json()).toMatchObject({ status: 'won' });
  });

  it('shows overdue, today and this week on the board, and lists late ones in What is late', async () => {
    const late = await make({ subject: 'Late one', receivedOn: day(-10), responseDue: day(-3) });
    await make({ subject: 'Due today', responseDue: day(0) });
    const board = (await call(w.tokens.admin, 'GET', '/api/customer-rfqs/board')).json();
    expect(board.overdue.map((r: any) => r.id)).toContain(late.id);
    expect(board.today.length).toBeGreaterThanOrEqual(1);
    expect(board.thisWeek.length).toBeGreaterThanOrEqual(1);
    const sec = (await call(w.tokens.admin, 'GET', '/api/what-is-late')).json().sections.find((s: any) => s.key === 'customer-rfqs');
    expect(sec.rows.some((r: any) => r.detail === 'Late one' && r.daysLate === 3)).toBe(true);
  });

  it('reminds the owner once a day and reports response times', async () => {
    const n = await asActor(w.admin, (tx) => remindInboundRfqs(tx, w.tenantId));
    expect(n).toBeGreaterThanOrEqual(2);
    await asActor(w.admin, (tx) => remindInboundRfqs(tx, w.tenantId));
    const c = await getAdminPool().query(`SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'crfq-due:%'`, [w.tenantId]);
    expect(c.rows[0].n).toBe(n); // the second run added nothing
    const rep = (await call(w.tokens.admin, 'GET', '/api/reports/rfq-response')).json();
    expect(rep.kpis.find((k: any) => k.label === 'Requests received').value).toBeGreaterThanOrEqual(5);
    expect(rep.kpis.find((k: any) => k.label === 'Open and late').value).toBeGreaterThanOrEqual(1);
  });

  it('accepts a drawing or spreadsheet from the customer, and still refuses an executable', async () => {
    const r = await make({ subject: 'With files' });
    const up = (mime: string) => call(w.tokens.admin, 'POST', '/api/attachments', { subjectType: 'inbound_rfq', subjectId: r.id, fileName: 'spec.xlsx', mime, contentBase64: Buffer.from('hello').toString('base64') });
    expect((await up('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).statusCode).toBe(201);
    expect((await up('application/x-msdownload')).statusCode).toBe(422);
    const l = await call(w.tokens.admin, 'GET', `/api/attachments?subjectType=inbound_rfq&subjectId=${r.id}`);
    expect(l.json()).toHaveLength(1);
  });
});
