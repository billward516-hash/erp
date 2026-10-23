import type { Grant } from './auth/actor.js';
import type { Tx } from './db/tx.js';
import { many } from './db/tx.js';

/**
 * Feature visibility by role (D-149). Each company decides, feature by feature, whether everyone sees it, only some
 * roles, or nobody. A feature hidden from a role is removed from that role's permissions when the user signs in (so
 * every screen and service check that already exists hides or refuses it), and its own navigation, API areas and
 * reports are refused for a user who sees it nowhere. Only `tenant.admin` users see the Features screen, which lists
 * every feature whatever its setting. Core screens (home, approvals, notifications, reports, administration) are not
 * features and cannot be hidden.
 *
 * `permissions` lists only permissions the feature owns outright; where another feature reads a shared permission
 * (the supplier list, the customer list, accounting settings), the feature hides through navigation and areas instead.
 */
export interface Feature {
  key: string; label: string; group: string; description: string;
  permissions: string[]; nav: string[]; areas: string[]; reports: string[];
  /** Other features that stop making sense, or lose a source, when this one is hidden. */
  affects?: string;
}

export const FEATURES: Feature[] = [
  { key: 'time', label: 'Time and timesheets', group: 'My day', description: 'Weekly timesheets, approvals and the payroll export.',
    permissions: ['time.approve', 'time.view_all', 'time.export'], nav: ['/time'], areas: ['time-entries', 'timesheets', 'payroll', 'earning-codes'], reports: ['labor-time'],
    affects: 'Safety incident rates use timesheet hours.' },
  { key: 'expenses', label: 'Expense reports', group: 'My day', description: 'Expense claims, approvals by department and amount, reimbursement.',
    permissions: ['expenses.submit', 'expenses.view_all', 'expenses.manage'], nav: ['/expenses'], areas: ['expenses', 'expense-lines', 'expense-rules'], reports: ['expense-summary'] },
  { key: 'training', label: 'Training and qualifications', group: 'My day', description: 'Courses, learning events, assessments, qualifications and certificates.',
    permissions: ['learning.view', 'learning.manage', 'learning.assign', 'learning.instruct', 'learning.evaluate', 'learning.view_records', 'qualifications.view', 'qualifications.grant'],
    nav: ['/training'], areas: ['courses', 'course-versions', 'enrollments', 'training', 'training-evidence', 'training-reviews', 'certificates', 'qualification-grants'],
    reports: ['qualification-status', 'training-compliance'], affects: 'Qualification checks on work orders and machines keep applying; nobody can grant new qualifications.' },
  { key: 'news', label: 'News and events', group: 'Company', description: 'Company announcements and the events calendar.',
    permissions: ['announcements.post'], nav: ['/news'], areas: ['announcements'], reports: [] },
  { key: 'performance', label: 'Performance reviews', group: 'Company', description: 'Reviews with each person’s manager, check-ins and goals, at the company’s frequency.',
    permissions: ['performance.manage'], nav: ['/performance'], areas: ['performance'], reports: [] },
  { key: 'people', label: 'People directory', group: 'Company', description: 'Colleagues with their work contact details.', permissions: [], nav: ['/people'], areas: ['directory'], reports: [] },
  { key: 'policies', label: 'Policies and handbook', group: 'Company', description: 'Versioned policies and the employee handbook with acknowledgements.',
    permissions: ['policies.manage'], nav: ['/policies'], areas: ['policies', 'handbook'], reports: [] },
  { key: 'improvements', label: 'Improvements', group: 'Company', description: 'Ideas through to measured savings.',
    permissions: ['improve.submit', 'improve.manage'], nav: ['/improvements'], areas: ['improvements'], reports: ['improvement-pipeline'] },
  { key: 'assets', label: 'Assets', group: 'Maintenance', description: 'The asset register, its documents, history and reliability.', permissions: [], nav: ['/assets'], areas: [],
    reports: ['asset-availability', 'reliability', 'repair-or-replace'], affects: 'Work orders, PM and production still use the assets; only the register pages go.' },
  { key: 'work_orders', label: 'Work orders', group: 'Maintenance', description: 'Maintenance requests, work orders, contractors and kits.',
    permissions: ['work_orders.view', 'work_orders.request', 'work_orders.manage', 'work_orders.execute', 'work_orders.verify'],
    nav: ['/work-orders'], areas: ['maintenance-requests', 'contractors', 'service-levels', 'kits', 'repair-templates'], reports: ['maintenance-backlog', 'kit-readiness', 'service-levels'],
    affects: 'PM and the shift log rely on work orders.' },
  { key: 'pm', label: 'Preventive maintenance', group: 'Maintenance', description: 'PM plans by calendar and meter, and the PM schedule.', permissions: [], nav: ['/pm'], areas: ['pm'], reports: ['pm-compliance'] },
  { key: 'storerooms', label: 'Storerooms and lots', group: 'Maintenance', description: 'Stock by storeroom, receipts, counts, lots and serial numbers.',
    permissions: ['inventory.view', 'inventory.manage'], nav: ['/inventory', '/scan'], areas: ['inventory', 'stock-locations', 'lots', 'scan', 'labels'], reports: ['inventory-reorder', 'lot-status'],
    affects: 'Receiving into stock, kits and production issues need storerooms.' },
  { key: 'production', label: 'Production', group: 'Production', description: 'Product revisions, production orders and the shop floor.',
    permissions: ['production.view', 'production.manage', 'production.execute'], nav: ['/production', '/production/floor'],
    areas: ['production-orders', 'production-entries', 'production-operations', 'product-revisions', 'products', 'scrap-reasons'], reports: ['production-status', 'labor-productivity'],
    affects: 'Planning works from production routings.' },
  { key: 'planning', label: 'Planning', group: 'Production', description: 'Forecasts, capacity and material plans, scenarios.',
    permissions: ['planning.view', 'planning.manage'], nav: ['/planning'], areas: ['plan', 'planning-scenarios', 'forecasts', 'consumption-rates'], reports: ['capacity-plan'] },
  { key: 'shift_log', label: 'Shift log', group: 'Production', description: 'Shift passdown with compiled facts and carried items.', permissions: [], nav: ['/shift-log'], areas: ['shift-logs'], reports: [] },
  { key: 'capa', label: 'CAPA and 8D', group: 'Quality & safety', description: 'Corrective and preventive actions and 8D problem solving, with their dashboard. Corrective actions opened from nonconformances, incidents and audits stay on those records.',
    permissions: [], nav: ['/capa'], areas: ['capa-dashboard'], reports: [] },
  { key: 'quality', label: 'Quality', group: 'Quality & safety', description: 'Nonconformances, corrective actions, audits and calibration.',
    permissions: ['quality.view', 'quality.report', 'quality.manage'], nav: ['/quality'], areas: ['nonconformances', 'corrective-actions', 'audits', 'audit-items', 'calibration', 'read-across'],
    reports: ['quality-status'], affects: 'FMEA and SPC live on the Quality page.' },
  { key: 'fmea', label: 'FMEA', group: 'Quality & safety', description: 'Failure mode and effects analysis.', permissions: [], nav: ['/quality/fmea'], areas: ['fmeas', 'fmea-rows'], reports: ['fmea-risk'] },
  { key: 'spc', label: 'SPC', group: 'Quality & safety', description: 'Statistical process control charts and capability.', permissions: [], nav: ['/quality/spc'], areas: ['spc'], reports: ['spc-summary'] },
  { key: 'safety', label: 'Safety', group: 'Quality & safety', description: 'Incidents, near misses and investigations.',
    permissions: ['safety.report', 'safety.view', 'safety.manage'], nav: ['/safety'], areas: ['incidents'], reports: ['safety-summary'] },
  { key: 'changes', label: 'Management of change', group: 'Quality & safety', description: 'Change requests, reviews, pre-startup safety review.',
    permissions: ['moc.view', 'moc.request', 'moc.manage'], nav: ['/changes'], areas: ['moc', 'moc-actions', 'change-notices', 'temporary-changes'], reports: ['moc-register'] },
  { key: 'continuity', label: 'Business continuity', group: 'Quality & safety', description: 'Continuity plans, exercises and readiness.',
    permissions: ['continuity.view', 'continuity.manage'], nav: ['/continuity'], areas: ['continuity-plans', 'continuity-exercises'], reports: ['continuity-readiness'] },
  { key: 'visits', label: 'Conditions and visits', group: 'Quality & safety', description: 'Condition readings with limits and site visit checklists.',
    permissions: ['visits.view', 'visits.conduct'], nav: ['/stores'], areas: ['condition-points', 'site-visits', 'site-visit-items', 'visit-templates'], reports: ['store-standards'] },
  { key: 'crm', label: 'Customers (CRM)', group: 'Sales & supply', description: 'Customer records, opportunities and activities.', permissions: ['crm.manage'], nav: ['/crm'], areas: ['opportunities'], reports: [],
    affects: 'Invoices still choose customers; only the CRM pages go.' },
  { key: 'sales', label: 'Quotes and orders', group: 'Sales & supply', description: 'Quotes, pricing approval, sales orders and shipments.',
    permissions: ['sales.view', 'sales.quote', 'sales.orders'], nav: ['/sales'], areas: ['quotes', 'customer-rfqs'], reports: ['sales-pipeline', 'quote-aging', 'quote-outcomes', 'rfq-response'] },
  { key: 'purchasing', label: 'Purchasing', group: 'Sales & supply', description: 'Purchase requests, approvals, orders and receiving.',
    permissions: ['purchasing.request', 'purchasing.manage', 'purchasing.receive'], nav: ['/purchasing'], areas: ['purchase-requests', 'purchase-approval-rules', 'rfqs'],
    reports: ['purchasing-status', 'supplier-performance', 'po-aging'], affects: 'Bills still choose suppliers; only purchasing pages go. Planning and reorder suggestions create purchase requests nobody will see.' },
  { key: 'leasing', label: 'Leasing', group: 'Sales & supply', description: 'Units, leases, rent roll and rent billing.',
    permissions: ['leasing.view', 'leasing.manage'], nav: ['/leasing'], areas: ['leases', 'rental-units', 'rent-roll', 'rent-billing', 'unit-turns'], reports: ['rent-roll'] },
  { key: 'books', label: 'Books', group: 'Finance', description: 'The built-in books: journal, banking, reconciliation, statements.',
    permissions: ['books.view', 'books.manage'], nav: ['/books'], areas: ['books'], reports: ['profit-and-loss', 'balance-sheet'], affects: 'Postings continue while the books are the accounting connection.' },
  { key: 'budgets', label: 'Budgets', group: 'Finance', description: 'Spend history, bottom-up and top-down budgets, budget against actual.',
    permissions: ['budgets.view', 'budgets.manage'], nav: ['/budgets'], areas: ['budgets', 'budget-targets', 'budget-submissions', 'spend-analysis', 'spend-categories'], reports: ['budget-vs-actual'] },
  { key: 'proforma', label: 'Business cases', group: 'Finance', description: 'Opportunity pro formas: scenarios, profit and cash by year, payback, NPV and IRR, with finance approval.',
    permissions: ['proforma.view', 'proforma.manage'], nav: ['/proforma'], areas: ['proformas'], reports: ['proforma-portfolio'] },
  { key: 'receivables', label: 'Receivables', group: 'Finance', description: 'Customer invoices, payments, collections and credit memos.',
    permissions: ['ar.view', 'ar.manage', 'ar.credit'], nav: ['/receivables'], areas: ['customer-invoices', 'customer-payments', 'collections', 'credit-memos'], reports: ['ar-aging', 'payment-behavior'] },
  { key: 'payables', label: 'Payables', group: 'Finance', description: 'Supplier bills, approval and payment status.', permissions: ['ap.manage'], nav: ['/ap'], areas: ['supplier-invoices'], reports: ['ap-aging'] },
];
export const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

