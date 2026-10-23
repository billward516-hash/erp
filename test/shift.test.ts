import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset, recordState } from '../src/modules/assets/service.js';
import { createWorkOrder } from '../src/modules/maintenance/service.js';
import { createNcr } from '../src/modules/quality/service.js';
import { acknowledge, defaultShift, getHandover, handOver, listHandovers, saveHandover, startHandover } from '../src/modules/shift/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World; let site: string; let pump: string;

beforeAll(async () => {
  w = await makeWorld('shift');
  site = w.facilities.A!;
  await asActor(w.managerA, async (tx) => {
    pump = (await createAsset(tx, w.managerA, { facilityId: site, assetTag: 'PMP-9', name: 'Coolant pump' })).id;
    await recordState(tx, w.managerA, pump, { state: 'unplanned_downtime', at: new Date(Date.now() - 2 * 3_600_000), reasonCode: 'MECH' });
    await createWorkOrder(tx, w.managerA, { assetId: pump, title: 'Pump seized', priority: 1 });
  });
  await asActor(w.qualityA, (tx) => createNcr(tx, w.qualityA, { facilityId: site, description: 'Burr on 12 housings', qty: 12 }));
});
afterAll(closePools);

describe('default shift', () => {
  it('names the shift by the site\'s local hour', () => {
    expect(defaultShift(new Date('2026-10-22T18:30:00Z'), 'America/New_York')).toMatchObject({ label: '1st', end: new Date('2026-10-22T18:30:00Z'), start: new Date('2026-10-22T10:30:00Z') });
    expect(defaultShift(new Date('2026-10-22T22:05:00Z'), 'America/New_York').label).toBe('2nd');
    expect(defaultShift(new Date('2026-10-23T05:00:00Z'), 'America/New_York').label).toBe('3rd');
  });
});

describe('shift handover', () => {
  it('compiles facts, carries notes and items, is frozen when handed over, and is acknowledged by the next shift', async () => {
    await expect(asActor(w.exec, (tx) => startHandover(tx, w.exec, { facilityId: site }))).rejects.toThrow(/work_orders.execute/);
    const h = await asActor(w.techA, (tx) => startHandover(tx, w.techA, { facilityId: site, area: 'Machining', shiftLabel: '1st' }));
    expect(h.facts.machinesDown.map((m: any) => m.asset_tag)).toEqual(['PMP-9']);
    expect(h.facts.urgentWork.map((x: any) => x.title)).toEqual(['Pump seized']);
    expect(h.facts.ncrs).toHaveLength(1);
    // Starting again returns the same draft.
    expect((await asActor(w.techA, (tx) => startHandover(tx, w.techA, { facilityId: site, area: 'Machining' }))).id).toBe(h.id);
    await asActor(w.techA, (tx) => saveHandover(tx, w.techA, h.id, { notes: 'Pump down since 10:00; spare on order', safetyNotes: 'Coolant on floor by VMC, coned off',
      items: [{ category: 'equipment', text: 'Pump PMP-9 seized, waiting on seal kit', assetId: pump }, { category: 'safety', text: 'Coolant spill by VMC' },
        { category: 'other', text: 'Forklift battery swapped', resolved: true, resolvedNote: 'Done at 11:00' }] }));
    await expect(asActor(w.techA, (tx) => saveHandover(tx, w.techA, h.id, { items: [{ category: 'other', text: 'x', resolved: true }] }))).rejects.toThrow(/how the item was resolved/);
    await asActor(w.techA, (tx) => handOver(tx, w.techA, h.id));
    expect((await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'shift.handed_over'`, [w.managerA.userId])).rows[0].n).toBe(1);
    await expect(asActor(w.techA, (tx) => saveHandover(tx, w.techA, h.id, { notes: 'later edit' }))).rejects.toThrow(/handed over/);
    await expect(db().query(`UPDATE shift_handover SET notes = 'x' WHERE id = $1`, [h.id])).rejects.toThrow(/cannot be changed/);
    await expect(asActor(w.techA, (tx) => acknowledge(tx, w.techA, h.id))).rejects.toThrow(/incoming shift/);
    await asActor(w.tech2A, (tx) => acknowledge(tx, w.tech2A, h.id, 'Read; will chase the seal kit'));
    const v = await asActor(w.exec, (tx) => getHandover(tx, w.exec, h.id));
    expect(v).toMatchObject({ status: 'acknowledged', ack_note: 'Read; will chase the seal kit', canWrite: false });
    expect(v.items.map((i: any) => [i.category, i.resolved])).toEqual([['safety', false], ['equipment', false], ['other', true]]);
    // The next shift's log starts with the two open items carried in.
    const next = await asActor(w.tech2A, (tx) => startHandover(tx, w.tech2A, { facilityId: site, area: 'Machining', shiftLabel: '2nd' }));
    const carried = (await asActor(w.tech2A, (tx) => getHandover(tx, w.tech2A, next.id))).items;
    expect(carried.map((i: any) => i.text)).toEqual(['Coolant spill by VMC', 'Pump PMP-9 seized, waiting on seal kit']);
    expect(carried[0].carried_from).toMatch(/^1st \d{4}-\d{2}-\d{2}$/);
    // Another area starts clean.
    const other = await asActor(w.tech2A, (tx) => startHandover(tx, w.tech2A, { facilityId: site, area: 'Assembly' }));
    expect((await asActor(w.tech2A, (tx) => getHandover(tx, w.tech2A, other.id))).items).toEqual([]);
    expect((await asActor(w.managerA, (tx) => listHandovers(tx, w.managerA, { facilityId: site }))).map((x) => [x.area, x.status, x.open_items])).toEqual([
      ['Assembly', 'draft', 0], ['Machining', 'draft', 2], ['Machining', 'acknowledged', 2]]);
  });
});
