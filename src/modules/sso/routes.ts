import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { finishSignIn, signOut, startSignIn } from '../../platform/auth/sso.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { getSso, saveSso } from './service.js';

/**
 * Sign-in routes live outside /api (no bearer token yet). The session token reaches the web app in the URL fragment
 * of /signed-in, which browsers do not send to servers or put in referrers; errors arrive the same way.
 */
export async function ssoRoutes(app: FastifyInstance) {
  const fail = (err: unknown) => `/signed-in#error=${encodeURIComponent((err as Error).message)}`;
  app.get('/auth/sso/start', async (req, reply) => {
    const q = req.query as { email?: string; company?: string; returnTo?: string };
    try { return reply.redirect(await startSignIn(q)); } catch (e) { return reply.redirect(fail(e)); }
  });
  app.get('/auth/sso/callback', async (req, reply) => {
    try {
      const r = await finishSignIn(req.query as Record<string, string>);
      req.log.info({ tenantId: r.tenantId, userId: r.userId, linkedBy: r.linkedBy }, 'sso sign-in');
      return reply.redirect(`/signed-in#token=${encodeURIComponent(r.token)}&next=${encodeURIComponent(r.returnTo)}`);
    } catch (e) { return reply.redirect(fail(e)); }
  });

  app.post('/api/session/sign-out', async (req, reply) => {
    const token = req.headers.authorization!.slice(7).trim();
    await signOut(token);
    return reply.status(204).send();
  });
  app.get('/api/sso', async (req) => asActor(actorOf(req), (tx) => getSso(tx, actorOf(req))));
  app.put('/api/sso', async (req) => {
    const b = parse(z.object({ issuer: z.string().url().max(300), clientId: z.string().min(1).max(300), clientSecret: z.string().max(500).nullable().optional(),
      emailDomains: z.array(z.string().max(100)).max(20), linkByEmail: z.boolean().optional(), enabled: z.boolean(), allowTokens: z.boolean().optional() }), req.body);
    return asActor(actorOf(req), (tx) => saveSso(tx, actorOf(req), b));
  });
}
