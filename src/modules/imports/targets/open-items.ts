import { many, one } from '../../../platform/db/tx.js';
import { importOpeningBill } from '../../ap/service.js';
import { importOpeningInvoice } from '../../ar/service.js';
import { importOpenOrderLine } from '../../purchasing/service.js';
import { facilityLookup, resolveFacility } from './common.js';
import type { FieldDef, TargetDefinition } from './types.js';

const siteField: FieldDef = { key: 'site_code', label: 'Site code', type: 'string', synonyms: ['site', 'site code', 'plant', 'facility', 'facility code', 'location', 'entity', 'division'] };

/** Unpaid customer invoices at the cutover date, one "balance brought forward" invoice each under the customer's own number. */
export const openCustomerInvoicesTarget: TargetDefinition = {
  key: 'open_customer_invoices', label: 'Open customer invoices', entityType: 'customer_invoice', naturalKey: 'invoice_number', commitPermission: 'ar.manage', supportsCustomFields: false,
  description: 'Invoices still unpaid at the cutover date (an aging report): invoice number, customer, dates and the amount still owed. Customers must exist first. Paid history is not needed. With the built-in books, load the trial balance without the receivables line: these invoices provide it.',
  fields: [
    { key: 'invoice_number', label: 'Invoice number', type: 'string', required: true, synonyms: ['invoice number', 'invoice no', 'invoice #', 'invoice', 'inv no', 'inv #', 'document number', 'doc number', 'reference', 'number', 'num'] },
    { key: 'customer_code', label: 'Customer code', type: 'string', required: true, synonyms: ['customer code', 'customer id', 'customer number', 'customer no', 'cust no', 'customer', 'cust id', 'account number', 'account no', 'name'] },
    { key: 'invoice_date', label: 'Invoice date', type: 'date', required: true, synonyms: ['invoice date', 'date', 'inv date', 'document date', 'transaction date', 'trans date', 'issued', 'issue date'] },
    { key: 'due_date', label: 'Due date', type: 'date', synonyms: ['due date', 'due', 'payment due', 'date due', 'pay by'] },
    { key: 'balance', label: 'Amount still owed', type: 'number', required: true, min: 0,
      synonyms: ['balance', 'amount still owed', 'open amount', 'open balance', 'outstanding', 'amount due', 'amount outstanding', 'unpaid', 'open', 'balance due', 'remaining'] },
    { key: 'customer_po', label: 'Customer PO', type: 'string', synonyms: ['po', 'po number', 'customer po', 'purchase order', 'your reference'] },
    siteField,
    { key: 'notes', label: 'Notes', type: 'string', synonyms: ['notes', 'memo', 'description', 'comment'] },
  ],
  async validate(ctx, rows) {
    const customers = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM customer')).flatMap((c) => [[c.code as string, c.id as string], [c.name as string, c.id as string]]));
    const fac = await facilityLookup(ctx);
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const c = customers.get(String(v.customer_code ?? '').trim().toLowerCase());
      if (!c) row.messages.push({ level: 'error', field: 'customer_code', message: `customer "${v.customer_code}" not found; import customers first` }); else v._customer_id = c;
      const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id;
      if (!(Number(v.balance) > 0)) row.messages.push({ level: 'error', field: 'balance', message: 'the amount still owed must be more than zero; credits are entered as credit memos' });
      const k = String(v.invoice_number ?? '').toLowerCase();
      if (seen.has(k)) row.messages.push({ level: 'error', field: 'invoice_number', message: `invoice ${v.invoice_number} also on row ${seen.get(k)}` }); else seen.set(k, row.rowNumber);
      const cur = await one(ctx.tx, 'SELECT id FROM customer_invoice WHERE lower(number) = $1', [k]);
      row.action = cur ? 'unchanged' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const r = await importOpeningInvoice(ctx.tx, ctx.actor, { customerId: v._customer_id as string, facilityId: v._facility_id as string, number: String(v.invoice_number), invoiceDate: String(v.invoice_date),
      dueDate: (v.due_date as string) ?? null, balance: Number(v.balance), customerPo: (v.customer_po as string) ?? null, notes: (v.notes as string) ?? null });
    return { entityId: r.id, action: r.created ? 'create' : 'unchanged' };
  },
};

