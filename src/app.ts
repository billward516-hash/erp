import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import type { Actor } from './platform/auth/actor.js';
import { authenticateToken } from './platform/auth/actor.js';
import { AppError } from './platform/errors.js';
import type { BlobStore } from './platform/storage/blob-store.js';
import { LocalBlobStore } from './platform/storage/blob-store.js';
import { assetRoutes } from './modules/assets/routes.js';
import { documentRoutes } from './modules/documents/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { learningRoutes } from './modules/learning/routes.js';
import { approvalRoutes } from './modules/approvals/routes.js';
import { mocRoutes } from './modules/moc/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { pmRoutes } from './modules/pm/routes.js';
import { purchasingRoutes } from './modules/purchasing/routes.js';
import { apRoutes } from './modules/ap/routes.js';
import { integrationRoutes } from './modules/integrations/routes.js';
import { timeRoutes } from './modules/time/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { crmRoutes } from './modules/crm/routes.js';
import { salesRoutes } from './modules/sales/routes.js';
import { maintenanceRoutes } from './modules/maintenance/routes.js';
import { orgRoutes } from './modules/org/routes.js';
import { reportRoutes } from './modules/reporting/routes.js';

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor }
}

export interface AppDeps { blobs: BlobStore }

export function buildApp(deps: Partial<AppDeps> = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' }, bodyLimit: Math.ceil(config.maxUploadBytes * 1.4) });
  const blobs = deps.blobs ?? new LocalBlobStore(config.storageDir);

  // Binary uploads (document versions) arrive as raw bodies; only JSON is parsed.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw new AppError(401, 'unauthenticated', 'missing bearer token');
    const actor = await authenticateToken(token);
    if (!actor) throw new AppError(401, 'unauthenticated', 'invalid or expired token');
    req.actor = actor;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.status(409).send({ error: { code: 'conflict', message: 'duplicate value' } });
    if (pgCode === '23P01') return reply.status(409).send({ error: { code: 'conflict', message: 'overlaps an existing record' } });
    if (pgCode === '42501') return reply.status(403).send({ error: { code: 'forbidden', message: 'not permitted' } });
    if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) {
      return reply.status((err as { statusCode: number }).statusCode).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.get('/health', async () => ({ ok: true }));
  // Built web UI (npm run web:build). Unknown non-API paths fall back to index.html for client routing.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      // Client-side routes (no file extension) get the app shell; missing assets stay 404.
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]+(\?|$)/i.test(req.url)) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'not_found', message: 'route not found' } });
    });
  }
  app.register(orgRoutes, { prefix: '/api' });
  app.register(assetRoutes, { prefix: '/api' });
  app.register(documentRoutes(blobs), { prefix: '/api' });
  app.register(maintenanceRoutes, { prefix: '/api' });
  app.register(importRoutes, { prefix: '/api' });
  app.register(learningRoutes(blobs), { prefix: '/api' });
  app.register(approvalRoutes, { prefix: '/api' });
  app.register(mocRoutes, { prefix: '/api' });
  app.register(inventoryRoutes, { prefix: '/api' });
  app.register(pmRoutes, { prefix: '/api' });
  app.register(purchasingRoutes, { prefix: '/api' });
  app.register(apRoutes(blobs), { prefix: '/api' });
  app.register(integrationRoutes, { prefix: '/api' });
  app.register(timeRoutes, { prefix: '/api' });
  app.register(notificationRoutes, { prefix: '/api' });
  app.register(crmRoutes, { prefix: '/api' });
  app.register(salesRoutes(blobs), { prefix: '/api' });
  app.register(reportRoutes, { prefix: '/api' });
  return app;
}
