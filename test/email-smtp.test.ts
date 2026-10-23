import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { notify } from '../src/platform/notify/notify.js';
import { assertProductionConfig } from '../src/platform/config-check.js';
import { runDailyForTenant } from '../src/platform/jobs/daily.js';
import { setPreferences } from '../src/modules/notifications/service.js';
import { DevFileMailSender, createMailSender, queueDigests, sendQueuedDetailed } from '../src/modules/notifications/mail.js';
import { SmtpMailSender, redactSecrets, smtpOptionsFromEnv } from '../src/modules/notifications/smtp.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { startFakeSmtp } from './fake-smtp.js';

/**
 * Outgoing email over SMTP (D-183B), proven against an in-process fake SMTP server only. Nothing here reaches a real provider
 * (owner item O-2), so it shows the code speaks SMTP correctly, not that any provider accepts our mail.
 */
let app: FastifyInstance;
const db = () => getAdminPool();
beforeAll(() => { app = buildApp(); });
afterAll(async () => { await app.close(); await closePools(); });

const FROM = 'Ops Platform <ops@plant.example>';
const sender = (port: number, extra: Partial<ConstructorParameters<typeof SmtpMailSender>[0]> = {}, overrides: Record<string, unknown> = {}) =>
  new SmtpMailSender({ host: '127.0.0.1', port, security: 'none', from: FROM, ...extra }, overrides);
const closed: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { while (closed.length) await closed.pop()!.close(); });
const fake = async (o: Parameters<typeof startFakeSmtp>[0] = {}) => { const s = await startFakeSmtp(o); closed.push(s); return s; };
/** A port nothing listens on. */
const deadPort = async () => { const s = await startFakeSmtp(); const p = s.port; await s.close(); return p; };
const mail = { id: 1, to: 'pat@customer.example', subject: 'Hello there', text: 'Line one\nLine two' };

describe('settings from the environment', () => {
  it('uses the development writer without SMTP_HOST, and SMTP with it', () => {
    expect(smtpOptionsFromEnv({})).toBeNull();
    expect(createMailSender({})).toBeInstanceOf(DevFileMailSender);
    const s = createMailSender({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASSWORD: 'p', MAIL_FROM: FROM });
    expect(s).toBeInstanceOf(SmtpMailSender);
    expect(s.name).toBe('smtp smtp.example.com:587 (STARTTLS)');
    expect(smtpOptionsFromEnv({ SMTP_HOST: 'h', SMTP_SECURE: 'true' })).toMatchObject({ port: 465, security: 'tls' });
    expect(smtpOptionsFromEnv({ SMTP_HOST: 'h', SMTP_PORT: '2525', SMTP_SECURE: 'false' })).toMatchObject({ port: 2525, security: 'none' });
    expect(smtpOptionsFromEnv({ SMTP_HOST: 'h', MAIL_FROM: FROM })).toMatchObject({ from: FROM, security: 'starttls' });
  });
  it('refuses nonsense values with a plain message', () => {
    expect(() => smtpOptionsFromEnv({ SMTP_HOST: 'h', SMTP_PORT: 'abc' })).toThrow(/SMTP_PORT/);
    expect(() => smtpOptionsFromEnv({ SMTP_HOST: 'h', SMTP_SECURE: 'maybe' })).toThrow(/SMTP_SECURE/);
    expect(() => smtpOptionsFromEnv({ SMTP_HOST: 'h', SMTP_USER: 'u' })).toThrow(/together/);
  });
  it('production warns, clearly, when no mail server is set; and checks the settings it is given', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://app:S3cure-long-secret@db.internal:5432/erp', DATABASE_ADMIN_URL: 'postgres://owner:Another-long-secret@db.internal:5432/erp', APP_BASE_URL: 'https://erp.example.com', SSO_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), STORAGE_DIR: '/data', TRUST_PROXY: '1', METRICS_TOKEN: 'm'.repeat(24) };
    expect(assertProductionConfig(base).warnings.join(' ')).toMatch(/SMTP_HOST is not set: email is NOT delivered/);
    expect(assertProductionConfig({ ...base, SMTP_HOST: 'smtp.example.com', MAIL_FROM: FROM })).toEqual({ problems: [], warnings: [] });
    expect(assertProductionConfig({ ...base, SMTP_HOST: 'smtp.example.com' }).warnings.join(' ')).toMatch(/MAIL_FROM/);
    expect(assertProductionConfig({ ...base, SMTP_HOST: 'smtp.example.com', MAIL_FROM: FROM, SMTP_USER: 'u' }).problems.join(' ')).toMatch(/together/);
    expect(assertProductionConfig({ ...base, SMTP_HOST: 'smtp.example.com', MAIL_FROM: FROM, SMTP_SECURE: 'false' }).warnings.join(' ')).toMatch(/unencrypted/);
    expect(assertProductionConfig({ NODE_ENV: 'development' })).toEqual({ problems: [], warnings: [] });
  });
});

