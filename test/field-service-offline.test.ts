import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { receive } from '../src/modules/inventory/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/**
 * My day offline (SC-002, D-121, D-183C): the tablet queues start, report draft and report submission with an Idempotency-Key and
 * replays them in order. A replay after a lost answer must change nothing a second time.
 */
let app: FastifyInstance; let w: World; let tia = ''; let tiaTok = ''; let dispTok = ''; let visit = ''; let part = ''; let truckLoc = ''; let truck = '';
const db = () => getAdminPool();
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (n: number) => { let d = n; while ([0, 6].includes(new Date(Date.now() + d * 86_400_000).getUTCDay())) d++; return day(d); };
const call = (token: string, method: string, url: string, payload?: unknown, key?: string) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) }, payload: payload as any });
const count = async (sql: string, args: unknown[]) => Number((await db().query(sql, args)).rows[0].n);
const SIG = 'data:image/png;base64,iVBORw0KGgo=';

beforeAll(async () => {
  app = buildApp(); w = await makeWorld('fsoff');
  await db().query(`INSERT INTO facility_entitlement (tenant_id, facility_id, module_key) VALUES ($1, $2, 'field_service')`, [w.tenantId, w.facilities.A]);
  tia = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name) VALUES ($1, $2, 'T1', 'Tia', 'Nguyen') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
  tiaTok = (await createUserWithToken(db(), w.tenantId, { email: 'tia-off@x.example', displayName: 'Tia', roles: [{ role: 'field_technician', facility: w.facilities.A! }], employeeId: tia })).token;
  dispTok = (await createUserWithToken(db(), w.tenantId, { email: 'disp-off@x.example', displayName: 'Dee', roles: [{ role: 'service_dispatcher', facility: w.facilities.A! }] })).token;
  const A = w.tokens.admin!;
  const cust = await asActor(w.admin, async (tx) => {
    part = (await createPart(tx, w.admin, { partNumber: 'OFF-FLT', description: 'Filter', uom: 'EA' })).id;
    return (await createCustomer(tx, w.admin, { code: 'OFFC', name: 'Offline Mall', kind: 'customer', paymentTerms: 'Net 30' })).id;
  });
  truck = (await call(A, 'POST', '/api/vehicles', { facilityId: w.facilities.A, tag: 'VAN-9', name: 'Van 9' })).json().id;
  truckLoc = (await db().query('SELECT truck_location_id FROM vehicle_profile WHERE asset_id = $1', [truck])).rows[0].truck_location_id;
  await asActor(w.admin, (tx) => receive(tx, w.admin, { locationId: truckLoc, partId: part, qty: 5, unitCost: 10 }));
  await call(A, 'PUT', `/api/technicians/${tia}`, { homeLat: 39.7, homeLon: -84.2, skills: ['hvac'], vehicleId: truck });
  const site = (await call(A, 'POST', '/api/customer-sites', { customerId: cust, name: 'Plant', lat: 39.76, lon: -84.19 })).json().id;
  const unit = (await call(A, 'POST', '/api/customer-equipment', { facilityId: w.facilities.A, customerId: cust, siteId: site, assetTag: 'OFF-1', name: 'RTU' })).json().id;
  const agr = (await call(A, 'POST', '/api/service-agreements', { facilityId: w.facilities.A, customerId: cust, startsOn: day(-1), billingModel: 'per_visit', perVisitFee: 100 })).json().id;
  const when = weekday(2);
  await call(A, 'POST', `/api/service-agreements/${agr}/plans`, { assetId: unit, title: 'Offline PM', everyN: 3, unit: 'month', firstDueOn: when, estimatedMinutes: 60, requiredSkill: 'hvac', checklist: ['Check belts'], perVisitFee: 100 });
  await call(A, 'POST', `/api/service-agreements/${agr}/activate`);
  visit = (await call(A, 'GET', '/api/service-visits?unassigned=true')).json().find((v: any) => v.title === 'Offline PM').id;
  expect((await call(dispTok, 'POST', `/api/service-visits/${visit}/assign`, { technicianId: tia, date: when })).statusCode).toBe(200);
});
afterAll(async () => { await app.close(); await closePools(); });

