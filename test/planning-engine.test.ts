import { describe, expect, it } from 'vitest';
import type { Item, PlanInput } from '../src/modules/planning/engine.js';
import { computePlan, projectMaintenance } from '../src/modules/planning/engine.js';

// Housing HSG (made: op 10 lathe, op 20 mill) uses 1 bar BAR (bought) and 2 seal kits SEAL (made: op 10 assembly),
// each seal kit uses 1 O-ring ORING (bought). Two months: November (30 days) and December (31 days).
const item = (o: Partial<Item> & { partId: string }): Item => ({ partNumber: o.partId, description: o.partId, made: false, operations: [], materials: [], available: 0, leadTimeDays: null,
  openProduction: [], openPurchases: [], ...o });
const base = (): PlanInput => ({
  months: ['2026-11', '2026-12'], today: '2026-10-25',
  demand: [
    { partId: 'HSG', customerId: 'A', customer: 'Lakeshore', month: '2026-11', forecast: 100, firm: 120 },   // firm consumes and exceeds the forecast
    { partId: 'HSG', customerId: 'B', customer: 'Brightline', month: '2026-11', forecast: 50, firm: 0 },
    { partId: 'HSG', customerId: 'A', customer: 'Lakeshore', month: '2026-12', forecast: 200, firm: 0 },
  ],
  items: [
    item({ partId: 'HSG', made: true, available: 20, openProduction: [{ month: '2026-11', qty: 30 }],
      operations: [{ opNo: 10, workCenterId: 'LATHE', setupMinutes: 30, runMinutesPerUnit: 6 }, { opNo: 20, workCenterId: 'MILL', setupMinutes: 0, runMinutesPerUnit: 3 }],
      materials: [{ partId: 'BAR', qtyPer: 1, scrapPct: 0 }, { partId: 'SEAL', qtyPer: 2, scrapPct: 0 }] }),
    item({ partId: 'SEAL', made: true, available: 40, operations: [{ opNo: 10, workCenterId: 'ASSY', setupMinutes: 0, runMinutesPerUnit: 1 }], materials: [{ partId: 'ORING', qtyPer: 1, scrapPct: 0 }] }),
    item({ partId: 'BAR', available: 100, leadTimeDays: 10, openPurchases: [{ month: '2026-12', qty: 150 }] }),
    item({ partId: 'ORING', available: 1000 }),
  ],
  workCenters: [
    { id: 'LATHE', code: 'LATHE', name: 'Lathes', hoursPerWeek: 80, units: null, machines: 1, availability: 0.9 },
    { id: 'MILL', code: 'MILL', name: 'Mills', hoursPerWeek: null, units: 2, machines: 0, availability: null },
    { id: 'ASSY', code: 'ASSY', name: 'Assembly', hoursPerWeek: 40, units: 1, machines: 0, availability: 1 },
  ],
  performance: [
    { partId: 'HSG', opNo: 10, goodUnits: 50, scrapUnits: 0, runMinutes: 400 },   // demonstrated: 8 min per good unit (standard 6)
    { partId: 'SEAL', opNo: 10, goodUnits: 15, scrapUnits: 5, runMinutes: 30 },   // too few good units for a rate, enough for a yield of 75%
  ],
});

