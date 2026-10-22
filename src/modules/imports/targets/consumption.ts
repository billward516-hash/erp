import { many } from '../../../platform/db/tx.js';
import { saveConsumptionRate } from '../../planning/service.js';
import type { TargetDefinition } from './types.js';

/**
 * Consumables and chemicals usage as plants keep it: "coolant concentrate, 0.5 gal per 10 machine hours on the lathes",
 * "1 insert per 120 parts", "wash detergent 2 drums a month". Quantity and "per" are separate so a sheet that says
 * "1 per 120" needs no arithmetic; the rate is quantity ÷ per. Rows set the rate in force at the batch's site.
 */
export const consumptionRatesTarget: TargetDefinition = {
  key: 'consumption_rates',
  label: 'Consumables and chemicals usage',
  entityType: 'consumption_rate',
  description: 'How much of a consumable or chemical a work center uses per machine hour, per part made, or per month. Feeds the material plan and its cost forecast.',
  naturalKey: 'part_number',
  commitPermission: 'planning.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'work_center', label: 'Work center code', type: 'string', description: 'Blank for site-wide monthly usage', synonyms: ['work center', 'workcenter', 'cell', 'line', 'department', 'area', 'machine group'] },
    { key: 'part_number', label: 'Part number', type: 'string', required: true, synonyms: ['part', 'part number', 'item', 'material', 'chemical', 'consumable', 'sku'] },
    { key: 'qty', label: 'Quantity', type: 'number', required: true, min: 0, synonyms: ['qty', 'quantity', 'usage', 'amount', 'consumption', 'rate'] },
    { key: 'per', label: 'Per (how many hours, parts or months)', type: 'number', min: 0, description: 'Default 1', synonyms: ['per', 'per qty', 'every', 'for every'] },
    { key: 'basis', label: 'Basis', type: 'enum', required: true, values: ['machine_hour', 'unit', 'month'], synonyms: ['basis', 'unit of usage', 'driver', 'per what', 'usage basis'],
      valueSynonyms: { machine_hour: ['hour', 'hours', 'hr', 'hrs', 'machine hour', 'machine hours', 'run hour', 'run hours', 'spindle hour', 'per hour', '/hr'],
        unit: ['part', 'parts', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'each', 'per part', 'per piece', '/pc'], month: ['month', 'months', 'monthly', 'mo', 'per month', '/mo'] } },
    { key: 'note', label: 'Note', type: 'string', synonyms: ['note', 'notes', 'comment', 'remarks', 'source'] },
  ],
  async validate(ctx, rows) {
    if (!ctx.facilityId) for (const r of rows) r.messages.push({ level: 'error', message: 'choose the site these rates are for (the import\'s facility)' });
    const wcs = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code FROM work_center WHERE facility_id = $1', [ctx.facilityId])).map((w) => [w.code, w.id]));
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS pn FROM part WHERE active')).map((p) => [p.pn, p.id]));
    for (const row of rows) {
      const v = row.values;
      v._part_id = parts.get(String(v.part_number ?? '').trim().toLowerCase());
      if (!v._part_id) row.messages.push({ level: 'error', field: 'part_number', message: `no active part ${v.part_number} (load the consumable into the part master first)` });
      if (v.work_center) {
        v._wc = wcs.get(String(v.work_center).trim().toLowerCase());
        if (!v._wc) row.messages.push({ level: 'error', field: 'work_center', message: `no work center ${v.work_center} at this site` });
      } else if (v.basis && v.basis !== 'month') row.messages.push({ level: 'error', field: 'work_center', message: 'per hour and per part usage needs a work center' });
      const per = v.per == null ? 1 : Number(v.per);
      if (!(per > 0)) row.messages.push({ level: 'error', field: 'per', message: '"per" must be more than 0' });
      v._rate = per > 0 && v.qty != null ? Number(v.qty) / per : null;
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const r = await saveConsumptionRate(ctx.tx, ctx.actor, { facilityId: ctx.facilityId!, partId: v._part_id as string, workCenterId: (v._wc as string) ?? null, basis: v.basis as any,
      rate: v._rate as number, note: (v.note as string) ?? null });
    return { entityId: r?.id ?? (v._part_id as string), action: 'create' };
  },
};
