/**
 * Runs the daily job once, now, for every company (D-171). The server runs it by itself every day at DAILY_JOB_HOUR_UTC;
 * this script is for a manual run, or for a deployment that prefers an external scheduler (set DAILY_JOB_ENABLED=false on the server).
 *
 *   npx tsx scripts/run-reminders.ts            (runs today's job unless it already ran)
 *   npx tsx scripts/run-reminders.ts --force    (runs it again)
 */
import { closePools } from '../src/platform/db/pool.js';
import { runDaily } from '../src/platform/jobs/daily.js';

const r = await runDaily({ trigger: 'manual', force: process.argv.includes('--force') });
if (!r) console.log('today\'s daily job already ran (or is running); use --force to run it again');
else for (const [id, t] of Object.entries(r.tenants)) console.log(`${t.slug ?? id}: ${JSON.stringify({ ...t, slug: undefined })}`);
await closePools();
process.exit(r && r.failed ? 1 : 0);
