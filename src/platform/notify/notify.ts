import type { Tx } from '../db/tx.js';
import { many } from '../db/tx.js';

export interface Notice {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Suppresses repeats for the same user (e.g. one reminder per item per week). */
  dedupeKey?: string | null;
}

/**
 * Creates in-app notifications (inside the caller's transaction, so they exist only if the change
 * commits). Users who muted the kind are skipped; so is the person who caused the event (`exceptUserId`).
 * Email goes out later as a daily digest (modules/notifications).
 */
export async function notify(tx: Tx, tenantId: string, userIds: (string | null | undefined)[], n: Notice, exceptUserId?: string | null) {
  const ids = [...new Set(userIds.filter((u): u is string => !!u && u !== exceptUserId))];
  if (!ids.length) return 0;
  const muted = new Set((await many(tx, `SELECT user_id FROM notification_preference WHERE user_id = ANY ($1) AND $2 = ANY (muted_kinds)`, [ids, n.kind])).map((r) => r.user_id));
  let created = 0;
  for (const u of ids) {
    if (muted.has(u)) continue;
    const r = await tx.query(`INSERT INTO notification (tenant_id, user_id, kind, title, body, link, subject_type, subject_id, dedupe_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [tenantId, u, n.kind, n.title, n.body ?? null, n.link ?? null, n.subjectType ?? null, n.subjectId ?? null, n.dedupeKey ?? null]);
    created += r.rowCount ?? 0;
  }
  return created;
}

/** Active users holding a role at the facility (facility-specific or corporate), plus anyone they delegated approvals to today. */
export async function usersWithRole(tx: Tx, roleKey: string, facilityId: string | null) {
  const rows = await many(tx, `SELECT DISTINCT a.user_id FROM user_role_assignment a JOIN role r ON r.id = a.role_id JOIN app_user u ON u.id = a.user_id
    WHERE r.key = $1 AND u.status = 'active' AND (a.facility_id IS NULL OR a.facility_id = $2)
    UNION
    SELECT DISTINCT d.delegate_user_id FROM approval_delegation d JOIN user_role_assignment a ON a.user_id = d.delegator_user_id JOIN role r ON r.id = a.role_id
    WHERE r.key = $1 AND (a.facility_id IS NULL OR a.facility_id = $2) AND d.revoked_at IS NULL AND current_date BETWEEN d.starts_on AND d.ends_on`, [roleKey, facilityId]);
  return rows.map((r) => r.user_id as string);
}

/** Active users holding a permission at the facility (or everywhere when facilityId is null). */
export async function usersWithPermission(tx: Tx, permission: string, facilityId: string | null) {
  const rows = await many(tx, `SELECT DISTINCT a.user_id FROM user_role_assignment a JOIN role r ON r.id = a.role_id JOIN app_user u ON u.id = a.user_id
    WHERE $1 = ANY (r.permissions) AND u.status = 'active' AND ($2::uuid IS NULL OR a.facility_id IS NULL OR a.facility_id = $2)`, [permission, facilityId]);
  return rows.map((r) => r.user_id as string);
}

export async function usersForEmployees(tx: Tx, employeeIds: string[]) {
  const rows = await many(tx, `SELECT id, employee_id FROM app_user WHERE employee_id = ANY ($1) AND status = 'active'`, [employeeIds]);
  return new Map(rows.map((r) => [r.employee_id as string, r.id as string]));
}
