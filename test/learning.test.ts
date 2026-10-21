import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createAsset } from '../src/modules/assets/service.js';
import { addVersion, approveVersion, createDocument } from '../src/modules/documents/service.js';
import { addLearningEvent, createCourse, createCourseVersion, getCourse, publishVersion } from '../src/modules/learning/catalog.js';
import { grade } from '../src/modules/learning/grading.js';
import {
  addMonths, checkAssetQualification, createQualification, eligibility, grantQualification, issueCertificate, qualificationStatus,
  revokeQualification, setAssetRequirement,
} from '../src/modules/learning/qualifications.js';
import { decideTrainingReview, listTrainingReviews } from '../src/modules/learning/reviews.js';
import { addEvidence, assignTraining, deliverAssessment, getEnrollment, listEnrollments, recordCompletion, submitAttempt } from '../src/modules/learning/training.js';
import { addLabor, assignTechnician, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
let w: World;
let assetId: string;
let sopDocId: string;
let courseId: string;
let versionId: string;
let qualId: string;
const ev: Record<string, string> = {};

const QUESTIONS = [
  { id: 'q1', prompt: 'Before opening the spindle housing you must…', type: 'single', options: ['Notify the operator', 'Apply lockout/tagout', 'Run warm-up'], answer: [1] },
  { id: 'q2', prompt: 'Which are signs of bearing wear? (select all)', type: 'multi', options: ['Noise rising with rpm', 'Coolant smell', 'Heat at the nose'], answer: [0, 2] },
  { id: 'q3', prompt: 'Drawbar pressure should be checked first.', type: 'true_false', options: ['True', 'False'], answer: [0] },
  { id: 'q4', prompt: 'Matched-pair bearings may be mixed between sets.', type: 'true_false', options: ['True', 'False'], answer: [1] },
];

beforeAll(async () => {
  w = await makeWorld('lms');
  ({ assetId, sopDocId } = await asActor(w.admin, async (tx) => {
    const a = await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'HMC-1', name: 'Horizontal machining center' });
    const doc = await createDocument(tx, w.admin, { facilityId: w.facilities.A!, docNumber: 'RP-SPN', title: 'Spindle bearing replacement', docType: 'repair_procedure' });
    const v = await addVersion(tx, w.admin, blobs, doc.id, { versionLabel: 'Rev A', fileName: 'rp.txt', mimeType: 'text/plain', content: Buffer.from('rev a') });
    await approveVersion(tx, w.admin, v.id);
    const video = await createDocument(tx, w.admin, { facilityId: null, docNumber: 'VID-SPN', title: 'Spindle overview video', docType: 'video' });
    const vv = await addVersion(tx, w.admin, blobs, video.id, { versionLabel: '1', fileName: 'spn.mp4', mimeType: 'video/mp4', content: Buffer.from('fake-video') });
    await approveVersion(tx, w.admin, vv.id);
    return { assetId: a.id, sopDocId: doc.id, videoId: video.id };
  }));
  const videoDoc = await asActor(w.admin, (tx) => one(tx, `SELECT id FROM document WHERE doc_number = 'VID-SPN'`));
  ({ courseId, versionId } = await asActor(w.managerA, async (tx) => {
    const c = await createCourse(tx, w.managerA, { facilityId: w.facilities.A!, code: 'SPN-201', title: 'HMC spindle service' });
    const v = await createCourseVersion(tx, w.managerA, c.id, { objectives: 'Diagnose and replace spindle bearings safely' });
    ev.video = (await addLearningEvent(tx, w.managerA, v.id, { kind: 'video', title: 'Spindle overview', documentId: videoDoc.id, durationMinutes: 20 })).id;
    ev.ilt = (await addLearningEvent(tx, w.managerA, v.id, { kind: 'instructor_led', title: 'LOTO classroom session', durationMinutes: 60 })).id;
    ev.self = (await addLearningEvent(tx, w.managerA, v.id, { kind: 'self_study', title: 'Read the repair procedure', documentId: sopDocId })).id;
    ev.ojt = (await addLearningEvent(tx, w.managerA, v.id, { kind: 'ojt_shadowing', title: 'Shadow a bearing replacement' })).id;
    ev.quiz = (await addLearningEvent(tx, w.managerA, v.id, { kind: 'assessment', title: 'Knowledge check', assessment: { passingScore: 75, maxAttempts: 2, questions: QUESTIONS } })).id;
    ev.practical = (await addLearningEvent(tx, w.managerA, v.id, { kind: 'practical_evaluation', title: 'Observed bearing replacement' })).id;
    return { courseId: c.id, versionId: v.id };
  }));
});
afterAll(closePools);

