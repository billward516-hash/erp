import type { Actor } from '../auth/actor.js';
import type { Tx } from '../db/tx.js';
import { one } from '../db/tx.js';

/**
 * Transactional outbox. Domain services call emit() inside the same transaction as the change, so an
 * event exists if and only if the change committed. The idempotency key identifies the business fact
 * (e.g. "bill <invoice id> approved, revision 1"); emitting the same key twice is a no-op, and adapters
 * pass it to the external system so a retried delivery cannot create a duplicate there.
 */
export async function emit(tx: Tx, actor: Actor, e: { topic: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; idempotencyKey: string }) {
  const row = await one(tx, `INSERT INTO outbox_event (tenant_id, topic, aggregate_type, aggregate_id, payload, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
  [actor.tenantId, e.topic, e.aggregateType, e.aggregateId, e.payload, e.idempotencyKey]);
  return (row?.id as number | undefined) ?? null;
}
