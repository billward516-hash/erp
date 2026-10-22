import type { Actor } from '../auth/actor.js';
import type { Tx } from '../db/tx.js';
import { many, one } from '../db/tx.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  facilityId?: string | null;
  data?: Record<string, unknown>;
}

/** Appends a tamper-evident audit event in the caller's transaction (commits or rolls back with it). */
export async function audit(tx: Tx, actor: Pick<Actor, 'tenantId'> & { userId: string | null }, e: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_event (tenant_id, facility_id, actor_user_id, action, entity_type, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.tenantId, e.facilityId ?? null, actor.userId, e.action, e.entityType, e.entityId ?? null, e.data ?? {}],
  );
}

export async function auditHistory(tx: Tx, entityType: string, entityId: string) {
  return many(
    tx,
    `SELECT e.id, e.occurred_at, e.action, e.data, u.display_name AS actor, encode(e.hash, 'hex') AS hash
     FROM audit_event e LEFT JOIN app_user u ON u.id = e.actor_user_id
     WHERE e.entity_type = $1 AND e.entity_id = $2 ORDER BY e.id`,
    [entityType, entityId],
  );
}

/** Returns null when the tenant's chain is intact, else the first event id that fails verification. */
export async function verifyAuditChain(tx: Tx): Promise<number | null> {
  const r = await one<{ bad: number | null }>(tx, 'SELECT audit_verify_chain() AS bad');
  return r?.bad ?? null;
}
