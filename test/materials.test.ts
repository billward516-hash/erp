import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { createWorkOrder, getWorkOrder } from '../src/modules/maintenance/service.js';
import {
  applyTemplate, availabilityByLocation, cancelKit, createKit, getKit, issueKit, listAssetParts, listTemplates, partWhereUsed, refreshKit, returnAndClose, saveAssetPart,
  saveTemplate, stageKit,
} from '../src/modules/materials/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { createPlan, generatePmWorkOrders } from '../src/modules/pm/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let mill: string; let store: string; let stage: string;
const P: Record<string, string> = {};
const bal = async (loc: string, part: string) => Number((await db().query('SELECT qty_on_hand FROM inventory_balance WHERE location_id = $1 AND part_id = $2', [loc, part])).rows[0]?.qty_on_hand ?? 0);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeAll(async () => {
  w = await makeWorld('mat');
  await asActor(w.admin, async (tx) => {
    mill = (await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'MILL-1', name: 'Vertical mill', category: 'VMC' })).id;
    store = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-STORE', name: 'Main storeroom' })).id;
    stage = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-STAGE', name: 'Kit staging', kind: 'staging' })).id;
    for (const [k, pn, qty] of [['seal', 'SEAL-1', 10], ['brg', 'BRG-1', 1], ['belt', 'BELT-1', 4]] as const) {
      P[k] = (await createPart(tx, w.admin, { partNumber: pn, description: pn, unitCost: 20 })).id;
      await receive(tx, w.admin, { locationId: store, partId: P[k]!, qty, unitCost: 20 });
    }
  });
});
afterAll(closePools);

describe('equipment parts lists and repair templates', () => {
  it('lists spares per machine with availability, and shows where a part is used', async () => {
    await asActor(w.managerA, async (tx) => {
      await saveAssetPart(tx, w.managerA, mill, { partId: P.seal!, position: 'Spindle drawbar', critical: true, minOnHand: 2 });
      await saveAssetPart(tx, w.managerA, mill, { partId: P.brg!, qtyInstalled: 2, position: 'Spindle', critical: true, minOnHand: 2 });
    });
    await expect(asActor(w.techA, (tx) => saveAssetPart(tx, w.techA, mill, { partId: P.belt! }))).rejects.toThrow(/assets.manage/);
    const list = await asActor(w.techA, (tx) => listAssetParts(tx, w.techA, mill));
    expect(list.map((p) => [p.part_number, p.available, p.below_min])).toEqual([['BRG-1', 1, true], ['SEAL-1', 10, false]]);
    expect((await asActor(w.admin, (tx) => partWhereUsed(tx, w.admin, P.brg!))).map((r) => [r.asset_tag, r.qty_installed])).toEqual([['MILL-1', 2]]);
  });

  it('a repair template for an asset category adds its parts, labor estimate and only once', async () => {
    await expect(asActor(w.managerA, (tx) => saveTemplate(tx, w.managerA, { code: 'X', title: 'No target', parts: [] }))).rejects.toThrow(/machine or to an asset category/);
    const t = await asActor(w.managerA, (tx) => saveTemplate(tx, w.managerA, { code: 'VMC-SPINDLE-SEALS', title: 'Replace spindle drawbar seals', assetCategory: 'VMC', estLaborHours: 4,
      parts: [{ partId: P.seal!, qty: 2 }, { partId: P.brg!, qty: 3 }] }));
    expect((await asActor(w.techA, (tx) => listTemplates(tx, w.techA, { assetId: mill }))).map((x) => x.code)).toEqual(['VMC-SPINDLE-SEALS']);
    const wo = await asActor(w.managerA, (tx) => createWorkOrder(tx, w.managerA, { assetId: mill, title: 'Drawbar seals leaking', dueAt: inDays(3) }));
    expect(await asActor(w.managerA, (tx) => applyTemplate(tx, w.managerA, wo.id, t.id))).toEqual({ added: 2 });
    expect(await asActor(w.managerA, (tx) => applyTemplate(tx, w.managerA, wo.id, t.id))).toEqual({ added: 0 });
    const v = await asActor(w.managerA, (tx) => getWorkOrder(tx, w.managerA, wo.id));
    expect(Number(v.estimated_labor_hours)).toBe(4);
    P.wo = wo.id;
  });
});

