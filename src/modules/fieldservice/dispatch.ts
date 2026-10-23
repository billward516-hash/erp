import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersForEmployees } from '../../platform/notify/notify.js';
import { assignTechnician, createWorkOrder, transitionWorkOrder } from '../maintenance/service.js';
import { getSettings, requireLicensed } from './service.js';

/**
 * Dispatch (SC-002 F2). A coordinator picks a visit and the day; the system lists which technicians can take it and what each would
 * cost the day: skill match, working day, time off, hours already booked, and the extra driving. Drive time has no maps provider
 * behind it: it is the straight-line distance between two coordinates, times a road factor, divided by an average speed (all three
 * typed in settings), which is good enough to rank technicians and to see a day is too full. A site or technician without
 * coordinates is assumed 20 minutes away and marked as an estimate.
 */
const UNKNOWN_DRIVE_MIN = 20;
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h! * 60 + m!; };
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 3958.8, rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
type Pt = { lat: number | null; lon: number | null } | null;
export function driveMinutes(a: Pt, b: Pt, s: { roadFactor: number; avgSpeedMph: number }): { minutes: number; miles: number | null; estimate: boolean } {
  if (!a || !b || a.lat == null || a.lon == null || b.lat == null || b.lon == null) return { minutes: UNKNOWN_DRIVE_MIN, miles: null, estimate: true };
  const miles = haversineMiles(a.lat, a.lon, b.lat, b.lon) * s.roadFactor;
  return { minutes: Math.round((miles / s.avgSpeedMph) * 60), miles: Math.round(miles * 10) / 10, estimate: false };
}

async function techDay(tx: Tx, employeeId: string, date: string, s: { roadFactor: number; avgSpeedMph: number }, excludeVisitId?: string) {
  const p = await one(tx, `SELECT p.*, p.home_lat::float AS hlat, p.home_lon::float AS hlon, p.day_start::text AS ds, p.day_end::text AS de FROM technician_profile p WHERE p.employee_id = $1`, [employeeId]);
  if (!p) return null;
  const visits = await many(tx, `SELECT v.id, v.number, v.title, v.estimated_minutes, v.scheduled_start::text AS start, v.status, v.priority, c.name AS customer, st.name AS site, st.lat::float AS lat, st.lon::float AS lon
    FROM service_visit v JOIN customer c ON c.id = v.customer_id LEFT JOIN customer_site st ON st.id = v.site_id
    WHERE v.technician_id = $1 AND v.scheduled_on = $2 AND v.status IN ('scheduled', 'dispatched', 'in_progress', 'completed') AND ($3::uuid IS NULL OR v.id <> $3)
    ORDER BY v.scheduled_start NULLS LAST, v.created_at`, [employeeId, date, excludeVisitId ?? null]);
  const start = toMin(p.ds.slice(0, 5)), end = toMin(p.de.slice(0, 5));
  let clock = start; let at: Pt = { lat: p.hlat, lon: p.hlon }; let driving = 0; let working = 0;
  const stops = visits.map((v) => {
    const d = driveMinutes(at, v, s);
    const arrive = v.start ? Math.max(toMin(v.start.slice(0, 5)), clock) : clock + d.minutes;
    clock = arrive + v.estimated_minutes; at = v; driving += d.minutes; working += v.estimated_minutes;
    return { ...v, driveMinutes: d.minutes, driveMiles: d.miles, driveEstimate: d.estimate, arrive: fromMin(arrive), leave: fromMin(clock) };
  });
  return { profile: p, stops, clock, end, start, at, driving, working, capacity: end - start };
}

async function eligibility(tx: Tx, p: any, emp: any, v: any, date: string) {
  const reasons: string[] = [];
  if (!p.active) reasons.push('not an active technician');
  if (!p.work_days.includes(dow(date))) reasons.push('not working that day');
  const off = await one(tx, 'SELECT reason FROM technician_time_off WHERE employee_id = $1 AND $2::date BETWEEN from_date AND to_date', [emp.id, date]);
  if (off) reasons.push(`time off${off.reason ? ` (${off.reason})` : ''}`);
  if (v.required_skill && !p.skills.includes(v.required_skill)) reasons.push(`lacks the ${v.required_skill} skill`);
  return reasons;
}

