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
      'qualifications.view', 'qualifications.grant', 'moc.view', 'moc.request', 'moc.manage',
    ],
  },
  operations_manager: {
    name: 'Operations / Plant Manager',
    permissions: ['org.view', 'employees.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view',
      'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view', 'moc.request', 'moc.manage'],
  },
  ehs_reviewer: {
    name: 'EHS / Safety Reviewer',
    permissions: ['org.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view', 'reports.view',
      'learning.view', 'qualifications.view', 'moc.view', 'moc.request'],
  },
  quality_reviewer: {
    name: 'Quality Reviewer',
    permissions: ['org.view', 'assets.view', 'documents.view', 'documents.view_draft', 'work_orders.view', 'reports.view',
      'learning.view', 'qualifications.view', 'moc.view', 'moc.request'],
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
      'moc.view', 'moc.request',
    ],
  },
  operator: {
    name: 'Operator / Requester',
    permissions: ['org.view', 'assets.view', 'documents.view', 'work_orders.view', 'work_orders.request', 'learning.view', 'moc.view', 'moc.request'],
  },
  executive: {
    name: 'Executive (read-only, consolidated)',
    permissions: ['org.view', 'assets.view', 'documents.view', 'work_orders.view', 'parts.view',
      'reports.view', 'reports.export', 'learning.view', 'qualifications.view', 'moc.view'],
  },
};
