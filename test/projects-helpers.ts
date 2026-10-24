import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createCustomer } from '../src/modules/crm/service.js';
import { createProject } from '../src/modules/projects/service.js';
import type { ProjectInput } from '../src/modules/projects/service.js';
import { addDays, weekStartOf } from '../src/modules/time/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

export interface ProjectWorld extends World {
  /** project manager at A (view + manage, no see_cost), linked to an employee */
  pm: Actor; pmEmployeeId: string;
  /** finance at all sites (view + see_cost); also the owner in the change-order tests */
  fin: Actor; finEmployeeId: string;
  /** project viewer without manage or cost (sales manager at A) */
  viewer: Actor;
  customerId: string;
}

/** The last full week, and the one before. */
export const W1 = addDays(weekStartOf(new Date().toISOString().slice(0, 10)), -7);
export const W0 = addDays(W1, -7);

export async function makeProjectWorld(prefix = 'projects'): Promise<ProjectWorld> {
  const w = await makeWorld(prefix);
  const db = getAdminPool();
  const emp = async (num: string, first: string, last: string) =>
    (await db.query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, $3, $4, $5, 'Consultant') RETURNING id`,
      [w.tenantId, w.facilities.A, num, first, last])).rows[0].id as string;
  const pmEmployeeId = await emp('E200', 'Pat', 'Manager');
  const finEmployeeId = await emp('E201', 'Fran', 'Finance');
  const user = async (key: string, roles: { role: string; facility: string | null }[], employeeId?: string) => {
    const u = await createUserWithToken(db, w.tenantId, { email: `${key}-${Date.now()}@${prefix}.example`, displayName: key, roles, employeeId });
    w.tokens[key] = u.token;
    return (await loadActor(w.tenantId, u.userId))!;
  };
  const pm = await user('pm', [{ role: 'project_manager', facility: w.facilities.A! }, { role: 'maintenance_manager', facility: w.facilities.A! }], pmEmployeeId);
  const fin = await user('fin', [{ role: 'finance_approver', facility: null }], finEmployeeId);
  const viewer = await user('viewer', [{ role: 'sales_manager', facility: w.facilities.A! }]);
  const customerId = (await asActor(w.admin, (tx) => createCustomer(tx, w.admin, { code: `C-${Date.now() % 100000}`, name: 'Acme Corp', kind: 'customer' } as any))).id as string;
  return { ...w, pm, pmEmployeeId, fin, finEmployeeId, viewer, customerId };
}

export const mkProject = (w: ProjectWorld, input: Partial<ProjectInput> = {}, by: Actor = w.pm) =>
  asActor(by, (tx) => createProject(tx, by, { name: 'Website rebuild', customerId: w.customerId, billingType: 'time_materials', facilityId: w.facilities.A!, ...input }));
