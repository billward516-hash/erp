import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asActor } from '../../platform/auth/actor.js';
import { invalid } from '../../platform/errors.js';
import { actorOf, parse, sendFile } from '../../platform/http/helpers.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { addVersion, approveVersion, createDocument, discardDraft, DOC_TYPES, downloadVersion, getDocument, linkDocument, obsoleteDocument, repositoryOverview, saveFolder, searchDocuments,
  submitVersion, updateDocument, withdrawVersion, documentPeople } from './service.js';
import { one } from '../../platform/db/tx.js';
import { notFound } from '../../platform/errors.js';
import { decideSpecReview, documentSettings, saveDocumentSettings, specReviewQueue } from './specs.js';
import { acknowledge, myReads } from './reads.js';

const Id = z.object({ id: z.string().uuid() });

export function documentRoutes(blobs: BlobStore) {
  return async function (app: FastifyInstance) {
    app.get('/documents', async (req) => {
      const q = parse(z.object({ q: z.string().optional(), docType: z.enum(DOC_TYPES).optional(), facilityId: z.string().uuid().optional(), folderId: z.string().uuid().optional(),
        origin: z.enum(['internal', 'external']).optional(), status: z.enum(['active', 'obsolete', 'in_review', 'pending']).optional(),
        entityType: z.string().optional(), entityId: z.string().uuid().optional(), limit: z.coerce.number().int().positive().optional() }), req.query);
      return asActor(actorOf(req), (tx) => searchDocuments(tx, actorOf(req), q));
    });
    app.post('/documents', async (req, reply) => {
      const body = parse(z.object({ facilityId: z.string().uuid().nullable().optional(), docNumber: z.string().max(64).nullable().optional(), title: z.string().min(1).max(300),
        docType: z.enum(DOC_TYPES), tags: z.array(z.string().max(50)).max(30).optional(), restricted: z.boolean().optional(), safetyCritical: z.boolean().optional(),
        description: z.string().max(4000).nullable().optional(), folderId: z.string().uuid().nullable().optional(), readRoles: z.array(z.string().max(64)).max(30).optional(),
        issuer: z.string().max(200).nullable().optional(), issuerDocNumber: z.string().max(100).nullable().optional(),
        ackRequired: z.boolean().optional(), ackRoles: z.array(z.string().max(64)).max(30).optional() }), req.body);
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
      const q = parse(z.object({ versionLabel: z.string().min(1).max(32), fileName: z.string().min(1).max(255), changeSummary: z.string().max(2000).optional(),
        issuerRevision: z.string().max(32).optional(), receivedOn: z.string().date().optional() }), req.query);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw invalid('file body is required');
      reply.status(201);
      return asActor(actorOf(req), (tx) => addVersion(tx, actorOf(req), blobs, id, {
        ...q, mimeType: String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!, content: req.body as Buffer,
        extractedText: String(req.headers['content-type'] ?? '').startsWith('text/') ? (req.body as Buffer).toString('utf8').slice(0, 200_000) : undefined,
      }));
    });
    app.post('/document-versions/:id/approve', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ effectiveOn: z.string().date().nullable().optional() }), req.body ?? {});
      return asActor(actorOf(req), (tx) => approveVersion(tx, actorOf(req), id, b));
    });
    app.post('/document-versions/:id/submit', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ reviewerIds: z.array(z.string().uuid()).max(8).optional(), approverId: z.string().uuid(), effectiveOn: z.string().date().nullable().optional() }), req.body);
      return asActor(actorOf(req), (tx) => submitVersion(tx, actorOf(req), id, b));
    });
    app.post('/document-versions/:id/withdraw', async (req, reply) => {
      const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().max(1000) }), req.body);
      await asActor(actorOf(req), (tx) => withdrawVersion(tx, actorOf(req), id, b.reason)); reply.status(204);
    });
    app.post('/document-versions/:id/discard', async (req, reply) => {
      const { id } = parse(Id, req.params);
      await asActor(actorOf(req), (tx) => discardDraft(tx, actorOf(req), id)); reply.status(204);
    });
    /** Which document a version belongs to (links from approvals point at versions). */
    app.get('/document-versions/:id', async (req) => {
      const { id } = parse(Id, req.params);
      return asActor(actorOf(req), async (tx) => { const v = await one(tx, 'SELECT id, document_id, revision, version_label, status FROM document_version WHERE id = $1', [id]); if (!v) throw notFound('document version'); return v; });
    });
    app.get('/document-people', async (req) => {
      const q = parse(z.object({ facilityId: z.string().uuid().optional() }), req.query);
      return asActor(actorOf(req), (tx) => documentPeople(tx, actorOf(req), q.facilityId ?? null));
    });
    app.get('/document-settings', async (req) => asActor(actorOf(req), (tx) => documentSettings(tx)));
    app.put('/document-settings', async (req) => {
      const b = parse(z.object({ specReviewDays: z.number().int().optional(), ackDays: z.number().int().optional(), esignTypes: z.array(z.enum(DOC_TYPES)).max(30).optional() }), req.body);
      return asActor(actorOf(req), (tx) => saveDocumentSettings(tx, actorOf(req), b));
    });
    app.get('/spec-reviews', async (req) => asActor(actorOf(req), (tx) => specReviewQueue(tx, actorOf(req))));
    app.post('/spec-reviews/:id/decide', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ outcome: z.enum(['no_impact', 'changes_required']), whatChanged: z.string().max(4000), assessment: z.string().max(4000),
        customerDueOn: z.string().date().nullable().optional(), mocChangeId: z.string().uuid().nullable().optional(),
        followups: z.array(z.object({ documentId: z.string().uuid(), ownerUserId: z.string().uuid(), dueOn: z.string().date(), note: z.string().max(1000).nullable().optional() })).max(50).optional() }), req.body);
      return asActor(actorOf(req), (tx) => decideSpecReview(tx, actorOf(req), id, b));
    });
    app.get('/my-reads', async (req) => asActor(actorOf(req), (tx) => myReads(tx, actorOf(req))));
    app.post('/document-versions/:id/acknowledge', async (req) => {
      const { id } = parse(Id, req.params);
      return asActor(actorOf(req), (tx) => acknowledge(tx, actorOf(req), id));
    });
    app.get('/document-repository', async (req) => asActor(actorOf(req), (tx) => repositoryOverview(tx, actorOf(req))));
    app.post('/document-folders', async (req, reply) => {
      const b = parse(z.object({ id: z.string().uuid().nullable().optional(), name: z.string().min(1).max(120), parentId: z.string().uuid().nullable().optional(),
        readRoles: z.array(z.string().max(64)).max(30).optional() }), req.body);
      reply.status(201);
      return asActor(actorOf(req), (tx) => saveFolder(tx, actorOf(req), b));
    });
    app.patch('/documents/:id', async (req) => {
      const { id } = parse(Id, req.params);
      const b = parse(z.object({ title: z.string().min(1).max(300).optional(), description: z.string().max(4000).nullable().optional(), tags: z.array(z.string().max(50)).max(30).optional(),
        folderId: z.string().uuid().nullable().optional(), readRoles: z.array(z.string().max(64)).max(30).optional(), restricted: z.boolean().optional(), safetyCritical: z.boolean().optional(),
        ownerUserId: z.string().uuid().optional(), issuer: z.string().max(200).nullable().optional(), issuerDocNumber: z.string().max(100).nullable().optional(),
        ackRequired: z.boolean().optional(), ackRoles: z.array(z.string().max(64)).max(30).optional() }), req.body);
      return asActor(actorOf(req), (tx) => updateDocument(tx, actorOf(req), id, b));
    });
    app.post('/documents/:id/obsolete', async (req) => {
      const { id } = parse(Id, req.params); const b = parse(z.object({ reason: z.string().max(1000) }), req.body);
      return asActor(actorOf(req), (tx) => obsoleteDocument(tx, actorOf(req), id, b.reason));
    });
    app.get('/document-versions/:id/download', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const file = await asActor(actorOf(req), (tx) => downloadVersion(tx, actorOf(req), blobs, id));
      return sendFile(reply, { contentType: file.mimeType, fileName: file.fileName, body: file.content });
    });
    app.post('/documents/:id/links', async (req, reply) => {
      const { id } = parse(Id, req.params);
      const body = parse(z.object({ entityType: z.enum(['asset', 'work_order', 'part', 'customer', 'supplier', 'product', 'work_center', 'document']), entityId: z.string().uuid(), linkRole: z.string().max(40).optional(),
        pinnedVersionId: z.string().uuid().nullable().optional() }), req.body);
      reply.status(204);
      await asActor(actorOf(req), (tx) => linkDocument(tx, actorOf(req), id, body));
    });
  };
}
