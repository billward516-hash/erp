import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { createMethod, getMethod, listMethods, reviseMethod } from '../src/modules/lab/methods.js';
import { addTest, cancelTest, closeInvestigation, enterResults, getInvestigation, raiseQuality, returnTest, reviewTest, updateInvestigation } from '../src/modules/lab/results.js';
import { disposeSample, getSample, holdSample, receiveSample, recordCustody, releaseSample, resumeSample } from '../src/modules/lab/samples.js';
import { recordCalibration } from '../src/modules/quality/calibration.js';
import { getNcr } from '../src/modules/quality/service.js';
import type { Lab } from './lab-fixtures.js';
import { day, db, enterPassing, grantQualification, makeLab, passing, sampleWithTest } from './lab-fixtures.js';

let l: Lab;
type Who = 'analyst' | 'unqualified' | 'reviewer' | 'manager' | 'quality' | 'managerB';
const as = <T>(who: Who, fn: (tx: any, a: any) => Promise<T>) => asActor(l[who], (tx) => fn(tx, l[who]));
beforeAll(async () => { l = await makeLab('labwf'); });
afterAll(closePools);

describe('analyst qualification gating', () => {
  it('refuses an analyst without the method’s qualification and names the missing one', async () => {
    const { test } = await sampleWithTest(l);
    await expect(as('unqualified', (tx, a) => enterResults(tx, a, test.id, passing(l)))).rejects.toThrow(/not qualified to run TITR-01 v1: QUAL-TITR Potentiometric titration \(not held\)/);
    const e: any = await as('unqualified', (tx, a) => enterResults(tx, a, test.id, passing(l))).catch((x) => x);
    expect(e.code).toBe('not_qualified');
    expect(e.details.missing[0]).toMatchObject({ code: 'QUAL-TITR', status: 'not_held' });
    expect((await db().query('SELECT count(*)::int AS n FROM lab_result WHERE test_id = $1', [test.id])).rows[0].n).toBe(0);
  });

  it('refuses an expired or revoked qualification, and a user with no employee record', async () => {
    const { test } = await sampleWithTest(l);
    const emp = (await db().query('SELECT employee_id FROM app_user WHERE id = $1', [l.unqualified.userId])).rows[0].employee_id;
    await grantQualification(l.w, emp, l.qualId, { expiresOn: day(-1) });
    await expect(as('unqualified', (tx, a) => enterResults(tx, a, test.id, passing(l)))).rejects.toThrow(/\(expired\)/);
    await grantQualification(l.w, emp, l.qualId, { revoked: true });
    await expect(as('unqualified', (tx, a) => enterResults(tx, a, test.id, passing(l)))).rejects.toThrow(/\(revoked\)/);
    // The quality manager has no employee record: with lab.analyze it would still be refused, because the qualification cannot be checked.
    await db().query(`UPDATE role SET permissions = permissions || ARRAY['lab.analyze'] WHERE tenant_id = $1 AND key = 'quality_manager'`, [l.w.tenantId]);
    const q = (await loadActor(l.w.tenantId, l.quality.userId))!;
    await expect(asActor(q, (tx) => enterResults(tx, q, test.id, passing(l)))).rejects.toThrow(/not linked to an employee record/);
  });

  it('a method with no required qualification can be run by any analyst', async () => {
    const m = await as('manager', (tx, a) => createMethod(tx, a, { facilityId: l.w.facilities.A!, code: 'VISC-01', name: 'Viscosity', analytes: [{ name: 'Viscosity', unit: 'cP', specHigh: 50 }] }));
    const s = await as('analyst', (tx, a) => receiveSample(tx, a, { facilityId: l.w.facilities.A!, source: 'internal', description: 'Batch oil', dueOn: day(3) }));
    const t = await as('unqualified', (tx, a) => addTest(tx, a, s.id, { methodId: m.id }));
    const analyte = (await db().query('SELECT id FROM lab_method_analyte WHERE method_id = $1', [m.id])).rows[0].id;
    expect(await as('unqualified', (tx, x) => enterResults(tx, x, t.id, [{ analyteId: analyte, value: 40 }]))).toEqual({ complete: true, outOfSpecification: 0 });
  });
});

