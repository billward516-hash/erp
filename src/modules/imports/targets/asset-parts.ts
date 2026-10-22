import { requirePermission } from '../../../platform/auth/actor.js';
import { audit } from '../../../platform/audit/audit.js';
import { many, one } from '../../../platform/db/tx.js';
import type { TargetDefinition } from './types.js';

/**
 * Equipment parts lists (spares per machine), typically an OEM's recommended spares list. Rows name the machine
 * and the part by our part number or, when the list only carries the OEM's number, by manufacturer part number.
 * Re-importing updates quantities and flags; parts and machines must exist first.
 */
export const assetPartsTarget: TargetDefinition = {
  key: 'asset_parts',
  label: 'Equipment parts lists (spares per machine)',
  entityType: 'asset_part',
  description: 'Which spare parts each machine uses, how many are installed, where, and which are critical. Matches parts by part number or manufacturer part number.',
  naturalKey: 'asset_tag',
  commitPermission: 'assets.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'asset_tag', label: 'Asset tag', type: 'string', required: true, synonyms: ['asset tag', 'asset', 'machine', 'equipment', 'equipment id', 'machine id', 'tag', 'asset number'] },
    { key: 'part_number', label: 'Part number', type: 'string', synonyms: ['part number', 'our item', 'our part', 'item code', 'item number', 'stock number', 'internal p/n', 'our p/n'] },
    { key: 'manufacturer_part_number', label: 'Manufacturer part number', type: 'string',
      synonyms: ['oem p/n', 'oem part number', 'mfr p/n', 'manufacturer part number', 'mpn', 'vendor part', 'oem number'] },
    { key: 'qty_installed', label: 'Quantity installed', type: 'number', min: 0, synonyms: ['qty/machine', 'qty per machine', 'quantity installed', 'qty installed', 'qty', 'quantity', 'per machine', 'used'] },
    { key: 'position', label: 'Position on the machine', type: 'string', synonyms: ['where', 'position', 'location on machine', 'assembly', 'component', 'used on', 'area'] },
    { key: 'critical', label: 'Critical spare', type: 'boolean', synonyms: ['critical', 'critical spare', 'critical (y/n)', 'insurance spare', 'strategic'],
      valueSynonyms: { true: ['y', 'yes', 'critical', 'x', 'a'], false: ['n', 'no', '', 'b', 'c'] } },
    { key: 'min_on_hand', label: 'Keep on hand', type: 'number', min: 0, synonyms: ['min stock', 'keep on hand', 'min', 'minimum', 'recommended stock', 'stock qty', 'spares to stock'] },
    { key: 'notes', label: 'Notes', type: 'text', synonyms: ['notes', 'comment', 'remarks', 'description'] },
  ],

  async validate(ctx, rows) {
    const assets = new Map((await many(ctx.tx, 'SELECT id, lower(asset_tag) AS tag, facility_id FROM asset')).map((a) => [a.tag, a]));
    const parts = await many(ctx.tx, 'SELECT id, part_number, lower(part_number) AS pn, lower(manufacturer_part_number) AS mpn, active FROM part');
    const byPn = new Map(parts.map((p) => [p.pn, p]));
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const a = v.asset_tag ? assets.get(String(v.asset_tag).trim().toLowerCase()) : undefined;
      if (v.asset_tag && !a) row.messages.push({ level: 'error', field: 'asset_tag', message: `asset "${v.asset_tag}" not found — import the equipment register first` });
      let p = v.part_number ? byPn.get(String(v.part_number).trim().toLowerCase()) : undefined;
      if (!p && v.manufacturer_part_number) {
        const m = parts.filter((x) => x.mpn && x.mpn === String(v.manufacturer_part_number).trim().toLowerCase());
        if (m.length === 1) { p = m[0]; row.messages.push({ level: 'warning', field: 'manufacturer_part_number', message: `matched to ${p.part_number} by manufacturer part number` }); }
        else if (m.length > 1) row.messages.push({ level: 'error', field: 'manufacturer_part_number', message: `${m.length} parts share manufacturer number ${v.manufacturer_part_number}; give our part number` });
      }
      if (!p) {
        if (!row.messages.some((m) => m.field === 'manufacturer_part_number')) {
          row.messages.push({ level: 'error', field: 'part_number', message: `part ${v.part_number ?? v.manufacturer_part_number ?? '(blank)'} not found by part number or manufacturer number — add it to the parts list first` });
        }
        continue;
      }
      if (!p.active) { row.messages.push({ level: 'error', field: 'part_number', message: `${p.part_number} is inactive (superseded?); list the current part instead` }); continue; }
      if (!a) continue;
      v._asset_id = a.id; v._facility_id = a.facility_id; v._part_id = p.id;
      const key = `${a.id}:${p.id}`;
      if (seen.has(key)) { row.messages.push({ level: 'error', message: `same machine and part already on row ${seen.get(key)}` }); continue; }
      seen.set(key, row.rowNumber);
      const cur = await one(ctx.tx, 'SELECT qty_installed::float AS q, critical FROM asset_part WHERE asset_id = $1 AND part_id = $2', [a.id, p.id]);
      row.action = !cur ? 'create' : cur.q === Number(v.qty_installed ?? 1) && cur.critical === (v.critical ?? false) ? 'unchanged' : 'update';
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'assets.manage', v._facility_id as string);
    const cur = await one(ctx.tx, 'SELECT 1 FROM asset_part WHERE asset_id = $1 AND part_id = $2', [v._asset_id, v._part_id]);
    await ctx.tx.query(`INSERT INTO asset_part (tenant_id, asset_id, part_id, qty_installed, position, critical, min_on_hand, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (asset_id, part_id) DO UPDATE SET qty_installed = EXCLUDED.qty_installed, position = coalesce(EXCLUDED.position, asset_part.position),
        critical = EXCLUDED.critical, min_on_hand = coalesce(EXCLUDED.min_on_hand, asset_part.min_on_hand), notes = coalesce(EXCLUDED.notes, asset_part.notes)`,
    [ctx.actor.tenantId, v._asset_id, v._part_id, v.qty_installed ?? 1, v.position ?? null, v.critical ?? false, v.min_on_hand ?? null, v.notes ?? null]);
    if (!cur) await audit(ctx.tx, ctx.actor, { action: 'asset.part_listed', entityType: 'asset', entityId: v._asset_id as string, facilityId: v._facility_id as string, data: { partId: v._part_id, batchId: ctx.batchId } });
    return { entityId: v._asset_id as string, action: row.action === 'unchanged' ? 'unchanged' : cur ? 'update' : 'create' };
  },
};
