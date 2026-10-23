import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import type { Question } from './grading.js';
import { QuestionBankSchema } from './grading.js';

export const EVENT_KINDS = ['video', 'instructor_led', 'self_study', 'ojt_shadowing', 'practical_evaluation', 'assessment'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Who records completion of each kind of learning event. */
export const COMPLETION_BY: Record<EventKind, 'learner' | 'instructor' | 'evaluator' | 'system'> = {
  video: 'learner',
  self_study: 'learner',
  instructor_led: 'instructor',
  ojt_shadowing: 'instructor',
  practical_evaluation: 'evaluator',
  assessment: 'system',
};

export async function createCourse(tx: Tx, actor: Actor, input: { facilityId?: string | null; code: string; title: string; description?: string | null }) {
  requirePermission(actor, 'learning.manage', input.facilityId);
  if (await one(tx, 'SELECT 1 FROM course WHERE code = $1', [input.code])) throw conflict(`course ${input.code} already exists`);
  const c = await one(
    tx,
    `INSERT INTO course (tenant_id, facility_id, code, title, description, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [actor.tenantId, input.facilityId ?? null, input.code, input.title, input.description ?? null, actor.userId],
  );
  await audit(tx, actor, { action: 'course.created', entityType: 'course', entityId: c.id, facilityId: c.facility_id, data: { code: c.code } });
  return c;
}

/** New draft version. With copyFromVersionId, the events and assessments of that version are copied in. */
export async function createCourseVersion(
  tx: Tx, actor: Actor, courseId: string,
  input: { objectives?: string | null; reviewDueOn?: string | null; changeSummary?: string | null; copyFromVersionId?: string | null },
) {
  const course = await one(tx, 'SELECT * FROM course WHERE id = $1 FOR UPDATE', [courseId]);
  if (!course) throw notFound('course');
  requirePermission(actor, 'learning.manage', course.facility_id);
  if (await one(tx, `SELECT 1 FROM course_version WHERE course_id = $1 AND status = 'draft'`, [courseId])) {
    throw conflict('course already has a draft version; publish or edit it first');
  }
  const next = await one<{ n: number }>(tx, 'SELECT coalesce(max(version_no), 0) + 1 AS n FROM course_version WHERE course_id = $1', [courseId]);
  const v = await one(
    tx,
    `INSERT INTO course_version (tenant_id, course_id, version_no, objectives, review_due_on, change_summary, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, courseId, next!.n, input.objectives ?? null, input.reviewDueOn ?? null, input.changeSummary ?? null, actor.userId],
  );
  if (input.copyFromVersionId) {
    const src = await one(tx, 'SELECT id FROM course_version WHERE id = $1 AND course_id = $2', [input.copyFromVersionId, courseId]);
    if (!src) throw invalid('copyFromVersionId must be a version of the same course');
    const events = await many(tx, 'SELECT * FROM learning_event WHERE course_version_id = $1 ORDER BY seq', [src.id]);
    for (const e of events) {
      const ne = await one(
        tx,
        `INSERT INTO learning_event (tenant_id, course_version_id, seq, kind, title, instructions, document_id, duration_minutes, completion_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [actor.tenantId, v.id, e.seq, e.kind, e.title, e.instructions, e.document_id, e.duration_minutes, e.completion_by],
      );
      const a = await one(tx, 'SELECT * FROM assessment WHERE learning_event_id = $1', [e.id]);
      if (a) {
        await tx.query(`INSERT INTO assessment (tenant_id, learning_event_id, passing_score, max_attempts, questions) VALUES ($1, $2, $3, $4, $5)`,
          [actor.tenantId, ne!.id, a.passing_score, a.max_attempts, JSON.stringify(a.questions)]);
      }
    }
  }
  await audit(tx, actor, { action: 'course.version_created', entityType: 'course', entityId: courseId, facilityId: course.facility_id,
    data: { versionId: v.id, versionNo: v.version_no, copiedFrom: input.copyFromVersionId ?? null } });
  return v;
}

export interface EventInput {
  kind: EventKind;
  title: string;
  instructions?: string | null;
  documentId?: string | null;
  durationMinutes?: number | null;
  assessment?: { passingScore: number; maxAttempts?: number; questions?: unknown };
}

export async function addLearningEvent(tx: Tx, actor: Actor, versionId: string, input: EventInput) {
  const v = await one(tx, `SELECT v.*, c.facility_id FROM course_version v JOIN course c ON c.id = v.course_id WHERE v.id = $1 FOR UPDATE OF v`, [versionId]);
  if (!v) throw notFound('course version');
  requirePermission(actor, 'learning.manage', v.facility_id);
  if (v.status !== 'draft') throw conflict('only draft versions can be edited; create a new version');
  if (input.kind === 'assessment' && !input.assessment) throw invalid('assessment events need questions and a passing score');
  if (input.kind !== 'assessment' && input.assessment) throw invalid('only assessment events carry questions');
  if (input.documentId && !(await one(tx, 'SELECT 1 FROM document WHERE id = $1', [input.documentId]))) throw invalid('document not found');
  if (input.kind === 'video' && !input.documentId) throw invalid('video events must reference a controlled video document');
  let questions: Question[] | undefined;
  if (input.assessment) {
    const parsed = QuestionBankSchema.safeParse(input.assessment.questions);
    if (!parsed.success) throw invalid('assessment questions are not valid', parsed.error.flatten());
    questions = parsed.data;
  }
  const seq = await one<{ n: number }>(tx, 'SELECT coalesce(max(seq), 0) + 1 AS n FROM learning_event WHERE course_version_id = $1', [versionId]);
  const e = await one(
    tx,
    `INSERT INTO learning_event (tenant_id, course_version_id, seq, kind, title, instructions, document_id, duration_minutes, completion_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, versionId, seq!.n, input.kind, input.title, input.instructions ?? null, input.documentId ?? null,
      input.durationMinutes ?? null, COMPLETION_BY[input.kind]],
  );
  if (questions) {
    await tx.query(`INSERT INTO assessment (tenant_id, learning_event_id, passing_score, max_attempts, questions) VALUES ($1, $2, $3, $4, $5)`,
      [actor.tenantId, e.id, input.assessment!.passingScore, input.assessment!.maxAttempts ?? 3, JSON.stringify(questions)]);
  }
  await audit(tx, actor, { action: 'course.event_added', entityType: 'course', entityId: v.course_id, facilityId: v.facility_id,
    data: { versionId, eventId: e.id, kind: e.kind } });
  return e;
}

/**
 * Publishes a draft. Every referenced document must have an approved version (learners only ever see
 * approved content). The previous published version is retired for new assignments; people already
 * enrolled on it keep their enrollment and records.
 */
export async function publishVersion(tx: Tx, actor: Actor, versionId: string) {
  const v = await one(tx, `SELECT v.*, c.facility_id, c.code FROM course_version v JOIN course c ON c.id = v.course_id WHERE v.id = $1 FOR UPDATE OF v`, [versionId]);
  if (!v) throw notFound('course version');
  requirePermission(actor, 'learning.manage', v.facility_id);
  if (v.status !== 'draft') throw conflict(`version is already ${v.status}`);
  const events = await many(tx, `SELECT e.*, d.current_version_id, d.doc_number FROM learning_event e LEFT JOIN document d ON d.id = e.document_id WHERE e.course_version_id = $1`, [versionId]);
  if (!events.length) throw invalid('add at least one learning event before publishing');
  const unapproved = events.filter((e) => e.document_id && !e.current_version_id).map((e) => e.doc_number);
  if (unapproved.length) throw invalid(`referenced documents have no approved version: ${unapproved.join(', ')}`);
  const previous = await one(tx, `SELECT id FROM course_version WHERE course_id = $1 AND status = 'published'`, [v.course_id]);
  if (previous) await tx.query(`UPDATE course_version SET status = 'retired' WHERE id = $1`, [previous.id]);
  await tx.query(`UPDATE course_version SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`, [versionId, actor.userId]);
  await audit(tx, actor, { action: 'course.version_published', entityType: 'course', entityId: v.course_id, facilityId: v.facility_id,
    data: { versionId, versionNo: v.version_no, retired: previous?.id ?? null } });
  return { versionId, retiredVersionId: previous?.id ?? null };
}

export async function listCourses(tx: Tx, actor: Actor) {
  requirePermission(actor, 'learning.view');
  return many(
    tx,
    `SELECT c.id, c.code, c.title, c.facility_id, c.active,
            pv.id AS published_version_id, pv.version_no AS published_version_no, pv.review_due_on,
            (SELECT count(*)::int FROM learning_event e WHERE e.course_version_id = pv.id) AS events,
            EXISTS (SELECT 1 FROM course_version d WHERE d.course_id = c.id AND d.status = 'draft') AS has_draft
     FROM course c LEFT JOIN course_version pv ON pv.course_id = c.id AND pv.status = 'published'
     ORDER BY c.code`,
  );
}

/** Course detail. Answer keys are only included for course authors. */
export async function getCourse(tx: Tx, actor: Actor, courseId: string) {
  const c = await one(tx, 'SELECT * FROM course WHERE id = $1', [courseId]);
  if (!c) throw notFound('course');
  requirePermission(actor, 'learning.view', c.facility_id);
  const author = can(actor, 'learning.manage', c.facility_id);
  const versions = await many(tx, `SELECT * FROM course_version WHERE course_id = $1 ${author ? '' : `AND status = 'published'`} ORDER BY version_no DESC`, [courseId]);
  for (const v of versions) {
    const events = await many(
      tx,
      `SELECT e.id, e.seq, e.kind, e.title, e.instructions, e.duration_minutes, e.completion_by, e.document_id,
              d.doc_number, d.title AS document_title, a.passing_score, a.max_attempts, a.questions
       FROM learning_event e LEFT JOIN document d ON d.id = e.document_id LEFT JOIN assessment a ON a.learning_event_id = e.id
       WHERE e.course_version_id = $1 ORDER BY e.seq`,
      [v.id],
    );
    // Learners see questions only when they take the assessment (see training.ts), never from the catalog.
    v.events = events.map((e) => ({ ...e, question_count: e.questions?.length, questions: author ? e.questions : undefined }));
  }
  const qualifications = await many(tx, `SELECT q.id, q.code, q.name FROM qualification_course qc JOIN qualification q ON q.id = qc.qualification_id WHERE qc.course_id = $1`, [courseId]);
  return { ...c, versions, qualifications };
}
