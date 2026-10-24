import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { cancelPlan, changeAmount, createPlan, generateNow, getPlan, listPlans, pausePlan, renewPlan, resumePlan, updatePlan } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();

export function retainerRoutes(blobs: BlobStore) {
  return async (app: FastifyInstance) => {
    app.get('/retainer-plans', async (req) => {
      const q = parse(z.object({ customerId: uuid.optional(), projectId: uuid.optional(), status: z.enum(['active', 'paused', 'cancelled']).optional() }), req.query);
      return asActor(actorOf(req), (tx) => listPlans(tx, actorOf(req), q));
    });
    app.post('/retainer-plans', async (req, reply) => {
      const b = parse(z.object({ facilityId: uuid.nullable().optional(), customerId: uuid, projectId: uuid.nullable().optional(), description: z.string().min(1).max(300), amount: z.number().positive().max(10_000_000),
        interval: z.enum(['month', 'quarter', 'year']), startDate: day, endDate: day.nullable().optional(), autoRenew: z.boolean().optional(), renewalTermMonths: z.number().int().min(1).max(60).optional(),
        noticeDays: z.number().int().min(0).max(365).optional(), prorate: z.boolean().optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => createPlan(tx, actorOf(req), b));
    });
    app.get('/retainer-plans/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getPlan(tx, actorOf(req), id)); });
    app.patch('/retainer-plans/:id', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ description: z.string().min(1).max(300).optional(), noticeDays: z.number().int().min(0).max(365).optional(), autoRenew: z.boolean().optional(),
        renewalTermMonths: z.number().int().min(1).max(60).optional(), prorate: z.boolean().optional() }), req.body);
      await asActor(actorOf(req), (tx) => updatePlan(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/retainer-plans/:id/pause', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ from: day.optional(), reason: z.string().max(500).nullable().optional() }), req.body ?? {});
      await asActor(actorOf(req), (tx) => pausePlan(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/retainer-plans/:id/resume', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ on: day.optional() }), req.body ?? {});
      await asActor(actorOf(req), (tx) => resumePlan(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/retainer-plans/:id/amount', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ effectiveFrom: day, amount: z.number().positive().max(10_000_000), reason: z.string().max(500).nullable().optional() }), req.body);
      await asActor(actorOf(req), (tx) => changeAmount(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/retainer-plans/:id/cancel', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ effectiveOn: day, reason: z.string().min(3).max(500) }), req.body);
      await asActor(actorOf(req), (tx) => cancelPlan(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/retainer-plans/:id/renew', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ endDate: day.optional(), months: z.number().int().min(1).max(60).optional() }), req.body ?? {});
      return asActor(actorOf(req), (tx) => renewPlan(tx, actorOf(req), id, b));
    });
    app.post('/retainer-plans/:id/generate', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ periodStart: day.optional() }), req.body ?? {});
      reply.status(201);
      return asActor(actorOf(req), (tx) => generateNow(tx, actorOf(req), blobs, id, b));
    });
  };
}
