import { can } from '../../../platform/auth/actor.js';
import { many } from '../../../platform/db/tx.js';
import type { Channel } from '../../cleanroom/limits.js';
import { effectiveLimits, isChannel, judge } from '../../cleanroom/limits.js';
import { recordReading } from '../../cleanroom/service.js';
import type { FieldDef, TargetDefinition } from './types.js';

/**
 * Particle-counter and building-monitoring exports (SC-007 A, D-184A): one row per sample, with the counts per size, differential
 * pressure, temperature and humidity. Each row goes through the same path as a reading typed in the app, so a reading over an action
 * limit opens an excursion and one nonconformance, however many rows of the file are over. Rows are applied oldest first. A row for a
 * point and time that already has a reading is skipped, so loading the same file twice records nothing twice. Counts must be per cubic
 * metre; the file is read as it is (no unit conversion).
 */
const particle = (key: string, label: string, size: string, extra: string[] = []): FieldDef => ({
  key, label, type: 'number', min: 0,
  synonyms: [`${size} µm`, `${size}um`, `${size} micron`, `${size} microns`, `>=${size} µm`, `≥${size}µm`, `${size} µm count`, `${size}um count`, `particles ${size} µm`, `particles ${size}um`, `particles >=${size} µm`,
    `pc ${size}`, `p${size}`, `count ${size}um`, `${size} µm/m3`, `${size}um/m3`, `${size} µm particles`, ...extra],
});

const FIELDS: FieldDef[] = [
  { key: 'read_at', label: 'Sampled at', type: 'datetime', required: true,
    synonyms: ['date/time', 'date time', 'datetime', 'timestamp', 'sample time', 'sample date', 'sampled', 'sample start', 'start time', 'time', 'date', 'measured at', 'reading time'] },
  { key: 'room', label: 'Room', type: 'string', description: 'Room code or name. May be left out when the point is written as "room / point".', synonyms: ['room', 'cleanroom', 'room id', 'room code', 'room name', 'zone', 'area'] },
  { key: 'point', label: 'Point', type: 'string', required: true, description: 'The monitoring point in the room (its label), or "room / point".',
    synonyms: ['room/point', 'room point', 'room / point', 'sample point', 'sampling point', 'point', 'location', 'sample location', 'probe', 'sensor', 'port', 'counter', 'monitor point'] },
  particle('p0_1', '0.1 µm count (per m³)', '0.1'), particle('p0_2', '0.2 µm count (per m³)', '0.2'), particle('p0_3', '0.3 µm count (per m³)', '0.3'),
  particle('p0_5', '0.5 µm count (per m³)', '0.5'), particle('p1', '1 µm count (per m³)', '1.0', ['1 µm', '1um', '1 micron', '>=1 µm', '1.0 µm/m3']), particle('p5', '5 µm count (per m³)', '5.0', ['5 µm', '5um', '5 micron', '>=5 µm', '5.0 µm/m3']),
  { key: 'dp_pa', label: 'Differential pressure (Pa)', type: 'number', synonyms: ['dp', 'dp pa', 'delta p', 'differential pressure', 'diff pressure', 'pressure differential', 'room pressure', 'pressure', 'dp (pa)', 'pressure pa'] },
  { key: 'temp_c', label: 'Temperature (°C)', type: 'number', min: -100, max: 200, synonyms: ['temp', 'temp c', 'temp °c', 'temperature', 'temperature c', 'temp (c)', 'temperature (c)', 'temp (°c)'] },
  { key: 'rh_pct', label: 'Relative humidity (%)', type: 'number', min: 0, max: 100, synonyms: ['rh', 'rh %', 'rh (%)', 'humidity', 'humidity %', 'relative humidity', 'rel humidity', '%rh'] },
  { key: 'occupancy', label: 'Occupancy', type: 'enum', values: ['at_rest', 'operational'], description: 'Defaults to the room\'s setting',
    synonyms: ['occupancy', 'state', 'room state', 'occupancy state', 'status', 'condition'],
    valueSynonyms: { at_rest: ['at rest', 'at-rest', 'rest', 'static', 'unoccupied'], operational: ['operational', 'in operation', 'dynamic', 'working', 'in use', 'occupied'] } },
  { key: 'note', label: 'Note', type: 'text', synonyms: ['note', 'notes', 'comment', 'comments', 'remarks', 'corrective action', 'action taken'] },
  { key: 'initials', label: 'Operator', type: 'string', synonyms: ['operator', 'initials', 'sampled by', 'by', 'technician', 'tech'] },
];
const CHANNEL_FIELD: Record<string, Channel> = { p0_1: 'p0_1', p0_2: 'p0_2', p0_3: 'p0_3', p0_5: 'p0_5', p1: 'p1', p5: 'p5', dp_pa: 'dp', temp_c: 'temp', rh_pct: 'rh' };

interface Loaded { rooms: Map<string, any>; points: any[]; overrides: Map<string, any[]>; existing: Set<string> }
const key = (s: unknown) => String(s ?? '').trim().toLowerCase();

async function load(ctx: { tx: any }, from: string, to: string): Promise<Loaded> {
  const rooms = new Map<string, any>();
  const roomRows = await many(ctx.tx, 'SELECT * FROM cleanroom');
  for (const r of roomRows) { rooms.set(key(r.code), r); if (!rooms.has(key(r.name))) rooms.set(key(r.name), r); }
  const points = await many(ctx.tx, `SELECT p.*, r.code AS room_code, r.iso_class, r.alert_pct, r.active AS room_active FROM cleanroom_point p JOIN cleanroom r ON r.id = p.room_id`);
  const overrides = new Map<string, any[]>();
  for (const o of await many(ctx.tx, 'SELECT * FROM cleanroom_point_limit')) overrides.set(o.point_id, [...(overrides.get(o.point_id) ?? []), o]);
  const existing = new Set((await many(ctx.tx, 'SELECT point_id, read_at FROM cleanroom_reading WHERE read_at BETWEEN $1 AND $2', [from, to])).map((x) => `${x.point_id}|${new Date(x.read_at).toISOString()}`));
  return { rooms, points, overrides, existing };
}

