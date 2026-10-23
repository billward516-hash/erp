import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { addAction } from '../quality/service.js';

const HOUR = 3_600_000;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Condition points and readings
// ---------------------------------------------------------------------------

const limitText = (p: { low: any; high: any; unit: string }) =>
  p.low != null && p.high != null ? `${fmt(Number(p.low))}–${fmt(Number(p.high))}${p.unit}` : p.high != null ? `at most ${fmt(Number(p.high))}${p.unit}` : `at least ${fmt(Number(p.low))}${p.unit}`;
export const inRange = (p: { low: any; high: any }, v: number) => (p.low == null || v >= Number(p.low)) && (p.high == null || v <= Number(p.high));

/** Something measured on an asset, with its limits and how often it must be read (e.g. a walk-in cooler, 33–41°F, twice a day). */
export async function saveConditionPoint(tx: Tx, actor: Actor, input: { assetId: string; measure?: string; unit: string; low?: number | null; high?: number | null; intervalHours?: number | null; active?: boolean }) {
  const a = await one(tx, 'SELECT id, facility_id, asset_tag FROM asset WHERE id = $1', [input.assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'assets.manage', a.facility_id);
  if (input.low == null && input.high == null) throw invalid('set a low limit, a high limit, or both');
  if (input.low != null && input.high != null && input.low >= input.high) throw invalid('the low limit must be below the high limit');
  if (!input.unit?.trim()) throw invalid('give the unit (°F, °C, %RH…)');
  const p = await one(tx, `INSERT INTO condition_point (tenant_id, facility_id, asset_id, measure, unit, low, high, interval_hours, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (asset_id, measure) DO UPDATE SET unit = EXCLUDED.unit, low = EXCLUDED.low, high = EXCLUDED.high, interval_hours = EXCLUDED.interval_hours, active = EXCLUDED.active RETURNING *`,
  [actor.tenantId, a.facility_id, a.id, (input.measure ?? 'temperature').trim().toLowerCase(), input.unit.trim(), input.low ?? null, input.high ?? null, input.intervalHours ?? null, input.active ?? true]);
  await audit(tx, actor, { action: 'condition.point_saved', entityType: 'asset', entityId: a.id, facilityId: a.facility_id, data: { measure: p.measure, unit: p.unit, low: input.low ?? null, high: input.high ?? null, every: input.intervalHours ?? null } });
  return p;
}

/**
 * Logs a reading. Outside the limits it opens an excursion and one maintenance request (so a cooler that stays
 * warm for six readings raises one request, not six); back inside the limits it closes the excursion.
 */
export async function recordReading(tx: Tx, actor: Actor, pointId: string, input: { value: number; readAt?: Date; note?: string | null; source?: 'manual' | 'import' }) {
  const p = await one(tx, `SELECT p.*, a.asset_tag, a.name AS asset_name FROM condition_point p JOIN asset a ON a.id = p.asset_id WHERE p.id = $1 FOR UPDATE OF p`, [pointId]);
  if (!p) throw notFound('condition point');
  requirePermission(actor, 'assets.record_state', p.facility_id);
  if (!p.active) throw conflict(`${p.asset_tag} ${p.measure} is not being logged`);
  if (!Number.isFinite(input.value)) throw invalid('enter the reading as a number');
  const at = input.readAt ?? new Date();
  if (at.getTime() > Date.now() + 5 * 60_000) throw invalid('the reading time is in the future');
  const ok = inRange(p, input.value);
  const r = await one(tx, `INSERT INTO condition_reading (tenant_id, facility_id, point_id, value, in_range, read_at, note, source, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.tenantId, p.facility_id, pointId, input.value, ok, at, input.note ?? null, input.source ?? 'manual', actor.userId]);
  const open = await one(tx, 'SELECT * FROM condition_excursion WHERE point_id = $1 AND ended_at IS NULL FOR UPDATE', [pointId]);
  let excursion: { id: string; opened: boolean; closed: boolean } | null = null;
  if (!ok && !open) {
    const symptom = `${p.asset_name} (${p.asset_tag}) ${p.measure} ${fmt(input.value)}${p.unit}, limit ${limitText(p)}${input.note ? `. Note: ${input.note}` : ''}`;
    const req = await one(tx, `INSERT INTO maintenance_request (tenant_id, facility_id, asset_id, requested_by, symptom, severity, source, asset_down) VALUES ($1, $2, $3, $4, $5, 'high', 'condition', false) RETURNING id`,
      [actor.tenantId, p.facility_id, p.asset_id, actor.userId, symptom]);
    const e = await one(tx, `INSERT INTO condition_excursion (tenant_id, facility_id, point_id, started_at, first_value, worst_value, request_id) VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
      [actor.tenantId, p.facility_id, pointId, at, input.value, req.id]);
    await notify(tx, actor.tenantId, await usersWithPermission(tx, 'work_orders.manage', p.facility_id), { kind: 'maintenance.request_received',
      title: `Out of limits: ${p.asset_name} at ${fmt(input.value)}${p.unit}`, body: symptom, link: '/work-orders', subjectType: 'maintenance_request', subjectId: req.id, dedupeKey: `excursion:${e.id}` }, actor.userId);
    await audit(tx, actor, { action: 'condition.excursion_opened', entityType: 'asset', entityId: p.asset_id, facilityId: p.facility_id, data: { value: input.value, limits: limitText(p), requestId: req.id } });
    excursion = { id: e.id, opened: true, closed: false };
  } else if (!ok && open) {
    const worse = p.high != null && input.value > Number(p.high) ? Math.max(Number(open.worst_value), input.value) : Math.min(Number(open.worst_value), input.value);
    await tx.query('UPDATE condition_excursion SET worst_value = $2, readings = readings + 1 WHERE id = $1', [open.id, worse]);
    excursion = { id: open.id, opened: false, closed: false };
  } else if (ok && open && at >= new Date(open.started_at)) {
    // Only a reading at or after the excursion's start closes it; a back-filled earlier reading does not (D-161).
    await tx.query('UPDATE condition_excursion SET ended_at = $2 WHERE id = $1', [open.id, at]);
    await audit(tx, actor, { action: 'condition.excursion_closed', entityType: 'asset', entityId: p.asset_id, facilityId: p.facility_id,
      data: { hours: Math.round(((at.getTime() - new Date(open.started_at).getTime()) / HOUR) * 10) / 10, worst: Number(open.worst_value) } });
    excursion = { id: open.id, opened: false, closed: true };
  }
  return { readingId: r.id as string, inRange: ok, excursion };
}

