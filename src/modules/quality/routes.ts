import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, can } from '../../platform/auth/actor.js';
import { forbidden } from '../../platform/errors.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  addAction, advanceCapa, assignableUsers, cancelAction, cancelCapa, cancelNcr, closeNcr, completeAction, containNcr, createCapa, createNcr, dispositionNcr, getCapa, getNcr,
  linkNcrToCapa, listCapas, listNcrs, myActions, updateCapa, verifyCapa,
} from './service.js';
import { ATTACHMENT_MIME, addAttachment, attachmentFile, listAttachments } from './attachments.js';
import { addItem, capaForFinding, closeAudit, createAudit, getAudit, listAudits, recordItem, reportAudit, startAudit } from './audits.js';
import { getPlan, listCalibration, recordCalibration, savePlan } from './calibration.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const reason = z.object({ reason: z.string().min(3).max(2000) });

const SUBJECTS = ['nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit'] as const;

export const qualityRoutes = (blobs: BlobStore) => async (app: FastifyInstance) => {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);

  app.get('/nonconformances', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), open: z.coerce.boolean().optional(), source: z.string().optional(), partId: uuid.optional(), supplierId: uuid.optional() }), req.query);
    return run(req, (tx, a) => listNcrs(tx, a, q));
  });
  app.post('/nonconformances', async (req, reply) => {
    const b = parse(z.object({
      facilityId: uuid.optional(), source: z.enum(['production', 'receiving', 'customer', 'supplier', 'internal']).optional(), title: z.string().max(200).optional(),
      description: z.string().min(3).max(4000), severity: z.enum(['minor', 'major', 'critical']).optional(), partId: uuid.nullable().optional(), qty: z.number().positive().nullable().optional(),
      productionEntryId: uuid.nullable().optional(), productionOrderId: uuid.nullable().optional(), purchaseOrderId: uuid.nullable().optional(), supplierId: uuid.nullable().optional(),
      customerId: uuid.nullable().optional(), salesOrderId: uuid.nullable().optional(), assetId: uuid.nullable().optional(),
    }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createNcr(tx, a, b));
  });
  app.get('/nonconformances/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getNcr(tx, a, id)); });
  app.post('/nonconformances/:id/contain', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ containment: z.string().min(3).max(4000) }), req.body);
    await run(req, (tx, a) => containNcr(tx, a, id, b.containment)); done(reply);
  });
  app.post('/nonconformances/:id/disposition', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ disposition: z.enum(['use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier']), reason: z.string().max(4000).nullable().optional(), cost: z.number().min(0).nullable().optional() }), req.body);
    await run(req, (tx, a) => dispositionNcr(tx, a, id, b)); done(reply);
  });
  app.post('/nonconformances/:id/link', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ capaId: uuid }), req.body);
    await run(req, (tx, a) => linkNcrToCapa(tx, a, id, b.capaId)); done(reply);
  });
  app.post('/nonconformances/:id/close', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => closeNcr(tx, a, id)); done(reply); });
  app.post('/nonconformances/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(reason, req.body); await run(req, (tx, a) => cancelNcr(tx, a, id, b.reason)); done(reply); });

  app.get('/corrective-actions', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), open: z.coerce.boolean().optional(), mine: z.coerce.boolean().optional() }), req.query);
    return run(req, (tx, a) => listCapas(tx, a, q));
  });
  app.post('/corrective-actions', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, title: z.string().min(3).max(200), problem: z.string().min(3).max(4000),
      source: z.enum(['nonconformance', 'incident', 'customer_complaint', 'audit', 'internal']), priority: z.enum(['low', 'medium', 'high']).optional(), ownerUserId: uuid,
      dueDate: day.nullable().optional(), ncrIds: z.array(uuid).max(50).optional(), incidentId: uuid.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createCapa(tx, a, b));
  });
  app.get('/corrective-actions/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getCapa(tx, a, id)); });
  app.patch('/corrective-actions/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ containment: z.string().max(4000).nullable().optional(), rootCauseMethod: z.enum(['five_whys', 'fishbone', 'eight_d', 'other']).nullable().optional(),
      rootCause: z.string().max(4000).nullable().optional(), verifyAfter: day.nullable().optional(), dueDate: day.nullable().optional(), priority: z.enum(['low', 'medium', 'high']).optional(),
      ownerUserId: uuid.optional() }), req.body);
    await run(req, (tx, a) => updateCapa(tx, a, id, b)); done(reply);
  });
  app.post('/corrective-actions/:id/advance', async (req) => { const { id } = parse(Id, req.params); return { status: await run(req, (tx, a) => advanceCapa(tx, a, id)) }; });
  app.post('/corrective-actions/:id/verify', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ effective: z.boolean(), note: z.string().min(3).max(4000) }), req.body);
    await run(req, (tx, a) => verifyCapa(tx, a, id, b)); done(reply);
  });
  app.post('/corrective-actions/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(reason, req.body); await run(req, (tx, a) => cancelCapa(tx, a, id, b.reason)); done(reply); });

  app.get('/assignable-users', async (req) => {
    const q = parse(z.object({ facilityId: uuid }), req.query);
    return run(req, (tx, a) => {
      if (!can(a, 'quality.view', q.facilityId) && !can(a, 'safety.view', q.facilityId)) throw forbidden('quality.view');
      return assignableUsers(tx, q.facilityId);
    });
  });
  app.get('/actions/mine', async (req) => run(req, (tx, a) => myActions(tx, a)));
  app.post('/actions', async (req, reply) => {
    const b = parse(z.object({ subjectType: z.enum(['corrective_action', 'safety_incident', 'quality_audit']), subjectId: uuid, title: z.string().min(3).max(500), ownerUserId: uuid, dueDate: day,
      auditItemId: uuid.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addAction(tx, a, b));
  });
  app.post('/actions/:id/complete', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().min(3).max(4000) }), req.body);
    await run(req, (tx, a) => completeAction(tx, a, id, b.note)); done(reply);
  });
  app.post('/actions/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(reason, req.body); await run(req, (tx, a) => cancelAction(tx, a, id, b.reason)); done(reply); });

  app.get('/calibration', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listCalibration(tx, a, q)); });
  app.post('/calibration', async (req) => {
    const b = parse(z.object({ assetId: uuid, intervalDays: z.number().int().min(1).max(3650), tolerance: z.string().min(2).max(500), method: z.string().max(2000).nullable().optional(),
      provider: z.enum(['internal', 'external']).optional(), supplierId: uuid.nullable().optional(), procedureDocumentId: uuid.nullable().optional(), nextDue: day.nullable().optional(),
      active: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => savePlan(tx, a, b));
  });
  app.get('/calibration/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getPlan(tx, a, id)); });
  app.post('/calibration/:id/records', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ performedOn: day, performedBy: z.string().min(2).max(200), asFound: z.enum(['in_tolerance', 'out_of_tolerance']), asLeft: z.enum(['in_tolerance', 'adjusted', 'failed']),
      certificateNo: z.string().max(100).nullable().optional(), notes: z.string().max(4000).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => recordCalibration(tx, a, id, b));
  });

  app.get('/audits', async (req) => { const q = parse(z.object({ open: z.coerce.boolean().optional() }), req.query); return run(req, (tx, a) => listAudits(tx, a, q)); });
  app.post('/audits', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, title: z.string().min(3).max(200), scope: z.string().min(3).max(2000), kind: z.enum(['internal', 'supplier', 'customer', 'certification']).optional(),
      supplierId: uuid.nullable().optional(), plannedOn: day, leadAuditorId: uuid, auditeeUserId: uuid.nullable().optional(), items: z.array(z.string().max(1000)).min(1).max(200) }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createAudit(tx, a, b));
  });
  app.get('/audits/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getAudit(tx, a, id)); });
  app.post('/audits/:id/start', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => startAudit(tx, a, id)); done(reply); });
  app.post('/audits/:id/items', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ requirement: z.string().min(3).max(1000) }), req.body); await run(req, (tx, a) => addItem(tx, a, id, b.requirement)); done(reply); });
  app.post('/audits/:id/report', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ summary: z.string().min(3).max(8000) }), req.body); return run(req, (tx, a) => reportAudit(tx, a, id, b.summary)); });
  app.post('/audits/:id/close', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => closeAudit(tx, a, id)); done(reply); });
  app.post('/audit-items/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ result: z.enum(['conforming', 'observation', 'minor_nc', 'major_nc', 'not_applicable']), evidence: z.string().max(4000).nullable().optional() }), req.body);
    await run(req, (tx, a) => recordItem(tx, a, id, b)); done(reply);
  });
  app.post('/audit-items/:id/capa', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ ownerUserId: uuid.nullable().optional(), dueDate: day.nullable().optional() }), req.body ?? {});
    reply.status(201);
    return run(req, (tx, a) => capaForFinding(tx, a, id, b));
  });

  app.get('/attachments', async (req) => {
    const q = parse(z.object({ subjectType: z.enum(SUBJECTS), subjectId: uuid }), req.query);
    return run(req, (tx, a) => listAttachments(tx, a, q.subjectType, q.subjectId));
  });
  app.post('/attachments', async (req, reply) => {
    const b = parse(z.object({ subjectType: z.enum(SUBJECTS), subjectId: uuid, fileName: z.string().min(1).max(255), mime: z.enum(ATTACHMENT_MIME as [string, ...string[]]),
      contentBase64: z.string().min(1), restricted: z.boolean().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addAttachment(tx, a, blobs, { ...b, content: Buffer.from(b.contentBase64, 'base64') }));
  });
  app.get('/attachments/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const f = await run(req, (tx, a) => attachmentFile(tx, a, blobs, id));
    reply.header('content-type', f.mime).header('content-disposition', `inline; filename="${f.name}"`);
    return f.content;
  });
};
