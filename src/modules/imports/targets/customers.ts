import { many, one } from '../../../platform/db/tx.js';
import { createCustomer, saveContact, updateCustomer } from '../../crm/service.js';
import { findExternalRef, flagDuplicates, saveExternalRef } from './common.js';
import type { TargetDefinition } from './types.js';

/**
 * Customer list from an accounting system or CRM export, with its primary contact on the same row.
 * Matched by legacy ID or customer code; blank cells never erase existing values.
 */
export const customersTarget: TargetDefinition = {
  key: 'customers',
  label: 'Customers / accounts',
  entityType: 'customer',
  description: 'Customer and prospect accounts with an optional primary contact per row. Bank and tax IDs stay in accounting; do not import them.',
  naturalKey: 'code',
  commitPermission: 'crm.manage',
  supportsCustomFields: true,
  fields: [
    { key: 'external_id', label: 'Legacy record ID', type: 'string', synonyms: ['record id', 'legacy id', 'customer id', 'account id', 'source id', 'id'] },
    { key: 'code', label: 'Customer code', type: 'string', required: true, maxLength: 40,
      synonyms: ['customer code', 'customer number', 'customer no', 'customer #', 'account number', 'account no', 'acct #', 'code', 'cust no'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 200,
      synonyms: ['name', 'customer name', 'company', 'company name', 'account name', 'customer', 'account', 'business name'] },
    { key: 'kind', label: 'Prospect or customer', type: 'enum', values: ['prospect', 'customer'],
      valueSynonyms: { prospect: ['prospect', 'lead', 'opportunity', 'p'], customer: ['customer', 'client', 'active customer', 'c', 'account'] },
      synonyms: ['type', 'lifecycle stage', 'customer type', 'status', 'kind'] },
    { key: 'industry', label: 'Industry', type: 'string', synonyms: ['industry', 'segment', 'vertical', 'sic description'] },
    { key: 'website', label: 'Website', type: 'string', synonyms: ['website', 'web site', 'url', 'domain', 'company domain name'] },
    { key: 'phone', label: 'Main phone', type: 'string', synonyms: ['phone', 'main phone', 'phone number', 'company phone', 'telephone'] },
    { key: 'billing_address', label: 'Billing address', type: 'text', synonyms: ['billing address', 'bill to', 'address', 'street address', 'bill to address'] },
    { key: 'shipping_address', label: 'Shipping address', type: 'text', synonyms: ['shipping address', 'ship to', 'ship to address', 'delivery address'] },
    { key: 'payment_terms', label: 'Payment terms', type: 'string', synonyms: ['terms', 'payment terms', 'net terms'] },
    { key: 'credit_limit', label: 'Credit limit', type: 'number', min: 0, synonyms: ['credit limit', 'credit line', 'limit'] },
    { key: 'contact_name', label: 'Primary contact name', type: 'string', synonyms: ['contact', 'contact name', 'primary contact', 'main contact', 'attention', 'attn', 'buyer'] },
    { key: 'contact_title', label: 'Primary contact title', type: 'string', synonyms: ['contact title', 'job title', 'title', 'position'] },
    { key: 'contact_email', label: 'Primary contact email', type: 'string', synonyms: ['email', 'e-mail', 'contact email', 'email address', 'buyer email'] },
    { key: 'contact_phone', label: 'Primary contact phone', type: 'string', synonyms: ['contact phone', 'direct phone', 'mobile', 'cell', 'mobile phone'] },
  ],

  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'customer code');
    const existing = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code FROM customer')).map((c) => [c.code, c.id]));
    for (const row of rows) {
      const v = row.values;
      if (v.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v.contact_email))) {
        row.messages.push({ level: 'warning', field: 'contact_email', message: `"${v.contact_email}" does not look like an email address; not imported` });
        v.contact_email = null;
      }
      if ((v.contact_email || v.contact_phone || v.contact_title) && !v.contact_name) {
        row.messages.push({ level: 'warning', field: 'contact_name', message: 'contact details without a contact name; contact not created' });
      }
      const match = (await findExternalRef(ctx, 'customer', v.external_id)) ?? existing.get(String(v.code ?? '').toLowerCase());
      row.action = match ? 'update' : 'create';
      if (ctx.mode === 'create_only' && match) row.messages.push({ level: 'error', field: 'code', message: 'customer already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !match) row.messages.push({ level: 'error', field: 'code', message: 'customer not found (mode is update only)' });
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    const id = (await findExternalRef(ctx, 'customer', v.external_id)) ?? (await one(ctx.tx, 'SELECT id FROM customer WHERE lower(code) = lower($1)', [v.code]))?.id;
    const fields = {
      name: v.name as string, kind: (v.kind as 'prospect' | 'customer') ?? undefined, industry: (v.industry as string) ?? undefined, website: (v.website as string) ?? undefined,
      phone: (v.phone as string) ?? undefined, billingAddress: (v.billing_address as string) ?? undefined, shippingAddress: (v.shipping_address as string) ?? undefined,
      paymentTerms: (v.payment_terms as string) ?? undefined, creditLimit: (v.credit_limit as number) ?? undefined,
      customFields: v.custom_fields && Object.keys(v.custom_fields).length ? v.custom_fields : undefined,
    };
    let customerId = id as string | undefined;
    if (!customerId) customerId = (await createCustomer(ctx.tx, ctx.actor, { code: String(v.code), ...fields, ownerUserId: null })).id as string;
    else await updateCustomer(ctx.tx, ctx.actor, customerId, fields);
    await saveExternalRef(ctx, 'customer', v.external_id, customerId);
    if (v.contact_name) {
      const existing = await one(ctx.tx, 'SELECT id FROM contact WHERE customer_id = $1 AND lower(name) = lower($2)', [customerId, v.contact_name]);
      await saveContact(ctx.tx, ctx.actor, { id: existing?.id, customerId, name: String(v.contact_name), title: (v.contact_title as string) ?? null,
        email: (v.contact_email as string) ?? null, phone: (v.contact_phone as string) ?? null, isPrimary: true });
    }
    return { entityId: customerId, action: id ? 'update' : 'create' };
  },
};
