import { loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';

let counter = 0;

export interface World {
  tenantId: string;
  facilities: Record<string, string>;
  admin: Actor;
  /** maintenance manager at facility A only */
  managerA: Actor;
  /** technician at facility A only, linked to an employee */
  techA: Actor; techAEmployeeId: string;
  /** second technician at A (for separation-of-duties checks) */
  tech2A: Actor; tech2AEmployeeId: string;
  /** executive with corporate (all-facility) read access */
  exec: Actor;
  /** operator at facility B only */
  operatorB: Actor;
  /** MOC reviewers at facility A */
  ehsA: Actor;
  qualityA: Actor;
  opsA: Actor;
  /** holds both maintenance_manager and operations_manager at A (separation-of-duties checks) */
  dualA: Actor;
  tokens: Record<string, string>;
}

/** Provisions an isolated tenant with two facilities and a cast of users. */
export async function makeWorld(prefix = 'test'): Promise<World> {
  const db = getAdminPool();
  const n = `${prefix}-${process.pid}-${++counter}-${Date.now() % 100000}`;
  const t = await provisionTenant(db, {
    slug: n.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60), name: `Tenant ${n}`, legalEntity: `Entity ${n}`,
    facilities: [{ code: 'A', name: 'Plant A', timezone: 'America/New_York' }, { code: 'B', name: 'Plant B', timezone: 'America/Chicago' }],
  });
  const emp = async (num: string, first: string, last: string, facility: string) =>
    (await db.query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, $3, $4, $5, 'Technician') RETURNING id`,
      [t.tenantId, facility, num, first, last])).rows[0].id as string;
  const techAEmployeeId = await emp('E100', 'Priya', 'Shah', t.facilities.A!);
  const tech2AEmployeeId = await emp('E101', 'Luis', 'Ortega', t.facilities.A!);
  const tokens: Record<string, string> = {};
  const user = async (key: string, roles: { role: string; facility: string | null }[], employeeId?: string) => {
    const u = await createUserWithToken(db, t.tenantId, { email: `${key}@${n}.example`, displayName: key, roles, employeeId });
    tokens[key] = u.token;
    return (await loadActor(t.tenantId, u.userId))!;
  };
  return {
    tenantId: t.tenantId, facilities: t.facilities, tokens,
    admin: await user('admin', [{ role: 'admin', facility: null }]),
    managerA: await user('managerA', [{ role: 'maintenance_manager', facility: t.facilities.A! }]),
    techA: await user('techA', [{ role: 'technician', facility: t.facilities.A! }], techAEmployeeId), techAEmployeeId,
    tech2A: await user('tech2A', [{ role: 'technician', facility: t.facilities.A! }], tech2AEmployeeId), tech2AEmployeeId,
    exec: await user('exec', [{ role: 'executive', facility: null }]),
    operatorB: await user('operatorB', [{ role: 'operator', facility: t.facilities.B! }]),
    ehsA: await user('ehsA', [{ role: 'ehs_reviewer', facility: t.facilities.A! }]),
    qualityA: await user('qualityA', [{ role: 'quality_reviewer', facility: t.facilities.A! }]),
    opsA: await user('opsA', [{ role: 'operations_manager', facility: t.facilities.A! }]),
    dualA: await user('dualA', [{ role: 'maintenance_manager', facility: t.facilities.A! }, { role: 'operations_manager', facility: t.facilities.A! }]),
  };
}
