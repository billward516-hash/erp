import { createHash } from 'node:crypto';
import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { notFound } from '../../platform/errors.js';
import { zip, type ZipEntry } from '../../platform/http/zip.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { toCsv } from '../reporting/render/csv.js';
import { searchDocuments } from './service.js';
import { verifySeal } from './signatures.js';

/**
 * The audit pack (D-170): one zip an auditor can be handed, for the whole repository or one document. It holds the master
 * list and the obsolete register, every revision with its author, reviewers, approver, reason and effective date, each
 * signature (recomputed to show it is intact), every acknowledgement, every specification review, every view and change as
 * the tamper-evident audit log, and the released files themselves; a manifest lists the checksum of everything in the pack
 * and whether the audit chain verifies. Only documents the requester manages are included.
 */
const FILE_CAP = 150 * 1024 * 1024;
const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : '');
const ts = (d: unknown) => (d ? new Date(d as string).toISOString() : '');
const safe = (s: string) => s.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function buildAuditPack(tx: Tx, actor: Actor, blobs: BlobStore, opts: { documentId?: string } = {}) {
  requirePermission(actor, 'documents.manage');
  const found = [...await searchDocuments(tx, actor, { status: 'active', limit: 1000 }), ...await searchDocuments(tx, actor, { status: 'obsolete', limit: 1000 })]
    .filter((d) => can(actor, 'documents.manage', d.facility_id) && (!opts.documentId || d.id === opts.documentId));
  if (opts.documentId && !found.length) throw notFound('document');
  const ids = found.map((d) => d.id as string);
  const docs = await many(tx, `SELECT d.*, f.code AS site, fo.name AS folder, o.display_name AS owner FROM document d LEFT JOIN facility f ON f.id = d.facility_id LEFT JOIN document_folder fo ON fo.id = d.folder_id
    LEFT JOIN app_user o ON o.id = d.owner_user_id WHERE d.id = ANY ($1) ORDER BY d.doc_number`, [ids]);
  const versions = await many(tx, `SELECT v.*, d.doc_number, cu.display_name AS author, au.display_name AS approver, su.display_name AS submitter FROM document_version v JOIN document d ON d.id = v.document_id
    LEFT JOIN app_user cu ON cu.id = v.created_by LEFT JOIN app_user au ON au.id = v.approved_by LEFT JOIN app_user su ON su.id = v.submitted_by WHERE v.document_id = ANY ($1) ORDER BY d.doc_number, v.revision`, [ids]);
  const steps = await many(tx, `SELECT d.doc_number, v.revision, s.stage, s.label, s.status, ub.display_name AS decided_by, ob.display_name AS on_behalf_of, s.decided_at, s.comment FROM approval_step s
    JOIN approval_request r ON r.id = s.request_id AND r.subject_type = 'document_version' JOIN document_version v ON v.id = r.subject_id JOIN document d ON d.id = v.document_id
    LEFT JOIN app_user ub ON ub.id = s.decided_by LEFT JOIN app_user ob ON ob.id = s.on_behalf_of WHERE v.document_id = ANY ($1) ORDER BY d.doc_number, v.revision, r.created_at, s.stage`, [ids]);
  const sigs = await many(tx, `SELECT sg.*, d.doc_number, v.revision FROM document_signature sg JOIN document_version v ON v.id = sg.version_id JOIN document d ON d.id = sg.document_id WHERE sg.document_id = ANY ($1) ORDER BY d.doc_number, v.revision, sg.signed_at`, [ids]);
  const acks = await many(tx, `SELECT d.doc_number, v.revision, u.display_name AS person, o.due_on, o.acknowledged_at, o.superseded_at FROM document_read_obligation o JOIN document d ON d.id = o.document_id
    JOIN document_version v ON v.id = o.version_id JOIN app_user u ON u.id = o.user_id WHERE o.document_id = ANY ($1) ORDER BY d.doc_number, v.revision, u.display_name`, [ids]);
  const reviews = await many(tx, `SELECT d.doc_number, v.issuer_revision, r.received_on, r.due_on, r.status, r.what_changed, r.assessment, bu.display_name AS assessed_by, r.assessed_at, r.customer_due_on,
      (SELECT string_agg(fd.doc_number || ' ' || f.status, '; ') FROM spec_review_followup f JOIN document fd ON fd.id = f.document_id WHERE f.review_id = r.id) AS followups
    FROM spec_review r JOIN document d ON d.id = r.document_id JOIN document_version v ON v.id = r.version_id LEFT JOIN app_user bu ON bu.id = r.assessed_by WHERE r.document_id = ANY ($1) ORDER BY d.doc_number, r.received_on`, [ids]);
  const events = await many(tx, `SELECT e.id, e.occurred_at, u.display_name AS actor, e.action, d.doc_number, e.data::text AS data, encode(e.prev_hash, 'hex') AS prev_hash, encode(e.hash, 'hex') AS hash
    FROM audit_event e JOIN document d ON d.id = e.entity_id LEFT JOIN app_user u ON u.id = e.actor_user_id WHERE e.entity_type = 'document' AND e.entity_id = ANY ($1) ORDER BY e.id LIMIT 250000`, [ids]);
  const chain = await one(tx, 'SELECT audit_verify_chain() AS broken');
  const me = await one(tx, 'SELECT display_name FROM app_user WHERE id = $1', [actor.userId]);

  const vers = new Map(versions.map((v) => [v.id, v]));
  const docRows = docs.map((d) => {
    const cur = d.current_version_id ? vers.get(d.current_version_id) : null;
    return { number: d.doc_number, title: d.title, kind: d.doc_type, origin: d.origin, issuer: d.issuer ?? '', issuer_number: d.issuer_doc_number ?? '', site: d.site ?? 'Company', folder: d.folder ?? '', owner: d.owner ?? '',
      status: d.status, restricted: d.restricted, safety_critical: d.safety_critical, read_roles: (d.read_roles ?? []).join(' '), read_required: d.ack_required, revision_in_force: cur?.version_label ?? '',
      effective_on: day(cur?.effective_on), approved_by: cur?.approver ?? '', approved_at: ts(cur?.approved_at), sha256: cur?.sha256 ?? '', obsoleted_at: ts(d.obsoleted_at), obsolete_reason: d.obsolete_reason ?? '' };
  });
  const entries: ZipEntry[] = [];
  const add = (name: string, text: string | Buffer) => entries.push({ name, data: Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8') });
  const csv = (cols: string[], rows: Record<string, unknown>[]) => toCsv(cols, rows);
  add('master-list.csv', csv(Object.keys(docRows[0] ?? { number: 1 }), docRows));
  add('obsolete-register.csv', csv(['number', 'title', 'kind', 'obsoleted_at', 'obsolete_reason'], docRows.filter((d) => d.status === 'obsolete')));
  add('revisions.csv', csv(['number', 'revision', 'label', 'status', 'author', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'effective_on', 'reason_for_change', 'file_name', 'mime_type', 'size_bytes', 'sha256', 'issuer_revision', 'received_on'],
    versions.map((v) => ({ number: v.doc_number, revision: v.revision, label: v.version_label, status: v.status, author: v.author, submitted_by: v.submitter, submitted_at: ts(v.submitted_at), approved_by: v.approver, approved_at: ts(v.approved_at),
      effective_on: day(v.effective_on), reason_for_change: v.change_summary ?? '', file_name: v.file_name, mime_type: v.mime_type, size_bytes: v.size_bytes, sha256: v.sha256, issuer_revision: v.issuer_revision ?? '', received_on: day(v.received_on) }))));
  add('reviews-and-approvals.csv', csv(['number', 'revision', 'stage', 'step', 'decision', 'by', 'on_behalf_of', 'at', 'comment'],
    steps.map((s) => ({ number: s.doc_number, revision: s.revision, stage: s.stage, step: s.label, decision: s.status, by: s.decided_by ?? '', on_behalf_of: s.on_behalf_of ?? '', at: ts(s.decided_at), comment: s.comment ?? '' }))));
  const sigRows = sigs.map((s) => ({ number: s.doc_number, revision: s.revision, signer: s.signer_name, meaning: s.meaning, signed_at: ts(s.signed_at), file_sha256: s.version_sha256, signature_hash: s.signature_hash,
    seal_intact: verifySeal(s, { doc_number: s.doc_number, revision: s.revision }) && s.version_sha256 === vers.get(s.version_id)?.sha256 }));
  add('signatures.csv', csv(['number', 'revision', 'signer', 'meaning', 'signed_at', 'file_sha256', 'signature_hash', 'seal_intact'], sigRows));
  add('acknowledgements.csv', csv(['number', 'revision', 'person', 'due_on', 'acknowledged_at', 'status'],
    acks.map((a) => ({ number: a.doc_number, revision: a.revision, person: a.person, due_on: day(a.due_on), acknowledged_at: ts(a.acknowledged_at), status: a.acknowledged_at ? 'acknowledged' : a.superseded_at ? 'replaced by a newer revision' : new Date(a.due_on) < new Date() ? 'overdue' : 'open' }))));
  add('specification-reviews.csv', csv(['number', 'issuer_revision', 'received_on', 'due_on', 'status', 'what_changed', 'assessment', 'assessed_by', 'assessed_at', 'customer_due_on', 'followups'],
    reviews.map((r) => ({ ...r, number: r.doc_number, received_on: day(r.received_on), due_on: day(r.due_on), assessed_at: ts(r.assessed_at), customer_due_on: day(r.customer_due_on), followups: r.followups ?? '' }))));
  add('audit-log.csv', csv(['id', 'at', 'actor', 'action', 'number', 'data', 'prev_hash', 'hash'], events.map((e) => ({ id: e.id, at: ts(e.occurred_at), actor: e.actor ?? '', action: e.action, number: e.doc_number, data: e.data, prev_hash: e.prev_hash ?? '', hash: e.hash }))));
  // The released files themselves, up to a size cap.
  let bytes = 0; const omitted: Record<string, unknown>[] = []; const fileList: Record<string, unknown>[] = [];
  for (const v of versions.filter((x) => ['approved', 'superseded', 'obsolete'].includes(x.status))) {
    const path = `files/${safe(v.doc_number)}/rev-${v.revision}-${safe(v.file_name)}`;
    if (bytes + Number(v.size_bytes) > FILE_CAP) { omitted.push({ number: v.doc_number, revision: v.revision, file_name: v.file_name, size_bytes: v.size_bytes, sha256: v.sha256, reason: 'over the size cap of the pack' }); continue; }
    try { const buf = await blobs.get(v.storage_key); const ok = sha(buf) === v.sha256; if (!ok) throw new Error('checksum differs'); bytes += buf.length; entries.push({ name: path, data: buf }); fileList.push({ path, sha256: v.sha256, bytes: buf.length }); }
    catch (e) { omitted.push({ number: v.doc_number, revision: v.revision, file_name: v.file_name, size_bytes: v.size_bytes, sha256: v.sha256, reason: `could not be read intact: ${(e as Error).message}` }); }
  }
  if (omitted.length) add('files-not-included.csv', csv(['number', 'revision', 'file_name', 'size_bytes', 'sha256', 'reason'], omitted));
  const manifest = {
    generatedAt: new Date().toISOString(), generatedBy: me?.display_name ?? '', scope: opts.documentId ? `document ${docs[0]?.doc_number}` : `${docs.length} documents`,
    counts: { documents: docs.length, revisions: versions.length, signatures: sigRows.length, acknowledgements: acks.length, specificationReviews: reviews.length, auditEvents: events.length, files: fileList.length, filesOmitted: omitted.length },
    auditChain: { intact: chain?.broken == null, firstBrokenEventId: chain?.broken ?? null, note: 'The audit chain of the whole company is verified: every event is hashed with the one before it.' },
    signaturesIntact: sigRows.every((s) => s.seal_intact),
    files: entries.map((e) => ({ path: e.name, sha256: sha(e.data), bytes: e.data.length })),
  };
  add('manifest.json', JSON.stringify(manifest, null, 2));
  add('README.txt', `Document control audit pack, ${manifest.generatedAt}\nGenerated by ${manifest.generatedBy}. Scope: ${manifest.scope}.\n\nmaster-list.csv            every controlled document with the revision in force\nobsolete-register.csv      documents withdrawn from use, with the reason\n`
    + 'revisions.csv              every revision: author, approver, dates, reason for change, file checksum\nreviews-and-approvals.csv  every review and approval step with its comment\nsignatures.csv             electronic signatures, with a check that each seal is intact\n'
    + 'acknowledgements.csv       read-and-understood records\nspecification-reviews.csv  impact reviews of customer specification and standard revisions\naudit-log.csv              every change and every opening, with the hash chain\nfiles/                     the released files, each checked against its recorded checksum\nmanifest.json              checksum of every file in this pack and the audit chain result\n');
  await audit(tx, actor, { action: 'document.audit_pack', entityType: 'document', entityId: opts.documentId ?? null, data: { scope: manifest.scope, counts: manifest.counts } });
  return { body: zip(entries), fileName: `document-audit-pack-${new Date().toISOString().slice(0, 10)}${opts.documentId ? `-${safe(docs[0]!.doc_number)}` : ''}.zip`, manifest };
}
