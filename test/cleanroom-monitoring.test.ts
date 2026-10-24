import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { getRoom, listRooms, overduePoints, recordReading, saveRoom, savePoint, setPointLimits } from '../src/modules/cleanroom/service.js';
import { forgetEdition } from '../src/platform/edition.js';
import { setFeature } from '../src/modules/features/service.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { whatIsLate } from '../src/modules/late/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** SC-007 A: rooms, thresholds, one nonconformance per excursion, notification dedupe, trends, permissions and site/tenant isolation. */
const db = () => getAdminPool();
const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H);
const first30 = ago(30);
let app: FastifyInstance; let w: World; let other: World;
let room: any; let point: any; let roomB: any;

const rec = (actor: any, pointId: string, values: any, readAt: Date, extra: any = {}) => asActor(actor, (tx) => recordReading(tx, actor, pointId, { values, readAt, ...extra }));
const ncrs = async () => (await db().query(`SELECT number, title, severity, status, source FROM nonconformance WHERE tenant_id = $1 AND title LIKE 'Cleanroom action limit exceeded%' ORDER BY created_at`, [w.tenantId])).rows;
const notices = async (kind: string, userId = w.opsA.userId) => (await db().query(`SELECT title, body, dedupe_key FROM notification WHERE user_id = $1 AND kind = $2 ORDER BY created_at`, [userId, kind])).rows;

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('cleanroom'); other = await makeWorld('cleanroom-other');
  room = await asActor(w.admin, (tx) => saveRoom(tx, w.admin, { facilityId: w.facilities.A!, code: 'CR-5A', name: 'Fill suite', isoClass: 5, occupancy: 'operational', ownerUserId: w.opsA.userId }));
  point = await asActor(w.admin, (tx) => savePoint(tx, w.admin, room.id, { label: 'P1 Fill line', channels: ['p0_5', 'p5', 'dp', 'temp', 'rh'], intervalHours: 8 }));
  roomB = await asActor(w.admin, (tx) => saveRoom(tx, w.admin, { facilityId: w.facilities.B!, code: 'CR-B', name: 'Site B room', isoClass: 7, ownerUserId: w.operatorB.userId }));
  await asActor(w.admin, (tx) => savePoint(tx, w.admin, roomB.id, { label: 'B1', channels: ['p0_5'], intervalHours: 24 }));
});
afterAll(async () => { await app.close(); await closePools(); });

describe('permissions and isolation', () => {
  it('rooms and limits are kept by managers; readings are recorded by people who record; everyone else only reads', async () => {
    await expect(asActor(w.techA, (tx) => saveRoom(tx, w.techA, { facilityId: w.facilities.A!, code: 'X', name: 'X', isoClass: 7, ownerUserId: w.opsA.userId }))).rejects.toThrow(/cleanroom.manage/);
    await expect(asActor(w.techA, (tx) => savePoint(tx, w.techA, room.id, { label: 'Z', channels: ['p0_5'], intervalHours: 8 }))).rejects.toThrow(/cleanroom.manage/);
    await expect(asActor(w.techA, (tx) => setPointLimits(tx, w.techA, point.id, { dp: { actionLow: 5 } }))).rejects.toThrow(/cleanroom.manage/);
    await expect(rec(w.exec, point.id, { p0_5: 100 }, ago(40))).rejects.toThrow(/cleanroom.record/);
    expect((await asActor(w.exec, (tx) => listRooms(tx, w.exec))).map((r: any) => r.code).sort()).toEqual(['CR-5A', 'CR-B']);
    await expect(asActor(w.opsA, (tx) => saveRoom(tx, w.opsA, { facilityId: w.facilities.A!, code: 'BAD', name: 'Bad', isoClass: 10, ownerUserId: w.opsA.userId }))).rejects.toThrow(/ISO class/);
    await expect(asActor(w.opsA, (tx) => saveRoom(tx, w.opsA, { facilityId: w.facilities.A!, code: 'BAD', name: 'Bad', isoClass: 7, ownerUserId: w.operatorB.userId }))).rejects.toThrow(/owner must be an active user/);
  });

  it('a person at another site cannot see, list or record into a room; another company cannot either', async () => {
    expect((await asActor(w.operatorB, (tx) => listRooms(tx, w.operatorB))).map((r: any) => r.code)).toEqual(['CR-B']);
    await expect(asActor(w.operatorB, (tx) => getRoom(tx, w.operatorB, room.id))).rejects.toThrow(/not found|cleanroom/i);
    await expect(rec(w.operatorB, point.id, { p0_5: 100 }, ago(39))).rejects.toThrow();
    await expect(asActor(other.admin, (tx) => getRoom(tx, other.admin, room.id))).rejects.toThrow(/not found|cleanroom/i);
    expect(await asActor(other.admin, (tx) => listRooms(tx, other.admin))).toEqual([]);
    const api = await app.inject({ method: 'GET', url: `/api/cleanrooms/${room.id}`, headers: { authorization: `Bearer ${other.tokens.admin}` } });
    expect(api.statusCode).toBe(404);
    const rows = (await db().query('SELECT count(*)::int AS n FROM cleanroom_reading WHERE tenant_id = $1', [other.tenantId])).rows[0].n;
    expect(rows).toBe(0);
  });
});

