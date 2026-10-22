import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { createDelegation, listDelegations, revokeDelegation } from '../../platform/approvals/engine.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import {
  cancelOrder, cancelPurchaseRequest, createOrdersFromRequest, createPurchaseRequest, createSupplier, getOrder, getPurchaseRequest, getSupplier,
  listApprovalRules, listOrders, listPurchaseRequests, listSuppliers, receiveOrder, requestForWorkOrder, saveApprovalRule, setSupplierPrice,
  submitPurchaseRequest, updatePurchaseRequest, updateSupplier,
} from './service.js';
import { renderPurchaseOrderPdf } from './po-pdf.js';
import { requestFromReorder } from './reorder.js';
import { issueScar, recordSupplierResponse, supplierScorecards } from './supplier-performance.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const supplierBody = z.object({
  code: z.string().min(1).max(40), name: z.string().min(1).max(200), contactName: z.string().max(200).nullable().optional(), email: z.string().email().nullable().optional(),
  phone: z.string().max(60).nullable().optional(), paymentTerms: z.string().max(100).nullable().optional(), currency: z.string().length(3).optional(),
});
const line = z.object({
  partId: uuid.nullable().optional(), description: z.string().max(500).nullable().optional(), qty: z.number().positive(), uom: z.string().max(20).nullable().optional(),
  estUnitPrice: z.number().nonnegative().nullable().optional(), supplierId: uuid.nullable().optional(), locationId: uuid.nullable().optional(), workOrderId: uuid.nullable().optional(),
});
const reason = z.object({ reason: z.string().min(3).max(1000) });

