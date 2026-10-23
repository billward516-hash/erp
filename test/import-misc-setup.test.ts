import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset } from '../src/modules/assets/service.js';
import { createPart } from '../src/modules/parts/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Sales items, meters, expense categories, earning codes, timesheet history (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('miscimp');
  await asActor(w.admin, async (tx) => {
    await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'PRESS-1', name: 'Press 1' });
    await createPart(tx, w.admin, { partNumber: 'HSG-100', description: 'Housing', uom: 'EA' });
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
async function load(target: string, text: string, expectErrors = 0) {
  const s = await call('POST', '/api/imports/stage', { target, sourceSystem: 'misc', fileName: `${target}.csv`, facilityId: w.facilities.A, contentBase64: Buffer.from(text).toString('base64') });
  expect(s.statusCode, s.body).toBe(201);
  const b = s.json();
  expect(b.stats.errors, JSON.stringify(b.problems)).toBe(expectErrors);
  if (expectErrors) return b;
  const c = await call('POST', `/api/imports/${b.batchId}/commit`, {});
  expect(c.statusCode, c.body).toBe(200);
  return c.json();
}
const q = async (sql: string) => (await getAdminPool().query(sql.replace('$T', `'${w.tenantId}'`))).rows;
const problems = (b: any) => b.problems.flatMap((p: any) => p.messages.map((m: any) => m.message)).join(' ');

describe('misc imports', () => {
  it('sales items link to parts and update on reload', async () => {
    await load('sales_items', 'Item code,Description,Product or service,List price,Made as part number\nHSG-100,Housing,Product,42.5,HSG-100\nSVC-REP,Repair labor,Service,95,\n');
    await load('sales_items', 'Item code,Description,List price\nHSG-100,Housing machined,45\n');
    expect(await q(`SELECT code, kind, list_price::float AS price, part_id IS NOT NULL AS linked FROM sales_item WHERE tenant_id = $T ORDER BY code`)).toEqual([
      { code: 'HSG-100', kind: 'product', price: 45, linked: true }, { code: 'SVC-REP', kind: 'service', price: 95, linked: false }]);
    expect(problems(await load('sales_items', 'Item code,Description,Made as part number\nX,Y,NOPE\n', 1))).toMatch(/part "NOPE" not found/);
  });

  it('meter readings are applied oldest first and refuse a reading that goes down', async () => {
    await load('meter_readings', 'Asset tag,Meter,Reading,Read on\nPRESS-1,hours,1200,2026-03-01\nPRESS-1,hours,900,2026-01-01\nPRESS-1,hours,1500,2026-06-01\n', 0).catch(() => undefined);
    expect((await q(`SELECT value::float AS v FROM asset_meter_reading WHERE tenant_id = $T AND meter = 'hours' ORDER BY read_at`)).map((r) => r.v)).toEqual([900, 1200, 1500]);
    expect(problems(await load('meter_readings', 'Asset tag,Meter,Reading,Read on\nPRESS-1,hours,1000,2026-09-01\n', 1))).toMatch(/lower than the earlier reading 1500/);
  });

  it('expense categories and earning codes load with their limits and payroll codes', async () => {
    await load('expense_categories', 'Category code,Name,Limit per item,Limit per day,Receipt required over\nmeals,Meals,60,90,25\nMILES,Mileage,,,\n');
    expect(problems(await load('expense_categories', 'Category code,Name,Limit per item,Limit per day\nX,Bad,100,50\n', 1))).toMatch(/per-item limit is above/);
    expect((await q(`SELECT code, limit_per_item::float AS item FROM expense_category WHERE tenant_id = $T AND code IN ('MEALS','MILES') ORDER BY code`))).toEqual([{ code: 'MEALS', item: 60 }, { code: 'MILES', item: null }]);
    await load('earning_codes', 'Code,Name,Kind,Payroll provider\'s code\nDT,Double time,Regular,0300\nOT,Overtime renamed,Worked,0200\n');
    expect((await q(`SELECT code, kind, external_code FROM earning_code WHERE tenant_id = $T AND code IN ('DT','OT') ORDER BY code`))).toEqual([{ code: 'DT', kind: 'worked', external_code: '0300' }, { code: 'OT', kind: 'worked', external_code: '0200' }]);
  });

  it('timesheet history arrives frozen as exported and is not added twice', async () => {
    await getAdminPool().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, status) VALUES ($1, $2, 'E7', 'Tess', 'Hours', 'active')`, [w.tenantId, w.facilities.A]);
    const csv = 'Employee number,Date,Earning code,Hours\nE7,2025-03-03,REG,8\nE7,2025-03-04,REG,8\nE7,2025-03-04,OT,2\nE7,2025-03-11,REG,8\n';
    const r = await load('timesheet_history', csv);
    expect(r.stats).toMatchObject({ created: 4 });
    expect(await q(`SELECT week_start::text AS w, status, (SELECT sum(hours)::float FROM time_entry e WHERE e.timesheet_id = t.id) AS hours FROM timesheet t WHERE tenant_id = $T ORDER BY week_start`)).toEqual([
      { w: '2025-03-03', status: 'exported', hours: 18 }, { w: '2025-03-10', status: 'exported', hours: 8 }]);
    expect((await load('timesheet_history', csv)).stats).toMatchObject({ created: 0, unchanged: 4 });
    expect(problems(await load('timesheet_history', 'Employee number,Date,Earning code,Hours\nE7,2025-03-05,XYZ,8\n', 1))).toMatch(/earning code "XYZ" not found/);
  });
});