export interface FeatureSetting { mode: 'all' | 'roles' | 'off'; roleKeys: string[] }

const cache = new Map<string, { at: number; settings: Map<string, FeatureSetting> }>();
/** Settings that differ from "everyone", cached briefly per company (cleared when an administrator saves). */
export async function featureSettings(tx: Tx, tenantId: string) {
  const c = cache.get(tenantId);
  if (c && Date.now() - c.at < 30_000) return c.settings;
  const rows = await many(tx, 'SELECT feature_key, mode, role_keys FROM tenant_feature');
  const settings = new Map(rows.filter((r) => FEATURE_BY_KEY.has(r.feature_key)).map((r) => [r.feature_key as string, { mode: r.mode, roleKeys: r.role_keys } as FeatureSetting]));
  cache.set(tenantId, { at: Date.now(), settings });
  return settings;
}
export function forgetFeatures(tenantId?: string) { if (tenantId) cache.delete(tenantId); else cache.clear(); }

const visibleTo = (s: FeatureSetting | undefined, roles: Set<string>) => !s || s.mode === 'all' || (s.mode === 'roles' && s.roleKeys.some((r) => roles.has(r)));

/**
 * Removes hidden features' permissions from each grant (a feature shown to a role keeps its permissions where the
 * user holds that role), and returns the features the user sees nowhere.
 */
