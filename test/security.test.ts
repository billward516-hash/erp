import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
import { safeFileName } from '../src/platform/http/helpers.js';
import { assertProductionConfig } from '../src/platform/config-check.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Security self-review checks that stay as regression tests. */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('sec'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as any });

describe('authentication is structural', () => {
  it('every /api route refuses a missing, malformed or wrong token, including encoded paths', async () => {
    for (const url of ['/api/me', '/api/assets', '/api/quotes', '/api/service-visits', '/api/change-notices', '/%61pi/me', '/api/%6De', '/api/fit-interview', '/api/scan/resolve?code=x']) {
      expect((await call(undefined, 'GET', url)).statusCode, url).toBe(401);
      expect((await call('not-a-real-token', 'GET', url)).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Basic abc' } })).statusCode).toBe(401);
  });
  it('only health, ready, sign-in and the public request form are reachable without a token; metrics need their own token', async () => {
    expect((await call(undefined, 'GET', '/health')).statusCode).toBe(200);
    expect((await call(undefined, 'GET', '/metrics')).statusCode).not.toBe(200);
    expect((await call(undefined, 'GET', '/public/requests/not-a-token')).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('responses carry the protective headers', () => {
  it('sets nosniff, a content-security-policy and a request id on every response', async () => {
    const r = await call(w.tokens.admin, 'GET', '/api/me');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toMatch(/default-src 'self'/);
    expect(r.headers['x-request-id']).toBeTruthy();
    const bad = await call(undefined, 'GET', '/api/me');
    expect(bad.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('uploaded files are served as untrusted', () => {
  it('file names cannot break out of the header', () => {
    expect(safeFileName('a"b\r\nSet-Cookie: x=1.pdf')).not.toMatch(/["\r\n]/);
    expect(safeFileName('../../etc/passwd')).not.toContain('/');
    expect(safeFileName('Ünïcode résumé.pdf')).toMatch(/^[\x20-\x7e]+$/);
    expect(safeFileName('')).toBe('file');
  });
  it('an uploaded HTML or SVG file is only ever a sandboxed download', async () => {
    for (const [mime, name] of [['text/html', 'x.html'], ['image/svg+xml', 'x.svg']] as const) {
      const d = (await call(w.tokens.admin, 'POST', '/api/documents', { title: `Evil ${name}`, docType: 'other', facilityId: w.facilities.A })).json();
      const up = await app.inject({ method: 'POST', url: `/api/documents/${d.id}/versions?versionLabel=${mime === 'text/html' ? 'A' : 'B'}&fileName=${name}&mimeType=${encodeURIComponent(mime)}&changeSummary=test`,
        headers: { authorization: `Bearer ${w.tokens.admin}`, 'content-type': mime }, payload: '<script>alert(1)</script>' });
      expect(up.statusCode, up.body).toBeLessThan(300);
      const id = up.json().id;
      const dl = await call(w.tokens.admin, 'GET', `/api/document-versions/${id}/download`);
      expect(dl.headers['content-type']).toBe('application/octet-stream');
      expect(String(dl.headers['content-disposition'])).toMatch(/^attachment;/);
      expect(String(dl.headers['content-security-policy'])).toMatch(/sandbox/);
    }
  });
});

describe('production configuration is checked at start', () => {
  const good = { NODE_ENV: 'production', DATABASE_URL: 'postgres://app:S3cure-long-secret@db.internal:5432/erp', DATABASE_ADMIN_URL: 'postgres://owner:Another-long-secret@db.internal:5432/erp', APP_BASE_URL: 'https://erp.example.com', SSO_SECRET_KEY: 'k'.repeat(32), STORAGE_DIR: '/data/blobs', TRUST_PROXY: '1', METRICS_TOKEN: 'm'.repeat(24) };
  it('accepts a complete configuration', () => { expect(assertProductionConfig(good)).toEqual({ problems: [], warnings: [] }); });
  it('refuses development defaults, plain-http base URLs and missing secrets', () => {
    const bad = assertProductionConfig({ NODE_ENV: 'production' });
    expect(bad.problems.join(' ')).toMatch(/DATABASE_URL/); expect(bad.problems.join(' ')).toMatch(/DATABASE_ADMIN_URL/); expect(bad.problems.join(' ')).toMatch(/APP_BASE_URL/); expect(bad.problems.join(' ')).toMatch(/SSO_SECRET_KEY/);
    expect(assertProductionConfig({ ...good, DATABASE_URL: 'postgres://erp_app:erp_app_dev@localhost:54329/erp' }).problems.join(' ')).toMatch(/development password/);
    expect(assertProductionConfig({ ...good, APP_BASE_URL: 'http://erp.example.com' }).problems.join(' ')).toMatch(/https/);
    expect(assertProductionConfig({ ...good, TRUST_PROXY: undefined }).warnings.join(' ')).toMatch(/TRUST_PROXY/);
  });
  it('does nothing outside production', () => { expect(assertProductionConfig({ NODE_ENV: 'development' }).problems).toEqual([]); });
});