describe('instrument calibration gating', () => {
  it('refuses an overdue instrument with the existing calibration message', async () => {
    const { test } = await sampleWithTest(l);
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, passing(l, l.balanceOverdue)))).rejects.toThrow(/BAL-2 is overdue for calibration/);
  });

  it('refuses an instrument of the wrong class, one not under calibration control, and a missing instrument', async () => {
    const { test } = await sampleWithTest(l);
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, passing(l, l.phMeter)))).rejects.toThrow(/PH-1 is a pH meter; this method needs a Balance/);
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, passing(l, l.notControlled)))).rejects.toThrow(/BAL-3 is not under calibration control/);
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, [{ analyteId: l.titrationAnalytes.Assay!, value: 99 }]))).rejects.toThrow(/choose the Balance used/);
  });

  it('an instrument that becomes overdue is refused; a failed calibration blocks it until a passing one', async () => {
    const { test } = await sampleWithTest(l);
    const plan = (await db().query('SELECT id FROM calibration_plan WHERE asset_id = $1', [l.balance])).rows[0].id;
    await db().query('UPDATE calibration_plan SET next_due = $2 WHERE id = $1', [plan, day(-1)]);
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, passing(l)))).rejects.toThrow(/overdue for calibration/);
    await db().query('UPDATE calibration_plan SET next_due = $2 WHERE id = $1', [plan, day(30)]);
    const q = l.w.qualityA;
    await asActor(q, (tx) => recordCalibration(tx, q, plan, { performedOn: day(0), performedBy: 'Cal lab', asFound: 'in_tolerance', asLeft: 'failed' }));
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, passing(l)))).rejects.toThrow(/failed its last calibration or is out of service/);
    await asActor(q, (tx) => recordCalibration(tx, q, plan, { performedOn: day(0), performedBy: 'Cal lab', asFound: 'in_tolerance', asLeft: 'in_tolerance' }));
    expect((await as('analyst', (tx, a) => enterResults(tx, a, test.id, passing(l)))).complete).toBe(true);
  });

  it('keeps the instrument id and its calibration due date with each result', async () => {
    const { test } = await sampleWithTest(l);
    await enterPassing(l, test.id);
    const r = (await db().query('SELECT instrument_tag, instrument_cal_due::text AS due, outcome FROM lab_result WHERE test_id = $1', [test.id])).rows;
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.instrument_tag === 'BAL-1' && x.outcome === 'pass')).toBe(true);
    expect(r[0].due).toMatch(/^\d{4}-\d\d-\d\d$/);
  });
});

