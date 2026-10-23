import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { decide, getImprovement, listImprovements, markImplemented, measureResult, planImprovement, setBaseline, submitIdea, validateSavings } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CATEGORIES = ['safety', 'quality', 'cost', 'delivery', 'maintenance', 'energy', 'workplace', 'other'] as const;

export async function improveRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/improvements', async (req) => { const q = parse(z.object({ facilityId: uuid.optional(), stage: z.string().max(20).optional() }), req.query); return run(req, (tx, a) => listImprovements(tx, a, q)); });
  app.post('/improvements', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, title: z.string().min(1).max(200), problem: z.string().min(1).max(5000), idea: z.string().max(5000).nullable().optional(), category: z.enum(CATEGORIES),
      assetId: uuid.nullable().optional(), workCenterId: uuid.nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => submitIdea(tx, a, b));
  });
  app.get('/improvements/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getImprovement(tx, a, id)); });
  app.post('/improvements/:id/decide', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ approve: z.boolean(), ownerUserId: uuid.nullable().optional(), note: z.string().max(2000).nullable().optional() }), req.body);
    await run(req, (tx, a) => decide(tx, a, id, b)); reply.status(204);
  });
  app.put('/improvements/:id/plan', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ metricKind: z.enum(['manual', 'asset_unplanned_downtime', 'work_center_scrap_rate']).optional(), metricName: z.string().max(100).nullable().optional(),
      metricUnit: z.string().max(30).nullable().optional(), lowerIsBetter: z.boolean().optional(), targetValue: z.number().nullable().optional(), estAnnualSavings: z.number().min(0).nullable().optional(),
      oneTimeCost: z.number().min(0).nullable().optional(), assetId: uuid.nullable().optional(), workCenterId: uuid.nullable().optional() }), req.body);
    await run(req, (tx, a) => planImprovement(tx, a, id, b)); reply.status(204);
  });
  app.post('/improvements/:id/baseline', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ from: date.optional(), to: date.optional(), value: z.number().nullable().optional() }), req.body); return run(req, (tx, a) => setBaseline(tx, a, id, b)); });
  app.post('/improvements/:id/implemented', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ implementedOn: date.optional() }), req.body); await run(req, (tx, a) => markImplemented(tx, a, id, b)); reply.status(204); });
  app.post('/improvements/:id/result', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ value: z.number().nullable().optional() }), req.body); return run(req, (tx, a) => measureResult(tx, a, id, b)); });
  app.post('/improvements/:id/validate', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ amount: z.number().min(0).max(1e9), note: z.string().min(1).max(2000) }), req.body); await run(req, (tx, a) => validateSavings(tx, a, id, b)); reply.status(204); });
}
