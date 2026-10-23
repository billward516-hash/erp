import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { adjust, createLocation, ledger, listBalances, openCount, postCount, receive, recordCounts, setStockSettings, transfer } from '../src/modules/inventory/service.js';
import { addLabor, addPart, assignTechnician, createWorkOrder, getWorkOrder, returnPart, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { dueState, nextDue } from '../src/modules/pm/schedule.js';
import type { PlanLike } from '../src/modules/pm/schedule.js';
import { createPlan, generatePmWorkOrders, getPlan, pmSchedule, recordMeter } from '../src/modules/pm/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

let w: World;
let mainA: string; let cribA: string; let mainB: string;
let filter: { id: string }; let belt: { id: string }; let rag: { id: string };
let assetId: string;
const today = new Date().toISOString().slice(0, 10);
const daysFrom = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const onHand = async (loc: string, part: string) => Number((await asActor(w.admin, (tx) => one(tx, 'SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [loc, part])))?.qty_on_hand ?? 0);

beforeAll(async () => {
  w = await makeWorld('inv');
  ({ mainA, cribA, mainB } = await asActor(w.admin, async (tx) => ({
    mainA: (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-MAIN', name: 'Plant A main storeroom' })).id,
    cribA: (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-CRIB', name: 'Plant A tool crib' })).id,
    mainB: (await createLocation(tx, w.admin, { facilityId: w.facilities.B!, code: 'B-MAIN', name: 'Plant B storeroom' })).id,
  })));
  ({ filter, belt, rag } = await asActor(w.admin, async (tx) => ({
    filter: await createPart(tx, w.admin, { partNumber: 'FLT-10', description: 'Hydraulic filter 10 micron' }),
    belt: await createPart(tx, w.admin, { partNumber: 'BLT-A42', description: 'V-belt A42', unitCost: 9 }),
    rag: await createPart(tx, w.admin, { partNumber: 'RAG-BOX', description: 'Shop rags (non-stock)' }),
  })));
  assetId = (await asActor(w.managerA, (tx) => createAsset(tx, w.managerA, { facilityId: w.facilities.A!, assetTag: 'HPU-3', name: 'Hydraulic power unit' }))).id;
});
afterAll(closePools);

describe('stock ledger', () => {
  it('receipts build on-hand and a moving-average cost; every movement is a ledger row with the running balance', async () => {
    await asActor(w.managerA, async (tx) => {
      await receive(tx, w.managerA, { locationId: mainA, partId: filter.id, qty: 10, unitCost: 20, reference: 'PO-1' });
      await receive(tx, w.managerA, { locationId: mainA, partId: filter.id, qty: 10, unitCost: 30, reference: 'PO-2' });
    });
    expect(await onHand(mainA, filter.id)).toBe(20);
    expect(Number((await asActor(w.admin, (tx) => one(tx, 'SELECT unit_cost FROM part WHERE id = $1', [filter.id]))).unit_cost)).toBe(25);
    const rows = await asActor(w.managerA, (tx) => ledger(tx, w.managerA, { partId: filter.id }));
    expect(rows.map((r) => [r.txn_type, r.qty, r.balance_after, r.reference])).toEqual([['receipt', 10, 20, 'PO-2'], ['receipt', 10, 10, 'PO-1']]);
  });

  it('stock cannot go negative, adjustments need a reason, and the ledger is append-only', async () => {
    await expect(asActor(w.managerA, (tx) => adjust(tx, w.managerA, { locationId: mainA, partId: filter.id, qty: -25, reason: 'damaged in storage' }))).rejects.toThrow(/only 20 of FLT-10/);
    await expect(asActor(w.managerA, (tx) => adjust(tx, w.managerA, { locationId: mainA, partId: filter.id, qty: -1, reason: '' }))).rejects.toThrow(/reason/);
    await asActor(w.managerA, (tx) => adjust(tx, w.managerA, { locationId: mainA, partId: filter.id, qty: -1, reason: 'crushed carton' }));
    expect(await onHand(mainA, filter.id)).toBe(19);
    // Two layers: the application role has no UPDATE/DELETE grant, and the table owner is stopped by a trigger.
    await expect(asActor(w.admin, (tx) => tx.query('UPDATE inventory_txn SET qty = 100'))).rejects.toThrow(/permission denied/);
    await expect(getAdminPool().query('UPDATE inventory_txn SET qty = 100 WHERE tenant_id = $1', [w.tenantId])).rejects.toThrow(/append-only/);
    await expect(getAdminPool().query('DELETE FROM inventory_txn WHERE tenant_id = $1', [w.tenantId])).rejects.toThrow(/append-only/);
  });

  it('transfers move stock between storerooms as a matched pair; facility scope applies', async () => {
    await asActor(w.managerA, (tx) => transfer(tx, w.managerA, { fromLocationId: mainA, toLocationId: cribA, partId: filter.id, qty: 4, reference: 'TR-1' }));
    expect([await onHand(mainA, filter.id), await onHand(cribA, filter.id)]).toEqual([15, 4]);
    // Manager at A cannot move stock into Plant B, and technicians cannot receive.
    await expect(asActor(w.managerA, (tx) => transfer(tx, w.managerA, { fromLocationId: mainA, toLocationId: mainB, partId: filter.id, qty: 1 }))).rejects.toThrow();
    await expect(asActor(w.techA, (tx) => receive(tx, w.techA, { locationId: mainA, partId: filter.id, qty: 1 }))).rejects.toThrow(/inventory.manage/);
    const seen = await asActor(w.techA, (tx) => listBalances(tx, w.techA, {}));
    expect(seen.every((b) => b.facility_code === 'A')).toBe(true);
  });

  it('work-order usage issues from a storeroom, returns put stock back, and stocked parts must name the storeroom', async () => {
    const wo = await asActor(w.managerA, async (tx) => {
      const o = await createWorkOrder(tx, w.managerA, { assetId, title: 'Replace return-line filter' });
      await assignTechnician(tx, w.managerA, o.id, w.techAEmployeeId, 'lead');
      return o;
    });
    await asActor(w.techA, (tx) => transitionWorkOrder(tx, w.techA, wo.id, { to: 'in_progress' }));
    await expect(asActor(w.techA, (tx) => addPart(tx, w.techA, wo.id, { partId: filter.id, qtyUsed: 2 }))).rejects.toThrow(/choose the storeroom/);
    await expect(asActor(w.techA, (tx) => addPart(tx, w.techA, wo.id, { partId: filter.id, qtyUsed: 2, locationId: mainB }))).rejects.toThrow();
    await expect(asActor(w.techA, (tx) => addPart(tx, w.techA, wo.id, { partId: filter.id, qtyUsed: 99, locationId: mainA }))).rejects.toThrow(/only 15/);
    const line = await asActor(w.techA, (tx) => addPart(tx, w.techA, wo.id, { partId: filter.id, qtyUsed: 3, locationId: mainA }));
    // A non-stock item is recorded without a stock movement.
    await asActor(w.techA, (tx) => addPart(tx, w.techA, wo.id, { partId: rag.id, qtyUsed: 1 }));
    expect(await onHand(mainA, filter.id)).toBe(12);
    await expect(asActor(w.techA, (tx) => returnPart(tx, w.techA, line.id, 4))).rejects.toThrow(/between 0 and 3/);
    await asActor(w.techA, (tx) => returnPart(tx, w.techA, line.id, 1));
    expect(await onHand(mainA, filter.id)).toBe(13);
    const full = await asActor(w.managerA, (tx) => getWorkOrder(tx, w.managerA, wo.id));
    expect(full.parts.find((p: any) => p.part_id === filter.id).qty_used).toBe(2);
    const moves = await asActor(w.managerA, (tx) => ledger(tx, w.managerA, { workOrderId: wo.id }));
    expect(moves.map((m) => [m.txn_type, m.qty, m.work_order])).toEqual([['return', 1, wo.number], ['issue', -3, wo.number]]);
  });

  it('cycle counts post variances, and refuse when stock moved after the count opened', async () => {
    await asActor(w.managerA, (tx) => receive(tx, w.managerA, { locationId: cribA, partId: belt.id, qty: 6 }));
    const c = await asActor(w.managerA, (tx) => openCount(tx, w.managerA, cribA));
    await expect(asActor(w.managerA, (tx) => openCount(tx, w.managerA, cribA))).rejects.toThrow(/already open/);
    await asActor(w.managerA, (tx) => recordCounts(tx, w.managerA, c.id, [{ partId: filter.id, countedQty: 3 }]));
    await expect(asActor(w.managerA, (tx) => postCount(tx, w.managerA, c.id))).rejects.toThrow(/not counted yet: BLT-A42/);
    await asActor(w.managerA, (tx) => recordCounts(tx, w.managerA, c.id, [{ partId: belt.id, countedQty: 6 }]));
    // Someone pulls a belt while the count is open: posting would be against a stale snapshot.
    await new Promise((r) => setTimeout(r, 5));
    await asActor(w.managerA, (tx) => adjust(tx, w.managerA, { locationId: cribA, partId: belt.id, qty: -1, reason: 'issued to line 2 by hand' }));
    await expect(asActor(w.managerA, (tx) => postCount(tx, w.managerA, c.id))).rejects.toThrow(/stock moved/);
    const r = await asActor(w.managerA, (tx) => postCount(tx, w.managerA, c.id, { acceptMovement: true }));
    // Filter: 4 on hand, counted 3 → -1. Belt: 5 on hand after the pull, counted 6 → +1.
    expect(r.variances).toEqual(expect.arrayContaining([
      expect.objectContaining({ partNumber: 'FLT-10', delta: -1 }), expect.objectContaining({ partNumber: 'BLT-A42', delta: 1 }),
    ]));
    expect([await onHand(cribA, filter.id), await onHand(cribA, belt.id)]).toEqual([3, 6]);
  });

  it('opening balances import sets on-hand by difference, so re-importing changes nothing', async () => {
    const file = Buffer.from('Item,Store,On Hand,Bin,Min,Order Qty,Cost\r\nFLT-10,A-MAIN,13,R1-S2,8,12,24\r\nBLT-A42,A-MAIN,5,R3-S1,6,10,9\r\nNOPE-1,A-MAIN,2,,,,\r\nBLT-A42,B-MAIN,3,,,,\r\n');
    const staged = await stageImport(w.managerA, { target: 'stock_balances', sourceSystem: 'storeroom', fileName: 'stock.csv', content: file });
    expect(staged.stats).toMatchObject({ total: 4, errors: 2 });
    const r = await commitImport(w.managerA, staged.batchId, { allowPartial: true });
    expect(r.stats).toMatchObject({ failed: 2 });
    expect(await onHand(mainA, belt.id)).toBe(5);
    const bal = await asActor(w.admin, (tx) => one(tx, 'SELECT bin, reorder_point, reorder_qty FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [mainA, filter.id]));
    expect(bal).toMatchObject({ bin: 'R1-S2', reorder_point: 8, reorder_qty: 12 });
    const txns = async () => (await asActor(w.admin, (tx) => many(tx, `SELECT 1 FROM inventory_txn WHERE txn_type = 'opening'`))).length;
    const before = await txns();
    expect(before).toBe(1);
    const again = await stageImport(w.managerA, { target: 'stock_balances', sourceSystem: 'storeroom', fileName: 'stock.csv', content: file });
    await commitImport(w.managerA, again.batchId, { allowPartial: true });
    expect(await txns()).toBe(before);
  });
});

describe('PM scheduling rules', () => {
  const cal: PlanLike = { trigger_type: 'calendar', interval_days: 30, interval_meter: null, schedule_basis: 'completion', lead_days: 7, lead_meter: 0, next_due_on: '2026-11-01', next_due_meter: null };
  const met: PlanLike = { trigger_type: 'meter', interval_days: null, interval_meter: 500, schedule_basis: 'completion', lead_days: 7, lead_meter: 50, next_due_on: null, next_due_meter: 1000 };

  it('due states follow the lead window', () => {
    expect(dueState(cal, '2026-10-24', null)).toBe('not_due');
    expect(dueState(cal, '2026-10-25', null)).toBe('due');
    expect(dueState(cal, '2026-11-01', null)).toBe('due');
    expect(dueState(cal, '2026-11-02', null)).toBe('overdue');
    expect(dueState(met, today, null)).toBe('not_due');
    expect(dueState(met, today, 949)).toBe('not_due');
    expect(dueState(met, today, 950)).toBe('due');
    expect(dueState(met, today, 1001)).toBe('overdue');
  });

  it('next due floats from completion, or keeps the fixed anchor and skips missed cycles', () => {
    expect(nextDue(cal, '2026-11-05', null)).toEqual({ nextDueOn: '2026-12-05' });
    expect(nextDue({ ...cal, schedule_basis: 'fixed' }, '2026-11-05', null)).toEqual({ nextDueOn: '2026-12-01' });
    expect(nextDue({ ...cal, schedule_basis: 'fixed' }, '2027-01-10', null)).toEqual({ nextDueOn: '2027-01-30' });
    expect(nextDue(met, today, 1040)).toEqual({ nextDueMeter: 1540 });
    expect(nextDue({ ...met, schedule_basis: 'fixed' }, today, 1040)).toEqual({ nextDueMeter: 1500 });
    expect(nextDue({ ...met, schedule_basis: 'fixed' }, today, 1620)).toEqual({ nextDueMeter: 2000 });
  });
});

describe('preventive maintenance', () => {
  let calPlan: any; let meterPlan: any;

  it('creates calendar and meter plans; meter readings cannot go backwards', async () => {
    calPlan = await asActor(w.managerA, (tx) => createPlan(tx, w.managerA, {
      assetId, code: 'PM-HPU3-M', title: 'Monthly HPU service', triggerType: 'calendar', intervalDays: 30, firstDueOn: daysFrom(-3), estimatedHours: 1.5,
      parts: [{ partId: filter.id, qty: 2 }, { partId: belt.id, qty: 8 }],
    }));
    expect(calPlan.next_due_on).toBe(daysFrom(-3));
    await expect(asActor(w.techA, (tx) => createPlan(tx, w.techA, { assetId, code: 'X', title: 'x', triggerType: 'calendar', intervalDays: 7 }))).rejects.toThrow(/work_orders.manage/);
    await expect(asActor(w.managerA, (tx) => createPlan(tx, w.managerA, { assetId, code: 'PM-BAD', title: 'x', triggerType: 'meter', intervalMeter: 100 }))).rejects.toThrow(/meter name/);

    await asActor(w.managerA, (tx) => recordMeter(tx, w.managerA, assetId, { meter: 'run_hours', value: 900 }));
    meterPlan = await asActor(w.managerA, (tx) => createPlan(tx, w.managerA, {
      assetId, code: 'PM-HPU3-500H', title: '500 h pump inspection', triggerType: 'meter', meter: 'run_hours', intervalMeter: 500, leadMeter: 50,
    }));
    expect(meterPlan.next_due_meter).toBe(1400);
    await expect(asActor(w.managerA, (tx) => recordMeter(tx, w.managerA, assetId, { meter: 'run_hours', value: 850 }))).rejects.toThrow(/lower than the last reading/);
  });

  it('the schedule shows due state and parts shortages; generation creates one work order per due plan', async () => {
    let sched = await asActor(w.managerA, (tx) => pmSchedule(tx, w.managerA, { facilityId: w.facilities.A }));
    const cal = sched.find((p) => p.code === 'PM-HPU3-M')!;
    expect(cal.due_state).toBe('overdue');
    // Plant A has 13 + 3 filters and 5 + 6 belts; the plan wants 8 belts at the facility → enough. Make belts short.
    expect(cal.parts_short).toBe(0);
    await asActor(w.managerA, (tx) => adjust(tx, w.managerA, { locationId: cribA, partId: belt.id, qty: -6, reason: 'sent out for warranty' }));
    sched = await asActor(w.managerA, (tx) => pmSchedule(tx, w.managerA, { facilityId: w.facilities.A }));
    expect(sched.find((p) => p.code === 'PM-HPU3-M')!.parts.find((p: any) => p.part_number === 'BLT-A42').short).toBe(true);
    expect(sched.find((p) => p.code === 'PM-HPU3-500H')!).toMatchObject({ due_state: 'not_due', meter_remaining: 500 });

    const g = await asActor(w.managerA, (tx) => generatePmWorkOrders(tx, w.managerA, { facilityId: w.facilities.A }));
    expect(g.created).toEqual([expect.objectContaining({ plan: 'PM-HPU3-M', dueState: 'overdue' })]);
    const again = await asActor(w.managerA, (tx) => generatePmWorkOrders(tx, w.managerA, { facilityId: w.facilities.A }));
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([expect.objectContaining({ plan: 'PM-HPU3-M' })]);

    // Meter crosses into the lead window → its PM is generated with the due reading recorded.
    await asActor(w.managerA, (tx) => recordMeter(tx, w.managerA, assetId, { meter: 'run_hours', value: 1362 }));
    const g2 = await asActor(w.managerA, (tx) => generatePmWorkOrders(tx, w.managerA, {}));
    expect(g2.created.map((c) => c.plan)).toEqual(['PM-HPU3-500H']);
    const wo = await asActor(w.managerA, (tx) => one(tx, 'SELECT wo_type, pm_due_meter FROM work_order WHERE pm_plan_id = $1', [meterPlan.id]));
    expect(wo).toMatchObject({ wo_type: 'preventive', pm_due_meter: 1400 });
  });

  it('verifying the PM work order moves the plan forward from the completion date', async () => {
    const woId = (await asActor(w.managerA, (tx) => one(tx, 'SELECT id FROM work_order WHERE pm_plan_id = $1', [calPlan.id]))).id;
    const full = await asActor(w.managerA, (tx) => getWorkOrder(tx, w.managerA, woId));
    expect(full.parts.map((p: any) => [p.part_number, p.qty_planned])).toEqual(expect.arrayContaining([['FLT-10', 2], ['BLT-A42', 8]]));
    await asActor(w.managerA, (tx) => assignTechnician(tx, w.managerA, woId, w.techAEmployeeId, 'lead'));
    await asActor(w.techA, async (tx) => {
      await transitionWorkOrder(tx, w.techA, woId, { to: 'in_progress' });
      await addLabor(tx, w.techA, woId, { workDate: today, hours: 1.25 });
      await addPart(tx, w.techA, woId, { partId: filter.id, qtyUsed: 2, locationId: mainA });
      await transitionWorkOrder(tx, w.techA, woId, { to: 'completed' });
    });
    // Completion alone does not advance the plan.
    expect((await asActor(w.managerA, (tx) => getPlan(tx, w.managerA, calPlan.id))).next_due_on).toBe(daysFrom(-3));
    await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, woId, { to: 'verified' }));
    const plan = await asActor(w.managerA, (tx) => getPlan(tx, w.managerA, calPlan.id));
    expect(plan).toMatchObject({ last_done_on: today, next_due_on: daysFrom(30), due_state: 'not_due' });
    expect(plan.history[0]).toMatchObject({ status: 'verified', on_time: false });
  });

  it('reports: PM compliance counts the late PM; reorder lists parts below reorder point or short for PM', async () => {
    const pm = await asActor(w.managerA, (tx) => getReport('pm-compliance')!.run(tx, w.managerA, { days: 90 }));
    expect(pm.kpis.find((k) => k.label === 'PM compliance')!.value).toBe(0);
    expect(pm.headline).toMatch(/PM compliance 0\.0% over 90 days \(0 of 1 on time\)/);
    expect(pm.rows.find((r) => r.code === 'PM-HPU3-500H')).toMatchObject({ due_state: 'Due', open_wo: expect.any(String) });

    await asActor(w.managerA, (tx) => setStockSettings(tx, w.managerA, mainA, filter.id, { reorderPoint: 12, reorderQty: 10 }));
    const ro = await asActor(w.managerA, (tx) => getReport('inventory-reorder')!.run(tx, w.managerA, { days: 45 }));
    const byPart = Object.fromEntries(ro.rows.map((r) => [r.part_number, r]));
    // Filters: 11 + 3 = 14 on hand at A, reorder point 12 → not below. Belts: 5 on hand, point 6, next monthly PM needs 8 → short.
    expect(byPart['FLT-10']).toBeUndefined();
    expect(byPart['BLT-A42']).toMatchObject({ on_hand: 5, pm_demand: 8, short_for_pm: true, pm_plans: 'PM-HPU3-M', suggested_qty: 10 });
    expect(ro.headline).toMatch(/1 part to reorder, 1 needed for PM/);
    // Plant B data is not in a Plant A manager's report.
    expect(ro.scope.facilities).toEqual(['A']);
  });
});
