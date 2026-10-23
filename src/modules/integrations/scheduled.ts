import type { Actor } from '../../platform/auth/actor.js';
import { can, loadActor } from '../../platform/auth/actor.js';
import { one, withTx } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { runSync } from './service.js';

/**
 * The accounting sync as a scheduled step (D-183B), per company: used by the daily job, the "Run it now" button and
 * scripts/run-sync.ts. Works with the built-in books and any connected provider. Safe to repeat and to overlap: runSync claims
 * rows with SKIP LOCKED and every delivery has an idempotency key. When the sync cannot run, the company's administrators are
 * told once per connection per day (deduped) and the error is raised so the job records the step as failed.
 */
export type SyncStepResult = { skipped: string } | { provider: string; delivered: number; failed: number; dead: number; skipped: number; payments: number; mock: boolean };

const ANY: { userId: null; facilityIds: string[]; allFacilities: boolean } = { userId: null, facilityIds: [], allFacilities: true };

/** Runs as the user who connected the system (their permissions apply and the audit trail shows who set it up); if they have left or lost the right, as another integration manager. */
async function syncActor(tenantId: string, createdBy: string): Promise<Actor | undefined> {
  const first = await loadActor(tenantId, createdBy);
  if (first && can(first, 'integrations.manage')) return first;
  const others = await withTx({ tenantId, ...ANY }, (tx) => usersWithPermission(tx, 'integrations.manage', null));
  for (const id of others) {
    const a = await loadActor(tenantId, id);
    if (a && can(a, 'integrations.manage')) return a;
  }
  return undefined;
}

export async function syncTenant(tenantId: string): Promise<SyncStepResult> {
  const c = await withTx({ tenantId, ...ANY }, (tx) => one<{ id: string; provider: string; created_by: string }>(tx, 'SELECT id, provider, created_by FROM integration_connection WHERE active'));
  if (!c) return { skipped: 'no accounting connection' };
  try {
    const actor = await syncActor(tenantId, c.created_by);
    if (!actor) throw new Error('nobody who may manage the accounting connection is active, so the sync could not run as anyone');
    const r = await runSync(actor);
    return { provider: c.provider, delivered: r.delivered, failed: r.failed, dead: r.dead, skipped: r.skipped, payments: r.payments, mock: r.mock };
  } catch (e) {
    const message = ((e as Error).message ?? String(e)).slice(0, 300);
    const day = new Date().toISOString().slice(0, 10);
    // Best effort: a failure to notify must not hide the sync failure itself.
    await withTx({ tenantId, ...ANY }, async (tx) => {
      const admins = await usersWithPermission(tx, 'tenant.admin', null);
      await notify(tx, tenantId, admins, { kind: 'reminder.sync_failed', title: 'The accounting sync did not run', body: message, link: '/jobs', subjectType: 'integration_connection', subjectId: c.id, dedupeKey: `sync-run-failed:${c.id}:${day}` });
    }).catch(() => undefined);
    throw new Error(message);
  }
}
