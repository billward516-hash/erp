import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, can } from '../../platform/auth/actor.js';
import { forbidden } from '../../platform/errors.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { CAPA_ORIGINS, CAPA_SOURCES,
  addAction, advanceCapa, assignableUsers, cancelAction, cancelCapa, cancelNcr, closeNcr, completeAction, containNcr, holdLotsForNcr, createCapa, createNcr, dispositionNcr, getCapa, getNcr,
  linkNcrToCapa, listCapas, listNcrs, myActions, updateCapa, verifyCapa,
} from './service.js';
import { ATTACHMENT_MIME, PRESENTATION_MIME, addAttachment, attachmentFile, listAttachments } from './attachments.js';
import { addItem, capaForFinding, closeAudit, createAudit, getAudit, listAudits, recordItem, reportAudit, startAudit } from './audits.js';
import { getPlan, listCalibration, recordCalibration, savePlan } from './calibration.js';
import { capaForRow, createFmea, evaluateRow, getFmea, listFmeas, reviseFmea, saveRows, submitFmea } from './fmea.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { addReadAcross, addTeamMember, decideReadAcross, recognizeTeam, removeTeamMember } from './eight-d.js';
import { renderEightDPdf } from './eight-d-pdf.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const reason = z.object({ reason: z.string().min(3).max(2000) });
const text = z.string().max(4000).nullable().optional();

