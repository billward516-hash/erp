import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { activateForecast, createPlannedOrders, draftForecast, getForecast, getPlan, horizonMonths, requestPlanShortages, saveScenario, saveWorkCenterCalendar, setForecastLines } from '../src/modules/planning/service.js';
import { createPlan } from '../src/modules/pm/service.js';
import { createQualification, grantQualification, setAssetRequirement } from '../src/modules/learning/qualifications.js';
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

describe('acting on the plan', () => {
  it('drafts one purchase request for the shortfall, and asking again finds nothing left to request', async () => {
    const r = await asActor(sup, (tx) => requestPlanShortages(tx, sup, { facilityId: site, horizon: 3 }));
    const lines = (await db().query('SELECT part_id, qty::float AS qty FROM purchase_request_line WHERE request_id = $1', [r.id])).rows;
    expect(lines).toEqual([{ part_id: P.bar, qty: 1200 }]);
    expect(r).toMatchObject({ status: 'draft', needed_by: expect.anything() });
    const p = await asActor(sup, (tx) => getPlan(tx, sup, { facilityId: site, horizon: 3 }));
    expect(p.materials[0]).toMatchObject({ shortQty: 1200, requested: 1200, toRequest: 0 });
    await expect(asActor(sup, (tx) => requestPlanShortages(tx, sup, { facilityId: site, horizon: 3 }))).rejects.toThrow(/nothing to request/);
  });

  it('creates planned production orders the plan then nets; their materials stay in the material plan', async () => {
    await expect(asActor(w.techA, (tx) => createPlannedOrders(tx, w.techA, { facilityId: site, horizon: 3 }))).rejects.toThrow(/planning.manage/);
    const made = await asActor(sup, (tx) => createPlannedOrders(tx, sup, { facilityId: site, horizon: 3, lines: [{ partId: P.hsg!, month: m0! }] }));
    expect(made).toEqual([expect.objectContaining({ partNumber: 'HSG-220', qty: 200, dueDate: new Date().toISOString().slice(0, 10) })]);
    const p = await asActor(sup, (tx) => getPlan(tx, sup, { facilityId: site, horizon: 3 }));
    expect(p.production[0]!.qty).toEqual([0, 500, 600]);
    // The planned order's 200 bars are still needed: the shortfall is unchanged.
    expect(p.materials[0]).toMatchObject({ required: [200, 500, 600], shortQty: 1200 });
    // Its load is now committed rather than planned.
    expect(p.workCenters[0]!.cells[0]).toMatchObject({ committed: 101, firm: 0, forecast: 0 });
    await expect(asActor(sup, (tx) => createPlannedOrders(tx, sup, { facilityId: site, horizon: 3, lines: [{ partId: P.hsg!, month: m0! }] }))).rejects.toThrow(/nothing to create/);
  });

  it('preventive maintenance on the lathe comes off its capacity', async () => {
    const asset = (await db().query(`SELECT asset_id FROM work_center_asset WHERE work_center_id = $1`, [lathe])).rows[0].asset_id;
    await asActor(w.admin, (tx) => createPlan(tx, w.admin, { assetId: asset, code: `PM-LATHE-${Date.now()}`, title: 'Lathe service', triggerType: 'calendar', intervalDays: 365, firstDueOn: `${m1}-10`, estimatedHours: 8 }));
    await asActor(w.admin, (tx) => createPlan(tx, w.admin, { assetId: asset, code: `PM-LUBE-${Date.now()}`, title: 'Lube', triggerType: 'calendar', intervalDays: 365, firstDueOn: `${m1}-12` }));
    const p = await asActor(sup, (tx) => getPlan(tx, sup, { facilityId: site, horizon: 3 }));
    const c = p.workCenters[0]!.cells[1]!;
    expect(c).toMatchObject({ maintenance: 8 });
    expect(c.capacity).toBeCloseTo(c.scheduled - 8, 1);
    expect(p.assumptions.join(' ')).toMatch(/PM-LUBE-\d+ has no estimated hours/);
  });
});

describe('qualified labor', () => {
  it('a lathe that needs a qualification is checked against the people who hold it', async () => {
    const asset = (await db().query(`SELECT asset_id FROM work_center_asset WHERE work_center_id = $1`, [lathe])).rows[0].asset_id;
    const p0 = await asActor(sup, (tx) => getPlan(tx, sup, { facilityId: site, horizon: 3 }));
    expect(p0.labor).toBeNull();
    await asActor(w.admin, async (tx) => {
      const q = await createQualification(tx, w.admin, { code: `TURN-${Date.now()}`, name: 'CNC turning operator' });
      await setAssetRequirement(tx, w.admin, asset, q.id, 'operate');
      await grantQualification(tx, w.admin, w.techAEmployeeId, q.id, { note: 'test' });
    });
    await asActor(sup, (tx) => saveWorkCenterCalendar(tx, sup, lathe, { hoursPerWeek: 40, units: null, laborRatio: 0.5 }));
    const p = await asActor(sup, (tx) => getPlan(tx, sup, { facilityId: site, horizon: 3 }));
    const L = p.labor!.workCenters[0]!;
    expect(L).toMatchObject({ code: 'LATHE', qualifiedNow: 1, singlePoint: true, laborRatio: 0.5 });
    const days = Number(new Date(Date.UTC(Number(m0!.slice(0, 4)), Number(m0!.slice(5, 7)), 0)).getUTCDate());
    expect(L.cells[0]!.available).toBeCloseTo(40 * days / 7, 1);
    expect(L.cells[0]!.required).toBeCloseTo(p.workCenters[0]!.cells[0]!.required * 0.5, 1);
    expect(p.assumptions.join(' ')).toMatch(/40 hours a week assumed for people with fewer than 4 approved timesheets/);
  });
});
