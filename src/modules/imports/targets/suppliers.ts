import { many, one } from '../../../platform/db/tx.js';
import { createSupplier, setSupplierPrice, updateSupplier } from '../../purchasing/service.js';
import { findExternalRef, flagDuplicates, saveExternalRef } from './common.js';
import type { TargetDefinition } from './types.js';

/** Vendor master from an accounting or purchasing export. Matched by legacy ID or supplier code. */
export const suppliersTarget: TargetDefinition = {
  key: 'suppliers',
  label: 'Suppliers / vendors',
  entityType: 'supplier',
  description: 'Vendor list (code, name, contact, terms). Bank and tax details stay in the accounting system; do not import them.',
  naturalKey: 'code',
  commitPermission: 'purchasing.manage',
  supportsCustomFields: true,
  fields: [
    { key: 'external_id', label: 'Legacy record ID', type: 'string', synonyms: ['legacy id', 'record id', 'vendor id', 'source id'] },
    { key: 'code', label: 'Supplier code', type: 'string', required: true, maxLength: 40,
      synonyms: ['supplier code', 'vendor code', 'vendor number', 'vendor no', 'vendor #', 'supplier number', 'supplier no', 'supplier id', 'code', 'vendor'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 200,
      synonyms: ['name', 'supplier name', 'vendor name', 'company', 'company name', 'supplier', 'business name'] },
    { key: 'contact_name', label: 'Contact', type: 'string', synonyms: ['contact', 'contact name', 'sales contact', 'rep', 'sales rep', 'attention', 'attn'] },
    { key: 'email', label: 'Email', type: 'string', synonyms: ['email', 'e-mail', 'email address', 'po email', 'order email'] },
    { key: 'phone', label: 'Phone', type: 'string', synonyms: ['phone', 'telephone', 'phone number', 'tel', 'main phone'] },
    { key: 'payment_terms', label: 'Payment terms', type: 'string', synonyms: ['terms', 'payment terms', 'pay terms', 'net terms'] },
    { key: 'currency', label: 'Currency', type: 'string', maxLength: 3, synonyms: ['currency', 'ccy', 'currency code'] },
    { key: 'active', label: 'Active', type: 'boolean', synonyms: ['active', 'status', 'vendor status'],
      valueSynonyms: { true: ['active', 'approved', 'a', 'current'], false: ['inactive', 'blocked', 'on hold', 'do not use', 'i', 'closed'] } },
    { key: 'trades', label: 'Trades (contractors)', type: 'string', description: 'Comma or semicolon separated, e.g. "plumbing; hvac"',
      synonyms: ['trade', 'trades', 'service type', 'services', 'specialty', 'vendor type', 'category', 'scope'] },
    { key: 'insurance_expires_on', label: 'Certificate of insurance expires', type: 'date',
      synonyms: ['coi expiration', 'coi expires', 'coi exp', 'insurance expiration', 'insurance expires', 'gl expiration', 'liability insurance expires', 'certificate expiration', 'coi'] },
  ],

  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'supplier code');
    const existing = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code FROM supplier')).map((s) => [s.code, s.id]));
    for (const row of rows) {
      const v = row.values;
      if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v.email))) {
        row.messages.push({ level: 'warning', field: 'email', message: `"${v.email}" does not look like an email address; not imported` });
        v.email = null;
      }
      if (v.currency) v.currency = String(v.currency).toUpperCase();
      const match = (await findExternalRef(ctx, 'supplier', v.external_id)) ?? existing.get(String(v.code ?? '').toLowerCase());
      row.action = match ? 'update' : 'create';
      if (ctx.mode === 'create_only' && match) row.messages.push({ level: 'error', field: 'code', message: 'supplier already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !match) row.messages.push({ level: 'error', field: 'code', message: 'supplier not found (mode is update only)' });
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    const id = (await findExternalRef(ctx, 'supplier', v.external_id)) ?? (await one(ctx.tx, 'SELECT id FROM supplier WHERE lower(code) = lower($1)', [v.code]))?.id;
    const fields = {
      name: v.name as string, contactName: (v.contact_name as string) ?? undefined, email: (v.email as string) ?? undefined, phone: (v.phone as string) ?? undefined,
      paymentTerms: (v.payment_terms as string) ?? undefined, currency: (v.currency as string) ?? undefined,
      customFields: v.custom_fields && Object.keys(v.custom_fields).length ? v.custom_fields : undefined,
    };
    const contractor = async (sid: string) => {
      if (v.trades == null && v.insurance_expires_on == null) return;
      const cur = await one(ctx.tx, 'SELECT trades, insurance_expires_on FROM supplier WHERE id = $1', [sid]);
      const trades = v.trades != null ? String(v.trades).split(/[,;/|]/).map((t) => t.trim().toLowerCase()).filter(Boolean) : cur.trades;
      await ctx.tx.query('UPDATE supplier SET trades = $2, insurance_expires_on = $3 WHERE id = $1', [sid, [...new Set(trades)].sort(), v.insurance_expires_on ?? cur.insurance_expires_on]);
    };
    if (!id) {
      const s = await createSupplier(ctx.tx, ctx.actor, { code: String(v.code), ...fields });
      if (v.active === false) await updateSupplier(ctx.tx, ctx.actor, s.id, { active: false });
      await contractor(s.id);
      await saveExternalRef(ctx, 'supplier', v.external_id, s.id);
      return { entityId: s.id, action: 'create' };
    }
    await updateSupplier(ctx.tx, ctx.actor, id, { ...fields, active: (v.active as boolean | null) ?? undefined });
    await contractor(id);
    await saveExternalRef(ctx, 'supplier', v.external_id, id);
    return { entityId: id, action: 'update' };
  },
};

