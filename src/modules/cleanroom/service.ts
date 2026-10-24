import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { assertAssignable, createNcr } from '../quality/service.js';
import type { Breach, Channel, Level } from './limits.js';
import { CHANNELS, CHANNEL_LABEL, classLimits, describeBreach, effectiveLimits, isChannel, isParticle, judge, worstLevel } from './limits.js';

/**
 * Cleanroom environmental monitoring (SC-007 A, D-184A): rooms with an ISO class, monitoring points with a sampling frequency,
 * append-only readings judged against limits when they are recorded, excursions (one per point while an action limit stays exceeded,
 * with one nonconformance), alerts and trends.
 */
const HOUR = 3_600_000;
const COLUMN: Record<Channel, string> = { p0_1: 'p0_1', p0_2: 'p0_2', p0_3: 'p0_3', p0_5: 'p0_5', p1: 'p1', p5: 'p5', dp: 'dp_pa', temp: 'temp_c', rh: 'rh_pct' };
const num = (v: unknown) => (v == null ? null : Number(v));
const day = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Rooms and points
// ---------------------------------------------------------------------------

export interface RoomInput { id?: string; facilityId?: string; code: string; name: string; isoClass: number; occupancy?: 'at_rest' | 'operational'; ownerUserId: string; alertPct?: number; trendCount?: number; active?: boolean }

