import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, hashToken, loadActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool, getPool } from '../src/platform/db/pool.js';
import { createApprovalRequest, decideStep, myApprovalQueue } from '../src/platform/approvals/engine.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { addAction as addCapaAction, advanceCapa, cancelCapa, closeNcr, createCapa, createNcr, dispositionNcr, linkNcrToCapa, updateCapa, verifyCapa } from '../src/modules/quality/service.js';
import { addTeamMember } from '../src/modules/quality/eight-d.js';
import { createAudit, recordItem, startAudit } from '../src/modules/quality/audits.js';
import { createFmea, getFmea, saveRows } from '../src/modules/quality/fmea.js';
import { saveCharacteristic } from '../src/modules/spc/service.js';
import { addAction as addMocAction, answerPssr, completeAction as completeMocAction, createChange, requestStartup, reviseChange } from '../src/modules/moc/service.js';
import { addMonths } from '../src/modules/continuity/service.js';
import { classifyIncident, reportIncident } from '../src/modules/safety/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Quality and platform findings from the verification pass (D-161), each pinned by the case that showed it. */
let app: FastifyInstance; let w: World;
const db = () => getAdminPool();
const A = () => w.facilities.A!;
const PLAN = { consequences: 'x x x', qmsImpact: 'x x x', resources: 'x x x', responsibilities: 'x x x' };
const capa = (input: Record<string, unknown> = {}) => asActor(w.qualityA, (tx) => createCapa(tx, w.qualityA, {
  facilityId: A(), title: 'Coolant drift', problem: 'Concentration drops between top-ups.', source: 'internal', ownerUserId: w.qualityA.userId, ...input } as any));
const toVerification = (id: string) => db().query(`UPDATE corrective_action SET status = 'verification', verify_after = current_date - 1 WHERE id = $1`, [id]);

beforeAll(async () => { app = buildApp(); w = await makeWorld('vfyqual'); });
afterAll(async () => { await app.close(); await closePools(); });

describe('corrective actions keep the effectiveness check independent', () => {
  it('the owner cannot be changed during the check, nor be the champion', async () => {
    const c = await capa({ ownerUserId: w.managerA.userId });
    await toVerification(c.id);
    await expect(asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, c.id, { ownerUserId: w.qualityA.userId }))).rejects.toThrow(/cannot change during the effectiveness check/);
    const d = await capa({ format: 'eight_d', ownerUserId: w.managerA.userId });
    await asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, d.id, { championUserId: w.opsA.userId }));
    await expect(asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, d.id, { ownerUserId: w.opsA.userId }))).rejects.toThrow(/other than the champion/);
  });

  it('the owner can lengthen the wait before the check but not shorten or clear it', async () => {
    const c = await capa({ ownerUserId: w.managerA.userId });
    await db().query(`UPDATE corrective_action SET verify_after = current_date + 30 WHERE id = $1`, [c.id]);
    const owner = w.managerA;
    await expect(asActor(owner, (tx) => updateCapa(tx, owner, c.id, { verifyAfter: null }))).rejects.toThrow(/cannot shorten/);
    await expect(asActor(owner, (tx) => updateCapa(tx, owner, c.id, { verifyAfter: '2020-01-01' }))).rejects.toThrow(/cannot shorten/);
    await asActor(owner, (tx) => updateCapa(tx, owner, c.id, { verifyAfter: '2099-01-01' }));
    await asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, c.id, { verifyAfter: '2030-01-01' })); // quality may shorten it
    await toVerification(c.id);
    await expect(asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, c.id, { verifyAfter: null }))).rejects.toThrow(/needs a date/);
  });

  it('cannot close as effective with actions added after the step moved on; a failed check is kept', async () => {
    const c = await capa({ ownerUserId: w.managerA.userId });
    await toVerification(c.id);
    const a = await asActor(w.qualityA, (tx) => addCapaAction(tx, w.qualityA, { subjectType: 'corrective_action', subjectId: c.id, title: 'Late extra check', ownerUserId: w.managerA.userId, dueDate: '2030-01-01' }));
    await expect(asActor(w.qualityA, (tx) => verifyCapa(tx, w.qualityA, c.id, { effective: true, note: 'Readings stable for a month.' }))).rejects.toThrow(/open actions/);
    await db().query(`UPDATE action_item SET status = 'done', completion_note = 'done' WHERE id = $1`, [a.id]);
    await asActor(w.qualityA, (tx) => verifyCapa(tx, w.qualityA, c.id, { effective: false, note: 'Still dropping on nights.' }));
    const checks = (await db().query('SELECT effective FROM capa_effectiveness_check WHERE capa_id = $1', [c.id])).rows;
    expect(checks).toEqual([{ effective: false }]);
  });

  it('an 8D cannot close with a read-across still undecided', async () => {
    const c = await capa({ format: 'eight_d', ownerUserId: w.managerA.userId });
    await asActor(w.qualityA, (tx) => addTeamMember(tx, w.qualityA, c.id, { userId: w.techA.userId }));
    await db().query(`INSERT INTO capa_read_across (tenant_id, facility_id, capa_id, scope, created_by) VALUES ($1, $2, $3, 'Line 2', $4)`, [w.tenantId, A(), c.id, w.qualityA.userId]);
    await db().query(`UPDATE corrective_action SET prevention_note = 'Control plan updated.' WHERE id = $1`, [c.id]);
    await toVerification(c.id);
    await expect(asActor(w.qualityA, (tx) => verifyCapa(tx, w.qualityA, c.id, { effective: true, note: 'Readings stable for a month.' }))).rejects.toThrow(/decide every read-across/);
  });
});

