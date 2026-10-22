import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { factorBetween, normalizeUom, partUnits, STANDARD } from '../inventory/uom.js';

export interface PartInput {
  partNumber: string;
  description: string;
  uom?: string;
  manufacturer?: string | null;
  manufacturerPartNumber?: string | null;
  unitCost?: number | null;
  active?: boolean;
  customFields?: Record<string, unknown>;
}

export async function createPart(tx: Tx, actor: Actor, input: PartInput) {
  requirePermission(actor, 'parts.manage');
  if (await one(tx, 'SELECT 1 FROM part WHERE part_number = $1', [input.partNumber])) {
    throw conflict(`part ${input.partNumber} already exists`);
  }
  const part = await one(
    tx,
    `INSERT INTO part (tenant_id, part_number, description, uom, manufacturer, manufacturer_part_number, unit_cost, active, custom_fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, input.partNumber, input.description, normalizeUom(input.uom), input.manufacturer ?? null,
      input.manufacturerPartNumber ?? null, input.unitCost ?? null, input.active ?? true, input.customFields ?? {}],
  );
  await audit(tx, actor, { action: 'part.created', entityType: 'part', entityId: part.id, data: { partNumber: part.part_number } });
  return part;
}

export async function listParts(tx: Tx, actor: Actor, q: { q?: string; limit?: number }) {
  requirePermission(actor, 'parts.view');
  return many(
    tx,
    `SELECT id, part_number, description, uom, manufacturer, manufacturer_part_number, unit_cost, currency, active, tracking, shelf_life_days
     FROM part WHERE ($1::text IS NULL OR part_number ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
     ORDER BY part_number LIMIT $2`,
    [q.q ?? null, Math.min(q.limit ?? 200, 1000)],
  );
}

// ---------------------------------------------------------------------------
// Units (D-143)
// ---------------------------------------------------------------------------

/** The part's stock unit, its own units (BOX of 10…), and the standard units that convert to it by fixed factors. */
export async function listPartUnits(tx: Tx, actor: Actor, partId: string) {
  requirePermission(actor, 'parts.view');
  const p = await one(tx, 'SELECT id, part_number, uom FROM part WHERE id = $1', [partId]);
  if (!p) throw notFound('part');
  const own = (await partUnits(tx, [partId])).get(partId) ?? new Map<string, number>();
  const usedBy = await many(tx, `SELECT sp.uom, s.name FROM supplier_part sp JOIN supplier s ON s.id = sp.supplier_id WHERE sp.part_id = $1 AND sp.uom IS NOT NULL`, [partId]);
  const standard = Object.entries(STANDARD).filter(([u]) => u !== p.uom && !own.has(u)).map(([u, d]) => ({ uom: u, label: d.label, perUnit: factorBetween(u, p.uom, own) }))
    .filter((x) => x.perUnit != null);
  return { stockUom: p.uom, own: [...own].map(([uom, perUnit]) => ({ uom, perUnit, suppliers: usedBy.filter((x) => x.uom === uom).map((x) => x.name) })), standard };
}

export async function setPartUnit(tx: Tx, actor: Actor, partId: string, input: { uom: string; perUnit: number }) {
  requirePermission(actor, 'parts.manage');
  const p = await one(tx, 'SELECT id, part_number, uom FROM part WHERE id = $1', [partId]);
  if (!p) throw notFound('part');
  const uom = normalizeUom(input.uom);
  if (!/^[A-Z0-9]{1,10}$/.test(uom)) throw invalid('a unit is up to 10 letters or digits, like BOX or CS12');
  if (uom === p.uom) throw invalid(`${uom} is the stock unit`);
  const fixed = STANDARD[uom] && STANDARD[p.uom] && STANDARD[uom]!.kind === STANDARD[p.uom]!.kind;
  if (fixed) throw invalid(`${uom} converts to ${p.uom} by a fixed factor already`);
  if (!(input.perUnit > 0)) throw invalid(`give how many ${p.uom} are in one ${uom}`);
  await tx.query(`INSERT INTO part_uom (tenant_id, part_id, uom, per_unit) VALUES ($1, $2, $3, $4)
    ON CONFLICT (part_id, uom) DO UPDATE SET per_unit = EXCLUDED.per_unit, updated_at = now()`, [actor.tenantId, partId, uom, input.perUnit]);
  await audit(tx, actor, { action: 'part.unit_set', entityType: 'part', entityId: partId, data: { uom, perUnit: input.perUnit, stockUom: p.uom } });
}

export async function deletePartUnit(tx: Tx, actor: Actor, partId: string, uomIn: string) {
  requirePermission(actor, 'parts.manage');
  const uom = normalizeUom(uomIn);
  const used = await one(tx, `SELECT s.name FROM supplier_part sp JOIN supplier s ON s.id = sp.supplier_id WHERE sp.part_id = $1 AND sp.uom = $2 LIMIT 1`, [partId, uom]);
  if (used) throw conflict(`${used.name} prices this part per ${uom}; change that price first`);
  await tx.query('DELETE FROM part_uom WHERE part_id = $1 AND uom = $2', [partId, uom]);
  await audit(tx, actor, { action: 'part.unit_removed', entityType: 'part', entityId: partId, data: { uom } });
}
