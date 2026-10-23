import { DevFileMailSender, queueDigests, sendQueued } from '../../modules/notifications/mail.js';
import { runReminders } from '../../modules/notifications/reminders.js';
import { runRetention } from '../../modules/retention/service.js';
import { runArchives } from '../../modules/archives/service.js';
import { remindOverdueSpecReviews } from '../../modules/documents/specs.js';
import { remindInboundRfqs } from '../../modules/sales/inbound-rfq.js';
import { remindNotices } from '../../modules/moc/notices.js';
import { generateVisitsForTenant } from '../../modules/fieldservice/service.js';
import { sweepToolCalibration } from '../../modules/fieldservice/trucks.js';
import { sweepTempChanges } from '../../modules/moc/temp-changes.js';
import { remindQuoteExpiry } from '../../modules/sales/service.js';
import { remindRfqs } from '../../modules/purchasing/rfq.js';
import { remindOverdueReads } from '../../modules/documents/reads.js';
import { config } from '../../config.js';
import { getAdminPool } from '../db/pool.js';
import { withTx } from '../db/tx.js';
import type { BlobStore } from '../storage/blob-store.js';
import { LocalBlobStore } from '../storage/blob-store.js';

/**
 * The daily job (D-171): for every company, the reminder sweep, the email digest, the retention sweep (D-151), company
 * archives (D-165), and the document server's late reviews and effective dates (D-169, D-170). A failure in one company
 * is recorded and does not stop the others. Mail goes through the development adapter until a provider is connected.
 */
export const DAILY_JOB = 'daily';
export type TenantSummary = Record<string, unknown> & { ok: boolean; error?: string };

export async function runDailyForTenant(tenantId: string, blobs: BlobStore = new LocalBlobStore(config.storageDir)): Promise<TenantSummary> {
  const sender = new DevFileMailSender();
  const out: TenantSummary = { ok: true };
  const step = async (name: string, fn: () => Promise<unknown>) => { try { out[name] = await fn(); } catch (e) { out.ok = false; out[`${name}Error`] = (e as Error).message.slice(0, 300); } };
  await step('reminders', () => runReminders(tenantId));
  await step('digests', async () => ({ queued: await queueDigests(tenantId), written: await sendQueued(tenantId, sender) }));
  // Retention runs after mail goes out, so nothing is removed before it is sent.
  await step('retention', () => runRetention(tenantId));
  await step('archives', () => runArchives(blobs, tenantId));
  await step('documents', () => withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    const promoted = (await tx.query('SELECT document_promote_due() AS n')).rows[0].n;
    return { promoted, lateReadings: await remindOverdueReads(tx, tenantId), lateSpecReviews: await remindOverdueSpecReviews(tx, tenantId), lateRfqs: await remindRfqs(tx, tenantId), lateCustomerRfqs: await remindInboundRfqs(tx, tenantId), quoteExpiry: await remindQuoteExpiry(tx, tenantId), noticeAcks: await remindNotices(tx, tenantId), temporaryChanges: await sweepTempChanges(tx, tenantId), serviceVisits: await generateVisitsForTenant(tx, tenantId), toolCalibration: await sweepToolCalibration(tx, tenantId) };
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
  if (opts.force) await db.query(`DELETE FROM job_run WHERE job = $1 AND run_date = $2 AND status <> 'running'`, [DAILY_JOB, today]);
  const claimed = await db.query(`INSERT INTO job_run (job, run_date, trigger) VALUES ($1, $2, $3) ON CONFLICT (job, run_date) DO NOTHING RETURNING id`, [DAILY_JOB, today, opts.trigger ?? 'schedule']);
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
      const last = (await getAdminPool().query(`SELECT max(run_date)::text AS d FROM job_run WHERE job = $1`, [DAILY_JOB])).rows[0]?.d ?? null;
      if (!dueNow(new Date(), opts.hourUtc, last)) return;
      const r = await runDaily({ blobs: opts.blobs, trigger: 'schedule' });
      if (r) log('daily job finished', { failedCompanies: r.failed, companies: Object.keys(r.tenants).length });
    } catch (e) { log('daily job failed', { error: (e as Error).message }); } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000); timer.unref();
  void tick();
  return () => clearInterval(timer);
}

/** The last runs, with one company's own summary, for the administration screen. */
export async function recentRuns(tenantId: string, limit = 14) {
  const rows = (await getAdminPool().query(`SELECT id, run_date::text AS run_date, started_at, finished_at, status, trigger, error, result FROM job_run WHERE job = $1 ORDER BY run_date DESC LIMIT $2`, [DAILY_JOB, limit])).rows;
  return rows.map((r) => ({ id: r.id, runDate: r.run_date, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, trigger: r.trigger, error: r.error, mine: r.result?.tenants?.[tenantId] ?? null }));
}
