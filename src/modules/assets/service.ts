import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { searchDocuments } from '../documents/service.js';
import type { AssetState } from './utilization.js';
import { computeUtilization } from './utilization.js';

export interface AssetInput {
  facilityId: string;
  assetTag: string;
  name: string;
  locationId?: string | null;
  parentAssetId?: string | null;
  assetClass?: 'equipment' | 'component' | 'tool' | 'vehicle' | 'facility_system' | 'it';
  category?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  commissionedOn?: string | null;
  warrantyExpiresOn?: string | null;
  criticality?: 'high' | 'medium' | 'low' | null;
  lifecycleStatus?: 'planned' | 'active' | 'inactive' | 'disposed';
  responsibleTeam?: string | null;
  vendorName?: string | null;
  ratedCapacity?: number | null;
  ratedCapacityUnit?: string | null;
  replacementCost?: number | null;
  customFields?: Record<string, unknown>;
}

// camelCase input field -> column
const COLUMNS: Record<string, string> = {
  facilityId: 'facility_id', assetTag: 'asset_tag', name: 'name', locationId: 'location_id',
  parentAssetId: 'parent_asset_id', assetClass: 'asset_class', category: 'category', manufacturer: 'manufacturer',
  model: 'model', serialNumber: 'serial_number', commissionedOn: 'commissioned_on',
  warrantyExpiresOn: 'warranty_expires_on', criticality: 'criticality', lifecycleStatus: 'lifecycle_status',
  responsibleTeam: 'responsible_team', vendorName: 'vendor_name', ratedCapacity: 'rated_capacity',
  ratedCapacityUnit: 'rated_capacity_unit', replacementCost: 'replacement_cost', customFields: 'custom_fields',
};

async function assertParentValid(tx: Tx, facilityId: string, parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return;
  const parent = await one(tx, 'SELECT id, facility_id FROM asset WHERE id = $1', [parentId]);
  if (!parent) throw invalid('parent asset not found');
  if (parent.facility_id !== facilityId) throw invalid('a component must belong to the same facility as its parent');
  if (selfId) {
    // Reject cycles: walk up from the proposed parent.
    const cycle = await one(tx, `WITH RECURSIVE up AS (
        SELECT id, parent_asset_id FROM asset WHERE id = $1
        UNION ALL SELECT a.id, a.parent_asset_id FROM asset a JOIN up ON a.id = up.parent_asset_id)
      SELECT 1 FROM up WHERE id = $2`, [parentId, selfId]);
    if (cycle) throw invalid('asset hierarchy cycle');
  }
}

