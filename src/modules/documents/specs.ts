import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';

/**
 * Review of external document revisions (D-169). A new revision of a customer specification or standard is reviewed
 * for its impact on our parts, processes and documents within a set number of working days of receipt (10 by default:
 * IATF 16949 7.5.3.2.2 asks for no more than ten). Until the review is decided the new revision is not put in force.
 * "Changes required" names our documents to revise (each follow-up closes itself when that document releases its next
 * revision) and can point at the change request (MOC) that carries the work.
 */
const REVIEWED_TYPES = new Set(['customer_spec', 'industry_standard']);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Adds working days (Monday to Friday; company holidays are not modelled, so the date is conservative only for weekends). */
export function addWorkingDays(from: string, days: number) {
  const d = new Date(`${from}T12:00:00Z`);
  let left = days;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) left--; }
  return iso(d);
}

export async function documentSettings(tx: Tx) {
  const s = await one(tx, 'SELECT spec_review_days FROM document_settings');
  return { specReviewDays: s?.spec_review_days ?? 10 };
}

export async function saveDocumentSettings(tx: Tx, actor: Actor, input: { specReviewDays: number }) {
  requirePermission(actor, 'tenant.admin');
  if (!Number.isInteger(input.specReviewDays) || input.specReviewDays < 1 || input.specReviewDays > 60) throw invalid('review within 1 to 60 working days');
  await tx.query(`INSERT INTO document_settings (tenant_id, spec_review_days, updated_by) VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO UPDATE SET spec_review_days = EXCLUDED.spec_review_days, updated_by = EXCLUDED.updated_by, updated_at = now()`, [actor.tenantId, input.specReviewDays, actor.userId]);
  await audit(tx, actor, { action: 'document.settings_changed', entityType: 'document_settings', entityId: actor.tenantId, data: input });
  return documentSettings(tx);
}

