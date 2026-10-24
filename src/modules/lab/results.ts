import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { qualificationStatus } from '../learning/qualifications.js';
import { assertCalibrated } from '../quality/calibration.js';
import { assertAssignable, createCapa, createNcr } from '../quality/service.js';
import { lockSample, refreshStatus } from './samples.js';
import { evaluate, limitText } from './spec.js';

const day = (v: unknown) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export async function addTest(tx: Tx, actor: Actor, sampleId: string, input: { methodId: string; assignedUserId?: string | null }) {
  const s = await lockSample(tx, sampleId);
  requirePermission(actor, 'lab.analyze', s.facility_id);
  if (['released', 'disposed', 'on_hold'].includes(s.status)) throw conflict(`${s.number} is ${s.status.replace('_', ' ')}; tests cannot be added`);
  const m = await one(tx, 'SELECT * FROM lab_method WHERE id = $1', [input.methodId]);
  if (!m) throw notFound('method');
  if (m.facility_id !== s.facility_id) throw invalid('the method belongs to another site');
  if (m.status !== 'active') throw conflict(`${m.code} version ${m.version} is retired; use its current version`);
  if (input.assignedUserId) await assertAssignable(tx, input.assignedUserId, s.facility_id);
  const t = await one(tx, 'INSERT INTO lab_test (tenant_id, facility_id, sample_id, method_id, assigned_user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [actor.tenantId, s.facility_id, sampleId, m.id, input.assignedUserId ?? null, actor.userId]);
  await refreshStatus(tx, sampleId);
  await audit(tx, actor, { action: 'lab.test_added', entityType: 'lab_test', entityId: t.id, facilityId: s.facility_id, data: { sample: s.number, method: m.code, version: m.version } });
  return t;
}

async function lockTest(tx: Tx, id: string) {
  const t = await one(tx, `SELECT t.*, m.code AS method_code, m.version AS method_version, m.name AS method_name, m.required_qualification_id, m.required_instrument_class,
      s.number AS sample_number, s.status AS sample_status, s.customer_id, s.source
    FROM lab_test t JOIN lab_method m ON m.id = t.method_id JOIN lab_sample s ON s.id = t.sample_id WHERE t.id = $1 FOR UPDATE OF t`, [id]);
  if (!t) throw notFound('test');
  return t;
}

export async function cancelTest(tx: Tx, actor: Actor, testId: string, reason: string) {
  const t = await lockTest(tx, testId);
  requirePermission(actor, 'lab.analyze', t.facility_id);
  if (['reviewed', 'cancelled'].includes(t.status)) throw conflict(`the test is ${t.status}`);
  if (!reason?.trim() || reason.trim().length < 3) throw invalid('say why the test is cancelled');
  if (await one(tx, `SELECT 1 FROM lab_investigation WHERE test_id = $1 AND status = 'open'`, [testId])) throw conflict('close the open investigation on this test first');
  await tx.query(`UPDATE lab_test SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1`, [testId, reason.trim()]);
  await refreshStatus(tx, t.sample_id);
  await audit(tx, actor, { action: 'lab.test_cancelled', entityType: 'lab_test', entityId: testId, facilityId: t.facility_id, data: { sample: t.sample_number, reason } });
}

// ---------------------------------------------------------------------------
// Result entry: qualified analyst, instrument in calibration, pass/fail at entry
// ---------------------------------------------------------------------------

/** The analyst must hold the method's qualification (existing qualification gating); the refusal names the one that is missing. */
async function assertAnalystQualified(tx: Tx, actor: Actor, t: any) {
  if (!t.required_qualification_id) return;
  const q = await one(tx, 'SELECT code, name FROM qualification WHERE id = $1', [t.required_qualification_id]);
  if (!actor.employeeId) {
    throw new AppError(422, 'not_qualified', `${t.method_code} v${t.method_version} needs the ${q!.code} qualification, and your user is not linked to an employee record, so it cannot be checked`,
      { missing: [{ code: q!.code, name: q!.name, status: 'no_employee_record' }] });
  }
  const s = await qualificationStatus(tx, actor.employeeId, t.required_qualification_id);
  if (s.status !== 'active') {
    throw new AppError(422, 'not_qualified', `${actor.displayName} is not qualified to run ${t.method_code} v${t.method_version}: ${q!.code} ${q!.name} (${s.status.replace(/_/g, ' ')})`,
      { missing: [{ code: q!.code, name: q!.name, status: s.status }] });
  }
}

/** The instrument must be at the site, of the class the method needs, under calibration control and not overdue or failed (reuses the production-run block). */
async function checkInstrument(tx: Tx, assetId: string, facilityId: string, requiredClass: string | null) {
  const a = await one(tx, 'SELECT id, asset_tag, name, category, facility_id, lifecycle_status, operational_state FROM asset WHERE id = $1', [assetId]);
  if (!a) throw invalid('the instrument was not found');
  if (a.facility_id !== facilityId) throw invalid(`${a.asset_tag} is at another site`);
  if (a.lifecycle_status !== 'active') throw invalid(`${a.asset_tag} is not in service`);
  if (requiredClass && (a.category ?? '').trim().toLowerCase() !== requiredClass.trim().toLowerCase()) {
    throw invalid(`${a.asset_tag} is ${a.category ? `a ${a.category}` : 'not classed as an instrument'}; this method needs a ${requiredClass}`);
  }
  const plan = await one(tx, `SELECT p.next_due, p.active, (SELECT r.as_left FROM calibration_record r WHERE r.plan_id = p.id ORDER BY r.performed_on DESC, r.created_at DESC LIMIT 1) AS last_as_left
    FROM calibration_plan p WHERE p.asset_id = $1`, [assetId]);
  if (!plan || !plan.active) throw invalid(`${a.asset_tag} is not under calibration control; add it to the calibration plan before using it for results`);
  await assertCalibrated(tx, assetId);
  if (plan.last_as_left === 'failed' || a.operational_state === 'out_of_service') throw conflict(`${a.asset_tag} failed its last calibration or is out of service; it cannot be used for results`);
  return { tag: a.asset_tag as string, calDue: day(plan.next_due) };
}

export interface ResultInput { analyteId: string; value: number; instrumentId?: string | null; note?: string | null }

export async function enterResults(tx: Tx, actor: Actor, testId: string, results: ResultInput[]) {
  const t = await lockTest(tx, testId);
  requirePermission(actor, 'lab.analyze', t.facility_id);
  if (t.status === 'cancelled') throw conflict('the test was cancelled');
  if (t.status !== 'assigned') throw conflict(`results are already entered (${t.status}); the reviewer can return the test for correction`);
  if (['on_hold', 'released', 'disposed'].includes(t.sample_status)) throw conflict(`${t.sample_number} is ${t.sample_status.replace('_', ' ')}`);
  if (!results?.length) throw invalid('enter at least one result');
  await assertAnalystQualified(tx, actor, t);
  const analytes = new Map((await many(tx, 'SELECT * FROM lab_method_analyte WHERE method_id = $1', [t.method_id])).map((a) => [a.id as string, a]));
  const have = new Set((await many(tx, 'SELECT analyte_id FROM lab_result WHERE test_id = $1 AND superseded_at IS NULL', [testId])).map((r) => r.analyte_id as string));
  const seen = new Set<string>();
  const instruments = new Map<string, { tag: string; calDue: string | null }>();
  const failed: { id: string; analyte: string; value: number; unit: string; low: unknown; high: unknown }[] = [];
  for (const r of results) {
    const a = analytes.get(r.analyteId);
    if (!a) throw invalid('that analyte is not part of this test’s method');
    if (seen.has(r.analyteId) || have.has(r.analyteId)) throw conflict(`${a.name} already has a result`);
    seen.add(r.analyteId);
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) throw invalid(`${a.name}: the result must be a number`);
    if (!r.instrumentId && t.required_instrument_class) throw invalid(`${a.name}: choose the ${t.required_instrument_class} used`);
    let ins: { tag: string; calDue: string | null } | null = null;
    if (r.instrumentId) {
      ins = instruments.get(r.instrumentId) ?? await checkInstrument(tx, r.instrumentId, t.facility_id, t.required_instrument_class);
      instruments.set(r.instrumentId, ins);
    }
    const outcome = evaluate(r.value, a.spec_low, a.spec_high);
    const row = await one(tx, `INSERT INTO lab_result (tenant_id, facility_id, test_id, analyte_id, analyte_name, unit, spec_low, spec_high, value, outcome, instrument_asset_id, instrument_tag, instrument_cal_due,
        note, entered_by, analyst_employee_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [actor.tenantId, t.facility_id, testId, a.id, a.name, a.unit, a.spec_low, a.spec_high, r.value, outcome, r.instrumentId ?? null, ins?.tag ?? null, ins?.calDue ?? null, r.note?.trim() || null, actor.userId, actor.employeeId]);
    if (outcome === 'fail') failed.push({ id: row.id, analyte: a.name, value: r.value, unit: a.unit, low: a.spec_low, high: a.spec_high });
  }
  const complete = [...analytes.keys()].every((id) => have.has(id) || seen.has(id));
  await tx.query(`UPDATE lab_test SET entered_by = $2, entered_at = CASE WHEN $3 THEN now() ELSE entered_at END, status = CASE WHEN $3 THEN 'entered' ELSE status END WHERE id = $1`, [testId, actor.userId, complete]);
  for (const f of failed) {
    const number = `OOS-${String(await nextSequence(tx, actor.tenantId, 'lab_oos')).padStart(6, '0')}`;
    const inv = await one(tx, `INSERT INTO lab_investigation (tenant_id, facility_id, number, sample_id, test_id, result_id, opened_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [actor.tenantId, t.facility_id, number, t.sample_id, testId, f.id, actor.userId]);
    await audit(tx, actor, { action: 'lab.oos_opened', entityType: 'lab_investigation', entityId: inv.id, facilityId: t.facility_id,
      data: { number, sample: t.sample_number, method: t.method_code, analyte: f.analyte, value: f.value, limits: limitText(f.low as any, f.high as any) } });
    await notify(tx, actor.tenantId, await usersWithPermission(tx, 'lab.review', t.facility_id), { kind: 'lab.oos_opened',
      title: `${number}: ${f.analyte} ${f.value} ${f.unit} is outside ${limitText(f.low as any, f.high as any)} in ${t.sample_number}`, body: 'Investigate and close it before the sample can be released.',
      link: `/lab/samples/${t.sample_id}`, subjectType: 'lab_investigation', subjectId: inv.id, dedupeKey: `lab-oos:${inv.id}` }, actor.userId);
  }
  await refreshStatus(tx, t.sample_id);
  await audit(tx, actor, { action: 'lab.results_entered', entityType: 'lab_test', entityId: testId, facilityId: t.facility_id,
    data: { sample: t.sample_number, method: t.method_code, count: results.length, outOfSpecification: failed.length, complete } });
  return { complete, outOfSpecification: failed.length };
}

// ---------------------------------------------------------------------------
// Review: a different person
// ---------------------------------------------------------------------------

/**
 * The reviewer needs lab.review and must not be a person who entered any of the test's results. The platform's
 * single-person approval setting is a Lite-edition rule inside the approval engine; this feature is Standard only and
 * has no such exception (D-184D).
 */
export async function reviewTest(tx: Tx, actor: Actor, testId: string, note?: string | null) {
  const t = await lockTest(tx, testId);
  requirePermission(actor, 'lab.review', t.facility_id);
  if (t.status !== 'entered') throw conflict(t.status === 'reviewed' ? 'the test has already been reviewed' : `the test is ${t.status.replace('_', ' ')}; it can be reviewed once every analyte has a result`);
  if (await one(tx, 'SELECT 1 FROM lab_result WHERE test_id = $1 AND superseded_at IS NULL AND entered_by = $2 LIMIT 1', [testId, actor.userId])) {
    throw invalid('you entered these results; a different person reviews them');
  }
  const open = await one(tx, `SELECT number FROM lab_investigation WHERE test_id = $1 AND status = 'open' LIMIT 1`, [testId]);
  if (open) throw conflict(`${open.number} is open on this test; close the investigation before reviewing`);
  await tx.query(`UPDATE lab_test SET status = 'reviewed', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [testId, actor.userId, note?.trim() || null]);
  await refreshStatus(tx, t.sample_id);
  await audit(tx, actor, { action: 'lab.test_reviewed', entityType: 'lab_test', entityId: testId, facilityId: t.facility_id, data: { sample: t.sample_number, method: t.method_code, note: note ?? null } });
}

/** The reviewer sends a test back: its results are superseded (kept, with the reason) and the analyst enters them again. */
export async function returnTest(tx: Tx, actor: Actor, testId: string, reason: string) {
  const t = await lockTest(tx, testId);
  requirePermission(actor, 'lab.review', t.facility_id);
  if (t.status !== 'entered') throw conflict('only a test waiting for review can be returned');
  if (!reason?.trim() || reason.trim().length < 3) throw invalid('say what needs correcting');
  if (await one(tx, `SELECT 1 FROM lab_investigation WHERE test_id = $1 AND status = 'open'`, [testId])) throw conflict('close the open investigation on this test first');
  await tx.query(`UPDATE lab_result SET superseded_at = now(), superseded_reason = $2 WHERE test_id = $1 AND superseded_at IS NULL`, [testId, `Returned by ${actor.displayName}: ${reason.trim()}`]);
  await tx.query(`UPDATE lab_test SET status = 'assigned', entered_at = NULL WHERE id = $1`, [testId]);
  await refreshStatus(tx, t.sample_id);
  await audit(tx, actor, { action: 'lab.test_returned', entityType: 'lab_test', entityId: testId, facilityId: t.facility_id, data: { sample: t.sample_number, reason } });
}

// ---------------------------------------------------------------------------
// Out-of-specification investigations
// ---------------------------------------------------------------------------

const INV_SQL = `SELECT i.*, s.number AS sample_number, s.description AS sample_description, s.customer_id, m.code AS method_code, m.version AS method_version, r.analyte_name, r.unit, r.value::float AS value,
    r.spec_low::float AS spec_low, r.spec_high::float AS spec_high, r.entered_by AS result_entered_by, ou.display_name AS opened_by_name, cu.display_name AS closed_by_name,
    n.number AS ncr_number, ca.number AS capa_number, f.code AS facility_code
  FROM lab_investigation i JOIN lab_sample s ON s.id = i.sample_id JOIN lab_test t ON t.id = i.test_id JOIN lab_method m ON m.id = t.method_id JOIN lab_result r ON r.id = i.result_id
  JOIN facility f ON f.id = i.facility_id JOIN app_user ou ON ou.id = i.opened_by LEFT JOIN app_user cu ON cu.id = i.closed_by
  LEFT JOIN nonconformance n ON n.id = i.ncr_id LEFT JOIN corrective_action ca ON ca.id = i.capa_id`;

export async function listInvestigations(tx: Tx, actor: Actor, q: { status?: string; facilityId?: string } = {}) {
  requirePermission(actor, 'lab.view');
  const rows = await many(tx, `${INV_SQL} WHERE ($1::text IS NULL OR i.status = $1) AND ($2::uuid IS NULL OR i.facility_id = $2) ORDER BY (i.status = 'closed'), i.opened_at DESC`, [q.status ?? null, q.facilityId ?? null]);
  return rows.filter((i) => can(actor, 'lab.view', i.facility_id));
}

export async function getInvestigation(tx: Tx, actor: Actor, id: string) {
  const i = await one(tx, `${INV_SQL} WHERE i.id = $1`, [id]);
  if (!i) throw notFound('investigation');
  requirePermission(actor, 'lab.view', i.facility_id);
  return { ...i, canWork: can(actor, 'lab.analyze', i.facility_id), canClose: can(actor, 'lab.review', i.facility_id) && i.result_entered_by !== actor.userId };
}

export async function updateInvestigation(tx: Tx, actor: Actor, id: string, input: { cause?: string | null; retestResult?: string | null }) {
  const i = await one(tx, 'SELECT * FROM lab_investigation WHERE id = $1 FOR UPDATE', [id]);
  if (!i) throw notFound('investigation');
  requirePermission(actor, 'lab.analyze', i.facility_id);
  if (i.status !== 'open') throw conflict(`${i.number} is closed`);
  await tx.query('UPDATE lab_investigation SET cause = coalesce($2, cause), retest_result = coalesce($3, retest_result) WHERE id = $1',
    [id, input.cause !== undefined ? input.cause?.trim() || null : null, input.retestResult !== undefined ? input.retestResult?.trim() || null : null]);
  await audit(tx, actor, { action: 'lab.oos_updated', entityType: 'lab_investigation', entityId: id, facilityId: i.facility_id, data: { number: i.number, cause: input.cause ?? undefined, retestResult: input.retestResult ?? undefined } });
}

/**
 * Closing needs the cause and a conclusion, and a decision: confirmed out of specification, or invalidated with the reason
 * (for example a documented laboratory error). The person closing is a reviewer other than the one who entered the result.
 * An invalidated result is superseded and the analyst enters the replacement; a confirmed one stays and is reported as it is.
 */
export async function closeInvestigation(tx: Tx, actor: Actor, id: string, input: { decision: 'confirmed_oos' | 'invalidated'; conclusion: string; invalidReason?: string | null }) {
  const i = await one(tx, `SELECT i.*, r.entered_by AS result_entered_by, s.number AS sample_number FROM lab_investigation i JOIN lab_result r ON r.id = i.result_id JOIN lab_sample s ON s.id = i.sample_id WHERE i.id = $1 FOR UPDATE OF i`, [id]);
  if (!i) throw notFound('investigation');
  requirePermission(actor, 'lab.review', i.facility_id);
  if (i.status !== 'open') throw conflict(`${i.number} is already closed`);
  if (i.result_entered_by === actor.userId) throw invalid('you entered the result under investigation; a different reviewer closes it');
  if (!i.cause?.trim()) throw invalid('record the cause (or that none was found) before closing');
  if (!input.conclusion?.trim() || input.conclusion.trim().length < 3) throw invalid('write the conclusion');
  if (input.decision === 'invalidated' && (!input.invalidReason?.trim() || input.invalidReason.trim().length < 3)) throw invalid('an invalidated result needs the reason it is invalid');
  await tx.query(`UPDATE lab_investigation SET status = 'closed', decision = $2, conclusion = $3, invalid_reason = $4, closed_by = $5, closed_at = now() WHERE id = $1`,
    [id, input.decision, input.conclusion.trim(), input.decision === 'invalidated' ? input.invalidReason!.trim() : null, actor.userId]);
  if (input.decision === 'invalidated') {
    await tx.query(`UPDATE lab_result SET superseded_at = now(), superseded_reason = $2 WHERE id = $1`, [i.result_id, `Invalidated by ${i.number}: ${input.invalidReason!.trim()}`]);
    await tx.query(`UPDATE lab_test SET status = 'assigned', entered_at = NULL WHERE id = $1 AND status = 'entered'`, [i.test_id]);
  }
  await refreshStatus(tx, i.sample_id);
  await audit(tx, actor, { action: 'lab.oos_closed', entityType: 'lab_investigation', entityId: id, facilityId: i.facility_id, data: { number: i.number, sample: i.sample_number, decision: input.decision, reason: input.invalidReason ?? null } });
}

/** A confirmed out-of-specification result may open one nonconformance or one corrective action in Quality, linked to the investigation. */
export async function raiseQuality(tx: Tx, actor: Actor, id: string, input: { kind: 'ncr' | 'capa'; severity?: 'minor' | 'major' | 'critical'; ownerUserId?: string | null; priority?: 'low' | 'medium' | 'high' }) {
  const i = await one(tx, `${INV_SQL} WHERE i.id = $1 FOR UPDATE OF i`, [id]);
  if (!i) throw notFound('investigation');
  requirePermission(actor, 'lab.review', i.facility_id);
  if (i.status !== 'closed' || i.decision !== 'confirmed_oos') throw conflict('only a closed investigation that confirmed the result out of specification can raise a nonconformance or corrective action');
  if (i.ncr_number || i.capa_number) throw conflict(`${i.number} already raised ${i.ncr_number ?? i.capa_number}`);
  const limits = limitText(i.spec_low, i.spec_high);
  const text = `Out-of-specification result confirmed by ${i.number} on sample ${i.sample_number} (${i.sample_description}): ${i.analyte_name} ${i.value} ${i.unit} against ${limits} ${i.unit}, method ${i.method_code} version ${i.method_version}.\n`
    + `Cause: ${i.cause}\nConclusion: ${i.conclusion}${i.retest_result ? `\nRetest: ${i.retest_result}` : ''}`;
  const title = `${i.number}: ${i.analyte_name} out of specification in ${i.sample_number}`;
  if (input.kind === 'ncr') {
    const n = await createNcr(tx, actor, { facilityId: i.facility_id, source: 'internal', severity: input.severity ?? 'major', title, description: text, customerId: i.customer_id ?? null });
    await tx.query('UPDATE lab_investigation SET ncr_id = $2 WHERE id = $1', [id, n.id]);
    await audit(tx, actor, { action: 'lab.oos_raised_ncr', entityType: 'lab_investigation', entityId: id, facilityId: i.facility_id, data: { number: i.number, ncr: n.number } });
    return { kind: 'ncr' as const, id: n.id as string, number: n.number as string };
  }
  const c = await createCapa(tx, actor, { facilityId: i.facility_id, title, problem: text, source: 'internal', priority: input.priority ?? 'medium', ownerUserId: input.ownerUserId ?? actor.userId });
  await tx.query('UPDATE lab_investigation SET capa_id = $2 WHERE id = $1', [id, c.id]);
  await audit(tx, actor, { action: 'lab.oos_raised_capa', entityType: 'lab_investigation', entityId: id, facilityId: i.facility_id, data: { number: i.number, capa: c.number } });
  return { kind: 'capa' as const, id: c.id as string, number: c.number as string };
}
