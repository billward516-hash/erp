import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { getAdminPool } from '../../platform/db/pool.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';

/**
 * Company archives and restore (D-165).
 *
 * An archive is every row the company owns, from one consistent snapshot, written as a gzip file: a manifest line, then
 * one line per table holding the rows as the database's own JSON (so numbers and dates come back exactly). The daily job
 * takes one when the last is older than the company's interval (30 days by default) and keeps the latest N (12).
 *
 * Restoring:
 * - Records: chosen rows (and, if asked, the records that belong to them: lines, steps, answers) are written back as
 *   they were, with every rule and reference still checked.
 * - The whole company: needs a second administrator. The present state is archived first, then the company's business
 *   data is replaced in one transaction. Sign-in and access (users, tokens, roles and their assignments), the audit
 *   trail, number counters, the licence and people's drafts are kept as they are now; references left pointing at
 *   something that no longer exists are cleared; if the archive itself is inconsistent nothing changes.
 */
const FORMAT = 'erp-company-archive/1';
/** Kept as they are now by a whole-company rollback. */
const KEEP = new Set(['app_user', 'api_token', 'user_role_assignment', 'role', 'audit_event', 'tenant_sequence', 'tenant_license', 'tenant_sso', 'sso_login', 'form_draft',
  'idempotency_record', 'retention_run', 'notification_sent_key', 'company_archive', 'archive_settings', 'company_rollback']);
/** Never written to an archive: secrets, other people's private drafts, replay records, and the archives themselves. */
const NOT_ARCHIVED = new Set(['api_token', 'sso_login', 'idempotency_record', 'form_draft', 'tenant_sso', 'company_archive', 'archive_settings', 'company_rollback']);
const ROLLBACK_HOURS = 24;

interface TableInfo { name: string; cols: string[]; pk: string[] }
interface ForeignKey { name: string; child: string; parent: string; childCols: string[]; parentCols: string[]; nullable: boolean }
type Db = pg.PoolClient;
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function tables(db: Db): Promise<TableInfo[]> {
  const rows = await many(db as Tx, `SELECT c.relname AS name,
      array_agg(a.attname::text ORDER BY a.attnum) AS cols,
      coalesce((SELECT array_agg(pa.attname::text ORDER BY pa.attnum) FROM pg_index i JOIN pg_attribute pa ON pa.attrelid = i.indrelid AND pa.attnum = ANY (i.indkey)
        WHERE i.indrelid = c.oid AND i.indisprimary), '{}') AS pk
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
    GROUP BY c.oid, c.relname ORDER BY c.relname`);
  return rows as TableInfo[];
}
async function foreignKeys(db: Db): Promise<ForeignKey[]> {
  return many(db as Tx, `SELECT c.conname AS name, cr.relname AS child, pr.relname AS parent,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "childCols",
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS "parentCols",
      NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k(attnum) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum WHERE a.attnotnull) AS nullable
    FROM pg_constraint c JOIN pg_class cr ON cr.oid = c.conrelid JOIN pg_class pr ON pr.oid = c.confrelid JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'`);
}

// ---------------------------------------------------------------------------
// Taking an archive
// ---------------------------------------------------------------------------

