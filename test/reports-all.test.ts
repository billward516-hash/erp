import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
import { REPORTS } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/**
 * Every report in the catalogue opens for an administrator and renders as screen data, CSV, PDF and XLSX, even for a
 * company with little data (the empty-data path of each report).
 */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('allreports'); });
afterAll(async () => { await app.close(); await closePools(); });

describe('every report', () => {
  for (const r of REPORTS) {
    it(`${r.id}: data, CSV, PDF and XLSX`, async () => {
      const h = { authorization: `Bearer ${w.tokens.admin}` };
      const json = await app.inject({ url: `/api/reports/${r.id}`, headers: h });
      expect(json.statusCode, json.body.slice(0, 300)).toBe(200);
      const body = json.json();
      expect(typeof body.headline).toBe('string');
      expect(Array.isArray(body.columns) && Array.isArray(body.rows)).toBe(true);
      const csv = await app.inject({ url: `/api/reports/${r.id}?format=csv`, headers: h });
      expect(csv.statusCode).toBe(200);
      const pdf = await app.inject({ url: `/api/reports/${r.id}?format=pdf`, headers: h });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      const xlsx = await app.inject({ url: `/api/reports/${r.id}?format=xlsx`, headers: h });
      expect(xlsx.statusCode).toBe(200);
      expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    });
  }
});
