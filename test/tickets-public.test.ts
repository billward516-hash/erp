import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { setFeature } from '../src/modules/features/service.js';
import { createRequestLink } from '../src/modules/sites/service.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { forgetEdition } from '../src/platform/edition.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { getTicket, listTickets } from '../src/modules/tickets/service.js';
import { createIntakeLink, listIntakeLinks, revokeIntakeLink, saveCategory } from '../src/modules/tickets/setup.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let app: FastifyInstance; let w: World; let manager: Actor; let managerToken: string; let agentToken: string; let acme: string; let globex: string; let fid: string;
const A = <T>(who: Actor, fn: (tx: any) => Promise<T>) => asActor(who, fn);
const post = (token: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/public/tickets/${token}`, payload: body });
const good = (over: Record<string, unknown> = {}) => ({ name: 'Rita Customer', contact: 'rita@acme.example', subject: 'Cannot log in', description: 'The portal rejects my password.', ...over });

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('tkt-public');
  fid = w.facilities.A!;
  const u = await createUserWithToken(db(), w.tenantId, { email: `sm-${Date.now()}@tp.example`, displayName: 'Sam Manager', roles: [{ role: 'support_manager', facility: fid }] });
  manager = (await loadActor(w.tenantId, u.userId))!; managerToken = u.token;
  agentToken = (await createUserWithToken(db(), w.tenantId, { email: `ag-${Date.now()}@tp.example`, displayName: 'Ann Agent', roles: [{ role: 'support_agent', facility: fid }] })).token;
  await A(w.admin, async (tx) => {
    acme = (await createCustomer(tx, w.admin, { code: 'ACME', name: 'Acme Ltd', kind: 'customer' })).id;
    globex = (await createCustomer(tx, w.admin, { code: 'GLOBEX', name: 'Globex', kind: 'customer' })).id;
  });
  await A(manager, (tx) => saveCategory(tx, manager, { name: 'Access' }));
});
afterAll(async () => { await app.close(); await closePools(); });

describe('the public ticket link', () => {
  let link: any;
  it('opens a form that shows only the site, the customer and the categories', async () => {
    link = await A(manager, (tx) => createIntakeLink(tx, manager, { facilityId: fid, customerId: acme, label: 'Acme staff, help page' }));
    expect(link.token).toMatch(/^tkt_[A-Za-z0-9_-]{20,}$/);
    const r = await app.inject({ url: `/public/tickets/${link.token}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ site: 'Plant A', customer: 'Acme Ltd', categories: [{ id: expect.any(String), name: 'Access' }] });
    // only the hash is stored
    const stored = (await db().query('SELECT encode(token_hash, \'hex\') AS h FROM ticket_intake_link WHERE id = $1', [link.id])).rows[0].h;
    expect(stored).not.toContain(link.token);
  });

  it('raises a ticket for that customer at that site and nothing else, whatever the request says', async () => {
    const r = await post(link.token, good({ customerId: globex, facilityId: w.facilities.B, priority: 'urgent', assigneeUserId: w.admin.userId, status: 'resolved' }));
    expect(r.statusCode).toBe(201);
    expect(r.json().reference).toMatch(/^TCK-\d{6}$/);
    const t = (await db().query('SELECT * FROM ticket WHERE number = $1 AND tenant_id = $2', [r.json().reference, w.tenantId])).rows[0];
    expect(t).toMatchObject({ customer_id: acme, facility_id: fid, channel: 'public_form', created_by: null, intake_link_id: link.id, priority: 'normal', status: 'new', assignee_user_id: null,
      requester_name: 'Rita Customer', requester_contact: 'rita@acme.example', subject: 'Cannot log in' });
    // the people who manage tickets at the site are told; the ticket is in their queue
    const bell = await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'ticket.received' AND subject_id = $2`, [manager.userId, t.id]);
    expect(bell.rows[0].n).toBe(1);
    expect((await A(manager, (tx) => listTickets(tx, manager, { view: 'unassigned' }))).rows.map((x: any) => x.id)).toContain(t.id);
    const detail = await A(manager, (tx) => getTicket(tx, manager, t.id));
    expect(detail.entries[0].body).toMatch(/Ticket raised by Rita Customer \(Public form\)/);
    expect(detail.entries[0].author_user_id).toBeNull();
  });

  it('can ask for attention (high) but never sets the top priority', async () => {
    const r = await post(link.token, good({ urgent: true }));
    expect(r.statusCode).toBe(201);
    expect((await db().query('SELECT priority FROM ticket WHERE number = $1 AND tenant_id = $2', [r.json().reference, w.tenantId])).rows[0].priority).toBe('high');
  });

  it('asks for a name, a way to reach the person and a description', async () => {
    expect((await post(link.token, good({ name: ' ' }))).statusCode).toBe(422);
    expect((await post(link.token, good({ contact: 'x' }))).statusCode).toBe(422);
    expect((await post(link.token, good({ description: 'no' }))).statusCode).toBe(422);
    expect((await post(link.token, good({ subject: '' }))).statusCode).toBe(422);
  });

  it('is not found for a wrong, malformed, other-kind or revoked token', async () => {
    for (const t of ['tkt_' + 'a'.repeat(30), 'tkt_shorter1', 'not-a-token-at-all', `${link.token}x`]) expect((await app.inject({ url: `/public/tickets/${t}` })).statusCode).toBe(404);
    // a site request link (maintenance) does not open a ticket form, and a ticket link does not open the maintenance form
    const siteLink = await A(w.admin, (tx) => createRequestLink(tx, w.admin, fid, 'Residents'));
    expect((await app.inject({ url: `/public/tickets/${siteLink.token}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/public/requests/${link.token}` })).statusCode).toBe(404);
    const second = await A(manager, (tx) => createIntakeLink(tx, manager, { facilityId: fid, customerId: globex, label: 'Globex' }));
    expect((await app.inject({ url: `/public/tickets/${second.token}` })).json().customer).toBe('Globex');
    await A(manager, (tx) => revokeIntakeLink(tx, manager, second.id));
    expect((await app.inject({ url: `/public/tickets/${second.token}` })).statusCode).toBe(404);
    expect((await post(second.token, good())).statusCode).toBe(404);
    const links = await A(manager, (tx) => listIntakeLinks(tx, manager, fid));
    expect(links.find((l: any) => l.id === second.id)).toMatchObject({ active: false, customer_name: 'Globex', tickets: 0 });
    expect(links.find((l: any) => l.id === link.id)!.tickets).toBeGreaterThanOrEqual(2);
  });

  it('only people who manage tickets at that site make links, and only for an active customer', async () => {
    const agent = (await loadActor(w.tenantId, (await db().query(`SELECT id FROM app_user WHERE email LIKE 'ag-%@tp.example' AND tenant_id = $1`, [w.tenantId])).rows[0].id))!;
    await expect(A(agent, (tx) => createIntakeLink(tx, agent, { facilityId: fid, customerId: acme, label: 'x' }))).rejects.toThrow(/tickets.manage/);
    await expect(A(manager, (tx) => createIntakeLink(tx, manager, { facilityId: w.facilities.B!, customerId: acme, label: 'x' }))).rejects.toThrow();
    await expect(A(manager, (tx) => createIntakeLink(tx, manager, { facilityId: fid, customerId: acme, label: ' ' }))).rejects.toThrow(/label/);
  });

  it('throttles one link to 20 tickets an hour', async () => {
    const busy = await A(manager, (tx) => createIntakeLink(tx, manager, { facilityId: fid, customerId: acme, label: 'Busy' }));
    for (let i = 0; i < 20; i++) expect((await post(busy.token, good({ subject: `Ticket ${i}` }))).statusCode).toBe(201);
    const over = await post(busy.token, good());
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toMatch(/too many requests/);
    // another link is unaffected
    expect((await post(link.token, good())).statusCode).toBe(201);
    // an hour later the busy link works again
    await db().query(`UPDATE ticket SET created_at = created_at - interval '2 hours' WHERE intake_link_id = $1`, [busy.id]);
    expect((await post(busy.token, good())).statusCode).toBe(201);
  });

  it('is stopped when the feature is turned off for the company, and the signed-in side follows the feature and edition', async () => {
    await A(w.admin, (tx) => setFeature(tx, w.admin, 'tickets', { mode: 'off' }));
    expect((await app.inject({ url: `/public/tickets/${link.token}` })).statusCode).toBe(404);
    expect((await post(link.token, good())).statusCode).toBe(404);
    const api = await app.inject({ url: '/api/tickets', headers: { authorization: `Bearer ${managerToken}` } });
    expect(api.statusCode).toBe(403);
    expect(api.json().error.code).toBe('feature_off');
    await A(w.admin, (tx) => setFeature(tx, w.admin, 'tickets', { mode: 'all' }));
    expect((await app.inject({ url: `/public/tickets/${link.token}` })).statusCode).toBe(200);
  });
});

describe('the signed-in ticket API', () => {
  it('serves the queue, a ticket and the reply, with permissions checked', async () => {
    const h = { authorization: `Bearer ${agentToken}` };
    const created = await app.inject({ method: 'POST', url: '/api/tickets', headers: h, payload: { facilityId: fid, customerId: acme, subject: 'API ticket', priority: 'high', channel: 'phone' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ url: '/api/tickets?view=unassigned&q=API%20ticket', headers: h })).json().rows.map((r: any) => r.id)).toContain(id);
    const reply = await app.inject({ method: 'POST', url: `/api/tickets/${id}/entries`, headers: h, payload: { kind: 'reply', body: 'On it.', statusAfter: 'waiting_customer' } });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().status).toBe('waiting_customer');
    const one = (await app.inject({ url: `/api/tickets/${id}`, headers: h })).json();
    expect(one.sla.paused).toBe(true);
    expect(one.next).toEqual(['open', 'waiting_third_party', 'resolved']);
    // service levels are the manager's: reading is open to anyone who can see tickets
    expect((await app.inject({ url: '/api/tickets/service-levels', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/tickets/service-levels', headers: h, payload: { name: 'x', priority: 'low' } })).statusCode).toBe(403);
    // a user with no ticket permission at all
    const op = { authorization: `Bearer ${w.tokens.operatorB}` };
    expect((await app.inject({ url: '/api/tickets', headers: op })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/reports/ticket-volume', headers: op })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/reports/ticket-volume', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/reports/ticket-volume?format=csv', headers: { authorization: `Bearer ${managerToken}` } })).statusCode).toBe(200);
  });

  it('keeps a file on a ticket for those who may see the ticket', async () => {
    const h = { authorization: `Bearer ${agentToken}` };
    const id = (await app.inject({ method: 'POST', url: '/api/tickets', headers: h, payload: { facilityId: fid, customerId: acme, subject: 'With a file' } })).json().id;
    const up = await app.inject({ method: 'POST', url: `/api/tickets/${id}/files`, headers: h, payload: { fileName: 'error.txt', mime: 'text/plain', contentBase64: Buffer.from('error 42').toString('base64') } });
    expect(up.statusCode).toBe(201);
    const file = await app.inject({ url: `/api/tickets/${id}/files/${up.json().id}`, headers: h });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('error 42');
    expect((await app.inject({ url: `/api/tickets/${id}`, headers: h })).json().files).toHaveLength(1);
    expect((await app.inject({ url: `/api/tickets/${id}/files/${up.json().id}`, headers: { authorization: `Bearer ${w.tokens.operatorB}` } })).statusCode).toBe(404);   // another site: the ticket is invisible
    expect((await app.inject({ method: 'POST', url: `/api/tickets/${id}/files`, headers: h, payload: { fileName: 'x.exe', mime: 'application/x-msdownload', contentBase64: 'AA==' } })).statusCode).toBe(422);
  });
});

describe('the Standard edition and per-address limits', () => {
  it('Lite companies are refused the ticket API', async () => {
    const n = `lite-tk-${process.pid}-${Date.now() % 100000}`;
    const t = await provisionTenant(db(), { slug: n, name: 'Tiny Co', legalEntity: 'Tiny Co LLC', edition: 'lite', facilities: [{ code: 'SHOP', name: 'Shop', timezone: 'America/Chicago', kind: 'office' }] });
    const u = await createUserWithToken(db(), t.tenantId, { email: `o@${n}.example`, displayName: 'Owner', roles: [{ role: 'admin', facility: null }] });
    forgetEdition();
    const r = await app.inject({ url: '/api/tickets', headers: { authorization: `Bearer ${u.token}` } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('edition');
  });

  it('answers a flood from one address with 429 on the public form', async () => {
    const limited = buildApp({ hardening: { perAddressPerMinute: 3 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.inject({ url: `/public/tickets/tkt_${'z'.repeat(30)}` })).statusCode);
      expect(codes).toEqual([404, 404, 404, 429, 429]);
    } finally { await limited.close(); }
  });
});