/**
 * Points at the reader's sites with their latest reading and state: ok, out (open excursion) or missed (no
 * reading within 1.5 × the expected interval).
 */
export async function listPoints(tx: Tx, actor: Actor, q: { facilityId?: string; assetId?: string } = {}) {
  requirePermission(actor, 'assets.view', q.facilityId);
  const rows = await many(tx, `SELECT p.*, a.asset_tag, a.name AS asset_name, f.code AS facility_code, f.name AS facility_name,
      r.value AS last_value, r.read_at AS last_read_at, r.in_range AS last_in_range,
      e.id AS excursion_id, e.started_at AS excursion_started_at, e.worst_value, e.request_id
    FROM condition_point p JOIN asset a ON a.id = p.asset_id JOIN facility f ON f.id = p.facility_id
    LEFT JOIN LATERAL (SELECT value, read_at, in_range FROM condition_reading x WHERE x.point_id = p.id ORDER BY read_at DESC, id DESC LIMIT 1) r ON true
    LEFT JOIN condition_excursion e ON e.point_id = p.id AND e.ended_at IS NULL
    WHERE p.active AND ($1::uuid IS NULL OR p.facility_id = $1) AND ($2::uuid IS NULL OR p.asset_id = $2) ORDER BY f.code, a.asset_tag`, [q.facilityId ?? null, q.assetId ?? null]);
  const now = Date.now();
  return rows.filter((p) => can(actor, 'assets.view', p.facility_id)).map((p) => {
    const late = p.interval_hours && (!p.last_read_at || now - new Date(p.last_read_at).getTime() > p.interval_hours * 1.5 * HOUR);
    return { ...p, low: p.low == null ? null : Number(p.low), high: p.high == null ? null : Number(p.high), last_value: p.last_value == null ? null : Number(p.last_value),
      worst_value: p.worst_value == null ? null : Number(p.worst_value), limits: limitText(p), state: p.excursion_id ? 'out' : late ? 'missed' : p.last_read_at ? 'ok' : 'no readings' };
  });
}

