import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { CONSUMPTION_BASES, activateForecast, createPlannedOrders, listConsumptionRates, saveConsumptionRate, draftForecast, getForecast, getPlan, listForecasts, listScenarios, requestPlanShortages, saveScenario, saveWorkCenterCalendar, setForecastLines } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const adjustments = z.array(z.object({ workCenterId: uuid, extraHoursPerWeek: z.number().min(-168).max(168).optional(), extraUnits: z.number().int().min(-50).max(50).optional() })).max(50);

export async function planningRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/plan', async (req) => {
    const q = parse(z.object({ facilityId: uuid, horizon: z.coerce.number().int().min(1).max(18).optional(), scenarioId: uuid.optional() }), req.query);
    return run(req, (tx, a) => getPlan(tx, a, q));
  });
  app.post('/plan/purchase-request', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, horizon: z.number().int().min(1).max(18).optional(), partIds: z.array(uuid).max(500).optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => requestPlanShortages(tx, a, b));
  });
  app.post('/plan/production-orders', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, horizon: z.number().int().min(1).max(18).optional(),
      lines: z.array(z.object({ partId: uuid, month: z.string().regex(/^\d{4}-\d{2}$/) })).max(500).optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => createPlannedOrders(tx, a, b));
  });
  app.get('/forecasts', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => listForecasts(tx, a, q)); });
  app.post('/forecasts', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, customerId: uuid, notes: z.string().max(2000).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => draftForecast(tx, a, b));
  });
  app.get('/forecasts/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getForecast(tx, a, id)); });
  app.put('/forecasts/:id/lines', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ partId: uuid, month: z.string().regex(/^\d{4}-\d{2}$/), qty: z.number().min(0).max(1e9) })).max(5000) }), req.body);
    await run(req, (tx, a) => setForecastLines(tx, a, id, b.lines)); reply.status(204);
  });
  app.post('/forecasts/:id/activate', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => activateForecast(tx, a, id)); reply.status(204); });
  app.put('/work-centers/:id/calendar', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ hoursPerWeek: z.number().positive().max(168).nullable(), units: z.number().int().positive().max(500).nullable(), laborRatio: z.number().positive().max(20).nullable().optional() }), req.body);
    await run(req, (tx, a) => saveWorkCenterCalendar(tx, a, id, b)); reply.status(204);
  });
  app.get('/consumption-rates', async (req) => { const q = parse(z.object({ facilityId: uuid }), req.query); return run(req, (tx, a) => listConsumptionRates(tx, a, q.facilityId)); });
  app.post('/consumption-rates', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, partId: uuid, workCenterId: uuid.nullable().optional(), basis: z.enum(CONSUMPTION_BASES), rate: z.number().min(0).max(1e7), note: z.string().max(500).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => saveConsumptionRate(tx, a, b));
  });
  app.get('/planning-scenarios', async (req) => { const q = parse(z.object({ facilityId: uuid }), req.query); return run(req, (tx, a) => listScenarios(tx, a, q.facilityId)); });
  app.post('/planning-scenarios', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, name: z.string().min(1).max(200), demandPct: z.number().gt(-100).max(500).optional(), adjustments: adjustments.optional(), notes: z.string().max(2000).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => saveScenario(tx, a, b));
  });
}
