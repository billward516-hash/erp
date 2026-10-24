import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { assign, dispatchDay } from '../src/modules/fieldservice/dispatch.js';
import { activateAgreement, addCustomerEquipment, addPlan, createAgreement, createCallout, saveSettings, saveSite, saveTechnician, saveVehicle } from '../src/modules/fieldservice/service.js';
import { ensureTruckLocation, setTruckLevel } from '../src/modules/fieldservice/trucks.js';
import { DEFAULT_MODULES } from '../src/platform/tenancy/provision.js';
import { log } from './seed-lib.js';

/**
 * Summit Climate Services: a small HVAC and refrigeration service company (SC-002). Two technicians with a van each, three customers
 * with sites and rooftop and refrigeration equipment, a per-visit and a flat-monthly agreement, generated visits (one already late),
 * a call-out, and today's day assigned and sent to the technicians.
 */
export async function seedSummit() {
  const db = getAdminPool();
  const t = await provisionTenant(db, { slug: 'summit', name: 'Summit Climate Services', legalEntity: 'Summit Climate Services Inc', facilities: [{ code: 'SVC', name: 'Summit service depot', timezone: 'America/New_York', modules: [...DEFAULT_MODULES, 'field_service'] }] });
  const fac = t.facilities.SVC!;
  const tokens: Record<string, string> = {};
  const mk = async (key: string, email: string, name: string, roles: { role: string; facility: string | null }[], employeeId?: string) => {
    const u = await createUserWithToken(db, t.tenantId, { email, displayName: name, roles, employeeId });
    tokens[key] = u.token;
    return (await loadActor(t.tenantId, u.userId))!;
  };
  const emp = async (num: string, first: string, last: string, title: string) => (await db.query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title, email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [t.tenantId, fac, num, first, last, title, `${first.toLowerCase()}@summit.example`])).rows[0].id as string;
  const tiaE = await emp('S101', 'Tia', 'Nguyen', 'HVAC technician'), samE = await emp('S102', 'Sam', 'Okafor', 'Refrigeration technician');
  const admin = await mk('summit admin (field service)', 'owner@summit.example', 'Morgan Summit', [{ role: 'admin', facility: null }]);
  await mk('dee (service dispatcher, Summit)', 'dee@summit.example', 'Dee Alvarez', [{ role: 'service_dispatcher', facility: fac }, { role: 'sales_rep', facility: fac }]);
  await mk('tia (field technician, Summit)', 'tia@summit.example', 'Tia Nguyen', [{ role: 'field_technician', facility: fac }], tiaE);
  await mk('sam (field technician, Summit)', 'sam@summit.example', 'Sam Okafor', [{ role: 'field_technician', facility: fac }], samE);
  await mk('ari (AR clerk, Summit)', 'ari@summit.example', 'Ari Chen', [{ role: 'ar_clerk', facility: null }]);
  const d = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const weekday = (n: number) => { let x = n; while ([0, 6].includes(new Date(Date.now() + x * 86_400_000).getUTCDay())) x++; return d(x); };

  log('Summit (field service): customers, sites, equipment, trucks, agreements');
  await asActor(admin, (tx) => saveSettings(tx, admin, { roadFactor: 1.3, avgSpeedMph: 35, laborRatePerHour: 105, partsMarkupPercent: 30 }));
  const parts = await asActor(admin, async (tx) => ({
    filter: await createPart(tx, admin, { partNumber: 'FLT-20x25', description: 'Pleated filter 20x25x2', uom: 'EA' }),
    belt: await createPart(tx, admin, { partNumber: 'BLT-A52', description: 'V-belt A52', uom: 'EA' }),
    contactor: await createPart(tx, admin, { partNumber: 'CTR-2P30', description: 'Contactor 2-pole 30 A', uom: 'EA' }),
    cap: await createPart(tx, admin, { partNumber: 'CAP-45-5', description: 'Run capacitor 45/5 µF', uom: 'EA' }),
  }));
  const store = await asActor(admin, (tx) => createLocation(tx, admin, { facilityId: fac, code: 'SVC-MAIN', name: 'Depot stockroom' }));
  await asActor(admin, async (tx) => { for (const [p, q, c] of [[parts.filter, 200, 6.5], [parts.belt, 40, 14], [parts.contactor, 12, 38], [parts.cap, 25, 17]] as const) await receive(tx, admin, { locationId: store.id, partId: p.id, qty: q, unitCost: c }); });
  const vans = await asActor(admin, async (tx) => ({
    v1: await saveVehicle(tx, admin, { facilityId: fac, tag: 'VAN-01', name: 'Service van 1', plate: 'HVC 4101', homeLat: 39.99, homeLon: -83.01 }),
    v2: await saveVehicle(tx, admin, { facilityId: fac, tag: 'VAN-02', name: 'Service van 2', plate: 'HVC 4102', homeLat: 39.95, homeLon: -82.93 }),
  }));
  await asActor(admin, async (tx) => {
    for (const [vid, qty] of [[vans.v1.id!, 8], [vans.v2.id!, 6]] as const) {
      const loc = await ensureTruckLocation(tx, admin, vid);
      for (const [p, min, par, q, c] of [[parts.filter, 6, 20, 12, 6.5], [parts.belt, 2, 6, qty, 14], [parts.contactor, 1, 3, 2, 38], [parts.cap, 2, 5, 3, 17]] as const) {
        await receive(tx, admin, { locationId: loc, partId: p.id, qty: q, unitCost: c });
        await setTruckLevel(tx, admin, vid, p.id, { min, par });
      }
    }
  });
  await asActor(admin, async (tx) => {
    await saveTechnician(tx, admin, tiaE, { homeLat: 39.99, homeLon: -83.01, skills: ['hvac', 'controls'], vehicleId: vans.v1.id! });
    await saveTechnician(tx, admin, samE, { homeLat: 39.95, homeLon: -82.93, skills: ['refrigeration', 'hvac'], vehicleId: vans.v2.id!, dayStart: '07:30', dayEnd: '16:00' });
  });
  const cust = await asActor(admin, async (tx) => ({
    mall: await createCustomer(tx, admin, { code: 'RVM', name: 'Riverside Mall', kind: 'customer', paymentTerms: 'Net 30' }),
    market: await createCustomer(tx, admin, { code: 'FRM', name: 'Fresh Market Grocers', kind: 'customer', paymentTerms: 'Net 15' }),
    clinic: await createCustomer(tx, admin, { code: 'NCL', name: 'Northside Clinic', kind: 'customer', paymentTerms: 'Net 30' }),
  }));
  const sites = await asActor(admin, async (tx) => ({
    mall: await saveSite(tx, admin, { customerId: cust.mall.id, name: 'Riverside Mall roof', address: { line1: '1 River Rd', city: 'Columbus', state: 'OH' }, lat: 39.96, lon: -83.0, accessNotes: 'Check in with security at dock B; roof hatch key at the desk' }),
    market: await saveSite(tx, admin, { customerId: cust.market.id, name: 'Fresh Market, Main St', address: { line1: '88 Main St', city: 'Grove City', state: 'OH' }, lat: 39.88, lon: -83.09, accessNotes: 'Walk-in coolers: ask for the produce manager' }),
    clinic: await saveSite(tx, admin, { customerId: cust.clinic.id, name: 'Northside Clinic', address: { line1: '400 High St', city: 'Worthington', state: 'OH' }, lat: 40.09, lon: -83.02 }),
  }));
  const eq = async (customerId: string, siteId: string, tag: string, name: string, make: string, model: string) => (await asActor(admin, (tx) => addCustomerEquipment(tx, admin, { facilityId: fac, customerId, siteId, assetTag: tag, name, manufacturer: make, model })));
  const rtu1 = await eq(cust.mall.id, sites.mall.id, 'RVM-RTU-1', 'Rooftop unit 1', 'Carrier', '48TC'); const rtu2 = await eq(cust.mall.id, sites.mall.id, 'RVM-RTU-2', 'Rooftop unit 2', 'Carrier', '48TC');
  const cooler = await eq(cust.market.id, sites.market.id, 'FRM-WIC-1', 'Walk-in cooler', 'Kolpak', 'QS7'); const rack = await eq(cust.market.id, sites.market.id, 'FRM-RACK-1', 'Refrigeration rack', 'Hussmann', 'Protocol');
  const split = await eq(cust.clinic.id, sites.clinic.id, 'NCL-SPLIT-1', 'Split system', 'Trane', 'XR14');
  const a1 = await asActor(admin, (tx) => createAgreement(tx, admin, { facilityId: fac, customerId: cust.mall.id, startsOn: d(-120), billingModel: 'per_visit', perVisitFee: 240, responseHours: 24, paymentTerms: 'Net 30' }));
  await asActor(admin, async (tx) => {
    await addPlan(tx, admin, a1.id, { assetId: rtu1.id, title: 'Quarterly PM', everyN: 3, unit: 'month', firstDueOn: d(-2), estimatedMinutes: 90, requiredSkill: 'hvac', checklist: ['Check belts and sheaves', 'Replace filters', 'Clean condenser coil', 'Record compressor amps', 'Check refrigerant pressures'], perVisitFee: 260 });
    await addPlan(tx, admin, a1.id, { assetId: rtu2.id, title: 'Quarterly PM', everyN: 3, unit: 'month', firstDueOn: weekday(1), estimatedMinutes: 90, requiredSkill: 'hvac', checklist: ['Check belts and sheaves', 'Replace filters', 'Clean condenser coil', 'Record compressor amps', 'Check refrigerant pressures'], perVisitFee: 260 });
    await activateAgreement(tx, admin, a1.id);
  });
  const a2 = await asActor(admin, (tx) => createAgreement(tx, admin, { facilityId: fac, customerId: cust.market.id, startsOn: d(-200), billingModel: 'monthly', monthlyFee: 1450, partsIncluded: false, responseHours: 4, autoRenew: true, paymentTerms: 'Net 15' }));
  await asActor(admin, async (tx) => {
    await addPlan(tx, admin, a2.id, { assetId: cooler.id, title: 'Monthly cooler inspection', everyN: 1, unit: 'month', firstDueOn: weekday(0), estimatedMinutes: 60, requiredSkill: 'refrigeration', checklist: ['Check evaporator fans', 'Defrost cycle', 'Door gaskets', 'Record box temperature'] });
    await addPlan(tx, admin, a2.id, { assetId: rack.id, title: 'Rack service', everyN: 1, unit: 'month', firstDueOn: weekday(1), estimatedMinutes: 120, requiredSkill: 'refrigeration', checklist: ['Oil levels', 'Compressor amps', 'Leak check', 'Controller alarms'] });
    await activateAgreement(tx, admin, a2.id);
  });
  const a3 = await asActor(admin, (tx) => createAgreement(tx, admin, { facilityId: fac, customerId: cust.clinic.id, startsOn: d(-30), billingModel: 'per_visit', perVisitFee: 195 }));
  await asActor(admin, async (tx) => { await addPlan(tx, admin, a3.id, { assetId: split.id, title: 'Semi-annual service', everyN: 6, unit: 'month', firstDueOn: weekday(3), estimatedMinutes: 75, requiredSkill: 'hvac', checklist: ['Filter', 'Coils', 'Drain line', 'Thermostat calibration'] }); await activateAgreement(tx, admin, a3.id); });
  await asActor(admin, (tx) => createCallout(tx, admin, { facilityId: fac, customerId: cust.market.id, assetId: cooler.id, agreementId: a2.id, title: 'Walk-in cooler not holding temperature', priority: 1, requiredSkill: 'refrigeration', estimatedMinutes: 90, dueOn: weekday(0) }));

  // Tools, one of them close to its calibration date
  for (const [tag, name, due] of [['GAUGE-01', 'Manifold gauge set', 40], ['LEAK-01', 'Electronic leak detector', 6], ['CLAMP-01', 'Clamp meter', 90]] as const) {
    const a = (await db.query(`INSERT INTO asset (tenant_id, facility_id, asset_tag, name, asset_class) VALUES ($1, $2, $3, $4, 'tool') RETURNING id`, [t.tenantId, fac, tag, name])).rows[0].id;
    await db.query(`INSERT INTO calibration_plan (tenant_id, facility_id, asset_id, interval_days, tolerance, next_due, created_by) VALUES ($1, $2, $3, 180, 'Per manufacturer', $4, $5)`, [t.tenantId, fac, a, d(due), admin.userId]);
  }

  // Today's day: assign what is due to the right technician and send it
  const day = d(0); // today, even on a weekend, so the technician's day is never empty
  const open = (await db.query(`SELECT id, title, required_skill, estimated_minutes FROM service_visit WHERE tenant_id = $1 AND status = 'planned' AND due_on <= $2::date ORDER BY priority, due_on`, [t.tenantId, d(1)])).rows;
  for (const v of open) {
    const who = v.required_skill === 'refrigeration' ? samE : tiaE;
    try { await asActor(admin, (tx) => assign(tx, admin, v.id, { technicianId: who, date: day })); } catch (e: any) { log(`  (not assigned: ${v.title}: ${e.message})`); }
  }
  for (const who of [tiaE, samE]) { try { await asActor(admin, (tx) => dispatchDay(tx, admin, { technicianId: who, date: day })); } catch { /* nothing scheduled */ } }
  return { tokens, tenantId: t.tenantId };
}
