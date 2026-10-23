import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';

/**
 * Shift passdown (docs/ARCHITECTURE.md §12q, D-123). Writing a handover is for people who do the work (maintenance or
 * production execute); reading it for anyone who can view either. Facts come from the records, never retyped.
 */
const SUBJECT = 'shift_handover';
const CATEGORIES = ['equipment', 'quality', 'safety', 'production', 'people', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
const canWrite = (a: Actor, f: string) => can(a, 'work_orders.execute', f) || can(a, 'production.execute', f) || can(a, 'work_orders.manage', f) || can(a, 'production.manage', f);
const canView = (a: Actor, f?: string) => can(a, 'work_orders.view', f) || can(a, 'production.view', f);
const iso = (d: any) => (d instanceof Date ? d.toISOString() : String(d));

/**
 * The shift being written up: the 8 hours up to now, named by the site's local hour (shift ending 06–14 "1st",
 * 14–22 "2nd", 22–06 "3rd"). The writer can change both before handing over.
 */
export function defaultShift(now = new Date(), timeZone = 'UTC') {
  const end = new Date(now);
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(end));
  const label = h > 6 && h <= 14 ? '1st' : h > 14 && h <= 22 ? '2nd' : '3rd';
  return { label, start: new Date(end.getTime() - 8 * 3_600_000), end };
}

/** What the records say about the site over the shift window (and what is open at its end). */
export async function compileFacts(tx: Tx, facilityId: string, from: Date, to: Date) {
  const machinesDown = await many(tx, `SELECT a.id, a.asset_tag, a.name, a.operational_state AS state,
      (SELECT max(e.started_at) FROM asset_state_event e WHERE e.asset_id = a.id) AS since
    FROM asset a WHERE a.facility_id = $1 AND a.operational_state IN ('unplanned_downtime', 'out_of_service') ORDER BY a.asset_tag`, [facilityId]);
  const urgentWork = await many(tx, `SELECT w.id, w.number, w.title, w.status, w.priority, a.asset_tag FROM work_order w JOIN asset a ON a.id = w.asset_id
    WHERE w.facility_id = $1 AND w.priority <= 2 AND w.status IN ('planned', 'scheduled', 'in_progress', 'on_hold') ORDER BY w.priority, w.created_at`, [facilityId]);
  const workDone = await many(tx, `SELECT w.id, w.number, w.title, a.asset_tag FROM work_order w JOIN asset a ON a.id = w.asset_id
    WHERE w.facility_id = $1 AND w.completed_at >= $2 AND w.completed_at < $3 ORDER BY w.completed_at`, [facilityId, from, to]);
  const production = await many(tx, `SELECT wc.code AS work_center, sum(e.qty_good)::float AS good, sum(e.qty_scrap)::float AS scrap,
      (SELECT string_agg(DISTINCT e2.scrap_reason, ', ') FROM production_entry e2 JOIN production_operation o2 ON o2.id = e2.operation_id
        WHERE o2.work_center_id = wc.id AND e2.started_at >= $2 AND e2.started_at < $3 AND e2.qty_scrap > 0) AS scrap_reasons
    FROM production_entry e JOIN production_operation o ON o.id = e.operation_id JOIN work_center wc ON wc.id = o.work_center_id
    WHERE e.facility_id = $1 AND e.kind = 'run' AND e.started_at >= $2 AND e.started_at < $3 GROUP BY wc.id, wc.code ORDER BY wc.code`, [facilityId, from, to]);
  const lateOrders = await many(tx, `SELECT o.id, o.number, p.part_number, o.due_date, (o.qty - o.qty_received)::float AS remaining FROM production_order o JOIN part p ON p.id = o.part_id
    WHERE o.facility_id = $1 AND o.status IN ('released', 'in_progress') AND o.due_date < $2::date ORDER BY o.due_date LIMIT 10`, [facilityId, to]);
  const ncrs = await many(tx, `SELECT id, number, title, severity FROM nonconformance WHERE facility_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at`, [facilityId, from, to]);
  const signals = await many(tx, `SELECT s.id, c.id AS characteristic_id, c.code, s.rule, s.detail FROM spc_signal s JOIN spc_characteristic c ON c.id = s.characteristic_id
    WHERE s.facility_id = $1 AND s.status = 'open' ORDER BY s.created_at`, [facilityId]);
  const incidents = await many(tx, `SELECT id, number, kind, location FROM safety_incident WHERE facility_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at`, [facilityId, from, to]);
  const excursions = await many(tx, `SELECT x.id, a.asset_tag, p.measure, p.unit, x.worst_value::float AS worst, x.started_at FROM condition_excursion x JOIN condition_point p ON p.id = x.point_id
    JOIN asset a ON a.id = p.asset_id WHERE x.facility_id = $1 AND x.ended_at IS NULL ORDER BY x.started_at`, [facilityId]);
  return {
    compiledAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(),
    machinesDown: machinesDown.map((m) => ({ ...m, since: m.since ? iso(m.since) : null })), urgentWork, workDone,
    production, lateOrders: lateOrders.map((o) => ({ ...o, due_date: iso(o.due_date).slice(0, 10) })), ncrs, signals, incidents,
    excursions: excursions.map((x) => ({ ...x, started_at: iso(x.started_at) })),
  };
}

