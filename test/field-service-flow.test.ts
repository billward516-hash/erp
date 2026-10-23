import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { sweepToolCalibration } from '../src/modules/fieldservice/trucks.js';
import { driveMinutes, haversineMiles } from '../src/modules/fieldservice/dispatch.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Field service: dispatch, the tablet report, billing, recommended repairs, trucks and tools (SC-002 F2-F4). */
let app: FastifyInstance; let w: World; let cust: string; let site: string; let unit: string; let unit2: string; let part: string; let store: string;
let tia: string; let sam: string; let tiaTok = ''; let samTok = ''; let dispatchTok = ''; let arTok = ''; let truck = ''; let truckLoc = '';
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (n: number) => { let d = n; while ([0, 6].includes(new Date(Date.now() + d * 86_400_000).getUTCDay())) d++; return day(d); };
const db = () => getAdminPool();
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('fs3');
  await db().query(`INSERT INTO facility_entitlement (tenant_id, facility_id, module_key) VALUES ($1, $2, 'field_service')`, [w.tenantId, w.facilities.A]);
  const mkEmp = async (num: string, first: string, last: string) => (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [w.tenantId, w.facilities.A, num, first, last])).rows[0].id as string;
  tia = await mkEmp('T1', 'Tia', 'Nguyen'); sam = await mkEmp('T2', 'Sam', 'Okafor');
  tiaTok = (await createUserWithToken(db(), w.tenantId, { email: 'tia@x.example', displayName: 'Tia', roles: [{ role: 'field_technician', facility: w.facilities.A! }], employeeId: tia })).token;
  samTok = (await createUserWithToken(db(), w.tenantId, { email: 'sam@x.example', displayName: 'Sam', roles: [{ role: 'field_technician', facility: w.facilities.A! }], employeeId: sam })).token;
  dispatchTok = (await createUserWithToken(db(), w.tenantId, { email: 'disp@x.example', displayName: 'Dee', roles: [{ role: 'service_dispatcher', facility: w.facilities.A! }, { role: 'sales_rep', facility: w.facilities.A! }] })).token;
  arTok = (await createUserWithToken(db(), w.tenantId, { email: 'ar@x.example', displayName: 'Ari', roles: [{ role: 'ar_clerk', facility: null }] })).token;
  await asActor(w.admin, async (tx) => {
    cust = (await createCustomer(tx, w.admin, { code: 'MALL', name: 'Riverside Mall', kind: 'customer', paymentTerms: 'Net 30' })).id;
    part = (await createPart(tx, w.admin, { partNumber: 'FLT-20', description: 'Filter 20x20', uom: 'EA' })).id;
    store = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'MAIN', name: 'Main storeroom' })).id;
    await receive(tx, w.admin, { locationId: store, partId: part, qty: 50, unitCost: 10 });
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
const A = () => w.tokens.admin;

describe('drive time', () => {
  it('is straight-line distance times a road factor over an average speed, and says so when it has to guess', () => {
    const dayton = { lat: 39.7589, lon: -84.1916 }, columbus = { lat: 39.9612, lon: -82.9988 };
    expect(Math.round(haversineMiles(dayton.lat, dayton.lon, columbus.lat, columbus.lon))).toBe(65); // about 65 miles as the crow flies
    const d = driveMinutes(dayton, columbus, { roadFactor: 1.3, avgSpeedMph: 40 });
    expect(d.estimate).toBe(false);
    expect(d.miles).toBeGreaterThan(83); expect(d.miles).toBeLessThan(87); // 65 straight-line miles x 1.3
    expect(d.minutes).toBe(Math.round((d.miles! / 40) * 60));
    expect(driveMinutes(dayton, { lat: null, lon: null }, { roadFactor: 1.3, avgSpeedMph: 40 })).toMatchObject({ minutes: 20, estimate: true });
  });
});