export async function purchasingRoutes(app: FastifyInstance) {
  app.get('/suppliers', async (req) => {
    const q = parse(z.object({ q: z.string().optional() }), req.query);
    return asActor(actorOf(req), (tx) => listSuppliers(tx, actorOf(req), q));
  });
  app.post('/suppliers', async (req, reply) => {
    const b = parse(supplierBody, req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createSupplier(tx, actorOf(req), b));
  });
  app.get('/supplier-performance', async (req) => {
    const q = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), facilityId: uuid.optional(), supplierId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => supplierScorecards(tx, actorOf(req), q));
  });
  app.post('/suppliers/:id/scar', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ facilityId: uuid, title: z.string().min(1).max(200), problem: z.string().min(1).max(5000), ownerUserId: uuid, ncrIds: z.array(uuid).max(50).optional(),
      responseDays: z.number().int().min(1).max(90).optional() }), req.body);
    reply.status(201); return asActor(actorOf(req), (tx) => issueScar(tx, actorOf(req), { ...b, supplierId: id }));
  });
  app.post('/capas/:id/supplier-response', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ response: z.string().min(1).max(10000), rootCause: z.string().max(5000).nullable().optional(), containment: z.string().max(5000).nullable().optional() }), req.body);
    await asActor(actorOf(req), (tx) => recordSupplierResponse(tx, actorOf(req), id, b)); reply.status(204);
  });
  app.get('/suppliers/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getSupplier(tx, actorOf(req), id)); });
  app.patch('/suppliers/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(supplierBody.partial().omit({ code: true }).extend({ active: z.boolean().optional() }), req.body);
    return asActor(actorOf(req), (tx) => updateSupplier(tx, actorOf(req), id, b));
  });
  app.put('/suppliers/:id/parts/:partId', async (req, reply) => {
    const p = parse(z.object({ id: uuid, partId: uuid }), req.params);
    const b = parse(z.object({ unitPrice: z.number().nonnegative().nullable().optional(), leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
      supplierPartNumber: z.string().max(100).nullable().optional(), preferred: z.boolean().optional() }), req.body);
    await asActor(actorOf(req), (tx) => setSupplierPrice(tx, actorOf(req), p.id, p.partId, b));
    reply.status(204);
  });

  app.get('/purchase-requests', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), mine: z.coerce.boolean().optional(), facilityId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => listPurchaseRequests(tx, actorOf(req), q));
  });
  app.post('/purchase-requests', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, title: z.string().min(3).max(200), justification: z.string().max(4000).nullable().optional(),
      spendType: z.enum(['opex', 'capex']).optional(), neededBy: z.string().date().nullable().optional(), workOrderId: uuid.nullable().optional(),
      lines: z.array(line).min(1).max(200) }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createPurchaseRequest(tx, actorOf(req), b));
  });
  app.get('/purchase-requests/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getPurchaseRequest(tx, actorOf(req), id)); });
  app.patch('/purchase-requests/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ title: z.string().min(3).max(200).optional(), justification: z.string().max(4000).nullable().optional(), spendType: z.enum(['opex', 'capex']).optional(),
      neededBy: z.string().date().nullable().optional(), lines: z.array(line).min(1).max(200).optional() }), req.body);
    return asActor(actorOf(req), (tx) => updatePurchaseRequest(tx, actorOf(req), id, b));
  });
  app.post('/purchase-requests/:id/submit', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => submitPurchaseRequest(tx, actorOf(req), id)); });
  app.post('/purchase-requests/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(reason, req.body);
    await asActor(actorOf(req), (tx) => cancelPurchaseRequest(tx, actorOf(req), id, b.reason));
    reply.status(204);
  });
  app.post('/purchase-requests/:id/order', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ requestLineId: uuid, unitPrice: z.number().nonnegative().optional(), qty: z.number().positive().optional() })).optional(),
      expectedOn: z.string().date().nullable().optional(), notes: z.string().max(2000).nullable().optional() }), req.body ?? {});
    reply.status(201);
    return asActor(actorOf(req), (tx) => createOrdersFromRequest(tx, actorOf(req), id, b));
  });
  app.post('/purchase-requests/from-reorder', async (req, reply) => {
    const b = parse(z.object({ facilityId: uuid, days: z.number().int().min(7).max(120).optional(), partIds: z.array(uuid).optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => requestFromReorder(tx, actorOf(req), b));
  });
  app.post('/work-orders/:id/purchase-request', async (req, reply) => {
    const { id } = parse(Id, req.params);
    reply.status(201);
    return asActor(actorOf(req), (tx) => requestForWorkOrder(tx, actorOf(req), id));
  });

  app.get('/purchase-orders', async (req) => {
    const q = parse(z.object({ status: z.string().optional(), openOnly: z.coerce.boolean().optional(), supplierId: uuid.optional(), facilityId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => listOrders(tx, actorOf(req), q));
  });
  app.get('/purchase-orders/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getOrder(tx, actorOf(req), id)); });
  app.get('/purchase-orders/:id/pdf', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const o = await asActor(actorOf(req), (tx) => getOrder(tx, actorOf(req), id));
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${o.number}.pdf"`);
    return renderPurchaseOrderPdf(o);
  });
  app.post('/purchase-orders/:id/receive', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ orderLineId: uuid, qty: z.number().positive(), locationId: uuid.nullable().optional() })).min(1),
      packingSlip: z.string().max(100).nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => receiveOrder(tx, actorOf(req), id, b));
  });
  app.post('/purchase-orders/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(reason, req.body);
    await asActor(actorOf(req), (tx) => cancelOrder(tx, actorOf(req), id, b.reason));
    reply.status(204);
  });

  app.get('/purchase-approval-rules', async (req) => asActor(actorOf(req), (tx) => listApprovalRules(tx, actorOf(req))));
  app.post('/purchase-approval-rules', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), facilityId: uuid.nullable().optional(), spendType: z.enum(['opex', 'capex']).nullable().optional(),
      minAmount: z.number().nonnegative(), stage: z.number().int().min(1).max(9), roleKey: z.string().min(1), label: z.string().min(3).max(200), active: z.boolean().optional() }), req.body);
    return asActor(actorOf(req), (tx) => saveApprovalRule(tx, actorOf(req), b));
  });

  app.get('/approval-delegations', async (req) => asActor(actorOf(req), (tx) => listDelegations(tx, actorOf(req))));
  app.post('/approval-delegations', async (req, reply) => {
    const b = parse(z.object({ delegatorUserId: uuid.optional(), delegateUserId: uuid, startsOn: z.string().date(), endsOn: z.string().date(), reason: z.string().min(3).max(500) }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createDelegation(tx, actorOf(req), b));
  });
  app.post('/approval-delegations/:id/revoke', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await asActor(actorOf(req), (tx) => revokeDelegation(tx, actorOf(req), id));
    reply.status(204);
  });
}
