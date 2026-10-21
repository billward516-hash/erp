import { requirePermission } from '../../../platform/auth/actor.js';
import { audit } from '../../../platform/audit/audit.js';
import { many, one } from '../../../platform/db/tx.js';
import { postTxn } from '../../inventory/service.js';
import type { TargetDefinition } from './types.js';

/**
 * Opening stock / stock take from a storeroom export. Each row SETS the on-hand quantity at a location:
 * the difference to the current balance is posted to the ledger as an 'opening' transaction, so
 * re-importing the same file changes nothing.
 */
export const stockBalancesTarget: TargetDefinition = {
  key: 'stock_balances',
  label: 'Stock on hand (opening balances)',
  entityType: 'inventory_balance',
  description: 'On-hand quantity per part and storeroom, with optional bin and reorder settings. Parts and storerooms must exist first.',
  naturalKey: 'part_number',
  commitPermission: 'inventory.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'part_number', label: 'Part number', type: 'string', required: true,
      synonyms: ['part number', 'part no', 'item code', 'item number', 'item', 'sku', 'stock number', 'pn', 'part'] },
    { key: 'location_code', label: 'Storeroom code', type: 'string', required: true,
      synonyms: ['storeroom', 'location', 'warehouse', 'stockroom', 'crib', 'store', 'location code', 'site'] },
    { key: 'qty_on_hand', label: 'On hand', type: 'number', required: true, min: 0,
      synonyms: ['on hand', 'qty on hand', 'quantity', 'qty', 'balance', 'stock', 'quantity on hand', 'soh', 'count'] },
    { key: 'bin', label: 'Bin', type: 'string', synonyms: ['bin', 'bin location', 'shelf', 'slot', 'rack'] },
    { key: 'reorder_point', label: 'Reorder point', type: 'number', min: 0, synonyms: ['reorder point', 'min', 'minimum', 'rop', 'min qty', 'reorder level'] },
    { key: 'reorder_qty', label: 'Reorder quantity', type: 'number', min: 0, synonyms: ['reorder qty', 'reorder quantity', 'order qty', 'eoq', 'max', 'order quantity'] },
    { key: 'unit_cost', label: 'Unit cost', type: 'number', min: 0, synonyms: ['unit cost', 'cost', 'avg cost', 'average cost', 'price'] },
  ],

  async validate(ctx, rows) {
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS pn FROM part')).map((p) => [p.pn, p.id]));
    const locs = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, facility_id FROM stock_location WHERE active')).map((l) => [l.code, l]));
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const partId = v.part_number ? parts.get(String(v.part_number).toLowerCase()) : undefined;
      const loc = v.location_code ? locs.get(String(v.location_code).toLowerCase()) : undefined;
      if (v.part_number && !partId) row.messages.push({ level: 'error', field: 'part_number', message: `part "${v.part_number}" not found — import the parts list first` });
      if (v.location_code && !loc) row.messages.push({ level: 'error', field: 'location_code', message: `storeroom "${v.location_code}" not found (or you lack access)` });
      if (!partId || !loc) continue;
      v._part_id = partId; v._location_id = loc.id; v._facility_id = loc.facility_id;
      const key = `${partId}:${loc.id}`;
      if (seen.has(key)) row.messages.push({ level: 'error', message: `same part and storeroom already on row ${seen.get(key)}` }); else seen.set(key, row.rowNumber);
      const bal = await one(ctx.tx, 'SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [loc.id, partId]);
      row.action = !bal ? 'create' : Number(bal.qty_on_hand) === Number(v.qty_on_hand) ? 'unchanged' : 'update';
      if (bal && Number(bal.qty_on_hand) !== Number(v.qty_on_hand)) {
        row.messages.push({ level: 'warning', field: 'qty_on_hand', message: `on hand changes from ${bal.qty_on_hand} to ${v.qty_on_hand}` });
      }
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'inventory.manage', v._facility_id as string);
    const bal = await one(ctx.tx, 'SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [v._location_id, v._part_id]);
    const delta = Math.round((Number(v.qty_on_hand) - Number(bal?.qty_on_hand ?? 0)) * 1000) / 1000;
    if (delta !== 0) {
      await postTxn(ctx.tx, ctx.actor, { locationId: v._location_id as string, partId: v._part_id as string, type: 'opening', qty: delta,
        unitCost: (v.unit_cost as number) ?? null, reference: `import ${ctx.batchId}`, reason: `stock import from ${ctx.sourceSystem}` });
    }
    const sets: string[] = [];
    const vals: unknown[] = [v._location_id, v._part_id];
    for (const k of ['bin', 'reorder_point', 'reorder_qty']) if (v[k] != null) { vals.push(v[k]); sets.push(`${k} = $${vals.length}`); }
    if (sets.length) {
      await ctx.tx.query(`INSERT INTO inventory_balance (tenant_id, facility_id, location_id, part_id) VALUES ($3, $4, $1, $2) ON CONFLICT DO NOTHING`, [v._location_id, v._part_id, ctx.actor.tenantId, v._facility_id]);
      await ctx.tx.query(`UPDATE inventory_balance SET ${sets.join(', ')} WHERE location_id = $1 AND part_id = $2`, vals);
    }
    if (delta !== 0) await audit(ctx.tx, ctx.actor, { action: 'inventory.balance_imported', entityType: 'part', entityId: v._part_id as string, facilityId: v._facility_id as string, data: { delta, batchId: ctx.batchId } });
    return { entityId: v._part_id as string, action: delta === 0 ? (sets.length ? 'update' : 'unchanged') : bal ? 'update' : 'create' };
  },
};