export async function suggest(tx: Tx, actor: Actor, visitId: string, date?: string) {
  const v = await one(tx, `SELECT v.*, st.lat::float AS lat, st.lon::float AS lon FROM service_visit v LEFT JOIN customer_site st ON st.id = v.site_id WHERE v.id = $1`, [visitId]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'fieldservice.manage', v.facility_id);
  const day = date ?? (v.scheduled_on ? new Date(v.scheduled_on).toISOString().slice(0, 10) : new Date(v.due_on).toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10) ? new Date().toISOString().slice(0, 10) : new Date(v.due_on).toISOString().slice(0, 10));
  const s = await getSettings(tx);
  const emps = await many(tx, `SELECT e.id, e.first_name, e.last_name, e.facility_id FROM technician_profile p JOIN employee e ON e.id = p.employee_id ORDER BY e.last_name`);
  const out = [];
  for (const e of emps) {
    const d = await techDay(tx, e.id, day, s, visitId);
    if (!d) continue;
    const why = await eligibility(tx, d.profile, e, v, day);
    const drive = driveMinutes(d.at, v, s);
    const remaining = d.capacity - (d.clock - d.start) - drive.minutes - v.estimated_minutes;
    if (remaining < 0) why.push(`only ${Math.max(0, d.capacity - (d.clock - d.start))} minutes left in the day (needs ${drive.minutes + v.estimated_minutes})`);
    out.push({ technicianId: e.id, name: `${e.first_name} ${e.last_name}`, eligible: why.length === 0, reasons: why, addedDriveMinutes: drive.minutes, driveMiles: drive.miles, driveEstimate: drive.estimate,
      bookedMinutes: d.working + d.driving, visitsThatDay: d.stops.length, remainingMinutesAfter: remaining, startsAt: fromMin(Math.max(d.start, d.clock) + (d.stops.length ? drive.minutes : drive.minutes)), skills: d.profile.skills, vehicleId: d.profile.vehicle_id });
  }
  out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.addedDriveMinutes - b.addedDriveMinutes || b.remainingMinutesAfter - a.remainingMinutesAfter);
  return { visitId, date: day, settings: s, suggestions: out };
}

export async function assign(tx: Tx, actor: Actor, visitId: string, input: { technicianId: string; date: string; start?: string | null; vehicleId?: string | null; allowOvertime?: boolean }) {
  const v = await one(tx, `SELECT v.*, st.lat::float AS lat, st.lon::float AS lon FROM service_visit v LEFT JOIN customer_site st ON st.id = v.site_id WHERE v.id = $1 FOR UPDATE OF v`, [visitId]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'fieldservice.manage', v.facility_id);
  await requireLicensed(tx, v.facility_id);
  if (!['planned', 'scheduled', 'dispatched'].includes(v.status)) throw conflict(`the visit is ${v.status}`);
  const emp = await one(tx, 'SELECT id, first_name, last_name FROM employee WHERE id = $1', [input.technicianId]);
  const s = await getSettings(tx);
  const d = emp ? await techDay(tx, emp.id, input.date, s, visitId) : null;
  if (!emp || !d) throw invalid('choose a technician');
  const why = await eligibility(tx, d.profile, emp, v, input.date);
  if (why.length) throw invalid(`${emp.first_name} ${emp.last_name} cannot take this visit: ${why.join('; ')}`);
  const drive = driveMinutes(d.at, v, s);
  const startMin = input.start ? toMin(input.start) : Math.max(d.start, d.clock + (d.stops.length ? drive.minutes : drive.minutes));
  const startAt = input.start ? startMin : startMin;
  if (startAt < d.start) throw invalid(`the working day starts at ${fromMin(d.start)}`);
  if (startAt + v.estimated_minutes > d.end && !input.allowOvertime) throw invalid(`this runs past the end of ${emp.first_name}’s day (${fromMin(d.end)}); choose another day or confirm overtime`);
  const vehicle = input.vehicleId ?? d.profile.vehicle_id ?? null;
  if (vehicle && !(await one(tx, `SELECT 1 FROM asset WHERE id = $1 AND asset_class = 'vehicle'`, [vehicle]))) throw invalid('choose a vehicle');
  await tx.query(`UPDATE service_visit SET status = CASE WHEN status = 'dispatched' THEN 'dispatched' ELSE 'scheduled' END, scheduled_on = $2, scheduled_start = $3, technician_id = $4, vehicle_id = $5 WHERE id = $1`,
    [visitId, input.date, fromMin(startAt), input.technicianId, vehicle]);
  // The work order carries the labor and parts and the history on the customer's equipment; one per visit, made when the visit is first placed.
  let woId = v.work_order_id as string | null;
  if (!woId) {
    const plan = v.plan_id ? await one(tx, 'SELECT checklist FROM service_plan WHERE id = $1', [v.plan_id]) : null;
    const list = ((plan?.checklist ?? []) as string[]).map((c, i) => `${i + 1}. ${c}`).join('\n');
    const wo = await createWorkOrder(tx, actor, { assetId: v.asset_id, title: `${v.number}: ${v.title}`.slice(0, 200), woType: v.kind === 'scheduled' ? 'preventive' : 'corrective', priority: v.priority as 1 | 2 | 3 | 4,
      description: list ? `Service checklist:\n${list}` : v.notes ?? null, dueAt: new Date(`${input.date}T23:59:00Z`).toISOString(), estimatedLaborHours: Math.round((v.estimated_minutes / 60) * 100) / 100 });
    woId = wo.id;
    await tx.query('UPDATE service_visit SET work_order_id = $2 WHERE id = $1', [visitId, woId]);
  }
  if (v.technician_id && v.technician_id !== input.technicianId) await tx.query('DELETE FROM work_order_assignment WHERE work_order_id = $1 AND employee_id = $2', [woId, v.technician_id]);
  await assignTechnician(tx, actor, woId!, input.technicianId, 'lead');
  const users = await usersForEmployees(tx, [input.technicianId]);
  await notify(tx, actor.tenantId, [users.get(input.technicianId)], { kind: 'service.assigned', title: `New visit ${v.number} on ${input.date} at ${fromMin(startAt)}: ${v.title}`, link: `/service/my-day`, subjectType: 'service_visit', subjectId: visitId, dedupeKey: `sv-assign:${visitId}:${input.date}:${input.technicianId}` }, actor.userId);
  await audit(tx, actor, { action: 'service_visit.assigned', entityType: 'service_visit', entityId: visitId, facilityId: v.facility_id, data: { technicianId: input.technicianId, date: input.date, start: fromMin(startAt), driveMinutes: drive.minutes } });
  return { visitId, technicianId: input.technicianId, date: input.date, start: fromMin(startAt), driveMinutes: drive.minutes };
}