describe('readings against limits', () => {
  it('a reading inside the limits is ok and records the conditions', async () => {
    const r = await rec(w.techA, point.id, { p0_5: 1200, p5: 4, dp: 15, temp: 21.5, rh: 45 }, first30, { note: 'Start of shift' });
    expect(r).toMatchObject({ status: 'ok', breaches: [], excursion: null, trend: false });
    const d = await asActor(w.techA, (tx) => getRoom(tx, w.techA, room.id));
    // the reading is inside its limits, but it was taken 30 hours ago against an 8-hour frequency
    expect(d.points[0]).toMatchObject({ label: 'P1 Fill line', last_status: 'ok', overdue: true, state: 'overdue' });
    expect(d.points[0].limits.p0_5).toMatchObject({ actionHigh: 3520, alertHigh: 2816, source: 'class' });
    expect(d.points[0].limits.dp).toMatchObject({ source: 'none' });
    expect(d.class_limits.find((l: any) => l.channel === 'p5').limit).toBe(29);
  });

  it('refuses what cannot be a reading', async () => {
    await expect(rec(w.techA, point.id, { p0_3: 10 }, ago(29))).rejects.toThrow(/does not measure/);
    await expect(rec(w.techA, point.id, { p0_5: -1 }, ago(29))).rejects.toThrow(/negative/);
    await expect(rec(w.techA, point.id, { rh: 101 }, ago(29))).rejects.toThrow(/humidity/);
    await expect(rec(w.techA, point.id, {}, ago(29))).rejects.toThrow(/at least one value/);
    await expect(rec(w.techA, point.id, { p0_5: 10 }, new Date(Date.now() + 3_600_000))).rejects.toThrow(/future/);
    await expect(rec(w.techA, point.id, { p0_5: 1200 }, first30)).rejects.toThrow(/already recorded/);
  });

  it('over the alert limit tells the room owner once a day; over the action limit it does not wait', async () => {
    const a = await rec(w.techA, point.id, { p0_5: 2900, p5: 5 }, ago(26));
    expect(a).toMatchObject({ status: 'alert', excursion: null });
    expect(a.breaches).toMatchObject([{ channel: 'p0_5', level: 'alert', limit: 2816 }]);
    const again = await rec(w.techA, point.id, { p0_5: 3000 }, ago(25));
    expect(again.status).toBe('alert');
    const n = await notices('cleanroom.alert');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: 'Alert limit exceeded in CR-5A / P1 Fill line', dedupe_key: expect.stringMatching(/^cleanroom-alert:/) });
    expect(n[0].body).toContain('0.5 µm 2,900/m³ over the alert limit of 2,816/m³');
    expect(await ncrs()).toEqual([]);
    expect(await notices('cleanroom.alert', w.techA.userId)).toEqual([]);
  });

  it('an action breach raises one nonconformance; more readings over the limit join the open excursion', async () => {
    const first = await rec(w.techA, point.id, { p0_5: 4200, p5: 31 }, ago(20), { note: 'HEPA filter alarm' });
    expect(first).toMatchObject({ status: 'action', excursion: { opened: true, closed: false } });
    expect(first.excursion!.nonconformanceId).toBeTruthy();
    const second = await rec(w.techA, point.id, { p0_5: 5100 }, ago(16));
    const third = await rec(w.techA, point.id, { p0_5: 4800, dp: 14 }, ago(12));
    expect(second.excursion).toMatchObject({ opened: false, closed: false, nonconformanceId: first.excursion!.nonconformanceId });
    expect(third.excursion).toMatchObject({ opened: false, nonconformanceId: first.excursion!.nonconformanceId });
    const n = await ncrs();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ severity: 'major', status: 'open', source: 'internal', title: 'Cleanroom action limit exceeded: CR-5A / P1 Fill line' });
    const ex = (await db().query('SELECT readings, channels, peak, nonconformance_id FROM cleanroom_excursion WHERE point_id = $1 AND ended_at IS NULL', [point.id])).rows;
    expect(ex).toHaveLength(1);
    expect(ex[0].readings).toBe(3);
    expect(ex[0].channels.sort()).toEqual(['p0_5', 'p5']);
    expect(ex[0].peak.p0_5).toEqual({ value: 5100, limit: 3520 });
    const d = await asActor(w.techA, (tx) => getRoom(tx, w.techA, room.id));
    expect(d.points[0]).toMatchObject({ state: 'action', ncr_number: n[0].number });
    expect(d.excursions[0]).toMatchObject({ ncr_number: n[0].number, ended_at: null });
    // the room owner was told once about the excursion, and quality managers heard about the nonconformance
    expect(await notices('cleanroom.action')).toHaveLength(1);
  });

  it('a reading back under the action limit closes the excursion; a later breach is a new excursion with its own nonconformance', async () => {
    const back = await rec(w.techA, point.id, { p0_5: 2000 }, ago(8));
    expect(back.excursion).toMatchObject({ closed: true });
    expect(await ncrs()).toHaveLength(1);
    const next = await rec(w.techA, point.id, { p0_5: 3600 }, ago(4));
    expect(next.excursion).toMatchObject({ opened: true });
    const n = await ncrs();
    expect(n).toHaveLength(2);
    expect(new Set(n.map((x: any) => x.number)).size).toBe(2);
    expect(await notices('cleanroom.action')).toHaveLength(2);
    await rec(w.techA, point.id, { p0_5: 1000 }, ago(1));
  });

  it('readings are a log: they cannot be edited or deleted', async () => {
    await expect(db().query('UPDATE cleanroom_reading SET p0_5 = 1 WHERE point_id = $1', [point.id])).rejects.toThrow(/log/);
    await expect(db().query('DELETE FROM cleanroom_reading WHERE point_id = $1', [point.id])).rejects.toThrow(/log/);
  });

  it('a point can have its own limits, including a pressure range', async () => {
    await expect(asActor(w.opsA, (tx) => setPointLimits(tx, w.opsA, point.id, { p0_5: { alertHigh: 4000 } }))).rejects.toThrow(/alert limit cannot be above/);
    await expect(asActor(w.opsA, (tx) => setPointLimits(tx, w.opsA, point.id, { p0_3: { actionHigh: 1 } }))).rejects.toThrow(/does not measure/);
    const l = await asActor(w.opsA, (tx) => setPointLimits(tx, w.opsA, point.id, { dp: { alertLow: 12, actionLow: 10 }, p5: { actionHigh: 20 } }));
    expect(l.dp).toMatchObject({ alertLow: 12, actionLow: 10, source: 'point' });
    expect(l.p5).toMatchObject({ actionHigh: 20, alertHigh: 16 });
    const low = await rec(w.techA, point.id, { dp: 11 }, ago(0.5));
    expect(low).toMatchObject({ status: 'alert', breaches: [{ channel: 'dp', level: 'alert', side: 'low', limit: 12 }] });
    const lower = await rec(w.techA, point.id, { dp: 9 }, ago(0.4));
    expect(lower).toMatchObject({ status: 'action', excursion: { opened: true } });
    expect(await ncrs()).toHaveLength(3);
    await asActor(w.opsA, (tx) => setPointLimits(tx, w.opsA, point.id, { p5: null, dp: null }));
    expect((await asActor(w.opsA, (tx) => getRoom(tx, w.opsA, room.id))).points[0].limits.dp.source).toBe('none');
  });
});

