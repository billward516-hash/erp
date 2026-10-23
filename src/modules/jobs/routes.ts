import type { FastifyInstance } from 'fastify';
import { asActor, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import { actorOf } from '../../platform/http/helpers.js';
import { one } from '../../platform/db/tx.js';
import { config } from '../../config.js';
import { recentRuns, runDailyManual } from '../../platform/jobs/daily.js';
import type { MailSender } from '../notifications/mail.js';
import { createMailSender, sendTestEmail } from '../notifications/mail.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';

/** The mail sender the server uses, or why it cannot be built (a bad SMTP setting). */
function mailState(factory: () => MailSender) {
  try { const s = factory(); return { sender: s, configured: !s.name.startsWith('dev-file'), error: null as string | null }; } catch (e) { return { sender: null, configured: false, error: (e as Error).message }; }
}

/** The daily job's history, a manual run, and the test email, for administrators (D-171, D-183B). `mail` is replaceable for tests. */
export function jobRoutes(blobs: BlobStore, mail: () => MailSender = () => createMailSender()) {
  return async function (app: FastifyInstance) {
    app.get('/job-runs', async (req) => {
      const a = actorOf(req); requirePermission(a, 'tenant.admin');
      const runs = await recentRuns(a.tenantId);
      const last = runs.find((r) => r.trigger === 'schedule');
      const stale = !last || last.runDate < new Date(Date.now() - 36 * 3_600_000).toISOString().slice(0, 10);
      const m = mailState(mail);
      const queue = await asActor(a, (tx) => one(tx, `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM email_message`));
      return { enabled: config.dailyJobEnabled, hourUtc: config.dailyJobHourUtc, runs,
        // Whether email is really delivered; the page says so plainly when it is not.
        mail: { configured: m.configured, sender: m.sender?.name ?? null, error: m.error, queued: queue?.queued ?? 0, failed: queue?.failed ?? 0 },
        answer: !config.dailyJobEnabled ? 'The built-in daily job is switched off on this server; an external scheduler must run it.'
          : !last ? `No daily job has run yet; the first runs at ${String(config.dailyJobHourUtc).padStart(2, '0')}:00 UTC.`
            : stale ? `The daily job has not run since ${last.runDate}: check the server.` : `The daily job last ran on ${last.runDate} (${last.status}); it runs every day at ${String(config.dailyJobHourUtc).padStart(2, '0')}:00 UTC.` };
    });
    /** Runs the steps for this company now and records the run (marked as run by a person); the answer says what each step did. */
    app.post('/job-runs/run-now', async (req) => {
      const a = actorOf(req); requirePermission(a, 'tenant.admin');
      const r = await runDailyManual(a.tenantId, a.userId, blobs);
      await asActor(a, (tx) => audit(tx, a, { action: 'jobs.run_now', entityType: 'tenant', entityId: a.tenantId, data: { runId: r.runId, ok: r.ok } }));
      return r;
    });
    /** Sends one test message to the administrator's own address. Reports success or the mail server's error text (secrets removed). */
    app.post('/job-runs/test-email', async (req) => {
      const a = actorOf(req); requirePermission(a, 'tenant.admin');
      const me = await asActor(a, (tx) => one(tx, 'SELECT email, display_name FROM app_user WHERE id = $1', [a.userId]));
      if (!me?.email) return { ok: false, delivered: false, sender: null, to: null, error: 'Your user has no email address, so there is nowhere to send the test.' };
      const m = mailState(mail);
      const result = m.sender ? await sendTestEmail(m.sender, me.email, me.display_name.split(' ')[0]) : { ok: false, delivered: false, sender: null, to: me.email, error: m.error };
      await asActor(a, (tx) => audit(tx, a, { action: 'mail.test_sent', entityType: 'tenant', entityId: a.tenantId, data: { ok: result.ok, sender: result.sender, error: result.error } }));
      return result;
    });
  };
}
