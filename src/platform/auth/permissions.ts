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
  /** See business continuity plans, exercises and the readiness report. */
  'continuity.view',
  /** Write continuity plans, schedule and record exercises, confirm periodic reviews. */
  'continuity.manage',
  /** See equipment qualification, protocols, the equipment logbook and tool states. */
  'qualification.view',
  /** Write qualification protocols, put equipment under qualification control, set intervals, declare existing qualification. */
  'qualification.manage',
  /** Record protocol results, execute a protocol, add logbook notes. */
  'qualification.execute',
  /** See rental units, leases, the rent roll and unit turns. */
  'leasing.view',
  /** Write leases, give notice, record move-outs, run rent billing, manage unit turns. */
  'leasing.manage',
  /** See site visits (store walks, checklists) and their scores. */
  'visits.view',
  /** Conduct site visits and keep the checklist templates. */
  'visits.conduct',
  /** See customer forecasts, the capacity and material plan, and scenarios. */
  'planning.view',
  /** Load and activate customer forecasts, set work-center calendars, save scenarios. */
  'planning.manage',
  /** Suggest an improvement (everyone). */
  'improve.submit',
  /** Approve, own and validate improvements and their savings. */
  'improve.manage',
  /** Write and publish policies and the employee handbook; set the expense policy rules; see who has acknowledged. Everyone reads published policies. */
  'policies.manage',
  /** Post and withdraw company announcements and events on the home page; keep the quick links. */
  'announcements.post',
  /** Claim business expenses (everyone). Approving is by approval step, not by permission. */
  'expenses.submit',
  /** See every expense report at the facility (finance). Claimants always see their own; approvers see what they sign. */
  'expenses.view_all',
  /** Expense approval rules and department heads; record reimbursements. */
  'expenses.manage',
  /** See budgets, spend history by category and budget against actual. Department heads also see and edit their own department's lines. */
  'budgets.view',
  /** Spend categories, budgets, top-down targets and allocation, reviewing submissions, approving and closing budgets. */
  'budgets.manage',
  /** See the built-in books: accounts, journal, statements, bank lines. */
  'books.view',
  /** Keep the built-in books: set up, chart of accounts, manual entries, bank review and rules, reconciliation, period lock. */
  'books.manage',
  /** See opportunity pro formas (D-162): business cases with their projections and scenarios. */
  'proforma.view',
  /** Build, submit and reopen opportunity pro formas. */
  'proforma.manage',
  /** Run performance reviews (D-155): settings, every review, assigning reviewers. Reviewers and employees need no permission for their own. */
  'performance.manage',
  /** See service agreements, visits, technicians and vehicles. */
  'fieldservice.view',
  /** Agreements, covered units, dispatch, technicians and vehicles. */
  'fieldservice.manage',
  /** Work your own visits from the tablet: service reports and sign-off. */
  'fieldservice.execute',
  /** See laboratory samples, methods, results, investigations and certificates of analysis (D-184D). */
  'lab.view',
  /** Receive samples, record custody, assign tests, enter results and work investigations; the method's qualification and a calibrated instrument are still required. */
  'lab.analyze',
  /** Review results entered by someone else, close out-of-specification investigations and release samples. */
  'lab.review',
  /** Keep the laboratory's methods and dispose of samples. */
  'lab.manage',
  /** See cleanrooms, their points, readings, excursions and trends (SC-007 A). */
  'cleanroom.view',
  /** Record or import cleanroom readings. */
  'cleanroom.record',
  /** Keep cleanrooms, monitoring points, sampling frequency and limits. */
  'cleanroom.manage',
  /** See chemical containers, preparations and the chemical reports (SC-007 C). */
  'chemicals.view',
  /** Mark parts as chemicals, keep storage groups, containers and preparations, set per-location limits. */
  'chemicals.manage',
  /** Place or move a container beside an incompatible storage group, with a reason that is audited. */
  'chemicals.override',
  /** See your own assignments, capacity and utilization, and the people who report to you (D-188C). */
  'staffing.view_own',
  /** See the capacity, assignments and utilization of everyone at the facility. */
  'staffing.view_team',
  /** Assign people to projects, set working patterns, holidays, targets; decide time-off requests. */
  'staffing.manage',
  /** See support tickets, the queue and ticket reports at the site. */
  'tickets.view',
  /** Raise, reply to, assign to yourself, move and log time on tickets. */
  'tickets.work',
  /** Service levels, business hours, categories, canned replies, public ticket links; assign others; reopen closed tickets. */
  'tickets.manage',
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
      'purchasing.view', 'purchasing.request', 'purchasing.receive', 'time.approve', 'quality.view', 'quality.report', 'safety.report', 'safety.view', 'continuity.view', 'visits.view', 'planning.view',
    ],
  },
  operations_manager: {
    name: 'Operations / Plant Manager',
    permissions: ['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view',
      'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'moc.manage', 'inventory.view',
      'purchasing.view', 'purchasing.request', 'time.approve', 'crm.view', 'sales.view', 'sales.orders', 'production.view', 'production.manage',
      'quality.view', 'quality.report', 'safety.report', 'safety.view', 'continuity.view', 'continuity.manage', 'visits.view', 'visits.conduct', 'planning.view', 'planning.manage', 'announcements.post',
      'tickets.view', 'tickets.work', 'tickets.manage'],
  },
  ehs_reviewer: {
    name: 'EHS / Safety Reviewer',
    permissions: ['org.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view', 'reports.view',
      'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'safety.report', 'safety.view', 'safety.manage', 'quality.view', 'continuity.view', 'continuity.manage'],
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
      'production.view', 'quality.view', 'quality.report', 'quality.manage', 'safety.report', 'continuity.view', 'visits.view'],
  },
  property_manager: {
    name: 'Property / Facilities Manager',
    permissions: ['org.view', 'employees.view', 'assets.view', 'assets.manage', 'assets.record_state', 'documents.view', 'documents.view_draft', 'documents.manage', 'parts.view',
      'work_orders.view', 'work_orders.request', 'work_orders.manage', 'work_orders.execute', 'work_orders.verify', 'imports.run', 'imports.commit', 'reports.view', 'reports.export',
      'learning.view', 'inventory.view', 'purchasing.view', 'purchasing.request', 'ap.view', 'crm.view', 'safety.report', 'safety.view', 'continuity.view',
      'leasing.view', 'leasing.manage', 'ar.view', 'ar.manage', 'visits.view', 'visits.conduct'],
  },
  district_manager: {
    name: 'District / Area Manager',
    permissions: ['org.view', 'employees.view', 'assets.view', 'assets.record_state', 'documents.view', 'work_orders.view', 'work_orders.request', 'work_orders.manage',
      'work_orders.verify', 'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'safety.report', 'safety.view', 'quality.report', 'purchasing.view', 'ap.view',
      'visits.view', 'visits.conduct'],
  },
  store_manager: {
    name: 'Store / Site Manager',
    permissions: ['org.view', 'assets.view', 'assets.record_state', 'documents.view', 'work_orders.view', 'work_orders.request', 'work_orders.verify', 'reports.view',
      'learning.view', 'safety.report', 'quality.report', 'visits.view'],
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
  service_dispatcher: {
    name: 'Service Dispatcher',
    permissions: ['org.view', 'employees.view', 'assets.view', 'crm.view', 'sales.view', 'sales.quote', 'work_orders.view', 'work_orders.manage', 'inventory.view', 'parts.view', 'reports.view', 'documents.view', 'qualifications.view',
      'fieldservice.view', 'fieldservice.manage', 'tickets.view', 'tickets.work'],
  },
  field_technician: {
    name: 'Field Technician',
    permissions: ['org.view', 'assets.view', 'documents.view', 'parts.view', 'work_orders.view', 'work_orders.execute', 'inventory.view', 'learning.view', 'qualifications.view', 'crm.view', 'fieldservice.view', 'fieldservice.execute'],
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
      'purchasing.view', 'purchasing.request', 'sales.view', 'production.view', 'production.manage', 'production.execute', 'quality.view', 'quality.report', 'safety.report', 'safety.view', 'continuity.view', 'planning.view', 'planning.manage'],
  },
  support_agent: {
    name: 'Support Agent',
    permissions: ['org.view', 'crm.view', 'reports.view', 'documents.view', 'tickets.view', 'tickets.work'],
  },
  support_manager: {
    name: 'Support Manager',
    permissions: ['org.view', 'crm.view', 'reports.view', 'reports.export', 'documents.view', 'tickets.view', 'tickets.work', 'tickets.manage', 'time.approve'],
  },
  executive: {
    name: 'Executive (read-only, consolidated)',
    permissions: ['org.view', 'assets.view', 'documents.view', 'work_orders.view', 'parts.view',
      'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'inventory.view', 'purchasing.view', 'ap.view', 'crm.view', 'sales.view', 'ar.view', 'production.view', 'quality.view', 'safety.view', 'continuity.view', 'leasing.view', 'visits.view', 'planning.view', 'tickets.view'],
  },
  buyer: {
    name: 'Buyer / Purchasing',
    permissions: ['org.view', 'assets.view', 'parts.view', 'parts.manage', 'work_orders.view', 'inventory.view',
      'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'purchasing.view', 'purchasing.request', 'purchasing.manage', 'purchasing.receive', 'ap.view', 'quality.view', 'quality.report', 'continuity.view', 'planning.view'],
  },
  finance_approver: {
    name: 'Finance Approver',
    permissions: ['org.view', 'parts.view', 'reports.view', 'reports.export', 'purchasing.view', 'ap.view', 'ap.manage', 'crm.view', 'sales.view', 'ar.view', 'ar.manage', 'ar.credit', 'leasing.view'],
  },
  sales_rep: {
    name: 'Sales Representative',
    permissions: ['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'crm.view', 'crm.manage', 'sales.quote', 'sales.view'],
  },
  sales_manager: {
    name: 'Sales Manager',
    permissions: ['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'crm.view', 'crm.manage', 'sales.quote', 'sales.view', 'sales.orders', 'ar.view', 'production.view', 'planning.view'],
  },
  ar_clerk: {
    name: 'Billing / Accounts Receivable',
    permissions: ['org.view', 'reports.view', 'reports.export', 'crm.view', 'sales.view', 'ar.view', 'ar.manage', 'leasing.view'],
  },
  payroll_admin: {
    name: 'Payroll Administrator',
    permissions: ['org.view', 'employees.view', 'reports.view', 'reports.export', 'time.view_all', 'time.export', 'policies.manage'],
  },
  bookkeeper: {
    name: 'Bookkeeper',
    permissions: ['org.view', 'reports.view', 'reports.export', 'imports.run', 'imports.commit', 'books.view', 'books.manage', 'ar.view', 'ar.manage', 'ap.view', 'ap.manage',
      'crm.view', 'crm.manage', 'sales.view', 'purchasing.view', 'purchasing.manage', 'expenses.view_all', 'expenses.manage', 'integrations.manage'],
  },
  hr_manager: {
    name: 'HR Manager',
    permissions: ['org.view', 'employees.view', 'employees.manage', 'reports.view', 'reports.export', 'learning.view', 'learning.assign', 'learning.view_records',
      'qualifications.view', 'time.view_all', 'policies.manage', 'announcements.post', 'performance.manage'],
  },
  ap_clerk: {
    name: 'Accounts Payable Clerk',
    permissions: ['org.view', 'parts.view', 'reports.view', 'reports.export', 'purchasing.view', 'ap.view', 'ap.manage'],
  },
};

// Equipment qualification (migration 0130): maintenance manages and executes; quality manages; technicians execute; managers and auditors read.
for (const [key, role] of Object.entries(ROLE_TEMPLATES)) {
  if (['maintenance_manager'].includes(key)) role.permissions.push('qualification.view', 'qualification.manage', 'qualification.execute');
  if (key === 'quality_manager') role.permissions.push('qualification.view', 'qualification.manage');
  if (['technician', 'field_technician'].includes(key)) role.permissions.push('qualification.view', 'qualification.execute');
  if (['operations_manager', 'quality_reviewer', 'ehs_reviewer', 'executive', 'property_manager'].includes(key)) role.permissions.push('qualification.view');
}

// Improvement suggestions are open to everyone; leads approve, own and validate them (migration 0032 does the same for
// existing tenants). Everyone claims expenses; finance sees and pays them (migration 0038).
for (const [key, role] of Object.entries(ROLE_TEMPLATES)) {
  if (!role.permissions.includes('expenses.submit')) role.permissions.push('expenses.submit');
  if (['finance_approver', 'ap_clerk'].includes(key)) role.permissions.push('expenses.view_all', 'expenses.manage');
  // Budgets (migration 0039): managers read them; finance manages them.
  if (['maintenance_manager', 'operations_manager', 'production_supervisor', 'quality_manager', 'executive', 'buyer', 'property_manager', 'sales_manager', 'hr_manager'].includes(key)) role.permissions.push('budgets.view');
  // Finance loads spend history from the previous accounting system (imports).
  if (key === 'finance_approver') role.permissions.push('budgets.view', 'budgets.manage', 'imports.run', 'imports.commit');
  // Built-in books (migration 0040): finance and executives read them; bookkeepers and administrators keep them.
  if (['finance_approver', 'executive'].includes(key)) role.permissions.push('books.view');
  if (!role.permissions.includes('improve.submit')) role.permissions.push('improve.submit');
  if (['maintenance_manager', 'operations_manager', 'production_supervisor', 'quality_manager', 'executive'].includes(key) && !role.permissions.includes('improve.manage')) role.permissions.push('improve.manage');
  // Opportunity pro formas (migration 0064): finance, operations and property build them; executives and districts read them.
  if (['finance_approver', 'operations_manager', 'property_manager'].includes(key)) role.permissions.push('proforma.view', 'proforma.manage');
  if (['executive', 'district_manager'].includes(key)) role.permissions.push('proforma.view');
  // Operations and sales managers read the parts catalog for stock, quotes and orders (migration 0063).
  if (['operations_manager', 'sales_manager'].includes(key) && !role.permissions.includes('parts.view')) role.permissions.push('parts.view');
  // Cleanroom environmental monitoring (migration 0120).
  if (['quality_manager', 'operations_manager'].includes(key)) role.permissions.push('cleanroom.view', 'cleanroom.record', 'cleanroom.manage');
  if (['quality_reviewer', 'production_supervisor', 'maintenance_manager', 'technician', 'operator'].includes(key)) role.permissions.push('cleanroom.view', 'cleanroom.record');
  if (['executive', 'ehs_reviewer'].includes(key)) role.permissions.push('cleanroom.view');
  // Chemicals and reagents (migration 0140).
  if (['ehs_reviewer', 'maintenance_manager', 'quality_manager'].includes(key)) role.permissions.push('chemicals.view', 'chemicals.manage');
  if (key === 'ehs_reviewer') role.permissions.push('chemicals.override');
  if (['operations_manager', 'quality_reviewer', 'technician', 'production_supervisor', 'executive'].includes(key)) role.permissions.push('chemicals.view');
  // Staffing and utilization (migration 0190): everyone sees their own; operations, HR and executives see teams; operations and HR manage.
  if (!role.permissions.includes('staffing.view_own')) role.permissions.push('staffing.view_own');
  if (['operations_manager', 'hr_manager', 'executive', 'district_manager'].includes(key) && !role.permissions.includes('staffing.view_team')) role.permissions.push('staffing.view_team');
  if (['operations_manager', 'hr_manager'].includes(key) && !role.permissions.includes('staffing.manage')) role.permissions.push('staffing.manage');
}

// Laboratory samples and test results (migration 0150, D-184D): analysts enter, quality reviewers review, laboratory managers do both and keep the methods.
ROLE_TEMPLATES.lab_analyst = { name: 'Laboratory Analyst', permissions: ['org.view', 'assets.view', 'documents.view', 'learning.view', 'qualifications.view', 'reports.view', 'quality.report', 'lab.view', 'lab.analyze', 'expenses.submit', 'improve.submit'] };
ROLE_TEMPLATES.lab_manager = { name: 'Laboratory Manager', permissions: ['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft', 'learning.view', 'qualifications.view', 'reports.view', 'reports.export',
  'quality.view', 'quality.report', 'crm.view', 'lab.view', 'lab.analyze', 'lab.review', 'lab.manage', 'expenses.submit', 'improve.submit'] };
ROLE_TEMPLATES.quality_manager!.permissions.push('lab.view', 'lab.review', 'lab.manage');
ROLE_TEMPLATES.quality_reviewer!.permissions.push('lab.view', 'lab.review');

/** Starter expense categories (tenants set the limits in the expense policy; empty means no limit). Same list as migration 0036. */
export const DEFAULT_EXPENSE_CATEGORIES: { code: string; name: string; kind: 'amount' | 'mileage'; needsAttendees?: boolean; accountKey: string; order: number }[] = [
  { code: 'AIR', name: 'Airfare', kind: 'amount', accountKey: 'travel_expense', order: 10 }, { code: 'LODGING', name: 'Lodging', kind: 'amount', accountKey: 'travel_expense', order: 20 },
  { code: 'MEALS', name: 'Meals while traveling', kind: 'amount', accountKey: 'travel_expense', order: 30 },
  { code: 'BIZMEAL', name: 'Business meals with guests', kind: 'amount', needsAttendees: true, accountKey: 'meals_entertainment', order: 40 },
  { code: 'GROUND', name: 'Taxi, rideshare, rental car', kind: 'amount', accountKey: 'travel_expense', order: 50 },
  { code: 'MILEAGE', name: 'Mileage (personal vehicle)', kind: 'mileage', accountKey: 'travel_expense', order: 60 },
  { code: 'PARKING', name: 'Parking and tolls', kind: 'amount', accountKey: 'travel_expense', order: 70 },
  { code: 'SUPPLIES', name: 'Office and shop supplies', kind: 'amount', accountKey: 'supplies_expense', order: 80 },
  { code: 'TRAINING', name: 'Training and conferences', kind: 'amount', accountKey: 'training_expense', order: 90 },
  { code: 'PHONE', name: 'Phone and internet', kind: 'amount', accountKey: 'telecom_expense', order: 100 },
  { code: 'TOOLS', name: 'Tools and small equipment', kind: 'amount', accountKey: 'maintenance_expense', order: 110 },
  { code: 'OTHER', name: 'Other (explain)', kind: 'amount', accountKey: 'other_expense', order: 200 },
];

/** Lite edition (D-135): one site, five users; the owner approves expenses; single-person approval allowed. */
export const LITE_LIMITS = { userCap: 5, siteCap: 1 } as const;
export const LITE_EXPENSE_RULES = [{ minAmount: 0, stage: 1, approver: 'role', roleKey: 'admin', label: 'Owner approval' }] as const;

/** Starter expense approval routing (migration 0038 adds the same for existing tenants). */
export const DEFAULT_EXPENSE_RULES = [
  { minAmount: 0, stage: 1, approver: 'department_head', roleKey: 'operations_manager', label: 'Manager approval' },
  { minAmount: 500, stage: 2, approver: 'role', roleKey: 'finance_approver', label: 'Finance review' },
  { minAmount: 5000, stage: 3, approver: 'role', roleKey: 'executive', label: 'Executive approval' },
] as const;

/** Starter spend categories over the platform's account keys (migration 0039 adds the same for existing tenants). */
export const DEFAULT_SPEND_CATEGORIES: { code: string; name: string; keys: string[]; order: number }[] = [
  { code: 'MAINT', name: 'Maintenance and repairs', keys: ['maintenance_expense'], order: 10 }, { code: 'PRODMAT', name: 'Production materials', keys: ['production_materials'], order: 20 },
  { code: 'CAPEX', name: 'Capital equipment and projects', keys: ['capital_projects'], order: 30 }, { code: 'FREIGHT', name: 'Freight', keys: ['freight'], order: 40 },
  { code: 'TRAVEL', name: 'Travel', keys: ['travel_expense'], order: 50 }, { code: 'MEALS', name: 'Meals and entertainment', keys: ['meals_entertainment'], order: 60 },
  { code: 'SUPPLIES', name: 'Supplies', keys: ['supplies_expense'], order: 70 }, { code: 'TRAINING', name: 'Training', keys: ['training_expense'], order: 80 },
  { code: 'TELECOM', name: 'Phone and internet', keys: ['telecom_expense'], order: 90 }, { code: 'UTIL', name: 'Utilities', keys: ['utilities_expense'], order: 100 },
  { code: 'SERVICES', name: 'Contract and professional services', keys: ['contract_services'], order: 110 }, { code: 'OTHER', name: 'Other', keys: ['other_expense', 'sales_tax'], order: 200 },
];

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
