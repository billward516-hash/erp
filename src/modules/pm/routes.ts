import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { createPlan, generatePmWorkOrders, getPlan, pmSchedule, recordMeter, setPlanActive } from './service.js';

const Id = z.object({ id: z.string().uuid() });

export async function pmRoutes(app: FastifyInstance) {
  app.get('/pm', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional(), assetId: z.string().uuid().optional(), horizonDays: z.coerce.number().int().min(1).max(730).optional() }), req.query);
    return asActor(actorOf(req), (tx) => pmSchedule(tx, actorOf(req), q));
  });
  app.post('/pm', async (req, reply) => {
    const b = parse(z.object({
      assetId: z.string().uuid(), code: z.string().min(1).max(40), title: z.string().min(3).max(200), instructions: z.string().max(10000).nullable().optional(),
      triggerType: z.enum(['calendar', 'meter']), intervalDays: z.number().int().positive().max(3650).nullable().optional(), meter: z.string().max(40).nullable().optional(),
      intervalMeter: z.number().positive().nullable().optional(), scheduleBasis: z.enum(['completion', 'fixed']).optional(), leadDays: z.number().int().min(0).max(365).optional(),
      leadMeter: z.number().min(0).optional(), firstDueOn: z.string().date().nullable().optional(), firstDueMeter: z.number().nonnegative().nullable().optional(),
      estimatedHours: z.number().positive().max(1000).nullable().optional(), priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
      documentId: z.string().uuid().nullable().optional(), parts: z.array(z.object({ partId: z.string().uuid(), qty: z.number().positive() })).max(100).optional(),
    }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createPlan(tx, actorOf(req), b));
  });
  app.get('/pm/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getPlan(tx, actorOf(req), id)); });
  app.post('/pm/:id/active', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ active: z.boolean(), reason: z.string().min(5).max(500) }), req.body);
    await asActor(actorOf(req), (tx) => setPlanActive(tx, actorOf(req), id, b.active, b.reason));
    reply.status(204);
  });
  app.post('/pm/generate', async (req) => {
    const b = parse(z.object({ facilityId: z.string().uuid().optional() }), req.body ?? {});
    return asActor(actorOf(req), (tx) => generatePmWorkOrders(tx, actorOf(req), b));
  });
  app.post('/assets/:id/meters', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ meter: z.string().min(1).max(40), value: z.number().nonnegative(), readAt: z.coerce.date().optional() }), req.body);
    await asActor(actorOf(req), (tx) => recordMeter(tx, actorOf(req), id, b));
    reply.status(201);
    return { ok: true };
  });
}
