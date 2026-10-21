import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, scopeOf } from '../../platform/auth/actor.js';
import { verifyAuditChain } from '../../platform/audit/audit.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { many, withTx } from '../../platform/db/tx.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { createEmployee, listEmployees, listFacilities } from './service.js';
import { createPart, listParts } from '../parts/service.js';

const EmployeeBody = z.object({
  facilityId: z.string().uuid().nullable().optional(), employeeNumber: z.string().min(1).max(64), firstName: z.string().min(1),
  lastName: z.string().min(1), jobTitle: z.string().nullable().optional(), email: z.string().email().nullable().optional(),
  hireDate: z.string().date().nullable().optional(),
});
const PartBody = z.object({
  partNumber: z.string().min(1).max(64), description: z.string().min(1), uom: z.string().max(16).optional(),
  manufacturer: z.string().nullable().optional(), manufacturerPartNumber: z.string().nullable().optional(),
  unitCost: z.number().nonnegative().nullable().optional(),
});

export async function orgRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const a = actorOf(req);
    return { userId: a.userId, tenantId: a.tenantId, displayName: a.displayName, employeeId: a.employeeId,
      grants: a.grants.map((g) => ({ facilityId: g.facilityId, permissions: [...g.permissions].sort() })) };
  });
  app.get('/facilities', async (req) => asActor(actorOf(req), (tx) => listFacilities(tx, actorOf(req))));
  // Directory of active users (names only), e.g. to choose an approval delegate.
  app.get('/users', async (req) => asActor(actorOf(req), (tx) => many(tx, `SELECT id, display_name FROM app_user WHERE status = 'active' ORDER BY display_name`)));
  app.get('/employees', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional() }), req.query);
    return asActor(actorOf(req), (tx) => listEmployees(tx, actorOf(req), q));
  });
  app.post('/employees', async (req, reply) => {
    const body = parse(EmployeeBody, req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createEmployee(tx, actorOf(req), body));
  });
  app.get('/parts', async (req) => {
    const q = parse(z.object({ q: z.string().optional(), limit: z.coerce.number().int().positive().optional() }), req.query);
    return asActor(actorOf(req), (tx) => listParts(tx, actorOf(req), q));
  });
  app.post('/parts', async (req, reply) => {
    const body = parse(PartBody, req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createPart(tx, actorOf(req), body));
  });
  app.get('/audit/verify', async (req) => {
    const a = actorOf(req);
    requirePermission(a, 'audit.view');
    const bad = await withTx(scopeOf(a), verifyAuditChain);
    return { intact: bad === null, firstInvalidEventId: bad };
  });
}
