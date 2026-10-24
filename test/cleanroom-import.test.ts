import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { getRoom, saveRoom, savePoint } from '../src/modules/cleanroom/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { suggestMapping } from '../src/modules/imports/mapping/suggest.js';
import { cleanroomReadingsTarget } from '../src/modules/imports/targets/cleanroom.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** SC-007 A: the particle-counter file goes through the imports pipeline and the same excursion rules as a reading typed in the app. */
const db = () => getAdminPool();
let w: World; let r5: any; let r7: any;
const sample = readFileSync('samples/imports/cleanroom/particle-counter-export.csv');

beforeAll(async () => {
  w = await makeWorld('cr-import');
  r5 = await asActor(w.admin, (tx) => saveRoom(tx, w.admin, { facilityId: w.facilities.A!, code: 'CR-5A', name: 'Fill suite', isoClass: 5, ownerUserId: w.opsA.userId }));
  await asActor(w.admin, (tx) => savePoint(tx, w.admin, r5.id, { label: 'P1 Fill line', channels: ['p0_3', 'p0_5', 'p1', 'p5', 'dp', 'temp', 'rh'], intervalHours: 12 }));
  r7 = await asActor(w.admin, (tx) => saveRoom(tx, w.admin, { facilityId: w.facilities.A!, code: 'CR-7B', name: 'Gowning', isoClass: 7, ownerUserId: w.opsA.userId }));
  await asActor(w.admin, (tx) => savePoint(tx, w.admin, r7.id, { label: 'P1 Gowning', channels: ['p0_5', 'p1', 'p5', 'dp', 'temp', 'rh'], intervalHours: 12 }));
});
afterAll(closePools);

describe('mapping common header spellings', () => {
  const map = (columns: string[]) => Object.fromEntries(Object.entries(suggestMapping(cleanroomReadingsTarget, columns, []).mapping.fields).map(([k, v]) => [k, v.source]));
  it('maps the bundled sample file by itself', () => {
    const cols = readFileSync('samples/imports/cleanroom/particle-counter-export.csv', 'utf8').split('\n')[0]!.split(',');
    expect(map(cols)).toEqual({ read_at: 'Sample Time', room: 'Room', point: 'Sample Point', p0_3: '0.3um', p0_5: '0.5um', p1: '1.0um', p5: '5.0um', dp_pa: 'DP (Pa)', temp_c: 'Temp (C)', rh_pct: 'RH (%)', initials: 'Operator' });
  });
  it('maps other spellings counters and monitoring systems use', () => {
    expect(map(['Date/Time', 'Location', '0.5 µm', '1 µm', '5 µm', 'Differential Pressure', 'Temperature', 'Humidity'])).toMatchObject(
      { read_at: 'Date/Time', point: 'Location', p0_5: '0.5 µm', p1: '1 µm', p5: '5 µm', dp_pa: 'Differential Pressure', temp_c: 'Temperature', rh_pct: 'Humidity' });
    expect(map(['Timestamp', 'Room / Point', '>=0.1 µm', '>=0.2 µm', '>=0.3 µm', '>=0.5 µm', 'DP', 'Temp °C', 'RH %'])).toMatchObject(
      { read_at: 'Timestamp', point: 'Room / Point', p0_1: '>=0.1 µm', p0_2: '>=0.2 µm', p0_3: '>=0.3 µm', p0_5: '>=0.5 µm', dp_pa: 'DP', temp_c: 'Temp °C', rh_pct: 'RH %' });
    expect(map(['Sample Date', 'Cleanroom', 'Sampling Point', '0.5um', '5um', 'Occupancy'])).toMatchObject({ read_at: 'Sample Date', room: 'Cleanroom', point: 'Sampling Point', p0_5: '0.5um', p5: '5um', occupancy: 'Occupancy' });
  });
});