export async function unassign(tx: Tx, actor: Actor, visitId: string) {
  const v = await one(tx, 'SELECT * FROM service_visit WHERE id = $1 FOR UPDATE', [visitId]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'fieldservice.manage', v.facility_id);
  if (!['scheduled', 'dispatched'].includes(v.status)) throw conflict(`the visit is ${v.status}`);
  if (v.work_order_id && v.technician_id) await tx.query('DELETE FROM work_order_assignment WHERE work_order_id = $1 AND employee_id = $2', [v.work_order_id, v.technician_id]);
  await tx.query(`UPDATE service_visit SET status = 'planned', scheduled_on = NULL, scheduled_start = NULL, technician_id = NULL, vehicle_id = NULL WHERE id = $1`, [visitId]);
  await audit(tx, actor, { action: 'service_visit.unassigned', entityType: 'service_visit', entityId: visitId, facilityId: v.facility_id, data: { wasTechnician: v.technician_id } });
}

/** Sends a technician's day to them: scheduled visits become dispatched and the technician is told. */
export async function dispatchDay(tx: Tx, actor: Actor, input: { technicianId: string; date: string }) {
  requirePermission(actor, 'fieldservice.manage');
  const r = await tx.query(`UPDATE service_visit SET status = 'dispatched' WHERE technician_id = $1 AND scheduled_on = $2 AND status = 'scheduled' RETURNING id, facility_id`, [input.technicianId, input.date]);
  if (!r.rowCount) throw invalid('nothing scheduled for that technician that day');
  const users = await usersForEmployees(tx, [input.technicianId]);
  await notify(tx, actor.tenantId, [users.get(input.technicianId)], { kind: 'service.assigned', title: `Your day for ${input.date} is ready: ${r.rowCount} visit${r.rowCount === 1 ? '' : 's'}`, link: '/service/my-day', subjectType: 'service_dispatch', subjectId: input.technicianId, dedupeKey: `sv-day:${input.technicianId}:${input.date}` }, actor.userId);
  await audit(tx, actor, { action: 'service_visit.dispatched', entityType: 'employee', entityId: input.technicianId, data: { date: input.date, visits: r.rowCount } });
  return { dispatched: r.rowCount };
}

