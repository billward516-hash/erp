/** Permission keys. Roles are tenant-configurable bundles of these. */
export const PERMISSIONS = [
  'tenant.admin',
  'org.view',
  'employees.view',
  'employees.manage',
  'assets.view',
  'assets.manage',
  'assets.record_state',
  'documents.view',
  'documents.view_draft',
  'documents.view_restricted',
  'documents.manage',
  'documents.approve',
  'parts.view',
  'parts.manage',
  'work_orders.view',
  'work_orders.request',
  'work_orders.manage',
  'work_orders.execute',
  'work_orders.verify',
  'imports.run',
  'imports.commit',
  'reports.view',
  'reports.export',
  'audit.view',
  /** Browse the course catalog and take assigned training. */
  'learning.view',
  /** Author courses, versions, assessments; decide training reviews. */
  'learning.manage',
  /** Assign training to employees. */
  'learning.assign',
  /** Record attendance and on-the-job training sign-offs for others. */
  'learning.instruct',
  /** Sign practical evaluations (competency verified). */
  'learning.evaluate',
  /** See other people's training records, scores and evidence (sensitive). */
  'learning.view_records',
  /** See who holds which qualification. */
  'qualifications.view',
  /** Authorize, revoke and certify qualifications. */
  'qualifications.grant',
  /** See management-of-change records. */
  'moc.view',
  /** Raise a change request and edit your own drafts. */
  'moc.request',
  /** Coordinate changes: screen, plan actions, run pre-startup review, close. */
  'moc.manage',
  /** See stock levels and the stock ledger. */
  'inventory.view',
  /** Storerooms, receipts, adjustments, counts, reorder settings. Issuing to work orders uses work_orders.execute. */
  'inventory.manage',
  /** See suppliers, purchase requests and purchase orders. */
  'purchasing.view',
  /** Raise purchase requests and submit them for approval. */
  'purchasing.request',
  /** Suppliers and prices, purchase orders, approval rules. */
  'purchasing.manage',
  /** Receive purchase-order deliveries (into storerooms through the stock ledger). */
  'purchasing.receive',
  /** See supplier invoices, accounts-payable status and aging. */
  'ap.view',
  /** Capture, approve, dispute and void supplier invoices; record payments in file-export mode. */
  'ap.manage',
  /** Connect accounting systems, map accounts, run and resolve syncs. */
  'integrations.manage',
  /** Approve or reject timesheets of employees at the facility (never one's own). */
  'time.approve',
  /** See every employee's timesheet (payroll). Employees always see their own. */
  'time.view_all',
  /** Produce payroll export files from approved timesheets. */
  'time.export',
  /** See customers, contacts, opportunities and activities. */
  'crm.view',
  /** Maintain customers, contacts, opportunities and activities. */
  'crm.manage',
  /** See quotes and sales orders. */
  'sales.view',
  /** Prepare, send and record decisions on quotes. */
  'sales.quote',
  /** Turn accepted quotes into orders, ship and cancel orders, maintain the sales catalog. */
  'sales.orders',
  /** See customer invoices, payments, receivables aging and collections. */
  'ar.view',
  /** Invoice shipments, record payments, work the collections queue, send payment reminders. */
  'ar.manage',
  /** Release orders held for exceeding a customer's credit limit. */
  'ar.credit',
  /** See work centers, product revisions (BOM + routing), production orders and shop-floor records. */
  'production.view',
  /** Work centers, product revisions, production orders: plan, release, receive, complete, close. */
  'production.manage',
  /** Shop floor: start and stop operations, report good/scrap/rework, issue and return materials. */
  'production.execute',
  /** See nonconformances, corrective actions and quality reports. */
  'quality.view',
  /** Raise a nonconformance (anyone who finds a problem: floor, receiving, buyers). */
  'quality.report',
  /** Contain and disposition nonconformances; own, approve and verify corrective actions. */
  'quality.manage',
  /** Report a safety incident or near miss. */
  'safety.report',
  /** See incidents at the facility (without the private details of people involved). */
  'safety.view',
  /** Investigate and classify incidents, see the people involved, decide recordability. */
  'safety.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Starter role templates copied into each new tenant; tenants may edit or add roles. */
export const ROLE_TEMPLATES: Record<string, { name: string; permissions: Permission[] }> = {
  admin: { name: 'Administrator', permissions: [...PERMISSIONS] },
  maintenance_manager: {
    name: 'Maintenance Manager',
    permissions: [
      'org.view', 'employees.view', 'assets.view', 'assets.manage', 'assets.record_state',
      'documents.view', 'documents.view_draft', 'documents.view_restricted', 'documents.manage', 'documents.approve',
      'parts.view', 'parts.manage', 'work_orders.view', 'work_orders.request', 'work_orders.manage',
      'work_orders.execute', 'work_orders.verify', 'imports.run', 'imports.commit', 'reports.view', 'reports.export',
      'learning.view', 'learning.manage', 'learning.assign', 'learning.instruct', 'learning.evaluate', 'learning.view_records',
      'qualifications.view', 'qualifications.grant', 'moc.view', 'moc.request', 'moc.manage', 'inventory.view', 'inventory.manage',
      'purchasing.view', 'purchasing.request', 'purchasing.receive', 'time.approve', 'quality.view', 'quality.report', 'safety.report', 'safety.view',
    ],
  },
  operations_manager: {
    name: 'Operations / Plant Manager',
    permissions: ['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view',
      'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'moc.manage', 'inventory.view',
      'purchasing.view', 'purchasing.request', 'time.approve', 'crm.view', 'sales.view', 'sales.orders', 'production.view', 'production.manage',
      'quality.view', 'quality.report', 'safety.report', 'safety.view'],
  },
  ehs_reviewer: {
    name: 'EHS / Safety Reviewer',
    permissions: ['org.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view', 'reports.view',
      'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'safety.report', 'safety.view', 'safety.manage', 'quality.view'],
  },
  quality_reviewer: {
    name: 'Quality Reviewer',
    permissions: ['org.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view', 'reports.view',
      'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'production.view', 'quality.view', 'quality.report', 'quality.manage', 'safety.report'],
  },
  quality_manager: {
    name: 'Quality Manager',
    permissions: ['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft', 'documents.manage', 'parts.view', 'inventory.view', 'work_orders.view',
      'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'purchasing.view', 'crm.view', 'sales.view',
      'production.view', 'quality.view', 'quality.report', 'quality.manage', 'safety.report'],
  },
  trainer: {
    name: 'Trainer / Evaluator',
    permissions: ['org.view', 'employees.view', 'assets.view', 'documents.view', 'learning.view', 'learning.assign',
      'learning.instruct', 'learning.evaluate', 'learning.view_records', 'qualifications.view', 'moc.view'],
  },
  technician: {
    name: 'Maintenance Technician',
    permissions: [
      'org.view', 'assets.view', 'assets.record_state', 'documents.view', 'parts.view',
      'work_orders.view', 'work_orders.request', 'work_orders.execute', 'reports.view', 'learning.view', 'qualifications.view',
      'moc.view', 'moc.request', 'inventory.view', 'purchasing.view', 'purchasing.request', 'quality.report', 'safety.report',
    ],
  },
  operator: {
    name: 'Operator / Requester',
    permissions: ['org.view', 'assets.view', 'documents.view', 'work_orders.view', 'work_orders.request', 'learning.view', 'moc.view', 'moc.request',
      'production.view', 'production.execute', 'quality.report', 'safety.report'],
  },
  production_supervisor: {
    name: 'Production Supervisor / Planner',
    permissions: ['org.view', 'employees.view', 'assets.view', 'documents.view', 'parts.view', 'inventory.view', 'work_orders.view', 'work_orders.request',
      'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request',
      'purchasing.view', 'purchasing.request', 'sales.view', 'production.view', 'production.manage', 'production.execute', 'quality.view', 'quality.report', 'safety.report', 'safety.view'],
  },
  executive: {
    name: 'Executive (read-only, consolidated)',
    permissions: ['org.view', 'assets.view', 'documents.view', 'work_orders.view', 'parts.view',
      'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'inventory.view', 'purchasing.view', 'ap.view', 'crm.view', 'sales.view', 'ar.view', 'production.view', 'quality.view', 'safety.view'],
  },
  buyer: {
    name: 'Buyer / Purchasing',
    permissions: ['org.view', 'assets.view', 'parts.view', 'parts.manage', 'work_orders.view', 'inventory.view',
      'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'purchasing.view', 'purchasing.request', 'purchasing.manage', 'purchasing.receive', 'ap.view', 'quality.view', 'quality.report'],
  },
  finance_approver: {
    name: 'Finance Approver',
    permissions: ['org.view', 'parts.view', 'reports.view', 'reports.export', 'purchasing.view', 'ap.view', 'ap.manage', 'crm.view', 'sales.view', 'ar.view', 'ar.manage', 'ar.credit'],
  },
  sales_rep: {
    name: 'Sales Representative',
    permissions: ['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'crm.view', 'crm.manage', 'sales.quote', 'sales.view'],
  },
  sales_manager: {
    name: 'Sales Manager',
    permissions: ['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'crm.view', 'crm.manage', 'sales.quote', 'sales.view', 'sales.orders', 'ar.view', 'production.view'],
  },
  ar_clerk: {
    name: 'Billing / Accounts Receivable',
    permissions: ['org.view', 'reports.view', 'reports.export', 'crm.view', 'sales.view', 'ar.view', 'ar.manage'],
  },
  payroll_admin: {
    name: 'Payroll Administrator',
    permissions: ['org.view', 'employees.view', 'reports.view', 'reports.export', 'time.view_all', 'time.export'],
  },
  ap_clerk: {
    name: 'Accounts Payable Clerk',
    permissions: ['org.view', 'parts.view', 'reports.view', 'reports.export', 'purchasing.view', 'ap.view', 'ap.manage'],
  },
};

/** Starter scrap reasons (tenants edit them). */
export const DEFAULT_SCRAP_REASONS: { code: string; label: string }[] = [
  { code: 'DIM', label: 'Out of tolerance' }, { code: 'SURF', label: 'Surface damage / finish' }, { code: 'MAT', label: 'Material defect' },
  { code: 'SETUP', label: 'Setup / first piece' }, { code: 'MACH', label: 'Machine fault' }, { code: 'HAND', label: 'Handling damage' }, { code: 'OTHER', label: 'Other' },
];

/** Starter earning codes (tenants map them to their payroll provider's codes). */
export const DEFAULT_EARNING_CODES: { code: string; label: string; kind: 'worked' | 'paid_leave' | 'unpaid' }[] = [
  { code: 'REG', label: 'Regular hours', kind: 'worked' }, { code: 'OT', label: 'Overtime hours', kind: 'worked' },
  { code: 'PTO', label: 'Paid time off', kind: 'paid_leave' }, { code: 'HOL', label: 'Holiday', kind: 'paid_leave' },
  { code: 'SICK', label: 'Sick leave', kind: 'paid_leave' }, { code: 'UNPAID', label: 'Unpaid leave', kind: 'unpaid' },
];

/**
 * Starter purchase-approval routing copied into each new tenant (editable per tenant): every rule whose
 * threshold the request total reaches adds a step. Amounts are in the tenant currency.
 */
export const DEFAULT_PURCHASE_RULES: { spendType: 'opex' | 'capex' | null; minAmount: number; stage: number; roleKey: string; label: string }[] = [
  { spendType: null, minAmount: 0, stage: 1, roleKey: 'maintenance_manager', label: 'Budget owner approval' },
  { spendType: null, minAmount: 2500, stage: 2, roleKey: 'operations_manager', label: 'Plant manager approval' },
  { spendType: null, minAmount: 10000, stage: 3, roleKey: 'finance_approver', label: 'Finance approval' },
  { spendType: 'capex', minAmount: 0, stage: 3, roleKey: 'finance_approver', label: 'Finance approval (capital)' },
];