describe('setup', () => {
  it('a truck, its stock, a site with equipment, technicians and a per-visit agreement', async () => {
    const t = await call(A(), 'POST', '/api/vehicles', { facilityId: w.facilities.A, tag: 'VAN-1', name: 'Van 1', homeLat: 39.7, homeLon: -84.2 });
    expect(t.statusCode, t.body).toBe(201); truck = t.json().id;
    truckLoc = (await db().query('SELECT truck_location_id FROM vehicle_profile WHERE asset_id = $1', [truck])).rows[0].truck_location_id;
    expect(truckLoc).toBeTruthy();
    expect((await db().query('SELECT kind, code FROM stock_location WHERE id = $1', [truckLoc])).rows[0]).toMatchObject({ kind: 'truck', code: 'TRK-VAN-1' });
    expect((await call(A(), 'PUT', `/api/technicians/${tia}`, { homeLat: 39.7, homeLon: -84.2, skills: ['hvac'], vehicleId: truck })).statusCode).toBe(200);
    expect((await call(A(), 'PUT', `/api/technicians/${sam}`, { homeLat: 39.9, homeLon: -83.0, skills: ['refrigeration'] })).statusCode).toBe(200);
    site = (await call(A(), 'POST', '/api/customer-sites', { customerId: cust, name: 'Main plant', lat: 39.76, lon: -84.19 })).json().id;
    const mk = async (tag: string) => (await call(A(), 'POST', '/api/customer-equipment', { facilityId: w.facilities.A, customerId: cust, siteId: site, assetTag: tag, name: `RTU ${tag}` })).json().id;
    unit = await mk('RTU-1'); unit2 = await mk('RTU-2');
  });
});

