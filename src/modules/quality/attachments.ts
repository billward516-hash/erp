import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { forbidden, invalid, notFound } from '../../platform/errors.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';

export type AttachmentSubject = 'nonconformance' | 'corrective_action' | 'safety_incident' | 'calibration_record' | 'quality_audit';
export const ATTACHMENT_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp', 'text/plain', 'text/csv'];
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Who may read and add files on a record: the same people who can see it (the reporter of a nonconformance
 * or incident included). Restricted incident files (default for files on incidents, since photos may show the
 * people involved) are readable by safety staff and the uploader only.
 */
async function access(tx: Tx, actor: Actor, type: AttachmentSubject, id: string) {
  const q: Record<AttachmentSubject, string> = {
    nonconformance: 'SELECT facility_id, reported_by AS owner FROM nonconformance WHERE id = $1',
    corrective_action: 'SELECT facility_id, owner_user_id AS owner FROM corrective_action WHERE id = $1',
    safety_incident: 'SELECT facility_id, reported_by AS owner FROM safety_incident WHERE id = $1',
    calibration_record: 'SELECT facility_id, NULL::uuid AS owner FROM calibration_record WHERE id = $1',
    quality_audit: 'SELECT facility_id, lead_auditor_id AS owner, auditee_user_id AS other FROM quality_audit WHERE id = $1',
  };
  const s = await one(tx, q[type], [id]);
  if (!s) throw notFound(type.replace(/_/g, ' '));
  const mine = s.owner === actor.userId || s.other === actor.userId;
  const ok = type === 'safety_incident' ? can(actor, 'safety.view', s.facility_id) || mine : can(actor, 'quality.view', s.facility_id) || mine;
  if (!ok) throw forbidden(type === 'safety_incident' ? 'safety.view' : 'quality.view');
  return { facilityId: s.facility_id as string, safetyStaff: can(actor, 'safety.manage', s.facility_id) };
}

export async function addAttachment(tx: Tx, actor: Actor, blobs: BlobStore, input: { subjectType: AttachmentSubject; subjectId: string; fileName: string; mime: string; content: Buffer; restricted?: boolean }) {
  const a = await access(tx, actor, input.subjectType, input.subjectId);
  if (!ATTACHMENT_MIME.includes(input.mime)) throw invalid(`file type ${input.mime} is not accepted (PDF, images or text)`);
  if (!input.content.length) throw invalid('the file is empty');
  if (input.content.length > MAX_BYTES) throw invalid('files are limited to 10 MB');
  const restricted = input.subjectType === 'safety_incident' ? input.restricted ?? true : false;
  const stored = await blobs.put(actor.tenantId, input.content);
  const row = await one(tx, `INSERT INTO attachment (tenant_id, facility_id, subject_type, subject_id, file_name, mime, size_bytes, blob_key, sha256, restricted, uploaded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, file_name, mime, size_bytes, restricted, created_at`,
  [actor.tenantId, a.facilityId, input.subjectType, input.subjectId, input.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 200), input.mime, input.content.length, stored.key, stored.sha256, restricted, actor.userId]);
  await audit(tx, actor, { action: 'attachment.added', entityType: input.subjectType, entityId: input.subjectId, facilityId: a.facilityId, data: { file: row.file_name, sha256: stored.sha256, restricted } });
  return row;
}

export async function listAttachments(tx: Tx, actor: Actor, subjectType: AttachmentSubject, subjectId: string) {
  const a = await access(tx, actor, subjectType, subjectId);
  const rows = await many(tx, `SELECT x.id, x.file_name, x.mime, x.size_bytes, x.restricted, x.created_at, x.uploaded_by, u.display_name AS uploaded_by_name
    FROM attachment x JOIN app_user u ON u.id = x.uploaded_by WHERE x.subject_type = $1 AND x.subject_id = $2 ORDER BY x.created_at`, [subjectType, subjectId]);
  return rows.filter((r) => !r.restricted || a.safetyStaff || r.uploaded_by === actor.userId);
}

export async function attachmentFile(tx: Tx, actor: Actor, blobs: BlobStore, id: string) {
  const x = await one(tx, 'SELECT * FROM attachment WHERE id = $1', [id]);
  if (!x) throw notFound('attachment');
  const a = await access(tx, actor, x.subject_type, x.subject_id);
  if (x.restricted && !a.safetyStaff && x.uploaded_by !== actor.userId) throw forbidden('safety.manage');
  return { name: x.file_name as string, mime: x.mime as string, content: await blobs.get(x.blob_key) };
}
