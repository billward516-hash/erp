import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import {
  assignmentHistory, cancelTimeOff, createAssignment, createHoliday, decideTimeOff, deleteHoliday, deletePattern, deleteTarget, getSettings, listAssignments, listHolidays,
  listTargets, listTimeOff, projectOptions, overview, personDetail, previewAssignment, projectDetail, removeAssignment, requestTimeOff, saveSettings, savePattern, saveTarget, setTracking,
  updateAssignment, utilizationView, visiblePeople,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const hours7 = z.array(z.number().min(0).max(24)).length(7);
const assignmentBody = z.object({
  projectId: uuid, employeeId: uuid, role: z.string().max(100).nullable().optional(), hoursPerWeek: z.number().positive().max(168), startDate: day, endDate: day,
  billable: z.boolean().optional(), state: z.enum(['tentative', 'confirmed']).optional(), note: z.string().max(1000).nullable().optional(), overrideReason: z.string().max(500).nullable().optional(),
});

export async function staffingRoutes(app: FastifyInstance) {
  const run = <T>(req: unknown, fn: (tx: Tx, actor: Actor) => Promise<T>) => asActor(actorOf(req as never), (tx) => fn(tx, actorOf(req as never)));

  app.get('/staffing/overview', async (req) => {
    const q = parse(z.object({ from: day.optional(), weeks: z.coerce.number().int().min(1).max(26).optional(), facilityId: uuid.optional(), departmentId: uuid.optional(), managerId: uuid.optional(), projectId: uuid.optional() }), req.query);
    return run(req, (tx, a) => overview(tx, a, q));
  });
  app.get('/staffing/people', async (req) => run(req, (tx, a) => visiblePeople(tx, a)));
  app.get('/staffing/people/:id', async (req) => {
    const { id } = parse(Id, req.params); const q = parse(z.object({ from: day.optional(), weeks: z.coerce.number().int().min(1).max(26).optional() }), req.query);
    return run(req, (tx, a) => personDetail(tx, a, id, q));
  });
  app.put('/staffing/people/:id/tracking', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ staffed: z.boolean(), reason: z.string().max(300).nullable().optional() }), req.body);
    await run(req, (tx, a) => setTracking(tx, a, id, b)); reply.status(204);
  });
  app.get('/staffing/project-options', async (req) => run(req, (tx, a) => projectOptions(tx, a)));
  app.get('/staffing/projects/:id', async (req) => {
    const { id } = parse(Id, req.params); const q = parse(z.object({ from: day.optional(), weeks: z.coerce.number().int().min(1).max(26).optional() }), req.query);
    return run(req, (tx, a) => projectDetail(tx, a, id, q));
  });

  app.get('/staffing/assignments', async (req) => {
    const q = parse(z.object({ employeeId: uuid.optional(), projectId: uuid.optional(), includePast: qbool.optional(), includeRemoved: qbool.optional() }), req.query);
    return run(req, (tx, a) => listAssignments(tx, a, q));
  });
  app.post('/staffing/assignments/preview', async (req) => {
    const b = parse(assignmentBody.extend({ assignmentId: uuid.optional() }), req.body);
    return run(req, (tx, a) => previewAssignment(tx, a, b, b.assignmentId));
  });
  app.post('/staffing/assignments', async (req, reply) => {
    const b = parse(assignmentBody, req.body); reply.status(201);
    return run(req, (tx, a) => createAssignment(tx, a, b));
  });
  app.patch('/staffing/assignments/:id', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(assignmentBody.partial(), req.body);
    return run(req, (tx, a) => updateAssignment(tx, a, id, b));
  });
  app.delete('/staffing/assignments/:id', async (req, reply) => {
    const { id } = parse(Id, req.params); const q = parse(z.object({ reason: z.string().max(500).optional() }), req.query);
    await run(req, (tx, a) => removeAssignment(tx, a, id, q.reason)); reply.status(204);
  });
  app.get('/staffing/assignments/:id/history', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => assignmentHistory(tx, a, id)); });

  app.get('/staffing/settings', async (req) => run(req, async (tx, a) => { await visiblePeople(tx, a); return getSettings(tx); }));
  app.put('/staffing/settings', async (req) => {
    const b = parse(z.object({ defaultHours: hours7.optional(), targetPct: z.number().min(0).max(100).optional(), benchPct: z.number().min(0).max(100).optional(), toleranceH: z.number().min(0).max(20).optional() }), req.body);
    return run(req, (tx, a) => saveSettings(tx, a, b));
  });
  app.post('/staffing/patterns', async (req, reply) => {
    const b = parse(z.object({ employeeId: uuid, effectiveFrom: day, hours: hours7, note: z.string().max(300).nullable().optional() }), req.body); reply.status(201);
    return run(req, (tx, a) => savePattern(tx, a, b));
  });
  app.delete('/staffing/patterns/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deletePattern(tx, a, id)); reply.status(204); });

  app.get('/staffing/holidays', async (req) => { const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query); return run(req, (tx, a) => listHolidays(tx, a, q)); });
  app.post('/staffing/holidays', async (req, reply) => {
    const b = parse(z.object({ date: day, name: z.string().min(1).max(100), facilityId: uuid.nullable().optional(), hoursOff: z.number().positive().max(24).nullable().optional() }), req.body); reply.status(201);
    return run(req, (tx, a) => createHoliday(tx, a, b));
  });
  app.delete('/staffing/holidays/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteHoliday(tx, a, id)); reply.status(204); });

  app.get('/staffing/time-off', async (req) => {
    const q = parse(z.object({ employeeId: uuid.optional(), status: z.enum(['requested', 'approved', 'rejected', 'cancelled']).optional(), from: day.optional(), to: day.optional() }), req.query);
    return run(req, (tx, a) => listTimeOff(tx, a, q));
  });
  app.post('/staffing/time-off', async (req, reply) => {
    const b = parse(z.object({ employeeId: uuid.optional(), fromDate: day, toDate: day, hoursPerDay: z.number().positive().max(24).nullable().optional(),
      kind: z.enum(['vacation', 'sick', 'personal', 'training', 'other']).optional(), note: z.string().max(500).nullable().optional() }), req.body); reply.status(201);
    return run(req, (tx, a) => requestTimeOff(tx, a, b));
  });
  app.post('/staffing/time-off/:id/decide', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(500).nullable().optional() }), req.body);
    return run(req, (tx, a) => decideTimeOff(tx, a, id, b));
  });
  app.post('/staffing/time-off/:id/cancel', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => cancelTimeOff(tx, a, id)); });

  app.get('/staffing/targets', async (req) => run(req, (tx, a) => listTargets(tx, a)));
  app.put('/staffing/targets', async (req) => {
    const b = parse(z.object({ employeeId: uuid.optional(), jobTitle: z.string().min(1).max(100).optional(), targetPct: z.number().min(0).max(100) }), req.body);
    return run(req, (tx, a) => saveTarget(tx, a, b));
  });
  app.delete('/staffing/targets/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteTarget(tx, a, id)); reply.status(204); });

  app.get('/staffing/utilization', async (req) => {
    const q = parse(z.object({ from: day.optional(), to: day.optional(), by: z.enum(['person', 'department', 'manager', 'site', 'role']).optional(), facilityId: uuid.optional() }), req.query);
    return run(req, (tx, a) => utilizationView(tx, a, q));
  });
}