describe('importing the sample particle-counter file', () => {
  it('previews every row, flags the ones over a limit, and rejects a point that is not set up', async () => {
    const bad = Buffer.from(`${sample.toString('utf8')}2026-10-23 08:00,CR-9Z,P1,100,100,100,0,1,1,1,XX\n2026-10-23 09:00,CR-5A,P9 Nowhere,100,100,100,0,1,1,1,XX\n`);
    const st = await stageImport(w.admin, { target: 'cleanroom_readings', sourceSystem: 'counter', fileName: 'p.csv', content: bad });
    const status = (x: string) => st.preview.filter((r: any) => r.status === x);
    expect([status('valid').length, status('warning').length, status('error').length]).toEqual([8, 3, 2]);
    const warn = status('warning').map((r: any) => r.messages.map((m: any) => m.message).join(' | '));
    expect(warn.filter((m: string) => m.includes('over an alert limit'))).toHaveLength(1);
    expect(warn.filter((m: string) => m.includes('opens an excursion and a nonconformance'))).toHaveLength(2);
    const errs = status('error').map((r: any) => r.messages.map((m: any) => m.message).join(' | '));
    expect(errs.some((m: string) => m.includes('no cleanroom "CR-9Z"'))).toBe(true);
    expect(errs.some((m: string) => m.includes('no monitoring point "P9 Nowhere" in CR-5A'))).toBe(true);
    await expect(commitImport(w.admin, st.batchId)).rejects.toThrow(/have errors/);
  });

  it('commits through the app\'s own path: one nonconformance for the two action rows in a row, times read in the site\'s time zone', async () => {
    const st = await stageImport(w.admin, { target: 'cleanroom_readings', sourceSystem: 'counter', fileName: 'particle-counter-export.csv', content: sample });
    expect(st.preview.every((r: any) => r.status !== 'error')).toBe(true);
    const done = await commitImport(w.admin, st.batchId);
    expect(done.stats).toMatchObject({ created: 11, unchanged: 0, failed: 0 });
    const n = (await db().query(`SELECT status, title FROM nonconformance WHERE tenant_id = $1 AND title LIKE 'Cleanroom action limit exceeded%'`, [w.tenantId])).rows;
    expect(n).toEqual([{ status: 'open', title: 'Cleanroom action limit exceeded: CR-5A / P1 Fill line' }]);
    const ex = (await db().query(`SELECT readings, started_at, ended_at FROM cleanroom_excursion WHERE tenant_id = $1`, [w.tenantId])).rows;
    expect(ex).toHaveLength(1);
    expect(ex[0].readings).toBe(2);
    expect(ex[0].ended_at).not.toBeNull();
    // 06:00 on 22 October in New York (EDT, UTC-4) is 10:00 UTC
    expect(new Date(ex[0].started_at).toISOString()).toBe('2026-10-22T10:00:00.000Z');
    const alerts = (await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'cleanroom.alert'`, [w.opsA.userId])).rows[0].n;
    expect(alerts).toBe(1);
    const r = (await db().query(`SELECT source, occupancy, note, p0_3, dp_pa::float, rh_pct::float FROM cleanroom_reading WHERE tenant_id = $1 ORDER BY read_at, id LIMIT 1`, [w.tenantId])).rows[0];
    expect(r).toMatchObject({ source: 'import', occupancy: 'operational', note: 'by JR', dp_pa: 15.2, rh_pct: 44 });
    expect(Number(r.p0_3)).toBe(1850);
  });

  it('loading the same file again records nothing twice', async () => {
    const st = await stageImport(w.admin, { target: 'cleanroom_readings', sourceSystem: 'counter', fileName: 'again.csv', content: sample });
    expect(st.preview.every((r: any) => r.action === 'unchanged')).toBe(true);
    const done = await commitImport(w.admin, st.batchId);
    expect(done.stats).toMatchObject({ created: 0, unchanged: 11 });
    expect((await db().query('SELECT count(*)::int AS n FROM cleanroom_reading WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(11);
    expect((await db().query(`SELECT count(*)::int AS n FROM nonconformance WHERE tenant_id = $1 AND title LIKE 'Cleanroom action%'`, [w.tenantId])).rows[0].n).toBe(1);
  });

  it('the room page shows what was imported; a file with "room / point" and an unmeasured channel still loads', async () => {
    const d = await asActor(w.opsA, (tx) => getRoom(tx, w.opsA, r5.id, 30));
    expect(d.readings).toHaveLength(7);
    expect(d.excursions[0]).toMatchObject({ readings: 2, channels: expect.arrayContaining(['p0_3', 'p0_5', 'p5']) });
    const csv = Buffer.from('Timestamp,Room / Point,0.1 µm,0.5 µm,5 µm\n2026-10-23 12:00,CR-7B / P1 Gowning,500,120000,800\n');
    const st = await stageImport(w.admin, { target: 'cleanroom_readings', sourceSystem: 'counter', fileName: 'x.csv', content: csv });
    expect(st.preview[0]).toMatchObject({ status: 'warning' });
    expect(st.preview[0]!.messages[0]!.message).toContain('does not measure 0.1 µm');
    await commitImport(w.admin, st.batchId);
    const last = (await db().query(`SELECT p0_5::float, read_at FROM cleanroom_reading x JOIN cleanroom_point p ON p.id = x.point_id WHERE p.room_id = $1 ORDER BY read_at DESC LIMIT 1`, [r7.id])).rows[0];
    expect(last.p0_5).toBe(120000);
    expect(new Date(last.read_at).toISOString()).toBe('2026-10-23T16:00:00.000Z');
  });

  it('people who may not record cannot commit a file', async () => {
    const st = await stageImport(w.admin, { target: 'cleanroom_readings', sourceSystem: 'counter', fileName: 'z.csv', content: Buffer.from('Sample Time,Room,Sample Point,0.5um\n2026-10-23 18:00,CR-7B,P1 Gowning,100\n') });
    await expect(commitImport(w.exec, st.batchId)).rejects.toThrow();
  });
});
