import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createAsset } from '../src/modules/assets/service.js';
import { assignTechnician, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

let app: FastifyInstance; let w: World; let wo: string;
const auth = (token: string, key?: string) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
const laborCount = async () => (await getAdminPool().query('SELECT count(*)::int AS n FROM work_order_labor WHERE work_order_id = $1', [wo])).rows[0].n;

beforeAll(async () => {
  app = buildApp({ blobs: new LocalBlobStore('./.storage/test') });
  w = await makeWorld('idem');
  await asActor(w.managerA, async (tx) => {
    const a = await createAsset(tx, w.managerA, { facilityId: w.facilities.A!, assetTag: 'P-1', name: 'Pump' });
    wo = (await createWorkOrder(tx, w.managerA, { assetId: a.id, title: 'Seal leak' })).id;
    await assignTechnician(tx, w.managerA, wo, w.techAEmployeeId);
  });
  await asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo, { to: 'in_progress' }));
});
afterAll(async () => { await app.close(); await closePools(); });

describe('Idempotency-Key', () => {
  it('a replayed request is answered from the first response and posts nothing twice', async () => {
    const body = { workDate: new Date().toISOString().slice(0, 10), hours: 1.5, note: 'Replaced seal' };
    const first = await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/labor`, headers: auth(w.tokens.techA!, 'offline-0001-abcd'), payload: body });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/labor`, headers: auth(w.tokens.techA!, 'offline-0001-abcd'), payload: body });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await laborCount()).toBe(1);
    // Keys are per user: another user's identical key is a different request.
    const other = await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/labor`, headers: auth(w.tokens.managerA!, 'offline-0001-abcd'), payload: { ...body, employeeId: w.techAEmployeeId } });
    expect(other.headers['idempotent-replay']).toBeUndefined();
    expect(await laborCount()).toBe(2);
  });

  it('refuses a key reused for another request, does not store failures, and leaves keyless requests alone', async () => {
    const reused = await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/parts`, headers: auth(w.tokens.techA!, 'offline-0001-abcd'), payload: {} });
    expect(reused.statusCode).toBe(422);
    const bad = await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/labor`, headers: auth(w.tokens.techA!, 'offline-0002-abcd'), payload: { workDate: 'x', hours: 1 } });
    expect(bad.statusCode).toBe(422);
    const fixed = await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/labor`, headers: auth(w.tokens.techA!, 'offline-0002-abcd'), payload: { workDate: new Date().toISOString().slice(0, 10), hours: 1 } });
    expect(fixed.statusCode).toBe(201);
    const before = await laborCount();
    for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/labor`, headers: auth(w.tokens.techA!), payload: { workDate: new Date().toISOString().slice(0, 10), hours: 0.5 } });
    expect(await laborCount()).toBe(before + 2);
    const short = await app.inject({ method: 'POST', url: `/api/work-orders/${wo}/labor`, headers: auth(w.tokens.techA!, 'short'), payload: {} });
    expect(short.statusCode).toBe(400);
  });
});
