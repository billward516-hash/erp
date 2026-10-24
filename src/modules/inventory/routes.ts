import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LotsBody } from './lot-schema.js';
import { getLot, listLots, setLotHold, setTracking, traceForward } from './lot-service.js';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { returnPart } from '../maintenance/service.js';
import { addBarcode, labelsPdf, listBarcodes, removeBarcode, resolveCode } from './scan.js';
import { adjust, countsDue, createLocation, getCount, issueStock, openDueCount, ledger, listBalances, listCounts, listLocations, openCount, postCount, receive, recordCounts, setStockSettings, transfer } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const qty = z.number().finite();

export async function inventoryRoutes(app: FastifyInstance) {
  app.get('/stock-locations', async (req) => asActor(actorOf(req), (tx) => listLocations(tx, actorOf(req))));
  app.post('/stock-locations', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, code: z.string().min(1).max(40), name: z.string().min(1).max(200), kind: z.enum(['storeroom', 'staging']).optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createLocation(tx, actorOf(req), b));
  });
  app.get('/inventory', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), locationId: uuid.optional(), partId: uuid.optional(), q: z.string().optional(), belowReorder: qbool.optional() }), req.query);
    return asActor(actorOf(req), (tx) => listBalances(tx, actorOf(req), q));
  });
  app.get('/inventory/ledger', async (req) => {
    const q = parse(z.object({ partId: uuid.optional(), locationId: uuid.optional(), workOrderId: uuid.optional(), limit: z.coerce.number().int().positive().optional() }), req.query);
    return asActor(actorOf(req), (tx) => ledger(tx, actorOf(req), q));
  });
  // Lots and serial numbers (D-147).
  app.get('/lots', async (req) => {
    const q = parse(z.object({ partId: uuid.optional(), q: z.string().max(60).optional(), status: z.enum(['available', 'hold', 'scrapped']).optional(),
      expiringDays: z.coerce.number().int().min(0).max(3650).optional() }), req.query);
    return asActor(actorOf(req), (tx) => listLots(tx, actorOf(req), q));
  });
  app.get('/lots/:id', async (req) => { const { id } = parse(z.object({ id: uuid }), req.params); return asActor(actorOf(req), (tx) => getLot(tx, actorOf(req), id)); });
  app.get('/lots/:id/trace', async (req) => { const { id } = parse(z.object({ id: uuid }), req.params); return asActor(actorOf(req), (tx) => traceForward(tx, actorOf(req), id)); });
  app.post('/lots/:id/hold', async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ hold: z.boolean(), reason: z.string().max(500).nullable().optional(), nonconformanceId: uuid.nullable().optional() }), req.body);
    await asActor(actorOf(req), (tx) => setLotHold(tx, actorOf(req), id, b));
    reply.status(204);
  });
  app.put('/parts/:id/tracking', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ tracking: z.enum(['none', 'lot', 'serial']), shelfLifeDays: z.number().int().positive().max(36500).nullable().optional(),
      existing: z.array(z.object({ locationId: uuid, lot: z.string().min(1).max(60), qty: z.number().positive(), expiresOn: z.string().date().nullable().optional() })).max(5000).optional() }), req.body);
    return asActor(actorOf(req), (tx) => setTracking(tx, actorOf(req), id, b));
  });
  // Scanning (SC-006 A)
  app.get('/scan/resolve', async (req) => { const q = parse(z.object({ code: z.string().min(1).max(200) }), req.query); return asActor(actorOf(req), (tx) => resolveCode(tx, actorOf(req), q.code)); });
  app.get('/parts/:id/barcodes', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => listBarcodes(tx, actorOf(req), id)); });
  app.post('/parts/:id/barcodes', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ code: z.string().min(3).max(60), kind: z.enum(['upc', 'ean', 'carton', 'supplier', 'internal']).optional(), qtyPerScan: z.number().positive().max(1_000_000).optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => addBarcode(tx, actorOf(req), id, b));
  });
  app.delete('/parts/:id/barcodes/:barcodeId', async (req, reply) => {
    const p = parse(z.object({ id: uuid, barcodeId: uuid }), req.params);
    await asActor(actorOf(req), (tx) => removeBarcode(tx, actorOf(req), p.id, p.barcodeId));
    reply.status(204);
  });
  app.post('/labels/pdf', async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(['part', 'location', 'lot']), ids: z.array(uuid).min(1).max(300) }), req.body);
    const pdf = await asActor(actorOf(req), (tx) => labelsPdf(tx, actorOf(req), b));
    reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="labels.pdf"');
    return pdf;
  });
  app.post('/inventory/issues', async (req, reply) => {
    const b = parse(z.object({ locationId: uuid, partId: uuid, qty: qty.positive(), reference: z.string().min(1).max(100), reason: z.string().max(500).nullable().optional(), lots: LotsBody }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => issueStock(tx, actorOf(req), b));
  });
  app.get('/inventory/counts-due', async (req) => asActor(actorOf(req), (tx) => countsDue(tx, actorOf(req))));
  app.post('/inventory/counts-due/:id/open', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ blind: z.boolean().optional() }), req.body ?? {});
    reply.status(201);
    return asActor(actorOf(req), (tx) => openDueCount(tx, actorOf(req), id, b));
  });
  app.post('/inventory/receipts', async (req, reply) => {
    const b = parse(z.object({ locationId: uuid, partId: uuid, qty: qty.positive(), unitCost: z.number().nonnegative().nullable().optional(), reference: z.string().max(100).nullable().optional(), lots: LotsBody,
      containerSize: z.number().positive().nullable().optional(), storageOverrideReason: z.string().max(500).nullable().optional() }), req.body);
    reply.status(201);
    const { containerSize, storageOverrideReason, ...rest } = b;
    return asActor(actorOf(req), (tx) => receive(tx, actorOf(req), { ...rest, chemical: containerSize || storageOverrideReason ? { containerSize, overrideReason: storageOverrideReason } : null }));
  });
  app.post('/inventory/adjustments', async (req, reply) => {
    const b = parse(z.object({ locationId: uuid, partId: uuid, qty, reason: z.string().min(5).max(500), lots: LotsBody }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => adjust(tx, actorOf(req), b));
  });
  app.post('/inventory/transfers', async (req, reply) => {
    const b = parse(z.object({ fromLocationId: uuid, toLocationId: uuid, partId: uuid, qty: qty.positive(), reference: z.string().max(100).nullable().optional(), lots: LotsBody }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => transfer(tx, actorOf(req), b));
  });
  app.put('/inventory/settings', async (req, reply) => {
    const b = parse(z.object({ locationId: uuid, partId: uuid, reorderPoint: z.number().nonnegative().nullable().optional(), reorderQty: z.number().positive().nullable().optional(), bin: z.string().max(40).nullable().optional(), cycleCountDays: z.number().int().positive().max(1095).nullable().optional() }), req.body);
    await asActor(actorOf(req), (tx) => setStockSettings(tx, actorOf(req), b.locationId, b.partId, b));
    reply.status(204);
  });
  app.get('/inventory/counts', async (req) => asActor(actorOf(req), (tx) => listCounts(tx, actorOf(req))));
  app.post('/inventory/counts', async (req, reply) => {
    const b = parse(z.object({ locationId: uuid, partIds: z.array(uuid).max(2000).optional(), note: z.string().max(500).nullable().optional(), blind: z.boolean().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => openCount(tx, actorOf(req), b.locationId, b));
  });
  app.get('/inventory/counts/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getCount(tx, actorOf(req), id)); });
  app.post('/inventory/counts/:id/lines', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ partId: uuid, countedQty: z.number().nonnegative(), lot: z.string().max(60).nullable().optional() })).min(1) }), req.body);
    await asActor(actorOf(req), (tx) => recordCounts(tx, actorOf(req), id, b.lines));
    reply.status(204);
  });
  app.post('/inventory/counts/:id/post', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ acceptMovement: z.boolean().optional() }), req.body ?? {});
    return asActor(actorOf(req), (tx) => postCount(tx, actorOf(req), id, b));
  });
  app.post('/work-order-parts/:id/return', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ qty: qty.positive() }), req.body);
    await asActor(actorOf(req), (tx) => returnPart(tx, actorOf(req), id, b.qty));
    reply.status(204);
  });
}
