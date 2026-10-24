import type { Actor } from '../../platform/auth/actor.js';
import { can, facilitiesWith } from '../../platform/auth/actor.js';
import { audit, auditHistory } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import type { Booking, PersonCalendar, TargetRow, WeekCell } from './capacity.js';
import {
  DEFAULT_HOURS, addDays, rangeHours, resolveTarget, round2, utilizationOf, weekCell, weekStartOf, weeksFrom,
} from './capacity.js';

/**
 * Staffing and utilization (SC-009 P3, D-188C): working patterns, holidays, time off, assignments of people to projects,
 * the capacity grid and billable utilization. The arithmetic is in capacity.ts; this file loads the data, applies who may
 * see and change what, and keeps the audit trail.
 */
export const isoToday = () => new Date().toISOString().slice(0, 10);
const MAX_WEEKS = 26;

export interface StaffingSettings { defaultHours: number[]; targetPct: number; benchPct: number; toleranceH: number; saved: boolean }
export async function getSettings(tx: Tx): Promise<StaffingSettings> {
  const r = await one(tx, 'SELECT default_hours::float[] AS default_hours, target_pct::float AS target_pct, bench_pct::float AS bench_pct, overbook_tolerance_h::float AS tol FROM staffing_settings');
  return { defaultHours: r?.default_hours ?? DEFAULT_HOURS, targetPct: r?.target_pct ?? 75, benchPct: r?.bench_pct ?? 50, toleranceH: r?.tol ?? 0.5, saved: !!r };
}

const companyWide = (actor: Actor) => facilitiesWith(actor, 'staffing.manage').all;
const mayManage = (actor: Actor, facilityId: string) => can(actor, 'staffing.manage', facilityId);
function requireManage(actor: Actor, facilityId: string) { if (!mayManage(actor, facilityId)) throw forbidden('staffing.manage'); }

