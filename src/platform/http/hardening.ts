import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { MIGRATIONS_DIR } from '../db/migrate.js';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors.js';
import { requestPath } from './helpers.js';

/**
 * Production hardening (D-150): request ids, security headers, rate limits, metrics and health probes.
 * Everything here is in-process and provider-independent; a second server instance keeps its own counters (see D-150).
 */
export interface HardeningOptions {
  /** Requests per minute for one signed-in user's token. 0 turns the limit off. */
  perUserPerMinute: number;
  /** Requests per minute from one address to unauthenticated endpoints (sign-in, public request forms). 0 turns it off. */
  perAddressPerMinute: number;
  /** Bearer token for /metrics. Without one, /metrics answers 404. */
  metricsToken?: string;
}

export function hardeningDefaults(): HardeningOptions {
  const off = process.env.NODE_ENV === 'test';
  return {
    perUserPerMinute: off ? 0 : config.rateLimitPerUser,
    perAddressPerMinute: off ? 0 : config.rateLimitPerAddress,
    metricsToken: config.metricsToken,
  };
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** An incoming X-Request-Id (from a load balancer) is kept when it looks like one; otherwise a new one is made. */
export function requestId(req: { headers: Record<string, string | string[] | undefined> }) {
  const h = req.headers['x-request-id'];
  return typeof h === 'string' && REQUEST_ID.test(h) ? h : randomUUID();
}

/** Content Security Policy for the web app: its own scripts only; blob: for document previews and downloads. */
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self'", "frame-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'self'",
].join('; ');

// ---------- rate limits: fixed one-minute windows ----------

class Windows {
  private counts = new Map<string, number>();
  private started = Date.now();
  hit(key: string, limit: number): number | null {
    const now = Date.now();
    if (now - this.started >= 60_000) { this.counts.clear(); this.started = now; }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n > limit ? this.retry(now) : null;
  }
  /** Refuses once a key has already used its limit, without counting this request. */
  over(key: string, limit: number): number | null {
    const now = Date.now();
    if (now - this.started >= 60_000) { this.counts.clear(); this.started = now; }
    return (this.counts.get(key) ?? 0) >= limit ? this.retry(now) : null;
  }
  private retry(now: number) { return Math.max(1, Math.ceil((this.started + 60_000 - now) / 1000)); }
}

// ---------- metrics (Prometheus text format) ----------

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
interface Histogram { buckets: number[]; sum: number; count: number }

export class Metrics {
  requests = new Map<string, number>();
  durations = new Map<string, Histogram>();
  limited = new Map<string, number>();
  errors = 0;
  readonly startedAt = Date.now();

  record(method: string, route: string, status: number, seconds: number) {
    const key = `${method}|${route}|${Math.floor(status / 100)}xx`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    let h = this.durations.get(route);
    if (!h) { h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.durations.set(route, h); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) h!.buckets[i]! += 1; });
    h.sum += seconds; h.count += 1;
    if (status >= 500) this.errors += 1;
  }

  render(): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const out: string[] = [];
    out.push('# HELP http_requests_total Requests answered, by method, route pattern and status class.', '# TYPE http_requests_total counter');
    for (const [k, n] of this.requests) { const [m, r, s] = k.split('|'); out.push(`http_requests_total{method="${m}",route="${esc(r!)}",status="${s}"} ${n}`); }
    out.push('# HELP http_request_duration_seconds Time to answer, by route pattern.', '# TYPE http_request_duration_seconds histogram');
    for (const [r, h] of this.durations) {
      BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{route="${esc(r)}",le="${b}"} ${h.buckets[i]}`));
      out.push(`http_request_duration_seconds_bucket{route="${esc(r)}",le="+Inf"} ${h.count}`, `http_request_duration_seconds_sum{route="${esc(r)}"} ${h.sum.toFixed(6)}`, `http_request_duration_seconds_count{route="${esc(r)}"} ${h.count}`);
    }
    out.push('# HELP http_rate_limited_total Requests refused by a rate limit.', '# TYPE http_rate_limited_total counter');
    for (const [k, n] of this.limited) out.push(`http_rate_limited_total{limit="${k}"} ${n}`);
    out.push('# HELP http_server_errors_total Requests answered with a 5xx status.', '# TYPE http_server_errors_total counter', `http_server_errors_total ${this.errors}`);
    const pool = getPool();
    out.push('# HELP db_pool_connections Database connections held by the request pool.', '# TYPE db_pool_connections gauge',
      `db_pool_connections{state="total"} ${pool.totalCount}`, `db_pool_connections{state="idle"} ${pool.idleCount}`, `db_pool_connections{state="waiting"} ${pool.waitingCount}`);
    const mem = process.memoryUsage();
    out.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`,
      '# TYPE nodejs_heap_used_bytes gauge', `nodejs_heap_used_bytes ${mem.heapUsed}`,
      '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);
    return `${out.join('\n')}\n`;
  }
}

