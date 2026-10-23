import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hiddenNav } from '../../platform/features.js';
import { asActor, scopeOf } from '../../platform/auth/actor.js';
import { verifyAuditChain } from '../../platform/audit/audit.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { many, one, withTx } from '../../platform/db/tx.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { createEmployee, listEmployees, listFacilities } from './service.js';
import { createPart, deletePartUnit, listPartUnits, listParts, setPartUnit } from '../parts/service.js';
import { canEditAnyReminder } from '../reminders/settings.js';

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
    const { tenant, ed, remindersEditable, implementationSteps } = await asActor(a, async (tx) => ({ tenant: await one(tx, 'SELECT name FROM tenant WHERE id = $1', [a.tenantId]), ed: await one(tx, 'SELECT * FROM tenant_edition()'),
      remindersEditable: await canEditAnyReminder(tx, a),
      implementationSteps: Number((await one(tx, `SELECT count(*) AS n FROM implementation_step WHERE assignee_user_id = $1 AND status NOT IN ('verified', 'skipped')`, [a.userId]))?.n ?? 0) }));
    return { userId: a.userId, tenantId: a.tenantId, tenantName: tenant?.name ?? null, displayName: a.displayName, employeeId: a.employeeId,
      edition: ed?.edition ?? 'standard', limits: { users: ed?.user_cap ?? null, sites: ed?.site_cap ?? null, usersActive: ed?.users_active ?? 0, sitesActive: ed?.sites_active ?? 0 },
      grants: a.grants.map((g) => ({ facilityId: g.facilityId, permissions: [...g.permissions].sort() })),
      hiddenFeatures: a.hiddenFeatures ?? [], hiddenNav: hiddenNav(a.hiddenFeatures ?? []), remindersEditable, implementationSteps };
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
  app.get('/parts/:id/units', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return asActor(actorOf(req), (tx) => listPartUnits(tx, actorOf(req), id));
  });
  app.put('/parts/:id/units/:uom', async (req, reply) => {
    const p = parse(z.object({ id: z.string().uuid(), uom: z.string().min(1).max(10) }), req.params);
    const b = parse(z.object({ perUnit: z.number().positive().max(1e6) }), req.body);
    await asActor(actorOf(req), (tx) => setPartUnit(tx, actorOf(req), p.id, { uom: p.uom, perUnit: b.perUnit }));
    reply.status(204);
  });
  app.delete('/parts/:id/units/:uom', async (req, reply) => {
    const p = parse(z.object({ id: z.string().uuid(), uom: z.string().min(1).max(10) }), req.params);
    await asActor(actorOf(req), (tx) => deletePartUnit(tx, actorOf(req), p.id, p.uom));
    reply.status(204);
  });
  app.get('/audit/verify', async (req) => {
    const a = actorOf(req);
    requirePermission(a, 'audit.view');
    const bad = await withTx(scopeOf(a), verifyAuditChain);
    return { intact: bad === null, firstInvalidEventId: bad };
  });
}
