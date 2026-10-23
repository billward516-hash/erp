import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { listFeatures, setFeature } from './service.js';

export async function featureRoutes(app: FastifyInstance) {
  app.get('/features', async (req) => asActor(actorOf(req), (tx) => listFeatures(tx, actorOf(req))));
  app.put('/features/:key', async (req, reply) => {
    const { key } = parse(z.object({ key: z.string().max(40) }), req.params);
    const b = parse(z.object({ mode: z.enum(['all', 'roles', 'off']), roleKeys: z.array(z.string().max(60)).max(100).optional() }), req.body);
    await asActor(actorOf(req), (tx) => setFeature(tx, actorOf(req), key, b));
    reply.status(204);
  });
}