describe('pass or fail at entry', () => {
  it('computes the outcome against one- and two-sided limits and keeps the limits it used', async () => {
    const { test } = await sampleWithTest(l);
    const out = await as('analyst', (tx, a) => enterResults(tx, a, test.id, [
      { analyteId: l.titrationAnalytes.Assay!, value: 97.5, instrumentId: l.balance }, // below the only (lower) limit
      { analyteId: l.titrationAnalytes.Moisture!, value: 0.1, instrumentId: l.balance }, // no lower limit exists
      { analyteId: l.titrationAnalytes.pH!, value: 7.5, instrumentId: l.balance }, // on the upper limit
    ]));
    expect(out).toEqual({ complete: true, outOfSpecification: 1 });
    const r = Object.fromEntries((await db().query('SELECT analyte_name, outcome, spec_low::float AS lo, spec_high::float AS hi FROM lab_result WHERE test_id = $1', [test.id])).rows.map((x) => [x.analyte_name, x]));
    expect(r.Assay).toMatchObject({ outcome: 'fail', lo: 98, hi: null });
    expect(r.Moisture).toMatchObject({ outcome: 'pass', lo: null, hi: 2 });
    expect(r.pH).toMatchObject({ outcome: 'pass', lo: 6.5, hi: 7.5 });
  });

  it('results are never edited or deleted, and an analyte takes one result', async () => {
    const { test } = await sampleWithTest(l);
    await enterPassing(l, test.id);
    await expect(db().query('UPDATE lab_result SET value = 100 WHERE test_id = $1', [test.id])).rejects.toThrow(/cannot be changed/);
    await expect(db().query('DELETE FROM lab_result WHERE test_id = $1', [test.id])).rejects.toThrow(/cannot be deleted/);
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, [{ analyteId: l.titrationAnalytes.pH!, value: 7, instrumentId: l.balance }]))).rejects.toThrow(/already entered/);
  });

  it('a method version in use cannot have its analytes or limits edited; a revision is a new version', async () => {
    await expect(db().query('UPDATE lab_method_analyte SET spec_high = 99 WHERE method_id = $1', [l.methodId])).rejects.toThrow(/save a new version/);
    const v2 = await as('manager', (tx, a) => reviseMethod(tx, a, l.methodId, { analytes: [{ name: 'Assay', unit: '%', specLow: 99 }, { name: 'pH', unit: 'pH', specLow: 6.5, specHigh: 7.5 }] }));
    expect(v2.version).toBe(2);
    expect((await as('manager', (tx, a) => getMethod(tx, a, l.methodId))).status).toBe('retired');
    expect((await as('manager', (tx, a) => listMethods(tx, a, {}))).filter((m: any) => m.code === 'TITR-01').map((m: any) => `${m.code} v${m.version}`)).toEqual(['TITR-01 v2']);
    const s = await as('analyst', (tx, a) => receiveSample(tx, a, { facilityId: l.w.facilities.A!, source: 'internal', description: 'Spare sample', dueOn: day(2) }));
    await expect(as('analyst', (tx, a) => addTest(tx, a, s.id, { methodId: l.methodId }))).rejects.toThrow(/retired/);
    // Restore a version equal to the first for the tests that follow.
    const v3 = await as('manager', (tx, a) => reviseMethod(tx, a, v2.id, { analytes: [{ name: 'Assay', unit: '%', specLow: 98 }, { name: 'Moisture', unit: '%', specHigh: 2 }, { name: 'pH', unit: 'pH', specLow: 6.5, specHigh: 7.5 }] }));
    l.methodId = v3.id;
    l.titrationAnalytes = Object.fromEntries((await db().query('SELECT id, name FROM lab_method_analyte WHERE method_id = $1', [v3.id])).rows.map((r) => [r.name, r.id]));
  });
});

describe('separation of duties', () => {
  it('the person who entered the results cannot review them; a reviewer with lab.review can', async () => {
    const { test } = await sampleWithTest(l);
    await as('manager', (tx, a) => enterResults(tx, a, test.id, passing(l)));
    await expect(as('manager', (tx, a) => reviewTest(tx, a, test.id))).rejects.toThrow(/you entered these results; a different person reviews them/);
    await expect(as('analyst', (tx, a) => reviewTest(tx, a, test.id))).rejects.toThrow(/lab\.review/);
    await as('reviewer', (tx, a) => reviewTest(tx, a, test.id, 'Checked against the worksheet'));
    expect((await db().query('SELECT status, reviewed_by FROM lab_test WHERE id = $1', [test.id])).rows[0]).toMatchObject({ status: 'reviewed', reviewed_by: l.reviewer.userId });
  });

  it('there is no single-person exception: the licence setting for approvals does not let an analyst review their own results', async () => {
    await db().query('UPDATE tenant_license SET single_person_approval = true WHERE tenant_id = $1', [l.w.tenantId]);
    try {
      const { test } = await sampleWithTest(l);
      await as('manager', (tx, a) => enterResults(tx, a, test.id, passing(l)));
      await expect(as('manager', (tx, a) => reviewTest(tx, a, test.id))).rejects.toThrow(/a different person reviews them/);
    } finally {
      await db().query('UPDATE tenant_license SET single_person_approval = false WHERE tenant_id = $1', [l.w.tenantId]);
    }
  });

  it('a person who entered results cannot release the sample', async () => {
    const { sample, test } = await sampleWithTest(l);
    await as('manager', (tx, a) => enterResults(tx, a, test.id, passing(l)));
    await as('reviewer', (tx, a) => reviewTest(tx, a, test.id));
    await expect(as('manager', (tx, a) => releaseSample(tx, a, sample.id))).rejects.toThrow(/you entered results for this sample/);
    await as('reviewer', (tx, a) => releaseSample(tx, a, sample.id));
  });

  it('a returned test supersedes its results (kept with the reason) and is entered again', async () => {
    const { sample, test } = await sampleWithTest(l);
    await enterPassing(l, test.id);
    await as('reviewer', (tx, a) => returnTest(tx, a, test.id, 'Moisture was read from the wrong sheet'));
    const d = await as('analyst', (tx, a) => getSample(tx, a, sample.id));
    expect(d.status).toBe('in_testing');
    expect(d.tests[0].results.filter((r: any) => r.superseded_at)).toHaveLength(3);
    expect(d.tests[0].results[0].superseded_reason).toMatch(/Returned by .*wrong sheet/);
    await enterPassing(l, test.id);
    expect((await as('analyst', (tx, a) => getSample(tx, a, sample.id))).status).toBe('in_review');
  });
});

