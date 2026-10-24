import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset, recordState } from '../src/modules/assets/service.js';
import { E10_GROUPS, E10_OF_STATE, computeToolStates, e10GroupOf } from '../src/modules/qualification/tool-states.js';
import { ASSET_STATES } from '../src/modules/assets/utilization.js';
import { runReport } from '../src/modules/reporting/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
const at = (s: string) => new Date(`${s}Z`);
const iv = (state: string, from: string, to: string | null, engineering = false) => ({ state: state as never, startedAt: at(from), endedAt: to ? at(to) : null, engineering });
let w: World; let app: FastifyInstance; let A: string; let B: string;
const h = (who: string) => ({ authorization: `Bearer ${w.tokens[who]}` });

beforeAll(async () => { app = buildApp(); w = await makeWorld('e10'); A = w.facilities.A!; B = w.facilities.B!; });
afterAll(async () => { await app.close(); await closePools(); });

describe('the mapping from platform states to E10 style groups', () => {
  it('maps every state to exactly one group, and engineering use only on up states', () => {
    expect(Object.keys(E10_OF_STATE).sort()).toEqual([...ASSET_STATES].sort());
    expect(Object.fromEntries(ASSET_STATES.map((s) => [s, e10GroupOf(s)]))).toEqual({
      available: 'standby', running: 'productive', idle: 'standby', planned_downtime: 'scheduled_downtime', unplanned_downtime: 'unscheduled_downtime', out_of_service: 'non_scheduled',
    });
    expect(e10GroupOf('running', true)).toBe('engineering');
    expect(e10GroupOf('idle', true)).toBe('engineering');
    expect(e10GroupOf('unplanned_downtime', true)).toBe('unscheduled_downtime');
  });
});

describe('hours per group', () => {
  const from = at('2026-10-01T00:00:00'); const to = at('2026-10-02T00:00:00');
  it('groups a day of states, with the unrecorded time reported apart, and the parts add up to the period', () => {
    const t = computeToolStates([
      iv('running', '2026-10-01T00:00:00', '2026-10-01T06:00:00'), iv('idle', '2026-10-01T06:00:00', '2026-10-01T08:00:00'),
      iv('running', '2026-10-01T08:00:00', '2026-10-01T10:00:00', true), iv('planned_downtime', '2026-10-01T10:00:00', '2026-10-01T14:00:00'),
      iv('unplanned_downtime', '2026-10-01T14:00:00', '2026-10-01T16:00:00'), iv('out_of_service', '2026-10-01T16:00:00', '2026-10-01T20:00:00'),
    ], from, to, { now: to });
    expect(t.hours).toEqual({ productive: 6, standby: 2, engineering: 2, scheduled_downtime: 4, unscheduled_downtime: 2, non_scheduled: 4 });
    expect(t.recordedHours).toBe(20);
    expect(t.unrecordedHours).toBe(4);
    expect(t.calendarHours).toBe(24);
    expect(t.percentOfCalendar.productive).toBe(0.25);
    expect(t.percentOfCalendar.unscheduled_downtime).toBe(0.0833);
    expect(t.percentOfRecorded.productive).toBe(0.3);
    expect(E10_GROUPS.reduce((s, g) => s + t.hours[g], 0) + t.unrecordedHours).toBeCloseTo(t.calendarHours, 6);
    expect(t.coverage).toBeCloseTo(20 / 24, 3);
  });

  it('counts an open state up to now, never into the future, and a window with no records as all unrecorded (not zero use)', () => {
    const t = computeToolStates([iv('running', '2026-10-01T12:00:00', null)], from, to, { now: at('2026-10-01T18:00:00') });
    expect(t.hours.productive).toBe(6);
    expect(t.unrecordedHours).toBe(18);
    const none = computeToolStates([], from, to, { now: to });
    expect(none).toMatchObject({ recordedHours: 0, unrecordedHours: 24, coverage: 0 });
    expect(none.percentOfRecorded.productive).toBeNull();
  });

  it('adds up for awkward fractions of an hour', () => {
    const ivs = [iv('running', '2026-10-01T00:00:00', '2026-10-01T03:17:00'), iv('idle', '2026-10-01T03:17:00', '2026-10-01T05:41:00', true), iv('unplanned_downtime', '2026-10-01T05:41:00', '2026-10-01T09:59:00'),
      iv('available', '2026-10-01T09:59:00', '2026-10-01T22:03:00')];
    const t = computeToolStates(ivs, from, to, { now: to });
    expect(E10_GROUPS.reduce((s, g) => s + t.hours[g], 0) + t.unrecordedHours).toBeCloseTo(24, 1);
    expect(t.hours.engineering).toBeCloseTo(2.4, 2);
  });
});

describe('recording engineering use', () => {
  it('flags an up state as engineering use; a flagged state is a new interval and the same flag again changes nothing', async () => {
    const id = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: A, assetTag: 'IMPL-1', name: 'Implanter 1' }))).id;
    const rec = (state: string, t: string, extra: Record<string, unknown> = {}) => asActor(w.managerA, (tx) => recordState(tx, w.managerA, id, { state: state as never, at: at(t), ...extra }));
    await rec('running', '2026-10-01T00:00:00');
    expect(await rec('running', '2026-10-01T04:00:00', { engineering: true })).toMatchObject({ unchanged: false });
    expect(await rec('running', '2026-10-01T05:00:00', { engineering: true })).toMatchObject({ unchanged: true });
    expect(await rec('running', '2026-10-01T06:00:00')).toMatchObject({ unchanged: true }); // no statement: no change
    await expect(rec('planned_downtime', '2026-10-01T07:00:00', { engineering: true })).rejects.toThrow(/engineering use applies to available, running or idle/);
    await expect(db().query(`INSERT INTO asset_state_event (tenant_id, facility_id, asset_id, state, started_at, engineering) VALUES ($1, $2, $3, 'out_of_service', '2026-09-01', true)`, [w.tenantId, A, id])).rejects.toThrow(/asset_state_engineering_up/);
    await rec('idle', '2026-10-01T08:00:00');
    const t = computeToolStates((await db().query('SELECT state, started_at, ended_at, engineering FROM asset_state_event WHERE asset_id = $1 ORDER BY started_at', [id])).rows
      .map((r) => ({ state: r.state, startedAt: r.started_at, endedAt: r.ended_at, engineering: r.engineering })), at('2026-10-01T00:00:00'), at('2026-10-01T10:00:00'), { now: at('2026-10-01T10:00:00') });
    expect(t.hours).toMatchObject({ productive: 4, engineering: 4, standby: 2 });
  });
});

