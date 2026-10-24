import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { ATTACHMENT_MIME, addAttachment, listAttachments } from '../quality/attachments.js';
import { LOG_KINDS, addNote, logbook } from './logbook.js';
import {
  PROTOCOL_TYPES, addStep, attentionCounts, cancelProtocol, createProtocol, declareQualified, executeProtocol, getAssetQualification, getProtocol, getSettings, linkProtocolDocument, listProtocols, listQualification,
  recordResult, removeStep, saveSettings, setRequalifyAfterWork, switchOff, switchOn, unlinkProtocolDocument, updateProtocol,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const AssetId = z.object({ assetId: z.string().uuid() });
const uuid = z.string().uuid();
const interval = z.number().int().min(1).max(120).nullable();

/** Equipment qualification, protocols and the equipment logbook (SC-007 B). Everything lives under /api/qualification. */
export const qualificationRoutes = (blobs: BlobStore) => async (app: FastifyInstance) => {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));

  app.get('/qualification', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), state: z.enum(['not_qualified', 'qualified', 'requalification_due', 'requalification_required']).optional() }), req.query);
    return run(req, async (tx, a) => ({ tools: await listQualification(tx, a, q), counts: await attentionCounts(tx, a), settings: await getSettings(tx, a) }));
  });
  app.get('/qualification/settings', async (req) => run(req, (tx, a) => getSettings(tx, a)));
  app.put('/qualification/settings', async (req) => {
    const b = parse(z.object({ intervals: z.object({ IQ: interval.optional(), OQ: interval.optional(), PQ: interval.optional(), requalification: interval.optional() }).optional(), dueLeadDays: z.number().int().min(1).max(365).optional() }), req.body);
    return run(req, (tx, a) => saveSettings(tx, a, b));
  });

  // One tool: status, protocols, history, switches
  app.get('/qualification/assets/:assetId', async (req) => { const { assetId } = parse(AssetId, req.params); return run(req, (tx, a) => getAssetQualification(tx, a, assetId)); });
  app.post('/qualification/assets/:assetId/switch-on', async (req) => {
    const { assetId } = parse(AssetId, req.params); const b = parse(z.object({ requalifyAfterWork: z.boolean().optional() }), req.body ?? {});
    return run(req, (tx, a) => switchOn(tx, a, assetId, b));
  });
  app.post('/qualification/assets/:assetId/switch-off', async (req) => {
    const { assetId } = parse(AssetId, req.params); const b = parse(z.object({ reason: z.string().min(5).max(1000) }), req.body);
    return run(req, (tx, a) => switchOff(tx, a, assetId, b.reason));
  });
  app.patch('/qualification/assets/:assetId', async (req) => {
    const { assetId } = parse(AssetId, req.params); const b = parse(z.object({ requalifyAfterWork: z.boolean() }), req.body);
    return run(req, (tx, a) => setRequalifyAfterWork(tx, a, assetId, b.requalifyAfterWork));
  });
  app.post('/qualification/assets/:assetId/declare', async (req) => {
    const { assetId } = parse(AssetId, req.params);
    const b = parse(z.object({ qualifiedOn: z.string().date(), basis: z.string().min(10).max(2000), requalDueOn: z.string().date().nullable().optional() }), req.body);
    return run(req, (tx, a) => declareQualified(tx, a, assetId, b));
  });

  // The equipment logbook
  app.get('/qualification/assets/:assetId/logbook', async (req) => {
    const { assetId } = parse(AssetId, req.params);
    const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), order: z.enum(['asc', 'desc']).default('desc'), kind: z.enum(LOG_KINDS).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() }), req.query);
    return run(req, (tx, a) => logbook(tx, a, assetId, { from: q.from, to: q.to, order: q.order, kinds: q.kind ? [q.kind] : undefined, limit: q.limit }));
  });
  app.post('/qualification/assets/:assetId/notes', async (req, reply) => {
    const { assetId } = parse(AssetId, req.params); const b = parse(z.object({ body: z.string().min(1).max(4000) }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addNote(tx, a, assetId, b.body));
  });

  // Protocols
  app.get('/qualification/protocols', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), assetId: uuid.optional(), status: z.enum(['draft', 'executed', 'approved', 'failed']).optional(), open: z.enum(['true', 'false']).optional() }), req.query);
    return run(req, (tx, a) => listProtocols(tx, a, { ...q, open: q.open === 'true' }));
  });
  app.post('/qualification/protocols', async (req, reply) => {
    const b = parse(z.object({ assetId: uuid, protocolType: z.enum(PROTOCOL_TYPES), title: z.string().min(3).max(200), acceptanceCriteria: z.string().max(8000).optional(), intervalMonths: interval.optional(),
      approverUserId: uuid.nullable().optional(), steps: z.array(z.object({ step: z.string().min(1).max(2000), expected: z.string().max(2000).optional() })).max(200).optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createProtocol(tx, a, b));
  });
  app.get('/qualification/protocols/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getProtocol(tx, a, id)); });
  app.patch('/qualification/protocols/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ title: z.string().min(3).max(200).optional(), acceptanceCriteria: z.string().max(8000).optional(), intervalMonths: interval.optional(), approverUserId: uuid.nullable().optional() }), req.body);
    return run(req, (tx, a) => updateProtocol(tx, a, id, b));
  });
  app.post('/qualification/protocols/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body);
    await run(req, (tx, a) => cancelProtocol(tx, a, id, b.reason)); reply.status(204);
  });
  app.post('/qualification/protocols/:id/steps', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ step: z.string().min(1).max(2000), expected: z.string().max(2000).optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addStep(tx, a, id, b));
  });
  app.delete('/qualification/steps/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => removeStep(tx, a, id)); reply.status(204); });
  app.put('/qualification/steps/:id/result', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ actual: z.string().max(4000).nullable().optional(), outcome: z.enum(['pass', 'fail', 'na']), note: z.string().max(4000).nullable().optional() }), req.body);
    return run(req, (tx, a) => recordResult(tx, a, id, b));
  });
  app.post('/qualification/protocols/:id/documents', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ documentId: uuid, role: z.enum(['procedure', 'reference']).optional() }), req.body);
    await run(req, (tx, a) => linkProtocolDocument(tx, a, id, b.documentId, b.role)); reply.status(204);
  });
  app.delete('/qualification/protocols/:id/documents/:documentId', async (req, reply) => {
    const { id, documentId } = parse(z.object({ id: uuid, documentId: uuid }), req.params);
    await run(req, (tx, a) => unlinkProtocolDocument(tx, a, id, documentId)); reply.status(204);
  });
  app.post('/qualification/protocols/:id/execute', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ conclusion: z.string().min(5).max(4000) }), req.body);
    return run(req, (tx, a) => executeProtocol(tx, a, id, b.conclusion));
  });

  // Files on protocols and on result entries (the attachments mechanism; files open through /api/attachments/:id)
  const FileBody = z.object({ fileName: z.string().min(1).max(255), mime: z.enum(ATTACHMENT_MIME as [string, ...string[]]), contentBase64: z.string().min(1) });
  for (const [path, type] of [['protocols', 'qualification_protocol'], ['steps', 'qualification_result']] as const) {
    app.get(`/qualification/${path}/:id/files`, async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => listAttachments(tx, a, type, id)); });
    app.post(`/qualification/${path}/:id/files`, async (req, reply) => {
      const { id } = parse(Id, req.params); const b = parse(FileBody, req.body);
      reply.status(201);
      return run(req, (tx, a) => addAttachment(tx, a, blobs, { subjectType: type, subjectId: id, fileName: b.fileName, mime: b.mime, content: Buffer.from(b.contentBase64, 'base64') }));
    });
  }
};
