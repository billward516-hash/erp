import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  createRequestLink, grantRole, listGroups, listRequestLinks, listSites, listUserGrants, publicRequestForm, revokeGrant, revokeRequestLink, saveGroup, saveSite, SITE_KINDS,
  submitPublicRequest,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const address = z.object({ line1: z.string().max(200).nullable().optional(), line2: z.string().max(200).nullable().optional(), city: z.string().max(100).nullable().optional(),
  region: z.string().max(100).nullable().optional(), postal: z.string().max(20).nullable().optional(), country: z.string().max(60).nullable().optional() });
const site = z.object({ code: z.string().min(1).max(30), name: z.string().min(1).max(200), kind: z.enum(SITE_KINDS), timezone: z.string().max(60).optional(), address: address.optional(), active: z.boolean().optional() });

export async function sitesRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/sites', async (req) => {
    const q = parse(z.object({ kind: z.enum(SITE_KINDS).optional(), groupId: uuid.optional(), q: z.string().max(100).optional() }), req.query);
    return run(req, (tx, a) => listSites(tx, a, { kind: q.kind, groupId: q.groupId, search: q.q }));
  });
  app.post('/sites', async (req, reply) => { const b = parse(site, req.body); reply.status(201); return run(req, (tx, a) => saveSite(tx, a, b)); });
  app.put('/sites/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(site, req.body); return run(req, (tx, a) => saveSite(tx, a, { ...b, id })); });
  app.get('/site-groups', async (req) => run(req, (tx, a) => listGroups(tx, a)));
  const group = z.object({ code: z.string().min(1).max(30), name: z.string().min(1).max(200), kind: z.enum(['portfolio', 'region', 'district', 'other']), facilityIds: z.array(uuid).max(5000) });
  app.post('/site-groups', async (req, reply) => { const b = parse(group, req.body); reply.status(201); return run(req, (tx, a) => saveGroup(tx, a, b)); });
  app.put('/site-groups/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(group, req.body); return run(req, (tx, a) => saveGroup(tx, a, { ...b, id })); });
  app.get('/user-grants', async (req) => run(req, (tx, a) => listUserGrants(tx, a)));
  app.post('/user-grants', async (req, reply) => {
    const b = parse(z.object({ userId: uuid, roleKey: z.string().min(1).max(60), facilityId: uuid.nullable().optional(), groupId: uuid.nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => grantRole(tx, a, b));
  });
  app.delete('/user-grants/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => revokeGrant(tx, a, id)); reply.status(204); });
  app.get('/sites/:id/request-links', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => listRequestLinks(tx, a, id)); });
  app.post('/sites/:id/request-links', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ label: z.string().min(1).max(200) }), req.body);
    reply.status(201); return run(req, (tx, a) => createRequestLink(tx, a, id, b.label));
  });
  app.post('/request-links/:id/revoke', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => revokeRequestLink(tx, a, id)); reply.status(204); });
}

/** No sign-in: the link token is the only credential and opens only its own site's request form. */
export async function publicRoutes(app: FastifyInstance) {
  const Token = z.object({ token: z.string().min(10).max(100) });
  app.get('/public/requests/:token', async (req) => { const { token } = parse(Token, req.params); return publicRequestForm(token); });
  app.post('/public/requests/:token', async (req, reply) => {
    const { token } = parse(Token, req.params);
    const b = parse(z.object({ placeId: uuid, description: z.string().min(5).max(4000), name: z.string().min(1).max(200), contact: z.string().min(3).max(200),
      entryPermission: z.boolean().optional(), urgent: z.boolean().optional() }), req.body);
    reply.status(201);
    return submitPublicRequest(token, b);
  });
}