describe('grading', () => {
  it('scores exact matches, all-or-nothing for multi-select', () => {
    const qs = QUESTIONS.map((q) => ({ ...q, points: 1 })) as any;
    expect(grade(qs, { q1: [1], q2: [0, 2], q3: [0], q4: [1] }, 75)).toMatchObject({ score: 100, passed: true });
    expect(grade(qs, { q1: [1], q2: [0], q3: [0], q4: [0] }, 75)).toMatchObject({ score: 50, passed: false });
    expect(grade(qs, { q1: [1], q2: [2, 0, 0], q3: [0] }, 75)).toMatchObject({ score: 75, passed: true, unanswered: ['q4'] });
  });
  it('adds calendar months without overflowing short months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-10-21', 24)).toBe('2028-10-21');
  });
});

describe('course authoring', () => {
  it('rejects invalid question banks and assessments without questions', async () => {
    await expect(asActor(w.managerA, async (tx) => {
      const c = await createCourse(tx, w.managerA, { code: 'BAD', title: 'bad' });
      const v = await createCourseVersion(tx, w.managerA, c.id, {});
      await addLearningEvent(tx, w.managerA, v.id, { kind: 'assessment', title: 'x', assessment: { passingScore: 80, questions: [{ id: 'a', prompt: 'p', type: 'single', options: ['x', 'y'], answer: [5] }] } });
    })).rejects.toThrow(/questions are not valid/);
  });

  it('publishes, then freezes the version content', async () => {
    await asActor(w.managerA, (tx) => publishVersion(tx, w.managerA, versionId));
    await expect(asActor(w.managerA, (tx) => addLearningEvent(tx, w.managerA, versionId, { kind: 'self_study', title: 'late add' }))).rejects.toThrow(/only draft/);
    await expect(asActor(w.admin, (tx) => tx.query('DELETE FROM learning_event WHERE id = $1', [ev.ilt]))).rejects.toThrow(/immutable/);
  });

  it('hides the answer key from learners browsing the catalog', async () => {
    const asTech = await asActor(w.techA, (tx) => getCourse(tx, w.techA, courseId));
    const quiz = asTech.versions[0].events.find((e: any) => e.kind === 'assessment');
    expect(quiz.questions).toBeUndefined();
    expect(quiz.question_count).toBe(4);
    const asAuthor = await asActor(w.managerA, (tx) => getCourse(tx, w.managerA, courseId));
    expect(asAuthor.versions[0].events.find((e: any) => e.kind === 'assessment').questions[0].answer).toEqual([1]);
  });
});

