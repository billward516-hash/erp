import { notify, usersForEmployees } from '../../platform/notify/notify.js';
import type { Actor } from '../../platform/auth/actor.js';
import { can, facilitiesWith, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { toCsv } from '../reporting/render/csv.js';
import { projectOptions, resolveBooking } from '../projects/booking.js';

const SUBJECT = 'timesheet';
/** Weekly worked hours above which the timesheet is flagged for an overtime review (not calculated: jurisdiction rules are Category 2). */
export const OVERTIME_REVIEW_HOURS = 40;
const LONG_DAY_HOURS = 12;
const round2 = (n: number) => Math.round(n * 100) / 100;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Monday of the ISO week containing the date. */
export function weekStartOf(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

async function employeeOf(tx: Tx, id: string) {
  const e = await one(tx, 'SELECT id, facility_id, employee_number, first_name, last_name, status FROM employee WHERE id = $1', [id]);
  if (!e) throw notFound('employee');
  if (!e.facility_id) throw invalid('the employee has no home facility; set one before recording time');
  return e;
}
const isOwn = (actor: Actor, employeeId: string) => actor.employeeId === employeeId;
const mayView = (actor: Actor, ts: { employee_id: string; facility_id: string }) =>
  isOwn(actor, ts.employee_id) || can(actor, 'time.view_all', ts.facility_id) || can(actor, 'time.approve', ts.facility_id);
/** Employees edit their own sheet; approvers may also prepare one on someone's behalf (e.g. from a paper timecard). */
const mayEdit = (actor: Actor, ts: { employee_id: string; facility_id: string }) => isOwn(actor, ts.employee_id) || can(actor, 'time.approve', ts.facility_id);

export async function getOrCreateTimesheet(tx: Tx, actor: Actor, input: { employeeId?: string; weekStart: string }) {
  const employeeId = input.employeeId ?? actor.employeeId;
  if (!employeeId) throw invalid('your user is not linked to an employee record');
  const week = weekStartOf(input.weekStart);
  const existing = await one(tx, 'SELECT * FROM timesheet WHERE employee_id = $1 AND week_start = $2', [employeeId, week]);
  if (existing) {
    if (!mayView(actor, existing)) throw forbidden('timesheet');
    return existing;
  }
  const e = await employeeOf(tx, employeeId);
  if (!mayEdit(actor, { employee_id: e.id, facility_id: e.facility_id })) throw forbidden('timesheet');
  return one(tx, `INSERT INTO timesheet (tenant_id, facility_id, employee_id, week_start) VALUES ($1, $2, $3, $4)
    ON CONFLICT (employee_id, week_start) DO UPDATE SET week_start = EXCLUDED.week_start RETURNING *`, [actor.tenantId, e.facility_id, e.id, week]);
}

async function lockSheet(tx: Tx, id: string) {
  const ts = await one(tx, 'SELECT * FROM timesheet WHERE id = $1 FOR UPDATE', [id]);
  if (!ts) throw notFound('timesheet');
  return ts;
}

/** Work-order labor for the employee in the week (live source while the sheet is a draft). */
async function workOrderLabor(tx: Tx, employeeId: string, week: string) {
  return many(tx, `SELECT l.id, l.work_date, l.hours::float AS hours, l.work_order_id, w.number AS work_order_number, w.title
    FROM work_order_labor l JOIN work_order w ON w.id = l.work_order_id
    WHERE l.employee_id = $1 AND l.work_date BETWEEN $2 AND $3 ORDER BY l.work_date, w.number`, [employeeId, week, addDays(week, 6)]);
}

export async function getTimesheet(tx: Tx, actor: Actor, id: string) {
  const ts = await one(tx, `SELECT t.*, e.employee_number, e.first_name || ' ' || e.last_name AS employee_name, f.code AS facility_code,
      su.display_name AS submitted_by_name, du.display_name AS decided_by_name
    FROM timesheet t JOIN employee e ON e.id = t.employee_id JOIN facility f ON f.id = t.facility_id
    LEFT JOIN app_user su ON su.id = t.submitted_by LEFT JOIN app_user du ON du.id = t.decided_by WHERE t.id = $1`, [id]);
  if (!ts) throw notFound('timesheet');
  if (!mayView(actor, ts)) throw forbidden('timesheet');
  const codes = await many(tx, 'SELECT code, label, kind FROM earning_code WHERE active ORDER BY code');
  const kind = new Map(codes.map((c) => [c.code as string, c.kind as string]));
  let entries = await many(tx, `SELECT x.id, x.work_date, x.earning_code, x.hours::float AS hours, x.source, x.work_order_id, w.number AS work_order_number, x.note,
      x.project_id, p.number AS project_number, p.name AS project_name, x.project_task_id, pt.name AS project_task_name, x.billable
    FROM time_entry x LEFT JOIN work_order w ON w.id = x.work_order_id LEFT JOIN project p ON p.id = x.project_id LEFT JOIN project_task pt ON pt.id = x.project_task_id
    WHERE x.timesheet_id = $1 ORDER BY x.work_date, x.source DESC, x.created_at`, [id]);
  // Drafts show work-order labor live; once submitted, the copied entries are what counts.
  if (['draft', 'rejected'].includes(ts.status)) {
    const live = await workOrderLabor(tx, ts.employee_id, ts.week_start);
    entries = [...entries.filter((e) => e.source !== 'work_order'),
      ...live.map((l) => ({ id: null, work_date: l.work_date, earning_code: 'REG', hours: l.hours, source: 'work_order', work_order_id: l.work_order_id,
        work_order_number: l.work_order_number, note: l.title, project_id: null, project_number: null, project_name: null, project_task_id: null, project_task_name: null, billable: false }))].sort((a, b) => (a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : 0));
  }
  const days = Array.from({ length: 7 }, (_, i) => addDays(ts.week_start, i));
  const byDay = days.map((d) => ({ date: d, hours: round2(entries.filter((e) => e.work_date === d).reduce((s, e) => s + e.hours, 0)) }));
  const byCode = codes.map((c) => ({ code: c.code, label: c.label, hours: round2(entries.filter((e) => e.earning_code === c.code).reduce((s, e) => s + e.hours, 0)) })).filter((c) => c.hours);
  const worked = round2(entries.filter((e) => kind.get(e.earning_code) === 'worked').reduce((s, e) => s + e.hours, 0));
  const total = round2(entries.reduce((s, e) => s + e.hours, 0));
  const workOrderHours = round2(entries.filter((e) => e.source === 'work_order').reduce((s, e) => s + e.hours, 0));
  const projectHours = round2(entries.filter((e) => e.source === 'project').reduce((s, e) => s + e.hours, 0));
  const warnings: string[] = [];
  if (worked > OVERTIME_REVIEW_HOURS && !entries.some((e) => e.earning_code === 'OT')) {
    warnings.push(`${worked} worked hours this week, over ${OVERTIME_REVIEW_HOURS}: split overtime per your pay policy before approving (not calculated here).`);
  }
  for (const d of byDay) if (d.hours > LONG_DAY_HOURS) warnings.push(`${d.date}: ${d.hours} hours in one day.`);
  return { ...ts, entries, days: byDay, byCode, worked, total, workOrderHours, projectHours, warnings, codes };
}

/** Active projects the timesheet's employee may book to (their team projects and those open to all staff), with tasks. */
export async function timesheetProjectOptions(tx: Tx, actor: Actor, timesheetId: string) {
  const ts = await one(tx, 'SELECT employee_id, facility_id FROM timesheet WHERE id = $1', [timesheetId]);
  if (!ts) throw notFound('timesheet');
  if (!mayView(actor, ts)) throw forbidden('timesheet');
  return projectOptions(tx, actor, ts.employee_id);
}

/** A manual entry may name a project (and task): then it is a project entry and carries a billable flag. */
export async function addEntry(tx: Tx, actor: Actor, timesheetId: string,
  input: { workDate: string; earningCode: string; hours: number; note?: string | null; projectId?: string | null; taskId?: string | null; billable?: boolean | null }) {
  const ts = await lockSheet(tx, timesheetId);
  if (!mayEdit(actor, ts)) throw forbidden('timesheet');
  if (!['draft', 'rejected'].includes(ts.status)) throw conflict(`timesheet is ${ts.status}`);
  if (input.workDate < ts.week_start || input.workDate > addDays(ts.week_start, 6)) throw invalid('the date is outside this week');
  if (!(await one(tx, 'SELECT 1 FROM earning_code WHERE code = $1 AND active', [input.earningCode]))) throw invalid(`unknown earning code ${input.earningCode}`);
  if (!(input.hours > 0 && input.hours <= 24)) throw invalid('hours must be between 0 and 24');
  if (!input.projectId && (input.taskId || input.billable)) throw invalid('choose the project these hours belong to');
  // Hours on a project are worked hours, never leave.
  if (input.projectId && (await one(tx, `SELECT kind FROM earning_code WHERE code = $1`, [input.earningCode]))?.kind !== 'worked') throw invalid('hours on a project must be worked time (e.g. REG), not leave');
  const booking = input.projectId ? await resolveBooking(tx, actor, { employeeId: ts.employee_id, projectId: input.projectId, taskId: input.taskId, billable: input.billable }) : null;
  const e = await one(tx, `INSERT INTO time_entry (tenant_id, timesheet_id, work_date, earning_code, hours, source, note, created_by, project_id, project_task_id, billable)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
  [actor.tenantId, timesheetId, input.workDate, input.earningCode, input.hours, booking ? 'project' : 'manual', input.note ?? null, actor.userId, booking?.projectId ?? null, booking?.taskId ?? null, booking?.billable ?? false]);
  await audit(tx, actor, { action: 'time.entry_added', entityType: SUBJECT, entityId: timesheetId, facilityId: ts.facility_id,
    data: { ...input, ...(booking ? { projectId: booking.projectId, taskId: booking.taskId, billable: booking.billable } : {}) } });
  return e;
}

export async function removeEntry(tx: Tx, actor: Actor, entryId: string) {
  const e = await one(tx, 'SELECT timesheet_id, source FROM time_entry WHERE id = $1', [entryId]);
  if (!e) throw notFound('time entry');
  const ts = await lockSheet(tx, e.timesheet_id);
  if (!mayEdit(actor, ts)) throw forbidden('timesheet');
  if (!['draft', 'rejected'].includes(ts.status)) throw conflict(`timesheet is ${ts.status}`);
  if (e.source === 'work_order') throw invalid('work-order hours are corrected on the work order');
  await tx.query('DELETE FROM time_entry WHERE id = $1', [entryId]);
  await audit(tx, actor, { action: 'time.entry_removed', entityType: SUBJECT, entityId: ts.id, facilityId: ts.facility_id, data: { entryId } });
}

/** Submits the week: work-order labor is copied in (from then on it is frozen for this week). */
export async function submitTimesheet(tx: Tx, actor: Actor, id: string) {
  const ts = await lockSheet(tx, id);
  if (!mayEdit(actor, ts)) throw forbidden('timesheet');
  if (!['draft', 'rejected'].includes(ts.status)) throw conflict(`timesheet is ${ts.status}`);
  await tx.query(`DELETE FROM time_entry WHERE timesheet_id = $1 AND source = 'work_order'`, [id]);
  for (const l of await workOrderLabor(tx, ts.employee_id, ts.week_start)) {
    await tx.query(`INSERT INTO time_entry (tenant_id, timesheet_id, work_date, earning_code, hours, source, work_order_labor_id, work_order_id, note, created_by)
      VALUES ($1, $2, $3, 'REG', $4, 'work_order', $5, $6, $7, $8)`, [actor.tenantId, id, l.work_date, l.hours, l.id, l.work_order_id, `${l.work_order_number} ${l.title}`, actor.userId]);
  }
  const total = await one(tx, 'SELECT coalesce(sum(hours), 0)::float AS h FROM time_entry WHERE timesheet_id = $1', [id]);
  if (!total.h) throw invalid('the timesheet has no hours');
  await tx.query(`UPDATE timesheet SET status = 'submitted', submitted_by = $2, submitted_at = now(), decided_by = NULL, decided_at = NULL, decision_comment = NULL WHERE id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'time.submitted', entityType: SUBJECT, entityId: id, facilityId: ts.facility_id, data: { hours: total.h, onBehalf: !isOwn(actor, ts.employee_id) } });
  return { hours: total.h as number };
}

/** Supervisor decision. Never on one's own timesheet; a rejection says what to fix. */
export async function decideTimesheet(tx: Tx, actor: Actor, id: string, input: { decision: 'approve' | 'reject'; comment?: string | null }) {
  const ts = await lockSheet(tx, id);
  requirePermission(actor, 'time.approve', ts.facility_id);
  if (isOwn(actor, ts.employee_id)) throw invalid('you cannot approve your own timesheet');
  if (ts.submitted_by === actor.userId && input.decision === 'approve') throw invalid('you entered this timesheet on the employee\'s behalf; another approver must approve it');
  if (ts.status !== 'submitted') throw conflict(`timesheet is ${ts.status}`);
  if (input.decision === 'reject' && !input.comment?.trim()) throw invalid('say what needs fixing');
  await tx.query(`UPDATE timesheet SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 WHERE id = $1`,
    [id, input.decision === 'approve' ? 'approved' : 'rejected', actor.userId, input.comment ?? null]);
  await audit(tx, actor, { action: `time.${input.decision === 'approve' ? 'approved' : 'rejected'}`, entityType: SUBJECT, entityId: id, facilityId: ts.facility_id, data: { comment: input.comment ?? null } });
  if (input.decision === 'reject') {
    const user = (await usersForEmployees(tx, [ts.employee_id])).get(ts.employee_id);
    await notify(tx, actor.tenantId, [user], { kind: 'time.sent_back', title: `Timesheet for the week of ${ts.week_start} was sent back`, body: input.comment ?? null,
      link: '/time', subjectType: SUBJECT, subjectId: id, dedupeKey: `time-sent-back:${id}:${Date.now()}` }, actor.userId);
  }
}

/** An approver can reopen an approved week that has not gone to payroll yet. */
export async function reopenTimesheet(tx: Tx, actor: Actor, id: string, reason: string) {
  const ts = await lockSheet(tx, id);
  requirePermission(actor, 'time.approve', ts.facility_id);
  if (ts.status !== 'approved') throw conflict(ts.status === 'exported' ? 'this week is already with payroll; correct it there' : `timesheet is ${ts.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE timesheet SET status = 'rejected', decision_comment = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [id, `Reopened: ${reason}`, actor.userId]);
  await audit(tx, actor, { action: 'time.reopened', entityType: SUBJECT, entityId: id, facilityId: ts.facility_id, data: { reason } });
}

/** Called before work-order labor is recorded: a submitted or approved week is frozen. */
export async function assertWeekOpen(tx: Tx, employeeId: string, workDate: string) {
  const ts = await one(tx, `SELECT status FROM timesheet WHERE employee_id = $1 AND week_start = $2`, [employeeId, weekStartOf(workDate)]);
  if (ts && ['submitted', 'approved', 'exported'].includes(ts.status)) {
    throw conflict(`the timesheet for the week of ${weekStartOf(workDate)} is ${ts.status}; ask a supervisor to reopen it before adding hours`);
  }
}

/** Team view for approvers: every active employee at their facilities with the week's status and hours. */
export async function teamWeek(tx: Tx, actor: Actor, weekStart: string) {
  const week = weekStartOf(weekStart);
  const scope = facilitiesWith(actor, 'time.approve');
  const all = facilitiesWith(actor, 'time.view_all');
  if (!scope.all && !scope.ids.length && !all.all && !all.ids.length) throw forbidden('time.approve');
  const rows = await many(tx, `SELECT e.id AS employee_id, e.employee_number, e.first_name || ' ' || e.last_name AS name, e.job_title, e.facility_id, f.code AS facility_code,
      t.id, t.status, t.submitted_at,
      coalesce((SELECT sum(x.hours) FROM time_entry x WHERE x.timesheet_id = t.id), 0)::float AS entered,
      coalesce((SELECT sum(x.hours) FROM time_entry x WHERE x.timesheet_id = t.id AND x.source <> 'work_order'), 0)::float AS manual,
      coalesce((SELECT sum(l.hours) FROM work_order_labor l WHERE l.employee_id = e.id AND l.work_date BETWEEN $1 AND $2), 0)::float AS wo_hours
    FROM employee e JOIN facility f ON f.id = e.facility_id LEFT JOIN timesheet t ON t.employee_id = e.id AND t.week_start = $1
    WHERE e.status = 'active' ORDER BY f.code, e.last_name, e.first_name`, [week, addDays(week, 6)]);
  return rows.filter((r) => [scope, all].some((s) => s.all || s.ids.includes(r.facility_id)) && r.employee_id !== actor.employeeId)
    // Submitted weeks count what was submitted; drafts (and weeks sent back) count manual time plus live work-order hours.
    .map((r) => ({ ...r, status: r.status ?? 'not_started', hours: r.status && !['draft', 'rejected'].includes(r.status) ? r.entered : round2(r.manual + r.wo_hours) }));
}

export async function myTimesheets(tx: Tx, actor: Actor) {
  if (!actor.employeeId) return [];
  return many(tx, `SELECT t.id, t.week_start, t.status, t.decision_comment, coalesce((SELECT sum(x.hours) FROM time_entry x WHERE x.timesheet_id = t.id), 0)::float AS hours
    FROM timesheet t WHERE t.employee_id = $1 ORDER BY t.week_start DESC LIMIT 26`, [actor.employeeId]);
}

export async function listEarningCodes(tx: Tx) {
  return many(tx, 'SELECT code, label, kind, external_code, active FROM earning_code ORDER BY code');
}

export async function setEarningCode(tx: Tx, actor: Actor, code: string, input: { externalCode?: string | null; label?: string; active?: boolean }) {
  requirePermission(actor, 'time.export');
  const r = await one(tx, `UPDATE earning_code SET external_code = CASE WHEN $2 THEN $3 ELSE external_code END, label = coalesce($4, label), active = coalesce($5, active)
    WHERE code = $1 RETURNING *`, [code, input.externalCode !== undefined, input.externalCode ?? null, input.label ?? null, input.active ?? null]);
  if (!r) throw notFound('earning code');
  await audit(tx, actor, { action: 'time.earning_code_set', entityType: 'earning_code', entityId: actor.tenantId, data: { code, ...input } });
  return r;
}

// ---------------------------------------------------------------------------
// Payroll export
// ---------------------------------------------------------------------------

/** What an export for these weeks would contain, and what is not ready (not submitted or not approved). */
export async function payrollPreview(tx: Tx, actor: Actor, input: { from: string; to: string }) {
  requirePermission(actor, 'time.export');
  const from = weekStartOf(input.from); const to = weekStartOf(input.to);
  if (to < from) throw invalid('the end week is before the start week');
  const sheets = await many(tx, `SELECT t.id, t.week_start, t.status, e.employee_number, e.first_name || ' ' || e.last_name AS name, f.code AS facility_code,
      coalesce((SELECT sum(x.hours) FROM time_entry x WHERE x.timesheet_id = t.id), 0)::float AS hours
    FROM timesheet t JOIN employee e ON e.id = t.employee_id JOIN facility f ON f.id = t.facility_id
    WHERE t.week_start BETWEEN $1 AND $2 ORDER BY t.week_start, e.last_name`, [from, to]);
  const weeks: string[] = [];
  for (let w = from; w <= to; w = addDays(w, 7)) weeks.push(w);
  const active = await many(tx, `SELECT e.id, e.employee_number, e.first_name || ' ' || e.last_name AS name FROM employee e WHERE e.status = 'active' AND e.facility_id IS NOT NULL`);
  const missing = [];
  for (const w of weeks) for (const e of active) if (!sheets.some((s) => s.week_start === w && s.employee_number === e.employee_number)) missing.push({ week_start: w, employee_number: e.employee_number, name: e.name });
  return {
    from, to, weeks,
    ready: sheets.filter((s) => s.status === 'approved'),
    alreadyExported: sheets.filter((s) => s.status === 'exported'),
    notReady: [...sheets.filter((s) => ['draft', 'submitted', 'rejected'].includes(s.status)), ...missing.map((m) => ({ ...m, status: 'not_started', hours: 0 }))],
  };
}

/**
 * Writes the payroll file for approved weeks in the range and marks those timesheets exported (frozen;
 * later corrections are made in payroll). Other timesheets are left for a later export.
 */
export async function createPayrollExport(tx: Tx, actor: Actor, input: { from: string; to: string; layout?: 'summary' | 'daily' }) {
  const p = await payrollPreview(tx, actor, input);
  if (!p.ready.length) throw invalid('no approved timesheets in these weeks');
  const layout = input.layout ?? 'summary';
  const ids = p.ready.map((s) => s.id);
  // Lock the weeks being exported; if another export took any of them meanwhile, this one stops rather than paying
  // the same hours twice.
  const locked = await many(tx, `SELECT id FROM timesheet WHERE id = ANY ($1) AND status = 'approved' FOR UPDATE`, [ids]);
  if (locked.length !== ids.length) throw conflict('some of these timesheets were just exported or changed; refresh and export again');
  const rows = layout === 'summary'
    ? await many(tx, `SELECT e.employee_number, e.last_name, e.first_name, f.code AS facility, t.week_start, coalesce(c.external_code, c.code) AS code, sum(x.hours)::float AS hours
        FROM time_entry x JOIN timesheet t ON t.id = x.timesheet_id JOIN employee e ON e.id = t.employee_id JOIN facility f ON f.id = t.facility_id
        JOIN earning_code c ON c.code = x.earning_code AND c.tenant_id = x.tenant_id
        WHERE t.id = ANY ($1) GROUP BY e.employee_number, e.last_name, e.first_name, f.code, t.week_start, c.external_code, c.code ORDER BY e.employee_number, t.week_start, 6`, [ids])
    : await many(tx, `SELECT e.employee_number, e.last_name, e.first_name, f.code AS facility, t.week_start, x.work_date, coalesce(c.external_code, c.code) AS code, sum(x.hours)::float AS hours
        FROM time_entry x JOIN timesheet t ON t.id = x.timesheet_id JOIN employee e ON e.id = t.employee_id JOIN facility f ON f.id = t.facility_id
        JOIN earning_code c ON c.code = x.earning_code AND c.tenant_id = x.tenant_id
        WHERE t.id = ANY ($1) GROUP BY e.employee_number, e.last_name, e.first_name, f.code, t.week_start, x.work_date, c.external_code, c.code ORDER BY e.employee_number, x.work_date, 7`, [ids]);
  const header = layout === 'summary'
    ? ['Employee number', 'Last name', 'First name', 'Facility', 'Week starting', 'Earning code', 'Hours']
    : ['Employee number', 'Last name', 'First name', 'Facility', 'Week starting', 'Date', 'Earning code', 'Hours'];
  const keys = layout === 'summary' ? ['employee_number', 'last_name', 'first_name', 'facility', 'week_start', 'code', 'hours'] : ['employee_number', 'last_name', 'first_name', 'facility', 'week_start', 'work_date', 'code', 'hours'];
  const content = toCsv(header, rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[keys[i]!]]))));
  const fileName = `payroll-hours-${p.from}-to-${addDays(p.to, 6)}-${layout}.csv`;
  const ex = await one(tx, `INSERT INTO payroll_export (tenant_id, period_from, period_to, layout, file_name, content, row_count, timesheets, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, file_name, row_count, timesheets`, [actor.tenantId, p.from, addDays(p.to, 6), layout, fileName, content, rows.length, ids.length, actor.userId]);
  await tx.query(`UPDATE timesheet SET status = 'exported', export_id = $2 WHERE id = ANY ($1) AND status = 'approved'`, [ids, ex.id]);
  await audit(tx, actor, { action: 'time.payroll_exported', entityType: 'payroll_export', entityId: ex.id, data: { from: p.from, to: p.to, layout, timesheets: ids.length, notReady: p.notReady.length } });
  return { ...ex, notReady: p.notReady.length };
}

export async function listPayrollExports(tx: Tx, actor: Actor) {
  requirePermission(actor, 'time.export');
  return many(tx, `SELECT x.id, x.period_from, x.period_to, x.layout, x.file_name, x.row_count, x.timesheets, x.created_at, u.display_name AS created_by
    FROM payroll_export x JOIN app_user u ON u.id = x.created_by ORDER BY x.created_at DESC LIMIT 50`);
}

export async function downloadPayrollExport(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'time.export');
  const x = await one(tx, 'SELECT file_name, content FROM payroll_export WHERE id = $1', [id]);
  if (!x) throw notFound('payroll export');
  await audit(tx, actor, { action: 'time.payroll_downloaded', entityType: 'payroll_export', entityId: id, data: { fileName: x.file_name } });
  return x as { file_name: string; content: string };
}
