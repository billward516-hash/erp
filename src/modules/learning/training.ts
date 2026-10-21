import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import type { Question } from './grading.js';
import { forDelivery, grade } from './grading.js';

type Source = 'individual' | 'job_title' | 'facility' | 'qualification' | 'retraining' | 'import';

/** Own records are always visible; anyone else's need learning.view_records at that person's facility. */
function assertRecordAccess(actor: Actor, employee: { id: string; facility_id: string | null }) {
  if (actor.employeeId === employee.id) return;
  if (!can(actor, 'learning.view_records', employee.facility_id)) throw forbidden('learning.view_records');
}

async function loadEnrollment(tx: Tx, enrollmentId: string, lock = false) {
  const e = await one(
    tx,
    `SELECT n.*, emp.facility_id AS employee_facility_id, emp.first_name || ' ' || emp.last_name AS employee_name,
            v.status AS version_status, v.course_id, c.code AS course_code, c.title AS course_title
     FROM enrollment n JOIN employee emp ON emp.id = n.employee_id
     JOIN course_version v ON v.id = n.course_version_id JOIN course c ON c.id = v.course_id
     WHERE n.id = $1 ${lock ? 'FOR UPDATE OF n' : ''}`,
    [enrollmentId],
  );
  if (!e) throw notFound('enrollment');
  return e;
}

export interface AssignInput {
  courseId?: string;
  courseVersionId?: string;
  employeeIds?: string[];
  /** Assign to every active employee with this job title (within your visible facilities). */
  jobTitle?: string;
  /** Assign to every active employee at this facility. */
  facilityId?: string;
  dueOn?: string | null;
  source?: Source;
}

/** Assigns the published version of a course. People already enrolled (not cancelled) are skipped. */
export async function assignTraining(tx: Tx, actor: Actor, input: AssignInput) {
  let versionId = input.courseVersionId;
  if (!versionId) {
    const pv = await one(tx, `SELECT id FROM course_version WHERE course_id = $1 AND status = 'published'`, [input.courseId]);
    if (!pv) throw invalid('course has no published version');
    versionId = pv.id;
  }
  const v = await one(tx, `SELECT v.id, v.status, c.facility_id, c.code FROM course_version v JOIN course c ON c.id = v.course_id WHERE v.id = $1`, [versionId]);
  if (!v) throw notFound('course version');
  if (v.status !== 'published') throw invalid('only published course versions can be assigned');
  const params: unknown[] = [];
  const where: string[] = [`e.status = 'active'`];
  const p = (x: unknown) => `$${params.push(x)}`;
  if (input.employeeIds?.length) where.push(`e.id = ANY (${p(input.employeeIds)})`);
  if (input.jobTitle) where.push(`lower(e.job_title) = lower(${p(input.jobTitle)})`);
  if (input.facilityId) where.push(`e.facility_id = ${p(input.facilityId)}`);
  if (!input.employeeIds?.length && !input.jobTitle && !input.facilityId) throw invalid('choose employees, a job title, or a facility');
  const employees = await many(tx, `SELECT e.id, e.facility_id FROM employee e WHERE ${where.join(' AND ')}`, params);
  if (input.employeeIds?.length && employees.length !== new Set(input.employeeIds).size) throw invalid('some employees were not found, are inactive, or are outside your facilities');
  employees.forEach((e) => requirePermission(actor, 'learning.assign', e.facility_id));
  const source: Source = input.source ?? (input.jobTitle ? 'job_title' : input.facilityId ? 'facility' : 'individual');
  let created = 0;
  const enrollmentIds: string[] = [];
  for (const e of employees) {
    const row = await one(
      tx,
      `INSERT INTO enrollment (tenant_id, course_version_id, employee_id, source, assigned_by, due_on) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (course_version_id, employee_id) WHERE status <> 'cancelled' DO NOTHING RETURNING id`,
      [actor.tenantId, versionId, e.id, source, actor.userId, input.dueOn ?? null],
    );
    if (row) {
      created++;
      enrollmentIds.push(row.id);
      await audit(tx, actor, { action: 'training.assigned', entityType: 'employee', entityId: e.id, facilityId: e.facility_id,
        data: { enrollmentId: row.id, course: v.code, versionId, dueOn: input.dueOn ?? null, source } });
    }
  }
  return { courseVersionId: versionId, assigned: created, alreadyEnrolled: employees.length - created, enrollmentIds };
}