describe('out-of-specification flow', () => {
  let sample: any; let test: any; let inv: any;
  it('an out-of-limit result opens an investigation automatically and notifies the reviewers', async () => {
    ({ sample, test } = await sampleWithTest(l));
    const out = await as('analyst', (tx, a) => enterResults(tx, a, test.id, [
      { analyteId: l.titrationAnalytes.Assay!, value: 96.8, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.Moisture!, value: 1.0, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.pH!, value: 7.1, instrumentId: l.balance }]));
    expect(out.outOfSpecification).toBe(1);
    const d = await as('analyst', (tx, a) => getSample(tx, a, sample.id));
    expect(d.investigations).toHaveLength(1);
    inv = d.investigations[0];
    expect(inv).toMatchObject({ status: 'open', analyte_name: 'Assay', number: expect.stringMatching(/^OOS-\d{6}$/) });
    expect((await db().query(`SELECT count(*)::int AS n FROM notification WHERE kind = 'lab.oos_opened' AND user_id = $1 AND subject_id = $2`, [l.reviewer.userId, inv.id])).rows[0].n).toBe(1);
  });

  it('blocks review and release until the investigation is closed', async () => {
    await expect(as('reviewer', (tx, a) => reviewTest(tx, a, test.id))).rejects.toThrow(new RegExp(`${inv.number} is open on this test`));
    await expect(as('reviewer', (tx, a) => releaseSample(tx, a, sample.id))).rejects.toThrow(new RegExp(`${inv.number} is still open; close the out-of-specification investigation before releasing`));
    await expect(as('manager', (tx, a) => disposeSample(tx, a, sample.id, { note: 'poured away', confirmEarly: true }))).rejects.toThrow(/still open; keep the sample/);
  });

  it('closing needs a cause, a conclusion, a decision and a different reviewer; an invalidation needs its reason', async () => {
    await expect(as('reviewer', (tx, a) => closeInvestigation(tx, a, inv.id, { decision: 'confirmed_oos', conclusion: 'Real failure' }))).rejects.toThrow(/record the cause/);
    await as('analyst', (tx, a) => updateInvestigation(tx, a, inv.id, { cause: 'Titrant drifted', retestResult: 'Retest 96.9 %' }));
    await expect(as('reviewer', (tx, a) => closeInvestigation(tx, a, inv.id, { decision: 'invalidated', conclusion: 'Lab error' }))).rejects.toThrow(/the reason it is invalid/);
    await expect(as('analyst', (tx, a) => closeInvestigation(tx, a, inv.id, { decision: 'confirmed_oos', conclusion: 'Real failure' }))).rejects.toThrow(/lab\.review/);
    expect((await as('manager', (tx, a) => getInvestigation(tx, a, inv.id))).canClose).toBe(true);
    expect((await as('analyst', (tx, a) => getInvestigation(tx, a, inv.id))).canClose).toBe(false);
  });

  it('a person who entered the failing result cannot close its investigation, even with lab.review', async () => {
    const { test: t } = await sampleWithTest(l);
    await as('manager', (tx, a) => enterResults(tx, a, t.id, [{ analyteId: l.titrationAnalytes.Moisture!, value: 3, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.Assay!, value: 99, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.pH!, value: 7, instrumentId: l.balance }]));
    const i = (await db().query('SELECT id FROM lab_investigation WHERE test_id = $1', [t.id])).rows[0];
    await as('manager', (tx, a) => updateInvestigation(tx, a, i.id, { cause: 'Wet sample' }));
    await expect(as('manager', (tx, a) => closeInvestigation(tx, a, i.id, { decision: 'confirmed_oos', conclusion: 'Moisture is high.' }))).rejects.toThrow(/a different reviewer closes it/);
  });

  it('a confirmed result is released as it is once the investigation is closed, and raises one nonconformance linked to it', async () => {
    await as('reviewer', (tx, a) => closeInvestigation(tx, a, inv.id, { decision: 'confirmed_oos', conclusion: 'The batch is below its assay specification.' }));
    await expect(as('reviewer', (tx, a) => closeInvestigation(tx, a, inv.id, { decision: 'confirmed_oos', conclusion: 'again' }))).rejects.toThrow(/already closed/);
    await as('reviewer', (tx, a) => reviewTest(tx, a, test.id));
    await as('quality', (tx, a) => releaseSample(tx, a, sample.id, 'Released with the confirmed out-of-specification result reported'));
    expect((await as('reviewer', (tx, a) => getSample(tx, a, sample.id))).status).toBe('released');
    const n = await as('reviewer', (tx, a) => raiseQuality(tx, a, inv.id, { kind: 'ncr', severity: 'major' }));
    expect(n.kind).toBe('ncr');
    const ncr = await asActor(l.w.qualityA, (tx) => getNcr(tx, l.w.qualityA, n.id));
    expect(ncr).toMatchObject({ severity: 'major', source: 'internal', number: n.number });
    expect(ncr.description).toMatch(/Assay 96\.8 % against at least 98 %/);
    expect(ncr.description).toMatch(/Cause: Titrant drifted/);
    expect((await as('reviewer', (tx, a) => getInvestigation(tx, a, inv.id))).ncr_number).toBe(n.number);
  });

  it('allows only one nonconformance or corrective action per investigation', async () => {
    await expect(as('reviewer', (tx, a) => raiseQuality(tx, a, inv.id, { kind: 'ncr' }))).rejects.toThrow(/already raised NCR-/);
    await expect(as('quality', (tx, a) => raiseQuality(tx, a, inv.id, { kind: 'capa' }))).rejects.toThrow(/already raised NCR-/);
    expect((await db().query('SELECT count(*)::int AS n FROM nonconformance WHERE tenant_id = $1 AND title LIKE $2', [l.w.tenantId, `${inv.number}%`])).rows[0].n).toBe(1);
  });

  it('can raise a corrective action instead, owned by the person named', async () => {
    const { sample: s2, test: t2 } = await sampleWithTest(l);
    await as('analyst', (tx, a) => enterResults(tx, a, t2.id, [{ analyteId: l.titrationAnalytes.Moisture!, value: 2.6, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.Assay!, value: 99, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.pH!, value: 7, instrumentId: l.balance }]));
    const i2 = (await as('analyst', (tx, a) => getSample(tx, a, s2.id))).investigations[0];
    await expect(as('quality', (tx, a) => raiseQuality(tx, a, i2.id, { kind: 'capa' }))).rejects.toThrow(/only a closed investigation that confirmed/);
    await as('analyst', (tx, a) => updateInvestigation(tx, a, i2.id, { cause: 'Sample absorbed water in transit' }));
    await as('quality', (tx, a) => closeInvestigation(tx, a, i2.id, { decision: 'confirmed_oos', conclusion: 'Moisture is above the limit.' }));
    const c = await as('quality', (tx, a) => raiseQuality(tx, a, i2.id, { kind: 'capa', ownerUserId: l.quality.userId }));
    expect(c.number).toMatch(/^CA-/);
    expect((await as('quality', (tx, a) => getInvestigation(tx, a, i2.id))).capa_number).toBe(c.number);
  });

  it('an invalidated result is superseded and replaced; the replacement may be released', async () => {
    const { sample: s3, test: t3 } = await sampleWithTest(l);
    await as('analyst', (tx, a) => enterResults(tx, a, t3.id, [{ analyteId: l.titrationAnalytes.pH!, value: 8.4, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.Assay!, value: 99, instrumentId: l.balance }, { analyteId: l.titrationAnalytes.Moisture!, value: 1, instrumentId: l.balance }]));
    const i3 = (await as('analyst', (tx, a) => getSample(tx, a, s3.id))).investigations[0];
    await as('analyst', (tx, a) => updateInvestigation(tx, a, i3.id, { cause: 'Electrode not conditioned', retestResult: 'pH 7.0 after conditioning' }));
    await as('reviewer', (tx, a) => closeInvestigation(tx, a, i3.id, { decision: 'invalidated', conclusion: 'Laboratory error, result invalid.', invalidReason: 'Electrode not conditioned per the method' }));
    await expect(as('reviewer', (tx, a) => raiseQuality(tx, a, i3.id, { kind: 'ncr' }))).rejects.toThrow(/only a closed investigation that confirmed/);
    let d = await as('analyst', (tx, a) => getSample(tx, a, s3.id));
    expect(d.status).toBe('in_testing');
    expect(d.tests[0].status).toBe('assigned');
    await as('analyst', (tx, a) => enterResults(tx, a, t3.id, [{ analyteId: l.titrationAnalytes.pH!, value: 7.0, instrumentId: l.balance }]));
    await as('reviewer', (tx, a) => reviewTest(tx, a, t3.id));
    await as('reviewer', (tx, a) => releaseSample(tx, a, s3.id));
    d = await as('analyst', (tx, a) => getSample(tx, a, s3.id));
    expect(d.status).toBe('released');
    const pH = d.tests[0].results.filter((r: any) => r.analyte_name === 'pH');
    expect(pH.map((r: any) => [r.value, r.outcome, !!r.superseded_at])).toEqual([[8.4, 'fail', true], [7, 'pass', false]]);
  });
});