/** Finds the point a row names: room and point, "room / point" in the point cell, or a point label that is unique across rooms. */
function resolve(L: Loaded, v: Record<string, unknown>): { point?: any; error?: string } {
  let room = key(v.room); let label = key(v.point);
  if (!room && label.includes('/')) { const [a, ...rest] = label.split('/'); room = key(a); label = key(rest.join('/')); }
  if (!label) return { error: 'name the monitoring point' };
  if (room) {
    const r = L.rooms.get(room);
    if (!r) return { error: `no cleanroom "${v.room ?? room}"` };
    const p = L.points.find((x) => x.room_id === r.id && key(x.label) === label);
    return p ? { point: p } : { error: `no monitoring point "${v.point}" in ${r.code}` };
  }
  const hits = L.points.filter((x) => key(x.label) === label);
  if (hits.length === 1) return { point: hits[0] };
  return { error: hits.length ? `"${v.point}" is a point in more than one room; give the room` : `no monitoring point "${v.point}"` };
}

export const cleanroomReadingsTarget: TargetDefinition = {
  key: 'cleanroom_readings',
  label: 'Cleanroom readings (particle counter files)',
  entityType: 'cleanroom_point',
  description: 'Particle counts per size (per m³), differential pressure, temperature and humidity from a particle counter or monitoring system export, for rooms and points already set up. Readings over an action limit raise one nonconformance per excursion, as in the app. A reading already recorded for the same point and time is skipped.',
  naturalKey: 'point',
  commitPermission: 'cleanroom.record',
  supportsCustomFields: false,
  fields: FIELDS,
  order: (rows) => [...rows].sort((a, b) => String(a.values.read_at ?? '').localeCompare(String(b.values.read_at ?? ''))),
  async validate(ctx, rows) {
    const times = rows.map((r) => String(r.values.read_at ?? '')).filter(Boolean).sort();
    const L = await load(ctx, times[0] ?? new Date().toISOString(), times[times.length - 1] ?? new Date().toISOString());
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      const { point, error } = resolve(L, v);
      if (!point) { row.messages.push({ level: 'error', field: 'point', message: error! }); continue; }
      if (!can(ctx.actor, 'cleanroom.record', point.facility_id)) { row.messages.push({ level: 'error', field: 'point', message: `you may not record readings at ${point.room_code}'s site` }); continue; }
      if (!point.active || !point.room_active) { row.messages.push({ level: 'error', field: 'point', message: `${point.room_code} / ${point.label} is not being monitored` }); continue; }
      v._point_id = point.id;
      const at = String(v.read_at ?? '');
      if (at && new Date(at).getTime() > Date.now() + 5 * 60_000) row.messages.push({ level: 'error', field: 'read_at', message: 'in the future' });
      const dropped: string[] = []; const values: Partial<Record<Channel, number>> = {};
      for (const [f, c] of Object.entries(CHANNEL_FIELD)) {
        if (typeof v[f] !== 'number') continue;
        if (!(point.channels as string[]).includes(c)) { dropped.push(f); delete v[f]; } else values[c] = v[f] as number;
      }
      if (dropped.length) row.messages.push({ level: 'warning', field: dropped[0]!, message: `${point.room_code} / ${point.label} does not measure ${dropped.map((f) => FIELDS.find((x) => x.key === f)!.label).join(', ')}; ignored` });
      if (!Object.keys(values).length) { row.messages.push({ level: 'error', message: 'no value to record for this point' }); continue; }
      const dupe = `${point.id}|${at}`;
      if (at && (L.existing.has(dupe) || seen.has(dupe))) { row.messages.push({ level: 'warning', field: 'read_at', message: 'a reading is already recorded for this point at this time; skipped' }); row.action = 'unchanged'; continue; }
      seen.add(dupe);
      const mine = L.overrides.get(point.id) ?? [];
      const over = (Object.entries(values) as [Channel, number][]).map(([c, x]) => judge(c, x, effectiveLimits(point.iso_class, point.alert_pct, c, mine.find((o) => o.channel === c)))).filter((b) => b);
      if (over.some((b) => b!.level === 'action')) row.messages.push({ level: 'warning', field: 'point', message: 'over an action limit; importing it opens an excursion and a nonconformance (if none is open for this point)' });
      else if (over.length) row.messages.push({ level: 'warning', field: 'point', message: 'over an alert limit; importing it notifies the room owner' });
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const pointId = String(v._point_id);
    if (row.action === 'unchanged') return { entityId: pointId, action: 'unchanged' };
    const values: Partial<Record<Channel, number>> = {};
    for (const [f, c] of Object.entries(CHANNEL_FIELD)) if (typeof v[f] === 'number' && isChannel(c)) values[c] = v[f] as number;
    const note = [v.note, v.initials ? `by ${v.initials}` : null].filter(Boolean).join(' · ') || null;
    await recordReading(ctx.tx, ctx.actor, pointId, { readAt: new Date(String(v.read_at)), occupancy: (v.occupancy as 'at_rest' | 'operational' | undefined) ?? undefined, values, note, source: 'import' });
    return { entityId: pointId, action: 'create' };
  },
};
