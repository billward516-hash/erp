import { buildApp } from './app.js';
import { config } from './config.js';
import { closePools } from './platform/db/pool.js';

const app = buildApp();
app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Graceful shutdown (D-150): stop taking requests, let those in flight finish, then release the database.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close().then(closePools).then(() => process.exit(0), (err) => { app.log.error(err); process.exit(1); });
  });
}
