import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LotsBody } from '../inventory/lot-schema.js';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { addLabor, addPart, assignTechnician, attachProcedure, createRequest, createWorkOrder, getWorkOrder, listRequests, listWorkOrders, rejectRequest, transitionWorkOrder, WO_STATUSES } from './service.js';
import { dispatchVendor, listContractors, recordVendorUpdate, saveContractor, saveServiceLevels, serviceLevels } from './vendors.js';

const Id = z.object({ id: z.string().uuid() });

export async function maintenanceRoutes(app: FastifyInstance) {
  app.get('/maintenance-requests', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional(), status: z.enum(['open', 'converted', 'rejected']).optional() }), req.query);
    return asActor(actorOf(req), (tx) => listRequests(tx, actorOf(req), q));
  });
  app.post('/maintenance-requests/:id/reject', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().min(3).max(2000) }), req.body);
    await asActor(actorOf(req), (tx) => rejectRequest(tx, actorOf(req), id, b.note)); reply.status(204);
  });
  app.post('/work-orders/:id/dispatch', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ supplierId: z.string().uuid(), nteAmount: z.number().positive().max(10_000_000).nullable().optional(), note: z.string().max(2000).nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => dispatchVendor(tx, actorOf(req), id, b));
  });
  app.post('/work-orders/:id/vendor-update', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ event: z.enum(['accepted', 'declined', 'on_site', 'completed']), note: z.string().max(4000).nullable().optional(), reference: z.string().max(100).nullable().optional() }), req.body);
    await asActor(actorOf(req), (tx) => recordVendorUpdate(tx, actorOf(req), id, b)); reply.status(204);
  });
  app.get('/contractors', async (req) => {
    const q = parse(z.object({ trade: z.string().max(60).optional() }), req.query);
    return asActor(actorOf(req), (tx) => listContractors(tx, actorOf(req), q.trade));
  });
  app.put('/contractors/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ trades: z.array(z.string().min(1).max(60)).max(20), insuranceExpiresOn: z.string().date().nullable() }), req.body);
    return asActor(actorOf(req), (tx) => saveContractor(tx, actorOf(req), id, b));
  });
  app.get('/service-levels', async (req) => asActor(actorOf(req), async (tx) => [...(await serviceLevels(tx)).values()]));
  app.put('/service-levels', async (req) => {
    const b = parse(z.object({ levels: z.array(z.object({ priority: z.number().int().min(1).max(4), respondHours: z.number().positive().nullable(), completeHours: z.number().positive().nullable() })).max(4) }), req.body);
    return asActor(actorOf(req), (tx) => saveServiceLevels(tx, actorOf(req), b.levels));
  });
  app.post('/maintenance-requests', async (req, reply) => {
    const body = parse(z.object({ assetId: z.string().uuid(), symptom: z.string().min(3).max(2000), severity: z.enum(['low', 'medium', 'high', 'critical']),
      safetyImpact: z.boolean().optional(), assetDown: z.boolean().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createRequest(tx, actorOf(req), body));
  });
  app.get('/work-orders', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional(), assetId: z.string().uuid().optional(), openOnly: qbool.optional(),
      status: z.union([z.enum(WO_STATUSES), z.array(z.enum(WO_STATUSES))]).optional(), limit: z.coerce.number().int().positive().optional(),
      assigned: z.enum(['me']).optional(), vendorId: z.string().uuid().optional() }), req.query);
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
      substituteForPartId: z.string().uuid().nullable().optional(), note: z.string().max(2000).optional(), locationId: z.string().uuid().nullable().optional(), lots: LotsBody }), req.body);
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
