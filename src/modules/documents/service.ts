import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { raiseTrainingReviews } from '../learning/reviews.js';

export const DOC_TYPES = [
  'manual', 'troubleshooting_guide', 'repair_procedure', 'service_bulletin', 'drawing', 'sop',
  'training_material', 'photo', 'video', 'contract', 'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface DocumentInput {
  facilityId?: string | null;
  docNumber: string;
  title: string;
  docType: DocType;
  tags?: string[];
  restricted?: boolean;
  safetyCritical?: boolean;
}

export interface VersionInput {
  versionLabel: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
  changeSummary?: string;
  /** Plain text used for search (e.g. from a PDF text extractor). */
  extractedText?: string;
}

/** SQL predicate limiting which versions a caller may see. */
function versionVisibility(actor: Actor, facilityId: string | null, alias = 'v'): string {
  return can(actor, 'documents.view_draft', facilityId) ? 'true' : `${alias}.status = 'approved'`;
}

function assertCanViewDocument(actor: Actor, doc: { facility_id: string | null; restricted: boolean }) {
  requirePermission(actor, 'documents.view', doc.facility_id);
  if (doc.restricted && !can(actor, 'documents.view_restricted', doc.facility_id)) {
    throw forbidden('documents.view_restricted');
  }
}

export async function createDocument(tx: Tx, actor: Actor, input: DocumentInput) {
  requirePermission(actor, 'documents.manage', input.facilityId);
  const existing = await one(tx, 'SELECT id FROM document WHERE doc_number = $1', [input.docNumber]);
  if (existing) throw conflict(`document number ${input.docNumber} already exists`);
  const doc = await one(
    tx,
    `INSERT INTO document (tenant_id, facility_id, doc_number, title, doc_type, tags, restricted, safety_critical, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [actor.tenantId, input.facilityId ?? null, input.docNumber, input.title, input.docType, input.tags ?? [],
      input.restricted ?? false, input.safetyCritical ?? false, actor.userId],
  );
  await audit(tx, actor, { action: 'document.created', entityType: 'document', entityId: doc.id,
    facilityId: doc.facility_id, data: { docNumber: doc.doc_number, title: doc.title } });
  return doc;
}

export async function addVersion(tx: Tx, actor: Actor, blobs: BlobStore, documentId: string, input: VersionInput) {
  const doc = await one(tx, 'SELECT * FROM document WHERE id = $1 FOR UPDATE', [documentId]);
  if (!doc) throw notFound('document');
  requirePermission(actor, 'documents.manage', doc.facility_id);
  const open = await one(tx, `SELECT id FROM document_version WHERE document_id = $1 AND status IN ('draft', 'in_review')`, [documentId]);
  if (open) throw conflict('document already has an unreleased draft; release or discard it first');
  const stored = await blobs.put(actor.tenantId, input.content);
  const rev = await one<{ next: number }>(tx, 'SELECT coalesce(max(revision), 0) + 1 AS next FROM document_version WHERE document_id = $1', [documentId]);
  const version = await one(
    tx,
    `INSERT INTO document_version (tenant_id, document_id, revision, version_label, storage_key, file_name, mime_type,
       size_bytes, sha256, change_summary, extracted_text, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, document_id, revision, version_label, status, file_name, mime_type, size_bytes, sha256, change_summary, created_at`,
    [actor.tenantId, documentId, rev!.next, input.versionLabel, stored.key, input.fileName, input.mimeType, stored.size,
      stored.sha256, input.changeSummary ?? null, input.extractedText ?? null, actor.userId],
  );
  await audit(tx, actor, { action: 'document.version_added', entityType: 'document', entityId: documentId,
    facilityId: doc.facility_id, data: { versionId: version.id, revision: version.revision, sha256: stored.sha256 } });
  return version;
}

/**
 * Releases a draft. The previously approved version becomes 'superseded' (history kept intact).
 * Safety-critical documents require an approver other than the author (separation of duties).
 * Returns records linked to the document so owners can review impact (e.g. training, open work orders);
 * nothing linked is silently rewritten.
 */
export async function approveVersion(tx: Tx, actor: Actor, versionId: string) {
  const v = await one(
    tx,
    `SELECT v.*, d.facility_id, d.safety_critical, d.current_version_id
     FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1 FOR UPDATE OF v, d`,
    [versionId],
  );
  if (!v) throw notFound('document version');
  requirePermission(actor, 'documents.approve', v.facility_id);
  if (!['draft', 'in_review'].includes(v.status)) throw conflict(`version is already ${v.status}`);
  if (v.safety_critical && v.created_by === actor.userId) {
    throw invalid('safety-critical documents must be approved by someone other than the author');
  }
  if (v.current_version_id) {
    await tx.query(`UPDATE document_version SET status = 'superseded' WHERE id = $1`, [v.current_version_id]);
  }
  await tx.query(`UPDATE document_version SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
    [versionId, actor.userId]);
  await tx.query('UPDATE document SET current_version_id = $2 WHERE id = $1', [v.document_id, versionId]);
  const impacted = await many(tx, 'SELECT entity_type, entity_id, link_role FROM document_link WHERE document_id = $1', [v.document_id]);
  // A revision (not a first release) of content that courses teach from opens training reviews.
  const trainingReviews = v.current_version_id ? await raiseTrainingReviews(tx, actor, v.document_id, versionId) : [];
  await audit(tx, actor, { action: 'document.version_approved', entityType: 'document', entityId: v.document_id,
    facilityId: v.facility_id, data: { versionId, revision: v.revision, supersedes: v.current_version_id, impacted, trainingReviews } });
  return { versionId, documentId: v.document_id, supersededVersionId: v.current_version_id, impactedLinks: impacted, trainingReviews };
}

export async function getDocument(tx: Tx, actor: Actor, documentId: string) {
  const doc = await one(tx, 'SELECT * FROM document WHERE id = $1', [documentId]);
  if (!doc) throw notFound('document');
  assertCanViewDocument(actor, doc);
  const versions = await many(
    tx,
    `SELECT v.id, v.revision, v.version_label, v.status, v.file_name, v.mime_type, v.size_bytes, v.sha256,
            v.change_summary, v.created_at, v.approved_at, au.display_name AS approved_by
     FROM document_version v LEFT JOIN app_user au ON au.id = v.approved_by
     WHERE v.document_id = $1 AND ${versionVisibility(actor, doc.facility_id)} ORDER BY v.revision DESC`,
    [documentId],
  );
  const links = await many(tx, 'SELECT entity_type, entity_id, link_role, pinned_version_id FROM document_link WHERE document_id = $1', [documentId]);
  return { ...doc, versions, links };
}

export interface DocumentQuery {
  q?: string;
  docType?: DocType;
  entityType?: string;
  entityId?: string;
  facilityId?: string;
  limit?: number;
}

/** Search documents the caller may see. Non-draft viewers only find documents with an approved version. */
export async function searchDocuments(tx: Tx, actor: Actor, query: DocumentQuery) {
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (query.q) {
    const term = p(query.q);
    where.push(`(to_tsvector('english', d.title || ' ' || d.doc_number || ' ' || array_to_string(d.tags, ' ') || ' ' ||
                  coalesce(cv.extracted_text, '')) @@ websearch_to_tsquery('english', ${term})
                 OR d.doc_number ILIKE '%' || ${term} || '%' OR d.title ILIKE '%' || ${term} || '%'
                 OR ${term} = ANY (d.tags))`);
  }
  if (query.docType) where.push(`d.doc_type = ${p(query.docType)}`);
  if (query.facilityId) where.push(`d.facility_id = ${p(query.facilityId)}`);
  if (query.entityType && query.entityId) {
    where.push(`EXISTS (SELECT 1 FROM document_link l WHERE l.document_id = d.id AND l.entity_type = ${p(query.entityType)} AND l.entity_id = ${p(query.entityId)})`);
  }
  const rows = await many(
    tx,
    `SELECT d.id, d.facility_id, d.doc_number, d.title, d.doc_type, d.tags, d.restricted, d.safety_critical,
            d.current_version_id, cv.version_label AS current_version_label, cv.approved_at AS current_approved_at,
            EXISTS (SELECT 1 FROM document_version x WHERE x.document_id = d.id AND x.status IN ('draft','in_review')) AS has_draft
     FROM document d LEFT JOIN document_version cv ON cv.id = d.current_version_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.doc_number LIMIT ${Math.min(query.limit ?? 100, 500)}`,
    params,
  );
  return rows
    .filter((d) => can(actor, 'documents.view', d.facility_id))
    .filter((d) => !d.restricted || can(actor, 'documents.view_restricted', d.facility_id))
    .filter((d) => d.current_version_id || can(actor, 'documents.view_draft', d.facility_id))
    .map((d) => (can(actor, 'documents.view_draft', d.facility_id) ? d : { ...d, has_draft: undefined }));
}

export async function downloadVersion(tx: Tx, actor: Actor, blobs: BlobStore, versionId: string) {
  // RLS on document_version follows the parent document's tenant + facility visibility.
  const v = await one(
    tx,
    `SELECT v.*, d.facility_id, d.restricted, d.doc_number FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1`,
    [versionId],
  );
  if (!v) throw notFound('document version');
  assertCanViewDocument(actor, v);
  if (v.status !== 'approved' && !can(actor, 'documents.view_draft', v.facility_id)) throw notFound('document version');
  const content = await blobs.get(v.storage_key);
  if (v.restricted) {
    await audit(tx, actor, { action: 'document.downloaded', entityType: 'document', entityId: v.document_id,
      facilityId: v.facility_id, data: { versionId } });
  }
  return { fileName: v.file_name as string, mimeType: v.mime_type as string, content };
}

export async function linkDocument(
  tx: Tx, actor: Actor, documentId: string,
  link: { entityType: string; entityId: string; linkRole?: string; pinnedVersionId?: string | null },
) {
  const doc = await one(tx, 'SELECT id, facility_id FROM document WHERE id = $1', [documentId]);
  if (!doc) throw notFound('document');
  requirePermission(actor, 'documents.manage', doc.facility_id);
  await tx.query(
    `INSERT INTO document_link (tenant_id, document_id, entity_type, entity_id, link_role, pinned_version_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (document_id, entity_type, entity_id, link_role) DO NOTHING`,
    [actor.tenantId, documentId, link.entityType, link.entityId, link.linkRole ?? 'reference', link.pinnedVersionId ?? null],
  );
  await audit(tx, actor, { action: 'document.linked', entityType: 'document', entityId: documentId,
    facilityId: doc.facility_id, data: link });
}