describe('trends', () => {
  it('consecutive alerts as long as the room setting are flagged once; an ok reading ends the run', async () => {
    const p = await asActor(w.admin, (tx) => savePoint(tx, w.admin, room.id, { label: 'P2 Door', channels: ['p0_5'], intervalHours: 24 }));
    const one = await rec(w.techA, p.id, { p0_5: 3000 }, ago(60));
    const two = await rec(w.techA, p.id, { p0_5: 3100 }, ago(50));
    expect([one.trend, two.trend]).toEqual([false, false]);
    const three = await rec(w.techA, p.id, { p0_5: 3200 }, ago(40));
    expect(three).toMatchObject({ status: 'alert', trend: true });
    const four = await rec(w.techA, p.id, { p0_5: 3300 }, ago(30));
    expect(four.trend).toBe(true);
    const t = (await notices('cleanroom.trend')).filter((x) => x.title.includes('P2 Door'));
    expect(t).toHaveLength(1);
    expect(t[0].title).toBe('Trend in CR-5A / P2 Door: 3 readings in a row over the alert limit');
    expect((await asActor(w.techA, (tx) => getRoom(tx, w.techA, room.id))).points.find((x: any) => x.id === p.id)).toMatchObject({ trend: true, run: 4 });
    expect((await rec(w.techA, p.id, { p0_5: 900 }, ago(20))).trend).toBe(false);
    for (const [i, v] of [3000, 3100, 3200].entries()) await rec(w.techA, p.id, { p0_5: v }, ago(18 - i * 2));
    expect((await notices('cleanroom.trend')).filter((x) => x.title.includes('P2 Door'))).toHaveLength(2);
  });

  it('the trend length is a room setting', async () => {
    const r = await asActor(w.opsA, (tx) => saveRoom(tx, w.opsA, { id: room.id, code: 'CR-5A', name: 'Fill suite', isoClass: 5, ownerUserId: w.opsA.userId, trendCount: 2 }));
    expect(r.trend_count).toBe(2);
    await expect(asActor(w.opsA, (tx) => saveRoom(tx, w.opsA, { id: room.id, code: 'CR-5A', name: 'Fill suite', isoClass: 5, ownerUserId: w.opsA.userId, trendCount: 1 }))).rejects.toThrow(/trend/);
    await asActor(w.opsA, (tx) => saveRoom(tx, w.opsA, { id: room.id, code: 'CR-5A', name: 'Fill suite', isoClass: 5, ownerUserId: w.opsA.userId, trendCount: 3 }));
  });
});

