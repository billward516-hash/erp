import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { deleteDraft, listDrafts, saveDraft } from './service.js';

const Key = z.object({ key: z.string().min(1).max(300) });

export async function draftRoutes(app: FastifyInstance) {
  app.get('/drafts', async (req) => {
    const q = parse(z.object({ path: z.string().max(300).optional() }), req.query);
    return asActor(actorOf(req), (tx) => listDrafts(tx, actorOf(req), q));
  });
  app.put('/drafts/:key', async (req) => {
    const { key } = parse(Key, req.params);
    const b = parse(z.object({ path: z.string().min(1).max(300), label: z.string().max(200).nullable().optional(), data: z.unknown() }), req.body);
    return asActor(actorOf(req), (tx) => saveDraft(tx, actorOf(req), key, { ...b, data: b.data ?? null }));
  });
  app.delete('/drafts/:key', async (req, reply) => {
    const { key } = parse(Key, req.params);
    await asActor(actorOf(req), (tx) => deleteDraft(tx, actorOf(req), key));
    reply.status(204);
  });
}
