import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool, sendFile } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { ATTACHMENT_MIME } from '../quality/attachments.js';
import { publicTicketForm, submitPublicTicket } from './public.js';
import {
  CHANNELS, PRIORITIES, STATUSES, addEntry, addTicketFile, assignMany, assignTicket, changeStatus, createTicket, customerContacts, getTicket, linkOptions, listTickets, logTime, lookups, removeTime,
  searchCustomers, ticketFile, updateTicket,
} from './service.js';
import {
  addHoliday, createIntakeLink, getCalendar, listCannedReplies, listCategories, listIntakeLinks, listServiceLevels, removeHoliday, revokeIntakeLink, saveCalendar, saveCannedReply, saveCategory,
  saveServiceLevel,
} from './setup.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const priority = z.enum(PRIORITIES);
const status = z.enum(STATUSES);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The signed-in API. Everything is under /api/tickets so the feature switch and the edition cover it as one area. */
export const ticketRoutes = (blobs: BlobStore) => async (app: FastifyInstance) => {
  const run = <T>(req: any, fn: (tx: any, actor: any) => Promise<T>) => asActor(actorOf(req), (tx) => fn(tx, actorOf(req)));

  app.get('/tickets', async (req) => {
    const q = parse(z.object({ view: z.enum(['open', 'mine', 'unassigned', 'breached', 'at_risk', 'waiting', 'all']).optional(), status: status.optional(), priority: priority.optional(), customerId: uuid.optional(),
      assigneeId: uuid.optional(), facilityId: uuid.optional(), q: z.string().max(100).optional(), sort: z.enum(['due', 'priority', 'created', 'updated', 'number']).optional(), dir: z.enum(['asc', 'desc']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional() }), req.query);
    return run(req, (tx, a) => listTickets(tx, a, q));
  });
  const input = z.object({ facilityId: uuid, customerId: uuid, contactId: uuid.nullable().optional(), subject: z.string().min(1).max(300), description: z.string().max(20000).nullable().optional(),
    priority: priority.optional(), categoryId: uuid.nullable().optional(), channel: z.enum(CHANNELS).optional(), assigneeUserId: uuid.nullable().optional(), projectId: uuid.nullable().optional(),
    assetId: uuid.nullable().optional(), workOrderId: uuid.nullable().optional(), serviceVisitId: uuid.nullable().optional(), retainerCovered: z.boolean().optional(),
    requesterName: z.string().max(200).nullable().optional(), requesterContact: z.string().max(200).nullable().optional() });
  app.post('/tickets', async (req, reply) => { const b = parse(input, req.body); reply.status(201); return run(req, (tx, a) => createTicket(tx, a, b)); });

  // Lookups and setup first: fixed paths sit beside /tickets/:id
  app.get('/tickets/lookups', async (req) => { const q = parse(z.object({ facilityId: uuid.optional() }), req.query); return run(req, (tx, a) => lookups(tx, a, q.facilityId)); });
  app.get('/tickets/customers', async (req) => { const q = parse(z.object({ q: z.string().max(100).optional() }), req.query); return run(req, (tx, a) => searchCustomers(tx, a, q.q)); });
  app.get('/tickets/customers/:id/contacts', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => customerContacts(tx, a, id)); });
  app.get('/tickets/link-options', async (req) => { const q = parse(z.object({ facilityId: uuid, customerId: uuid }), req.query); return run(req, (tx, a) => linkOptions(tx, a, q)); });
  app.post('/tickets/assign', async (req) => {
    const b = parse(z.object({ ids: z.array(uuid).min(1).max(100), assigneeUserId: uuid.nullable() }), req.body);
    return run(req, (tx, a) => assignMany(tx, a, b.ids, b.assigneeUserId));
  });

  app.get('/tickets/service-levels', async (req) => run(req, (tx, a) => listServiceLevels(tx, a)));
  const level = z.object({ name: z.string().min(1).max(100), priority, customerId: uuid.nullable().optional(), firstResponseMinutes: z.number().int().positive().nullable().optional(),
    resolutionMinutes: z.number().int().positive().nullable().optional(), atRiskPct: z.number().int().min(1).max(99).optional(), active: z.boolean().optional() });
  app.post('/tickets/service-levels', async (req, reply) => { const b = parse(level, req.body); reply.status(201); return run(req, (tx, a) => saveServiceLevel(tx, a, b)); });
  app.put('/tickets/service-levels/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(level, req.body); return run(req, (tx, a) => saveServiceLevel(tx, a, { ...b, id })); });

  app.get('/tickets/calendars/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getCalendar(tx, a, id)); });
  app.put('/tickets/calendars/:id', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ timeZone: z.string().min(1).max(60), days: z.record(z.array(z.string()).length(2).nullable()) }), req.body);
    return run(req, (tx, a) => saveCalendar(tx, a, id, b));
  });
  app.post('/tickets/holidays', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid.nullable(), day, name: z.string().min(1).max(100) }), req.body);
    reply.status(201); return run(req, (tx, a) => addHoliday(tx, a, b));
  });
  app.delete('/tickets/holidays/:id', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => removeHoliday(tx, a, id)); reply.status(204); });

  app.get('/tickets/categories', async (req) => run(req, (tx, a) => listCategories(tx, a)));
  const category = z.object({ name: z.string().min(1).max(100), sortNo: z.number().int().optional(), active: z.boolean().optional() });
  app.post('/tickets/categories', async (req, reply) => { const b = parse(category, req.body); reply.status(201); return run(req, (tx, a) => saveCategory(tx, a, b)); });
  app.put('/tickets/categories/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(category, req.body); return run(req, (tx, a) => saveCategory(tx, a, { ...b, id })); });

  app.get('/tickets/canned-replies', async (req) => run(req, (tx, a) => listCannedReplies(tx, a)));
  const canned = z.object({ title: z.string().min(1).max(100), body: z.string().min(1).max(5000), active: z.boolean().optional() });
  app.post('/tickets/canned-replies', async (req, reply) => { const b = parse(canned, req.body); reply.status(201); return run(req, (tx, a) => saveCannedReply(tx, a, b)); });
  app.put('/tickets/canned-replies/:id', async (req) => { const { id } = parse(Id, req.params); const b = parse(canned, req.body); return run(req, (tx, a) => saveCannedReply(tx, a, { ...b, id })); });

  app.get('/tickets/intake-links', async (req) => { const q = parse(z.object({ facilityId: uuid }), req.query); return run(req, (tx, a) => listIntakeLinks(tx, a, q.facilityId)); });
  app.post('/tickets/intake-links', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, customerId: uuid, label: z.string().min(1).max(200) }), req.body);
    reply.status(201); return run(req, (tx, a) => createIntakeLink(tx, a, b));
  });
  app.post('/tickets/intake-links/:id/revoke', async (req, reply) => { const { id } = parse(Id, req.params); await run(req, (tx, a) => revokeIntakeLink(tx, a, id)); reply.status(204); });

  // One ticket
  app.get('/tickets/:id', async (req) => { const { id } = parse(Id, req.params); return run(req, (tx, a) => getTicket(tx, a, id)); });
  app.patch('/tickets/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(input.pick({ subject: true, description: true, priority: true, categoryId: true, contactId: true, projectId: true, assetId: true, workOrderId: true, serviceVisitId: true, retainerCovered: true }).partial(), req.body);
    return run(req, (tx, a) => updateTicket(tx, a, id, b));
  });
  app.post('/tickets/:id/status', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ status, note: z.string().max(2000).nullable().optional() }), req.body);
    return run(req, (tx, a) => changeStatus(tx, a, id, b));
  });
  app.post('/tickets/:id/entries', async (req, reply) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ kind: z.enum(['reply', 'note', 'customer_reply']), body: z.string().min(1).max(20000), statusAfter: status.optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => addEntry(tx, a, id, b));
  });
  app.post('/tickets/:id/assign', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ assigneeUserId: uuid.nullable() }), req.body);
    return run(req, (tx, a) => assignTicket(tx, a, id, b.assigneeUserId));
  });
  app.post('/tickets/:id/time', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ hours: z.number().positive().max(24), workDate: day.optional(), note: z.string().max(500).nullable().optional(), billable: qbool.optional(), projectTaskId: uuid.nullable().optional() }), req.body);
    reply.status(201); return run(req, (tx, a) => logTime(tx, a, id, b));
  });
  app.delete('/tickets/:id/time/:timeId', async (req, reply) => {
    const { id, timeId } = parse(z.object({ id: uuid, timeId: uuid }), req.params);
    await run(req, (tx, a) => removeTime(tx, a, id, timeId)); reply.status(204);
  });
  app.post('/tickets/:id/files', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ fileName: z.string().min(1).max(255), mime: z.enum(ATTACHMENT_MIME as [string, ...string[]]), contentBase64: z.string().min(1) }), req.body);
    reply.status(201); return run(req, (tx, a) => addTicketFile(tx, a, blobs, id, { fileName: b.fileName, mime: b.mime, content: Buffer.from(b.contentBase64, 'base64') }));
  });
  app.get('/tickets/:id/files/:fileId', async (req, reply) => {
    const { id, fileId } = parse(z.object({ id: uuid, fileId: uuid }), req.params);
    const f = await run(req, (tx, a) => ticketFile(tx, a, blobs, id, fileId));
    return sendFile(reply, { contentType: f.mime, fileName: f.name, body: f.content }, true);
  });
};

/** No sign-in: the link token is the only credential and opens only its own customer's ticket form. */
export async function ticketPublicRoutes(app: FastifyInstance) {
  const Token = z.object({ token: z.string().min(10).max(100) });
  app.get('/public/tickets/:token', async (req) => { const { token } = parse(Token, req.params); return publicTicketForm(token); });
  app.post('/public/tickets/:token', async (req, reply) => {
    const { token } = parse(Token, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(200), contact: z.string().min(3).max(200), subject: z.string().min(1).max(300), description: z.string().min(5).max(4000),
      categoryId: uuid.nullable().optional(), urgent: z.boolean().optional() }), req.body);
    reply.status(201);
    return submitPublicTicket(token, b);
  });
}