describe('mixed learning events through to qualification', () => {
  let enrollmentId: string;

  it('assigns training and records each event type with the right authority', async () => {
    const r = await asActor(w.managerA, (tx) => assignTraining(tx, w.managerA, { courseId, employeeIds: [w.techAEmployeeId, w.tech2AEmployeeId], dueOn: '2026-12-31' }));
    expect(r).toMatchObject({ assigned: 2, alreadyEnrolled: 0 });
    const again = await asActor(w.managerA, (tx) => assignTraining(tx, w.managerA, { courseId, employeeIds: [w.techAEmployeeId] }));
    expect(again).toMatchObject({ assigned: 0, alreadyEnrolled: 1 });
    enrollmentId = (await asActor(w.techA, (tx) => listEnrollments(tx, w.techA, { mine: true })))[0].id;

    // Learner self-attests video and self-study.
    await asActor(w.techA, (tx) => recordCompletion(tx, w.techA, enrollmentId, ev.video!, {}));
    await asActor(w.techA, (tx) => recordCompletion(tx, w.techA, enrollmentId, ev.self!, {}));
    // Learner cannot record their own classroom attendance, OJT, or practical evaluation.
    await expect(asActor(w.techA, (tx) => recordCompletion(tx, w.techA, enrollmentId, ev.ilt!, {}))).rejects.toThrow(/instructor or trainer/);
    await expect(asActor(w.techA, (tx) => recordCompletion(tx, w.techA, enrollmentId, ev.practical!, { outcome: 'passed', attestation: 'I did it well myself' }))).rejects.toThrow(/cannot be signed by the learner/);
    // Another technician without trainer rights cannot either.
    await expect(asActor(w.tech2A, (tx) => recordCompletion(tx, w.tech2A, enrollmentId, ev.ojt!, {}))).rejects.toThrow(/learning.instruct/);
    await asActor(w.managerA, (tx) => recordCompletion(tx, w.managerA, enrollmentId, ev.ilt!, {}));
    await asActor(w.managerA, (tx) => recordCompletion(tx, w.managerA, enrollmentId, ev.ojt!, {}));
    const rec = await asActor(w.techA, (tx) => getEnrollment(tx, w.techA, enrollmentId));
    expect(rec.status).toBe('in_progress');
    expect(rec.events.find((e: any) => e.kind === 'instructor_led').completions[0].outcome).toBe('attended');
    // Self-study recorded which approved document version was read.
    expect(rec.events.find((e: any) => e.kind === 'self_study').completions[0].documentVersionId).toBeTruthy();
  });

  it('delivers the assessment without answers, grades attempts and enforces the attempt limit', async () => {
    const d = await asActor(w.techA, (tx) => deliverAssessment(tx, w.techA, enrollmentId, ev.quiz!));
    expect(d.questions[0]).not.toHaveProperty('answer');
    expect(d).toMatchObject({ attemptsUsed: 0, maxAttempts: 2, passingScore: 75 });
    await expect(asActor(w.managerA, (tx) => submitAttempt(tx, w.managerA, enrollmentId, ev.quiz!, { q1: [1] }))).rejects.toThrow(/only the enrolled learner/);
    const fail = await asActor(w.techA, (tx) => submitAttempt(tx, w.techA, enrollmentId, ev.quiz!, { q1: [0], q2: [0], q3: [0], q4: [1] }));
    expect(fail).toMatchObject({ score: 50, passed: false, attemptsRemaining: 1 });
    expect(fail).not.toHaveProperty('answer');
    const pass = await asActor(w.techA, (tx) => submitAttempt(tx, w.techA, enrollmentId, ev.quiz!, { q1: [1], q2: [0, 2], q3: [0], q4: [1] }));
    expect(pass).toMatchObject({ score: 100, passed: true, enrollmentStatus: 'in_progress' });
    await expect(asActor(w.techA, (tx) => submitAttempt(tx, w.techA, enrollmentId, ev.quiz!, {}))).rejects.toThrow(/already passed/);
  });

  it('course completion alone does not qualify anyone', async () => {
    await expect(asActor(w.managerA, (tx) => eligibility(tx, w.techAEmployeeId, '00000000-0000-0000-0000-000000000000'))).rejects.toThrow(/not found/);
    qualId = (await asActor(w.managerA, (tx) => createQualification(tx, w.managerA, { code: 'Q-SPN', name: 'Spindle service', validityMonths: 24, safetyCritical: true, requiresPractical: true, courseIds: [courseId] }))).id;
    await asActor(w.managerA, (tx) => setAssetRequirement(tx, w.managerA, assetId, qualId, 'maintain'));
    const el = await asActor(w.managerA, (tx) => eligibility(tx, w.techAEmployeeId, qualId));
    expect(el.eligible).toBe(false);
    expect(el.reasons).toEqual(['course SPN-201 not completed', 'no passed practical evaluation on record']);
    await expect(asActor(w.managerA, (tx) => grantQualification(tx, w.managerA, w.techAEmployeeId, qualId))).rejects.toThrow(/training record incomplete/);
  });

  it('a practical evaluation needs an evaluator attestation; not-yet-competent does not complete the course', async () => {
    await expect(asActor(w.managerA, (tx) => recordCompletion(tx, w.managerA, enrollmentId, ev.practical!, { outcome: 'passed' }))).rejects.toThrow(/attestation/);
    const first = await asActor(w.managerA, (tx) => recordCompletion(tx, w.managerA, enrollmentId, ev.practical!, { outcome: 'not_yet_competent', attestation: 'Missed the preload check; repeat next week.' }));
    expect(first.enrollmentStatus).toBe('in_progress');
    const second = await asActor(w.managerA, (tx) => recordCompletion(tx, w.managerA, enrollmentId, ev.practical!, { outcome: 'passed', attestation: 'Replaced bearings unaided; preload and runout in spec.' }));
    expect(second.enrollmentStatus).toBe('completed');
    const ev1 = await asActor(w.techA, (tx) => addEvidence(tx, w.techA, blobs, enrollmentId, { fileName: 'runout.jpg', mimeType: 'image/jpeg', content: Buffer.from('jpeg') }));
    expect(ev1.sha256).toHaveLength(64);
    // Training records are append-only.
    await expect(asActor(w.admin, (tx) => tx.query(`UPDATE event_completion SET outcome = 'passed' WHERE enrollment_id = $1`, [enrollmentId]))).rejects.toThrow(/permission denied|append-only/); // runtime role has no UPDATE; trigger also blocks the owner
  });

  it('an authorized person grants; nobody self-grants; the grant expires on schedule', async () => {
    const el = await asActor(w.managerA, (tx) => eligibility(tx, w.techAEmployeeId, qualId));
    expect(el.eligible).toBe(true);
    const g = await asActor(w.managerA, (tx) => grantQualification(tx, w.managerA, w.techAEmployeeId, qualId, { effectiveOn: '2026-10-21' }));
    expect(g.expires_on).toBe('2028-10-21');
    expect(g.basis.evaluator).toBe('managerA');
    await expect(asActor(w.techA, (tx) => grantQualification(tx, w.techA, w.techAEmployeeId, qualId))).rejects.toThrow(/qualifications.grant/);
    const later = await asActor(w.admin, (tx) => qualificationStatus(tx, w.techAEmployeeId, qualId, new Date('2028-11-01')));
    expect(later.status).toBe('expired');
    const cert = await asActor(w.managerA, (tx) => issueCertificate(tx, w.managerA, g.id));
    expect(cert.number).toMatch(/^CERT-\d{4}-00001$/);
  });

  it('assignment to restricted equipment checks current qualification, and revocation takes effect immediately', async () => {
    const wo = await asActor(w.managerA, (tx) => createWorkOrder(tx, w.managerA, { assetId, title: 'Spindle bearing noise' }));
    // Luis has not completed the course: blocked, with the reason.
    await expect(asActor(w.managerA, (tx) => assignTechnician(tx, w.managerA, wo.id, w.tech2AEmployeeId))).rejects.toThrow(/not qualified to maintain this asset: Q-SPN \(not held\)/);
    await asActor(w.managerA, (tx) => assignTechnician(tx, w.managerA, wo.id, w.techAEmployeeId));
    await asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo.id, { to: 'in_progress' }));
    await asActor(w.techA, (tx) => addLabor(tx, w.techA, wo.id, { workDate: '2026-10-21', hours: 1 }));
    const grant = await asActor(w.admin, (tx) => one(tx, 'SELECT id FROM employee_qualification WHERE employee_id = $1', [w.techAEmployeeId]));
    await asActor(w.managerA, (tx) => revokeQualification(tx, w.managerA, grant.id, 'Bearing failure traced to incorrect preload'));
    await expect(asActor(w.techA, (tx) => addLabor(tx, w.techA, wo.id, { workDate: '2026-10-21', hours: 1 }))).rejects.toThrow(/Q-SPN \(revoked\)/);
    const check = await asActor(w.managerA, (tx) => checkAssetQualification(tx, w.techAEmployeeId, assetId, 'maintain'));
    expect(check).toMatchObject({ ok: false, missing: [{ code: 'Q-SPN', status: 'revoked' }] });
    await expect(asActor(w.admin, (tx) => tx.query('DELETE FROM employee_qualification WHERE id = $1', [grant.id]))).rejects.toThrow(/permission denied|cannot be deleted/);
  });

  it('a procedure revision opens a training review without touching past records', async () => {
    const before = await asActor(w.admin, (tx) => many(tx, `SELECT c.document_version_id FROM event_completion c WHERE c.learning_event_id = $1`, [ev.self]));
    const r = await asActor(w.admin, async (tx) => {
      const v2 = await addVersion(tx, w.admin, blobs, sopDocId, { versionLabel: 'Rev B', fileName: 'rp.txt', mimeType: 'text/plain', content: Buffer.from('rev b'), changeSummary: 'New preload torque' });
      return approveVersion(tx, w.admin, v2.id);
    });
    expect(r.trainingReviews).toEqual([{ reviewId: expect.any(String), course: 'SPN-201' }]);
    const after = await asActor(w.admin, (tx) => many(tx, `SELECT c.document_version_id FROM event_completion c WHERE c.learning_event_id = $1`, [ev.self]));
    expect(after).toEqual(before);
    const reviews = await asActor(w.managerA, (tx) => listTrainingReviews(tx, w.managerA, { status: 'open' }));
    expect(reviews[0]).toMatchObject({ code: 'SPN-201', version_label: 'Rev B', trained_people: 1 });

    // Decision: publish v2 of the course and retrain everyone who completed v1.
    const v2 = await asActor(w.managerA, async (tx) => {
      const v = await createCourseVersion(tx, w.managerA, courseId, { changeSummary: 'Rev B preload', copyFromVersionId: versionId });
      await publishVersion(tx, w.managerA, v.id);
      return v;
    });
    const d = await asActor(w.managerA, (tx) => decideTrainingReview(tx, w.managerA, reviews[0].id, { decision: 'retraining_assigned', note: 'Torque spec changed', courseVersionId: v2.id, dueOn: '2026-11-30' }));
    expect(d.assigned).toBe(1);
    const course = await asActor(w.managerA, (tx) => getCourse(tx, w.managerA, courseId));
    expect(course.versions.map((v: any) => [v.version_no, v.status])).toEqual([[2, 'published'], [1, 'retired']]);
  });

  it('training records are private to the learner and to people with records access', async () => {
    const mine = await asActor(w.tech2A, (tx) => listEnrollments(tx, w.tech2A, { mine: true }));
    expect(mine).toHaveLength(1);
    const priyaEnrollment = (await asActor(w.managerA, (tx) => listEnrollments(tx, w.managerA, { employeeId: w.techAEmployeeId })))[0].id;
    await expect(asActor(w.tech2A, (tx) => getEnrollment(tx, w.tech2A, priyaEnrollment))).rejects.toThrow(/learning.view_records/);
    await expect(asActor(w.tech2A, (tx) => listEnrollments(tx, w.tech2A, {}))).rejects.toThrow(/learning.view_records/);
    // Facility B operator cannot even see the Facility A employee's enrollment rows (RLS).
    expect(await asActor(w.operatorB, (tx) => many(tx, 'SELECT id FROM enrollment'))).toHaveLength(0);
  });
});
