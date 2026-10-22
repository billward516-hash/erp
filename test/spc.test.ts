import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createAsset } from '../src/modules/assets/service.js';
import { commitImport, stageImport } from '../src/modules/imports/service.js';
import { createPart } from '../src/modules/parts/service.js';
import { recordCalibration, savePlan } from '../src/modules/quality/calibration.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { excludeSubgroup, getCharacteristic, listCharacteristics, recordSubgroup, respondToSignal, saveCharacteristic, setLimits } from '../src/modules/spc/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World; let qm: Actor; let site: string; let gauge: string; let calPlan: string; let charId: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
// A stable process around 25.000 with a small, repeating within-subgroup spread (R = 0.004 for every subgroup).
const base = (k: number) => { const m = 25 + [0, 0.001, -0.001, 0.0005, -0.0005][k % 5]!; return [m - 0.002, m - 0.001, m, m + 0.001, m + 0.002].map((v) => Math.round(v * 1e6) / 1e6); };

beforeAll(async () => {
  w = await makeWorld('spc');
  site = w.facilities.A!;
  const u = await createUserWithToken(db(), w.tenantId, { email: `qm-${Date.now()}@spc.example`, displayName: 'Quality Manager', roles: [{ role: 'quality_manager', facility: site }] });
  qm = (await loadActor(w.tenantId, u.userId))!;
  gauge = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site, assetTag: 'BG-1', name: 'Bore gauge', assetClass: 'tool' }))).id;
  calPlan = (await asActor(qm, (tx) => savePlan(tx, qm, { assetId: gauge, intervalDays: 365, tolerance: '±0.001 mm', nextDue: day(-60) }))).id;
  await asActor(qm, (tx) => recordCalibration(tx, qm, calPlan, { performedOn: day(-60), performedBy: 'QA lab', asFound: 'in_tolerance', asLeft: 'in_tolerance' }));
});
afterAll(closePools);

describe('characteristics and measurements', () => {
  it('a characteristic is set up by quality; measurements must match its subgroup size and are permanent', async () => {
    const part = await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'HSG-1', description: 'Housing', uom: 'EA' }));
    await expect(asActor(w.techA, (tx) => saveCharacteristic(tx, w.techA, { facilityId: site, code: 'X', name: 'X', subgroupSize: 5 }))).rejects.toThrow(/quality.manage/);
    await expect(asActor(qm, (tx) => saveCharacteristic(tx, qm, { facilityId: site, code: 'BORE', name: 'Bore', subgroupSize: 5, lsl: 25.02, usl: 24.98 }))).rejects.toThrow(/lower tolerance/);
    const c = await asActor(qm, (tx) => saveCharacteristic(tx, qm, { facilityId: site, code: 'BORE', name: 'Bore diameter', partId: part.id, opNo: 10, gaugeAssetId: gauge,
      unit: 'mm', nominal: 25, lsl: 24.98, usl: 25.02, subgroupSize: 5 }));
    charId = c.id;
    await expect(asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, charId, { values: [25, 25.001] }))).rejects.toThrow(/subgroups of 5; got 2 values/);
    // 24 subgroups over the last 48 hours, recorded by an operator.
    for (let k = 0; k < 24; k++) await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, charId, { values: base(k), measuredAt: hoursAgo(48 - 2 * k) }));
    await expect(db().query('UPDATE spc_subgroup SET vals = $2 WHERE characteristic_id = $1', [charId, [1, 2, 3, 4, 5]])).rejects.toThrow(/cannot be changed/);
    await expect(db().query('DELETE FROM spc_subgroup WHERE characteristic_id = $1', [charId])).rejects.toThrow(/cannot be deleted/);
    await expect(asActor(qm, (tx) => saveCharacteristic(tx, qm, { id: charId, facilityId: site, code: 'BORE', name: 'Bore diameter', subgroupSize: 3 }))).rejects.toThrow(/cannot change/);
  });

  it('without set limits the chart shows trial limits and raises no control signals', async () => {
    const c = await asActor(qm, (tx) => getCharacteristic(tx, qm, charId));
    expect(c.limits).toMatchObject({ trial: true, center: 25.000021, rangeCenter: 0.004 });
    expect(c.signals).toEqual([]);
    expect(c.warnings.join(' ')).toMatch(/set them from a baseline/);
    // R̄ = 0.004 → σ within = 0.004 / 2.326; tolerance ±0.02 → Cp = 0.04 / (6 × 0.00172) ≈ 3.88.
    expect(c.capability.cp).toBeCloseTo(0.04 / (6 * (0.004 / 2.326)), 1);
  });
});

