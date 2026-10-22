import { many, one } from '../../../platform/db/tx.js';
import { audit } from '../../../platform/audit/audit.js';
import { normalizeUom } from '../../inventory/uom.js';
import { createPart, setPartUnit } from '../../parts/service.js';
import { findExternalRef, flagDuplicates, saveExternalRef } from './common.js';
import type { TargetDefinition } from './types.js';

/** Common unit-of-measure spellings -> platform UOM codes. Unrecognized units pass through upper-cased. */
export const UOM_SYNONYMS: Record<string, string[]> = {
  EA: ['ea', 'each', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'u', 'ct', 'count'],
  PR: ['pr', 'pair', 'pairs'], SET: ['set', 'sets', 'kit'], BX: ['bx', 'box', 'boxes'], CS: ['cs', 'case', 'cases'],
  PK: ['pk', 'pack', 'package', 'pkg'], RL: ['rl', 'roll', 'rolls'], FT: ['ft', 'foot', 'feet', "'"], IN: ['in', 'inch', 'inches', '"'],
  M: ['m', 'meter', 'meters', 'metre'], LB: ['lb', 'lbs', 'pound', 'pounds'], KG: ['kg', 'kilogram', 'kilograms'],
  GAL: ['gal', 'gallon', 'gallons'], QT: ['qt', 'quart', 'quarts'], L: ['l', 'liter', 'litre', 'liters', 'ltr'],
  OZ: ['oz', 'ounce', 'ounces'], DR: ['dr', 'drum', 'drums'],
};

