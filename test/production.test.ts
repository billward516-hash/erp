import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset, recordState } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { parseLevel } from '../src/modules/imports/targets/boms.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { createQualification, grantQualification, setAssetRequirement } from '../src/modules/learning/qualifications.js';
import { createPart } from '../src/modules/parts/service.js';
import {
  cancelOrder, closeOrder, completeShort, createOrder, createRevision, floorQueue, getOrder, getRevision, issueMaterials, receiveOutput, releaseOrder,
  releaseRevision, requestShortages, returnMaterial, saveRevision, saveWorkCenter, startOperation, stopOperation,
} from '../src/modules/production/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let sup: Actor; let ana: Actor; let ben: Actor;
const P: Record<string, string> = {};
const WC: Record<string, string> = {};
const A: Record<string, string> = {};
let rm: string; let fg: string;

const operator = async (num: string, first: string) => {
  const e = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, $3, $4, 'Op', 'Machinist') RETURNING id`,
    [w.tenantId, w.facilities.A, num, first])).rows[0].id;
  const u = await createUserWithToken(db(), w.tenantId, { email: `${first}-${Date.now()}@p.example`, displayName: first, employeeId: e, roles: [{ role: 'operator', facility: w.facilities.A! }] });
  return (await loadActor(w.tenantId, u.userId))!;
};
const state = async (assetId: string) => (await db().query('SELECT operational_state FROM asset WHERE id = $1', [assetId])).rows[0].operational_state;

beforeAll(async () => {
  w = await makeWorld('prod');
  const u = await createUserWithToken(db(), w.tenantId, { email: `sup-${Date.now()}@p.example`, displayName: 'Sup', roles: [{ role: 'production_supervisor', facility: w.facilities.A! }] });
  sup = (await loadActor(w.tenantId, u.userId))!;
  ana = await operator('E300', 'Ana');
  ben = await operator('E301', 'Ben');
  await asActor(w.admin, async (tx) => {
    for (const [k, pn, uom] of [['hsg', 'HSG-220', 'EA'], ['bar', 'BAR-6061-250', 'IN'], ['kit', 'KIT-AH220-SEAL', 'EA'], ['oring', 'ORING-2-214', 'EA'], ['plug', 'PLUG-SAE-6', 'EA'],
      ['tag', 'TAG-SER-01', 'EA'], ['box', 'BOX-HSG-4', 'EA']]) P[k!] = (await createPart(tx, w.admin, { partNumber: pn!, description: pn!, uom: uom! })).id;
    rm = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-RM', name: 'Raw material' })).id;
    fg = (await createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-FG', name: 'Finished goods' })).id;
    await receive(tx, w.admin, { locationId: rm, partId: P.bar!, qty: 200, unitCost: 0.5 });
    await receive(tx, w.admin, { locationId: rm, partId: P.oring!, qty: 50, unitCost: 0.4 });
    await receive(tx, w.admin, { locationId: rm, partId: P.plug!, qty: 10, unitCost: 1.2 });
    for (const [k, tag] of [['lathe', 'LATHE-1'], ['vmc', 'VMC-1'], ['cmm', 'CMM-1']]) A[k!] = (await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: tag!, name: tag! })).id;
    const q = await createQualification(tx, w.admin, { code: 'CMM-OP', name: 'CMM operator' });
    await setAssetRequirement(tx, w.admin, A.cmm!, q.id, 'operate');
    await grantQualification(tx, w.admin, ana.employeeId!, q.id);
  });
  await asActor(sup, async (tx) => {
    WC.lathe = (await saveWorkCenter(tx, sup, { facilityId: w.facilities.A!, code: 'LATHE', name: 'CNC turning', assetIds: [A.lathe!] })).id;
    WC.vmc = (await saveWorkCenter(tx, sup, { facilityId: w.facilities.A!, code: 'VMC', name: 'Vertical machining', assetIds: [A.vmc!] })).id;
    WC.deburr = (await saveWorkCenter(tx, sup, { facilityId: w.facilities.A!, code: 'DEBURR', name: 'Deburr and wash' })).id;
    WC.insp = (await saveWorkCenter(tx, sup, { facilityId: w.facilities.A!, code: 'INSPECT', name: 'Final inspection', assetIds: [A.cmm!] })).id;
  });
});
afterAll(closePools);

const ROUTING = () => [
  { opNo: 10, workCenterId: WC.lathe!, description: 'Turn blank from bar', setupMinutes: 30, runMinutesPerUnit: 6 },
  { opNo: 20, workCenterId: WC.vmc!, description: 'Mill ports', setupMinutes: 45, runMinutesPerUnit: 9 },
  { opNo: 30, workCenterId: WC.deburr!, description: 'Deburr, wash, install seals', runMinutesPerUnit: 3 },
  { opNo: 40, workCenterId: WC.insp!, description: 'CMM inspection', runMinutesPerUnit: 4 },
];

describe('product revisions (bill of materials + routing)', () => {
  let rev1: any;
  it('a draft is edited as a whole, refuses circular structures, and needs a routing to release', async () => {
    rev1 = await asActor(sup, (tx) => createRevision(tx, sup, { partId: P.hsg! }));
    expect(rev1).toMatchObject({ revision: 1, status: 'draft' });
    await expect(asActor(sup, (tx) => saveRevision(tx, sup, rev1.id, { materials: [{ partId: P.hsg!, qtyPer: 1 }], operations: [] }))).rejects.toThrow(/cannot contain itself/);
    await expect(asActor(sup, (tx) => releaseRevision(tx, sup, rev1.id))).rejects.toThrow(/at least one operation/);
    const kit = await asActor(sup, (tx) => createRevision(tx, sup, { partId: P.kit! }));
    await asActor(sup, (tx) => saveRevision(tx, sup, kit.id, { materials: [{ partId: P.oring!, qtyPer: 2 }], operations: [{ opNo: 10, workCenterId: WC.deburr!, description: 'Bag seals' }] }));
    const v = await asActor(sup, (tx) => saveRevision(tx, sup, rev1.id, {
      materials: [{ partId: P.bar!, qtyPer: 3.4, scrapPct: 2, opNo: 10 }, { partId: P.oring!, qtyPer: 2, scrapPct: 5, opNo: 30 }, { partId: P.plug!, qtyPer: 1, opNo: 30 }, { partId: P.kit!, qtyPer: 1 }],
      operations: ROUTING() }));
    // The seal kit is in the housing, so the housing cannot go into the seal kit.
    await expect(asActor(sup, (tx) => saveRevision(tx, sup, kit.id, { materials: [{ partId: P.hsg!, qtyPer: 1 }], operations: [{ opNo: 10, workCenterId: WC.deburr!, description: 'x' }] })))
      .rejects.toThrow(/circular/);
    // Standard cost: 3.4 × 1.02 × 0.50 + 2 × 1.05 × 0.40 + 1 × 1.20 (+ the kit, not costed yet); minutes 6 + 9 + 3 + 4 + setups.
    expect(v.standard.materialCost).toBeCloseTo(1.734 + 0.84 + 1.2, 4);
    expect(v.standard.uncosted).toEqual(['KIT-AH220-SEAL']);
    await asActor(sup, (tx) => saveRevision(tx, sup, rev1.id, { materials: v.materials.filter((m: any) => m.part_id !== P.kit).map((m: any) => ({ partId: m.part_id, qtyPer: m.qty_per, scrapPct: m.scrap_pct, opNo: m.op_no })), operations: ROUTING() }));
    await expect(asActor(ana, (tx) => releaseRevision(tx, ana, rev1.id))).rejects.toThrow(/production.manage/);
    expect(await asActor(sup, (tx) => releaseRevision(tx, sup, rev1.id))).toEqual({ revision: 1, supersedes: null });
  });

  it('released revisions are frozen; a new revision starts as a copy and supersedes the old one on release', async () => {
    await expect(db().query('UPDATE product_material SET qty_per = 9 WHERE revision_id = $1', [rev1.id])).rejects.toThrow(/cannot change/);
    await expect(asActor(sup, (tx) => saveRevision(tx, sup, rev1.id, { materials: [], operations: ROUTING() }))).rejects.toThrow(/create a new revision/);
    const rev2 = await asActor(sup, (tx) => createRevision(tx, sup, { partId: P.hsg!, notes: 'Shorter blank' }));
    const v2 = await asActor(sup, (tx) => getRevision(tx, sup, rev2.id));
    expect(v2.materials.map((m: any) => m.part_number)).toEqual(['BAR-6061-250', 'ORING-2-214', 'PLUG-SAE-6']);
    expect(v2.operations).toHaveLength(4);
    await expect(asActor(sup, (tx) => createRevision(tx, sup, { partId: P.hsg! }))).rejects.toThrow(/already has a draft/);
    await asActor(sup, (tx) => releaseRevision(tx, sup, rev2.id));
    const revs = await asActor(sup, (tx) => many(tx, 'SELECT revision, status FROM product_revision WHERE part_id = $1 ORDER BY revision', [P.hsg]));
    expect(revs).toEqual([{ revision: 1, status: 'obsolete' }, { revision: 2, status: 'released' }]);
  });
});

describe('production orders on the floor', () => {
  let mo: any;
  const op = async (n: number) => (await asActor(sup, (tx) => getOrder(tx, sup, mo.id))).operations.find((o: any) => o.op_no === n);

  it('release pins the revision, copies materials scaled with scrap allowance, and reports shortages', async () => {
    await expect(asActor(sup, (tx) => createOrder(tx, sup, { facilityId: w.facilities.A!, partId: P.bar!, qty: 1 }))).rejects.toThrow(/no released product revision/);
    mo = await asActor(sup, (tx) => createOrder(tx, sup, { facilityId: w.facilities.A!, partId: P.hsg!, qty: 20, outputLocationId: fg, dueDate: '2026-11-30' }));
    expect(mo.number).toMatch(/^MO-\d{6}$/);
    const r = await asActor(sup, (tx) => releaseOrder(tx, sup, mo.id));
    expect(r.revision).toBe(2);
    expect(r.shortages.map((s: any) => [s.part_number, s.short])).toEqual([['PLUG-SAE-6', 10]]);
    const o = await asActor(sup, (tx) => getOrder(tx, sup, mo.id));
    expect(o.materials.map((m: any) => [m.part_number, m.qty_required])).toEqual([['BAR-6061-250', 69.36], ['ORING-2-214', 42], ['PLUG-SAE-6', 20]]);
    // Released orders can request what is missing; a second request finds it already requested.
    const pr = await asActor(sup, (tx) => requestShortages(tx, sup, mo.id));
    const lines = await asActor(sup, (tx) => many(tx, 'SELECT qty::float AS qty FROM purchase_request_line WHERE request_id = $1', [pr.id]));
    expect(lines).toEqual([{ qty: 10 }]);
    await expect(asActor(sup, (tx) => requestShortages(tx, sup, mo.id))).rejects.toThrow(/already on order/);
  });

  it('materials issue through the stock ledger and can be returned', async () => {
    const o = await asActor(sup, (tx) => getOrder(tx, sup, mo.id));
    const bar = o.materials.find((m: any) => m.part_number === 'BAR-6061-250');
    await asActor(ana, (tx) => issueMaterials(tx, ana, mo.id, [{ materialId: bar.id, locationId: rm, qty: 70 }]));
    await asActor(ana, (tx) => returnMaterial(tx, ana, mo.id, { materialId: bar.id, locationId: rm, qty: 0.64 }));
    const txns = await asActor(sup, (tx) => many(tx, `SELECT txn_type, qty::float AS qty FROM inventory_txn WHERE production_order_id = $1 ORDER BY id`, [mo.id]));
    expect(txns).toEqual([{ txn_type: 'production_issue', qty: -70 }, { txn_type: 'production_return', qty: 0.64 }]);
    await expect(asActor(ana, (tx) => returnMaterial(tx, ana, mo.id, { materialId: bar.id, locationId: rm, qty: 100 }))).rejects.toThrow(/return between/);
  });

  it('a run marks the machine running; one job per machine and per person; quantities flow operation to operation', async () => {
    const o10 = await op(10);
    await expect(asActor(ana, (tx) => startOperation(tx, ana, o10.id, {}))).rejects.toThrow(/choose the machine/);
    await expect(asActor(ana, (tx) => startOperation(tx, ana, o10.id, { assetId: A.vmc! }))).rejects.toThrow(/not part of this work center/);
    const e1 = await asActor(ben, (tx) => startOperation(tx, ben, o10.id, { assetId: A.lathe! }));
    expect(await state(A.lathe!)).toBe('running');
    await expect(asActor(ana, (tx) => startOperation(tx, ana, o10.id, { assetId: A.lathe! }))).rejects.toThrow(/already running another job/);
    const o20 = await op(20);
    await expect(asActor(ben, (tx) => startOperation(tx, ben, o20.id, { assetId: A.vmc! }))).rejects.toThrow(/already has a job running/);
    await expect(asActor(ana, (tx) => startOperation(tx, ana, o10.id, { assetId: A.lathe!, employeeId: ben.employeeId }))).rejects.toThrow(/production.manage/);
    await expect(asActor(ben, (tx) => stopOperation(tx, ben, e1.id, { qtyGood: 18, qtyScrap: 1 }))).rejects.toThrow(/scrap reason/);
    await expect(asActor(ben, (tx) => stopOperation(tx, ben, e1.id, { qtyGood: 18, qtyScrap: 3, scrapReason: 'DIM' }))).rejects.toThrow(/received 20 units/);
    const r = await asActor(ben, (tx) => stopOperation(tx, ben, e1.id, { qtyGood: 18, qtyScrap: 1, scrapReason: 'DIM', note: 'Bore oversize, offset corrected' }));
    expect(r).toMatchObject({ operationDone: false, processed: 19, input: 20 });
    expect(await state(A.lathe!)).toBe('idle');
    const e2 = await asActor(sup, (tx) => startOperation(tx, sup, o10.id, { assetId: A.lathe!, employeeId: ben.employeeId }));
    expect((await asActor(sup, (tx) => stopOperation(tx, sup, e2.id, { qtyGood: 1 }))).operationDone).toBe(true);
    // Operation 20 can only take what operation 10 passed (19).
    const e3 = await asActor(ana, (tx) => startOperation(tx, ana, o20.id, { assetId: A.vmc! }));
    await expect(asActor(ana, (tx) => stopOperation(tx, ana, e3.id, { qtyGood: 20 }))).rejects.toThrow(/received 19 units from the previous operation/);
    await asActor(ana, (tx) => stopOperation(tx, ana, e3.id, { qtyGood: 19 }));
    const o30 = await op(30);
    const e4 = await asActor(ana, (tx) => startOperation(tx, ana, o30.id, {}));
    await expect(asActor(ana, (tx) => stopOperation(tx, ana, e4.id, { qtyGood: 5, qtyRework: 6 }))).rejects.toThrow(/cannot exceed the good quantity/);
    await asActor(ana, (tx) => stopOperation(tx, ana, e4.id, { qtyGood: 19, qtyRework: 2 }));
    // Finished runs are records.
    await expect(db().query('UPDATE production_entry SET qty_good = 99 WHERE id = $1', [e1.id])).rejects.toThrow(/cannot be changed/);
  });

  it('inspection on the CMM needs the operate qualification and a machine that is not down', async () => {
    const o40 = await op(40);
    await expect(asActor(ben, (tx) => startOperation(tx, ben, o40.id, { assetId: A.cmm! }))).rejects.toThrow(/not qualified to operate this asset: CMM-OP/);
    await asActor(w.admin, (tx) => recordState(tx, w.admin, A.cmm!, { state: 'unplanned_downtime' }));
    await expect(asActor(ana, (tx) => startOperation(tx, ana, o40.id, { assetId: A.cmm! }))).rejects.toThrow(/unplanned downtime; it cannot run production/);
    await asActor(w.admin, (tx) => recordState(tx, w.admin, A.cmm!, { state: 'available' }));
    const q = await asActor(ana, (tx) => floorQueue(tx, ana, WC.insp!));
    expect(q.queue.map((x: any) => [x.number, x.waiting])).toEqual([[mo.number, 19]]);
    expect(q.machines[0].requires).toEqual(['CMM-OP']);
    const e = await asActor(ana, (tx) => startOperation(tx, ana, o40.id, { assetId: A.cmm! }));
    expect((await asActor(ana, (tx) => floorQueue(tx, ana, WC.insp!))).mine.id).toBe(e.id);
    expect((await asActor(ana, (tx) => stopOperation(tx, ana, e.id, { qtyGood: 19 }))).operationDone).toBe(true);
  });

  it('finished units are received at standard material cost; short completion needs a reason; closing records the variance', async () => {
    await expect(asActor(ana, (tx) => receiveOutput(tx, ana, mo.id, { qty: 20 }))).rejects.toThrow(/only 19 finished units/);
    const r = await asActor(ana, (tx) => receiveOutput(tx, ana, mo.id, { qty: 19 }));
    expect(r).toEqual({ received: 19, complete: false });
    const t = await asActor(sup, (tx) => one(tx, `SELECT qty::float AS qty, unit_cost::float AS unit_cost FROM inventory_txn WHERE production_order_id = $1 AND txn_type = 'production_receipt'`, [mo.id]));
    expect(t.qty).toBe(19);
    expect(t.unit_cost).toBeCloseTo(3.774, 3);
    await expect(asActor(sup, (tx) => closeOrder(tx, sup, mo.id))).rejects.toThrow(/complete the order/);
    await expect(asActor(sup, (tx) => completeShort(tx, sup, mo.id, ''))).rejects.toThrow(/why the order ends short/);
    await asActor(sup, (tx) => completeShort(tx, sup, mo.id, 'One blank scrapped at turning; customer accepts 19'));
    const o = await asActor(sup, (tx) => getOrder(tx, sup, mo.id));
    expect(o.metrics).toMatchObject({ made: 19, totalScrap: 1, totalRework: 2, firstPassYield: 85 });
    // Bar was over-issued slightly; O-rings and plugs were never issued, so they show as used without a record.
    expect(o.materials.map((m: any) => [m.part_number, m.variance_qty])).toEqual([['BAR-6061-250', 3.468], ['ORING-2-214', -39.9], ['PLUG-SAE-6', -19]]);
    expect(o.metrics.materialVariance).toBeCloseTo(3.468 * 0.5 - 39.9 * 0.4 - 19 * 1.2, 2);
    await asActor(sup, (tx) => closeOrder(tx, sup, mo.id));
    expect((await db().query('SELECT status FROM production_order WHERE id = $1', [mo.id])).rows[0].status).toBe('closed');
    await expect(asActor(ana, (tx) => issueMaterials(tx, ana, mo.id, [{ materialId: o.materials[0].id, locationId: rm, qty: 1 }]))).rejects.toThrow(/order is closed/);
  });

  it('an order with nothing issued can be cancelled; the status report shows yield and scrap reasons', async () => {
    const mo2 = await asActor(sup, (tx) => createOrder(tx, sup, { facilityId: w.facilities.A!, partId: P.hsg!, qty: 5, dueDate: '2026-01-15' }));
    await asActor(sup, (tx) => releaseOrder(tx, sup, mo2.id));
    const def = getReport('production-status')!;
    const r = await asActor(sup, (tx) => def.run(tx, sup, def.params.parse({})));
    expect(r.headline).toMatch(/^1 production order late of 1 open; first-pass yield /);
    expect(r.kpis.find((k) => k.label.startsWith('Scrap rate'))!.value).toBeCloseTo(1 / 77, 3);
    expect(r.insights.join(' ')).toMatch(/Top scrap reason: Out of tolerance/);
    await asActor(sup, (tx) => cancelOrder(tx, sup, mo2.id, 'Customer pushed the order'));
  });

  it('a shortage of a part made in house asks for a production order, not a purchase', async () => {
    const kitRev = (await asActor(sup, (tx) => one(tx, `SELECT id FROM product_revision WHERE part_id = $1 AND status = 'draft'`, [P.kit])))!.id;
    await asActor(sup, (tx) => releaseRevision(tx, sup, kitRev));
    const box = await asActor(sup, (tx) => createRevision(tx, sup, { partId: P.box! }));
    await asActor(sup, async (tx) => {
      await saveRevision(tx, sup, box.id, { materials: [{ partId: P.kit!, qtyPer: 4 }], operations: [{ opNo: 10, workCenterId: WC.deburr!, description: 'Pack kits' }] });
      await releaseRevision(tx, sup, box.id);
    });
    const mo3 = await asActor(sup, (tx) => createOrder(tx, sup, { facilityId: w.facilities.A!, partId: P.box!, qty: 2 }));
    const r = await asActor(sup, (tx) => releaseOrder(tx, sup, mo3.id));
    expect(r.shortages).toEqual([expect.objectContaining({ part_number: 'KIT-AH220-SEAL', short: 8, made_in_house: true })]);
    await expect(asActor(sup, (tx) => requestShortages(tx, sup, mo3.id))).rejects.toThrow(/KIT-AH220-SEAL is made in house; create a production order instead/);
  });
});

describe('bill of materials import', () => {
  it('parses dotted, numeric and outline levels', () => {
    expect([parseLevel('0'), parseLevel('.1'), parseLevel('..2'), parseLevel('...'), parseLevel('1.2.1'), parseLevel('x')]).toEqual([0, 1, 2, 3, 2, null]);
  });

  it('an indented legacy export lands on draft revisions per parent, with unknown parts and unit mismatches rejected', async () => {
    const w2 = await makeWorld('bomimp');
    await asActor(w2.admin, async (tx) => {
      for (const [pn, uom] of [['HSG-220', 'EA'], ['BAR-6061-250', 'IN'], ['KIT-AH220-SEAL', 'EA'], ['ORING-2-214', 'EA'], ['PLUG-SAE-6', 'EA'], ['TAG-SER-01', 'EA'], ['BOX-HSG-4', 'EA']]) {
        await createPart(tx, w2.admin, { partNumber: pn!, description: pn!, uom: uom! });
      }
    });
    const content = await readFile('samples/imports/ridgeline/10_engineering_bom_indented.csv');
    const s = await stageImport(w2.admin, { target: 'boms', sourceSystem: 'legacy-erp', fileName: 'bom.csv', content });
    expect(s.stats).toMatchObject({ total: 8, errors: 2, toCreate: 5 });
    const msgs = s.preview.flatMap((p: any) => p.messages.map((m: any) => m.message));
    expect(msgs).toEqual(expect.arrayContaining([expect.stringMatching(/part "LOCTITE-567" not found/), expect.stringMatching(/file says FT but BOX-HSG-4 is stocked in EA/)]));
    await commitImport(w2.admin, s.batchId, { allowPartial: true });
    const drafts = await asActor(w2.admin, (tx) => many(tx, `SELECT p.part_number AS parent, r.status, array_agg(c.part_number ORDER BY m.line_no) AS components
      FROM product_revision r JOIN part p ON p.id = r.part_id JOIN product_material m ON m.revision_id = r.id JOIN part c ON c.id = m.part_id GROUP BY p.part_number, r.status ORDER BY 1`));
    expect(drafts).toEqual([
      { parent: 'HSG-220', status: 'draft', components: ['BAR-6061-250', 'KIT-AH220-SEAL', 'TAG-SER-01'] },
      { parent: 'KIT-AH220-SEAL', status: 'draft', components: ['ORING-2-214', 'PLUG-SAE-6'] },
    ]);
    const again = await stageImport(w2.admin, { target: 'boms', sourceSystem: 'legacy-erp', fileName: 'bom.csv', content });
    expect(again.stats).toMatchObject({ toCreate: 0, toUpdate: 0 });
  });

  it('a flat export names the parent on every row', async () => {
    const w3 = await makeWorld('bomflat');
    await asActor(w3.admin, async (tx) => { for (const pn of ['FG-1', 'C-1', 'C-2']) await createPart(tx, w3.admin, { partNumber: pn, description: pn }); });
    const content = Buffer.from('Assembly,Component,Qty Per Assembly\r\nFG-1,C-1,2\r\nFG-1,C-2,0\r\nFG-1,C-1,1\r\n');
    const s = await stageImport(w3.admin, { target: 'boms', sourceSystem: 'erp', fileName: 'flat.csv', content });
    expect(s.preview.map((p: any) => p.messages.map((m: any) => m.message).join('; '))).toEqual([
      '', 'quantity per unit must be more than zero', expect.stringMatching(/C-1 is already listed under FG-1 on row 2; combine/),
    ]);
  });
});
