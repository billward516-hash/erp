import { many, one } from '../../../platform/db/tx.js';
import { inRange, recordReading, saveConditionPoint } from '../../storeops/service.js';
import type { TargetDefinition } from './types.js';

/**
 * Condition logs (cooler and freezer temperatures, humidity) from paper logs typed into a spreadsheet or a form
 * export: one row per reading. Each row goes through the same path as a reading taken in the app, so a reading
 * out of limits opens an excursion and a maintenance request. Rows are applied in file order.
 */
export const conditionReadingsTarget: TargetDefinition = {
  key: 'condition_readings',
  label: 'Condition readings (temperature logs)',
  entityType: 'condition_point',
  description: 'Readings for condition points already set up on assets (e.g. walk-in cooler 33–41°F). Out-of-limit readings raise requests as they would in the app.',
  naturalKey: 'asset_tag',
  commitPermission: 'assets.record_state',
  supportsCustomFields: false,
  fields: [
    { key: 'asset_tag', label: 'Equipment (asset tag)', type: 'string', required: true, synonyms: ['equipment', 'unit', 'asset', 'asset tag', 'cooler', 'equipment id'] },
    { key: 'measure', label: 'Measure', type: 'string', description: 'Defaults to temperature', synonyms: ['measure', 'reading type', 'parameter'] },
    { key: 'read_at', label: 'Read at', type: 'datetime', required: true, synonyms: ['date/time', 'timestamp', 'read at', 'time', 'date time', 'checked at'] },
    { key: 'value', label: 'Reading', type: 'number', required: true, min: -1000, synonyms: ['temp', 'temperature', 'reading', 'value', 'temp (°f)', 'temp f', 'temp (°c)', 'degrees'] },
    { key: 'note', label: 'Note / corrective action', type: 'text', synonyms: ['corrective action', 'action taken', 'comments', 'notes', 'note'] },
    { key: 'initials', label: 'Initials', type: 'string', synonyms: ['initials', 'checked by', 'employee', 'by'] },
  ],
  async validate(ctx, rows) {
    const points = new Map((await many(ctx.tx, `SELECT lower(a.asset_tag) || '|' || p.measure AS k, p.id, p.low, p.high, p.unit FROM condition_point p JOIN asset a ON a.id = p.asset_id WHERE p.active`)).map((p) => [p.k, p]));
    const last = new Map<string, string>();
    for (const row of rows) {
      const v = row.values;
      v.measure = String(v.measure ?? 'temperature').trim().toLowerCase();
      const p = points.get(`${String(v.asset_tag ?? '').toLowerCase()}|${v.measure}`);
      if (!p) { row.messages.push({ level: 'error', field: 'asset_tag', message: `no ${v.measure} log is set up for ${v.asset_tag}` }); continue; }
      const at = String(v.read_at ?? '');
      if (at && last.get(p.id) && at < last.get(p.id)!) row.messages.push({ level: 'warning', field: 'read_at', message: 'earlier than the row before for the same equipment; rows are applied in file order' });
      last.set(p.id, at);
      if (typeof v.value === 'number' && !inRange(p, v.value)) row.messages.push({ level: 'warning', field: 'value', message: `outside the limits; importing it opens an excursion and a maintenance request` });
      if (at && new Date(at).getTime() > Date.now() + 5 * 60_000) row.messages.push({ level: 'error', field: 'read_at', message: 'in the future' });
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const p = await one(ctx.tx, `SELECT p.id FROM condition_point p JOIN asset a ON a.id = p.asset_id WHERE lower(a.asset_tag) = lower($1) AND p.measure = $2`, [v.asset_tag, v.measure]);
    const note = [v.note, v.initials ? `by ${v.initials}` : null].filter(Boolean).join(' · ') || null;
    await recordReading(ctx.tx, ctx.actor, p.id, { value: v.value as number, readAt: new Date(String(v.read_at)), note, source: 'import' });
    // Readings have integer ids; the import ledger points at the condition point the reading belongs to.
    return { entityId: p.id, action: 'create' };
  },
};

/** Limits for condition logs from an equipment list (Min Temp / Max Temp / Log every columns). */
export const conditionPointsTarget: TargetDefinition = {
  key: 'condition_points',
  label: 'Condition limits (coolers, freezers)',
  entityType: 'condition_point',
  description: 'What is logged on which equipment, with its limits and how often: e.g. walk-in cooler 33–41°F every 12 h. Equipment must exist first.',
  naturalKey: 'asset_tag',
  commitPermission: 'assets.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'asset_tag', label: 'Equipment (asset tag)', type: 'string', required: true, synonyms: ['equipment', 'asset tag', 'equipment id', 'asset'] },
    { key: 'measure', label: 'Measure', type: 'string', synonyms: ['measure', 'reading type', 'parameter'] },
    { key: 'unit', label: 'Unit', type: 'string', synonyms: ['unit', 'units', 'uom', 'scale'] },
    { key: 'low', label: 'Low limit', type: 'number', min: -1000, synonyms: ['min', 'min temp', 'low', 'low limit', 'minimum'] },
    { key: 'high', label: 'High limit', type: 'number', min: -1000, synonyms: ['max', 'max temp', 'high', 'high limit', 'maximum'] },
    { key: 'interval_hours', label: 'Log every (hours)', type: 'integer', min: 1, synonyms: ['log every', 'log every (hrs)', 'interval', 'check every', 'frequency hours'] },
  ],
  async validate(ctx, rows) {
    const assets = new Map((await many(ctx.tx, 'SELECT lower(asset_tag) AS tag, id FROM asset')).map((a) => [a.tag, a.id]));
    for (const row of rows) {
      const v = row.values;
      if (!assets.has(String(v.asset_tag ?? '').toLowerCase())) row.messages.push({ level: 'error', field: 'asset_tag', message: `no equipment ${v.asset_tag}` });
      if (v.low == null && v.high == null) row.messages.push({ level: 'error', field: 'high', message: 'no limits: nothing to log for this equipment' });
      if (v.low != null && v.high != null && Number(v.low) >= Number(v.high)) row.messages.push({ level: 'error', field: 'low', message: 'the low limit is not below the high limit' });
      v.unit = v.unit ?? '°F';
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const a = await one(ctx.tx, 'SELECT id FROM asset WHERE lower(asset_tag) = lower($1)', [v.asset_tag]);
    const p = await saveConditionPoint(ctx.tx, ctx.actor, { assetId: a.id, measure: (v.measure as string) ?? 'temperature', unit: String(v.unit), low: (v.low as number) ?? null, high: (v.high as number) ?? null,
      intervalHours: (v.interval_hours as number) ?? null });
    return { entityId: p.id, action: 'create' };
  },
};
