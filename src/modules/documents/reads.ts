import type { Actor } from '../../platform/auth/actor.js';
import { can } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';

/**
 * Read and understood (D-170). A document can require its audience to read and acknowledge every revision. When a
 * revision is released, each person in the audience gets an obligation due on the revision's effective date (or a set
 * number of days after release, 7 by default). A person can acknowledge only after opening that revision: the opening
 * is already logged, so "read" is evidenced, and the acknowledgement is a record that cannot change. A newer revision
 * released before an obligation was met supersedes it.
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (from: string, n: number) => { const d = new Date(`${from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** Who must read it: people holding one of the named roles (or, with none named, any role that may read documents) at the document's site. */
export async function audienceOf(tx: Tx, doc: { facility_id: string | null; ack_roles: string[] }): Promise<string[]> {
  const rows = await many(tx, `SELECT DISTINCT u.id FROM app_user u JOIN user_role_scope a ON a.user_id = u.id JOIN role r ON r.id = a.role_id
    WHERE u.status = 'active' AND (a.facility_id IS NULL OR $1::uuid IS NULL OR a.facility_id = $1)
      AND (cardinality($2::text[]) > 0 AND r.key = ANY ($2) OR cardinality($2::text[]) = 0 AND 'documents.view' = ANY (r.permissions))`, [doc.facility_id, doc.ack_roles]);
  return rows.map((r) => r.id as string);
}

/** Creates the obligations for a released revision (safe to repeat) and tells the audience. */
export async function createObligations(tx: Tx, actor: Pick<Actor, 'tenantId' | 'userId'>, doc: { id: string; facility_id: string | null; ack_roles: string[]; doc_number: string; title: string },
  version: { id: string; revision: number; version_label: string }, effectiveOn: string) {
  const today = iso(new Date());
  const s = await one(tx, 'SELECT ack_days FROM document_settings');
  const due = effectiveOn > today ? effectiveOn : addDays(today, s?.ack_days ?? 7);
  const people = await audienceOf(tx, doc);
  const created: string[] = [];
  for (const u of people) {
    const r = await tx.query(`INSERT INTO document_read_obligation (tenant_id, document_id, version_id, user_id, due_on) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (version_id, user_id) DO NOTHING RETURNING user_id`,
      [actor.tenantId, doc.id, version.id, u, due]);
    if (r.rowCount) created.push(u);
  }
  // A person who has not yet read an earlier revision no longer needs to: the newer one replaces it.
  await tx.query(`UPDATE document_read_obligation SET superseded_at = now() WHERE document_id = $1 AND version_id <> $2 AND acknowledged_at IS NULL AND superseded_at IS NULL`, [doc.id, version.id]);
  if (created.length) {
    await notify(tx, actor.tenantId, created, { kind: 'action.assigned', title: `Read and acknowledge ${doc.doc_number} revision ${version.version_label} by ${due}`, link: `/documents/${doc.id}?version=${version.id}`,
      subjectType: 'document_version', subjectId: version.id, dedupeKey: `read:${version.id}` }, actor.userId);
  }
  return { created: created.length, dueOn: due };
}

/** The person's own open obligations, soonest first. */
export async function myReads(tx: Tx, actor: Actor) {
  return many(tx, `SELECT o.id, o.document_id, o.version_id, o.due_on, (o.due_on < current_date) AS overdue, d.doc_number, d.title, v.version_label, v.revision,
      EXISTS (SELECT 1 FROM audit_event e WHERE e.actor_user_id = $1 AND e.action = 'document.viewed' AND e.entity_id = o.document_id AND e.data->>'versionId' = o.version_id::text) AS opened
    FROM document_read_obligation o JOIN document d ON d.id = o.document_id JOIN document_version v ON v.id = o.version_id
    WHERE o.user_id = $1 AND o.acknowledged_at IS NULL AND o.superseded_at IS NULL ORDER BY o.due_on, d.doc_number`, [actor.userId]);
}

