import { many, one } from '../../../platform/db/tx.js';
import type { AccountingAdapter, DeliveryResult } from '../../../platform/integration/adapter.js';
import { billLines, resolveAccounts } from '../accounts.js';

/**
 * MOCK accounting system — for development and demos only, never a real integration.
 * Stands in for a provider API (vendors, bills, payments) inside this database so the sync framework
 * can be exercised end to end: idempotent retries, failures (settings.failNext simulates an outage),
 * vendor find-or-create via the external-ID crosswalk, voids, and payments made "in accounting".
 */
export const mockAccountingAdapter: AccountingAdapter = {
  provider: 'mock_accounting',
  isMock: true,
  topics: ['ap.bill.approved', 'ap.bill.voided'],
  async deliver(tx, actor, connection, events) {
    const results: DeliveryResult[] = [];
    const sourceSystem = `conn:${connection.id}`;
    for (const e of events) {
      const fail = Number(connection.settings?.failNext ?? 0);
      if (fail > 0) {
        connection.settings = { ...connection.settings, failNext: fail - 1 };
        await tx.query(`UPDATE integration_connection SET settings = $2 WHERE id = $1`, [connection.id, connection.settings]);
        results.push({ eventId: e.id, ok: false, error: 'MOCK: simulated outage (503 Service Unavailable)' });
        continue;
      }
      const p = e.payload;
      if (e.topic === 'ap.bill.voided') {
        const bill = await one(tx, `SELECT external_id, status FROM mock_accounting_record WHERE connection_id = $1 AND kind = 'bill' AND payload->>'invoiceId' = $2`, [connection.id, p.invoiceId]);
        if (!bill) { results.push({ eventId: e.id, ok: false, error: 'MOCK: bill not found in accounting' }); continue; }
        if (bill.status === 'paid') { results.push({ eventId: e.id, ok: false, error: 'MOCK: bill is already paid in accounting; reverse the payment there first', permanent: true }); continue; }
        await tx.query(`UPDATE mock_accounting_record SET status = 'void' WHERE connection_id = $1 AND kind = 'bill' AND external_id = $2`, [connection.id, bill.external_id]);
        results.push({ eventId: e.id, ok: true, externalId: bill.external_id });
        continue;
      }
      // Idempotency: the same key returns the record created by an earlier (possibly unacknowledged) attempt.
      const prior = await one(tx, `SELECT external_id FROM mock_accounting_record WHERE connection_id = $1 AND idempotency_key = $2`, [connection.id, e.idempotency_key]);
      if (prior) { results.push({ eventId: e.id, ok: true, externalId: prior.external_id }); continue; }
      const lines = billLines(p);
      const { map, missing } = await resolveAccounts(tx, lines.map((l) => l.accountKey));
      if (missing.length) { results.push({ eventId: e.id, ok: false, error: `account mapping missing for: ${missing.join(', ')}` }); continue; }
      // Vendor find-or-create, remembered in the external-ID crosswalk for this connection.
      let vendorId = (await one(tx, `SELECT external_id FROM external_ref WHERE source_system = $1 AND entity_type = 'supplier' AND entity_id = $2`, [sourceSystem, p.supplier.id]))?.external_id;
      if (!vendorId) {
        const n = (await one(tx, `SELECT count(*)::int AS n FROM mock_accounting_record WHERE connection_id = $1 AND kind = 'vendor'`, [connection.id])).n + 1;
        vendorId = `MOCK-V-${String(n).padStart(4, '0')}`;
        await tx.query(`INSERT INTO mock_accounting_record (tenant_id, connection_id, kind, external_id, payload) VALUES ($1, $2, 'vendor', $3, $4)`,
          [actor.tenantId, connection.id, vendorId, { code: p.supplier.code, name: p.supplier.name, terms: p.supplier.paymentTerms }]);
        await tx.query(`INSERT INTO external_ref (tenant_id, source_system, entity_type, external_id, entity_id) VALUES ($1, $2, 'supplier', $3, $4)`,
          [actor.tenantId, sourceSystem, vendorId, p.supplier.id]);
      }
      const n = (await one(tx, `SELECT count(*)::int AS n FROM mock_accounting_record WHERE connection_id = $1 AND kind = 'bill'`, [connection.id])).n + 1;
      const billId = `MOCK-B-${String(n).padStart(5, '0')}`;
      await tx.query(`INSERT INTO mock_accounting_record (tenant_id, connection_id, kind, external_id, idempotency_key, payload) VALUES ($1, $2, 'bill', $3, $4, $5)`,
        [actor.tenantId, connection.id, billId, e.idempotency_key, { ...p, vendorId, lines: lines.map((l) => ({ ...l, account: map.get(l.accountKey)!.code })) }]);
      results.push({ eventId: e.id, ok: true, externalId: billId });
    }
    return results;
  },
  async fetchPayments(tx, _actor, connection, externalIds) {
    const rows = await many(tx, `SELECT external_id, paid_on, paid_amount FROM mock_accounting_record
      WHERE connection_id = $1 AND kind = 'bill' AND status = 'paid' AND external_id = ANY ($2)`, [connection.id, externalIds]);
    return rows.map((r) => ({ externalId: r.external_id, paidOn: r.paid_on, amount: Number(r.paid_amount), reference: `MOCK payment for ${r.external_id}` }));
  },
};
