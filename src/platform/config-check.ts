/**
 * Refuses to start in production with development defaults (a database password anyone could guess, plain-http links, no secret for
 * single sign-on). Pure function of the environment so it can be tested; server.ts calls it before listening.
 */
export function assertProductionConfig(env: Record<string, string | undefined>) {
  const problems: string[] = []; const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') return { problems, warnings };
  for (const k of ['DATABASE_URL', 'DATABASE_ADMIN_URL'] as const) {
    const v = env[k];
    if (!v) { problems.push(`${k} must be set (the development default is not allowed in production)`); continue; }
    if (/_dev(@|:|\/|$)|erp_(app|owner)_dev|:password@|:postgres@/.test(v)) problems.push(`${k} uses a development password`);
    if (/localhost|127\.0\.0\.1/.test(v)) warnings.push(`${k} points at localhost`);
  }
  if (env.DATABASE_URL && env.DATABASE_URL === env.DATABASE_ADMIN_URL) problems.push('DATABASE_URL and DATABASE_ADMIN_URL must be different roles (the application role is limited by row-level security; the owner role is not)');
  if (!env.APP_BASE_URL) problems.push('APP_BASE_URL must be set to the public address, used in links inside emails');
  else if (!/^https:\/\//.test(env.APP_BASE_URL)) problems.push('APP_BASE_URL must use https');
  if (!env.SSO_SECRET_KEY) problems.push('SSO_SECRET_KEY is required (generate one with: openssl rand -base64 32)');
  else if (Buffer.from(env.SSO_SECRET_KEY, 'base64').length !== 32) problems.push('SSO_SECRET_KEY must be 32 random bytes, base64-encoded (generate one with: openssl rand -base64 32)');
  if (!env.STORAGE_DIR) warnings.push('STORAGE_DIR is not set: files go to ./.storage, which is lost when the container is replaced; mount a volume or use object storage');
  if (env.TRUST_PROXY !== '1') warnings.push('TRUST_PROXY is not 1: behind a load balancer every request will appear to come from the proxy, defeating per-address rate limits');
  if (!env.METRICS_TOKEN) warnings.push('METRICS_TOKEN is not set: /metrics is off');
  // Outgoing email (D-183B). Without SMTP_HOST the daily digests and notices are written to files on the server and nobody receives them.
  if (!env.SMTP_HOST) warnings.push('SMTP_HOST is not set: email is NOT delivered. Daily digests and notices are written as files under STORAGE_DIR/mail and nothing reaches anyone; set SMTP_HOST (and SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE, MAIL_FROM) to send real email');
  else {
    if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD) problems.push('SMTP_USER and SMTP_PASSWORD must be set together');
    if (env.SMTP_PORT && !(Number.isInteger(Number(env.SMTP_PORT)) && Number(env.SMTP_PORT) > 0 && Number(env.SMTP_PORT) < 65536)) problems.push('SMTP_PORT must be a port number');
    if (env.SMTP_SECURE && !/^(true|false|starttls|tls|ssl|none|1|0|yes|no)$/i.test(env.SMTP_SECURE.trim())) problems.push('SMTP_SECURE must be true, starttls or false');
    if (/^(false|none|0|no)$/i.test((env.SMTP_SECURE ?? '').trim()) && !/^(localhost|127\.0\.0\.1|::1)$/.test(env.SMTP_HOST)) warnings.push('SMTP_SECURE is false and SMTP_HOST is not this machine: mail, and the SMTP password, cross the network unencrypted');
    if (!env.MAIL_FROM) warnings.push('MAIL_FROM is not set: mail is sent from the placeholder address notifications@ops-platform.example, which providers will reject or mark as spam');
  }
  return { problems, warnings };
}