describe('overdue sampling', () => {
  let p3: any;
  it('a point with no reading within its frequency is overdue: on What is late, in the daily reminder (once a day) and in the report', async () => {
    p3 = await asActor(w.admin, (tx) => savePoint(tx, w.admin, room.id, { label: 'P3 Pass-through', channels: ['p0_5'], intervalHours: 4 }));
    await db().query(`UPDATE cleanroom_point SET created_at = now() - interval '10 hours' WHERE id = $1`, [p3.id]);
    const late = await asActor(w.qualityA, (tx) => whatIsLate(tx, w.qualityA));
    const s = late.sections.find((x: any) => x.key === 'cleanroom-sampling');
    expect(s).toBeTruthy();
    expect(s!.rows.map((r: any) => r.label)).toContain('CR-5A · P3 Pass-through');
    expect(s!.rows.find((r: any) => r.label === 'CR-5A · P3 Pass-through')).toMatchObject({ owner: 'opsA', href: `/cleanrooms/${room.id}` });
    // a person at another site sees none of it
    const lateB = await asActor(w.operatorB, (tx) => whatIsLate(tx, w.operatorB));
    expect(lateB.sections.find((x: any) => x.key === 'cleanroom-sampling')?.rows.map((r: any) => r.label) ?? []).not.toContain('CR-5A · P3 Pass-through');

    const first = await runReminders(w.tenantId);
    expect(first.cleanroom_sampling).toBeGreaterThanOrEqual(1);
    const mine = await notices('reminder.cleanroom_sampling', w.techA.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toMatch(/^A: \d cleanroom sampling points? overdue$/);
    expect(mine[0].body).toContain('CR-5A / P3 Pass-through');
    await runReminders(w.tenantId);
    expect(await notices('reminder.cleanroom_sampling', w.techA.userId)).toHaveLength(1);
    expect((await asActor(w.admin, (tx) => overduePoints(tx, [w.facilities.A!]))).map((o: any) => o.label)).toContain('P3 Pass-through');
  });

  it('a reading clears it', async () => {
    await rec(w.techA, p3.id, { p0_5: 100 }, ago(0.1));
    const late = await asActor(w.qualityA, (tx) => whatIsLate(tx, w.qualityA));
    expect((late.sections.find((x: any) => x.key === 'cleanroom-sampling')?.rows ?? []).map((r: any) => r.label)).not.toContain('CR-5A · P3 Pass-through');
  });
});

describe('the monitoring report', () => {
  const get = (url: string, token = w.tokens.admin) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  it('shows compliance by room and period, the excursions with their nonconformances, and overdue sampling', async () => {
    const r = (await get(`/api/reports/cleanroom-monitoring?facilityId=${w.facilities.A}`)).json();
    expect(r.reportId).toBe('cleanroom-monitoring');
    expect(r.kpis.map((k: any) => k.label)).toEqual(['Compliance', 'Over alert limit', 'Over action limit', 'Open excursions', 'Sampling on time', 'Points overdue']);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x: any) => x.room.startsWith('CR-5A'))).toBe(true);
    const over = r.rows.reduce((s: number, x: any) => s + x.over_action, 0);
    expect(over).toBeGreaterThanOrEqual(5);
    expect(r.notes.join(' ')).toContain('own copy of the standard');
    const ex = (await get(`/api/reports/cleanroom-monitoring?facilityId=${w.facilities.A}&view=excursions`)).json();
    expect(ex.rows.length).toBe(3);
    expect(ex.rows.map((x: any) => x.nonconformance).every((x: string) => /^NCR-\d+ \(open\)$/.test(x))).toBe(true);
    const od = (await get(`/api/reports/cleanroom-monitoring?facilityId=${w.facilities.A}&view=overdue`)).json();
    expect(Array.isArray(od.rows)).toBe(true);
  });
  it('exports to CSV, XLSX and PDF like the other reports, and is limited to the sites a person may see', async () => {
    for (const [f, type] of [['csv', 'text/csv'], ['xlsx', 'spreadsheetml'], ['pdf', 'application/pdf']] as const) {
      const res = await get(`/api/reports/cleanroom-monitoring?format=${f}`);
      expect(res.statusCode, f).toBe(200);
      expect(String(res.headers['content-type'])).toContain(type);
    }
    const b = (await get('/api/reports/cleanroom-monitoring', w.tokens.operatorB)).json();
    expect(b.rows.every((x: any) => !x.room.startsWith('CR-5A'))).toBe(true);
    expect((await get('/api/reports/cleanroom-monitoring', other.tokens.admin)).json().rows).toEqual([]);
  });
});

