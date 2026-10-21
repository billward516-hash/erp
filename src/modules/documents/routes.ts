import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { invalid } from '../../platform/errors.js';
import { actorOf, parse, sendFile } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { addVersion, approveVersion, createDocument, DOC_TYPES, downloadVersion, getDocument, linkDocument, searchDocuments } from './service.js';

const Id = z.object({ id: z.string().uuid() });

export function documentRoutes(blobs: BlobStore) {
  return async function (app: FastifyInstance) {
    app.get('/documents', async (req) => {
      const q = parse(z.object({ q: z.string().optional(), docType: z.enum(DOC_TYPES).optional(), facilityId: z.string().uuid().optional(),
        entityType: z.string().optional(), entityId: z.string().uuid().optional(), limit: z.coerce.number().int().positive().optional() }), req.query);
      return asActor(actorOf(req), (tx) => searchDocuments(tx, actorOf(req), q));
    });
    app.post('/documents', async (req, reply) => {
      const body = parse(z.object({ facilityId: z.string().uuid().nullable().optional(), docNumber: z.string().min(1).max(64), title: z.string().min(1).max(300),
        docType: z.enum(DOC_TYPES), tags: z.array(z.string().max(50)).max(30).optional(), restricted: z.boolean().optional(), safetyCritical: z.boolean().optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => createDocument(tx, actorOf(req), body));
    });
    app.get('/documents/:id', async (req) => {
      const { id } = parse(Id, req.params);
      return asActor(actorOf(req), (tx) => getDocument(tx, actorOf(req), id));
    });
    /** Raw file body; metadata in query string. Content-Type header is stored as the file's MIME type. */
    app.post('/documents/:id/versions', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const q = parse(z.object({ versionLabel: z.string().min(1).max(32), fileName: z.string().min(1).max(255), changeSummary: z.string().max(2000).optional() }), req.query);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw invalid('file body is required');
      reply.status(201);
      return asActor(actorOf(req), (tx) => addVersion(tx, actorOf(req), blobs, id, {
        ...q, mimeType: String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!, content: req.body as Buffer,
        extractedText: String(req.headers['content-type'] ?? '').startsWith('text/') ? (req.body as Buffer).toString('utf8').slice(0, 200_000) : undefined,
      }));
    });
    app.post('/document-versions/:id/approve', async (req) => {
      const { id } = parse(Id, req.params);
      return asActor(actorOf(req), (tx) => approveVersion(tx, actorOf(req), id));
    });
    app.get('/document-versions/:id/download', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const file = await asActor(actorOf(req), (tx) => downloadVersion(tx, actorOf(req), blobs, id));
      return sendFile(reply, { contentType: file.mimeType, fileName: file.fileName, body: file.content });
    });
    app.post('/documents/:id/links', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const body = parse(z.object({ entityType: z.enum(['asset', 'work_order', 'part']), entityId: z.string().uuid(), linkRole: z.string().max(40).optional(),
        pinnedVersionId: z.string().uuid().nullable().optional() }), req.body);
      reply.status(204);
      await asActor(actorOf(req), (tx) => linkDocument(tx, actorOf(req), id, body));
    });
  };
}
