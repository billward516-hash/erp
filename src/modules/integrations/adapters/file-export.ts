import { one } from '../../../platform/db/tx.js';
import type { Actor } from '../../../platform/auth/actor.js';
import type { Tx } from '../../../platform/db/tx.js';
import type { AccountingAdapter, Connection, DeliveryResult, OutboxEvent } from '../../../platform/integration/adapter.js';
import { toCsv } from '../../reporting/render/csv.js';
import { billLines, resolveAccounts } from '../accounts.js';

const AP_HEADER = ['Action', 'Supplier code', 'Supplier name', 'Invoice number', 'Invoice date', 'Due date', 'Currency', 'PO number', 'Facility',
  'Line', 'Description', 'Quantity', 'Unit price', 'Amount', 'Account code', 'Account name', 'Platform invoice ID'];
const AR_HEADER = ['Action', 'Customer code', 'Customer name', 'Invoice number', 'Invoice date', 'Due date', 'Currency', 'Customer PO', 'Order number', 'Facility',
  'Line', 'Description', 'Quantity', 'Unit price', 'Amount', 'Account code', 'Account name', 'Platform invoice ID'];

type Side = { header: string[]; kind: string; prefix: string; created: string; voided: string; side: 'ap' | 'ar'; base: (p: any, action: string) => unknown[] };
const SIDES: Side[] = [
  { header: AP_HEADER, kind: 'ap_bills', prefix: 'ap-bills', created: 'ap.bill.approved', voided: 'ap.bill.voided', side: 'ap',
    base: (p, action) => [action, p.supplier.code, p.supplier.name, p.invoiceNumber, p.invoiceDate, p.dueDate ?? '', p.currency, p.poNumber ?? '', p.facility.code] },
  { header: AR_HEADER, kind: 'ar_invoices', prefix: 'ar-invoices', created: 'ar.invoice.issued', voided: 'ar.invoice.voided', side: 'ar',
    base: (p, action) => [action, p.customer.code, p.customer.name, p.invoiceNumber, p.invoiceDate, p.dueDate ?? '', p.currency, p.customerPo ?? '', p.orderNumber ?? '', p.facility.code] },
];

async function writeSide(tx: Tx, actor: Actor, connection: Connection, side: Side, events: OutboxEvent[]): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  const rows: unknown[][] = [];
  for (const e of events) {
    const p = e.payload;
    const lines = billLines(p, side.side);
    const { map, missing } = await resolveAccounts(tx, lines.map((l) => l.accountKey));
    if (e.topic === side.created && missing.length) { results.push({ eventId: e.id, ok: false, error: `account mapping missing for: ${missing.join(', ')}` }); continue; }
    const base = side.base(p, e.topic === side.voided ? 'VOID' : 'CREATE');
    if (e.topic === side.voided) rows.push([...base, '', `Void invoice ${p.invoiceNumber}`, '', '', '', '', '', p.invoiceId]);
    else lines.forEach((l, i) => rows.push([...base, i + 1, l.description, l.qty, l.unitPrice, l.amount, map.get(l.accountKey)!.code, map.get(l.accountKey)!.name ?? '', p.invoiceId]));
    results.push({ eventId: e.id, ok: true, externalId: '' });
  }
  if (!results.some((r) => r.ok)) return results;
  const name = `${side.prefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  const file = await one(tx, `INSERT INTO export_file (tenant_id, connection_id, kind, file_name, row_count, content) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [actor.tenantId, connection.id, side.kind, name, rows.length, toCsv(side.header, rows.map((r) => Object.fromEntries(side.header.map((h, i) => [h, r[i]]))))]);
  return results.map((r) => (r.ok ? { ...r, externalId: `file:${file.id}` } : r));
}

/**
 * Generic accounting export: each sync run writes one CSV per side (supplier bills, customer invoices)
 * that a person downloads and imports into their accounting system (column names are generic;
 * provider-specific templates come with D-016). Payments are recorded back by hand in this mode.
 */
export const fileExportAdapter: AccountingAdapter = {
  provider: 'file_export',
  isMock: false,
  topics: ['ap.bill.approved', 'ap.bill.voided', 'ar.invoice.issued', 'ar.invoice.voided'],
  async deliver(tx, actor, connection, events) {
    const results: DeliveryResult[] = [];
    for (const side of SIDES) {
      const mine = events.filter((e) => e.topic === side.created || e.topic === side.voided);
      if (mine.length) results.push(...(await writeSide(tx, actor, connection, side, mine)));
    }
    return results;
  },
};