describe('planning engine', () => {
  it('firm orders consume the forecast per customer; netting plans production level by level', () => {
    const p = computePlan(base());
    expect(p.demand).toEqual([{ month: '2026-11', firm: 120, forecast: 50, total: 170 }, { month: '2026-12', firm: 0, forecast: 200, total: 200 }]);
    // HSG: 20 on hand + 30 due − 170 → make 120 in November; 200 in December.
    // SEAL: 2 × (120, 200) = 240, 400; 40 on hand → make 200, 400.
    expect(p.production.map((x) => [x.partNumber, x.qty])).toEqual([['HSG', [120, 200]], ['SEAL', [200, 400]]]);
  });

  it('loads work centers from the routing with demonstrated rates and yields, against calendar × availability', () => {
    const p = computePlan(base());
    const lathe = p.workCenters.find((w) => w.code === 'LATHE')!;
    // Committed: 30 open × 8 min + 30 setup = 270 min = 4.5 h. Planned Nov: 30 + 120 × 8 = 990 min = 16.5 h (120/170 firm).
    expect(lathe.cells[0]).toMatchObject({ committed: 4.5, firm: 11.6, forecast: 4.9, required: 21, scheduled: 342.9, capacity: 308.6 });
    // December: 30 + 200 × 8 = 1630 min = 27.2 h, all forecast; capacity 80 × 31/7 × 0.9.
    expect(lathe.cells[1]).toMatchObject({ committed: 0, firm: 0, forecast: 27.2, capacity: 318.9 });
    // Mill: no calendar → 40 h assumed × 2 crews (no machines, so no availability assumption); standard 3 min, no history → yield 100%.
    expect(p.workCenters.find((w) => w.code === 'MILL')!.cells[0]).toMatchObject({ committed: 1.5, required: 7.5, scheduled: 342.9 });
    // Seal kits: 1 min ÷ 75% yield; November 200 kits = 266.7 min = 4.4 h, labelled like the housings (120/170 firm).
    expect(p.workCenters.find((w) => w.code === 'ASSY')!.cells[0]).toMatchObject({ firm: 3.1, forecast: 1.3, required: 4.4 });
    expect(p.bottleneck).toMatchObject({ code: 'LATHE', month: '2026-12' });
  });

  it('purchased materials: shortfall, need-by and order-by from the lead time', () => {
    const p = computePlan(base());
    // BAR: 100 − 120 = −20 in November; −20 + 150 − 200 = −70 in December.
    expect(p.materials.find((m) => m.partNumber === 'BAR')).toMatchObject({ required: [120, 200], receipts: [0, 150], projected: [-20, -70], shortQty: 70,
      needBy: '2026-11-01', orderBy: '2026-10-22', late: true });
    expect(p.materials.find((m) => m.partNumber === 'ORING')).toMatchObject({ required: [200, 400], shortQty: 0, needBy: null });
  });

  it('lists every assumption it had to make', () => {
    expect(computePlan(base()).assumptions).toEqual([
      'MILL has no calendar; 40 hours a week assumed',
      'Standard run times and 100% yield assumed where fewer than 20 units have been recorded (e.g. HSG op 20)',
    ]);
  });

  it('scenarios: extra hours on the bottleneck, and forecast growth that does not touch firm orders', () => {
    const p = computePlan({ ...base(), scenario: { demandPct: 10, adjustments: [{ workCenterId: 'LATHE', extraHoursPerWeek: 40 }] } });
    // Forecast × 1.1: customer A November max(110, 120) = 120 (firm wins); B 55; December 220.
    expect(p.demand).toEqual([{ month: '2026-11', firm: 120, forecast: 55, total: 175 }, { month: '2026-12', firm: 0, forecast: 220, total: 220 }]);
    expect(p.workCenters.find((w) => w.code === 'LATHE')!.cells[1]).toMatchObject({ capacity: 478.3 });
  });

  it('firm orders past due fall into the first month; demand beyond the horizon is ignored', () => {
    const p = computePlan({ ...base(), demand: [{ partId: 'HSG', customerId: 'A', customer: 'A', month: '2026-09', forecast: 0, firm: 70 }, { partId: 'HSG', customerId: 'A', customer: 'A', month: '2027-03', forecast: 999, firm: 0 }] });
    expect(p.demand[0]).toMatchObject({ firm: 70, total: 70 });
    // 20 + 30 − 70 = −20 → make 20 in November.
    expect(p.production[0]).toMatchObject({ partNumber: 'HSG', qty: [20, 0] });
  });
});

describe('acting on the plan', () => {
  it('open production orders\' unissued materials are demand; open requests reduce what is left to request, not the balance', () => {
    const b = base();
    const bar = b.items.find((i) => i.partId === 'BAR')!; bar.requested = 50;
    const p = computePlan({ ...b, allocations: [{ partId: 'BAR', month: '2026-11', qty: 30 }] });
    // BAR: 100 − (120 + 30) = −50 in November; −50 + 150 − 200 = −100 in December. 50 already requested → 50 left.
    expect(p.materials.find((m) => m.partNumber === 'BAR')).toMatchObject({ required: [150, 200], projected: [-50, -100], shortQty: 100, requested: 50, toRequest: 50 });
  });

  it('preventive maintenance comes off capacity: calendar occurrences, an overdue one counted now and restarted from today', () => {
    const months = ['2026-11', '2026-12'];
    // Every 14 days from 5 Nov: 5, 19 Nov; 3, 17, 31 Dec. Overdue since 1 Oct, every 30 days: now (Nov), then 24 Nov, 24 Dec.
    expect(projectMaintenance([{ nextDueOn: '2026-11-05', intervalDays: 14, hours: 2 }, { nextDueOn: '2026-10-01', intervalDays: 30, hours: 4 }], months, '2026-10-25'))
      .toEqual([2 * 2 + 4 + 4, 3 * 2 + 4]);
    const b = base(); b.workCenters[0]!.maintenanceHours = [20, 0];
    const lathe = computePlan(b).workCenters.find((w) => w.code === 'LATHE')!;
    // 342.9 × 0.9 = 308.6, less 20 h of PM.
    expect(lathe.cells[0]).toMatchObject({ maintenance: 20, capacity: 288.6 });
  });
});

describe('forecast month headers', () => {
  it('reads months the way customers write them', async () => {
    const { parseMonth } = await import('../src/modules/imports/targets/forecasts.js');
    expect(['2026-11', '2026-11-15', '11/2026', '11/15/2026', 'Nov-26', 'Nov 2026', 'November 2026', "Nov '26", 'nov.2026', '13/2026', 'Q4 2026', '']
      .map(parseMonth)).toEqual(['2026-11', '2026-11', '2026-11', '2026-11', '2026-11', '2026-11', '2026-11', '2026-11', '2026-11', null, null, null]);
  });
});
