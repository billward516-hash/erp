import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { remindQuoteExpiry } from '../src/modules/sales/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Quote content, recorded acceptance and tracked validity. */
let app: FastifyInstance; let w: World; let cust: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('qacc');
  await asActor(w.admin, async (tx) => { cust = (await createCustomer(tx, w.admin, { code: 'ACME', name: 'Acme Corp', kind: 'customer', paymentTerms: 'Net 30' })).id; });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
const sent = async (validUntil: string, extra: any = {}) => {
  const q = (await call('POST', '/api/quotes', { facilityId: w.facilities.A, customerId: cust, title: 'Line 4 retrofit brackets', validUntil, lines: [{ description: 'Bracket, machined', qty: 100, unitPrice: 12.5 }], ...extra })).json();
  expect((await call('POST', `/api/quotes/${q.id}/submit`)).statusCode).toBeLessThan(300);
  expect((await call('POST', `/api/quotes/${q.id}/send`, {})).statusCode).toBeLessThan(300);
  return q;
};

describe('quote content and format', () => {
  it('keeps lead time, delivery, inclusions and exclusions, and renders a multi-section PDF', async () => {
    const q = await sent(day(30), { leadTime: '4 to 6 weeks from PO', deliveryTerms: 'FOB our dock', inclusions: 'Machining and inspection report', exclusions: 'Freight and taxes' });
    const g = (await call('GET', `/api/quotes/${q.id}`)).json();
    expect(g).toMatchObject({ lead_time: '4 to 6 weeks from PO', exclusions: 'Freight and taxes', days_left: 30 });
    const pdf = await call('GET', `/api/quotes/${q.id}/pdf`);
    expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.slice(0, 4).toString()).toBe('%PDF');
    const many = (await call('POST', '/api/quotes', { facilityId: w.facilities.A, customerId: cust, title: 'Long one', lines: Array.from({ length: 60 }, (_, i) => ({ description: `Item ${i + 1} with a reasonably long description of what is supplied`, qty: 1, unitPrice: 10 })) })).json();
    expect((await call('GET', `/api/quotes/${many.id}/pdf?preview=true`)).statusCode).toBe(200);
  });
});

describe('recorded acceptance', () => {
  it('needs who accepted, how and when; a PO method needs the PO; records the revision and total accepted', async () => {
    const q = await sent(day(20));
    expect((await call('POST', `/api/quotes/${q.id}/accept`, { customerPo: 'PO-1' })).statusCode).toBe(422); // no name or method
    expect((await call('POST', `/api/quotes/${q.id}/accept`, { acceptedByName: 'Dana Reyes', method: 'purchase_order' })).statusCode).toBe(422);
    expect((await call('POST', `/api/quotes/${q.id}/accept`, { acceptedByName: 'Dana Reyes', method: 'email', acceptedOn: day(3) })).statusCode).toBe(422);
    const ok = await call('POST', `/api/quotes/${q.id}/accept`, { acceptedByName: 'Dana Reyes', acceptedByTitle: 'Purchasing manager', method: 'purchase_order', customerPo: 'PO-9001', acceptedOn: day(0), note: 'Ship in two lots' });
    expect(ok.statusCode, ok.body).toBe(201);
    const g = (await call('GET', `/api/quotes/${q.id}`)).json();
    expect(g).toMatchObject({ status: 'accepted', accepted_by_name: 'Dana Reyes', accepted_by_title: 'Purchasing manager', accepted_method: 'purchase_order', accepted_revision: 1, customer_po: 'PO-9001', acceptance_note: 'Ship in two lots' });
    expect(Number(g.accepted_total)).toBe(1250);
    const list = (await call('GET', '/api/quotes')).json().find((x: any) => x.id === q.id);
    expect(list).toMatchObject({ accepted_by_name: 'Dana Reyes', accepted_method: 'purchase_order' });
  });

  it('keeps the signed quote filed on the quote', async () => {
    const q = await sent(day(20));
    const up = await call('POST', '/api/attachments', { subjectType: 'quote', subjectId: q.id, fileName: 'signed.pdf', mime: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 x').toString('base64') });
    expect(up.statusCode).toBe(201);
    expect((await call('GET', `/api/attachments?subjectType=quote&subjectId=${q.id}`)).json()).toHaveLength(1);
  });
});

describe('expiry tracking', () => {
  it('flags an expired quote, blocks acceptance, and allows an extension with a recorded reason', async () => {
    const q = await sent(day(10));
    await getAdminPool().query('UPDATE quote SET valid_until = $2 WHERE id = $1', [q.id, day(-2)]);
    const g = (await call('GET', `/api/quotes/${q.id}`)).json();
    expect(g).toMatchObject({ expired: true, days_left: -2 });
    const blocked = await call('POST', `/api/quotes/${q.id}/accept`, { acceptedByName: 'Dana', method: 'email' });
    expect(blocked.statusCode).toBe(422); expect(blocked.json().error.message).toMatch(/extend its validity/);
    expect((await call('POST', `/api/quotes/${q.id}/extend`, { validUntil: day(-1), reason: 'still in the past' })).statusCode).toBe(422);
    expect((await call('POST', `/api/quotes/${q.id}/extend`, { validUntil: day(14), reason: 'x' })).statusCode).toBe(422);
    const ext = await call('POST', `/api/quotes/${q.id}/extend`, { validUntil: day(14), reason: 'Customer budget approval pending' });
    expect(ext.statusCode, ext.body).toBe(200);
    expect(ext.json()).toMatchObject({ expired: false, days_left: 14 });
    expect(ext.json().validity[0]).toMatchObject({ reason: 'Customer budget approval pending' });
    expect((await call('POST', `/api/quotes/${q.id}/accept`, { acceptedByName: 'Dana', method: 'email' })).statusCode).toBe(201);
  });

  it('reminds the owner 7 days and 2 days before expiry and the day after, once each', async () => {
    const a = await sent(day(7)); const b = await sent(day(2)); const c = await sent(day(-1)); await sent(day(20));
    const n = await asActor(w.admin, (tx) => remindQuoteExpiry(tx, w.tenantId));
    expect(n).toBe(3);
    await asActor(w.admin, (tx) => remindQuoteExpiry(tx, w.tenantId));
    const rows = (await getAdminPool().query(`SELECT dedupe_key FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'quote-expiry:%'`, [w.tenantId])).rows.map((r) => r.dedupe_key);
    expect(rows.sort()).toEqual([`quote-expiry:${a.id}:7`, `quote-expiry:${b.id}:2`, `quote-expiry:${c.id}:-1`].sort());
  });
});

describe('quote outcomes report', () => {
  it('counts accepted, declined and expired quotes with how and why', async () => {
    const r = (await call('GET', '/api/reports/quote-outcomes')).json();
    expect(r.rows.some((x: any) => x.outcome === 'Accepted' && x.accepted_by_name === 'Dana Reyes' && x.accepted_method === 'purchase_order')).toBe(true);
    expect(r.rows.some((x: any) => x.outcome === 'Expired unanswered')).toBe(true);
    expect(r.rows.some((x: any) => x.extensions === 1)).toBe(true);
    expect(r.kpis.find((k: any) => k.label === 'Quotes sent').value).toBeGreaterThanOrEqual(8);
  });
});