/** Unpaid supplier bills at the cutover date. */
export const openSupplierBillsTarget: TargetDefinition = {
  key: 'open_supplier_bills', label: 'Open supplier bills', entityType: 'supplier_invoice', naturalKey: 'invoice_number', commitPermission: 'ap.manage', supportsCustomFields: false,
  description: 'Bills still unpaid at the cutover date (a payables aging): supplier, bill number, dates and the amount still owed. Suppliers must exist first. With the built-in books, load the trial balance without the payables line: these bills provide it.',
  fields: [
    { key: 'invoice_number', label: 'Bill number', type: 'string', required: true, synonyms: ['bill number', 'invoice number', 'invoice no', 'invoice #', 'bill no', 'bill #', 'invoice', 'bill', 'vendor invoice', 'reference', 'number', 'doc number'] },
    { key: 'supplier_code', label: 'Supplier code', type: 'string', required: true, synonyms: ['supplier code', 'vendor code', 'vendor id', 'vendor number', 'vendor no', 'vendor', 'supplier', 'supplier id', 'name', 'vendor name'] },
    { key: 'invoice_date', label: 'Bill date', type: 'date', required: true, synonyms: ['bill date', 'invoice date', 'date', 'document date', 'transaction date', 'trans date'] },
    { key: 'due_date', label: 'Due date', type: 'date', synonyms: ['due date', 'due', 'payment due', 'date due', 'pay by'] },
    { key: 'total', label: 'Amount still owed', type: 'number', required: true, min: 0, synonyms: ['amount still owed', 'balance', 'open amount', 'open balance', 'outstanding', 'amount due', 'amount', 'total', 'unpaid', 'balance due', 'open'] },
    siteField,
    { key: 'notes', label: 'Notes', type: 'string', synonyms: ['notes', 'memo', 'description', 'comment'] },
  ],
  async validate(ctx, rows) {
    const suppliers = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM supplier')).flatMap((c) => [[c.code as string, c.id as string], [c.name as string, c.id as string]]));
    const fac = await facilityLookup(ctx);
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const s = suppliers.get(String(v.supplier_code ?? '').trim().toLowerCase());
      if (!s) row.messages.push({ level: 'error', field: 'supplier_code', message: `supplier "${v.supplier_code}" not found; import suppliers first` }); else v._supplier_id = s;
      const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id;
      if (!(Number(v.total) > 0)) row.messages.push({ level: 'error', field: 'total', message: 'the amount still owed must be more than zero' });
      const k = `${v.supplier_code}|${v.invoice_number}`.toLowerCase();
      if (seen.has(k)) row.messages.push({ level: 'error', field: 'invoice_number', message: `bill ${v.invoice_number} also on row ${seen.get(k)}` }); else seen.set(k, row.rowNumber);
      row.action = s && (await one(ctx.tx, `SELECT 1 FROM supplier_invoice WHERE supplier_id = $1 AND lower(invoice_number) = lower($2) AND status <> 'void'`, [s, v.invoice_number])) ? 'unchanged' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const r = await importOpeningBill(ctx.tx, ctx.actor, { supplierId: v._supplier_id as string, facilityId: v._facility_id as string, invoiceNumber: String(v.invoice_number), invoiceDate: String(v.invoice_date),
      dueDate: (v.due_date as string) ?? null, total: Number(v.total), notes: (v.notes as string) ?? null });
    return { entityId: r.id, action: r.created ? 'create' : 'unchanged' };
  },
};

