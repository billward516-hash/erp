import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { config } from '../../config.js';
import type { MailSender, OutgoingMail } from './mail.js';

/**
 * Provider-neutral SMTP sending (D-183B). Verified only against an in-process fake SMTP server (test/email-smtp.test.ts);
 * it has not been run against a real provider (owner item O-2), so treat the first real connection as a test.
 */

/** A failed send. `connection`: the server could not be reached or refused our login, so every message would fail alike. `permanent`: retrying will not help (the address was refused). */
export class MailError extends Error {
  constructor(message: string, readonly kind: { connection?: boolean; permanent?: boolean } = {}) { super(message); this.name = 'MailError'; }
  get connection() { return !!this.kind.connection; }
  get permanent() { return !!this.kind.permanent; }
}

/** Removes secrets from text that will be stored or shown: the password itself, and its base64 forms as they appear in an SMTP AUTH exchange. */
export function redactSecrets(text: string, secrets: (string | undefined | null)[]) {
  let out = text;
  for (const s of secrets.filter((x): x is string => !!x && x.length >= 3)) {
    for (const f of new Set([s, Buffer.from(s).toString('base64'), encodeURIComponent(s)])) out = out.split(f).join('[hidden]');
  }
  return out.replace(/(AUTH\s+(?:PLAIN|LOGIN|XOAUTH2|CRAM-MD5)\s+)\S+/gi, '$1[hidden]');
}

export type SmtpSecurity = 'starttls' | 'tls' | 'none';
export interface SmtpOptions { host: string; port: number; user?: string; password?: string; security: SmtpSecurity; from: string }

/**
 * Reads SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE and MAIL_FROM. Returns null when SMTP_HOST is unset (development
 * adapter). SMTP_SECURE: `true` = encrypted from the first byte (usually port 465); `starttls` (the default) = the connection must
 * upgrade to TLS before anything is sent, including the password (usually port 587); `false` = no encryption, for a trusted relay on
 * the same host only. Throws a plain-language error for a value that makes no sense.
 */
export function smtpOptionsFromEnv(env: Record<string, string | undefined>): SmtpOptions | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const sec = (env.SMTP_SECURE ?? '').trim().toLowerCase();
  let security: SmtpSecurity;
  if (['true', '1', 'yes', 'tls', 'ssl'].includes(sec)) security = 'tls';
  else if (['false', '0', 'no', 'none'].includes(sec)) security = 'none';
  else if (sec === '' || sec === 'starttls') security = 'starttls';
  else throw new Error(`SMTP_SECURE must be true, starttls or false (got "${env.SMTP_SECURE}")`);
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : security === 'tls' ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SMTP_PORT must be a port number (got "${env.SMTP_PORT}")`);
  if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
  return { host, port, user: env.SMTP_USER || undefined, password: env.SMTP_PASSWORD || undefined, security, from: env.MAIL_FROM || config.mailFrom };
}

const CONNECTION_CODES = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ETLS', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND']);

/** Sends through any SMTP server (STARTTLS or TLS, with login). Only standard SMTP is used. */
export class SmtpMailSender implements MailSender {
  readonly name: string;
  private readonly transport: Transporter;
  /** `transportOverrides` is for tests (for example to trust a test certificate); production never sets it, so certificates are always verified. */
  constructor(private readonly o: SmtpOptions, transportOverrides: Record<string, unknown> = {}) {
    this.name = `smtp ${o.host}:${o.port} (${o.security === 'tls' ? 'TLS' : o.security === 'starttls' ? 'STARTTLS' : 'unencrypted'})`;
    this.transport = nodemailer.createTransport({
      host: o.host, port: o.port, secure: o.security === 'tls', requireTLS: o.security === 'starttls', ignoreTLS: o.security === 'none',
      auth: o.user ? { user: o.user, pass: o.password } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000, ...transportOverrides,
    } as SMTPTransport.Options);
  }
  private secrets() { return [this.o.password, this.o.user && this.o.password ? Buffer.from(`\0${this.o.user}\0${this.o.password}`).toString('base64') : undefined]; }
  async send(m: OutgoingMail) {
    try {
      const info = await this.transport.sendMail({ from: this.o.from, to: m.to, subject: m.subject, text: m.text, headers: { 'Auto-Submitted': 'auto-generated' } });
      if (info.rejected?.length) throw Object.assign(new Error(`recipient refused: ${info.rejected.join(', ')}`), { code: 'EENVELOPE' });
    } catch (e) {
      throw this.describe(e);
    }
  }
  private describe(e: unknown) {
    const err = e as { code?: string; responseCode?: number; message?: string; response?: string };
    const base = err.message ?? String(e);
    const text = redactSecrets(`${base}${err.response && !base.includes(err.response) ? ` (${err.response})` : ''}`, this.secrets()).slice(0, 400);
    const connection = CONNECTION_CODES.has(err.code ?? '');
    const permanent = !connection && (err.code === 'EENVELOPE' || (err.responseCode ?? 0) >= 500);
    return new MailError(`${err.code ? `${err.code}: ` : ''}${text}`, { connection, permanent });
  }
}