export async function saveRoom(tx: Tx, actor: Actor, input: RoomInput) {
  const code = input.code?.trim(); const name = input.name?.trim();
  if (!code || !name) throw invalid('a room needs a code and a name');
  if (!Number.isInteger(input.isoClass) || input.isoClass < 1 || input.isoClass > 9) throw invalid('the ISO class is a whole number from 1 to 9 (ISO 14644-1)');
  const alertPct = input.alertPct ?? 80; const trendCount = input.trendCount ?? 3;
  if (!Number.isInteger(alertPct) || alertPct < 10 || alertPct > 99) throw invalid('the alert limit is 10% to 99% of the action limit');
  if (!Number.isInteger(trendCount) || trendCount < 2 || trendCount > 20) throw invalid('a trend is 2 to 20 alerts in a row');
  let room: any;
  if (input.id) {
    const cur = await one(tx, 'SELECT * FROM cleanroom WHERE id = $1 FOR UPDATE', [input.id]);
    if (!cur) throw notFound('cleanroom');
    requirePermission(actor, 'cleanroom.manage', cur.facility_id);
    if (input.ownerUserId !== cur.owner_user_id) await assertAssignable(tx, input.ownerUserId, cur.facility_id);
    room = await one(tx, `UPDATE cleanroom SET code = $2, name = $3, iso_class = $4, occupancy = $5, owner_user_id = $6, alert_pct = $7, trend_count = $8, active = $9 WHERE id = $1 RETURNING *`,
      [input.id, code, name, input.isoClass, input.occupancy ?? cur.occupancy, input.ownerUserId, alertPct, trendCount, input.active ?? cur.active]);
    await audit(tx, actor, { action: 'cleanroom.room_saved', entityType: 'cleanroom', entityId: room.id, facilityId: room.facility_id,
      data: { code, isoClass: input.isoClass, occupancy: room.occupancy, was: { isoClass: cur.iso_class, occupancy: cur.occupancy, ownerUserId: cur.owner_user_id } } });
  } else {
    if (!input.facilityId) throw invalid('choose the site');
    requirePermission(actor, 'cleanroom.manage', input.facilityId);
    await assertAssignable(tx, input.ownerUserId, input.facilityId);
    room = await one(tx, `INSERT INTO cleanroom (tenant_id, facility_id, code, name, iso_class, occupancy, owner_user_id, alert_pct, trend_count, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [actor.tenantId, input.facilityId, code, name, input.isoClass, input.occupancy ?? 'operational', input.ownerUserId, alertPct, trendCount, input.active ?? true]);
    await audit(tx, actor, { action: 'cleanroom.room_saved', entityType: 'cleanroom', entityId: room.id, facilityId: room.facility_id, data: { code, isoClass: input.isoClass, occupancy: room.occupancy } });
  }
  return room;
}

export interface PointInput { id?: string; label: string; channels: string[]; intervalHours: number; active?: boolean }

export async function savePoint(tx: Tx, actor: Actor, roomId: string, input: PointInput) {
  const room = await one(tx, 'SELECT id, facility_id, code FROM cleanroom WHERE id = $1', [roomId]);
  if (!room) throw notFound('cleanroom');
  requirePermission(actor, 'cleanroom.manage', room.facility_id);
  const label = input.label?.trim();
  if (!label) throw invalid('say where in the room this point is');
  const channels = [...new Set(input.channels)];
  if (!channels.length || channels.some((c) => !isChannel(c))) throw invalid('choose what the point measures: particle sizes, pressure, temperature, humidity');
  if (!Number.isInteger(input.intervalHours) || input.intervalHours < 1 || input.intervalHours > 24 * 366) throw invalid('the sampling frequency is a whole number of hours, at least 1');
  let p: any;
  if (input.id) {
    const cur = await one(tx, 'SELECT * FROM cleanroom_point WHERE id = $1 AND room_id = $2 FOR UPDATE', [input.id, roomId]);
    if (!cur) throw notFound('monitoring point');
    p = await one(tx, 'UPDATE cleanroom_point SET label = $2, channels = $3, interval_hours = $4, active = $5 WHERE id = $1 RETURNING *', [input.id, label, channels, input.intervalHours, input.active ?? cur.active]);
  } else {
    p = await one(tx, 'INSERT INTO cleanroom_point (tenant_id, facility_id, room_id, label, channels, interval_hours, active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [actor.tenantId, room.facility_id, roomId, label, channels, input.intervalHours, input.active ?? true]);
  }
  await audit(tx, actor, { action: 'cleanroom.point_saved', entityType: 'cleanroom', entityId: roomId, facilityId: room.facility_id, data: { room: room.code, label, channels, everyHours: input.intervalHours, active: p.active } });
  return p;
}

export interface LimitInput { alertLow?: number | null; alertHigh?: number | null; actionLow?: number | null; actionHigh?: number | null }

/**
 * Sets or clears this point's own limits, per channel (null clears back to the default). A particle channel keeps its class default for any
 * field left empty; pressure, temperature and humidity are limited only by what is set here.
 */
export async function setPointLimits(tx: Tx, actor: Actor, pointId: string, limits: Record<string, LimitInput | null>) {
  const p = await one(tx, `SELECT p.*, r.iso_class, r.alert_pct, r.code AS room_code FROM cleanroom_point p JOIN cleanroom r ON r.id = p.room_id WHERE p.id = $1 FOR UPDATE OF p`, [pointId]);
  if (!p) throw notFound('monitoring point');
  requirePermission(actor, 'cleanroom.manage', p.facility_id);
  for (const [channel, l] of Object.entries(limits)) {
    if (!isChannel(channel) || !(p.channels as string[]).includes(channel)) throw invalid(`this point does not measure ${channel}`);
    if (l === null) { await tx.query('DELETE FROM cleanroom_point_limit WHERE point_id = $1 AND channel = $2', [pointId, channel]); continue; }
    const v = { alert_low: l.alertLow ?? null, alert_high: l.alertHigh ?? null, action_low: l.actionLow ?? null, action_high: l.actionHigh ?? null };
    if (Object.values(v).some((x) => x != null && !Number.isFinite(x))) throw invalid('limits are numbers');
    if (Object.values(v).every((x) => x == null)) { await tx.query('DELETE FROM cleanroom_point_limit WHERE point_id = $1 AND channel = $2', [pointId, channel]); continue; }
    if (isParticle(channel) && (v.alert_low != null || v.action_low != null)) throw invalid('particle counts have an upper limit only');
    if ([v.alert_high, v.action_high, v.alert_low, v.action_low].some((x) => x != null && x < 0) && (isParticle(channel) || channel === 'rh')) throw invalid('this limit cannot be negative');
    const eff = effectiveLimits(p.iso_class, p.alert_pct, channel, v);
    if (eff.alertHigh != null && eff.actionHigh != null && eff.alertHigh > eff.actionHigh) throw invalid(`${CHANNEL_LABEL[channel]}: the alert limit cannot be above the action limit`);
    if (eff.alertLow != null && eff.actionLow != null && eff.alertLow < eff.actionLow) throw invalid(`${CHANNEL_LABEL[channel]}: the alert limit cannot be below the action limit`);
    if (v.action_low != null && v.action_high != null && v.action_low >= v.action_high) throw invalid(`${CHANNEL_LABEL[channel]}: the low limit must be below the high limit`);
    await tx.query(`INSERT INTO cleanroom_point_limit (tenant_id, facility_id, point_id, channel, alert_low, alert_high, action_low, action_high) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (point_id, channel) DO UPDATE SET alert_low = EXCLUDED.alert_low, alert_high = EXCLUDED.alert_high, action_low = EXCLUDED.action_low, action_high = EXCLUDED.action_high`,
    [actor.tenantId, p.facility_id, pointId, channel, v.alert_low, v.alert_high, v.action_low, v.action_high]);
  }
  await audit(tx, actor, { action: 'cleanroom.limits_set', entityType: 'cleanroom', entityId: p.room_id, facilityId: p.facility_id, data: { room: p.room_code, point: p.label, limits } });
  return pointLimits(tx, pointId);
}

/** The limits in force at a point, per channel it measures, with where each came from. */
async function pointLimits(tx: Tx, pointId: string) {
  const p = await one(tx, `SELECT p.channels, r.iso_class, r.alert_pct FROM cleanroom_point p JOIN cleanroom r ON r.id = p.room_id WHERE p.id = $1`, [pointId]);
  const rows = await many(tx, 'SELECT * FROM cleanroom_point_limit WHERE point_id = $1', [pointId]);
  return limitsFor(p, rows);
}
function limitsFor(p: { channels: string[]; iso_class: number; alert_pct: number }, overrides: any[]) {
  const by = new Map(overrides.map((o) => [o.channel as string, o]));
  return Object.fromEntries((CHANNELS.filter((c) => p.channels.includes(c))).map((c) => [c, effectiveLimits(p.iso_class, p.alert_pct, c, by.get(c))]));
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

export interface ReadingInput { readAt?: Date; occupancy?: 'at_rest' | 'operational'; values: Partial<Record<Channel, number | null>>; note?: string | null; source?: 'manual' | 'import' }

/**
 * Records a reading and judges it against the point's limits. Over an alert limit the room owner is told (one notice per point per day);
 * over an action limit an excursion opens with one nonconformance (more action readings join the open excursion, a reading back under the
 * action limit closes it); a run of alerts as long as the room's trend setting is flagged and the owner is told once per run.
 */
export async function recordReading(tx: Tx, actor: Actor, pointId: string, input: ReadingInput) {
  const p = await one(tx, `SELECT p.*, r.code AS room_code, r.name AS room_name, r.iso_class, r.occupancy AS room_occupancy, r.owner_user_id, r.alert_pct, r.trend_count, r.active AS room_active
    FROM cleanroom_point p JOIN cleanroom r ON r.id = p.room_id WHERE p.id = $1 FOR UPDATE OF p`, [pointId]);
  if (!p) throw notFound('monitoring point');
  requirePermission(actor, 'cleanroom.record', p.facility_id);
  if (!p.active || !p.room_active) throw conflict(`${p.room_code} / ${p.label} is not being monitored`);
  const at = input.readAt ?? new Date();
  if (Number.isNaN(at.getTime())) throw invalid('the reading time is not a date');
  if (at.getTime() > Date.now() + 5 * 60_000) throw invalid('the reading time is in the future');
  const values: Partial<Record<Channel, number>> = {};
  for (const [c, v] of Object.entries(input.values)) {
    if (v == null) continue;
    if (!isChannel(c)) throw invalid(`unknown measure ${c}`);
    if (!(p.channels as string[]).includes(c)) throw invalid(`${p.room_code} / ${p.label} does not measure ${CHANNEL_LABEL[c]}`);
    if (!Number.isFinite(v)) throw invalid(`${CHANNEL_LABEL[c]}: enter a number`);
    if ((isParticle(c) || c === 'rh') && v < 0) throw invalid(`${CHANNEL_LABEL[c]} cannot be negative`);
    if (c === 'rh' && v > 100) throw invalid('relative humidity is 0 to 100%');
    values[c] = v;
  }
  if (!Object.keys(values).length) throw invalid('enter at least one value');
  if (await one(tx, 'SELECT 1 FROM cleanroom_reading WHERE point_id = $1 AND read_at = $2', [pointId, at])) throw conflict('a reading is already recorded for this point at that time');

  const limits = limitsFor(p, await many(tx, 'SELECT * FROM cleanroom_point_limit WHERE point_id = $1', [pointId]));
  const breaches: Breach[] = [];
  for (const [c, v] of Object.entries(values) as [Channel, number][]) { const b = judge(c, v, limits[c]!); if (b) breaches.push(b); }
  const status = worstLevel(breaches);
  const occupancy = input.occupancy ?? p.room_occupancy;
  const cols = Object.keys(values).map((c) => COLUMN[c as Channel]);
  const r = await one(tx, `INSERT INTO cleanroom_reading (tenant_id, facility_id, point_id, read_at, occupancy, status, breaches, note, source, recorded_by, ${cols.join(', ')})
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${cols.map((_, i) => `$${i + 11}`).join(', ')}) RETURNING id`,
  [actor.tenantId, p.facility_id, pointId, at, occupancy, status, JSON.stringify(breaches), input.note?.trim() || null, input.source ?? 'manual', actor.userId, ...Object.values(values)]);

  const where = `${p.room_code} / ${p.label}`;
  const link = `/cleanrooms/${p.room_id}`;
  const open = await one(tx, 'SELECT * FROM cleanroom_excursion WHERE point_id = $1 AND ended_at IS NULL FOR UPDATE', [pointId]);
  let excursion: { id: string; opened: boolean; closed: boolean; nonconformanceId: string | null } | null = null;
  const action = breaches.filter((b) => b.level === 'action');
  if (status === 'action') {
    const peak = (prior: Record<string, { value: number; limit: number }>) => {
      const out = { ...prior };
      for (const b of action) { const o = out[b.channel]; if (!o || (b.side === 'high' ? b.value > o.value : b.value < o.value)) out[b.channel] = { value: b.value, limit: b.limit }; }
      return out;
    };
    if (!open) {
      const text = action.map(describeBreach).join('; ');
      const ncActor: Actor = { ...actor, grants: [...actor.grants, { facilityId: p.facility_id, permissions: new Set(['quality.report']), roles: new Set() }] };
      const ncr = await createNcr(tx, ncActor, { facilityId: p.facility_id, source: 'internal', severity: 'major', title: `Cleanroom action limit exceeded: ${where}`,
        description: `${p.room_name} (${p.room_code}, ISO class ${p.iso_class}, ${occupancy === 'at_rest' ? 'at rest' : 'operational'}), point "${p.label}", read ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC: ${text}.${input.note ? ` Note: ${input.note}` : ''} Raised automatically by cleanroom monitoring; later readings over the action limit join this record until a reading is back under it.` });
      const e = await one(tx, `INSERT INTO cleanroom_excursion (tenant_id, facility_id, room_id, point_id, started_at, channels, peak, nonconformance_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [actor.tenantId, p.facility_id, p.room_id, pointId, at, [...new Set(action.map((b) => b.channel))], JSON.stringify(peak({})), ncr.id]);
      await notify(tx, actor.tenantId, [p.owner_user_id], { kind: 'cleanroom.action', title: `Action limit exceeded in ${where}`, body: `${text}. ${ncr.number} has been raised.`, link,
        subjectType: 'cleanroom_excursion', subjectId: e.id, dedupeKey: `cleanroom-action:${e.id}` });
      await audit(tx, actor, { action: 'cleanroom.excursion_opened', entityType: 'cleanroom', entityId: p.room_id, facilityId: p.facility_id, data: { point: p.label, breaches: action, nonconformance: ncr.number } });
      excursion = { id: e.id, opened: true, closed: false, nonconformanceId: ncr.id };
    } else {
      const channels = [...new Set([...(open.channels as string[]), ...action.map((b) => b.channel)])];
      await tx.query('UPDATE cleanroom_excursion SET readings = readings + 1, channels = $2, peak = $3 WHERE id = $1', [open.id, channels, JSON.stringify(peak(open.peak))]);
      excursion = { id: open.id, opened: false, closed: false, nonconformanceId: open.nonconformance_id };
    }
  } else if (open && at >= new Date(open.started_at)) {
    // Only a reading at or after the excursion's start closes it; a back-filled earlier reading does not.
    await tx.query('UPDATE cleanroom_excursion SET ended_at = $2 WHERE id = $1', [open.id, at]);
    await audit(tx, actor, { action: 'cleanroom.excursion_closed', entityType: 'cleanroom', entityId: p.room_id, facilityId: p.facility_id,
      data: { point: p.label, hours: Math.round(((at.getTime() - new Date(open.started_at).getTime()) / HOUR) * 10) / 10, readings: open.readings } });
    excursion = { id: open.id, opened: false, closed: true, nonconformanceId: open.nonconformance_id };
  }

  if (status === 'alert') {
    await notify(tx, actor.tenantId, [p.owner_user_id], { kind: 'cleanroom.alert', title: `Alert limit exceeded in ${where}`, body: breaches.map(describeBreach).join('; '), link,
      subjectType: 'cleanroom', subjectId: p.room_id, dedupeKey: `cleanroom-alert:${pointId}:${day(at)}` });
  }
  // A run of readings over the alert limit (or the action limit) as long as the room's trend setting.
  let trend = false;
  if (status !== 'ok') {
    const run = await many(tx, `SELECT id, status FROM cleanroom_reading WHERE point_id = $1 AND read_at <= $2 ORDER BY read_at DESC, id DESC LIMIT 200`, [pointId, at]);
    let len = 0; for (const x of run) { if (x.status === 'ok') break; len++; }
    if (len >= p.trend_count) {
      trend = true;
      const start = run[len - 1]!.id;
      const sent = await notify(tx, actor.tenantId, [p.owner_user_id], { kind: 'cleanroom.trend', title: `Trend in ${where}: ${len} readings in a row over the alert limit`,
        body: 'Look for a cause before it reaches the action limit.', link, subjectType: 'cleanroom', subjectId: p.room_id, dedupeKey: `cleanroom-trend:${pointId}:${start}` });
      if (sent) await audit(tx, actor, { action: 'cleanroom.trend_flagged', entityType: 'cleanroom', entityId: p.room_id, facilityId: p.facility_id, data: { point: p.label, readings: len } });
    }
  }
  return { readingId: String(r.id), status: status as Level, breaches, excursion, trend };
}

