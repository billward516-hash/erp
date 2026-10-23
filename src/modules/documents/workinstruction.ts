import { z } from 'zod';
import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { diffLines } from './diff.js';
import { addVersion, readableVersion } from './service.js';

/**
 * Work instructions written in the app (D-170): purpose, hazards, protective equipment, tools and numbered steps, each
 * with an optional caution, a checkpoint (what to check or measure and to what) and photos. A revision is stored as a
 * file like any other, so its checksum, approval, effective date and read-and-understood all apply unchanged. Photos
 * are kept apart, hashed, and never changed once added; each step records the hash of the photos it shows.
 */
export const WI_MIME = 'application/vnd.erp.work-instruction+json';
const WI_KINDS = new Set(['work_instruction', 'sop', 'procedure', 'method']);

export const WorkInstruction = z.object({
  purpose: z.string().trim().min(3).max(2000),
  scope: z.string().trim().max(2000).optional().default(''),
  hazards: z.array(z.object({ text: z.string().trim().min(1).max(500) })).max(30).default([]),
  ppe: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  tools: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  steps: z.array(z.object({
    text: z.string().trim().min(2).max(2000),
    caution: z.string().trim().max(500).optional().default(''),
    checkpoint: z.object({ label: z.string().trim().min(1).max(300), spec: z.string().trim().max(200).optional().default('') }).nullable().optional().default(null),
    photos: z.array(z.object({ id: z.string().uuid(), sha256: z.string().optional() })).max(6).default([]),
  })).min(1).max(150),
});
export type WorkInstructionContent = z.infer<typeof WorkInstruction>;

/** The text of a work instruction, one line each, for search and comparison. */
export function toLines(c: WorkInstructionContent): string[] {
  return [`Purpose: ${c.purpose}`, ...(c.scope ? [`Scope: ${c.scope}`] : []), ...c.hazards.map((h) => `Hazard: ${h.text}`), ...(c.ppe.length ? [`PPE: ${c.ppe.join(', ')}`] : []),
    ...(c.tools.length ? [`Tools: ${c.tools.join(', ')}`] : []),
    ...c.steps.flatMap((s, i) => [`Step ${i + 1}: ${s.text}`, ...(s.caution ? [`Step ${i + 1} caution: ${s.caution}`] : []), ...(s.checkpoint ? [`Step ${i + 1} check: ${s.checkpoint.label}${s.checkpoint.spec ? ` (${s.checkpoint.spec})` : ''}`] : []),
      ...(s.photos.length ? [`Step ${i + 1} photos: ${s.photos.length}`] : [])])];
}

async function ownDocument(tx: Tx, actor: Actor, documentId: string) {
  const doc = await one(tx, 'SELECT * FROM document WHERE id = $1 FOR UPDATE', [documentId]);
  if (!doc) throw notFound('document');
  requirePermission(actor, 'documents.manage', doc.facility_id);
  if (doc.status === 'obsolete') throw conflict('the document is obsolete');
  return doc;
}

/** Saves the steps as a new draft revision, or rewrites the open draft when `versionId` names it. */
export async function saveWorkInstruction(tx: Tx, actor: Actor, blobs: BlobStore, documentId: string, input: { versionLabel: string; changeSummary?: string | null; content: unknown; versionId?: string | null }) {
  const doc = await ownDocument(tx, actor, documentId);
  if (!WI_KINDS.has(doc.doc_type)) throw invalid('only work instructions, SOPs, procedures and methods are written in the app');
  const parsed = WorkInstruction.safeParse(input.content);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => `${i.path.join('.') || 'content'}: ${i.message}`).slice(0, 3).join('; '));
  const content = parsed.data;
  // Each photo must be one of this document's; its hash is recorded in the step.
  const ids = [...new Set(content.steps.flatMap((s) => s.photos.map((p) => p.id)))];
  const media = ids.length ? await many(tx, 'SELECT id, sha256 FROM document_media WHERE document_id = $1 AND id = ANY ($2)', [documentId, ids]) : [];
  const hashes = new Map(media.map((m) => [m.id, m.sha256 as string]));
  for (const id of ids) if (!hashes.has(id)) throw invalid('a photo does not belong to this document; add it here first');
  for (const s of content.steps) s.photos = s.photos.map((p) => ({ id: p.id, sha256: hashes.get(p.id)! }));
  const body = Buffer.from(JSON.stringify(content), 'utf8');
  const text = toLines(content).join('\n');
  if (input.versionId) {
    const v = await one(tx, 'SELECT id, status FROM document_version WHERE id = $1 AND document_id = $2 FOR UPDATE', [input.versionId, documentId]);
    if (!v) throw notFound('document version');
    if (v.status !== 'draft') throw conflict(`a revision that is ${v.status.replace('_', ' ')} cannot be edited; write a new one`);
    const stored = await blobs.put(actor.tenantId, body);
    await tx.query(`UPDATE document_version SET storage_key = $2, sha256 = $3, size_bytes = $4, mime_type = $5, file_name = 'work-instruction.json', extracted_text = $6, change_summary = coalesce($7, change_summary),
      version_label = $8 WHERE id = $1`, [v.id, stored.key, stored.sha256, stored.size, WI_MIME, text, input.changeSummary?.trim() || null, input.versionLabel]);
    await audit(tx, actor, { action: 'document.draft_changed', entityType: 'document', entityId: documentId, facilityId: doc.facility_id, data: { versionId: v.id, sha256: stored.sha256, steps: content.steps.length } });
    return { id: v.id, sha256: stored.sha256, steps: content.steps.length };
  }
  const v = await addVersion(tx, actor, blobs, documentId, { versionLabel: input.versionLabel, fileName: 'work-instruction.json', mimeType: WI_MIME, content: body, changeSummary: input.changeSummary ?? undefined, extractedText: text });
  return { id: v.id, sha256: v.sha256, steps: content.steps.length };
}