export async function pointReadings(tx: Tx, actor: Actor, pointId: string, days = 14) {
  const p = await one(tx, 'SELECT facility_id FROM condition_point WHERE id = $1', [pointId]);
  if (!p) throw notFound('condition point');
  requirePermission(actor, 'assets.view', p.facility_id);
  const readings = await many(tx, `SELECT r.id, r.value::float AS value, r.in_range, r.read_at, r.note, r.source, u.display_name AS recorded_by
    FROM condition_reading r LEFT JOIN app_user u ON u.id = r.recorded_by WHERE r.point_id = $1 AND r.read_at > now() - make_interval(days => $2) ORDER BY r.read_at DESC`, [pointId, days]);
  const excursions = await many(tx, `SELECT e.id, e.started_at, e.ended_at, e.first_value::float AS first_value, e.worst_value::float AS worst_value, e.readings, e.request_id,
      (SELECT w.number FROM work_order w WHERE w.request_id = e.request_id LIMIT 1) AS work_order
    FROM condition_excursion e WHERE e.point_id = $1 ORDER BY e.started_at DESC LIMIT 20`, [pointId]);
  return { readings, excursions };
}

// ---------------------------------------------------------------------------
// Site visits (store walks, opening checklists)
// ---------------------------------------------------------------------------

export interface TemplateItem { area?: string | null; text: string; critical?: boolean }

