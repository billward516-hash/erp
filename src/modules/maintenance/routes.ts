import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { addLabor, addPart, assignTechnician, attachProcedure, createRequest, createWorkOrder, getWorkOrder, listWorkOrders, transitionWorkOrder, WO_STATUSES } from './service.js';

const Id = z.object({ id: z.string().uuid() });

export async function maintenanceRoutes(app: FastifyInstance) {
  app.post('/maintenance-requests', async (req, reply) => {
    const body = parse(z.object({ assetId: z.string().uuid(), symptom: z.string().min(3).max(2000), severity: z.enum(['low', 'medium', 'high', 'critical']),
      safetyImpact: z.boolean().optional(), assetDown: z.boolean().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createRequest(tx, actorOf(req), body));
  });
  app.get('/work-orders', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional(), assetId: z.string().uuid().optional(), openOnly: z.coerce.boolean().optional(),
      status: z.union([z.enum(WO_STATUSES), z.array(z.enum(WO_STATUSES))]).optional(), limit: z.coerce.number().int().positive().optional(),
      assigned: z.enum(['me']).optional() }), req.query);
    const a = actorOf(req);
    const assignedEmployeeId = q.assigned === 'me' ? (a.employeeId ?? '00000000-0000-0000-0000-000000000000') : undefined;
    return asActor(a, (tx) => listWorkOrders(tx, a, { ...q, status: q.status ? [q.status].flat() : undefined, assignedEmployeeId }));
  });
  app.post('/work-orders', async (req, reply) => {
    const body = parse(z.object({ assetId: z.string().uuid(), title: z.string().min(3).max(300), description: z.string().max(5000).nullable().optional(),
      woType: z.enum(['corrective', 'preventive', 'inspection', 'other']).optional(), priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
      safetyNotes: z.string().max(5000).nullable().optional(), dueAt: z.string().datetime({ offset: true }).nullable().optional(),
      estimatedLaborHours: z.number().positive().max(10000).nullable().optional(), requestId: z.string().uuid().nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createWorkOrder(tx, actorOf(req), body));
  });
  app.get('/work-orders/:id', async (req) => {
    const { id } = parse(Id, req.params);
    return asActor(actorOf(req), (tx) => getWorkOrder(tx, actorOf(req), id));
  });
  app.post('/work-orders/:id/transition', async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ to: z.enum(WO_STATUSES), note: z.string().max(2000).optional(), remedy: z.string().max(5000).optional(),
      findings: z.string().max(5000).optional(), failureCode: z.string().max(64).optional(), causeCode: z.string().max(64).optional(),
      returnToService: z.boolean().optional() }), req.body);
    return asActor(actorOf(req), (tx) => transitionWorkOrder(tx, actorOf(req), id, body));
  });
  app.post('/work-orders/:id/assignments', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ employeeId: z.string().uuid(), role: z.enum(['lead', 'technician']).optional() }), req.body);
    reply.status(204);
    await asActor(actorOf(req), (tx) => assignTechnician(tx, actorOf(req), id, body.employeeId, body.role));
  });
  app.post('/work-orders/:id/labor', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ employeeId: z.string().uuid().optional(), workDate: z.string().date(), hours: z.number().positive().max(24),
      hourlyRate: z.number().nonnegative().nullable().optional(), note: z.string().max(2000).optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => addLabor(tx, actorOf(req), id, body));
  });
  app.post('/work-orders/:id/parts', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ partId: z.string().uuid(), qtyPlanned: z.number().nonnegative().optional(), qtyUsed: z.number().nonnegative().optional(),
      substituteForPartId: z.string().uuid().nullable().optional(), note: z.string().max(2000).optional(), locationId: z.string().uuid().nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => addPart(tx, actorOf(req), id, body));
  });
  app.post('/work-orders/:id/procedures', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ documentVersionId: z.string().uuid() }), req.body);
    reply.status(204);
    await asActor(actorOf(req), (tx) => attachProcedure(tx, actorOf(req), id, body.documentVersionId));
  });
}
