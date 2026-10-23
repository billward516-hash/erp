import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { approvalHistory, closePendingRequests, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit, auditHistory } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { raiseTrainingReviews } from '../learning/reviews.js';

/**
 * The document server (D-168): controlled documents, internal (SOPs, work instructions, procedures, methods, technical
 * requirements, forms, drawings, manuals) and external (customer specifications, standards), each with numbered
 * versions whose released content never changes (database guard), a reason for every change, review and approval by
 * named people other than the author, an effective date, read access by folder or document, and a logged view of every
 * file opened.
 */
export const DOC_TYPES = [
  'sop', 'work_instruction', 'procedure', 'method', 'technical_requirement', 'customer_spec', 'industry_standard', 'form', 'drawing',
  'manual', 'troubleshooting_guide', 'repair_procedure', 'service_bulletin', 'training_material', 'photo', 'video', 'contract', 'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_LABEL: Record<DocType, string> = {
  sop: 'Standard operating procedure', work_instruction: 'Work instruction', procedure: 'Procedure', method: 'Method (test or inspection)',
  technical_requirement: 'Technical requirement', customer_spec: 'Customer specification', industry_standard: 'Standard', form: 'Form or template',
  drawing: 'Drawing', manual: 'Manual', troubleshooting_guide: 'Troubleshooting guide', repair_procedure: 'Repair procedure', service_bulletin: 'Service bulletin',
  training_material: 'Training material', photo: 'Photo', video: 'Video', contract: 'Contract', other: 'Other',
};
/** Numbering when none is given: a prefix per kind and a company-wide sequence per prefix. */
const PREFIX: Partial<Record<DocType, string>> = { sop: 'SOP', work_instruction: 'WI', procedure: 'PR', method: 'TM', technical_requirement: 'TR',
  customer_spec: 'CS', industry_standard: 'STD', form: 'FRM', drawing: 'DWG', manual: 'MAN' };
/** Kinds issued by someone else; their owner is the issuer, we control our copy and where it applies. */
export const EXTERNAL_TYPES = new Set<DocType>(['customer_spec', 'industry_standard']);
const SUBJECT = 'document_version';
const PURPOSE = 'release';

registerApprovalSubject(SUBJECT, {
  link: (id) => `/documents/version/${id}`,
  describe: async (tx, id) => { const v = await one(tx, `SELECT d.doc_number, d.title, v.version_label FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1`, [id]);
    return v ? `${v.doc_number} rev ${v.version_label} ${v.title}` : 'Document'; },
  // Each signature records what it means: the reviewer's or approver's comment.
  commentRequired: true,
});

export interface DocumentInput {
  facilityId?: string | null;
  docNumber?: string | null;
  title: string;
  docType: DocType;
  description?: string | null;
  tags?: string[];
  restricted?: boolean;
  safetyCritical?: boolean;
  folderId?: string | null;
  readRoles?: string[];
  issuer?: string | null;
  issuerDocNumber?: string | null;
}

export interface VersionInput {
  versionLabel: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
  /** The reason for the change; required from the second version on. */
  changeSummary?: string;
  /** Plain text used for search (e.g. from a PDF text extractor). */
  extractedText?: string;
  issuerRevision?: string | null;
  receivedOn?: string | null;
}

/**
 * SQL predicate limiting which versions a caller may see. People without draft access see only a released version in
 * force (approved and effective), never a superseded one or one whose effective date is still ahead.
 */
function versionVisibility(actor: Actor, facilityId: string | null, alias = 'v'): string {
  return can(actor, 'documents.view_draft', facilityId) ? 'true' : `(${alias}.status = 'approved' AND (${alias}.effective_on IS NULL OR ${alias}.effective_on <= current_date))`;
}

const holdsAnyRole = (actor: Actor, roles: string[]) => actor.grants.some((g) => roles.some((r) => g.roles.has(r)));

/** The roles that may read a document: its own list, else its folder's (or the nearest parent's); empty means everyone. */
async function readRolesOf(tx: Tx, doc: { read_roles: string[]; folder_id: string | null }): Promise<string[]> {
  if (doc.read_roles?.length) return doc.read_roles;
  if (!doc.folder_id) return [];
  const r = await one(tx, `WITH RECURSIVE up AS (SELECT id, parent_id, read_roles, 0 AS depth FROM document_folder WHERE id = $1
      UNION ALL SELECT f.id, f.parent_id, f.read_roles, up.depth + 1 FROM document_folder f JOIN up ON f.id = up.parent_id WHERE up.depth < 20)
    SELECT read_roles FROM up WHERE cardinality(read_roles) > 0 ORDER BY depth LIMIT 1`, [doc.folder_id]);
  return r?.read_roles ?? [];
}

