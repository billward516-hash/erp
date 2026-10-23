import type { MailSender } from '../../modules/notifications/mail.js';
import { createMailSender, queueDigests, sendQueuedDetailed } from '../../modules/notifications/mail.js';
import { syncTenant } from '../../modules/integrations/scheduled.js';
import { runReminders } from '../../modules/notifications/reminders.js';
import { runRetention } from '../../modules/retention/service.js';
import { runArchives } from '../../modules/archives/service.js';
import { remindOverdueSpecReviews } from '../../modules/documents/specs.js';
import { remindInboundRfqs } from '../../modules/sales/inbound-rfq.js';
import { remindNotices } from '../../modules/moc/notices.js';
import { generateVisitsForTenant } from '../../modules/fieldservice/service.js';
import { sweepToolCalibration } from '../../modules/fieldservice/trucks.js';
import { sweepTempChanges } from '../../modules/moc/temp-changes.js';
import { remindRfqs } from '../../modules/purchasing/rfq.js';
import { remindOverdueReads } from '../../modules/documents/reads.js';
import { config } from '../../config.js';
import { getAdminPool } from '../db/pool.js';
import { withTx } from '../db/tx.js';
import type { BlobStore } from '../storage/blob-store.js';
import { LocalBlobStore } from '../storage/blob-store.js';

/**
 * The daily job (D-171): for every company, the reminder sweep, the email digest, the retention sweep (D-151), company
 * archives (D-165), the accounting sync (D-183B), and the document server's late reviews and effective dates (D-169, D-170).
 * A failure in one company, or in one step, is recorded and does not stop the others. Mail goes through SMTP when SMTP_HOST is
 * set, otherwise through the development adapter that writes files (D-183B). Quote-expiry notices are part of the reminder
 * sweep (one series per quote), not a separate step.
 */
export const DAILY_JOB = 'daily';
export type TenantSummary = Record<string, unknown> & { ok: boolean; error?: string };

export async function runDailyForTenant(tenantId: string, blobs: BlobStore = new LocalBlobStore(config.storageDir), opts: { sender?: MailSender } = {}): Promise<TenantSummary> {
  const out: TenantSummary = { ok: true };
  const step = async (name: string, fn: () => Promise<unknown>) => { try { out[name] = await fn(); } catch (e) { out.ok = false; out[`${name}Error`] = (e as Error).message.slice(0, 300); } };
  await step('reminders', () => runReminders(tenantId));
  // A failed send never stops the job: it is recorded on the message, retried by the next run, and shown here and to administrators.
  await step('digests', async () => {
    const queued = await queueDigests(tenantId);
    const r = await sendQueuedDetailed(tenantId, opts.sender ?? createMailSender());
    if (r.retrying + r.gaveUp + r.deferred) { out.ok = false; out.digestsError = `${r.retrying + r.gaveUp + r.deferred} email${r.retrying + r.gaveUp + r.deferred === 1 ? '' : 's'} not delivered${r.gaveUp ? ` (${r.gaveUp} given up on)` : ', will be retried by the next daily run'}: ${r.firstError ?? 'mail server not reachable'}`.slice(0, 300); }
    return { queued, ...r };
  });
  // Accounting sync (D-183B): idempotent, so re-running it is safe; a failure tells the administrators once a day.
  await step('sync', () => syncTenant(tenantId));
  // Retention runs after mail goes out, so nothing is removed before it is sent.
  await step('retention', () => runRetention(tenantId));
  await step('archives', () => runArchives(blobs, tenantId));
  await step('documents', () => withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    const promoted = (await tx.query('SELECT document_promote_due() AS n')).rows[0].n;
    return { promoted, lateReadings: await remindOverdueReads(tx, tenantId), lateSpecReviews: await remindOverdueSpecReviews(tx, tenantId), lateRfqs: await remindRfqs(tx, tenantId), lateCustomerRfqs: await remindInboundRfqs(tx, tenantId), noticeAcks: await remindNotices(tx, tenantId), temporaryChanges: await sweepTempChanges(tx, tenantId), serviceVisits: await generateVisitsForTenant(tx, tenantId), toolCalibration: await sweepToolCalibration(tx, tenantId) };
  }));
  return out;
}

/**
 * Runs the day's job once across all server instances: the unique (job, date) row is the lock. Returns null when another
 * instance (or an earlier run today) already has it, unless `force` asks for a manual re-run.
 */
