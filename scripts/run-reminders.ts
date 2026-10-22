/**
 * Daily job: reminder sweep, then the email digest for every tenant. Schedule it once a day (e.g. 6:00
 * local) until the job queue lands. Mail goes through the DEVELOPMENT adapter (files in .storage/mail):
 * no email provider is connected yet.
 *
 *   npx tsx scripts/run-reminders.ts
 */
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { DevFileMailSender, queueDigests, sendQueued } from '../src/modules/notifications/mail.js';
import { runReminders } from '../src/modules/notifications/reminders.js';

const sender = new DevFileMailSender();
for (const t of (await getAdminPool().query('SELECT id, slug FROM tenant ORDER BY slug')).rows) {
  const reminders = await runReminders(t.id);
  const queued = await queueDigests(t.id);
  const sent = await sendQueued(t.id, sender);
  console.log(`${t.slug}: reminders ${JSON.stringify(reminders)}; digests queued ${queued}, written ${sent} via ${sender.name}`);
}
await closePools();
