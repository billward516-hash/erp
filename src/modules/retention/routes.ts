import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { getRetention, setRetention } from './service.js';

export async function retentionRoutes(app: FastifyInstance) {
  app.get('/retention', async (req) => asActor(actorOf(req), (tx) => getRetention(tx, actorOf(req))));
  app.put('/retention/:category', async (req, reply) => {
    const { category } = parse(z.object({ category: z.string().max(40) }), req.params);
    const { days } = parse(z.object({ days: z.number().int() }), req.body);
    await asActor(actorOf(req), (tx) => setRetention(tx, actorOf(req), category, days));
    reply.status(204);
  });
}
