import { requirePermission } from '../../../platform/auth/actor.js';
import { audit } from '../../../platform/audit/audit.js';
import { many, one } from '../../../platform/db/tx.js';
import type { PlannedRow, TargetContext, TargetDefinition } from './types.js';

/** "2", ".2", "..2", "1.2.3" (outline numbering) → depth. Returns null when the value is not a level. */
export function parseLevel(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const dots = /^(\.+)(\d+)?$/.exec(s);
  if (dots) return dots[2] !== undefined ? Number(dots[2]) : dots[1]!.length;
  if (/^\d+(\.\d+)+$/.test(s)) return s.split('.').length - 1;
  return null;
}

/** Draft revision for a parent part: the existing draft, or a new one copied from the released revision. */
export async function draftFor(ctx: TargetContext, partId: string) {
  const d = await one(ctx.tx, `SELECT id FROM product_revision WHERE part_id = $1 AND status = 'draft'`, [partId]);
  if (d) return d.id as string;
  const next = Number((await one(ctx.tx, 'SELECT coalesce(max(revision), 0) + 1 AS n FROM product_revision WHERE part_id = $1', [partId])).n);
  const r = await one(ctx.tx, `INSERT INTO product_revision (tenant_id, part_id, revision, notes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ctx.actor.tenantId, partId, next, `Imported from ${ctx.sourceSystem}`, ctx.actor.userId]);
  const from = await one(ctx.tx, `SELECT id FROM product_revision WHERE part_id = $1 AND status = 'released'`, [partId]);
  if (from) {
    await ctx.tx.query(`INSERT INTO product_material (tenant_id, revision_id, line_no, part_id, qty_per, scrap_pct, op_no, notes)
      SELECT tenant_id, $2, line_no, part_id, qty_per, scrap_pct, op_no, notes FROM product_material WHERE revision_id = $1`, [from.id, r.id]);
    await ctx.tx.query(`INSERT INTO product_operation (tenant_id, revision_id, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit, document_id)
      SELECT tenant_id, $2, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit, document_id FROM product_operation WHERE revision_id = $1`, [from.id, r.id]);
  }
  await audit(ctx.tx, ctx.actor, { action: 'product_revision.created', entityType: 'product_revision', entityId: r.id, data: { revision: next, import: ctx.batchId, copiedFrom: from?.id ?? null } });
  return r.id as string;
}

/**
 * Bills of materials from another system. Accepts a flat export (parent and component on every row) or an
 * indented one (a level column; the parent is the nearest row above at the level before). Lines are added to
 * or updated on each parent's DRAFT revision, so nothing reaches production until a person reviews the
 * routing and releases it. Components missing from the file are left as they are.
 */
export const bomsTarget: TargetDefinition = {
  key: 'boms',
  label: 'Bills of materials',
  entityType: 'product_material',
  description: 'Components and quantity per unit for manufactured parts, flat or indented. Lines land on a draft revision for review; parts must exist first.',
  naturalKey: 'component_part_number',
  commitPermission: 'production.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'parent_part_number', label: 'Parent part', type: 'string',
      description: 'The part being made. Leave unmapped for indented BOMs that use a level column.',
      synonyms: ['parent', 'parent part', 'parent item', 'assembly', 'assembly number', 'finished good', 'fg', 'top level', 'product', 'bom', 'bom item', 'parent pn', 'made item'] },
    { key: 'component_part_number', label: 'Component part', type: 'string', required: true,
      synonyms: ['component', 'component part', 'child', 'child part', 'material', 'item', 'item number', 'part number', 'part no', 'part', 'raw material', 'comp pn', 'sku'] },
    { key: 'qty_per', label: 'Quantity per unit', type: 'number', min: 0,
      synonyms: ['qty per', 'quantity per', 'qty', 'quantity', 'usage', 'per', 'qty/assy', 'qty per assembly', 'extended qty', 'amount'] },
    { key: 'level', label: 'Level (indented BOMs)', type: 'string',
      synonyms: ['level', 'lvl', 'bom level', 'indent', 'depth', 'tree level'] },
    { key: 'uom', label: 'Unit of measure', type: 'string', synonyms: ['uom', 'unit', 'u/m', 'units', 'unit of measure'] },
    { key: 'scrap_pct', label: 'Scrap allowance %', type: 'number', min: 0, max: 99,
      synonyms: ['scrap', 'scrap %', 'scrap pct', 'scrap factor', 'yield loss', 'waste', 'waste %', 'shrink'] },
    { key: 'notes', label: 'Notes', type: 'text', synonyms: ['notes', 'note', 'comment', 'comments', 'reference designator', 'ref des', 'remarks'] },
  ],

  order(rows) { return [...rows].sort((a, b) => a.rowNumber - b.rowNumber); },

  async validate(ctx, rows) {
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS pn, part_number, uom FROM part WHERE active')).map((p) => [p.pn, p]));
    const find = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : parts.get(String(v).trim().toLowerCase()));
    const stack: { level: number; partId: string | undefined; pn: string }[] = [];
    const seen = new Map<string, number>();
    for (const row of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
      const v = row.values;
      const comp = find(v.component_part_number);
      if (v.component_part_number && !comp) row.messages.push({ level: 'error', field: 'component_part_number', message: `part "${v.component_part_number}" not found — import the parts list first` });
      const level = parseLevel(v.level);
      if (v.level !== null && v.level !== undefined && v.level !== '' && level === null) row.messages.push({ level: 'error', field: 'level', message: `"${v.level}" is not a BOM level` });
      let parentPn = v.parent_part_number ? String(v.parent_part_number).trim() : null;
      if (level !== null) {
        while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
        if (!parentPn) parentPn = stack.length ? stack[stack.length - 1]!.pn : null;
        stack.push({ level, partId: comp?.id, pn: String(v.component_part_number ?? '') });
        if (!parentPn) {
          // The top of an indented tree: it names the product, it is not a component line.
          row.action = 'unchanged';
          v._top = true; v._top_id = comp?.id ?? null;
          continue;
        }
      }
      if (!parentPn) { row.messages.push({ level: 'error', field: 'parent_part_number', message: 'no parent part (map a parent column, or a level column for indented BOMs)' }); continue; }
      const parent = find(parentPn);
      if (!parent) { row.messages.push({ level: 'error', field: 'parent_part_number', message: `parent part "${parentPn}" not found — import the parts list first` }); continue; }
      if (v.qty_per === null || v.qty_per === undefined || !(Number(v.qty_per) > 0)) { row.messages.push({ level: 'error', field: 'qty_per', message: 'quantity per unit must be more than zero' }); continue; }
      if (!comp) continue;
      if (comp.id === parent.id) { row.messages.push({ level: 'error', message: 'a part cannot contain itself' }); continue; }
      if (v.uom && String(v.uom).trim().toUpperCase() !== String(comp.uom).toUpperCase()) {
        row.messages.push({ level: 'error', field: 'uom', message: `file says ${v.uom} but ${comp.part_number} is stocked in ${comp.uom}; convert the quantity to ${comp.uom} (no unit conversions are guessed)` });
        continue;
      }
      const key = `${parent.id}:${comp.id}`;
      if (seen.has(key)) { row.messages.push({ level: 'error', message: `${comp.part_number} is already listed under ${parent.part_number} on row ${seen.get(key)}; combine the quantities` }); continue; }
      seen.set(key, row.rowNumber);
      v._parent_id = parent.id; v._component_id = comp.id; v._parent_pn = parent.part_number;
      const existing = await one(ctx.tx, `SELECT m.qty_per::float AS qty_per, m.scrap_pct::float AS scrap_pct FROM product_material m JOIN product_revision r ON r.id = m.revision_id
        WHERE r.part_id = $1 AND m.part_id = $2 ORDER BY (r.status = 'draft') DESC, (r.status = 'released') DESC LIMIT 1`, [parent.id, comp.id]);
      row.action = !existing ? 'create' : existing.qty_per === Number(v.qty_per) && existing.scrap_pct === Number(v.scrap_pct ?? 0) ? 'unchanged' : 'update';
    }
  },

  async commitRow(ctx, row: PlannedRow) {
    const v = row.values;
    if (v._top) return { entityId: v._top_id as string, action: 'unchanged' };
    requirePermission(ctx.actor, 'production.manage');
    const draftId = await draftFor(ctx, v._parent_id as string);
    const cur = await one(ctx.tx, 'SELECT id, qty_per::float AS qty_per, scrap_pct::float AS scrap_pct FROM product_material WHERE revision_id = $1 AND part_id = $2', [draftId, v._component_id]);
    const qty = Number(v.qty_per); const scrap = Number(v.scrap_pct ?? 0);
    if (cur && cur.qty_per === qty && cur.scrap_pct === scrap) return { entityId: cur.id, action: 'unchanged' };
    if (cur) {
      await ctx.tx.query('UPDATE product_material SET qty_per = $2, scrap_pct = $3, notes = coalesce($4, notes) WHERE id = $1', [cur.id, qty, scrap, v.notes ?? null]);
      return { entityId: cur.id, action: 'update' };
    }
    const n = Number((await one(ctx.tx, 'SELECT coalesce(max(line_no), 0) + 1 AS n FROM product_material WHERE revision_id = $1', [draftId])).n);
    const m = await one(ctx.tx, `INSERT INTO product_material (tenant_id, revision_id, line_no, part_id, qty_per, scrap_pct, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [ctx.actor.tenantId, draftId, n, v._component_id, qty, scrap, v.notes ?? null]);
    return { entityId: m.id as string, action: 'create' };
  },
};
