import type { Actor } from '../../platform/auth/actor.js';
import { generateToken, hashToken, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { DEFAULT_DAYS, isTimeZone, parseDays } from './hours.js';
import { PRIORITIES } from './sla.js';
import { calendarFor, refreshOpenTickets } from './service.js';

/*
 * Setup for the ticket queue: business hours and holidays (per site, site-scoped), service levels, categories and canned replies (company
 * lists, edited by anyone who manages tickets at any site), and the per-customer public links (site-scoped).
 */

// --- Business hours ---------------------------------------------------------

export async function getCalendar(tx: Tx, actor: Actor, facilityId: string) {
  requirePermission(actor, 'tickets.view', facilityId);
  const cal = await calendarFor(tx, facilityId);
  const holidays = await many(tx, `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, name, facility_id FROM ticket_holiday WHERE facility_id IS NULL OR facility_id = $1 ORDER BY day`, [facilityId]);
  return { facilityId, timeZone: cal.timeZone, days: cal.days, saved: cal.saved, holidays, defaultDays: DEFAULT_DAYS };
}

export async function saveCalendar(tx: Tx, actor: Actor, facilityId: string, input: { timeZone: string; days: unknown }) {
  requirePermission(actor, 'tickets.manage', facilityId);
  if (!isTimeZone(input.timeZone)) throw invalid(`unknown time zone ${input.timeZone}`);
  let days;
  try { days = parseDays(input.days); } catch (e) { throw invalid((e as Error).message); }
  await tx.query(`INSERT INTO ticket_calendar (tenant_id, facility_id, time_zone, days, updated_by) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (facility_id) DO UPDATE SET time_zone = EXCLUDED.time_zone, days = EXCLUDED.days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, facilityId, input.timeZone, JSON.stringify(days), actor.userId]);
  const refreshed = await refreshOpenTickets(tx, facilityId);
  await audit(tx, actor, { action: 'ticket.calendar_saved', entityType: 'facility', entityId: facilityId, facilityId, data: { timeZone: input.timeZone, days, refreshed } });
  return { refreshed };
}

export async function addHoliday(tx: Tx, actor: Actor, input: { facilityId: string | null; day: string; name: string }) {
  if (input.facilityId) requirePermission(actor, 'tickets.manage', input.facilityId); else requirePermission(actor, 'tickets.manage');
  if (!input.name?.trim()) throw invalid('name the holiday');
  const h = await one(tx, `INSERT INTO ticket_holiday (tenant_id, facility_id, day, name, created_by) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING RETURNING id, to_char(day, 'YYYY-MM-DD') AS day, name`, [actor.tenantId, input.facilityId, input.day, input.name.trim(), actor.userId]);
  if (!h) throw conflict('that day is already a holiday');
  const refreshed = await refreshOpenTickets(tx, input.facilityId);
  await audit(tx, actor, { action: 'ticket.holiday_added', entityType: 'ticket_holiday', entityId: h.id, facilityId: input.facilityId, data: { day: input.day, name: input.name.trim(), refreshed } });
  return h;
}

export async function removeHoliday(tx: Tx, actor: Actor, id: string) {
  const h = await one(tx, `SELECT id, facility_id, to_char(day, 'YYYY-MM-DD') AS day FROM ticket_holiday WHERE id = $1`, [id]);
  if (!h) throw notFound('holiday');
  if (h.facility_id) requirePermission(actor, 'tickets.manage', h.facility_id); else requirePermission(actor, 'tickets.manage');
  await tx.query('DELETE FROM ticket_holiday WHERE id = $1', [id]);
  await refreshOpenTickets(tx, h.facility_id);
  await audit(tx, actor, { action: 'ticket.holiday_removed', entityType: 'ticket_holiday', entityId: id, facilityId: h.facility_id, data: { day: h.day } });
}

// --- Service levels ---------------------------------------------------------

export async function listServiceLevels(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tickets.view');
  return many(tx, `SELECT s.id, s.name, s.priority, s.customer_id, c.name AS customer_name, s.first_response_minutes, s.resolution_minutes, s.at_risk_pct, s.active
    FROM ticket_service_level s LEFT JOIN customer c ON c.id = s.customer_id
    ORDER BY s.active DESC, CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, c.name NULLS FIRST`);
}

export interface ServiceLevelInput { id?: string; name: string; priority: string; customerId?: string | null; firstResponseMinutes?: number | null; resolutionMinutes?: number | null; atRiskPct?: number; active?: boolean }
/** Targets apply to tickets raised (or re-prioritised) after the change; a promise already made to a customer is not moved. */
export async function saveServiceLevel(tx: Tx, actor: Actor, input: ServiceLevelInput) {
  requirePermission(actor, 'tickets.manage');
  if (!input.name?.trim()) throw invalid('name the service level');
  if (!(PRIORITIES as readonly string[]).includes(input.priority)) throw invalid('priority is urgent, high, normal or low');
  const first = input.firstResponseMinutes ?? null; const res = input.resolutionMinutes ?? null;
  for (const [n, v] of [['first response', first], ['resolution', res]] as const) if (v != null && (!Number.isInteger(v) || v < 1 || v > 525_600)) throw invalid(`${n} is a whole number of business minutes`);
  if (first != null && res != null && first > res) throw invalid('the first response cannot be due after the resolution');
  const pct = input.atRiskPct ?? 80;
  if (!Number.isInteger(pct) || pct < 1 || pct > 99) throw invalid('at-risk is a percentage between 1 and 99');
  if (input.customerId && !(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw invalid('unknown customer');
  try {
    const row = input.id
      ? await one(tx, `UPDATE ticket_service_level SET name = $2, priority = $3, customer_id = $4, first_response_minutes = $5, resolution_minutes = $6, at_risk_pct = $7, active = $8, updated_at = now()
          WHERE id = $1 RETURNING *`, [input.id, input.name.trim(), input.priority, input.customerId ?? null, first, res, pct, input.active ?? true])
      : await one(tx, `INSERT INTO ticket_service_level (tenant_id, name, priority, customer_id, first_response_minutes, resolution_minutes, at_risk_pct, active, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [actor.tenantId, input.name.trim(), input.priority, input.customerId ?? null, first, res, pct, input.active ?? true, actor.userId]);
    if (!row) throw notFound('service level');
    await audit(tx, actor, { action: 'ticket.service_level_saved', entityType: 'ticket_service_level', entityId: row.id, data: { priority: row.priority, customerId: row.customer_id, first, res, pct, active: row.active } });
    return row;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict(`there is already an active service level for ${input.priority} priority${input.customerId ? ' for this customer' : ' company-wide'}`);
    throw e;
  }
}

// --- Categories and canned replies -----------------------------------------

export async function listCategories(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tickets.view');
  return many(tx, 'SELECT id, name, sort_no, active FROM ticket_category ORDER BY active DESC, sort_no, name');
}
export async function saveCategory(tx: Tx, actor: Actor, input: { id?: string; name: string; sortNo?: number; active?: boolean }) {
  requirePermission(actor, 'tickets.manage');
  if (!input.name?.trim()) throw invalid('name the category');
  try {
    const row = input.id
      ? await one(tx, 'UPDATE ticket_category SET name = $2, sort_no = coalesce($3, sort_no), active = coalesce($4, active) WHERE id = $1 RETURNING *', [input.id, input.name.trim(), input.sortNo ?? null, input.active ?? null])
      : await one(tx, 'INSERT INTO ticket_category (tenant_id, name, sort_no) VALUES ($1, $2, $3) RETURNING *', [actor.tenantId, input.name.trim(), input.sortNo ?? 0]);
    if (!row) throw notFound('category');
    await audit(tx, actor, { action: 'ticket.category_saved', entityType: 'ticket_category', entityId: row.id, data: { name: row.name, active: row.active } });
    return row;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict(`a category named ${input.name.trim()} already exists`);
    throw e;
  }
}

export async function listCannedReplies(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tickets.view');
  return many(tx, 'SELECT id, title, body, active FROM ticket_canned_reply ORDER BY active DESC, title');
}
export async function saveCannedReply(tx: Tx, actor: Actor, input: { id?: string; title: string; body: string; active?: boolean }) {
  requirePermission(actor, 'tickets.manage');
  if (!input.title?.trim() || !input.body?.trim()) throw invalid('a canned reply needs a title and some text');
  try {
    const row = input.id
      ? await one(tx, 'UPDATE ticket_canned_reply SET title = $2, body = $3, active = coalesce($4, active) WHERE id = $1 RETURNING *', [input.id, input.title.trim(), input.body.trim(), input.active ?? null])
      : await one(tx, 'INSERT INTO ticket_canned_reply (tenant_id, title, body) VALUES ($1, $2, $3) RETURNING *', [actor.tenantId, input.title.trim(), input.body.trim()]);
    if (!row) throw notFound('canned reply');
    await audit(tx, actor, { action: 'ticket.canned_reply_saved', entityType: 'ticket_canned_reply', entityId: row.id, data: { title: row.title, active: row.active } });
    return row;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict(`a canned reply titled ${input.title.trim()} already exists`);
    throw e;
  }
}

// --- Public links, one per customer ----------------------------------------

/** Creates a link for a customer's staff; the token is shown once (only its hash is stored). */
export async function createIntakeLink(tx: Tx, actor: Actor, input: { facilityId: string; customerId: string; label: string }) {
  requirePermission(actor, 'tickets.manage', input.facilityId);
  if (!input.label?.trim()) throw invalid('label the link (for example "Acme Ltd, support portal page")');
  if (!(await one(tx, 'SELECT 1 FROM customer WHERE id = $1 AND active', [input.customerId]))) throw invalid('choose an active customer');
  const token = `tkt_${generateToken().slice(4)}`;
  const l = await one(tx, 'INSERT INTO ticket_intake_link (tenant_id, facility_id, customer_id, token_hash, label, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, label, created_at',
    [actor.tenantId, input.facilityId, input.customerId, hashToken(token), input.label.trim(), actor.userId]);
  await audit(tx, actor, { action: 'ticket_link.created', entityType: 'facility', entityId: input.facilityId, facilityId: input.facilityId, data: { linkId: l.id, customerId: input.customerId, label: l.label } });
  return { ...l, token };
}

export async function listIntakeLinks(tx: Tx, actor: Actor, facilityId: string) {
  requirePermission(actor, 'tickets.manage', facilityId);
  return many(tx, `SELECT l.id, l.label, l.active, l.created_at, c.name AS customer_name, u.display_name AS created_by,
      (SELECT count(*)::int FROM ticket t WHERE t.intake_link_id = l.id) AS tickets
    FROM ticket_intake_link l JOIN customer c ON c.id = l.customer_id JOIN app_user u ON u.id = l.created_by WHERE l.facility_id = $1 ORDER BY l.created_at DESC`, [facilityId]);
}

export async function revokeIntakeLink(tx: Tx, actor: Actor, id: string) {
  const l = await one(tx, 'SELECT * FROM ticket_intake_link WHERE id = $1 FOR UPDATE', [id]);
  if (!l) throw notFound('link');
  requirePermission(actor, 'tickets.manage', l.facility_id);
  await tx.query('UPDATE ticket_intake_link SET active = false WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'ticket_link.revoked', entityType: 'facility', entityId: l.facility_id, facilityId: l.facility_id, data: { linkId: id } });
}