export async function runDaily(opts: { blobs?: BlobStore; trigger?: 'schedule' | 'manual'; force?: boolean; today?: string } = {}) {
  const db = getAdminPool();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (opts.force) await db.query(`DELETE FROM job_run WHERE job = $1 AND run_date = $2 AND tenant_id IS NULL AND status <> 'running'`, [DAILY_JOB, today]);
  const claimed = await db.query(`INSERT INTO job_run (job, run_date, trigger) VALUES ($1, $2, $3) ON CONFLICT (job, run_date) WHERE tenant_id IS NULL DO NOTHING RETURNING id`, [DAILY_JOB, today, opts.trigger ?? 'schedule']);
  if (!claimed.rowCount) return null;
  const id = claimed.rows[0].id;
  try {
    const tenants: Record<string, TenantSummary> = {};
    for (const t of (await db.query('SELECT id, slug FROM tenant ORDER BY slug')).rows) tenants[t.id] = { slug: t.slug, ...(await runDailyForTenant(t.id, opts.blobs)) };
    const failed = Object.values(tenants).filter((x) => !x.ok).length;
    await db.query(`UPDATE job_run SET status = $2, finished_at = now(), result = $3 WHERE id = $1`, [id, failed ? 'failed' : 'done', JSON.stringify({ tenants, failed })]);
    return { id, tenants, failed };
  } catch (e) {
    await db.query(`UPDATE job_run SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [id, (e as Error).message.slice(0, 500)]);
    throw e;
  }
}

/** True once the configured hour (UTC) has passed and today's run has not been claimed. */
export function dueNow(now: Date, hourUtc: number, lastRunDate: string | null) {
  return now.getUTCHours() >= hourUtc && lastRunDate !== now.toISOString().slice(0, 10);
}

/** Starts the in-process scheduler: checks every minute, runs the day's job once the hour has come. Returns a stop function. */
export function startDailyScheduler(opts: { hourUtc: number; blobs?: BlobStore; log?: (msg: string, extra?: object) => void }) {
  const log = opts.log ?? (() => undefined);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const last = (await getAdminPool().query(`SELECT max(run_date)::text AS d FROM job_run WHERE job = $1 AND tenant_id IS NULL`, [DAILY_JOB])).rows[0]?.d ?? null;
      if (!dueNow(new Date(), opts.hourUtc, last)) return;
      const r = await runDaily({ blobs: opts.blobs, trigger: 'schedule' });
      if (r) log('daily job finished', { failedCompanies: r.failed, companies: Object.keys(r.tenants).length });
    } catch (e) { log('daily job failed', { error: (e as Error).message }); } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000); timer.unref();
  void tick();
  return () => clearInterval(timer);
}

/**
 * A person's "Run it now" for one company (D-183B): recorded in job_run like the scheduled run (marked as run by a person, with
 * the company and who started it) so it shows in the history, with the same per-step result.
 */
export async function runDailyManual(tenantId: string, userId: string, blobs?: BlobStore, opts: { sender?: MailSender } = {}) {
  const db = getAdminPool();
  const today = new Date().toISOString().slice(0, 10);
  const id = (await db.query(`INSERT INTO job_run (job, run_date, trigger, tenant_id, started_by) VALUES ($1, $2, 'manual', $3, $4) RETURNING id`, [DAILY_JOB, today, tenantId, userId])).rows[0].id;
  try {
    const slug = (await db.query('SELECT slug FROM tenant WHERE id = $1', [tenantId])).rows[0]?.slug;
    const summary = { slug, ...(await runDailyForTenant(tenantId, blobs, opts)) } as TenantSummary;
    await db.query(`UPDATE job_run SET status = $2, finished_at = now(), result = $3 WHERE id = $1`, [id, summary.ok ? 'done' : 'failed', JSON.stringify({ tenants: { [tenantId]: summary }, failed: summary.ok ? 0 : 1 })]);
    return { runId: String(id), ...summary, steps: describeSummary(summary) };
  } catch (e) {
    await db.query(`UPDATE job_run SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [id, (e as Error).message.slice(0, 500)]);
    throw e;
  }
}

const STEP_LABELS: Record<string, string> = { reminders: 'Reminders', digests: 'Email digests', sync: 'Accounting sync', retention: 'Data retention', archives: 'Company archive', documents: 'Documents and changes' };
const words = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase();
function counts(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== 0 && x !== null && x !== false && x !== '')
      .map(([k, x]) => (typeof x === 'object' ? `${words(k)}: ${counts(x)}` : typeof x === 'number' ? `${words(k)} ${x}` : `${words(k)}: ${x}`)).join(', ');
  }
  return '';
}

/** What a run did, step by step, in plain words, for the Scheduled jobs page. */
export function describeSummary(summary: Record<string, unknown>) {
  return Object.keys(STEP_LABELS).filter((k) => k in summary || `${k}Error` in summary).map((k) => {
    const error = summary[`${k}Error`] as string | undefined;
    const text = counts(summary[k]);
    return { step: k, label: STEP_LABELS[k]!, ok: !error, text: error ?? (text || 'nothing to do') };
  });
}

/** The last runs, with one company's own summary, for the administration screen. Manual runs are shown only to the company that made them. */
export async function recentRuns(tenantId: string, limit = 14) {
  const rows = (await getAdminPool().query(`SELECT r.id, r.run_date::text AS run_date, r.started_at, r.finished_at, r.status, r.trigger, r.error, r.result, u.display_name AS started_by
    FROM job_run r LEFT JOIN app_user u ON u.id = r.started_by WHERE r.job = $1 AND (r.tenant_id IS NULL OR r.tenant_id = $2) ORDER BY r.started_at DESC LIMIT $3`, [DAILY_JOB, tenantId, limit])).rows;
  return rows.map((r) => {
    const mine = r.result?.tenants?.[tenantId] ?? null;
    return { id: r.id, runDate: r.run_date, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, trigger: r.trigger, startedBy: r.started_by ?? null, error: r.error, mine, steps: mine ? describeSummary(mine) : [] };
  });
}
