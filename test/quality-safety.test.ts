import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { createPart } from '../src/modules/parts/service.js';
import { runReminders } from '../src/modules/notifications/reminders.js';
import { createOrder, createRevision, getOrder, releaseOrder, releaseRevision, saveRevision, saveWorkCenter, startOperation, stopOperation } from '../src/modules/production/service.js';
import {
  addAction, advanceCapa, closeNcr, completeAction, containNcr, createCapa, createNcr, dispositionNcr, getCapa, getNcr, listNcrs, myActions, updateCapa, verifyCapa,
} from '../src/modules/quality/service.js';
import { getReport } from '../src/modules/reporting/registry.js';
import { classifyIncident, closeIncident, getIncident, investigateIncident, listIncidents, reportIncident } from '../src/modules/safety/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let qm2: Actor; let op: Actor;
let part: string;
const notices = async (who: Actor, kind: string) => (await db().query('SELECT title, body FROM notification WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [who.userId, kind])).rows;

beforeAll(async () => {
  w = await makeWorld('qs');
  const u = await createUserWithToken(db(), w.tenantId, { email: `qm2-${Date.now()}@q.example`, displayName: 'QM Two', roles: [{ role: 'quality_manager', facility: w.facilities.A! }] });
  qm2 = (await loadActor(w.tenantId, u.userId))!;
  const e = (await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title) VALUES ($1, $2, 'E400', 'Omar', 'Ruiz', 'Operator') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
  const uo = await createUserWithToken(db(), w.tenantId, { email: `op-${Date.now()}@q.example`, displayName: 'Omar', employeeId: e, roles: [{ role: 'operator', facility: w.facilities.A! }] });
  op = (await loadActor(w.tenantId, uo.userId))!;
  part = (await asActor(w.admin, (tx) => createPart(tx, w.admin, { partNumber: 'BRK-10', description: 'Bracket', unitCost: 12.5 }))).id;
});
afterAll(closePools);

describe('nonconformances', () => {
  let major1: any; let major2: any;

  it('a nonconformance raised from a production run carries the order, part, scrap quantity and reason', async () => {
    const wc = await asActor(w.admin, (tx) => saveWorkCenter(tx, w.admin, { facilityId: w.facilities.A!, code: 'BENCH', name: 'Bench' }));
    const rev = await asActor(w.admin, (tx) => createRevision(tx, w.admin, { partId: part }));
    await asActor(w.admin, async (tx) => { await saveRevision(tx, w.admin, rev.id, { materials: [], operations: [{ opNo: 10, workCenterId: wc.id, description: 'Bend' }] }); await releaseRevision(tx, w.admin, rev.id); });
    const mo = await asActor(w.admin, (tx) => createOrder(tx, w.admin, { facilityId: w.facilities.A!, partId: part, qty: 10 }));
    await asActor(w.admin, (tx) => releaseOrder(tx, w.admin, mo.id));
    const opId = (await asActor(w.admin, (tx) => getOrder(tx, w.admin, mo.id))).operations[0].id;
    const run = await asActor(op, (tx) => startOperation(tx, op, opId, {}));
    await asActor(op, (tx) => stopOperation(tx, op, run.id, { qtyGood: 8, qtyScrap: 2, scrapReason: 'DIM' }));
    const n = await asActor(op, (tx) => createNcr(tx, op, { productionEntryId: run.id, description: 'Bend angle 2° over on two brackets' }));
    expect(n).toMatchObject({ source: 'production', production_order_id: mo.id, part_id: part, number: expect.stringMatching(/^NCR-\d{6}$/) });
    expect(Number(n.qty)).toBe(2);
    expect(n.title).toMatch(/^BRK-10 · MO-\d+ op 10: Out of tolerance$/);
    await expect(asActor(op, (tx) => createNcr(tx, op, { productionEntryId: run.id, description: 'again' }))).rejects.toThrow(/already covers this run/);
    expect((await notices(w.qualityA, 'quality.ncr_raised'))[0].title).toBe(`${n.number} (minor): ${n.title}`);
    // The reporter can follow their own report without quality.view.
    expect((await asActor(op, (tx) => getNcr(tx, op, n.id))).number).toBe(n.number);
    expect((await asActor(op, (tx) => listNcrs(tx, op))).map((x) => x.number)).toEqual([n.number]);
  });

  it('accepting a major nonconformance as is needs a justification and someone other than the reporter', async () => {
    major1 = await asActor(w.techA, (tx) => createNcr(tx, w.techA, { facilityId: w.facilities.A!, source: 'internal', severity: 'major', partId: part, qty: 3, description: 'Hole position off by 0.4 mm' }));
    await expect(asActor(w.techA, (tx) => dispositionNcr(tx, w.techA, major1.id, { disposition: 'scrap' }))).rejects.toThrow(/quality.manage/);
    await asActor(w.qualityA, (tx) => containNcr(tx, w.qualityA, major1.id, 'Tagged and moved to the MRB cage; WIP sorted, none found'));
    await expect(asActor(w.qualityA, (tx) => dispositionNcr(tx, w.qualityA, major1.id, { disposition: 'use_as_is', reason: 'ok' }))).rejects.toThrow(/written justification/);
    await asActor(w.qualityA, (tx) => dispositionNcr(tx, w.qualityA, major1.id, { disposition: 'use_as_is', reason: 'Customer engineer (J. Park) accepted by email 10/21; fit unaffected' }));
    major2 = await asActor(w.qualityA, (tx) => createNcr(tx, w.qualityA, { facilityId: w.facilities.A!, severity: 'major', partId: part, qty: 4, description: 'Cracked at bend radius' }));
    await expect(asActor(w.qualityA, (tx) => dispositionNcr(tx, w.qualityA, major2.id, { disposition: 'use_as_is', reason: 'Looks fine to me after review' }))).rejects.toThrow(/other than the reporter/);
    await expect(asActor(w.qualityA, (tx) => dispositionNcr(tx, w.qualityA, major2.id, { disposition: 'return_to_supplier' }))).rejects.toThrow(/no supplier/);
    await asActor(w.qualityA, (tx) => dispositionNcr(tx, w.qualityA, major2.id, { disposition: 'scrap' }));
    expect((await asActor(w.qualityA, (tx) => getNcr(tx, w.qualityA, major2.id))).cost).toBe(50); // 4 × 12.50
    await expect(asActor(w.qualityA, (tx) => closeNcr(tx, w.qualityA, major2.id))).rejects.toThrow(/needs a corrective action before it closes/);
  });

  describe('corrective actions', () => {
    let capa: any;
    it('steps need their evidence: containment, root cause, finished actions', async () => {
      capa = await asActor(w.qualityA, (tx) => createCapa(tx, w.qualityA, { facilityId: w.facilities.A!, title: 'Bracket bend defects', problem: 'Two major NCRs on BRK-10 in a week',
        source: 'nonconformance', priority: 'high', ownerUserId: qm2.userId, ncrIds: [major1.id, major2.id] }));
      expect((await notices(qm2, 'quality.capa_assigned'))[0].title).toBe(`You own ${capa.number}: Bracket bend defects`);
      await expect(asActor(qm2, (tx) => advanceCapa(tx, qm2, capa.id))).rejects.toThrow(/containment/);
      await asActor(qm2, (tx) => updateCapa(tx, qm2, capa.id, { containment: 'All BRK-10 WIP held for 100% inspection' }));
      expect(await asActor(qm2, (tx) => advanceCapa(tx, qm2, capa.id))).toBe('root_cause');
      await expect(asActor(qm2, (tx) => advanceCapa(tx, qm2, capa.id))).rejects.toThrow(/root cause/);
      await asActor(qm2, (tx) => updateCapa(tx, qm2, capa.id, { rootCauseMethod: 'five_whys', rootCause: 'Worn bend die; die life not tracked' }));
      expect(await asActor(qm2, (tx) => advanceCapa(tx, qm2, capa.id))).toBe('actions');
      await expect(asActor(qm2, (tx) => advanceCapa(tx, qm2, capa.id))).rejects.toThrow(/at least one action/);
      const a = await asActor(qm2, (tx) => addAction(tx, qm2, { subjectType: 'corrective_action', subjectId: capa.id, title: 'Replace die and add die-hit counter to PM', ownerUserId: w.techA.userId, dueDate: '2026-11-15' }));
      expect((await notices(w.techA, 'action.assigned'))[0].title).toBe(`Action for ${capa.number}: Replace die and add die-hit counter to PM`);
      expect((await asActor(w.techA, (tx) => myActions(tx, w.techA))).map((x) => x.subject_number)).toEqual([capa.number]);
      await expect(asActor(qm2, (tx) => advanceCapa(tx, qm2, capa.id))).rejects.toThrow(/open actions/);
      await expect(asActor(w.tech2A, (tx) => completeAction(tx, w.tech2A, a.id, 'done'))).rejects.toThrow(/action owner/);
      await asActor(w.techA, (tx) => completeAction(tx, w.techA, a.id, 'Die replaced 10/24; counter added to PM-114'));
      expect(await asActor(qm2, (tx) => advanceCapa(tx, qm2, capa.id))).toBe('verification');
    });

    it('the effectiveness check waits for its date, is never done by the owner, and a failed check reopens actions', async () => {
      await expect(asActor(w.qualityA, (tx) => verifyCapa(tx, w.qualityA, capa.id, { effective: true, note: 'No defects in 300 parts' }))).rejects.toThrow(/effectiveness check is due on/);
      await asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, capa.id, { verifyAfter: new Date().toISOString().slice(0, 10) }));
      await expect(asActor(qm2, (tx) => verifyCapa(tx, qm2, capa.id, { effective: true, note: 'No defects in 300 parts' }))).rejects.toThrow(/owner cannot verify/);
      await asActor(w.qualityA, (tx) => verifyCapa(tx, w.qualityA, capa.id, { effective: false, note: 'One more crack found in lot 2214; die is not the only cause' }));
      let c = await asActor(qm2, (tx) => getCapa(tx, qm2, capa.id));
      expect(c).toMatchObject({ status: 'actions', effective: false, verify_after: null });
      const a2 = await asActor(qm2, (tx) => addAction(tx, qm2, { subjectType: 'corrective_action', subjectId: capa.id, title: 'Add material cert check for bend-grade steel', ownerUserId: qm2.userId, dueDate: '2026-11-30' }));
      await asActor(qm2, async (tx) => { await completeAction(tx, qm2, a2.id, 'Receiving inspection plan updated'); await advanceCapa(tx, qm2, capa.id); });
      await asActor(w.qualityA, async (tx) => {
        await updateCapa(tx, w.qualityA, capa.id, { verifyAfter: new Date().toISOString().slice(0, 10) });
        await verifyCapa(tx, w.qualityA, capa.id, { effective: true, note: 'Zero bend cracks in 1,200 parts over 3 weeks' });
      });
      c = await asActor(qm2, (tx) => getCapa(tx, qm2, capa.id));
      expect(c).toMatchObject({ status: 'closed', effective: true, verified_by: w.qualityA.userId });
      expect(c.ncrs.map((n: any) => n.number)).toEqual([major1.number, major2.number]);
      await asActor(w.qualityA, (tx) => closeNcr(tx, w.qualityA, major2.id));
      await expect(db().query('UPDATE corrective_action SET verified_by = owner_user_id WHERE id = $1', [capa.id])).rejects.toThrow(/check/);
    });
  });

  it('the quality report counts open items and the cost of poor quality', async () => {
    const def = getReport('quality-status')!;
    const r = await asActor(w.qualityA, (tx) => def.run(tx, w.qualityA, def.params.parse({})));
    expect(r.headline).toMatch(/^2 open nonconformances; \$\d+ cost of poor quality in 90 days$/);
    // 50 on the scrapped NCR + 2 production scrap units already written up as an NCR without a cost (standard material cost 0 here).
    expect(r.kpis.find((k) => k.label.startsWith('Cost of poor quality'))!.value).toBe(50);
    expect(r.insights.join(' ')).toMatch(/Repeat part: BRK-10 on 3 nonconformances/);
  });
});

