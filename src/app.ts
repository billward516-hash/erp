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
import { noticeRoutes, tempChangeRoutes } from './modules/moc/notice-routes.js';
import { fieldServiceRoutes } from './modules/fieldservice/routes.js';
import { fitRoutes } from './modules/fit/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { pmRoutes } from './modules/pm/routes.js';
import { purchasingRoutes } from './modules/purchasing/routes.js';
import { apRoutes } from './modules/ap/routes.js';
import { integrationRoutes } from './modules/integrations/routes.js';
import { timeRoutes } from './modules/time/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { crmRoutes } from './modules/crm/routes.js';
import { salesRoutes } from './modules/sales/routes.js';
import { arRoutes } from './modules/ar/routes.js';
import { productionRoutes } from './modules/production/routes.js';
import { qualityRoutes } from './modules/quality/routes.js';
import { safetyRoutes } from './modules/safety/routes.js';
import { continuityRoutes } from './modules/continuity/routes.js';
import { publicRoutes, sitesRoutes } from './modules/sites/routes.js';
import { leasingRoutes } from './modules/leasing/routes.js';
import { storeOpsRoutes } from './modules/storeops/routes.js';
import { planningRoutes } from './modules/planning/routes.js';
import { spcRoutes } from './modules/spc/routes.js';
import { shiftRoutes } from './modules/shift/routes.js';
import { improveRoutes } from './modules/improve/routes.js';
import { policyRoutes } from './modules/policies/routes.js';
import { intranetRoutes } from './modules/intranet/routes.js';
import { expenseRoutes } from './modules/expenses/routes.js';
import { budgetRoutes } from './modules/budgets/routes.js';
import { bookRoutes } from './modules/books/routes.js';
import { ssoRoutes } from './modules/sso/routes.js';
import { featureRoutes } from './modules/features/routes.js';
import { retentionRoutes } from './modules/retention/routes.js';
import { reminderRoutes } from './modules/reminders/routes.js';
import { reviewRoutes } from './modules/reviews/routes.js';
import { performanceRoutes } from './modules/performance/routes.js';
import { capaRoutes } from './modules/capa/routes.js';
import { proformaRoutes } from './modules/proforma/routes.js';
import { draftRoutes } from './modules/drafts/routes.js';
import { archiveRoutes } from './modules/archives/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { lateRoutes } from './modules/late/routes.js';
import { implementationRoutes } from './modules/implementation/routes.js';
import { hiddenFeatureFor } from './platform/features.js';
import { areaOf, allowedInLite, editionOf } from './platform/edition.js';
import { registerIdempotency } from './platform/http/idempotency.js';
import { requestPath } from './platform/http/helpers.js';
import { type HardeningOptions, hardeningDefaults, registerHardening, requestId } from './platform/http/hardening.js';
import { materialsRoutes } from './modules/materials/routes.js';
import { maintenanceRoutes } from './modules/maintenance/routes.js';
import { orgRoutes } from './modules/org/routes.js';
import { reportRoutes } from './modules/reporting/routes.js';

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor }
}

export interface AppDeps { blobs: BlobStore; hardening: Partial<HardeningOptions> }