/** "I have read and understood this revision." Needs the revision to have been opened by this person first. */
export async function acknowledge(tx: Tx, actor: Actor, versionId: string) {
  const o = await one(tx, `SELECT o.*, d.doc_number, d.facility_id, v.revision FROM document_read_obligation o JOIN document d ON d.id = o.document_id JOIN document_version v ON v.id = o.version_id
    WHERE o.version_id = $1 AND o.user_id = $2 FOR UPDATE OF o`, [versionId, actor.userId]);
  if (!o) throw notFound('a reading assigned to you for this revision');
  if (o.acknowledged_at) throw conflict('you have already acknowledged this revision');
  if (o.superseded_at) throw conflict('a newer revision replaced this one; read that one instead');
  const opened = await one(tx, `SELECT 1 FROM audit_event WHERE actor_user_id = $1 AND action = 'document.viewed' AND entity_id = $2 AND data->>'versionId' = $3 LIMIT 1`, [actor.userId, o.document_id, versionId]);
  if (!opened) throw invalid('open the document and read it first; the acknowledgement follows the reading');
  await tx.query('UPDATE document_read_obligation SET acknowledged_at = now() WHERE id = $1', [o.id]);
  await audit(tx, actor, { action: 'document.acknowledged', entityType: 'document', entityId: o.document_id, facilityId: o.facility_id, data: { versionId, revision: o.revision, late: new Date(o.due_on).getTime() < Date.now() - 86_400_000 } });
  return { versionId, acknowledgedAt: new Date().toISOString() };
}

/** For document managers: who has and has not read each revision of one document. */
export async function readStatus(tx: Tx, actor: Actor, documentId: string) {
  const d = await one(tx, 'SELECT facility_id FROM document WHERE id = $1', [documentId]);
  if (!d) throw notFound('document');
  if (!can(actor, 'documents.manage', d.facility_id)) return { revisions: [], people: [] };
  const revisions = await many(tx, `SELECT v.id AS version_id, v.revision, v.version_label, count(*)::int AS required, count(*) FILTER (WHERE o.acknowledged_at IS NOT NULL)::int AS acknowledged,
      count(*) FILTER (WHERE o.acknowledged_at IS NULL AND o.superseded_at IS NULL AND o.due_on < current_date)::int AS overdue, count(*) FILTER (WHERE o.superseded_at IS NOT NULL AND o.acknowledged_at IS NULL)::int AS superseded
    FROM document_read_obligation o JOIN document_version v ON v.id = o.version_id WHERE o.document_id = $1 GROUP BY v.id, v.revision, v.version_label ORDER BY v.revision DESC`, [documentId]);
  const people = await many(tx, `SELECT o.version_id, u.display_name, o.due_on, o.acknowledged_at, (o.acknowledged_at IS NULL AND o.superseded_at IS NULL AND o.due_on < current_date) AS overdue
    FROM document_read_obligation o JOIN app_user u ON u.id = o.user_id WHERE o.document_id = $1 AND o.superseded_at IS NULL ORDER BY o.acknowledged_at IS NOT NULL, o.due_on, u.display_name LIMIT 500`, [documentId]);
  return { revisions, people };
}

/** Daily: tells people about readings past their due date (once a day each). */
export async function remindOverdueReads(tx: Tx, tenantId: string) {
  const late = await many(tx, `SELECT o.user_id, o.document_id, o.version_id, o.due_on, d.doc_number, v.version_label FROM document_read_obligation o JOIN document d ON d.id = o.document_id
    JOIN document_version v ON v.id = o.version_id WHERE o.acknowledged_at IS NULL AND o.superseded_at IS NULL AND o.due_on < current_date`);
  for (const o of late) {
    await notify(tx, tenantId, [o.user_id], { kind: 'reminder.review_due', title: `Overdue: read and acknowledge ${o.doc_number} revision ${o.version_label} (was due ${iso(new Date(o.due_on))})`,
      link: `/documents/${o.document_id}?version=${o.version_id}`, subjectType: 'document_version', subjectId: o.version_id, dedupeKey: `read-late:${o.version_id}:${iso(new Date())}` });
  }
  return late.length;
}
