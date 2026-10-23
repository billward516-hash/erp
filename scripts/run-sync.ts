/**
 * Runs one accounting sync for every tenant with an active connection. The built-in daily job (D-171, D-183B) now does this by
 * itself for every company; this script remains for running it more often than daily (e.g. every 5 minutes); each run is
 * idempotent and safe to overlap.
 *
 *   npx tsx scripts/run-sync.ts
 */
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { syncTenant } from '../src/modules/integrations/scheduled.js';

const rows = (await getAdminPool().query('SELECT DISTINCT tenant_id FROM integration_connection WHERE active')).rows;
for (const r of rows) {
  try { console.log(`tenant ${r.tenant_id}:`, await syncTenant(r.tenant_id)); } catch (e) { console.error(`tenant ${r.tenant_id}: ${(e as Error).message}`); }
}
await closePools();