function canReadWith(actor: Actor, doc: { facility_id: string | null; restricted: boolean }, roles: string[]) {
  if (!can(actor, 'documents.view', doc.facility_id)) return false;
  if (doc.restricted && !can(actor, 'documents.view_restricted', doc.facility_id)) return false;
  return !roles.length || can(actor, 'documents.manage', doc.facility_id) || holdsAnyRole(actor, roles);
}

async function assertCanViewDocument(tx: Tx, actor: Actor, doc: { facility_id: string | null; restricted: boolean; read_roles: string[]; folder_id: string | null }) {
  requirePermission(actor, 'documents.view', doc.facility_id);
  if (doc.restricted && !can(actor, 'documents.view_restricted', doc.facility_id)) throw forbidden('documents.view_restricted');
  if (!canReadWith(actor, doc, await readRolesOf(tx, doc))) throw forbidden('this document is limited to certain roles');
}

/** Approved versions whose effective date has come take over from the one in force. */
export async function promoteDue(tx: Tx) {
  return (await one(tx, 'SELECT document_promote_due() AS n'))?.n ?? 0;
}

export async function createDocument(tx: Tx, actor: Actor, input: DocumentInput) {
  requirePermission(actor, 'documents.manage', input.facilityId);
  const external = EXTERNAL_TYPES.has(input.docType);
  if (external && !input.issuer?.trim()) throw invalid('an external document needs its issuer (the customer, supplier or standards body)');
  if (input.folderId && !(await one(tx, 'SELECT 1 FROM document_folder WHERE id = $1', [input.folderId]))) throw notFound('folder');
  let docNumber = input.docNumber?.trim();
  if (!docNumber) {
    const prefix = PREFIX[input.docType] ?? 'DOC';
    docNumber = `${prefix}-${String(await nextSequence(tx, actor.tenantId, `doc:${prefix}`)).padStart(4, '0')}`;
  }
  const existing = await one(tx, 'SELECT id FROM document WHERE doc_number = $1', [docNumber]);
  if (existing) throw conflict(`document number ${docNumber} already exists`);
  const doc = await one(
    tx,
    `INSERT INTO document (tenant_id, facility_id, doc_number, title, doc_type, tags, restricted, safety_critical, owner_user_id, origin, issuer, issuer_doc_number,
       description, folder_id, read_roles)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [actor.tenantId, input.facilityId ?? null, docNumber, input.title.trim(), input.docType, input.tags ?? [], input.restricted ?? false, input.safetyCritical ?? false,
      actor.userId, external ? 'external' : 'internal', external ? input.issuer!.trim() : null, input.issuerDocNumber?.trim() || null, input.description?.trim() || null,
      input.folderId ?? null, input.readRoles ?? []],
  );
  await audit(tx, actor, { action: 'document.created', entityType: 'document', entityId: doc.id,
    facilityId: doc.facility_id, data: { docNumber: doc.doc_number, title: doc.title, docType: doc.doc_type, origin: doc.origin } });
  return doc;
}

export async function updateDocument(tx: Tx, actor: Actor, id: string, input: { title?: string; description?: string | null; tags?: string[]; folderId?: string | null;
  readRoles?: string[]; restricted?: boolean; safetyCritical?: boolean; ownerUserId?: string; issuer?: string | null; issuerDocNumber?: string | null }) {
  const doc = await one(tx, 'SELECT * FROM document WHERE id = $1 FOR UPDATE', [id]);
  if (!doc) throw notFound('document');
  requirePermission(actor, 'documents.manage', doc.facility_id);
  if (input.folderId && !(await one(tx, 'SELECT 1 FROM document_folder WHERE id = $1', [input.folderId]))) throw notFound('folder');
  if (input.ownerUserId && !(await one(tx, `SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [input.ownerUserId]))) throw invalid('the owner must be an active user');
  const next = { title: input.title?.trim() ?? doc.title, description: input.description === undefined ? doc.description : input.description?.trim() || null,
    tags: input.tags ?? doc.tags, folder_id: input.folderId === undefined ? doc.folder_id : input.folderId, read_roles: input.readRoles ?? doc.read_roles,
    restricted: input.restricted ?? doc.restricted, safety_critical: input.safetyCritical ?? doc.safety_critical, owner_user_id: input.ownerUserId ?? doc.owner_user_id,
    issuer: input.issuer === undefined ? doc.issuer : input.issuer?.trim() || null, issuer_doc_number: input.issuerDocNumber === undefined ? doc.issuer_doc_number : input.issuerDocNumber?.trim() || null };
  if (doc.origin === 'external' && !next.issuer) throw invalid('an external document needs its issuer');
  await tx.query(`UPDATE document SET title = $2, description = $3, tags = $4, folder_id = $5, read_roles = $6, restricted = $7, safety_critical = $8, owner_user_id = $9,
    issuer = $10, issuer_doc_number = $11 WHERE id = $1`, [id, next.title, next.description, next.tags, next.folder_id, next.read_roles, next.restricted, next.safety_critical,
    next.owner_user_id, next.issuer, next.issuer_doc_number]);
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(doc[k])));
  await audit(tx, actor, { action: 'document.updated', entityType: 'document', entityId: id, facilityId: doc.facility_id, data: { changed } });
  return getDocument(tx, actor, id);
}