const MEDIA_MAX = 10 * 1024 * 1024;
/** Adds a photo to a document's media (images only, up to 10 MB). Never changed or removed afterwards. */
export async function addMedia(tx: Tx, actor: Actor, blobs: BlobStore, documentId: string, input: { fileName: string; mimeType: string; content: Buffer }) {
  const doc = await ownDocument(tx, actor, documentId);
  if (!/^image\/(png|jpeg|gif|webp)$/.test(input.mimeType)) throw invalid('photos are PNG, JPEG, GIF or WebP images');
  if (!input.content.length || input.content.length > MEDIA_MAX) throw invalid('a photo is up to 10 MB');
  const stored = await blobs.put(actor.tenantId, input.content);
  const m = await one(tx, `INSERT INTO document_media (tenant_id, document_id, storage_key, file_name, mime_type, size_bytes, sha256, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, file_name, sha256`, [actor.tenantId, documentId, stored.key, input.fileName.slice(0, 200), input.mimeType, stored.size, stored.sha256, actor.userId]);
  await audit(tx, actor, { action: 'document.media_added', entityType: 'document', entityId: documentId, facilityId: doc.facility_id, data: { mediaId: m.id, sha256: m.sha256 } });
  return m;
}

/** A photo, for anyone who may read the document. */
export async function getMedia(tx: Tx, actor: Actor, blobs: BlobStore, documentId: string, mediaId: string) {
  const m = await one(tx, `SELECT m.*, d.facility_id, d.restricted FROM document_media m JOIN document d ON d.id = m.document_id WHERE m.id = $1 AND m.document_id = $2`, [mediaId, documentId]);
  if (!m) throw notFound('photo');
  requirePermission(actor, 'documents.view', m.facility_id);
  if (m.restricted && !can(actor, 'documents.view_restricted', m.facility_id)) throw forbidden('documents.view_restricted');
  return { content: await blobs.get(m.storage_key), mimeType: m.mime_type as string, fileName: m.file_name as string, sha256: m.sha256 as string };
}

/** Two revisions side by side, line by line, for anyone who may read both. */
export async function compareVersions(tx: Tx, actor: Actor, blobs: BlobStore, documentId: string, fromId: string, toId: string) {
  if (fromId === toId) throw invalid('choose two different revisions');
  const load = async (id: string) => {
    const v = await readableVersion(tx, actor, documentId, id);
    const buf = await blobs.get(v.storage_key);
    return { v, buf };
  };
  const [a, b] = [await load(fromId), await load(toId)];
  const lines = (x: { v: any; buf: Buffer }): string[] | null => {
    if (x.v.mime_type === WI_MIME) { try { return toLines(WorkInstruction.parse(JSON.parse(x.buf.toString('utf8')))); } catch { return null; } }
    if (String(x.v.mime_type).startsWith('text/')) return x.buf.toString('utf8').split(/\r?\n/);
    return null;
  };
  const [la, lb] = [lines(a), lines(b)];
  const side = (x: { v: any }) => ({ id: x.v.id, revision: x.v.revision, version_label: x.v.version_label, status: x.v.status, sha256: x.v.sha256, change_summary: x.v.change_summary });
  await audit(tx, actor, { action: 'document.compared', entityType: 'document', entityId: documentId, data: { from: fromId, to: toId } });
  if (!la || !lb) return { comparable: false, identical: a.v.sha256 === b.v.sha256, from: side(a), to: side(b), lines: [], added: 0, removed: 0, truncated: false,
    answer: a.v.sha256 === b.v.sha256 ? 'The two files are identical.' : 'These revisions are files the browser cannot compare line by line; their checksums differ, so the content differs.' };
  const d = diffLines(la, lb);
  return { comparable: true, identical: !d.added && !d.removed, from: side(a), to: side(b), ...d,
    answer: !d.added && !d.removed ? 'The two revisions read the same.' : `${d.added} line${d.added === 1 ? '' : 's'} added and ${d.removed} removed from revision ${a.v.version_label} to ${b.v.version_label}.` };
}

