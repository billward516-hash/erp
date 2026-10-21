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
    ],
  },
  technician: {
    name: 'Maintenance Technician',
    permissions: [
      'org.view', 'assets.view', 'assets.record_state', 'documents.view', 'parts.view',
      'work_orders.view', 'work_orders.request', 'work_orders.execute', 'reports.view',
    ],
  },
  operator: {
    name: 'Operator / Requester',
    permissions: ['org.view', 'assets.view', 'documents.view', 'work_orders.view', 'work_orders.request'],
  },
  executive: {
    name: 'Executive (read-only, consolidated)',
    permissions: ['org.view', 'assets.view', 'documents.view', 'work_orders.view', 'parts.view',
      'reports.view', 'reports.export'],
  },
};
