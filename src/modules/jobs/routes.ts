import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../platform/auth/actor.js';
import { actorOf } from '../../platform/http/helpers.js';
import { config } from '../../config.js';
import { recentRuns, runDailyForTenant } from '../../platform/jobs/daily.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';

/** The daily job's history and a manual run, for administrators (D-171). */
export function jobRoutes(blobs: BlobStore) {
  return async function (app: FastifyInstance) {
    app.get('/job-runs', async (req) => {
      const a = actorOf(req); requirePermission(a, 'tenant.admin');
      const runs = await recentRuns(a.tenantId);
      const last = runs[0];
      const stale = !last || last.runDate < new Date(Date.now() - 36 * 3_600_000).toISOString().slice(0, 10);
      return { enabled: config.dailyJobEnabled, hourUtc: config.dailyJobHourUtc, runs,
        answer: !config.dailyJobEnabled ? 'The built-in daily job is switched off on this server; an external scheduler must run it.'
          : !last ? `No daily job has run yet; the first runs at ${String(config.dailyJobHourUtc).padStart(2, '0')}:00 UTC.`
            : stale ? `The daily job has not run since ${last.runDate}: check the server.` : `The daily job last ran on ${last.runDate} (${last.status}); it runs every day at ${String(config.dailyJobHourUtc).padStart(2, '0')}:00 UTC.` };
    });
    /** Runs the steps for this company now (reminders, digests, retention, archives, document reviews). */
    app.post('/job-runs/run-now', async (req) => {
      const a = actorOf(req); requirePermission(a, 'tenant.admin');
      return runDailyForTenant(a.tenantId, blobs);
    });
  };
}
