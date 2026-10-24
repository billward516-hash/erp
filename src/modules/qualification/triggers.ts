import type { Actor } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { qualificationInactive } from './gate.js';

/**
 * What makes a qualified tool need requalification (SC-007 B, D-184B): a work order on it (or on a component of it) completed
 * or verified, or a change that affects it put in service. Kept free of the rest of the module so maintenance and change
 * management can call it without import cycles.
 */
export type QualificationEventKind = 'switched_on' | 'switched_off' | 'declared' | 'protocol_executed' | 'protocol_approved' | 'protocol_failed' | 'protocol_rejected'
  | 'requal_required' | 'requal_cleared' | 'setting_changed';

/** Appends to the asset's qualification history (append-only). */
export async function logQualificationEvent(
  tx: Tx, actor: Pick<Actor, 'tenantId'> & { userId: string | null }, e: { facilityId: string; assetId: string; kind: QualificationEventKind; summary: string; protocolId?: string | null; refType?: string | null; refId?: string | null; data?: Record<string, unknown> },
) {
  await tx.query(`INSERT INTO qualification_event (tenant_id, facility_id, asset_id, kind, actor_user_id, protocol_id, ref_type, ref_id, summary, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [actor.tenantId, e.facilityId, e.assetId, e.kind, actor.userId, e.protocolId ?? null, e.refType ?? null, e.refId ?? null, e.summary, e.data ?? {}]);
}

/**
 * Marks the asset, and any assets above it in the hierarchy that are under qualification control, as requiring requalification.
 * Only a qualified tool whose "requalify after work" setting is on changes (a tool not yet qualified has nothing to lose, and one
 * already marked keeps its earlier date). The same trigger (same record) is recorded once per tool.
 */
export async function requireRequalification(tx: Tx, actor: Actor, assetId: string, trigger: { reason: string; refType: 'work_order' | 'moc_change'; refId: string }) {
  if (await qualificationInactive(tx)) return 0;
  const rows = await many(tx, `WITH RECURSIVE up AS (SELECT id, parent_asset_id FROM asset WHERE id = $1
      UNION ALL SELECT a.id, a.parent_asset_id FROM asset a JOIN up ON a.id = up.parent_asset_id)
    SELECT q.id, q.asset_id, q.facility_id, q.status, a.asset_tag FROM up JOIN asset_qualification q ON q.asset_id = up.id JOIN asset a ON a.id = q.asset_id
    WHERE q.enabled AND q.requalify_after_work FOR UPDATE OF q`, [assetId]);
  let changed = 0;
  for (const q of rows) {
    if (q.status === 'not_qualified') continue;
    if (await one(tx, `SELECT 1 FROM qualification_event WHERE asset_id = $1 AND kind = 'requal_required' AND ref_type = $2 AND ref_id = $3`, [q.asset_id, trigger.refType, trigger.refId])) continue;
    const viaComponent = q.asset_id !== assetId;
    const reason = viaComponent ? `${trigger.reason} (on a component)` : trigger.reason;
    if (q.status === 'qualified') {
      await tx.query(`UPDATE asset_qualification SET status = 'requalification_required', required_since = now(), required_reason = $2, required_ref_type = $3, required_ref_id = $4 WHERE id = $1`,
        [q.id, reason, trigger.refType, trigger.refId]);
      changed++;
    }
    await logQualificationEvent(tx, actor, { facilityId: q.facility_id, assetId: q.asset_id, kind: 'requal_required', refType: trigger.refType, refId: trigger.refId,
      summary: q.status === 'qualified' ? `Requalification required: ${reason}` : `Also affected, requalification was already required: ${reason}`, data: { alreadyRequired: q.status !== 'qualified' } });
    await audit(tx, actor, { action: 'qualification.requalification_required', entityType: 'asset', entityId: q.asset_id, facilityId: q.facility_id, data: { reason, refType: trigger.refType, refId: trigger.refId, alreadyRequired: q.status !== 'qualified' } });
    if (q.status === 'qualified') {
      await notify(tx, actor.tenantId, await usersWithPermission(tx, 'qualification.manage', q.facility_id), { kind: 'qualification.required', title: `${q.asset_tag} needs requalification: ${reason}`,
        body: 'It cannot return to service until a protocol is executed and approved.', link: `/qualification/assets/${q.asset_id}`, subjectType: 'asset', subjectId: q.asset_id,
        dedupeKey: `requal-required:${q.asset_id}:${trigger.refId}` }, actor.userId);
    }
  }
  return changed;
}

/** A work order finished or verified on a tool: requalify it when the tool's setting says so. */
export async function requalifyAfterWorkOrder(tx: Tx, actor: Actor, wo: { id: string; number: string; title: string; asset_id: string }, to: 'completed' | 'verified') {
  return requireRequalification(tx, actor, wo.asset_id, { reason: `${wo.number} ${to}: ${wo.title}`, refType: 'work_order', refId: wo.id });
}

/** A change put in service: every asset it affects is requalified when its setting says so. */
export async function requalifyAfterChange(tx: Tx, actor: Actor, changeId: string) {
  const c = await one(tx, 'SELECT number, title FROM moc_change WHERE id = $1', [changeId]);
  if (!c) return 0;
  let n = 0;
  for (const a of await many(tx, `SELECT entity_id FROM moc_affected WHERE change_id = $1 AND entity_type = 'asset'`, [changeId])) {
    n += await requireRequalification(tx, actor, a.entity_id, { reason: `${c.number} in service: ${c.title}`, refType: 'moc_change', refId: changeId });
  }
  return n;
}
