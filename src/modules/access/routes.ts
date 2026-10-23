import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { AppError } from '../../platform/errors.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { createUser, deleteCustomRole, issueToken, linkSso, listAccess, listRoles, listTokens, revokeToken, saveCustomRole, setUserStatus, unlinkSso, updateUser } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();

/**
 * People and access (D-183A). Three API areas, all tenant-administrator only: admin-users (also in Lite),
 * admin-tokens (also in Lite) and admin-roles (Standard only: Lite has the starter roles). Granting and removing roles
 * stays on /api/user-grants.
 */
export async function accessRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));

  app.get('/admin-users', async (req) => run(req, (tx, a) => listAccess(tx, a)));
  app.post('/admin-users', async (req, reply) => {
    const b = parse(z.object({ displayName: z.string().min(1).max(200), email: z.string().min(3).max(200), employeeId: uuid.nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => createUser(tx, a, b));
  });
  app.patch('/admin-users/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ displayName: z.string().min(1).max(200).optional(), employeeId: uuid.nullable().optional() }), req.body);
    await run(req, (tx, a) => updateUser(tx, a, id, b)); reply.status(204);
  });
  app.post('/admin-users/:id/disable', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => setUserStatus(tx, a, id, 'disabled')); });
  app.post('/admin-users/:id/enable', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => setUserStatus(tx, a, id, 'active')); });
  app.post('/admin-users/:id/sso-link', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ issuer: z.string().url().max(300).optional(), subject: z.string().min(1).max(300) }), req.body);
    await run(req, (tx, a) => linkSso(tx, a, id, b)); reply.status(204);
  });
  app.post('/admin-users/:id/sso-unlink', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => unlinkSso(tx, a, id)); reply.status(204); });

  app.get('/admin-roles', async (req) => run(req, (tx, a) => listRoles(tx, a)));
  const role = z.object({ name: z.string().min(2).max(60), description: z.string().max(300).nullable().optional(), permissions: z.array(z.string().max(60)).max(300) });
  app.post('/admin-roles', async (req, reply) => { const b = parse(role, req.body); reply.status(201); return run(req, (tx, a) => saveCustomRole(tx, a, b)); });
  app.put('/admin-roles/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(role, req.body); return run(req, (tx, a) => saveCustomRole(tx, a, { ...b, id })); });
  app.delete('/admin-roles/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteCustomRole(tx, a, id)); reply.status(204); });

  app.get('/admin-tokens', async (req) => {
    const q = parse(z.object({ all: qbool.optional() }), req.query);
    return run(req, (tx, a) => listTokens(tx, a, { includeInactive: !!q.all }));
  });
  app.post('/admin-tokens', async (req, reply) => {
    // A replayed response would keep the token in the idempotency store; the token is shown once and never stored in the clear.
    if (req.headers['idempotency-key']) throw new AppError(400, 'bad_request', 'token issuance cannot be repeated with an Idempotency-Key: the response holds the only copy of the token');
    const b = parse(z.object({ userId: uuid, label: z.string().min(1).max(100), expiresInDays: z.number().int().min(1).max(3660).nullable().optional(), expiresAt: z.string().datetime().nullable().optional() }), req.body);
    reply.status(201).header('cache-control', 'no-store');
    return run(req, (tx, a) => issueToken(tx, a, b));
  });
  app.post('/admin-tokens/:id/revoke', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => revokeToken(tx, a, id)); reply.status(204); });
}