/** The board for a day: each technician's route with drive times and load, then the open visits still to place. */
export async function board(tx: Tx, actor: Actor, date: string) {
  requirePermission(actor, 'fieldservice.view');
  const s = await getSettings(tx);
  const emps = await many(tx, `SELECT e.id, e.first_name, e.last_name, e.facility_id, p.skills, p.work_days FROM technician_profile p JOIN employee e ON e.id = p.employee_id WHERE p.active ORDER BY e.last_name`);
  const technicians = [];
  for (const e of emps.filter((x) => !x.facility_id || can(actor, 'fieldservice.view', x.facility_id))) {
    const d = await techDay(tx, e.id, date, s);
    if (!d) continue;
    const off = await one(tx, 'SELECT reason FROM technician_time_off WHERE employee_id = $1 AND $2::date BETWEEN from_date AND to_date', [e.id, date]);
    const used = d.working + d.driving;
    technicians.push({ id: e.id, name: `${e.first_name} ${e.last_name}`, skills: e.skills, working: e.work_days.includes(dow(date)) && !off, off: off ? off.reason ?? 'time off' : null, capacityMinutes: d.capacity, workMinutes: d.working, driveMinutes: d.driving,
      loadPercent: d.capacity ? Math.round((used / d.capacity) * 100) : 0, overbooked: used > d.capacity, stops: d.stops });
  }
  const unassigned = (await many(tx, `SELECT v.id, v.number, v.title, v.due_on, v.priority, v.kind, v.estimated_minutes, v.required_skill, v.facility_id, c.name AS customer, st.name AS site, (v.due_on < $1::date) AS overdue
    FROM service_visit v JOIN customer c ON c.id = v.customer_id LEFT JOIN customer_site st ON st.id = v.site_id WHERE v.status = 'planned' AND v.due_on <= $1::date + 7 ORDER BY v.priority, v.due_on, v.number`, [date])).filter((v) => can(actor, 'fieldservice.view', v.facility_id));
  return { date, settings: s, technicians, unassigned };
}

/** What a technician sees for a day: their visits in route order with site, access notes and drive time. */
export async function myDay(tx: Tx, actor: Actor, date: string) {
  requirePermission(actor, 'fieldservice.execute');
  if (!actor.employeeId) return { date, technician: false, stops: [] }; // a sign-in with no employee record (an administrator, say) simply has no day
  const s = await getSettings(tx);
  const d = await techDay(tx, actor.employeeId, date, s);
  if (!d) return { date, technician: false, stops: [] };
  const ids = d.stops.map((x) => x.id);
  const detail = ids.length ? await many(tx, `SELECT v.id, v.number, v.title, v.status, v.work_order_id, st.address, st.access_notes, x.asset_tag, x.name AS asset_name, x.manufacturer, x.model, x.serial_number, sp.checklist
    FROM service_visit v LEFT JOIN customer_site st ON st.id = v.site_id LEFT JOIN asset x ON x.id = v.asset_id LEFT JOIN service_plan sp ON sp.id = v.plan_id WHERE v.id = ANY ($1)`, [ids]) : [];
  const by = new Map(detail.map((x) => [x.id, x]));
  return { date, technician: true, stops: d.stops.map((x) => ({ ...x, ...by.get(x.id) })) };
}

export async function startVisit(tx: Tx, actor: Actor, visitId: string) {
  requirePermission(actor, 'fieldservice.execute');
  const v = await one(tx, 'SELECT * FROM service_visit WHERE id = $1 FOR UPDATE', [visitId]);
  if (!v) throw notFound('visit');
  if (v.technician_id !== actor.employeeId && !can(actor, 'fieldservice.manage', v.facility_id)) throw forbidden('this visit is assigned to someone else');
  if (!['scheduled', 'dispatched'].includes(v.status)) throw conflict(`the visit is ${v.status}`);
  await tx.query(`UPDATE service_visit SET status = 'in_progress', started_at = now() WHERE id = $1`, [visitId]);
  if (v.work_order_id) await transitionWorkOrder(tx, actor, v.work_order_id, { to: 'in_progress' });
  await audit(tx, actor, { action: 'service_visit.started', entityType: 'service_visit', entityId: visitId, facilityId: v.facility_id, data: {} });
}
