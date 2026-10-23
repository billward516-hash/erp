import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor, requirePermission } from '../../platform/auth/actor.js';
import { actorOf, parse, sendFile } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { archiveContents, archiveFile, archiveRows, archivesOverview, cancelRollback, confirmRollback, createArchive, requestRollback, restoreRecords, saveArchiveSettings } from './service.js';

const Id = z.object({ id: z.string().uuid() });

/** Company archives and restore (D-165); administrators only. */
export function archiveRoutes(blobs: BlobStore) {
  return async function (app: FastifyInstance) {
    app.get('/archives', async (req) => asActor(actorOf(req), (tx) => archivesOverview(tx, actorOf(req))));
    app.put('/archives/settings', async (req) => {
      const b = parse(z.object({ intervalDays: z.number().int(), keepCount: z.number().int() }), req.body);
      return asActor(actorOf(req), (tx) => saveArchiveSettings(tx, actorOf(req), b));
    });
    app.post('/archives', async (req, reply) => {
      const actor = actorOf(req);
      requirePermission(actor, 'tenant.admin');
      const b = parse(z.object({ note: z.string().max(300).nullable().optional() }), req.body ?? {});
      reply.status(201);
      return createArchive(blobs, actor.tenantId, 'manual', actor.userId, b.note ?? undefined);
    });
    app.get('/archives/:id/download', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const f = await asActor(actorOf(req), (tx) => archiveFile(tx, blobs, actorOf(req), id));
      return sendFile(reply, { contentType: 'application/gzip', fileName: f.fileName, body: f.body });
    });
    app.get('/archives/:id/contents', async (req) => { const { id } = parse(Id, req.params); return asActor(actorOf(req), (tx) => archiveContents(tx, blobs, actorOf(req), id)); });
    app.get('/archives/:id/rows', async (req) => {
      const { id } = parse(Id, req.params);
      const q = parse(z.object({ table: z.string().regex(/^[a-z_][a-z0-9_]*$/).max(63), q: z.string().max(200).optional() }), req.query);
      return asActor(actorOf(req), (tx) => archiveRows(tx, blobs, actorOf(req), id, q.table, q.q));
    });
    app.post('/archives/:id/restore', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ table: z.string().regex(/^[a-z_][a-z0-9_]*$/).max(63), keys: z.array(z.record(z.unknown())).min(1).max(500), withChildren: z.boolean().optional() }), req.body);
      return asActor(actorOf(req), (tx) => restoreRecords(tx, blobs, actorOf(req), id, b));
    });
    app.post('/archives/:id/rollback', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reason: z.string().max(1000) }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => requestRollback(tx, actorOf(req), id, b.reason));
    });
    app.post('/rollbacks/:id/confirm', async (req) => { const { id } = parse(Id, req.params); return confirmRollback(blobs, actorOf(req), id); });
    app.post('/rollbacks/:id/cancel', async (req, reply) => {
      const { id } = parse(Id, req.params);
      await asActor(actorOf(req), (tx) => cancelRollback(tx, actorOf(req), id));
      reply.status(204);
    });
  };
}
