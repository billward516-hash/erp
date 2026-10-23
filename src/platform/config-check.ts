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
  if (!env.SSO_SECRET_KEY || env.SSO_SECRET_KEY.length < 32) problems.push('SSO_SECRET_KEY is required (at least 32 characters)');
  if (!env.STORAGE_DIR) warnings.push('STORAGE_DIR is not set: files go to ./.storage, which is lost when the container is replaced; mount a volume or use object storage');
  if (env.TRUST_PROXY !== '1') warnings.push('TRUST_PROXY is not 1: behind a load balancer every request will appear to come from the proxy, defeating per-address rate limits');
  if (!env.METRICS_TOKEN) warnings.push('METRICS_TOKEN is not set: /metrics is off');
  return { problems, warnings };
}