describe('editions and the feature switch', () => {
  it('Lite has no cleanrooms; Standard can turn the feature off for everyone and back on', async () => {
    const n = `cr-lite-${process.pid}-${Date.now() % 100000}`;
    const t = await provisionTenant(db(), { slug: n, name: 'Lite Co', legalEntity: 'Lite Co LLC', edition: 'lite', facilities: [{ code: 'SHOP', name: 'Shop', timezone: 'America/Chicago', kind: 'office' }] });
    const u = await createUserWithToken(db(), t.tenantId, { email: `o@${n}.example`, displayName: 'Owner', roles: [{ role: 'admin', facility: null }] });
    forgetEdition();
    const lite = await app.inject({ method: 'GET', url: '/api/cleanrooms', headers: { authorization: `Bearer ${u.token}` } });
    expect(lite.statusCode).toBe(403);
    expect(lite.json().error.code).toBe('edition');
    const h = { authorization: `Bearer ${w.tokens.techA}` };
    expect((await app.inject({ method: 'GET', url: '/api/cleanrooms', headers: h })).statusCode).toBe(200);
    await asActor(w.admin, (tx) => setFeature(tx, w.admin, 'cleanroom', { mode: 'off', roleKeys: [] }));
    const off = await app.inject({ method: 'GET', url: '/api/cleanrooms', headers: h });
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('feature_off');
    expect((await app.inject({ method: 'GET', url: '/api/reports/cleanroom-monitoring', headers: h })).statusCode).toBe(403);
    await asActor(w.admin, (tx) => setFeature(tx, w.admin, 'cleanroom', { mode: 'all', roleKeys: [] }));
    expect((await app.inject({ method: 'GET', url: '/api/cleanrooms', headers: h })).statusCode).toBe(200);
  });
});
