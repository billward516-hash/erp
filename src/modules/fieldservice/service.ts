import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';
import { hasModule } from '../org/service.js';
import { ensureTruckLocation } from './trucks.js';

/**
 * Field service (SC-002 F1): a company that maintains other people's equipment on a schedule. Customers have sites; the equipment at
 * a site is the same asset record used for our own equipment, owned by the customer; a service agreement covers some of that
 * equipment with a frequency and a price; visits are generated ahead of time from the agreements, and call-outs are added by hand.
 * The module is licensed per facility (the `field_service` entitlement): without it nothing here is available.
 */
export const MODULE = 'field_service';
const today = () => new Date().toISOString().slice(0, 10);

export async function requireLicensed(tx: Tx, facilityId: string) {
  if (!(await hasModule(tx, facilityId, MODULE))) throw new AppError(402, 'module_not_licensed', 'Field service is not licensed for this site');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export async function getSettings(tx: Tx) {
  const s = await one(tx, 'SELECT road_factor::float AS road_factor, avg_speed_mph::float AS avg_speed_mph, horizon_days, default_visit_minutes, labor_rate_per_hour::float AS labor_rate, parts_markup_percent::float AS markup FROM field_service_settings');
  return { roadFactor: s?.road_factor ?? 1.3, avgSpeedMph: s?.avg_speed_mph ?? 35, horizonDays: s?.horizon_days ?? 30, defaultVisitMinutes: s?.default_visit_minutes ?? 60, laborRatePerHour: s?.labor_rate ?? 95, partsMarkupPercent: s?.markup ?? 25 };
}

export async function saveSettings(tx: Tx, actor: Actor, input: Partial<Awaited<ReturnType<typeof getSettings>>>) {
  requirePermission(actor, 'fieldservice.manage');
  const next = { ...(await getSettings(tx)), ...input };
  if (!(next.roadFactor >= 1 && next.roadFactor <= 3)) throw invalid('the road factor is between 1 and 3 (road distance over straight-line distance)');
  if (!(next.avgSpeedMph >= 5 && next.avgSpeedMph <= 80)) throw invalid('average speed is between 5 and 80 mph');
  if (!Number.isInteger(next.horizonDays) || next.horizonDays < 1 || next.horizonDays > 365) throw invalid('generate visits 1 to 365 days ahead');
  if (!Number.isInteger(next.defaultVisitMinutes) || next.defaultVisitMinutes < 5 || next.defaultVisitMinutes > 960) throw invalid('a default visit is 5 to 960 minutes');
  if (!(next.laborRatePerHour >= 0)) throw invalid('the labor rate cannot be negative');
  if (!(next.partsMarkupPercent >= 0 && next.partsMarkupPercent <= 500)) throw invalid('the parts markup is 0 to 500 percent');
  await tx.query(`INSERT INTO field_service_settings (tenant_id, road_factor, avg_speed_mph, horizon_days, default_visit_minutes, labor_rate_per_hour, parts_markup_percent, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (tenant_id) DO UPDATE SET road_factor = EXCLUDED.road_factor, avg_speed_mph = EXCLUDED.avg_speed_mph, horizon_days = EXCLUDED.horizon_days, default_visit_minutes = EXCLUDED.default_visit_minutes, labor_rate_per_hour = EXCLUDED.labor_rate_per_hour, parts_markup_percent = EXCLUDED.parts_markup_percent, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, next.roadFactor, next.avgSpeedMph, next.horizonDays, next.defaultVisitMinutes, next.laborRatePerHour, next.partsMarkupPercent, actor.userId]);
  await audit(tx, actor, { action: 'field_service.settings_changed', entityType: 'field_service_settings', entityId: actor.tenantId, data: next });
  return getSettings(tx);
}

// ---------------------------------------------------------------------------
// Customer sites and customer-owned equipment
// ---------------------------------------------------------------------------
const clean = (a: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(a ?? {}).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));

export async function saveSite(tx: Tx, actor: Actor, input: { id?: string; customerId: string; name: string; address?: Record<string, string>; lat?: number | null; lon?: number | null; accessNotes?: string | null; contactId?: string | null; active?: boolean }) {
  requirePermission(actor, 'fieldservice.manage');
  if (!input.name.trim()) throw invalid('name the site');
  if ((input.lat == null) !== (input.lon == null)) throw invalid('give both latitude and longitude, or neither');
  if (!(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw invalid('customer not found');
  if (input.contactId && !(await one(tx, 'SELECT 1 FROM contact WHERE id = $1 AND customer_id = $2', [input.contactId, input.customerId]))) throw invalid('contact is not at this customer');
  const dup = await one(tx, 'SELECT id FROM customer_site WHERE customer_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3', [input.customerId, input.name.trim(), input.id ?? null]);
  if (dup) throw conflict(`${input.name.trim()} already exists for this customer`);
  const vals = [input.name.trim(), clean(input.address), input.lat ?? null, input.lon ?? null, input.accessNotes?.trim() || null, input.contactId ?? null];
  const s = input.id
    ? await one(tx, `UPDATE customer_site SET name = $2, address = $3, lat = $4, lon = $5, access_notes = $6, contact_id = $7, active = $8 WHERE id = $1 RETURNING *`, [input.id, ...vals, input.active ?? true])
    : await one(tx, `INSERT INTO customer_site (tenant_id, customer_id, name, address, lat, lon, access_notes, contact_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [actor.tenantId, input.customerId, ...vals]);
  if (!s) throw notFound('site');
  await audit(tx, actor, { action: input.id ? 'customer_site.updated' : 'customer_site.created', entityType: 'customer_site', entityId: s.id, data: { name: s.name, customerId: input.customerId } });
  return s;
}

export async function listSites(tx: Tx, actor: Actor, q: { customerId?: string } = {}) {
  requirePermission(actor, 'fieldservice.view');
  return many(tx, `SELECT s.*, c.name AS customer_name, (SELECT count(*)::int FROM asset a WHERE a.customer_site_id = s.id) AS equipment
    FROM customer_site s JOIN customer c ON c.id = s.customer_id WHERE ($1::uuid IS NULL OR s.customer_id = $1) ORDER BY c.name, s.name`, [q.customerId ?? null]);
}

export async function addCustomerEquipment(tx: Tx, actor: Actor, input: { facilityId: string; customerId: string; siteId: string; assetTag: string; name: string; manufacturer?: string | null; model?: string | null; serialNumber?: string | null; category?: string | null }) {
  requirePermission(actor, 'fieldservice.manage', input.facilityId);
  await requireLicensed(tx, input.facilityId);
  const site = await one(tx, 'SELECT id, customer_id FROM customer_site WHERE id = $1', [input.siteId]);
  if (!site || site.customer_id !== input.customerId) throw invalid('the site is not this customer’s');
  if (await one(tx, 'SELECT 1 FROM asset WHERE lower(asset_tag) = lower($1)', [input.assetTag.trim()])) throw conflict(`asset tag ${input.assetTag.trim()} is already used`);
  const a = await one(tx, `INSERT INTO asset (tenant_id, facility_id, asset_tag, name, asset_class, category, manufacturer, model, serial_number, customer_id, customer_site_id)
    VALUES ($1, $2, $3, $4, 'equipment', $5, $6, $7, $8, $9, $10) RETURNING id, asset_tag, name`,
  [actor.tenantId, input.facilityId, input.assetTag.trim(), input.name.trim(), input.category ?? null, input.manufacturer ?? null, input.model ?? null, input.serialNumber ?? null, input.customerId, input.siteId]);
  await audit(tx, actor, { action: 'asset.customer_equipment_added', entityType: 'asset', entityId: a.id, facilityId: input.facilityId, data: { tag: a.asset_tag, customerId: input.customerId, siteId: input.siteId } });
  return a;
}

export async function listCustomerEquipment(tx: Tx, actor: Actor, q: { customerId?: string; siteId?: string } = {}) {
  requirePermission(actor, 'fieldservice.view');
  return many(tx, `SELECT a.id, a.asset_tag, a.name, a.manufacturer, a.model, a.serial_number, a.category, a.customer_id, a.customer_site_id, c.name AS customer_name, s.name AS site_name, a.facility_id
    FROM asset a JOIN customer c ON c.id = a.customer_id LEFT JOIN customer_site s ON s.id = a.customer_site_id
    WHERE a.customer_id IS NOT NULL AND ($1::uuid IS NULL OR a.customer_id = $1) AND ($2::uuid IS NULL OR a.customer_site_id = $2) ORDER BY c.name, s.name, a.asset_tag`, [q.customerId ?? null, q.siteId ?? null]);
}

// ---------------------------------------------------------------------------
// Technicians and vehicles
// ---------------------------------------------------------------------------
export interface TechnicianInput { homeLat?: number | null; homeLon?: number | null; skills?: string[]; dayStart?: string; dayEnd?: string; workDays?: number[]; vehicleId?: string | null; active?: boolean }

export async function saveTechnician(tx: Tx, actor: Actor, employeeId: string, input: TechnicianInput) {
  const emp = await one(tx, 'SELECT id, facility_id, first_name, last_name FROM employee WHERE id = $1', [employeeId]);
  if (!emp) throw notFound('employee');
  requirePermission(actor, 'fieldservice.manage', emp.facility_id);
  if (emp.facility_id) await requireLicensed(tx, emp.facility_id);
  if ((input.homeLat == null) !== (input.homeLon == null)) throw invalid('give both latitude and longitude, or neither');
  const days = input.workDays ?? [1, 2, 3, 4, 5];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw invalid('work days are numbered 0 (Sunday) to 6 (Saturday)');
  const start = input.dayStart ?? '08:00', end = input.dayEnd ?? '17:00';
  if (end <= start) throw invalid('the working day must end after it starts');
  if (input.vehicleId && !(await one(tx, `SELECT 1 FROM asset WHERE id = $1 AND asset_class = 'vehicle'`, [input.vehicleId]))) throw invalid('choose a vehicle');
  const skills = [...new Set((input.skills ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  await tx.query(`INSERT INTO technician_profile (employee_id, tenant_id, home_lat, home_lon, skills, day_start, day_end, work_days, vehicle_id, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (employee_id) DO UPDATE SET home_lat = EXCLUDED.home_lat, home_lon = EXCLUDED.home_lon, skills = EXCLUDED.skills, day_start = EXCLUDED.day_start, day_end = EXCLUDED.day_end, work_days = EXCLUDED.work_days, vehicle_id = EXCLUDED.vehicle_id, active = EXCLUDED.active`,
  [employeeId, actor.tenantId, input.homeLat ?? null, input.homeLon ?? null, skills, start, end, days, input.vehicleId ?? null, input.active ?? true]);
  await audit(tx, actor, { action: 'technician.profile_saved', entityType: 'employee', entityId: employeeId, facilityId: emp.facility_id, data: { skills, workDays: days } });
  return { employeeId, skills };
}

export async function listTechnicians(tx: Tx, actor: Actor) {
  requirePermission(actor, 'fieldservice.view');
  const rows = await many(tx, `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.facility_id, p.home_lat::float AS home_lat, p.home_lon::float AS home_lon, p.skills, p.day_start::text AS day_start, p.day_end::text AS day_end, p.work_days, p.vehicle_id, p.active,
      v.asset_tag AS vehicle_tag, (SELECT count(*)::int FROM service_visit sv WHERE sv.technician_id = e.id AND sv.scheduled_on = current_date AND sv.status IN ('scheduled', 'dispatched', 'in_progress')) AS visits_today
    FROM technician_profile p JOIN employee e ON e.id = p.employee_id LEFT JOIN asset v ON v.id = p.vehicle_id ORDER BY e.last_name, e.first_name`);
  return rows.filter((r) => !r.facility_id || can(actor, 'fieldservice.view', r.facility_id));
}

export async function addTimeOff(tx: Tx, actor: Actor, employeeId: string, input: { fromDate: string; toDate: string; reason?: string | null }) {
  requirePermission(actor, 'fieldservice.manage');
  if (!(await one(tx, 'SELECT 1 FROM technician_profile WHERE employee_id = $1', [employeeId]))) throw invalid('this person is not set up as a technician');
  if (input.toDate < input.fromDate) throw invalid('the last day is before the first');
  const r = await one(tx, 'INSERT INTO technician_time_off (tenant_id, employee_id, from_date, to_date, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [actor.tenantId, employeeId, input.fromDate, input.toDate, input.reason ?? null, actor.userId]);
  await audit(tx, actor, { action: 'technician.time_off_added', entityType: 'employee', entityId: employeeId, data: input });
  return r;
}

export async function removeTimeOff(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'fieldservice.manage');
  if (!(await one(tx, 'DELETE FROM technician_time_off WHERE id = $1 RETURNING id', [id]))) throw notFound('time off');
}

export async function listTimeOff(tx: Tx, actor: Actor, employeeId?: string) {
  requirePermission(actor, 'fieldservice.view');
  return many(tx, `SELECT t.id, t.employee_id, e.first_name, e.last_name, t.from_date, t.to_date, t.reason FROM technician_time_off t JOIN employee e ON e.id = t.employee_id
    WHERE t.to_date >= current_date AND ($1::uuid IS NULL OR t.employee_id = $1) ORDER BY t.from_date`, [employeeId ?? null]);
}

export async function saveVehicle(tx: Tx, actor: Actor, input: { id?: string; facilityId: string; tag: string; name: string; plate?: string | null; vin?: string | null; homeLat?: number | null; homeLon?: number | null; assignedEmployeeId?: string | null }) {
  requirePermission(actor, 'fieldservice.manage', input.facilityId);
  await requireLicensed(tx, input.facilityId);
  if ((input.homeLat == null) !== (input.homeLon == null)) throw invalid('give both latitude and longitude, or neither');
  let id = input.id;
  if (id) {
    const a = await one(tx, `UPDATE asset SET asset_tag = $2, name = $3 WHERE id = $1 AND asset_class = 'vehicle' RETURNING id`, [id, input.tag.trim(), input.name.trim()]);
    if (!a) throw notFound('vehicle');
  } else {
    if (await one(tx, 'SELECT 1 FROM asset WHERE lower(asset_tag) = lower($1)', [input.tag.trim()])) throw conflict(`asset tag ${input.tag.trim()} is already used`);
    id = (await one(tx, `INSERT INTO asset (tenant_id, facility_id, asset_tag, name, asset_class) VALUES ($1, $2, $3, $4, 'vehicle') RETURNING id`, [actor.tenantId, input.facilityId, input.tag.trim(), input.name.trim()]))!.id;
  }
  await tx.query(`INSERT INTO vehicle_profile (asset_id, tenant_id, plate, vin, home_lat, home_lon, assigned_employee_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (asset_id) DO UPDATE SET plate = EXCLUDED.plate, vin = EXCLUDED.vin, home_lat = EXCLUDED.home_lat, home_lon = EXCLUDED.home_lon, assigned_employee_id = EXCLUDED.assigned_employee_id`,
  [id, actor.tenantId, input.plate ?? null, input.vin ?? null, input.homeLat ?? null, input.homeLon ?? null, input.assignedEmployeeId ?? null]);
  await ensureTruckLocation(tx, actor, id!);
  await audit(tx, actor, { action: 'vehicle.saved', entityType: 'asset', entityId: id!, facilityId: input.facilityId, data: { tag: input.tag } });
  return { id };
}

export async function listVehicles(tx: Tx, actor: Actor) {
  requirePermission(actor, 'fieldservice.view');
  const rows = await many(tx, `SELECT a.id, a.asset_tag, a.name, a.facility_id, a.operational_state, v.plate, v.vin, v.assigned_employee_id, e.first_name, e.last_name
    FROM asset a JOIN vehicle_profile v ON v.asset_id = a.id LEFT JOIN employee e ON e.id = v.assigned_employee_id WHERE a.asset_class = 'vehicle' ORDER BY a.asset_tag`);
  return rows.filter((r) => can(actor, 'fieldservice.view', r.facility_id));
}

// ---------------------------------------------------------------------------
// Agreements and covered units
// ---------------------------------------------------------------------------
export interface AgreementInput {
  facilityId: string; customerId: string; startsOn: string; endsOn?: string | null; billingModel: 'per_visit' | 'monthly'; monthlyFee?: number | null; perVisitFee?: number | null;
  responseHours?: number | null; autoRenew?: boolean; partsIncluded?: boolean; paymentTerms?: string | null; terms?: string | null; ownerUserId?: string | null;
}
function checkAgreement(i: AgreementInput) {
  if (i.endsOn && i.endsOn < i.startsOn) throw invalid('the agreement ends before it starts');
  if (i.billingModel === 'monthly' && !(i.monthlyFee != null && i.monthlyFee >= 0)) throw invalid('a monthly agreement needs a monthly fee');
  if (i.billingModel === 'per_visit' && !(i.perVisitFee != null && i.perVisitFee >= 0)) throw invalid('a per-visit agreement needs a fee per visit (it can be overridden per covered unit)');
}

export async function createAgreement(tx: Tx, actor: Actor, input: AgreementInput) {
  requirePermission(actor, 'fieldservice.manage', input.facilityId);
  await requireLicensed(tx, input.facilityId);
  checkAgreement(input);
  const c = await one(tx, 'SELECT id, active, payment_terms FROM customer WHERE id = $1', [input.customerId]);
  if (!c || !c.active) throw invalid('customer not found or inactive');
  const number = `SA-${String(await nextSequence(tx, actor.tenantId, 'service_agreement')).padStart(6, '0')}`;
  const a = await one(tx, `INSERT INTO service_agreement (tenant_id, facility_id, number, customer_id, starts_on, ends_on, billing_model, monthly_fee, per_visit_fee, response_hours, auto_renew, payment_terms, terms, owner_user_id, created_by, parts_included)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.customerId, input.startsOn, input.endsOn ?? null, input.billingModel, input.monthlyFee ?? null, input.perVisitFee ?? null, input.responseHours ?? null, input.autoRenew ?? false,
    input.paymentTerms ?? c.payment_terms ?? null, input.terms ?? null, input.ownerUserId ?? actor.userId, actor.userId, input.partsIncluded ?? false]);
  await audit(tx, actor, { action: 'service_agreement.created', entityType: 'service_agreement', entityId: a.id, facilityId: a.facility_id, data: { number, customerId: input.customerId, billingModel: input.billingModel } });
  return a;
}

async function lockAgreement(tx: Tx, id: string) {
  const a = await one(tx, 'SELECT * FROM service_agreement WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw notFound('service agreement');
  return a;
}

export async function updateAgreement(tx: Tx, actor: Actor, id: string, patch: Partial<Omit<AgreementInput, 'facilityId' | 'customerId'>>) {
  const a = await lockAgreement(tx, id);
  requirePermission(actor, 'fieldservice.manage', a.facility_id);
  if (!['draft', 'active', 'suspended'].includes(a.status)) throw conflict(`the agreement is ${a.status}`);
  const merged: AgreementInput = { facilityId: a.facility_id, customerId: a.customer_id, startsOn: patch.startsOn ?? a.starts_on.toISOString().slice(0, 10), endsOn: patch.endsOn !== undefined ? patch.endsOn : a.ends_on?.toISOString().slice(0, 10) ?? null,
    billingModel: patch.billingModel ?? a.billing_model, monthlyFee: patch.monthlyFee !== undefined ? patch.monthlyFee : a.monthly_fee == null ? null : Number(a.monthly_fee), perVisitFee: patch.perVisitFee !== undefined ? patch.perVisitFee : a.per_visit_fee == null ? null : Number(a.per_visit_fee) };
  checkAgreement(merged);
  await tx.query(`UPDATE service_agreement SET starts_on = $2, ends_on = $3, billing_model = $4, monthly_fee = $5, per_visit_fee = $6,
      response_hours = CASE WHEN $7 THEN $8 ELSE response_hours END, auto_renew = coalesce($9, auto_renew), parts_included = coalesce($14, parts_included), payment_terms = CASE WHEN $10 THEN $11 ELSE payment_terms END, terms = CASE WHEN $12 THEN $13 ELSE terms END WHERE id = $1`,
  [id, merged.startsOn, merged.endsOn, merged.billingModel, merged.monthlyFee, merged.perVisitFee, patch.responseHours !== undefined, patch.responseHours ?? null, patch.autoRenew ?? null,
    patch.paymentTerms !== undefined, patch.paymentTerms ?? null, patch.terms !== undefined, patch.terms ?? null, patch.partsIncluded ?? null]);
  await audit(tx, actor, { action: 'service_agreement.updated', entityType: 'service_agreement', entityId: id, facilityId: a.facility_id, data: patch });
  return getAgreement(tx, actor, id);
}

export interface PlanInput { assetId: string; title: string; everyN: number; unit: 'week' | 'month' | 'year'; firstDueOn: string; estimatedMinutes?: number | null; requiredSkill?: string | null; checklist?: string[]; perVisitFee?: number | null }

export async function addPlan(tx: Tx, actor: Actor, agreementId: string, input: PlanInput) {
  const a = await lockAgreement(tx, agreementId);
  requirePermission(actor, 'fieldservice.manage', a.facility_id);
  if (['ended', 'cancelled'].includes(a.status)) throw conflict(`the agreement is ${a.status}`);
  if (!input.title.trim()) throw invalid('name the service');
  const asset = await one(tx, 'SELECT id, customer_id FROM asset WHERE id = $1', [input.assetId]);
  if (!asset || asset.customer_id !== a.customer_id) throw invalid('the equipment must belong to this agreement’s customer');
  const checklist = (input.checklist ?? []).map((c) => c.trim()).filter(Boolean);
  const p = await one(tx, `INSERT INTO service_plan (tenant_id, agreement_id, asset_id, title, every_n, unit, next_due_on, estimated_minutes, required_skill, checklist, per_visit_fee)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
  [actor.tenantId, agreementId, input.assetId, input.title.trim(), input.everyN, input.unit, input.firstDueOn, input.estimatedMinutes ?? null, input.requiredSkill?.trim().toLowerCase() || null, JSON.stringify(checklist), input.perVisitFee ?? null])
    .catch((e) => { if (String(e.message).includes('service_plan_agreement_id_asset_id_title_key')) throw conflict('this equipment already has a service with that name on the agreement'); throw e; });
  await audit(tx, actor, { action: 'service_plan.added', entityType: 'service_agreement', entityId: agreementId, facilityId: a.facility_id, data: { planId: p.id, title: p.title, every: `${input.everyN} ${input.unit}` } });
  return p;
}

export async function setPlanActive(tx: Tx, actor: Actor, planId: string, active: boolean) {
  const p = await one(tx, 'SELECT p.*, a.facility_id FROM service_plan p JOIN service_agreement a ON a.id = p.agreement_id WHERE p.id = $1', [planId]);
  if (!p) throw notFound('covered unit');
  requirePermission(actor, 'fieldservice.manage', p.facility_id);
  await tx.query('UPDATE service_plan SET active = $2 WHERE id = $1', [planId, active]);
  if (!active) await tx.query(`UPDATE service_visit SET status = 'cancelled', cancel_reason = 'Service removed from the agreement' WHERE plan_id = $1 AND status = 'planned'`, [planId]);
  await audit(tx, actor, { action: active ? 'service_plan.activated' : 'service_plan.deactivated', entityType: 'service_plan', entityId: planId, facilityId: p.facility_id, data: {} });
}

export async function activateAgreement(tx: Tx, actor: Actor, id: string) {
  const a = await lockAgreement(tx, id);
  requirePermission(actor, 'fieldservice.manage', a.facility_id);
  await requireLicensed(tx, a.facility_id);
  if (!['draft', 'suspended'].includes(a.status)) throw conflict(`the agreement is ${a.status}`);
  const plans = await one(tx, 'SELECT count(*)::int AS n FROM service_plan WHERE agreement_id = $1 AND active', [id]);
  if (!plans!.n) throw invalid('add at least one covered unit before activating');
  await tx.query(`UPDATE service_agreement SET status = 'active' WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'service_agreement.activated', entityType: 'service_agreement', entityId: id, facilityId: a.facility_id, data: { from: a.status } });
  await generateVisitsForTenant(tx, actor.tenantId, { agreementId: id });
  return getAgreement(tx, actor, id);
}

export async function suspendAgreement(tx: Tx, actor: Actor, id: string, reason: string) {
  const a = await lockAgreement(tx, id);
  requirePermission(actor, 'fieldservice.manage', a.facility_id);
  if (a.status !== 'active') throw conflict(`the agreement is ${a.status}`);
  if (reason.trim().length < 3) throw invalid('give a reason');
  await tx.query(`UPDATE service_agreement SET status = 'suspended' WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'service_agreement.suspended', entityType: 'service_agreement', entityId: id, facilityId: a.facility_id, data: { reason } });
}

export async function endAgreement(tx: Tx, actor: Actor, id: string, input: { outcome: 'ended' | 'cancelled'; reason: string }) {
  const a = await lockAgreement(tx, id);
  requirePermission(actor, 'fieldservice.manage', a.facility_id);
  if (['ended', 'cancelled'].includes(a.status)) throw conflict(`the agreement is already ${a.status}`);
  if (input.reason.trim().length < 3) throw invalid('give a reason');
  await tx.query(`UPDATE service_agreement SET status = $2, ends_on = least(coalesce(ends_on, current_date), current_date) WHERE id = $1`, [id, input.outcome]);
  const gone = await tx.query(`UPDATE service_visit SET status = 'cancelled', cancel_reason = $2 WHERE agreement_id = $1 AND status IN ('planned', 'scheduled')`, [id, `Agreement ${input.outcome}: ${input.reason}`]);
  await audit(tx, actor, { action: `service_agreement.${input.outcome}`, entityType: 'service_agreement', entityId: id, facilityId: a.facility_id, data: { reason: input.reason, visitsCancelled: gone.rowCount } });
}

const AGREEMENT_SELECT = `SELECT a.*, c.name AS customer_name, f.code AS facility_code, u.display_name AS owner_name,
    (SELECT count(*)::int FROM service_plan p WHERE p.agreement_id = a.id AND p.active) AS covered_units,
    (SELECT count(*)::int FROM service_visit v WHERE v.agreement_id = a.id AND v.status IN ('planned', 'scheduled', 'dispatched', 'in_progress') AND v.due_on < current_date) AS overdue_visits,
    (SELECT min(v.due_on) FROM service_visit v WHERE v.agreement_id = a.id AND v.status IN ('planned', 'scheduled', 'dispatched')) AS next_visit_due
  FROM service_agreement a JOIN customer c ON c.id = a.customer_id JOIN facility f ON f.id = a.facility_id JOIN app_user u ON u.id = a.owner_user_id`;

export async function listAgreements(tx: Tx, actor: Actor, q: { status?: string; customerId?: string } = {}) {
  requirePermission(actor, 'fieldservice.view');
  const rows = await many(tx, `${AGREEMENT_SELECT} WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.customer_id = $2) ORDER BY a.created_at DESC LIMIT 300`, [q.status ?? null, q.customerId ?? null]);
  return rows.filter((r) => can(actor, 'fieldservice.view', r.facility_id));
}

export async function getAgreement(tx: Tx, actor: Actor, id: string) {
  const a = await one(tx, `${AGREEMENT_SELECT} WHERE a.id = $1`, [id]);
  if (!a) throw notFound('service agreement');
  requirePermission(actor, 'fieldservice.view', a.facility_id);
  const plans = await many(tx, `SELECT p.*, x.asset_tag, x.name AS asset_name, s.name AS site_name FROM service_plan p JOIN asset x ON x.id = p.asset_id LEFT JOIN customer_site s ON s.id = x.customer_site_id
    WHERE p.agreement_id = $1 ORDER BY p.active DESC, x.asset_tag, p.title`, [id]);
  const visits = await many(tx, `SELECT v.id, v.number, v.title, v.due_on, v.status, v.scheduled_on, v.kind, (v.due_on < current_date AND v.status IN ('planned', 'scheduled', 'dispatched', 'in_progress')) AS overdue
    FROM service_visit v WHERE v.agreement_id = $1 ORDER BY v.due_on DESC LIMIT 50`, [id]);
  return { ...a, plans, visits };
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------
function advance(date: string, n: number, unit: 'week' | 'month' | 'year'): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (unit === 'week') { d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); }
  const months = unit === 'year' ? 12 * n : n;
  const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
export const nextDueAfter = advance;

/**
 * Creates the visits that fall inside the horizon for every active agreement, once each (a plan and a due date make one visit). A plan
 * that has fallen behind creates its overdue visit once and then resumes on the next date still ahead, so a lapse does not generate a
 * pile of missed visits.
 */
export async function generateVisitsForTenant(tx: Tx, tenantId: string, opts: { agreementId?: string; horizonDays?: number } = {}) {
  const s = await getSettings(tx);
  const horizon = new Date(Date.now() + (opts.horizonDays ?? s.horizonDays) * 86_400_000).toISOString().slice(0, 10);
  const t = today();
  const plans = await many(tx, `SELECT p.*, a.facility_id, a.customer_id, a.ends_on, x.customer_site_id AS site_id FROM service_plan p JOIN service_agreement a ON a.id = p.agreement_id JOIN asset x ON x.id = p.asset_id
    WHERE p.active AND a.status = 'active' AND a.starts_on <= $2 AND p.next_due_on <= $2 AND ($1::uuid IS NULL OR a.id = $1) ORDER BY p.next_due_on FOR UPDATE OF p`, [opts.agreementId ?? null, horizon]);
  let created = 0;
  for (const p of plans) {
    if (!(await hasModule(tx, p.facility_id, MODULE))) continue;
    let due = new Date(p.next_due_on).toISOString().slice(0, 10);
    const ends = p.ends_on ? new Date(p.ends_on).toISOString().slice(0, 10) : null;
    let guard = 0;
    while (due <= horizon && guard++ < 500) {
      if (ends && due > ends) break;
      const behind = due < t;
      const number = `SV-${String(await nextSequence(tx, tenantId, 'service_visit')).padStart(6, '0')}`;
      const r = await tx.query(`INSERT INTO service_visit (tenant_id, facility_id, number, agreement_id, plan_id, customer_id, site_id, asset_id, kind, title, due_on, estimated_minutes, required_skill)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9, $10, $11, $12) ON CONFLICT (plan_id, due_on) WHERE plan_id IS NOT NULL DO NOTHING`,
      [tenantId, p.facility_id, number, p.agreement_id, p.id, p.customer_id, p.site_id, p.asset_id, p.title, due, p.estimated_minutes ?? s.defaultVisitMinutes, p.required_skill]);
      created += r.rowCount ?? 0;
      due = advance(due, p.every_n, p.unit);
      if (behind) while (due < t && guard++ < 500) due = advance(due, p.every_n, p.unit);
    }
    await tx.query('UPDATE service_plan SET next_due_on = $2 WHERE id = $1', [p.id, due]);
  }
  return created;
}

export async function generateVisits(tx: Tx, actor: Actor, opts: { horizonDays?: number } = {}) {
  requirePermission(actor, 'fieldservice.manage');
  const created = await generateVisitsForTenant(tx, actor.tenantId, opts);
  await audit(tx, actor, { action: 'service_visit.generated', entityType: 'service_visit', entityId: actor.tenantId, data: { created } });
  return { created };
}

export async function createCallout(tx: Tx, actor: Actor, input: { facilityId: string; customerId: string; siteId?: string | null; assetId: string; agreementId?: string | null; title: string; priority?: number; dueOn?: string; estimatedMinutes?: number; requiredSkill?: string | null; notes?: string | null }) {
  requirePermission(actor, 'fieldservice.manage', input.facilityId);
  await requireLicensed(tx, input.facilityId);
  if (input.title.trim().length < 3) throw invalid('say what the call is about');
  if (!(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw invalid('customer not found');
  let siteId = input.siteId ?? null;
  if (!input.assetId) throw invalid('choose the equipment the call is about (add it to the customer first if it is new)');
  {
    const a = await one(tx, 'SELECT customer_id, customer_site_id FROM asset WHERE id = $1', [input.assetId]);
    if (!a || a.customer_id !== input.customerId) throw invalid('the equipment is not this customer’s');
    siteId = siteId ?? a.customer_site_id;
  }
  if (siteId && !(await one(tx, 'SELECT 1 FROM customer_site WHERE id = $1 AND customer_id = $2', [siteId, input.customerId]))) throw invalid('the site is not this customer’s');
  if (input.agreementId && !(await one(tx, 'SELECT 1 FROM service_agreement WHERE id = $1 AND customer_id = $2', [input.agreementId, input.customerId]))) throw invalid('the agreement is not this customer’s');
  const s = await getSettings(tx);
  const number = `SV-${String(await nextSequence(tx, actor.tenantId, 'service_visit')).padStart(6, '0')}`;
  const v = await one(tx, `INSERT INTO service_visit (tenant_id, facility_id, number, agreement_id, customer_id, site_id, asset_id, kind, title, priority, due_on, estimated_minutes, required_skill, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'callout', $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.agreementId ?? null, input.customerId, siteId, input.assetId ?? null, input.title.trim(), input.priority ?? 3, input.dueOn ?? today(), input.estimatedMinutes ?? s.defaultVisitMinutes,
    input.requiredSkill?.trim().toLowerCase() || null, input.notes ?? null, actor.userId]);
  await audit(tx, actor, { action: 'service_visit.callout_created', entityType: 'service_visit', entityId: v.id, facilityId: v.facility_id, data: { number, customerId: input.customerId } });
  return v;
}

const VISIT_SELECT = `SELECT v.*, c.name AS customer_name, s.name AS site_name, s.lat::float AS site_lat, s.lon::float AS site_lon, s.address AS site_address, s.access_notes, x.asset_tag, x.name AS asset_name,
    e.first_name || ' ' || e.last_name AS technician_name, sa.number AS agreement_number, f.code AS facility_code,
    (v.due_on < current_date AND v.status IN ('planned', 'scheduled', 'dispatched', 'in_progress')) AS overdue
  FROM service_visit v JOIN customer c ON c.id = v.customer_id JOIN facility f ON f.id = v.facility_id LEFT JOIN customer_site s ON s.id = v.site_id LEFT JOIN asset x ON x.id = v.asset_id
  LEFT JOIN employee e ON e.id = v.technician_id LEFT JOIN service_agreement sa ON sa.id = v.agreement_id`;

export async function listVisits(tx: Tx, actor: Actor, q: { status?: string; open?: boolean; from?: string; to?: string; technicianId?: string; customerId?: string; overdue?: boolean; unassigned?: boolean } = {}) {
  requirePermission(actor, 'fieldservice.view');
  const rows = await many(tx, `${VISIT_SELECT} WHERE ($1::text IS NULL OR v.status = $1) AND (NOT $2 OR v.status IN ('planned', 'scheduled', 'dispatched', 'in_progress'))
      AND ($3::date IS NULL OR v.due_on >= $3) AND ($4::date IS NULL OR v.due_on <= $4) AND ($5::uuid IS NULL OR v.technician_id = $5) AND ($6::uuid IS NULL OR v.customer_id = $6)
      AND (NOT $7 OR (v.due_on < current_date AND v.status IN ('planned', 'scheduled', 'dispatched', 'in_progress'))) AND (NOT $8 OR (v.technician_id IS NULL AND v.status = 'planned'))
    ORDER BY v.due_on, v.priority, v.number LIMIT 500`,
  [q.status ?? null, q.open ?? false, q.from ?? null, q.to ?? null, q.technicianId ?? null, q.customerId ?? null, q.overdue ?? false, q.unassigned ?? false]);
  return rows.filter((r) => can(actor, 'fieldservice.view', r.facility_id));
}

export async function getVisit(tx: Tx, actor: Actor, id: string) {
  const v = await one(tx, `${VISIT_SELECT} WHERE v.id = $1`, [id]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'fieldservice.view', v.facility_id);
  const plan = v.plan_id ? await one(tx, 'SELECT checklist, per_visit_fee FROM service_plan WHERE id = $1', [v.plan_id]) : null;
  return { ...v, checklist: plan?.checklist ?? [] };
}

export async function cancelVisit(tx: Tx, actor: Actor, id: string, reason: string) {
  const v = await one(tx, 'SELECT * FROM service_visit WHERE id = $1 FOR UPDATE', [id]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'fieldservice.manage', v.facility_id);
  if (['completed', 'cancelled', 'in_progress'].includes(v.status)) throw conflict(`the visit is ${v.status}`);
  if (reason.trim().length < 3) throw invalid('give a reason');
  await tx.query(`UPDATE service_visit SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason.trim()]);
  await audit(tx, actor, { action: 'service_visit.cancelled', entityType: 'service_visit', entityId: id, facilityId: v.facility_id, data: { reason } });
}
