import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { alarmSummary, excludeSubgroup, getCharacteristic, getSpcSettings, listCharacteristics, recordSubgroup, respondToSignal, saveCharacteristic, saveSpcSettings, setCharacteristicRules, setLimits, summarySentence } from './service.js';
import { requirePermission } from '../../platform/auth/actor.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const characteristic = z.object({ facilityId: uuid, code: z.string().min(1).max(40), name: z.string().min(1).max(200), partId: uuid.nullable().optional(), opNo: z.number().int().min(0).max(9999).nullable().optional(),
  workCenterId: uuid.nullable().optional(), assetId: uuid.nullable().optional(), gaugeAssetId: uuid.nullable().optional(), unit: z.string().min(1).max(20).optional(),
  nominal: z.number().nullable().optional(), lsl: z.number().nullable().optional(), usl: z.number().nullable().optional(), subgroupSize: z.number().int().min(1).max(10),
  frequency: z.string().max(200).nullable().optional(), active: z.boolean().optional(), chartType: z.enum(['variables', 'p', 'np', 'c', 'u']).optional(),
  sampleSize: z.number().positive().max(1e7).nullable().optional() });

export async function spcRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  // Rules in force and the alarm summary (D-156).
  app.get('/spc/settings', async (req) => run(req, (tx, a) => getSpcSettings(tx, a)));
  app.put('/spc/settings', async (req, reply) => {
    const b = parse(z.object({ rules: z.array(z.string().max(40)).max(20), notifyEachAlarm: z.boolean() }), req.body);
    await run(req, (tx, a) => saveSpcSettings(tx, a, b)); reply.status(204);
  });
  app.put('/spc/characteristics/:id/rules', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ rules: z.array(z.string().max(40)).max(20).nullable() }), req.body);
    await run(req, (tx, a) => setCharacteristicRules(tx, a, id, b.rules)); reply.status(204);
  });
  app.get('/spc/summary', async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(1), silentDays: z.coerce.number().int().min(1).max(365).default(7) }), req.query);
    return run(req, async (tx, a) => {
      requirePermission(a, 'quality.view');
      const period = q.days === 1 ? 'in the last day' : `in the last ${q.days} days`;
      return (await alarmSummary(tx, q)).map((s) => ({ ...s, sentence: summarySentence(s, period) }));
    });
  });
  app.get('/spc/characteristics', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listCharacteristics(tx, a, q)); });
  app.post('/spc/characteristics', async (req, reply) => { const b = parse(characteristic, req.body); reply.status(201); return run(req, (tx, a) => saveCharacteristic(tx, a, b)); });
  app.put('/spc/characteristics/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(characteristic, req.body); return run(req, (tx, a) => saveCharacteristic(tx, a, { ...b, id })); });
  app.get('/spc/characteristics/:id', async (req) => {
    const { id } = parse(Id, req.params); const q = parse(z.object({ window: z.coerce.number().int().min(10).max(500).optional() }), req.query);
    return run(req, (tx, a) => getCharacteristic(tx, a, id, q));
  });
  app.post('/spc/characteristics/:id/subgroups', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ values: z.array(z.number()).min(1).max(10), sampleSize: z.number().positive().max(1e7).nullable().optional(), measuredAt: z.coerce.date().optional(), productionOrderId: uuid.nullable().optional(),
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
