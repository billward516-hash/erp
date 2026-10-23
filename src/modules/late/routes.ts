import type { FastifyInstance } from 'fastify';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf } from '../../platform/http/helpers.js';
import { whatIsLate } from './service.js';

export async function lateRoutes(app: FastifyInstance) {
  app.get('/what-is-late', async (req) => asActor(actorOf(req), (tx) => whatIsLate(tx, actorOf(req))));
}
