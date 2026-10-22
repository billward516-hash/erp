import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { classifyIncident, closeIncident, getIncident, investigateIncident, listIncidents, reportIncident } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const KINDS = ['near_miss', 'first_aid', 'injury', 'illness', 'property_damage', 'environmental'] as const;

export async function safetyRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  app.get('/incidents', async (req) => {
    const q = parse(z.object({ open: z.coerce.boolean().optional(), kind: z.enum(KINDS).optional() }), req.query);
    return run(req, (tx, a) => listIncidents(tx, a, q));
  });
  app.post('/incidents', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, kind: z.enum(KINDS), occurredAt: z.string().datetime({ offset: true }), location: z.string().max(200).nullable().optional(),
      assetId: uuid.nullable().optional(), description: z.string().min(3).max(4000), immediateActions: z.string().max(4000).nullable().optional(),
      involvedEmployeeId: uuid.nullable().optional(), injuryDescription: z.string().max(4000).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => reportIncident(tx, a, { ...b, occurredAt: new Date(b.occurredAt) }));
  });
  app.get('/incidents/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getIncident(tx, a, id)); });
  app.post('/incidents/:id/classify', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ severity: z.enum(['low', 'medium', 'high', 'serious']), kind: z.enum(KINDS).optional(), involvedEmployeeId: uuid.nullable().optional(),
      injuryDescription: z.string().max(4000).nullable().optional(), medicalTreatment: z.boolean().nullable().optional(), daysAway: z.number().int().min(0).nullable().optional(),
      daysRestricted: z.number().int().min(0).nullable().optional(), recordable: z.boolean().nullable().optional() }), req.body);
    await run(req, (tx, a) => classifyIncident(tx, a, id, b));
    reply.status(204);
  });
  app.post('/incidents/:id/investigate', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ rootCause: z.string().min(3).max(4000), contributingFactors: z.string().max(4000).nullable().optional() }), req.body);
    await run(req, (tx, a) => investigateIncident(tx, a, id, b));
    reply.status(204);
  });
  app.post('/incidents/:id/close', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => closeIncident(tx, a, id)); reply.status(204); });
}
