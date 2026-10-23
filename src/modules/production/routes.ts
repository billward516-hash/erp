import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LotsBody } from '../inventory/lot-schema.js';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import {
  cancelOrder, closeOrder, completeShort, createOrder, createRevision, finishOperation, floorQueue, getOrder, getRevision, issueMaterials, listOrders, listProducts,
  listScrapReasons, listWorkCenters, productForPart, receiveOutput, releaseOrder, releaseRevision, requestShortages, returnMaterial, saveRevision, saveWorkCenter,
  startOperation, stopOperation, updateOrder,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const reason = z.object({ reason: z.string().min(3).max(2000) });
const when = z.string().datetime({ offset: true }).optional();

export async function productionRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/work-centers', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listWorkCenters(tx, a, q)); });
  app.post('/work-centers', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), facilityId: uuid, code: z.string().min(1).max(30), name: z.string().min(1).max(200), active: z.boolean().optional(),
      assetIds: z.array(uuid).max(50).optional() }), req.body);
    return run(req, (tx, a) => saveWorkCenter(tx, a, b));
  });
  app.get('/work-centers/:id/floor', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => floorQueue(tx, a, id)); });
  app.get('/scrap-reasons', async (req) => run(req, (tx) => listScrapReasons(tx)));

  app.get('/products', async (req) => run(req, (tx, a) => listProducts(tx, a)));
  app.get('/products/by-part/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => productForPart(tx, a, id)); });
  app.post('/product-revisions', async (req, reply) => {
    const b = parse(z.object({ partId: uuid, notes: z.string().max(4000).nullable().optional(), blank: z.boolean().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createRevision(tx, a, b));
  });
  app.get('/product-revisions/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getRevision(tx, a, id)); });
  app.put('/product-revisions/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({
      notes: z.string().max(4000).nullable().optional(),
      materials: z.array(z.object({ partId: uuid, qtyPer: z.number().positive(), scrapPct: z.number().min(0).max(99).optional(), opNo: z.number().int().positive().nullable().optional(),
        notes: z.string().max(500).nullable().optional() })).max(300),
      operations: z.array(z.object({ opNo: z.number().int().positive(), workCenterId: uuid, description: z.string().min(1).max(1000), setupMinutes: z.number().min(0).optional(),
        runMinutesPerUnit: z.number().min(0).optional(), documentId: uuid.nullable().optional() })).max(100),
    }), req.body);
    return run(req, (tx, a) => saveRevision(tx, a, id, b));
  });
  app.post('/product-revisions/:id/release', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => releaseRevision(tx, a, id)); });

  app.get('/production-orders', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), open: qbool.optional(), partId: uuid.optional(), facilityId: uuid.optional() }), req.query);
    return run(req, (tx, a) => listOrders(tx, a, q));
  });
  app.post('/production-orders', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, partId: uuid, qty: z.number().positive(), dueDate: day.nullable().optional(), outputLocationId: uuid.nullable().optional(),
      salesOrderLineId: uuid.nullable().optional(), notes: z.string().max(4000).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createOrder(tx, a, b));
  });
  app.get('/production-orders/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getOrder(tx, a, id)); });
  app.patch('/production-orders/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ qty: z.number().positive().optional(), dueDate: day.nullable().optional(), outputLocationId: uuid.nullable().optional(), notes: z.string().max(4000).nullable().optional() }), req.body);
    await run(req, (tx, a) => updateOrder(tx, a, id, b));
    reply.status(204);
  });
  app.post('/production-orders/:id/release', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => releaseOrder(tx, a, id)); });
  app.post('/production-orders/:id/request-shortages', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => requestShortages(tx, a, id)); });
  app.post('/production-orders/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(reason, req.body); await run(req, (tx, a) => cancelOrder(tx, a, id, b.reason)); reply.status(204); });
  app.post('/production-orders/:id/issue', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ materialId: uuid, locationId: uuid, qty: z.number().positive(), lots: LotsBody })).min(1).max(300) }), req.body);
    await run(req, (tx, a) => issueMaterials(tx, a, id, b.lines));
    reply.status(204);
  });
  app.post('/production-orders/:id/return', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ materialId: uuid, locationId: uuid, qty: z.number().positive(), reason: z.string().max(500).nullable().optional(), lots: LotsBody }), req.body);
    await run(req, (tx, a) => returnMaterial(tx, a, id, b));
    reply.status(204);
  });
  app.post('/production-orders/:id/receive', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ qty: z.number().positive(), locationId: uuid.nullable().optional(), lots: LotsBody }), req.body);
    return run(req, (tx, a) => receiveOutput(tx, a, id, b));
  });
  app.post('/production-orders/:id/complete-short', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(reason, req.body); await run(req, (tx, a) => completeShort(tx, a, id, b.reason)); reply.status(204); });
  app.post('/production-orders/:id/close', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ unreturnedReason: z.string().max(500).nullable().optional() }), req.body ?? {}); await run(req, (tx, a) => closeOrder(tx, a, id, b)); reply.status(204); });

  app.post('/production-operations/:id/start', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ employeeId: uuid.nullable().optional(), assetId: uuid.nullable().optional(), kind: z.enum(['setup', 'run']).optional(), at: when }), req.body ?? {});
    reply.status(201);
    return run(req, (tx, a) => startOperation(tx, a, id, { ...b, at: b.at ? new Date(b.at) : undefined }));
  });
  app.post('/production-operations/:id/finish', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => finishOperation(tx, a, id)); reply.status(204); });
  app.post('/production-entries/:id/stop', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ qtyGood: z.number().min(0).optional(), qtyScrap: z.number().min(0).optional(), qtyRework: z.number().min(0).optional(),
      scrapReason: z.string().max(20).nullable().optional(), note: z.string().max(2000).nullable().optional(), at: when }), req.body ?? {});
    return run(req, (tx, a) => stopOperation(tx, a, id, { ...b, at: b.at ? new Date(b.at) : undefined }));
  });
}