describe('kits', () => {
  let kit: any;
  it('a kit reserves what the storeroom has and shows what is short; reserved stock is not available to others', async () => {
    kit = await asActor(w.managerA, (tx) => createKit(tx, w.managerA, P.wo!));
    expect(kit.number).toMatch(/^KIT-\d{6}$/);
    await expect(asActor(w.managerA, (tx) => createKit(tx, w.managerA, P.wo!))).rejects.toThrow(/already has a kit/);
    const k = await asActor(w.managerA, (tx) => getKit(tx, w.managerA, kit.id));
    expect(k.lines.map((l: any) => [l.part_number, l.qty_needed, l.qty_reserved])).toEqual([['BRG-1', 3, 1], ['SEAL-1', 2, 2]]);
    expect(k.short).toBe(1);
    expect((await asActor(w.admin, (tx) => availabilityByLocation(tx, w.facilities.A!, P.seal!)))[0]).toMatchObject({ location: 'A-STORE', on_hand: 10, reserved: 2, available: 8 });
  });

  it('a short kit cannot be staged; once stock arrives a refresh fills it and staging moves it through the ledger', async () => {
    await expect(asActor(w.admin, (tx) => stageKit(tx, w.admin, kit.id, stage))).rejects.toThrow(/short on 1 line/);
    await asActor(w.admin, (tx) => receive(tx, w.admin, { locationId: store, partId: P.brg!, qty: 4, unitCost: 20 }));
    expect(await asActor(w.managerA, (tx) => refreshKit(tx, w.managerA, kit.id))).toEqual({ linesTopped: 1 });
    await expect(asActor(w.admin, (tx) => stageKit(tx, w.admin, kit.id, store))).rejects.toThrow(/staging location/);
    await expect(asActor(w.techA, (tx) => stageKit(tx, w.techA, kit.id, stage))).rejects.toThrow(/inventory.manage/);
    await asActor(w.admin, (tx) => stageKit(tx, w.admin, kit.id, stage));
    expect([await bal(store, P.seal!), await bal(stage, P.seal!), await bal(store, P.brg!), await bal(stage, P.brg!)]).toEqual([8, 2, 2, 3]);
    // Staged stock is never offered to other work.
    expect((await asActor(w.admin, (tx) => availabilityByLocation(tx, w.facilities.A!, P.brg!))).map((a) => a.location)).toEqual(['A-STORE']);
  });

  it('the technician takes the kit to the job; unused parts go back to the storeroom they came from', async () => {
    await asActor(w.techA, (tx) => issueKit(tx, w.techA, kit.id));
    const used = await asActor(w.techA, (tx) => many(tx, 'SELECT part_id, qty_used::float AS q FROM work_order_part WHERE work_order_id = $1 ORDER BY qty_used', [P.wo]));
    expect(used.map((u) => u.q)).toEqual([2, 3]);
    expect([await bal(stage, P.seal!), await bal(stage, P.brg!)]).toEqual([0, 0]);
    const k = await asActor(w.techA, (tx) => getKit(tx, w.techA, kit.id));
    const brgLine = k.lines.find((l: any) => l.part_number === 'BRG-1');
    await expect(asActor(w.techA, (tx) => returnAndClose(tx, w.techA, kit.id, [{ kitLineId: brgLine.id, qty: 5 }]))).rejects.toThrow(/at most 3/);
    await asActor(w.techA, (tx) => returnAndClose(tx, w.techA, kit.id, [{ kitLineId: brgLine.id, qty: 1 }]));
    expect([await bal(store, P.brg!), await bal(stage, P.brg!)]).toEqual([3, 0]);
    expect((await asActor(w.techA, (tx) => one(tx, 'SELECT qty_used::float AS q FROM work_order_part WHERE work_order_id = $1 AND part_id = $2', [P.wo, P.brg]))).q).toBe(2);
    expect((await asActor(w.techA, (tx) => getKit(tx, w.techA, kit.id))).status).toBe('closed');
  });

  it('a virtual kit issues straight from the storeroom; cancelling a staged kit puts the stock back', async () => {
    const wo2 = await asActor(w.managerA, async (tx) => { const x = await createWorkOrder(tx, w.managerA, { assetId: mill, title: 'Belt change', dueAt: inDays(2) });
      const { addPart } = await import('../src/modules/maintenance/service.js'); await addPart(tx, w.managerA, x.id, { partId: P.belt!, qtyPlanned: 2 }); return x; });
    const k2 = await asActor(w.managerA, (tx) => createKit(tx, w.managerA, wo2.id));
    await asActor(w.techA, (tx) => issueKit(tx, w.techA, k2.id));
    expect(await bal(store, P.belt!)).toBe(2);
    await expect(asActor(w.managerA, (tx) => cancelKit(tx, w.managerA, k2.id, 'not needed'))).rejects.toThrow(/kit is issued/);
    const wo3 = await asActor(w.managerA, async (tx) => { const x = await createWorkOrder(tx, w.managerA, { assetId: mill, title: 'Seal check', dueAt: inDays(30) });
      const { addPart } = await import('../src/modules/maintenance/service.js'); await addPart(tx, w.managerA, x.id, { partId: P.seal!, qtyPlanned: 1 }); return x; });
    const k3 = await asActor(w.managerA, (tx) => createKit(tx, w.managerA, wo3.id));
    await asActor(w.admin, (tx) => stageKit(tx, w.admin, k3.id, stage));
    await asActor(w.managerA, (tx) => cancelKit(tx, w.managerA, k3.id, 'Job moved to the shutdown'));
    expect([await bal(store, P.seal!), await bal(stage, P.seal!)]).toEqual([8, 0]);
  });

  it('a work order completed or cancelled without its kit releases the reservation and returns staged stock', async () => {
    const { addPart, transitionWorkOrder } = await import('../src/modules/maintenance/service.js');
    const wo4 = await asActor(w.managerA, async (tx) => { const x = await createWorkOrder(tx, w.managerA, { assetId: mill, title: 'Inspect seals', dueAt: inDays(4) });
      await addPart(tx, w.managerA, x.id, { partId: P.seal!, qtyPlanned: 3 }); return x; });
    const k4 = await asActor(w.managerA, (tx) => createKit(tx, w.managerA, wo4.id));
    await asActor(w.admin, (tx) => stageKit(tx, w.admin, k4.id, stage));
    expect([await bal(store, P.seal!), await bal(stage, P.seal!)]).toEqual([5, 3]);
    await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo4.id, { to: 'cancelled', note: 'Seals checked during the PM instead' }));
    expect([await bal(store, P.seal!), await bal(stage, P.seal!)]).toEqual([8, 0]);
    expect((await asActor(w.managerA, (tx) => getKit(tx, w.managerA, k4.id)))).toMatchObject({ status: 'cancelled', cancel_reason: expect.stringMatching(/cancelled without the kit being issued/) });
  });

  it('generating a PM work order builds its kit', async () => {
    await asActor(w.managerA, (tx) => createPlan(tx, w.managerA, { assetId: mill, code: 'PM-MILL-Q', title: 'Quarterly service', triggerType: 'calendar', intervalDays: 90,
      firstDueOn: inDays(1).slice(0, 10), parts: [{ partId: P.seal!, qty: 1 }] }));
    const g = await asActor(w.managerA, (tx) => generatePmWorkOrders(tx, w.managerA, {}));
    expect(g.created).toEqual([expect.objectContaining({ plan: 'PM-MILL-Q', kit: expect.stringMatching(/^KIT-\d{6}$/) })]);
  });

  it('the readiness report shows kits short or missing and critical spares below minimum', async () => {
    await asActor(w.managerA, async (tx) => { const x = await createWorkOrder(tx, w.managerA, { assetId: mill, title: 'Replace spindle bearings', dueAt: inDays(5) });
      const { addPart } = await import('../src/modules/maintenance/service.js'); await addPart(tx, w.managerA, x.id, { partId: P.brg!, qtyPlanned: 2 }); });
    const def = getReport('kit-readiness')!;
    const r = await asActor(w.managerA, (tx) => def.run(tx, w.managerA, def.params.parse({})));
    expect(r.rows.map((x: any) => [x.title, x.readiness])).toEqual(expect.arrayContaining([['PM: Quarterly service', 'Reserved'], ['Replace spindle bearings', 'No kit']]));
    // The drawbar job still plans one bearing more than it used (one was returned), and its kit is closed.
    expect(r.headline).toMatch(/^2 of 3 upcoming work orders not ready: 2 without a kit$/);
    // BRG-1: 3 in the store, minimum 2 → fine; SEAL-1: 8 − 1 reserved → fine. Raise the minimum to see the warning.
    await asActor(w.managerA, (tx) => saveAssetPart(tx, w.managerA, mill, { partId: P.brg!, qtyInstalled: 2, critical: true, minOnHand: 5 }));
    const r2 = await asActor(w.managerA, (tx) => def.run(tx, w.managerA, def.params.parse({})));
    expect(r2.insights.join(' ')).toMatch(/1 critical spare below minimum: BRG-1 for MILL-1 \(3 of 5\)/);
  });
});

