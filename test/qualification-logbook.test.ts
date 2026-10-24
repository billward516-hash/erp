import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset, recordState } from '../src/modules/assets/service.js';
import { createWorkOrder } from '../src/modules/maintenance/service.js';
import { createChange } from '../src/modules/moc/service.js';
import { recordCalibration, savePlan } from '../src/modules/quality/calibration.js';
import { addNote, logbook } from '../src/modules/qualification/logbook.js';
import { runReport } from '../src/modules/reporting/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World; let other: World; let app: FastifyInstance;
let A: string; let tool: string;
const at = (s: string) => new Date(`${s}Z`);
const h = (who: string) => ({ authorization: `Bearer ${w.tokens[who]}` });

beforeAll(async () => {
  app = buildApp();
  w = await makeWorld('qlog'); other = await makeWorld('qlogo'); A = w.facilities.A!;
  tool = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: A, assetTag: 'IMPL-7', name: 'Ion implanter' }))).id;
  // State history at known times
  for (const [state, when, extra] of [['running', '2026-10-01T08:00:00', {}], ['idle', '2026-10-01T20:00:00', {}], ['planned_downtime', '2026-10-02T06:00:00', { reasonCode: undefined }], ['available', '2026-10-02T12:00:00', {}]] as const) {
    await asActor(w.managerA, (tx) => recordState(tx, w.managerA, tool, { state, at: at(when), note: `to ${state}`, ...extra }));
  }
  // A work order opened and completed, a calibration, and a change affecting the tool, all at known times
  const wo = await asActor(w.managerA, (tx) => createWorkOrder(tx, w.managerA, { assetId: tool, title: 'Replace ion source filament' }));
  await db().query(`UPDATE work_order SET created_at = '2026-10-01T09:00:00Z', completed_at = '2026-10-02T10:00:00Z', completed_by = $2, remedy = 'Filament replaced' WHERE id = $1`, [wo.id, w.techA.userId]);
  const plan = await asActor(w.qualityA, (tx) => savePlan(tx, w.qualityA, { assetId: tool, intervalDays: 180, tolerance: 'Dose ±1%' }));
  await asActor(w.qualityA, (tx) => recordCalibration(tx, w.qualityA, plan.id, { performedOn: '2026-10-01', performedBy: 'Vendor service', asFound: 'in_tolerance', asLeft: 'in_tolerance', certificateNo: 'CAL-77' }));
  const ch = await asActor(w.managerA, (tx) => createChange(tx, w.managerA, { facilityId: A, title: 'Move the dose controller to the new firmware', changeType: 'controls_software', description: 'Firmware 4.2', justification: 'Support ends',
    consequences: 'Retest', qmsImpact: 'None', resources: 'Vendor', responsibilities: 'Maintenance', affected: [{ entityType: 'asset', entityId: tool }] }));
  await db().query(`UPDATE moc_change SET created_at = '2026-10-01T14:00:00Z', in_service_at = '2026-10-02T15:00:00Z' WHERE id = $1`, [ch.id]);
});
afterAll(async () => { await app.close(); await closePools(); });

const window = { from: at('2026-10-01T00:00:00'), to: at('2026-10-03T00:00:00') };