export async function saveSettings(tx: Tx, actor: Actor, input: { defaultHours?: number[]; targetPct?: number; benchPct?: number; toleranceH?: number }) {
  if (!companyWide(actor)) throw forbidden('staffing.manage (company-wide)');
  const cur = await getSettings(tx);
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as StaffingSettings;
  if (next.defaultHours.length !== 7 || next.defaultHours.some((h) => h < 0 || h > 24)) throw invalid('the default week needs seven values between 0 and 24 hours');
  await tx.query(`INSERT INTO staffing_settings (tenant_id, default_hours, target_pct, bench_pct, overbook_tolerance_h, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tenant_id) DO UPDATE SET default_hours = EXCLUDED.default_hours, target_pct = EXCLUDED.target_pct, bench_pct = EXCLUDED.bench_pct, overbook_tolerance_h = EXCLUDED.overbook_tolerance_h, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, next.defaultHours, next.targetPct, next.benchPct, next.toleranceH, actor.userId]);
  await audit(tx, actor, { action: 'staffing.settings_saved', entityType: 'staffing_settings', entityId: actor.tenantId, data: { before: cur, after: next } });
  return getSettings(tx);
}

// ---------------------------------------------------------------------------------------------------------------------
// Who is visible
// ---------------------------------------------------------------------------------------------------------------------
export interface Person {
  id: string; employee_number: string; name: string; job_title: string | null; facility_id: string; facility_code: string;
  department_id: string | null; department: string | null; manager_employee_id: string | null; manager: string | null; excluded: boolean;
}

const PEOPLE_SQL = `SELECT e.id, e.employee_number, e.first_name || ' ' || e.last_name AS name, e.job_title, e.facility_id, f.code AS facility_code,
    e.department_id, d.name AS department, e.manager_employee_id, m.first_name || ' ' || m.last_name AS manager, (x.employee_id IS NOT NULL) AS excluded
  FROM employee e JOIN facility f ON f.id = e.facility_id LEFT JOIN department d ON d.id = e.department_id
  LEFT JOIN employee m ON m.id = e.manager_employee_id LEFT JOIN staffing_exclusion x ON x.employee_id = e.id
  WHERE e.status = 'active' AND e.facility_id IS NOT NULL ORDER BY f.code, e.last_name, e.first_name`;

/** Every active employee with a home site, whoever is asking (for the daily job). */
export async function allPeople(tx: Tx): Promise<Person[]> { return many<Person>(tx, PEOPLE_SQL); }

/**
 * People the actor may see: themselves, everyone who reports to them (directly or through others) when they hold
 * staffing.view_own, and everyone at the sites where they hold staffing.view_team or staffing.manage.
 */
export async function visiblePeople(tx: Tx, actor: Actor): Promise<Person[]> {
  const own = can(actor, 'staffing.view_own');
  const team = facilitiesWith(actor, 'staffing.view_team');
  const manage = facilitiesWith(actor, 'staffing.manage');
  if (!own && !team.all && !team.ids.length && !manage.all && !manage.ids.length) throw forbidden('staffing.view_own');
  const reports = new Set<string>();
  if (own && actor.employeeId) {
    for (const r of await many(tx, `WITH RECURSIVE r AS (SELECT id FROM employee WHERE manager_employee_id = $1 UNION SELECT e.id FROM employee e JOIN r ON e.manager_employee_id = r.id) SELECT id FROM r`, [actor.employeeId])) reports.add(r.id);
  }
  const sites = new Set([...team.ids, ...manage.ids]);
  const everywhere = team.all || manage.all;
  return (await allPeople(tx)).filter((p) => (own && p.id === actor.employeeId) || reports.has(p.id) || everywhere || sites.has(p.facility_id));
}

async function personFor(tx: Tx, actor: Actor, id: string): Promise<Person> {
  const p = (await visiblePeople(tx, actor)).find((x) => x.id === id);
  if (!p) throw notFound('person');
  return p;
}
async function employeeRow(tx: Tx, id: string) {
  const e = await one(tx, 'SELECT id, facility_id, first_name || \' \' || last_name AS name, job_title FROM employee WHERE id = $1', [id]);
  if (!e) throw notFound('employee');
  if (!e.facility_id) throw invalid('the employee has no home site; set one before staffing them');
  return e as { id: string; facility_id: string; name: string; job_title: string | null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Calendars and bookings
// ---------------------------------------------------------------------------------------------------------------------
export async function loadCalendars(tx: Tx, people: Pick<Person, 'id' | 'facility_id'>[], from: string, to: string, settings: StaffingSettings): Promise<Map<string, PersonCalendar>> {
  const ids = people.map((p) => p.id);
  const patterns = await many(tx, 'SELECT employee_id, effective_from::text AS effective_from, hours::float[] AS hours FROM work_pattern WHERE employee_id = ANY ($1) ORDER BY effective_from', [ids]);
  const holidays = await many(tx, 'SELECT facility_id, holiday_date::text AS d, hours_off::float AS hours_off FROM company_holiday WHERE holiday_date BETWEEN $1 AND $2', [from, to]);
  const own = await many(tx, `SELECT employee_id, from_date::text AS f, to_date::text AS t, hours_per_day::float AS h FROM employee_time_off WHERE employee_id = ANY ($1) AND status = 'approved' AND to_date >= $2 AND from_date <= $3`, [ids, from, to]);
  const tech = await many(tx, 'SELECT employee_id, from_date::text AS f, to_date::text AS t FROM technician_time_off WHERE employee_id = ANY ($1) AND to_date >= $2 AND from_date <= $3', [ids, from, to]);
  const out = new Map<string, PersonCalendar>();
  for (const p of people) {
    const hol = new Map<string, number | null>();
    for (const h of holidays) {
      if (h.facility_id && h.facility_id !== p.facility_id) continue;
      // Two holidays on one date (company-wide and the site's): the larger claim wins; null (whole day) is the largest.
      if (!hol.has(h.d)) hol.set(h.d, h.hours_off);
      else { const cur = hol.get(h.d); hol.set(h.d, cur == null || h.hours_off == null ? null : Math.max(cur, h.hours_off)); }
    }
    out.set(p.id, {
      defaultHours: settings.defaultHours,
      patterns: patterns.filter((r) => r.employee_id === p.id).map((r) => ({ effectiveFrom: r.effective_from, hours: r.hours })),
      holidays: hol,
      timeOff: [...own.filter((r) => r.employee_id === p.id).map((r) => ({ from: r.f, to: r.t, hoursPerDay: r.h })),
        ...tech.filter((r) => r.employee_id === p.id).map((r) => ({ from: r.f, to: r.t, hoursPerDay: null }))],
    });
  }
  return out;
}

export interface BookingRow extends Booking {
  id: string; employeeId: string; projectId: string; role: string | null; billable: boolean;
  projectNumber: string | null; projectName: string | null; overrideReason: string | null;
}
export async function loadBookings(tx: Tx, employeeIds: string[], from: string, to: string, opts: { projectId?: string; excludeId?: string } = {}): Promise<Map<string, BookingRow[]>> {
  const rows = await many(tx, `SELECT a.id, a.employee_id, a.project_id, a.role, a.hours_per_week::float AS hpw, a.start_date::text AS start, a.end_date::text AS "end", a.state, a.billable, a.override_reason,
      p.number AS project_number, p.name AS project_name
    FROM project_assignment a LEFT JOIN project p ON p.id = a.project_id
    WHERE a.employee_id = ANY ($1) AND a.removed_at IS NULL AND a.end_date >= $2 AND a.start_date <= $3 AND ($4::uuid IS NULL OR a.project_id = $4) AND ($5::uuid IS NULL OR a.id <> $5)`,
  [employeeIds, from, to, opts.projectId ?? null, opts.excludeId ?? null]);
  const out = new Map<string, BookingRow[]>();
  for (const r of rows) {
    const list = out.get(r.employee_id) ?? [];
    list.push({ id: r.id, employeeId: r.employee_id, projectId: r.project_id, role: r.role, hoursPerWeek: r.hpw, start: r.start, end: r.end, state: r.state, billable: r.billable,
      projectNumber: r.project_number, projectName: r.project_name, overrideReason: r.override_reason });
    out.set(r.employee_id, list);
  }
  return out;
}

export interface GridRow { person: Person; cells: WeekCell[]; available: number; booked: number; over: number; free: number }
/** Weeks across, people down: each cell is the person's capacity and bookings for the week. */
export async function gridFor(tx: Tx, people: Person[], from: string, weeks: number, settings: StaffingSettings, opts: { projectId?: string } = {}): Promise<GridRow[]> {
  const start = weekStartOf(from);
  const end = addDays(start, 7 * weeks - 1);
  const cals = await loadCalendars(tx, people, start, end, settings);
  const books = await loadBookings(tx, people.map((p) => p.id), start, end);
  return people.map((person) => {
    const cal = cals.get(person.id)!;
    const all = books.get(person.id) ?? [];
    const cells = weeksFrom(start, weeks).map((w) => {
      const c = weekCell(cal, all, w, settings.toleranceH);
      if (!opts.projectId) return c;
      // For a project's staffing view, also say how much of the booking is this project's.
      const mine = weekCell(cal, all.filter((b) => b.projectId === opts.projectId), w, settings.toleranceH);
      return { ...c, project: mine.booked };
    });
    return { person, cells, available: round2(cells.reduce((s, c) => s + c.available, 0)), booked: round2(cells.reduce((s, c) => s + c.booked, 0)),
      over: round2(cells.reduce((s, c) => s + c.over, 0)), free: round2(cells.reduce((s, c) => s + c.free, 0)) };
  });
}

export interface OverviewQuery { from?: string; weeks?: number; facilityId?: string; departmentId?: string; managerId?: string; projectId?: string; includeExcluded?: boolean }
export async function overview(tx: Tx, actor: Actor, q: OverviewQuery) {
  const settings = await getSettings(tx);
  const weeks = Math.min(Math.max(q.weeks ?? 8, 1), MAX_WEEKS);
  const from = weekStartOf(q.from ?? isoToday());
  let people = await visiblePeople(tx, actor);
  if (q.facilityId) people = people.filter((p) => p.facility_id === q.facilityId);
  if (q.departmentId) people = people.filter((p) => p.department_id === q.departmentId);
  if (q.managerId) people = people.filter((p) => p.manager_employee_id === q.managerId);
  if (q.projectId) {
    const on = new Set((await many(tx, `SELECT DISTINCT employee_id FROM project_assignment WHERE project_id = $1 AND removed_at IS NULL AND end_date >= $2 AND start_date <= $3`, [q.projectId, from, addDays(from, 7 * weeks - 1)])).map((r) => r.employee_id));
    people = people.filter((p) => on.has(p.id));
  }
  const rows = await gridFor(tx, people, from, weeks, settings, { projectId: q.projectId });
  const sites = [...new Map(people.map((p) => [p.facility_id, p.facility_code])).entries()].map(([id, code]) => ({ id, code }));
  const departments = [...new Map(people.filter((p) => p.department_id).map((p) => [p.department_id!, p.department])).entries()].map(([id, name]) => ({ id, name }));
  const managers = [...new Map(people.filter((p) => p.manager_employee_id).map((p) => [p.manager_employee_id!, p.manager])).entries()].map(([id, name]) => ({ id, name }));
  const canManage = actor.grants.some((g) => g.permissions.has('staffing.manage'));
  return { from, weeks: weeksFrom(from, weeks), settings, canManage, today: isoToday(), sites, departments, managers, rows };
}

export async function personDetail(tx: Tx, actor: Actor, id: string, q: { from?: string; weeks?: number }) {
  const person = await personFor(tx, actor, id);
  const settings = await getSettings(tx);
  const weeks = Math.min(Math.max(q.weeks ?? 12, 1), MAX_WEEKS);
  const from = weekStartOf(q.from ?? isoToday());
  const [grid] = await gridFor(tx, [person], from, weeks, settings);
  const assignments = await listAssignments(tx, actor, { employeeId: id, includePast: true });
  const timeOff = await listTimeOff(tx, actor, { employeeId: id });
  const patterns = await many(tx, `SELECT id, effective_from::text AS effective_from, hours::float[] AS hours, note FROM work_pattern WHERE employee_id = $1 ORDER BY effective_from DESC`, [id]);
  const targets = await loadTargets(tx);
  const target = resolveTarget({ id, jobTitle: person.job_title }, targets, settings.targetPct);
  const today = isoToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  const [last3] = await utilizationFor(tx, [person], { from: addDays(monthStart, -90), to: addDays(today, -1) }, settings, targets, today);
  return { person, settings, grid, assignments, timeOff, patterns, target, canManage: mayManage(actor, person.facility_id), utilization: last3 ?? null };
}

/** Projects a person with the manage permission can put people on: not finished, at a site they manage. */
export async function projectOptions(tx: Tx, actor: Actor) {
  const manage = facilitiesWith(actor, 'staffing.manage');
  if (!manage.all && !manage.ids.length) return [];
  const rows = await many(tx, `SELECT id, number, name, status, billing_type, facility_id FROM project WHERE status IN ('proposed', 'active', 'on_hold') ORDER BY number`);
  return rows.filter((r) => manage.all || manage.ids.includes(r.facility_id));
}

export async function projectDetail(tx: Tx, actor: Actor, projectId: string, q: { from?: string; weeks?: number }) {
  const project = await one(tx, 'SELECT id, number, name, status, billing_type, facility_id, start_date::text AS start_date, end_date::text AS end_date FROM project WHERE id = $1', [projectId]);
  if (!project) throw notFound('project');
  const o = await overview(tx, actor, { from: q.from, weeks: q.weeks ?? 12, projectId });
  const assignments = await listAssignments(tx, actor, { projectId, includePast: true });
  const weeks = o.weeks;
  const totals = weeks.map((w, i) => ({ weekStart: w, hours: round2(o.rows.reduce((s, r) => s + ((r.cells[i] as WeekCell & { project?: number }).project ?? 0), 0)) }));
  return { project, ...o, assignments, totals };
}

// ---------------------------------------------------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------------------------------------------------
export interface AssignmentInput {
  projectId: string; employeeId: string; role?: string | null; hoursPerWeek: number; startDate: string; endDate: string;
  billable?: boolean; state?: 'tentative' | 'confirmed'; note?: string | null; overrideReason?: string | null;
}
export interface Conflict { weekStart: string; available: number; alreadyBooked: number; added: number; total: number; over: number }

/** Weeks in which putting this booking on the person leaves them over capacity. Nothing is written. */
export async function conflictsFor(tx: Tx, employee: { id: string; facility_id: string }, b: Booking, settings: StaffingSettings, excludeId?: string): Promise<Conflict[]> {
  const first = weekStartOf(b.start);
  const last = weekStartOf(b.end);
  const cals = await loadCalendars(tx, [employee], first, addDays(last, 6), settings);
  const cal = cals.get(employee.id)!;
  const others = (await loadBookings(tx, [employee.id], first, addDays(last, 6), { excludeId })).get(employee.id) ?? [];
  const out: Conflict[] = [];
  for (let w = first; w <= last; w = addDays(w, 7)) {
    const before = weekCell(cal, others, w, settings.toleranceH);
    const after = weekCell(cal, [...others, b], w, settings.toleranceH);
    const added = round2(after.booked - before.booked);
    if (added > 0 && after.status === 'over') out.push({ weekStart: w, available: after.available, alreadyBooked: before.booked, added, total: after.booked, over: after.over });
  }
  return out;
}

async function projectFor(tx: Tx, projectId: string) {
  const p = await one(tx, 'SELECT id, number, name, status, billing_type, facility_id FROM project WHERE id = $1', [projectId]);
  if (!p) throw notFound('project');
  return p as { id: string; number: string; name: string; status: string; billing_type: string; facility_id: string };
}
function checkInput(i: { hoursPerWeek: number; startDate: string; endDate: string }) {
  if (!(i.hoursPerWeek > 0 && i.hoursPerWeek <= 168)) throw invalid('hours per week must be between 0 and 168');
  if (i.endDate < i.startDate) throw invalid('the end date is before the start date');
  if (daysSpan(i.startDate, i.endDate) > 366 * 3) throw invalid('an assignment can span at most three years; split a longer one');
}
const daysSpan = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

const ASSIGNMENT_SQL = `SELECT a.id, a.project_id, a.employee_id, a.facility_id, a.role, a.hours_per_week::float AS hours_per_week, a.start_date::text AS start_date, a.end_date::text AS end_date,
    a.billable, a.state, a.override_reason, a.note, a.removed_at, a.created_at, a.updated_at, p.number AS project_number, p.name AS project_name, p.status AS project_status,
    e.first_name || ' ' || e.last_name AS employee_name, e.employee_number
  FROM project_assignment a JOIN employee e ON e.id = a.employee_id LEFT JOIN project p ON p.id = a.project_id`;

export async function previewAssignment(tx: Tx, actor: Actor, input: AssignmentInput, assignmentId?: string) {
  checkInput(input);
  const emp = await employeeRow(tx, input.employeeId);
  const proj = await projectFor(tx, input.projectId);
  requireManage(actor, emp.facility_id);
  const settings = await getSettings(tx);
  const warnings = await conflictsFor(tx, emp, { hoursPerWeek: input.hoursPerWeek, start: input.startDate, end: input.endDate, state: input.state ?? 'tentative' }, settings, assignmentId);
  return { warnings, person: emp.name, project: `${proj.number} ${proj.name}` };
}

export async function createAssignment(tx: Tx, actor: Actor, input: AssignmentInput) {
  checkInput(input);
  const emp = await employeeRow(tx, input.employeeId);
  const proj = await projectFor(tx, input.projectId);
  requireManage(actor, emp.facility_id);
  requireManage(actor, proj.facility_id);
  if (['completed', 'cancelled'].includes(proj.status)) throw conflict(`project ${proj.number} is ${proj.status}; reopen it before assigning people`);
  const settings = await getSettings(tx);
  const state = input.state ?? 'tentative';
  const warnings = await conflictsFor(tx, emp, { hoursPerWeek: input.hoursPerWeek, start: input.startDate, end: input.endDate, state }, settings);
  const reason = warnings.length ? input.overrideReason?.trim() || null : null;
  const row = await one(tx, `INSERT INTO project_assignment (tenant_id, facility_id, project_id, employee_id, role, hours_per_week, start_date, end_date, billable, state, override_reason, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
  [actor.tenantId, emp.facility_id, proj.id, emp.id, input.role?.trim() || null, input.hoursPerWeek, input.startDate, input.endDate, input.billable ?? proj.billing_type !== 'non_billable', state, reason, input.note ?? null, actor.userId]);
  await audit(tx, actor, { action: 'staffing.assignment_created', entityType: 'project_assignment', entityId: row.id, facilityId: emp.facility_id,
    data: { project: proj.number, employee: emp.name, hoursPerWeek: input.hoursPerWeek, start: input.startDate, end: input.endDate, state, conflicts: warnings.map((w) => w.weekStart), overrideReason: reason } });
  return { assignment: await getAssignment(tx, row.id), warnings };
}

export async function getAssignment(tx: Tx, id: string) {
  const a = await one(tx, `${ASSIGNMENT_SQL} WHERE a.id = $1`, [id]);
  if (!a) throw notFound('assignment');
  return a;
}

export interface AssignmentPatch {
  projectId?: string; employeeId?: string; role?: string | null; hoursPerWeek?: number; startDate?: string; endDate?: string;
  billable?: boolean; state?: 'tentative' | 'confirmed'; note?: string | null; overrideReason?: string | null;
}
export async function updateAssignment(tx: Tx, actor: Actor, id: string, patch: AssignmentPatch) {
  const cur = await one(tx, `SELECT id, project_id, employee_id, facility_id, role, hours_per_week::float AS hours_per_week, start_date::text AS start_date, end_date::text AS end_date, billable, state, note, override_reason, removed_at
    FROM project_assignment WHERE id = $1 FOR UPDATE`, [id]);
  if (!cur) throw notFound('assignment');
  if (cur.removed_at) throw conflict('this assignment was removed; make a new one');
  requireManage(actor, cur.facility_id);
  const next = {
    projectId: patch.projectId ?? cur.project_id, employeeId: patch.employeeId ?? cur.employee_id, role: patch.role !== undefined ? patch.role?.trim() || null : cur.role,
    hoursPerWeek: patch.hoursPerWeek ?? cur.hours_per_week, startDate: patch.startDate ?? cur.start_date, endDate: patch.endDate ?? cur.end_date,
    billable: patch.billable ?? cur.billable, state: patch.state ?? cur.state, note: patch.note !== undefined ? patch.note : cur.note,
  };
  checkInput(next);
  const emp = await employeeRow(tx, next.employeeId);
  const proj = await projectFor(tx, next.projectId);
  requireManage(actor, emp.facility_id);
  requireManage(actor, proj.facility_id);
  if (next.projectId !== cur.project_id && ['completed', 'cancelled'].includes(proj.status)) throw conflict(`project ${proj.number} is ${proj.status}; reopen it before assigning people`);
  const settings = await getSettings(tx);
  const warnings = await conflictsFor(tx, emp, { hoursPerWeek: next.hoursPerWeek, start: next.startDate, end: next.endDate, state: next.state }, settings, id);
  const reason = warnings.length ? (patch.overrideReason?.trim() || cur.override_reason || null) : null;
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  const was: Record<string, unknown> = { projectId: cur.project_id, employeeId: cur.employee_id, role: cur.role, hoursPerWeek: cur.hours_per_week, startDate: cur.start_date, endDate: cur.end_date, billable: cur.billable, state: cur.state, note: cur.note };
  for (const [k, v] of Object.entries(next)) if (was[k] !== v) changed[k] = { from: was[k], to: v };
  if (!Object.keys(changed).length && reason === cur.override_reason) return { assignment: await getAssignment(tx, id), warnings };
  await tx.query(`UPDATE project_assignment SET project_id = $2, employee_id = $3, facility_id = $4, role = $5, hours_per_week = $6, start_date = $7, end_date = $8, billable = $9, state = $10, note = $11, override_reason = $12 WHERE id = $1`,
    [id, next.projectId, next.employeeId, emp.facility_id, next.role, next.hoursPerWeek, next.startDate, next.endDate, next.billable, next.state, next.note, reason]);
  const moved = ['employeeId', 'projectId', 'startDate', 'endDate'].some((k) => k in changed);
  await audit(tx, actor, { action: moved ? 'staffing.assignment_moved' : 'staffing.assignment_edited', entityType: 'project_assignment', entityId: id, facilityId: emp.facility_id,
    data: { changed, conflicts: warnings.map((w) => w.weekStart), overrideReason: reason } });
  return { assignment: await getAssignment(tx, id), warnings };
}

export async function removeAssignment(tx: Tx, actor: Actor, id: string, reason?: string | null) {
  const cur = await one(tx, 'SELECT id, facility_id, removed_at FROM project_assignment WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw notFound('assignment');
  requireManage(actor, cur.facility_id);
  if (cur.removed_at) return;
  await tx.query('UPDATE project_assignment SET removed_at = now(), removed_by = $2 WHERE id = $1', [id, actor.userId]);
  await audit(tx, actor, { action: 'staffing.assignment_removed', entityType: 'project_assignment', entityId: id, facilityId: cur.facility_id, data: { reason: reason ?? null } });
}

export async function listAssignments(tx: Tx, actor: Actor, q: { employeeId?: string; projectId?: string; includePast?: boolean; includeRemoved?: boolean }) {
  const people = new Set((await visiblePeople(tx, actor)).map((p) => p.id));
  const rows = await many(tx, `${ASSIGNMENT_SQL} WHERE ($1::uuid IS NULL OR a.employee_id = $1) AND ($2::uuid IS NULL OR a.project_id = $2) AND ($3 OR a.end_date >= current_date) AND ($4 OR a.removed_at IS NULL)
    ORDER BY a.start_date, e.last_name`, [q.employeeId ?? null, q.projectId ?? null, !!q.includePast, !!q.includeRemoved]);
  return rows.filter((r) => people.has(r.employee_id));
}

export async function assignmentHistory(tx: Tx, actor: Actor, id: string) {
  const a = await getAssignment(tx, id);
  await personFor(tx, actor, a.employee_id).catch(() => { throw notFound('assignment'); });
  return auditHistory(tx, 'project_assignment', id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Working patterns, holidays, time off, tracking
// ---------------------------------------------------------------------------------------------------------------------
export async function savePattern(tx: Tx, actor: Actor, input: { employeeId: string; effectiveFrom: string; hours: number[]; note?: string | null }) {
  const emp = await employeeRow(tx, input.employeeId);
  requireManage(actor, emp.facility_id);
  if (input.hours.length !== 7 || input.hours.some((h) => h < 0 || h > 24)) throw invalid('a working pattern needs seven values between 0 and 24 hours (Monday first)');
  const r = await one(tx, `INSERT INTO work_pattern (tenant_id, facility_id, employee_id, effective_from, hours, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (employee_id, effective_from) DO UPDATE SET hours = EXCLUDED.hours, note = EXCLUDED.note, created_by = EXCLUDED.created_by RETURNING id`,
  [actor.tenantId, emp.facility_id, emp.id, input.effectiveFrom, input.hours, input.note ?? null, actor.userId]);
  await audit(tx, actor, { action: 'staffing.pattern_saved', entityType: 'employee', entityId: emp.id, facilityId: emp.facility_id, data: { from: input.effectiveFrom, hours: input.hours } });
  return r;
}
export async function deletePattern(tx: Tx, actor: Actor, id: string) {
  const p = await one(tx, 'SELECT id, facility_id, employee_id, effective_from::text AS effective_from FROM work_pattern WHERE id = $1', [id]);
  if (!p) throw notFound('working pattern');
  requireManage(actor, p.facility_id);
  await tx.query('DELETE FROM work_pattern WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'staffing.pattern_removed', entityType: 'employee', entityId: p.employee_id, facilityId: p.facility_id, data: { from: p.effective_from } });
}

export async function listHolidays(tx: Tx, actor: Actor, q: { year?: number }) {
  await visiblePeople(tx, actor); // any staffing permission
  const year = q.year ?? new Date().getUTCFullYear();
  return many(tx, `SELECT h.id, h.facility_id, f.code AS facility_code, h.holiday_date::text AS holiday_date, h.name, h.hours_off::float AS hours_off
    FROM company_holiday h LEFT JOIN facility f ON f.id = h.facility_id WHERE h.holiday_date BETWEEN $1 AND $2 ORDER BY h.holiday_date, f.code NULLS FIRST`, [`${year}-01-01`, `${year}-12-31`]);
}
export async function createHoliday(tx: Tx, actor: Actor, input: { date: string; name: string; facilityId?: string | null; hoursOff?: number | null }) {
  if (input.facilityId) requireManage(actor, input.facilityId); else if (!companyWide(actor)) throw forbidden('staffing.manage (company-wide)');
  if (await one(tx, `SELECT 1 FROM company_holiday WHERE holiday_date = $1 AND facility_id IS NOT DISTINCT FROM $2::uuid`, [input.date, input.facilityId ?? null])) throw conflict(`there is already a holiday on ${input.date} for that scope`);
  const r = await one(tx, `INSERT INTO company_holiday (tenant_id, facility_id, holiday_date, name, hours_off, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [actor.tenantId, input.facilityId ?? null, input.date, input.name.trim(), input.hoursOff ?? null, actor.userId]);
  await audit(tx, actor, { action: 'staffing.holiday_added', entityType: 'company_holiday', entityId: r.id, facilityId: input.facilityId ?? null, data: input });
  return r;
}
export async function deleteHoliday(tx: Tx, actor: Actor, id: string) {
  const h = await one(tx, 'SELECT id, facility_id, holiday_date::text AS d, name FROM company_holiday WHERE id = $1', [id]);
  if (!h) throw notFound('holiday');
  if (h.facility_id) requireManage(actor, h.facility_id); else if (!companyWide(actor)) throw forbidden('staffing.manage (company-wide)');
  await tx.query('DELETE FROM company_holiday WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'staffing.holiday_removed', entityType: 'company_holiday', entityId: id, facilityId: h.facility_id, data: { date: h.d, name: h.name } });
}

export interface TimeOffInput { employeeId?: string; fromDate: string; toDate: string; hoursPerDay?: number | null; kind?: 'vacation' | 'sick' | 'personal' | 'training' | 'other'; note?: string | null }
export async function requestTimeOff(tx: Tx, actor: Actor, input: TimeOffInput) {
  const employeeId = input.employeeId ?? actor.employeeId;
  if (!employeeId) throw invalid('your user is not linked to an employee record');
  if (input.toDate < input.fromDate) throw invalid('the last day is before the first day');
  const emp = await employeeRow(tx, employeeId);
  const mine = employeeId === actor.employeeId;
  if (mine) { if (!can(actor, 'staffing.view_own') && !mayManage(actor, emp.facility_id)) throw forbidden('staffing.view_own'); }
  else requireManage(actor, emp.facility_id);
  // A manager entering time off for someone else records it as approved (their decision, audited); a person's own request waits.
  const direct = !mine;
  const r = await one(tx, `INSERT INTO employee_time_off (tenant_id, facility_id, employee_id, from_date, to_date, hours_per_day, kind, status, note, requested_by, decided_by, decided_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
  [actor.tenantId, emp.facility_id, emp.id, input.fromDate, input.toDate, input.hoursPerDay ?? null, input.kind ?? 'vacation', direct ? 'approved' : 'requested', input.note ?? null, actor.userId, direct ? actor.userId : null, direct ? new Date() : null]);
  await audit(tx, actor, { action: direct ? 'staffing.time_off_entered' : 'staffing.time_off_requested', entityType: 'employee_time_off', entityId: r.id, facilityId: emp.facility_id, data: { employee: emp.name, ...input } });
  if (!direct) {
    await notify(tx, actor.tenantId, await usersWithPermission(tx, 'staffing.manage', emp.facility_id), { kind: 'staffing.time_off_requested', title: `${emp.name} asks for time off ${input.fromDate}${input.toDate !== input.fromDate ? ` to ${input.toDate}` : ''}`,
      link: '/staffing?tab=timeoff', subjectType: 'employee_time_off', subjectId: r.id }, actor.userId);
  }
  return getTimeOff(tx, r.id);
}
const TIME_OFF_SQL = `SELECT t.id, t.employee_id, e.first_name || ' ' || e.last_name AS employee_name, t.facility_id, t.from_date::text AS from_date, t.to_date::text AS to_date, t.hours_per_day::float AS hours_per_day,
    t.kind, t.status, t.note, t.decision_comment, t.decided_at, du.display_name AS decided_by_name, t.created_at
  FROM employee_time_off t JOIN employee e ON e.id = t.employee_id LEFT JOIN app_user du ON du.id = t.decided_by`;
async function getTimeOff(tx: Tx, id: string) {
  const r = await one(tx, `${TIME_OFF_SQL} WHERE t.id = $1`, [id]);
  if (!r) throw notFound('time off');
  return r;
}
export async function listTimeOff(tx: Tx, actor: Actor, q: { employeeId?: string; status?: string; from?: string; to?: string }) {
  const people = new Set((await visiblePeople(tx, actor)).map((p) => p.id));
  const rows = await many(tx, `${TIME_OFF_SQL} WHERE ($1::uuid IS NULL OR t.employee_id = $1) AND ($2::text IS NULL OR t.status = $2) AND ($3::date IS NULL OR t.to_date >= $3) AND ($4::date IS NULL OR t.from_date <= $4)
    ORDER BY t.from_date DESC LIMIT 500`, [q.employeeId ?? null, q.status ?? null, q.from ?? null, q.to ?? null]);
  const own = rows.filter((r) => people.has(r.employee_id)).map((r) => ({ ...r, source: 'request' as const }));
  // Field-service time off (technicians) counts as approved full days off; shown read-only here.
  const tech = (await many(tx, `SELECT t.id, t.employee_id, e.first_name || ' ' || e.last_name AS employee_name, t.from_date::text AS from_date, t.to_date::text AS to_date, t.reason FROM technician_time_off t JOIN employee e ON e.id = t.employee_id
    WHERE ($1::uuid IS NULL OR t.employee_id = $1) AND ($2::date IS NULL OR t.to_date >= $2) AND ($3::date IS NULL OR t.from_date <= $3) ORDER BY t.from_date DESC LIMIT 200`, [q.employeeId ?? null, q.from ?? null, q.to ?? null]))
    .filter((r) => people.has(r.employee_id) && (!q.status || q.status === 'approved'))
    .map((r) => ({ id: r.id, employee_id: r.employee_id, employee_name: r.employee_name, facility_id: null, from_date: r.from_date, to_date: r.to_date, hours_per_day: null, kind: 'field service', status: 'approved', note: r.reason, decision_comment: null, decided_at: null, decided_by_name: null, created_at: null, source: 'field_service' as const }));
  return [...own, ...tech];
}
export async function decideTimeOff(tx: Tx, actor: Actor, id: string, input: { decision: 'approve' | 'reject'; comment?: string | null }) {
  const t = await one(tx, 'SELECT id, employee_id, facility_id, status, requested_by FROM employee_time_off WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('time off');
  requireManage(actor, t.facility_id);
  if (t.employee_id === actor.employeeId || t.requested_by === actor.userId) throw forbidden('another manager must decide your own time off');
  if (t.status !== 'requested') throw conflict(`this request is already ${t.status}`);
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  await tx.query('UPDATE employee_time_off SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 WHERE id = $1', [id, status, actor.userId, input.comment ?? null]);
  await audit(tx, actor, { action: `staffing.time_off_${status}`, entityType: 'employee_time_off', entityId: id, facilityId: t.facility_id, data: { comment: input.comment ?? null } });
  const u = await one(tx, 'SELECT id FROM app_user WHERE employee_id = $1 AND status = \'active\'', [t.employee_id]);
  if (u) await notify(tx, actor.tenantId, [u.id], { kind: 'staffing.time_off_decided', title: `Your time off request was ${status}`, body: input.comment ?? undefined, link: '/staffing?tab=timeoff', subjectType: 'employee_time_off', subjectId: id }, actor.userId);
  return getTimeOff(tx, id);
}
export async function cancelTimeOff(tx: Tx, actor: Actor, id: string) {
  const t = await one(tx, 'SELECT id, employee_id, facility_id, status FROM employee_time_off WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('time off');
  if (t.employee_id !== actor.employeeId) requireManage(actor, t.facility_id);
  if (!['requested', 'approved'].includes(t.status)) throw conflict(`this request is already ${t.status}`);
  await tx.query(`UPDATE employee_time_off SET status = 'cancelled' WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'staffing.time_off_cancelled', entityType: 'employee_time_off', entityId: id, facilityId: t.facility_id, data: { was: t.status } });
  return getTimeOff(tx, id);
}

export async function setTracking(tx: Tx, actor: Actor, employeeId: string, input: { staffed: boolean; reason?: string | null }) {
  const emp = await employeeRow(tx, employeeId);
  requireManage(actor, emp.facility_id);
  if (input.staffed) await tx.query('DELETE FROM staffing_exclusion WHERE employee_id = $1', [employeeId]);
  else await tx.query(`INSERT INTO staffing_exclusion (employee_id, tenant_id, facility_id, reason, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (employee_id) DO UPDATE SET reason = EXCLUDED.reason`, [employeeId, actor.tenantId, emp.facility_id, input.reason ?? null, actor.userId]);
  await audit(tx, actor, { action: input.staffed ? 'staffing.tracking_on' : 'staffing.tracking_off', entityType: 'employee', entityId: employeeId, facilityId: emp.facility_id, data: { reason: input.reason ?? null } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------------------------------
export async function loadTargets(tx: Tx): Promise<TargetRow[]> {
  return (await many(tx, 'SELECT kind, employee_id, job_title, target_pct::float AS pct FROM utilization_target')).map((r) => ({ kind: r.kind, employeeId: r.employee_id, jobTitle: r.job_title, targetPct: r.pct }));
}
export async function listTargets(tx: Tx, actor: Actor) {
  await visiblePeople(tx, actor);
  const settings = await getSettings(tx);
  const rows = await many(tx, `SELECT t.id, t.kind, t.employee_id, e.first_name || ' ' || e.last_name AS employee_name, t.job_title, t.target_pct::float AS target_pct, t.updated_at
    FROM utilization_target t LEFT JOIN employee e ON e.id = t.employee_id ORDER BY t.kind, t.job_title, e.last_name`);
  return { company: settings.targetPct, targets: rows };
}
export async function saveTarget(tx: Tx, actor: Actor, input: { employeeId?: string; jobTitle?: string; targetPct: number }) {
  if (!input.employeeId === !input.jobTitle) throw invalid('name either a person or a job title');
  if (input.employeeId) {
    const emp = await employeeRow(tx, input.employeeId);
    requireManage(actor, emp.facility_id);
    const r = await one(tx, `INSERT INTO utilization_target (tenant_id, kind, employee_id, target_pct, updated_by) VALUES ($1, 'employee', $2, $3, $4)
      ON CONFLICT (employee_id) WHERE kind = 'employee' DO UPDATE SET target_pct = EXCLUDED.target_pct, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING id`, [actor.tenantId, emp.id, input.targetPct, actor.userId]);
    await audit(tx, actor, { action: 'staffing.target_saved', entityType: 'utilization_target', entityId: r.id, facilityId: emp.facility_id, data: { employee: emp.name, targetPct: input.targetPct } });
    return r;
  }
  if (!companyWide(actor)) throw forbidden('staffing.manage (company-wide)');
  const title = input.jobTitle!.trim();
  const r = await one(tx, `INSERT INTO utilization_target (tenant_id, kind, job_title, target_pct, updated_by) VALUES ($1, 'job_title', $2, $3, $4)
    ON CONFLICT (tenant_id, lower(job_title)) WHERE kind = 'job_title' DO UPDATE SET target_pct = EXCLUDED.target_pct, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING id`, [actor.tenantId, title, input.targetPct, actor.userId]);
  await audit(tx, actor, { action: 'staffing.target_saved', entityType: 'utilization_target', entityId: r.id, data: { jobTitle: title, targetPct: input.targetPct } });
  return r;
}
export async function deleteTarget(tx: Tx, actor: Actor, id: string) {
  const t = await one(tx, `SELECT t.id, t.kind, e.facility_id FROM utilization_target t LEFT JOIN employee e ON e.id = t.employee_id WHERE t.id = $1`, [id]);
  if (!t) throw notFound('target');
  if (t.kind === 'employee') requireManage(actor, t.facility_id); else if (!companyWide(actor)) throw forbidden('staffing.manage (company-wide)');
  await tx.query('DELETE FROM utilization_target WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'staffing.target_removed', entityType: 'utilization_target', entityId: id, data: {} });
}

// ---------------------------------------------------------------------------------------------------------------------
// Utilization
// ---------------------------------------------------------------------------------------------------------------------
export interface UtilRow {
  id: string; name: string; employee_number: string; job_title: string | null; department: string | null; manager: string | null; facility_code: string;
  scheduled: number; holiday: number; timeOff: number; available: number; billable: number; otherWorked: number; pendingBillable: number;
  approvedSheets: number; hasData: boolean; utilization: number | null; target: number; targetSource: 'person' | 'role' | 'company'; gap: number | null;
}
/**
 * Billable hours over available hours per person for a period. Only whole days that have passed count (the period is cut at
 * yesterday). Billable hours come from approved or exported timesheets; hours on submitted timesheets are shown as pending.
 * A person with no approved timesheet in the period has no utilization (not 0%).
 */
export async function utilizationFor(tx: Tx, people: Person[], p: { from: string; to: string }, settings: StaffingSettings, targets: TargetRow[], today = isoToday()): Promise<UtilRow[]> {
  const end = p.to < today ? p.to : addDays(today, -1);
  const live = end >= p.from;
  const cals = live ? await loadCalendars(tx, people, p.from, end, settings) : new Map<string, PersonCalendar>();
  const time = live ? await many(tx, `SELECT t.employee_id,
        coalesce(sum(x.hours) FILTER (WHERE x.billable AND t.status IN ('approved', 'exported')), 0)::float AS billable,
        coalesce(sum(x.hours) FILTER (WHERE NOT x.billable AND t.status IN ('approved', 'exported') AND c.kind = 'worked'), 0)::float AS other_worked,
        coalesce(sum(x.hours) FILTER (WHERE x.billable AND t.status = 'submitted'), 0)::float AS pending,
        count(DISTINCT t.id) FILTER (WHERE t.status IN ('approved', 'exported'))::int AS sheets
      FROM time_entry x JOIN timesheet t ON t.id = x.timesheet_id LEFT JOIN earning_code c ON c.code = x.earning_code AND c.tenant_id = x.tenant_id
      WHERE t.employee_id = ANY ($1) AND x.work_date BETWEEN $2 AND $3 GROUP BY t.employee_id`, [people.map((x) => x.id), p.from, end]) : [];
  const byEmp = new Map(time.map((r) => [r.employee_id as string, r]));
  return people.map((person) => {
    const h = live ? rangeHours(cals.get(person.id)!, p.from, end) : { scheduled: 0, holiday: 0, timeOff: 0, available: 0 };
    const t = byEmp.get(person.id);
    const billable = round2(t?.billable ?? 0);
    const util = utilizationOf(billable, h.available);
    const hasData = (t?.sheets ?? 0) > 0;
    const target = resolveTarget({ id: person.id, jobTitle: person.job_title }, targets, settings.targetPct);
    const utilization = hasData ? util : null;
    return { id: person.id, name: person.name, employee_number: person.employee_number, job_title: person.job_title, department: person.department, manager: person.manager, facility_code: person.facility_code,
      ...h, billable, otherWorked: round2(t?.other_worked ?? 0), pendingBillable: round2(t?.pending ?? 0), approvedSheets: t?.sheets ?? 0, hasData, utilization,
      target: target.pct, targetSource: target.source, gap: utilization == null ? null : utilization - target.pct / 100 };
  });
}

export type GroupBy = 'person' | 'department' | 'manager' | 'site' | 'role';
export interface UtilGroup {
  key: string; label: string; people: number; peopleWithData: number; available: number; billable: number; pendingBillable: number; otherWorked: number;
  utilization: number | null; target: number | null; gap: number | null;
}
/** Team figures use only people who have approved time in the period, so someone who has not had a timesheet approved does not drag a team down. */
export function groupUtilization(rows: UtilRow[], by: GroupBy): UtilGroup[] {
  const keyOf = (r: UtilRow): [string, string] => {
    switch (by) {
      case 'department': return [r.department ?? '(no department)', r.department ?? '(no department)'];
      case 'manager': return [r.manager ?? '(no manager)', r.manager ?? '(no manager)'];
      case 'site': return [r.facility_code, r.facility_code];
      case 'role': return [(r.job_title ?? '(no job title)').toLowerCase(), r.job_title ?? '(no job title)'];
      default: return [r.id, r.name];
    }
  };
  const groups = new Map<string, UtilGroup & { tw: number }>();
  for (const r of rows) {
    const [key, label] = keyOf(r);
    const g = groups.get(key) ?? { key, label, people: 0, peopleWithData: 0, available: 0, billable: 0, pendingBillable: 0, otherWorked: 0, utilization: null, target: null, gap: null, tw: 0 };
    g.people++;
    g.pendingBillable += r.pendingBillable;
    if (r.hasData) {
      g.peopleWithData++; g.available += r.available; g.billable += r.billable; g.otherWorked += r.otherWorked;
      g.target = (g.target ?? 0) + r.target * r.available; g.tw += r.available;
    }
    groups.set(key, g);
  }
  return [...groups.values()].map(({ tw, ...g }) => {
    const util = g.peopleWithData ? utilizationOf(g.billable, g.available) : null;
    const target = g.peopleWithData && tw > 0 ? g.target! / tw : null;
    return { ...g, available: round2(g.available), billable: round2(g.billable), pendingBillable: round2(g.pendingBillable), otherWorked: round2(g.otherWorked), utilization: util, target, gap: util != null && target != null ? util - target / 100 : null };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export async function utilizationView(tx: Tx, actor: Actor, q: { from?: string; to?: string; by?: GroupBy; facilityId?: string }) {
  const today = isoToday();
  const to = q.to ?? today;
  const from = q.from ?? `${to.slice(0, 7)}-01`;
  if (to < from) throw invalid('the end of the period is before its start');
  const settings = await getSettings(tx);
  const targets = await loadTargets(tx);
  let people = (await visiblePeople(tx, actor)).filter((p) => !p.excluded);
  if (q.facilityId) people = people.filter((p) => p.facility_id === q.facilityId);
  const rows = await utilizationFor(tx, people, { from, to }, settings, targets, today);
  const groups = groupUtilization(rows, q.by ?? 'person');
  const total = groupUtilization(rows.map((r) => ({ ...r, facility_code: 'all' })), 'site')[0] ?? null;
  return { from, to, throughDate: to < today ? to : addDays(today, -1), by: q.by ?? 'person', company: settings.targetPct, rows, groups, total, anyData: rows.some((r) => r.hasData) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bench, over-allocation and the forecast
// ---------------------------------------------------------------------------------------------------------------------
export async function benchAndOver(tx: Tx, people: Person[], from: string, weeks: number, settings: StaffingSettings) {
  const staffed = people.filter((p) => !p.excluded);
  const grid = await gridFor(tx, staffed, from, weeks, settings);
  const bench = grid.filter((g) => g.available > 0).map((g) => ({ person: g.person, available: g.available, booked: g.booked, free: g.free, bookedPct: g.booked / g.available }))
    .filter((g) => g.bookedPct < settings.benchPct / 100).sort((a, b) => a.bookedPct - b.bookedPct);
  const over = grid.flatMap((g) => g.cells.filter((c) => c.status === 'over').map((c) => ({ person: g.person, ...c })));
  return { grid, bench, over };
}

export async function forecast(tx: Tx, people: Person[], from: string, weeks: number, settings: StaffingSettings) {
  const staffed = people.filter((p) => !p.excluded);
  const grid = await gridFor(tx, staffed, from, weeks, settings);
  return weeksFrom(weekStartOf(from), weeks).map((w, i) => {
    const cells = grid.map((g) => g.cells[i]!);
    const capacity = round2(cells.reduce((s, c) => s + c.available, 0));
    const confirmed = round2(cells.reduce((s, c) => s + c.confirmed, 0));
    const tentative = round2(cells.reduce((s, c) => s + c.tentative, 0));
    const booked = round2(confirmed + tentative);
    return { weekStart: w, people: cells.filter((c) => c.available > 0).length, capacity, confirmed, tentative, booked, free: round2(cells.reduce((s, c) => s + c.free, 0)), over: round2(cells.reduce((s, c) => s + c.over, 0)),
      overPeople: cells.filter((c) => c.status === 'over').length, plannedUtilization: capacity > 0 ? booked / capacity : null };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Daily reminders (called by the sweep, which has no actor)
// ---------------------------------------------------------------------------------------------------------------------
export async function staffingReminders(tx: Tx, tenantId: string, today: string, on: { overbooked: boolean; unbooked: boolean; low: boolean }, period: (key: string) => string) {
  const counts: Record<string, number> = {};
  const add = (k: string, n: number) => { counts[k] = (counts[k] ?? 0) + n; };
  const settings = await getSettings(tx);
  const people = (await allPeople(tx)).filter((p) => !p.excluded);
  if (!people.length) return counts;
  const week = weekStartOf(today);
  const sites = [...new Map(people.map((p) => [p.facility_id, p.facility_code])).entries()];
  if (on.overbooked || on.unbooked) {
    const next = addDays(week, 7);
    const grid = await gridFor(tx, people, next, 2, settings);
    for (const [fid, code] of sites) {
      const mine = grid.filter((g) => g.person.facility_id === fid);
      const managers = await usersWithPermission(tx, 'staffing.manage', fid);
      if (on.overbooked) {
        const over = mine.filter((g) => g.cells[0]!.status === 'over');
        if (over.length) add('staffing_overbooked', await notify(tx, tenantId, managers, { kind: 'reminder.staffing_overbooked',
          title: `${code}: ${over.length} ${over.length === 1 ? 'person is' : 'people are'} booked over capacity the week of ${next}`,
          body: over.slice(0, 8).map((g) => `${g.person.name} (${g.cells[0]!.booked} h booked, ${g.cells[0]!.available} h available)`).join('\n'), link: `/staffing?from=${next}`,
          dedupeKey: `staffing-over:${fid}:${next}:${period('staffing_overbooked')}` }));
      }
      if (on.unbooked) {
        const idle = mine.filter((g) => g.cells.every((c) => c.booked <= 0) && g.cells.some((c) => c.available > 0));
        if (idle.length) add('staffing_unbooked', await notify(tx, tenantId, managers, { kind: 'reminder.staffing_unbooked',
          title: `${code}: ${idle.length} ${idle.length === 1 ? 'person has' : 'people have'} no booking in the next two weeks`,
          body: idle.slice(0, 10).map((g) => `${g.person.name} (${g.available} h free)`).join('\n'), link: `/staffing?from=${next}`,
          dedupeKey: `staffing-unbooked:${fid}:${next}:${period('staffing_unbooked')}` }));
      }
    }
  }
  // Month end: on the last day of the month, people below their utilization target for the month so far (once per month).
  if (on.low && addDays(today, 1).slice(0, 7) !== today.slice(0, 7)) {
    const month = today.slice(0, 7);
    const rows = await utilizationFor(tx, people, { from: `${month}-01`, to: today }, settings, await loadTargets(tx), today);
    for (const [fid, code] of sites) {
      const low = rows.filter((r) => r.hasData && r.utilization != null && r.utilization < r.target / 100 && people.find((p) => p.id === r.id)?.facility_id === fid);
      if (!low.length) continue;
      add('utilization_low', await notify(tx, tenantId, await usersWithPermission(tx, 'staffing.manage', fid), { kind: 'reminder.utilization_low',
        title: `${code}: ${low.length} ${low.length === 1 ? 'person is' : 'people are'} below the utilization target for ${month}`,
        body: low.slice(0, 10).map((r) => `${r.name}: ${Math.round(r.utilization! * 100)}% against ${r.target}%`).join('\n'), link: '/staffing?tab=utilization',
        dedupeKey: `utilization-low:${fid}:${month}` }));
    }
  }
  return counts;
}