/** Recomputes whether every event is satisfied. Practical evaluations need a 'passed' outcome; assessments a passed attempt. */
async function refreshEnrollment(tx: Tx, actor: Actor, enrollmentId: string) {
  const n = await loadEnrollment(tx, enrollmentId, true);
  if (n.status === 'cancelled' || n.status === 'completed') return n.status;
  const events = await many(
    tx,
    `SELECT e.id, e.kind,
            (SELECT c.outcome FROM event_completion c WHERE c.enrollment_id = $1 AND c.learning_event_id = e.id ORDER BY c.completed_at DESC LIMIT 1) AS latest
     FROM learning_event e WHERE e.course_version_id = $2`,
    [enrollmentId, n.course_version_id],
  );
  const done = events.every((e) => (e.kind === 'practical_evaluation' || e.kind === 'assessment' ? e.latest === 'passed' : !!e.latest));
  const anything = events.some((e) => !!e.latest);
  const status = done ? 'completed' : anything ? 'in_progress' : 'assigned';
  if (status !== n.status) {
    await tx.query(`UPDATE enrollment SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN now() END WHERE id = $1`, [enrollmentId, status]);
    if (status === 'completed') {
      await audit(tx, actor, { action: 'training.completed', entityType: 'employee', entityId: n.employee_id, facilityId: n.employee_facility_id,
        data: { enrollmentId, course: n.course_code, versionId: n.course_version_id } });
    }
  }
  return status;
}

/**
 * Records completion of a non-assessment event. Who may record depends on the event kind:
 * learner self-attests video/self-study; an instructor records attendance and OJT shadowing;
 * a practical evaluation needs an evaluator (not the learner) with a written attestation.
 */
