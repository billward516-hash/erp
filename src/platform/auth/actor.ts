import { createHash, randomBytes } from 'node:crypto';
import type { DbScope, Tx } from '../db/tx.js';
import { many, one, withTx } from '../db/tx.js';
import { getPool } from '../db/pool.js';
import { forbidden } from '../errors.js';
import type { Permission } from './permissions.js';

export interface Grant {
  /** null = applies at every facility in the tenant (corporate scope). */
  facilityId: string | null;
  permissions: Set<string>;
}

export interface Actor {
  userId: string;
  tenantId: string;
  employeeId: string | null;
  displayName: string;
  grants: Grant[];
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
    const rows = await many<{ facility_id: string | null; permissions: string[] }>(
      tx,
      `SELECT a.facility_id, r.permissions FROM user_role_assignment a JOIN role r ON r.id = a.role_id
       WHERE a.user_id = $1`,
      [userId],
    );
    const byFacility = new Map<string | null, Set<string>>();
    for (const r of rows) {
      const set = byFacility.get(r.facility_id) ?? new Set<string>();
      r.permissions.forEach((p) => set.add(p));
      byFacility.set(r.facility_id, set);
    }
    return {
      userId,
      tenantId,
      employeeId: user.employee_id,
      displayName: user.display_name,
      grants: [...byFacility].map(([facilityId, permissions]) => ({ facilityId, permissions })),
    };
  });
}

export async function authenticateToken(token: string): Promise<Actor | undefined> {
  const r = await getPool().query('SELECT user_id, tenant_id FROM auth_resolve_token($1)', [hashToken(token)]);
  const row = r.rows[0];
  if (!row) return undefined;
  return loadActor(row.tenant_id, row.user_id);
}
