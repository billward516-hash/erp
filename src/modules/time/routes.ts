import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  addEntry, createPayrollExport, decideTimesheet, downloadPayrollExport, getOrCreateTimesheet, getTimesheet, listEarningCodes, listPayrollExports,
  myTimesheets, payrollPreview, removeEntry, reopenTimesheet, setEarningCode, submitTimesheet, teamWeek, timesheetProjectOptions,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const day = z.string().date();

export async function timeRoutes(app: FastifyInstance) {
  app.get('/timesheets/mine', async (req) => asActor(actorOf(req), (tx) => myTimesheets(tx, actorOf(req))));
  /** Opens (creating if needed) the timesheet for an employee (default: me) and week. */
  app.post('/timesheets/open', async (req) => {
    const b = parse(z.object({ employeeId: z.string().uuid().optional(), weekStart: day }), req.body);
    return asActor(actorOf(req), async (tx) => getTimesheet(tx, actorOf(req), (await getOrCreateTimesheet(tx, actorOf(req), b)).id));
  });
  app.get('/timesheets/team', async (req) => {
    const q = parse(z.object({ weekStart: day }), req.query);
    return asActor(actorOf(req), (tx) => teamWeek(tx, actorOf(req), q.weekStart));
  });
  app.get('/timesheets/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getTimesheet(tx, actorOf(req), id)); });
  app.post('/timesheets/:id/entries', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ workDate: day, earningCode: z.string().min(1).max(20), hours: z.number().positive().max(24), note: z.string().max(500).nullable().optional(),
      projectId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(), billable: z.boolean().nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => addEntry(tx, actorOf(req), id, b));
  });
  app.get('/timesheets/:id/project-options', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => timesheetProjectOptions(tx, actorOf(req), id)); });
  app.delete('/time-entries/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await asActor(actorOf(req), (tx) => removeEntry(tx, actorOf(req), id));
    reply.status(204);
  });
  app.post('/timesheets/:id/submit', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => submitTimesheet(tx, actorOf(req), id)); });
  app.post('/timesheets/:id/decide', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(1000).nullable().optional() }), req.body);
    await asActor(actorOf(req), (tx) => decideTimesheet(tx, actorOf(req), id, b));
    reply.status(204);
  });
  app.post('/timesheets/:id/reopen', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body);
    await asActor(actorOf(req), (tx) => reopenTimesheet(tx, actorOf(req), id, b.reason));
    reply.status(204);
  });
  app.get('/earning-codes', async (req) => asActor(actorOf(req), (tx) => listEarningCodes(tx)));
  app.patch('/earning-codes/:code', async (req) => {
    const { code } = parse(z.object({ code: z.string().min(1).max(20) }), req.params);
    const b = parse(z.object({ externalCode: z.string().max(40).nullable().optional(), label: z.string().min(1).max(100).optional(), active: z.boolean().optional() }), req.body);
    return asActor(actorOf(req), (tx) => setEarningCode(tx, actorOf(req), code, b));
  });
  app.get('/payroll/preview', async (req) => {
    const q = parse(z.object({ from: day, to: day }), req.query);
    return asActor(actorOf(req), (tx) => payrollPreview(tx, actorOf(req), q));
  });
  app.get('/payroll/exports', async (req) => asActor(actorOf(req), (tx) => listPayrollExports(tx, actorOf(req))));
  app.post('/payroll/exports', async (req, reply) => {
    const b = parse(z.object({ from: day, to: day, layout: z.enum(['summary', 'daily']).optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createPayrollExport(tx, actorOf(req), b));
  });
  app.get('/payroll/exports/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const x = await asActor(actorOf(req), (tx) => downloadPayrollExport(tx, actorOf(req), id));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${x.file_name}"`);
    return x.content;
  });
}
