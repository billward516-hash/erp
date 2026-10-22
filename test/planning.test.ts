import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { activateForecast, draftForecast, getForecast, getPlan, horizonMonths, saveScenario, saveWorkCenterCalendar, setForecastLines } from '../src/modules/planning/service.js';
import { createRevision, releaseRevision, saveRevision, saveWorkCenter } from '../src/modules/production/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World; let sup: Actor; let site: string;
const P: Record<string, string> = {};
let lathe: string; let customer: string;
const [m0, m1, m2] = horizonMonths(3);

beforeAll(async () => {
  w = await makeWorld('plan');
  site = w.facilities.A!;
  const u = await createUserWithToken(db(), w.tenantId, { email: `sup-${Date.now()}@pl.example`, displayName: 'Planner', roles: [{ role: 'production_supervisor', facility: site }] });
  sup = (await loadActor(w.tenantId, u.userId))!;
  await asActor(w.admin, async (tx) => {
    for (const [k, pn] of [['hsg', 'HSG-220'], ['bar', 'BAR-6061']]) P[k!] = (await createPart(tx, w.admin, { partNumber: pn!, description: pn!, uom: 'EA' })).id;
    const rm = await createLocation(tx, w.admin, { facilityId: site, code: 'RM', name: 'Raw' });
    await receive(tx, w.admin, { locationId: rm.id, partId: P.bar!, qty: 100, unitCost: 2 });
  });
  const asset = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site, assetTag: 'LATHE-1', name: 'Lathe' }));
  lathe = (await asActor(sup, (tx) => saveWorkCenter(tx, sup, { facilityId: site, code: 'LATHE', name: 'Turning', assetIds: [asset.id] }))).id;
  const rev = await asActor(sup, (tx) => createRevision(tx, sup, { partId: P.hsg! }));
  await asActor(sup, (tx) => saveRevision(tx, sup, rev.id, { materials: [{ partId: P.bar!, qtyPer: 1 }], operations: [{ opNo: 10, workCenterId: lathe, description: 'Turn', setupMinutes: 60, runMinutesPerUnit: 30 }] }));
  await asActor(sup, (tx) => releaseRevision(tx, sup, rev.id));
  customer = (await db().query(`INSERT INTO customer (tenant_id, code, name, kind) VALUES ($1, 'LAKE', 'Lakeshore Hydraulics', 'customer') RETURNING id`, [w.tenantId])).rows[0].id;
  const item = (await db().query(`INSERT INTO sales_item (tenant_id, code, description, part_id) VALUES ($1, 'HSG-220', 'Housing', $2) RETURNING id`, [w.tenantId, P.hsg])).rows[0].id;
  const so = (await db().query(`INSERT INTO sales_order (tenant_id, facility_id, number, customer_id, promised_date, created_by) VALUES ($1, $2, 'SO-1', $3, $4, $5) RETURNING id`,
    [w.tenantId, site, customer, `${m1}-15`, w.admin.userId])).rows[0].id;
  await db().query(`INSERT INTO sales_order_line (tenant_id, order_id, line_no, item_id, description, qty, unit_price) VALUES ($1, $2, 1, $3, 'Housing', 500, 40)`, [w.tenantId, so, item]);
});
afterAll(closePools);

