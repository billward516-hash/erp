import type { Actor } from '../../platform/auth/actor.js';
import { generateToken, hashToken, requirePermission } from '../../platform/auth/actor.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { assertCoversUser, assertHoldsAll, rawGrants } from './delegation.js';

/**
 * People and access (D-183A): the administrator's view of who can sign in, what they hold, the roles, and the API
 * tokens. Everything here needs `tenant.admin`, writes an audit event, and refuses to hand out more than the
 * administrator holds (delegation.ts). Role grants themselves go through the existing grant service (sites/service).
 */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const admin = (actor: Actor) => requirePermission(actor, 'tenant.admin');

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function listAccess(tx: Tx, actor: Actor) {
  admin(actor);
  const users = await many(tx, `SELECT u.id, u.display_name, u.email, u.status, u.employee_id, e.employee_number, u.sso_issuer, u.sso_subject, u.created_at,
      (SELECT count(*)::int FROM api_token t WHERE t.user_id = u.id AND t.kind = 'api' AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())) AS active_tokens,
      (SELECT max(t.last_used_at) FROM api_token t WHERE t.user_id = u.id) AS last_seen
    FROM app_user u LEFT JOIN employee e ON e.id = u.employee_id ORDER BY u.status, u.display_name`);
  const grants = await many(tx, `SELECT a.id, a.user_id, r.key AS role, r.name AS role_name, r.custom, a.facility_id, f.code AS facility, a.facility_group_id AS group_id, g.code AS "group"
    FROM user_role_assignment a JOIN role r ON r.id = a.role_id LEFT JOIN facility f ON f.id = a.facility_id LEFT JOIN facility_group g ON g.id = a.facility_group_id
    ORDER BY r.name, f.code NULLS FIRST`);
  const byUser = new Map<string, any[]>();
  for (const g of grants) {
    const { user_id, ...rest } = g;
    byUser.set(user_id, [...(byUser.get(user_id) ?? []), { id: rest.id, role: rest.role, roleName: rest.role_name, custom: rest.custom, facilityId: rest.facility_id, facility: rest.facility, groupId: rest.group_id, group: rest.group }]);
  }
  const lic = await one(tx, 'SELECT * FROM tenant_edition()');
  const sso = await one(tx, 'SELECT issuer, enabled, link_by_email, allow_tokens FROM tenant_sso');
  return {
    users: users.map((u) => ({
      id: u.id, displayName: u.display_name, email: u.email, status: u.status, employeeId: u.employee_id, employeeNumber: u.employee_number, createdAt: u.created_at,
      sso: u.sso_subject ? { issuer: u.sso_issuer, subject: u.sso_subject } : null, activeTokens: u.active_tokens, lastSeen: u.last_seen, grants: byUser.get(u.id) ?? [],
    })),
    roles: await many(tx, 'SELECT key, name, custom FROM role ORDER BY custom, name'),
    sites: await many(tx, 'SELECT id, code, name FROM facility WHERE active ORDER BY code'),
    groups: await many(tx, 'SELECT id, code, name FROM facility_group ORDER BY code'),
    licence: { edition: lic?.edition ?? 'standard', userCap: lic?.user_cap ?? null, usersActive: lic?.users_active ?? 0 },
    sso: sso ? { issuer: sso.issuer, enabled: sso.enabled, linkByEmail: sso.link_by_email, allowTokens: sso.allow_tokens } : null,
    you: actor.userId,
  };
}

async function employeeOrThrow(tx: Tx, employeeId: string | null | undefined) {
  if (employeeId && !(await one(tx, 'SELECT 1 FROM employee WHERE id = $1', [employeeId]))) throw invalid('that employee record does not exist');
}

/** Adds a person without the import. The user cap of the edition is enforced by the database. Roles are given afterwards. */
export async function createUser(tx: Tx, actor: Actor, input: { displayName: string; email: string; employeeId?: string | null }) {
  admin(actor);
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw invalid(`"${input.email}" does not look like an email address`);
  const name = input.displayName.trim();
  if (!name) throw invalid('a person needs a name');
  if (await one(tx, 'SELECT 1 FROM app_user WHERE lower(email) = $1', [email])) throw conflict(`${email} is already a user of this company`);
  await employeeOrThrow(tx, input.employeeId);
  const u = await one(tx, 'INSERT INTO app_user (tenant_id, email, display_name, employee_id) VALUES ($1, $2, $3, $4) RETURNING id, email, display_name, status',
    [actor.tenantId, email, name, input.employeeId ?? null]);
  await audit(tx, actor, { action: 'user.created', entityType: 'app_user', entityId: u.id, data: { email, via: 'access screen' } });
  return { id: u.id as string, email: u.email as string, displayName: u.display_name as string, status: u.status as string };
}

