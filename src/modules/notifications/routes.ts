import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { getPreferences, listMine, markRead, setPreferences, unreadCount } from './service.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/notifications', async (req) => {
    const q = parse(z.object({ unreadOnly: qbool.optional(), limit: z.coerce.number().int().positive().optional() }), req.query);
    return asActor(actorOf(req), (tx) => listMine(tx, actorOf(req), q));
  });
  app.get('/notifications/unread-count', async (req) => asActor(actorOf(req), async (tx) => ({ count: await unreadCount(tx, actorOf(req)) })));
  app.post('/notifications/read', async (req) => {
    const b = parse(z.object({ ids: z.union([z.array(z.number().int().positive()).max(500), z.literal('all')]) }), req.body);
    return asActor(actorOf(req), async (tx) => ({ marked: await markRead(tx, actorOf(req), b.ids) }));
  });
  app.get('/notification-preferences', async (req) => asActor(actorOf(req), (tx) => getPreferences(tx, actorOf(req))));
  app.put('/notification-preferences', async (req) => {
    const b = parse(z.object({ emailDigest: z.boolean().optional(), mutedKinds: z.array(z.string().max(60)).max(50).optional() }), req.body);
    return asActor(actorOf(req), (tx) => setPreferences(tx, actorOf(req), b));
  });
}
