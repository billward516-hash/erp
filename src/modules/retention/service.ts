import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import { getAdminPool } from '../../platform/db/pool.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one, withTx } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';
import { purgeIdempotency } from '../../platform/http/idempotency.js';

/**
 * Data retention (D-151). Short-lived working data is removed by the daily sweep after a period each company sets
 * within limits. Business records, documents, the stock ledger, accounting sync history and the audit log are never
 * removed by retention.
 */
export interface Category { key: string; label: string; description: string; defaultDays: number; min: number; max: number }

export const CATEGORIES: Category[] = [
  { key: 'import_rows', label: 'Rows of finished imports', defaultDays: 90, min: 7, max: 3650,
    description: 'The staged rows of an import, holding the values from the uploaded file. The import summary (file name, mapping, counts) stays. Imports never committed are cancelled after the same period.' },
  { key: 'notifications_read', label: 'Read notifications', defaultDays: 180, min: 30, max: 3650,
    description: 'Notifications a person has read, counted from when they read them.' },
  { key: 'notifications_unread', label: 'Unread notifications', defaultDays: 365, min: 90, max: 3650,
    description: 'Notifications nobody opened. The records they point to are not affected.' },
  { key: 'emails', label: 'Sent emails', defaultDays: 90, min: 7, max: 3650,
    description: 'Copies of digests and reminders that were sent or failed. Emails still waiting to be sent are never removed.' },
  { key: 'tokens', label: 'Expired sign-in tokens', defaultDays: 30, min: 1, max: 3650,
    description: 'Sign-in tokens past their expiry or revoked. Unfinished single sign-on attempts are removed after a day.' },
];
const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export const FIXED = [{ label: 'Saved replies for retried requests', days: 7, description: 'Lets a phone that lost its connection resend a change without doing it twice.' }];
export const KEPT = [
  'The audit log (tamper-evident, never changed or removed)',
  'Business records: assets, work orders, orders, invoices, bills, timesheets, training, quality and safety records',
  'Documents and every version of them',
  'The stock ledger and lot history',
  'Accounting sync history',
  'Import summaries (file, mapping and counts)',
];

type Days = Record<string, number>;

async function daysFor(tx: Tx | { query: Tx['query'] }, tenantId: string): Promise<Days> {
  const rows = (await tx.query('SELECT category, days FROM tenant_retention WHERE tenant_id = $1', [tenantId])).rows;
  const set = new Map(rows.map((r: any) => [r.category, r.days as number]));
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, set.get(c.key) ?? c.defaultDays]));
}

// Each category: what is due, as a WHERE clause over the named table, with $1 the company and $2 the days.
const DUE = {
  import_rows: `FROM import_row r JOIN import_batch b ON b.id = r.batch_id WHERE b.tenant_id = $1 AND b.status IN ('committed', 'cancelled', 'failed')
    AND coalesce(b.committed_at, b.created_at) < now() - make_interval(days => $2)`,
  abandoned_imports: `FROM import_batch WHERE tenant_id = $1 AND status = 'validated' AND created_at < now() - make_interval(days => $2)`,
  notifications_read: `FROM notification WHERE tenant_id = $1 AND read_at IS NOT NULL AND read_at < now() - make_interval(days => $2)`,
  notifications_unread: `FROM notification WHERE tenant_id = $1 AND read_at IS NULL AND created_at < now() - make_interval(days => $2)`,
  emails: `FROM email_message WHERE tenant_id = $1 AND status IN ('sent', 'failed') AND coalesce(sent_at, created_at) < now() - make_interval(days => $2)`,
  tokens: `FROM api_token WHERE tenant_id = $1 AND (revoked_at < now() - make_interval(days => $2) OR expires_at < now() - make_interval(days => $2))`,
};

