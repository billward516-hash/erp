import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset } from '../src/modules/assets/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { intervalDaysFrom } from '../src/modules/imports/targets/production-setup.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** PM plan and routing imports (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('pmroute');
  await asActor(w.admin, async (tx) => {
    await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'CNC-1', name: 'CNC 1' });
    await createPart(tx, w.admin, { partNumber: 'HSG-100', description: 'Housing', uom: 'EA' });
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
async function load(target: string, text: string, expectErrors = 0) {
  const s = await call('POST', '/api/imports/stage', { target, sourceSystem: 'test', fileName: `${target}.csv`, facilityId: w.facilities.A, contentBase64: Buffer.from(text).toString('base64') });
  expect(s.statusCode, s.body).toBe(201);
  const b = s.json();
  expect(b.stats.errors, JSON.stringify(b.problems)).toBe(expectErrors);
  if (expectErrors) return b;
  const c = await call('POST', `/api/imports/${b.batchId}/commit`, {});
  expect(c.statusCode, c.body).toBe(200);
  return c.json();
}

describe('frequencies', () => {
  it('reads numbers and words as days', () => {
    expect(intervalDaysFrom('90')).toBe(90);
    expect(intervalDaysFrom('Monthly')).toBe(30);
    expect(intervalDaysFrom('every 6 months')).toBe(183);
    expect(intervalDaysFrom('2 weeks')).toBe(14);
    expect(intervalDaysFrom('annual')).toBe(365);
    expect(intervalDaysFrom('whenever')).toBeNull();
  });
});

describe('PM plans and routings', () => {
  it('PM plans continue the schedule from the last done date; meter plans need their interval', async () => {
    const bad = await load('pm_plans', 'Asset tag,Task,How often\nCNC-1,Lube,whenever\nNOPE,Lube,30\n', 2);
    expect(bad.problems.flatMap((p: any) => p.messages.map((m: any) => m.message)).join(' ')).toMatch(/cannot read "whenever"/);
    await load('pm_plans', 'Asset tag,Task,How often,Last done,Estimated hours\nCNC-1,Grease spindle,monthly,2026-10-01,1.5\nCNC-1,Replace coolant,every 6 months,2026-06-15,3\n');
    await load('pm_plans', 'Asset tag,Task,Meter,Meter interval\nCNC-1,Spindle service,hours,2000\n');
    const rows = (await getAdminPool().query(`SELECT title, trigger_type, interval_days, next_due_on::text AS due, meter, interval_meter::float AS im FROM pm_plan WHERE tenant_id = $1 ORDER BY title`, [w.tenantId])).rows;
    expect(rows).toEqual([
      { title: 'Grease spindle', trigger_type: 'calendar', interval_days: 30, due: '2026-10-31', meter: null, im: null },
      { title: 'Replace coolant', trigger_type: 'calendar', interval_days: 183, due: '2026-12-15', meter: null, im: null },
      { title: 'Spindle service', trigger_type: 'meter', interval_days: null, due: null, meter: 'hours', im: 2000 }]);
    const again = await load('pm_plans', 'Asset tag,Task,How often\nCNC-1,Grease spindle,monthly\n');
    expect(again.stats).toMatchObject({ created: 0 });
  });

  it('routings land on the part\'s draft revision beside the bill of material', async () => {
    await load('work_centers', 'Work center code,Name,Site code\nTURN,Turning,A\n');
    const bad = await load('routings', 'Part number,Operation number,Work center,Operation description\nHSG-100,10,MILL,Mill\n', 1);
    expect(bad.problems.flatMap((p: any) => p.messages.map((m: any) => m.message)).join(' ')).toMatch(/work center "MILL" not found/);
    await load('routings', 'Part number,Operation number,Work center,Operation description,Setup minutes,Run minutes per unit\nHSG-100,10,TURN,Turn outside,45,2.5\nHSG-100,20,TURN,Finish turn,15,1\n');
    const ops = (await getAdminPool().query(`SELECT o.op_no, o.setup_minutes::float AS setup, o.run_minutes_per_unit::float AS run, r.status FROM product_operation o JOIN product_revision r ON r.id = o.revision_id WHERE o.tenant_id = $1 ORDER BY o.op_no`, [w.tenantId])).rows;
    expect(ops).toEqual([{ op_no: 10, setup: 45, run: 2.5, status: 'draft' }, { op_no: 20, setup: 15, run: 1, status: 'draft' }]);
  });
});