describe('replay of queued field-service writes', () => {
  const status = async () => (await db().query('SELECT status FROM service_visit WHERE id = $1', [visit])).rows[0].status;

  it('start: a repeat with the same key is answered from the first answer; a keyless repeat on a started visit is harmless', async () => {
    const first = await call(tiaTok, 'POST', `/api/service-visits/${visit}/start`, {}, 'q-start-0001');
    const again = await call(tiaTok, 'POST', `/api/service-visits/${visit}/start`, {}, 'q-start-0001');
    expect([first.statusCode, again.statusCode, again.headers['idempotent-replay']]).toEqual([204, 204, 'true']);
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1 AND action = 'service_visit.started'`, [visit])).toBe(1);
    const keyless = await call(tiaTok, 'POST', `/api/service-visits/${visit}/start`, {});
    expect(keyless.statusCode).toBe(204);
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1 AND action = 'service_visit.started'`, [visit])).toBe(1);
    expect(await status()).toBe('in_progress');
    // The same key may not be borrowed for another request.
    expect((await call(tiaTok, 'PUT', `/api/service-visits/${visit}/report`, { workPerformed: 'x' }, 'q-start-0001')).statusCode).toBe(422);
  });

  it('report draft: saved twice with the same key, kept once; an omitted signature keeps the saved one', async () => {
    const body = { workPerformed: 'Started the PM', laborHours: 1, customerSignedName: 'Pat', signaturePng: SIG };
    const a = await call(tiaTok, 'PUT', `/api/service-visits/${visit}/report`, body, 'q-draft-0001');
    const b = await call(tiaTok, 'PUT', `/api/service-visits/${visit}/report`, body, 'q-draft-0001');
    expect([a.statusCode, b.statusCode, b.headers['idempotent-replay']]).toEqual([200, 200, 'true']);
    expect(await count('SELECT count(*) AS n FROM service_report WHERE visit_id = $1', [visit])).toBe(1);
    // The restored form sends no signature when the technician has not signed again: the saved one stays.
    const c = await call(tiaTok, 'PUT', `/api/service-visits/${visit}/report`, { workPerformed: 'Started the PM, belts checked', laborHours: 1, customerSignedName: 'Pat' }, 'q-draft-0002');
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ hasSignature: true, work_performed: 'Started the PM, belts checked', status: 'draft' });
    // The draft comes back from the server for the form to restore.
    const got = (await call(tiaTok, 'GET', `/api/service-visits/${visit}/report`)).json();
    expect(got).toMatchObject({ status: 'draft', labor_hours: 1, customer_signed_name: 'Pat', hasSignature: true });
    // Signing again, or clearing, still works.
    expect((await call(tiaTok, 'PUT', `/api/service-visits/${visit}/report`, { workPerformed: 'x', signaturePng: null })).json().hasSignature).toBe(false);
  });

  it('submit: labor, parts, the work order and the report are posted once however often it is sent', async () => {
    const body = { checklistResults: [{ item: 'Check belts', result: 'ok' }], workPerformed: 'Replaced filters', findings: 'All good', laborHours: 1.5, partsUsed: [{ partId: part, qty: 2 }],
      customerPresent: true, customerSignedName: 'Pat Lindqvist', signaturePng: SIG };
    const first = await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, body, 'q-submit-0001');
    expect(first.statusCode, first.body).toBe(200);
    const again = await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, body, 'q-submit-0001');
    expect([again.statusCode, again.headers['idempotent-replay']]).toEqual([200, 'true']);
    expect(again.json()).toEqual(first.json());
    const wo = (await db().query('SELECT work_order_id FROM service_visit WHERE id = $1', [visit])).rows[0].work_order_id;
    expect(await count('SELECT count(*) AS n FROM work_order_labor WHERE work_order_id = $1', [wo])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM inventory_txn WHERE work_order_id = $1 AND qty < 0`, [wo])).toBe(1);
    expect(Number((await db().query('SELECT qty_on_hand::float AS n FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [truckLoc, part])).rows[0].n)).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1 AND action = 'service_report.submitted'`, [visit])).toBe(1);
    expect(await status()).toBe('completed');
  });

  it('a different key after completion is a refusal with a reason (what the tablet shows for the technician to discard)', async () => {
    const late = await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, {}, 'q-submit-0002');
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toMatch(/visit is completed/);
    // The failure is not stored: the key is free again, nothing was recorded for it.
    expect(await count(`SELECT count(*) AS n FROM idempotency_record WHERE key = 'q-submit-0002'`, [])).toBe(0);
  });
});
