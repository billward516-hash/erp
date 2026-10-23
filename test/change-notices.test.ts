import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createSupplier } from '../src/modules/purchasing/service.js';
import { remindNotices } from '../src/modules/moc/notices.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Change notices with a tracked distribution list (SC-006 B). */
let app: FastifyInstance; let w: World; let cust: string; let sup: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('notice');
  await asActor(w.admin, async (tx) => {
    cust = (await createCustomer(tx, w.admin, { code: 'ACME', name: 'Acme Corp', kind: 'customer', paymentTerms: 'Net 30' })).id;
    sup = (await createSupplier(tx, w.admin, { code: 'S1', name: 'Atlas Bearing', paymentTerms: 'Net 30' })).id;
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe('change notice', () => {
  let id = ''; let rec: Record<string, string> = {};
  it('is drafted with colleagues, a customer and a supplier, and cannot be issued with nobody on the list', async () => {
    expect((await call(w.tokens.techA, 'POST', '/api/change-notices', { facilityId: w.facilities.A, kind: 'ecn', title: 'No no', summary: 'x'.repeat(5) })).statusCode).toBe(403);
    const empty = (await call(w.tokens.admin, 'POST', '/api/change-notices', { facilityId: w.facilities.A, kind: 'ecn', title: 'Empty', summary: 'Nobody listed' })).json();
    expect((await call(w.tokens.admin, 'POST', `/api/change-notices/${empty.id}/issue`)).statusCode).toBe(422);
    const r = await call(w.tokens.admin, 'POST', '/api/change-notices', { facilityId: w.facilities.A, kind: 'ecn', title: 'Bracket B-100 moves to 6061 aluminium', summary: 'Material change on bracket B-100',
      whatChanged: 'From 5052 to 6061; drawing rev C', effectiveOn: day(20), ackDueOn: day(5),
      recipients: [{ partyType: 'user', userId: w.admin.userId }, { partyType: 'user', userId: (await getAdminPool().query(`SELECT id FROM app_user WHERE tenant_id = $1 AND email LIKE 'techA@%'`, [w.tenantId])).rows[0].id },
        { partyType: 'customer', customerId: cust, email: 'quality@acme.example' }, { partyType: 'supplier', supplierId: sup }] });
    expect(r.statusCode, r.body).toBe(201);
    id = r.json().id; expect(r.json().number).toBe('ECN-00002');
    const g = (await call(w.tokens.admin, 'GET', `/api/change-notices/${id}`)).json();
    expect(g).toMatchObject({ status: 'draft', recipients: 4, outstanding: 4 });
    rec = Object.fromEntries(g.recipientList.map((x: any) => [x.party_type === 'user' ? x.name : x.party_type, x.id]));
    expect((await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/recipients`, { partyType: 'customer', customerId: cust })).statusCode).toBe(409); // already listed
  });

  it('issues: colleagues are told and marked sent; outside parties wait for the sender to confirm', async () => {
    const i = await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/issue`);
    expect(i.statusCode, i.body).toBe(200);
    const g = i.json();
    expect(g.status).toBe('issued');
    expect(g.recipientList.filter((r: any) => r.party_type === 'user').every((r: any) => r.sent_on)).toBe(true);
    expect(g.recipientList.find((r: any) => r.party_type === 'customer').sent_on).toBeNull();
    const pdf = await call(w.tokens.admin, 'GET', `/api/change-notices/${id}/pdf`);
    expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.slice(0, 4).toString()).toBe('%PDF');
    expect((await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/recipients/${rec.customer}/sent`, {})).statusCode).toBe(204);
    expect((await call(w.tokens.admin, 'PATCH', `/api/change-notices/${id}`, { title: 'Edited after issue' })).statusCode).toBe(409);
  });

  it('a colleague acknowledges their own line; outside parties are recorded by someone with authority, saying who and how', async () => {
    const mine = (await call(w.tokens.techA, 'GET', `/api/change-notices/${id}`)).json();
    expect(mine.mineToAcknowledge).toBeTruthy();
    expect((await call(w.tokens.techA, 'POST', `/api/change-notices/${id}/recipients/${mine.mineToAcknowledge}/acknowledge`, {})).statusCode).toBe(204);
    expect((await call(w.tokens.techA, 'POST', `/api/change-notices/${id}/recipients/${rec.customer}/acknowledge`, { method: 'email', byName: 'Pat' })).statusCode).toBe(403); // not theirs, no authority
    expect((await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/recipients/${rec.customer}/acknowledge`, { method: 'email' })).statusCode).toBe(422); // who confirmed?
    expect((await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/recipients/${rec.customer}/acknowledge`, { method: 'email', byName: 'Pat Lindqvist', note: 'Replied by email' })).statusCode).toBe(204);
    expect((await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/recipients/${rec.customer}/acknowledge`, { method: 'email', byName: 'Pat' })).statusCode).toBe(409);
    const g = (await call(w.tokens.admin, 'GET', `/api/change-notices/${id}`)).json();
    expect(g).toMatchObject({ acknowledged: 2, outstanding: 2 });
    expect(g.recipientList.find((r: any) => r.party_type === 'customer')).toMatchObject({ ack_by_name: 'Pat Lindqvist', ack_method: 'email' });
  });

  it('flags overdue acknowledgements, lists them in What is late, reminds once a day, and closing with some outstanding needs a reason', async () => {
    await getAdminPool().query('UPDATE change_notice SET ack_due_on = $2 WHERE id = $1', [id, day(-3)]);
    expect((await call(w.tokens.admin, 'GET', '/api/change-notices?outstanding=true')).json().find((n: any) => n.id === id)).toMatchObject({ overdue: true, outstanding: 2 });
    const late = (await call(w.tokens.admin, 'GET', '/api/what-is-late')).json().sections.find((s: any) => s.key === 'change-notices');
    expect(late.rows[0]).toMatchObject({ daysLate: 3 });
    expect(late.rows[0].detail).toMatch(/Atlas Bearing/);
    const n1 = await asActor(w.admin, (tx) => remindNotices(tx, w.tenantId));
    expect(n1).toBeGreaterThanOrEqual(1);
    const before = (await getAdminPool().query(`SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'cn-%'`, [w.tenantId])).rows[0].n;
    await asActor(w.admin, (tx) => remindNotices(tx, w.tenantId));
    expect((await getAdminPool().query(`SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'cn-%'`, [w.tenantId])).rows[0].n).toBe(before);
    expect((await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/close`, {})).statusCode).toBe(422);
    const closed = await call(w.tokens.admin, 'POST', `/api/change-notices/${id}/close`, { note: 'Supplier never replied; part not yet in use' });
    expect(closed.json().status).toBe('closed');
  });
});
