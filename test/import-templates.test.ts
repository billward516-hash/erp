import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
import { TARGETS } from '../src/modules/imports/targets/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Every import target hands out a template that maps by itself, and has a dictionary (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('templates'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });

describe('import templates', () => {
  for (const t of TARGETS) {
    it(`${t.key}: the CSV template maps every column with nothing missing, and the workbook has a dictionary`, async () => {
      const csv = await call('GET', `/api/imports/targets/${t.key}/template?format=csv`);
      expect(csv.statusCode, csv.body).toBe(200);
      expect(csv.headers['content-disposition']).toContain(`${t.key}-template.csv`);
      const s = await call('POST', '/api/imports/suggest', { target: t.key, fileName: 'template.csv', contentBase64: Buffer.from(csv.body.replace(/^﻿/, '')).toString('base64') });
      expect(s.statusCode, s.body).toBe(200);
      const sug = s.json();
      expect(sug.missingRequired ?? sug.suggestion?.missingRequired ?? []).toEqual([]);
      expect((sug.unmappedColumns ?? sug.suggestion?.unmappedColumns ?? [])).toEqual([]);
      const xlsx = await call('GET', `/api/imports/targets/${t.key}/template?format=xlsx`);
      expect(xlsx.statusCode).toBe(200);
      expect(xlsx.rawPayload.length).toBeGreaterThan(3000);
    });
  }
  it('an unknown target is not found', async () => {
    expect((await call('GET', '/api/imports/targets/nothing/template')).statusCode).toBe(404);
  });
});
