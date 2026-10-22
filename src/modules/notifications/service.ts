import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';

/** Notifications are personal: every query here is limited to the signed-in user's own rows. */
export async function listMine(tx: Tx, actor: Actor, q: { unreadOnly?: boolean; limit?: number } = {}) {
  return many(tx, `SELECT id, kind, title, body, link, created_at, read_at FROM notification
    WHERE user_id = $1 AND (NOT $2 OR read_at IS NULL) ORDER BY created_at DESC, id DESC LIMIT $3`, [actor.userId, q.unreadOnly ?? false, Math.min(q.limit ?? 50, 200)]);
}

export async function unreadCount(tx: Tx, actor: Actor) {
  return (await one(tx, 'SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL', [actor.userId])).n as number;
}

export async function markRead(tx: Tx, actor: Actor, ids: number[] | 'all') {
  const r = ids === 'all'
    ? await tx.query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [actor.userId])
    : await tx.query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND id = ANY ($2) AND read_at IS NULL', [actor.userId, ids]);
  return r.rowCount ?? 0;
}

export const NOTIFICATION_KINDS: Record<string, string> = {
  'approval.waiting': 'Something is waiting for my sign-off',
  'approval.decided': 'My requests are approved or rejected',
  'work_order.assigned': 'A work order is assigned to me',
  'training.assigned': 'Training is assigned to me',
  'time.sent_back': 'My timesheet is sent back',
  'purchasing.received': 'Items I requested arrive',
  'sales.shipped': 'An order from my quote ships',
  'sales.credit_hold': 'An order goes on credit hold (credit approvers)',
  'reminder.crm_task_due': 'My sales and collections follow-ups are due',
  'reminder.receivables_overdue': 'Customer invoices are overdue (receivables)',
  'reminder.quote_expiring': 'A quote I sent expires soon',
  'reminder.pm_due': 'PM plans due without a work order (planners)',
  'reminder.wo_overdue': 'My work orders are overdue',
  'reminder.training_due': 'My training is due soon or overdue',
  'reminder.qualification_expiring': 'My qualifications are expiring',
  'reminder.po_late': 'Purchase orders are late (buyers)',
  'reminder.invoices_waiting': 'Supplier invoices wait for approval (accounts payable)',
  'reminder.timesheet_missing': 'I have not submitted last week\'s timesheet',
  'reminder.timesheets_waiting': 'Timesheets wait for my approval',
  'reminder.sync_failed': 'Accounting sync needs attention (administrators)',
  'reminder.temporary_change_ending': 'A temporary change I own is ending',
};

export async function getPreferences(tx: Tx, actor: Actor) {
  const p = await one(tx, 'SELECT email_digest, muted_kinds FROM notification_preference WHERE user_id = $1', [actor.userId]);
  const email = await one(tx, 'SELECT email FROM app_user WHERE id = $1', [actor.userId]);
  return { emailDigest: p?.email_digest ?? true, mutedKinds: (p?.muted_kinds ?? []) as string[], email: email?.email ?? null, kinds: NOTIFICATION_KINDS };
}

export async function setPreferences(tx: Tx, actor: Actor, input: { emailDigest?: boolean; mutedKinds?: string[] }) {
  const muted = (input.mutedKinds ?? []).filter((k) => NOTIFICATION_KINDS[k]);
  await tx.query(`INSERT INTO notification_preference (tenant_id, user_id, email_digest, muted_kinds) VALUES ($1, $2, coalesce($3, true), $4)
    ON CONFLICT (user_id) DO UPDATE SET email_digest = coalesce($3, notification_preference.email_digest),
      muted_kinds = CASE WHEN $5 THEN $4 ELSE notification_preference.muted_kinds END`,
  [actor.tenantId, actor.userId, input.emailDigest ?? null, muted, input.mutedKinds !== undefined]);
  return getPreferences(tx, actor);
}
