import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { listReviews, listReviewSettings, recordReview, reviewHistory, setRecordInterval, setReviewSetting } from './service.js';

const Subject = z.object({ type: z.string().max(40), id: z.string().uuid() });

export async function reviewRoutes(app: FastifyInstance) {
  app.get('/reviews', async (req) => {
    const q = parse(z.object({ status: z.enum(['due', 'all']).optional(), type: z.string().max(40).optional() }), req.query);
    return asActor(actorOf(req), (tx) => listReviews(tx, actorOf(req), q));
  });
  app.get('/reviews/:type/:id/history', async (req) => { const { type, id } = parse(Subject, req.params); return asActor(actorOf(req), (tx) => reviewHistory(tx, type, id)); });
  app.post('/reviews/:type/:id', async (req) => {
    const { type, id } = parse(Subject, req.params);
    const b = parse(z.object({ outcome: z.enum(['no_change', 'changes_needed']), note: z.string().max(4000).nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => recordReview(tx, actorOf(req), type, id, b));
  });
  app.put('/reviews/:type/:id/interval', async (req, reply) => {
    const { type, id } = parse(Subject, req.params);
    const b = parse(z.object({ months: z.number().int().nullable() }), req.body);
    await asActor(actorOf(req), (tx) => setRecordInterval(tx, actorOf(req), type, id, b.months));
    reply.status(204);
  });
  app.get('/review-settings', async (req) => asActor(actorOf(req), (tx) => listReviewSettings(tx, actorOf(req))));
  app.put('/review-settings/:key', async (req, reply) => {
    const { key } = parse(z.object({ key: z.string().max(40) }), req.params);
    const b = parse(z.object({ enabled: z.boolean(), months: z.number().int(), leadDays: z.number().int(), repeat: z.enum(['daily', 'weekly', 'once']), escalateDays: z.number().int() }), req.body);
    await asActor(actorOf(req), (tx) => setReviewSetting(tx, actorOf(req), key, b));
    reply.status(204);
  });
}