export async function updateUser(tx: Tx, actor: Actor, id: string, input: { displayName?: string; employeeId?: string | null }) {
  admin(actor);
  const cur = await one(tx, 'SELECT display_name, employee_id FROM app_user WHERE id = $1', [id]);
  if (!cur) throw notFound('user');
  const name = input.displayName === undefined ? cur.display_name : input.displayName.trim();
  if (!name) throw invalid('a person needs a name');
  const employeeId = input.employeeId === undefined ? cur.employee_id : input.employeeId;
  await employeeOrThrow(tx, employeeId);
  await tx.query('UPDATE app_user SET display_name = $2, employee_id = $3 WHERE id = $1', [id, name, employeeId]);
  await audit(tx, actor, { action: 'user.updated', entityType: 'app_user', entityId: id, data: { from: { name: cur.display_name, employeeId: cur.employee_id }, to: { name, employeeId } } });
}

/**
 * Disabling is immediate: token and sign-in checks read the user's status on every request, so the next call fails.
 * Sign-in sessions are ended (revoked) here; API tokens are left as they are but stop working until the user is enabled.
 */
export async function setUserStatus(tx: Tx, actor: Actor, id: string, status: 'active' | 'disabled') {
  admin(actor);
  const u = await one(tx, 'SELECT status, email FROM app_user WHERE id = $1', [id]);
  if (!u) throw notFound('user');
  if (id === actor.userId && status === 'disabled') throw invalid('you cannot disable your own account');
  if (u.status === status) return { status, sessionsEnded: 0 };
  await tx.query('UPDATE app_user SET status = $2 WHERE id = $1', [id, status]); // the edition's user cap is checked by the database
  let sessionsEnded = 0;
  if (status === 'disabled') {
    sessionsEnded = (await tx.query(`UPDATE api_token SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND kind = 'session' AND revoked_at IS NULL`, [id, actor.userId])).rowCount ?? 0;
  }
  await audit(tx, actor, { action: status === 'disabled' ? 'user.disabled' : 'user.enabled', entityType: 'app_user', entityId: id, data: { email: u.email, ...(status === 'disabled' ? { sessionsEnded } : {}) } });
  return { status, sessionsEnded };
}

