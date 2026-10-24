import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, facilitiesWith, requirePermission } from '../../platform/auth/actor.js';
import { many } from '../../platform/db/tx.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { addMilestone, getBillableContract, reachMilestone, reopenMilestone, setTerms } from './contracts.js';
import { createRate, endRate, explainRate, listRates, saveSettings, viewSettings } from './rates.js';
import { adjustLine, cancelRun, createDraftInvoice, createRun, getRun, holdEntry, listRuns, releaseHold, restoreWriteOff, unbilledWork } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();

export async function billingRoutes(app: FastifyInstance) {
  // ---- Rates ---------------------------------------------------------------------------------------------------------------
  app.get('/bill-rates', async (req) => {
    const q = parse(z.object({ projectId: uuid.optional(), customerId: uuid.optional(), employeeId: uuid.optional(), scope: z.enum(['project', 'customer', 'person', 'role', 'default']).optional() }), req.query);
    return asActor(actorOf(req), (tx) => listRates(tx, actorOf(req), q));
  });
  app.post('/bill-rates', async (req, reply) => {
    const b = parse(z.object({ scope: z.enum(['project', 'customer', 'person', 'role', 'default']), projectId: uuid.nullable().optional(), customerId: uuid.nullable().optional(), employeeId: uuid.nullable().optional(),
      role: z.string().max(80).nullable().optional(), amount: z.number().min(0).max(100000), effectiveFrom: day, note: z.string().max(500).nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createRate(tx, actorOf(req), b));
  });
  app.post('/bill-rates/:id/end', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ endOn: day }), req.body);
    await asActor(actorOf(req), (tx) => endRate(tx, actorOf(req), id, b.endOn));
    reply.status(204);
  });
  app.get('/bill-rates/explain', async (req) => {
    const q = parse(z.object({ projectId: uuid, employeeId: uuid, date: day.optional() }), req.query);
    return asActor(actorOf(req), (tx) => explainRate(tx, actorOf(req), q));
  });
  /** People a rate can be set for (billing staff need not hold the employee directory permission). */
  app.get('/bill-rates/people', async (req) => asActor(actorOf(req), async (tx) => {
    requirePermission(actorOf(req), 'billing.view');
    return many(tx, `SELECT id, employee_number, first_name || ' ' || last_name AS name, job_title FROM employee WHERE status = 'active' ORDER BY last_name, first_name`);
  }));
  app.get('/billing-settings', async (req) => asActor(actorOf(req), (tx) => viewSettings(tx, actorOf(req))));
  app.put('/billing-settings', async (req) => {
    const b = parse(z.object({ roundHoursTo: z.number().nullable().optional(), retainerIssueMode: z.enum(['draft', 'issue']).optional() }), req.body);
    return asActor(actorOf(req), (tx) => saveSettings(tx, actorOf(req), b));
  });

  // ---- Runs ----------------------------------------------------------------------------------------------------------------
  app.get('/billing-runs', async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'invoiced', 'closed', 'cancelled']).optional(), customerId: uuid.optional(), projectId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => listRuns(tx, actorOf(req), q));
  });
  app.post('/billing-runs', async (req, reply) => {
    const b = parse(z.object({ customerId: uuid, projectId: uuid.nullable().optional(), facilityId: uuid.nullable().optional(), periodFrom: day, periodTo: day, notes: z.string().max(1000).nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createRun(tx, actorOf(req), b));
  });
  app.get('/billing-runs/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getRun(tx, actorOf(req), id)); });
  app.post('/billing-runs/:id/adjust', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ key: z.string().min(3).max(120), description: z.string().max(500).nullable().optional(), writedown: z.number().min(0).optional(), writeOff: z.boolean().optional(),
      reason: z.string().max(500).nullable().optional(), clear: z.boolean().optional() }), req.body);
    await asActor(actorOf(req), (tx) => adjustLine(tx, actorOf(req), id, b));
    reply.status(204);
  });
  app.post('/billing-runs/:id/invoice', async (req, reply) => {
    const { id } = parse(Id, req.params);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createDraftInvoice(tx, actorOf(req), id));
  });
  app.post('/billing-runs/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    await asActor(actorOf(req), (tx) => cancelRun(tx, actorOf(req), id, b.reason));
    reply.status(204);
  });
  app.get('/billing-wip', async (req) => {
    const q = parse(z.object({ customerId: uuid.optional(), projectId: uuid.optional(), facilityId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => unbilledWork(tx, actorOf(req), q));
  });
  /** Projects that can be billed (until the projects module has its own list endpoint for billing staff). */
  app.get('/billing-projects', async (req) => asActor(actorOf(req), async (tx) => {
    const a = actorOf(req);
    requirePermission(a, 'billing.view');
    const q = parse(z.object({ customerId: uuid.optional() }), req.query);
    const f = facilitiesWith(a, 'billing.view');
    const rows = await many(tx, `SELECT p.id, p.number, p.name, p.status, p.billing_type, p.customer_id, c.name AS customer_name, p.facility_id FROM project p LEFT JOIN customer c ON c.id = p.customer_id
      WHERE ($1::uuid IS NULL OR p.customer_id = $1) ORDER BY p.number`, [q.customerId ?? null]);
    return rows.filter((r) => f.all || f.ids.includes(r.facility_id));
  }));

  // ---- Holds and write-offs ----------------------------------------------------------------------------------------------------
  app.post('/billing-holds', async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(['time', 'expense', 'milestone']), sourceId: uuid, reason: z.string().min(3).max(500) }), req.body);
    await asActor(actorOf(req), (tx) => holdEntry(tx, actorOf(req), b));
    reply.status(204);
  });
  app.post('/billing-holds/release', async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(['time', 'expense', 'milestone']), sourceId: uuid }), req.body);
    await asActor(actorOf(req), (tx) => releaseHold(tx, actorOf(req), b));
    reply.status(204);
  });
  app.post('/billing-holds/restore-writeoff', async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(['time', 'expense', 'milestone', 'percent']), sourceId: uuid, reason: z.string().min(3).max(500) }), req.body);
    await asActor(actorOf(req), (tx) => restoreWriteOff(tx, actorOf(req), b));
    reply.status(204);
  });

  // ---- Fixed price ---------------------------------------------------------------------------------------------------------------
  app.get('/billing-contracts/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getBillableContract(tx, actorOf(req), id)); });
  app.put('/billing-contracts/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ contractValue: z.number().min(0), method: z.enum(['milestone', 'percent_complete']), percentComplete: z.number().min(0).max(100).optional() }), req.body);
    return asActor(actorOf(req), (tx) => setTerms(tx, actorOf(req), id, b));
  });
  app.post('/billing-contracts/:id/milestones', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(120), amount: z.number().positive(), dueDate: day.nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => addMilestone(tx, actorOf(req), id, b));
  });
  app.post('/billing-milestones/:id/reach', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reachedOn: day }), req.body);
    await asActor(actorOf(req), (tx) => reachMilestone(tx, actorOf(req), id, b));
    reply.status(204);
  });
  app.post('/billing-milestones/:id/reopen', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    await asActor(actorOf(req), (tx) => reopenMilestone(tx, actorOf(req), id, b.reason));
    reply.status(204);
  });
}