describe('dispatch', () => {
  let visit = ''; let agr = ''; const when = weekday(2);
  it('suggests technicians by skill, day and drive time, and refuses an unqualified one', async () => {
    agr = (await call(A(), 'POST', '/api/service-agreements', { facilityId: w.facilities.A, customerId: cust, startsOn: day(-1), billingModel: 'per_visit', perVisitFee: 180 })).json().id;
    await call(A(), 'POST', `/api/service-agreements/${agr}/plans`, { assetId: unit, title: 'Quarterly PM', everyN: 3, unit: 'month', firstDueOn: when, estimatedMinutes: 90, requiredSkill: 'hvac', checklist: ['Check belts', 'Record amps'], perVisitFee: 220 });
    expect((await call(A(), 'POST', `/api/service-agreements/${agr}/activate`)).statusCode).toBe(200);
    visit = (await call(A(), 'GET', '/api/service-visits?unassigned=true')).json().find((v: any) => v.title === 'Quarterly PM').id;
    const s = (await call(dispatchTok, 'GET', `/api/service-visits/${visit}/suggestions?date=${when}`)).json();
    expect(s.suggestions[0]).toMatchObject({ name: 'Tia Nguyen', eligible: true });
    expect(s.suggestions.find((x: any) => x.name === 'Sam Okafor')).toMatchObject({ eligible: false });
    expect(s.suggestions.find((x: any) => x.name === 'Sam Okafor').reasons.join()).toMatch(/lacks the hvac skill/);
    expect((await call(dispatchTok, 'POST', `/api/service-visits/${visit}/assign`, { technicianId: sam, date: when })).statusCode).toBe(422);
    expect((await call(tiaTok, 'POST', `/api/service-visits/${visit}/assign`, { technicianId: tia, date: when })).statusCode).toBe(403); // technicians do not dispatch
  });
  it('time off and weekends refuse; a good assignment makes a work order and tells the technician', async () => {
    await call(A(), 'POST', `/api/technicians/${tia}/time-off`, { fromDate: when, toDate: when, reason: 'Dentist' });
    const off = await call(dispatchTok, 'POST', `/api/service-visits/${visit}/assign`, { technicianId: tia, date: when });
    expect(off.statusCode).toBe(422); expect(off.json().error.message).toMatch(/time off/);
    await db().query('DELETE FROM technician_time_off WHERE employee_id = $1', [tia]);
    const ok = await call(dispatchTok, 'POST', `/api/service-visits/${visit}/assign`, { technicianId: tia, date: when });
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json().start).toMatch(/^\d\d:\d\d$/);
    const v = (await call(A(), 'GET', `/api/service-visits/${visit}`)).json();
    expect(v).toMatchObject({ status: 'scheduled', technician_name: 'Tia Nguyen' }); expect(v.work_order_id).toBeTruthy();
    expect((await db().query(`SELECT 1 FROM work_order_assignment WHERE work_order_id = $1 AND employee_id = $2`, [v.work_order_id, tia])).rowCount).toBe(1);
    expect((await db().query(`SELECT 1 FROM notification WHERE tenant_id = $1 AND dedupe_key LIKE 'sv-assign:%'`, [w.tenantId])).rowCount).toBeGreaterThan(0);
  });
  it('the board shows the day with drive time and load, and a day cannot be overfilled', async () => {
    const b = (await call(dispatchTok, 'GET', `/api/service-dispatch/board?date=${when}`)).json();
    const t = b.technicians.find((x: any) => x.name === 'Tia Nguyen');
    expect(t.stops).toHaveLength(1); expect(t.workMinutes).toBe(90); expect(t.driveMinutes).toBeGreaterThan(0); expect(t.loadPercent).toBeGreaterThan(0);
    const long = (await call(A(), 'POST', '/api/service-visits', { facilityId: w.facilities.A, customerId: cust, assetId: unit2, title: 'All-day overhaul', estimatedMinutes: 600, requiredSkill: 'hvac', dueOn: when })).json();
    const r = await call(dispatchTok, 'POST', `/api/service-visits/${long.id}/assign`, { technicianId: tia, date: when });
    expect(r.statusCode).toBe(422); expect(r.json().error.message).toMatch(/past the end of/);
    await call(A(), 'POST', `/api/service-visits/${long.id}/cancel`, { reason: 'Test cleanup' });
  });
  it('dispatching sends the day; reassigning moves the work order assignment', async () => {
    expect((await call(dispatchTok, 'POST', '/api/service-dispatch/dispatch', { technicianId: tia, date: when })).json()).toMatchObject({ dispatched: 1 });
    expect((await call(A(), 'GET', `/api/service-visits/${visit}`)).json().status).toBe('dispatched');
    const my = (await call(tiaTok, 'GET', `/api/service-my-day?date=${when}`)).json();
    expect(my.stops[0]).toMatchObject({ number: expect.stringMatching(/^SV-/), asset_tag: 'RTU-1' }); expect(my.stops[0].checklist).toEqual(['Check belts', 'Record amps']);
    expect((await call(samTok, 'POST', `/api/service-visits/${visit}/start`)).statusCode).toBe(403);
  });
  it('is the technician’s truck and the visit’s report that do the work', async () => {
    await call(A(), 'PUT', `/api/vehicles/${truck}/stock-levels/${part}`, { min: 2, par: 6 });
    await asActor(w.admin, (tx) => receive(tx, w.admin, { locationId: truckLoc, partId: part, qty: 3, unitCost: 10 }));
    expect((await call(tiaTok, 'POST', `/api/service-visits/${visit}/start`)).statusCode).toBe(204);
    const incomplete = await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, { checklistResults: [{ item: 'Check belts', result: 'ok' }], workPerformed: 'Replaced filters', laborHours: 1.5, customerSignedName: 'Pat', signaturePng: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(incomplete.statusCode).toBe(422); expect(incomplete.json().error.message).toMatch(/answer every checklist item/);
    const draft = await call(tiaTok, 'PUT', `/api/service-visits/${visit}/report`, { workPerformed: 'Started', laborHours: 1 });
    expect(draft.statusCode, draft.body).toBe(200); expect(draft.json().status).toBe('draft');
    const nosig = await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, { checklistResults: [{ item: 'Check belts', result: 'ok' }, { item: 'Record amps', result: 'issue', note: 'Draws 14 A, rated 11' }], workPerformed: 'Replaced filters', laborHours: 1.5 });
    expect(nosig.statusCode).toBe(422); expect(nosig.json().error.message).toMatch(/customer signs/);
    const over = await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, { checklistResults: [{ item: 'Check belts', result: 'ok' }, { item: 'Record amps', result: 'ok' }], workPerformed: 'Replaced filters', laborHours: 1.5, customerSignedName: 'Pat', signaturePng: 'data:image/png;base64,iVBORw0KGgo=', partsUsed: [{ partId: part, qty: 9 }] });
    expect(over.statusCode).toBe(422); expect(over.json().error.message).toMatch(/only 3 of FLT-20/); // the truck cannot go below zero
    const sub = await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, { checklistResults: [{ item: 'Check belts', result: 'ok' }, { item: 'Record amps', result: 'issue', note: 'Draws 14 A, rated 11' }],
      readings: [{ name: 'Amps', value: 14, unit: 'A' }], workPerformed: 'Replaced filters, cleaned coils', findings: 'Compressor is drawing high current', laborHours: 1.5, partsUsed: [{ partId: part, qty: 2 }], resolved: false,
      customerSignedName: 'Pat Lindqvist', signaturePng: 'data:image/png;base64,iVBORw0KGgo=', recommendedRepairs: [{ description: 'Replace compressor contactor', qty: 1, urgency: 'soon' }, { description: 'Add a condensate drain switch', unitPrice: 85 }] });
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json()).toMatchObject({ status: 'submitted', billing_status: 'ready', hasSignature: true });
    expect(sub.json().billing.lines.map((l: any) => [l.description.slice(0, 8), l.qty, l.unitPrice])).toEqual([['Quarterl', 1, 220], ['FLT-20 F', 2, 12.5]]); // fee for the unit, parts at cost + 25%
    expect(sub.json().billing.total).toBe(245);
    const v = (await call(A(), 'GET', `/api/service-visits/${visit}`)).json();
    expect(v.status).toBe('completed');
    const wo = (await call(A(), 'GET', `/api/work-orders/${v.work_order_id}`)).json();
    expect(wo.status).toBe('completed'); expect(wo.labor[0]).toMatchObject({ hours: 1.5 });
    expect((await db().query('SELECT qty_on_hand::float AS q FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [truckLoc, part])).rows[0].q).toBe(1); // 3 on the truck, 2 used
    expect((await call(tiaTok, 'POST', `/api/service-visits/${visit}/report/submit`, {})).statusCode).toBe(409);
    const sig = await call(A(), 'GET', `/api/service-visits/${visit}/report/signature`);
    expect(sig.statusCode).toBe(200); expect(sig.headers['content-type']).toBe('image/png');
  });
  it('the restock list shows the truck under its minimum, and a restock is a transfer from the storeroom', async () => {
    const list = (await call(A(), 'GET', '/api/truck-restock')).json();
    expect(list[0]).toMatchObject({ asset_tag: 'VAN-1', part_number: 'FLT-20', qty: 1, needed: 5, canSupply: 5 });
    expect((await call(A(), 'POST', `/api/vehicles/${truck}/restock`, { fromLocationId: store, lines: [{ partId: part, qty: 5 }] })).statusCode).toBe(201);
    expect((await call(A(), 'GET', '/api/truck-restock')).json()).toEqual([]);
    expect((await call(A(), 'GET', `/api/vehicles/${truck}/stock`)).json().parts[0]).toMatchObject({ qty: 6, min: 2, par: 6, low: false });
  });
  it('recommended repairs become a draft quote for the customer, priced where the technician left it blank', async () => {
    const noPrice = await call(dispatchTok, 'POST', `/api/service-visits/${visit}/quote`, { items: [{ index: 0 }] });
    expect(noPrice.statusCode).toBe(422); expect(noPrice.json().error.message).toMatch(/enter a price/);
    const q = await call(dispatchTok, 'POST', `/api/service-visits/${visit}/quote`, { items: [{ index: 0, unitPrice: 340 }, { index: 1 }] });
    expect(q.statusCode, q.body).toBe(201);
    const quote = (await call(A(), 'GET', `/api/quotes/${q.json().quoteId}`)).json();
    expect(quote).toMatchObject({ status: 'draft', customer_name: 'Riverside Mall', total: 425 });
    expect((await call(dispatchTok, 'POST', `/api/service-visits/${visit}/quote`, { items: [{ index: 0, unitPrice: 340 }] })).statusCode).toBe(409); // already quoted
    expect((await call(A(), 'GET', `/api/service-visits/${visit}/report`)).json().recommended_repairs[0].quoted).toBe(quote.number);
  });
  it('billing: the clerk invoices a ready visit once; a flat monthly agreement bills once a month', async () => {
    expect((await call(dispatchTok, 'POST', `/api/service-visits/${visit}/bill`)).statusCode).toBe(403);
    const ready = (await call(arTok, 'GET', '/api/service-billing/ready')).json();
    expect(ready).toHaveLength(1); expect(ready[0]).toMatchObject({ number: expect.stringMatching(/^SV-/), total: 245 });
    const b = await call(arTok, 'POST', `/api/service-visits/${visit}/bill`);
    expect(b.statusCode, b.body).toBe(201); expect(b.json().total).toBe(245);
    expect((await call(arTok, 'POST', `/api/service-visits/${visit}/bill`)).statusCode).toBe(409);
    expect((await call(arTok, 'GET', '/api/service-billing/ready')).json()).toEqual([]);
    const m = (await call(A(), 'POST', '/api/service-agreements', { facilityId: w.facilities.A, customerId: cust, startsOn: day(-70), billingModel: 'monthly', monthlyFee: 1200, partsIncluded: true })).json();
    await call(A(), 'POST', `/api/service-agreements/${m.id}/plans`, { assetId: unit2, title: 'Monthly filter check', everyN: 1, unit: 'month', firstDueOn: day(40) });
    await call(A(), 'POST', `/api/service-agreements/${m.id}/activate`);
    const month = day(0).slice(0, 7);
    const run1 = (await call(arTok, 'POST', '/api/service-billing/monthly', { month })).json();
    expect(run1.invoices).toEqual([expect.objectContaining({ amount: 1200, customer: 'Riverside Mall' })]);
    expect((await call(arTok, 'POST', '/api/service-billing/monthly', { month })).json().invoices).toEqual([]); // twice is safe
    expect((await call(arTok, 'POST', '/api/service-billing/monthly', { month: '2099-01' })).statusCode).toBe(422);
  });
});

