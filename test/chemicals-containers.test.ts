import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createLocation, receive } from '../src/modules/inventory/service.js';
import {
  addIncompatiblePair, createContainer, disposeContainer, getContainer, listContainers, markEmpty, moveContainer, openContainer, recordUse, saveStorageGroup, setChemicalPart,
} from '../src/modules/chemicals/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';
import { chemicalWorld, daysFrom } from './chemicals-fixtures.js';

/** Containers, beyond-use dates, the storage-group rule and receiving (SC-007 C). */
const db = () => getAdminPool();
let w: World; let c: Awaited<ReturnType<typeof chemicalWorld>>;
const admin = <T>(fn: (tx: any) => Promise<T>) => asActor(w.admin, fn);
let n = 0;
/** A fresh location, so one test's chemicals never sit beside another's. */
const loc = async (facility: 'A' | 'B' = 'A') => (await admin((tx) => createLocation(tx, w.admin, { facilityId: w.facilities[facility]!, code: `${facility}-T${++n}`, name: `Test location ${n}` }))).id as string;
const ledger = async (partId: string, locationId: string) => Number((await db().query('SELECT qty_on_hand FROM inventory_balance WHERE part_id = $1 AND location_id = $2', [partId, locationId])).rows[0]?.qty_on_hand ?? 0);
const recv = (locationId: string, partId: string, lot: string, qty: number, extra: any = {}) =>
  admin((tx) => receive(tx, w.admin, { locationId, partId, qty, lots: [{ lot, qty, expiresOn: extra.expiresOn ?? null }], chemical: extra.chemical ?? null })) as Promise<any>;
const containersOf = (partId: string) => admin((tx) => listContainers(tx, w.admin, { partId, status: 'all' }));

beforeAll(async () => { w = await makeWorld('chem-c'); c = await chemicalWorld(w); });
afterAll(closePools);

describe('receiving a chemical creates containers', () => {
  it('one per received lot, with the lot expiry, and split by container size', async () => {
    const l = await loc();
    const r = await recv(l, c.acid.id, 'HCL-A1', 5, { expiresOn: daysFrom(200) });
    expect(r.containers).toHaveLength(1);
    const list = await containersOf(c.acid.id);
    expect(list[0]).toMatchObject({ lot_number: 'HCL-A1', qty: 5, uom: 'L', status: 'in_storage', expires_on: daysFrom(200), use_by: daysFrom(200) });
    expect(list[0]!.number).toMatch(/^CHM-\d{6}$/);
    const l2 = await loc();
    const split = await recv(l2, c.base.id, 'NAOH-1', 10, { expiresOn: daysFrom(400), chemical: { containerSize: 2.5 } });
    expect(split.containers).toHaveLength(4);
    expect((await containersOf(c.base.id)).map((x) => x.qty)).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(await ledger(c.base.id, l2)).toBe(10);
  });

  it('an uneven split keeps the remainder in the last container', async () => {
    const r = await recv(await loc(), c.solvent.id, 'IPA-1', 7, { chemical: { containerSize: 3 } });
    expect(r.containers).toHaveLength(3);
    const list = await containersOf(c.solvent.id);
    expect(list.map((x) => x.qty).sort()).toEqual([1, 3, 3]);
    for (const x of list) expect(x.use_by).toBeNull(); // no expiry on the lot, no in-use days applied until opened
  });

  it('ordinary parts receive exactly as before', async () => {
    const l = await loc();
    const r: any = await admin((tx) => receive(tx, w.admin, { locationId: l, partId: c.plain.id, qty: 12, unitCost: 1 }));
    expect(r.containers).toBeUndefined();
    expect(r).toMatchObject({ balanceAfter: 12 });
    expect(Object.keys(r).sort()).toEqual(['balanceAfter', 'location', 'lots', 'part', 'txnId']);
    expect(await ledger(c.plain.id, l)).toBe(12);
    expect((await db().query('SELECT count(*)::int AS n FROM chemical_container WHERE part_id = $1', [c.plain.id])).rows[0].n).toBe(0);
  });

  it('the company can switch container creation off', async () => {
    await db().query('UPDATE chemical_setting SET receipt_containers = false WHERE tenant_id = $1', [w.tenantId]);
    const r = await recv(await loc(), c.oxidizer.id, 'PEROX-0', 2, { expiresOn: daysFrom(100) });
    expect(r.containers).toBeUndefined();
    await db().query('UPDATE chemical_setting SET receipt_containers = true WHERE tenant_id = $1', [w.tenantId]);
  });
});