describe('customer forecasts', () => {
  it('versions: a draft is edited, activated, and superseded by the next; active versions are frozen', async () => {
    const v1 = await asActor(sup, (tx) => draftForecast(tx, sup, { facilityId: site, customerId: customer }));
    await asActor(sup, (tx) => setForecastLines(tx, sup, v1.id, [{ partId: P.hsg!, month: m0!, qty: 200 }, { partId: P.hsg!, month: m1!, qty: 300 }]));
    await asActor(sup, (tx) => activateForecast(tx, sup, v1.id));
    await expect(asActor(sup, (tx) => setForecastLines(tx, sup, v1.id, [{ partId: P.hsg!, month: m0!, qty: 1 }]))).rejects.toThrow(/new version/);
    await expect(db().query('UPDATE customer_forecast_line SET qty = 1 WHERE forecast_id = $1', [v1.id])).rejects.toThrow(/cannot change/);
    // Version 2 comes in by import (wide: a column per month), lands in the draft, and shows what changed and where firm orders exceed it.
    const csv = Buffer.from(`Customer,Part,${m0},${m1},${m2}\nLAKE,HSG-220,200,450,600\nLAKE,NOPE-1,5,5,5\n`);
    const st = await stageImport(sup, { target: 'customer_forecasts', sourceSystem: 'edi-830', fileName: 'f.csv', content: csv, facilityId: site,
      mapping: { fields: { customer_code: { source: 'Customer' }, part_number: { source: 'Part' }, month: { source: 'Month' }, qty: { source: 'Qty' } },
        options: { unpivot: { allExcept: ['Customer', 'Part'], nameColumn: 'Month', valueColumn: 'Qty' } } } as any });
    expect(st.stats).toMatchObject({ total: 6, errors: 3 });
    await commitImport(sup, st.batchId, { allowPartial: true });
    const v2 = (await db().query(`SELECT id FROM customer_forecast WHERE customer_id = $1 AND version = 2`, [customer])).rows[0];
    const view = await asActor(sup, (tx) => getForecast(tx, sup, v2.id));
    expect(view).toMatchObject({ status: 'draft', previousVersion: 1, total: 1250, previousTotal: 500 });
    expect(view.rows[0].cells.map((c: any) => [c.month, c.qty, c.was, c.change, c.firm])).toEqual([[m0, 200, 200, 0, 0], [m1, 450, 300, 150, 500], [m2, 600, 0, 600, 0]]);
    expect(view.rows[0].cells[1].firmOver).toBe(true);
    await asActor(sup, (tx) => activateForecast(tx, sup, v2.id));
    expect((await db().query(`SELECT version, status FROM customer_forecast WHERE customer_id = $1 ORDER BY version`, [customer])).rows).toEqual([{ version: 1, status: 'superseded' }, { version: 2, status: 'active' }]);
  });
});

describe('the plan', () => {
  it('nets demand (firm consuming forecast), loads the lathe through the routing, and finds the material shortfall', async () => {
    const p = await asActor(sup, (tx) => getPlan(tx, sup, { facilityId: site, horizon: 3 }));
    // Month 1: firm 500 beats forecast 450.
    expect(p.demand.map((d: any) => [d.firm, d.forecast])).toEqual([[0, 200], [500, 0], [0, 600]]);
    expect(p.production[0]).toMatchObject({ partNumber: 'HSG-220', qty: [200, 500, 600] });
    const L = p.workCenters[0]!;
    // 1 machine, no calendar → 40 h/week assumed; no state history → 100%. Load: (60 + 200 × 30) / 60 = 101 h, etc.
    expect(L.cells.map((c: any) => c.required)).toEqual([101, 251, 301]);
    expect(p.assumptions).toEqual(expect.arrayContaining(['LATHE has no calendar; 40 hours a week assumed', 'LATHE: no machine state history; 100% availability assumed']));
    expect(p.materials[0]).toMatchObject({ partNumber: 'BAR-6061', available: 100, shortQty: 1200, needBy: new Date().toISOString().slice(0, 10) });
  });

  it('a calendar and a scenario change capacity; the report answers first', async () => {
    await expect(asActor(w.techA, (tx) => saveWorkCenterCalendar(tx, w.techA, lathe, { hoursPerWeek: 80, units: null }))).rejects.toThrow(/planning.manage/);
    await asActor(sup, (tx) => saveWorkCenterCalendar(tx, sup, lathe, { hoursPerWeek: 40, units: null }));
    const s = await asActor(sup, (tx) => saveScenario(tx, sup, { facilityId: site, name: 'Second shift', adjustments: [{ workCenterId: lathe, extraHoursPerWeek: 40 }], demandPct: -10 }));
    const p = await asActor(sup, (tx) => getPlan(tx, sup, { facilityId: site, horizon: 3, scenarioId: s.id }));
    // Forecast −10%: month 2 forecast 405 < firm 500 → still 500; month 3 → 540.
    expect(p.production[0]!.qty).toEqual([180, 500, 540]);
    expect(p.workCenters[0]!.hoursPerWeek).toBe(80);
    expect(p.base).toMatchObject({ materialsShort: 1 });
    const def = getReport('capacity-plan')!;
    const r = await asActor(sup, (tx) => def.run(tx, sup, def.params.parse({ facilityId: site, horizon: 3 })));
    expect(r.headline).toMatch(/^LATHE is loaded to \d+\.\d% in \w{3} \d{4}; \d+ work-center months? over capacity, 1 material short$/);
    expect(r.notes.join(' ')).toMatch(/no machine state history/);
  });
});
