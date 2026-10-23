import { many, one } from '../../../platform/db/tx.js';
import type { PlannedRow, TargetContext } from './types.js';

export async function findExternalRef(ctx: TargetContext, entityType: string, externalId: unknown): Promise<string | null> {
  if (externalId === null || externalId === undefined || externalId === '') return null;
  const r = await one(ctx.tx, 'SELECT entity_id FROM external_ref WHERE source_system = $1 AND entity_type = $2 AND external_id = $3',
    [ctx.sourceSystem, entityType, String(externalId)]);
  return r?.entity_id ?? null;
}

export async function saveExternalRef(ctx: TargetContext, entityType: string, externalId: unknown, entityId: string) {
  if (externalId === null || externalId === undefined || externalId === '') return;
  await ctx.tx.query(
    `INSERT INTO external_ref (tenant_id, source_system, entity_type, external_id, entity_id, batch_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, source_system, entity_type, external_id) DO UPDATE SET entity_id = excluded.entity_id`,
    [ctx.actor.tenantId, ctx.sourceSystem, entityType, String(externalId), entityId, ctx.batchId ?? null],
  );
}

/** Flags rows that repeat a key already seen earlier in the same file. */
export function flagDuplicates(rows: PlannedRow[], key: string, label: string) {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const v = row.values[key];
    if (v === null || v === undefined || v === '') continue;
    const k = String(v).trim().toLowerCase();
    const first = seen.get(k);
    if (first !== undefined) {
      row.messages.push({ level: 'error', field: key, message: `duplicate ${label} "${v}" (first seen on row ${first})` });
    } else seen.set(k, row.rowNumber);
  }
}

export interface FacilityInfo { id: string; code: string; timezone: string }

export async function facilityLookup(ctx: TargetContext): Promise<Map<string, FacilityInfo>> {
  const rows = await many<FacilityInfo & { name: string }>(ctx.tx, 'SELECT id, code, name, timezone FROM facility');
  const map = new Map<string, FacilityInfo>();
  for (const f of rows) {
    map.set(f.code.toLowerCase(), f);
    map.set(f.name.toLowerCase(), f);
  }
  return map;
}

/** Resolves the row's facility from a code/name column, falling back to the batch default. */
export function resolveFacility(
  ctx: TargetContext, row: PlannedRow, facilities: Map<string, FacilityInfo>, field = 'facility_code',
): FacilityInfo | null {
  const v = row.values[field];
  if (v) {
    const f = facilities.get(String(v).trim().toLowerCase());
    if (!f) row.messages.push({ level: 'error', field, message: `unknown facility "${v}" (or you lack access to it)` });
    return f ?? null;
  }
  if (!ctx.facilityId) {
    row.messages.push({ level: 'error', field, message: 'no facility given and no default facility selected for this import' });
    return null;
  }
  return [...facilities.values()].find((f) => f.id === ctx.facilityId) ?? null;
}

export const hasErrors = (row: PlannedRow) => row.messages.some((m) => m.level === 'error');

/** Keys present on the row = fields the mapping actually supplied (so updates never blank unmapped fields). */
export function suppliedKeys(row: PlannedRow): Set<string> {
  return new Set(Object.keys(row.values).filter((k) => row.values[k] !== undefined));
}
