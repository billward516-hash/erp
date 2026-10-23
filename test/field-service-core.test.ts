import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { generateVisitsForTenant, nextDueAfter } from '../src/modules/fieldservice/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Field service core (SC-002 F1): licensing, customer equipment, agreements and generated visits. */
let app: FastifyInstance; let w: World; let unlicensed: World; let cust: string; let site: string; let unit1: string; let unit2: string; let tech: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const db = () => getAdminPool();
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('fs1'); unlicensed = await makeWorld('fs2');
  await db().query(`INSERT INTO facility_entitlement (tenant_id, facility_id, module_key) VALUES ($1, $2, 'field_service')`, [w.tenantId, w.facilities.A]);
  await asActor(w.admin, async (tx) => { cust = (await createCustomer(tx, w.admin, { code: 'MALL', name: 'Riverside Mall', kind: 'customer', paymentTerms: 'Net 30' })).id; });
  tech = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name) VALUES ($1, $2, 'T1', 'Tia', 'Nguyen') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe('licensing', () => {
  it('is refused where the site is not licensed, and by people without the permission', async () => {
    const un = await call(unlicensed.tokens.admin, 'POST', '/api/vehicles', { facilityId: unlicensed.facilities.A, tag: 'TRK-1', name: 'Truck 1' });
    expect(un.statusCode).toBe(402); expect(un.json().error.code).toBe('module_not_licensed');
    expect((await call(w.tokens.techA, 'POST', '/api/vehicles', { facilityId: w.facilities.A, tag: 'TRK-1', name: 'Truck 1' })).statusCode).toBe(403);
    expect((await call(w.tokens.admin, 'POST', '/api/vehicles', { facilityId: w.facilities.A, tag: 'TRK-1', name: 'Truck 1', plate: 'ABC123' })).statusCode).toBe(201);
  });
});

describe('sites, equipment, technicians', () => {
  it('keeps a customer’s sites and the equipment at them as assets owned by the customer', async () => {
    const s = await call(w.tokens.admin, 'POST', '/api/customer-sites', { customerId: cust, name: 'Riverside Mall main plant', address: { line1: '1 River Rd', city: 'Dayton', state: 'OH' }, lat: 39.76, lon: -84.19, accessNotes: 'Check in at security' });
    expect(s.statusCode, s.body).toBe(201); site = s.json().id;
    expect((await call(w.tokens.admin, 'POST', '/api/customer-sites', { customerId: cust, name: 'riverside mall MAIN plant' })).statusCode).toBe(409);
    expect((await call(w.tokens.admin, 'POST', '/api/customer-sites', { customerId: cust, name: 'Half place', lat: 39 })).statusCode).toBe(422);
    const mk = async (tag: string) => (await call(w.tokens.admin, 'POST', '/api/customer-equipment', { facilityId: w.facilities.A, customerId: cust, siteId: site, assetTag: tag, name: `Rooftop unit ${tag}`, manufacturer: 'Carrier', model: '48TC' })).json();
    unit1 = (await mk('RTU-1')).id; unit2 = (await mk('RTU-2')).id;
    expect((await call(w.tokens.admin, 'POST', '/api/customer-equipment', { facilityId: w.facilities.A, customerId: cust, siteId: site, assetTag: 'rtu-1', name: 'dup' })).statusCode).toBe(409);
    expect((await call(w.tokens.admin, 'GET', `/api/customer-equipment?customerId=${cust}`)).json().map((a: any) => a.asset_tag)).toEqual(['RTU-1', 'RTU-2']);
    expect((await call(w.tokens.admin, 'GET', '/api/customer-sites')).json()[0]).toMatchObject({ name: 'Riverside Mall main plant', equipment: 2 });
  });
  it('records a technician’s skills, hours and time off', async () => {
    const t = await call(w.tokens.admin, 'PUT', `/api/technicians/${tech}`, { homeLat: 39.7, homeLon: -84.2, skills: ['HVAC', ' refrigeration ', 'hvac'], workDays: [1, 2, 3, 4] });
    expect(t.statusCode, t.body).toBe(200); expect(t.json().skills).toEqual(['hvac', 'refrigeration']);
    expect((await call(w.tokens.admin, 'PUT', `/api/technicians/${tech}`, { workDays: [9] })).statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'PUT', `/api/technicians/${tech}`, { dayStart: '17:00', dayEnd: '08:00' })).statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'POST', `/api/technicians/${tech}/time-off`, { fromDate: day(5), toDate: day(7), reason: 'Holiday' })).statusCode).toBe(201);
    expect((await call(w.tokens.admin, 'GET', '/api/technicians')).json()[0]).toMatchObject({ first_name: 'Tia', skills: ['hvac', 'refrigeration'] });
    expect((await call(w.tokens.admin, 'GET', '/api/technician-time-off')).json()).toHaveLength(1);
  });
});