async function lock(tx: Tx, id: string) {
  const h = await one(tx, 'SELECT * FROM shift_handover WHERE id = $1 FOR UPDATE', [id]);
  if (!h) throw notFound('shift log');
  return h;
}

/**
 * Starts the handover for a site (or area) and shift as a draft: facts compiled for the window, and every item still open
 * on the previous handover for the same site and area carried in.
 */
export async function startHandover(tx: Tx, actor: Actor, input: { facilityId: string; area?: string | null; shiftLabel?: string; periodStart?: Date; periodEnd?: Date }) {
  if (!canWrite(actor, input.facilityId)) throw forbidden('work_orders.execute');
  const site = await one(tx, 'SELECT timezone FROM facility WHERE id = $1', [input.facilityId]);
  if (!site) throw notFound('site');
  const d = defaultShift(new Date(), site.timezone);
  const start = input.periodStart ?? d.start; const end = input.periodEnd ?? d.end;
  if (!(end > start)) throw invalid('the shift must end after it starts');
  if (end.getTime() - start.getTime() > 24 * 3_600_000) throw invalid('a shift log covers at most 24 hours');
  const area = input.area?.trim() || 'Whole site';
  const draft = await one(tx, `SELECT id FROM shift_handover WHERE facility_id = $1 AND area = $2 AND status = 'draft' AND written_by = $3`, [input.facilityId, area, actor.userId]);
  if (draft) return lock(tx, draft.id);
  const facts = await compileFacts(tx, input.facilityId, start, end);
  const h = await one(tx, `INSERT INTO shift_handover (tenant_id, facility_id, area, shift_label, period_start, period_end, facts, written_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [actor.tenantId, input.facilityId, area, input.shiftLabel?.trim() || d.label, start, end, facts, actor.userId]);
  const prev = await one(tx, `SELECT id FROM shift_handover WHERE facility_id = $1 AND area = $2 AND status <> 'draft' AND id <> $3 ORDER BY period_end DESC, created_at DESC LIMIT 1`,
    [input.facilityId, area, h.id]);
  if (prev) {
    await tx.query(`INSERT INTO shift_handover_item (tenant_id, handover_id, category, text, asset_id, work_order_id, carried_from_item_id, created_by)
      SELECT tenant_id, $2, category, text, asset_id, work_order_id, id, $3 FROM shift_handover_item WHERE handover_id = $1 AND NOT resolved`, [prev.id, h.id, actor.userId]);
  }
  await audit(tx, actor, { action: 'shift.started', entityType: SUBJECT, entityId: h.id, facilityId: input.facilityId, data: { area, shift: h.shift_label } });
  return h;
}

/** Edits a draft: notes, safety notes and items (add, change, resolve with a note). */
export async function saveHandover(tx: Tx, actor: Actor, id: string, input: { notes?: string | null; safetyNotes?: string | null;
  items?: { id?: string; category: Category; text: string; assetId?: string | null; workOrderId?: string | null; resolved?: boolean; resolvedNote?: string | null }[] }) {
  const h = await lock(tx, id);
  if (!canWrite(actor, h.facility_id)) throw forbidden('work_orders.execute');
  if (h.status !== 'draft') throw conflict('this shift log has been handed over; add to the next one');
  if (h.written_by !== actor.userId && !can(actor, 'work_orders.manage', h.facility_id) && !can(actor, 'production.manage', h.facility_id)) throw forbidden('shift log');
  await tx.query('UPDATE shift_handover SET notes = coalesce($2, notes), safety_notes = coalesce($3, safety_notes) WHERE id = $1', [id, input.notes ?? null, input.safetyNotes ?? null]);
  for (const it of input.items ?? []) {
    if (!CATEGORIES.includes(it.category)) throw invalid(`unknown category ${it.category}`);
    if (!it.text?.trim()) throw invalid('an item needs text');
    if (it.resolved && !it.resolvedNote?.trim()) throw invalid('say how the item was resolved');
    if (it.id) {
      const r = await tx.query(`UPDATE shift_handover_item SET category = $3, text = $4, asset_id = $5, work_order_id = $6, resolved = $7, resolved_note = $8 WHERE id = $1 AND handover_id = $2`,
        [it.id, id, it.category, it.text.trim(), it.assetId ?? null, it.workOrderId ?? null, !!it.resolved, it.resolvedNote?.trim() || null]);
      if (!r.rowCount) throw notFound('item');
    } else {
      await tx.query(`INSERT INTO shift_handover_item (tenant_id, handover_id, category, text, asset_id, work_order_id, resolved, resolved_note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [actor.tenantId, id, it.category, it.text.trim(), it.assetId ?? null, it.workOrderId ?? null, !!it.resolved, it.resolvedNote?.trim() || null, actor.userId]);
    }
  }
}

