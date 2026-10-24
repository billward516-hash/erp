import { loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import type { World } from './fixtures.js';

const db = () => getAdminPool();

export async function actorWith(w: World, role: string, key: string, facility: string | null): Promise<Actor> {
  const u = await createUserWithToken(db(), w.tenantId, { email: `${key}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@billing.example`, displayName: key, roles: [{ role, facility }] });
  return (await loadActor(w.tenantId, u.userId))!;
}

export async function customer(w: World, code: string, name = `Customer ${code}`) {
  return (await db().query(`INSERT INTO customer (tenant_id, code, name, kind, payment_terms) VALUES ($1, $2, $3, 'customer', 'Net 30') RETURNING id`, [w.tenantId, code, name])).rows[0].id as string;
}

export async function project(w: World, o: { number: string; name?: string; customerId: string | null; facility?: string; billingType?: string; ownerUserId?: string }) {
  return (await db().query(`INSERT INTO project (tenant_id, facility_id, number, name, customer_id, billing_type, owner_user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [w.tenantId, o.facility ?? w.facilities.A, o.number, o.name ?? `Project ${o.number}`, o.customerId, o.billingType ?? 'time_materials', o.ownerUserId ?? null, w.admin.userId])).rows[0].id as string;
}

export async function task(w: World, projectId: string, name: string, sortNo = 0) {
  return (await db().query(`INSERT INTO project_task (tenant_id, project_id, sort_no, name) VALUES ($1, $2, $3, $4) RETURNING id`, [w.tenantId, projectId, sortNo, name])).rows[0].id as string;
}

export async function employee(w: World, num: string, first: string, last: string, title: string | null, facility?: string) {
  return (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [w.tenantId, facility ?? w.facilities.A, num, first, last, title])).rows[0].id as string;
}

/** A timesheet for the Monday-started week with project time entries, in the given status ('approved' by default). Returns the entry ids. */
export async function week(w: World, employeeId: string, weekStart: string, entries: { date: string; hours: number; projectId: string; taskId?: string | null; billable?: boolean; note?: string }[], status = 'approved', facility?: string) {
  const ts = (await db().query(`INSERT INTO timesheet (tenant_id, facility_id, employee_id, week_start) VALUES ($1, $2, $3, $4) RETURNING id`, [w.tenantId, facility ?? w.facilities.A, employeeId, weekStart])).rows[0].id;
  const ids: string[] = [];
  for (const e of entries) {
    ids.push((await db().query(`INSERT INTO time_entry (tenant_id, timesheet_id, work_date, earning_code, hours, source, note, created_by, project_id, project_task_id, billable)
      VALUES ($1, $2, $3, 'REG', $4, 'project', $5, $6, $7, $8, $9) RETURNING id`, [w.tenantId, ts, e.date, e.hours, e.note ?? null, w.admin.userId, e.projectId, e.taskId ?? null, e.billable ?? true])).rows[0].id);
  }
  if (status !== 'draft') await db().query('UPDATE timesheet SET status = $2 WHERE id = $1', [ts, status]);
  return ids;
}

export const rate = (w: World, o: { scope: string; amount: number; from?: string; to?: string | null; projectId?: string; customerId?: string; employeeId?: string; role?: string }) =>
  db().query(`INSERT INTO bill_rate (tenant_id, scope, project_id, customer_id, employee_id, role_key, role_label, amount, effective_from, effective_to, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [w.tenantId, o.scope, o.projectId ?? null, o.customerId ?? null, o.employeeId ?? null, o.role ? o.role.toLowerCase() : null, o.role ?? null, o.amount, o.from ?? '2026-01-01', o.to ?? null, w.admin.userId]);