describe('safety incidents', () => {
  let inj: any;
  it('anyone can report; safety staff are told, and the injured person\'s details are private to them', async () => {
    inj = await asActor(w.techA, (tx) => reportIncident(tx, w.techA, { facilityId: w.facilities.A!, kind: 'injury', occurredAt: new Date(Date.now() - 3_600_000), location: 'Press bay 2',
      description: 'Hand caught between die and stripper plate during setup', immediateActions: 'First aid, press locked out', involvedEmployeeId: w.tech2AEmployeeId, injuryDescription: 'Laceration, left index finger' }));
    expect(inj.number).toMatch(/^INC-\d{6}$/);
    for (const who of [w.ehsA, w.opsA]) expect((await notices(who, 'safety.incident_reported'))[0]).toEqual({ title: `${inj.number} Injury reported at Press bay 2`, body: null });
    const asOps = await asActor(w.opsA, (tx) => getIncident(tx, w.opsA, inj.id));
    expect(asOps).toMatchObject({ restricted: true, description: expect.stringMatching(/Hand caught/) });
    expect(asOps).not.toHaveProperty('injury_description');
    expect(asOps).not.toHaveProperty('involved_name');
    const asEhs = await asActor(w.ehsA, (tx) => getIncident(tx, w.ehsA, inj.id));
    expect(asEhs).toMatchObject({ restricted: false, involved_name: 'Luis Ortega', injury_description: 'Laceration, left index finger' });
    expect((await asActor(w.techA, (tx) => getIncident(tx, w.techA, inj.id))).restricted).toBe(true);
    await expect(asActor(w.operatorB, (tx) => getIncident(tx, w.operatorB, inj.id))).rejects.toThrow();
    await expect(asActor(w.techA, (tx) => reportIncident(tx, w.techA, { facilityId: w.facilities.A!, kind: 'near_miss', occurredAt: new Date(Date.now() + 3_600_000), description: 'x' }))).rejects.toThrow(/future/);
  });

  it('classification, investigation and actions come before closing; days away make it recordable', async () => {
    await expect(asActor(w.opsA, (tx) => classifyIncident(tx, w.opsA, inj.id, { severity: 'medium' }))).rejects.toThrow(/safety.manage/);
    await expect(asActor(w.ehsA, (tx) => classifyIncident(tx, w.ehsA, inj.id, { severity: 'medium', medicalTreatment: true, daysAway: 2, recordable: false }))).rejects.toThrow(/recordable/);
    await asActor(w.ehsA, (tx) => classifyIncident(tx, w.ehsA, inj.id, { severity: 'medium', medicalTreatment: true, daysAway: 2, recordable: true }));
    await expect(asActor(w.ehsA, (tx) => closeIncident(tx, w.ehsA, inj.id))).rejects.toThrow(/root cause/);
    await asActor(w.ehsA, (tx) => investigateIncident(tx, w.ehsA, inj.id, { rootCause: 'Setup done with ram powered; setup mode bypassed the light curtain', contributingFactors: 'No setup procedure at press 2' }));
    const a = await asActor(w.ehsA, (tx) => addAction(tx, w.ehsA, { subjectType: 'safety_incident', subjectId: inj.id, title: 'Write and train press setup procedure with LOTO', ownerUserId: w.managerA.userId, dueDate: '2026-11-05' }));
    await expect(asActor(w.ehsA, (tx) => closeIncident(tx, w.ehsA, inj.id))).rejects.toThrow(/open actions/);
    await asActor(w.managerA, (tx) => completeAction(tx, w.managerA, a.id, 'SOP-PR-02 released; 6 setters trained 11/02'));
    await asActor(w.ehsA, (tx) => closeIncident(tx, w.ehsA, inj.id));
    const nm = await asActor(w.techA, (tx) => reportIncident(tx, w.techA, { facilityId: w.facilities.A!, kind: 'near_miss', occurredAt: new Date(Date.now() - 60_000), location: 'Dock 1', description: 'Forklift reversed without spotter' }));
    await expect(asActor(w.ehsA, (tx) => closeIncident(tx, w.ehsA, nm.id))).rejects.toThrow(/classify/);
    await asActor(w.ehsA, async (tx) => { await classifyIncident(tx, w.ehsA, nm.id, { severity: 'low' }); await closeIncident(tx, w.ehsA, nm.id); });
    // Reporters see their own reports; managers see the site's, without recordability.
    expect((await asActor(w.techA, (tx) => listIncidents(tx, w.techA))).length).toBe(2);
    const ops = await asActor(w.opsA, (tx) => listIncidents(tx, w.opsA));
    expect(ops.every((i) => i.recordable === undefined)).toBe(true);
  });

  it('the safety report counts recordables and near misses and says when hours are missing', async () => {
    await asActor(w.techA, (tx) => reportIncident(tx, w.techA, { facilityId: w.facilities.A!, kind: 'near_miss', occurredAt: new Date(Date.now() - 120_000), description: 'Oil on walkway by press 2' }));
    const def = getReport('safety-summary')!;
    const r = await asActor(w.ehsA, (tx) => def.run(tx, w.ehsA, def.params.parse({})));
    expect(r.headline).toBe('1 recordable case and 2 near misses in 365 days; 0 days since the last recordable');
    expect(r.insights.join(' ')).toMatch(/cannot be computed/);
    expect(r.insights.join(' ')).toMatch(/1 report not yet classified/);
    expect(JSON.stringify(r.rows)).not.toMatch(/Luis|Laceration/);
  });

  it('reminders chase overdue actions and unclassified reports', async () => {
    const nm = await asActor(w.techA, (tx) => reportIncident(tx, w.techA, { facilityId: w.facilities.A!, kind: 'property_damage', occurredAt: new Date(), description: 'Rack upright hit' }));
    await asActor(w.ehsA, (tx) => addAction(tx, w.ehsA, { subjectType: 'safety_incident', subjectId: nm.id, title: 'Replace upright', ownerUserId: w.managerA.userId, dueDate: '2026-11-01' }));
    const counts = await runReminders(w.tenantId, '2027-01-04');
    expect(counts.action_overdue).toBeGreaterThanOrEqual(1);
    expect(counts.incident_unclassified).toBeGreaterThanOrEqual(1);
    expect((await notices(w.managerA, 'reminder.action_overdue'))[0].title).toMatch(/^Overdue since 2026-11-01: Replace upright \(INC-\d+\)$/);
    const rows = await asActor(w.ehsA, (tx) => many(tx, `SELECT count(*)::int AS n FROM notification WHERE kind = 'reminder.incident_unclassified' AND user_id = $1`, [w.ehsA.userId]));
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    void one;
  });
});
