import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { actorOf, parse } from '../../platform/http/helpers.js';
import { listAccountMappings, setAccountMapping } from './accounts.js';
import {
  createConnection, disconnect, downloadExportFile, listConnections, listDeliveries, listExportFiles, mockBills, mockPayBill, mockSimulateOutage,
  resolveDelivery, retryDelivery, runSync,
} from './service.js';

const Id = z.object({ id: z.string().uuid() });
const NumId = z.object({ id: z.coerce.number().int().positive() });

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/integrations', async (req) => asActor(actorOf(req), (tx) => listConnections(tx, actorOf(req))));
  app.post('/integrations', async (req, reply) => {
    const b = parse(z.object({ provider: z.enum(['file_export', 'mock_accounting']), label: z.string().min(3).max(100).optional(), backfill: z.enum(['none', 'all']).optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => createConnection(tx, actorOf(req), b));
  });
  app.post('/integrations/:id/disconnect', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await asActor(actorOf(req), (tx) => disconnect(tx, actorOf(req), id));
    reply.status(204);
  });
  app.post('/integrations/sync', async (req) => runSync(actorOf(req)));
  app.get('/integrations/:id/deliveries', async (req) => {
    const { id } = parse(Id, req.params);
    const q = parse(z.object({ status: z.enum(['pending', 'delivered', 'dead', 'skipped']).optional() }), req.query);
    return asActor(actorOf(req), (tx) => listDeliveries(tx, actorOf(req), id, q));
  });
  app.post('/sync-deliveries/:id/retry', async (req, reply) => {
    const { id } = parse(NumId, req.params);
    await asActor(actorOf(req), (tx) => retryDelivery(tx, actorOf(req), id));
    reply.status(204);
  });
  app.post('/sync-deliveries/:id/resolve', async (req, reply) => {
    const { id } = parse(NumId, req.params);
    const b = parse(z.object({ note: z.string().min(3).max(1000) }), req.body);
    await asActor(actorOf(req), (tx) => resolveDelivery(tx, actorOf(req), id, b.note));
    reply.status(204);
  });
  app.get('/integrations/:id/files', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => listExportFiles(tx, actorOf(req), id)); });
  app.get('/export-files/:id', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const f = await asActor(actorOf(req), (tx) => downloadExportFile(tx, actorOf(req), id));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${f.file_name}"`);
    return f.content;
  });
  app.get('/account-mappings', async (req) => asActor(actorOf(req), (tx) => listAccountMappings(tx, actorOf(req))));
  app.put('/account-mappings/:key', async (req, reply) => {
    const { key } = parse(z.object({ key: z.string().min(1).max(40) }), req.params);
    const b = parse(z.object({ externalCode: z.string().max(40).nullable(), externalName: z.string().max(200).nullable().optional() }), req.body);
    await asActor(actorOf(req), (tx) => setAccountMapping(tx, actorOf(req), key, b));
    reply.status(204);
  });
  // MOCK accounting controls (demo connection only)
  app.get('/integrations/:id/mock/bills', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => mockBills(tx, actorOf(req), id)); });
  app.post('/integrations/:id/mock/pay', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ externalId: z.string().min(1), paidOn: z.string().date().optional(), amount: z.number().positive().optional() }), req.body);
    await asActor(actorOf(req), (tx) => mockPayBill(tx, actorOf(req), id, b));
    reply.status(204);
  });
  app.post('/integrations/:id/mock/outage', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ failures: z.number().int().min(0).max(20) }), req.body);
    await asActor(actorOf(req), (tx) => mockSimulateOutage(tx, actorOf(req), id, b.failures));
    reply.status(204);
  });
}
