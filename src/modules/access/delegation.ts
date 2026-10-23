import type { Actor, Grant } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { AppError } from '../../platform/errors.js';

/**
 * Nobody hands out more than they hold (D-183A). An administrator may give a role, define a role or issue a token only
 * when they themselves hold every permission involved, at the place it is given. `tenant.admin` is the one exception:
 * every administrator holds it by definition, and an administrator may make another.
 *
 * "Hold" means the permissions of the roles the person has been given, BEFORE feature visibility (D-149) removes any:
 * an administrator who has hidden Payables from everyone can still give the Bookkeeper role.
 */
export async function rawGrants(tx: Tx, userId: string): Promise<Grant[]> {
  const rows = await many<{ facility_id: string | null; permissions: string[]; key: string }>(tx,
    `SELECT a.facility_id, r.permissions, r.key FROM user_role_assignment a JOIN role r ON r.id = a.role_id WHERE a.user_id = $1 AND a.facility_group_id IS NULL
     UNION ALL
     SELECT m.facility_id, r.permissions, r.key FROM user_role_assignment a JOIN role r ON r.id = a.role_id
     JOIN facility_group_member m ON m.group_id = a.facility_group_id WHERE a.user_id = $1`, [userId]);
  const by = new Map<string | null, Grant>();
  for (const r of rows) {
    const g = by.get(r.facility_id) ?? { facilityId: r.facility_id, permissions: new Set<string>(), roles: new Set<string>() };
    r.permissions.forEach((p) => g.permissions.add(p));
    g.roles.add(r.key);
    by.set(r.facility_id, g);
  }
  return [...by.values()];
}

/** Where a permission is given: every site (corporate), or these sites (a site, or the members of a portfolio). */
export type Scope = 'all' | string[];

function holds(grants: Grant[], permission: string, scope: Scope) {
  if (scope === 'all') return grants.some((g) => g.facilityId === null && g.permissions.has(permission));
  return scope.every((f) => grants.some((g) => g.permissions.has(permission) && (g.facilityId === null || g.facilityId === f)));
}

/** Refuses (403) naming the first permission the administrator does not hold at that scope. */
export async function assertCanDelegate(tx: Tx, actor: Pick<Actor, 'userId'>, permissions: Iterable<string>, scope: Scope, what = 'give') {
  const mine = await rawGrants(tx, actor.userId);
  for (const p of permissions) {
    if (p === 'tenant.admin') continue;
    if (!holds(mine, p, scope)) {
      throw new AppError(403, 'escalation', `you cannot ${what} "${p}": you do not hold it ${scope === 'all' ? 'at every site' : 'at that site'}. Ask an administrator who does.`);
    }
  }
}

/** The same check for a role definition, which has no site yet: the administrator must hold each permission somewhere. */
export async function assertHoldsAll(tx: Tx, actor: Pick<Actor, 'userId'>, permissions: Iterable<string>, what = 'put in a role') {
  const mine = await rawGrants(tx, actor.userId);
  for (const p of permissions) {
    if (p === 'tenant.admin') continue;
    if (!mine.some((g) => g.permissions.has(p))) throw new AppError(403, 'escalation', `you cannot ${what} "${p}": you do not hold it yourself`);
  }
}

/** Everything another person can do, checked against the administrator, site by site (used before issuing a token in their name). */
export async function assertCoversUser(tx: Tx, actor: Pick<Actor, 'userId'>, targetUserId: string, what = 'issue a token for someone who holds') {
  if (targetUserId === actor.userId) return;
  for (const g of await rawGrants(tx, targetUserId)) await assertCanDelegate(tx, actor, g.permissions, g.facilityId === null ? 'all' : [g.facilityId], what);
}

/** Scope of a role grant row or request: a site, a portfolio's members, or everywhere. */
export async function scopeOfGrant(tx: Tx, facilityId: string | null | undefined, groupId: string | null | undefined): Promise<Scope> {
  if (groupId) return (await many(tx, 'SELECT facility_id FROM facility_group_member WHERE group_id = $1', [groupId])).map((r) => r.facility_id as string);
  return facilityId ? [facilityId] : 'all';
}