/** Hands over: facts are compiled again at this moment and frozen with the log; supervisors at the site are told. */
export async function handOver(tx: Tx, actor: Actor, id: string) {
  const h = await lock(tx, id);
  if (!canWrite(actor, h.facility_id)) throw forbidden('work_orders.execute');
  if (h.status !== 'draft') throw conflict('already handed over');
  // Written up near the end of the shift: what happened between starting the log and handing over belongs to it.
  const now = new Date(); let end = new Date(h.period_end);
  if (now > end && now.getTime() - end.getTime() <= 4 * 3_600_000) end = now;
  const facts = await compileFacts(tx, h.facility_id, new Date(h.period_start), end);
  await tx.query(`UPDATE shift_handover SET facts = $2, period_end = $3 WHERE id = $1`, [id, facts, end]);
  await tx.query(`UPDATE shift_handover SET status = 'handed_over', handed_over_at = now() WHERE id = $1`, [id]);
  const open = await one(tx, 'SELECT count(*)::int AS n FROM shift_handover_item WHERE handover_id = $1 AND NOT resolved', [id]);
  const who = [...new Set([...(await usersWithPermission(tx, 'work_orders.manage', h.facility_id)), ...(await usersWithPermission(tx, 'production.manage', h.facility_id))])];
  const f = await one(tx, 'SELECT code FROM facility WHERE id = $1', [h.facility_id]);
  await notify(tx, actor.tenantId, who, { kind: 'shift.handed_over', title: `${f.code} ${h.area}, ${h.shift_label} shift handed over: ${open.n} open item${open.n === 1 ? '' : 's'}, ${facts.machinesDown.length} machine${facts.machinesDown.length === 1 ? '' : 's'} down`,
    body: h.notes?.slice(0, 300) ?? null, link: `/shift-log/${id}`, subjectType: SUBJECT, subjectId: id, dedupeKey: `shift:${id}` }, actor.userId);
  await audit(tx, actor, { action: 'shift.handed_over', entityType: SUBJECT, entityId: id, facilityId: h.facility_id, data: { openItems: open.n } });
}