describe('the equipment logbook', () => {
  it('combines state changes, work orders, calibrations and changes in time order', async () => {
    const book = await asActor(w.managerA, (tx) => logbook(tx, w.managerA, tool, { ...window, order: 'asc' }));
    expect(book.entries.map((e) => `${e.at.slice(5, 16)} ${e.kind}: ${e.title}`)).toEqual([
      '10-01T08:00 state: State: Running',
      '10-01T09:00 work_order: Work order WO-000001 opened: Replace ion source filament',
      '10-01T12:00 calibration: Calibration: found in tolerance, left in tolerance',
      '10-01T14:00 change: Change MOC-000001 raised: Move the dose controller to the new firmware',
      '10-01T20:00 state: State: Idle',
      '10-02T06:00 state: State: Planned downtime',
      '10-02T10:00 work_order: Work order WO-000001 completed',
      '10-02T12:00 state: State: Available',
      '10-02T15:00 change: Change MOC-000001 put in service',
    ]);
    expect(book.omitted).toEqual([]);
    expect(book.entries[2]).toMatchObject({ detail: 'certificate CAL-77', actor: 'Vendor service' });
    expect(book.entries[6]).toMatchObject({ detail: 'Filament replaced', actor: 'techA', ref: { type: 'work_order', href: expect.stringMatching(/^\/work-orders\//) } });
  });

  it('newest first reverses it exactly, and a kind or a date range narrows it', async () => {
    const asc = await asActor(w.managerA, (tx) => logbook(tx, w.managerA, tool, { ...window, order: 'asc' }));
    const desc = await asActor(w.managerA, (tx) => logbook(tx, w.managerA, tool, { ...window, order: 'desc' }));
    expect(desc.entries.map((e) => e.title)).toEqual([...asc.entries].reverse().map((e) => e.title));
    const states = await asActor(w.managerA, (tx) => logbook(tx, w.managerA, tool, { ...window, kinds: ['state'], order: 'asc' }));
    expect(states.entries.map((e) => e.title)).toEqual(['State: Running', 'State: Idle', 'State: Planned downtime', 'State: Available']);
    const day2 = await asActor(w.managerA, (tx) => logbook(tx, w.managerA, tool, { from: at('2026-10-02T00:00:00'), to: at('2026-10-03T00:00:00'), order: 'asc' }));
    expect(day2.entries).toHaveLength(4);
    expect(day2.entries.every((e) => e.at >= '2026-10-02')).toBe(true);
  });

  it('shows qualification events and notes with who and when, and notes cannot be edited or removed', async () => {
    const { switchOn } = await import('../src/modules/qualification/service.js');
    await asActor(w.managerA, (tx) => switchOn(tx, w.managerA, tool));
    await expect(asActor(w.exec, (tx) => addNote(tx, w.exec, tool, 'Not allowed to write'))).rejects.toThrow(/qualification.execute/);
    await expect(asActor(w.techA, (tx) => addNote(tx, w.techA, tool, '   '))).rejects.toThrow(/write the note/);
    const n = await asActor(w.techA, (tx) => addNote(tx, w.techA, tool, 'Chamber vented for the filament change; pumped down overnight.'));
    expect(n.id).toBeTruthy();
    const book = await asActor(w.managerA, (tx) => logbook(tx, w.managerA, tool, { order: 'desc' }));
    expect(book.entries[0]).toMatchObject({ kind: 'note', actor: 'techA', detail: 'Chamber vented for the filament change; pumped down overnight.' });
    expect(book.entries.map((e) => e.kind)).toContain('qualification');
    await expect(db().query(`UPDATE equipment_note SET body = 'changed' WHERE id = $1`, [n.id])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(db().query(`DELETE FROM equipment_note WHERE id = $1`, [n.id])).rejects.toThrow(/cannot be changed or deleted/);
  });

  it('leaves out, and names, what the reader may not see', async () => {
    const book = await asActor(w.techA, (tx) => logbook(tx, w.techA, tool, { ...window, order: 'asc' }));
    expect(book.omitted).toEqual(['calibrations']);
    expect(book.entries.map((e) => e.kind)).not.toContain('calibration');
    expect(book.entries.map((e) => e.kind)).toContain('change');
  });

  it('is limited to the sites a person may see, and to the company', async () => {
    await expect(asActor(w.operatorB, (tx) => logbook(tx, w.operatorB, tool))).rejects.toThrow(/qualification.view|not found/);
    await expect(asActor(other.managerA, (tx) => logbook(tx, other.managerA, tool))).rejects.toThrow(/not found/);
    const r = await app.inject({ method: 'GET', url: `/api/qualification/assets/${tool}/logbook`, headers: { authorization: `Bearer ${other.tokens.managerA}` } });
    expect(r.statusCode).toBe(404);
  });
});

describe('exports, like other reports', () => {
  it('prints and exports the logbook as PDF, CSV and Excel with the same entries', async () => {
    const q = { assetId: tool, from: '2026-10-01', to: '2026-10-03', order: 'asc' };
    const json: any = (await runReport(w.managerA, 'equipment-logbook', q, 'json')).body;
    expect(json.headline).toMatch(/IMPL-7 Ion implanter: 9 logbook entries since 2026-10-01; qualification: not qualified/);
    expect(json.rows).toHaveLength(9);
    const csv = (await runReport(w.managerA, 'equipment-logbook', q, 'csv')).body as string;
    expect(csv).toContain('Replace ion source filament');
    expect(csv.split('\n').filter((l) => /State: /.test(l))).toHaveLength(4);
    const pdf = (await runReport(w.managerA, 'equipment-logbook', q, 'pdf')).body as Buffer;
    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe('%PDF');
    expect(Buffer.from((await runReport(w.managerA, 'equipment-logbook', q, 'xlsx')).body as Buffer).subarray(0, 2).toString()).toBe('PK');
    await expect(runReport(w.operatorB, 'equipment-logbook', q, 'csv')).rejects.toThrow(/qualification.view/);
    const api = await app.inject({ method: 'GET', url: `/api/reports/equipment-logbook?assetId=${tool}&format=csv`, headers: h('managerA') });
    expect(api.statusCode).toBe(200);
    expect(api.headers['content-type']).toMatch(/text\/csv/);
    expect(api.body).toContain('IMPL-7');
  });

  it('says in the export when part of the logbook was left out for the reader', async () => {
    const json: any = (await runReport(w.techA, 'equipment-logbook', { assetId: tool }, 'json')).body;
    expect(json.insights.join(' ')).toMatch(/Left out because you may not see them: calibrations/);
  });
});
