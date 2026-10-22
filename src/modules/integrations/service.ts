import type { Actor } from '../../platform/auth/actor.js';
import { asActor, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import type { AccountingAdapter, Connection, OutboxEvent } from '../../platform/integration/adapter.js';
import { onBillDelivered, onBillPaid } from '../ap/service.js';
import { onInvoiceDelivered, onInvoicePaid } from '../ar/service.js';
import { fileExportAdapter } from './adapters/file-export.js';
import { mockAccountingAdapter } from './adapters/mock-accounting.js';

export const ADAPTERS: Record<string, AccountingAdapter> = { file_export: fileExportAdapter, mock_accounting: mockAccountingAdapter };
/** Minutes to wait after the 1st, 2nd, … failure; after the last, the delivery is parked as dead. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

/** Reactions to a successful delivery, by topic (same transaction as recording the delivery). */
const ON_DELIVERED: Record<string, (tx: Tx, actor: Actor, e: OutboxEvent, externalId: string) => Promise<void>> = {
  'ap.bill.approved': onBillDelivered,
  'ar.invoice.issued': onInvoiceDelivered,
};

export async function createConnection(tx: Tx, actor: Actor, input: { provider: string; label?: string; backfill?: 'none' | 'all' }) {
  requirePermission(actor, 'integrations.manage');
  const adapter = ADAPTERS[input.provider];
  if (!adapter) throw invalid(`unknown provider ${input.provider}`);
  if (await one(tx, 'SELECT 1 FROM integration_connection WHERE active')) throw conflict('an accounting connection is already active; disconnect it first');
  // By default only events from now on are sent; 'all' also sends approved invoices still waiting for export.
  const startsAfter = input.backfill === 'all' ? 0 : Number((await one(tx, 'SELECT coalesce(max(id), 0) AS m FROM outbox_event')).m);
  const label = input.label ?? (adapter.isMock ? 'MOCK accounting system (demo only)' : 'Accounts-payable file export');
  const c = await one(tx, `INSERT INTO integration_connection (tenant_id, provider, label, is_mock, created_by, starts_after_event)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [actor.tenantId, input.provider, label, adapter.isMock, actor.userId, startsAfter]);
  await audit(tx, actor, { action: 'integration.connected', entityType: 'integration_connection', entityId: c.id, data: { provider: c.provider, mock: c.is_mock, backfill: input.backfill ?? 'none' } });
  return c;
}

export async function disconnect(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'integrations.manage');
  const c = await one(tx, 'UPDATE integration_connection SET active = false WHERE id = $1 AND active RETURNING id, provider', [id]);
  if (!c) throw notFound('active connection');
  await audit(tx, actor, { action: 'integration.disconnected', entityType: 'integration_connection', entityId: id, data: { provider: c.provider } });
}

export async function activeConnection(tx: Tx) {
  return one<Connection & { active: boolean; starts_after_event: number }>(tx, 'SELECT * FROM integration_connection WHERE active');
}

export async function listConnections(tx: Tx, actor: Actor) {
  requirePermission(actor, 'ap.view');
  return many(tx, `SELECT c.*, u.display_name AS created_by_name,
      (SELECT count(*)::int FROM sync_delivery d WHERE d.connection_id = c.id AND d.status = 'pending') AS pending,
      (SELECT count(*)::int FROM sync_delivery d WHERE d.connection_id = c.id AND d.status = 'dead') AS dead,
      (SELECT count(*)::int FROM sync_delivery d WHERE d.connection_id = c.id AND d.status = 'delivered') AS delivered,
      (SELECT max(d.delivered_at) FROM sync_delivery d WHERE d.connection_id = c.id) AS last_delivery
    FROM integration_connection c JOIN app_user u ON u.id = c.created_by ORDER BY c.active DESC, c.created_at DESC`);
}

export async function listDeliveries(tx: Tx, actor: Actor, connectionId: string, q: { status?: string } = {}) {
  requirePermission(actor, 'ap.view');
  return many(tx, `SELECT d.id, d.status, d.attempts, d.next_attempt_at, d.last_error, d.external_id, d.delivered_at, d.resolution_note,
      e.id AS event_id, e.topic, e.aggregate_type, e.aggregate_id, e.created_at AS event_at,
      e.payload->>'invoiceNumber' AS invoice_number, coalesce(e.payload->'supplier'->>'name', e.payload->'customer'->>'name') AS party_name
    FROM sync_delivery d JOIN outbox_event e ON e.id = d.outbox_id
    WHERE d.connection_id = $1 AND ($2::text IS NULL OR d.status = $2) ORDER BY d.outbox_id DESC LIMIT 200`, [connectionId, q.status ?? null]);
}

export async function listExportFiles(tx: Tx, actor: Actor, connectionId: string) {
  requirePermission(actor, 'ap.view');
  return many(tx, 'SELECT id, kind, file_name, row_count, created_at, downloaded_at FROM export_file WHERE connection_id = $1 ORDER BY created_at DESC LIMIT 100', [connectionId]);
}

export async function downloadExportFile(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'integrations.manage');
  const f = await one(tx, 'UPDATE export_file SET downloaded_at = coalesce(downloaded_at, now()) WHERE id = $1 RETURNING file_name, content', [id]);
  if (!f) throw notFound('export file');
  await audit(tx, actor, { action: 'integration.file_downloaded', entityType: 'export_file', entityId: id, data: { fileName: f.file_name } });
  return f as { file_name: string; content: string };
}

/**
 * One sync run for the active connection: queue new outbox events, deliver what is due (oldest first),
 * record each result, then pull payment status from the system of record. Safe to run concurrently
 * (rows are claimed with SKIP LOCKED) and repeatedly (idempotency keys). Intended to run from a
 * scheduler (`scripts/run-sync.ts`) and on demand from the Integrations page.
 */
export async function runSync(actor: Actor, opts: { limit?: number } = {}) {
  requirePermission(actor, 'integrations.manage');
  return asActor(actor, async (tx) => {
    const c = await activeConnection(tx);
    if (!c) throw invalid('no active accounting connection');
    const adapter = ADAPTERS[c.provider]!;
    await tx.query(`INSERT INTO sync_delivery (tenant_id, outbox_id, connection_id)
      SELECT e.tenant_id, e.id, $1 FROM outbox_event e WHERE e.id > $2 ON CONFLICT (outbox_id, connection_id) DO NOTHING`, [c.id, c.starts_after_event]);
    const due = await many(tx, `SELECT d.id AS delivery_id, d.attempts, e.* FROM sync_delivery d JOIN outbox_event e ON e.id = d.outbox_id
      WHERE d.connection_id = $1 AND d.status = 'pending' AND d.next_attempt_at <= now()
      ORDER BY d.outbox_id LIMIT $2 FOR UPDATE OF d SKIP LOCKED`, [c.id, opts.limit ?? 200]);
    const summary = { delivered: 0, failed: 0, dead: 0, skipped: 0, payments: 0, mock: c.is_mock };
    const unsupported = due.filter((d) => !adapter.topics.includes(d.topic));
    for (const d of unsupported) {
      await tx.query(`UPDATE sync_delivery SET status = 'skipped', resolution_note = 'topic not handled by this connection' WHERE id = $1`, [d.delivery_id]);
      summary.skipped++;
    }
    const work = due.filter((d) => adapter.topics.includes(d.topic));
    const results = work.length ? await adapter.deliver(tx, actor, c, work as unknown as OutboxEvent[]) : [];
    for (const r of results) {
      const d = work.find((x) => x.id === r.eventId)!;
      const attempts = d.attempts + 1;
      if (r.ok) {
        await tx.query(`UPDATE sync_delivery SET status = 'delivered', attempts = $2, external_id = $3, delivered_at = now(), last_error = NULL WHERE id = $1`, [d.delivery_id, attempts, r.externalId]);
        await ON_DELIVERED[d.topic]?.(tx, actor, d as unknown as OutboxEvent, r.externalId);
        summary.delivered++;
      } else if (r.permanent || attempts >= MAX_ATTEMPTS) {
        await tx.query(`UPDATE sync_delivery SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1`, [d.delivery_id, attempts, r.error]);
        summary.dead++;
      } else {
        await tx.query(`UPDATE sync_delivery SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`,
          [d.delivery_id, attempts, r.error, BACKOFF_MINUTES[attempts - 1]]);
        summary.failed++;
      }
    }
    // Payment status comes from accounting (system of record for payments).
    if (adapter.fetchPayments) {
      const open = await many(tx, `SELECT d.external_id, e.aggregate_id, e.topic FROM sync_delivery d JOIN outbox_event e ON e.id = d.outbox_id
        LEFT JOIN supplier_invoice i ON i.id = e.aggregate_id AND e.topic = 'ap.bill.approved'
        LEFT JOIN customer_invoice ci ON ci.id = e.aggregate_id AND e.topic = 'ar.invoice.issued'
        WHERE d.connection_id = $1 AND d.status = 'delivered' AND (i.status = 'exported' OR ci.status IN ('issued', 'partially_paid'))`, [c.id]);
      if (open.length) {
        const paid = await adapter.fetchPayments(tx, actor, c, open.map((o) => o.external_id));
        for (const p of paid) {
          const inv = open.find((o) => o.external_id === p.externalId)!;
          if (inv.topic === 'ar.invoice.issued') {
            if (await onInvoicePaid(tx, actor, inv.aggregate_id, p)) summary.payments++;
          } else {
            await onBillPaid(tx, actor, inv.aggregate_id, p);
            summary.payments++;
          }
        }
      }
    }
    await audit(tx, actor, { action: 'integration.sync_run', entityType: 'integration_connection', entityId: c.id, data: summary });
    return summary;
  });
}

/** Reconciliation: send a parked delivery again (after fixing the cause, e.g. an account mapping). */
export async function retryDelivery(tx: Tx, actor: Actor, id: number) {
  requirePermission(actor, 'integrations.manage');
  const d = await one(tx, `UPDATE sync_delivery SET status = 'pending', attempts = 0, next_attempt_at = now(), resolved_by = $2
    WHERE id = $1 AND status = 'dead' RETURNING id`, [id, actor.userId]);
  if (!d) throw conflict('only dead deliveries can be retried');
  await audit(tx, actor, { action: 'integration.delivery_retried', entityType: 'sync_delivery', entityId: actor.tenantId, data: { deliveryId: id } });
}

/** Reconciliation: close a parked delivery that was handled by hand in the accounting system. */
export async function resolveDelivery(tx: Tx, actor: Actor, id: number, note: string) {
  requirePermission(actor, 'integrations.manage');
  if (!note?.trim()) throw invalid('say how it was resolved (e.g. entered by hand in accounting as bill 1043)');
  const d = await one(tx, `UPDATE sync_delivery SET status = 'skipped', resolved_by = $2, resolution_note = $3 WHERE id = $1 AND status = 'dead' RETURNING id`, [id, actor.userId, note]);
  if (!d) throw conflict('only dead deliveries can be resolved by hand');
  await audit(tx, actor, { action: 'integration.delivery_resolved', entityType: 'sync_delivery', entityId: actor.tenantId, data: { deliveryId: id, note } });
}

// ---------------------------------------------------------------------------
// MOCK accounting controls (demo only): simulate an outage, or a payment made in accounting.
// ---------------------------------------------------------------------------
async function mockConnection(tx: Tx, id: string) {
  const c = await one(tx, 'SELECT * FROM integration_connection WHERE id = $1', [id]);
  if (!c) throw notFound('connection');
  if (!c.is_mock) throw invalid('only available on the MOCK accounting connection');
  return c;
}

export async function mockSimulateOutage(tx: Tx, actor: Actor, id: string, failures: number) {
  requirePermission(actor, 'integrations.manage');
  const c = await mockConnection(tx, id);
  await tx.query('UPDATE integration_connection SET settings = $2 WHERE id = $1', [id, { ...c.settings, failNext: failures }]);
}

/** Marks a MOCK bill paid, or a MOCK customer invoice paid (in full, or partly with `amount`). */
export async function mockPayBill(tx: Tx, actor: Actor, id: string, input: { externalId: string; paidOn?: string; amount?: number }) {
  requirePermission(actor, 'integrations.manage');
  await mockConnection(tx, id);
  const b = await one(tx, `SELECT kind, payload FROM mock_accounting_record WHERE connection_id = $1 AND kind IN ('bill', 'invoice') AND external_id = $2 AND status = 'open'`, [id, input.externalId]);
  if (!b) throw notFound('open MOCK bill or invoice');
  await tx.query(`UPDATE mock_accounting_record SET status = 'paid', paid_on = $3, paid_amount = $4 WHERE connection_id = $1 AND kind = $5 AND external_id = $2`,
    [id, input.externalId, input.paidOn ?? new Date().toISOString().slice(0, 10), input.amount ?? b.payload.total, b.kind]);
}

/** What the MOCK system holds: supplier bills and customer invoices. */
export async function mockBills(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'ap.view');
  await mockConnection(tx, id);
  return many(tx, `SELECT kind, external_id, status, paid_on, paid_amount, payload->>'invoiceNumber' AS invoice_number,
      coalesce(payload->'supplier'->>'name', payload->'customer'->>'name') AS party, coalesce(payload->>'vendorId', payload->>'customerRef') AS party_id,
      (payload->>'total')::float AS total, created_at
    FROM mock_accounting_record WHERE connection_id = $1 AND kind IN ('bill', 'invoice') ORDER BY created_at DESC`, [id]);
}
