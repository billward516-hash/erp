import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { listRequests } from '../src/modules/maintenance/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { saveGroup, saveSite } from '../src/modules/sites/service.js';
import {
  completeVisit, getVisit, listPoints, pointReadings, recordReading, recordVisitItem, saveConditionPoint, saveTemplate, startVisit,
} from '../src/modules/storeops/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H);
let w: World; let dm: Actor; let sm: Actor; let smId: string;
let store: any; let cooler: string; let point: any; let door: string;

beforeAll(async () => {
  w = await makeWorld('store');
  store = await asActor(w.admin, (tx) => saveSite(tx, w.admin, { code: 'S101', name: 'Store 101 Elm St', kind: 'store' }));
  const g = await asActor(w.admin, (tx) => saveGroup(tx, w.admin, { code: 'D1', name: 'District 1', kind: 'district', facilityIds: [store.id] }));
  const d = await createUserWithToken(db(), w.tenantId, { email: `dm-${Date.now()}@s.example`, displayName: 'Dee Manager', roles: [{ role: 'district_manager', facility: null, group: g.id }] });
  const s = await createUserWithToken(db(), w.tenantId, { email: `sm-${Date.now()}@s.example`, displayName: 'Sol Store', roles: [{ role: 'store_manager', facility: store.id }] });
  dm = (await loadActor(w.tenantId, d.userId))!; sm = (await loadActor(w.tenantId, s.userId))!; smId = s.userId;
  cooler = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: store.id, assetTag: 'S101-WIC', name: 'Walk-in cooler' }))).id;
  door = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: store.id, assetTag: 'S101-DOOR', name: 'Front automatic door' }))).id;
});
afterAll(closePools);

describe('condition readings', () => {
  it('limits are set by asset managers; readings are logged by store staff', async () => {
    await expect(asActor(sm, (tx) => saveConditionPoint(tx, sm, { assetId: cooler, unit: '°F', low: 33, high: 41 }))).rejects.toThrow(/assets.manage/);
    await expect(asActor(w.admin, (tx) => saveConditionPoint(tx, w.admin, { assetId: cooler, unit: '°F', low: 41, high: 33 }))).rejects.toThrow(/below the high/);
    point = await asActor(w.admin, (tx) => saveConditionPoint(tx, w.admin, { assetId: cooler, unit: '°F', low: 33, high: 41, intervalHours: 12 }));
    expect(await asActor(sm, (tx) => recordReading(tx, sm, point.id, { value: 37, readAt: ago(30) }))).toMatchObject({ inRange: true, excursion: null });
  });

  it('a warm cooler opens one excursion and one request however many warm readings follow; back in range closes it', async () => {
    const first = await asActor(sm, (tx) => recordReading(tx, sm, point.id, { value: 44, readAt: ago(20), note: 'Door was propped open' }));
    expect(first).toMatchObject({ inRange: false, excursion: { opened: true } });
    await asActor(sm, (tx) => recordReading(tx, sm, point.id, { value: 47.5, readAt: ago(14) }));
    await asActor(sm, (tx) => recordReading(tx, sm, point.id, { value: 45, readAt: ago(8) }));
    const reqs = (await asActor(dm, (tx) => listRequests(tx, dm))).filter((r: any) => r.asset_id === cooler);
    expect(reqs.map((r: any) => [r.source, r.severity, r.symptom])).toEqual([['condition', 'high', 'Walk-in cooler (S101-WIC) temperature 44°F, limit 33–41°F. Note: Door was propped open']]);
    expect((await asActor(sm, (tx) => listPoints(tx, sm)))[0]).toMatchObject({ state: 'out', worst_value: 47.5, last_value: 45 });
    const back = await asActor(sm, (tx) => recordReading(tx, sm, point.id, { value: 39, readAt: ago(2) }));
    expect(back.excursion).toMatchObject({ closed: true });
    const h = await asActor(sm, (tx) => pointReadings(tx, sm, point.id));
    expect(h.excursions[0]).toMatchObject({ first_value: 44, worst_value: 47.5, readings: 3, ended_at: expect.any(Date) });
    await expect(db().query('UPDATE condition_reading SET value = 38 WHERE point_id = $1', [point.id])).rejects.toThrow(/log/);
  });

  it('a temperature log imports through the same path, and overdue readings remind the store', async () => {
    const freezer = await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: store.id, assetTag: 'S101-WIF', name: 'Walk-in freezer' }));
    await asActor(w.admin, (tx) => saveConditionPoint(tx, w.admin, { assetId: freezer.id, unit: '°F', high: 0, intervalHours: 12 }));
    // A paper log is in store-local time (the site is in America/New_York).
    const d = (h: number) => ago(h).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16);
    const csv = Buffer.from(`Store #,Date/Time,Equipment,Temp (°F),Initials,Corrective action\n101,${d(6)},S101-WIF,-4,JR,\n101,${d(5)},S101-WIF,6,JR,Defrost stuck; called service\n101,${d(4)},S101-XYZ,3,JR,\n`);
    const st = await stageImport(w.admin, { target: 'condition_readings', sourceSystem: 'temp-log', fileName: 't.csv', content: csv });
    expect(st.preview.map((r: any) => r.status)).toEqual(['valid', 'warning', 'error']);
    await commitImport(w.admin, st.batchId, { allowPartial: true });
    const pts = await asActor(sm, (tx) => listPoints(tx, sm));
    expect(pts.find((p: any) => p.asset_tag === 'S101-WIF')).toMatchObject({ state: 'out', last_value: 6 });
    // The cooler's last reading was 2 hours ago (interval 12 h): not missed. Backdate the freezer's point so it is.
    await db().query(`UPDATE condition_point SET interval_hours = 2 WHERE asset_id = $1`, [freezer.id]);
    const counts = await runReminders(w.tenantId);
    expect(counts.readings_missed).toBeGreaterThanOrEqual(1);
    const n = await db().query(`SELECT title FROM notification WHERE user_id = $1 AND kind = 'reminder.readings_missed'`, [smId]);
    expect(n.rows[0].title).toBe('S101: 1 condition reading overdue');
  });
});