/** Writes a full archive of one company from a single consistent snapshot and records it. */
export async function createArchive(blobs: BlobStore, tenantId: string, kind: 'scheduled' | 'manual' | 'pre_rollback', userId: string | null, note?: string) {
  const db = await getAdminPool().connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tenant = await one(db as Tx, 'SELECT id, slug, name FROM tenant WHERE id = $1', [tenantId]);
    if (!tenant) throw notFound('company');
    const schema = await one(db as Tx, 'SELECT max(name) AS v FROM schema_migration');
    const list = (await tables(db)).filter((t) => !NOT_ARCHIVED.has(t.name));
    const bodies: string[] = []; const manifest: { name: string; cols: string[]; rows: number }[] = [];
    let rowCount = 0;
    for (const t of list) {
      const r = await one(db as Tx, `SELECT count(*)::int AS n, coalesce(json_agg(x), '[]')::text AS body FROM ${q(t.name)} x WHERE tenant_id = $1`, [tenantId]);
      // json_agg separates elements with line breaks; a line break inside a JSON string is always escaped, so every raw one is spacing.
      manifest.push({ name: t.name, cols: t.cols, rows: r.n }); bodies.push(r.body.replace(/\n/g, '')); rowCount += r.n;
    }
    await db.query('COMMIT');
    const head = { format: FORMAT, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }, createdAt: new Date().toISOString(), schemaVersion: schema?.v ?? null, kind, tables: manifest };
    const file = gzipSync(Buffer.from([JSON.stringify(head), ...bodies].join('\n'), 'utf8'));
    const stored = await blobs.put(tenantId, file);
    const rec = await one(getAdminPool() as any, `INSERT INTO company_archive (tenant_id, kind, blob_key, sha256, size_bytes, table_count, row_count, schema_version, note, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tenantId, kind, stored.key, stored.sha256, stored.size, manifest.length, rowCount, head.schemaVersion, note ?? null, userId]);
    await getAdminPool().query(`INSERT INTO audit_event (tenant_id, actor_user_id, action, entity_type, entity_id, data) VALUES ($1, $2, 'archive.created', 'company_archive', $3, $4)`,
      [tenantId, userId, rec.id, { kind, tables: manifest.length, rows: rowCount, bytes: stored.size }]);
    return rec;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

interface Loaded { head: { format: string; tenant: { id: string; name: string }; createdAt: string; schemaVersion: string | null; tables: { name: string; cols: string[]; rows: number }[] };
  body: (name: string) => string | null }

async function loadArchive(blobs: BlobStore, rec: any): Promise<Loaded> {
  if (rec.status !== 'ready' || !rec.blob_key) throw conflict(`this archive is ${rec.status}`);
  const file = await blobs.get(rec.blob_key);
  if (createHash('sha256').update(file).digest('hex') !== rec.sha256) throw new AppError(409, 'archive_damaged', 'the archive file does not match its checksum; it cannot be used');
  const lines = gunzipSync(file).toString('utf8').split('\n');
  const head = JSON.parse(lines[0]!);
  if (head.format !== FORMAT || head.tenant.id !== rec.tenant_id) throw new AppError(409, 'archive_damaged', 'the archive belongs to another company or format');
  const index = new Map<string, number>(head.tables.map((t: any, i: number) => [t.name, i + 1]));
  return { head, body: (name) => { const i = index.get(name); return i == null ? null : lines[i]!; } };
}

// ---------------------------------------------------------------------------
// The daily job and the screen
// ---------------------------------------------------------------------------

async function settingsOf(db: { query: Tx['query'] }, tenantId: string) {
  const r = (await db.query('SELECT interval_days, keep_count FROM archive_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  return { intervalDays: r?.interval_days ?? 30, keepCount: r?.keep_count ?? 12 };
}

/** Run daily: archives a company whose last archive is older than its interval, then keeps only the latest N scheduled ones. */
export async function runArchives(blobs: BlobStore, tenantId: string, now = new Date()) {
  const admin = getAdminPool();
  const s = await settingsOf(admin as any, tenantId);
  const last = (await admin.query(`SELECT max(created_at) AS at FROM company_archive WHERE tenant_id = $1 AND status = 'ready' AND kind IN ('scheduled', 'manual')`, [tenantId])).rows[0]?.at;
  let created: any = null;
  if (!last || now.getTime() - new Date(last).getTime() >= s.intervalDays * 86_400_000 - 3_600_000) created = await createArchive(blobs, tenantId, 'scheduled', null);
  const old = (await admin.query(`SELECT id, blob_key FROM company_archive WHERE tenant_id = $1 AND status = 'ready' AND kind = 'scheduled' ORDER BY created_at DESC OFFSET $2`, [tenantId, s.keepCount])).rows;
  for (const a of old) await removeArchive(blobs, a);
  // Expired rollback requests close themselves.
  await admin.query(`UPDATE company_rollback SET status = 'expired', finished_at = now() WHERE tenant_id = $1 AND status = 'pending' AND requested_at < now() - make_interval(hours => $2)`, [tenantId, ROLLBACK_HOURS]);
  return { created: created?.id ?? null, removed: old.length };
}
async function removeArchive(blobs: BlobStore, a: { id: string; blob_key: string | null }) {
  if (a.blob_key) await blobs.remove?.(a.blob_key).catch(() => undefined);
  await getAdminPool().query(`UPDATE company_archive SET status = 'deleted', deleted_at = now(), blob_key = NULL WHERE id = $1`, [a.id]);
}

export async function archivesOverview(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const s = await settingsOf(tx, actor.tenantId);
  const archives = await many(tx, `SELECT a.id, a.kind, a.status, a.size_bytes::float AS size_bytes, a.table_count, a.row_count::float AS row_count, a.schema_version, a.note, a.created_at,
      u.display_name AS created_by FROM company_archive a LEFT JOIN app_user u ON u.id = a.created_by WHERE a.status = 'ready' ORDER BY a.created_at DESC`);
  const rollbacks = await many(tx, `SELECT r.*, a.created_at AS archive_created_at, ru.display_name AS requested_by_name, cu.display_name AS confirmed_by_name FROM company_rollback r
      JOIN company_archive a ON a.id = r.archive_id JOIN app_user ru ON ru.id = r.requested_by LEFT JOIN app_user cu ON cu.id = r.confirmed_by ORDER BY r.requested_at DESC LIMIT 20`);
  const last = archives.find((a) => a.kind !== 'pre_rollback');
  const days = last ? Math.floor((Date.now() - new Date(last.created_at).getTime()) / 86_400_000) : null;
  const next = days == null ? 0 : Math.max(0, s.intervalDays - days);
  const answer = !last ? `No archive yet; the first is taken by tonight's job (every ${s.intervalDays} days after that).`
    : `Last archive ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}; the next is due ${next === 0 ? 'tonight' : `in ${next} day${next === 1 ? '' : 's'}`}. ${archives.length} kept.`;
  const admins = await adminIds(tx);
  return { answer, settings: s, archives, rollbacks, admins: admins.length, me: actor.userId };
}