/** Links a person to an identity at the company's identity provider by hand (for example after the provider changed). */
export async function linkSso(tx: Tx, actor: Actor, id: string, input: { issuer?: string; subject: string }) {
  admin(actor);
  const u = await one(tx, 'SELECT sso_subject FROM app_user WHERE id = $1', [id]);
  if (!u) throw notFound('user');
  const issuer = (input.issuer ?? (await one(tx, 'SELECT issuer FROM tenant_sso'))?.issuer ?? '').trim().replace(/\/+$/, '');
  const subject = input.subject.trim();
  if (!/^https?:\/\//.test(issuer)) throw invalid('give the identity provider address (the issuer), or set up single sign-on first');
  if (!subject) throw invalid('give the identity\'s subject (the provider\'s stable id for the person)');
  if (u.sso_subject) throw conflict('this person is already linked to an identity; unlink it first');
  try {
    await tx.query('SAVEPOINT link_sso');
    await tx.query('UPDATE app_user SET sso_issuer = $2, sso_subject = $3 WHERE id = $1', [id, issuer, subject]);
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT link_sso');
    if ((e as { code?: string }).code === '23505') throw conflict('that identity is already linked to a user');
    throw e;
  }
  await audit(tx, actor, { action: 'user.sso_linked', entityType: 'app_user', entityId: id, data: { issuer, subject } });
}

/** Unlinks the identity. At the next sign-in the person is matched again by verified email if the company allows it. */
export async function unlinkSso(tx: Tx, actor: Actor, id: string) {
  admin(actor);
  const u = await one(tx, 'SELECT sso_issuer, sso_subject FROM app_user WHERE id = $1', [id]);
  if (!u) throw notFound('user');
  if (!u.sso_subject) throw conflict('this person is not linked to an identity');
  await tx.query('UPDATE app_user SET sso_issuer = NULL, sso_subject = NULL WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'user.sso_unlinked', entityType: 'app_user', entityId: id, data: { issuer: u.sso_issuer, subject: u.sso_subject } });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function listRoles(tx: Tx, actor: Actor) {
  admin(actor);
  const roles = await many(tx, `SELECT r.id, r.key, r.name, r.description, r.custom, r.permissions, r.updated_at,
      (SELECT count(DISTINCT a.user_id)::int FROM user_role_assignment a JOIN app_user u ON u.id = a.user_id WHERE a.role_id = r.id AND u.status = 'active') AS users
    FROM role r ORDER BY r.custom, r.name`);
  const held = new Set((await rawGrants(tx, actor.userId)).flatMap((g) => [...g.permissions]));
  return {
    roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, custom: r.custom, permissions: r.permissions as string[], users: r.users, updatedAt: r.updated_at })),
    permissions: PERMISSIONS.map((p) => ({ key: p, area: p.split('.')[0]!, held: p === 'tenant.admin' || held.has(p) })),
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'role';

function cleanPermissions(input: string[]) {
  const known = new Set<string>(PERMISSIONS);
  const bad = input.filter((p) => !known.has(p));
  if (bad.length) throw invalid(`unknown permission ${bad.slice(0, 3).join(', ')}`);
  const set = new Set(input);
  if (!set.size) throw invalid('choose at least one permission');
  return PERMISSIONS.filter((p) => set.has(p)) as string[];
}

/** A company's own role: a named set of permissions chosen from the list. Starter roles are never touched. */
export async function saveCustomRole(tx: Tx, actor: Actor, input: { id?: string; name: string; description?: string | null; permissions: string[] }) {
  admin(actor);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) throw invalid('name the role (2 to 60 characters)');
  const permissions = cleanPermissions(input.permissions);
  await assertHoldsAll(tx, actor, permissions);
  if (await one(tx, 'SELECT 1 FROM role WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)', [name, input.id ?? null])) throw conflict(`a role named "${name}" already exists`);
  if (!input.id) {
    let key = `custom_${slug(name)}`;
    for (let i = 2; await one(tx, 'SELECT 1 FROM role WHERE key = $1', [key]); i++) key = `custom_${slug(name)}_${i}`;
    const r = await one(tx, 'INSERT INTO role (tenant_id, key, name, description, permissions, custom, created_by) VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id, key',
      [actor.tenantId, key, name, input.description?.trim() || null, permissions, actor.userId]);
    await audit(tx, actor, { action: 'role.created', entityType: 'role', entityId: r.id, data: { key, name, permissions } });
    return { id: r.id as string, key: r.key as string };
  }
  const cur = await one(tx, 'SELECT id, key, name, permissions, custom FROM role WHERE id = $1', [input.id]);
  if (!cur) throw notFound('role');
  if (!cur.custom) throw forbidden('starter roles are read-only: copy it into a new role of your own');
  // Changing a role changes everyone who holds it, so the administrator must hold everything it already carries too.
  await assertHoldsAll(tx, actor, cur.permissions, 'change a role that carries');
  await tx.query('UPDATE role SET name = $2, description = $3, permissions = $4, updated_at = now() WHERE id = $1', [cur.id, name, input.description?.trim() || null, permissions]);
  const before = new Set<string>(cur.permissions);
  await audit(tx, actor, { action: 'role.updated', entityType: 'role', entityId: cur.id, data: { key: cur.key, name, renamedFrom: cur.name !== name ? cur.name : undefined,
    added: permissions.filter((p) => !before.has(p)), removed: cur.permissions.filter((p: string) => !permissions.includes(p)) } });
  return { id: cur.id as string, key: cur.key as string };
}