const routeOf = (req: FastifyRequest) => req.routeOptions?.url ?? 'unmatched';

export interface Hardening {
  metrics: Metrics;
  /** Called when a bearer token is missing or wrong: counts against the address, so guessing tokens is limited too. */
  failedSignIn(req: FastifyRequest, reply: { header(k: string, v: string): unknown }): void;
}

export function registerHardening(app: FastifyInstance, opts: HardeningOptions): Hardening {
  const metrics = new Metrics();
  const windows = new Windows();
  const httpsOnly = /^https:/i.test(config.appBaseUrl);

  // Runs before authentication, so a flood of requests never reaches the database.
  app.addHook('onRequest', async (req, reply) => {
    (req as { startedAt?: bigint }).startedAt = process.hrtime.bigint();
    reply.header('x-request-id', req.id);
    const path = requestPath(req.url);
    if (path === '/health' || path === '/ready' || path === '/metrics') return;
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (path.startsWith('/api/') && token) {
      // An address that keeps sending wrong tokens is refused before its tokens are looked up.
      if (opts.perAddressPerMinute) refuse(reply, 'address', windows.over(`f:${req.ip}`, opts.perAddressPerMinute));
      if (opts.perUserPerMinute) refuse(reply, 'user', windows.hit(`u:${token}`, opts.perUserPerMinute));
    } else if ((path.startsWith('/auth/') || path.startsWith('/public/')) && opts.perAddressPerMinute) {
      // Separate budgets (D-161): a burst of public request forms from a shared address (a store, an office behind one
      // gateway) does not lock that address out of signing in, and neither shares the wrong-token budget.
      refuse(reply, 'address', windows.hit(`${path.startsWith('/auth/') ? 'a' : 'p'}:${req.ip}`, opts.perAddressPerMinute));
    }
  });

  function refuse(reply: { header(k: string, v: string): unknown }, which: string, retry: number | null) {
    if (retry === null) return;
    metrics.limited.set(which, (metrics.limited.get(which) ?? 0) + 1);
    reply.header('retry-after', String(retry));
    throw new AppError(429, 'rate_limited', `Too many requests. Try again in ${retry} second${retry === 1 ? '' : 's'}.`);
  }

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', CSP);
    if (httpsOnly) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const t = (req as { startedAt?: bigint }).startedAt;
    if (t === undefined || req.url === '/metrics') return;
    metrics.record(req.method, routeOf(req), reply.statusCode, Number(process.hrtime.bigint() - t) / 1e9);
  });

  // Liveness: the process answers.
  app.get('/health', async () => ({ ok: true }));
  // Readiness: the database answers and every migration in this build has been applied.
  app.get('/ready', async (_req, reply) => {
    try {
      const expected = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      const applied = new Set((await getPool().query('SELECT name FROM schema_migration')).rows.map((r) => r.name as string));
      const missing = expected.filter((f) => !applied.has(f));
      if (missing.length) return reply.status(503).send({ ok: false, reason: `${missing.length} migration${missing.length === 1 ? '' : 's'} not applied`, missing });
      return { ok: true, migrations: expected.length };
    } catch (err) {
      return reply.status(503).send({ ok: false, reason: 'database unavailable', detail: (err as Error).message });
    }
  });
  app.get('/metrics', async (req, reply) => {
    if (!opts.metricsToken) return reply.status(404).send({ error: { code: 'not_found', message: 'route not found' } });
    if (req.headers.authorization !== `Bearer ${opts.metricsToken}`) return reply.status(401).send({ error: { code: 'unauthenticated', message: 'metrics token required' } });
    return reply.type('text/plain; version=0.0.4').send(metrics.render());
  });
  return {
    metrics,
    failedSignIn(req, reply) { if (opts.perAddressPerMinute) refuse(reply, 'address', windows.hit(`f:${req.ip}`, opts.perAddressPerMinute)); },
  };
}
