import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { closePendingRequests, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { createChange } from './service.js';

/**
 * Temporary changes to a procedure (SC-006 C). A procedure can be changed for a stated period without rewriting it: the change says
 * what is different, why, from when and until when; someone else approves it; while it is in force every reader of the procedure sees
 * a banner with the change and its end date. Expiry is a timer: the owner is alerted at 14, 7, 3, 1 and 0 days, and once the date
 * passes the change is marked expired and the owner is alerted daily, escalating to change coordinators after a week. An expired
 * change cannot quietly continue: it is reverted, extended (a reason and a fresh approval each time) or made permanent, which opens a
 * normal change for the procedure and keeps the banner and timer running until that change is approved.
 */
const SUBJECT = 'temporary_change';
const P_START = 'temporary_change';
const P_EXTEND = 'temporary_change_extension';
registerApprovalSubject(SUBJECT, {
  link: (id) => `/changes/temporary/${id}`,
  describe: async (tx, id) => {
    const t = await one(tx, `SELECT t.number, t.title, t.expires_on, t.pending_expires_on, d.doc_number FROM temporary_change t JOIN document d ON d.id = t.document_id WHERE t.id = $1`, [id]);
    return t ? `Temporary change ${t.number} to ${t.doc_number}: ${t.title}${t.pending_expires_on ? ` (extension to ${String(new Date(t.pending_expires_on).toISOString()).slice(0, 10)})` : ''}` : 'temporary change';
  },
});
const today = () => new Date().toISOString().slice(0, 10);
const LIVE = ['active', 'expired', 'permanent_pending'];
const link = (id: string) => `/changes/temporary/${id}`;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

async function maxDays(tx: Tx) { return (await one(tx, 'SELECT temp_change_max_days AS d FROM document_settings'))?.d ?? 90; }
async function lock(tx: Tx, id: string) {
  const t = await one(tx, 'SELECT * FROM temporary_change WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('temporary change');
  return t;
}
async function event(tx: Tx, actor: Actor, id: string, kind: string, d: { from?: string | null; to?: string | null; reason?: string | null } = {}) {
  await tx.query('INSERT INTO temporary_change_event (tenant_id, temporary_change_id, kind, from_date, to_date, reason, by_user) VALUES ($1, $2, $3, $4, $5, $6, $7)', [actor.tenantId, id, kind, d.from ?? null, d.to ?? null, d.reason ?? null, actor.userId]);
}
const ownerOrManager = (actor: Actor, t: any) => { if (t.owner_user_id !== actor.userId && t.created_by !== actor.userId && !can(actor, 'moc.manage', t.facility_id)) throw forbidden('moc.manage'); };

export interface TempChangeInput { facilityId: string; documentId: string; title: string; whatChanges: string; reason: string; startsOn: string; expiresOn: string; ownerUserId?: string | null; changeId?: string | null }

export async function createTempChange(tx: Tx, actor: Actor, input: TempChangeInput) {
  requirePermission(actor, 'moc.request', input.facilityId);
  const doc = await one(tx, 'SELECT id, doc_number, title, current_version_id, facility_id FROM document WHERE id = $1', [input.documentId]);
  if (!doc) throw invalid('procedure not found');
  if (!doc.current_version_id) throw invalid(`${doc.doc_number} has no approved revision to change temporarily`);
  if (!input.title.trim() || input.whatChanges.trim().length < 10) throw invalid('describe what is different while the change is in force');
  if (input.reason.trim().length < 5) throw invalid('say why the change is needed');
  if (input.expiresOn < input.startsOn) throw invalid('the end date is before the start date');
  const max = await maxDays(tx);
  const span = daysBetween(input.startsOn, input.expiresOn);
  if (span > max) throw invalid(`a temporary change can run for at most ${max} days; for longer, change the procedure itself`);
  if (input.expiresOn < today()) throw invalid('the end date is in the past');
  const number = `TC-${String(await nextSequence(tx, actor.tenantId, 'temp_change')).padStart(5, '0')}`;
  const t = await one(tx, `INSERT INTO temporary_change (tenant_id, facility_id, number, document_id, base_version_id, title, what_changes, reason, starts_on, expires_on, original_expires_on, owner_user_id, change_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13) RETURNING *`,
  [actor.tenantId, input.facilityId, number, doc.id, doc.current_version_id, input.title.trim(), input.whatChanges.trim(), input.reason.trim(), input.startsOn, input.expiresOn, input.ownerUserId ?? actor.userId, input.changeId ?? null, actor.userId]);
  await audit(tx, actor, { action: 'temporary_change.created', entityType: SUBJECT, entityId: t.id, facilityId: t.facility_id, data: { number, document: doc.doc_number, startsOn: input.startsOn, expiresOn: input.expiresOn } });
  return t;
}

async function approverFor(tx: Tx, actor: Actor, t: any, approverId: string) {
  if (approverId === actor.userId) throw invalid('someone else must approve a temporary change');
  const ok = await usersWithPermission(tx, 'moc.manage', t.facility_id);
  if (!ok.includes(approverId)) throw invalid('choose a change coordinator at this site to approve');
}

export async function submitTempChange(tx: Tx, actor: Actor, id: string, input: { approverId: string }) {
  const t = await lock(tx, id);
  ownerOrManager(actor, t);
  if (!['draft', 'rejected'].includes(t.status)) throw conflict(`the change is ${t.status}`);
  if (t.expires_on < today()) throw invalid('the end date has passed; set new dates first');
  await approverFor(tx, actor, t, input.approverId);
  const rev = t.status === 'rejected' ? t.revision + 1 : t.revision;
  await tx.query(`UPDATE temporary_change SET status = 'pending_approval', approver_user_id = $2, revision = $3 WHERE id = $1`, [id, input.approverId, rev]);
  await createApprovalRequest(tx, actor, { facilityId: t.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: rev, purpose: P_START,
    stages: [{ steps: [{ roleKey: 'moc', label: 'Approve temporary change', assigneeUserId: input.approverId }] }] });
  await audit(tx, actor, { action: 'temporary_change.submitted', entityType: SUBJECT, entityId: id, facilityId: t.facility_id, data: { approver: input.approverId } });
  return getTempChange(tx, actor, id);
}

/** Called by the approval engine in the deciding transaction. */
export async function onTempChangeDecided(tx: Tx, actor: Actor, subjectId: string, purpose: string, status: string) {
  if (![P_START, P_EXTEND].includes(purpose) || status === 'pending') return;
  const t = await lock(tx, subjectId);
  if (purpose === P_START) {
    if (t.status !== 'pending_approval') return;
    if (status === 'approved') {
      const live = t.starts_on <= today();
      await tx.query(`UPDATE temporary_change SET status = $2, activated_at = CASE WHEN $2 = 'active' THEN now() ELSE NULL END WHERE id = $1`, [subjectId, live ? 'active' : 'approved']);
      await event(tx, actor, subjectId, 'activated', { to: iso(t.expires_on) });
      await notify(tx, actor.tenantId, [t.owner_user_id, t.created_by], { kind: 'moc.temporary', title: `${t.number} approved${live ? ': in force now' : `: starts ${iso(t.starts_on)}`}`, body: `Ends ${iso(t.expires_on)}.`, link: link(subjectId), subjectType: SUBJECT, subjectId, dedupeKey: `tc-approved:${subjectId}` }, actor.userId);
    } else {
      await tx.query(`UPDATE temporary_change SET status = 'rejected' WHERE id = $1`, [subjectId]);
      await notify(tx, actor.tenantId, [t.owner_user_id, t.created_by], { kind: 'moc.temporary', title: `${t.number} was not approved`, link: link(subjectId), subjectType: SUBJECT, subjectId, dedupeKey: `tc-rejected:${subjectId}:${t.revision}` }, actor.userId);
    }
    return;
  }
  if (!t.pending_expires_on) return;
  if (status === 'approved') {
    const next = iso(t.pending_expires_on)!;
    await tx.query(`UPDATE temporary_change SET expires_on = $2, pending_expires_on = NULL, extension_count = extension_count + 1, status = CASE WHEN status = 'expired' THEN 'active' ELSE status END WHERE id = $1`, [subjectId, next]);
    await event(tx, actor, subjectId, 'extended', { from: iso(t.expires_on), to: next, reason: t.pending_reason });
  } else {
    await tx.query('UPDATE temporary_change SET pending_expires_on = NULL, pending_reason = NULL WHERE id = $1', [subjectId]);
    await event(tx, actor, subjectId, 'extension_rejected', { from: iso(t.expires_on), to: iso(t.pending_expires_on), reason: t.pending_reason });
    await notify(tx, actor.tenantId, [t.owner_user_id], { kind: 'moc.temporary', title: `${t.number}: extension refused`, body: 'Revert it or make it permanent.', link: link(subjectId), subjectType: SUBJECT, subjectId, dedupeKey: `tc-ext-refused:${subjectId}:${t.extension_count}` }, actor.userId);
  }
}

/** More time needs a reason and a fresh approval every time; each extension is capped at the company's ceiling. */
export async function requestExtension(tx: Tx, actor: Actor, id: string, input: { newExpiresOn: string; reason: string; approverId: string }) {
  const t = await lock(tx, id);
  ownerOrManager(actor, t);
  if (!['active', 'expired'].includes(t.status)) throw conflict(`the change is ${t.status}`);
  if (t.pending_expires_on) throw conflict('an extension is already waiting for approval');
  if (input.reason.trim().length < 5) throw invalid('say why more time is needed');
  const cur = iso(t.expires_on)!;
  if (input.newExpiresOn <= cur) throw invalid('the new end date must be later than the current one');
  const max = await maxDays(tx);
  const base = cur > today() ? cur : today();
  if (daysBetween(base, input.newExpiresOn) > max) throw invalid(`one extension can add at most ${max} days; for longer, make the change permanent`);
  await approverFor(tx, actor, t, input.approverId);
  const rev = t.revision + 1;
  await tx.query('UPDATE temporary_change SET pending_expires_on = $2, pending_reason = $3, revision = $4, approver_user_id = $5 WHERE id = $1', [id, input.newExpiresOn, input.reason.trim(), rev, input.approverId]);
  await createApprovalRequest(tx, actor, { facilityId: t.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: rev, purpose: P_EXTEND,
    stages: [{ steps: [{ roleKey: 'moc', label: `Approve extension to ${input.newExpiresOn}`, assigneeUserId: input.approverId }] }] });
  await event(tx, actor, id, 'extension_requested', { from: cur, to: input.newExpiresOn, reason: input.reason.trim() });
  await audit(tx, actor, { action: 'temporary_change.extension_requested', entityType: SUBJECT, entityId: id, facilityId: t.facility_id, data: { from: cur, to: input.newExpiresOn, reason: input.reason } });
  return getTempChange(tx, actor, id);
}

export async function revertTempChange(tx: Tx, actor: Actor, id: string, note: string) {
  const t = await lock(tx, id);
  ownerOrManager(actor, t);
  if (!['approved', 'active', 'expired', 'permanent_pending'].includes(t.status)) throw conflict(`the change is ${t.status}`);
  if (note.trim().length < 5) throw invalid('confirm the procedure is back to its approved form and people have been told');
  await tx.query(`UPDATE temporary_change SET status = 'reverted', closed_at = now(), closed_by = $2, close_note = $3, pending_expires_on = NULL WHERE id = $1`, [id, actor.userId, note.trim()]);
  await closePendingRequests(tx, actor, SUBJECT, id, 'cancelled', 'reverted');
  await event(tx, actor, id, 'reverted', { reason: note.trim() });
  await audit(tx, actor, { action: 'temporary_change.reverted', entityType: SUBJECT, entityId: id, facilityId: t.facility_id, data: { note } });
  return getTempChange(tx, actor, id);
}

/** Opens a normal change to put the temporary wording into the procedure for good; the banner and the timer continue until that change is approved. */
export async function makePermanent(tx: Tx, actor: Actor, id: string, input: { ownerUserId?: string | null } = {}) {
  const t = await lock(tx, id);
  ownerOrManager(actor, t);
  if (!['active', 'expired'].includes(t.status)) throw conflict(`the change is ${t.status}`);
  const doc = await one(tx, 'SELECT doc_number, title FROM document WHERE id = $1', [t.document_id]);
  const c = await createChange(tx, actor, { facilityId: t.facility_id, title: `Make permanent: ${doc!.doc_number} ${t.title}`.slice(0, 200),
    description: `${t.what_changes}\n\nIn force temporarily as ${t.number} since ${iso(t.starts_on)}.`, justification: t.reason.length >= 10 ? t.reason : `${t.reason} (temporary change ${t.number} proved necessary)`,
    changeType: 'procedure', ownerUserId: input.ownerUserId ?? t.owner_user_id, affected: [{ entityType: 'document', entityId: t.document_id, note: `Temporary change ${t.number}` }] });
  await tx.query(`UPDATE temporary_change SET status = 'permanent_pending', change_id = $2, pending_expires_on = NULL WHERE id = $1`, [id, c.id]);
  await event(tx, actor, id, 'made_permanent', { reason: `Change ${c.number} opened` });
  await audit(tx, actor, { action: 'temporary_change.made_permanent', entityType: SUBJECT, entityId: id, facilityId: t.facility_id, data: { change: c.number } });
  return { change: { id: c.id, number: c.number }, temporaryChange: await getTempChange(tx, actor, id) };
}

export async function cancelTempChange(tx: Tx, actor: Actor, id: string, reason: string) {
  const t = await lock(tx, id);
  ownerOrManager(actor, t);
  if (!['draft', 'pending_approval', 'rejected'].includes(t.status)) throw conflict(`the change is ${t.status}; revert it instead`);
  if (reason.trim().length < 3) throw invalid('give a reason');
  await tx.query(`UPDATE temporary_change SET status = 'cancelled', closed_at = now(), closed_by = $2, close_note = $3 WHERE id = $1`, [id, actor.userId, reason.trim()]);
  await closePendingRequests(tx, actor, SUBJECT, id, 'cancelled', reason.trim());
  await event(tx, actor, id, 'cancelled', { reason: reason.trim() });
}

const SELECT = `SELECT t.*, f.code AS facility_code, d.doc_number, d.title AS document_title, u.display_name AS owner_name, a.display_name AS approver_name, c.number AS change_number, c.status AS change_status,
    (t.expires_on - current_date) AS days_left, (t.status IN ('active', 'permanent_pending', 'expired') AND t.expires_on < current_date) AS past_end,
    (SELECT count(*)::int FROM temporary_change_event e WHERE e.temporary_change_id = t.id AND e.kind = 'extended') AS extensions
  FROM temporary_change t JOIN facility f ON f.id = t.facility_id JOIN document d ON d.id = t.document_id JOIN app_user u ON u.id = t.owner_user_id
  LEFT JOIN app_user a ON a.id = t.approver_user_id LEFT JOIN moc_change c ON c.id = t.change_id`;
/** green until 14 days out, amber inside 14, red inside 3 and after the date. */
const level = (t: any) => (!['active', 'approved', 'expired', 'permanent_pending'].includes(t.status) ? null : t.days_left < 0 || t.status === 'expired' ? 'expired' : t.days_left <= 3 ? 'red' : t.days_left <= 14 ? 'amber' : 'green');

export async function listTempChanges(tx: Tx, actor: Actor, q: { status?: string; live?: boolean; documentId?: string } = {}) {
  requirePermission(actor, 'moc.view');
  const rows = await many(tx, `${SELECT} ORDER BY (t.status IN ('active', 'expired', 'permanent_pending')) DESC, t.expires_on LIMIT 300`);
  return rows.filter((r) => can(actor, 'moc.view', r.facility_id) && (!q.status || r.status === q.status) && (!q.live || LIVE.includes(r.status)) && (!q.documentId || r.document_id === q.documentId)).map((r) => ({ ...r, level: level(r) }));
}

export async function getTempChange(tx: Tx, actor: Actor, id: string) {
  const t = await one(tx, `${SELECT} WHERE t.id = $1`, [id]);
  if (!t) throw notFound('temporary change');
  requirePermission(actor, 'moc.view', t.facility_id);
  const events = await many(tx, `SELECT e.kind, e.from_date, e.to_date, e.reason, e.at, u.display_name AS by_name FROM temporary_change_event e JOIN app_user u ON u.id = e.by_user WHERE e.temporary_change_id = $1 ORDER BY e.at`, [id]);
  const ceiling = await maxDays(tx);
  return { ...t, level: level(t), events, ceilingDays: ceiling, canManage: can(actor, 'moc.manage', t.facility_id) };
}

/** What readers of a procedure must see: changes in force now, with their end dates. Used by the document page and instruction view. */
export async function liveTempChanges(tx: Tx, documentId: string) {
  const rows = await many(tx, `SELECT t.id, t.number, t.title, t.what_changes, t.starts_on, t.expires_on, t.status, (t.expires_on - current_date) AS days_left, c.number AS change_number
    FROM temporary_change t LEFT JOIN moc_change c ON c.id = t.change_id WHERE t.document_id = $1 AND t.status IN ('active', 'expired', 'permanent_pending') ORDER BY t.expires_on`, [documentId]);
  return rows.map((r) => ({ ...r, level: level(r) }));
}

/**
 * Daily timer. Approved changes start on their date; an active change past its end date is marked expired; a permanent-change request
 * follows its change (approved: done, refused: back to a temporary change). Alerts: owner at 14, 7, 3, 1 and 0 days; approver at 3, 1, 0;
 * once expired, the owner daily and change coordinators from the seventh day. This is the only series for a temporary change (D-183B):
 * the reminder catalogue's "Temporary changes ending" skips change records tied to one.
 */
export async function sweepTempChanges(tx: Tx, tenantId: string) {
  await tx.query(`UPDATE temporary_change SET status = 'active', activated_at = now() WHERE status = 'approved' AND starts_on <= current_date`);
  await tx.query(`UPDATE temporary_change t SET status = 'made_permanent', closed_at = now(), close_note = 'Made permanent by change ' || c.number
    FROM moc_change c WHERE c.id = t.change_id AND t.status = 'permanent_pending' AND c.status IN ('approved', 'startup_review', 'in_service', 'closed')`);
  await tx.query(`UPDATE temporary_change t SET status = CASE WHEN t.expires_on < current_date THEN 'expired' ELSE 'active' END
    FROM moc_change c WHERE c.id = t.change_id AND t.status = 'permanent_pending' AND c.status IN ('rejected', 'cancelled')`);
  await tx.query(`UPDATE temporary_change SET status = 'expired' WHERE status = 'active' AND expires_on < current_date`);
  const rows = await many(tx, `${SELECT} WHERE t.status IN ('active', 'expired', 'permanent_pending') AND t.expires_on <= current_date + 14`);
  const day = today(); let sent = 0;
  for (const t of rows) {
    const left = Number(t.days_left);
    const base = { subjectType: SUBJECT, subjectId: t.id, link: link(t.id), kind: 'reminder.review_due' };
    if (left >= 0 && [14, 7, 3, 1, 0].includes(left)) {
      const title = left === 0 ? `${t.number} ends today: ${t.doc_number} must be back to its approved form tonight` : `${t.number} ends in ${left} day${left === 1 ? '' : 's'} (${iso(t.expires_on)}): ${t.doc_number} ${t.title}`;
      const body = t.status === 'permanent_pending' ? `Change ${t.change_number} must be approved by then.` : 'Revert it, extend it with a reason, or make it permanent.';
      sent += await notify(tx, tenantId, [t.owner_user_id], { ...base, kind: 'reminder.temporary_change_ending', title, body, dedupeKey: `tc-exp:${t.id}:${left}` });
      if (left <= 3 && t.approver_user_id) sent += await notify(tx, tenantId, [t.approver_user_id], { ...base, title, body, dedupeKey: `tc-exp-ap:${t.id}:${left}` });
    } else if (left < 0) {
      const late = -left;
      sent += await notify(tx, tenantId, [t.owner_user_id], { ...base, kind: 'reminder.temporary_change_ending', title: `${t.number} has expired (${late} day${late === 1 ? '' : 's'} ago): ${t.doc_number} is still carrying a temporary change`, body: 'Revert it, request an extension, or make it permanent.', dedupeKey: `tc-late:${t.id}:${day}` });
      if (late >= 7) sent += await notify(tx, tenantId, await usersWithPermission(tx, 'moc.manage', t.facility_id), { ...base, title: `${t.number} expired ${late} days ago and has not been resolved`, body: `${t.doc_number} · owner ${t.owner_name}`, dedupeKey: `tc-esc:${t.id}:${day}` });
    }
  }
  return sent;
}