describe('control limits and signals', () => {
  it('limits are set from a baseline of at least 20 subgroups, by quality', async () => {
    await expect(asActor(qm, (tx) => setLimits(tx, qm, charId, { from: hoursAgo(10), reason: 'too few' }))).rejects.toThrow(/at least 20/);
    await expect(asActor(w.techA, (tx) => setLimits(tx, w.techA, charId, { reason: 'x' }))).rejects.toThrow(/quality.manage/);
    const L = await asActor(qm, (tx) => setLimits(tx, qm, charId, { reason: 'Initial capability study, new boring bar' }));
    // Means cycle 25, 25.001, 24.999, 25.0005, 24.9995: 24 subgroups average 25.000021; UCL = X̄̄ + 0.577 × 0.004.
    expect(L).toMatchObject({ subgroups: 24, rangeCenter: 0.004, rangeUcl: 0.008456, rangeLcl: 0 });
    expect(L.ucl).toBeCloseTo(L.center + 0.577 * 0.004, 6);
  });

  it('a subgroup beyond the limits raises a signal and tells quality; an out-of-tolerance value raises its own', async () => {
    const r = await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, charId, { values: [25.008, 25.009, 25.01, 25.011, 25.025], lot: 'L-77' }));
    expect(r.signals.map((s) => s.rule).sort()).toEqual(['beyond_limits', 'out_of_spec', 'range_beyond']);
    const n = await db().query(`SELECT title FROM notification WHERE user_id = $1 AND kind = 'spc.signal'`, [qm.userId]);
    expect(n.rows[0].title).toMatch(/^BORE Bore diameter: /);
    const list = await asActor(qm, (tx) => listCharacteristics(tx, qm, { facilityId: site }));
    expect(list[0]).toMatchObject({ code: 'BORE', status: 'signal', openSignals: 3, limitsSet: true });
  });

  it('a signal is answered with the cause; it can raise a nonconformance and exclude the subgroup', async () => {
    const sigs = (await asActor(qm, (tx) => getCharacteristic(tx, qm, charId))).signals;
    const beyond = sigs.find((s: any) => s.rule === 'beyond_limits')!;
    await expect(asActor(qm, (tx) => respondToSignal(tx, qm, beyond.id, { cause: '', response: 'x' }))).rejects.toThrow(/cause/);
    const res = await asActor(qm, (tx) => respondToSignal(tx, qm, beyond.id, { cause: 'Boring insert chipped', response: 'Insert replaced, offset reset, last 20 parts sorted',
      raiseNcr: { severity: 'major', qty: 20 }, excludeSubgroup: true }));
    const ncr = (await db().query('SELECT source, severity, part_id, title FROM nonconformance WHERE id = $1', [res.ncrId])).rows[0];
    expect(ncr).toMatchObject({ source: 'production', severity: 'major', title: 'BORE Bore diameter: Beyond a control limit' });
    for (const s of sigs.filter((x: any) => x.id !== beyond.id)) await asActor(qm, (tx) => respondToSignal(tx, qm, s.id, { cause: 'Same chipped insert', response: 'See the NCR' }));
    const c = await asActor(qm, (tx) => getCharacteristic(tx, qm, charId));
    expect(c.openSignals).toBe(0);
    expect(c.subgroups.at(-1)).toMatchObject({ excluded: true, excludeReason: 'Signal: Boring insert chipped', lot: 'L-77' });
    await expect(asActor(qm, (tx) => excludeSubgroup(tx, qm, c.subgroups.at(-1).id, 'again please'))).rejects.toThrow(/already/);
  });

  it('a run of 9 above the center line is caught even when each point is inside the limits', async () => {
    const shifted = (k: number) => base(k).map((v) => Math.round((v + 0.0012) * 1e6) / 1e6); // inside the limits, above the center
    const rules: string[] = [];
    for (let k = 0; k < 9; k++) rules.push(...(await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, charId, { values: shifted(k) }))).signals.map((s) => s.rule));
    expect(rules).toContain('run_of_9');
    expect(rules).not.toContain('beyond_limits');
  });
});

