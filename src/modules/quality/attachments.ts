import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { forbidden, invalid, notFound } from '../../platform/errors.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';

export type AttachmentSubject = 'nonconformance' | 'corrective_action' | 'safety_incident' | 'calibration_record' | 'quality_audit' | 'fmea' | 'continuity_plan' | 'continuity_exercise' | 'moc_change' | 'inbound_rfq' | 'quote' | 'change_notice' | 'temporary_change';
/** Equipment qualification (SC-007 B): files on a protocol and on a result entry (evidence photos, instrument printouts, certificates). */
export type QualificationSubject = 'qualification_protocol' | 'qualification_result';
async function qualificationAccess(tx: Tx, actor: Actor, type: QualificationSubject, id: string) {
  const s = type === 'qualification_protocol'
    ? await one(tx, 'SELECT facility_id, status FROM qualification_protocol WHERE id = $1', [id])
    : await one(tx, 'SELECT r.facility_id, p.status FROM qualification_result r JOIN qualification_protocol p ON p.id = r.protocol_id WHERE r.id = $1', [id]);
  if (!s) throw notFound(type.replace(/_/g, ' '));
  if (!can(actor, 'qualification.view', s.facility_id)) throw forbidden('qualification.view');
  return { facilityId: s.facility_id as string, safetyStaff: false, status: s.status as string | undefined, mine: false, manage: false };
}
export const ATTACHMENT_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp', 'text/plain', 'text/csv'];
/** Justification decks on changes (D-159): PowerPoint or PDF, larger than other files. */
export const PRESENTATION_MIME = ['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PRESENTATION_BYTES = 25 * 1024 * 1024;
/** Files that arrive with a customer's request for quote (SC-005 B): specifications, drawings, spreadsheets and archives, up to 25 MB. */
export const RFQ_MIME = [...ATTACHMENT_MIME, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream', 'image/vnd.dwg', 'image/vnd.dxf', 'model/step'];

/**
 * Who may read and add files on a record: the same people who can see it (the reporter of a nonconformance
 * or incident included). Restricted incident files (default for files on incidents, since photos may show the
 * people involved) are readable by safety staff and the uploader only.
 */
async function access(tx: Tx, actor: Actor, type: AttachmentSubject | QualificationSubject, id: string) {
  if (type === 'qualification_protocol' || type === 'qualification_result') return qualificationAccess(tx, actor, type, id);
  const q: Record<AttachmentSubject, string> = {
    nonconformance: 'SELECT facility_id, reported_by AS owner FROM nonconformance WHERE id = $1',
    corrective_action: 'SELECT facility_id, owner_user_id AS owner FROM corrective_action WHERE id = $1',
    safety_incident: 'SELECT facility_id, reported_by AS owner FROM safety_incident WHERE id = $1',
    calibration_record: 'SELECT facility_id, NULL::uuid AS owner FROM calibration_record WHERE id = $1',
    quality_audit: 'SELECT facility_id, lead_auditor_id AS owner, auditee_user_id AS other FROM quality_audit WHERE id = $1',
    fmea: 'SELECT facility_id, owner_user_id AS owner FROM fmea WHERE id = $1',
    continuity_plan: 'SELECT facility_id, owner_user_id AS owner, alternate_user_id AS other FROM continuity_plan WHERE id = $1',
    continuity_exercise: `SELECT e.facility_id, e.facilitator_user_id AS owner, p.owner_user_id AS other FROM continuity_exercise e JOIN continuity_plan p ON p.id = e.plan_id WHERE e.id = $1`,
    moc_change: 'SELECT facility_id, owner_user_id AS owner, requested_by AS other, status FROM moc_change WHERE id = $1',
    inbound_rfq: 'SELECT facility_id, owner_user_id AS owner FROM inbound_rfq WHERE id = $1',
    quote: 'SELECT facility_id, created_by AS owner FROM quote WHERE id = $1',
    change_notice: 'SELECT facility_id, owner_user_id AS owner FROM change_notice WHERE id = $1',
    temporary_change: 'SELECT facility_id, owner_user_id AS owner FROM temporary_change WHERE id = $1',
  };
  const s = await one(tx, q[type], [id]);
  if (!s) throw notFound(type.replace(/_/g, ' '));
  const mine = s.owner === actor.userId || s.other === actor.userId;
  const perm = type === 'safety_incident' ? 'safety.view' : type.startsWith('continuity') ? 'continuity.view' : type === 'moc_change' ? 'moc.view' : type === 'inbound_rfq' || type === 'quote' ? 'sales.view' : type === 'change_notice' || type === 'temporary_change' ? 'moc.view' : 'quality.view';
  if (!(can(actor, perm, s.facility_id) || mine)) throw forbidden(perm);
  return { facilityId: s.facility_id as string, safetyStaff: can(actor, 'safety.manage', s.facility_id), status: s.status as string | undefined, mine,
    manage: type === 'moc_change' && can(actor, 'moc.manage', s.facility_id) };
}

export async function addAttachment(tx: Tx, actor: Actor, blobs: BlobStore, input: { subjectType: AttachmentSubject | QualificationSubject; subjectId: string; fileName: string; mime: string; content: Buffer; restricted?: boolean }) {
  const a = await access(tx, actor, input.subjectType, input.subjectId);
  if (input.subjectType === 'qualification_protocol' || input.subjectType === 'qualification_result') {
    if (!can(actor, 'qualification.execute', a.facilityId)) throw forbidden('qualification.execute');
    if (!['draft', 'executed'].includes(a.status ?? '')) throw invalid('files can no longer be added once the protocol has been decided');
  }
  const deck = input.subjectType === 'moc_change';
  const rfq = ['inbound_rfq', 'quote', 'change_notice', 'temporary_change'].includes(input.subjectType);
  if (deck) {
    // The deck behind a change's justification (D-159): only while the change is a draft, by its requester, owner or a change coordinator.
    if (!['draft', 'rejected'].includes(a.status ?? '')) throw invalid('the presentation can be replaced only while the change is a draft; revise the change first (its approvals are then voided)');
    if (!a.mine && !a.manage) throw forbidden('moc.manage');
    if (!PRESENTATION_MIME.includes(input.mime)) throw invalid('upload the presentation as PowerPoint (.pptx, .ppt) or PDF');
    if (input.content.length > MAX_PRESENTATION_BYTES) throw invalid('presentations are limited to 25 MB');
  } else if (rfq) {
    if (!RFQ_MIME.includes(input.mime)) throw invalid(`file type ${input.mime} is not accepted for a request for quote`);
    if (input.content.length > MAX_PRESENTATION_BYTES) throw invalid('files are limited to 25 MB');
  } else if (!ATTACHMENT_MIME.includes(input.mime)) throw invalid(`file type ${input.mime} is not accepted (PDF, images or text)`);
  if (!input.content.length) throw invalid('the file is empty');
  if (!deck && !rfq && input.content.length > MAX_BYTES) throw invalid('files are limited to 10 MB');
  const restricted = input.subjectType === 'safety_incident' ? input.restricted ?? true : false;
  const stored = await blobs.put(actor.tenantId, input.content);
  const row = await one(tx, `INSERT INTO attachment (tenant_id, facility_id, subject_type, subject_id, file_name, mime, size_bytes, blob_key, sha256, restricted, uploaded_by, purpose)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, file_name, mime, size_bytes, restricted, created_at, purpose`,
  [actor.tenantId, a.facilityId, input.subjectType, input.subjectId, input.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 200), input.mime, input.content.length, stored.key, stored.sha256, restricted, actor.userId, deck ? 'justification_presentation' : null]);
  await audit(tx, actor, { action: 'attachment.added', entityType: input.subjectType, entityId: input.subjectId, facilityId: a.facilityId, data: { file: row.file_name, sha256: stored.sha256, restricted, ...(deck ? { purpose: 'justification_presentation' } : {}) } });
  return row;
}

export async function listAttachments(tx: Tx, actor: Actor, subjectType: AttachmentSubject | QualificationSubject, subjectId: string) {
  const a = await access(tx, actor, subjectType, subjectId);
  const rows = await many(tx, `SELECT x.id, x.file_name, x.mime, x.size_bytes, x.restricted, x.created_at, x.uploaded_by, x.purpose, u.display_name AS uploaded_by_name
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