export const partsTarget: TargetDefinition = {
  key: 'parts',
  label: 'Parts / spares master',
  entityType: 'part',
  description: 'Maintenance spares and consumables. Load on-hand quantities with the stock_balances target; unmapped columns are kept in custom fields.',
  naturalKey: 'part_number',
  commitPermission: 'parts.manage',
  supportsCustomFields: true,
  fields: [
    { key: 'external_id', label: 'Legacy record ID', type: 'string', synonyms: ['legacy id', 'record id', 'item id', 'source id'] },
    { key: 'part_number', label: 'Part number', type: 'string', required: true, maxLength: 64,
      synonyms: ['part number', 'part no', 'pn', 'item number', 'item no', 'item', 'sku', 'stock number', 'stock code', 'catalog number', 'item code', 'part', 'part id', 'material number', 'material'] },
    { key: 'description', label: 'Description', type: 'string', required: true, maxLength: 500,
      synonyms: ['description', 'item description', 'part description', 'part name', 'name', 'item name', 'material description'] },
    { key: 'uom', label: 'Unit of measure', type: 'enum', values: Object.keys(UOM_SYNONYMS), valueSynonyms: UOM_SYNONYMS, allowOther: true, maxLength: 16,
      synonyms: ['uom', 'unit', 'unit of measure', 'um', 'units', 'issue unit', 'stocking unit'] },
    { key: 'manufacturer', label: 'Manufacturer', type: 'string', synonyms: ['manufacturer', 'make', 'brand', 'oem'] },
    { key: 'manufacturer_part_number', label: 'Manufacturer part number', type: 'string',
      synonyms: ['manufacturer part number', 'mfr part number', 'mpn', 'oem part number', 'oem part', 'manufacturer part', 'vendor part number', 'supplier part number'] },
    { key: 'purchase_uom', label: 'Purchase unit', type: 'enum', values: Object.keys(UOM_SYNONYMS), valueSynonyms: UOM_SYNONYMS, allowOther: true, maxLength: 10,
      description: 'The unit it is bought in when that is not the stock unit (BOX, CASE, DRUM); with "Stock units per purchase unit"',
      synonyms: ['purchase unit', 'purchase uom', 'buy unit', 'order unit', 'po unit', 'pack unit', 'purch um'] },
    { key: 'purchase_qty', label: 'Stock units per purchase unit', type: 'number', min: 0, description: 'How many stock units are in one purchase unit (a box of 10: 10)',
      synonyms: ['pack size', 'pack qty', 'qty per pack', 'units per pack', 'conversion', 'conversion factor', 'per pack', 'case qty', 'box qty', 'purchase qty'] },
    { key: 'unit_cost', label: 'Unit cost', type: 'number', min: 0,
      synonyms: ['unit cost', 'cost', 'unit price', 'price', 'avg cost', 'average cost', 'standard cost', 'std cost', 'last cost'] },
    { key: 'active', label: 'Active', type: 'boolean', synonyms: ['active', 'status', 'item status', 'enabled'],
      valueSynonyms: { true: ['active', 'current', 'stocked', 'available', 'a'], false: ['inactive', 'obsolete', 'discontinued', 'superseded', 'do not use', 'i'] } },
  ],

  async validate(ctx, rows) {
    flagDuplicates(rows, 'part_number', 'part number');
    const existing = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS pn FROM part')).map((p) => [p.pn, p.id]));
    for (const row of rows) {
      const match = (await findExternalRef(ctx, 'part', row.values.external_id)) ?? existing.get(String(row.values.part_number ?? '').toLowerCase());
      row.action = match ? 'update' : 'create';
      if (ctx.mode === 'create_only' && match) row.messages.push({ level: 'error', field: 'part_number', message: 'part already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !match) row.messages.push({ level: 'error', field: 'part_number', message: 'part not found (mode is update only)' });
      const v = row.values;
      if (v.uom) v.uom = normalizeUom(String(v.uom));
      if (match && v.uom) {
        const cur = await one(ctx.tx, `SELECT p.uom, EXISTS (SELECT 1 FROM inventory_txn t WHERE t.part_id = p.id) AS stocked FROM part p WHERE p.id = $1`, [match]);
        if (cur && cur.uom !== v.uom && cur.stocked) row.messages.push({ level: 'error', field: 'uom', message: `stock of this part is held in ${cur.uom}; changing its stock unit to ${v.uom} would misstate it (count it out and in again, or keep ${cur.uom})` });
      }
      if (v.purchase_uom || v.purchase_qty != null) {
        const pu = v.purchase_uom ? normalizeUom(String(v.purchase_uom)) : null;
        const stock = (v.uom as string | undefined) ?? (match ? (await one(ctx.tx, 'SELECT uom FROM part WHERE id = $1', [match]))?.uom : 'EA');
        if (!pu || !(Number(v.purchase_qty) > 0)) row.messages.push({ level: 'error', field: pu ? 'purchase_qty' : 'purchase_uom', message: 'give both the purchase unit and how many stock units are in one' });
        else if (pu === stock) { v._skip_unit = true; }
        else v.purchase_uom = pu;
      }
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    const existingId = (await findExternalRef(ctx, 'part', v.external_id))
      ?? (await one(ctx.tx, 'SELECT id FROM part WHERE lower(part_number) = lower($1)', [v.part_number]))?.id;
    if (!existingId) {
      const part = await createPart(ctx.tx, ctx.actor, {
        partNumber: String(v.part_number), description: String(v.description), uom: (v.uom as string) ?? 'EA',
        manufacturer: v.manufacturer as string, manufacturerPartNumber: v.manufacturer_part_number as string,
        unitCost: v.unit_cost as number, active: (v.active as boolean) ?? true, customFields: v.custom_fields ?? {},
      });
      await saveExternalRef(ctx, 'part', v.external_id, part.id);
      await savePurchaseUnit(ctx, part.id, v);
      return { entityId: part.id, action: 'create' };
    }
    const cols: Record<string, string> = { description: 'description', uom: 'uom', manufacturer: 'manufacturer',
      manufacturer_part_number: 'manufacturer_part_number', unit_cost: 'unit_cost', active: 'active' };
    const sets: string[] = [];
    const vals: unknown[] = [existingId];
    for (const [f, col] of Object.entries(cols)) {
      if (v[f] === undefined || v[f] === null) continue;
      vals.push(v[f]);
      sets.push(`${col} = $${vals.length} `);
    }
    if (v.custom_fields && Object.keys(v.custom_fields).length) { vals.push(v.custom_fields); sets.push(`custom_fields = custom_fields || $${vals.length}`); }
    const unitChanged = await savePurchaseUnit(ctx, existingId, v);
    const before = await one(ctx.tx, 'SELECT * FROM part WHERE id = $1', [existingId]);
    if (sets.length) {
      const after = await one(ctx.tx, `UPDATE part SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
      const changed = Object.keys(cols).filter((c) => JSON.stringify(before[c]) !== JSON.stringify(after[c]))
        .concat(JSON.stringify(before.custom_fields) !== JSON.stringify(after.custom_fields) ? ['custom_fields'] : []);
      await saveExternalRef(ctx, 'part', v.external_id, existingId);
      if (!changed.length && !unitChanged) return { entityId: existingId, action: 'unchanged' };
      await audit(ctx.tx, ctx.actor, { action: 'part.updated', entityType: 'part', entityId: existingId, data: { changed, via: 'import' } });
      return { entityId: existingId, action: 'update' };
    }
    return { entityId: existingId, action: unitChanged ? 'update' : 'unchanged' };
  },
};

/** The part's purchase unit (D-143), as one of its own units; true when it changed. */
async function savePurchaseUnit(ctx: Parameters<TargetDefinition['commitRow']>[0], partId: string, v: Record<string, unknown>) {
  if (!v.purchase_uom || v._skip_unit) return false;
  const prior = await one(ctx.tx, 'SELECT per_unit::float AS per FROM part_uom WHERE part_id = $1 AND uom = $2', [partId, v.purchase_uom]);
  if (prior && prior.per === Number(v.purchase_qty)) return false;
  await setPartUnit(ctx.tx, ctx.actor, partId, { uom: String(v.purchase_uom), perUnit: Number(v.purchase_qty) });
  return true;
}
