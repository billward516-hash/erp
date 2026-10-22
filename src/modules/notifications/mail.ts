import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { many, withTx } from '../../platform/db/tx.js';

export interface OutgoingMail { id: number; to: string; subject: string; text: string }
/**
 * Mail adapter. Only the development adapter exists: no email provider has been chosen or security-tested
 * yet (brief §15: email delivery "when justified and security-tested"). A hosted adapter (e.g. SES or
 * SMTP with SPF/DKIM) implements the same interface.
 */
export interface MailSender { name: string; send(m: OutgoingMail): Promise<void> }

/** DEVELOPMENT ONLY: writes each message as an .eml file under the storage directory; nothing is sent. */
export class DevFileMailSender implements MailSender {
  name = 'dev-file (not sent)';
  constructor(private readonly dir = path.join(config.storageDir, 'mail')) {}
  async send(m: OutgoingMail) {
    await mkdir(this.dir, { recursive: true });
    const eml = [`From: ${config.mailFrom}`, `To: ${m.to}`, `Subject: ${m.subject}`, 'Content-Type: text/plain; charset=utf-8', `X-Dev-Note: development mail adapter, not delivered`, '', m.text].join('\r\n');
    await writeFile(path.join(this.dir, `${String(m.id).padStart(6, '0')}-${m.to.replace(/[^\w.@-]/g, '_')}.eml`), eml);
  }
}

/**
 * Queues one daily digest per user who wants email and has unread notifications not yet emailed.
 * Idempotent per user per day (dedupe key).
 */
export async function queueDigests(tenantId: string, today = new Date().toISOString().slice(0, 10)) {
  return withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    const users = await many(tx, `SELECT u.id, u.email, u.display_name FROM app_user u LEFT JOIN notification_preference p ON p.user_id = u.id
      WHERE u.status = 'active' AND u.email IS NOT NULL AND coalesce(p.email_digest, true)
        AND EXISTS (SELECT 1 FROM notification n WHERE n.user_id = u.id AND n.read_at IS NULL AND n.emailed_at IS NULL)`);
    let queued = 0;
    for (const u of users) {
      const items = await many(tx, `SELECT id, title, body, link FROM notification WHERE user_id = $1 AND read_at IS NULL AND emailed_at IS NULL
        ORDER BY created_at DESC LIMIT 50`, [u.id]);
      const lines = items.map((n) => `• ${n.title}${n.body ? `\n  ${n.body}` : ''}${n.link ? `\n  ${config.appBaseUrl}${n.link}` : ''}`);
      const text = [`Hello ${u.display_name.split(' ')[0]},`, '', `${items.length} thing${items.length === 1 ? '' : 's'} for you today:`, '', ...lines, '',
        `Open the platform: ${config.appBaseUrl}/notifications`, 'You get this daily summary because email is on in your notification settings.'].join('\n');
      const r = await tx.query(`INSERT INTO email_message (tenant_id, user_id, to_address, subject, body_text, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [tenantId, u.id, u.email, `${items.length} item${items.length === 1 ? '' : 's'} need your attention`, text, `digest:${u.id}:${today}`]);
      if (r.rowCount) {
        queued++;
        await tx.query('UPDATE notification SET emailed_at = now() WHERE id = ANY ($1)', [items.map((n) => n.id)]);
      }
    }
    return queued;
  });
}

/** Sends queued messages through the adapter; failures retry on the next run, up to 5 attempts. */
export async function sendQueued(tenantId: string, sender: MailSender) {
  const msgs = await withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, (tx) =>
    many(tx, `SELECT id, to_address, subject, body_text FROM email_message WHERE status = 'queued' AND attempts < 5 ORDER BY id LIMIT 500`));
  let sent = 0;
  for (const m of msgs) {
    let error: string | null = null;
    try { await sender.send({ id: m.id, to: m.to_address, subject: m.subject, text: m.body_text }); sent++; } catch (e) { error = (e as Error).message; }
    await withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, (tx) => tx.query(
      `UPDATE email_message SET attempts = attempts + 1, status = CASE WHEN $2::text IS NULL THEN 'sent' WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'queued' END,
         sent_at = CASE WHEN $2::text IS NULL THEN now() END, last_error = $2 WHERE id = $1`, [m.id, error]));
  }
  return sent;
}