// ---------------------------------------------------------------------------
// Reading the rooms
// ---------------------------------------------------------------------------

/** Active points with their latest reading, open excursion, run of alerts and whether sampling is overdue. */
async function pointOverview(tx: Tx, where: string, params: unknown[]) {
  const rows = await many(tx, `SELECT p.id, p.room_id, p.facility_id, p.label, p.channels, p.interval_hours, p.active, p.created_at,
      r.read_at AS last_read_at, r.status AS last_status, r.breaches AS last_breaches,
      e.id AS excursion_id, e.started_at AS excursion_started_at, e.nonconformance_id, n.number AS ncr_number,
      (SELECT count(*)::int FROM cleanroom_reading x WHERE x.point_id = p.id AND x.read_at > coalesce((SELECT max(o.read_at) FROM cleanroom_reading o WHERE o.point_id = p.id AND o.status = 'ok'), '-infinity'::timestamptz)) AS run,
      coalesce(r.read_at, p.created_at) + make_interval(hours => p.interval_hours) AS due_at
    FROM cleanroom_point p
    LEFT JOIN LATERAL (SELECT read_at, status, breaches FROM cleanroom_reading x WHERE x.point_id = p.id ORDER BY x.read_at DESC, x.id DESC LIMIT 1) r ON true
    LEFT JOIN cleanroom_excursion e ON e.point_id = p.id AND e.ended_at IS NULL LEFT JOIN nonconformance n ON n.id = e.nonconformance_id
    WHERE ${where} ORDER BY p.label`, params);
  const now = Date.now();
  return rows.map((p) => ({ ...p, overdue: p.active && new Date(p.due_at).getTime() < now, hours_overdue: Math.max(0, Math.floor((now - new Date(p.due_at).getTime()) / HOUR)) }));
}

