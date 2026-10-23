import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  cancelExercise, confirmReview, createPlan, editorOptions, getPlan, listPlans, recordExercise, revisePlan, savePlanBody, saveContacts, scheduleExercise, submitPlan, updatePlan,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const hours = z.number().positive().max(100000);
const header = z.object({
  process: z.string().min(3).max(200), title: z.string().min(3).max(200), description: z.string().max(4000).nullable().optional(),
  criticality: z.enum(['critical', 'high', 'medium']).optional(), rtoHours: hours, rpoHours: z.number().min(0).max(100000).nullable().optional(),
  ownerUserId: uuid.optional(), alternateUserId: uuid.nullable().optional(),
  reviewIntervalMonths: z.number().int().min(1).max(60).optional(), exerciseIntervalMonths: z.number().int().min(1).max(60).optional(),
});

export async function continuityRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);

  app.get('/continuity-plans', async (req) => run(req, (tx, a) => listPlans(tx, a)));
  app.post('/continuity-plans', async (req, reply) => {
    const b = parse(header.extend({ facilityId: uuid }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createPlan(tx, a, b));
  });
  app.get('/continuity-plans/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getPlan(tx, a, id)); });
  app.get('/continuity-plans/:id/options', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => editorOptions(tx, a, id)); });
  app.put('/continuity-plans/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(header, req.body); return run(req, (tx, a) => updatePlan(tx, a, id, b)); });
  app.put('/continuity-plans/:id/body', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({
      dependencies: z.array(z.object({ kind: z.enum(['asset', 'supplier', 'skill', 'person', 'other']), assetId: uuid.nullable().optional(), supplierId: uuid.nullable().optional(),
        qualificationId: uuid.nullable().optional(), employeeId: uuid.nullable().optional(), description: z.string().min(1).max(1000), workaround: z.string().max(2000).nullable().optional(),
        minHolders: z.number().int().min(1).max(50).nullable().optional() })).max(100),
      scenarios: z.array(z.object({ scenario: z.string().min(1).max(500), impact: z.string().max(2000).nullable().optional(), recoverySteps: z.string().min(1).max(8000),
        recoveryOwnerUserId: uuid, estRecoveryHours: hours.nullable().optional(), documentId: uuid.nullable().optional() })).max(50),
    }), req.body);
    return run(req, (tx, a) => savePlanBody(tx, a, id, b));
  });
  app.put('/continuity-plans/:id/contacts', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ contacts: z.array(z.object({ name: z.string().min(1).max(200), role: z.string().min(1).max(200), phone: z.string().max(60).nullable().optional(),
      email: z.string().max(200).nullable().optional(), userId: uuid.nullable().optional(), supplierId: uuid.nullable().optional() })).max(100) }), req.body);
    await run(req, (tx, a) => saveContacts(tx, a, id, b.contacts)); done(reply);
  });
  app.post('/continuity-plans/:id/submit', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => submitPlan(tx, a, id)); done(reply); });
  app.post('/continuity-plans/:id/revise', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(2000) }), req.body);
    reply.status(201);
    return run(req, (tx, a) => revisePlan(tx, a, id, b.reason));
  });
  app.post('/continuity-plans/:id/review', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().min(3).max(4000) }), req.body);
    return run(req, (tx, a) => confirmReview(tx, a, id, b.note));
  });
  app.post('/continuity-plans/:id/exercises', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ kind: z.enum(['tabletop', 'walkthrough', 'simulation', 'full_test']), scheduledOn: day, facilitatorUserId: uuid, scenarioId: uuid.nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => scheduleExercise(tx, a, id, b));
  });
  app.post('/continuity-exercises/:id/record', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ conductedOn: day, participants: z.string().min(1).max(4000), outcome: z.enum(['met', 'partly_met', 'not_met']),
      achievedRecoveryHours: hours.nullable().optional(), findings: z.string().max(8000).nullable().optional() }), req.body);
    await run(req, (tx, a) => recordExercise(tx, a, id, b)); done(reply);
  });
  app.post('/continuity-exercises/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(2000) }), req.body);
    await run(req, (tx, a) => cancelExercise(tx, a, id, b.reason)); done(reply);
  });
}
