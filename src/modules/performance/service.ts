import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { AppError, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';

/**
 * Performance reviews (D-155). Each active employee is reviewed by their manager at the company's frequency, with
 * check-ins in between and goals carried forward. The daily sweep opens each review some days before it is due.
 * HR-sensitive (D-010): visible to the employee (once shared, apart from their own self-assessment), their reviewer,
 * and people with performance.manage. Every step is audited.
 */
export interface PerformanceSettings {
  enabled: boolean; intervalMonths: number; anchor: 'calendar' | 'hire_date'; calendarMonth: number; firstReviewMonths: number;
  checkinMonths: number; selfAssessment: boolean; openDaysBefore: number; configured: boolean;
}
export const RATINGS = ['', 'Below expectations', 'Partly meets expectations', 'Meets expectations', 'Exceeds expectations', 'Outstanding'];

const HR = 'performance.manage';
const isHr = (a: Actor) => can(a, HR as never);
const iso = (d: unknown) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Last day of the month `n` months after the month of `d`. */
function monthEnd(d: string, n = 0) {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n + 1, 0)).toISOString().slice(0, 10);
}
function addMonths(d: string, n: number) {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const last = Number(monthEnd(`${y}-${String(m).padStart(2, '0')}-01`, n).slice(8));
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}

export async function getSettings(tx: Tx): Promise<PerformanceSettings> {
  const r = await one(tx, 'SELECT * FROM performance_settings');
  return { enabled: r?.enabled ?? false, intervalMonths: r?.interval_months ?? 12, anchor: r?.anchor ?? 'calendar', calendarMonth: r?.calendar_month ?? 1,
    firstReviewMonths: r?.first_review_months ?? 3, checkinMonths: r?.checkin_months ?? 3, selfAssessment: r?.self_assessment ?? true, openDaysBefore: r?.open_days_before ?? 21, configured: !!r };
}

