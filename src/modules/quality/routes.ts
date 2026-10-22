import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, can } from '../../platform/auth/actor.js';
import { forbidden } from '../../platform/errors.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  addAction, advanceCapa, assignableUsers, cancelAction, cancelCapa, cancelNcr, closeNcr, completeAction, containNcr, createCapa, createNcr, dispositionNcr, getCapa, getNcr,
  linkNcrToCapa, listCapas, listNcrs, myActions, updateCapa, verifyCapa,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const reason = z.object({ reason: z.string().min(3).max(2000) });

export async function qualityRoutes(app: FastifyInstance) {
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
    const b = parse(z.object({ subjectType: z.enum(['corrective_action', 'safety_incident']), subjectId: uuid, title: z.string().min(3).max(500), ownerUserId: uuid, dueDate: day }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addAction(tx, a, b));
  });
  app.post('/actions/:id/complete', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().min(3).max(4000) }), req.body);
    await run(req, (tx, a) => completeAction(tx, a, id, b.note)); done(reply);
  });
  app.post('/actions/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(reason, req.body); await run(req, (tx, a) => cancelAction(tx, a, id, b.reason)); done(reply); });
}