export async function saveArchiveSettings(tx: Tx, actor: Actor, input: { intervalDays: number; keepCount: number }) {
  requirePermission(actor, 'tenant.admin');
  if (!(input.intervalDays >= 1 && input.intervalDays <= 90)) throw invalid('archive every 1 to 90 days');
  if (!(input.keepCount >= 1 && input.keepCount <= 120)) throw invalid('keep 1 to 120 archives');
  await tx.query(`INSERT INTO archive_settings (tenant_id, interval_days, keep_count, updated_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id) DO UPDATE SET interval_days = EXCLUDED.interval_days, keep_count = EXCLUDED.keep_count, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, input.intervalDays, input.keepCount, actor.userId]);
  await audit(tx, actor, { action: 'archive.settings_changed', entityType: 'archive_settings', entityId: actor.tenantId, data: input });
  return settingsOf(tx, actor.tenantId);
}

async function archiveFor(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'tenant.admin');
  const a = await one(tx, 'SELECT * FROM company_archive WHERE id = $1', [id]);
  if (!a || a.status !== 'ready') throw notFound('archive');
  return a;
}

export async function archiveFile(tx: Tx, blobs: BlobStore, actor: Actor, id: string) {
  const a = await archiveFor(tx, actor, id);
  await audit(tx, actor, { action: 'archive.downloaded', entityType: 'company_archive', entityId: id, data: {} });
  return { body: await blobs.get(a.blob_key), fileName: `archive-${new Date(a.created_at).toISOString().slice(0, 10)}-${a.id.slice(0, 8)}.json.gz` };
}

// ---------------------------------------------------------------------------
// Browsing an archive and bringing records back
// ---------------------------------------------------------------------------

/** The kinds of record in an archive that can be brought back, with how many each holds. */
export async function archiveContents(tx: Tx, blobs: BlobStore, actor: Actor, id: string) {
  const a = await archiveFor(tx, actor, id);
  const l = await loadArchive(blobs, a);
  return { archive: { id: a.id, created_at: a.created_at, kind: a.kind }, tables: l.head.tables.filter((t) => !KEEP.has(t.name) && t.rows > 0)
    .map((t) => ({ name: t.name, label: t.name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), rows: t.rows })).sort((x, y) => x.label.localeCompare(y.label)) };
}

async function withOwner<T>(tenantId: string, userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await getAdminPool().connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.facility_ids', '{}', true), set_config('app.all_facilities', 'on', true)`,
      [tenantId, userId]);
    const r = await fn(db);
    await db.query('COMMIT');
    return r;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

/** Rows of one kind in the archive, matching a search, each marked deleted since, changed since or the same as now. */
export async function archiveRows(tx: Tx, blobs: BlobStore, actor: Actor, id: string, table: string, search?: string | null) {
  const a = await archiveFor(tx, actor, id);
  const l = await loadArchive(blobs, a);
  const body = l.body(table);
  if (!body || KEEP.has(table)) throw notFound('that kind of record in this archive');
  return withOwner(actor.tenantId, actor.userId, async (db) => {
    const t = (await tables(db)).find((x) => x.name === table);
    if (!t || !t.pk.length) throw invalid('that kind of record no longer exists, so it cannot be compared or brought back');
    const join = t.pk.map((c) => `c.${q(c)}::text = x->>'${c}'`).join(' AND ');
    const rows = await many(db as Tx, `SELECT x AS row, CASE WHEN c.tenant_id IS NULL THEN 'deleted' WHEN x::jsonb = to_jsonb(c) THEN 'same' ELSE 'changed' END AS state
      FROM json_array_elements($1::json) x LEFT JOIN ${q(table)} c ON ${join} AND c.tenant_id = $2
      WHERE $3::text IS NULL OR x::text ILIKE '%' || $3 || '%' ORDER BY (CASE WHEN c.tenant_id IS NULL THEN 0 WHEN x::jsonb = to_jsonb(c) THEN 2 ELSE 1 END) LIMIT 50`,
    [body, actor.tenantId, search?.trim() || null]);
    const counts = await one(db as Tx, `SELECT count(*) FILTER (WHERE c.tenant_id IS NULL)::int AS deleted, count(*) FILTER (WHERE c.tenant_id IS NOT NULL AND x::jsonb <> to_jsonb(c))::int AS changed,
      (SELECT count(*)::int FROM ${q(table)} n WHERE n.tenant_id = $2) AS now FROM json_array_elements($1::json) x LEFT JOIN ${q(table)} c ON ${join} AND c.tenant_id = $2`, [body, actor.tenantId]);
    return { table, pk: t.pk, counts, rows: rows.map((r) => ({ key: Object.fromEntries(t.pk.map((c) => [c, r.row[c]])), state: r.state, values: r.row })) };
  });
}

/**
 * Brings chosen records back as they were in the archive: rows that were deleted are inserted, rows that changed are
 * written back. With `withChildren`, the records that belong to them in the archive (lines, steps, answers, down to
 * four levels) come back too. Every rule and reference is checked as for any change; a record pointing at something
 * that no longer exists is refused with the reference named.
 */
export async function restoreRecords(tx: Tx, blobs: BlobStore, actor: Actor, id: string, input: { table: string; keys: Record<string, unknown>[]; withChildren?: boolean }) {
  const a = await archiveFor(tx, actor, id);
  if (!input.keys.length || input.keys.length > 500) throw invalid('choose 1 to 500 records');
  const l = await loadArchive(blobs, a);
  return withOwner(actor.tenantId, actor.userId, async (db) => {
    const all = await tables(db); const byName = new Map(all.map((t) => [t.name, t]));
    const fks = await foreignKeys(db);
    const plan: { table: string; rows: string }[] = []; let total = 0;
    // Picks the archived rows of a table matching a set of key values, as the archive's own JSON text.
    const pick = async (table: string, cols: string[], values: unknown[][]) => {
      const body = l.body(table); if (!body || !values.length) return null;
      const r = await one(db as Tx, `SELECT coalesce(json_agg(x), '[]')::text AS rows, count(*)::int AS n FROM json_array_elements($1::json) x
        WHERE (${cols.map((c, i) => `x->>'${c}' = ANY ($${i + 2}::text[])`).join(' AND ')})`, [body, ...cols.map((_, i) => values.map((v) => (v[i] == null ? null : String(v[i]))))]);
      return r.n ? r : null;
    };
    const root = byName.get(input.table);
    if (!root || KEEP.has(input.table) || !root.pk.length) throw invalid('that kind of record cannot be brought back from an archive');
    const first = await pick(input.table, root.pk, input.keys.map((k) => root.pk.map((c) => k[c])));
    if (!first) throw notFound('those records in this archive');
    plan.push({ table: input.table, rows: first.rows }); total += first.n;
    if (input.withChildren) {
      let frontier = [{ table: input.table, rows: JSON.parse(first.rows) as Record<string, unknown>[] }];
      for (let depth = 0; depth < 4 && frontier.length; depth++) {
        const next: typeof frontier = [];
        for (const f of frontier) {
          for (const fk of fks.filter((k) => k.parent === f.table && !KEEP.has(k.child) && byName.has(k.child) && k.child !== f.table)) {
            const got = await pick(fk.child, fk.childCols, f.rows.map((r) => fk.parentCols.map((c) => r[c])));
            if (!got) continue;
            if (total + got.n > 5000) throw invalid('more than 5,000 records belong to these; bring back fewer at a time');
            plan.push({ table: fk.child, rows: got.rows }); total += got.n;
            next.push({ table: fk.child, rows: JSON.parse(got.rows) });
          }
        }
        frontier = next;
      }
    }
    const done: Record<string, number> = {};
    for (const step of plan) {
      const t = byName.get(step.table)!;
      const archived = l.head.tables.find((x) => x.name === step.table)!;
      const cols = t.cols.filter((c) => archived.cols.includes(c));
      const update = cols.filter((c) => !t.pk.includes(c));
      try {
        await db.query('SAVEPOINT r');
        const r = await db.query(`INSERT INTO ${q(step.table)} (${cols.map(q).join(', ')}) SELECT ${cols.map(q).join(', ')} FROM json_populate_recordset(null::${q(step.table)}, $1::json) x
          WHERE x.tenant_id = $2
          ON CONFLICT (${t.pk.map(q).join(', ')}) DO ${update.length ? `UPDATE SET ${update.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}` : 'NOTHING'}`, [step.rows, actor.tenantId]);
        await db.query('RELEASE SAVEPOINT r');
        done[step.table] = (done[step.table] ?? 0) + (r.rowCount ?? 0);
      } catch (err: any) {
        await db.query('ROLLBACK TO SAVEPOINT r');
        const why = err.code === '23503' ? `it refers to a record that no longer exists (${err.constraint}); bring that back first, or include the records it belongs to`
          : err.code === '23505' ? `another record now holds the same unique value (${err.constraint})` : err.message;
        throw invalid(`${step.table.replace(/_/g, ' ')}: ${why}`);
      }
    }
    await audit(db as Tx, actor, { action: 'archive.records_restored', entityType: 'company_archive', entityId: id, data: { table: input.table, keys: input.keys.slice(0, 50), restored: done } });
    return { restored: done, answer: `${Object.values(done).reduce((s, n) => s + n, 0)} record${total === 1 ? '' : 's'} brought back from the archive of ${new Date(a.created_at).toISOString().slice(0, 10)}.` };
  });
}

// ---------------------------------------------------------------------------
// Rolling the whole company back (two administrators)
// ---------------------------------------------------------------------------

async function adminIds(tx: Tx): Promise<string[]> {
  return (await many(tx, `SELECT DISTINCT u.id FROM user_role_assignment a JOIN role r ON r.id = a.role_id JOIN app_user u ON u.id = a.user_id
    WHERE 'tenant.admin' = ANY (r.permissions) AND u.status = 'active'`)).map((r) => r.id);
}

export async function requestRollback(tx: Tx, actor: Actor, archiveId: string, reason: string) {
  const a = await archiveFor(tx, actor, archiveId);
  if (!reason?.trim() || reason.trim().length < 5) throw invalid('say why the company is being rolled back');
  const admins = await adminIds(tx);
  if (admins.filter((u) => u !== actor.userId).length === 0) throw invalid('a second administrator must confirm a rollback; add another administrator first');
  if (await one(tx, `SELECT 1 FROM company_rollback WHERE status = 'pending'`)) throw conflict('a rollback is already waiting for confirmation');
  const r = await one(tx, `INSERT INTO company_rollback (tenant_id, archive_id, reason, requested_by) VALUES ($1, $2, $3, $4) RETURNING *`, [actor.tenantId, a.id, reason.trim(), actor.userId]);
  await audit(tx, actor, { action: 'company.rollback_requested', entityType: 'company_rollback', entityId: r.id, data: { archiveId: a.id, archiveDate: a.created_at, reason: reason.trim() } });
  await notify(tx, actor.tenantId, admins, { kind: 'approval.requested', title: `Roll the company back to ${new Date(a.created_at).toISOString().slice(0, 10)}? A second administrator must confirm`,
    link: '/archives', subjectType: 'company_rollback', subjectId: r.id, dedupeKey: `rollback:${r.id}` }, actor.userId);
  return r;
}

export async function cancelRollback(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'tenant.admin');
  const r = await one(tx, `UPDATE company_rollback SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [id]);
  if (!r) throw notFound('pending rollback');
  await audit(tx, actor, { action: 'company.rollback_cancelled', entityType: 'company_rollback', entityId: id, data: {} });
}

/** The second administrator confirms; the present state is archived, then the company is rolled back in one transaction. */
export async function confirmRollback(blobs: BlobStore, actor: Actor, id: string) {
  requirePermission(actor, 'tenant.admin');
  const admin = getAdminPool();
  const req = (await admin.query(`SELECT r.*, a.blob_key, a.sha256, a.status AS archive_status, a.tenant_id AS archive_tenant, a.created_at AS archive_created_at
    FROM company_rollback r JOIN company_archive a ON a.id = r.archive_id WHERE r.id = $1 AND r.tenant_id = $2`, [id, actor.tenantId])).rows[0];
  if (!req || req.status !== 'pending') throw notFound('pending rollback');
  if (req.requested_by === actor.userId) throw invalid('the administrator who asked for the rollback cannot confirm it; a second administrator must');
  if (Date.now() - new Date(req.requested_at).getTime() > ROLLBACK_HOURS * 3_600_000) throw conflict(`the request is more than ${ROLLBACK_HOURS} hours old; ask again`);
  const archived = await loadArchive(blobs, { id: req.archive_id, tenant_id: req.archive_tenant, status: req.archive_status, blob_key: req.blob_key, sha256: req.sha256 });
  const pre = await createArchive(blobs, actor.tenantId, 'pre_rollback', actor.userId, `Taken before rolling back to ${new Date(req.archive_created_at).toISOString().slice(0, 10)}`);
  try {
    const result = await withOwner(actor.tenantId, actor.userId, async (db) => {
      const claimed = await db.query(`UPDATE company_rollback SET confirmed_by = $2, confirmed_at = now(), pre_archive_id = $3 WHERE id = $1 AND status = 'pending' RETURNING id`, [id, actor.userId, pre.id]);
      if (!claimed.rowCount) throw conflict('the rollback was confirmed, cancelled or expired meanwhile');
      try { await db.query('SET LOCAL session_replication_role = replica'); } catch {
        throw new AppError(409, 'rollback_unavailable', 'this database does not let the platform suspend reference checks during a rollback; ask the platform operator to run it');
      }
      const now = await tables(db); const fks = await foreignKeys(db);
      const current = new Map(now.map((t) => [t.name, t]));
      let deleted = 0; let inserted = 0;
      for (const t of now) if (!KEEP.has(t.name)) deleted += (await db.query(`DELETE FROM ${q(t.name)} WHERE tenant_id = $1`, [actor.tenantId])).rowCount ?? 0;
      for (const t of archived.head.tables) {
        const cur = current.get(t.name);
        if (!cur || KEEP.has(t.name) || !t.rows) continue;
        const cols = cur.cols.filter((c) => t.cols.includes(c));
        inserted += (await db.query(`INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) SELECT ${cols.map(q).join(', ')} FROM json_populate_recordset(null::${q(t.name)}, $1::json) x
          WHERE x.tenant_id = $2`, [archived.body(t.name), actor.tenantId])).rowCount ?? 0;
      }
      await db.query('DELETE FROM idempotency_record WHERE tenant_id = $1', [actor.tenantId]);
      // References left pointing at rows that no longer exist: cleared (or the row removed) in kept tables such as role
      // assignments; in restored data they mean the archive is inconsistent, and the whole rollback is undone.
      const fixed: Record<string, number> = {};
      for (const fk of fks) {
        if (!current.has(fk.child) || fk.parent === 'tenant' || fk.child === 'audit_event') continue;
        const where = `x.tenant_id = $1 AND ${fk.childCols.map((c) => `x.${q(c)} IS NOT NULL`).join(' AND ')}
          AND NOT EXISTS (SELECT 1 FROM ${q(fk.parent)} p WHERE ${fk.childCols.map((c, i) => `p.${q(fk.parentCols[i]!)} = x.${q(c)}`).join(' AND ')})`;
        const n = (await one(db as Tx, `SELECT count(*)::int AS n FROM ${q(fk.child)} x WHERE ${where}`, [actor.tenantId])).n;
        if (!n) continue;
        if (!KEEP.has(fk.child) && !fk.nullable) throw new AppError(409, 'archive_inconsistent', `the archive has ${fk.child.replace(/_/g, ' ')} records pointing at missing ${fk.parent.replace(/_/g, ' ')} records; nothing was changed`);
        const r = fk.nullable
          ? await db.query(`UPDATE ${q(fk.child)} x SET ${fk.childCols.map((c) => `${q(c)} = NULL`).join(', ')} WHERE ${where}`, [actor.tenantId])
          : await db.query(`DELETE FROM ${q(fk.child)} x WHERE ${where}`, [actor.tenantId]);
        fixed[`${fk.child}.${fk.childCols.join('+')}`] = r.rowCount ?? 0;
      }
      await db.query('SET LOCAL session_replication_role = origin');
      const summary = { archiveId: req.archive_id, archiveDate: req.archive_created_at, preRollbackArchiveId: pre.id, deleted, inserted, referencesCleared: fixed };
      await db.query(`UPDATE company_rollback SET status = 'done', finished_at = now(), result = $2 WHERE id = $1`, [id, JSON.stringify(summary)]);
      await audit(db as Tx, actor, { action: 'company.rolled_back', entityType: 'company_rollback', entityId: id, data: { ...summary, requestedBy: req.requested_by } });
      return summary;
    });
    await withOwner(actor.tenantId, actor.userId, async (db) => notify(db as Tx, actor.tenantId, await adminIds(db as Tx), { kind: 'approval.decided',
      title: `The company was rolled back to ${new Date(req.archive_created_at).toISOString().slice(0, 10)}`, link: '/archives', subjectType: 'company_rollback', subjectId: id,
      dedupeKey: `rollback-done:${id}` }));
    return { ...result, answer: `Rolled back to the archive of ${new Date(req.archive_created_at).toISOString().slice(0, 10)}: ${result.inserted} records restored. The state before the rollback is kept as an archive, so it can be undone.` };
  } catch (err: any) {
    await admin.query(`UPDATE company_rollback SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'pending'`, [id, String(err.message).slice(0, 500)]);
    throw err;
  }
}
