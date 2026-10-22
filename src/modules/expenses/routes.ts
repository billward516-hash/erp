import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import {
  attachReceipt, cancelReport, createReport, deleteLine, getReport, listDepartments, listReports, listRules, markPaid, receiptFile, reviseReport, saveLine, saveRule,
  setDepartmentHead, submitReport, withdrawReport,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();

export const expenseRoutes = (blobs: BlobStore) => async (app: FastifyInstance) => {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));
  const done = (reply: any) => reply.status(204);
  app.get('/expenses', async (req) => { const q = parse(z.object({ scope: z.enum(['mine', 'all']).optional(), status: z.string().max(20).optional() }), req.query); return run(req, (tx, a) => listReports(tx, a, q)); });
  app.post('/expenses', async (req, reply) => {
    const b = parse(z.object({ title: z.string().min(2).max(200), purpose: z.string().max(1000).nullable().optional(), facilityId: uuid.nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => createReport(tx, a, b));
  });
  app.get('/expenses/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getReport(tx, a, id)); });
  app.post('/expenses/:id/lines', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ id: uuid.optional(), spentOn: day, categoryId: uuid, merchant: z.string().max(200).nullable().optional(), description: z.string().max(1000).nullable().optional(),
      amount: z.number().min(0).max(1_000_000).nullable().optional(), miles: z.number().positive().max(10_000).nullable().optional(), attendees: z.string().max(1000).nullable().optional(),
      explanation: z.string().max(1000).nullable().optional() }), req.body);
    return run(req, (tx, a) => saveLine(tx, a, id, b));
  });
  app.delete('/expense-lines/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => deleteLine(tx, a, id)); done(reply); });
  app.post('/expense-lines/:id/receipt', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ fileName: z.string().min(1).max(255), mime: z.string().max(100), contentBase64: z.string().min(1) }), req.body);
    return run(req, (tx, a) => attachReceipt(tx, a, blobs, id, { fileName: b.fileName, mime: b.mime, content: Buffer.from(b.contentBase64, 'base64') }));
  });
  app.get('/expense-lines/:id/receipt', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const f = await run(req, (tx, a) => receiptFile(tx, a, blobs, id));
    reply.header('content-type', f.mime).header('content-disposition', `inline; filename="${f.name}"`);
    return f.content;
  });
  app.post('/expenses/:id/submit', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => submitReport(tx, a, id)); });
  app.post('/expenses/:id/withdraw', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => withdrawReport(tx, a, id)); done(reply); });
  app.post('/expenses/:id/revise', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => reviseReport(tx, a, id)); done(reply); });
  app.post('/expenses/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body); await run(req, (tx, a) => cancelReport(tx, a, id, b.reason)); done(reply); });
  app.post('/expenses/:id/paid', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ paidOn: day, method: z.enum(['payroll', 'direct_deposit', 'check', 'other']), reference: z.string().max(200).nullable().optional(), bankAccountId: uuid.nullable().optional() }), req.body);
    await run(req, (tx, a) => markPaid(tx, a, id, b)); done(reply);
  });
  app.get('/expense-rules', async (req) => run(req, (tx) => listRules(tx)));
  app.post('/expense-rules', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), facilityId: uuid.nullable().optional(), departmentId: uuid.nullable().optional(), minAmount: z.number().min(0).max(10_000_000),
      stage: z.number().int().min(1).max(9), approver: z.enum(['department_head', 'role']), roleKey: z.string().min(1).max(60), label: z.string().min(2).max(100), active: z.boolean().optional() }), req.body);
    return run(req, (tx, a) => saveRule(tx, a, b));
  });
  app.get('/departments', async (req) => run(req, (tx) => listDepartments(tx)));
  app.put('/departments/:id/head', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ userId: uuid.nullable() }), req.body); await run(req, (tx, a) => setDepartmentHead(tx, a, id, b.userId)); done(reply); });
};
