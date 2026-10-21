/**
 * Runs one accounting sync for every tenant with an active connection. Schedule it (e.g. every 5 minutes)
 * until the job queue lands; each run is idempotent and safe to overlap.
 *
 *   npx tsx scripts/run-sync.ts
 */
import { loadActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { runSync } from '../src/modules/integrations/service.js';

// Runs as the user who created each connection (their permissions apply; audit shows who set it up).
const rows = (await getAdminPool().query('SELECT tenant_id, created_by FROM integration_connection WHERE active')).rows;
for (const r of rows) {
  const actor = await loadActor(r.tenant_id, r.created_by);
  if (!actor) { console.error(`tenant ${r.tenant_id}: connection owner inactive; skipped`); continue; }
  try { console.log(`tenant ${r.tenant_id}:`, await runSync(actor)); } catch (e) { console.error(`tenant ${r.tenant_id}: ${(e as Error).message}`); }
}
await closePools();
