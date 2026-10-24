import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { CHANNELS, CHANNEL_LABEL, CHANNEL_UNIT, classLimits } from './limits.js';
import { getRoom, listRooms, recordReading, saveRoom, savePoint, setPointLimits } from './service.js';

const uuid = z.string().uuid();
const Id = z.object({ id: uuid });
const channel = z.enum(CHANNELS);
const limit = z.object({ alertLow: z.number().nullable().optional(), alertHigh: z.number().nullable().optional(), actionLow: z.number().nullable().optional(), actionHigh: z.number().nullable().optional() });

export async function cleanroomRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  /** What the screen needs to label channels, and the ISO 14644-1 class table the platform generates (to be confirmed against the company's copy of the standard). */
  app.get('/cleanrooms/reference', async () => ({
    channels: CHANNELS.map((c) => ({ key: c, label: CHANNEL_LABEL[c], unit: CHANNEL_UNIT[c] })),
    classes: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ isoClass: n, limits: classLimits(n) })),
  }));
  app.get('/cleanrooms', async (req) => { const q = parse(z.object({ facilityId: uuid.optional(), all: z.coerce.boolean().optional() }), req.query); return run(req, (tx, a) => listRooms(tx, a, q)); });
  const room = z.object({ facilityId: uuid.optional(), code: z.string().min(1).max(40), name: z.string().min(1).max(200), isoClass: z.number().int().min(1).max(9), occupancy: z.enum(['at_rest', 'operational']).optional(),
    ownerUserId: uuid, alertPct: z.number().int().min(10).max(99).optional(), trendCount: z.number().int().min(2).max(20).optional(), active: z.boolean().optional() });
  app.post('/cleanrooms', async (req, reply) => { const b = parse(room, req.body); reply.status(201); return run(req, (tx, a) => saveRoom(tx, a, b)); });
  app.get('/cleanrooms/:id', async (req) => { const { id } = parse(Id, req.params); const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(14) }), req.query); return run(req, (tx, a) => getRoom(tx, a, id, q.days)); });
  app.put('/cleanrooms/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(room, req.body); return run(req, (tx, a) => saveRoom(tx, a, { ...b, id })); });
  const point = z.object({ id: uuid.optional(), label: z.string().min(1).max(200), channels: z.array(channel).min(1).max(9), intervalHours: z.number().int().min(1).max(24 * 366), active: z.boolean().optional() });
  app.post('/cleanrooms/:id/points', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(point, req.body); reply.status(201); return run(req, (tx, a) => savePoint(tx, a, id, b)); });
  app.put('/cleanrooms/:id/points', async (req) => { const { id } = parse(Id, req.params); const b = parse(point.required({ id: true }), req.body); return run(req, (tx, a) => savePoint(tx, a, id, b)); });
  app.put('/cleanrooms/points/:id/limits', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ limits: z.record(channel, limit.nullable()) }), req.body);
    return run(req, (tx, a) => setPointLimits(tx, a, id, b.limits));
  });
  app.post('/cleanrooms/points/:id/readings', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const value = z.number().nullable().optional();
    const b = parse(z.object({ readAt: z.coerce.date().optional(), occupancy: z.enum(['at_rest', 'operational']).optional(), note: z.string().max(1000).nullable().optional(),
      values: z.object({ p0_1: value, p0_2: value, p0_3: value, p0_5: value, p1: value, p5: value, dp: value, temp: value, rh: value }) }), req.body);
    reply.status(201); return run(req, (tx, a) => recordReading(tx, a, id, b));
  });
}
