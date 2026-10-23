import { audit } from '../../../platform/audit/audit.js';
import { requirePermission } from '../../../platform/auth/actor.js';
import { many, one } from '../../../platform/db/tx.js';
import type { TargetDefinition } from './types.js';

const HOUR = 3_600_000;

export const downtimeTarget: TargetDefinition = {
  key: 'asset_downtime',
  label: 'Downtime / state log',
  entityType: 'asset_state_event',
  description: 'Historical machine state intervals (e.g. a downtime spreadsheet) used for availability and utilization history. Overlapping intervals for the same asset are rejected.',
  naturalKey: 'asset_tag',
  commitPermission: 'assets.record_state',
  supportsCustomFields: false,
  fields: [
    { key: 'asset_tag', label: 'Asset tag', type: 'string', required: true, synonyms: ['asset', 'asset tag', 'asset number', 'equipment', 'machine', 'machine number', 'equipment id', 'tag'] },
    { key: 'started_at', label: 'Start', type: 'datetime', required: true, synonyms: ['start', 'start time', 'down at', 'down time start', 'from', 'began', 'stop time', 'stopped', 'start date', 'down start'] },
    { key: 'ended_at', label: 'End', type: 'datetime', synonyms: ['end', 'end time', 'up at', 'restored', 'to', 'back up', 'restart time', 'end date', 'down end', 'up time'] },
    { key: 'duration_hours', label: 'Duration (hours)', type: 'number', min: 0, synonyms: ['duration', 'hours', 'duration hours', 'hours down', 'downtime hours', 'down hours'] },
    { key: 'state', label: 'State', type: 'enum', values: ['running', 'idle', 'planned_downtime', 'unplanned_downtime', 'out_of_service'],
      synonyms: ['state', 'status', 'type', 'downtime type', 'event type', 'category'],
      valueSynonyms: { unplanned_downtime: ['unplanned', 'breakdown', 'down', 'failure', 'unscheduled', 'bd', 'u'], planned_downtime: ['planned', 'pm', 'scheduled', 'changeover', 'setup', 'p'],
        out_of_service: ['oos', 'out of service', 'locked out', 'loto'], idle: ['idle', 'no demand', 'no work', 'starved', 'blocked'], running: ['run', 'running', 'up', 'producing'] } },
    { key: 'reason_code', label: 'Reason code', type: 'string', synonyms: ['reason', 'reason code', 'cause', 'downtime reason', 'code'] },
    { key: 'note', label: 'Note', type: 'text', synonyms: ['note', 'notes', 'comment', 'comments', 'description', 'details'] },
  ],

  async validate(ctx, rows) {
    const assets = new Map((await many(ctx.tx, 'SELECT id, asset_tag, facility_id FROM asset')).map((a) => [String(a.asset_tag).toLowerCase(), a]));
    const reasons = new Set((await many(ctx.tx, 'SELECT code FROM downtime_reason')).map((r) => String(r.code).toLowerCase()));
    const perAsset = new Map<string, { start: number; end: number; row: number }[]>();
    for (const row of rows) {
      const v = row.values;
      const asset = v.asset_tag ? assets.get(String(v.asset_tag).toLowerCase()) : undefined;
      if (!asset) { row.messages.push({ level: 'error', field: 'asset_tag', message: `asset "${v.asset_tag ?? ''}" not found` }); continue; }
      v._asset_id = asset.id;
      v._facility_id = asset.facility_id;
      v.state ??= 'unplanned_downtime';
      if (!v.ended_at && v.duration_hours != null && v.started_at) {
        v.ended_at = new Date(new Date(String(v.started_at)).getTime() + Number(v.duration_hours) * HOUR).toISOString();
      }
      if (!v.ended_at) { row.messages.push({ level: 'error', field: 'ended_at', message: 'an end time or a duration is required for historical intervals' }); continue; }
      const start = new Date(String(v.started_at)).getTime();
      const end = new Date(String(v.ended_at)).getTime();
      if (!(end > start)) { row.messages.push({ level: 'error', field: 'ended_at', message: 'end must be after start' }); continue; }
      if (end > Date.now()) row.messages.push({ level: 'error', field: 'ended_at', message: 'interval ends in the future' });
      if (v.reason_code && !reasons.has(String(v.reason_code).toLowerCase())) {
        row.messages.push({ level: 'warning', field: 'reason_code', message: `reason "${v.reason_code}" is not a configured reason code; kept in the note` });
        v.note = [v.note, `reason: ${v.reason_code}`].filter(Boolean).join(' — ');
        v.reason_code = null;
      }
      const list = perAsset.get(asset.id) ?? [];
      const clash = list.find((i) => start < i.end && end > i.start);
      if (clash) row.messages.push({ level: 'error', message: `overlaps row ${clash.row} for the same asset` });
      list.push({ start, end, row: row.rowNumber });
      perAsset.set(asset.id, list);
      const dbClash = await one(ctx.tx, `SELECT 1 FROM asset_state_event WHERE asset_id = $1 AND tstzrange(started_at, coalesce(ended_at, 'infinity')) && tstzrange($2, $3)`,
        [asset.id, v.started_at, v.ended_at]);
      if (dbClash) row.messages.push({ level: 'error', message: 'overlaps state history already recorded for this asset' });
      row.action = 'create';
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'assets.record_state', v._facility_id as string);
    const reason = v.reason_code ? await one(ctx.tx, 'SELECT code FROM downtime_reason WHERE lower(code) = lower($1)', [v.reason_code]) : null;
    const ev = await one(
      ctx.tx,
      `INSERT INTO asset_state_event (tenant_id, facility_id, asset_id, state, reason_code, started_at, ended_at, source, note, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'import', $8, $9) RETURNING id`,
      [ctx.actor.tenantId, v._facility_id, v._asset_id, v.state, reason?.code ?? null, v.started_at, v.ended_at, v.note ?? null, ctx.actor.userId],
    );
    await audit(ctx.tx, ctx.actor, { action: 'asset.state_imported', entityType: 'asset', entityId: v._asset_id as string, facilityId: v._facility_id as string,
      data: { eventId: ev.id, state: v.state, startedAt: v.started_at, endedAt: v.ended_at, batchId: ctx.batchId } });
    return { entityId: ev.id, action: 'create' };
  },
};
