import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { capaDashboard } from './dashboard.js';

export async function capaRoutes(app: FastifyInstance) {
  app.get('/capa-dashboard', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional() }), req.query);
    return asActor(actorOf(req), (tx) => capaDashboard(tx, actorOf(req), q));
  });
}
