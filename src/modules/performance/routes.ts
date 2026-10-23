import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { acknowledgeReview, addGoal, getReview, hrAction, listPerformance, saveAssessment, saveSettings, shareReview, submitSelfAssessment, updateGoal } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const text = z.string().max(8000).nullable().optional();

export async function performanceRoutes(app: FastifyInstance) {
  app.get('/performance', async (req) => asActor(actorOf(req), (tx) => listPerformance(tx, actorOf(req))));
  app.put('/performance/settings', async (req, reply) => {
    const b = parse(z.object({ enabled: z.boolean(), intervalMonths: z.number().int(), anchor: z.enum(['calendar', 'hire_date']), calendarMonth: z.number().int().min(1).max(12),
      firstReviewMonths: z.number().int().min(1).max(24), checkinMonths: z.number().int(), selfAssessment: z.boolean(), openDaysBefore: z.number().int().min(0).max(90) }), req.body);
    await asActor(actorOf(req), (tx) => saveSettings(tx, actorOf(req), b));
    reply.status(204);
  });
  app.get('/performance/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getReview(tx, actorOf(req), id)); });
  app.post('/performance/:id/self-assessment', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ text: z.string().max(8000) }), req.body);
    await asActor(actorOf(req), (tx) => submitSelfAssessment(tx, actorOf(req), id, b.text)); reply.status(204);
  });
  app.put('/performance/:id/assessment', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ rating: z.number().int().min(1).max(5).nullable().optional(), strengths: text, development: text, summary: text }), req.body);
    await asActor(actorOf(req), (tx) => saveAssessment(tx, actorOf(req), id, b)); reply.status(204);
  });
  app.post('/performance/:id/share', async (req, reply) => { const { id } = parse(Id, req.params); await asActor(actorOf(req), (tx) => shareReview(tx, actorOf(req), id)); reply.status(204); });
  app.post('/performance/:id/acknowledge', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ comment: text }), req.body ?? {});
    await asActor(actorOf(req), (tx) => acknowledgeReview(tx, actorOf(req), id, b.comment)); reply.status(204);
  });
  app.post('/performance/:id/hr', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.discriminatedUnion('action', [z.object({ action: z.literal('assign'), reviewerUserId: z.string().uuid() }), z.object({ action: z.literal('cancel'), reason: z.string().max(500) }),
      z.object({ action: z.literal('close_unacknowledged') })]), req.body);
    await asActor(actorOf(req), (tx) => hrAction(tx, actorOf(req), id, b)); reply.status(204);
  });
  app.post('/performance/:id/goals', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ title: z.string().max(300), measure: text, dueOn: z.string().date().nullable().optional() }), req.body);
    reply.status(201); return asActor(actorOf(req), (tx) => addGoal(tx, actorOf(req), id, b));
  });
  app.put('/performance/:id/goals/:goalId', async (req, reply) => {
    const { id, goalId } = parse(z.object({ id: z.string().uuid(), goalId: z.string().uuid() }), req.params);
    const b = parse(z.object({ progressNote: text, status: z.enum(['open', 'met', 'partly_met', 'not_met', 'dropped']).optional() }), req.body);
    await asActor(actorOf(req), (tx) => updateGoal(tx, actorOf(req), id, goalId, b)); reply.status(204);
  });
}
