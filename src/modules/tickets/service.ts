import type { Actor } from '../../platform/auth/actor.js';
import { can, facilitiesWith, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { ATTACHMENT_MIME } from '../quality/attachments.js';
import { assertWeekOpen, getOrCreateTimesheet } from '../time/service.js';
import type { BusinessCalendar } from './hours.js';
import { DEFAULT_DAYS, parseDays } from './hours.js';
import type { ClockEvent, ClockState, Priority, Status, Targets } from './sla.js';
import { PAUSED, PRIORITIES, STATUSES, STOPPED, TIMER_LABEL, advance, blankClock, timerState } from './sla.js';

export { PRIORITIES, STATUSES };
export const CHANNELS = ['phone', 'email', 'in_person', 'public_form'] as const;
export type Channel = (typeof CHANNELS)[number];
export const STATUS_LABEL: Record<string, string> = { new: 'New', open: 'Open', waiting_customer: 'Waiting on customer', waiting_third_party: 'Waiting on third party', resolved: 'Resolved', closed: 'Closed', reopened: 'Reopened' };
export const CHANNEL_LABEL: Record<string, string> = { phone: 'Phone', email: 'Email (typed in)', portal: 'Portal', in_person: 'In person', public_form: 'Public form' };

/** Who may move a ticket where: everyone with the work permission, except that reopening a closed ticket takes the manage permission. */
export const TRANSITIONS: Record<Status, Status[]> = {
  new: ['open', 'waiting_customer', 'waiting_third_party', 'resolved'],
  open: ['waiting_customer', 'waiting_third_party', 'resolved'],
  reopened: ['open', 'waiting_customer', 'waiting_third_party', 'resolved'],
  waiting_customer: ['open', 'waiting_third_party', 'resolved'],
  waiting_third_party: ['open', 'waiting_customer', 'resolved'],
  resolved: ['closed', 'reopened'],
  closed: ['reopened'],
};
export function nextStatuses(actor: Actor, status: Status, facilityId: string): Status[] {
  return TRANSITIONS[status].filter((s) => !(status === 'closed' && s === 'reopened' && !can(actor, 'tickets.manage', facilityId)));
}

const ONE_HOUR_CAP = 20;
const pad6 = (n: number) => String(n).padStart(6, '0');

// ---------------------------------------------------------------------------
// Calendar, policy and clock plumbing
// ---------------------------------------------------------------------------

export async function calendarFor(tx: Tx, facilityId: string): Promise<BusinessCalendar & { saved: boolean }> {
  const saved = await one(tx, 'SELECT time_zone, days FROM ticket_calendar WHERE facility_id = $1', [facilityId]);
  const fac = await one(tx, 'SELECT timezone FROM facility WHERE id = $1', [facilityId]);
  const holidays = await many(tx, `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM ticket_holiday WHERE facility_id IS NULL OR facility_id = $1`, [facilityId]);
  return {
    saved: !!saved, timeZone: saved?.time_zone ?? fac?.timezone ?? 'UTC',
    days: saved ? parseDays(saved.days) : DEFAULT_DAYS,
    holidays: new Set(holidays.map((h) => h.day as string)),
  };
}

/** The policy for a priority: the customer's own row if it has one, else the company-wide row. */
export async function policyFor(tx: Tx, priority: string, customerId: string) {
  return one(tx, `SELECT id, first_response_minutes, resolution_minutes, at_risk_pct FROM ticket_service_level
    WHERE active AND priority = $1 AND (customer_id = $2 OR customer_id IS NULL) ORDER BY customer_id NULLS LAST LIMIT 1`, [priority, customerId]);
}
const targetsOf = (p: { first_response_minutes: number | null; resolution_minutes: number | null; at_risk_pct: number } | undefined): Targets =>
  ({ firstResponse: p?.first_response_minutes ?? null, resolution: p?.resolution_minutes ?? null, atRiskPct: p?.at_risk_pct ?? 80 });

const asDate = (v: unknown) => (v ? new Date(v as string) : null);
export function clockOf(t: any): ClockState {
  return {
    status: t.status, runningSince: asDate(t.sla_running_since), elapsed: t.sla_elapsed_minutes, resolutionBase: t.resolution_base_minutes,
    targets: { firstResponse: t.first_response_target_min, resolution: t.resolution_target_min, atRiskPct: t.at_risk_pct },
    firstRespondedAt: asDate(t.first_responded_at), firstResponseMissed: t.first_response_missed, resolvedAt: asDate(t.resolved_at), resolutionMissed: t.resolution_missed,
    firstDueAt: asDate(t.first_response_due_at), firstRiskAt: asDate(t.first_response_risk_at), resolutionDueAt: asDate(t.resolution_due_at), resolutionRiskAt: asDate(t.resolution_risk_at),
  };
}
const CLOCK_SET = `status = $2, sla_running_since = $3, sla_elapsed_minutes = $4, resolution_base_minutes = $5, first_response_target_min = $6, resolution_target_min = $7, at_risk_pct = $8,
  first_responded_at = $9, first_response_missed = $10, resolved_at = $11, resolution_missed = $12, first_response_due_at = $13, first_response_risk_at = $14,
  resolution_due_at = $15, resolution_risk_at = $16, updated_at = now()`;
const clockParams = (id: string, c: ClockState) => [id, c.status, c.runningSince, c.elapsed, c.resolutionBase, c.targets.firstResponse, c.targets.resolution, c.targets.atRiskPct,
  c.firstRespondedAt, c.firstResponseMissed, c.resolvedAt, c.resolutionMissed, c.firstDueAt, c.firstRiskAt, c.resolutionDueAt, c.resolutionRiskAt];

/** Moves a ticket's clock with an event and stores the result (due times included). Returns the updated row. */
async function moveClock(tx: Tx, t: any, ev: ClockEvent, now = new Date(), extra: Record<string, unknown> = {}) {
  const cal = await calendarFor(tx, t.facility_id);
  const c = advance(cal, clockOf(t), ev, now);
  const sets = [CLOCK_SET]; const vals: unknown[] = clockParams(t.id, c);
  if (c.status !== t.status) { vals.push(now); sets.push(`status_changed_at = $${vals.length}`); }
  for (const [k, v] of Object.entries(extra)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  return one(tx, `UPDATE ticket SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
}

/** After a calendar or holiday change: running tickets at the site get their due times recomputed against the new hours. */
export async function refreshOpenTickets(tx: Tx, facilityId: string | null) {
  const rows = await many(tx, `SELECT * FROM ticket WHERE sla_running_since IS NOT NULL AND status IN ('new', 'open', 'reopened') AND ($1::uuid IS NULL OR facility_id = $1) FOR UPDATE`, [facilityId]);
  for (const t of rows) await moveClock(tx, t, {});
  return rows.length;
}

// ---------------------------------------------------------------------------
// What a ticket row looks like to the screen
// ---------------------------------------------------------------------------

export function slaView(t: any, now = new Date()) {
  const paused = PAUSED.has(t.status);
  const timer = (target: number | null, done: boolean, missed: boolean | null, due: unknown, risk: unknown) => {
    const state = timerState({ target, done, missed, due: asDate(due), risk: asDate(risk), paused }, now);
    return { target, state, label: TIMER_LABEL[state], dueAt: done ? null : asDate(due)?.toISOString() ?? null, riskAt: done ? null : asDate(risk)?.toISOString() ?? null };
  };
  const firstResponse = { ...timer(t.first_response_target_min, !!t.first_responded_at, t.first_response_missed, t.first_response_due_at, t.first_response_risk_at), at: asDate(t.first_responded_at)?.toISOString() ?? null };
  const resolution = { ...timer(t.resolution_target_min, !!t.resolved_at, t.resolution_missed, t.resolution_due_at, t.resolution_risk_at), at: asDate(t.resolved_at)?.toISOString() ?? null };
  const rank: Record<string, number> = { breached: 6, at_risk: 5, on_track: 4, paused: 3, missed: 2, met: 1, none: 0 };
  const overall = rank[firstResponse.state]! >= rank[resolution.state]! ? firstResponse.state : resolution.state;
  return { firstResponse, resolution, paused, overall, overallLabel: TIMER_LABEL[overall] };
}

const BREACH_FIRST = `(t.first_responded_at IS NULL AND t.first_response_due_at < now())`;
const BREACH_RES = `(t.resolution_due_at < now())`;
export const BREACHED_SQL = `(t.status NOT IN ('resolved', 'closed') AND (${BREACH_FIRST} OR ${BREACH_RES}))`;
export const RISK_FIRST = `(t.first_responded_at IS NULL AND t.first_response_risk_at <= now() AND (t.first_response_due_at IS NULL OR t.first_response_due_at >= now()))`;
export const RISK_RES = `(t.resolution_risk_at <= now() AND (t.resolution_due_at IS NULL OR t.resolution_due_at >= now()))`;
export const AT_RISK_SQL = `(t.status NOT IN ('resolved', 'closed') AND NOT ${BREACHED_SQL} AND (${RISK_FIRST} OR ${RISK_RES}))`;
const OPEN_SQL = `t.status NOT IN ('resolved', 'closed')`;
const NEXT_DUE = `LEAST(CASE WHEN t.first_responded_at IS NULL THEN t.first_response_due_at END, t.resolution_due_at)`;

const LIST_FROM = `FROM ticket t JOIN customer c ON c.id = t.customer_id JOIN facility f ON f.id = t.facility_id LEFT JOIN app_user u ON u.id = t.assignee_user_id
  LEFT JOIN ticket_category cat ON cat.id = t.category_id LEFT JOIN contact ct ON ct.id = t.contact_id`;

export interface QueueFilter {
  view?: 'open' | 'mine' | 'unassigned' | 'breached' | 'at_risk' | 'waiting' | 'all'; status?: Status; priority?: Priority; customerId?: string; assigneeId?: string; facilityId?: string;
  q?: string; sort?: 'due' | 'priority' | 'created' | 'updated' | 'number'; dir?: 'asc' | 'desc'; limit?: number;
}

export async function listTickets(tx: Tx, actor: Actor, f: QueueFilter = {}) {
  requirePermission(actor, 'tickets.view');
  const scope = facilitiesWith(actor, 'tickets.view');
  const where: string[] = ['(t.facility_id = ANY ($1) OR $2::boolean)']; const vals: unknown[] = [scope.ids, scope.all];
  const add = (sql: string, v?: unknown) => { if (v !== undefined) { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); } else where.push(sql); };
  const view = f.view ?? 'open';
  if (view === 'open') add(OPEN_SQL);
  else if (view === 'mine') { add(OPEN_SQL); add('t.assignee_user_id = ?', actor.userId); }
  else if (view === 'unassigned') { add(OPEN_SQL); add('t.assignee_user_id IS NULL'); }
  else if (view === 'breached') add(BREACHED_SQL);
  else if (view === 'at_risk') add(AT_RISK_SQL);
  else if (view === 'waiting') add(`t.status IN ('waiting_customer', 'waiting_third_party')`);
  if (f.status) add('t.status = ?', f.status);
  if (f.priority) add('t.priority = ?', f.priority);
  if (f.customerId) add('t.customer_id = ?', f.customerId);
  if (f.assigneeId) add('t.assignee_user_id = ?', f.assigneeId);
  if (f.facilityId) add('t.facility_id = ?', f.facilityId);
  if (f.q?.trim()) add(`(t.number ILIKE '%' || ? || '%' OR t.subject ILIKE '%' || ? || '%' OR c.name ILIKE '%' || ? || '%')`.replace(/\?/g, () => { vals.push(f.q!.trim()); return `$${vals.length}`; }));
  const dir = f.dir === 'desc' ? 'DESC' : 'ASC';
  const order = ({
    due: `${NEXT_DUE} ${dir} NULLS LAST, t.created_at`,
    priority: `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ${dir}, ${NEXT_DUE} NULLS LAST`,
    created: `t.created_at ${dir}`, updated: `t.updated_at ${dir}`, number: `t.number ${dir}`,
  } as Record<string, string>)[f.sort ?? 'due']!;
  const limit = Math.min(Math.max(f.limit ?? 300, 1), 1000);
  const rows = await many(tx, `SELECT t.id, t.number, t.subject, t.priority, t.status, t.channel, t.facility_id, f.code AS facility_code, t.customer_id, c.name AS customer_name, t.contact_id, ct.name AS contact_name,
      t.requester_name, t.assignee_user_id, u.display_name AS assignee_name, cat.name AS category_name, t.retainer_covered, t.project_id, t.created_at, t.updated_at, t.status_changed_at,
      t.first_response_target_min, t.resolution_target_min, t.at_risk_pct, t.first_responded_at, t.first_response_missed, t.resolved_at, t.resolution_missed,
      t.first_response_due_at, t.first_response_risk_at, t.resolution_due_at, t.resolution_risk_at, ${NEXT_DUE} AS next_due_at
    ${LIST_FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`, vals);
  const now = new Date();
  const counts = await one(tx, `SELECT count(*) FILTER (WHERE ${OPEN_SQL})::int AS open, count(*) FILTER (WHERE ${OPEN_SQL} AND t.assignee_user_id = $3)::int AS mine,
      count(*) FILTER (WHERE ${OPEN_SQL} AND t.assignee_user_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE ${BREACHED_SQL})::int AS breached,
      count(*) FILTER (WHERE ${AT_RISK_SQL})::int AS at_risk, count(*) FILTER (WHERE t.status IN ('waiting_customer', 'waiting_third_party'))::int AS waiting
    FROM ticket t WHERE (t.facility_id = ANY ($1) OR $2::boolean)`, [scope.ids, scope.all, actor.userId]);
  return { counts, rows: rows.map((r) => ({ ...r, sla: slaView(r, now) })) };
}

export async function getTicket(tx: Tx, actor: Actor, id: string) {
  const t = await one(tx, `SELECT t.*, c.name AS customer_name, c.code AS customer_code, f.code AS facility_code, f.name AS facility_name, u.display_name AS assignee_name, cat.name AS category_name,
      ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone, cu.display_name AS created_by_name, p.number AS project_number, p.name AS project_name,
      a.asset_tag, a.name AS asset_name, w.number AS work_order_number, w.title AS work_order_title, v.number AS service_visit_number
    ${LIST_FROM} LEFT JOIN app_user cu ON cu.id = t.created_by LEFT JOIN project p ON p.id = t.project_id LEFT JOIN asset a ON a.id = t.asset_id
    LEFT JOIN work_order w ON w.id = t.work_order_id LEFT JOIN service_visit v ON v.id = t.service_visit_id WHERE t.id = $1`, [id]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.view', t.facility_id);
  const entries = await many(tx, `SELECT e.id, e.kind, e.customer_visible, e.author_name, e.author_user_id, e.body, e.created_at FROM ticket_entry e WHERE e.ticket_id = $1 ORDER BY e.seq`, [id]);
  const time = await many(tx, `SELECT x.id, x.work_date, x.hours::float AS hours, x.billable, x.covered_by_retainer, x.note, x.user_id, u.display_name AS who, x.created_at
    FROM ticket_time x JOIN app_user u ON u.id = x.user_id WHERE x.ticket_id = $1 ORDER BY x.work_date, x.created_at`, [id]);
  const files = await many(tx, `SELECT x.id, x.file_name, x.mime, x.size_bytes, x.created_at, u.display_name AS uploaded_by_name FROM attachment x JOIN app_user u ON u.id = x.uploaded_by
    WHERE x.subject_type = 'ticket' AND x.subject_id = $1 ORDER BY x.created_at`, [id]);
  return {
    ...t, sla: slaView(t), entries, time, files, timeTotal: Math.round(time.reduce((s, x) => s + x.hours, 0) * 100) / 100,
    next: can(actor, 'tickets.work', t.facility_id) ? nextStatuses(actor, t.status, t.facility_id) : [],
    can: { work: can(actor, 'tickets.work', t.facility_id), manage: can(actor, 'tickets.manage', t.facility_id) },
  };
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

export interface TicketInput {
  facilityId: string; customerId: string; contactId?: string | null; subject: string; description?: string | null; priority?: Priority; categoryId?: string | null; channel?: Channel;
  assigneeUserId?: string | null; projectId?: string | null; assetId?: string | null; workOrderId?: string | null; serviceVisitId?: string | null; retainerCovered?: boolean;
  requesterName?: string | null; requesterContact?: string | null;
}
type Who = { tenantId: string; userId: string | null; displayName: string };

async function checkLinks(tx: Tx, facilityId: string, customerId: string, l: { contactId?: string | null; categoryId?: string | null; projectId?: string | null; assetId?: string | null; workOrderId?: string | null; serviceVisitId?: string | null }) {
  if (l.contactId && !(await one(tx, 'SELECT 1 FROM contact WHERE id = $1 AND customer_id = $2 AND active', [l.contactId, customerId]))) throw invalid('that contact does not belong to this customer');
  if (l.categoryId && !(await one(tx, 'SELECT 1 FROM ticket_category WHERE id = $1 AND active', [l.categoryId]))) throw invalid('unknown category');
  if (l.projectId) {
    const p = await one(tx, 'SELECT customer_id, status FROM project WHERE id = $1', [l.projectId]);
    if (!p) throw invalid('unknown project');
    if (p.customer_id && p.customer_id !== customerId) throw invalid('that project belongs to a different customer');
  }
  if (l.assetId && !(await one(tx, 'SELECT 1 FROM asset WHERE id = $1 AND facility_id = $2', [l.assetId, facilityId]))) throw invalid('that asset is not at this site');
  if (l.workOrderId && !(await one(tx, 'SELECT 1 FROM work_order WHERE id = $1', [l.workOrderId]))) throw invalid('unknown work order');
  if (l.serviceVisitId && !(await one(tx, 'SELECT 1 FROM service_visit WHERE id = $1 AND customer_id = $2', [l.serviceVisitId, customerId]))) throw invalid('that service visit is not for this customer');
}

async function eventEntry(tx: Tx, tenantId: string, ticketId: string, who: { userId: string | null; displayName: string }, body: string) {
  return (await one(tx, `INSERT INTO ticket_entry (tenant_id, ticket_id, kind, customer_visible, author_user_id, author_name, body) VALUES ($1, $2, 'event', false, $3, $4, $5) RETURNING id`,
    [tenantId, ticketId, who.userId, who.displayName, body])).id as string;
}

async function assertAssignable(tx: Tx, facilityId: string, userId: string) {
  if (!(await usersWithPermission(tx, 'tickets.work', facilityId)).includes(userId)) throw invalid('that person cannot work tickets at this site');
}

/** Creates a ticket, with the service-level clock started. `who.userId` is null for a ticket raised through a public link. */
export async function createTicketAs(tx: Tx, who: Who, input: TicketInput, extra: { intakeLinkId?: string } = {}) {
  const cust = await one(tx, 'SELECT id, name, active FROM customer WHERE id = $1', [input.customerId]);
  if (!cust || !cust.active) throw invalid('choose an active customer');
  if (!input.subject?.trim()) throw invalid('give the ticket a subject');
  await checkLinks(tx, input.facilityId, input.customerId, input);
  if (input.assigneeUserId) await assertAssignable(tx, input.facilityId, input.assigneeUserId);
  const priority = input.priority ?? 'normal';
  const now = new Date();
  const policy = await policyFor(tx, priority, input.customerId);
  const cal = await calendarFor(tx, input.facilityId);
  const c = advance(cal, blankClock(targetsOf(policy)), { status: input.assigneeUserId ? 'open' : 'new' }, now);
  const number = `TCK-${pad6(await nextSequence(tx, who.tenantId, 'ticket'))}`;
  const channel = input.channel ?? (extra.intakeLinkId ? 'public_form' : 'email');
  const vals: unknown[] = [who.tenantId, input.facilityId, number, input.customerId, input.contactId ?? null, input.requesterName?.trim() || null, input.requesterContact?.trim() || null, input.subject.trim().slice(0, 300),
    input.description?.trim() || null, priority, input.categoryId ?? null, channel, input.assigneeUserId ?? null, input.projectId ?? null, input.assetId ?? null, input.workOrderId ?? null,
    input.serviceVisitId ?? null, input.retainerCovered ?? false, extra.intakeLinkId ?? null, policy?.id ?? null, who.userId, now, ...clockParams('', c).slice(1)];
  const t = await one(tx, `INSERT INTO ticket (tenant_id, facility_id, number, customer_id, contact_id, requester_name, requester_contact, subject, description, priority, category_id, channel, assignee_user_id,
      project_id, asset_id, work_order_id, service_visit_id, retainer_covered, intake_link_id, service_level_id, created_by, created_at, status, sla_running_since, sla_elapsed_minutes, resolution_base_minutes,
      first_response_target_min, resolution_target_min, at_risk_pct, first_responded_at, first_response_missed, resolved_at, resolution_missed, first_response_due_at, first_response_risk_at, resolution_due_at, resolution_risk_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37) RETURNING *`, vals);
  await eventEntry(tx, who.tenantId, t.id, who, `Ticket raised by ${who.displayName} (${CHANNEL_LABEL[channel]})${policy ? '' : '. No service level is set for this priority, so no timers run'}`);
  await audit(tx, { tenantId: who.tenantId, userId: who.userId }, { action: 'ticket.created', entityType: 'ticket', entityId: t.id, facilityId: t.facility_id, data: { number, priority, channel, customerId: t.customer_id } });
  if (t.assignee_user_id) {
    await notify(tx, who.tenantId, [t.assignee_user_id], { kind: 'ticket.assigned', title: `Ticket ${number} assigned to you: ${t.subject}`, body: `${cust.name}, ${priority} priority`, link: `/tickets/${t.id}`,
      subjectType: 'ticket', subjectId: t.id, dedupeKey: `ticket-assigned:${t.id}:created` }, who.userId);
  }
  return t;
}

export async function createTicket(tx: Tx, actor: Actor, input: TicketInput) {
  requirePermission(actor, 'tickets.work', input.facilityId);
  if (input.assigneeUserId && input.assigneeUserId !== actor.userId) requirePermission(actor, 'tickets.manage', input.facilityId);
  if (input.channel === 'public_form') throw invalid('public-form tickets arrive through a ticket link');
  return createTicketAs(tx, actor, input);
}

export async function updateTicket(tx: Tx, actor: Actor, id: string, patch: Partial<Pick<TicketInput, 'subject' | 'description' | 'priority' | 'categoryId' | 'contactId' | 'projectId' | 'assetId' | 'workOrderId' | 'serviceVisitId' | 'retainerCovered'>>) {
  const t = await one(tx, 'SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.work', t.facility_id);
  if (t.status === 'closed') throw conflict('the ticket is closed; reopen it to change it');
  await checkLinks(tx, t.facility_id, t.customer_id, patch);
  const sets: string[] = []; const vals: unknown[] = [id]; const changed: string[] = [];
  const col: Record<string, string> = { subject: 'subject', description: 'description', categoryId: 'category_id', contactId: 'contact_id', projectId: 'project_id', assetId: 'asset_id', workOrderId: 'work_order_id', serviceVisitId: 'service_visit_id', retainerCovered: 'retainer_covered' };
  for (const [k, c] of Object.entries(col)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === 'subject' && !String(v).trim()) throw invalid('give the ticket a subject');
    vals.push(typeof v === 'string' ? v.trim() : v); sets.push(`${c} = $${vals.length}`); changed.push(k);
  }
  let row = t;
  if (sets.length) row = await one(tx, `UPDATE ticket SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
  if (patch.priority && patch.priority !== t.priority) {
    if (STOPPED.has(t.status)) throw conflict('the ticket is resolved; reopen it before changing its priority');
    const policy = await policyFor(tx, patch.priority, t.customer_id);
    row = await moveClock(tx, row, { targets: targetsOf(policy) }, new Date(), { priority: patch.priority, service_level_id: policy?.id ?? null });
    await eventEntry(tx, actor.tenantId, id, actor, `Priority changed from ${t.priority} to ${patch.priority} by ${actor.displayName}${policy ? '; targets follow the new priority' : '; no service level is set for it, so no timers run'}`);
    changed.push('priority');
  }
  if (changed.length) await audit(tx, actor, { action: 'ticket.updated', entityType: 'ticket', entityId: id, facilityId: t.facility_id, data: { changed } });
  return row;
}

// ---------------------------------------------------------------------------
// Status, conversation, assignment
// ---------------------------------------------------------------------------

async function lockWork(tx: Tx, actor: Actor, id: string) {
  const t = await one(tx, 'SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.work', t.facility_id);
  return t;
}

function assertMove(actor: Actor, t: any, to: Status) {
  if (!TRANSITIONS[t.status as Status].includes(to)) throw conflict(`a ticket that is ${STATUS_LABEL[t.status]!.toLowerCase()} cannot become ${STATUS_LABEL[to]!.toLowerCase()}`);
  if (t.status === 'closed') requirePermission(actor, 'tickets.manage', t.facility_id);
}

async function setStatus(tx: Tx, actor: Actor, t: any, to: Status, ev: ClockEvent = {}, note?: string | null) {
  assertMove(actor, t, to);
  const reopening = STOPPED.has(t.status) && to === 'reopened';
  const row = await moveClock(tx, t, { ...ev, status: to }, new Date(), {
    ...(reopening ? { reopened_count: t.reopened_count + 1, closed_at: null } : {}), ...(to === 'closed' ? { closed_at: new Date() } : {}),
  });
  await eventEntry(tx, actor.tenantId, t.id, actor, `Status changed from ${STATUS_LABEL[t.status]} to ${STATUS_LABEL[to]} by ${actor.displayName}${note?.trim() ? `: ${note.trim()}` : ''}`);
  await audit(tx, actor, { action: 'ticket.status', entityType: 'ticket', entityId: t.id, facilityId: t.facility_id, data: { from: t.status, to, note: note?.trim() || null } });
  return row;
}

export async function changeStatus(tx: Tx, actor: Actor, id: string, input: { status: Status; note?: string | null }) {
  const t = await lockWork(tx, actor, id);
  if (input.status === 'new') throw invalid('a ticket cannot be moved back to new');
  return setStatus(tx, actor, t, input.status, {}, input.note);
}

export type EntryKind = 'reply' | 'note' | 'customer_reply';
export async function addEntry(tx: Tx, actor: Actor, id: string, input: { kind: EntryKind; body: string; statusAfter?: Status }) {
  let t = await lockWork(tx, actor, id);
  const body = input.body?.trim();
  if (!body) throw invalid('write something first');
  if (body.length > 20_000) throw invalid('that is too long (20,000 characters at most)');
  if (t.status === 'closed') throw conflict('the ticket is closed; reopen it to add to it');
  const entry = await one(tx, `INSERT INTO ticket_entry (tenant_id, ticket_id, kind, customer_visible, author_user_id, author_name, body) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [actor.tenantId, id, input.kind, input.kind !== 'note', actor.userId, actor.displayName, body]);
  if (input.kind === 'reply') {
    // The first reply a customer can see answers the first-response target; a new ticket becomes open.
    t = (input.statusAfter && input.statusAfter !== t.status)
      ? await setStatus(tx, actor, t, input.statusAfter, { responded: true })
      : t.status === 'new' ? await setStatus(tx, actor, t, 'open', { responded: true }) : await moveClock(tx, t, { responded: true });
  } else if (input.kind === 'note') {
    if (input.statusAfter && input.statusAfter !== t.status) t = await setStatus(tx, actor, t, input.statusAfter);
  } else {
    // The customer wrote back (typed in from a call or an email): the clock starts again, a resolved ticket reopens, the owner is told.
    if (input.statusAfter) throw invalid('a customer reply sets the status itself');
    if (t.status === 'waiting_customer') t = await setStatus(tx, actor, t, 'open', {}, 'customer replied');
    else if (t.status === 'resolved') t = await setStatus(tx, actor, t, 'reopened', {}, 'customer replied');
    const who = t.assignee_user_id ? [t.assignee_user_id] : await usersWithPermission(tx, 'tickets.manage', t.facility_id);
    await notify(tx, actor.tenantId, who, { kind: 'ticket.customer_reply', title: `Customer replied on ${t.number}: ${t.subject}`, body: body.slice(0, 300), link: `/tickets/${id}`,
      subjectType: 'ticket', subjectId: id, dedupeKey: `ticket-customer-reply:${entry.id}` }, actor.userId);
  }
  await audit(tx, actor, { action: `ticket.${input.kind}`, entityType: 'ticket', entityId: id, facilityId: t.facility_id, data: { entryId: entry.id } });
  return { ...entry, status: t.status };
}

async function assignOne(tx: Tx, actor: Actor, id: string, userId: string | null) {
  const t = await one(tx, 'SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.work', t.facility_id);
  if (STOPPED.has(t.status)) throw conflict('the ticket is resolved; reopen it before assigning it');
  const toSelfOrFromSelf = userId === actor.userId || (userId === null && t.assignee_user_id === actor.userId);
  if (!toSelfOrFromSelf) requirePermission(actor, 'tickets.manage', t.facility_id);
  if (userId) await assertAssignable(tx, t.facility_id, userId);
  if (userId === t.assignee_user_id) return t;
  let row = await one(tx, 'UPDATE ticket SET assignee_user_id = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, userId]);
  if (userId && row.status === 'new') row = await moveClock(tx, row, { status: 'open' });
  const name = userId ? (await one(tx, 'SELECT display_name FROM app_user WHERE id = $1', [userId])).display_name : null;
  const entryId = await eventEntry(tx, actor.tenantId, id, actor, name ? `Assigned to ${name} by ${actor.displayName}` : `Unassigned by ${actor.displayName}`);
  await audit(tx, actor, { action: 'ticket.assigned', entityType: 'ticket', entityId: id, facilityId: t.facility_id, data: { from: t.assignee_user_id, to: userId } });
  if (userId) {
    await notify(tx, actor.tenantId, [userId], { kind: 'ticket.assigned', title: `Ticket ${t.number} assigned to you: ${t.subject}`, body: `${t.priority} priority`, link: `/tickets/${id}`,
      subjectType: 'ticket', subjectId: id, dedupeKey: `ticket-assigned:${id}:${entryId}` }, actor.userId);
  }
  return row;
}
export const assignTicket = assignOne;

/** Assigns several tickets to one person (or nobody); each ticket succeeds or fails on its own and the answer says which. */
export async function assignMany(tx: Tx, actor: Actor, ids: string[], userId: string | null) {
  const done: string[] = []; const failed: { id: string; message: string }[] = [];
  let n = 0;
  for (const id of [...new Set(ids)].slice(0, 100)) {
    const sp = `assign_${n++}`;
    await tx.query(`SAVEPOINT ${sp}`);
    try { await assignOne(tx, actor, id, userId); done.push(id); await tx.query(`RELEASE SAVEPOINT ${sp}`); } catch (e) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      failed.push({ id, message: (e as Error).message });
    }
  }
  return { assigned: done.length, failed };
}

// ---------------------------------------------------------------------------
// Time on a ticket
// ---------------------------------------------------------------------------

/**
 * Logs hours on a ticket for the person signed in: a time entry on their timesheet for that week (earning code REG). With a project on the
 * ticket the entry is source 'project' with the project (and task) and may be billable; without one it is plain manual time and never
 * billable. A week already submitted or approved is closed, as for any other hours.
 */
export async function logTime(tx: Tx, actor: Actor, ticketId: string, input: { hours: number; workDate?: string; note?: string | null; billable?: boolean; projectTaskId?: string | null }) {
  const t = await one(tx, 'SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [ticketId]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.work', t.facility_id);
  if (!actor.employeeId) throw invalid('your user is not linked to an employee record, so there is no timesheet to put the hours on');
  if (!(input.hours > 0 && input.hours <= 24)) throw invalid('hours must be more than 0 and at most 24');
  const workDate = input.workDate ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw invalid('the date is written YYYY-MM-DD');
  let billable = !!input.billable;
  if (!t.project_id) {
    if (billable) throw invalid('billable time needs a project on the ticket; link one first');
    if (input.projectTaskId) throw invalid('choose a project before choosing a task');
  } else if (input.projectTaskId) {
    const task = await one(tx, 'SELECT billable FROM project_task WHERE id = $1 AND project_id = $2 AND active', [input.projectTaskId, t.project_id]);
    if (!task) throw invalid('that task is not on the ticket’s project');
    if (billable && !task.billable) throw invalid('that task is not billable');
  }
  await assertWeekOpen(tx, actor.employeeId, workDate);
  const sheet = await getOrCreateTimesheet(tx, actor, { weekStart: workDate });
  const note = `${t.number}: ${input.note?.trim() || t.subject}`.slice(0, 500);
  const entry = await one(tx, `INSERT INTO time_entry (tenant_id, timesheet_id, work_date, earning_code, hours, source, note, created_by, project_id, project_task_id, billable)
    VALUES ($1, $2, $3, 'REG', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
  [actor.tenantId, sheet.id, workDate, input.hours, t.project_id ? 'project' : 'manual', note, actor.userId, t.project_id ?? null, input.projectTaskId ?? null, billable]);
  const row = await one(tx, `INSERT INTO ticket_time (tenant_id, ticket_id, time_entry_id, user_id, work_date, hours, billable, covered_by_retainer, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [actor.tenantId, ticketId, entry.id, actor.userId, workDate, input.hours, billable, t.retainer_covered, input.note?.trim() || null]);
  await audit(tx, actor, { action: 'ticket.time_logged', entityType: 'ticket', entityId: ticketId, facilityId: t.facility_id, data: { hours: input.hours, workDate, billable, timeEntryId: entry.id, source: t.project_id ? 'project' : 'manual' } });
  return { ...row, timesheetId: sheet.id, timeEntryId: entry.id as string };
}

export async function removeTime(tx: Tx, actor: Actor, ticketId: string, timeId: string) {
  const t = await one(tx, 'SELECT * FROM ticket WHERE id = $1', [ticketId]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.work', t.facility_id);
  const x = await one(tx, `SELECT x.*, s.status AS sheet_status FROM ticket_time x JOIN time_entry e ON e.id = x.time_entry_id JOIN timesheet s ON s.id = e.timesheet_id WHERE x.id = $1 AND x.ticket_id = $2`, [timeId, ticketId]);
  if (!x) throw notFound('time entry');
  if (x.user_id !== actor.userId && !can(actor, 'tickets.manage', t.facility_id)) throw forbidden('tickets.manage');
  if (!['draft', 'rejected'].includes(x.sheet_status)) throw conflict(`the timesheet is ${x.sheet_status}; ask an approver to reopen it first`);
  await tx.query('DELETE FROM time_entry WHERE id = $1', [x.time_entry_id]);   // the ticket_time row goes with it
  await audit(tx, actor, { action: 'ticket.time_removed', entityType: 'ticket', entityId: ticketId, facilityId: t.facility_id, data: { hours: Number(x.hours), timeEntryId: x.time_entry_id } });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const MAX_FILE = 10 * 1024 * 1024;
export async function addTicketFile(tx: Tx, actor: Actor, blobs: BlobStore, ticketId: string, input: { fileName: string; mime: string; content: Buffer }) {
  const t = await one(tx, 'SELECT facility_id FROM ticket WHERE id = $1', [ticketId]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.work', t.facility_id);
  if (!ATTACHMENT_MIME.includes(input.mime)) throw invalid(`file type ${input.mime} is not accepted (PDF, images or text)`);
  if (!input.content.length) throw invalid('the file is empty');
  if (input.content.length > MAX_FILE) throw invalid('files are limited to 10 MB');
  const stored = await blobs.put(actor.tenantId, input.content);
  const row = await one(tx, `INSERT INTO attachment (tenant_id, facility_id, subject_type, subject_id, file_name, mime, size_bytes, blob_key, sha256, restricted, uploaded_by)
    VALUES ($1, $2, 'ticket', $3, $4, $5, $6, $7, $8, false, $9) RETURNING id, file_name, mime, size_bytes, created_at`,
  [actor.tenantId, t.facility_id, ticketId, input.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 200), input.mime, input.content.length, stored.key, stored.sha256, actor.userId]);
  await audit(tx, actor, { action: 'attachment.added', entityType: 'ticket', entityId: ticketId, facilityId: t.facility_id, data: { file: row.file_name, sha256: stored.sha256 } });
  return row;
}

export async function ticketFile(tx: Tx, actor: Actor, blobs: BlobStore, ticketId: string, fileId: string) {
  const t = await one(tx, 'SELECT facility_id FROM ticket WHERE id = $1', [ticketId]);
  if (!t) throw notFound('ticket');
  requirePermission(actor, 'tickets.view', t.facility_id);
  const x = await one(tx, `SELECT * FROM attachment WHERE id = $1 AND subject_type = 'ticket' AND subject_id = $2`, [fileId, ticketId]);
  if (!x) throw notFound('file');
  return { name: x.file_name as string, mime: x.mime as string, content: await blobs.get(x.blob_key) };
}

// ---------------------------------------------------------------------------
// Lookups for the screens
// ---------------------------------------------------------------------------

export async function lookups(tx: Tx, actor: Actor, facilityId?: string) {
  requirePermission(actor, 'tickets.view');
  const sites = (await many(tx, 'SELECT id, code, name FROM facility WHERE active ORDER BY code')).filter((s) => (facilityId ? s.id === facilityId : can(actor, 'tickets.view', s.id)));
  const assignees = facilityId ? await many(tx, `SELECT id, display_name FROM app_user WHERE id = ANY ($1) ORDER BY display_name`, [await usersWithPermission(tx, 'tickets.work', facilityId)]) : [];
  return {
    sites,
    categories: await many(tx, 'SELECT id, name FROM ticket_category WHERE active ORDER BY sort_no, name'),
    cannedReplies: await many(tx, 'SELECT id, title, body FROM ticket_canned_reply WHERE active ORDER BY title'),
    assignees, priorities: PRIORITIES, statuses: STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] })), channels: CHANNELS.map((c) => ({ key: c, label: CHANNEL_LABEL[c] })),
  };
}

export async function searchCustomers(tx: Tx, actor: Actor, q?: string) {
  requirePermission(actor, 'tickets.view');
  return many(tx, `SELECT id, code, name FROM customer WHERE active AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR code ILIKE '%' || $1 || '%') ORDER BY name LIMIT 50`, [q?.trim() || null]);
}
export async function customerContacts(tx: Tx, actor: Actor, customerId: string) {
  requirePermission(actor, 'tickets.view');
  return many(tx, 'SELECT id, name, email, phone, is_primary FROM contact WHERE customer_id = $1 AND active ORDER BY is_primary DESC, name', [customerId]);
}
export async function linkOptions(tx: Tx, actor: Actor, q: { facilityId: string; customerId: string }) {
  requirePermission(actor, 'tickets.work', q.facilityId);
  return {
    projects: await many(tx, `SELECT id, number, name FROM project WHERE status IN ('proposed', 'active', 'on_hold') AND (customer_id = $1 OR customer_id IS NULL) ORDER BY number LIMIT 100`, [q.customerId]),
    assets: await many(tx, `SELECT id, asset_tag, name FROM asset WHERE facility_id = $1 AND lifecycle_status = 'active' ORDER BY asset_tag LIMIT 200`, [q.facilityId]),
    workOrders: await many(tx, `SELECT id, number, title FROM work_order WHERE facility_id = $1 AND status NOT IN ('closed', 'cancelled', 'verified') ORDER BY number DESC LIMIT 100`, [q.facilityId]),
    serviceVisits: await many(tx, `SELECT id, number, title FROM service_visit WHERE customer_id = $1 ORDER BY number DESC LIMIT 50`, [q.customerId]),
  };
}

export { ONE_HOUR_CAP };