/** The incoming lead confirms they have read it (someone other than the writer). */
export async function acknowledge(tx: Tx, actor: Actor, id: string, note?: string | null) {
  const h = await lock(tx, id);
  if (!canWrite(actor, h.facility_id)) throw forbidden('work_orders.execute');
  if (h.status !== 'handed_over') throw conflict(h.status === 'draft' ? 'not handed over yet' : 'already acknowledged');
  if (h.written_by === actor.userId) throw invalid('the incoming shift acknowledges the handover, not its writer');
  await tx.query(`UPDATE shift_handover SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), ack_note = $3 WHERE id = $1`, [id, actor.userId, note?.trim() || null]);
  await audit(tx, actor, { action: 'shift.acknowledged', entityType: SUBJECT, entityId: id, facilityId: h.facility_id, data: { note: note ?? null } });
}

export async function getHandover(tx: Tx, actor: Actor, id: string) {
  const h = await one(tx, `SELECT h.*, f.code AS facility_code, f.name AS facility_name, w.display_name AS written_by_name, a.display_name AS acknowledged_by_name
    FROM shift_handover h JOIN facility f ON f.id = h.facility_id JOIN app_user w ON w.id = h.written_by LEFT JOIN app_user a ON a.id = h.acknowledged_by WHERE h.id = $1`, [id]);
  if (!h) throw notFound('shift log');
  if (!canView(actor, h.facility_id)) throw forbidden('work_orders.view');
  const items = await many(tx, `SELECT i.*, a.asset_tag, w.number AS work_order_number, u.display_name AS created_by_name,
      (SELECT ph.shift_label || ' ' || to_char(ph.period_end, 'YYYY-MM-DD') FROM shift_handover_item pi JOIN shift_handover ph ON ph.id = pi.handover_id WHERE pi.id = i.carried_from_item_id) AS carried_from
    FROM shift_handover_item i LEFT JOIN asset a ON a.id = i.asset_id LEFT JOIN work_order w ON w.id = i.work_order_id JOIN app_user u ON u.id = i.created_by
    WHERE i.handover_id = $1 ORDER BY i.resolved, array_position(ARRAY['safety', 'equipment', 'quality', 'production', 'people', 'other'], i.category), i.created_at`, [id]);
  // A draft shows the facts as they are now; a handed-over log shows them as they were handed over.
  const facts = h.status === 'draft' ? await compileFacts(tx, h.facility_id, new Date(h.period_start), new Date(h.period_end)) : h.facts;
  return { ...h, facts, items, canWrite: canWrite(actor, h.facility_id), mine: h.written_by === actor.userId };
}

export async function listHandovers(tx: Tx, actor: Actor, q: { facilityId?: string; limit?: number } = {}) {
  if (!canView(actor, q.facilityId)) throw forbidden('work_orders.view');
  const rows = await many(tx, `SELECT h.id, h.facility_id, f.code AS facility_code, h.area, h.shift_label, h.period_start, h.period_end, h.status, h.handed_over_at, h.acknowledged_at,
      w.display_name AS written_by, a.display_name AS acknowledged_by, jsonb_array_length(coalesce(h.facts->'machinesDown', '[]')) AS machines_down,
      (SELECT count(*)::int FROM shift_handover_item i WHERE i.handover_id = h.id AND NOT i.resolved) AS open_items,
      (SELECT count(*)::int FROM shift_handover_item i WHERE i.handover_id = h.id AND i.category = 'safety' AND NOT i.resolved) AS open_safety
    FROM shift_handover h JOIN facility f ON f.id = h.facility_id JOIN app_user w ON w.id = h.written_by LEFT JOIN app_user a ON a.id = h.acknowledged_by
    WHERE ($1::uuid IS NULL OR h.facility_id = $1) ORDER BY h.period_end DESC, h.created_at DESC LIMIT $2`, [q.facilityId ?? null, q.limit ?? 50]);
  return rows.filter((r) => canView(actor, r.facility_id));
}
