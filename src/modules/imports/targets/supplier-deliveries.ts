import { many, one } from '../../../platform/db/tx.js';
import type { TargetDefinition } from './types.js';

/**
 * Purchase receipt history from the previous system (a "PO receipts" or "vendor delivery" report): one row per order
 * line with its due date, when it was received and how much was rejected. Feeds supplier scorecards from day one;
 * these are records of what happened, not orders to receive against. Re-importing the same report updates the rows.
 */
export const supplierDeliveriesTarget: TargetDefinition = {
  key: 'supplier_deliveries',
  label: 'Supplier delivery history',
  entityType: 'supplier',
  description: 'Past purchase order lines with due and received dates and rejected quantities, for supplier scorecards. Suppliers must be loaded first.',
  naturalKey: 'reference',
  commitPermission: 'purchasing.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'supplier', label: 'Supplier code or name', type: 'string', required: true, synonyms: ['supplier', 'vendor', 'vendor id', 'vendor code', 'supplier code', 'vendor name', 'supplier name'] },
    { key: 'reference', label: 'PO and line', type: 'string', required: true, description: 'Unique per supplier, e.g. 4500123-10', synonyms: ['po', 'po number', 'po#', 'purchase order', 'order', 'po line', 'reference'] },
    { key: 'part_number', label: 'Part number', type: 'string', synonyms: ['part', 'item', 'material', 'part number', 'item number'] },
    { key: 'description', label: 'Description', type: 'string', synonyms: ['description', 'item description', 'material description'] },
    { key: 'qty_ordered', label: 'Quantity ordered', type: 'number', required: true, min: 0, synonyms: ['qty ordered', 'order qty', 'ordered', 'po qty', 'quantity'] },
    { key: 'due_on', label: 'Due date', type: 'date', required: true, synonyms: ['due', 'due date', 'promised', 'promise date', 'need date', 'delivery date', 'expected'] },
    { key: 'received_on', label: 'Received date', type: 'date', synonyms: ['received', 'receipt date', 'received date', 'gr date', 'date received', 'last receipt'] },
    { key: 'qty_received', label: 'Quantity received', type: 'number', min: 0, synonyms: ['qty received', 'received qty', 'gr qty', 'receipt qty'] },
    { key: 'qty_rejected', label: 'Quantity rejected', type: 'number', min: 0, synonyms: ['rejected', 'qty rejected', 'rejects', 'returned', 'nonconforming', 'mrb qty'] },
    { key: 'unit_price', label: 'Unit price', type: 'number', min: 0, synonyms: ['price', 'unit price', 'unit cost', 'po price'] },
  ],
  async validate(ctx, rows) {
    if (!ctx.facilityId) for (const r of rows) r.messages.push({ level: 'error', message: 'choose the site these deliveries were received at (the import\'s facility)' });
    const sups = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM supplier')).flatMap((x) => [[x.code, x.id], [x.name, x.id]]));
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS pn FROM part')).map((p) => [p.pn, p.id]));
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      v._supplier_id = sups.get(String(v.supplier ?? '').trim().toLowerCase());
      if (!v._supplier_id) row.messages.push({ level: 'error', field: 'supplier', message: `no supplier ${v.supplier} (load suppliers first)` });
      if (v.part_number) {
        v._part_id = parts.get(String(v.part_number).trim().toLowerCase());
        if (!v._part_id) row.messages.push({ level: 'warning', field: 'part_number', message: `no part ${v.part_number}; kept as description` });
      }
      if (v.qty_received != null && Number(v.qty_received) > 0 && !v.received_on) row.messages.push({ level: 'error', field: 'received_on', message: 'a received quantity needs the date it was received' });
      if (v.received_on && v.qty_received == null) v.qty_received = v.qty_ordered; // a receipt date without a quantity: received in full
      if (Number(v.qty_rejected ?? 0) > Number(v.qty_received ?? 0)) row.messages.push({ level: 'error', field: 'qty_rejected', message: 'more rejected than received' });
      const k = `${v._supplier_id}|${String(v.reference ?? '').trim().toLowerCase()}`;
      if (seen.has(k)) row.messages.push({ level: 'error', field: 'reference', message: 'the same PO line twice in the file' });
      seen.add(k);
      const cur = v._supplier_id ? await one(ctx.tx, 'SELECT id FROM supplier_delivery_history WHERE supplier_id = $1 AND reference = $2', [v._supplier_id, String(v.reference ?? '').trim()]) : null;
      v._id = cur?.id; row.action = cur ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const r = await one(ctx.tx, `INSERT INTO supplier_delivery_history (tenant_id, facility_id, supplier_id, reference, part_id, description, qty_ordered, due_on, received_on, qty_received, qty_rejected, unit_price, source_system)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (tenant_id, supplier_id, reference) DO UPDATE SET part_id = EXCLUDED.part_id, description = EXCLUDED.description, qty_ordered = EXCLUDED.qty_ordered, due_on = EXCLUDED.due_on,
        received_on = EXCLUDED.received_on, qty_received = EXCLUDED.qty_received, qty_rejected = EXCLUDED.qty_rejected, unit_price = EXCLUDED.unit_price, facility_id = EXCLUDED.facility_id
      RETURNING id`,
    [ctx.actor.tenantId, ctx.facilityId, v._supplier_id, String(v.reference).trim(), v._part_id ?? null, v.description ?? null, v.qty_ordered, v.due_on, v.received_on ?? null,
      v.qty_received ?? 0, v.qty_rejected ?? 0, v.unit_price ?? null, ctx.sourceSystem]);
    return { entityId: r.id, action: v._id ? 'update' : 'create' };
  },
};
