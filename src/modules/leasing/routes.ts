import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import {
  activateLease, addTurnWork, billingPreview, cancelLease, createLease, getLease, giveNotice, listTurns, markTurnReady, recordMoveOut, renewLease, rentRoll,
  runRentBilling, saveRentalUnit,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const money = z.number().min(0).max(10_000_000);

export const leasingRoutes = (blobs: BlobStore) => async (app: FastifyInstance) => {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);

  app.get('/rent-roll', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), asOf: day.optional() }), req.query);
    return run(req, (tx, a) => rentRoll(tx, a, q));
  });
  app.put('/rental-units', async (req) => {
    const b = parse(z.object({ assetId: uuid, unitType: z.enum(['residential', 'commercial', 'storage', 'parking', 'other']).optional(), bedrooms: z.number().min(0).max(50).nullable().optional(),
      bathrooms: z.number().min(0).max(50).nullable().optional(), areaSqft: z.number().int().positive().max(10_000_000).nullable().optional(), marketRent: money.nullable().optional(),
      offline: z.boolean().optional(), offlineReason: z.string().max(500).nullable().optional() }), req.body);
    return run(req, (tx, a) => saveRentalUnit(tx, a, b));
  });
  app.post('/leases', async (req, reply) => {
    const b = parse(z.object({ unitId: uuid, startDate: day, endDate: day.nullable().optional(), rentAmount: money, depositAmount: money.optional(), graceDays: z.number().int().min(0).max(31).optional(),
      renter: z.object({ customerId: uuid.optional(), name: z.string().max(200).optional(), email: z.string().max(200).nullable().optional(), phone: z.string().max(60).nullable().optional(), organization: z.boolean().optional() }),
      charges: z.array(z.object({ description: z.string().min(1).max(200), amount: z.number().positive().max(1_000_000), startsOn: day.nullable().optional(), endsOn: day.nullable().optional() })).max(20).optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createLease(tx, a, b));
  });
  app.get('/leases/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getLease(tx, a, id)); });
  app.post('/leases/:id/activate', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ depositReceivedOn: day.nullable().optional() }), req.body ?? {});
    await run(req, (tx, a) => activateLease(tx, a, id, b)); done(reply);
  });
  app.post('/leases/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(2000) }), req.body); await run(req, (tx, a) => cancelLease(tx, a, id, b.reason)); done(reply); });
  app.post('/leases/:id/notice', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ noticeOn: day, moveOutOn: day }), req.body); await run(req, (tx, a) => giveNotice(tx, a, id, b)); done(reply); });
  app.post('/leases/:id/move-out', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ movedOutOn: day, turnDays: z.number().int().min(0).max(120).optional(), reason: z.string().max(500).nullable().optional() }), req.body);
    return run(req, (tx, a) => recordMoveOut(tx, a, id, b));
  });
  app.post('/leases/:id/renew', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ startDate: day.optional(), endDate: day.nullable(), rentAmount: money }), req.body);
    reply.status(201); return run(req, (tx, a) => renewLease(tx, a, id, b));
  });
  app.get('/rent-billing/preview', async (req) => {
    const q = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), facilityId: uuid.optional() }), req.query);
    return run(req, (tx, a) => billingPreview(tx, a, q));
  });
  app.post('/rent-billing', async (req) => {
    const b = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), facilityId: uuid.optional(), issue: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => runRentBilling(tx, a, blobs, b));
  });
  app.get('/unit-turns', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), open: qbool.optional() }), req.query);
    return run(req, (tx, a) => listTurns(tx, a, q));
  });
  app.post('/unit-turns/:id/work', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ title: z.string().min(3).max(300), priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(), description: z.string().max(4000).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => addTurnWork(tx, a, id, b));
  });
  app.post('/unit-turns/:id/ready', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ readyOn: day.optional() }), req.body ?? {});
    await run(req, (tx, a) => markTurnReady(tx, a, id, b.readyOn)); done(reply);
  });
};