describe('nonconformances and their corrective actions', () => {
  it('link only to a live corrective action at the same site; a major one does not close against a cancelled CAPA', async () => {
    const n = await asActor(w.qualityA, (tx) => createNcr(tx, w.qualityA, { facilityId: A(), title: 'Oversize bore', description: 'Bore 0.05 over on 4 parts.', severity: 'major', source: 'production' }));
    const other = await asActor(w.admin, (tx) => createCapa(tx, w.admin, { facilityId: w.facilities.B!, title: 'Other site', problem: 'Plant B only.', source: 'internal', ownerUserId: w.admin.userId }));
    await expect(asActor(w.admin, (tx) => linkNcrToCapa(tx, w.admin, n.id, other.id))).rejects.toThrow(/another site/);
    const prev = await capa({ actionType: 'preventive', source: 'risk' });
    await expect(asActor(w.qualityA, (tx) => linkNcrToCapa(tx, w.qualityA, n.id, prev.id))).rejects.toThrow(/preventive action/);
    const c = await capa();
    await asActor(w.qualityA, (tx) => linkNcrToCapa(tx, w.qualityA, n.id, c.id));
    await asActor(w.qualityA, (tx) => cancelCapa(tx, w.qualityA, c.id, 'Opened by mistake'));
    await asActor(w.admin, (tx) => dispositionNcr(tx, w.admin, n.id, { disposition: 'scrap' }));
    await expect(asActor(w.qualityA, (tx) => closeNcr(tx, w.qualityA, n.id))).rejects.toThrow(/was cancelled/);
  });
});

describe('FMEA rows', () => {
  it('keep their ids (and actions) when a row above them is removed', async () => {
    const f = await asActor(w.qualityA, (tx) => createFmea(tx, w.qualityA, { facilityId: A(), kind: 'process', title: 'Bending', scope: 'Op 30 press brake' }));
    const row = (item: string) => ({ item, failureMode: `${item} fails`, effect: 'Scrap', severity: 5, cause: 'Wear', occurrence: 4, detection: 3 });
    const v1 = await asActor(w.qualityA, (tx) => saveRows(tx, w.qualityA, f.id, [row('Bend'), row('Trim')]));
    const trim = v1.rows.find((r: any) => r.item === 'Trim');
    await asActor(w.qualityA, (tx) => addCapaAction(tx, w.qualityA, { subjectType: 'fmea', subjectId: f.id, fmeaRowId: trim.id, title: 'Sharpen trim die', ownerUserId: w.qualityA.userId, dueDate: '2030-01-01' }));
    // The editor removes "Bend" and sends "Trim" with its id: Trim keeps its id and its action.
    const v2 = await asActor(w.qualityA, (tx) => saveRows(tx, w.qualityA, f.id, [{ ...row('Trim'), id: trim.id }]));
    expect(v2.rows).toEqual([expect.objectContaining({ id: trim.id, item: 'Trim', seq: 1 })]);
    await expect(asActor(w.qualityA, (tx) => saveRows(tx, w.qualityA, f.id, [{ ...row('Trim'), id: '00000000-0000-4000-8000-000000000000' }]))).rejects.toThrow(/another FMEA/);
    expect((await asActor(w.qualityA, (tx) => getFmea(tx, w.qualityA, f.id))).rows).toHaveLength(1);
  });
});

