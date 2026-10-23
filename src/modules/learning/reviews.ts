import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { assignTraining } from './training.js';

/**
 * Called when a document version is approved. Opens one review per published course version that
 * teaches from that document. Historical training records are untouched; a person decides next steps.
 */
export async function raiseTrainingReviews(tx: Tx, actor: Pick<Actor, 'tenantId' | 'userId'>, documentId: string, documentVersionId: string) {
  const courses = await many(
    tx,
    `SELECT DISTINCT v.id AS course_version_id, c.code, c.facility_id FROM learning_event e
     JOIN course_version v ON v.id = e.course_version_id JOIN course c ON c.id = v.course_id
     WHERE e.document_id = $1 AND v.status = 'published'`,
    [documentId],
  );
  const raised: { reviewId: string; course: string }[] = [];
  for (const c of courses) {
    const r = await one(
      tx,
      `INSERT INTO training_review (tenant_id, course_version_id, document_id, document_version_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (course_version_id, document_version_id) DO NOTHING RETURNING id`,
      [actor.tenantId, c.course_version_id, documentId, documentVersionId],
    );
    if (r) {
      raised.push({ reviewId: r.id, course: c.code });
      await audit(tx, actor, { action: 'training.review_raised', entityType: 'course_version', entityId: c.course_version_id, facilityId: c.facility_id,
        data: { reviewId: r.id, documentId, documentVersionId } });
    }
  }
  return raised;
}

export async function listTrainingReviews(tx: Tx, actor: Actor, q: { status?: string }) {
  requirePermission(actor, 'learning.manage');
  return many(
    tx,
    `SELECT r.id, r.status, r.raised_at, r.decided_at, r.decision_note, c.id AS course_id, c.code, c.title, v.version_no,
            d.doc_number, dv.version_label, dv.change_summary,
            (SELECT count(*)::int FROM enrollment n WHERE n.course_version_id = r.course_version_id AND n.status = 'completed') AS trained_people
     FROM training_review r JOIN course_version v ON v.id = r.course_version_id JOIN course c ON c.id = v.course_id
     JOIN document d ON d.id = r.document_id JOIN document_version dv ON dv.id = r.document_version_id
     WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.raised_at DESC`,
    [q.status ?? null],
  );
}

/**
 * Records the decision. 'retraining_assigned' assigns a published version of the same course (usually a
 * new version created after the document change) to everyone who completed the reviewed version.
 * Existing qualifications are not revoked automatically; that is a separate, deliberate action.
 */
export async function decideTrainingReview(
  tx: Tx, actor: Actor, reviewId: string,
  input: { decision: 'no_retraining' | 'retraining_assigned'; note: string; courseVersionId?: string; dueOn?: string | null },
) {
  const r = await one(tx, `SELECT r.*, v.course_id, c.facility_id FROM training_review r JOIN course_version v ON v.id = r.course_version_id
                           JOIN course c ON c.id = v.course_id WHERE r.id = $1 FOR UPDATE OF r`, [reviewId]);
  if (!r) throw notFound('training review');
  requirePermission(actor, 'learning.manage', r.facility_id);
  if (r.status !== 'open') throw conflict(`review already decided (${r.status})`);
  if (!input.note || input.note.trim().length < 5) throw invalid('explain the decision in the note');
  let assigned = 0;
  if (input.decision === 'retraining_assigned') {
    const target = input.courseVersionId ?? (await one(tx, `SELECT id FROM course_version WHERE course_id = $1 AND status = 'published'`, [r.course_id]))?.id;
    const tv = target && (await one(tx, 'SELECT id, course_id, status FROM course_version WHERE id = $1', [target]));
    if (!tv || tv.course_id !== r.course_id || tv.status !== 'published') throw invalid('retraining needs a published version of the same course');
    // Everyone retrained already completed the reviewed version, so assigning it again would reach no one (D-161).
    if (tv.id === r.course_version_id) throw invalid('publish a revised version of the course first: everyone to retrain has already completed this one');
    const people = await many(tx, `SELECT DISTINCT employee_id FROM enrollment WHERE course_version_id = $1 AND status = 'completed'`, [r.course_version_id]);
    if (people.length) {
      const res = await assignTraining(tx, actor, { courseVersionId: tv.id, employeeIds: people.map((p) => p.employee_id), dueOn: input.dueOn ?? null, source: 'retraining' });
      assigned = res.assigned;
    }
  }
  await tx.query(`UPDATE training_review SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
    [reviewId, input.decision, actor.userId, input.note]);
  await audit(tx, actor, { action: 'training.review_decided', entityType: 'course_version', entityId: r.course_version_id, facilityId: r.facility_id,
    data: { reviewId, decision: input.decision, assigned } });
  return { reviewId, decision: input.decision, assigned };
}