describe('opening: beyond-use date', () => {
  it('is opened date plus in-use days', async () => {
    const r = await recv(await loc(), c.acid.id, 'HCL-OPEN', 2, { expiresOn: daysFrom(300) });
    const id = r.containers[0].id;
    const opened = await admin((tx) => openContainer(tx, w.admin, id, { openedOn: daysFrom(-10) }));
    expect(opened).toEqual({ openedOn: daysFrom(-10), beyondUseOn: daysFrom(20) });
    const got = await admin((tx) => getContainer(tx, w.admin, id));
    expect(got).toMatchObject({ status: 'in_use', in_use_days: 30, beyond_use_on: daysFrom(20), use_by: daysFrom(20) });
    expect(got.events.map((e: any) => e.kind)).toEqual(['created', 'opened']);
    await expect(admin((tx) => openContainer(tx, w.admin, id))).rejects.toThrow(/in use/);
  });

  it('never goes past the lot expiry', async () => {
    const r = await recv(await loc(), c.acid.id, 'HCL-SHORT', 1, { expiresOn: daysFrom(12) });
    const opened = await admin((tx) => openContainer(tx, w.admin, r.containers[0].id));
    expect(opened.beyondUseOn).toBe(daysFrom(12)); // 30 in-use days would be later than the expiry
    expect((await admin((tx) => getContainer(tx, w.admin, r.containers[0].id))).state).toBe('ok');
  });

  it('an expired container cannot be opened or used, and shows as past use-by', async () => {
    const r = await recv(await loc(), c.base.id, 'NAOH-OLD', 1, { expiresOn: daysFrom(40) });
    const id = r.containers[0].id;
    await db().query('UPDATE stock_lot SET expires_on = $2 WHERE number = $1', ['NAOH-OLD', daysFrom(-3)]);
    await db().query('UPDATE chemical_container SET expires_on = $2 WHERE id = $1', [id, daysFrom(-3)]);
    await expect(admin((tx) => openContainer(tx, w.admin, id))).rejects.toThrow(/passed its use-by date/);
    await expect(admin((tx) => recordUse(tx, w.admin, id, { qty: 0.1, reference: 'TEST-1' }))).rejects.toThrow(/passed its use-by date/);
    expect((await admin((tx) => getContainer(tx, w.admin, id))).state).toBe('expired');
  });

  it('a container opened and left past its beyond-use date reads as beyond use', async () => {
    const r = await recv(await loc(), c.acid.id, 'HCL-LONG', 1, { expiresOn: daysFrom(300) });
    await admin((tx) => openContainer(tx, w.admin, r.containers[0].id, { openedOn: daysFrom(-45) }));
    const got = await admin((tx) => getContainer(tx, w.admin, r.containers[0].id));
    expect(got).toMatchObject({ state: 'beyond_use', beyond_use_on: daysFrom(-15) });
  });
});

