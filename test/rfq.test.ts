import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { remindRfqs } from '../src/modules/purchasing/rfq.js';
import { createPart } from '../src/modules/parts/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Request for quote, buyer side (SC-005 A). */
let app: FastifyInstance; let w: World; let part: string; const sup: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('rfq');
  await asActor(w.admin, async (tx) => {
    part = (await createPart(tx, w.admin, { partNumber: 'BRG-6204', description: 'Bearing 6204', uom: 'EA' })).id;
    for (const [k, n] of [['a', 'Atlas Bearing'], ['b', 'Buckeye Supply'], ['c', 'Cardinal Parts']]) sup[k!] = (await createSupplier(tx, w.admin, { code: k!.toUpperCase(), name: n!, paymentTerms: 'Net 30' })).id;
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe('request for quote', () => {
  let id = ''; let lines: any[] = []; let inv: Record<string, string> = {};
  it('is made by a buyer with lines and suppliers, and cannot be sent without a reply date', async () => {
    expect((await call(w.tokens.techA, 'POST', '/api/rfqs', { facilityId: w.facilities.A, title: 'Not allowed', lines: [{ description: 'y', qty: 1 }] })).statusCode).toBe(403);
    const r = await call(w.tokens.admin, 'POST', '/api/rfqs', { facilityId: w.facilities.A, title: 'Bearings for HMC-201 rebuild', neededBy: day(30), notes: 'Delivered to the dock',
      lines: [{ partId: part, qty: 20, targetPrice: 12 }, { description: 'Spindle seal kit', qty: 2 }], supplierIds: [sup.a, sup.b, sup.c] });
    expect(r.statusCode, r.body).toBe(201);
    const g = r.json(); id = g.id; lines = g.lines;
    expect(g).toMatchObject({ number: 'RFQ-000001', status: 'draft' });
    expect(g.lines[0].description).toBe('BRG-6204 Bearing 6204');
    inv = Object.fromEntries(g.invites.map((i: any) => [i.supplier_code.toLowerCase(), i.id]));
    const noDate = await call(w.tokens.admin, 'POST', `/api/rfqs/${id}/send`);
    expect(noDate.statusCode).toBe(422); expect(noDate.json().error.message).toMatch(/date suppliers must reply/);
    await getAdminPool().query('UPDATE rfq SET respond_by = $2 WHERE id = $1', [id, day(7)]);
    const sent = await call(w.tokens.admin, 'POST', `/api/rfqs/${id}/send`);
    expect(sent.json()).toMatchObject({ status: 'sent' });
    expect(sent.json().answer).toMatch(/0 of 3 suppliers have answered/);
    const pdf = await call(w.tokens.admin, 'GET', `/api/rfqs/${id}/pdf`);
    expect(pdf.statusCode).toBe(200); expect(pdf.headers['content-type']).toBe('application/pdf'); expect(pdf.rawPayload.slice(0, 4).toString()).toBe('%PDF');
  });

  it('records replies per line and compares price, landed cost and lead time', async () => {
    const reply = (key: string, a: number, b: number | null, extra: any) => call(w.tokens.admin, 'POST', `/api/rfqs/${id}/invites/${inv[key]}/response`,
      { lines: [{ rfqLineId: lines[0].id, unitPrice: a, leadTimeDays: extra.lead, minQty: extra.min ?? null }, ...(b != null ? [{ rfqLineId: lines[1].id, unitPrice: b, leadTimeDays: extra.lead }] : [])], freight: extra.freight, paymentTerms: 'Net 30' });
    expect((await reply('a', 11, 40, { lead: 14, freight: 60 })).statusCode).toBe(200);   // goods 220+80=300, landed 360
    expect((await reply('b', 12.5, 35, { lead: 5, freight: 0 })).statusCode).toBe(200);    // goods 250+70=320, landed 320, fastest
    const g = (await call(w.tokens.admin, 'GET', `/api/rfqs/${id}`)).json();
    expect(g.answer).toMatch(/2 of 3 suppliers have answered.*waiting for Cardinal Parts/);
    const c0 = g.cells[0];
    expect(c0.lowest).toBe(11);
    expect(c0.offers.find((o: any) => o.inviteId === inv.a)).toMatchObject({ unitPrice: 11, isLowest: true, isFastest: false });
    expect(c0.offers.find((o: any) => o.inviteId === inv.b)).toMatchObject({ unitPrice: 12.5, isFastest: true });
    expect(g.totals.find((t: any) => t.inviteId === inv.a)).toMatchObject({ goods: 300, landed: 360, best: false });
    expect(g.totals.find((t: any) => t.inviteId === inv.b)).toMatchObject({ goods: 320, landed: 320, best: true });
    expect(g.overdue).toBe(false);
  });

  it('is reminded and listed as late once the reply date passes with someone still silent', async () => {
    await getAdminPool().query('UPDATE rfq SET respond_by = $2 WHERE id = $1', [id, day(-3)]);
    const n = await asActor(w.admin, (tx) => remindRfqs(tx, w.tenantId));
    expect(n).toBe(1);
    const note = (await getAdminPool().query(`SELECT title FROM notification WHERE tenant_id = $1 AND title LIKE 'RFQ-000001%'`, [w.tenantId])).rows[0];
    expect(note.title).toMatch(/3 days late: still waiting for Cardinal Parts/);
    const late = (await call(w.tokens.admin, 'GET', '/api/what-is-late')).json().sections.find((s: any) => s.key === 'rfqs');
    expect(late.rows[0]).toMatchObject({ label: 'RFQ-000001 · Bearings for HMC-201 rebuild', daysLate: 3, detail: 'Waiting for Cardinal Parts' });
    expect((await call(w.tokens.admin, 'GET', `/api/rfqs?status=sent`)).json()[0]).toMatchObject({ overdue: true, invited: 3, answered: 2 });
  });

  it('awards by line: a supplier that is not the lowest needs a reason; the award becomes one purchase request at those prices', async () => {
    const dear = await call(w.tokens.admin, 'POST', `/api/rfqs/${id}/award`, { awards: [{ rfqLineId: lines[0].id, inviteId: inv.b }] });
    expect(dear.statusCode).toBe(422); expect(dear.json().error.message).toMatch(/Buckeye Supply is not the lowest price; say why/);
    const none = await call(w.tokens.admin, 'POST', `/api/rfqs/${id}/award`, { awards: [{ rfqLineId: lines[0].id, inviteId: inv.c }] });
    expect(none.json().error.message).toMatch(/that supplier gave no price/);
    const ok = await call(w.tokens.admin, 'POST', `/api/rfqs/${id}/award`, { awards: [{ rfqLineId: lines[0].id, inviteId: inv.b, reason: 'Five-day lead time; the rebuild is booked' }, { rfqLineId: lines[1].id, inviteId: inv.b, reason: 'Lowest landed cost overall' }] });
    expect(ok.statusCode, ok.body).toBe(200);
    const b = ok.json();
    expect(b).toMatchObject({ linesLeft: 0, requestNumber: expect.stringMatching(/^PR-/) });
    expect(b.rfq).toMatchObject({ status: 'awarded' });
    const pr = (await call(w.tokens.admin, 'GET', `/api/purchase-requests/${b.requestId}`)).json();
    expect(pr.lines.map((l: any) => [Number(l.qty), Number(l.est_unit_price), l.supplier_id])).toEqual([[20, 12.5, sup.b], [2, 35, sup.b]]);
    expect((await call(w.tokens.admin, 'POST', `/api/rfqs/${id}/cancel`, { reason: 'too late' })).statusCode).toBe(409);
    const kept = (await getAdminPool().query(`SELECT award_reason FROM rfq_line WHERE rfq_id = $1 ORDER BY line_no`, [id])).rows.map((r) => r.award_reason);
    expect(kept[0]).toMatch(/Five-day lead time/);
  });

  it('keeps companies apart', async () => {
    const other = await makeWorld('rfq2');
    expect((await call(other.tokens.admin, 'GET', `/api/rfqs/${id}`)).statusCode).toBe(404);
    expect((await call(other.tokens.admin, 'GET', '/api/rfqs')).json()).toEqual([]);
  });
});
