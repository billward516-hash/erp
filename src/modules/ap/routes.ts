import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { approveInvoice, captureInvoice, disputeInvoice, getInvoice, invoiceDraftFromOrder, invoiceFile, listInvoices, recordPayment, setDueDate, voidInvoice } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const day = z.string().date();
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'];

export function apRoutes(blobs: BlobStore) {
  return async (app: FastifyInstance) => {
    app.get('/supplier-invoices', async (req) => {
      const q = parse(z.object({ status: z.string().optional(), open: z.coerce.boolean().optional(), supplierId: uuid.optional(), purchaseOrderId: uuid.optional() }), req.query);
      return asActor(actorOf(req), (tx) => listInvoices(tx, actorOf(req), q));
    });
    app.post('/supplier-invoices', async (req, reply) => {
      const b = parse(z.object({
        supplierId: uuid, facilityId: uuid.nullable().optional(), purchaseOrderId: uuid.nullable().optional(), invoiceNumber: z.string().min(1).max(60),
        invoiceDate: day, dueDate: day.nullable().optional(), taxAmount: z.number().nonnegative().optional(), freightAmount: z.number().nonnegative().optional(),
        lines: z.array(z.object({ poLineId: uuid.nullable().optional(), description: z.string().max(500).nullable().optional(), qty: z.number().positive(),
          unitPrice: z.number().nonnegative(), accountKey: z.string().max(40).nullable().optional() })).min(1).max(200),
        file: z.object({ name: z.string().min(1).max(255), mime: z.enum(ALLOWED_MIME as [string, ...string[]]), contentBase64: z.string().min(1) }).nullable().optional(),
      }), req.body);
      const file = b.file ? { name: b.file.name, mime: b.file.mime, content: Buffer.from(b.file.contentBase64, 'base64') } : null;
      reply.status(201);
      return asActor(actorOf(req), (tx) => captureInvoice(tx, actorOf(req), blobs, b, file));
    });
    app.get('/purchase-orders/:id/invoice-draft', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => invoiceDraftFromOrder(tx, actorOf(req), id)); });
    app.get('/supplier-invoices/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getInvoice(tx, actorOf(req), id)); });
    app.get('/supplier-invoices/:id/file', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const f = await asActor(actorOf(req), (tx) => invoiceFile(tx, actorOf(req), blobs, id));
      reply.header('content-type', f.mime).header('content-disposition', `inline; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`);
      return f.content;
    });
    app.post('/supplier-invoices/:id/approve', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ varianceNote: z.string().max(2000).nullable().optional() }), req.body ?? {});
      return asActor(actorOf(req), (tx) => approveInvoice(tx, actorOf(req), id, b));
    });
    app.post('/supplier-invoices/:id/dispute', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().min(3).max(2000) }), req.body);
      await asActor(actorOf(req), (tx) => disputeInvoice(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
    app.post('/supplier-invoices/:id/void', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().min(3).max(2000) }), req.body);
      await asActor(actorOf(req), (tx) => voidInvoice(tx, actorOf(req), id, b.reason));
      reply.status(204);
    });
    app.post('/supplier-invoices/:id/due-date', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ dueDate: day }), req.body);
      await asActor(actorOf(req), (tx) => setDueDate(tx, actorOf(req), id, b.dueDate));
      reply.status(204);
    });
    app.post('/supplier-invoices/:id/payment', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ paidOn: day, amount: z.number().positive(), reference: z.string().max(100).nullable().optional() }), req.body);
      await asActor(actorOf(req), (tx) => recordPayment(tx, actorOf(req), id, b));
      reply.status(204);
    });
  };
}
