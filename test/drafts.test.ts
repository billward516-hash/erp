import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { runRetention } from '../src/modules/retention/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Unsaved form entries kept on the server (D-164). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('drafts'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe('form drafts', () => {
  it('are private to their author, listed by page, replaced on save and removed on discard', async () => {
    const key = encodeURIComponent('/capa/new#0');
    expect((await call(w.tokens.qualityA, 'PUT', `/api/drafts/${key}`, { path: '/capa/new', label: 'Open a CAPA', data: { 'capa-title-m': 'Coolant drift' } })).statusCode).toBe(200);
    expect((await call(w.tokens.qualityA, 'PUT', `/api/drafts/${key}`, { path: '/capa/new', label: 'Open a CAPA', data: { 'capa-title-m': 'Coolant drift on Cell 1' } })).statusCode).toBe(200);
    await call(w.tokens.qualityA, 'PUT', `/api/drafts/${encodeURIComponent('/expenses/new#0')}`, { path: '/expenses/new', data: { purpose: 'Trip' } });
    const mine = (await call(w.tokens.qualityA, 'GET', '/api/drafts?path=/capa/new')).json();
    expect(mine).toEqual([expect.objectContaining({ key: '/capa/new#0', label: 'Open a CAPA', data: { 'capa-title-m': 'Coolant drift on Cell 1' } })]);
    expect((await call(w.tokens.qualityA, 'GET', '/api/drafts')).json()).toHaveLength(2);
    // Nobody else sees them, not even an administrator.
    expect((await call(w.tokens.admin, 'GET', '/api/drafts')).json()).toEqual([]);
    expect((await call(w.tokens.qualityA, 'DELETE', `/api/drafts/${key}`)).statusCode).toBe(204);
    expect((await call(w.tokens.qualityA, 'GET', '/api/drafts?path=/capa/new')).json()).toEqual([]);
  });

  it('refuse a page that is not a path and a draft over 256 KB', async () => {
    expect((await call(w.tokens.techA, 'PUT', '/api/drafts/x', { path: 'https://elsewhere.example', data: {} })).statusCode).toBe(422);
    const big = (await call(w.tokens.techA, 'PUT', '/api/drafts/big', { path: '/notes', data: { text: 'x'.repeat(300_000) } }));
    expect(big.statusCode).toBeGreaterThanOrEqual(400);
    expect(big.statusCode).toBeLessThan(500);
  });

  it('are swept by retention once untouched for the company\'s period (90 days by default)', async () => {
    await call(w.tokens.techA, 'PUT', '/api/drafts/old', { path: '/work-orders', data: { a: 1 } });
    await call(w.tokens.techA, 'PUT', '/api/drafts/fresh', { path: '/work-orders', data: { a: 2 } });
    await getAdminPool().query(`UPDATE form_draft SET updated_at = now() - interval '91 days' WHERE tenant_id = $1 AND key = 'old'`, [w.tenantId]);
    const removed = await runRetention(w.tenantId);
    expect(removed.form_drafts).toBe(1);
    expect((await call(w.tokens.techA, 'GET', '/api/drafts')).json().map((d: any) => d.key)).toEqual(['fresh']);
  });
});