const rollUp = (points: { active: boolean; excursion_id: string | null; overdue: boolean; last_status: string | null }[]) =>
  points.some((p) => p.excursion_id) ? 'action' : points.some((p) => p.last_status === 'alert') ? 'alert' : points.some((p) => p.overdue) ? 'overdue' : points.some((p) => p.last_status) ? 'ok' : 'no readings';

export async function listRooms(tx: Tx, actor: Actor, q: { facilityId?: string; all?: boolean } = {}) {
  requirePermission(actor, 'cleanroom.view', q.facilityId);
  const rooms = await many(tx, `SELECT r.*, f.code AS facility_code, f.name AS facility_name, u.display_name AS owner_name FROM cleanroom r JOIN facility f ON f.id = r.facility_id JOIN app_user u ON u.id = r.owner_user_id
    WHERE ($1::uuid IS NULL OR r.facility_id = $1) AND ($2 OR r.active) ORDER BY f.code, r.code`, [q.facilityId ?? null, !!q.all]);
  const visible = rooms.filter((r) => can(actor, 'cleanroom.view', r.facility_id));
  const points = visible.length ? await pointOverview(tx, 'p.room_id = ANY ($1) AND p.active', [visible.map((r) => r.id)]) : [];
  return visible.map((r) => {
    const ps = points.filter((p) => p.room_id === r.id);
    return { ...r, points: ps.length, open_excursions: ps.filter((p) => p.excursion_id).length, overdue_points: ps.filter((p) => p.overdue).length,
      trend_points: ps.filter((p) => p.run >= r.trend_count).length, state: rollUp(ps), can_manage: can(actor, 'cleanroom.manage', r.facility_id), can_record: can(actor, 'cleanroom.record', r.facility_id) };
  });
}