describe('my day', () => {
  it('a sign-in with no employee record simply has no day, not an error', async () => {
    expect((await call(A(), 'GET', '/api/service-my-day')).json()).toMatchObject({ technician: false, stops: [] });
  });
});

describe('tools', () => {
  it('a tool can be checked out only while calibrated; going out of calibration while out alerts the holder', async () => {
    const tool = (await db().query(`INSERT INTO asset (tenant_id, facility_id, asset_tag, name, asset_class) VALUES ($1, $2, 'GAUGE-1', 'Manifold gauge', 'tool') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
    await db().query(`INSERT INTO calibration_plan (tenant_id, facility_id, asset_id, interval_days, tolerance, next_due, created_by) VALUES ($1, $2, $3, 180, '±1 psi', $4, $5)`, [w.tenantId, w.facilities.A, tool, day(-3), w.admin.userId]);
    const blocked = await call(tiaTok, 'POST', `/api/service-tools/${tool}/checkout`, { vehicleId: truck });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.message).toMatch(/GAUGE-1 is overdue for calibration/);
    await db().query('UPDATE calibration_plan SET next_due = $2 WHERE asset_id = $1', [tool, day(10)]);
    expect((await call(tiaTok, 'POST', `/api/service-tools/${tool}/checkout`, { vehicleId: truck })).statusCode).toBe(201);
    expect((await call(samTok, 'POST', `/api/service-tools/${tool}/checkout`, {})).json().error.message).toMatch(/already out with Tia Nguyen/);
    expect((await call(A(), 'GET', '/api/tool-checkouts?open=true')).json()[0]).toMatchObject({ asset_tag: 'GAUGE-1', vehicle_tag: 'VAN-1', calibration_overdue: false });
    await db().query('UPDATE calibration_plan SET next_due = $2 WHERE asset_id = $1', [tool, day(-1)]);
    expect(await asActor(w.admin, (tx) => sweepToolCalibration(tx, w.tenantId))).toBeGreaterThanOrEqual(1);
    expect(await asActor(w.admin, (tx) => sweepToolCalibration(tx, w.tenantId))).toBe(0); // once per due date
    expect((await call(A(), 'GET', '/api/tool-checkouts?open=true')).json()[0].calibration_overdue).toBe(true);
    expect((await call(samTok, 'POST', `/api/service-tools/${tool}/return`, {})).statusCode).toBe(403);
    expect((await call(tiaTok, 'POST', `/api/service-tools/${tool}/return`, {})).statusCode).toBe(204);
  });
});
