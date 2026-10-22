import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  applyTemplate, cancelKit, createKit, getKit, issueKit, kitForWorkOrder, listAssetParts, listKits, listTemplates, partWhereUsed, refreshKit, removeAssetPart, returnAndClose,
  saveAssetPart, saveTemplate, stageKit,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();

export async function materialsRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/assets/:id/parts', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => listAssetParts(tx, a, id)); });
  app.put('/assets/:id/parts/:partId', async (req, reply) => {
    const p = parse(z.object({ id: uuid, partId: uuid }), req.params);
    const b = parse(z.object({ qtyInstalled: z.number().positive().optional(), position: z.string().max(200).nullable().optional(), critical: z.boolean().optional(),
      minOnHand: z.number().min(0).nullable().optional(), notes: z.string().max(1000).nullable().optional() }), req.body);
    await run(req, (tx, a) => saveAssetPart(tx, a, p.id, { ...b, partId: p.partId }));
    reply.status(204);
  });
  app.delete('/assets/:id/parts/:partId', async (req, reply) => {
    const p = parse(z.object({ id: uuid, partId: uuid }), req.params);
    await run(req, (tx, a) => removeAssetPart(tx, a, p.id, p.partId));
    reply.status(204);
  });
  app.get('/parts/:id/where-used', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => partWhereUsed(tx, a, id)); });

  app.get('/repair-templates', async (req) => { const q = parse(z.object({ assetId: uuid.optional() }), req.query); return run(req, (tx, a) => listTemplates(tx, a, q)); });
  app.post('/repair-templates', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), code: z.string().min(1).max(40), title: z.string().min(3).max(200), assetId: uuid.nullable().optional(), assetCategory: z.string().max(100).nullable().optional(),
      procedureDocumentId: uuid.nullable().optional(), estLaborHours: z.number().min(0).nullable().optional(), notes: z.string().max(2000).nullable().optional(),
      parts: z.array(z.object({ partId: uuid, qty: z.number().positive() })).max(200) }), req.body);
    return run(req, (tx, a) => saveTemplate(tx, a, b));
  });
  app.post('/work-orders/:id/apply-template', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ templateId: uuid }), req.body);
    return run(req, (tx, a) => applyTemplate(tx, a, id, b.templateId));
  });

  app.get('/kits', async (req) => { const q = parse(z.object({ facilityId: uuid.optional(), open: z.coerce.boolean().optional() }), req.query); return run(req, (tx, a) => listKits(tx, a, q)); });
  app.get('/work-orders/:id/kit', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => kitForWorkOrder(tx, a, id)); });
  app.post('/work-orders/:id/kit', async (req, reply) => { const { id } = parse(Id, req.params); reply.status(201); return run(req, (tx, a) => createKit(tx, a, id)); });
  app.get('/kits/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getKit(tx, a, id)); });
  app.post('/kits/:id/refresh', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => refreshKit(tx, a, id)); });
  app.post('/kits/:id/stage', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ stagingLocationId: uuid }), req.body);
    await run(req, (tx, a) => stageKit(tx, a, id, b.stagingLocationId)); reply.status(204);
  });
  app.post('/kits/:id/issue', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => issueKit(tx, a, id)); reply.status(204); });
  app.post('/kits/:id/close', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ returns: z.array(z.object({ kitLineId: uuid, qty: z.number().min(0) })).max(300) }), req.body);
    await run(req, (tx, a) => returnAndClose(tx, a, id, b.returns)); reply.status(204);
  });
  app.post('/kits/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body);
    await run(req, (tx, a) => cancelKit(tx, a, id, b.reason)); reply.status(204);
  });
}
