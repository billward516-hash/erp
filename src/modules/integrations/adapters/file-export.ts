import { one } from '../../../platform/db/tx.js';
import type { AccountingAdapter, DeliveryResult } from '../../../platform/integration/adapter.js';
import { toCsv } from '../../reporting/render/csv.js';
import { billLines, resolveAccounts } from '../accounts.js';

const HEADER = ['Action', 'Supplier code', 'Supplier name', 'Invoice number', 'Invoice date', 'Due date', 'Currency', 'PO number', 'Facility',
  'Line', 'Description', 'Quantity', 'Unit price', 'Amount', 'Account code', 'Account name', 'Platform invoice ID'];

/**
 * Generic accounts-payable export: each sync run writes one CSV that a person downloads and imports into
 * their accounting system (column names are generic; provider-specific templates come with D-016).
 * Payments are recorded back by hand in this mode.
 */
export const fileExportAdapter: AccountingAdapter = {
  provider: 'file_export',
  isMock: false,
  topics: ['ap.bill.approved', 'ap.bill.voided'],
  async deliver(tx, actor, connection, events) {
    const results: DeliveryResult[] = [];
    const rows: unknown[][] = [];
    for (const e of events) {
      const p = e.payload;
      const lines = billLines(p);
      const { map, missing } = await resolveAccounts(tx, lines.map((l) => l.accountKey));
      if (e.topic === 'ap.bill.approved' && missing.length) { results.push({ eventId: e.id, ok: false, error: `account mapping missing for: ${missing.join(', ')}` }); continue; }
      const base = [e.topic === 'ap.bill.voided' ? 'VOID' : 'CREATE', p.supplier.code, p.supplier.name, p.invoiceNumber, p.invoiceDate, p.dueDate ?? '', p.currency, p.poNumber ?? '', p.facility.code];
      if (e.topic === 'ap.bill.voided') rows.push([...base, '', `Void invoice ${p.invoiceNumber}`, '', '', '', '', '', p.invoiceId]);
      else lines.forEach((l, i) => rows.push([...base, i + 1, l.description, l.qty, l.unitPrice, l.amount, map.get(l.accountKey)!.code, map.get(l.accountKey)!.name ?? '', p.invoiceId]));
      results.push({ eventId: e.id, ok: true, externalId: '' });
    }
    const delivered = results.filter((r) => r.ok);
    if (!delivered.length) return results;
    const name = `ap-bills-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    const file = await one(tx, `INSERT INTO export_file (tenant_id, connection_id, kind, file_name, row_count, content) VALUES ($1, $2, 'ap_bills', $3, $4, $5) RETURNING id`,
      [actor.tenantId, connection.id, name, rows.length, toCsv(HEADER, rows.map((r) => Object.fromEntries(HEADER.map((h, i) => [h, r[i]]))))]);
    return results.map((r) => (r.ok ? { ...r, externalId: `file:${file.id}` } : r));
  },
};
