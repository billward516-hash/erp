import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';

/** Platform account keys used on bill lines; each tenant maps them to their own chart of accounts. */
export const ACCOUNT_KEYS: Record<string, string> = {
  inventory: 'Parts received into a storeroom (inventory asset)',
  maintenance_expense: 'Parts and services used directly (repairs and maintenance expense)',
  capital_projects: 'Capital purchases (construction in progress / fixed assets)',
  freight: 'Freight and delivery charges',
  sales_tax: 'Sales tax on supplier invoices',
  sales_revenue: 'Product sales on customer invoices (revenue)',
  service_revenue: 'Service and labor sales on customer invoices (revenue)',
  freight_income: 'Freight billed to customers',
  sales_tax_payable: 'Sales tax collected on customer invoices (liability)',
  rental_income: 'Rent billed to residents and commercial tenants (revenue)',
  tenant_charges: 'Other recurring charges to tenants: parking, pets, storage, utilities, common-area maintenance (revenue)',
  travel_expense: 'Travel: airfare, lodging, meals while traveling, ground transport, mileage (expense reports)',
  meals_entertainment: 'Business meals with guests (expense reports; often only partly deductible)',
  supplies_expense: 'Office and shop supplies',
  training_expense: 'Training, courses and conferences',
  telecom_expense: 'Phone and internet',
  other_expense: 'Other business expenses',
  employee_reimbursement: 'Amounts owed to employees for approved expense reports (liability until paid)',
  production_materials: 'Production materials used (stock issued to production; cost of goods)',
  utilities_expense: 'Utilities: electricity, gas, water, waste',
  contract_services: 'Contract and professional services',
};

export async function listAccountMappings(tx: Tx, actor: Actor) {
  requirePermission(actor, 'ap.view');
  const rows = await many(tx, 'SELECT account_key, external_code, external_name FROM account_mapping');
  const by = new Map(rows.map((r) => [r.account_key, r]));
  return Object.entries(ACCOUNT_KEYS).map(([key, description]) => ({ key, description, externalCode: by.get(key)?.external_code ?? null, externalName: by.get(key)?.external_name ?? null }));
}

export async function setAccountMapping(tx: Tx, actor: Actor, key: string, input: { externalCode: string | null; externalName?: string | null }) {
  requirePermission(actor, 'integrations.manage');
  if (!ACCOUNT_KEYS[key]) throw invalid(`unknown account key ${key}`);
  if (!input.externalCode?.trim()) await tx.query('DELETE FROM account_mapping WHERE account_key = $1', [key]);
  else {
    await tx.query(`INSERT INTO account_mapping (tenant_id, account_key, external_code, external_name) VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, account_key) DO UPDATE SET external_code = EXCLUDED.external_code, external_name = EXCLUDED.external_name`,
    [actor.tenantId, key, input.externalCode.trim(), input.externalName ?? null]);
  }
  await audit(tx, actor, { action: 'integration.account_mapped', entityType: 'account_mapping', entityId: actor.tenantId, data: { key, ...input } });
}

/** Resolves account keys at delivery time (so fixing a mapping and retrying works). */
export async function resolveAccounts(tx: Tx, keys: string[]) {
  const rows = await many(tx, 'SELECT account_key, external_code, external_name FROM account_mapping WHERE account_key = ANY ($1)', [keys]);
  const map = new Map(rows.map((r) => [r.account_key as string, { code: r.external_code as string, name: r.external_name as string | null }]));
  const missing = [...new Set(keys)].filter((k) => !map.has(k));
  return { map, missing };
}

/** Bill (or customer invoice) lines including tax and freight as their own lines. */
export function billLines(p: any, side: 'ap' | 'ar' = 'ap'): { description: string; qty: number; unitPrice: number; amount: number; accountKey: string }[] {
  const lines = p.lines.map((l: any) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount, accountKey: l.accountKey }));
  if (p.freightAmount > 0) lines.push({ description: 'Freight', qty: 1, unitPrice: p.freightAmount, amount: p.freightAmount, accountKey: side === 'ap' ? 'freight' : 'freight_income' });
  if (p.taxAmount > 0) lines.push({ description: 'Sales tax', qty: 1, unitPrice: p.taxAmount, amount: p.taxAmount, accountKey: side === 'ap' ? 'sales_tax' : 'sales_tax_payable' });
  return lines;
}
