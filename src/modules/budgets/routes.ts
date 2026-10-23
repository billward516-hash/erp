import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  allocateTarget, approveBudget, budgetVsActual, closeBudget, createBudget, decideSubmission, deleteTarget, getBudget, listBudgets, listSpendCategories, proposeLines,
  saveBudgetLine, saveSpendCategory, setTarget, spendAnalysis, submitBudget,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const money = z.number().min(0).max(1e10);

export async function budgetRoutes(app: FastifyInstance) {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);
  app.get('/spend-categories', async (req) => run(req, (tx) => listSpendCategories(tx)));
  app.post('/spend-categories', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), code: z.string().min(1).max(20), name: z.string().min(1).max(100), accountKeys: z.array(z.string().max(40)).max(30),
      sortOrder: z.number().int().min(0).max(10_000).optional(), active: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => saveSpendCategory(tx, a, b));
  });
  app.get('/spend-analysis', async (req) => {
    const q = parse(z.object({ facilityId: uuid.optional(), departmentId: uuid.optional(), asOf: z.string().date().optional() }), req.query);
    return run(req, (tx, a) => spendAnalysis(tx, a, q));
  });
  app.get('/budgets', async (req) => run(req, (tx, a) => listBudgets(tx, a)));
  app.post('/budgets', async (req, reply) => {
    const b = parse(z.object({ fiscalYear: z.number().int().min(2000).max(2100), name: z.string().min(2).max(120), startMonth: z.number().int().min(1).max(12).optional(),
      notes: z.string().max(2000).nullable().optional(), copyFrom: uuid.nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => createBudget(tx, a, b));
  });
  app.get('/budgets/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getBudget(tx, a, id)); });
  app.get('/budgets/:id/vs-actual', async (req) => { const { id } = parse(Id, req.params); const q = parse(z.object({ asOf: z.string().date().optional() }), req.query); return run(req, (tx, a) => budgetVsActual(tx, a, id, q)); });
  app.post('/budgets/:id/lines', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ facilityId: uuid, departmentId: uuid.nullable().optional(), categoryId: uuid, amounts: z.array(money).length(12).optional(), annual: money.optional(),
      spreadBy: z.enum(['history', 'even']).optional(), note: z.string().max(500).nullable().optional() }), req.body);
    await run(req, (tx, a) => saveBudgetLine(tx, a, id, b)); done(reply);
  });
  app.post('/budgets/:id/propose', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ facilityId: uuid, departmentId: uuid.nullable().optional(), changePct: z.number().min(-90).max(500).optional(), overwrite: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => proposeLines(tx, a, id, b));
  });
  app.post('/budgets/:id/targets', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ facilityId: uuid.nullable().optional(), departmentId: uuid.nullable().optional(), categoryId: uuid.nullable().optional(), amount: money, note: z.string().max(500).nullable().optional() }), req.body);
    return run(req, (tx, a) => setTarget(tx, a, id, b));
  });
  app.delete('/budget-targets/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteTarget(tx, a, id)); done(reply); });
  app.post('/budget-targets/:id/allocate', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ basis: z.enum(['history', 'bottom_up']) }), req.body); return run(req, (tx, a) => allocateTarget(tx, a, id, b)); });
  app.post('/budgets/:id/submit', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ facilityId: uuid, departmentId: uuid.nullable().optional(), note: z.string().max(1000).nullable().optional() }), req.body);
    return run(req, (tx, a) => submitBudget(tx, a, id, b));
  });
  app.post('/budget-submissions/:id/decide', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ accept: z.boolean(), note: z.string().max(1000).nullable().optional() }), req.body);
    await run(req, (tx, a) => decideSubmission(tx, a, id, b)); done(reply);
  });
  app.post('/budgets/:id/approve', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => approveBudget(tx, a, id)); done(reply); });
  app.post('/budgets/:id/close', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => closeBudget(tx, a, id)); done(reply); });
}