describe('equipment parts import', () => {
  it('an OEM spares list matches parts by our number or the manufacturer\'s, and rejects superseded and unknown parts', async () => {
    const w2 = await makeWorld('spares');
    await asActor(w2.admin, async (tx) => {
      for (const [tag, f] of [['CNC-101', 'A'], ['CNC-102', 'A'], ['HMC-201', 'A'], ['CMP-01', 'A'], ['PRS-01', 'B'], ['CNC-104', 'A']]) await createAsset(tx, w2.admin, { facilityId: w2.facilities[f!]!, assetTag: tag!, name: tag! });
      for (const [pn, mpn, active] of [['SEAL-KIT-VF4', '93-3215', true], ['BRG-7014-ACD', '7014 ACD/P4ADGA', true], ['BRG-6205-2RS', '6205-2RSH', true], ['FLT-AIR-OLD', '1613740800', false], ['FLT-HYD-10', '937399Q', true]] as const) {
        await createPart(tx, w2.admin, { partNumber: pn, description: pn, manufacturerPartNumber: mpn, active });
      }
    });
    const content = await readFile('samples/imports/ridgeline/11_oem_spares_list.csv');
    const s = await stageImport(w2.admin, { target: 'asset_parts', sourceSystem: 'oem-spares', fileName: 'spares.csv', content });
    expect(s.stats).toMatchObject({ total: 7, errors: 2, warnings: 3, toCreate: 5 });
    const msgs = s.preview.flatMap((p: any) => p.messages.map((m: any) => m.message));
    expect(msgs).toEqual(expect.arrayContaining([expect.stringMatching(/FLT-AIR-OLD is inactive/), expect.stringMatching(/part 99-0412 not found/), 'matched to BRG-7014-ACD by manufacturer part number']));
    await commitImport(w2.admin, s.batchId, { allowPartial: true });
    const rows = await asActor(w2.admin, (tx) => many(tx, `SELECT a.asset_tag, p.part_number, ap.critical, ap.min_on_hand::float AS min FROM asset_part ap JOIN asset a ON a.id = ap.asset_id JOIN part p ON p.id = ap.part_id ORDER BY 1, 2`));
    expect(rows).toEqual([
      { asset_tag: 'CNC-101', part_number: 'BRG-7014-ACD', critical: true, min: 1 }, { asset_tag: 'CNC-101', part_number: 'SEAL-KIT-VF4', critical: true, min: 1 },
      { asset_tag: 'CNC-102', part_number: 'SEAL-KIT-VF4', critical: true, min: 1 }, { asset_tag: 'HMC-201', part_number: 'BRG-6205-2RS', critical: false, min: null },
      { asset_tag: 'PRS-01', part_number: 'FLT-HYD-10', critical: true, min: 2 },
    ]);
    const again = await stageImport(w2.admin, { target: 'asset_parts', sourceSystem: 'oem-spares', fileName: 'spares.csv', content });
    expect(again.stats).toMatchObject({ toCreate: 0, toUpdate: 0 });
  });
});
