import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import { acknowledge, addRecipient, cancelNotice, closeNotice, createNotice, getNotice, issueNotice, listNotices, markSent, NOTICE_KINDS, noticePdf, removeRecipient, updateNotice } from './notices.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const recipient = z.object({ partyType: z.enum(['user', 'customer', 'supplier', 'other']), userId: uuid.nullable().optional(), customerId: uuid.nullable().optional(), supplierId: uuid.nullable().optional(),
  name: z.string().max(200).nullable().optional(), email: z.string().max(200).nullable().optional(), requiresAck: z.boolean().optional() });

/** Change notices (SC-006 B): ECN and similar, with a tracked distribution list. */
export async function noticeRoutes(app: FastifyInstance) {
  app.get('/change-notices', async (req) => {
    const q = parse(z.object({ status: z.enum(['draft', 'issued', 'closed', 'cancelled']).optional(), kind: z.enum(NOTICE_KINDS).optional(), outstanding: qbool.optional(), mine: qbool.optional(), changeId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => listNotices(tx, actorOf(req), q));
  });
  app.post('/change-notices', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, kind: z.enum(NOTICE_KINDS), title: z.string().min(3).max(200), summary: z.string().min(3).max(4000), whatChanged: z.string().max(8000).nullable().optional(),
      effectiveOn: z.string().date().nullable().optional(), ackDueOn: z.string().date().nullable().optional(), changeId: uuid.nullable().optional(), documentId: uuid.nullable().optional(), partId: uuid.nullable().optional(),
      ownerUserId: uuid.nullable().optional(), recipients: z.array(recipient).max(200).optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createNotice(tx, actorOf(req), b));
  });
  app.get('/change-notices/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getNotice(tx, actorOf(req), id)); });
  app.patch('/change-notices/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ title: z.string().min(3).max(200).optional(), summary: z.string().min(3).max(4000).optional(), whatChanged: z.string().max(8000).nullable().optional(),
      effectiveOn: z.string().date().nullable().optional(), ackDueOn: z.string().date().nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => updateNotice(tx, actorOf(req), id, b));
  });
  app.post('/change-notices/:id/recipients', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(recipient, req.body); reply.status(201); return asActor(actorOf(req), (tx) => addRecipient(tx, actorOf(req), id, b)); });
  app.delete('/change-notices/:id/recipients/:rid', async (req, reply) => { const p = parse(z.object({ id: uuid, rid: uuid }), req.params); await asActor(actorOf(req), (tx) => removeRecipient(tx, actorOf(req), p.id, p.rid)); reply.status(204); });
  app.post('/change-notices/:id/issue', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => issueNotice(tx, actorOf(req), id)); });
  app.post('/change-notices/:id/recipients/:rid/sent', async (req, reply) => {
    const p = parse(z.object({ id: uuid, rid: uuid }), req.params); const b = parse(z.object({ sentOn: z.string().date().nullable().optional() }), req.body ?? {});
    await asActor(actorOf(req), (tx) => markSent(tx, actorOf(req), p.id, p.rid, b)); reply.status(204);
  });
  app.post('/change-notices/:id/recipients/:rid/acknowledge', async (req, reply) => {
    const p = parse(z.object({ id: uuid, rid: uuid }), req.params);
    const b = parse(z.object({ method: z.enum(['in_app', 'email', 'phone', 'signed', 'other']).optional(), byName: z.string().max(200).nullable().optional(), on: z.string().date().nullable().optional(), note: z.string().max(1000).nullable().optional() }), req.body ?? {});
    await asActor(actorOf(req), (tx) => acknowledge(tx, actorOf(req), p.id, p.rid, b)); reply.status(204);
  });
  app.post('/change-notices/:id/close', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().max(1000).nullable().optional() }), req.body ?? {}); return asActor(actorOf(req), (tx) => closeNotice(tx, actorOf(req), id, b.note)); });
  app.post('/change-notices/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body); await asActor(actorOf(req), (tx) => cancelNotice(tx, actorOf(req), id, b.reason)); reply.status(204); });
  app.get('/change-notices/:id/pdf', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const pdf = await asActor(actorOf(req), (tx) => noticePdf(tx, actorOf(req), id));
    reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="change-notice.pdf"');
    return pdf;
  });
}

/** Temporary changes to a procedure (SC-006 C). */
import { cancelTempChange, createTempChange, getTempChange, listTempChanges, makePermanent, requestExtension, revertTempChange, submitTempChange } from './temp-changes.js';
export async function tempChangeRoutes(app: FastifyInstance) {
  app.get('/temporary-changes', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), live: qbool.optional(), documentId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => listTempChanges(tx, actorOf(req), q));
  });
  app.post('/temporary-changes', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, documentId: uuid, title: z.string().min(3).max(200), whatChanges: z.string().min(10).max(8000), reason: z.string().min(5).max(4000),
      startsOn: z.string().date(), expiresOn: z.string().date(), ownerUserId: uuid.nullable().optional(), changeId: uuid.nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createTempChange(tx, actorOf(req), b));
  });
  app.get('/temporary-changes/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getTempChange(tx, actorOf(req), id)); });
  app.post('/temporary-changes/:id/submit', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ approverId: uuid }), req.body); return asActor(actorOf(req), (tx) => submitTempChange(tx, actorOf(req), id, b)); });
  app.post('/temporary-changes/:id/extend', async (req) => {
    const { id } = parse(Id, req.params); const b = parse(z.object({ newExpiresOn: z.string().date(), reason: z.string().min(5).max(2000), approverId: uuid }), req.body);
    return asActor(actorOf(req), (tx) => requestExtension(tx, actorOf(req), id, b));
  });
  app.post('/temporary-changes/:id/revert', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ note: z.string().min(5).max(2000) }), req.body); return asActor(actorOf(req), (tx) => revertTempChange(tx, actorOf(req), id, b.note)); });
  app.post('/temporary-changes/:id/make-permanent', async (req) => { const { id } = parse(Id, req.params); const b = parse(z.object({ ownerUserId: uuid.nullable().optional() }), req.body ?? {}); return asActor(actorOf(req), (tx) => makePermanent(tx, actorOf(req), id, b)); });
  app.post('/temporary-changes/:id/cancel', async (req, reply) => { const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body); await asActor(actorOf(req), (tx) => cancelTempChange(tx, actorOf(req), id, b.reason)); reply.status(204); });
}
