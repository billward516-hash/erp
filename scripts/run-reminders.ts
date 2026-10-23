/**
 * Daily job: reminder sweep, the email digest, the retention sweep (D-151), then company archives (D-165) for every tenant. Schedule it once a day (e.g. 6:00
 * local) until the job queue lands. Mail goes through the DEVELOPMENT adapter (files in .storage/mail):
 * no email provider is connected yet.
 *
 *   npx tsx scripts/run-reminders.ts
 */
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { DevFileMailSender, queueDigests, sendQueued } from '../src/modules/notifications/mail.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { runRetention } from '../src/modules/retention/service.js';
import { runArchives } from '../src/modules/archives/service.js';
import { remindOverdueSpecReviews } from '../src/modules/documents/specs.js';
import { withTx } from '../src/platform/db/tx.js';
import { config } from '../src/config.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';

const sender = new DevFileMailSender();
const blobs = new LocalBlobStore(config.storageDir);
for (const t of (await getAdminPool().query('SELECT id, slug FROM tenant ORDER BY slug')).rows) {
  const reminders = await runReminders(t.id);
  const queued = await queueDigests(t.id);
  const sent = await sendQueued(t.id, sender);
  // Retention (D-151) runs after mail goes out, so nothing is removed before it is sent.
  const removed = await runRetention(t.id);
  // Company archives (D-165): one every 30 days by default, the latest 12 kept.
  const archives = await runArchives(blobs, t.id);
  // Specification revisions whose impact review is late (D-169), and documents whose effective date has come.
  const lateSpecs = await withTx({ tenantId: t.id, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    await tx.query('SELECT document_promote_due()');
    return remindOverdueSpecReviews(tx, t.id);
  });
  console.log(`${t.slug}: reminders ${JSON.stringify(reminders)}; digests queued ${queued}, written ${sent} via ${sender.name}; retention removed ${JSON.stringify(removed)}; archive ${archives.created ? 'taken' : 'not due'}, ${archives.removed} expired; ${lateSpecs} late specification reviews`);
}
await closePools();
