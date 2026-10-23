import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset } from '../src/modules/assets/service.js';
import { assetCostHistory, assetLifecycle, crf, repairOrReplace } from '../src/modules/assets/lifecycle.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
const years = [{ year: 2023, maintenance: 10000, downtimeHours: 10 }, { year: 2024, maintenance: 14000, downtimeHours: 20 }, { year: 2025, maintenance: 18000, downtimeHours: 30 },
  { year: 2026, maintenance: 99999, downtimeHours: 99 }];
const base = { today: '2026-10-22', commissionedOn: '2014-03-01', expectedLifeYears: 10, downtimeCostPerHour: 200, years, discountRate: 0.08 };

describe('repair or replace (hand-computed)', () => {
  it('capital recovery factor', () => {
    expect(crf(0.08, 10)).toBeCloseTo(0.149029, 6);
    expect(crf(0, 10)).toBe(0.1);
  });
  it('replaces when keeping it costs more this year than a new one costs a year', () => {
    // Totals 12,000 / 18,000 / 24,000 (downtime at 200/h); the partial current year is left out. Trend +6,000 a year → 30,000 in 2026.
    // New: 100,000 × 0.149029 + 2% upkeep 2,000 = 16,903.
    const r = repairOrReplace({ ...base, replacementCost: 100000 });
    expect(r).toMatchObject({ verdict: 'replace', keepNext: 30000, replaceEac: 16903, slope: 6000, crossover: 2026 });
    expect(r.rows.map((x) => x.total)).toEqual([12000, 18000, 24000]);
    expect(r.notes).toContain('The asset is 12.6 years old, past the 10-year expected life of a new one');
  });
  it('keeps, and names the year replacing starts to pay', () => {
    // New: 300,000 × 0.149029 + 6,000 = 50,709. Trend 18,000 + 6,000 × (year − 2024) passes it in 2030.
    const r = repairOrReplace({ ...base, replacementCost: 300000 });
    expect(r).toMatchObject({ verdict: 'keep', replaceEac: 50709, crossover: 2030 });
  });
  it('never trends below the last two years, and says what it lacks', () => {
    const falling = repairOrReplace({ ...base, replacementCost: 100000, downtimeCostPerHour: null, years: [{ year: 2024, maintenance: 30000, downtimeHours: 5 }, { year: 2025, maintenance: 10000, downtimeHours: 5 }] });
    expect(falling).toMatchObject({ keepNext: 20000 }); // the line says −10,000; the floor is the average 20,000
    expect(falling.notes).toEqual(expect.arrayContaining(['No downtime cost per hour on the asset: downtime is shown but not priced', 'Only two full years of history: the trend is a straight line through two points']));
    expect(repairOrReplace({ ...base, replacementCost: null }).verdict).toBe('unknown');
    expect(repairOrReplace({ ...base, replacementCost: 1, years: [years[2]!] })).toMatchObject({ verdict: 'unknown', reason: '1 full year of cost history; at least 2 are needed' });
  });
});

describe('cost history from the records', () => {
  let w: World; let press: string; let motor: string;
  beforeAll(async () => {
    w = await makeWorld('life');
    await asActor(w.admin, async (tx) => {
      press = (await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'PR-7', name: 'Press', commissionedOn: '2012-01-01', replacementCost: 100000, expectedLifeYears: 10, downtimeCostPerHour: 200 } as any)).id;
      motor = (await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'PR-7-M', name: 'Main motor', parentAssetId: press, assetClass: 'component' })).id;
    });
    let n = 0;
    const wo = async (asset: string, completed: string, status = 'closed', legacy: number | null = null) => (await db().query(`INSERT INTO work_order (tenant_id, facility_id, number, asset_id, title, status, completed_at, legacy_cost, created_by)
      VALUES ($1, $2, $3, $4, 'Repair', $5, $6, $7, $8) RETURNING id`, [w.tenantId, w.facilities.A, `LC-${++n}`, asset, status, completed, legacy, w.admin.userId])).rows[0].id;
    const emp = w.techAEmployeeId;
    // 2024: 10 h at 60 + 10 h without a rate (default 45) on the press; a 2,000 legacy job on the motor; 5 h of downtime.
    const a = await wo(press, '2024-03-10T12:00:00Z');
    await db().query(`INSERT INTO work_order_labor (tenant_id, work_order_id, employee_id, work_date, hours, hourly_rate, recorded_by) VALUES ($1, $2, $3, '2024-03-10', 10, 60, $4), ($1, $2, $3, '2024-03-11', 10, NULL, $4)`, [w.tenantId, a, emp, w.admin.userId]);
    await wo(motor, '2024-09-01T12:00:00Z', 'closed', 2000);
    // 2025: parts 3 × 400 on the press; an open work order (not counted); 12 h of downtime on the motor.
    const b = await wo(press, '2025-05-05T12:00:00Z');
    const part = (await db().query(`INSERT INTO part (tenant_id, part_number, description, uom, unit_cost) VALUES ($1, 'BRG-X', 'Bearing', 'EA', 400) RETURNING id`, [w.tenantId])).rows[0].id;
    await db().query(`INSERT INTO work_order_part (tenant_id, work_order_id, part_id, qty_planned, qty_used, unit_cost) VALUES ($1, $2, $3, 3, 3, 400)`, [w.tenantId, b, part]);
    await wo(press, '2025-06-01T12:00:00Z', 'in_progress', 50000);
    for (const [asset, start, hours] of [[press, '2024-04-01T08:00:00Z', 5], [motor, '2025-02-01T08:00:00Z', 12]] as const) {
      const s = new Date(start);
      await db().query(`INSERT INTO asset_state_event (tenant_id, facility_id, asset_id, state, started_at, ended_at, recorded_by) VALUES ($1, $2, $3, 'unplanned_downtime', $4, $5, $6)`,
        [w.tenantId, w.facilities.A, asset, s, new Date(s.getTime() + hours * 3_600_000), w.admin.userId]);
    }
  });
  afterAll(closePools);

  it('adds labor, parts, imported costs and downtime for the asset and its components, completed work only', async () => {
    const h = await asActor(w.admin, (tx) => assetCostHistory(tx, press));
    expect(h).toEqual([
      { year: 2024, labor: 1050, parts: 0, vendors: 0, legacy: 2000, unrated: 1, maintenance: 3050, downtimeHours: 5 },
      { year: 2025, labor: 0, parts: 1200, vendors: 0, legacy: 0, unrated: 0, maintenance: 1200, downtimeHours: 12 },
    ]);
    const r = await asActor(w.admin, (tx) => assetLifecycle(tx, w.admin, press, { today: '2026-10-22' }));
    // 2024: 3,050 + 5 × 200 = 4,050; 2025: 1,200 + 12 × 200 = 3,600 → floor 3,825 (the line falls) < 16,903 → keep.
    expect(r).toMatchObject({ verdict: 'keep', keepNext: 3825, replaceEac: 16903 });
    expect(r.notes).toContain('Labor without a recorded rate is costed at 45 an hour');
    const def = getReport('repair-or-replace')!;
    const rep = await asActor(w.admin, (tx) => def.run(tx, w.admin, def.params.parse({ facilityId: w.facilities.A })));
    expect(rep.headline).toMatch(/^No asset costs more to keep than to replace/);
    expect(rep.rows).toHaveLength(1); // the component is part of its parent, not listed alone
  });
});
