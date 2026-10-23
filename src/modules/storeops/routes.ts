import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { completeVisit, getVisit, listPoints, listTemplates, listVisits, pointReadings, recordReading, recordVisitItem, saveConditionPoint, saveTemplate, startVisit } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();

export async function storeOpsRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/condition-points', async (req) => { const q = parse(z.object({ facilityId: uuid.optional(), assetId: uuid.optional() }), req.query); return run(req, (tx, a) => listPoints(tx, a, q)); });
  app.put('/condition-points', async (req) => {
    const b = parse(z.object({ assetId: uuid, measure: z.string().min(1).max(40).optional(), unit: z.string().min(1).max(10), low: z.number().nullable().optional(), high: z.number().nullable().optional(),
      intervalHours: z.number().int().positive().max(24 * 31).nullable().optional(), active: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => saveConditionPoint(tx, a, b));
  });
  app.get('/condition-points/:id/readings', async (req) => {
    const { id } = parse(Id, req.params); const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(14) }), req.query);
    return run(req, (tx, a) => pointReadings(tx, a, id, q.days));
  });
  app.post('/condition-points/:id/readings', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ value: z.number().min(-1000).max(100000), readAt: z.coerce.date().optional(), note: z.string().max(1000).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => recordReading(tx, a, id, b));
  });
  app.get('/visit-templates', async (req) => run(req, (tx, a) => listTemplates(tx, a)));
  const tpl = z.object({ code: z.string().min(1).max(40), name: z.string().min(1).max(200), items: z.array(z.object({ area: z.string().max(100).nullable().optional(), text: z.string().min(1).max(500), critical: z.boolean().optional() })).min(1).max(200), active: z.boolean().optional() });
  app.post('/visit-templates', async (req, reply) => { const b = parse(tpl, req.body); reply.status(201); return run(req, (tx, a) => saveTemplate(tx, a, b)); });
  app.put('/visit-templates/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(tpl, req.body); return run(req, (tx, a) => saveTemplate(tx, a, { ...b, id })); });
  app.get('/site-visits', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listVisits(tx, a, q)); });
  app.post('/site-visits', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, templateId: uuid, visitedOn: z.string().date().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => startVisit(tx, a, b));
  });
  app.get('/site-visits/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getVisit(tx, a, id)); });
  app.post('/site-visit-items/:id', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ result: z.enum(['pass', 'fail', 'na']), note: z.string().max(2000).nullable().optional(), assetId: uuid.nullable().optional() }), req.body);
    await run(req, (tx, a) => recordVisitItem(tx, a, id, b)); reply.status(204);
  });
  app.post('/site-visits/:id/complete', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ summary: z.string().max(4000).nullable().optional(), actionOwnerUserId: uuid.nullable().optional(), actionDueDays: z.number().int().min(1).max(90).optional() }), req.body);
    return run(req, (tx, a) => completeVisit(tx, a, id, b));
  });
}
