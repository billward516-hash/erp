import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, requirePermission } from '../../platform/auth/actor.js';
import { one } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';
import { actorOf, parse, qbool, sendFile } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { addLearningEvent, createCourse, createCourseVersion, EVENT_KINDS, getCourse, listCourses, publishVersion } from './catalog.js';
import { certificateToPdf } from './certificate-pdf.js';
import {
  certificateData, checkAssetQualification, createQualification, eligibility, employeeQualifications, grantQualification, issueCertificate,
  listQualifications, recordExternalCredential, revokeQualification, setAssetRequirement,
} from './qualifications.js';
import { decideTrainingReview, listTrainingReviews } from './reviews.js';
import { addEvidence, assignTraining, cancelEnrollment, deliverAssessment, downloadEvidence, getEnrollment, listEnrollments, recordCompletion, submitAttempt } from './training.js';

const Id = z.object({ id: z.string().uuid() });
const date = z.string().date();

export function learningRoutes(blobs: BlobStore) {
  return async function (app: FastifyInstance) {
    // ---- catalog
    app.get('/courses', async (req) => asActor(actorOf(req), (tx) => listCourses(tx, actorOf(req))));
    app.post('/courses', async (req, reply) => {
      const b = parse(z.object({ facilityId: z.string().uuid().nullable().optional(), code: z.string().min(1).max(40), title: z.string().min(1).max(200), description: z.string().max(5000).nullable().optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => createCourse(tx, actorOf(req), b));
    });
    app.get('/courses/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getCourse(tx, actorOf(req), id)); });
    app.post('/courses/:id/versions', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ objectives: z.string().max(5000).nullable().optional(), reviewDueOn: date.nullable().optional(), changeSummary: z.string().max(2000).nullable().optional(),
        copyFromVersionId: z.string().uuid().nullable().optional() }), req.body ?? {});
      reply.status(201);
      return asActor(actorOf(req), (tx) => createCourseVersion(tx, actorOf(req), id, b));
    });
    app.post('/course-versions/:id/events', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ kind: z.enum(EVENT_KINDS), title: z.string().min(1).max(200), instructions: z.string().max(5000).nullable().optional(),
        documentId: z.string().uuid().nullable().optional(), durationMinutes: z.number().int().positive().max(10000).nullable().optional(),
        assessment: z.object({ passingScore: z.number().min(0).max(100), maxAttempts: z.number().int().positive().max(10).optional(), questions: z.unknown() }).optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => addLearningEvent(tx, actorOf(req), id, b));
    });
    app.post('/course-versions/:id/publish', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => publishVersion(tx, actorOf(req), id)); });

    // ---- assignment & training records
    app.post('/training/assign', async (req, reply) => {
      const b = parse(z.object({ courseId: z.string().uuid().optional(), courseVersionId: z.string().uuid().optional(), employeeIds: z.array(z.string().uuid()).max(1000).optional(),
        jobTitle: z.string().max(200).optional(), facilityId: z.string().uuid().optional(), dueOn: date.nullable().optional() })
        .refine((x) => x.courseId || x.courseVersionId, 'courseId or courseVersionId is required'), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => assignTraining(tx, actorOf(req), b));
    });
    app.get('/enrollments', async (req) => {
      const q = parse(z.object({ mine: qbool.optional(), employeeId: z.string().uuid().optional(), courseId: z.string().uuid().optional(),
        status: z.enum(['assigned', 'in_progress', 'completed', 'cancelled']).optional() }), req.query);
      return asActor(actorOf(req), (tx) => listEnrollments(tx, actorOf(req), q));
    });
    app.get('/enrollments/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getEnrollment(tx, actorOf(req), id)); });
    const EventParams = z.object({ id: z.string().uuid(), eventId: z.string().uuid() });
    app.post('/enrollments/:id/events/:eventId/complete', async (req) => {
      const { id, eventId } = parse(EventParams, req.params);
      const b = parse(z.object({ outcome: z.enum(['completed', 'attended', 'passed', 'not_yet_competent']).optional(), attestation: z.string().max(5000).nullable().optional(),
        completedAt: z.coerce.date().optional() }), req.body ?? {});
      return asActor(actorOf(req), (tx) => recordCompletion(tx, actorOf(req), id, eventId, b));
    });
    app.get('/enrollments/:id/events/:eventId/assessment', async (req) => {
      const { id, eventId } = parse(EventParams, req.params);
      return asActor(actorOf(req), (tx) => deliverAssessment(tx, actorOf(req), id, eventId));
    });
    app.post('/enrollments/:id/events/:eventId/attempts', async (req, reply) => {
      const { id, eventId } = parse(EventParams, req.params);
      const b = parse(z.object({ responses: z.record(z.array(z.number().int().nonnegative()).max(10)) }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => submitAttempt(tx, actorOf(req), id, eventId, b.responses));
    });
    app.post('/enrollments/:id/evidence', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const q = parse(z.object({ fileName: z.string().min(1).max(255), eventCompletionId: z.string().uuid().optional() }), req.query);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw invalid('file body is required');
      reply.status(201);
      return asActor(actorOf(req), (tx) => addEvidence(tx, actorOf(req), blobs, id, { ...q, mimeType: String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!, content: req.body as Buffer }));
    });
    app.get('/training-evidence/:id/download', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const f = await asActor(actorOf(req), (tx) => downloadEvidence(tx, actorOf(req), blobs, id));
      return sendFile(reply, { contentType: f.mimeType, fileName: f.fileName, body: f.content });
    });
    app.post('/enrollments/:id/cancel', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
      await asActor(actorOf(req), (tx) => cancelEnrollment(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });

    // ---- qualifications
    app.get('/qualifications', async (req) => asActor(actorOf(req), (tx) => listQualifications(tx, actorOf(req))));
    app.post('/qualifications', async (req, reply) => {
      const b = parse(z.object({ code: z.string().min(1).max(40), name: z.string().min(1).max(200), description: z.string().max(2000).nullable().optional(),
        validityMonths: z.number().int().positive().max(120).nullable().optional(), safetyCritical: z.boolean().optional(), requiresPractical: z.boolean().optional(),
        courseIds: z.array(z.string().uuid()).max(20).optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => createQualification(tx, actorOf(req), b));
    });
    app.get('/qualifications/:id/eligibility', async (req) => {
      const { id } = parse(Id, req.params);
      const q = parse(z.object({ employeeId: z.string().uuid() }), req.query);
      return asActor(actorOf(req), async (tx) => {
        const emp = await one(tx, 'SELECT facility_id FROM employee WHERE id = $1', [q.employeeId]);
        if (!emp) throw notFound('employee');
        requirePermission(actorOf(req), 'qualifications.view', emp.facility_id);
        return eligibility(tx, q.employeeId, id);
      });
    });
    app.post('/qualifications/:id/grant', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ employeeId: z.string().uuid(), effectiveOn: date.optional(), note: z.string().max(2000).optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => grantQualification(tx, actorOf(req), b.employeeId, id, b));
    });
    app.post('/qualification-grants/:id/revoke', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().min(5).max(2000) }), req.body);
      await asActor(actorOf(req), (tx) => revokeQualification(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
    app.post('/qualification-grants/:id/certificate', async (req, reply) => {
      const { id } = parse(Id, req.params);
      reply.status(201);
      return asActor(actorOf(req), (tx) => issueCertificate(tx, actorOf(req), id));
    });
    app.get('/certificates/:id/pdf', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const c = await asActor(actorOf(req), (tx) => certificateData(tx, actorOf(req), id));
      return sendFile(reply, { contentType: 'application/pdf', fileName: `${c.number}.pdf`, body: await certificateToPdf(c) }, true);
    });
    app.get('/employees/:id/qualifications', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => employeeQualifications(tx, actorOf(req), id)); });
    app.post('/employees/:id/credentials', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ name: z.string().min(1).max(200), issuer: z.string().min(1).max(200), credentialNo: z.string().max(100).nullable().optional(),
        issuedOn: date.nullable().optional(), expiresOn: date.nullable().optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => recordExternalCredential(tx, actorOf(req), id, b));
    });

    // ---- asset requirements
    const Req = z.object({ qualificationId: z.string().uuid(), scope: z.enum(['operate', 'maintain']) });
    app.put('/assets/:id/requirements', async (req, reply) => {
      const { id } = parse(Id, req.params); const b = parse(Req, req.body);
      await asActor(actorOf(req), (tx) => setAssetRequirement(tx, actorOf(req), id, b.qualificationId, b.scope));
      reply.status(204);
    });
    app.delete('/assets/:id/requirements', async (req, reply) => {
      const { id } = parse(Id, req.params); const b = parse(Req, req.body);
      await asActor(actorOf(req), (tx) => setAssetRequirement(tx, actorOf(req), id, b.qualificationId, b.scope, true));
      reply.status(204);
    });
    app.get('/assets/:id/qualified', async (req) => {
      const { id } = parse(Id, req.params);
      const q = parse(z.object({ employeeId: z.string().uuid(), scope: z.enum(['operate', 'maintain']).default('maintain') }), req.query);
      return asActor(actorOf(req), async (tx) => {
        const a = await one(tx, 'SELECT facility_id FROM asset WHERE id = $1', [id]);
        if (!a) throw notFound('asset');
        requirePermission(actorOf(req), 'qualifications.view', a.facility_id);
        return checkAssetQualification(tx, q.employeeId, id, q.scope);
      });
    });

    // ---- training reviews
    app.get('/training-reviews', async (req) => {
      const q = parse(z.object({ status: z.enum(['open', 'no_retraining', 'retraining_assigned']).optional() }), req.query);
      return asActor(actorOf(req), (tx) => listTrainingReviews(tx, actorOf(req), q));
    });
    app.post('/training-reviews/:id/decide', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ decision: z.enum(['no_retraining', 'retraining_assigned']), note: z.string().min(5).max(2000),
        courseVersionId: z.string().uuid().optional(), dueOn: date.nullable().optional() }), req.body);
      return asActor(actorOf(req), (tx) => decideTrainingReview(tx, actorOf(req), id, b));
    });
  };
}