export function applyFeatures(grants: Grant[], settings: Map<string, FeatureSetting>): string[] {
  if (!settings.size) return [];
  const hidden: string[] = [];
  for (const f of FEATURES) {
    const s = settings.get(f.key);
    if (!s || s.mode === 'all') continue;
    let seen = false;
    for (const g of grants) {
      if (visibleTo(s, g.roles)) { seen = true; continue; }
      for (const p of f.permissions) g.permissions.delete(p);
    }
    if (!seen) hidden.push(f.key);
  }
  return hidden;
}

/** The feature each approval subject belongs to: a user who cannot see the feature is not asked to approve its records (D-161). */
export const APPROVAL_FEATURE: Record<string, string> = {
  expense_report: 'expenses', purchase_request: 'purchasing', quote: 'sales', moc_change: 'changes', temporary_change: 'changes', fmea: 'fmea', continuity_plan: 'continuity', proforma: 'proforma',
};

/** The people among `userIds` who can see a feature, by the roles they hold anywhere (so notices go only to people who could act on them). */
export async function seeingFeature(tx: Tx, tenantId: string, userIds: string[], featureKey: string | undefined): Promise<string[]> {
  if (!featureKey || !userIds.length) return userIds;
  const s = (await featureSettings(tx, tenantId)).get(featureKey);
  if (!s || s.mode === 'all') return userIds;
  if (s.mode !== 'roles' || !s.roleKeys.length) return [];
  const rows = await many(tx, `SELECT DISTINCT a.user_id FROM user_role_scope a JOIN role r ON r.id = a.role_id WHERE a.user_id = ANY ($1) AND r.key = ANY ($2)`, [userIds, s.roleKeys]);
  const ok = new Set(rows.map((r) => r.user_id as string));
  return userIds.filter((u) => ok.has(u));
}
export const approvalHidden = (hidden: string[] | undefined, subjectType: string) => !!hidden?.length && hidden.includes(APPROVAL_FEATURE[subjectType] ?? '');

/** The API area or report a request touches, refused when it belongs to a feature the user cannot see. */
export function hiddenFeatureFor(hidden: string[], area: string, report: string | null): Feature | null {
  for (const k of hidden) {
    const f = FEATURE_BY_KEY.get(k)!;
    if (f.areas.includes(area) || (report && f.reports.includes(report))) return f;
  }
  return null;
}
export const hiddenNav = (hidden: string[]) => hidden.flatMap((k) => FEATURE_BY_KEY.get(k)!.nav);
export const hiddenReports = (hidden: string[]) => new Set(hidden.flatMap((k) => FEATURE_BY_KEY.get(k)!.reports));