describe('agreements and visit generation', () => {
  let agr = ''; let planA = '';
  it('an agreement needs the right fees and covered units before it can be activated', async () => {
    expect((await call(w.tokens.admin, 'POST', '/api/service-agreements', { facilityId: w.facilities.A, customerId: cust, startsOn: day(0), billingModel: 'monthly' })).statusCode).toBe(422);
    const a = await call(w.tokens.admin, 'POST', '/api/service-agreements', { facilityId: w.facilities.A, customerId: cust, startsOn: day(0), billingModel: 'per_visit', perVisitFee: 180, responseHours: 24 });
    expect(a.statusCode, a.body).toBe(201); agr = a.json().id; expect(a.json().number).toBe('SA-000001');
    expect((await call(w.tokens.admin, 'POST', `/api/service-agreements/${agr}/activate`)).statusCode).toBe(422); // no covered units
    const other = (await call(w.tokens.admin, 'POST', '/api/customer-sites', { customerId: (await asActor(w.admin, (tx) => createCustomer(tx, w.admin, { code: 'OTH', name: 'Other Co', kind: 'customer' }))).id, name: 'Other site' })).json();
    void other;
    const p = await call(w.tokens.admin, 'POST', `/api/service-agreements/${agr}/plans`, { assetId: unit1, title: 'Quarterly PM', everyN: 3, unit: 'month', firstDueOn: day(5), estimatedMinutes: 90, requiredSkill: 'HVAC', checklist: ['Check belts', 'Clean coils', 'Record amps'], perVisitFee: 220 });
    expect(p.statusCode, p.body).toBe(201); planA = p.json().id;
    expect((await call(w.tokens.admin, 'POST', `/api/service-agreements/${agr}/plans`, { assetId: unit1, title: 'Quarterly PM', everyN: 3, unit: 'month', firstDueOn: day(5) })).statusCode).toBe(409);
    expect((await call(w.tokens.admin, 'POST', `/api/service-agreements/${agr}/plans`, { assetId: unit2, title: 'Monthly filter change', everyN: 1, unit: 'month', firstDueOn: day(-3), estimatedMinutes: 20 })).statusCode).toBe(201);
  });
  it('activation generates the visits inside the horizon once, and the daily generator adds nothing twice', async () => {
    const r = await call(w.tokens.admin, 'POST', `/api/service-agreements/${agr}/activate`);
    expect(r.statusCode, r.body).toBe(200); expect(r.json().status).toBe('active');
    const visits = (await call(w.tokens.admin, 'GET', '/api/service-visits')).json();
    // quarterly PM due in 5 days; filter change was 3 days late (one overdue visit) and the next is a month after that, inside 30 days
    expect(visits.filter((v: any) => v.title === 'Quarterly PM')).toHaveLength(1);
    const fc = visits.filter((v: any) => v.title === 'Monthly filter change');
    expect(fc.length).toBeGreaterThanOrEqual(2);
    expect(fc.some((v: any) => v.overdue)).toBe(true);
    const before = visits.length;
    expect(await asActor(w.admin, (tx) => generateVisitsForTenant(tx, w.tenantId))).toBe(0);
    expect((await call(w.tokens.admin, 'GET', '/api/service-visits')).json()).toHaveLength(before);
    const v = (await call(w.tokens.admin, 'GET', `/api/service-visits/${visits.find((x: any) => x.title === 'Quarterly PM').id}`)).json();
    expect(v).toMatchObject({ estimated_minutes: 90, required_skill: 'hvac', customer_name: 'Riverside Mall', asset_tag: 'RTU-1', site_name: 'Riverside Mall main plant' });
    expect(v.checklist).toEqual(['Check belts', 'Clean coils', 'Record amps']);
  });
  it('a plan that fell far behind makes one overdue visit, not a pile', async () => {
    await db().query(`UPDATE service_plan SET next_due_on = $2 WHERE id = $1`, [planA, day(-200)]);
    await db().query(`DELETE FROM service_visit WHERE plan_id = $1`, [planA]);
    await asActor(w.admin, (tx) => generateVisitsForTenant(tx, w.tenantId));
    const mine = (await call(w.tokens.admin, 'GET', '/api/service-visits')).json().filter((v: any) => v.title === 'Quarterly PM');
    expect(mine.filter((v: any) => v.overdue)).toHaveLength(1);
    expect(mine.length).toBeLessThanOrEqual(2);
  });
  it('month arithmetic keeps the day, clamping at month end', () => {
    expect(nextDueAfter('2026-01-31', 1, 'month')).toBe('2026-02-28');
    expect(nextDueAfter('2026-03-15', 3, 'month')).toBe('2026-06-15');
    expect(nextDueAfter('2024-02-29', 1, 'year')).toBe('2025-02-28');
    expect(nextDueAfter('2026-01-05', 2, 'week')).toBe('2026-01-19');
  });
  it('call-outs are added by hand, and ending an agreement cancels what has not happened', async () => {
    const c = await call(w.tokens.admin, 'POST', '/api/service-visits', { facilityId: w.facilities.A, customerId: cust, assetId: unit1, agreementId: agr, title: 'No cooling in the food court', priority: 1, requiredSkill: 'refrigeration' });
    expect(c.statusCode, c.body).toBe(201); expect(c.json()).toMatchObject({ kind: 'callout', priority: 1, site_id: site });
    expect((await call(w.tokens.admin, 'POST', '/api/service-visits', { facilityId: w.facilities.A, customerId: cust, assetId: '00000000-0000-4000-8000-000000000000', title: 'Wrong equipment' })).statusCode).toBe(422);
    expect((await call(w.tokens.admin, 'POST', `/api/service-agreements/${agr}/end`, { outcome: 'cancelled', reason: 'Customer sold the building' })).statusCode).toBe(204);
    const open = (await call(w.tokens.admin, 'GET', '/api/service-visits?open=true')).json();
    expect(open.every((v: any) => v.kind === 'callout' || v.agreement_id !== agr)).toBe(true);
    expect((await call(w.tokens.admin, 'GET', `/api/service-agreements/${agr}`)).json()).toMatchObject({ status: 'cancelled', covered_units: 2 });
  });
  it('is isolated between companies', async () => {
    expect((await call(unlicensed.tokens.admin, 'GET', `/api/service-agreements/${agr}`)).statusCode).toBe(404);
  });
});
