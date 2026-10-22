import { many } from '../../../platform/db/tx.js';
import { recordSubgroup } from '../../spc/service.js';
import type { TargetDefinition } from './types.js';

/** Splits "25.001 25.003; 24.998" into numbers: semicolons, bars and spaces separate values; commas too when nothing else does. */
export function splitValues(raw: unknown): number[] | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return [raw];
  const s = String(raw).trim();
  let parts = s.split(/[;|\s]+/).filter(Boolean);
  if (parts.length === 1 && s.includes(',') && s.split(',').length > 2) parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  else if (parts.length === 1 && /^-?\d+,\d+$/.test(s)) parts = [s.replace(',', '.')]; // one value with a decimal comma
  else if (parts.length === 1 && s.includes(',')) parts = s.split(',').map((x) => x.trim());
  const nums = parts.map((p) => Number(p));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/**
 * Measurements from gauges, CMM exports and inspection spreadsheets. One row per subgroup: the values in one column
 * separated by spaces or semicolons, or in several columns joined by a profile template ("{X1};{X2};{X3}").
 * Rows are applied in file order; the gauge must have been in calibration when each was measured.
 */
export const spcMeasurementsTarget: TargetDefinition = {
  key: 'spc_measurements',
  label: 'SPC measurements',
  entityType: 'spc_characteristic',
  description: 'Subgroups of measurements for set-up characteristics (one row per subgroup). Control-chart signals and out-of-tolerance values alert quality as they would when typed in.',
  naturalKey: 'characteristic',
  commitPermission: 'quality.report',
  supportsCustomFields: false,
  fields: [
    { key: 'characteristic', label: 'Characteristic code', type: 'string', required: true, synonyms: ['characteristic', 'char', 'feature', 'characteristic code', 'dimension', 'balloon'] },
    { key: 'measured_at', label: 'Measured at', type: 'datetime', required: true, synonyms: ['date/time', 'timestamp', 'measured at', 'time', 'date', 'inspection date'] },
    { key: 'values', label: 'Values', type: 'string', required: true, description: 'One value, or the subgroup separated by spaces or semicolons', synonyms: ['values', 'value', 'measurement', 'reading', 'actual', 'measured'] },
    { key: 'lot', label: 'Lot', type: 'string', synonyms: ['lot', 'batch', 'heat', 'lot number'] },
    { key: 'order_number', label: 'Production order', type: 'string', synonyms: ['order', 'work order', 'job', 'mo', 'production order'] },
    { key: 'note', label: 'Note', type: 'string', synonyms: ['note', 'comment', 'remarks'] },
  ],
  async validate(ctx, rows) {
    const chars = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, subgroup_size, active FROM spc_characteristic')).map((c) => [c.code, c]));
    const orders = new Map((await many(ctx.tx, 'SELECT id, lower(number) AS number FROM production_order')).map((o) => [o.number, o.id]));
    for (const row of rows) {
      const v = row.values;
      const c = chars.get(String(v.characteristic ?? '').trim().toLowerCase());
      if (!c) row.messages.push({ level: 'error', field: 'characteristic', message: `no characteristic ${v.characteristic} (set it up under Quality → SPC first)` });
      else if (!c.active) row.messages.push({ level: 'error', field: 'characteristic', message: `${v.characteristic} is no longer measured` });
      v._characteristic_id = c?.id;
      const vals = splitValues(v.values);
      if (v.values != null && !vals) row.messages.push({ level: 'error', field: 'values', message: `"${v.values}" is not a list of numbers` });
      else if (vals && c && vals.length !== c.subgroup_size) row.messages.push({ level: 'error', field: 'values', message: `${vals.length} value${vals.length === 1 ? '' : 's'}; ${v.characteristic} is measured in subgroups of ${c.subgroup_size}` });
      v._values = vals;
      if (v.order_number) {
        v._order_id = orders.get(String(v.order_number).trim().toLowerCase());
        if (!v._order_id) row.messages.push({ level: 'warning', field: 'order_number', message: `no production order ${v.order_number}; recorded without it` });
      }
      if (v.measured_at && new Date(String(v.measured_at)).getTime() > Date.now() + 5 * 60_000) row.messages.push({ level: 'error', field: 'measured_at', message: 'in the future' });
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    await recordSubgroup(ctx.tx, ctx.actor, v._characteristic_id as string, { values: v._values as number[], measuredAt: new Date(String(v.measured_at)),
      productionOrderId: (v._order_id as string) ?? null, lot: (v.lot as string) ?? null, note: (v.note as string) ?? null, source: 'import' });
    return { entityId: v._characteristic_id as string, action: 'create' };
  },
};