describe('gauges', () => {
  it('refuses measurements with a gauge that was overdue; flags measurements taken before it was found out of tolerance', async () => {
    // Found out of tolerance today: everything measured since the last good calibration (60 days ago) is suspect.
    await asActor(qm, (tx) => recordCalibration(tx, qm, calPlan, { performedOn: day(0), performedBy: 'QA lab', asFound: 'out_of_tolerance', asLeft: 'adjusted', notes: 'Read +0.003 mm at 25 mm setting ring' }));
    const c = await asActor(qm, (tx) => getCharacteristic(tx, qm, charId));
    expect(c.subgroups.every((s: any) => s.suspect === `gauge found out of tolerance on ${day(0)}`)).toBe(true);
    expect(c.warnings.join(' ')).toMatch(/gauge later found out of tolerance/);
    // A second gauge, overdue since yesterday.
    const g2 = (await asActor(w.admin, (tx) => createAsset(tx, w.admin, { facilityId: site, assetTag: 'MIC-1', name: 'Micrometer', assetClass: 'tool' }))).id;
    await asActor(qm, (tx) => savePlan(tx, qm, { assetId: g2, intervalDays: 30, tolerance: '±0.001', nextDue: day(-1) }));
    const ch = await asActor(qm, (tx) => saveCharacteristic(tx, qm, { facilityId: site, code: 'OD', name: 'Outside diameter', gaugeAssetId: g2, lsl: 9.9, usl: 10.1, subgroupSize: 1 }));
    await expect(asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, ch.id, { values: [10] }))).rejects.toThrow(/MIC-1 was overdue for calibration/);
    // Measured before it fell due: accepted.
    await asActor(w.techA, (tx) => recordSubgroup(tx, w.techA, ch.id, { values: [10], measuredAt: hoursAgo(72) }));
  });
});

describe('imports and the report', () => {
  it('imports one row per subgroup, values in one column or joined from several; then the report answers first', async () => {
    const csv = Buffer.from('Char,Date,X1,X2,X3,X4,X5\nBORE,2026-01-05 08:00,25.001,25.002,25,24.999,24.998\nBORE,2026-01-05 10:00,25.001,25.002,25,24.999\nNOPE,2026-01-05 10:00,1,1,1,1,1\n');
    const st = await stageImport(w.admin, { target: 'spc_measurements', sourceSystem: 'cmm', fileName: 'cmm.csv', content: csv, facilityId: site,
      mapping: { fields: { characteristic: { source: 'Char' }, measured_at: { source: 'Date' }, values: { template: '{X1};{X2};{X3};{X4};{X5}' } } } as any });
    expect(st.stats).toMatchObject({ total: 3, errors: 2 });
    const errs = (await db().query(`SELECT messages FROM import_row WHERE batch_id = $1 ORDER BY row_number`, [st.batchId])).rows.map((r) => JSON.stringify(r.messages));
    expect(errs[1]).toMatch(/4 values; BORE is measured in subgroups of 5/);
    expect(errs[2]).toMatch(/no characteristic NOPE/);
    await commitImport(w.admin, st.batchId, { allowPartial: true });
    expect((await db().query(`SELECT count(*)::int AS n FROM spc_subgroup WHERE characteristic_id = $1 AND source = 'import'`, [charId])).rows[0].n).toBe(1);
    const def = getReport('spc-summary')!;
    const r = await asActor(qm, (tx) => def.run(tx, qm, def.params.parse({ facilityId: site })));
    expect(r.headline).toMatch(/^(1 characteristic of 2 has open control-chart signals|All 2 characteristics without open signals); lowest Cpk \d+\.\d\d \((BORE|OD)\)$/);
  });
});
