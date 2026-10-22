import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  acknowledgeHandbook, acknowledgePolicy, archivePolicy, createPolicy, discardDraft, expenseRules, getPolicy, handbook, installTemplates, listPolicies, myPendingPolicies,
  publishPolicy, saveDraft, saveExpenseCategory, saveExpensePolicy,
} from './service.js';
import { POLICY_TEMPLATES, TEMPLATE_NOTICE } from './templates.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const CATEGORIES = ['handbook', 'expense', 'hr', 'it', 'safety', 'quality', 'finance', 'other'] as const;
const money = z.number().positive().max(1_000_000);

export async function policyRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);

  app.get('/policies', async (req) => { const q = parse(z.object({ category: z.enum(CATEGORIES).optional() }), req.query); return run(req, (tx, a) => listPolicies(tx, a, q)); });
  app.get('/policies/pending', async (req) => run(req, (tx, a) => myPendingPolicies(tx, a)));
  app.get('/policies/templates', async () => ({ notice: TEMPLATE_NOTICE, templates: POLICY_TEMPLATES.map(({ body: _b, ...t }) => t) }));
  app.post('/policies/templates', async (req) => { const b = parse(z.object({ keys: z.array(z.string().max(60)).max(50).optional() }), req.body ?? {}); return run(req, (tx, a) => installTemplates(tx, a, b.keys)); });
  app.get('/handbook', async (req) => run(req, (tx, a) => handbook(tx, a)));
  app.post('/handbook/acknowledge', async (req) => run(req, (tx, a) => acknowledgeHandbook(tx, a)));
  app.post('/policies', async (req, reply) => {
    const b = parse(z.object({ title: z.string().min(2).max(200), category: z.enum(CATEGORIES), facilityId: uuid.nullable().optional(), requiresAcknowledgement: z.boolean().optional(),
      body: z.string().max(100_000).optional(), handbookOrder: z.number().int().min(0).max(10_000).nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => createPolicy(tx, a, b));
  });
  app.get('/policies/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getPolicy(tx, a, id)); });
  app.put('/policies/:id/draft', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ body: z.string().max(100_000).optional(), changeSummary: z.string().max(1000).nullable().optional(), requiresReack: z.boolean().optional(),
      title: z.string().min(2).max(200).optional(), requiresAcknowledgement: z.boolean().optional(), handbookOrder: z.number().int().min(0).max(10_000).nullable().optional() }), req.body);
    return run(req, (tx, a) => saveDraft(tx, a, id, b));
  });
  app.delete('/policies/:id/draft', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => discardDraft(tx, a, id)); done(reply); });
  app.post('/policies/:id/publish', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ effectiveOn: day.nullable().optional() }), req.body ?? {}); return run(req, (tx, a) => publishPolicy(tx, a, id, b)); });
  app.post('/policies/:id/acknowledge', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => acknowledgePolicy(tx, a, id)); done(reply); });
  app.post('/policies/:id/archive', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body); await run(req, (tx, a) => archivePolicy(tx, a, id, b.reason)); done(reply); });

  app.get('/expense-policy', async (req) => run(req, (tx) => expenseRules(tx)));
  app.put('/expense-policy', async (req, reply) => {
    const b = parse(z.object({ receiptRequiredOver: z.number().min(0).max(100_000), mileageRate: z.number().positive().max(10).nullable().optional(),
      submitWithinDays: z.number().int().positive().max(365).nullable().optional(), notes: z.string().max(2000).nullable().optional() }), req.body);
    await run(req, (tx, a) => saveExpensePolicy(tx, a, b)); done(reply);
  });
  app.post('/expense-categories', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), code: z.string().min(1).max(20), name: z.string().min(1).max(100), kind: z.enum(['amount', 'mileage']).optional(),
      limitPerItem: money.nullable().optional(), limitPerDay: money.nullable().optional(), receiptRequiredOver: z.number().min(0).max(100_000).nullable().optional(),
      needsAttendees: z.boolean().optional(), accountKey: z.string().max(40).optional(), active: z.boolean().optional(), sortOrder: z.number().int().min(0).max(10_000).optional() }), req.body);
    return run(req, (tx, a) => saveExpenseCategory(tx, a, b));
  });
}