export async function createAsset(tx: Tx, actor: Actor, input: AssetInput) {
  requirePermission(actor, 'assets.manage', input.facilityId);
  await assertParentValid(tx, input.facilityId, input.parentAssetId);
  if (await one(tx, 'SELECT 1 FROM asset WHERE asset_tag = $1', [input.assetTag])) {
    throw conflict(`asset tag ${input.assetTag} already exists`);
  }
  const entries = Object.entries(input).filter(([k, v]) => COLUMNS[k] && v !== undefined);
  const cols = ['tenant_id', ...entries.map(([k]) => COLUMNS[k]!)];
  const vals = [actor.tenantId, ...entries.map(([, v]) => v)];
  const asset = await one(tx, `INSERT INTO asset (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
  await audit(tx, actor, { action: 'asset.created', entityType: 'asset', entityId: asset.id, facilityId: asset.facility_id,
    data: { assetTag: asset.asset_tag, name: asset.name } });
  return asset;
}

export async function updateAsset(tx: Tx, actor: Actor, assetId: string, patch: Partial<AssetInput>) {
  const current = await one(tx, 'SELECT * FROM asset WHERE id = $1 FOR UPDATE', [assetId]);
  if (!current) throw notFound('asset');
  requirePermission(actor, 'assets.manage', current.facility_id);
  if (patch.facilityId && patch.facilityId !== current.facility_id) {
    throw invalid('moving assets between facilities is not supported in this release');
  }
  if (patch.parentAssetId !== undefined) await assertParentValid(tx, current.facility_id, patch.parentAssetId, assetId);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const sets: string[] = [];
  const vals: unknown[] = [assetId];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLUMNS[k];
    if (!col || v === undefined || k === 'facilityId') continue;
    const next = k === 'customFields' ? { ...current.custom_fields, ...(v as object) } : v;
    if (JSON.stringify(current[col]) === JSON.stringify(next)) continue;
    changes[k] = { from: current[col], to: next };
    vals.push(next);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return { asset: current, changed: false };
  const asset = await one(tx, `UPDATE asset SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  await audit(tx, actor, { action: 'asset.updated', entityType: 'asset', entityId: assetId, facilityId: asset.facility_id, data: { changes } });
  return { asset, changed: true };
}

export interface AssetQuery {
  facilityId?: string;
  q?: string;
  state?: AssetState;
  criticality?: string;
  parentAssetId?: string | null;
  limit?: number;
  offset?: number;
}

export async function listAssets(tx: Tx, actor: Actor, query: AssetQuery) {
  requirePermission(actor, 'assets.view', query.facilityId);
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (query.facilityId) where.push(`a.facility_id = ${p(query.facilityId)}`);
  if (query.q) { const t = p(`%${query.q}%`); where.push(`(a.asset_tag ILIKE ${t} OR a.name ILIKE ${t} OR a.serial_number ILIKE ${t} OR a.model ILIKE ${t})`); }
  if (query.state) where.push(`a.operational_state = ${p(query.state)}`);
  if (query.criticality) where.push(`a.criticality = ${p(query.criticality)}`);
  if (query.parentAssetId === null) where.push('a.parent_asset_id IS NULL');
  else if (query.parentAssetId) where.push(`a.parent_asset_id = ${p(query.parentAssetId)}`);
  const rows = await many(
    tx,
    `SELECT a.id, a.facility_id, f.code AS facility_code, a.asset_tag, a.name, a.asset_class, a.category, a.manufacturer,
            a.model, a.serial_number, a.criticality, a.lifecycle_status, a.operational_state, a.parent_asset_id,
            l.name AS location_name,
            (SELECT count(*) FROM work_order w WHERE w.asset_id = a.id AND w.status NOT IN ('closed','cancelled','verified')) AS open_work_orders
     FROM asset a JOIN facility f ON f.id = a.facility_id LEFT JOIN functional_location l ON l.id = a.location_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY f.code, a.asset_tag LIMIT ${Math.min(query.limit ?? 200, 1000)} OFFSET ${Math.max(query.offset ?? 0, 0)}`,
    params,
  );
  // RLS already limits rows to visible facilities; this narrows to facilities granting assets.view.
  return rows.filter((r) => can(actor, 'assets.view', r.facility_id));
}

export async function getAsset(tx: Tx, actor: Actor, assetId: string) {
  const asset = await one(
    tx,
    `SELECT a.*, f.code AS facility_code, f.name AS facility_name FROM asset a JOIN facility f ON f.id = a.facility_id WHERE a.id = $1`,
    [assetId],
  );
  if (!asset) throw notFound('asset');
  requirePermission(actor, 'assets.view', asset.facility_id);
  // Sequential on purpose: one transaction = one connection; pg does not pipeline queries.
  const locationPath = asset.location_id
    ? await many(tx, `WITH RECURSIVE up AS (SELECT id, parent_id, name, kind, 0 AS depth FROM functional_location WHERE id = $1
        UNION ALL SELECT l.id, l.parent_id, l.name, l.kind, up.depth + 1 FROM functional_location l JOIN up ON l.id = up.parent_id)
        SELECT name, kind FROM up ORDER BY depth DESC`, [asset.location_id])
    : [];
  const components = await many(tx, 'SELECT id, asset_tag, name, asset_class, operational_state FROM asset WHERE parent_asset_id = $1 ORDER BY asset_tag', [assetId]);
  const currentState = await one(tx, 'SELECT state, reason_code, started_at, note FROM asset_state_event WHERE asset_id = $1 AND ended_at IS NULL', [assetId]);
  const openWorkOrders = can(actor, 'work_orders.view', asset.facility_id)
    ? await many(tx, `SELECT id, number, title, status, priority, due_at FROM work_order
                WHERE asset_id = $1 AND status NOT IN ('closed','cancelled','verified') ORDER BY priority, due_at NULLS LAST`, [assetId])
    : [];
  const documents = can(actor, 'documents.view', asset.facility_id)
    ? await searchDocuments(tx, actor, { entityType: 'asset', entityId: assetId })
    : [];
  // Open changes touching this asset, so anyone working on it sees pending or temporary modifications.
  const openChanges = can(actor, 'moc.view', asset.facility_id)
    ? await many(tx, `SELECT c.id, c.number, c.title, c.status, c.risk_level, c.is_temporary, c.temporary_until FROM moc_change c
                      JOIN moc_affected a ON a.change_id = c.id WHERE a.entity_type = 'asset' AND a.entity_id = $1
                        AND c.status NOT IN ('closed', 'cancelled', 'rejected') ORDER BY c.created_at`, [assetId])
    : [];
  return { ...asset, locationPath, components, currentState: currentState ?? null, openWorkOrders, documents, openChanges };
}

export async function getAssetByQr(tx: Tx, actor: Actor, qrToken: string) {
  const a = await one(tx, 'SELECT id FROM asset WHERE qr_token = $1', [qrToken]);
  if (!a) throw notFound('asset');
  return getAsset(tx, actor, a.id);
}

/**
 * Records a state change: closes the open interval at `at` and opens a new one.
 * Backdating before the open interval's start is rejected so history cannot be rewritten silently.
 */
export async function recordState(
  tx: Tx, actor: Actor, assetId: string,
  input: { state: AssetState; at?: Date; reasonCode?: string | null; note?: string | null; source?: 'manual' | 'work_order' | 'import' | 'telemetry' },
) {
  const asset = await one(tx, 'SELECT id, facility_id, operational_state FROM asset WHERE id = $1 FOR UPDATE', [assetId]);
  if (!asset) throw notFound('asset');
  requirePermission(actor, 'assets.record_state', asset.facility_id);
  const at = input.at ?? new Date();
  const open = await one(tx, 'SELECT id, state, started_at FROM asset_state_event WHERE asset_id = $1 AND ended_at IS NULL', [assetId]);
  if (open && open.state === input.state && !input.reasonCode) return { eventId: open.id, unchanged: true };
  if (open && at <= open.started_at) throw invalid('state change must be later than the current state start');
  if (input.reasonCode) {
    const reason = await one(tx, 'SELECT category FROM downtime_reason WHERE code = $1', [input.reasonCode]);
    if (!reason) throw invalid(`unknown downtime reason code ${input.reasonCode}`);
  }
  if (open) await tx.query('UPDATE asset_state_event SET ended_at = $2 WHERE id = $1', [open.id, at]);
  const ev = await one(
    tx,
    `INSERT INTO asset_state_event (tenant_id, facility_id, asset_id, state, reason_code, started_at, source, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.tenantId, asset.facility_id, assetId, input.state, input.reasonCode ?? null, at, input.source ?? 'manual', input.note ?? null, actor.userId],
  );
  await tx.query('UPDATE asset SET operational_state = $2 WHERE id = $1', [assetId, input.state]);
  await audit(tx, actor, { action: 'asset.state_changed', entityType: 'asset', entityId: assetId, facilityId: asset.facility_id,
    data: { from: asset.operational_state, to: input.state, at: at.toISOString(), reasonCode: input.reasonCode ?? null } });
  return { eventId: ev.id as string, unchanged: false };
}

export async function assetUtilization(
  tx: Tx, actor: Actor, assetId: string, from: Date, to: Date, basis: 'calendar' | 'scheduled' = 'scheduled',
) {
  const asset = await one(tx, 'SELECT id, facility_id FROM asset WHERE id = $1', [assetId]);
  if (!asset) throw notFound('asset');
  requirePermission(actor, 'assets.view', asset.facility_id);
  const rows = await many(
    tx,
    `SELECT state, started_at, ended_at FROM asset_state_event
     WHERE asset_id = $1 AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2) ORDER BY started_at`,
    [assetId, from, to],
  );
  return computeUtilization(rows.map((r) => ({ state: r.state, startedAt: r.started_at, endedAt: r.ended_at })), from, to, { basis });
}

/** Finds or creates a functional location path like "Building 2 > Line 3" under a facility. */
export async function ensureLocationPath(tx: Tx, actor: Actor, facilityId: string, path: string[]): Promise<string | null> {
  let parentId: string | null = null;
  for (const [depth, rawName] of path.entries()) {
    const name = rawName.trim();
    if (!name) continue;
    const code = path.slice(0, depth + 1).map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-')).join('/');
    const found: { id: string } | undefined = await one(tx, 'SELECT id FROM functional_location WHERE facility_id = $1 AND code = $2', [facilityId, code]);
    if (found) { parentId = found.id; continue; }
    const kind = /line/i.test(name) ? 'line' : /cell/i.test(name) ? 'cell' : /bldg|building/i.test(name) ? 'building' : /crib|store/i.test(name) ? 'storeroom' : 'area';
    const created: { id: string } | undefined = await one(
      tx,
      `INSERT INTO functional_location (tenant_id, facility_id, parent_id, code, name, kind) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [actor.tenantId, facilityId, parentId, code, name, kind],
    );
    parentId = created!.id;
  }
  return parentId;
}
