import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { many, withTx } from '../../platform/db/tx.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { MailError, SmtpMailSender, smtpOptionsFromEnv } from './smtp.js';

export interface OutgoingMail { id: number; to: string; subject: string; text: string }
/**
 * Mail adapter. Two exist: `SmtpMailSender` (smtp.ts; any provider that speaks SMTP, chosen when SMTP_HOST is set) and the development
 * adapter below that writes .eml files. The SMTP sender is verified only against an in-process fake SMTP server (test/email-smtp.test.ts),
 * never against a real provider (owner item O-2). SPF/DKIM are the provider's and the domain's business, not this code's.
 */
export interface MailSender { name: string; send(m: OutgoingMail): Promise<void> }

/** The sender the environment asks for: SMTP when SMTP_HOST is set, otherwise the development file writer. */
export function createMailSender(env: Record<string, string | undefined> = process.env): MailSender {
  const o = smtpOptionsFromEnv(env);
  return o ? new SmtpMailSender(o) : new DevFileMailSender();
}

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

export interface SendReport {
  /** Delivered to the mail server this run. */
  sent: number;
  /** Failed this run and will be tried again by the next daily run. */
  retrying: number;
  /** Failed for good (the address was refused, five attempts, or two weeks in the queue): shown to administrators. */
  gaveUp: number;
  /** The recipient turned email off, or left, after the message was queued. */
  cancelled: number;
  /** Not tried because the server could not be reached; they stay queued. */
  deferred: number;
  /** First error text of the run (secrets removed), for the Scheduled jobs page. */
  firstError: string | null;
  sender: string;
}

const ANY_FACILITY: { userId: null; facilityIds: string[]; allFacilities: boolean } = { userId: null, facilityIds: [], allFacilities: true };
const MAX_ATTEMPTS = 5;
const MAX_QUEUE_DAYS = 14;
/** After this many connection-level failures in a row the rest of the batch is left queued instead of waiting on a dead server. */
const STOP_AFTER_CONNECTION_FAILURES = 3;

/**
 * Sends queued messages through the adapter. A failed send is recorded on the message (attempts, last error) and tried again by the
 * next daily run; it never stops the job and is never dropped without a trace: a message that is given up on is marked failed and
 * tells the administrators. Preferences are checked again at send time, so a person who turned email off after their digest was
 * queued does not get it. Connection and login failures do not use up a message's attempts (the server, not the message, is the
 * problem) and end the batch early; a message still unsent after two weeks is given up on.
 */
export async function sendQueuedDetailed(tenantId: string, sender: MailSender): Promise<SendReport> {
  const msgs = await withTx({ tenantId, ...ANY_FACILITY }, (tx) =>
    many(tx, `SELECT m.id, m.to_address, m.subject, m.body_text, m.user_id, m.kind, (u.id IS NULL OR u.status <> 'active' OR NOT coalesce(p.email_digest, true)) AS opted_out
      FROM email_message m LEFT JOIN app_user u ON u.id = m.user_id LEFT JOIN notification_preference p ON p.user_id = m.user_id
      WHERE m.status = 'queued' AND m.attempts < ${MAX_ATTEMPTS} ORDER BY m.id LIMIT 500`));
  const r: SendReport = { sent: 0, retrying: 0, gaveUp: 0, cancelled: 0, deferred: 0, firstError: null, sender: sender.name };
  let connectionFailures = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.kind === 'digest' && m.user_id && m.opted_out) {
      await withTx({ tenantId, ...ANY_FACILITY }, (tx) => tx.query(`UPDATE email_message SET status = 'cancelled', last_error = 'recipient turned email off or is no longer active' WHERE id = $1`, [m.id]));
      r.cancelled++;
      continue;
    }
    if (connectionFailures >= STOP_AFTER_CONNECTION_FAILURES) { r.deferred += msgs.length - i; break; }
    let error: string | null = null;
    let kind: { connection?: boolean; permanent?: boolean } = {};
    try {
      await sender.send({ id: m.id, to: m.to_address, subject: m.subject, text: m.body_text });
      connectionFailures = 0;
    } catch (e) {
      error = (e instanceof MailError ? e.message : `${(e as Error).message ?? e}`).slice(0, 400);
      kind = e instanceof MailError ? { connection: e.connection, permanent: e.permanent } : {};
      r.firstError ??= error;
      if (kind.connection) connectionFailures++;
    }
    const status = await withTx({ tenantId, ...ANY_FACILITY }, async (tx) => {
      const row = (await tx.query(
        `UPDATE email_message SET attempts = attempts + CASE WHEN $3 THEN 1 ELSE 0 END,
           status = CASE WHEN $2::text IS NULL THEN 'sent'
                         WHEN $4 OR attempts + CASE WHEN $3 THEN 1 ELSE 0 END >= ${MAX_ATTEMPTS} OR created_at < now() - interval '${MAX_QUEUE_DAYS} days' THEN 'failed' ELSE 'queued' END,
           sent_at = CASE WHEN $2::text IS NULL THEN now() END, last_error = $2 WHERE id = $1 RETURNING status`,
        [m.id, error, !kind.connection, !!kind.permanent])).rows[0].status as string;
      if (row === 'failed') {
        await notify(tx, tenantId, await usersWithPermission(tx, 'tenant.admin', null), { kind: 'reminder.mail_failed', title: `An email to ${m.to_address} could not be delivered and was given up on`,
          body: `${m.subject}\n${error ?? ''}`.trim(), link: '/jobs', dedupeKey: `mail-failed:${m.id}` });
      }
      return row;
    });
    if (status === 'sent') r.sent++; else if (status === 'failed') r.gaveUp++; else r.retrying++;
  }
  return r;
}

/** As `sendQueuedDetailed`, returning only how many were delivered. */
export async function sendQueued(tenantId: string, sender: MailSender) { return (await sendQueuedDetailed(tenantId, sender)).sent; }

/** Sends one message to the person asking, so an administrator can see whether delivery works. Never throws: the outcome is the result. */
export async function sendTestEmail(sender: MailSender, to: string, who: string) {
  const delivered = !(sender instanceof DevFileMailSender);
  try {
    await sender.send({ id: 0, to, subject: 'Test email from your platform', text: [`Hello ${who},`, '',
      delivered ? 'This is a test message sent with the platform\'s mail server settings. If you can read it, outgoing email works.'
        : 'This is a test message from the development mail adapter. Nothing was sent: no mail server is configured (SMTP_HOST is not set), so the message was written to a file on the server.'].join('\n') });
    return { ok: true, delivered, sender: sender.name, to, error: null as string | null };
  } catch (e) {
    return { ok: false, delivered: false, sender: sender.name, to, error: ((e as Error).message ?? String(e)).slice(0, 400) };
  }
}
