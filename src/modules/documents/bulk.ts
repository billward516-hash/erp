import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';
import { readZip } from '../../platform/http/zip-read.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { parseFile } from '../imports/parsers/index.js';
import { createDocument, DOC_TYPES, EXTERNAL_TYPES, saveFolder } from './service.js';
import type { DocType } from './service.js';

/**
 * Bulk document load (SC-003): a zip with the files and an index sheet (index.csv, index.xlsx or index.json) saying what each is.
 * Each row becomes a released revision brought over from the previous system, with its own effective date: there is no review
 * to run again, and the approval evidence stays in the source (recorded in the revision's reason for change). Several rows
 * for one document number are its revisions; the latest effective one is in force. Loading again adds only what is new.
 */
const HEAD: Record<string, string[]> = {
  file: ['file', 'file name', 'filename', 'path', 'document file', 'attachment'],
  title: ['title', 'document title', 'name', 'document name', 'description'],
  type: ['type', 'document type', 'kind', 'category', 'class'],
  number: ['document number', 'doc number', 'doc no', 'doc #', 'number', 'document id', 'id', 'doc id', 'document no'],
  revision: ['revision', 'rev', 'version', 'revision label', 'issue', 'rev level'],
  effective: ['effective date', 'effective', 'effective on', 'date', 'issue date', 'released', 'release date', 'approved date'],
  folder: ['folder', 'folder path', 'category path', 'location', 'section'],
  site: ['site', 'site code', 'plant', 'facility', 'facility code'],
  issuer: ['issuer', 'issued by', 'customer', 'source', 'standards body', 'organization'],
  issuerNumber: ['issuer document number', 'issuer doc number', 'customer document number', 'customer doc no', 'external number', 'standard number'],
  issuerRevision: ['issuer revision', 'customer revision', 'external revision', 'their revision', 'standard revision'],
  summary: ['change summary', 'reason for change', 'changes', 'what changed', 'change description', 'revision notes', 'notes'],
  tags: ['tags', 'keywords', 'labels'],
  safety: ['safety critical', 'safety', 'critical'],
};
const TYPE_WORDS: Record<DocType, string[]> = {
  sop: ['sop', 'standard operating procedure', 'operating procedure'], work_instruction: ['work instruction', 'wi', 'job instruction', 'instruction'], procedure: ['procedure', 'policy and procedure', 'process'],
  method: ['method', 'test method', 'inspection method', 'tm'], technical_requirement: ['technical requirement', 'requirement', 'spec', 'specification', 'tr'], customer_spec: ['customer spec', 'customer specification', 'customer requirement', 'csr'],
  industry_standard: ['standard', 'industry standard', 'iso', 'astm', 'sae', 'ansi'], form: ['form', 'template', 'checklist', 'record form'], drawing: ['drawing', 'dwg', 'print', 'blueprint'], manual: ['manual', 'oem manual', 'operator manual', 'maintenance manual'],
  troubleshooting_guide: ['troubleshooting', 'troubleshooting guide'], repair_procedure: ['repair', 'repair procedure'], service_bulletin: ['service bulletin', 'bulletin', 'sb'], training_material: ['training', 'training material'],
  photo: ['photo', 'image', 'picture'], video: ['video'], contract: ['contract', 'agreement'], other: ['other'],
};
const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.mp4': 'video/mp4', '.dwg': 'application/acad', '.dxf': 'application/dxf', '.md': 'text/markdown' };

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function docType(raw: string | undefined): DocType | null {
  if (!raw) return 'other';
  const n = norm(raw);
  for (const t of DOC_TYPES) if (norm(t) === n || norm(t.replace(/_/g, ' ')) === n) return t;
  for (const [t, words] of Object.entries(TYPE_WORDS)) if (words.some((w) => norm(w) === n)) return t as DocType;
  return null;
}
function toDay(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`; // month first, as the importer reads dates by default
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export interface BulkRow { row: number; file: string; title: string; type: DocType; number: string | null; revision: string; effectiveOn: string; folder: string | null; siteId: string | null;
  issuer: string | null; issuerNumber: string | null; issuerRevision: string | null; summary: string | null; tags: string[]; safety: boolean; content: Buffer; problems: string[]; status: 'new' | 'exists' | 'error' }

export async function planBulk(tx: Tx, zip: Buffer): Promise<{ rows: BulkRow[]; problems: string[] }> {
  const entries = readZip(zip);
  const idx = entries.find((e) => /^index\.(csv|xlsx|json)$/i.test(e.name));
  if (!idx) throw invalid('the zip needs an index sheet at its top level: index.csv, index.xlsx or index.json');
  const table = await parseFile(idx.content, idx.name);
  const col: Record<string, string> = {};
  for (const [k, names] of Object.entries(HEAD)) { const hit = table.columns.find((c) => names.includes(norm(c))); if (hit) col[k] = hit; }
  if (!col.file || !col.title) throw invalid('the index needs a File column and a Title column');
  const files = new Map(entries.filter((e) => e !== idx).map((e) => [e.name.toLowerCase(), e]));
  const sites = new Map((await many(tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM facility')).flatMap((f) => [[f.code as string, f.id as string], [f.name as string, f.id as string]]));
  const existing = new Map((await many(tx, `SELECT d.id, lower(d.doc_number) AS n, lower(d.title) AS t, d.doc_type FROM document d`)).map((d) => [d.n as string, d]));
  const have = new Set((await many(tx, `SELECT lower(d.doc_number) || '|' || lower(v.version_label) AS k FROM document_version v JOIN document d ON d.id = v.document_id`)).map((r) => r.k as string));
  const rows: BulkRow[] = []; const seen = new Set<string>();
  for (const r of table.rows) {
    const g = (k: string) => (col[k] ? (r.values[col[k]!] == null ? undefined : String(r.values[col[k]!]).trim()) : undefined) || undefined;
    const problems: string[] = [];
    const fileName = g('file') ?? '';
    const entry = files.get(fileName.toLowerCase()) ?? files.get(path.basename(fileName).toLowerCase());
    if (!entry) problems.push(`file "${fileName}" is not in the zip`);
    const type = docType(g('type'));
    if (!type) problems.push(`unknown type "${g('type')}"`);
    const effectiveOn = toDay(col.effective ? r.values[col.effective] : null);
    if (col.effective && r.values[col.effective] != null && r.values[col.effective] !== '' && !effectiveOn) problems.push(`cannot read the date "${r.values[col.effective]}"`);
    const site = g('site'); const siteId = site ? sites.get(site.toLowerCase()) ?? null : null;
    if (site && !siteId) problems.push(`unknown site "${site}"`);
    const title = g('title') ?? '';
    if (!title) problems.push('a title is required');
    if (type && EXTERNAL_TYPES.has(type) && !g('issuer')) problems.push('a customer specification or standard needs its issuer');
    const number = g('number') ?? null;
    const revision = g('revision') ?? 'A';
    const key = `${(number ?? `${title}|${type}`).toLowerCase()}|${revision.toLowerCase()}`;
    if (seen.has(key)) problems.push('the same document and revision appear twice'); seen.add(key);
    const dup = number ? have.has(`${number.toLowerCase()}|${revision.toLowerCase()}`) : false;
    rows.push({ row: r.rowNumber, file: fileName, title, type: type ?? 'other', number, revision, effectiveOn: effectiveOn ?? new Date().toISOString().slice(0, 10), folder: g('folder') ?? null, siteId,
      issuer: g('issuer') ?? null, issuerNumber: g('issuerNumber') ?? null, issuerRevision: g('issuerRevision') ?? null, summary: g('summary') ?? null,
      tags: (g('tags') ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean), safety: /^(y|yes|true|x|1)$/i.test(g('safety') ?? ''), content: entry?.content ?? Buffer.alloc(0),
      problems, status: problems.length ? 'error' : dup ? 'exists' : 'new' });
  }
  void existing;
  const unused = [...files.values()].filter((e) => !rows.some((x) => x.file.toLowerCase() === e.name.toLowerCase() || path.basename(x.file).toLowerCase() === path.basename(e.name).toLowerCase())).map((e) => `"${e.name}" is in the zip but not in the index`);
  return { rows, problems: unused };
}

async function folderChain(tx: Tx, actor: Actor, pathText: string): Promise<string> {
  let parent: string | null = null;
  for (const name of pathText.split(/[/>\\]/).map((x) => x.trim()).filter(Boolean)) {
    const hit: { id: string } | undefined = await one(tx, 'SELECT id FROM document_folder WHERE lower(name) = lower($1) AND parent_id IS NOT DISTINCT FROM $2::uuid', [name, parent]);
    parent = hit?.id ?? (await saveFolder(tx, actor, { name, parentId: parent })).id;
  }
  return parent!;
}

export async function importBulk(tx: Tx, actor: Actor, blobs: BlobStore, zip: Buffer, opts: { dryRun?: boolean; fileName?: string } = {}) {
  requirePermission(actor, 'documents.manage');
  const { rows, problems } = await planBulk(tx, zip);
  const summary = { total: rows.length, new: rows.filter((r) => r.status === 'new').length, exists: rows.filter((r) => r.status === 'exists').length, errors: rows.filter((r) => r.status === 'error').length };
  const view = rows.map(({ content, ...r }) => ({ ...r, bytes: content.length }));
  if (opts.dryRun || summary.errors) return { committed: false, stats: summary, rows: view, problems, answer: summary.errors ? `${summary.errors} of ${summary.total} rows have problems; nothing was loaded.` : `${summary.new} new revisions would be loaded, ${summary.exists} already here.` };
  // Oldest effective date first, so the last one loaded for a document is the newest.
  const todo = rows.filter((r) => r.status === 'new').sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  const today = new Date().toISOString().slice(0, 10);
  let created = 0; let versions = 0;
  for (const r of todo) {
    let doc = r.number ? await one(tx, 'SELECT * FROM document WHERE lower(doc_number) = lower($1)', [r.number]) : await one(tx, 'SELECT * FROM document WHERE lower(title) = lower($1) AND doc_type = $2', [r.title, r.type]);
    if (!doc) {
      const folderId = r.folder ? await folderChain(tx, actor, r.folder) : null;
      doc = await createDocument(tx, actor, { title: r.title, docType: r.type, docNumber: r.number ?? undefined, facilityId: r.siteId, folderId, tags: r.tags, safetyCritical: r.safety,
        issuer: r.issuer ?? undefined, issuerDocNumber: r.issuerNumber ?? undefined } as any);
      created++;
    }
    const stored = await blobs.put(actor.tenantId, r.content);
    const rev = (await one<{ n: number }>(tx, 'SELECT coalesce(max(revision), 0) + 1 AS n FROM document_version WHERE document_id = $1', [doc.id]))!.n;
    const ext = path.extname(r.file).toLowerCase();
    const reason = `${r.summary ? `${r.summary}. ` : ''}Brought over from the previous system as released on ${r.effectiveOn}; the original approval is held there.`;
    const v = await one(tx, `INSERT INTO document_version (tenant_id, document_id, revision, version_label, status, storage_key, file_name, mime_type, size_bytes, sha256, change_summary, extracted_text,
        created_by, approved_by, approved_at, effective_on, issuer_revision)
      VALUES ($1, $2, $3, $4, 'approved', $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15) RETURNING id`,
    [actor.tenantId, doc.id, rev, r.revision, stored.key, path.basename(r.file), MIME[ext] ?? 'application/octet-stream', stored.size, stored.sha256, reason,
      /^(\.txt|\.csv|\.md)$/.test(ext) ? r.content.toString('utf8').slice(0, 200_000) : null, actor.userId, `${r.effectiveOn}T12:00:00Z`, r.effectiveOn, r.issuerRevision]);
    // The newest revision in force wins; earlier ones are superseded.
    if (r.effectiveOn <= today) {
      const cur = await one(tx, 'SELECT current_version_id AS c FROM document WHERE id = $1', [doc.id]);
      if (cur?.c) await tx.query(`UPDATE document_version SET status = 'superseded' WHERE id = $1`, [cur.c]);
      await tx.query('UPDATE document SET current_version_id = $2, pending_version_id = NULL WHERE id = $1', [doc.id, v.id]);
    } else await tx.query('UPDATE document SET pending_version_id = $2 WHERE id = $1', [doc.id, v.id]);
    versions++;
  }
  const sha = createHash('sha256').update(zip).digest('hex');
  const stats = { total: summary.total, created: versions, updated: 0, unchanged: summary.exists, failed: 0, documents: created };
  await tx.query(`INSERT INTO import_batch (tenant_id, target, source_system, file_name, file_sha256, format, parse_info, source_columns, mapping, status, stats, created_by, committed_by, committed_at)
    VALUES ($1, 'documents', 'zip-upload', $2, $3, 'csv', '{}', '{}', '{}', 'committed', $4, $5, $5, now())`, [actor.tenantId, opts.fileName ?? 'documents.zip', sha, stats, actor.userId]);
  await audit(tx, actor, { action: 'document.bulk_imported', entityType: 'document', entityId: actor.tenantId, data: { ...stats, sha256: sha } });
  return { committed: true, stats, rows: view, problems, answer: `${versions} revisions of ${created} new documents loaded (${summary.exists} already here).` };
}