describe('custody and sample life', () => {
  it('custody events are appended with who, when, from and to, and cannot be changed or removed', async () => {
    const s = await as('analyst', (tx, a) => receiveSample(tx, a, { facilityId: l.w.facilities.A!, source: 'customer', customerReference: 'PO-9', description: 'Tablet bulk', container: 'HDPE jar', quantity: 250, quantityUnit: 'g', storageLocation: 'Fridge 2', dueOn: day(4), retentionUntil: day(90) }));
    await as('analyst', (tx, a) => recordCustody(tx, a, s.id, { kind: 'moved', toWhere: 'Bench 3', note: 'For weighing' }));
    await as('manager', (tx, a) => recordCustody(tx, a, s.id, { kind: 'handed_over', toWhere: 'Rae Reviewer', fromWhere: 'Bench 3' }));
    const d = await as('analyst', (tx, a) => getSample(tx, a, s.id));
    expect(d.custody.map((e: any) => [e.kind, e.from_where, e.to_where, e.by_name])).toEqual([
      ['received', 'Customer', 'Fridge 2', 'analyst'], ['moved', 'Fridge 2', 'Bench 3', 'analyst'], ['handed_over', 'Bench 3', 'Rae Reviewer', 'manager']]);
    expect(d.storage_location).toBe('Bench 3');
    expect(d.custody.every((e: any) => e.at)).toBe(true);
    await expect(db().query('UPDATE lab_custody_event SET to_where = $2 WHERE sample_id = $1', [s.id, 'elsewhere'])).rejects.toThrow(/cannot be changed or removed/);
    await expect(db().query('DELETE FROM lab_custody_event WHERE sample_id = $1', [s.id])).rejects.toThrow(/cannot be changed or removed/);
  });

  it('hold stops results and release; resuming returns the sample to where it was', async () => {
    const { sample, test } = await sampleWithTest(l);
    await expect(as('analyst', (tx, a) => holdSample(tx, a, sample.id, 'Customer asked to wait'))).rejects.toThrow(/lab\.review/);
    await as('reviewer', (tx, a) => holdSample(tx, a, sample.id, 'Customer asked to wait'));
    await expect(as('analyst', (tx, a) => enterResults(tx, a, test.id, passing(l)))).rejects.toThrow(/is on hold/);
    await as('reviewer', (tx, a) => resumeSample(tx, a, sample.id));
    const d = await as('analyst', (tx, a) => getSample(tx, a, sample.id));
    expect(d.status).toBe('in_testing');
    expect(d.custody.map((e: any) => e.kind)).toEqual(['received', 'on_hold', 'resumed']);
  });

  it('follows its tests through received and in testing; cancelled tests do not count', async () => {
    const s = await as('analyst', (tx, a) => receiveSample(tx, a, { facilityId: l.w.facilities.A!, source: 'internal', description: 'Water', dueOn: day(2) }));
    expect(s.status).toBe('received');
    const t = await as('analyst', (tx, a) => addTest(tx, a, s.id, { methodId: l.methodId }));
    expect((await as('analyst', (tx, a) => getSample(tx, a, s.id))).status).toBe('in_testing');
    await as('analyst', (tx, a) => cancelTest(tx, a, t.id, 'Wrong method'));
    expect((await as('analyst', (tx, a) => getSample(tx, a, s.id))).status).toBe('received');
    await expect(as('reviewer', (tx, a) => releaseSample(tx, a, s.id))).rejects.toThrow(/no tests to release/);
  });

  it('disposal before the retention date needs confirmation and is recorded in custody', async () => {
    const { sample, test } = await sampleWithTest(l, { retentionUntil: day(30) });
    await enterPassing(l, test.id);
    await as('reviewer', (tx, a) => reviewTest(tx, a, test.id));
    await as('reviewer', (tx, a) => releaseSample(tx, a, sample.id));
    await expect(as('analyst', (tx, a) => disposeSample(tx, a, sample.id, { note: 'Incinerated' }))).rejects.toThrow(/lab\.manage/);
    await expect(as('manager', (tx, a) => disposeSample(tx, a, sample.id, { note: 'Incinerated' }))).rejects.toThrow(/retained until .*confirm early disposal/);
    await as('manager', (tx, a) => disposeSample(tx, a, sample.id, { note: 'Incinerated by the manager', confirmEarly: true }));
    const d = await as('manager', (tx, a) => getSample(tx, a, sample.id));
    expect(d.status).toBe('disposed');
    expect(d.custody.at(-1)).toMatchObject({ kind: 'disposed' });
    expect(d.custody.at(-1).note).toMatch(/Early disposal/);
    await expect(as('analyst', (tx, a) => recordCustody(tx, a, sample.id, { kind: 'moved', toWhere: 'x' }))).rejects.toThrow(/disposed/);
  });

  it('rejects impossible dates and a customer on an internal sample', async () => {
    const base = { facilityId: l.w.facilities.A!, source: 'internal' as const, description: 'Water' };
    await expect(as('analyst', (tx, a) => receiveSample(tx, a, { ...base, dueOn: day(-3) }))).rejects.toThrow(/before the received date/);
    await expect(as('analyst', (tx, a) => receiveSample(tx, a, { ...base, dueOn: day(3), receivedOn: day(1) }))).rejects.toThrow(/future/);
    await expect(as('analyst', (tx, a) => receiveSample(tx, a, { ...base, dueOn: day(3), customerId: '00000000-0000-0000-0000-000000000000' }))).rejects.toThrow(/no customer/);
  });
});