export async function saveSettings(tx: Tx, actor: Actor, s: Omit<PerformanceSettings, 'configured'>) {
  if (!isHr(actor)) throw forbidden(HR);
  const prior = await getSettings(tx);
  if (s.intervalMonths < 1 || s.intervalMonths > 36) throw invalid('review every 1 to 36 months');
  if (s.checkinMonths < 0 || s.checkinMonths > 12) throw invalid('check-ins every 0 (none) to 12 months');
  if (s.checkinMonths && s.checkinMonths >= s.intervalMonths) throw invalid('check-ins must come more often than reviews');
  await tx.query(`INSERT INTO performance_settings (tenant_id, enabled, interval_months, anchor, calendar_month, first_review_months, checkin_months, self_assessment, open_days_before, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, interval_months = EXCLUDED.interval_months, anchor = EXCLUDED.anchor, calendar_month = EXCLUDED.calendar_month,
      first_review_months = EXCLUDED.first_review_months, checkin_months = EXCLUDED.checkin_months, self_assessment = EXCLUDED.self_assessment,
      open_days_before = EXCLUDED.open_days_before, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, s.enabled, s.intervalMonths, s.anchor, s.calendarMonth, s.firstReviewMonths, s.checkinMonths, s.selfAssessment, s.openDaysBefore, actor.userId]);
  await audit(tx, actor, { action: 'performance.settings_set', entityType: 'performance_settings', entityId: actor.tenantId, data: { from: prior, to: s } });
}

/**
 * The next review date for an employee. Calendar: the end of the review month and every interval after it. Hire date:
 * anniversaries of hire every interval. A new hire first gets a review after `firstReviewMonths`, then joins the cycle.
 * After a review, the next is one interval later (calendar dates stay aligned to the review month).
 */
export function nextReviewDue(s: PerformanceSettings, e: { hire_date: string | null }, lastDue: string | null, today: string): string {
  const firstAfterHire = e.hire_date ? monthEnd(e.hire_date, s.firstReviewMonths) : null;
  if (!lastDue && firstAfterHire && firstAfterHire >= addDays(today, -60)) return firstAfterHire;
  const from = lastDue ? addDays(lastDue, 1) : addDays(today, -60);
  if (s.anchor === 'hire_date' && e.hire_date) {
    let d = monthEnd(e.hire_date, s.intervalMonths);
    while (d < from) d = monthEnd(d, s.intervalMonths);
    return d;
  }
  // Calendar cycle: review months are calendarMonth, calendarMonth + interval, … After a review on the cycle the next is
  // a full interval on; after one off it (a new hire's first review) the next cycle date at least half an interval on.
  const year = Number(from.slice(0, 4)) - 1;
  const onCycle = lastDue && lastDue === monthEnd(lastDue) && (((Number(lastDue.slice(5, 7)) - s.calendarMonth) % s.intervalMonths) + s.intervalMonths) % s.intervalMonths === 0;
  const gap = onCycle ? Math.max(1, s.intervalMonths - 1) : Math.ceil(s.intervalMonths / 2);
  let d = monthEnd(`${year}-${String(s.calendarMonth).padStart(2, '0')}-01`);
  while (d < from || (lastDue && d < monthEnd(lastDue, gap))) d = monthEnd(d, s.intervalMonths);
  return d;
}

/** The reviewer: the employee's manager's user; else their department head; else none (HR assigns one). */
async function reviewerFor(tx: Tx, employeeId: string): Promise<string | null> {
  const r = await one(tx, `SELECT (SELECT u.id FROM app_user u WHERE u.employee_id = e.manager_employee_id AND u.status = 'active' LIMIT 1) AS manager,
      d.head_user_id AS head FROM employee e LEFT JOIN department d ON d.id = e.department_id WHERE e.id = $1`, [employeeId]);
  return r?.manager ?? r?.head ?? null;
}

/** Daily: opens reviews and check-ins coming due (idempotent). Returns how many were opened. */
export async function openDueReviews(tx: Tx, tenantId: string, today: string) {
  const s = await getSettings(tx);
  if (!s.configured || !s.enabled) return { opened: 0 };
  const employees = await many(tx, `SELECT e.id, e.facility_id, e.hire_date,
      (SELECT max(r.due_on) FROM performance_review r WHERE r.employee_id = e.id AND r.kind = 'review') AS last_due,
      EXISTS (SELECT 1 FROM performance_review r WHERE r.employee_id = e.id AND r.status IN ('open', 'shared')) AS has_open,
      (SELECT u.id FROM app_user u WHERE u.employee_id = e.id AND u.status = 'active' LIMIT 1) AS user_id
    FROM employee e WHERE e.status = 'active'`);
  let opened = 0;
  for (const e of employees) {
    if (e.has_open) continue;
    const lastDue = iso(e.last_due);
    const due = nextReviewDue(s, { hire_date: iso(e.hire_date) }, lastDue, today);
    let kind: 'review' | 'check_in' = 'review'; let openOn = addDays(due, -s.openDaysBefore); let checkDue = due;
    if (today < openOn && s.checkinMonths && lastDue) {
      // Between reviews: the next check-in, unless it falls within a month of the review.
      let c = monthEnd(lastDue, s.checkinMonths);
      const done = new Set((await many(tx, `SELECT due_on FROM performance_review WHERE employee_id = $1 AND kind = 'check_in' AND due_on > $2`, [e.id, lastDue])).map((r) => iso(r.due_on)));
      while (done.has(c) || c < addDays(today, -31)) c = monthEnd(c, s.checkinMonths);
      if (c < monthEnd(due, -1)) { kind = 'check_in'; checkDue = c; openOn = addDays(c, -Math.min(s.openDaysBefore, 14)); }
    }
    if (today < openOn) continue;
    const reviewer = await reviewerFor(tx, e.id);
    const r = await one(tx, `INSERT INTO performance_review (tenant_id, facility_id, employee_id, reviewer_user_id, kind, period_start, due_on)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (employee_id, kind, due_on) DO NOTHING RETURNING id`,
    [tenantId, e.facility_id, e.id, reviewer, kind, lastDue ? addDays(lastDue, 1) : iso(e.hire_date) ?? addMonths(checkDue, -s.intervalMonths), checkDue]);
    if (!r) continue;
    opened += 1;
    const label = kind === 'review' ? 'performance review' : 'check-in';
    const who = reviewer ? [reviewer] : await usersWithPermission(tx, HR, e.facility_id);
    await notify(tx, tenantId, who, { kind: 'performance.opened', title: `${reviewer ? 'A' : 'Needs a reviewer: a'} ${label} is due ${checkDue}`, link: `/performance/${r.id}`, subjectType: 'performance_review', subjectId: r.id, dedupeKey: `perf-open:${r.id}` });
    if (e.user_id && kind === 'review' && s.selfAssessment) {
      await notify(tx, tenantId, [e.user_id], { kind: 'performance.self_assessment', title: `Your performance review is due ${checkDue}: add your self-assessment`, link: `/performance/${r.id}`, subjectType: 'performance_review', subjectId: r.id, dedupeKey: `perf-self:${r.id}` });
    }
  }
  return { opened };
}

// ---------- reading ----------

type Role = 'employee' | 'reviewer' | 'hr';
/** Their own review is always the employee's, even for someone in HR (D-161): nobody writes or reads ahead on their own. */
function roleIn(actor: Actor, r: any): Role | null {
  if (actor.employeeId && r.employee_id === actor.employeeId) return 'employee';
  if (r.reviewer_user_id === actor.userId) return 'reviewer';
  if (isHr(actor)) return 'hr';
  return null;
}
/** What the employee may see: their own self-assessment always; the manager's part only once shared (a review cancelled before then stays hidden). */
function shape(r: any, role: Role) {
  const hidden = role === 'employee' && !r.shared_at;
  return { ...r, rating: hidden ? null : r.rating, ratingLabel: hidden || !r.rating ? null : RATINGS[r.rating], strengths: hidden ? null : r.strengths, development: hidden ? null : r.development,
    summary: hidden ? null : r.summary, role };
}

const SELECT = `SELECT r.*, e.first_name || ' ' || e.last_name AS employee_name, e.job_title, e.employee_number, u.display_name AS reviewer_name
  FROM performance_review r JOIN employee e ON e.id = r.employee_id LEFT JOIN app_user u ON u.id = r.reviewer_user_id`;

export async function listPerformance(tx: Tx, actor: Actor) {
  const today = new Date().toISOString().slice(0, 10);
  const mine = actor.employeeId ? await many(tx, `${SELECT} WHERE r.employee_id = $1 AND r.status <> 'cancelled' ORDER BY r.due_on DESC`, [actor.employeeId]) : [];
  const team = await many(tx, `${SELECT} WHERE r.reviewer_user_id = $1 AND r.status IN ('open', 'shared') ORDER BY r.due_on`, [actor.userId]);
  const all = isHr(actor) ? await many(tx, `${SELECT} WHERE r.status IN ('open', 'shared') OR r.completed_at > now() - interval '90 days' ORDER BY r.status, r.due_on`) : null;
  const goals = actor.employeeId ? await many(tx, `SELECT * FROM performance_goal WHERE employee_id = $1 AND status = 'open' ORDER BY due_on NULLS LAST`, [actor.employeeId]) : [];
  return {
    settings: isHr(actor) ? await getSettings(tx) : null, hr: isHr(actor), today,
    mine: mine.map((r) => shape(r, 'employee')), myGoals: goals,
    team: team.map((r) => shape(r, 'reviewer')),
    all: all?.map((r) => shape(r, r.employee_id === actor.employeeId ? 'employee' : 'hr')) ?? null,
    counts: all ? { open: all.filter((r) => r.status === 'open').length, overdue: all.filter((r) => r.status !== 'completed' && iso(r.due_on)! < today).length,
      noReviewer: all.filter((r) => !r.reviewer_user_id && r.status === 'open').length } : null,
  };
}

async function load(tx: Tx, actor: Actor, id: string) {
  const r = await one(tx, `${SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw notFound('performance review');
  const role = roleIn(actor, r);
  if (!role) throw notFound('performance review');
  return { r, role };
}

export async function getReview(tx: Tx, actor: Actor, id: string) {
  const { r, role } = await load(tx, actor, id);
  const goals = await many(tx, `SELECT * FROM performance_goal WHERE employee_id = $1 AND (status = 'open' OR set_in_review = $2 OR closed_in_review = $2) ORDER BY created_at`, [r.employee_id, id]);
  const previous = await many(tx, `SELECT id, kind, due_on, status, rating FROM performance_review WHERE employee_id = $1 AND id <> $2 AND status = 'completed' ORDER BY due_on DESC LIMIT 6`, [r.employee_id, id]);
  const s = await getSettings(tx);
  return { ...shape(r, role), selfAssessmentOn: s.selfAssessment, goals, previous: role === 'employee' ? previous.map((p) => ({ ...p, rating: p.rating })) : previous, ratings: RATINGS.slice(1) };
}

// ---------- steps ----------

export async function submitSelfAssessment(tx: Tx, actor: Actor, id: string, text: string) {
  const { r, role } = await load(tx, actor, id);
  if (role !== 'employee') throw forbidden('only the employee writes their self-assessment');
  if (r.status !== 'open' || r.kind !== 'review') throw invalid('the self-assessment is closed once the review is shared');
  if (!text.trim()) throw invalid('write your self-assessment');
  await tx.query('UPDATE performance_review SET self_assessment = $2, self_submitted_at = now() WHERE id = $1', [id, text.trim()]);
  await audit(tx, actor, { action: 'performance.self_assessed', entityType: 'performance_review', entityId: id, facilityId: r.facility_id });
  if (r.reviewer_user_id) await notify(tx, actor.tenantId, [r.reviewer_user_id], { kind: 'performance.self_assessed', title: `${r.employee_name} added a self-assessment`, link: `/performance/${id}`, subjectType: 'performance_review', subjectId: id });
}

export async function saveAssessment(tx: Tx, actor: Actor, id: string, v: { rating?: number | null; strengths?: string | null; development?: string | null; summary?: string | null }) {
  const { r, role } = await load(tx, actor, id);
  if (role === 'employee') throw forbidden('the reviewer writes the assessment');
  if (r.status !== 'open') throw invalid('this review has been shared; it can no longer be edited');
  if (v.rating != null && (v.rating < 1 || v.rating > 5)) throw invalid('rating 1 to 5');
  await tx.query('UPDATE performance_review SET rating = $2, strengths = $3, development = $4, summary = $5 WHERE id = $1',
    [id, r.kind === 'review' ? v.rating ?? null : null, v.strengths ?? null, v.development ?? null, v.summary ?? null]);
}

/** Shares a review with the employee (or completes a check-in, which needs no acknowledgement). */
export async function shareReview(tx: Tx, actor: Actor, id: string) {
  const { r, role } = await load(tx, actor, id);
  if (role === 'employee') throw forbidden('the reviewer shares the review');
  if (r.status !== 'open') throw invalid('already shared');
  if (r.kind === 'review' && !r.rating) throw invalid('choose an overall rating before sharing');
  if (!(r.summary ?? '').trim()) throw invalid('write a summary before sharing');
  const employeeUser = (await one(tx, `SELECT id FROM app_user WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [r.employee_id]))?.id;
  if (r.kind === 'check_in') await tx.query(`UPDATE performance_review SET status = 'completed', shared_at = now(), completed_at = now() WHERE id = $1`, [id]);
  else await tx.query(`UPDATE performance_review SET status = 'shared', shared_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: r.kind === 'check_in' ? 'performance.check_in_completed' : 'performance.shared', entityType: 'performance_review', entityId: id, facilityId: r.facility_id, data: { rating: r.rating } });
  if (employeeUser) await notify(tx, actor.tenantId, [employeeUser], { kind: 'performance.shared', title: r.kind === 'check_in' ? `Notes from your check-in with ${r.reviewer_name ?? 'your manager'}` : `Your performance review is ready to read and acknowledge`, link: `/performance/${id}`, subjectType: 'performance_review', subjectId: id });
}

/** The employee acknowledges (not necessarily agrees with) the review, optionally commenting; this completes it. */
export async function acknowledgeReview(tx: Tx, actor: Actor, id: string, comment?: string | null) {
  const { r, role } = await load(tx, actor, id);
  if (role !== 'employee') throw forbidden('only the employee acknowledges their review');
  if (r.status !== 'shared') throw invalid('nothing to acknowledge yet');
  await tx.query(`UPDATE performance_review SET status = 'completed', employee_comment = $2, acknowledged_at = now(), completed_at = now() WHERE id = $1`, [id, comment?.trim() || null]);
  await audit(tx, actor, { action: 'performance.acknowledged', entityType: 'performance_review', entityId: id, facilityId: r.facility_id, data: { commented: !!comment?.trim() } });
}

/** HR: assign or change the reviewer; cancel a review (leaver, long leave); close a shared review the employee has not acknowledged in 14 days. */
export async function hrAction(tx: Tx, actor: Actor, id: string, a: { action: 'assign'; reviewerUserId: string } | { action: 'cancel'; reason: string } | { action: 'close_unacknowledged' }) {
  if (!isHr(actor)) throw forbidden(HR);
  const { r, role } = await load(tx, actor, id);
  if (role === 'employee') throw forbidden('another member of HR handles your own review');
  if (a.action === 'assign') {
    if (r.status !== 'open') throw invalid('only an open review can change reviewer');
    if ((await one(tx, 'SELECT employee_id FROM app_user WHERE id = $1', [a.reviewerUserId]))?.employee_id === r.employee_id) throw invalid('an employee cannot review themselves');
    await tx.query('UPDATE performance_review SET reviewer_user_id = $2 WHERE id = $1', [id, a.reviewerUserId]);
    await notify(tx, actor.tenantId, [a.reviewerUserId], { kind: 'performance.opened', title: `You are reviewing ${r.employee_name} (due ${iso(r.due_on)})`, link: `/performance/${id}`, subjectType: 'performance_review', subjectId: id });
  } else if (a.action === 'cancel') {
    if (!a.reason.trim()) throw invalid('give a reason');
    if (r.status === 'completed') throw invalid('a completed review cannot be cancelled');
    await tx.query(`UPDATE performance_review SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1`, [id, a.reason.trim()]);
  } else {
    if (r.status !== 'shared') throw invalid('only a shared review can be closed');
    if (Date.parse(r.shared_at) > Date.now() - 14 * 86_400_000) throw new AppError(409, 'too_soon', 'give the employee 14 days to acknowledge first');
    await tx.query(`UPDATE performance_review SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
  }
  await audit(tx, actor, { action: `performance.${a.action}`, entityType: 'performance_review', entityId: id, facilityId: r.facility_id, data: a });
}

// ---------- goals ----------

export async function addGoal(tx: Tx, actor: Actor, reviewId: string, g: { title: string; measure?: string | null; dueOn?: string | null }) {
  const { r, role } = await load(tx, actor, reviewId);
  if (role === 'employee' && r.status !== 'open') throw invalid('goals are agreed during an open review');
  if (!g.title.trim()) throw invalid('name the goal');
  const row = await one(tx, `INSERT INTO performance_goal (tenant_id, employee_id, set_in_review, title, measure, due_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, r.employee_id, reviewId, g.title.trim(), g.measure?.trim() || null, g.dueOn ?? null, actor.userId]);
  await audit(tx, actor, { action: 'performance.goal_added', entityType: 'performance_review', entityId: reviewId, facilityId: r.facility_id, data: { title: row.title } });
  return row;
}

/** Progress (the employee or reviewer), or an outcome (the reviewer, during a review or check-in). */
export async function updateGoal(tx: Tx, actor: Actor, reviewId: string, goalId: string, g: { progressNote?: string | null; status?: 'open' | 'met' | 'partly_met' | 'not_met' | 'dropped' }) {
  const { r, role } = await load(tx, actor, reviewId);
  const goal = await one(tx, 'SELECT * FROM performance_goal WHERE id = $1 AND employee_id = $2', [goalId, r.employee_id]);
  if (!goal) throw notFound('goal');
  if (g.status && g.status !== goal.status && role === 'employee') throw forbidden('the reviewer records a goal’s outcome');
  await tx.query(`UPDATE performance_goal SET progress_note = coalesce($2, progress_note), status = coalesce($3, status), closed_in_review = CASE WHEN coalesce($3, status) <> 'open' THEN $4 ELSE NULL END, updated_at = now() WHERE id = $1`,
    [goalId, g.progressNote ?? null, g.status ?? null, reviewId]);
}

// ---------- reminders (called by the sweep) ----------

/** Open or shared items due within `lead` days or overdue → the reviewer (or HR when there is none); overdue past `hrAfter` days → HR, one summary. */
export async function performanceReminders(tx: Tx, tenantId: string, today: string, o: { dueOn: boolean; lead: number; dueKey: (id: string) => string; hrOn: boolean; hrAfter: number; hrKey: string }) {
  const counts: Record<string, number> = {};
  const add = (k: string, n: number) => { counts[k] = (counts[k] ?? 0) + n; };
  const open = await many(tx, `${SELECT} WHERE r.status IN ('open', 'shared') AND r.due_on <= $1::date + $2::int`, [today, o.lead]);
  if (o.dueOn) {
    for (const r of open) {
      const due = iso(r.due_on)!;
      if (r.status === 'shared') continue; // waiting on the employee's acknowledgement
      const who = r.reviewer_user_id ? [r.reviewer_user_id] : await usersWithPermission(tx, HR, r.facility_id);
      add('performance_due', await notify(tx, tenantId, who, { kind: 'reminder.performance_due',
        title: `${r.kind === 'review' ? 'Performance review' : 'Check-in'} with ${r.employee_name} ${due < today ? `overdue since ${due}` : `due ${due}`}${r.reviewer_user_id ? '' : ' (no reviewer assigned)'}`,
        link: `/performance/${r.id}`, subjectType: 'performance_review', subjectId: r.id, dedupeKey: o.dueKey(r.id) }));
    }
  }
  if (o.hrOn) {
    const late = open.filter((r) => iso(r.due_on)! <= addDays(today, -o.hrAfter));
    if (late.length) {
      add('performance_overdue', await notify(tx, tenantId, await usersWithPermission(tx, HR, null), { kind: 'reminder.performance_overdue',
        title: `${late.length} performance review${late.length === 1 ? '' : 's'} or check-in${late.length === 1 ? '' : 's'} more than ${o.hrAfter} days overdue`,
        body: late.slice(0, 6).map((r) => `${r.employee_name} (${r.reviewer_name ?? 'no reviewer'})`).join(', '), link: '/performance?tab=all', dedupeKey: o.hrKey }));
    }
  }
  return counts;
}
