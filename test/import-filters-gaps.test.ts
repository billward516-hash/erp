import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
import { rowMatchesFilter } from '../src/modules/imports/mapping/spec.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Row filters and the missing-references check (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('filters'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('row filters', () => {
  it('match case-insensitively on equals, contains, lists and blanks', () => {
    const row = { Status: ' Inactive ', Code: 'TEST-9', Note: '' };
    expect(rowMatchesFilter(row, { column: 'Status', is: 'equals', value: 'inactive' })).toBe(true);
    expect(rowMatchesFilter(row, { column: 'Status', is: 'in', value: 'obsolete; inactive' })).toBe(true);
    expect(rowMatchesFilter(row, { column: 'Code', is: 'contains', value: 'test' })).toBe(true);
    expect(rowMatchesFilter(row, { column: 'Code', is: 'matches', value: '^test-\\d$' })).toBe(true);
    expect(rowMatchesFilter(row, { column: 'Note', is: 'blank' })).toBe(true);
    expect(rowMatchesFilter(row, { column: 'Status', is: 'not_equals', value: 'inactive' })).toBe(false);
  });

  it('rows matching a filter are left out and counted; the mapping keeps the filter for the next file', async () => {
    const csv = 'Code,Name,Status\nS1,Alpha,Active\nS2,Beta,Inactive\nS3,Gamma,Active\n';
    const sug = (await call('POST', '/api/imports/suggest', { target: 'suppliers', fileName: 's.csv', contentBase64: b64(csv) })).json();
    const mapping = { ...sug.mapping, options: { ...sug.mapping.options, skipRows: [{ column: 'Status', is: 'equals', value: 'inactive' }] } };
    const st = await call('POST', '/api/imports/stage', { target: 'suppliers', sourceSystem: 'filters', fileName: 's.csv', contentBase64: b64(csv), mapping });
    expect(st.statusCode, st.body).toBe(201);
    expect(st.json().stats).toMatchObject({ total: 3, toCreate: 2, skippedByFilter: 1, skippedBlank: 0 });
    const bad = await call('POST', '/api/imports/stage', { target: 'suppliers', sourceSystem: 'filters', fileName: 's.csv', contentBase64: b64(csv), mapping: { ...mapping, options: { ...mapping.options, skipRows: [{ column: 'Status', is: 'equals' }] } } });
    expect(bad.statusCode).toBe(422);
  });
});

describe('missing references', () => {
  it('are summarised per field with the values that are missing and how many rows name them', async () => {
    const csv = 'Supplier code,Part number,Quantity ordered,Unit price,PO number\nNOPE,P1,1,1,A\nNOPE,P2,1,1,B\nNOPE,P1,1,1,C\nOTHER,P3,1,1,D\n';
    const st = await call('POST', '/api/imports/stage', { target: 'open_purchase_orders', sourceSystem: 'gaps', fileName: 'po.csv', facilityId: w.facilities.A, contentBase64: b64(csv) });
    expect(st.statusCode, st.body).toBe(201);
    const gaps = st.json().gaps as any[];
    const sup = gaps.find((g) => g.field === 'supplier_code');
    expect(sup).toMatchObject({ rows: 4, distinct: 2, label: 'Supplier code' });
    expect(sup.examples[0]).toEqual({ value: 'NOPE', rows: 3 });
    expect(gaps.find((g) => g.field === 'part_number')).toMatchObject({ distinct: 3 });
  });
});
