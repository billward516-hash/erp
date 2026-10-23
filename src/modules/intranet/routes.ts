import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { deleteQuickLink, directory, listAnnouncements, listQuickLinks, postAnnouncement, saveQuickLink, search, upcoming, withdrawAnnouncement } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const day = z.string().date();

export async function intranetRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/announcements', async (req) => { const q = parse(z.object({ all: qbool.optional() }), req.query); return run(req, (tx, a) => listAnnouncements(tx, a, q)); });
  app.get('/announcements/upcoming', async (req) => run(req, (tx, a) => upcoming(tx, a)));
  app.post('/announcements', async (req, reply) => {
    const b = parse(z.object({ title: z.string().min(3).max(200), body: z.string().min(1).max(20_000), kind: z.enum(['news', 'event', 'safety', 'people', 'it']).optional(),
      facilityId: z.string().uuid().nullable().optional(), eventOn: day.nullable().optional(), pinned: z.boolean().optional(), expiresOn: day.nullable().optional(), notifyEveryone: z.boolean().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => postAnnouncement(tx, a, b));
  });
  app.post('/announcements/:id/withdraw', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => withdrawAnnouncement(tx, a, id)); reply.status(204); });
  app.get('/quick-links', async (req) => run(req, (tx) => listQuickLinks(tx)));
  app.post('/quick-links', async (req) => {
    const b = parse(z.object({ id: z.string().uuid().optional(), title: z.string().min(2).max(60), url: z.string().min(1).max(500), description: z.string().max(200).nullable().optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional() }), req.body);
    return run(req, (tx, a) => saveQuickLink(tx, a, b));
  });
  app.delete('/quick-links/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteQuickLink(tx, a, id)); reply.status(204); });
  app.get('/directory', async (req) => { const q = parse(z.object({ search: z.string().max(100).optional(), site: z.string().max(20).optional() }), req.query); return run(req, (tx) => directory(tx, q)); });
  app.get('/search', async (req) => { const q = parse(z.object({ q: z.string().max(100) }), req.query); return run(req, (tx, a) => search(tx, a, q.q)); });
}