export async function saveTemplate(tx: Tx, actor: Actor, input: { id?: string; code: string; name: string; items: TemplateItem[]; active?: boolean }) {
  requirePermission(actor, 'visits.conduct');
  if (!input.code?.trim() || !input.name?.trim()) throw invalid('a checklist needs a code and a name');
  const items = input.items.map((i) => ({ area: i.area?.trim() || null, text: i.text?.trim(), critical: !!i.critical })).filter((i) => i.text);
  if (!items.length) throw invalid('add at least one checklist item');
  const t = input.id
    ? await one(tx, 'UPDATE visit_template SET code = $2, name = $3, items = $4, active = $5 WHERE id = $1 RETURNING *', [input.id, input.code.trim(), input.name.trim(), JSON.stringify(items), input.active ?? true])
    : await one(tx, 'INSERT INTO visit_template (tenant_id, code, name, items, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [actor.tenantId, input.code.trim(), input.name.trim(), JSON.stringify(items), actor.userId]);
  if (!t) throw notFound('checklist');
  await audit(tx, actor, { action: 'visit.template_saved', entityType: 'visit_template', entityId: t.id, data: { code: t.code, items: items.length } });
  return t;
}

export async function listTemplates(tx: Tx, actor: Actor) {
  requirePermission(actor, 'visits.view');
  return many(tx, 'SELECT id, code, name, items, active FROM visit_template ORDER BY active DESC, name');
}

/** Starts a visit: the template's items are copied, so later template changes do not rewrite past visits. */
export async function startVisit(tx: Tx, actor: Actor, input: { facilityId: string; templateId: string; visitedOn?: string }) {
  requirePermission(actor, 'visits.conduct', input.facilityId);
  const t = await one(tx, 'SELECT * FROM visit_template WHERE id = $1 AND active', [input.templateId]);
  if (!t) throw invalid('choose an active checklist');
  const f = await one(tx, 'SELECT code, name FROM facility WHERE id = $1', [input.facilityId]);
  const number = `VIS-${String(await nextSequence(tx, actor.tenantId, 'site_visit')).padStart(5, '0')}`;
  const v = await one(tx, `INSERT INTO site_visit (tenant_id, facility_id, number, template_id, title, visited_by, visited_on) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, input.facilityId, number, t.id, `${t.name}, ${f.code} ${f.name}`, actor.userId, input.visitedOn ?? today()]);
  for (const [i, it] of (t.items as TemplateItem[]).entries()) {
    await tx.query('INSERT INTO site_visit_item (tenant_id, visit_id, seq, area, text, critical) VALUES ($1, $2, $3, $4, $5, $6)', [actor.tenantId, v.id, i + 1, it.area ?? null, it.text, !!it.critical]);
  }
  await audit(tx, actor, { action: 'visit.started', entityType: 'site_visit', entityId: v.id, facilityId: input.facilityId, data: { number, template: t.code } });
  return v;
}

export async function recordVisitItem(tx: Tx, actor: Actor, itemId: string, input: { result: 'pass' | 'fail' | 'na'; note?: string | null; assetId?: string | null }) {
  const it = await one(tx, 'SELECT i.*, v.facility_id, v.status, v.visited_by FROM site_visit_item i JOIN site_visit v ON v.id = i.visit_id WHERE i.id = $1', [itemId]);
  if (!it) throw notFound('checklist item');
  requirePermission(actor, 'visits.conduct', it.facility_id);
  if (it.status !== 'in_progress') throw conflict(`the visit is ${it.status}`);
  if (input.result === 'fail' && !input.note?.trim()) throw invalid('say what was wrong');
  if (input.assetId && !(await one(tx, 'SELECT 1 FROM asset WHERE id = $1 AND facility_id = $2', [input.assetId, it.facility_id]))) throw invalid('the equipment or space must be at this site');
  await tx.query('UPDATE site_visit_item SET result = $2, note = $3, asset_id = $4 WHERE id = $1', [itemId, input.result, input.note?.trim() || null, input.result === 'fail' ? input.assetId ?? null : null]);
}

/**
 * Completes the visit: every item answered; score = passed / (passed + failed). Each failed item becomes a
 * maintenance request when it names equipment or a space, otherwise an action for the store's owner of fixes.
 */
export async function completeVisit(tx: Tx, actor: Actor, visitId: string, input: { summary?: string | null; actionOwnerUserId?: string | null; actionDueDays?: number }) {
  const v = await one(tx, 'SELECT * FROM site_visit WHERE id = $1 FOR UPDATE', [visitId]);
  if (!v) throw notFound('site visit');
  requirePermission(actor, 'visits.conduct', v.facility_id);
  if (v.status !== 'in_progress') throw conflict(`the visit is ${v.status}`);
  const items = await many(tx, 'SELECT * FROM site_visit_item WHERE visit_id = $1 ORDER BY seq', [visitId]);
  const blank = items.filter((i) => !i.result).map((i) => i.seq);
  if (blank.length) throw invalid(`answer every item first (${blank.join(', ')})`);
  const failed = items.filter((i) => i.result === 'fail');
  const pass = items.filter((i) => i.result === 'pass').length;
  const needsOwner = failed.some((i) => !i.asset_id);
  if (needsOwner && !input.actionOwnerUserId) throw invalid('choose who fixes the failed items that are not maintenance');
  const due = addDays(today(), input.actionDueDays ?? 7);
  for (const i of failed) {
    if (i.asset_id) {
      const req = await one(tx, `INSERT INTO maintenance_request (tenant_id, facility_id, asset_id, requested_by, symptom, severity, source) VALUES ($1, $2, $3, $4, $5, $6, 'visit') RETURNING id`,
        [actor.tenantId, v.facility_id, i.asset_id, actor.userId, `${v.number}: ${i.text}. ${i.note}`, i.critical ? 'high' : 'medium']);
      await tx.query('UPDATE site_visit_item SET request_id = $2 WHERE id = $1', [i.id, req.id]);
    } else {
      await addAction(tx, actor, { subjectType: 'site_visit', subjectId: visitId, siteVisitItemId: i.id, title: `${i.text}: ${i.note}`.slice(0, 480), ownerUserId: input.actionOwnerUserId!, dueDate: i.critical ? addDays(today(), 1) : due });
    }
  }
  const score = pass + failed.length ? pass / (pass + failed.length) : 1;
  const critical = failed.filter((i) => i.critical).length;
  await tx.query(`UPDATE site_visit SET status = 'completed', completed_at = now(), score = $2, critical_fails = $3, summary = $4 WHERE id = $1`, [visitId, Math.round(score * 10000) / 10000, critical, input.summary?.trim() || null]);
  if (failed.length) {
    await notify(tx, actor.tenantId, (await usersWithPermission(tx, 'work_orders.request', v.facility_id)).filter((u) => u !== actor.userId), { kind: 'visit.completed',
      title: `${v.number}: ${Math.round(score * 100)}%${critical ? `, ${critical} critical` : ''} at your site`, body: failed.slice(0, 5).map((i) => `${i.text}: ${i.note}`).join('\n'),
      link: `/stores/visits/${visitId}`, subjectType: 'site_visit', subjectId: visitId, dedupeKey: `visit-done:${visitId}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'visit.completed', entityType: 'site_visit', entityId: visitId, facilityId: v.facility_id, data: { score, failed: failed.length, critical } });
  return { score, failed: failed.length, critical };
}