export async function addVersion(tx: Tx, actor: Actor, blobs: BlobStore, documentId: string, input: VersionInput) {
  const doc = await one(tx, 'SELECT * FROM document WHERE id = $1 FOR UPDATE', [documentId]);
  if (!doc) throw notFound('document');
  requirePermission(actor, 'documents.manage', doc.facility_id);
  if (doc.status === 'obsolete') throw conflict('the document is obsolete');
  const open = await one(tx, `SELECT id FROM document_version WHERE document_id = $1 AND status IN ('draft', 'in_review')`, [documentId]);
  if (open) throw conflict('document already has an unreleased draft; release or discard it first');
  const rev = await one<{ next: number }>(tx, 'SELECT coalesce(max(revision), 0) + 1 AS next FROM document_version WHERE document_id = $1', [documentId]);
  if (rev!.next > 1 && !input.changeSummary?.trim()) throw invalid('say what changed and why (the reason for change is part of the record)');
  if (doc.origin === 'external' && !input.issuerRevision?.trim()) throw invalid('give the issuer\'s revision of this copy');
  const stored = await blobs.put(actor.tenantId, input.content);
  const version = await one(
    tx,
    `INSERT INTO document_version (tenant_id, document_id, revision, version_label, storage_key, file_name, mime_type,
       size_bytes, sha256, change_summary, extracted_text, created_by, issuer_revision, received_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, document_id, revision, version_label, status, file_name, mime_type, size_bytes, sha256, change_summary, created_at, issuer_revision, received_on`,
    [actor.tenantId, documentId, rev!.next, input.versionLabel, stored.key, input.fileName, input.mimeType, stored.size,
      stored.sha256, input.changeSummary?.trim() || null, input.extractedText ?? null, actor.userId, input.issuerRevision?.trim() || null, input.receivedOn ?? null],
  );
  await audit(tx, actor, { action: 'document.version_added', entityType: 'document', entityId: documentId,
    facilityId: doc.facility_id, data: { versionId: version.id, revision: version.revision, sha256: stored.sha256, reason: version.change_summary } });
  return version;
}

/** Discards an unreleased draft (the file stays in storage; the record of the draft is kept as discarded in the audit trail). */
export async function discardDraft(tx: Tx, actor: Actor, versionId: string) {
  const v = await one(tx, `SELECT v.*, d.facility_id FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1 FOR UPDATE OF v`, [versionId]);
  if (!v) throw notFound('document version');
  requirePermission(actor, 'documents.manage', v.facility_id);
  if (v.status !== 'draft') throw conflict(`a version that is ${v.status.replace('_', ' ')} cannot be discarded`);
  await tx.query(`UPDATE document_version SET status = 'obsolete' WHERE id = $1`, [versionId]);
  await audit(tx, actor, { action: 'document.draft_discarded', entityType: 'document', entityId: v.document_id, facilityId: v.facility_id, data: { versionId, revision: v.revision } });
}

