import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { acknowledge, getHandover, handOver, listHandovers, saveHandover, startHandover } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const item = z.object({ id: uuid.optional(), category: z.enum(['equipment', 'quality', 'safety', 'production', 'people', 'other']), text: z.string().min(1).max(2000),
  assetId: uuid.nullable().optional(), workOrderId: uuid.nullable().optional(), resolved: z.boolean().optional(), resolvedNote: z.string().max(2000).nullable().optional() });

export async function shiftRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/shift-logs', async (req) => { const q = parse(z.object({ facilityId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query); return run(req, (tx, a) => listHandovers(tx, a, q)); });
  app.post('/shift-logs', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, area: z.string().max(100).nullable().optional(), shiftLabel: z.string().min(1).max(40).optional(),
      periodStart: z.coerce.date().optional(), periodEnd: z.coerce.date().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => startHandover(tx, a, b));
  });
  app.get('/shift-logs/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getHandover(tx, a, id)); });
  app.put('/shift-logs/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ notes: z.string().max(10000).nullable().optional(), safetyNotes: z.string().max(5000).nullable().optional(), items: z.array(item).max(100).optional() }), req.body);
    await run(req, (tx, a) => saveHandover(tx, a, id, b)); reply.status(204);
  });
  app.post('/shift-logs/:id/hand-over', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => handOver(tx, a, id)); reply.status(204); });
  app.post('/shift-logs/:id/acknowledge', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().max(2000).nullable().optional() }), req.body);
    await run(req, (tx, a) => acknowledge(tx, a, id, b.note)); reply.status(204);
  });
}
