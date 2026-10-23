import type { Actor } from '../auth/actor.js';
import type { Tx } from '../db/tx.js';

export interface OutboxEvent {
  id: number; topic: string; aggregate_type: string; aggregate_id: string; payload: any; idempotency_key: string; created_at: Date;
}
export interface Connection { id: string; tenant_id: string; provider: string; label: string; is_mock: boolean; settings: any }

export type DeliveryResult = { eventId: number; ok: true; externalId: string } | { eventId: number; ok: false; error: string; permanent?: boolean };
export interface PaymentUpdate { externalId: string; paidOn: string; amount: number; reference: string | null }

/**
 * An accounting adapter. deliver() receives a batch of events in outbox order and reports per event.
 * Adapters must pass each event's idempotency key to the external system (or check it themselves) so
 * a retried delivery never duplicates a record there. Implementations: file export (any system, via a
 * downloaded file), MOCK accounting (development/demo only). Provider adapters (QuickBooks Online, Xero)
 * implement the same interface once a pilot selects one (D-016).
 */
export interface AccountingAdapter {
  provider: string;
  isMock: boolean;
  /** Delivered as each event is emitted, in the same transaction (the built-in books), instead of by a sync run. */
  inline?: boolean;
  /** Topics this adapter accepts; others are marked skipped. */
  topics: string[];
  deliver(tx: Tx, actor: Actor, connection: Connection, events: OutboxEvent[]): Promise<DeliveryResult[]>;
  /** Payment status from the system of record, for bills this adapter delivered. */
  fetchPayments?(tx: Tx, actor: Actor, connection: Connection, externalIds: string[]): Promise<PaymentUpdate[]>;
}
