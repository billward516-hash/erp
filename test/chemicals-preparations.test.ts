import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import { getContainer } from '../src/modules/chemicals/service.js';
import { chemicalLabelsPdf, createPreparation, discardPreparation, getPreparation, listPreparations, usePreparation } from '../src/modules/chemicals/preparations.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { chemicalWorld, daysFrom } from './chemicals-fixtures.js';

/** Reagent and standard preparations (SC-007 C). */
const db = () => getAdminPool();
let w: World; let c: Awaited<ReturnType<typeof chemicalWorld>>; let loc: string;
const admin = <T>(fn: (tx: any) => Promise<T>) => asActor(w.admin, fn);
const ledger = async (partId: string) => Number((await db().query('SELECT coalesce(sum(qty_on_hand), 0) AS q FROM inventory_balance WHERE part_id = $1 AND location_id = $2', [partId, loc])).rows[0].q);
const box = async (partId: string, lot: string, qty: number, expiresOn: string | null, at = loc) =>
  ((await admin((tx) => receive(tx, w.admin, { locationId: at, partId, qty, lots: [{ lot, qty, expiresOn }] }))) as any).containers[0].id as string;

beforeAll(async () => {
  w = await makeWorld('chem-p'); c = await chemicalWorld(w);
  loc = (await admin((tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-LAB', name: 'Lab store' }))).id;
});
afterAll(closePools);

describe('a preparation', () => {
  it('records what went in, who made it, and expires with the earliest component or the shelf life', async () => {
    const hcl = await box(c.acid.id, 'HCL-P1', 2, daysFrom(200));      // 30 in-use days once opened
    const ipa = await box(c.solvent.id, 'IPA-P1', 2, daysFrom(15));   // expiry in 15 days
    const prep = await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: '0.1 M HCl in IPA', kind: 'reagent', concentration: '0.1 M', qty: 1, uom: 'L',
      shelfLifeDays: 90, components: [{ containerId: hcl, qty: 0.1 }, { containerId: ipa, qty: 0.9 }] }));
    expect(prep.number).toMatch(/^PREP-\d{5}$/);
    expect(prep).toMatchObject({ name: '0.1 M HCl in IPA', kind: 'reagent', status: 'active', prepared_by_name: 'admin', prepared_on: daysFrom(0), qty_remaining: 1, shelf_life_days: 90 });
    // Earliest of: HCl opened today + 30 days, IPA expiry in 15 days, shelf life 90 days.
    expect(prep.expires_on).toBe(daysFrom(15));
    expect(prep.components.map((x: any) => [x.part_number, x.qty, x.use_by])).toEqual([['HCL-37', 0.1, daysFrom(30)], ['IPA-99', 0.9, daysFrom(15)]]);
    // The containers were opened by use, reduced, and the ledger followed.
    expect(await admin((tx) => getContainer(tx, w.admin, hcl))).toMatchObject({ qty: 1.9, status: 'in_use', beyond_use_on: daysFrom(30) });
    expect(await ledger(c.acid.id)).toBe(1.9);
    expect(await ledger(c.solvent.id)).toBe(1.1);
  });

  it('a short stated shelf life wins over longer component dates', async () => {
    const hcl = await box(c.acid.id, 'HCL-P2', 2, daysFrom(200));
    const p = await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Rinse', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 7, components: [{ containerId: hcl, qty: 0.1 }] }));
    expect(p.expires_on).toBe(daysFrom(7));
  });

  it('with no component date and no shelf life it is refused; nothing is drawn', async () => {
    const ace = await c.part('ACE-2', 'Acetone, no in-use limit', 'L', { hazardClasses: ['flammable'] }); // no in-use days
    const ipa = await box(ace.id, 'ACE-P2', 1, null);
    const before = await ledger(ace.id);
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Wash', kind: 'reagent', qty: 1, uom: 'L', components: [{ containerId: ipa, qty: 0.2 }] }))).rejects.toThrow(/give the shelf life/);
    expect(await ledger(ace.id)).toBe(before);
    expect((await admin((tx) => getContainer(tx, w.admin, ipa))).status).toBe('in_storage'); // the opening rolled back too
  });

  it('refuses an expired or beyond-use container, more than a container holds, and a duplicate', async () => {
    const baseLoc = (await admin((tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-LAB-BASE', name: 'Lab base cabinet' }))).id;
    const old = await box(c.base.id, 'NAOH-P1', 1, daysFrom(30), baseLoc);
    await db().query('UPDATE chemical_container SET expires_on = $2 WHERE id = $1', [old, daysFrom(-1)]);
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Caustic', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: old, qty: 0.1 }] }))).rejects.toThrow(/passed its use-by date/);
    const ok = await box(c.base.id, 'NAOH-P2', 1, daysFrom(300), baseLoc);
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Caustic', kind: 'reagent', qty: 1, uom: 'L', components: [{ containerId: ok, qty: 5 }] }))).rejects.toThrow(/holds only 1/);
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Caustic', kind: 'reagent', qty: 1, uom: 'L', components: [{ containerId: ok, qty: 0.2 }, { containerId: ok, qty: 0.2 }] }))).rejects.toThrow(/listed twice/);
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Caustic', kind: 'reagent', qty: 1, uom: 'L', components: [] }))).rejects.toThrow(/what went into it/);
    // A held lot cannot be used either.
    await db().query(`UPDATE stock_lot SET status = 'hold', hold_reason = 'recall' WHERE number = 'NAOH-P2'`);
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Caustic', kind: 'reagent', qty: 1, uom: 'L', components: [{ containerId: ok, qty: 0.2 }] }))).rejects.toThrow(/on hold/);
  });

  it('a working standard can be made from a stock standard, and its expiry follows the stock', async () => {
    const hcl = await box(c.acid.id, 'HCL-P3', 5, daysFrom(400));
    const stock = await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Stock standard 1000 ppm', kind: 'standard', qty: 1, uom: 'L', shelfLifeDays: 20, components: [{ containerId: hcl, qty: 0.5 }] }));
    const work = await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Working standard 10 ppm', kind: 'standard', qty: 0.5, uom: 'L', shelfLifeDays: 60, components: [{ preparationId: stock.id, qty: 0.25 }] }));
    expect(work.expires_on).toBe(daysFrom(20));
    expect(work.components[0]).toMatchObject({ source_number: stock.number, qty: 0.25 });
    expect((await admin((tx) => getPreparation(tx, w.admin, stock.id))).qty_remaining).toBe(0.75);
    await expect(admin((tx) => usePreparation(tx, w.admin, stock.id, { qty: 5 }))).rejects.toThrow(/0.75/);
    await admin((tx) => usePreparation(tx, w.admin, stock.id, { qty: 0.75, note: 'Calibration run 12' }));
    expect((await admin((tx) => getPreparation(tx, w.admin, stock.id))).status).toBe('used_up');
    await expect(admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Again', kind: 'standard', qty: 1, uom: 'L', components: [{ preparationId: stock.id, qty: 0.1 }] }))).rejects.toThrow(/used up/);
  });

  it('discarding keeps the record; an expired active preparation is flagged', async () => {
    const hcl = await box(c.acid.id, 'HCL-P4', 3, daysFrom(400));
    const p = await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Buffer', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: hcl, qty: 0.1 }] }));
    await db().query(`UPDATE chemical_preparation SET expires_on = $2 WHERE id = $1`, [p.id, daysFrom(-2)]);
    const listed = (await admin((tx) => listPreparations(tx, w.admin, {}))).find((x) => x.id === p.id)!;
    expect(listed.expired).toBe(true);
    await expect(admin((tx) => usePreparation(tx, w.admin, p.id, { qty: 0.1 }))).rejects.toThrow(/expired/);
    await expect(admin((tx) => discardPreparation(tx, w.admin, p.id, { note: '' }))).rejects.toThrow(/how it was discarded/);
    await admin((tx) => discardPreparation(tx, w.admin, p.id, { note: 'Expired, poured to acid waste' }));
    expect(await admin((tx) => getPreparation(tx, w.admin, p.id))).toMatchObject({ status: 'discarded', discard_note: 'Expired, poured to acid waste' });
    expect((await admin((tx) => listPreparations(tx, w.admin, {}))).some((x) => x.id === p.id)).toBe(false);
  });

  it('only a chemical manager at the site can make one, and the audit trail names the components', async () => {
    const hcl = await box(c.acid.id, 'HCL-P5', 3, daysFrom(400));
    await expect(asActor(w.techA, (tx) => createPreparation(tx, w.techA, { facilityId: w.facilities.A!, name: 'Nope', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: hcl, qty: 0.1 }] }))).rejects.toMatchObject({ status: 403 });
    await expect(asActor(w.operatorB, (tx) => createPreparation(tx, w.operatorB, { facilityId: w.facilities.A!, name: 'Nope', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: hcl, qty: 0.1 }] }))).rejects.toMatchObject({ status: 403 });
    const p = await asActor(w.managerA, (tx) => createPreparation(tx, w.managerA, { facilityId: w.facilities.A!, name: 'Manager buffer', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: hcl, qty: 0.1 }] }));
    const ev = await db().query(`SELECT data FROM audit_event WHERE tenant_id = $1 AND action = 'chemical.preparation_made' AND entity_id = $2`, [w.tenantId, p.id]);
    expect(ev.rows[0].data.components).toEqual([{ from: expect.stringMatching(/^CHM-/), qty: 0.1 }]);
  });
});

describe('labels', () => {
  it('container and preparation labels use the Code 128 sheet', async () => {
    const hcl = await box(c.acid.id, 'HCL-L1', 1, daysFrom(100));
    const p = await admin((tx) => createPreparation(tx, w.admin, { facilityId: w.facilities.A!, name: 'Label test', kind: 'reagent', qty: 1, uom: 'L', shelfLifeDays: 5, components: [{ containerId: hcl, qty: 0.1 }] }));
    const a = await admin((tx) => chemicalLabelsPdf(tx, w.admin, { kind: 'container', ids: [hcl] }));
    const b = await admin((tx) => chemicalLabelsPdf(tx, w.admin, { kind: 'preparation', ids: [p.id] }));
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(b.subarray(0, 5).toString()).toBe('%PDF-');
    await expect(asActor(w.operatorB, (tx) => chemicalLabelsPdf(tx, w.operatorB, { kind: 'container', ids: [hcl] }))).rejects.toMatchObject({ status: 403 });
  });
});
