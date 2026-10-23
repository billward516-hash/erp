import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { createRehearsal, deleteRehearsal, getRehearsal } from './rehearsal.js';
import { createPlan, getPlan, myImplementationSteps, reopenStep, setDepth, setGoLiveDate, skipStep, startStep, updateStep, verifyStep } from './service.js';

const Key = z.object({ key: z.string().regex(/^[a-z_0-9]+$/).max(60) });
const Depth = z.enum(['guided', 'standard', 'full']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function implementationRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/implementation', async (req) => run(req, (tx, a) => getPlan(tx, a)));
  app.get('/implementation/mine', async (req) => run(req, (tx, a) => myImplementationSteps(tx, a)));
  app.post('/implementation', async (req, reply) => {
    const b = parse(z.object({ depth: Depth, targetGoLive: day.nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => createPlan(tx, a, b));
  });
  app.put('/implementation/depth', async (req) => { const b = parse(z.object({ depth: Depth }), req.body); return run(req, (tx, a) => setDepth(tx, a, b.depth)); });
  app.put('/implementation/go-live-date', async (req, reply) => { const b = parse(z.object({ date: day.nullable() }), req.body); await run(req, (tx, a) => setGoLiveDate(tx, a, b.date)); reply.status(204); });
  app.patch('/implementation/steps/:key', async (req) => {
    const { key } = parse(Key, req.params);
    const b = parse(z.object({ assigneeUserId: z.string().uuid().nullable().optional(), expectedCount: z.number().int().min(0).max(10_000_000).nullable().optional(), note: z.string().max(2000).nullable().optional() }), req.body);
    return run(req, (tx, a) => updateStep(tx, a, key, b));
  });
  app.post('/implementation/steps/:key/start', async (req) => { const { key } = parse(Key, req.params); const b = parse(z.object({ overrideReason: z.string().max(500).nullable().optional() }), req.body ?? {}); return run(req, (tx, a) => startStep(tx, a, key, b)); });
  app.post('/implementation/steps/:key/verify', async (req) => { const { key } = parse(Key, req.params); const b = parse(z.object({ note: z.string().max(2000).nullable().optional() }), req.body ?? {}); return run(req, (tx, a) => verifyStep(tx, a, key, b)); });
  app.post('/implementation/steps/:key/skip', async (req) => { const { key } = parse(Key, req.params); const b = parse(z.object({ reason: z.string().max(500) }), req.body); return run(req, (tx, a) => skipStep(tx, a, key, b.reason)); });
  app.post('/implementation/steps/:key/reopen', async (req) => { const { key } = parse(Key, req.params); return run(req, (tx, a) => reopenStep(tx, a, key)); });
  app.get('/implementation/rehearsal', async (req) => getRehearsal(actorOf(req)));
  app.post('/implementation/rehearsal', async (req, reply) => { const b = parse(z.object({ mode: z.enum(['blank', 'sample']) }), req.body); reply.status(201); return createRehearsal(actorOf(req), b); });
  app.delete('/implementation/rehearsal', async (req, reply) => { await deleteRehearsal(actorOf(req)); reply.status(204); });
}
