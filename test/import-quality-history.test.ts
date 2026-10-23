import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createAsset } from '../src/modules/assets/service.js';
import { createPart } from '../src/modules/parts/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Quality and safety setup and history imports (SC-003). */
let app: FastifyInstance; let w: World;
beforeAll(async () => {
  app = buildApp(); w = await makeWorld('qualhist');
  await asActor(w.admin, async (tx) => {
    await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'MIC-01', name: 'Micrometer' });
    await createPart(tx, w.admin, { partNumber: 'HSG-100', description: 'Housing', uom: 'EA' });
  });
});
afterAll(async () => { await app.close(); await closePools(); });
const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${w.tokens.admin}` }, payload: payload as any });
async function load(target: string, text: string, expectErrors = 0) {
  const s = await call('POST', '/api/imports/stage', { target, sourceSystem: 'hist', fileName: `${target}.csv`, facilityId: w.facilities.A, contentBase64: Buffer.from(text).toString('base64') });
  expect(s.statusCode, s.body).toBe(201);
  const b = s.json();
  expect(b.stats.errors, JSON.stringify(b.problems)).toBe(expectErrors);
  if (expectErrors) return b;
  const c = await call('POST', `/api/imports/${b.batchId}/commit`, {});
  expect(c.statusCode, c.body).toBe(200);
  return c.json();
}
const q = async (sql: string) => (await getAdminPool().query(sql.replace('$T', `'${w.tenantId}'`))).rows;

describe('quality and safety imports', () => {
  it('SPC characteristics are set up, then measurements can be loaded against them', async () => {
    await load('spc_characteristics', 'Characteristic code,Name,Part number,Gauge (asset tag),Unit,Nominal,Lower limit,Upper limit,Subgroup size\nBORE-1,Bore diameter,HSG-100,MIC-01,mm,25,24.98,25.02,3\n');
    const bad = await load('spc_characteristics', 'Characteristic code,Name,Lower limit,Upper limit\nX,Bad,5,2\n', 1);
    expect(bad.problems[0].messages[0].message).toMatch(/lower limit must be below/);
    const c = (await q(`SELECT code, subgroup_size, nominal::float AS nominal, usl::float AS usl FROM spc_characteristic WHERE tenant_id = $T`));
    expect(c).toEqual([{ code: 'BORE-1', subgroup_size: 3, nominal: 25, usl: 25.02 }]);
  });

  it('calibration: plan with the last calibration as history; no nonconformance or state change', async () => {
    const r = await load('calibration', 'Instrument (asset tag),Calibrate every,Tolerance,Last calibrated,Calibrated by,Certificate number,As found,As left\nMIC-01,annual,±0.002 mm,2026-05-10,Metrology Lab,C-1177,Fail,Adjusted\n');
    expect(r.stats.failed ?? 0).toBe(0);
    const p = (await q(`SELECT p.interval_days, p.next_due::text AS due, (SELECT count(*)::int FROM calibration_record r WHERE r.plan_id = p.id) AS records, (SELECT as_found FROM calibration_record r WHERE r.plan_id = p.id) AS found FROM calibration_plan p WHERE tenant_id = $T`))[0];
    expect(p).toEqual({ interval_days: 365, due: '2027-05-10', records: 1, found: 'out_of_tolerance' });
    expect((await q(`SELECT count(*)::int AS n FROM nonconformance WHERE tenant_id = $T`))[0].n).toBe(0);
    expect((await q(`SELECT operational_state FROM asset WHERE tenant_id = $T AND asset_tag = 'MIC-01'`))[0].operational_state).not.toBe('out_of_service');
    await load('calibration', 'Instrument (asset tag),Calibrate every,Tolerance,Last calibrated,Calibrated by\nMIC-01,365,±0.002 mm,2026-05-10,Metrology Lab\n');
    expect((await q(`SELECT count(*)::int AS n FROM calibration_record WHERE tenant_id = $T`))[0].n).toBe(1);
  });

  it('nonconformance history keeps the customer\'s number and dates, and is not duplicated on reload', async () => {
    const csv = 'Your NCR number,Date reported,Title,Severity,Where found,Part number,Quantity,Disposition,Cost,Date closed\nQR-0042,2025-03-04,Burr on bore,Major,incoming,HSG-100,12,Scrap,340.50,2025-03-20\nQR-0043,2025-06-01,Wrong material cert,minor,supplier,,,,,\n';
    const r = await load('nonconformance_history', csv);
    expect(r.stats).toMatchObject({ created: 2 });
    const rows = await q(`SELECT number, status, severity, source, disposition, cost::float AS cost, created_at::date::text AS created, closed_at::date::text AS closed FROM nonconformance WHERE tenant_id = $T ORDER BY number`);
    expect(rows).toEqual([{ number: 'NCR-000001', status: 'closed', severity: 'major', source: 'receiving', disposition: 'scrap', cost: 340.5, created: '2025-03-04', closed: '2025-03-20' },
      { number: 'NCR-000002', status: 'open', severity: 'minor', source: 'supplier', disposition: null, cost: null, created: '2025-06-01', closed: null }]);
    expect((await load('nonconformance_history', csv)).stats).toMatchObject({ created: 0, unchanged: 2 });
    expect((await q(`SELECT count(*)::int AS n FROM nonconformance WHERE tenant_id = $T`))[0].n).toBe(2);
  });

  it('safety history arrives closed with the recordable flag and days away', async () => {
    const csv = 'Your incident number,Date,Kind,What happened,Recordable,Days away,Severity\nSI-1,2025-02-11,Lost time,Strained shoulder lifting a die,yes,4,medium\nSI-2,2025-04-02,Near miss,Forklift came close to a pedestrian,,,low\n';
    const r = await load('safety_history', csv);
    expect(r.stats).toMatchObject({ created: 2 });
    const rows = await q(`SELECT kind, status, recordable, days_away, severity FROM safety_incident WHERE tenant_id = $T ORDER BY number`);
    expect(rows).toEqual([{ kind: 'injury', status: 'closed', recordable: true, days_away: 4, severity: 'medium' }, { kind: 'near_miss', status: 'closed', recordable: false, days_away: 0, severity: 'low' }]);
  });
});
