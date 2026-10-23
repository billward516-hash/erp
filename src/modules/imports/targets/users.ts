import { many, one } from '../../../platform/db/tx.js';
import { saveUser } from '../../org/service.js';
import { grantRole } from '../../sites/service.js';
import { facilityLookup, resolveFacility } from './common.js';
import type { TargetDefinition } from './types.js';

/** People who sign in, with their roles: one row per person and role (repeat the person for more roles). Matched by work email. */
export const usersRolesTarget: TargetDefinition = {
  key: 'users_roles', label: 'People who sign in, with roles', entityType: 'app_user', naturalKey: 'email', commitPermission: 'tenant.admin', supportsCustomFields: false,
  description: 'Work email, name, the employee number (to link the employee record), a role and the site it applies to. Leave the site blank for all sites. One row per role: repeat the person for a second role. They sign in through the company\'s identity provider, which finds them by email.',
  fields: [
    { key: 'email', label: 'Work email', type: 'string', required: true, synonyms: ['email', 'work email', 'email address', 'e-mail', 'login', 'username', 'user'] },
    { key: 'display_name', label: 'Name', type: 'string', synonyms: ['name', 'full name', 'display name', 'user name', 'employee name'] },
    { key: 'employee_number', label: 'Employee number', type: 'string', synonyms: ['employee number', 'employee id', 'emp no', 'emp #', 'badge', 'payroll id', 'staff number'] },
    { key: 'role', label: 'Role', type: 'string', required: true, description: 'A role name as shown under Administration, for example Maintenance Manager or Technician',
      synonyms: ['role', 'roles', 'job role', 'access', 'permission group', 'user role', 'profile'] },
    { key: 'site_code', label: 'Site code', type: 'string', description: 'Blank = all sites', synonyms: ['site', 'site code', 'plant', 'facility', 'location', 'facility code'] },
  ],
  async validate(ctx, rows) {
    const roles = await many(ctx.tx, 'SELECT key, name FROM role');
    const byWord = new Map<string, string>();
    for (const r of roles) { byWord.set(r.key.toLowerCase(), r.key); byWord.set(r.name.toLowerCase(), r.key); byWord.set(r.key.replace(/_/g, ' ').toLowerCase(), r.key); }
    const fac = await facilityLookup(ctx);
    const emps = new Map((await many(ctx.tx, 'SELECT id, lower(employee_number) AS n FROM employee')).map((e) => [e.n as string, e.id as string]));
    const known = new Set((await many(ctx.tx, 'SELECT lower(email) AS e FROM app_user')).map((u) => u.e as string));
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      const email = String(v.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) row.messages.push({ level: 'error', field: 'email', message: `"${v.email}" does not look like an email address` });
      const role = byWord.get(String(v.role ?? '').trim().toLowerCase());
      if (!role) row.messages.push({ level: 'error', field: 'role', message: `unknown role "${v.role}" (roles: ${roles.map((r) => r.name).slice(0, 8).join(', ')}…)` }); else v._role = role;
      if (v.site_code) { const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id; } else v._facility_id = null;
      if (v.employee_number) { const e = emps.get(String(v.employee_number).trim().toLowerCase()); if (!e) row.messages.push({ level: 'warning', field: 'employee_number', message: `employee ${v.employee_number} not found; the person is created without an employee link` }); else v._employee_id = e; }
      if (!v.display_name && !known.has(email)) row.messages.push({ level: 'error', field: 'display_name', message: 'a new person needs a name' });
      const k = `${email}|${v._role}|${v._facility_id ?? ''}`;
      if (seen.has(k)) row.messages.push({ level: 'error', message: 'the same person, role and site appear twice' }); else seen.add(k);
      row.action = known.has(email) ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const email = String(v.email).trim().toLowerCase();
    const cur = await one(ctx.tx, 'SELECT display_name FROM app_user WHERE lower(email) = $1', [email]);
    const u = await saveUser(ctx.tx, ctx.actor, { email, displayName: String(v.display_name ?? cur?.display_name), employeeId: (v._employee_id as string) ?? null });
    try { await grantRole(ctx.tx, ctx.actor, { userId: u.id, roleKey: String(v._role), facilityId: (v._facility_id as string) ?? null }); } catch (e) { if (!/already has this role/.test((e as Error).message)) throw e; }
    return { entityId: u.id, action: u.created ? 'create' : 'update' };
  },
};