/** Called when a version is added: a revision of a reviewed external kind opens its impact review. */
export async function openSpecReview(tx: Tx, actor: Actor, doc: { id: string; doc_type: string; origin: string; owner_user_id: string | null; doc_number: string; title: string; current_version_id: string | null },
  version: { id: string; received_on: string | Date | null; issuer_revision: string | null }) {
  if (doc.origin !== 'external' || !REVIEWED_TYPES.has(doc.doc_type)) return null;
  const received = version.received_on ? iso(new Date(version.received_on)) : iso(new Date());
  const { specReviewDays } = await documentSettings(tx);
  const due = addWorkingDays(received, specReviewDays);
  const assignee = doc.owner_user_id ?? actor.userId;
  const r = await one(tx, `INSERT INTO spec_review (tenant_id, document_id, version_id, previous_version_id, received_on, due_on, assigned_to) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, doc.id, version.id, doc.current_version_id, received, due, assignee]);
  await notify(tx, actor.tenantId, [assignee], { kind: 'reminder.review_due', title: `Review ${doc.doc_number} rev ${version.issuer_revision ?? ''} for its impact by ${due}`.replace('  ', ' '),
    link: `/documents/${doc.id}`, subjectType: 'spec_review', subjectId: r.id, dedupeKey: `spec-review:${r.id}` });
  await audit(tx, actor, { action: 'document.spec_review_opened', entityType: 'document', entityId: doc.id, data: { reviewId: r.id, versionId: version.id, receivedOn: received, dueOn: due } });
  return r;
}

/** The review with everything an assessor needs: the revision before and after, and where the document applies. */
export async function specReviewFor(tx: Tx, documentId: string) {
  const reviews = await many(tx, `SELECT r.*, v.version_label, v.issuer_revision, pv.issuer_revision AS previous_issuer_revision, au.display_name AS assigned_name, bu.display_name AS assessed_name,
      m.number AS moc_number, (r.status = 'open' AND r.due_on < current_date) AS overdue,
      CASE WHEN r.status = 'open' THEN NULL ELSE (r.assessed_at::date <= r.due_on) END AS on_time
    FROM spec_review r JOIN document_version v ON v.id = r.version_id LEFT JOIN document_version pv ON pv.id = r.previous_version_id
      LEFT JOIN app_user au ON au.id = r.assigned_to LEFT JOIN app_user bu ON bu.id = r.assessed_by LEFT JOIN moc_change m ON m.id = r.moc_change_id
    WHERE r.document_id = $1 ORDER BY r.created_at DESC`, [documentId]);
  for (const r of reviews) {
    r.followups = await many(tx, `SELECT f.*, d.doc_number, d.title, o.display_name AS owner_name, dv.version_label AS done_version_label FROM spec_review_followup f JOIN document d ON d.id = f.document_id
      JOIN app_user o ON o.id = f.owner_user_id LEFT JOIN document_version dv ON dv.id = f.done_version_id WHERE f.review_id = $1 ORDER BY d.doc_number`, [r.id]);
  }
  const appliesTo = await many(tx, `SELECT l.entity_type, l.entity_id, l.link_role,
      CASE l.entity_type WHEN 'part' THEN (SELECT part_number || ' ' || description FROM part WHERE id = l.entity_id)
        WHEN 'customer' THEN (SELECT name FROM customer WHERE id = l.entity_id) WHEN 'supplier' THEN (SELECT name FROM supplier WHERE id = l.entity_id)
        WHEN 'asset' THEN (SELECT asset_tag || ' ' || name FROM asset WHERE id = l.entity_id) ELSE NULL END AS label
    FROM document_link l WHERE l.document_id = $1 AND l.entity_type <> 'document'`, [documentId]);
  // Our documents that say they work to this one.
  const usedBy = await many(tx, `SELECT d.id, d.doc_number, d.title, d.doc_type, d.owner_user_id, o.display_name AS owner_name FROM document_link l JOIN document d ON d.id = l.document_id
    LEFT JOIN app_user o ON o.id = d.owner_user_id WHERE l.entity_type = 'document' AND l.entity_id = $1 AND d.status = 'active' ORDER BY d.doc_number`, [documentId]);
  return { reviews, appliesTo, usedBy };
}

export interface DecisionInput {
  outcome: 'no_impact' | 'changes_required'; whatChanged: string; assessment: string; customerDueOn?: string | null; mocChangeId?: string | null;
  followups?: { documentId: string; ownerUserId: string; dueOn: string; note?: string | null }[];
}

/** Records the outcome. After this the new revision can be released; the follow-ups carry the changes it requires. */
export async function decideSpecReview(tx: Tx, actor: Actor, reviewId: string, input: DecisionInput) {
  const r = await one(tx, `SELECT r.*, d.facility_id, d.doc_number FROM spec_review r JOIN document d ON d.id = r.document_id WHERE r.id = $1 FOR UPDATE OF r`, [reviewId]);
  if (!r) throw notFound('specification review');
  requirePermission(actor, 'documents.manage', r.facility_id);
  if (r.status !== 'open') throw conflict('the review is already decided');
  if (!input.whatChanged?.trim() || input.whatChanged.trim().length < 5) throw invalid('say what changed in this revision');
  if (!input.assessment?.trim() || input.assessment.trim().length < 5) throw invalid('record the assessment: what was checked and why it does or does not affect us');
  const followups = input.followups ?? [];
  if (input.outcome === 'changes_required' && !followups.length && !input.mocChangeId) throw invalid('name the documents to revise or the change request that carries the work');
  if (input.outcome === 'no_impact' && followups.length) throw invalid('"no impact" has no follow-ups; choose "changes required"');
  if (input.mocChangeId && !(await one(tx, 'SELECT 1 FROM moc_change WHERE id = $1', [input.mocChangeId]))) throw notFound('change request');
  for (const f of followups) {
    const d = await one(tx, `SELECT 1 FROM document WHERE id = $1 AND origin = 'internal' AND status = 'active'`, [f.documentId]);
    if (!d) throw invalid('follow-ups are revisions of our own active documents');
    if (!(await one(tx, `SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [f.ownerUserId]))) throw invalid('each follow-up needs an active owner');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dueOn)) throw invalid('each follow-up needs a due date');
  }
  await tx.query(`UPDATE spec_review SET status = $2, what_changed = $3, assessment = $4, customer_due_on = $5, moc_change_id = $6, assessed_by = $7, assessed_at = now() WHERE id = $1`,
    [reviewId, input.outcome, input.whatChanged.trim(), input.assessment.trim(), input.customerDueOn ?? null, input.mocChangeId ?? null, actor.userId]);
  for (const f of followups) {
    await tx.query(`INSERT INTO spec_review_followup (tenant_id, review_id, document_id, owner_user_id, due_on, note) VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor.tenantId, reviewId, f.documentId, f.ownerUserId, f.dueOn, f.note?.trim() || null]);
  }
  if (followups.length) {
    await notify(tx, actor.tenantId, followups.map((f) => f.ownerUserId), { kind: 'action.assigned', title: `Revise your document for ${r.doc_number}'s new revision`,
      link: `/documents/${r.document_id}`, subjectType: 'spec_review', subjectId: reviewId, dedupeKey: `spec-followups:${reviewId}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'document.spec_review_decided', entityType: 'document', entityId: r.document_id, facilityId: r.facility_id,
    data: { reviewId, outcome: input.outcome, followups: followups.map((f) => f.documentId), mocChangeId: input.mocChangeId ?? null, onTime: new Date().toISOString().slice(0, 10) <= iso(new Date(r.due_on)) } });
  return { reviewId, outcome: input.outcome };
}

/** A version cannot be released while its impact review is open. */
export async function assertReviewDone(tx: Tx, versionId: string) {
  const r = await one(tx, `SELECT due_on FROM spec_review WHERE version_id = $1 AND status = 'open'`, [versionId]);
  if (r) throw conflict(`this revision's impact review is not done yet (due ${iso(new Date(r.due_on))}); decide it before putting the revision in force`);
}

/** When one of our documents releases a revision, the follow-ups waiting on it are done. */
export async function closeFollowups(tx: Tx, documentId: string, versionId: string) {
  await tx.query(`UPDATE spec_review_followup SET status = 'done', done_version_id = $2, done_at = now() WHERE document_id = $1 AND status = 'open'`, [documentId, versionId]);
}

/** Open and late reviews, and follow-ups waiting, across the documents the reader may see. */
export async function specReviewQueue(tx: Tx, actor: Actor) {
  if (!can(actor, 'documents.view')) requirePermission(actor, 'documents.view');
  const open = await many(tx, `SELECT r.id, r.document_id, d.doc_number, d.title, d.issuer, v.issuer_revision, r.received_on, r.due_on, (r.due_on < current_date) AS overdue, au.display_name AS assigned_name
    FROM spec_review r JOIN document d ON d.id = r.document_id JOIN document_version v ON v.id = r.version_id LEFT JOIN app_user au ON au.id = r.assigned_to
    WHERE r.status = 'open' ORDER BY r.due_on`);
  const followups = await many(tx, `SELECT f.id, f.due_on, (f.due_on < current_date) AS overdue, d.id AS document_id, d.doc_number, d.title, s.doc_number AS spec_number, o.display_name AS owner_name
    FROM spec_review_followup f JOIN document d ON d.id = f.document_id JOIN spec_review r ON r.id = f.review_id JOIN document s ON s.id = r.document_id JOIN app_user o ON o.id = f.owner_user_id
    WHERE f.status = 'open' ORDER BY f.due_on`);
  return { open, followups };
}

/** Daily: tells the assignee about a review that has gone past its due date (once a day). */
export async function remindOverdueSpecReviews(tx: Tx, tenantId: string) {
  const late = await many(tx, `SELECT r.id, r.assigned_to, r.document_id, r.due_on, d.doc_number FROM spec_review r JOIN document d ON d.id = r.document_id
    WHERE r.status = 'open' AND r.due_on < current_date AND r.assigned_to IS NOT NULL`);
  for (const r of late) {
    await notify(tx, tenantId, [r.assigned_to], { kind: 'reminder.review_due', title: `${r.doc_number}: the impact review was due ${iso(new Date(r.due_on))}`, link: `/documents/${r.document_id}`,
      subjectType: 'spec_review', subjectId: r.id, dedupeKey: `spec-review-late:${r.id}:${iso(new Date())}` });
  }
  return late.length;
}
