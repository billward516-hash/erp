export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://erp_app:erp_app_dev@localhost:54329/erp',
  databaseAdminUrl: process.env.DATABASE_ADMIN_URL ?? 'postgres://erp_owner@localhost:54329/erp',
  storageDir: process.env.STORAGE_DIR ?? './.storage',
  port: Number(process.env.PORT ?? 3000),
  authMode: (process.env.AUTH_MODE ?? 'dev-token') as 'dev-token',
  /** Base URL used in links inside emails. */
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  /** Sender address for notification emails. */
  mailFrom: process.env.MAIL_FROM ?? 'Ops Platform <notifications@ops-platform.example>',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  /** Rate limits (D-150): requests per minute per signed-in user, and per address to sign-in and public endpoints. 0 turns one off. */
  rateLimitPerUser: Number(process.env.RATE_LIMIT_PER_USER ?? 1200),
  rateLimitPerAddress: Number(process.env.RATE_LIMIT_PER_ADDRESS ?? 120),
  /** Bearer token that unlocks /metrics; unset keeps /metrics off. */
  metricsToken: process.env.METRICS_TOKEN || undefined,
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
