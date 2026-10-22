import type { Actor } from './auth/actor.js';
import { asActor } from './auth/actor.js';
import { one } from './db/tx.js';

/**
 * Editions (D-135). Lite is bookkeeping and the company basics: the intranet, policies, expenses, customers and
 * invoicing, suppliers and bills, the built-in books, imports and their reports. Every other API area answers with an
 * upgrade message. The edition is read from the licence (control plane) and cached briefly per tenant.
 */
export const LITE_AREAS = new Set([
  'me', 'facilities', 'users', 'assignable-users', 'user-grants', 'employees', 'licence', 'notifications', 'notification-preferences', 'approvals', 'approval-delegations',
  'announcements', 'quick-links', 'directory', 'search', 'policies', 'handbook', 'expense-policy', 'expense-categories', 'expenses', 'expense-lines', 'expense-rules', 'departments',
  'customers', 'contacts', 'activities', 'opportunities', 'sales-items', 'customer-invoices', 'customer-payments', 'credit-memos', 'collections', 'suppliers', 'supplier-invoices',
  'session', 'sso', 'report-views', 'features', 'account-mappings', 'integrations', 'sync-deliveries', 'export-files', 'imports', 'import-profiles', 'reports', 'books', 'retention',
]);
export const LITE_REPORTS = new Set(['profit-and-loss', 'balance-sheet', 'ar-aging', 'ap-aging', 'expense-summary']);

const cache = new Map<string, { edition: string; at: number }>();
export async function editionOf(actor: Actor): Promise<string> {
  const c = cache.get(actor.tenantId);
  if (c && Date.now() - c.at < 60_000) return c.edition;
  const r = await asActor(actor, (tx) => one(tx, 'SELECT edition FROM tenant_edition()'));
  cache.set(actor.tenantId, { edition: r?.edition ?? 'standard', at: Date.now() });
  return r?.edition ?? 'standard';
}
/** Tests and the control plane change editions; forget the cached value. */
export function forgetEdition(tenantId?: string) { if (tenantId) cache.delete(tenantId); else cache.clear(); }

/** The API area of a path (/api/books/... → books) and, for reports, the report id. */
export function areaOf(url: string) {
  const parts = url.split('?')[0]!.split('/').filter(Boolean); // ['api', area, ...]
  return { area: parts[1] ?? '', report: parts[1] === 'reports' ? parts[2] ?? null : null };
}

export function allowedInLite(url: string) {
  const { area, report } = areaOf(url);
  if (!LITE_AREAS.has(area)) return false;
  return !report || LITE_REPORTS.has(report) || report === 'catalog';
}
