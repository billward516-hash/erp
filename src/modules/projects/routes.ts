import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { projectOptions } from './booking.js';
import { costRateOverview, getProjectFigures, listCostRates, setCostRate } from './costing.js';
import {
  addMember, addMilestone, addTask, createProject, deleteMilestone, getBillableContract, getChangeOrder, getProject, getSettings, listProjects, projectLookups, reachMilestone, requestChangeOrder,
  saveSettings, transitionProject, unreachMilestone, updateMember, updateMilestone, updateProject, updateTask, withdrawChangeOrder,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const money = z.number().min(0).max(1_000_000_000);
const billing = z.enum(['time_materials', 'fixed_price', 'retainer', 'non_billable']);

export async function projectRoutes(app: FastifyInstance) {
  const run = <T>(req: Parameters<typeof actorOf>[0], fn: (tx: Parameters<Parameters<typeof asActor>[1]>[0], a: ReturnType<typeof actorOf>) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));

  app.get('/projects', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), customerId: uuid.optional(), mine: qbool.optional(), search: z.string().max(100).optional() }), req.query);
    return run(req, (tx, a) => listProjects(tx, a, q));
  });
  /** Active projects the signed-in person may book hours or expenses to (their team projects and those open to all staff), with tasks. */
  app.get('/projects/booking-options', async (req) => run(req, (tx, a) => projectOptions(tx, a, a.employeeId)));
  app.get('/projects/lookups', async (req) => run(req, (tx, a) => projectLookups(tx, a)));
  app.post('/projects', async (req, reply) => {
    const b = parse(z.object({ name: z.string().min(2).max(200), customerId: uuid.nullable().optional(), billingType: billing.optional(), ownerUserId: uuid.nullable().optional(), startDate: day.nullable().optional(),
      endDate: day.nullable().optional(), description: z.string().max(4000).nullable().optional(), facilityId: uuid.nullable().optional(), openToAll: z.boolean().optional(), hoursBudget: money.nullable().optional(),
      amountBudget: money.nullable().optional(), contractAmount: money.nullable().optional(), status: z.enum(['proposed', 'active']).optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => createProject(tx, a, b));
  });
  app.get('/projects/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getProject(tx, a, id)); });
  app.patch('/projects/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ name: z.string().min(2).max(200).optional(), customerId: uuid.nullable().optional(), billingType: billing.optional(), ownerUserId: uuid.optional(), startDate: day.nullable().optional(),
      endDate: day.nullable().optional(), description: z.string().max(4000).nullable().optional(), openToAll: z.boolean().optional(), hoursBudget: money.nullable().optional(), amountBudget: money.nullable().optional(),
      contractAmount: money.nullable().optional() }), req.body);
    return run(req, (tx, a) => updateProject(tx, a, id, b));
  });
  app.post('/projects/:id/transition', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ to: z.enum(['proposed', 'active', 'on_hold', 'completed', 'cancelled']), reason: z.string().max(1000).nullable().optional() }), req.body);
    return run(req, (tx, a) => transitionProject(tx, a, id, b));
  });
  /** Budget against actual, cost, billed, margin, burn and warnings. Cost and margin are absent unless the caller holds projects.see_cost. */
  app.get('/projects/:id/figures', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getProjectFigures(tx, a, id)); });
  app.get('/projects/:id/contract', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getBillableContract(tx, a, id)); });

  app.post('/projects/:id/members', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ employeeId: uuid, role: z.string().max(100).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addMember(tx, a, id, b));
  });
  app.patch('/project-members/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ role: z.string().max(100).nullable().optional(), active: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => updateMember(tx, a, id, b));
  });

  app.post('/projects/:id/tasks', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(200), billable: z.boolean().optional(), hoursBudget: money.nullable().optional(), amountBudget: money.nullable().optional(), sortNo: z.number().int().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addTask(tx, a, id, b));
  });
  app.patch('/project-tasks/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(200).optional(), billable: z.boolean().optional(), hoursBudget: money.nullable().optional(), amountBudget: money.nullable().optional(),
      sortNo: z.number().int().optional(), active: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => updateTask(tx, a, id, b));
  });

  app.post('/projects/:id/milestones', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(200), dueDate: day.nullable().optional(), amount: money.nullable().optional(), percent: z.number().min(0).max(100).nullable().optional(), sortNo: z.number().int().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => addMilestone(tx, a, id, b));
  });
  app.patch('/project-milestones/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(200).optional(), dueDate: day.nullable().optional(), amount: money.nullable().optional(), percent: z.number().min(0).max(100).nullable().optional(), sortNo: z.number().int().optional() }), req.body);
    return run(req, (tx, a) => updateMilestone(tx, a, id, b));
  });
  app.delete('/project-milestones/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteMilestone(tx, a, id)); reply.status(204); });
  app.post('/project-milestones/:id/reach', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reachedOn: day.nullable().optional() }), req.body ?? {});
    return run(req, (tx, a) => reachMilestone(tx, a, id, { reachedOn: b.reachedOn }));
  });
  app.post('/project-milestones/:id/unreach', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body);
    return run(req, (tx, a) => unreachMilestone(tx, a, id, b.reason));
  });

  app.post('/projects/:id/change-orders', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ amount: z.number().min(-1_000_000_000).max(1_000_000_000), reason: z.string().min(3).max(2000), reference: z.string().max(200).nullable().optional() }), req.body);
    reply.status(201);
    return run(req, (tx, a) => requestChangeOrder(tx, a, id, b));
  });
  app.get('/project-change-orders/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getChangeOrder(tx, a, id)); });
  app.post('/project-change-orders/:id/withdraw', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => withdrawChangeOrder(tx, a, id)); reply.status(204); });

  // Cost rates: every one of these needs projects.see_cost.
  app.get('/employee-cost-rates', async (req) => {
    const q = parse(z.object({ employeeId: uuid.optional(), overview: qbool.optional() }), req.query);
    return run(req, (tx, a) => (q.overview ? costRateOverview(tx, a) : listCostRates(tx, a, q.employeeId)));
  });
  app.post('/employee-cost-rates', async (req, reply) => {
    const b = parse(z.object({ employeeId: uuid, effectiveFrom: day, hourlyCost: z.number().min(0).max(100_000) }), req.body);
    reply.status(201);
    return run(req, (tx, a) => setCostRate(tx, a, b));
  });

  app.get('/project-settings', async (req) => run(req, (tx, a) => getSettings(tx, a)));
  app.put('/project-settings', async (req) => {
    const b = parse(z.object({ budgetAlertPct: z.number().int().min(50).max(100) }), req.body);
    return run(req, (tx, a) => saveSettings(tx, a, b));
  });
}