describe('site visits', () => {
  let tpl: any; let visit: any;
  it('a district manager walks a store with a checklist; failed items become requests or actions; scored against the last visit', async () => {
    tpl = await asActor(dm, (tx) => saveTemplate(tx, dm, { code: 'WALK', name: 'Monthly store walk', items: [
      { area: 'Front', text: 'Entrance clean and doors working', critical: false }, { area: 'Cold chain', text: 'Coolers and freezers in range, logs complete', critical: true },
      { area: 'Safety', text: 'Fire exits clear', critical: true }, { area: 'Back room', text: 'Back room tidy, nothing on the floor' }] }));
    await expect(asActor(sm, (tx) => startVisit(tx, sm, { facilityId: store.id, templateId: tpl.id }))).rejects.toThrow(/visits.conduct/);
    visit = await asActor(dm, (tx) => startVisit(tx, dm, { facilityId: store.id, templateId: tpl.id }));
    const v = await asActor(dm, (tx) => getVisit(tx, dm, visit.id));
    expect(v.items).toHaveLength(4);
    await expect(asActor(dm, (tx) => recordVisitItem(tx, dm, v.items[0].id, { result: 'fail' }))).rejects.toThrow(/what was wrong/);
    await asActor(dm, (tx) => recordVisitItem(tx, dm, v.items[0].id, { result: 'fail', note: 'Left door sticks half open', assetId: door }));
    await asActor(dm, (tx) => recordVisitItem(tx, dm, v.items[1].id, { result: 'pass' }));
    await expect(asActor(dm, (tx) => completeVisit(tx, dm, visit.id, {}))).rejects.toThrow(/answer every item first \(3, 4\)/);
    await asActor(dm, (tx) => recordVisitItem(tx, dm, v.items[2].id, { result: 'fail', note: 'Pallet blocking the rear exit' }));
    await asActor(dm, (tx) => recordVisitItem(tx, dm, v.items[3].id, { result: 'na' }));
    await expect(asActor(dm, (tx) => completeVisit(tx, dm, visit.id, {}))).rejects.toThrow(/who fixes/);
    expect(await asActor(dm, (tx) => completeVisit(tx, dm, visit.id, { actionOwnerUserId: smId, summary: 'Cold chain good; exits need daily checks' }))).toEqual({ score: 1 / 3, failed: 2, critical: 1 });
    const done = await asActor(sm, (tx) => getVisit(tx, sm, visit.id));
    expect(done.items.map((i: any) => [i.result, !!i.request_id, i.action_status])).toEqual([['fail', true, null], ['pass', false, null], ['fail', false, 'open'], ['na', false, null]]);
    const action = await db().query(`SELECT due_date::text, owner_user_id FROM action_item WHERE subject_type = 'site_visit' AND subject_id = $1`, [visit.id]);
    expect(action.rows[0]).toEqual({ due_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), owner_user_id: smId });
    await expect(db().query(`UPDATE site_visit_item SET result = 'pass' WHERE visit_id = $1`, [visit.id])).rejects.toThrow(/final/);
  });

  it('the next visit flags repeat failures; the standards report ranks stores', async () => {
    const v2 = await asActor(dm, (tx) => startVisit(tx, dm, { facilityId: store.id, templateId: tpl.id }));
    const items = (await asActor(dm, (tx) => getVisit(tx, dm, v2.id))).items;
    for (const i of items) await asActor(dm, (tx) => recordVisitItem(tx, dm, i.id, i.seq === 3 ? { result: 'fail', note: 'Exit blocked again' } : { result: 'pass' }));
    await asActor(dm, (tx) => completeVisit(tx, dm, v2.id, { actionOwnerUserId: smId }));
    const g = await asActor(dm, (tx) => getVisit(tx, dm, v2.id));
    expect(g.items.filter((i: any) => i.repeat).map((i: any) => i.text)).toEqual(['Fire exits clear']);
    expect(g.previous).toMatchObject({ number: visit.number });
    const def = getReport('store-standards')!;
    const r = await asActor(dm, (tx) => def.run(tx, dm, def.params.parse({})));
    expect(r.headline).toBe('1 site below the 85.0% standard on the latest visit; 2 excursions out of limits in 30 days (1 still open)');
    expect(r.rows[0]).toMatchObject({ score: 0.75, previous: 0.3333, critical: 1, excursions: 2, open_excursions: 1 });
  });
});