/** Supplier price list / catalog: price, lead time and the supplier's own part number per part. */
export const supplierPricesTarget: TargetDefinition = {
  key: 'supplier_prices',
  label: 'Supplier price list',
  entityType: 'supplier_part',
  description: 'Price, lead time and supplier part number per supplier and part. Suppliers and parts must exist first. One row per supplier and part.',
  naturalKey: 'part_number',
  commitPermission: 'purchasing.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'supplier_code', label: 'Supplier code', type: 'string', required: true, synonyms: ['supplier code', 'vendor code', 'vendor', 'supplier', 'vendor number', 'vendor no'] },
    { key: 'part_number', label: 'Our part number', type: 'string', required: true,
      synonyms: ['part number', 'our part number', 'internal part number', 'item code', 'item number', 'item', 'our item', 'item no', 'part', 'pn', 'sku'] },
    { key: 'supplier_part_number', label: 'Supplier part number', type: 'string',
      synonyms: ['supplier part number', 'vendor part number', 'vendor item', 'vendor pn', 'supplier pn', 'catalog number', 'cat no', 'their part number'] },
    { key: 'unit_price', label: 'Unit price', type: 'number', min: 0, synonyms: ['unit price', 'price', 'cost', 'net price', 'list price', 'each'] },
    { key: 'lead_time_days', label: 'Lead time (days)', type: 'integer', min: 0, synonyms: ['lead time', 'lead time days', 'lead days', 'lt', 'delivery days'] },
    { key: 'preferred', label: 'Preferred', type: 'boolean', synonyms: ['preferred', 'primary', 'primary vendor', 'default supplier'],
      valueSynonyms: { true: ['yes', 'y', 'x', 'primary', 'preferred', '1', 'true'], false: ['no', 'n', '', '0', 'false', 'alternate'] } },
  ],

  async validate(ctx, rows) {
    const suppliers = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code FROM supplier')).map((s) => [s.code, s.id]));
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS pn FROM part')).map((p) => [p.pn, p.id]));
    const seen = new Map<string, number>();
    const preferredSeen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const s = v.supplier_code ? suppliers.get(String(v.supplier_code).toLowerCase()) : undefined;
      const p = v.part_number ? parts.get(String(v.part_number).toLowerCase()) : undefined;
      if (v.supplier_code && !s) row.messages.push({ level: 'error', field: 'supplier_code', message: `supplier "${v.supplier_code}" not found — import suppliers first` });
      if (v.part_number && !p) row.messages.push({ level: 'error', field: 'part_number', message: `part "${v.part_number}" not found — import the parts list first` });
      if (!s || !p) continue;
      v._supplier_id = s; v._part_id = p;
      const key = `${s}:${p}`;
      if (seen.has(key)) row.messages.push({ level: 'error', message: `same supplier and part already on row ${seen.get(key)}` }); else seen.set(key, row.rowNumber);
      if (v.preferred === true) {
        if (preferredSeen.has(p)) row.messages.push({ level: 'error', field: 'preferred', message: `part already has a preferred supplier on row ${preferredSeen.get(p)}` });
        else preferredSeen.set(p, row.rowNumber);
      }
      if (v.unit_price == null) row.messages.push({ level: 'warning', field: 'unit_price', message: 'no price; requests will need an estimate' });
      row.action = (await one(ctx.tx, 'SELECT 1 FROM supplier_part WHERE supplier_id = $1 AND part_id = $2', [s, p])) ? 'update' : 'create';
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    const existed = !!(await one(ctx.tx, 'SELECT 1 FROM supplier_part WHERE supplier_id = $1 AND part_id = $2', [v._supplier_id, v._part_id]));
    await setSupplierPrice(ctx.tx, ctx.actor, v._supplier_id as string, v._part_id as string, {
      unitPrice: (v.unit_price as number) ?? null, leadTimeDays: (v.lead_time_days as number) ?? null,
      supplierPartNumber: (v.supplier_part_number as string) ?? null, preferred: v.preferred == null ? undefined : v.preferred === true,
    });
    return { entityId: v._part_id as string, action: existed ? 'update' : 'create' };
  },
};
