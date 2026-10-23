import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';

export async function listFacilities(tx: Tx, actor: Actor) {
  requirePermission(actor, 'org.view');
  return many(
    tx,
    `SELECT f.id, f.code, f.name, f.timezone, le.name AS legal_entity,
            coalesce(array_agg(e.module_key ORDER BY e.module_key) FILTER (WHERE e.module_key IS NOT NULL
              AND e.active_from <= current_date AND (e.active_to IS NULL OR e.active_to >= current_date)), '{}') AS modules
     FROM facility f JOIN legal_entity le ON le.id = f.legal_entity_id
     LEFT JOIN facility_entitlement e ON e.facility_id = f.id
     GROUP BY f.id, le.name ORDER BY f.code`,
  );
}

export async function hasModule(tx: Tx, facilityId: string, moduleKey: string): Promise<boolean> {
  const r = await one(
    tx,
    `SELECT 1 FROM facility_entitlement WHERE facility_id = $1 AND module_key = $2
       AND active_from <= current_date AND (active_to IS NULL OR active_to >= current_date)`,
    [facilityId, moduleKey],
  );
  return !!r;
}

export interface EmployeeInput {
  facilityId?: string | null;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  email?: string | null;
  hireDate?: string | null;
  status?: 'active' | 'inactive' | 'terminated';
  customFields?: Record<string, unknown>;
}

export async function createEmployee(tx: Tx, actor: Actor, input: EmployeeInput) {
  requirePermission(actor, 'employees.manage', input.facilityId);
  if (await one(tx, 'SELECT 1 FROM employee WHERE employee_number = $1', [input.employeeNumber])) {
    throw conflict(`employee number ${input.employeeNumber} already exists`);
  }
  const emp = await one(
    tx,
    `INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title, email, hire_date, status, custom_fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [actor.tenantId, input.facilityId ?? null, input.employeeNumber, input.firstName, input.lastName, input.jobTitle ?? null,
      input.email ?? null, input.hireDate ?? null, input.status ?? 'active', input.customFields ?? {}],
  );
  await audit(tx, actor, { action: 'employee.created', entityType: 'employee', entityId: emp.id, facilityId: emp.facility_id,
    data: { employeeNumber: emp.employee_number } });
  return emp;
}

/** Directory view; deliberately excludes HR-sensitive fields (none stored yet; pay data will live elsewhere). */
export async function listEmployees(tx: Tx, actor: Actor, q: { facilityId?: string }) {
  requirePermission(actor, 'employees.view', q.facilityId);
  const rows = await many(
    tx,
    `SELECT e.id, e.facility_id, f.code AS facility_code, e.employee_number, e.first_name, e.last_name, e.job_title, e.status
     FROM employee e LEFT JOIN facility f ON f.id = e.facility_id
     WHERE ($1::uuid IS NULL OR e.facility_id = $1) ORDER BY e.last_name, e.first_name`,
    [q.facilityId ?? null],
  );
  return rows.filter((r) => can(actor, 'employees.view', r.facility_id));
}

/** Departments (cost centers): code and name, optionally tied to one site. Used by approval rules, budgets and expense reports. */
export async function saveDepartment(tx: Tx, actor: Actor, input: { id?: string; code: string; name: string; facilityId?: string | null }) {
  requirePermission(actor, 'tenant.admin');
  const code = input.code.trim();
  if (!code || !input.name?.trim()) throw invalid('a department needs a code and a name');
  if (await one(tx, 'SELECT 1 FROM department WHERE lower(code) = lower($1) AND id IS DISTINCT FROM $2::uuid', [code, input.id ?? null])) throw conflict(`department ${code} already exists`);
  const d = input.id
    ? await one(tx, 'UPDATE department SET code = $2, name = $3, facility_id = $4 WHERE id = $1 RETURNING *', [input.id, code, input.name.trim(), input.facilityId ?? null])
    : await one(tx, 'INSERT INTO department (tenant_id, facility_id, code, name) VALUES ($1, $2, $3, $4) RETURNING *', [actor.tenantId, input.facilityId ?? null, code, input.name.trim()]);
  if (!d) throw notFound('department');
  await audit(tx, actor, { action: input.id ? 'org.department_updated' : 'org.department_created', entityType: 'department', entityId: d.id, data: { code, name: d.name } });
  return d;
}
