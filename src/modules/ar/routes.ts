import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { releaseCreditHold } from '../sales/service.js';
import {
  collectionsQueue, customerAccount, draftInvoiceFromOrder, getInvoice, invoicePdf, issueInvoice, listInvoices, logCollection, recordPayment, sendPaymentReminder,
  toInvoice, updateDraft, voidInvoice,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();

export function arRoutes(blobs: BlobStore) {
  return async (app: FastifyInstance) => {
    app.get('/customer-invoices', async (req) => {
      const q = parse(z.object({ status: z.string().optional(), open: z.coerce.boolean().optional(), customerId: uuid.optional() }), req.query);
      return asActor(actorOf(req), (tx) => listInvoices(tx, actorOf(req), q));
    });
    app.get('/customer-invoices/to-invoice', async (req) => asActor(actorOf(req), (tx) => toInvoice(tx, actorOf(req))));
    app.post('/sales-orders/:id/invoice', async (req, reply) => {
      const { id } = parse(Id, req.params);
      reply.status(201);
      return asActor(actorOf(req), (tx) => draftInvoiceFromOrder(tx, actorOf(req), id));
    });
    app.post('/sales-orders/:id/release-credit', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ note: z.string().min(3).max(2000) }), req.body);
      await asActor(actorOf(req), (tx) => releaseCreditHold(tx, actorOf(req), id, b.note));
      reply.status(204);
    });
    app.get('/customer-invoices/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getInvoice(tx, actorOf(req), id)); });
    app.patch('/customer-invoices/:id', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ freightAmount: z.number().nonnegative().optional(), taxAmount: z.number().nonnegative().optional(), notes: z.string().max(4000).nullable().optional(),
        lines: z.array(z.object({ lineId: uuid, qty: z.number().nonnegative() })).max(200).optional() }), req.body);
      await asActor(actorOf(req), (tx) => updateDraft(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/customer-invoices/:id/issue', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ invoiceDate: day.optional() }), req.body ?? {});
      return asActor(actorOf(req), (tx) => issueInvoice(tx, actorOf(req), blobs, id, b));
    });
    app.post('/customer-invoices/:id/void', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().min(3).max(2000) }), req.body);
      await asActor(actorOf(req), (tx) => voidInvoice(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
    app.get('/customer-invoices/:id/pdf', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const f = await asActor(actorOf(req), (tx) => invoicePdf(tx, actorOf(req), blobs, id));
      reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${f.name}"`);
      return f.content;
    });
    app.post('/customer-invoices/:id/reminder', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => sendPaymentReminder(tx, actorOf(req), id)); });
    app.post('/customer-payments', async (req, reply) => {
      const b = parse(z.object({ customerId: uuid, receivedOn: day, amount: z.number().positive(), method: z.enum(['check', 'ach', 'wire', 'card', 'other']),
        reference: z.string().max(100).nullable().optional(), allocations: z.array(z.object({ invoiceId: uuid, amount: z.number().positive() })).min(1).max(100) }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => recordPayment(tx, actorOf(req), b));
    });
    app.get('/collections', async (req) => asActor(actorOf(req), (tx) => collectionsQueue(tx, actorOf(req))));
    app.post('/collections', async (req, reply) => {
      const b = parse(z.object({ customerId: uuid, invoiceId: uuid.nullable().optional(), summary: z.string().min(1).max(4000), promiseDate: day.nullable().optional() }), req.body);
      await asActor(actorOf(req), (tx) => logCollection(tx, actorOf(req), b));
      reply.status(204);
    });
    app.get('/customers/:id/account', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => customerAccount(tx, actorOf(req), id)); });
  };
}
