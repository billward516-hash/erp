import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { completeTask, createCustomer, getCustomer, listActivities, listCustomers, logActivity, pipeline, saveContact, saveOpportunity, updateCustomer } from './service.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();
const customer = z.object({
  code: z.string().min(1).max(40), name: z.string().min(1).max(200), kind: z.enum(['prospect', 'customer']).optional(), industry: z.string().max(100).nullable().optional(),
  website: z.string().max(200).nullable().optional(), phone: z.string().max(60).nullable().optional(), billingAddress: z.string().max(1000).nullable().optional(),
  shippingAddress: z.string().max(1000).nullable().optional(), paymentTerms: z.string().max(100).nullable().optional(), creditLimit: z.number().nonnegative().nullable().optional(),
  taxExempt: z.boolean().optional(), ownerUserId: uuid.nullable().optional(),
});

export async function crmRoutes(app: FastifyInstance) {
  app.get('/customers', async (req) => {
    const q = parse(z.object({ q: z.string().optional(), kind: z.enum(['prospect', 'customer']).optional(), mine: z.coerce.boolean().optional() }), req.query);
    return asActor(actorOf(req), (tx) => listCustomers(tx, actorOf(req), q));
  });
  app.post('/customers', async (req, reply) => { const b = parse(customer, req.body); reply.status(201); return asActor(actorOf(req), (tx) => createCustomer(tx, actorOf(req), b)); });
  app.get('/customers/:id', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => getCustomer(tx, actorOf(req), id)); });
  app.patch('/customers/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(customer.partial().omit({ code: true }).extend({ active: z.boolean().optional() }), req.body);
    return asActor(actorOf(req), (tx) => updateCustomer(tx, actorOf(req), id, b));
  });
  app.post('/contacts', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), customerId: uuid, name: z.string().min(1).max(200), title: z.string().max(100).nullable().optional(), email: z.string().max(200).nullable().optional(),
      phone: z.string().max(60).nullable().optional(), isPrimary: z.boolean().optional(), active: z.boolean().optional() }), req.body);
    return asActor(actorOf(req), (tx) => saveContact(tx, actorOf(req), b));
  });
  app.get('/opportunities', async (req) => {
    const q = parse(z.object({ ownerUserId: uuid.optional() }), req.query);
    return asActor(actorOf(req), (tx) => pipeline(tx, actorOf(req), q));
  });
  app.post('/opportunities', async (req) => {
    const b = parse(z.object({ id: uuid.optional(), customerId: uuid, title: z.string().min(3).max(200), stage: z.enum(['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']).optional(),
      amount: z.number().nonnegative().nullable().optional(), probability: z.number().int().min(0).max(100).nullable().optional(), expectedClose: z.string().date().nullable().optional(),
      source: z.string().max(100).nullable().optional(), ownerUserId: uuid.nullable().optional(), lostReason: z.string().max(1000).nullable().optional() }), req.body);
    return asActor(actorOf(req), (tx) => saveOpportunity(tx, actorOf(req), b));
  });
  app.get('/activities', async (req) => {
    const q = parse(z.object({ customerId: uuid.optional(), mineOpen: z.coerce.boolean().optional() }), req.query);
    return asActor(actorOf(req), (tx) => listActivities(tx, actorOf(req), { customerId: q.customerId, openTasksFor: q.mineOpen ? actorOf(req).userId : undefined }));
  });
  app.post('/activities', async (req, reply) => {
    const b = parse(z.object({ customerId: uuid, opportunityId: uuid.nullable().optional(), quoteId: uuid.nullable().optional(), kind: z.enum(['call', 'email', 'meeting', 'note', 'task']),
      summary: z.string().min(1).max(4000), dueOn: z.string().date().nullable().optional(), ownerUserId: uuid.nullable().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => logActivity(tx, actorOf(req), b));
  });
  app.post('/activities/:id/done', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await asActor(actorOf(req), (tx) => completeTask(tx, actorOf(req), id));
    reply.status(204);
  });
}
