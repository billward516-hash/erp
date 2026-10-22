import type { Actor } from '../../../platform/auth/actor.js';
import type { Tx } from '../../../platform/db/tx.js';
import { many, one } from '../../../platform/db/tx.js';
import type { AccountingAdapter, Connection, DeliveryResult, OutboxEvent } from '../../../platform/integration/adapter.js';
import { billLines, resolveAccounts } from '../accounts.js';

/** One side of the books in the MOCK system: supplier bills (AP) or customer invoices (AR). */
const SIDES = {
  ap: { record: 'bill', party: 'vendor', entity: 'supplier', recordPrefix: 'MOCK-B-', partyPrefix: 'MOCK-V-', created: 'ap.bill.approved', voided: 'ap.bill.voided',
    party_of: (p: any) => ({ id: p.supplier.id, data: { code: p.supplier.code, name: p.supplier.name, terms: p.supplier.paymentTerms } }) },
  ar: { record: 'invoice', party: 'customer', entity: 'customer', recordPrefix: 'MOCK-I-', partyPrefix: 'MOCK-C-', created: 'ar.invoice.issued', voided: 'ar.invoice.voided',
    party_of: (p: any) => ({ id: p.customer.id, data: { code: p.customer.code, name: p.customer.name, billingAddress: p.customer.billingAddress } }) },
} as const;
type Side = (typeof SIDES)[keyof typeof SIDES];

const sideOf = (topic: string): Side => (topic.startsWith('ar.') ? SIDES.ar : SIDES.ap);

async function count(tx: Tx, connectionId: string, kind: string) {
  return (await one(tx, `SELECT count(*)::int AS n FROM mock_accounting_record WHERE connection_id = $1 AND kind = $2`, [connectionId, kind])).n + 1;
}

async function deliverOne(tx: Tx, actor: Actor, connection: Connection, e: OutboxEvent): Promise<DeliveryResult> {
  const side = sideOf(e.topic);
  const p = e.payload;
  const label = side.record;
  if (e.topic === side.voided) {
    const rec = await one(tx, `SELECT external_id, status FROM mock_accounting_record WHERE connection_id = $1 AND kind = $2 AND payload->>'invoiceId' = $3`, [connection.id, side.record, p.invoiceId]);
    if (!rec) return { eventId: e.id, ok: false, error: `MOCK: ${label} not found in accounting` };
    if (rec.status === 'paid') return { eventId: e.id, ok: false, error: `MOCK: ${label} is already paid in accounting; reverse the payment there first`, permanent: true };
    await tx.query(`UPDATE mock_accounting_record SET status = 'void' WHERE connection_id = $1 AND kind = $2 AND external_id = $3`, [connection.id, side.record, rec.external_id]);
    return { eventId: e.id, ok: true, externalId: rec.external_id };
  }
  // Idempotency: the same key returns the record created by an earlier (possibly unacknowledged) attempt.
  const prior = await one(tx, `SELECT external_id FROM mock_accounting_record WHERE connection_id = $1 AND idempotency_key = $2`, [connection.id, e.idempotency_key]);
  if (prior) return { eventId: e.id, ok: true, externalId: prior.external_id };
  const lines = billLines(p, side === SIDES.ar ? 'ar' : 'ap');
  const { map, missing } = await resolveAccounts(tx, lines.map((l) => l.accountKey));
  if (missing.length) return { eventId: e.id, ok: false, error: `account mapping missing for: ${missing.join(', ')}` };
  // Vendor / customer find-or-create, remembered in the external-ID crosswalk for this connection.
  const sourceSystem = `conn:${connection.id}`;
  const party = side.party_of(p);
  let partyId = (await one(tx, `SELECT external_id FROM external_ref WHERE source_system = $1 AND entity_type = $2 AND entity_id = $3`, [sourceSystem, side.entity, party.id]))?.external_id;
  if (!partyId) {
    partyId = `${side.partyPrefix}${String(await count(tx, connection.id, side.party)).padStart(4, '0')}`;
    await tx.query(`INSERT INTO mock_accounting_record (tenant_id, connection_id, kind, external_id, payload) VALUES ($1, $2, $3, $4, $5)`,
      [actor.tenantId, connection.id, side.party, partyId, party.data]);
    await tx.query(`INSERT INTO external_ref (tenant_id, source_system, entity_type, external_id, entity_id) VALUES ($1, $2, $3, $4, $5)`,
      [actor.tenantId, sourceSystem, side.entity, partyId, party.id]);
  }
  const recordId = `${side.recordPrefix}${String(await count(tx, connection.id, side.record)).padStart(5, '0')}`;
  const partyKey = side === SIDES.ar ? 'customerRef' : 'vendorId';
  await tx.query(`INSERT INTO mock_accounting_record (tenant_id, connection_id, kind, external_id, idempotency_key, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor.tenantId, connection.id, side.record, recordId, e.idempotency_key, { ...p, [partyKey]: partyId, lines: lines.map((l) => ({ ...l, account: map.get(l.accountKey)!.code })) }]);
  return { eventId: e.id, ok: true, externalId: recordId };
}

/**
 * MOCK accounting system — for development and demos only, never a real integration.
 * Stands in for a provider API (vendors, bills, customers, invoices, payments) inside this database so the
 * sync framework can be exercised end to end: idempotent retries, failures (settings.failNext simulates an
 * outage), vendor/customer find-or-create via the external-ID crosswalk, voids, and payments made "in accounting".
 */
export const mockAccountingAdapter: AccountingAdapter = {
  provider: 'mock_accounting',
  isMock: true,
  topics: ['ap.bill.approved', 'ap.bill.voided', 'ar.invoice.issued', 'ar.invoice.voided'],
  async deliver(tx, actor, connection, events) {
    const results: DeliveryResult[] = [];
    for (const e of events) {
      const fail = Number(connection.settings?.failNext ?? 0);
      if (fail > 0) {
        connection.settings = { ...connection.settings, failNext: fail - 1 };
        await tx.query(`UPDATE integration_connection SET settings = $2 WHERE id = $1`, [connection.id, connection.settings]);
        results.push({ eventId: e.id, ok: false, error: 'MOCK: simulated outage (503 Service Unavailable)' });
        continue;
      }
      results.push(await deliverOne(tx, actor, connection, e));
    }
    return results;
  },
  async fetchPayments(tx, _actor, connection, externalIds) {
    const rows = await many(tx, `SELECT external_id, paid_on, paid_amount FROM mock_accounting_record
      WHERE connection_id = $1 AND kind IN ('bill', 'invoice') AND status = 'paid' AND external_id = ANY ($2)`, [connection.id, externalIds]);
    return rows.map((r) => ({ externalId: r.external_id, paidOn: r.paid_on, amount: Number(r.paid_amount), reference: `MOCK payment for ${r.external_id}` }));
  },
};
