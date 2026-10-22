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
  'maintenance.request_received': 'A request comes in through a site\'s request link (site managers)',
  'training.assigned': 'Training is assigned to me',
  'time.sent_back': 'My timesheet is sent back',
  'purchasing.received': 'Items I requested arrive',
  'sales.shipped': 'An order from my quote ships',
  'sales.credit_hold': 'An order goes on credit hold (credit approvers)',
  'production.completed': 'A production order for my sales order is finished',
  'quality.ncr_raised': 'A nonconformance is raised at my site (quality)',
  'quality.capa_assigned': 'I am made owner of a corrective action',
  'action.assigned': 'An action is assigned to me',
  'safety.incident_reported': 'A safety incident is reported at my site',
  'quality.audit_planned': 'An audit I lead or am audited in is planned',
  'quality.audit_reported': 'An audit report with findings for me is issued',
  'continuity.exercise_scheduled': 'I am asked to facilitate a continuity exercise',
  'continuity.exercise_failed': 'An exercise of a continuity plan I own falls short',
  'reminder.crm_task_due': 'My sales and collections follow-ups are due',
  'reminder.receivables_overdue': 'Customer invoices are overdue (receivables)',
  'reminder.action_overdue': 'My corrective or safety actions are overdue',
  'reminder.capa_verification_due': 'Corrective actions wait for an effectiveness check (quality)',
  'reminder.kits_short': 'Kits are short of parts for work due soon (storeroom, planners)',
  'reminder.continuity_review_due': 'Continuity plans I own are due for review or an exercise',
  'visit.completed': 'A site visit at my site found problems',
  'reminder.readings_missed': 'Condition readings at my site are overdue (coolers, freezers)',
  'reminder.leasing_due': 'Leases ending without renewal and unit turns running late (leasing)',
  'reminder.calibration_due': 'Instruments are due or overdue for calibration (quality)',
  'reminder.incident_unclassified': 'Incidents reported more than a day ago are not yet classified (safety)',
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