describe('the tool-states report', () => {
  let t1: string; let t2: string; let tb: string;
  beforeAll(async () => {
    const rec = (who: typeof w.managerA, id: string, state: string, t: string, extra: Record<string, unknown> = {}) => asActor(who, (tx) => recordState(tx, who, id, { state: state as never, at: at(t), ...extra }));
    t1 = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: A, assetTag: 'RPT-1', name: 'Report tool 1' }))).id;
    t2 = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: A, assetTag: 'RPT-2', name: 'Report tool 2' }))).id;
    tb = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: B, assetTag: 'RPT-B', name: 'Site B tool' }))).id;
    await rec(w.managerA, t1, 'running', '2026-09-01T00:00:00'); await rec(w.managerA, t1, 'unplanned_downtime', '2026-09-01T12:00:00'); await rec(w.managerA, t1, 'available', '2026-09-01T18:00:00');
    await rec(w.managerA, t2, 'running', '2026-09-01T00:00:00', { engineering: true }); await rec(w.managerA, t2, 'out_of_service', '2026-09-01T06:00:00');
    await rec(w.admin, tb, 'running', '2026-09-01T00:00:00');
  });
  const q = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', minCoverage: '0' };

  it('gives hours and shares of the period per tool and group', async () => {
    const json: any = (await runReport(w.admin, 'tool-states', { ...q, facilityId: A }, 'json')).body;
    const r1 = json.rows.find((r: any) => r.asset_tag === 'RPT-1'); const r2 = json.rows.find((r: any) => r.asset_tag === 'RPT-2');
    expect(r1).toMatchObject({ productive_h: 12, unscheduled_h: 6, standby_h: 6, engineering_h: 0, scheduled_h: 0, non_scheduled_h: 0, not_recorded_h: 0, productive_pct: 0.5, unscheduled_pct: 0.25, standby_pct: 0.25 });
    expect(r2).toMatchObject({ engineering_h: 6, productive_h: 0, non_scheduled_h: 18, non_scheduled_pct: 0.75 });
    for (const r of [r1, r2]) {
      expect(r.productive_h + r.standby_h + r.engineering_h + r.scheduled_h + r.unscheduled_h + r.non_scheduled_h + r.not_recorded_h).toBeCloseTo(24, 6);
      expect(r.productive_pct + r.standby_pct + r.engineering_pct + r.scheduled_pct + r.unscheduled_pct + r.non_scheduled_pct).toBeCloseTo(1, 3);
    }
    expect(json.rows.map((r: any) => r.asset_tag)).not.toContain('RPT-B');
    expect(json.notes.join(' ')).toMatch(/not a certification/);
    expect(json.kpis.map((k: any) => k.label)).toEqual(['Productive', 'Unscheduled downtime', 'Engineering', 'Not recorded']);
  });

  it('exports to CSV and PDF with the same numbers, and is limited to the sites a person may see', async () => {
    const csv = (await runReport(w.admin, 'tool-states', { ...q, facilityId: A }, 'csv')).body as string;
    expect(csv.split('\n').find((l) => l.includes('RPT-1'))).toContain('12');
    expect(Buffer.from((await runReport(w.admin, 'tool-states', { ...q, facilityId: A }, 'pdf')).body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    // The site-A manager has no view of site B; a corporate reader sees both.
    const mine: any = (await runReport(w.managerA, 'tool-states', q, 'json')).body;
    expect(mine.rows.map((r: any) => r.asset_tag)).toEqual(expect.arrayContaining(['RPT-1', 'RPT-2']));
    expect(mine.rows.map((r: any) => r.asset_tag)).not.toContain('RPT-B');
    const all: any = (await runReport(w.exec, 'tool-states', q, 'json')).body;
    expect(all.rows.map((r: any) => r.asset_tag)).toContain('RPT-B');
    await expect(runReport(w.operatorB, 'tool-states', q, 'json')).rejects.toThrow(/qualification.view/);
    const api = await app.inject({ method: 'GET', url: '/api/reports/tool-states?format=json&from=2026-09-01&to=2026-09-02', headers: h('managerA') });
    expect(api.statusCode).toBe(200);
    expect(api.json().rows.length).toBeGreaterThan(1);
    expect(api.json().links).toBeDefined();
  });

  it('a single tool can be asked for, with its components, and a missing one is refused', async () => {
    const one: any = (await runReport(w.admin, 'tool-states', { ...q, assetId: t1 }, 'json')).body;
    expect(one.rows.map((r: any) => r.asset_tag)).toEqual(['RPT-1']);
    await expect(runReport(w.admin, 'tool-states', { ...q, assetId: '00000000-0000-4000-8000-000000000000' }, 'json')).rejects.toThrow(/not found/);
  });
});