async function userCanApprove(tx: Tx, userId: string, facilityId: string | null) {
  return !!(await one(tx, `SELECT 1 FROM user_role_scope a JOIN role r ON r.id = a.role_id JOIN app_user u ON u.id = a.user_id
    WHERE a.user_id = $1 AND u.status = 'active' AND 'documents.approve' = ANY (r.permissions) AND (a.facility_id IS NULL OR $2::uuid IS NULL OR a.facility_id = $2) LIMIT 1`, [userId, facilityId]));
}

/**
 * Sends a draft for review and approval: named reviewers first (any of the company's people), then the named approver,
 * who must hold document approval at the document's site and must not be the author. Each signature needs a comment
 * that says what was checked. The version takes effect on its effective date (today if none).
 */
export async function submitVersion(tx: Tx, actor: Actor, versionId: string, input: { reviewerIds?: string[]; approverId: string; effectiveOn?: string | null }) {
  const v = await one(tx, `SELECT v.*, d.facility_id, d.doc_number, d.title FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1 FOR UPDATE OF v`, [versionId]);
  if (!v) throw notFound('document version');
  requirePermission(actor, 'documents.manage', v.facility_id);
  if (v.status !== 'draft') throw conflict(`the version is ${v.status.replace('_', ' ')}`);
  const reviewers = [...new Set(input.reviewerIds ?? [])];
  if (reviewers.length > 8) throw invalid('up to 8 reviewers');
  if (input.approverId === v.created_by) throw invalid('the approver must be someone other than the author');
  if (reviewers.includes(input.approverId)) throw invalid('the approver signs after the reviewers; do not list them as a reviewer too');
  if (!(await userCanApprove(tx, input.approverId, v.facility_id))) throw invalid('the approver must hold document approval at this site');
  for (const r of reviewers) if (!(await one(tx, `SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [r]))) throw invalid('every reviewer must be an active user');
  if (input.effectiveOn && input.effectiveOn < new Date().toISOString().slice(0, 10)) throw invalid('the effective date cannot be in the past');
  const names = new Map((await many(tx, 'SELECT id, display_name FROM app_user WHERE id = ANY ($1)', [[...reviewers, input.approverId]])).map((u) => [u.id, u.display_name]));
  await createApprovalRequest(tx, actor, { facilityId: v.facility_id, subjectType: SUBJECT, subjectId: versionId, subjectRevision: v.revision, purpose: PURPOSE, stages: [
    { steps: reviewers.map((id) => ({ roleKey: 'documents', label: `Review by ${names.get(id)}`, assigneeUserId: id })) },
    { steps: [{ roleKey: 'documents', label: `Approval by ${names.get(input.approverId)}`, assigneeUserId: input.approverId }] },
  ] });
  await tx.query(`UPDATE document_version SET status = 'in_review', submitted_by = $2, submitted_at = now(), effective_on = $3 WHERE id = $1`,
    [versionId, actor.userId, input.effectiveOn ?? null]);
  await audit(tx, actor, { action: 'document.version_submitted', entityType: 'document', entityId: v.document_id, facilityId: v.facility_id,
    data: { versionId, revision: v.revision, reviewers, approver: input.approverId, effectiveOn: input.effectiveOn ?? null } });
  return { versionId, status: 'in_review' };
}

/** Withdraws a version from review back to draft (the pending approval is closed). */
export async function withdrawVersion(tx: Tx, actor: Actor, versionId: string, reason: string) {
  const v = await one(tx, `SELECT v.*, d.facility_id FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1 FOR UPDATE OF v`, [versionId]);
  if (!v) throw notFound('document version');
  requirePermission(actor, 'documents.manage', v.facility_id);
  if (v.status !== 'in_review') throw conflict('only a version in review can be withdrawn');
  if (!reason?.trim()) throw invalid('say why it is withdrawn');
  await closePendingRequests(tx, actor, SUBJECT, versionId, 'cancelled', reason.trim());
  await tx.query(`UPDATE document_version SET status = 'draft' WHERE id = $1`, [versionId]);
  await audit(tx, actor, { action: 'document.version_withdrawn', entityType: 'document', entityId: v.document_id, facilityId: v.facility_id, data: { versionId, reason: reason.trim() } });
}

/** The approval engine's decision on a submitted version: approved releases it; sent back returns it to draft. */
export async function onDocumentDecided(tx: Tx, actor: Actor, versionId: string, purpose: string, status: string) {
  if (purpose !== PURPOSE || status === 'pending') return;
  if (status === 'approved') { await release(tx, actor, versionId); return; }
  const v = await one(tx, `SELECT v.document_id, d.facility_id FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1`, [versionId]);
  await tx.query(`UPDATE document_version SET status = 'draft' WHERE id = $1 AND status = 'in_review'`, [versionId]);
  if (v) await audit(tx, actor, { action: 'document.version_sent_back', entityType: 'document', entityId: v.document_id, facilityId: v.facility_id, data: { versionId } });
}

/**
 * Releases a version. With an effective date still ahead, it waits as the pending version and the one in force stays in
 * force until then; otherwise it takes over now and the previous version becomes 'superseded' (history kept intact).
 * Records linked to the document are returned so owners can review impact; a revision opens training reviews.
 */
async function release(tx: Tx, actor: Actor, versionId: string, effectiveOn?: string | null) {
  const v = await one(tx, `SELECT v.*, d.facility_id, d.current_version_id, d.pending_version_id FROM document_version v JOIN document d ON d.id = v.document_id
    WHERE v.id = $1 FOR UPDATE OF v, d`, [versionId]);
  if (!v) throw notFound('document version');
  const today = new Date().toISOString().slice(0, 10);
  const effective = effectiveOn ?? (v.effective_on ? new Date(v.effective_on).toISOString().slice(0, 10) : today);
  await tx.query(`UPDATE document_version SET status = 'approved', approved_by = $2, approved_at = now(), effective_on = $3 WHERE id = $1`, [versionId, actor.userId, effective]);
  // A version approved earlier and still waiting for its date is overtaken by this one.
  if (v.pending_version_id && v.pending_version_id !== versionId) await tx.query(`UPDATE document_version SET status = 'superseded' WHERE id = $1 AND status = 'approved'`, [v.pending_version_id]);
  let supersedes: string | null = null;
  if (effective <= today) {
    if (v.current_version_id) { await tx.query(`UPDATE document_version SET status = 'superseded' WHERE id = $1`, [v.current_version_id]); supersedes = v.current_version_id; }
    await tx.query('UPDATE document SET current_version_id = $2, pending_version_id = NULL WHERE id = $1', [v.document_id, versionId]);
  } else {
    await tx.query('UPDATE document SET pending_version_id = $2 WHERE id = $1', [v.document_id, versionId]);
  }
  const impacted = await many(tx, 'SELECT entity_type, entity_id, link_role FROM document_link WHERE document_id = $1', [v.document_id]);
  const trainingReviews = v.current_version_id ? await raiseTrainingReviews(tx, actor, v.document_id, versionId) : [];
  await audit(tx, actor, { action: 'document.version_approved', entityType: 'document', entityId: v.document_id,
    facilityId: v.facility_id, data: { versionId, revision: v.revision, supersedes, effectiveOn: effective, impacted, trainingReviews } });
  return { versionId, documentId: v.document_id, supersededVersionId: supersedes, effectiveOn: effective, impactedLinks: impacted, trainingReviews };
}

/**
 * Releases a draft directly, as a one-step approval by someone who holds document approval; for documents that do not
 * go through named reviewers. The approver may never be the author (separation of duties).
 */
export async function approveVersion(tx: Tx, actor: Actor, versionId: string, opts: { effectiveOn?: string | null } = {}) {
  const v = await one(tx, `SELECT v.*, d.facility_id FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1 FOR UPDATE OF v`, [versionId]);
  if (!v) throw notFound('document version');
  requirePermission(actor, 'documents.approve', v.facility_id);
  if (v.status === 'in_review') throw conflict('the version is in review; it is released by its approval');
  if (v.status !== 'draft') throw conflict(`version is already ${v.status}`);
  if (v.created_by === actor.userId) throw invalid('documents must be approved by someone other than the author');
  if (opts.effectiveOn && opts.effectiveOn < new Date().toISOString().slice(0, 10)) throw invalid('the effective date cannot be in the past');
  return release(tx, actor, versionId, opts.effectiveOn ?? null);
}

/** Withdraws a document from use. Its versions stay on record as obsolete; links are returned so they can be replaced. */
export async function obsoleteDocument(tx: Tx, actor: Actor, id: string, reason: string) {
  const doc = await one(tx, 'SELECT * FROM document WHERE id = $1 FOR UPDATE', [id]);
  if (!doc) throw notFound('document');
  requirePermission(actor, 'documents.approve', doc.facility_id);
  if (doc.status === 'obsolete') throw conflict('the document is already obsolete');
  if (!reason?.trim() || reason.trim().length < 5) throw invalid('say why the document is withdrawn');
  const open = await one(tx, `SELECT 1 FROM document_version WHERE document_id = $1 AND status = 'in_review'`, [id]);
  if (open) throw conflict('a version is in review; withdraw it first');
  await tx.query(`UPDATE document_version SET status = 'obsolete' WHERE document_id = $1 AND status IN ('approved', 'superseded', 'draft')`, [id]);
  await tx.query(`UPDATE document SET status = 'obsolete', obsoleted_at = now(), obsolete_reason = $2, pending_version_id = NULL WHERE id = $1`, [id, reason.trim()]);
  const links = await many(tx, 'SELECT entity_type, entity_id, link_role FROM document_link WHERE document_id = $1', [id]);
  await audit(tx, actor, { action: 'document.obsoleted', entityType: 'document', entityId: id, facilityId: doc.facility_id, data: { reason: reason.trim(), links } });
  return { links };
}

export async function getDocument(tx: Tx, actor: Actor, documentId: string) {
  await promoteDue(tx);
  const doc = await one(tx, `SELECT d.*, o.display_name AS owner_name, f.name AS folder_name, fac.code AS facility_code FROM document d LEFT JOIN app_user o ON o.id = d.owner_user_id
    LEFT JOIN document_folder f ON f.id = d.folder_id LEFT JOIN facility fac ON fac.id = d.facility_id WHERE d.id = $1`, [documentId]);
  if (!doc) throw notFound('document');
  await assertCanViewDocument(tx, actor, doc);
  const versions = await many(
    tx,
    `SELECT v.id, v.revision, v.version_label, v.status, v.file_name, v.mime_type, v.size_bytes, v.sha256, v.change_summary, v.created_at, v.approved_at,
            v.effective_on, v.issuer_revision, v.received_on, v.submitted_at, v.created_by AS created_by_id, au.display_name AS approved_by, cu.display_name AS created_by
     FROM document_version v LEFT JOIN app_user au ON au.id = v.approved_by LEFT JOIN app_user cu ON cu.id = v.created_by
     WHERE v.document_id = $1 AND ${versionVisibility(actor, doc.facility_id)} ORDER BY v.revision DESC`,
    [documentId],
  );
  const links = await many(tx, 'SELECT entity_type, entity_id, link_role, pinned_version_id FROM document_link WHERE document_id = $1', [documentId]);
  const manage = can(actor, 'documents.manage', doc.facility_id);
  const open = versions.find((v) => v.status === 'draft' || v.status === 'in_review');
  return {
    ...doc, type_label: DOC_TYPE_LABEL[doc.doc_type as DocType], versions, links, readRolesInForce: await readRolesOf(tx, doc),
    approvals: open && manage ? await approvalHistory(tx, SUBJECT, open.id) : [],
    history: manage ? await auditHistory(tx, 'document', documentId) : [],
    canManage: manage, canApprove: can(actor, 'documents.approve', doc.facility_id),
  };
}

export interface DocumentQuery {
  q?: string;
  docType?: DocType;
  entityType?: string;
  entityId?: string;
  facilityId?: string;
  folderId?: string;
  origin?: 'internal' | 'external';
  status?: 'active' | 'obsolete' | 'in_review' | 'pending';
  limit?: number;
}

/** Search documents the caller may see. Non-draft viewers only find documents with a released version. Obsolete ones only when asked. */
export async function searchDocuments(tx: Tx, actor: Actor, query: DocumentQuery) {
  await promoteDue(tx);
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (query.q) {
    const term = p(query.q);
    where.push(`(to_tsvector('english', d.title || ' ' || d.doc_number || ' ' || array_to_string(d.tags, ' ') || ' ' || coalesce(d.issuer, '') || ' ' || coalesce(d.issuer_doc_number, '') || ' ' ||
                  coalesce(cv.extracted_text, '')) @@ websearch_to_tsquery('english', ${term})
                 OR d.doc_number ILIKE '%' || ${term} || '%' OR d.title ILIKE '%' || ${term} || '%' OR d.issuer_doc_number ILIKE '%' || ${term} || '%'
                 OR ${term} = ANY (d.tags))`);
  }
  if (query.docType) where.push(`d.doc_type = ${p(query.docType)}`);
  if (query.facilityId) where.push(`d.facility_id = ${p(query.facilityId)}`);
  if (query.folderId) where.push(`d.folder_id = ${p(query.folderId)}`);
  if (query.origin) where.push(`d.origin = ${p(query.origin)}`);
  if (query.status === 'obsolete') where.push(`d.status = 'obsolete'`);
  else where.push(`d.status = 'active'`);
  if (query.status === 'in_review') where.push(`EXISTS (SELECT 1 FROM document_version x WHERE x.document_id = d.id AND x.status = 'in_review')`);
  if (query.status === 'pending') where.push('d.pending_version_id IS NOT NULL');
  if (query.entityType && query.entityId) {
    where.push(`EXISTS (SELECT 1 FROM document_link l WHERE l.document_id = d.id AND l.entity_type = ${p(query.entityType)} AND l.entity_id = ${p(query.entityId)})`);
  }
  const rows = await many(
    tx,
    `SELECT d.id, d.facility_id, fac.code AS facility_code, d.doc_number, d.title, d.doc_type, d.tags, d.restricted, d.safety_critical, d.origin, d.issuer, d.issuer_doc_number,
            d.status, d.folder_id, f.name AS folder_name, d.read_roles, o.display_name AS owner_name,
            d.current_version_id, cv.version_label AS current_version_label, cv.approved_at AS current_approved_at, cv.effective_on AS current_effective_on, cv.issuer_revision AS current_issuer_revision,
            pv.version_label AS pending_version_label, pv.effective_on AS pending_effective_on,
            (SELECT x.status FROM document_version x WHERE x.document_id = d.id AND x.status IN ('draft','in_review') LIMIT 1) AS open_version_status
     FROM document d LEFT JOIN document_version cv ON cv.id = d.current_version_id LEFT JOIN document_version pv ON pv.id = d.pending_version_id
       LEFT JOIN document_folder f ON f.id = d.folder_id LEFT JOIN facility fac ON fac.id = d.facility_id LEFT JOIN app_user o ON o.id = d.owner_user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.doc_number LIMIT ${Math.min(query.limit ?? 200, 1000)}`,
    params,
  );
  const out = [];
  const folderRoles = new Map<string, string[]>();
  for (const d of rows) {
    if (!d.current_version_id && !can(actor, 'documents.view_draft', d.facility_id)) continue;
    let roles: string[] = d.read_roles;
    if (!roles.length && d.folder_id) {
      if (!folderRoles.has(d.folder_id)) folderRoles.set(d.folder_id, await readRolesOf(tx, { read_roles: [], folder_id: d.folder_id }));
      roles = folderRoles.get(d.folder_id)!;
    }
    if (!canReadWith(actor, d, roles)) continue;
    const draftView = can(actor, 'documents.view_draft', d.facility_id);
    out.push({ ...d, type_label: DOC_TYPE_LABEL[d.doc_type as DocType], has_draft: draftView ? !!d.open_version_status : undefined,
      open_version_status: draftView ? d.open_version_status : undefined, limited: roles.length > 0 });
  }
  return out;
}

/** The repository's answer first: what is in force, in review, waiting to take effect, and the external documents held. */
export async function repositoryOverview(tx: Tx, actor: Actor) {
  const docs = await searchDocuments(tx, actor, { limit: 1000 });
  const inReview = docs.filter((d) => d.open_version_status === 'in_review');
  const pending = docs.filter((d) => d.pending_version_label);
  const external = docs.filter((d) => d.origin === 'external');
  const mine = await many(tx, `SELECT count(*)::int AS n FROM approval_step s JOIN approval_request r ON r.id = s.request_id
    WHERE r.subject_type = $1 AND r.status = 'pending' AND s.status = 'pending' AND s.assignee_user_id = $2`, [SUBJECT, actor.userId]);
  const byType = new Map<string, number>();
  for (const d of docs) byType.set(d.type_label, (byType.get(d.type_label) ?? 0) + 1);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return {
    answer: !docs.length ? 'No controlled documents yet. Start with your SOPs, work instructions and the customer specifications you work to.'
      : `${n(docs.length, 'controlled document', 'controlled documents')} (${external.length} external); ${inReview.length} in review, ${pending.length} approved and waiting for their effective date.`,
    counts: { total: docs.length, inReview: inReview.length, pending: pending.length, external: external.length, waitingOnMe: mine[0]?.n ?? 0 },
    byType: [...byType.entries()].map(([label, k]) => ({ label, n: k })).sort((a, b) => b.n - a.n),
    folders: await listFolders(tx),
    types: DOC_TYPES.map((t) => ({ key: t, label: DOC_TYPE_LABEL[t], external: EXTERNAL_TYPES.has(t) })),
  };
}

export async function listFolders(tx: Tx) {
  return many(tx, `SELECT f.id, f.parent_id, f.name, f.read_roles, (SELECT count(*)::int FROM document d WHERE d.folder_id = f.id AND d.status = 'active') AS documents
    FROM document_folder f ORDER BY f.name`);
}

export async function saveFolder(tx: Tx, actor: Actor, input: { id?: string | null; name: string; parentId?: string | null; readRoles?: string[] }) {
  requirePermission(actor, 'documents.manage');
  if (!input.name?.trim()) throw invalid('a folder needs a name');
  if (input.parentId && !(await one(tx, 'SELECT 1 FROM document_folder WHERE id = $1', [input.parentId]))) throw notFound('parent folder');
  const known = new Set((await many(tx, 'SELECT DISTINCT key FROM role')).map((r) => r.key));
  for (const r of input.readRoles ?? []) if (!known.has(r)) throw invalid(`unknown role ${r}`);
  const f = input.id
    ? await one(tx, 'UPDATE document_folder SET name = $2, parent_id = $3, read_roles = $4 WHERE id = $1 RETURNING *', [input.id, input.name.trim(), input.parentId ?? null, input.readRoles ?? []])
    : await one(tx, 'INSERT INTO document_folder (tenant_id, parent_id, name, read_roles, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [actor.tenantId, input.parentId ?? null, input.name.trim(), input.readRoles ?? [], actor.userId]);
  if (!f) throw notFound('folder');
  if (input.id && input.parentId === input.id) throw invalid('a folder cannot be inside itself');
  await audit(tx, actor, { action: input.id ? 'document.folder_changed' : 'document.folder_created', entityType: 'document_folder', entityId: f.id, data: { name: f.name, readRoles: f.read_roles } });
  return f;
}

/** Every opening of a document's file is logged: who saw which revision, when (an auditor's question). */
export async function downloadVersion(tx: Tx, actor: Actor, blobs: BlobStore, versionId: string) {
  // RLS on document_version follows the parent document's tenant + facility visibility.
  const v = await one(
    tx,
    `SELECT v.*, d.facility_id, d.restricted, d.doc_number, d.read_roles, d.folder_id FROM document_version v JOIN document d ON d.id = v.document_id WHERE v.id = $1`,
    [versionId],
  );
  if (!v) throw notFound('document version');
  await assertCanViewDocument(tx, actor, v);
  const inForce = v.status === 'approved' && (!v.effective_on || new Date(v.effective_on).toISOString().slice(0, 10) <= new Date().toISOString().slice(0, 10));
  if (!inForce && !can(actor, 'documents.view_draft', v.facility_id)) throw notFound('document version');
  const content = await blobs.get(v.storage_key);
  await audit(tx, actor, { action: 'document.viewed', entityType: 'document', entityId: v.document_id, facilityId: v.facility_id, data: { versionId, revision: v.revision, status: v.status } });
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

/** People for the review form: every active user, marked when they may approve documents at the site; and the roles folders can be limited to. */
export async function documentPeople(tx: Tx, actor: Actor, facilityId: string | null) {
  requirePermission(actor, 'documents.manage', facilityId);
  const users = await many(tx, `SELECT u.id, u.display_name,
      EXISTS (SELECT 1 FROM user_role_scope a JOIN role r ON r.id = a.role_id WHERE a.user_id = u.id AND 'documents.approve' = ANY (r.permissions)
        AND (a.facility_id IS NULL OR $1::uuid IS NULL OR a.facility_id = $1)) AS can_approve
    FROM app_user u WHERE u.status = 'active' ORDER BY u.display_name`, [facilityId]);
  const roles = await many(tx, 'SELECT DISTINCT key, name FROM role ORDER BY name');
  return { users, roles };
}
