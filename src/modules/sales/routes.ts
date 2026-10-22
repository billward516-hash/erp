import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import {
  acceptQuote, cancelOrder, createQuote, declineQuote, getOrder, getQuote, listItems, listOrders, listQuotes, quotePreviewPdf, quoteSentPdf, reviseQuote, saveItem,
  sendQuote, setPromisedDate, shipOrder, submitQuote, updateQuote,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const line = z.object({ itemId: uuid.nullable().optional(), description: z.string().max(1000).nullable().optional(), qty: z.number().positive(), unitPrice: z.number().nonnegative().nullable().optional(), uom: z.string().max(20).nullable().optional() });
const reason = z.object({ reason: z.string().min(3).max(1000) });

export function salesRoutes(blobs: BlobStore) {
  return async (app: FastifyInstance) => {
    app.get('/sales-items', async (req) => asActor(actorOf(req), (tx) => listItems(tx, actorOf(req))));
    app.post('/sales-items', async (req) => {
      const b = parse(z.object({ id: uuid.optional(), code: z.string().min(1).max(40), description: z.string().min(1).max(500), kind: z.enum(['product', 'service']).optional(), uom: z.string().max(20).optional(),
        listPrice: z.number().nonnegative().nullable().optional(), unitCost: z.number().nonnegative().nullable().optional(), partId: uuid.nullable().optional(), active: z.boolean().optional() }), req.body);
      return asActor(actorOf(req), (tx) => saveItem(tx, actorOf(req), b));
    });
    app.get('/quotes', async (req) => {
      const q = parse(z.object({ status: z.string().optional(), customerId: uuid.optional(), open: z.coerce.boolean().optional() }), req.query);
      return asActor(actorOf(req), (tx) => listQuotes(tx, actorOf(req), q));
    });
    app.post('/quotes', async (req, reply) => {
      const b = parse(z.object({ facilityId: uuid, customerId: uuid, contactId: uuid.nullable().optional(), opportunityId: uuid.nullable().optional(), title: z.string().min(3).max(200),
        validUntil: z.string().date().nullable().optional(), paymentTerms: z.string().max(100).nullable().optional(), notes: z.string().max(4000).nullable().optional(), lines: z.array(line).min(1).max(200) }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => createQuote(tx, actorOf(req), b));
    });
    app.get('/quotes/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getQuote(tx, actorOf(req), id)); });
    app.patch('/quotes/:id', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ title: z.string().min(3).max(200).optional(), contactId: uuid.nullable().optional(), validUntil: z.string().date().optional(), paymentTerms: z.string().max(100).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(), lines: z.array(line).min(1).max(200).optional() }), req.body);
      return asActor(actorOf(req), (tx) => updateQuote(tx, actorOf(req), id, b));
    });
    app.post('/quotes/:id/submit', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => submitQuote(tx, actorOf(req), id)); });
    app.post('/quotes/:id/send', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ sentTo: z.string().max(200).nullable().optional() }), req.body ?? {});
      return asActor(actorOf(req), (tx) => sendQuote(tx, actorOf(req), blobs, id, b));
    });
    app.post('/quotes/:id/revise', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(reason, req.body);
      await asActor(actorOf(req), (tx) => reviseQuote(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
    app.post('/quotes/:id/accept', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ customerPo: z.string().max(60).nullable().optional(), requestedDate: z.string().date().nullable().optional() }), req.body ?? {});
      reply.status(201);
      return asActor(actorOf(req), (tx) => acceptQuote(tx, actorOf(req), id, b));
    });
    app.post('/quotes/:id/decline', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(reason, req.body);
      await asActor(actorOf(req), (tx) => declineQuote(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
    app.get('/quotes/:id/pdf', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const q = parse(z.object({ revision: z.coerce.number().int().positive().optional(), preview: z.coerce.boolean().optional() }), req.query);
      if (q.preview) {
        const pdf = await asActor(actorOf(req), (tx) => quotePreviewPdf(tx, actorOf(req), id));
        reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="quote-preview.pdf"');
        return pdf;
      }
      const f = await asActor(actorOf(req), (tx) => quoteSentPdf(tx, actorOf(req), blobs, id, q.revision));
      reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${f.name}"`);
      return f.content;
    });
    app.get('/sales-orders', async (req) => {
      const q = parse(z.object({ open: z.coerce.boolean().optional(), customerId: uuid.optional() }), req.query);
      return asActor(actorOf(req), (tx) => listOrders(tx, actorOf(req), q));
    });
    app.get('/sales-orders/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getOrder(tx, actorOf(req), id)); });
    app.post('/sales-orders/:id/promise', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ promisedDate: z.string().date() }), req.body);
      await asActor(actorOf(req), (tx) => setPromisedDate(tx, actorOf(req), id, b.promisedDate));
      reply.status(204);
    });
    app.post('/sales-orders/:id/ship', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ shippedOn: z.string().date().optional(), carrier: z.string().max(100).nullable().optional(), tracking: z.string().max(100).nullable().optional(),
        lines: z.array(z.object({ orderLineId: uuid, qty: z.number().nonnegative(), locationId: uuid.nullable().optional() })).min(1) }), req.body);
      return asActor(actorOf(req), (tx) => shipOrder(tx, actorOf(req), id, b));
    });
    app.post('/sales-orders/:id/cancel', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(reason, req.body);
      await asActor(actorOf(req), (tx) => cancelOrder(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
  };
}