describe('SPC alarm summary', () => {
  it('shows only sites where the user may see quality data', async () => {
    const both = await createUserWithToken(db(), w.tenantId, { email: `qa-opB-${Date.now()}@x.example`, displayName: 'QA at A, operator at B',
      roles: [{ role: 'quality_reviewer', facility: A() }, { role: 'operator', facility: w.facilities.B! }] });
    for (const f of [A(), w.facilities.B!]) await asActor(w.admin, (tx) => saveCharacteristic(tx, w.admin, { facilityId: f, code: `OD-${f.slice(0, 4)}`, name: 'Outer diameter', unit: 'mm', lsl: 9.9, usl: 10.1, subgroupSize: 1 }));
    const r = await app.inject({ url: '/api/spc/summary', headers: { authorization: `Bearer ${both.token}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((s: any) => s.facilityCode)).toEqual(['A']);
  });
});

describe('changes (MOC)', () => {
  const change = (extra: Record<string, unknown> = {}) => asActor(w.admin, (tx) => createChange(tx, w.admin, { ...PLAN, facilityId: A(), title: 'New fixture', changeType: 'equipment',
    description: 'Replace the op 20 fixture.', justification: 'Worn locators cause scrap.', ...extra } as any));
  const approve = (id: string, extra = '') => db().query(`UPDATE moc_change SET status = 'approved', approved_at = now(), pssr_required = true ${extra} WHERE id = $1`, [id]);

  it('a "no" on the pre-startup review withdraws the startup sign-off already requested', async () => {
    const c = await change();
    await approve(c.id);
    await asActor(w.admin, (tx) => requestStartup(tx, w.admin, c.id));
    const yes = [1, 2, 3, 4, 5, 6].map((seq) => ({ seq, response: 'yes' as const }));
    expect((await asActor(w.admin, (tx) => answerPssr(tx, w.admin, c.id, yes))).startupApprovalRequested).toBe(true);
    await asActor(w.admin, (tx) => answerPssr(tx, w.admin, c.id, [{ seq: 5, response: 'no', note: 'Interlock on the guard does not trip.' }]));
    const reqs = (await db().query(`SELECT status FROM approval_request WHERE subject_id = $1 AND purpose = 'moc.startup'`, [c.id])).rows;
    expect(reqs).toEqual([{ status: 'cancelled' }]);
  });

  it('a revised change rebuilds its checklist (made temporary: the restore question appears)', async () => {
    const c = await change();
    await approve(c.id);
    await asActor(w.admin, (tx) => requestStartup(tx, w.admin, c.id));
    const seqs = async () => (await db().query('SELECT seq FROM moc_pssr_item WHERE change_id = $1 ORDER BY seq', [c.id])).rows.map((r) => r.seq);
    expect(await seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    await asActor(w.admin, (tx) => reviseChange(tx, w.admin, c.id, { isTemporary: true, temporaryUntil: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10) }, 'Trial the fixture for a quarter first'));
    await approve(c.id);
    await asActor(w.admin, (tx) => requestStartup(tx, w.admin, c.id));
    expect(await seqs()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('a work order action needs its work order; a revised owner must work at the site', async () => {
    const c = await change();
    await approve(c.id);
    const a = await asActor(w.admin, (tx) => addMocAction(tx, w.admin, c.id, { kind: 'work_order', title: 'Install the fixture', requiredBefore: 'startup' }));
    await expect(asActor(w.admin, (tx) => completeMocAction(tx, w.admin, a.id, { note: 'Installed by the night shift.' }))).rejects.toThrow(/link the work order/);
    const d = await change();
    await expect(asActor(w.admin, (tx) => reviseChange(tx, w.admin, d.id, { ownerUserId: w.operatorB.userId }))).rejects.toThrow(/access to this facility/);
  });
});

describe('audits, incidents and dates', () => {
  it('the auditee cannot record results, even as a quality manager', async () => {
    const a = await asActor(w.admin, (tx) => createAudit(tx, w.admin, { facilityId: A(), title: 'Quality office', scope: 'Document control', plannedOn: '2030-01-01',
      leadAuditorId: w.admin.userId, auditeeUserId: w.qualityA.userId, items: ['Procedures are current'] }));
    await asActor(w.admin, (tx) => startAudit(tx, w.admin, a.id));
    const item = (await db().query('SELECT id FROM audit_item WHERE audit_id = $1', [a.id])).rows[0].id;
    await expect(asActor(w.qualityA, (tx) => recordItem(tx, w.qualityA, item, { result: 'conforming', evidence: 'Looked fine to me.' }))).rejects.toThrow(/lead auditor/);
  });

  it('classifying an incident with an unknown employee is refused, not a server error', async () => {
    const i = await asActor(w.admin, (tx) => reportIncident(tx, w.admin, { facilityId: A(), kind: 'near_miss', occurredAt: new Date(), description: 'Pallet slipped off the forks.' }));
    await expect(asActor(w.admin, (tx) => classifyIncident(tx, w.admin, i.id, { severity: 'low', involvedEmployeeId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(/employee was not found/);
  });

  it('a month later is the month end when the month is shorter', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-08-31', 6)).toBe('2026-02-28');
    expect(addMonths('2025-03-15', 12)).toBe('2026-03-15');
  });
});

describe('platform', () => {
  it('a feature turned off for a user hides its approvals and refuses their decision', async () => {
    const c = await asActor(w.admin, (tx) => createChange(tx, w.admin, { ...PLAN, facilityId: A(), title: 'Hidden approvals', changeType: 'process', description: 'For the hidden feature check.', justification: 'Test.' } as any));
    await asActor(w.admin, (tx) => createApprovalRequest(tx, w.admin, { facilityId: A(), subjectType: 'moc_change', subjectId: c.id, subjectRevision: c.revision, purpose: 'moc.authorize',
      stages: [{ steps: [{ roleKey: 'operations_manager', label: 'Authorize' }] }] }));
    const step = (await asActor(w.opsA, (tx) => myApprovalQueue(tx, w.opsA))).find((r: any) => r.subject_id === c.id);
    expect(step).toBeTruthy();
    const hidden = { ...w.opsA, hiddenFeatures: ['changes'] };
    expect((await asActor(hidden, (tx) => myApprovalQueue(tx, hidden))).some((r: any) => r.subject_id === c.id)).toBe(false);
    await expect(asActor(hidden, (tx) => decideStep(tx, hidden, step.step_id, { decision: 'approve', comment: 'ok' }))).rejects.toThrow(/turned off/);
  });

  it('a repeat sent while the first request with the same Idempotency-Key is still running is refused', async () => {
    const key = `inflight-${Date.now()}`;
    await db().query(`INSERT INTO idempotency_record (tenant_id, user_id, key, method, path, status, body) VALUES ($1, $2, $3, 'POST', '/api/corrective-actions', 0, '')`, [w.tenantId, w.qualityA.userId, key]);
    const r = await app.inject({ method: 'POST', url: '/api/corrective-actions', headers: { authorization: `Bearer ${w.tokens.qualityA}`, 'idempotency-key': key },
      payload: { facilityId: A(), title: 'Twice', problem: 'Sent twice.', source: 'internal', ownerUserId: w.qualityA.userId } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('idempotency_in_progress');
    // A request that fails releases its key, so a corrected retry runs.
    const k2 = `fails-${Date.now()}`;
    const bad = await app.inject({ method: 'POST', url: '/api/corrective-actions', headers: { authorization: `Bearer ${w.tokens.qualityA}`, 'idempotency-key': k2 }, payload: { facilityId: A() } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect((await db().query('SELECT 1 FROM idempotency_record WHERE key = $1', [k2])).rowCount).toBe(0);
  });

  it('a single sign-on session is issued only for an active user of that company', async () => {
    const other = await makeWorld('vfyqual2');
    await expect(getPool().query('SELECT sso_issue_session($1, $2, $3, 12)', [other.tenantId, w.admin.userId, hashToken(`x-${Date.now()}`)])).rejects.toThrow(/not an active user/);
    await getPool().query('SELECT sso_issue_session($1, $2, $3, 12)', [w.tenantId, w.admin.userId, hashToken(`y-${Date.now()}`)]);
    expect(await loadActor(w.tenantId, w.admin.userId)).toBeTruthy();
  });
});
