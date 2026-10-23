import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse, qbool } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { releaseCreditHold } from '../sales/service.js';
import {
  collectionsQueue, createInvoice, customerAccount, draftInvoiceFromOrder, getInvoice, invoicePdf, issueInvoice, listInvoices, logCollection, recordPayment, sendPaymentReminder,
  toInvoice, updateDraft, voidInvoice,
} from './service.js';
import { applyCredit, createCreditMemo, creditMemoPdf, getCreditMemo, issueCreditMemo, listCreditMemos, refundCredit, updateCreditMemo, voidCreditMemo } from './credit-memos.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();

export function arRoutes(blobs: BlobStore) {
  return async (app: FastifyInstance) => {
    app.get('/customer-invoices', async (req) => {
      const q = parse(z.object({ status: z.string().optional(), open: qbool.optional(), customerId: uuid.optional() }), req.query);
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
    // Credit memos, customer returns and refunds (D-146).
    const creditLine = z.object({ description: z.string().min(1).max(500), qty: z.number().positive(), unitPrice: z.number().min(0), accountKey: z.string().max(40).optional(),
      partId: uuid.nullable().optional(), locationId: uuid.nullable().optional(), lots: z.string().max(2000).nullable().optional() });
    app.get('/credit-memos', async (req) => {
      const q = parse(z.object({ customerId: uuid.optional(), open: qbool.optional() }), req.query);
      return asActor(actorOf(req), (tx) => listCreditMemos(tx, actorOf(req), q));
    });
    app.post('/credit-memos', async (req, reply) => {
      const b = parse(z.object({ customerId: uuid, invoiceId: uuid.nullable().optional(), facilityId: uuid.nullable().optional(), reason: z.string().min(3).max(500),
        taxAmount: z.number().min(0).optional(), lines: z.array(creditLine).min(1).max(100) }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => createCreditMemo(tx, actorOf(req), b));
    });
    app.get('/credit-memos/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getCreditMemo(tx, actorOf(req), id)); });
    app.put('/credit-memos/:id', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().min(3).max(500).optional(), taxAmount: z.number().min(0).optional(), lines: z.array(creditLine).min(1).max(100).optional() }), req.body);
      await asActor(actorOf(req), (tx) => updateCreditMemo(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/credit-memos/:id/issue', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ memoDate: day.optional() }), req.body ?? {});
      return asActor(actorOf(req), (tx) => issueCreditMemo(tx, actorOf(req), blobs, id, b));
    });
    app.post('/credit-memos/:id/apply', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ invoiceId: uuid, amount: z.number().positive() }), req.body);
      await asActor(actorOf(req), (tx) => applyCredit(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/credit-memos/:id/refund', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ amount: z.number().positive(), paidOn: day, method: z.enum(['check', 'ach', 'wire', 'card', 'other']), reference: z.string().max(80).nullable().optional(),
        bankAccountId: uuid.nullable().optional() }), req.body);
      await asActor(actorOf(req), (tx) => refundCredit(tx, actorOf(req), id, b));
      reply.status(204);
    });
    app.post('/credit-memos/:id/void', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
      await asActor(actorOf(req), (tx) => voidCreditMemo(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
    app.get('/credit-memos/:id/pdf', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const f = await asActor(actorOf(req), (tx) => creditMemoPdf(tx, actorOf(req), blobs, id));
      reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${f.name}"`);
      return f.content;
    });
    app.post('/customer-invoices/:id/reminder', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => sendPaymentReminder(tx, actorOf(req), id)); });
    app.post('/customer-invoices', async (req, reply) => {
      const b = parse(z.object({ customerId: uuid, facilityId: uuid.nullable().optional(), lines: z.array(z.object({ description: z.string().min(1).max(500), qty: z.number().positive(),
        unitPrice: z.number().min(0), accountKey: z.string().max(40).optional() })).min(1).max(100), taxAmount: z.number().min(0).optional(), paymentTerms: z.string().max(40).nullable().optional(),
        customerPo: z.string().max(60).nullable().optional(), notes: z.string().max(2000).nullable().optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => createInvoice(tx, actorOf(req), b));
    });
    app.post('/customer-payments', async (req, reply) => {
      const b = parse(z.object({ customerId: uuid, receivedOn: day, amount: z.number().positive(), method: z.enum(['check', 'ach', 'wire', 'card', 'other']),
        reference: z.string().max(100).nullable().optional(), allocations: z.array(z.object({ invoiceId: uuid, amount: z.number().positive() })).min(1).max(100), bankAccountId: uuid.nullable().optional() }), req.body);
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