export async function recordCompletion(
  tx: Tx, actor: Actor, enrollmentId: string, eventId: string,
  input: { outcome?: 'completed' | 'attended' | 'passed' | 'not_yet_competent'; attestation?: string | null; completedAt?: Date },
) {
  const n = await loadEnrollment(tx, enrollmentId, true);
  if (n.status === 'cancelled') throw conflict('enrollment is cancelled');
  const ev = await one(tx, `SELECT e.*, d.current_version_id FROM learning_event e LEFT JOIN document d ON d.id = e.document_id WHERE e.id = $1 AND e.course_version_id = $2`, [eventId, n.course_version_id]);
  if (!ev) throw notFound('learning event in this course version');
  const self = actor.employeeId === n.employee_id;
  let outcome = input.outcome;
  switch (ev.completion_by) {
    case 'system':
      throw invalid('assessments are completed by submitting an attempt');
    case 'learner':
      if (!self && !can(actor, 'learning.instruct', n.employee_facility_id)) throw forbidden('learning.instruct');
      outcome = 'completed';
      break;
    case 'instructor':
      if (self) throw invalid('an instructor or trainer must record this, not the learner');
      requirePermission(actor, 'learning.instruct', n.employee_facility_id);
      outcome = ev.kind === 'instructor_led' ? 'attended' : 'completed';
      break;
    case 'evaluator':
      if (self) throw invalid('a practical evaluation cannot be signed by the learner');
      requirePermission(actor, 'learning.evaluate', n.employee_facility_id);
      if (outcome !== 'passed' && outcome !== 'not_yet_competent') throw invalid('practical evaluations record passed or not_yet_competent');
      if (!input.attestation || input.attestation.trim().length < 10) throw invalid('the evaluator must write an attestation of what was observed');
      break;
  }
  const c = await one(
    tx,
    `INSERT INTO event_completion (tenant_id, enrollment_id, learning_event_id, outcome, completed_at, recorded_by, attestation, document_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [actor.tenantId, enrollmentId, eventId, outcome, input.completedAt ?? new Date(), actor.userId, input.attestation ?? null, ev.current_version_id ?? null],
  );
  await audit(tx, actor, { action: ev.kind === 'practical_evaluation' ? 'training.evaluated' : 'training.event_recorded', entityType: 'employee',
    entityId: n.employee_id, facilityId: n.employee_facility_id, data: { enrollmentId, eventId, kind: ev.kind, outcome } });
  const status = await refreshEnrollment(tx, actor, enrollmentId);
  return { completion: c, enrollmentStatus: status };
}

/** Questions for the learner to answer (no answer key), plus attempts used. */
export async function deliverAssessment(tx: Tx, actor: Actor, enrollmentId: string, eventId: string) {
  const n = await loadEnrollment(tx, enrollmentId);
  if (actor.employeeId !== n.employee_id) throw forbidden('only the enrolled learner can take this assessment');
  const a = await one(tx, `SELECT a.* FROM assessment a JOIN learning_event e ON e.id = a.learning_event_id WHERE e.id = $1 AND e.course_version_id = $2`, [eventId, n.course_version_id]);
  if (!a) throw notFound('assessment');
  const used = await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM assessment_attempt WHERE enrollment_id = $1 AND assessment_id = $2', [enrollmentId, a.id]);
  return { assessmentId: a.id, passingScore: a.passing_score, attemptsUsed: used!.n, maxAttempts: a.max_attempts, questions: forDelivery(a.questions as Question[]) };
}

export async function submitAttempt(tx: Tx, actor: Actor, enrollmentId: string, eventId: string, responses: Record<string, number[]>) {
  const n = await loadEnrollment(tx, enrollmentId, true);
  if (actor.employeeId !== n.employee_id) throw forbidden('only the enrolled learner can submit this assessment');
  if (n.status === 'cancelled') throw conflict('enrollment is cancelled');
  const a = await one(tx, `SELECT a.* FROM assessment a JOIN learning_event e ON e.id = a.learning_event_id WHERE e.id = $1 AND e.course_version_id = $2`, [eventId, n.course_version_id]);
  if (!a) throw notFound('assessment');
  const prior = await many(tx, 'SELECT passed FROM assessment_attempt WHERE enrollment_id = $1 AND assessment_id = $2', [enrollmentId, a.id]);
  if (prior.some((p) => p.passed)) throw conflict('assessment already passed');
  if (prior.length >= a.max_attempts) throw conflict(`no attempts left (${a.max_attempts} allowed); a trainer must re-assign the course`);
  const result = grade(a.questions as Question[], responses, Number(a.passing_score));
  const attempt = await one(
    tx,
    `INSERT INTO assessment_attempt (tenant_id, enrollment_id, assessment_id, attempt_no, responses, score, passed, submitted_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, attempt_no, score, passed, submitted_at`,
    [actor.tenantId, enrollmentId, a.id, prior.length + 1, JSON.stringify(responses), result.score, result.passed, actor.userId],
  );
  if (result.passed) {
    await tx.query(
      `INSERT INTO event_completion (tenant_id, enrollment_id, learning_event_id, outcome, recorded_by) VALUES ($1, $2, $3, 'passed', $4)`,
      [actor.tenantId, enrollmentId, eventId, actor.userId],
    );
  }
  await audit(tx, actor, { action: 'training.assessment_submitted', entityType: 'employee', entityId: n.employee_id, facilityId: n.employee_facility_id,
    data: { enrollmentId, assessmentId: a.id, attemptNo: attempt.attempt_no, score: result.score, passed: result.passed } });
  const status = await refreshEnrollment(tx, actor, enrollmentId);
  // Results show the score and which questions were missed by id — not the answer key.
  return { ...attempt, attemptsRemaining: a.max_attempts - prior.length - 1, unanswered: result.unanswered, enrollmentStatus: status };
}

export async function addEvidence(
  tx: Tx, actor: Actor, blobs: BlobStore, enrollmentId: string,
  input: { eventCompletionId?: string | null; fileName: string; mimeType: string; content: Buffer },
) {
  const n = await loadEnrollment(tx, enrollmentId);
  const self = actor.employeeId === n.employee_id;
  if (!self && !can(actor, 'learning.instruct', n.employee_facility_id) && !can(actor, 'learning.evaluate', n.employee_facility_id)) {
    throw forbidden('learning.instruct');
  }
  if (input.eventCompletionId && !(await one(tx, 'SELECT 1 FROM event_completion WHERE id = $1 AND enrollment_id = $2', [input.eventCompletionId, enrollmentId]))) {
    throw invalid('completion does not belong to this enrollment');
  }
  const stored = await blobs.put(actor.tenantId, input.content);
  const row = await one(
    tx,
    `INSERT INTO training_evidence (tenant_id, enrollment_id, event_completion_id, storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, file_name, mime_type, size_bytes, sha256, uploaded_at`,
    [actor.tenantId, enrollmentId, input.eventCompletionId ?? null, stored.key, input.fileName, input.mimeType, stored.size, stored.sha256, actor.userId],
  );
  await audit(tx, actor, { action: 'training.evidence_added', entityType: 'employee', entityId: n.employee_id, facilityId: n.employee_facility_id,
    data: { enrollmentId, evidenceId: row.id, sha256: stored.sha256 } });
  return row;
}

export async function downloadEvidence(tx: Tx, actor: Actor, blobs: BlobStore, evidenceId: string) {
  const ev = await one(tx, `SELECT t.*, n.employee_id, emp.facility_id FROM training_evidence t JOIN enrollment n ON n.id = t.enrollment_id
                            JOIN employee emp ON emp.id = n.employee_id WHERE t.id = $1`, [evidenceId]);
  if (!ev) throw notFound('evidence');
  assertRecordAccess(actor, { id: ev.employee_id, facility_id: ev.facility_id });
  await audit(tx, actor, { action: 'training.evidence_viewed', entityType: 'employee', entityId: ev.employee_id, facilityId: ev.facility_id, data: { evidenceId } });
  return { fileName: ev.file_name as string, mimeType: ev.mime_type as string, content: await blobs.get(ev.storage_key) };
}

/** Full training record for one enrollment: every event, each completion, attempts (scores only), evidence. */
export async function getEnrollment(tx: Tx, actor: Actor, enrollmentId: string) {
  const n = await loadEnrollment(tx, enrollmentId);
  assertRecordAccess(actor, { id: n.employee_id, facility_id: n.employee_facility_id });
  const events = await many(
    tx,
    `SELECT e.id, e.seq, e.kind, e.title, e.completion_by, e.document_id, d.doc_number,
            coalesce((SELECT json_agg(json_build_object('id', c.id, 'outcome', c.outcome, 'completedAt', c.completed_at,
                       'recordedBy', u.display_name, 'attestation', c.attestation, 'documentVersionId', c.document_version_id) ORDER BY c.completed_at)
                      FROM event_completion c JOIN app_user u ON u.id = c.recorded_by WHERE c.enrollment_id = $1 AND c.learning_event_id = e.id), '[]') AS completions,
            coalesce((SELECT json_agg(json_build_object('attemptNo', t.attempt_no, 'score', t.score, 'passed', t.passed, 'submittedAt', t.submitted_at) ORDER BY t.attempt_no)
                      FROM assessment_attempt t JOIN assessment a ON a.id = t.assessment_id WHERE t.enrollment_id = $1 AND a.learning_event_id = e.id), '[]') AS attempts
     FROM learning_event e LEFT JOIN document d ON d.id = e.document_id
     WHERE e.course_version_id = $2 ORDER BY e.seq`,
    [enrollmentId, n.course_version_id],
  );
  const evidence = await many(tx, 'SELECT id, event_completion_id, file_name, mime_type, size_bytes, sha256, uploaded_at FROM training_evidence WHERE enrollment_id = $1 ORDER BY uploaded_at', [enrollmentId]);
  return { ...n, events, evidence };
}

export async function listEnrollments(tx: Tx, actor: Actor, q: { employeeId?: string; mine?: boolean; courseId?: string; status?: string }) {
  const employeeId = q.mine ? actor.employeeId : q.employeeId;
  if (q.mine && !employeeId) throw invalid('your user is not linked to an employee record');
  if (!q.mine) requirePermission(actor, 'learning.view_records');
  const rows = await many(
    tx,
    `SELECT n.id, n.employee_id, emp.first_name || ' ' || emp.last_name AS employee, emp.facility_id, c.id AS course_id, c.code, c.title,
            v.version_no, n.status, n.due_on, n.assigned_at, n.completed_at, n.source,
            (n.due_on < current_date AND n.status IN ('assigned', 'in_progress')) AS overdue
     FROM enrollment n JOIN employee emp ON emp.id = n.employee_id JOIN course_version v ON v.id = n.course_version_id JOIN course c ON c.id = v.course_id
     WHERE ($1::uuid IS NULL OR n.employee_id = $1) AND ($2::uuid IS NULL OR c.id = $2) AND ($3::text IS NULL OR n.status = $3)
     ORDER BY n.due_on NULLS LAST, emp.last_name`,
    [employeeId ?? null, q.courseId ?? null, q.status ?? null],
  );
  return rows.filter((r) => r.employee_id === actor.employeeId || can(actor, 'learning.view_records', r.facility_id));
}

export async function cancelEnrollment(tx: Tx, actor: Actor, enrollmentId: string, reason: string) {
  const n = await loadEnrollment(tx, enrollmentId, true);
  requirePermission(actor, 'learning.assign', n.employee_facility_id);
  if (n.status === 'completed' || n.status === 'cancelled') throw conflict(`enrollment is ${n.status}`);
  await tx.query(`UPDATE enrollment SET status = 'cancelled' WHERE id = $1`, [enrollmentId]);
  await audit(tx, actor, { action: 'training.cancelled', entityType: 'employee', entityId: n.employee_id, facilityId: n.employee_facility_id, data: { enrollmentId, reason } });
}