export async function getRoom(tx: Tx, actor: Actor, id: string, days = 14) {
  const room = await one(tx, `SELECT r.*, f.code AS facility_code, f.name AS facility_name, u.display_name AS owner_name FROM cleanroom r JOIN facility f ON f.id = r.facility_id JOIN app_user u ON u.id = r.owner_user_id WHERE r.id = $1`, [id]);
  if (!room) throw notFound('cleanroom');
  requirePermission(actor, 'cleanroom.view', room.facility_id);
  const ps = await pointOverview(tx, 'p.room_id = $1', [id]);
  const overrides = await many(tx, 'SELECT * FROM cleanroom_point_limit WHERE facility_id = $1 AND point_id = ANY ($2)', [room.facility_id, ps.map((p) => p.id)]);
  const points = ps.map((p) => {
    const mine = overrides.filter((o) => o.point_id === p.id);
    return { ...p, limits: limitsFor({ channels: p.channels, iso_class: room.iso_class, alert_pct: room.alert_pct }, mine), has_overrides: mine.map((o) => o.channel),
      overrides: Object.fromEntries(mine.map((o) => [o.channel, { alertLow: num(o.alert_low), alertHigh: num(o.alert_high), actionLow: num(o.action_low), actionHigh: num(o.action_high) }])), trend: p.run >= room.trend_count && p.last_status !== 'ok' && p.last_status != null,
      state: p.excursion_id ? 'action' : p.last_status === 'alert' ? 'alert' : p.overdue ? 'overdue' : p.last_status ?? 'no readings' };
  });
  const readings = await many(tx, `SELECT x.id::text AS id, x.point_id, x.read_at, x.occupancy, x.p0_1::float, x.p0_2::float, x.p0_3::float, x.p0_5::float, x.p1::float, x.p5::float, x.dp_pa::float, x.temp_c::float, x.rh_pct::float,
      x.status, x.breaches, x.note, x.source, u.display_name AS recorded_by
    FROM cleanroom_reading x JOIN cleanroom_point p ON p.id = x.point_id LEFT JOIN app_user u ON u.id = x.recorded_by
    WHERE p.room_id = $1 AND x.read_at > now() - make_interval(days => $2) ORDER BY x.read_at DESC, x.id DESC LIMIT 1500`, [id, days]);
  const excursions = await many(tx, `SELECT e.id, e.point_id, p.label AS point, e.started_at, e.ended_at, e.readings, e.channels, e.peak, e.nonconformance_id, n.number AS ncr_number
    FROM cleanroom_excursion e JOIN cleanroom_point p ON p.id = e.point_id LEFT JOIN nonconformance n ON n.id = e.nonconformance_id WHERE e.room_id = $1 ORDER BY e.started_at DESC LIMIT 30`, [id]);
  return { ...room, state: rollUp(ps), points, readings, excursions, class_limits: classLimits(room.iso_class), can_manage: can(actor, 'cleanroom.manage', room.facility_id), can_record: can(actor, 'cleanroom.record', room.facility_id) };
}