export async function deleteCustomRole(tx: Tx, actor: Actor, id: string) {
  admin(actor);
  const r = await one(tx, 'SELECT id, key, name, permissions, custom FROM role WHERE id = $1', [id]);
  if (!r) throw notFound('role');
  if (!r.custom) throw forbidden('starter roles are read-only and cannot be deleted');
  await assertHoldsAll(tx, actor, r.permissions, 'delete a role that carries');
  const holders = (await one(tx, 'SELECT count(*)::int AS n FROM user_role_assignment WHERE role_id = $1', [id]))!.n;
  if (holders) throw conflict(`${holders} role grant${holders === 1 ? ' is' : 's are'} still using "${r.name}"; remove them first`);
  const uses = (await one(tx, `SELECT (SELECT count(*) FROM tenant_feature WHERE $1 = ANY (role_keys)) + (SELECT count(*) FROM purchase_approval_rule WHERE role_key = $1)
    + (SELECT count(*) FROM expense_approval_rule WHERE role_key = $1) + (SELECT count(*) FROM approval_step WHERE role_key = $1 AND status = 'pending') AS n`, [r.key]))!.n;
  if (Number(uses)) throw conflict(`"${r.name}" is named in feature visibility, approval rules or pending approvals; change those first`);
  await tx.query('DELETE FROM role WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'role.deleted', entityType: 'role', entityId: id, data: { key: r.key, name: r.name } });
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

export async function listTokens(tx: Tx, actor: Actor, opts: { includeInactive?: boolean } = {}) {
  admin(actor);
  const rows = await many(tx, `SELECT t.id, t.label, t.user_id, u.display_name AS user_name, u.email AS user_email, u.status AS user_status, t.created_at, c.display_name AS created_by,
      t.expires_at, t.last_used_at, t.revoked_at, rv.display_name AS revoked_by,
      CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked' WHEN t.expires_at IS NOT NULL AND t.expires_at <= now() THEN 'expired' ELSE 'active' END AS state
    FROM api_token t JOIN app_user u ON u.id = t.user_id LEFT JOIN app_user c ON c.id = t.created_by LEFT JOIN app_user rv ON rv.id = t.revoked_by
    WHERE t.kind = 'api' ORDER BY t.created_at DESC`);
  const sso = await one(tx, 'SELECT enabled, allow_tokens FROM tenant_sso');
  return {
    tokens: rows.filter((t) => opts.includeInactive || t.state === 'active').map((t) => ({ id: t.id, label: t.label, userId: t.user_id, userName: t.user_name, userEmail: t.user_email, userStatus: t.user_status,
      createdAt: t.created_at, createdBy: t.created_by, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at, revokedBy: t.revoked_by, state: t.state })),
    hidden: opts.includeInactive ? 0 : rows.filter((t) => t.state !== 'active').length,
    tokensAllowed: !(sso?.enabled && !sso.allow_tokens),
  };
}

/**
 * Issues an API token for a user. The token is returned once; only its SHA-256 is stored (like a password, it cannot be
 * shown again). The token acts as that user with all their access, so the administrator must hold all of it too.
 */
export async function issueToken(tx: Tx, actor: Actor, input: { userId: string; label: string; expiresInDays?: number | null; expiresAt?: string | null }) {
  admin(actor);
  const label = input.label.trim();
  if (!label) throw invalid('label the token (what will use it, for example "Payroll export")');
  const u = await one(tx, 'SELECT id, status, display_name FROM app_user WHERE id = $1', [input.userId]);
  if (!u) throw notFound('user');
  if (u.status !== 'active') throw invalid(`${u.display_name} is disabled; enable the account first`);
  let expiresAt: Date | null = null;
  if (input.expiresAt) expiresAt = new Date(input.expiresAt);
  else if (input.expiresInDays) expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  if (expiresAt && !(expiresAt.getTime() > Date.now() + 60_000)) throw invalid('the expiry must be in the future');
  if (expiresAt && expiresAt.getTime() > Date.now() + 10 * 366 * 86_400_000) throw invalid('the expiry is more than ten years away; leave it blank for a token that does not expire');
  await assertCoversUser(tx, actor, input.userId);
  const token = generateToken();
  const t = await one(tx, 'INSERT INTO api_token (tenant_id, user_id, token_hash, label, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at, expires_at',
    [actor.tenantId, input.userId, hashToken(token), label, expiresAt, actor.userId]);
  // The audit event records who, for whom, the label and the expiry; never the token or its hash.
  await audit(tx, actor, { action: 'token.issued', entityType: 'api_token', entityId: t.id, data: { userId: input.userId, label, expiresAt: t.expires_at } });
  return { id: t.id as string, token, label, userId: input.userId, createdAt: t.created_at, expiresAt: t.expires_at };
}

export async function revokeToken(tx: Tx, actor: Actor, id: string) {
  admin(actor);
  const t = await one(tx, `SELECT id, user_id, label, revoked_at FROM api_token WHERE id = $1 AND kind = 'api'`, [id]);
  if (!t) throw notFound('token');
  if (t.revoked_at) throw conflict('this token is already revoked');
  await tx.query('UPDATE api_token SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [id, actor.userId]);
  await audit(tx, actor, { action: 'token.revoked', entityType: 'api_token', entityId: id, data: { userId: t.user_id, label: t.label } });
}