export function buildApp(deps: Partial<AppDeps> = {}): FastifyInstance {
  const app = Fastify({
    // Structured JSON logs (D-150): one line per request with its id; credentials never logged.
    logger: process.env.NODE_ENV === 'test' ? false : { level: config.logLevel, redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[redacted]' } },
    genReqId: requestId, trustProxy: process.env.TRUST_PROXY === '1',
    bodyLimit: Math.ceil(config.maxUploadBytes * 1.4),
  });
  const blobs = deps.blobs ?? new LocalBlobStore(config.storageDir);

  // Binary uploads (document versions) arrive as raw bodies; only JSON is parsed.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) => done(null, body));

  const hardening = registerHardening(app, { ...hardeningDefaults(), ...deps.hardening });

  app.addHook('onRequest', async (req, reply) => {
    const path = requestPath(req.url);
    if (!path.startsWith('/api/')) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) { hardening.failedSignIn(req, reply); throw new AppError(401, 'unauthenticated', 'missing bearer token'); }
    const actor = await authenticateToken(token);
    if (!actor) { hardening.failedSignIn(req, reply); throw new AppError(401, 'unauthenticated', 'invalid or expired token'); }
    req.actor = actor;
    req.log = req.log.child({ tenantId: actor.tenantId, userId: actor.userId });
    // Editions (D-135): Lite answers outside its areas with an upgrade message.
    if (!allowedInLite(path) && (await editionOf(actor)) === 'lite') {
      throw new AppError(403, 'edition', 'This is part of the Standard edition. Your company uses Lite (books, invoicing, bills, expenses, policies and the intranet); an administrator can upgrade.');
    }
    // Features hidden from this user (D-149): their own API areas and reports are refused.
    if (actor.hiddenFeatures?.length) {
      const { area, report } = areaOf(path);
      const f = hiddenFeatureFor(actor.hiddenFeatures, area, report);
      if (f) throw new AppError(403, 'feature_off', `${f.label} is turned off for your role. An administrator can turn it on under Admin → Features.`);
    }
  });

  registerIdempotency(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.status(409).send({ error: { code: 'conflict', message: 'duplicate value' } });
    if (pgCode === '23P01') return reply.status(409).send({ error: { code: 'conflict', message: 'overlaps an existing record' } });
    if (pgCode === '42501') return reply.status(403).send({ error: { code: 'forbidden', message: 'not permitted' } });
    // Database rules (D-161): a broken rule or a trigger's refusal is the caller's problem (422), never a server error.
    if (pgCode === '23514') return reply.status(422).send({ error: { code: 'invalid', message: `that breaks a rule on this record (${(err as { constraint?: string }).constraint ?? 'check'})` } });
    if (pgCode === '23503') return reply.status(422).send({ error: { code: 'invalid', message: 'a record it refers to does not exist' } });
    if (pgCode === 'P0001') return reply.status(422).send({ error: { code: 'invalid', message: (err as Error).message } });
    if (pgCode === '22P02' || pgCode === '22007' || pgCode === '22008') return reply.status(400).send({ error: { code: 'bad_request', message: 'a value is not in the expected format' } });
    if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) {
      return reply.status((err as { statusCode: number }).statusCode).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: `internal error (reference ${req.id})`, requestId: req.id } });
  });

  app.register(ssoRoutes);
  app.register(featureRoutes, { prefix: '/api' });
  app.register(retentionRoutes, { prefix: '/api' });
  app.register(reminderRoutes, { prefix: '/api' });
  app.register(reviewRoutes, { prefix: '/api' });
  app.register(performanceRoutes, { prefix: '/api' });
  app.register(capaRoutes, { prefix: '/api' });
  app.register(proformaRoutes, { prefix: '/api' });
  app.register(draftRoutes, { prefix: '/api' });
  app.register(archiveRoutes(blobs), { prefix: '/api' });
  app.register(jobRoutes(blobs), { prefix: '/api' });
  app.register(implementationRoutes, { prefix: '/api' });
  app.register(lateRoutes, { prefix: '/api' });
  // Built web UI (npm run web:build). Unknown non-API paths fall back to index.html for client routing.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      // Client-side routes (no file extension) get the app shell; missing assets stay 404.
      if (req.method === 'GET' && !requestPath(req.url).startsWith('/api/') && !/\.[a-z0-9]+(\?|$)/i.test(req.url)) return reply.sendFile('index.html');
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
  app.register(noticeRoutes, { prefix: '/api' });
  app.register(tempChangeRoutes, { prefix: '/api' });
  app.register(fieldServiceRoutes, { prefix: '/api' });
  app.register(fitRoutes, { prefix: '/api' });
  app.register(inventoryRoutes, { prefix: '/api' });
  app.register(pmRoutes, { prefix: '/api' });
  app.register(purchasingRoutes, { prefix: '/api' });
  app.register(apRoutes(blobs), { prefix: '/api' });
  app.register(integrationRoutes, { prefix: '/api' });
  app.register(timeRoutes, { prefix: '/api' });
  app.register(notificationRoutes, { prefix: '/api' });
  app.register(crmRoutes, { prefix: '/api' });
  app.register(salesRoutes(blobs), { prefix: '/api' });
  app.register(arRoutes(blobs), { prefix: '/api' });
  app.register(productionRoutes, { prefix: '/api' });
  app.register(qualityRoutes(blobs), { prefix: '/api' });
  app.register(safetyRoutes, { prefix: '/api' });
  app.register(continuityRoutes, { prefix: '/api' });
  app.register(sitesRoutes, { prefix: '/api' });
  app.register(leasingRoutes(blobs), { prefix: '/api' });
  app.register(storeOpsRoutes, { prefix: '/api' });
  app.register(planningRoutes, { prefix: '/api' });
  app.register(spcRoutes, { prefix: '/api' });
  app.register(shiftRoutes, { prefix: '/api' });
  app.register(improveRoutes, { prefix: '/api' });
  app.register(policyRoutes, { prefix: '/api' });
  app.register(intranetRoutes, { prefix: '/api' });
  app.register(expenseRoutes(blobs), { prefix: '/api' });
  app.register(budgetRoutes, { prefix: '/api' });
  app.register(bookRoutes, { prefix: '/api' });
  app.register(publicRoutes);
  app.register(materialsRoutes, { prefix: '/api' });
  app.register(reportRoutes, { prefix: '/api' });
  return app;
}