// ---------------------------------------------------------------------------
// Overdue sampling (What is late, the daily reminder and the monitoring report)
// ---------------------------------------------------------------------------

/** Active points in active rooms at the given sites whose next reading was due before now. */
export async function overduePoints(tx: Tx, facilityIds: string[]) {
  return many(tx, `SELECT p.id, p.facility_id, p.label, r.id AS room_id, r.code AS room_code, r.name AS room_name, r.owner_user_id, u.display_name AS owner_name, p.interval_hours,
      x.read_at AS last_read_at, coalesce(x.read_at, p.created_at) + make_interval(hours => p.interval_hours) AS due_at,
      floor(extract(epoch FROM now() - (coalesce(x.read_at, p.created_at) + make_interval(hours => p.interval_hours))) / 3600)::int AS hours_overdue
    FROM cleanroom_point p JOIN cleanroom r ON r.id = p.room_id JOIN app_user u ON u.id = r.owner_user_id
    LEFT JOIN LATERAL (SELECT read_at FROM cleanroom_reading y WHERE y.point_id = p.id ORDER BY y.read_at DESC LIMIT 1) x ON true
    WHERE p.active AND r.active AND p.facility_id = ANY ($1) AND coalesce(x.read_at, p.created_at) + make_interval(hours => p.interval_hours) < now() ORDER BY due_at`, [facilityIds]);
}

/** Rows for What is late. */
export async function lateSampling(tx: Tx, facilityIds: string[]) {
  return (await overduePoints(tx, facilityIds)).map((p) => ({ label: `${p.room_code} · ${p.label}`, detail: `Sampling every ${p.interval_hours} h; ${p.last_read_at ? `last reading ${new Date(p.last_read_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no reading yet'}`,
    owner: p.owner_name as string | null, daysLate: Math.floor(p.hours_overdue / 24), amount: null, href: `/cleanrooms/${p.room_id}` }));
}
