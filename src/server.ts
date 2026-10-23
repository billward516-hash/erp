import { buildApp } from './app.js';
import { assertProductionConfig } from './platform/config-check.js';
import { config } from './config.js';
import { closePools } from './platform/db/pool.js';
import { startDailyScheduler } from './platform/jobs/daily.js';

const check = assertProductionConfig(process.env);
if (check.problems.length) { console.error(`Refusing to start:\n- ${check.problems.join('\n- ')}`); process.exit(1); }
const app = buildApp();
for (const w of check.warnings) app.log.warn(w);
app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// The daily job runs inside the server (D-171); with several instances the first to claim the day's row runs it.
const stopScheduler = config.dailyJobEnabled ? startDailyScheduler({ hourUtc: config.dailyJobHourUtc, log: (msg, extra) => app.log.info(extra ?? {}, msg) }) : () => undefined;

// Graceful shutdown (D-150): stop taking requests, let those in flight finish, then release the database.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    stopScheduler();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close().then(closePools).then(() => process.exit(0), (err) => { app.log.error(err); process.exit(1); });
  });
}