describe('use, empty and disposal post the ledger', () => {
  it('drawing from a container reduces it and the stock; the last of it marks it empty', async () => {
    const l = await loc();
    const id = (await recv(l, c.oxidizer.id, 'PEROX-U1', 2, { expiresOn: daysFrom(90) })).containers[0].id;
    await admin((tx) => recordUse(tx, w.admin, id, { qty: 0.5, reference: 'Etch bath 4' }));
    let got = await admin((tx) => getContainer(tx, w.admin, id));
    expect(got).toMatchObject({ qty: 1.5, status: 'in_use' });
    expect(got.opened_on).toBeTruthy(); // using it opened it
    expect(await ledger(c.oxidizer.id, l)).toBe(1.5);
    await expect(admin((tx) => recordUse(tx, w.admin, id, { qty: 5, reference: 'x' }))).rejects.toThrow(/holds only 1.5/);
    await admin((tx) => recordUse(tx, w.admin, id, { qty: 1.5, reference: 'Etch bath 4' }));
    got = await admin((tx) => getContainer(tx, w.admin, id));
    expect(got).toMatchObject({ qty: 0, status: 'empty' });
    expect(await ledger(c.oxidizer.id, l)).toBe(0);
  });

  it('registering a container cannot hold more than the ledger and the other containers allow', async () => {
    const l = await loc();
    await recv(l, c.oxidizer.id, 'PEROX-R1', 2, { expiresOn: daysFrom(90) }); // one container of 2 L already
    await expect(admin((tx) => createContainer(tx, w.admin, { partId: c.oxidizer.id, locationId: l, lot: 'PEROX-R1', qty: 1 }))).rejects.toThrow(/ledger holds 2.*already account for 2/);
    await expect(admin((tx) => createContainer(tx, w.admin, { partId: c.oxidizer.id, locationId: l, lot: 'NOPE', qty: 1 }))).rejects.toThrow(/not in stock/);
    const l2 = await loc();
    const made = await admin((tx) => createContainer(tx, w.admin, { partId: c.oxidizer.id, locationId: l2, lot: 'PEROX-R2', qty: 4, receiveIntoStock: true, expiresOn: daysFrom(90) }));
    expect(made.containers).toHaveLength(1);
    expect(await ledger(c.oxidizer.id, l2)).toBe(4);
  });

  it('registering against stock already on the ledger works when the lot is there', async () => {
    const l = await loc();
    await admin((tx) => receive(tx, w.admin, { locationId: l, partId: c.solvent.id, qty: 3, lots: [{ lot: 'IPA-LEG', qty: 3 }] })); // containers on, so one is made by the receipt
    await db().query(`DELETE FROM chemical_container_event WHERE container_id IN (SELECT id FROM chemical_container WHERE lot_number = 'IPA-LEG')`);
    await db().query(`DELETE FROM chemical_container WHERE lot_number = 'IPA-LEG'`);
    const made = await admin((tx) => createContainer(tx, w.admin, { partId: c.solvent.id, locationId: l, lot: 'IPA-LEG', qty: 3 }));
    expect(made.containers).toHaveLength(1);
    expect(await ledger(c.solvent.id, l)).toBe(3);
  });

  it('marking empty writes off what is left; disposal needs a note and keeps the date', async () => {
    const l = await loc();
    const a = (await admin((tx) => createContainer(tx, w.admin, { partId: c.solvent.id, locationId: l, lot: 'IPA-2', qty: 2, receiveIntoStock: true, expiresOn: daysFrom(300) }))).containers[0].id;
    await admin((tx) => markEmpty(tx, w.admin, a));
    expect(await ledger(c.solvent.id, l)).toBe(0);
    expect(await admin((tx) => getContainer(tx, w.admin, a))).toMatchObject({ status: 'empty', qty: 0 });
    const b = (await admin((tx) => createContainer(tx, w.admin, { partId: c.solvent.id, locationId: l, lot: 'IPA-3', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(300) }))).containers[0].id;
    await expect(admin((tx) => disposeContainer(tx, w.admin, b, { note: '' }))).rejects.toThrow(/how it was disposed/);
    await admin((tx) => disposeContainer(tx, w.admin, b, { note: 'Collected by waste contractor, drum 4' }));
    const got = await admin((tx) => getContainer(tx, w.admin, b));
    expect(got).toMatchObject({ status: 'disposed', qty: 0, disposal_note: 'Collected by waste contractor, drum 4' });
    expect(got.disposed_on).toBeTruthy();
    expect(await ledger(c.solvent.id, l)).toBe(0);
    const adj = await db().query(`SELECT reason FROM inventory_txn WHERE part_id = $1 AND txn_type = 'adjustment' ORDER BY id DESC LIMIT 1`, [c.solvent.id]);
    expect(adj.rows[0].reason).toMatch(/Disposed: Collected/);
    await expect(admin((tx) => disposeContainer(tx, w.admin, b, { note: 'again please' }))).rejects.toThrow(/already disposed/);
  });
});