/** The Data retention screen: each category's period, what the next sweep would remove, and the last sweeps. */
export async function getRetention(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const days = await daysFor(tx, actor.tenantId);
  const meta = new Map((await many(tx, `SELECT t.category, t.updated_at, u.display_name AS updated_by FROM tenant_retention t JOIN app_user u ON u.id = t.updated_by`)).map((r) => [r.category, r]));
  const due = async (sql: string, d: number) => Number((await one(tx, `SELECT count(*)::int AS n ${sql}`, [actor.tenantId, d])).n);
  const categories = [];
  for (const c of CATEGORIES) {
    let n = await due(DUE[c.key as keyof typeof DUE], days[c.key]!);
    const abandoned = c.key === 'import_rows' ? await due(DUE.abandoned_imports, days[c.key]!) : 0;
    if (c.key === 'import_rows') n += Number((await one(tx, `SELECT count(*)::int AS n FROM import_row r JOIN import_batch b ON b.id = r.batch_id
      WHERE b.tenant_id = $1 AND b.status = 'validated' AND b.created_at < now() - make_interval(days => $2)`, [actor.tenantId, days[c.key]])).n);
    const m = meta.get(c.key);
    categories.push({ ...c, days: days[c.key], due: n, abandonedImports: abandoned, updatedAt: m?.updated_at ?? null, updatedBy: m?.updated_by ?? null });
  }
  const runs = await many(tx, 'SELECT ran_at, removed FROM retention_run ORDER BY ran_at DESC LIMIT 5');
  return { categories, fixed: FIXED, kept: KEPT, runs };
}

export async function setRetention(tx: Tx, actor: Actor, key: string, days: number) {
  requirePermission(actor, 'tenant.admin');
  const c = BY_KEY.get(key);
  if (!c) throw notFound('retention category');
  if (!Number.isInteger(days) || days < c.min || days > c.max) throw invalid(`${c.label}: keep for ${c.min} to ${c.max} days`);
  const prior = (await daysFor(tx, actor.tenantId))[key];
  if (days === c.defaultDays) await tx.query('DELETE FROM tenant_retention WHERE category = $1', [key]);
  else await tx.query(`INSERT INTO tenant_retention (tenant_id, category, days, updated_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, category) DO UPDATE SET days = EXCLUDED.days, updated_by = EXCLUDED.updated_by, updated_at = now()`, [actor.tenantId, key, days, actor.userId]);
  await audit(tx, actor, { action: 'retention.period_set', entityType: 'tenant_retention', entityId: actor.tenantId, data: { category: key, from: prior, to: days } });
}

/**
 * The daily sweep for one company (scripts/run-reminders.ts). Deletes run as the owner role, which the request role
 * cannot do, with an explicit company filter in every statement; the result is recorded and audited as that company.
 */
export async function runRetention(tenantId: string) {
  const client = await getAdminPool().connect();
  const removed: Record<string, number> = {};
  try {
    await client.query('BEGIN');
    const days = await daysFor(client, tenantId);
    const run = async (key: string, sql: string) => { const n = (await client.query(sql, [tenantId, days[key]])).rowCount ?? 0; if (n) removed[key] = (removed[key] ?? 0) + n; };
    const cancelled = await client.query(`UPDATE import_batch SET status = 'cancelled' WHERE id IN (SELECT id ${DUE.abandoned_imports}) RETURNING id`, [tenantId, days.import_rows]);
    if (cancelled.rowCount) removed.abandoned_imports = cancelled.rowCount;
    const batches = (await client.query(`SELECT DISTINCT b.id ${DUE.import_rows}`, [tenantId, days.import_rows])).rows.map((r) => r.id);
    if (batches.length) {
      const n = (await client.query('DELETE FROM import_row WHERE tenant_id = $1 AND batch_id = ANY ($2)', [tenantId, batches])).rowCount ?? 0;
      if (n) removed.import_rows = n;
      await client.query('UPDATE import_batch SET rows_purged_at = now() WHERE tenant_id = $1 AND id = ANY ($2) AND rows_purged_at IS NULL', [tenantId, batches]);
    }
    await run('notifications_read', `DELETE ${DUE.notifications_read}`);
    await run('notifications_unread', `DELETE ${DUE.notifications_unread}`);
    await run('emails', `DELETE ${DUE.emails}`);
    await run('tokens', `DELETE ${DUE.tokens}`);
    const sso = (await client.query(`DELETE FROM sso_login WHERE tenant_id = $1 AND expires_at < now() - interval '1 day'`, [tenantId])).rowCount ?? 0;
    if (sso) removed.sso_attempts = sso;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const replies = await purgeIdempotency(tenantId);
  if (replies) removed.saved_replies = replies;
  await withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    await tx.query('INSERT INTO retention_run (tenant_id, removed) VALUES ($1, $2)', [tenantId, removed]);
    if (Object.keys(removed).length) await audit(tx, { tenantId, userId: null }, { action: 'retention.swept', entityType: 'tenant', entityId: tenantId, data: { removed } });
  });
  return removed;
}
