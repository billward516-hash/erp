import { many, one } from '../../../platform/db/tx.js';
import { audit } from '../../../platform/audit/audit.js';
import { createPart } from '../../parts/service.js';
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
  description: 'Maintenance spares and consumables. Stock quantities arrive with the Inventory slice; on-hand columns are preserved in custom fields.',
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
    const before = await one(ctx.tx, 'SELECT * FROM part WHERE id = $1', [existingId]);
    if (sets.length) {
      const after = await one(ctx.tx, `UPDATE part SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
      const changed = Object.keys(cols).filter((c) => JSON.stringify(before[c]) !== JSON.stringify(after[c]))
        .concat(JSON.stringify(before.custom_fields) !== JSON.stringify(after.custom_fields) ? ['custom_fields'] : []);
      await saveExternalRef(ctx, 'part', v.external_id, existingId);
      if (!changed.length) return { entityId: existingId, action: 'unchanged' };
      await audit(ctx.tx, ctx.actor, { action: 'part.updated', entityType: 'part', entityId: existingId, data: { changed, via: 'import' } });
      return { entityId: existingId, action: 'update' };
    }
    return { entityId: existingId, action: 'unchanged' };
  },
};
