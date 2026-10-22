import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { excludeSubgroup, getCharacteristic, listCharacteristics, recordSubgroup, respondToSignal, saveCharacteristic, setLimits } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const characteristic = z.object({ facilityId: uuid, code: z.string().min(1).max(40), name: z.string().min(1).max(200), partId: uuid.nullable().optional(), opNo: z.number().int().min(0).max(9999).nullable().optional(),
  workCenterId: uuid.nullable().optional(), assetId: uuid.nullable().optional(), gaugeAssetId: uuid.nullable().optional(), unit: z.string().min(1).max(20).optional(),
  nominal: z.number().nullable().optional(), lsl: z.number().nullable().optional(), usl: z.number().nullable().optional(), subgroupSize: z.number().int().min(1).max(10),
  frequency: z.string().max(200).nullable().optional(), active: z.boolean().optional() });

export async function spcRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/spc/characteristics', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listCharacteristics(tx, a, q)); });
  app.post('/spc/characteristics', async (req, reply) => { const b = parse(characteristic, req.body); reply.status(201); return run(req, (tx, a) => saveCharacteristic(tx, a, b)); });
  app.put('/spc/characteristics/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(characteristic, req.body); return run(req, (tx, a) => saveCharacteristic(tx, a, { ...b, id })); });
  app.get('/spc/characteristics/:id', async (req) => {
    const { id } = parse(Id, req.params); const q = parse(z.object({ window: z.coerce.number().int().min(10).max(500).optional() }), req.query);
    return run(req, (tx, a) => getCharacteristic(tx, a, id, q));
  });
  app.post('/spc/characteristics/:id/subgroups', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ values: z.array(z.number()).min(1).max(10), measuredAt: z.coerce.date().optional(), productionOrderId: uuid.nullable().optional(),
      lot: z.string().max(100).nullable().optional(), note: z.string().max(1000).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => recordSubgroup(tx, a, id, b));
  });
  app.post('/spc/characteristics/:id/limits', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ from: z.coerce.date().nullable().optional(), to: z.coerce.date().nullable().optional(), reason: z.string().min(1).max(1000) }), req.body);
    reply.status(201); return run(req, (tx, a) => setLimits(tx, a, id, b));
  });
  app.post('/spc/subgroups/:id/exclude', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(1).max(1000) }), req.body);
    await run(req, (tx, a) => excludeSubgroup(tx, a, id, b.reason)); reply.status(204);
  });
  app.post('/spc/signals/:id/respond', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ cause: z.string().min(1).max(2000), response: z.string().min(1).max(2000), excludeSubgroup: z.boolean().optional(),
      raiseNcr: z.object({ severity: z.enum(['minor', 'major', 'critical']).optional(), qty: z.number().positive().nullable().optional() }).nullable().optional() }), req.body);
    return run(req, (tx, a) => respondToSignal(tx, a, id, b));
  });
}