describe('the storage-group rule', () => {
  it('refuses a base beside an acid, naming the pair, and leaves nothing behind', async () => {
    const l = await loc('B');
    await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: l, lot: 'HCL-B1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }));
    const err = await recv(l, c.base.id, 'NAOH-B1', 1, { expiresOn: daysFrom(200) }).catch((e) => e);
    expect(err.code).toBe('incompatible_storage');
    expect(err.message).toMatch(/NAOH-50 is in storage group BASE \(Bases\), and B-T\d+ already holds HCL-37 in storage group ACID \(Acids\)/);
    expect(err.details.pairs[0]).toMatchObject({ groupCode: 'ACID', newGroupCode: 'BASE', containerNumber: expect.stringMatching(/^CHM-/) });
    expect(await ledger(c.base.id, l)).toBe(0);
    const reg = await admin((tx) => createContainer(tx, w.admin, { partId: c.base.id, locationId: l, lot: 'NAOH-B2', qty: 1, receiveIntoStock: true })).catch((e) => e);
    expect(reg.code).toBe('incompatible_storage');
  });

  it('refuses moving a container the same way, and allows a compatible location; the move posts the ledger', async () => {
    const acidLoc = await loc(); const baseLoc = await loc(); const freeLoc = await loc();
    await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: acidLoc, lot: 'HCL-M1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }));
    const baseBox = (await admin((tx) => createContainer(tx, w.admin, { partId: c.base.id, locationId: baseLoc, lot: 'NAOH-M1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }))).containers[0].id;
    await expect(admin((tx) => moveContainer(tx, w.admin, baseBox, { toLocationId: acidLoc }))).rejects.toMatchObject({ code: 'incompatible_storage' });
    expect(await ledger(c.base.id, baseLoc)).toBe(1); // refused: nothing moved
    await admin((tx) => moveContainer(tx, w.admin, baseBox, { toLocationId: freeLoc }));
    expect((await admin((tx) => getContainer(tx, w.admin, baseBox))).location_id).toBe(freeLoc);
    expect(await ledger(c.base.id, baseLoc)).toBe(0);
    expect(await ledger(c.base.id, freeLoc)).toBe(1);
    const lot = await db().query(`SELECT lb.qty FROM lot_balance lb JOIN stock_lot l ON l.id = lb.lot_id WHERE l.number = 'NAOH-M1' AND lb.location_id = $1`, [freeLoc]);
    expect(Number(lot.rows[0].qty)).toBe(1);
  });

  it('an override needs the permission and a reason, and is audited with the pair', async () => {
    const acidLoc = await loc(); const baseLoc = await loc();
    await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: acidLoc, lot: 'HCL-O1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }));
    const baseBox = (await admin((tx) => createContainer(tx, w.admin, { partId: c.base.id, locationId: baseLoc, lot: 'NAOH-O1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }))).containers[0].id;
    // The plant A manager keeps chemicals but does not hold the override permission.
    await expect(asActor(w.managerA, (tx) => moveContainer(tx, w.managerA, baseBox, { toLocationId: acidLoc, overrideReason: 'Short of space this week' }))).rejects.toMatchObject({ status: 403 });
    await expect(admin((tx) => moveContainer(tx, w.admin, baseBox, { toLocationId: acidLoc, overrideReason: 'x' }))).rejects.toThrow(/reason/);
    await asActor(w.ehsA, (tx) => moveContainer(tx, w.ehsA, baseBox, { toLocationId: acidLoc, overrideReason: 'Short of space; separate secondary containment fitted' }));
    const got = await admin((tx) => getContainer(tx, w.admin, baseBox));
    expect(got.location_id).toBe(acidLoc);
    expect(got.events.map((e: any) => e.kind)).toContain('override');
    const ev = await db().query(`SELECT data, actor_user_id FROM audit_event WHERE tenant_id = $1 AND action = 'chemical.storage_override' AND entity_id = $2`, [w.tenantId, baseBox]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].actor_user_id).toBe(w.ehsA.userId);
    expect(ev.rows[0].data).toMatchObject({ reason: expect.stringMatching(/separate secondary containment/), pairs: [{ groupCode: 'ACID', newGroupCode: 'BASE' }] });
  });

  it('an override at receiving is allowed for the holder and recorded the same way', async () => {
    const l = await loc();
    await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: l, lot: 'HCL-O2', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }));
    const r = await recv(l, c.base.id, 'NAOH-O2', 1, { expiresOn: daysFrom(200), chemical: { overrideReason: 'Receiving dock overflow, moving tomorrow' } });
    const ev = await db().query(`SELECT 1 FROM audit_event WHERE tenant_id = $1 AND action = 'chemical.storage_override' AND entity_id = $2`, [w.tenantId, r.containers[0].id]);
    expect(ev.rows).toHaveLength(1);
  });

  it('the pair list is editable: a removed pair is not enforced', async () => {
    const l = await loc(); const l2 = await loc();
    await admin((tx) => createContainer(tx, w.admin, { partId: c.solvent.id, locationId: l, lot: 'IPA-R1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }));
    const ox = (await admin((tx) => createContainer(tx, w.admin, { partId: c.oxidizer.id, locationId: l2, lot: 'PEROX-R9', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(100) }))).containers[0].id;
    await expect(admin((tx) => moveContainer(tx, w.admin, ox, { toLocationId: l }))).rejects.toThrow(/OXID.*incompatible list|FLAM.*incompatible list/);
    const pairs = await db().query(`SELECT i.id FROM chemical_incompatibility i JOIN chemical_storage_group a ON a.id = i.group_a JOIN chemical_storage_group b ON b.id = i.group_b WHERE i.tenant_id = $1 AND a.code IN ('OXID','FLAM') AND b.code IN ('OXID','FLAM')`, [w.tenantId]);
    expect(pairs.rows).toHaveLength(1);
    await db().query('DELETE FROM chemical_incompatibility WHERE id = $1', [pairs.rows[0].id]);
    await admin((tx) => moveContainer(tx, w.admin, ox, { toLocationId: l }));
    // Add it back through the service.
    const g = await admin((tx) => saveStorageGroup(tx, w.admin, { code: 'WATERREACT', name: 'Water reactive' }));
    await expect(admin((tx) => addIncompatiblePair(tx, w.admin, { groupA: g.id, groupB: g.id }))).rejects.toThrow(/two different/);
    await admin((tx) => addIncompatiblePair(tx, w.admin, { groupA: c.g('OXID'), groupB: c.g('FLAM'), reason: 'back again' }));
    await expect(admin((tx) => addIncompatiblePair(tx, w.admin, { groupA: c.g('FLAM'), groupB: c.g('OXID') }))).rejects.toThrow(/already on the list/);
  });

  it('a part with no storage group is not checked, and a chemical must be lot tracked', async () => {
    const free = await c.part('ACE-1', 'Acetone', 'L', { hazardClasses: ['flammable'], casNumber: '67-64-1' });
    const l = await loc();
    await admin((tx) => createContainer(tx, w.admin, { partId: c.acid.id, locationId: l, lot: 'HCL-N1', qty: 1, receiveIntoStock: true, expiresOn: daysFrom(200) }));
    const made = await admin((tx) => createContainer(tx, w.admin, { partId: free.id, locationId: l, lot: 'ACE-L1', qty: 1, receiveIntoStock: true }));
    expect(made.containers).toHaveLength(1);
    await expect(admin((tx) => setChemicalPart(tx, w.admin, c.plain.id, { isChemical: true }))).rejects.toThrow(/tracked by lot/);
  });
});