/** Purchase orders not yet fully received, one row per line. */
export const openPurchaseOrdersTarget: TargetDefinition = {
  key: 'open_purchase_orders', label: 'Open purchase orders', entityType: 'purchase_order', naturalKey: 'order_number', commitPermission: 'purchasing.manage', supportsCustomFields: false,
  description: 'Orders not yet fully received, one row per line: order number, supplier, part (or description), quantity ordered and already received, price, due date. Suppliers and parts must exist first. Received quantities are history; stock on hand is loaded as a count.',
  fields: [
    { key: 'order_number', label: 'PO number', type: 'string', required: true, synonyms: ['po number', 'po no', 'po #', 'po', 'purchase order', 'purchase order number', 'order number', 'order no', 'order'] },
    { key: 'supplier_code', label: 'Supplier code', type: 'string', required: true, synonyms: ['supplier code', 'vendor code', 'vendor id', 'vendor number', 'vendor no', 'vendor', 'supplier', 'vendor name'] },
    { key: 'part_number', label: 'Part number', type: 'string', synonyms: ['part number', 'item', 'item number', 'item code', 'part', 'sku', 'pn', 'our part number'] },
    { key: 'description', label: 'Description', type: 'string', synonyms: ['description', 'item description', 'part description', 'text'] },
    { key: 'qty_ordered', label: 'Quantity ordered', type: 'number', required: true, min: 0, synonyms: ['quantity ordered', 'qty ordered', 'ordered', 'order qty', 'quantity', 'qty'] },
    { key: 'qty_received', label: 'Quantity received', type: 'number', min: 0, synonyms: ['quantity received', 'qty received', 'received', 'received qty', 'qty rec'] },
    { key: 'unit_price', label: 'Unit price', type: 'number', required: true, min: 0, synonyms: ['unit price', 'price', 'unit cost', 'cost', 'net price', 'each'] },
    { key: 'due_date', label: 'Due date', type: 'date', synonyms: ['due date', 'promise date', 'promised date', 'expected', 'expected date', 'delivery date', 'need by', 'required date', 'due'] },
    siteField,
    { key: 'storeroom_code', label: 'Storeroom code', type: 'string', synonyms: ['storeroom', 'storeroom code', 'stock location', 'receive to', 'warehouse'] },
  ],
  async validate(ctx, rows) {
    const suppliers = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM supplier')).flatMap((c) => [[c.code as string, c.id as string], [c.name as string, c.id as string]]));
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS n, description FROM part')).map((p) => [p.n as string, p]));
    const locs = new Map((await many(ctx.tx, 'SELECT id, facility_id, lower(code) AS code FROM stock_location')).map((l) => [l.code as string, l]));
    const fac = await facilityLookup(ctx);
    for (const row of rows) {
      const v = row.values;
      const s = suppliers.get(String(v.supplier_code ?? '').trim().toLowerCase());
      if (!s) row.messages.push({ level: 'error', field: 'supplier_code', message: `supplier "${v.supplier_code}" not found; import suppliers first` }); else v._supplier_id = s;
      const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id;
      if (v.part_number) { const p = parts.get(String(v.part_number).trim().toLowerCase()); if (!p) row.messages.push({ level: 'error', field: 'part_number', message: `part "${v.part_number}" not found; import parts first` }); else { v._part_id = p.id; v._desc = v.description ?? p.description; } }
      else v._desc = v.description;
      if (!v._desc) row.messages.push({ level: 'error', field: 'description', message: 'give a part number or a description' });
      if (v.storeroom_code) { const l = locs.get(String(v.storeroom_code).trim().toLowerCase()); if (!l) row.messages.push({ level: 'error', field: 'storeroom_code', message: `storeroom "${v.storeroom_code}" not found` }); else v._location_id = l.id; }
      if (!(Number(v.qty_ordered) > 0)) row.messages.push({ level: 'error', field: 'qty_ordered', message: 'quantity ordered must be more than zero' });
      if (Number(v.qty_received ?? 0) >= Number(v.qty_ordered)) row.messages.push({ level: 'warning', field: 'qty_received', message: 'this line is fully received; it is brought in as received' });
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const r = await importOpenOrderLine(ctx.tx, ctx.actor, { orderNumber: String(v.order_number), supplierId: v._supplier_id as string, facilityId: v._facility_id as string, partId: (v._part_id as string) ?? null,
      description: String(v._desc), qty: Number(v.qty_ordered), qtyReceived: Number(v.qty_received ?? 0), unitPrice: Number(v.unit_price), expectedOn: (v.due_date as string) ?? null, locationId: (v._location_id as string) ?? null });
    return { entityId: r.id, action: r.created ? 'create' : 'unchanged' };
  },
};
