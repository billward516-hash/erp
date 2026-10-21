import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { SCREENING_QUESTIONS } from './screening.js';
import {
  ACTION_KINDS, addAction, AFFECTED_TYPES, answerPssr, cancelAction, cancelChange, CHANGE_TYPES, closeChange, completeAction, createChange, getChange,
  linkActionWorkOrder, listChanges, requestStartup, reviseChange, submitForReview,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const date = z.string().date();
const Affected = z.array(z.object({ entityType: z.enum(AFFECTED_TYPES), entityId: z.string().uuid(), note: z.string().max(500).nullable().optional() })).max(100);
const Fields = {
  title: z.string().min(3).max(200), description: z.string().min(10).max(10000), justification: z.string().min(10).max(5000),
  changeType: z.enum(CHANGE_TYPES), isTemporary: z.boolean().optional(), temporaryUntil: date.nullable().optional(), targetDate: date.nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(), affected: Affected.optional(),
};

export async function mocRoutes(app: FastifyInstance) {
  app.get('/moc/screening-questions', async () => SCREENING_QUESTIONS);
  app.get('/moc', async (req) => {
    const q = parse(z.object({ facilityId: z.string().uuid().optional(), open: z.coerce.boolean().optional(), status: z.string().optional(),
      entityType: z.enum(AFFECTED_TYPES).optional(), entityId: z.string().uuid().optional() }), req.query);
    return asActor(actorOf(req), (tx) => listChanges(tx, actorOf(req), { ...q, openOnly: q.open, status: q.status?.split(',') }));
  });
  app.post('/moc', async (req, reply) => {
    const b = parse(z.object({ facilityId: z.string().uuid(), ...Fields }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createChange(tx, actorOf(req), b));
  });
  app.get('/moc/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getChange(tx, actorOf(req), id)); });
  app.patch('/moc/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ ...Fields, reason: z.string().max(2000).optional() }).partial(), req.body);
    const { reason, ...patch } = b;
    return asActor(actorOf(req), (tx) => reviseChange(tx, actorOf(req), id, patch, reason));
  });
  app.post('/moc/:id/submit', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ screening: z.record(z.boolean()) }), req.body);
    return asActor(actorOf(req), (tx) => submitForReview(tx, actorOf(req), id, b.screening));
  });
  app.post('/moc/:id/actions', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ kind: z.enum(ACTION_KINDS), title: z.string().min(3).max(300), requiredBefore: z.enum(['startup', 'closeout']),
      ownerUserId: z.string().uuid().nullable().optional(), dueOn: date.nullable().optional(), documentId: z.string().uuid().nullable().optional(),
      courseId: z.string().uuid().nullable().optional(), workOrderId: z.string().uuid().nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => addAction(tx, actorOf(req), id, b));
  });
  app.post('/moc-actions/:id/complete', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ note: z.string().max(5000).nullable().optional() }), req.body ?? {});
    return asActor(actorOf(req), (tx) => completeAction(tx, actorOf(req), id, b));
  });
  app.post('/moc-actions/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reason: z.string().min(5).max(2000) }), req.body);
    await asActor(actorOf(req), (tx) => cancelAction(tx, actorOf(req), id, b.reason));
    reply.status(204);
  });
  app.post('/moc-actions/:id/work-order', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ workOrderId: z.string().uuid() }), req.body);
    await asActor(actorOf(req), (tx) => linkActionWorkOrder(tx, actorOf(req), id, b.workOrderId));
    reply.status(204);
  });
  app.post('/moc/:id/startup', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => requestStartup(tx, actorOf(req), id)); });
  app.post('/moc/:id/pssr', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ answers: z.array(z.object({ seq: z.number().int().positive(), response: z.enum(['yes', 'no', 'na']), note: z.string().max(2000).nullable().optional() })).min(1) }), req.body);
    return asActor(actorOf(req), (tx) => answerPssr(tx, actorOf(req), id, b.answers));
  });
  app.post('/moc/:id/close', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ note: z.string().min(10).max(5000) }), req.body);
    await asActor(actorOf(req), (tx) => closeChange(tx, actorOf(req), id, b.note));
    reply.status(204);
  });
  app.post('/moc/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reason: z.string().min(5).max(2000) }), req.body);
    await asActor(actorOf(req), (tx) => cancelChange(tx, actorOf(req), id, b.reason));
    reply.status(204);
  });
}