describe('delivery to an SMTP server', () => {
  it('delivers one message, with login, sender, recipient, subject and body', async () => {
    const s = await fake({ user: 'mailer', password: 'S3cret-pass' });
    await sender(s.port, { user: 'mailer', password: 'S3cret-pass' }).send(mail);
    expect(s.mails).toHaveLength(1);
    const m = s.mails[0]!;
    expect(m).toMatchObject({ from: 'ops@plant.example', to: ['pat@customer.example'], user: 'mailer' });
    expect(m.data).toMatch(/Subject: Hello there/);
    expect(m.data).toMatch(/Auto-Submitted: auto-generated/);
    expect(m.data).toContain('Line one');
    expect(m.data).toContain('Line two');
  });

  it('upgrades with STARTTLS before it logs in, and checks the server certificate', async () => {
    const s = await fake({ user: 'mailer', password: 'S3cret-pass', starttls: true });
    await sender(s.port, { user: 'mailer', password: 'S3cret-pass', security: 'starttls' }, { tls: { ca: s.cert!.cert } }).send(mail);
    expect(s.mails[0]).toMatchObject({ encrypted: true, user: 'mailer' });
    // Without trusting the certificate the same server is refused, and no message and no password are sent.
    const refused = fake({ user: 'mailer', password: 'S3cret-pass', starttls: true });
    const r = await refused;
    await expect(sender(r.port, { user: 'mailer', password: 'S3cret-pass', security: 'starttls' }).send(mail)).rejects.toThrow(/certificate|self.signed|ETLS|ESOCKET/i);
    expect(r.mails).toHaveLength(0);
    expect(r.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
  });

  it('delivers over TLS from the first byte', async () => {
    const s = await fake({ user: 'mailer', password: 'S3cret-pass', implicitTls: true });
    await sender(s.port, { user: 'mailer', password: 'S3cret-pass', security: 'tls' }, { tls: { ca: s.cert!.cert } }).send(mail);
    expect(s.mails[0]).toMatchObject({ encrypted: true, to: ['pat@customer.example'] });
  });

  it('will not send the password in the clear when encryption is required but the server offers none', async () => {
    const s = await fake({ user: 'mailer', password: 'S3cret-pass' });
    await expect(sender(s.port, { user: 'mailer', password: 'S3cret-pass', security: 'starttls' }).send(mail)).rejects.toThrow();
    expect(s.mails).toHaveLength(0);
    expect(s.commands.some((c) => /^AUTH/.test(c))).toBe(false);
  });

  it('reports a refused login without ever showing the password, even if the server echoes it', async () => {
    const s = await fake({ user: 'mailer', password: 'S3cret-pass', echoAuthInErrors: true });
    const err = await sender(s.port, { user: 'mailer', password: 'wrong-Passw0rd' }).send(mail).then(() => new Error('did not fail'), (e) => e as Error);
    expect(err.message).toMatch(/535|Authentication/i);
    expect(err.message).not.toContain('wrong-Passw0rd');
    expect(err.message).not.toContain(Buffer.from('wrong-Passw0rd').toString('base64'));
    expect(redactSecrets('AUTH PLAIN AHVzZXIAcGFzcw== and pw hunter22', ['hunter22'])).toBe('AUTH PLAIN [hidden] and pw [hidden]');
  });
});

/** A company with three people who have something unread, to see who gets a digest. */
async function fresh() {
  const w = await makeWorld('smtp');
  const give = async (who: World['admin'], kind = 'reminder.pm_due', title = `Something for ${who.userId.slice(0, 4)}`) => asActor(w.admin, (tx) => notify(tx, w.tenantId, [who.userId], { kind, title, body: 'Details', link: '/pm' }));
  const rows = async () => (await db().query('SELECT user_id, to_address, status, attempts, last_error, subject FROM email_message WHERE tenant_id = $1 ORDER BY id', [w.tenantId])).rows;
  return { w, give, rows };
}

describe('who gets a digest', () => {
  it('respects the digest switch, muted kinds, and a switch turned off after the digest was queued', async () => {
    const { w, give, rows } = await fresh();
    const addr = async (u: World['admin']) => (await db().query('SELECT email FROM app_user WHERE id = $1', [u.userId])).rows[0].email as string;
    await give(w.managerA); await give(w.exec); await give(w.opsA);
    await asActor(w.techA, (tx) => setPreferences(tx, w.techA, { emailDigest: false }));
    await give(w.techA); // has something unread but does not want email
    await asActor(w.buyer, (tx) => setPreferences(tx, w.buyer, { mutedKinds: ['reminder.po_late'] }));
    await give(w.buyer, 'reminder.po_late'); // muted: never created, so there is nothing to email
    expect(await queueDigests(w.tenantId, '2031-05-01')).toBe(3);
    const queued = await rows();
    expect(queued.map((r) => r.to_address).sort()).toEqual((await Promise.all([w.managerA, w.exec, w.opsA].map(addr))).sort());
    // exec turns email off after the digest was queued: it is cancelled, not sent.
    await asActor(w.exec, (tx) => setPreferences(tx, w.exec, { emailDigest: false }));
    const s = await fake();
    const report = await sendQueuedDetailed(w.tenantId, sender(s.port));
    expect(report).toMatchObject({ sent: 2, cancelled: 1, retrying: 0, gaveUp: 0 });
    expect(s.mails.map((m) => m.to[0]).sort()).toEqual((await Promise.all([w.managerA, w.opsA].map(addr))).sort());
    expect((await rows()).find((r) => r.user_id === w.exec.userId)).toMatchObject({ status: 'cancelled' });
    // Nothing for the person who switched email off, nor for the one who muted the only kind they had.
    expect(s.mails.some((m) => /^(techA|buyer)@/.test(m.to[0]!))).toBe(false);
  });
});

describe('when sending fails', () => {
  it('records a transient failure, keeps the message, and the next run delivers it', async () => {
    const { w, give, rows } = await fresh();
    await give(w.managerA);
    await queueDigests(w.tenantId, '2031-05-02');
    let failures = 1;
    const s = await fake({ failData: () => (failures-- > 0 ? '451 4.3.0 try again later' : null) });
    const first = await sendQueuedDetailed(w.tenantId, sender(s.port));
    expect(first).toMatchObject({ sent: 0, retrying: 1, gaveUp: 0 });
    expect(first.firstError).toMatch(/451/);
    expect((await rows())[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await rows())[0]!.last_error).toMatch(/451/);
    const second = await sendQueuedDetailed(w.tenantId, sender(s.port));
    expect(second).toMatchObject({ sent: 1, retrying: 0 });
    expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
    expect(s.mails).toHaveLength(1);
  });

  it('gives up on an address the server refuses for good, and tells the administrators once', async () => {
    const { w, give, rows } = await fresh();
    await give(w.managerA); await give(w.exec);
    await queueDigests(w.tenantId, '2031-05-03');
    const s = await fake({ rejectRcpt: (a) => (a.startsWith('managerA@') ? '550 5.1.1 No such mailbox' : null) });
    const r = await sendQueuedDetailed(w.tenantId, sender(s.port));
    expect(r).toMatchObject({ sent: 1, gaveUp: 1, retrying: 0 });
    const bad = (await rows()).find((x) => x.to_address.startsWith('managerA@'))!;
    expect(bad).toMatchObject({ status: 'failed', attempts: 1 });
    expect(bad.last_error).toMatch(/550|mailbox|refused/i);
    // Not silently dropped: the administrator has a notification, and running again adds no second one.
    await sendQueuedDetailed(w.tenantId, sender(s.port));
    const told = (await db().query(`SELECT count(*)::int AS n FROM notification WHERE tenant_id = $1 AND kind = 'reminder.mail_failed' AND user_id = $2`, [w.tenantId, w.admin.userId])).rows[0].n;
    expect(told).toBe(1);
  });

  it('gives up after five failed attempts, not before', async () => {
    const { w, give, rows } = await fresh();
    await give(w.managerA);
    await queueDigests(w.tenantId, '2031-05-04');
    const s = await fake({ failData: () => '451 4.3.0 busy' });
    for (let i = 1; i <= 4; i++) { await sendQueuedDetailed(w.tenantId, sender(s.port)); expect((await rows())[0]).toMatchObject({ status: 'queued', attempts: i }); }
    expect(await sendQueuedDetailed(w.tenantId, sender(s.port))).toMatchObject({ gaveUp: 1 });
    expect((await rows())[0]).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('a server that cannot be reached does not use up attempts, stops the batch early, and is retried', async () => {
    const { w, give, rows } = await fresh();
    for (const u of [w.managerA, w.exec, w.opsA, w.buyer, w.finance]) await give(u);
    await queueDigests(w.tenantId, '2031-05-05');
    const down = await sendQueuedDetailed(w.tenantId, sender(await deadPort()));
    expect(down).toMatchObject({ sent: 0, deferred: 2 }); // three tried, the rest left alone
    expect(down.firstError).toMatch(/ECONNECTION|ECONNREFUSED|connect/i);
    expect((await rows()).filter((r) => r.attempts === 0 && r.status === 'queued')).toHaveLength(5); // none used up an attempt
    expect((await rows()).filter((r) => r.last_error)).toHaveLength(3); // the three that were tried say why
    const s = await fake();
    expect(await sendQueuedDetailed(w.tenantId, sender(s.port))).toMatchObject({ sent: 5 });
    expect((await rows()).every((r) => r.status === 'sent')).toBe(true);
  });
});

describe('the daily job', () => {
  it('never stops for a failed send: it records it, finishes the other steps, and the next run delivers', async () => {
    const { w, give } = await fresh();
    await give(w.managerA);
    const down = await runDailyForTenant(w.tenantId, undefined, { sender: sender(await deadPort()) });
    expect(down.ok).toBe(false);
    expect(down.digestsError).toMatch(/not delivered.*retried by the next daily run/);
    expect(down).toHaveProperty('retention'); // steps after the failed send still ran
    expect(down).toHaveProperty('archives');
    expect(down).toHaveProperty('documents');
    expect(down).toHaveProperty('sync');
    const s = await fake();
    const up = await runDailyForTenant(w.tenantId, undefined, { sender: sender(s.port) });
    expect(up.ok).toBe(true);
    expect(up.digests).toMatchObject({ sent: expect.any(Number), retrying: 0, gaveUp: 0 });
    expect(s.mails.length).toBeGreaterThan(0);
    expect(s.mails.some((m) => /^managerA@/.test(m.to[0]!))).toBe(true);
  });
});

describe('the test email', () => {
  let w: World;
  const saved = { ...process.env };
  beforeAll(async () => { w = await makeWorld('smtptest'); });
  afterEach(() => { for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'MAIL_FROM']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const post = (token: string | undefined) => app.inject({ method: 'POST', url: '/api/job-runs/test-email', headers: { authorization: `Bearer ${token}` } });

  it('is for tenant administrators only', async () => {
    expect((await post(w.tokens.techA)).statusCode).toBe(403);
    expect((await post(w.tokens.managerA)).statusCode).toBe(403);
  });

  it('says plainly that nothing was sent when no mail server is set', async () => {
    delete process.env.SMTP_HOST;
    const r = (await post(w.tokens.admin)).json();
    expect(r).toMatchObject({ ok: true, delivered: false, sender: expect.stringContaining('not sent') });
    const page = (await app.inject({ method: 'GET', url: '/api/job-runs', headers: { authorization: `Bearer ${w.tokens.admin}` } })).json();
    expect(page.mail).toMatchObject({ configured: false });
  });

  it('delivers to the administrator\'s own address through the configured server', async () => {
    const s = await fake({ user: 'mailer', password: 'S3cret-pass' });
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_USER: 'mailer', SMTP_PASSWORD: 'S3cret-pass', SMTP_SECURE: 'false', MAIL_FROM: FROM });
    const r = (await post(w.tokens.admin)).json();
    expect(r).toMatchObject({ ok: true, delivered: true, error: null, to: expect.stringMatching(/^admin@/) });
    expect(s.mails).toHaveLength(1);
    expect(s.mails[0]!.to[0]).toBe(r.to);
    const page = (await app.inject({ method: 'GET', url: '/api/job-runs', headers: { authorization: `Bearer ${w.tokens.admin}` } })).json();
    expect(page.mail).toMatchObject({ configured: true, sender: expect.stringContaining('127.0.0.1') });
    const audit = (await db().query(`SELECT data FROM audit_event WHERE tenant_id = $1 AND action = 'mail.test_sent'`, [w.tenantId])).rows;
    expect(audit.length).toBeGreaterThan(0);
  });

  it('shows the server\'s error text with the password removed', async () => {
    const s = await fake({ user: 'mailer', password: 'S3cret-pass', echoAuthInErrors: true });
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_USER: 'mailer', SMTP_PASSWORD: 'Wrong-Passw0rd', SMTP_SECURE: 'false' });
    const res = await post(w.tokens.admin);
    const r = res.json();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/535|Authentication/i);
    expect(res.body).not.toContain('Wrong-Passw0rd');
    expect(JSON.stringify((await db().query(`SELECT data FROM audit_event WHERE tenant_id = $1 AND action = 'mail.test_sent'`, [w.tenantId])).rows)).not.toContain('Wrong-Passw0rd');
  });

  it('reports a server that cannot be reached', async () => {
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(await deadPort()), SMTP_SECURE: 'false' });
    delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
    expect((await post(w.tokens.admin)).json()).toMatchObject({ ok: false, delivered: false, error: expect.stringMatching(/ECONNECTION|ECONNREFUSED|connect/i) });
  });

  it('reports a bad setting instead of failing', async () => {
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: 'abc' });
    expect((await post(w.tokens.admin)).json()).toMatchObject({ ok: false, error: expect.stringMatching(/SMTP_PORT/) });
  });
});