const SUBJECTS = ['nonconformance', 'corrective_action', 'safety_incident', 'calibration_record', 'quality_audit', 'fmea', 'continuity_plan', 'continuity_exercise', 'moc_change'] as const;

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
  app.post('/nonconformances/:id/hold-lots', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ lotIds: z.array(z.string().uuid()).min(1).max(200) }), req.body);
    await run(req, (tx, a) => holdLotsForNcr(tx, a, id, b.lotIds)); done(reply);
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
      source: z.enum(CAPA_SOURCES), priority: z.enum(['low', 'medium', 'high']).optional(), ownerUserId: uuid,
      dueDate: day.nullable().optional(), ncrIds: z.array(uuid).max(50).optional(), incidentId: uuid.nullable().optional(), format: z.enum(['standard', 'eight_d']).optional(),
      actionType: z.enum(['corrective', 'preventive']).optional(), originType: z.enum(CAPA_ORIGINS).nullable().optional(), originId: uuid.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createCapa(tx, a, b));
  });
  app.get('/corrective-actions/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getCapa(tx, a, id)); });
  app.patch('/corrective-actions/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ containment: z.string().max(4000).nullable().optional(), rootCauseMethod: z.enum(['five_whys', 'fishbone', 'eight_d', 'other']).nullable().optional(),
      rootCause: z.string().max(4000).nullable().optional(), verifyAfter: day.nullable().optional(), dueDate: day.nullable().optional(), priority: z.enum(['low', 'medium', 'high']).optional(),
      ownerUserId: uuid.optional(), format: z.enum(['standard', 'eight_d']).optional(), championUserId: uuid.nullable().optional(),
      isIsNot: z.record(z.enum(['what', 'where', 'when', 'extent']), z.object({ is: z.string().max(2000).nullable().optional(), isNot: z.string().max(2000).nullable().optional() })).nullable().optional(),
      containmentVerification: text, escapePoint: text, escapeRootCause: text, rootCauseVerification: text, preventionNote: text }), req.body);
    await run(req, (tx, a) => updateCapa(tx, a, id, b)); done(reply);
  });
  app.get('/corrective-actions/:id/8d.pdf', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const c = await run(req, (tx, a) => getCapa(tx, a, id));
    if (c.format !== 'eight_d') throw forbidden('an 8D report (this corrective action uses the standard format)');
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${c.number}-8D.pdf"`);
    return renderEightDPdf(c);
  });
  app.post('/corrective-actions/:id/team', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ userId: uuid, expertise: z.string().max(200).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => addTeamMember(tx, a, id, b));
  });
  app.delete('/corrective-actions/:id/team/:userId', async (req, reply) => {
    const p = parse(z.object({ id: uuid, userId: uuid }), req.params); await run(req, (tx, a) => removeTeamMember(tx, a, p.id, p.userId)); done(reply);
  });
  app.post('/corrective-actions/:id/read-across', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ scope: z.string().min(3).max(300) }), req.body);
    reply.status(201); return run(req, (tx, a) => addReadAcross(tx, a, id, b.scope));
  });
  app.post('/read-across/:id/decide', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ applies: z.boolean(), note: z.string().min(3).max(2000) }), req.body);
    await run(req, (tx, a) => decideReadAcross(tx, a, id, b)); done(reply);
  });
  app.post('/corrective-actions/:id/recognize', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().min(3).max(2000) }), req.body);
    await run(req, (tx, a) => recognizeTeam(tx, a, id, b.note)); done(reply);
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
      if (!['quality.view', 'safety.view', 'continuity.view', 'visits.conduct'].some((x) => can(a, x as any, q.facilityId))) throw forbidden('quality.view');
      return assignableUsers(tx, q.facilityId);
    });
  });
  app.get('/actions/mine', async (req) => run(req, (tx, a) => myActions(tx, a)));
  app.post('/actions', async (req, reply) => {
    const b = parse(z.object({ subjectType: z.enum(['corrective_action', 'safety_incident', 'quality_audit', 'fmea', 'continuity_plan', 'site_visit', 'improvement']), subjectId: uuid, title: z.string().min(3).max(500), ownerUserId: uuid, dueDate: day,
      auditItemId: uuid.nullable().optional(), fmeaRowId: uuid.nullable().optional(), continuityExerciseId: uuid.nullable().optional(), siteVisitItemId: uuid.nullable().optional(),
      discipline: z.enum(['containment', 'corrective', 'preventive']).nullable().optional() }), req.body);
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

  app.get('/fmeas', async (req) => run(req, (tx, a) => listFmeas(tx, a)));
  app.post('/fmeas', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, kind: z.enum(['process', 'design', 'equipment']), title: z.string().min(3).max(200), scope: z.string().min(3).max(2000),
      method: z.enum(['ap', 'rpn']).optional(), rpnThreshold: z.number().int().min(1).max(1000).nullable().optional(), assetId: uuid.nullable().optional(), partId: uuid.nullable().optional(),
      documentId: uuid.nullable().optional(), team: z.string().max(500).nullable().optional(), ownerUserId: uuid.optional(), reviewDue: day.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createFmea(tx, a, b));
  });
  app.get('/fmeas/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getFmea(tx, a, id)); });
  app.put('/fmeas/:id/rows', async (req) => {
    const { id } = parse(Id, req.params);
    const score = z.number().int().min(1).max(10);
    const b = parse(z.object({ rows: z.array(z.object({ item: z.string().min(1).max(500), failureMode: z.string().min(1).max(500), effect: z.string().min(1).max(1000), severity: score,
      cause: z.string().min(1).max(1000), occurrence: score, preventionControls: z.string().max(1000).nullable().optional(), detectionControls: z.string().max(1000).nullable().optional(),
      detection: score, failureCode: z.string().max(40).nullable().optional(), pmPlanId: uuid.nullable().optional() })).max(300) }), req.body);
    return run(req, (tx, a) => saveRows(tx, a, id, b.rows));
  });
  app.post('/fmeas/:id/submit', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => submitFmea(tx, a, id)); done(reply); });
  app.post('/fmeas/:id/revise', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(2000) }), req.body);
    reply.status(201);
    return run(req, (tx, a) => reviseFmea(tx, a, id, b.reason));
  });
  app.post('/fmea-rows/:id/evaluate', async (req) => {
    const { id } = parse(Id, req.params); const score = z.number().int().min(1).max(10);
    const b = parse(z.object({ severity: score, occurrence: score, detection: score }), req.body);
    return run(req, (tx, a) => evaluateRow(tx, a, id, b));
  });
  app.post('/fmea-rows/:id/capa', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ ownerUserId: uuid }), req.body);
    reply.status(201);
    return run(req, (tx, a) => capaForRow(tx, a, id, b));
  });

  app.get('/attachments', async (req) => {
    const q = parse(z.object({ subjectType: z.enum(SUBJECTS), subjectId: uuid }), req.query);
    return run(req, (tx, a) => listAttachments(tx, a, q.subjectType, q.subjectId));
  });
  app.post('/attachments', async (req, reply) => {
    const b = parse(z.object({ subjectType: z.enum(SUBJECTS), subjectId: uuid, fileName: z.string().min(1).max(255), mime: z.enum([...new Set([...ATTACHMENT_MIME, ...PRESENTATION_MIME])] as [string, ...string[]]),
      contentBase64: z.string().min(1), restricted: z.boolean().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addAttachment(tx, a, blobs, { ...b, content: Buffer.from(b.contentBase64, 'base64') }));
  });
  app.get('/attachments/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const f = await run(req, (tx, a) => attachmentFile(tx, a, blobs, id));
    // PDFs and images open in the browser; PowerPoint files download (browsers cannot show them).
    reply.header('content-type', f.mime).header('content-disposition', `${f.mime.includes('presentation') || f.mime.includes('powerpoint') ? 'attachment' : 'inline'}; filename="${f.name}"`);
    return f.content;
  });
};
