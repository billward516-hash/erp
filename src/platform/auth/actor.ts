import { createHash, randomBytes } from 'node:crypto';
import type { DbScope, Tx } from '../db/tx.js';
import { many, one, withTx } from '../db/tx.js';
import { getPool } from '../db/pool.js';
import { forbidden } from '../errors.js';
import type { Permission } from './permissions.js';
import { applyFeatures, featureSettings } from '../features.js';

export interface Grant {
  /** null = applies at every facility in the tenant (corporate scope). */
  facilityId: string | null;
  permissions: Set<string>;
  /** Role keys held at this scope (approval steps are addressed to roles, e.g. 'ehs_reviewer'). */
  roles: Set<string>;
}

export interface Actor {
  userId: string;
  tenantId: string;
  employeeId: string | null;
  displayName: string;
  grants: Grant[];
  /** Features this user sees nowhere (D-149): their navigation, API areas and reports are refused. */
  hiddenFeatures?: string[];
}

export function can(actor: Actor, permission: Permission, facilityId?: string | null): boolean {
  return actor.grants.some(
    (g) =>
      g.permissions.has(permission) &&
      // facilityId undefined/null: tenant-wide action — any grant holding the permission suffices.
      (facilityId == null || g.facilityId === null || g.facilityId === facilityId),
  );
}

export function requirePermission(actor: Actor, permission: Permission, facilityId?: string | null): void {
  if (!can(actor, permission, facilityId)) throw forbidden(permission);
}

/** Whether the actor holds a role at a facility (or at corporate scope). */
export function hasRole(actor: Actor, roleKey: string, facilityId: string | null): boolean {
  return actor.grants.some((g) => g.roles.has(roleKey) && (g.facilityId === null || g.facilityId === facilityId));
}

/** Facilities where the actor holds a given permission (null entry = all facilities). */
export function facilitiesWith(actor: Actor, permission: Permission): { all: boolean; ids: string[] } {
  const gs = actor.grants.filter((g) => g.permissions.has(permission));
  return {
    all: gs.some((g) => g.facilityId === null),
    ids: gs.flatMap((g) => (g.facilityId ? [g.facilityId] : [])),
  };
}

export function scopeOf(actor: Actor): DbScope {
  return {
    tenantId: actor.tenantId,
    userId: actor.userId,
    allFacilities: actor.grants.some((g) => g.facilityId === null),
    facilityIds: [...new Set(actor.grants.flatMap((g) => (g.facilityId ? [g.facilityId] : [])))],
  };
}

/** Convenience: run fn in a transaction scoped to this actor's tenant + facilities. */
export function asActor<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(scopeOf(actor), fn);
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function generateToken(): string {
  return `erp_${randomBytes(24).toString('base64url')}`;
}

export async function loadActor(tenantId: string, userId: string): Promise<Actor | undefined> {
  // Role assignments are tenant-scoped (not facility-scoped), so a tenant-only scope suffices here.
  return withTx({ tenantId, userId, facilityIds: [], allFacilities: false }, async (tx) => {
    const user = await one(tx, 'SELECT id, display_name, employee_id, status FROM app_user WHERE id = $1', [userId]);
    if (!user || user.status !== 'active') return undefined;
    const rows = await many<{ facility_id: string | null; permissions: string[]; key: string }>(
      tx,
      // A grant on a facility group counts as a grant on each member facility (resolved here, at sign-in),
      // so row-level security and permission checks only ever see facility ids.
      `SELECT a.facility_id, r.permissions, r.key FROM user_role_assignment a JOIN role r ON r.id = a.role_id
       WHERE a.user_id = $1 AND a.facility_group_id IS NULL
       UNION ALL
       SELECT m.facility_id, r.permissions, r.key FROM user_role_assignment a JOIN role r ON r.id = a.role_id
       JOIN facility_group_member m ON m.group_id = a.facility_group_id WHERE a.user_id = $1`,
      [userId],
    );
    const byFacility = new Map<string | null, { permissions: Set<string>; roles: Set<string> }>();
    for (const r of rows) {
      const g = byFacility.get(r.facility_id) ?? { permissions: new Set<string>(), roles: new Set<string>() };
      r.permissions.forEach((p) => g.permissions.add(p));
      g.roles.add(r.key);
      byFacility.set(r.facility_id, g);
    }
    const grants = [...byFacility].map(([facilityId, g]) => ({ facilityId, ...g }));
    // Features hidden from a role lose their permissions there (D-149).
    const hiddenFeatures = applyFeatures(grants, await featureSettings(tx, tenantId));
    return {
      userId,
      tenantId,
      employeeId: user.employee_id,
      displayName: user.display_name,
      grants,
      hiddenFeatures,
    };
  });
}

export async function authenticateToken(token: string): Promise<Actor | undefined> {
  const r = await getPool().query('SELECT user_id, tenant_id FROM auth_resolve_token($1)', [hashToken(token)]);
  const row = r.rows[0];
  if (!row) return undefined;
  return loadActor(row.tenant_id, row.user_id);
}
