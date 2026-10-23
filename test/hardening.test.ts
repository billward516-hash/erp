import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Production hardening (D-150). */
let app: FastifyInstance; let w: World;
const h = (who: string) => ({ authorization: `Bearer ${w.tokens[who]}` });

beforeAll(async () => {
  app = buildApp({ hardening: { perUserPerMinute: 5, perAddressPerMinute: 3, metricsToken: 'metrics-secret' } });
  w = await makeWorld('hard');
});
afterAll(async () => { await app.close(); await closePools(); });

describe('every response', () => {
  it('carries a request id and security headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(String(r.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(r.headers['content-security-policy'])).toContain("frame-src 'self' blob:");
  });

  it('keeps a request id passed by a load balancer, but not a malformed one', async () => {
    expect((await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'lb-1234.abc' } })).headers['x-request-id']).toBe('lb-1234.abc');
    expect((await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id <script>' } })).headers['x-request-id']).not.toBe('bad id <script>');
  });
});

describe('probes', () => {
  it('is ready when the database answers and every migration has been applied', async () => {
    const r = await app.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, migrations: expect.any(Number) });
  });

  it('serves metrics only with the metrics token', async () => {
    await app.inject({ method: 'GET', url: '/api/me', headers: h('admin') });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const m = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } });
    expect(m.statusCode).toBe(200);
    expect(m.body).toMatch(/http_requests_total\{method="GET",route="\/api\/me",status="2xx"\} \d+/);
    expect(m.body).toContain('http_request_duration_seconds_bucket{route="/api/me",le="+Inf"}');
    expect(m.body).toContain('db_pool_connections{state="total"}');
    // Route patterns, never ids, so the series stay few.
    expect(m.body).not.toMatch(/route="\/api\/[^"]*[0-9a-f]{8}-/);
  });

  it('has no metrics without a configured token', async () => {
    const plain = buildApp();
    expect((await plain.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    await plain.close();
  });
});

describe('rate limits', () => {
  it('refuses a user past their limit with Retry-After, without affecting another user', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: 'GET', url: '/api/me', headers: h('techA') })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: h('techA') });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.json().error).toMatchObject({ code: 'rate_limited', message: expect.stringMatching(/Too many requests/) });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: h('managerA') })).statusCode).toBe(200);
    const m = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } });
    expect(m.body).toMatch(/http_rate_limited_total\{limit="user"\} [1-9]/);
  });

  it('limits unauthenticated attempts per address, including bad tokens', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 2; i++) codes.push((await app.inject({ method: 'GET', url: '/api/me' })).statusCode);
    codes.push((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer guess-1' } })).statusCode);
    codes.push((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer guess-2' } })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]); // three failures a minute, then refused before any lookup
    // Probes are never limited.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('errors', () => {
  it('a server error names its request id so support can find the log line', async () => {
    const a = buildApp();
    a.get('/api/boom-test', async () => { throw new Error('boom'); });
    const r = await a.inject({ method: 'GET', url: '/api/boom-test', headers: h('admin') });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.requestId).toBe(r.headers['x-request-id']);
    expect(r.json().error.message).not.toContain('boom');
    await a.close();
  });
});
