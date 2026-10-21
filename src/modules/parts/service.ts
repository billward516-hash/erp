import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict } from '../../platform/errors.js';

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
    [actor.tenantId, input.partNumber, input.description, input.uom ?? 'EA', input.manufacturer ?? null,
      input.manufacturerPartNumber ?? null, input.unitCost ?? null, input.active ?? true, input.customFields ?? {}],
  );
  await audit(tx, actor, { action: 'part.created', entityType: 'part', entityId: part.id, data: { partNumber: part.part_number } });
  return part;
}

export async function listParts(tx: Tx, actor: Actor, q: { q?: string; limit?: number }) {
  requirePermission(actor, 'parts.view');
  return many(
    tx,
    `SELECT id, part_number, description, uom, manufacturer, manufacturer_part_number, unit_cost, currency, active
     FROM part WHERE ($1::text IS NULL OR part_number ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
     ORDER BY part_number LIMIT $2`,
    [q.q ?? null, Math.min(q.limit ?? 200, 1000)],
  );
}
