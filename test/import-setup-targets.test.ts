import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset } from '../src/modules/assets/service.js';
import { setupBooks } from '../src/modules/books/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Setup imports: departments, storerooms, work centers, chart of accounts (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('setupimp'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
async function load(target: string, text: string, expectErrors = 0) {
  const s = await call('POST', '/api/imports/stage', { target, sourceSystem: 'test', fileName: `${target}.csv`, contentBase64: Buffer.from(text).toString('base64') });
  expect(s.statusCode, s.body).toBe(201);
  const batch = s.json();
  expect(batch.stats.errors, JSON.stringify(batch.problems)).toBe(expectErrors);
  if (expectErrors) return batch;
  const c = await call('POST', `/api/imports/${batch.batchId}/commit`, {});
  expect(c.statusCode, c.body).toBe(200);
  return c.json();
}

describe('setup imports', () => {
  it('departments: created, then updated on a second load', async () => {
    const r = await load('departments', 'Department code,Name,Site code\nMNT,Maintenance,A\nPRD,Production,\n');
    expect(r.stats).toMatchObject({ created: 2 });
    const again = await load('departments', 'Department code,Name\nMNT,Plant maintenance\n');
    expect(again.stats).toMatchObject({ created: 0, updated: 1 });
    const rows = (await getAdminPool().query('SELECT code, name, facility_id FROM department WHERE tenant_id = $1 ORDER BY code', [w.tenantId])).rows;
    expect(rows).toEqual([expect.objectContaining({ code: 'MNT', name: 'Plant maintenance', facility_id: w.facilities.A }), expect.objectContaining({ code: 'PRD', facility_id: null })]);
    const dup = await load('departments', 'Department code,Name\nX1,One\nx1,Two\n', 1);
    expect(dup.problems[0].messages[0].message).toMatch(/duplicate department code/);
  });

  it('storerooms need a site; the name is updated on reload', async () => {
    await load('stock_locations', 'Storeroom code,Name,Site code\nMRO,Maintenance crib,A\nRAW,Raw material,B\n');
    const bad = await load('stock_locations', 'Storeroom code,Name,Site code\nZZ,Nowhere,NOPE\n', 1);
    expect(bad.problems[0].messages[0].message).toMatch(/unknown facility/);
    await load('stock_locations', 'Storeroom code,Name,Site code\nMRO,MRO crib,A\n');
    const r = (await getAdminPool().query(`SELECT name FROM stock_location WHERE tenant_id = $1 AND code = 'MRO'`, [w.tenantId])).rows[0];
    expect(r.name).toBe('MRO crib');
  });

  it('work centers link machines by asset tag and carry their calendar', async () => {
    await asActor(w.admin, async (tx) => { await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'LTH-1', name: 'Lathe 1' }); await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'LTH-2', name: 'Lathe 2' }); });
    const bad = await load('work_centers', 'Work center code,Name,Site code,Machines (asset tags)\nTURN,Turning,A,LTH-1;NOPE\n', 1);
    expect(bad.problems[0].messages[0].message).toMatch(/machine "NOPE" not found/);
    await load('work_centers', 'Work center code,Name,Site code,Machines (asset tags),Scheduled hours a week,Machines or crews\nTURN,Turning,A,LTH-1;LTH-2,80,2\n');
    const wc = (await getAdminPool().query(`SELECT w.hours_per_week::float AS h, w.units, (SELECT count(*)::int FROM work_center_asset a WHERE a.work_center_id = w.id) AS machines FROM work_center w WHERE w.tenant_id = $1 AND w.code = 'TURN'`, [w.tenantId])).rows[0];
    expect(wc).toEqual({ h: 80, units: 2, machines: 2 });
  });

  it('chart of accounts adds to the starter chart once the books are set up, and works out detail types', async () => {
    const early = await load('chart_of_accounts', 'Account number,Account name,Type\n1500,Machinery,Asset\n', 1);
    expect(early.problems[0].messages[0].message).toMatch(/set the books up first/);
    await asActor(w.admin, (tx) => setupBooks(tx, w.admin, { startDate: '2026-01-01', openingBalance: 0 }));
    await load('chart_of_accounts', 'Account number,Account name,Type\n1550,Shop machinery,Asset\n2150,Equipment loan,Liability\n4900,Scrap sales,Revenue\n5900,Freight in,Cost of sales\n');
    const rows = (await getAdminPool().query(`SELECT code, type, subtype FROM ledger_account WHERE tenant_id = $1 AND code IN ('1550','2150','4900','5900') ORDER BY code`, [w.tenantId])).rows;
    expect(rows).toEqual([{ code: '1550', type: 'asset', subtype: 'fixed_asset' }, { code: '2150', type: 'liability', subtype: 'long_term_liability' },
      { code: '4900', type: 'income', subtype: 'income' }, { code: '5900', type: 'expense', subtype: 'cost_of_goods' }]);
    const sys = await load('chart_of_accounts', 'Account number,Account name,Type\n1100,Receivables,Liability\n', 1);
    expect(sys.problems[0].messages[0].message).toMatch(/system account/);
  });
});