export async function getVisit(tx: Tx, actor: Actor, id: string) {
  const v = await one(tx, `SELECT v.*, f.code AS facility_code, f.name AS facility_name, u.display_name AS visited_by_name, t.code AS template_code
    FROM site_visit v JOIN facility f ON f.id = v.facility_id JOIN app_user u ON u.id = v.visited_by JOIN visit_template t ON t.id = v.template_id WHERE v.id = $1`, [id]);
  if (!v) throw notFound('site visit');
  requirePermission(actor, 'visits.view', v.facility_id);
  const items = await many(tx, `SELECT i.*, a.asset_tag, a.name AS asset_name, (SELECT w.id FROM work_order w WHERE w.request_id = i.request_id LIMIT 1) AS work_order_id,
      (SELECT x.status FROM action_item x WHERE x.site_visit_item_id = i.id ORDER BY x.created_at DESC LIMIT 1) AS action_status
    FROM site_visit_item i LEFT JOIN asset a ON a.id = i.asset_id WHERE i.visit_id = $1 ORDER BY i.seq`, [id]);
  const previous = await one(tx, `SELECT number, score::float AS score, visited_on FROM site_visit WHERE facility_id = $1 AND template_id = $2 AND status = 'completed' AND id <> $3
    AND visited_on <= $4 ORDER BY visited_on DESC, completed_at DESC LIMIT 1`, [v.facility_id, v.template_id, id, v.visited_on]);
  const repeats = previous ? (await many(tx, `SELECT i.text FROM site_visit_item i JOIN site_visit p ON p.id = i.visit_id WHERE p.number = $1 AND p.tenant_id = $2 AND i.result = 'fail'`, [previous.number, v.tenant_id])).map((r) => r.text) : [];
  return { ...v, score: v.score == null ? null : Number(v.score), items: items.map((i) => ({ ...i, repeat: i.result === 'fail' && repeats.includes(i.text) })), previous: previous ?? null,
    canConduct: can(actor, 'visits.conduct', v.facility_id) };
}

export async function listVisits(tx: Tx, actor: Actor, q: { facilityId?: string } = {}) {
  requirePermission(actor, 'visits.view', q.facilityId);
  const rows = await many(tx, `SELECT v.id, v.number, v.title, v.facility_id, f.code AS facility_code, v.visited_on, v.status, v.score::float AS score, v.critical_fails, u.display_name AS visited_by,
      (SELECT count(*)::int FROM site_visit_item i WHERE i.visit_id = v.id AND i.result = 'fail') AS failed,
      (SELECT count(*)::int FROM action_item x WHERE x.subject_type = 'site_visit' AND x.subject_id = v.id AND x.status = 'open') AS open_actions
    FROM site_visit v JOIN facility f ON f.id = v.facility_id JOIN app_user u ON u.id = v.visited_by
    WHERE ($1::uuid IS NULL OR v.facility_id = $1) AND v.status <> 'cancelled' ORDER BY v.visited_on DESC, v.created_at DESC LIMIT 300`, [q.facilityId ?? null]);
  return rows.filter((r) => can(actor, 'visits.view', r.facility_id));
}
