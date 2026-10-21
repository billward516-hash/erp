import { many, one } from '../../../platform/db/tx.js';
import { requirePermission } from '../../../platform/auth/actor.js';
import { audit } from '../../../platform/audit/audit.js';
import { createEmployee } from '../../org/service.js';
import { facilityLookup, findExternalRef, flagDuplicates, resolveFacility, saveExternalRef } from './common.js';
import type { TargetDefinition } from './types.js';

/** "Garcia, Maria" | "Maria Garcia" | "Maria J. Garcia" -> first/last. */
export function splitFullName(full: string): { first: string; last: string } | null {
  const s = full.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2).map((x) => x.trim());
    return last && first ? { first: first.split(' ')[0]!, last } : null;
  }
  const parts = s.split(' ');
  if (parts.length < 2) return null;
  return { first: parts[0]!, last: parts[parts.length - 1]! };
}

export const employeesTarget: TargetDefinition = {
  key: 'employees',
  label: 'Employees / technicians',
  entityType: 'employee',
  description: 'Directory records used for technician assignment and labor. Do not import pay rates or other HR-sensitive data here.',
  naturalKey: 'employee_number',
  commitPermission: 'employees.manage',
  supportsCustomFields: true,
  fields: [
    { key: 'external_id', label: 'Legacy record ID', type: 'string', synonyms: ['legacy id', 'record id', 'person id', 'source id'] },
    { key: 'employee_number', label: 'Employee number', type: 'string', required: true,
      synonyms: ['employee number', 'employee no', 'employee id', 'emp id', 'emp number', 'badge', 'badge number', 'clock number', 'payroll id', 'file number', 'id'] },
    { key: 'first_name', label: 'First name', type: 'string', synonyms: ['first name', 'first', 'given name', 'fname'] },
    { key: 'last_name', label: 'Last name', type: 'string', synonyms: ['last name', 'last', 'surname', 'family name', 'lname'] },
    { key: 'full_name', label: 'Full name (split automatically)', type: 'string', synonyms: ['name', 'full name', 'employee name', 'employee', 'technician', 'worker'] },
    { key: 'facility_code', label: 'Facility / site', type: 'string', synonyms: ['site', 'plant', 'facility', 'location', 'home site', 'branch'] },
    { key: 'job_title', label: 'Job title', type: 'string', synonyms: ['title', 'job title', 'position', 'job', 'role', 'classification', 'craft', 'trade'] },
    { key: 'email', label: 'Email', type: 'string', synonyms: ['email', 'e mail', 'email address', 'work email'] },
    { key: 'hire_date', label: 'Hire date', type: 'date', synonyms: ['hire date', 'hired', 'start date', 'date of hire', 'doh', 'seniority date'] },
    { key: 'status', label: 'Employment status', type: 'enum', values: ['active', 'inactive', 'terminated'], synonyms: ['status', 'employment status', 'emp status'],
      valueSynonyms: { active: ['a', 'active', 'current', 'employed', 'ft', 'pt', 'full time', 'part time'], inactive: ['loa', 'leave', 'inactive', 'on leave', 'l'], terminated: ['t', 'term', 'terminated', 'separated', 'former', 'quit', 'resigned'] } },
  ],

  async validate(ctx, rows) {
    flagDuplicates(rows, 'employee_number', 'employee number');
    const facilities = await facilityLookup(ctx);
    const existing = new Map((await many(ctx.tx, 'SELECT id, lower(employee_number) AS n FROM employee')).map((e) => [e.n, e.id]));
    for (const row of rows) {
      const v = row.values;
      if ((!v.first_name || !v.last_name) && v.full_name) {
        const split = splitFullName(String(v.full_name));
        if (split) { v.first_name ??= split.first; v.last_name ??= split.last; }
      }
      if (!v.first_name || !v.last_name) row.messages.push({ level: 'error', field: 'last_name', message: 'first and last name are required (map them, or map a full name to split)' });
      if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v.email))) row.messages.push({ level: 'warning', field: 'email', message: `"${v.email}" does not look like an email; it will be skipped` });
      const f = resolveFacility(ctx, row, facilities);
      if (f) v._facility_id = f.id;
      const match = (await findExternalRef(ctx, 'employee', v.external_id)) ?? existing.get(String(v.employee_number ?? '').toLowerCase());
      row.action = match ? 'update' : 'create';
      if (ctx.mode === 'create_only' && match) row.messages.push({ level: 'error', field: 'employee_number', message: 'employee already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !match) row.messages.push({ level: 'error', field: 'employee_number', message: 'employee not found (mode is update only)' });
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    const email = v.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v.email)) ? String(v.email) : null;
    const existingId = (await findExternalRef(ctx, 'employee', v.external_id))
      ?? (await one(ctx.tx, 'SELECT id FROM employee WHERE lower(employee_number) = lower($1)', [v.employee_number]))?.id;
    if (!existingId) {
      const emp = await createEmployee(ctx.tx, ctx.actor, {
        facilityId: v._facility_id as string, employeeNumber: String(v.employee_number), firstName: String(v.first_name),
        lastName: String(v.last_name), jobTitle: v.job_title as string, email, hireDate: v.hire_date as string,
        status: (v.status as any) ?? 'active', customFields: v.custom_fields ?? {},
      });
      await saveExternalRef(ctx, 'employee', v.external_id, emp.id);
      return { entityId: emp.id, action: 'create' };
    }
    const before = await one(ctx.tx, 'SELECT * FROM employee WHERE id = $1', [existingId]);
    requirePermission(ctx.actor, 'employees.manage', before.facility_id);
    const next = {
      first_name: v.first_name ?? before.first_name, last_name: v.last_name ?? before.last_name,
      job_title: v.job_title ?? before.job_title, email: email ?? before.email, hire_date: v.hire_date ?? before.hire_date,
      status: v.status ?? before.status, custom_fields: { ...before.custom_fields, ...(v.custom_fields ?? {}) },
    };
    const changed = Object.keys(next).filter((k) => JSON.stringify((next as any)[k]) !== JSON.stringify(before[k]));
    await saveExternalRef(ctx, 'employee', v.external_id, existingId);
    if (!changed.length) return { entityId: existingId, action: 'unchanged' };
    await ctx.tx.query(
      `UPDATE employee SET first_name = $2, last_name = $3, job_title = $4, email = $5, hire_date = $6, status = $7, custom_fields = $8 WHERE id = $1`,
      [existingId, next.first_name, next.last_name, next.job_title, next.email, next.hire_date, next.status, next.custom_fields],
    );
    await audit(ctx.tx, ctx.actor, { action: 'employee.updated', entityType: 'employee', entityId: existingId, facilityId: before.facility_id, data: { changed, via: 'import' } });
    return { entityId: existingId, action: 'update' };
  },
};
