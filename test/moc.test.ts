import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { myApprovalQueue } from '../src/platform/approvals/engine.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createAsset } from '../src/modules/assets/service.js';
import { addVersion, approveVersion, createDocument } from '../src/modules/documents/service.js';
import { addLearningEvent, createCourse, createCourseVersion, publishVersion } from '../src/modules/learning/catalog.js';
import { assignTraining } from '../src/modules/learning/training.js';
import { addLabor, assignTechnician, createWorkOrder, transitionWorkOrder } from '../src/modules/maintenance/service.js';
import { screen } from '../src/modules/moc/screening.js';
import {
  answerPssr, cancelAction, closeChange, completeAction, createChange, getChange, linkActionWorkOrder, listChanges, requestStartup, reviseChange, submitForReview,
} from '../src/modules/moc/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const blobs = new LocalBlobStore('./.storage/test');
let w: World;
let assetId: string;
let docId: string;
let courseId: string;

/** ISO 9001 6.3 planning (D-158), required before review. */
const PLAN = { consequences: 'Higher spindle load; holder failure if unbalanced', qmsImpact: 'Setup sheet and course change', resources: 'Balanced holders on hand', responsibilities: 'Owner: the requester; ops authorizes' };
const NO = { affects_safety_systems: false, new_or_changed_chemical: false, changes_operating_limits: false, affects_controls_software: false,
  affects_product_quality: false, affects_environmental: false, requires_procedure_change: false, requires_training: false, affects_staffing: false };

beforeAll(async () => {
  w = await makeWorld('moc');
  ({ assetId, docId, courseId } = await asActor(w.admin, async (tx) => {
    const a = await createAsset(tx, w.admin, { facilityId: w.facilities.A!, assetTag: 'HMC-9', name: 'Horizontal machining center' });
    const d = await createDocument(tx, w.admin, { facilityId: w.facilities.A!, docNumber: 'SOP-HMC-9', title: 'HMC-9 operating procedure', docType: 'sop' });
    const v = await addVersion(tx, w.admin, blobs, d.id, { versionLabel: 'Rev A', fileName: 's.txt', mimeType: 'text/plain', content: Buffer.from('max 10k rpm') });
    await approveVersion(tx, w.managerA, v.id);
    const c = await createCourse(tx, w.admin, { facilityId: w.facilities.A!, code: 'HMC-OPS', title: 'HMC-9 operation' });
    const cv = await createCourseVersion(tx, w.admin, c.id, {});
    await addLearningEvent(tx, w.admin, cv.id, { kind: 'self_study', title: 'Read SOP', documentId: d.id });
    await publishVersion(tx, w.admin, cv.id);
    return { assetId: a.id, docId: d.id, courseId: c.id };
  }));
});
afterAll(closePools);

/** Approves every pending step of the current stage with the given actors (in order of role). */
async function approve(changeId: string, purpose: string, byRole: Record<string, typeof w.admin>) {
  const req = await asActor(w.admin, (tx) => one(tx, `SELECT id FROM approval_request WHERE subject_id = $1 AND purpose = $2 AND status = 'pending'`, [changeId, purpose]));
  for (;;) {
    const steps = await asActor(w.admin, (tx) => many(tx, `SELECT id, role_key FROM approval_step WHERE request_id = $1 AND status = 'pending'
      AND stage = (SELECT min(stage) FROM approval_step WHERE request_id = $1 AND status = 'pending')`, [req.id]));
    if (!steps.length) return;
    for (const s of steps) await asActor(byRole[s.role_key]!, (tx) => decideApproval(tx, byRole[s.role_key]!, s.id, { decision: 'approve', comment: 'Reviewed: OK' }));
  }
}

describe('screening rules', () => {
  it('routes reviews and risk deterministically', () => {
    expect(screen('procedure', NO, false)).toEqual({ riskLevel: 'low', reviews: [], pssrRequired: false, reasons: [] });
    expect(screen('equipment', { ...NO, changes_operating_limits: true }, false)).toMatchObject({ riskLevel: 'high', reviews: ['ehs_reviewer', 'maintenance_manager'], pssrRequired: true });
    expect(screen('process', { ...NO, affects_product_quality: true }, false)).toMatchObject({ riskLevel: 'medium', reviews: ['quality_reviewer'], pssrRequired: false });
    expect(screen('material', { ...NO, new_or_changed_chemical: true }, false)).toMatchObject({ riskLevel: 'high', reviews: ['ehs_reviewer'], pssrRequired: true });
    expect(screen('procedure', NO, true).riskLevel).toBe('medium');
  });
});

describe('management of change lifecycle', () => {
  let changeId: string;

  it('a technician raises a change; screening builds the review route and action plan', async () => {
    const c = await asActor(w.techA, (tx) => createChange(tx, w.techA, { ...PLAN,
      facilityId: w.facilities.A!, title: 'Raise HMC-9 spindle limit to 12k rpm', changeType: 'equipment',
      description: 'Increase the programmed spindle limit from 10,000 to 12,000 rpm for the new aluminum housing job.',
      justification: 'Cycle time on the new job drops 18% at 12k rpm; OEM rates the spindle to 12k.',
      affected: [{ entityType: 'asset', entityId: assetId }, { entityType: 'document', entityId: docId }, { entityType: 'course', entityId: courseId }],
    }));
    changeId = c.id;
    expect(c.number).toBe('MOC-000001');
    const r = await asActor(w.techA, (tx) => submitForReview(tx, w.techA, changeId, { ...NO, changes_operating_limits: true, requires_procedure_change: true, requires_training: true }));
    expect(r).toMatchObject({ riskLevel: 'high', reviews: ['ehs_reviewer', 'maintenance_manager'], pssrRequired: true, status: 'review' });
    const full = await asActor(w.managerA, (tx) => getChange(tx, w.managerA, changeId));
    expect(full.actions.map((a: any) => a.kind).sort()).toEqual(['communication', 'document_update', 'hazard_review', 'training', 'work_order']);
    expect(full.approvals[0].steps.map((s: any) => [s.stage, s.role_key]).sort()).toEqual([[1, 'ehs_reviewer'], [1, 'maintenance_manager'], [2, 'operations_manager']]);
  });

  it('enforces stage order, role membership and separation of duties', async () => {
    const steps = await asActor(w.admin, (tx) => many(tx, `SELECT s.id, s.role_key FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_id = $1`, [changeId]));
    const step = (role: string) => steps.find((s) => s.role_key === role)!.id;
    await expect(asActor(w.opsA, (tx) => decideApproval(tx, w.opsA, step('operations_manager'), { decision: 'approve', comment: 'Reviewed: OK' }))).rejects.toThrow(/earlier approval stages/);
    await expect(asActor(w.qualityA, (tx) => decideApproval(tx, w.qualityA, step('ehs_reviewer'), { decision: 'approve', comment: 'Reviewed: OK' }))).rejects.toThrow(/role ehs_reviewer/);
    expect((await asActor(w.ehsA, (tx) => myApprovalQueue(tx, w.ehsA))).map((q) => q.role_key)).toEqual(['ehs_reviewer']);
    await asActor(w.ehsA, (tx) => decideApproval(tx, w.ehsA, step('ehs_reviewer'), { decision: 'approve', comment: 'Guarding rated for 12k; OK' }));
    await asActor(w.dualA, (tx) => decideApproval(tx, w.dualA, step('maintenance_manager'), { decision: 'approve', comment: 'Reviewed: OK' }));
    // dualA also holds operations_manager but already signed this request.
    await expect(asActor(w.dualA, (tx) => decideApproval(tx, w.dualA, step('operations_manager'), { decision: 'approve', comment: 'Reviewed: OK' }))).rejects.toThrow(/different person/);
    const r = await asActor(w.opsA, (tx) => decideApproval(tx, w.opsA, step('operations_manager'), { decision: 'approve', comment: 'Reviewed: OK' }));
    expect(r.requestStatus).toBe('approved');
    expect((await asActor(w.admin, (tx) => getChange(tx, w.admin, changeId))).status).toBe('approved');
    await expect(asActor(w.admin, (tx) => tx.query(`UPDATE approval_step SET status = 'rejected' WHERE id = $1`, [step('ehs_reviewer')]))).rejects.toThrow(/final/);
  });

  it('a material change after approval voids the approvals and requires re-approval', async () => {
    await expect(asActor(w.techA, (tx) => reviseChange(tx, w.techA, changeId, { title: 'Raise to 12.5k' }))).rejects.toThrow(/moc.manage/);
    await expect(asActor(w.managerA, (tx) => reviseChange(tx, w.managerA, changeId, { description: 'Raise the limit to 12,500 rpm instead of 12,000.' }))).rejects.toThrow(/reason/);
    const c = await asActor(w.managerA, (tx) => reviseChange(tx, w.managerA, changeId,
      { description: 'Increase the programmed spindle limit from 10,000 to 12,000 rpm, only on pallet 2 fixtures.' }, 'Scope limited to pallet 2 after vibration review'));
    expect(c).toMatchObject({ status: 'draft', revision: 2, approved_at: null });
    const reqs = await asActor(w.admin, (tx) => many(tx, `SELECT status FROM approval_request WHERE subject_id = $1 ORDER BY created_at`, [changeId]));
    expect(reqs.map((r) => r.status)).toEqual(['superseded']);
    await asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, changeId, { ...NO, changes_operating_limits: true, requires_procedure_change: true, requires_training: true }));
    // managerA resubmitted, so managerA may not sign the maintenance review of this request.
    const own = await asActor(w.admin, (tx) => one(tx, `SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id
      WHERE r.subject_id = $1 AND r.status = 'pending' AND s.role_key = 'maintenance_manager'`, [changeId]));
    await expect(asActor(w.managerA, (tx) => decideApproval(tx, w.managerA, own.id, { decision: 'approve', comment: 'Reviewed: OK' }))).rejects.toThrow(/request you raised/);
    await approve(changeId, 'moc.authorize', { ehs_reviewer: w.ehsA, maintenance_manager: w.dualA, operations_manager: w.opsA });
    const full = await asActor(w.admin, (tx) => getChange(tx, w.admin, changeId));
    expect(full.status).toBe('approved');
    expect(full.approvals.map((r: any) => [r.subject_revision, r.status])).toEqual([[1, 'superseded'], [2, 'approved']]);
    // Re-screening replaced the generated plan rather than duplicating it.
    expect(full.actions.filter((a: any) => a.status === 'open')).toHaveLength(5);
  });

  it('actions are verified against platform records, not ticked', async () => {
    const actions = (await asActor(w.managerA, (tx) => getChange(tx, w.managerA, changeId))).actions.filter((a: any) => a.status === 'open');
    const act = (kind: string) => actions.find((a: any) => a.kind === kind)!.id;
    await expect(asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('document_update'), {}))).rejects.toThrow(/no revision of the document has been approved since/);
    await asActor(w.admin, async (tx) => {
      const v = await addVersion(tx, w.admin, blobs, docId, { versionLabel: 'Rev B', fileName: 's.txt', mimeType: 'text/plain', content: Buffer.from('max 12k rpm, pallet 2 only'), changeSummary: 'Speed limit raised for the new spindle (the change)' });
      await approveVersion(tx, w.managerA, v.id);
    });
    const done = await asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('document_update'), {}));
    expect(done.verification).toMatchObject({ document: 'SOP-HMC-9', version: 'Rev B' });

    await expect(asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('training'), {}))).rejects.toThrow(/publish an updated course version/);
    await asActor(w.admin, async (tx) => {
      const prev = await one(tx, `SELECT id FROM course_version WHERE course_id = $1 AND status = 'published'`, [courseId]);
      const v = await createCourseVersion(tx, w.admin, courseId, { copyFromVersionId: prev.id, changeSummary: 'Rev B limits' });
      await publishVersion(tx, w.admin, v.id);
      await assignTraining(tx, w.admin, { courseVersionId: v.id, employeeIds: [w.techAEmployeeId] });
    });
    expect((await asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('training'), {}))).verification).toMatchObject({ assigned: 1, completed: 0 });

    const wo = await asActor(w.managerA, async (tx) => {
      const o = await createWorkOrder(tx, w.managerA, { assetId, title: 'Update spindle limit parameter', woType: 'other' });
      await assignTechnician(tx, w.managerA, o.id, w.techAEmployeeId);
      return o;
    });
    await asActor(w.managerA, (tx) => linkActionWorkOrder(tx, w.managerA, act('work_order'), wo.id));
    await expect(asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('work_order'), {}))).rejects.toThrow(/must be verified or closed/);
    await asActor(w.techA, async (tx) => {
      await transitionWorkOrder(tx, w.techA, wo.id, { to: 'in_progress' });
      await addLabor(tx, w.techA, wo.id, { workDate: '2026-10-21', hours: 0.5 });
      await transitionWorkOrder(tx, w.techA, wo.id, { to: 'completed' });
    });
    await asActor(w.managerA, (tx) => transitionWorkOrder(tx, w.managerA, wo.id, { to: 'verified' }));
    await asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('work_order'), {}));

    await expect(asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('hazard_review'), { note: 'done' }))).rejects.toThrow(/describe what was done/);
    await asActor(w.managerA, (tx) => completeAction(tx, w.managerA, act('hazard_review'), { note: 'What-if review held 10/20; balance check added to setup sheet.' }));
  });

  it('startup is blocked by open actions and by a failed pre-startup review item', async () => {
    await expect(asActor(w.managerA, (tx) => requestStartup(tx, w.managerA, changeId))).rejects.toThrow(/startup action\(s\) still open: Brief affected shifts/);
    const comm = (await asActor(w.managerA, (tx) => getChange(tx, w.managerA, changeId))).actions.find((a: any) => a.kind === 'communication' && a.status === 'open');
    await asActor(w.managerA, (tx) => completeAction(tx, w.managerA, comm.id, { note: 'Toolbox talk held with 1st and 2nd shift on 10/21.' }));
    expect(await asActor(w.managerA, (tx) => requestStartup(tx, w.managerA, changeId))).toEqual({ status: 'startup_review' });
    const items = (await asActor(w.managerA, (tx) => getChange(tx, w.managerA, changeId))).pssr;
    expect(items).toHaveLength(6); // temporary-change item omitted for a permanent change
    await expect(asActor(w.managerA, (tx) => answerPssr(tx, w.managerA, changeId, [{ seq: 4, response: 'no' }]))).rejects.toThrow(/explain/);
    const partial = await asActor(w.managerA, (tx) => answerPssr(tx, w.managerA, changeId,
      items.map((i: any) => ({ seq: i.seq, response: i.seq === 4 ? 'no' : 'yes', note: i.seq === 4 ? 'Second shift not yet trained' : null }))));
    expect(partial).toMatchObject({ blocking: [4], startupApprovalRequested: false });
    const ok = await asActor(w.managerA, (tx) => answerPssr(tx, w.managerA, changeId, [{ seq: 4, response: 'yes' }]));
    expect(ok).toMatchObject({ blocking: [], unanswered: [], startupApprovalRequested: true });
    await approve(changeId, 'moc.startup', { ehs_reviewer: w.ehsA, operations_manager: w.opsA });
    expect((await asActor(w.admin, (tx) => getChange(tx, w.admin, changeId))).status).toBe('in_service');
    await asActor(w.managerA, (tx) => closeChange(tx, w.managerA, changeId, 'Running at 12k on pallet 2 for two weeks with no vibration alarms.', { achieved: true, evidence: 'Cycle time down 17% over 240 parts; no vibration alarms; bores in tolerance.' }));
    const final = await asActor(w.admin, (tx) => getChange(tx, w.admin, changeId));
    expect(final.status).toBe('closed');
    expect(final.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['moc.created', 'moc.submitted', 'moc.revised', 'moc.approved', 'moc.pssr_opened', 'moc.started_up', 'moc.closed']));
  });
});

describe('temporary changes, rejection and visibility', () => {
  it('temporary changes get a restore action that cannot be dropped, and a bounded duration', async () => {
    const base = { ...PLAN, facilityId: w.facilities.A!, title: 'Bypass coolant chiller', changeType: 'equipment' as const, description: 'Run HMC-9 with the portable chiller while the main chiller is repaired.', justification: 'Main chiller compressor failed; parts are 3 weeks out.' };
    await expect(asActor(w.managerA, (tx) => createChange(tx, w.managerA, { ...base, isTemporary: true, temporaryUntil: '2030-01-01' }))).rejects.toThrow(/at most 180 days/);
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const c = await asActor(w.managerA, (tx) => createChange(tx, w.managerA, { ...base, isTemporary: true, temporaryUntil: until }));
    const r = await asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, NO));
    expect(r.riskLevel).toBe('medium');
    const restore = (await asActor(w.managerA, (tx) => getChange(tx, w.managerA, c.id))).actions.find((a: any) => a.kind === 'restore');
    expect(restore).toMatchObject({ required_before: 'closeout', due_on: until });
    await expect(asActor(w.managerA, (tx) => cancelAction(tx, w.managerA, restore.id, 'not needed'))).rejects.toThrow(/cannot be cancelled/);
  });

  it('a rejection needs a reason and returns the change to its author for rework', async () => {
    const c = await asActor(w.techA, (tx) => createChange(tx, w.techA, { ...PLAN, facilityId: w.facilities.A!, title: 'Switch to new cutting fluid', changeType: 'material',
      description: 'Replace the semi-synthetic coolant with a new vendor product.', justification: 'Vendor offers 12% lower price per gallon.' }));
    await asActor(w.techA, (tx) => submitForReview(tx, w.techA, c.id, { ...NO, new_or_changed_chemical: true }));
    const step = await asActor(w.admin, (tx) => one(tx, `SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_id = $1 AND s.role_key = 'ehs_reviewer'`, [c.id]));
    await expect(asActor(w.ehsA, (tx) => decideApproval(tx, w.ehsA, step.id, { decision: 'reject' }))).rejects.toThrow(/needs a comment/);
    await asActor(w.ehsA, (tx) => decideApproval(tx, w.ehsA, step.id, { decision: 'reject', comment: 'No SDS provided; skin sensitizer per vendor sheet.' }));
    const after = await asActor(w.techA, (tx) => getChange(tx, w.techA, c.id));
    expect(after.status).toBe('rejected');
    expect(after.approvals[0].steps.find((s: any) => s.role_key === 'operations_manager').status).toBe('skipped');
    const reworked = await asActor(w.techA, (tx) => reviseChange(tx, w.techA, c.id, { justification: 'Vendor offers 12% lower price; SDS attached, no sensitizers.' }));
    expect(reworked.status).toBe('draft');
  });

  it('changes are visible only within the facility scope', async () => {
    expect(await asActor(w.operatorB, (tx) => listChanges(tx, w.operatorB, {}))).toEqual([]);
    const forAsset = await asActor(w.exec, (tx) => listChanges(tx, w.exec, { entityType: 'asset', entityId: assetId }));
    expect(forAsset.map((c) => c.number)).toEqual(['MOC-000001']);
  });
});

describe('ISO 9001 change control (D-158)', () => {
  const draft = (extra: Record<string, unknown> = {}) => asActor(w.managerA, (tx) => createChange(tx, w.managerA, {
    facilityId: w.facilities.A!, title: 'Change the deburr tool on op 30', changeType: 'process' as const,
    description: 'Replace the manual deburr on op 30 with a brush deburr in the machine cycle.', justification: 'Burrs on cross-drilled ports caused two customer returns.', ...extra }));

  it('6.3: planning comes before review: consequences, QMS impact, resources and responsibilities', async () => {
    const c = await draft();
    await expect(asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, NO))).rejects.toThrow(/potential consequences.*quality management system.*resources.*responsible/);
    await asActor(w.managerA, (tx) => reviseChange(tx, w.managerA, c.id, PLAN));
    await expect(asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, NO))).resolves.toMatchObject({ status: 'review' });
  });

  it('8.2.4 / 8.5.6: a change customers must approve plans their approval before startup; the customers must be named', async () => {
    const c = await draft({ ...PLAN, customerImpact: 'approval' });
    await expect(asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, NO))).rejects.toThrow(/which customers/);
    await asActor(w.managerA, (tx) => reviseChange(tx, w.managerA, c.id, { customerNote: 'Lakeshore: PPAP change notification and approval' }));
    await asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, NO));
    const full = await asActor(w.managerA, (tx) => getChange(tx, w.managerA, c.id));
    expect(full.actions.find((a: any) => a.kind === 'customer')).toMatchObject({ required_before: 'startup', title: expect.stringMatching(/customer’s approval/) });
  });

  it('8.1: an emergency or unintended change has its consequences reviewed before close-out', async () => {
    const c = await draft({ ...PLAN, origin: 'unintended' });
    await asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, NO));
    const full = await asActor(w.managerA, (tx) => getChange(tx, w.managerA, c.id));
    expect(full.actions.find((a: any) => a.kind === 'consequence_review')).toMatchObject({ required_before: 'closeout', title: expect.stringMatching(/unintended change/) });
  });

  it('8.5.6: every authorization records the result of the review', async () => {
    const c = await draft({ ...PLAN });
    await asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, { ...NO, affects_product_quality: true }));
    const step = await asActor(w.admin, (tx) => one(tx, `SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE r.subject_id = $1 AND s.role_key = 'quality_reviewer'`, [c.id]));
    expect((await asActor(w.qualityA, (tx) => myApprovalQueue(tx, w.qualityA))).find((q) => q.subject_id === c.id)).toMatchObject({ comment_required: true });
    await expect(asActor(w.qualityA, (tx) => decideApproval(tx, w.qualityA, step.id, { decision: 'approve' }))).rejects.toThrow(/record the result of your review/);
    await asActor(w.qualityA, (tx) => decideApproval(tx, w.qualityA, step.id, { decision: 'approve', comment: 'Brush trial on 50 parts: no burrs, no edge break beyond 0.2 mm' }));
  });

  it('6.3 a / 9.1: closing needs the verified outcome; one that missed its purpose names its follow-up', async () => {
    const closed = await asActor(w.admin, (tx) => one(tx, `SELECT outcome_achieved, effectiveness_note FROM moc_change WHERE status = 'closed' LIMIT 1`));
    expect(closed).toMatchObject({ outcome_achieved: true, effectiveness_note: expect.stringMatching(/Cycle time down/) });
    const c = await draft({ ...PLAN });
    await getAdminPool().query(`UPDATE moc_change SET status = 'in_service', in_service_at = now() WHERE id = $1`, [c.id]); // a change already in service, for the closure rules
    const close = (outcome?: { achieved: boolean; evidence: string }) => asActor(w.managerA, (tx) => closeChange(tx, w.managerA, c.id, 'Brush deburr running on op 30 since the trial.', outcome));
    await expect(close()).rejects.toThrow(/achieved its purpose/);
    await expect(close({ achieved: true, evidence: 'ok' })).rejects.toThrow(/give the evidence/);
    await expect(close({ achieved: false, evidence: 'Burrs still found on 3 of 200 ports at final inspection.' })).rejects.toThrow(/needs a follow-up/);
    // The follow-up must exist (D-161): a number that names nothing, or the word "corrective", is not one.
    await expect(close({ achieved: false, evidence: 'Burrs still found on 3 of 200 ports; corrective action CA-999999 opened for the brush wear rate.' })).rejects.toThrow(/needs a follow-up/);
    await expect(close({ achieved: false, evidence: 'Burrs still found; no corrective action was needed for this one.' })).rejects.toThrow(/needs a follow-up/);
    const { createCapa } = await import('../src/modules/quality/service.js');
    const ca = await asActor(w.admin, (tx) => createCapa(tx, w.admin, { facilityId: c.facility_id, title: 'Brush wear rate', problem: 'Burrs return as the deburr brush wears.', source: 'change',
      originType: 'moc_change', originId: c.id, ownerUserId: w.admin.userId }));
    await close({ achieved: false, evidence: `Burrs still found on 3 of 200 ports; corrective action ${ca.number} opened for the brush wear rate.` });
    expect(await asActor(w.admin, (tx) => one(tx, 'SELECT status, outcome_achieved FROM moc_change WHERE id = $1', [c.id]))).toEqual({ status: 'closed', outcome_achieved: false });
  });
});

describe('justification presentation (D-159)', () => {
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  it('a draft carries its deck (PowerPoint or PDF, every version kept) or a link; frozen once submitted', async () => {
    const { addAttachment } = await import('../src/modules/quality/attachments.js');
    const { setJustificationLink } = await import('../src/modules/moc/service.js');
    const blobs = new LocalBlobStore('./.storage/test');
    const c = await asActor(w.managerA, (tx) => createChange(tx, w.managerA, { ...PLAN, facilityId: w.facilities.A!, title: 'Second shift on line 2', changeType: 'organizational',
      description: 'Add a second shift on line 2 for the housing family.', justification: 'Demand forecast exceeds one-shift capacity from March.' }));
    const add = (who = w.managerA, mime = PPTX, name = 'case.pptx') => asActor(who, (tx) => addAttachment(tx, who, blobs, { subjectType: 'moc_change', subjectId: c.id, fileName: name, mime, content: Buffer.from('deck') }));
    await expect(add(w.managerA, 'image/png', 'chart.png')).rejects.toThrow(/PowerPoint .* or PDF/);
    await expect(add(w.techA)).rejects.toThrow(/moc.manage|moc.view/);
    await add(w.managerA, PPTX, 'case-v1.pptx');
    await add(w.managerA, 'application/pdf', 'case-v2.pdf');
    await expect(asActor(w.managerA, (tx) => setJustificationLink(tx, w.managerA, c.id, 'http://intranet/deck'))).rejects.toThrow(/https/);
    await asActor(w.managerA, (tx) => setJustificationLink(tx, w.managerA, c.id, 'https://example.sharepoint.com/sites/ops/case.pptx'));
    const full = await asActor(w.exec, (tx) => getChange(tx, w.exec, c.id));
    expect(full.presentations.map((p: any) => p.file_name)).toEqual(['case-v2.pdf', 'case-v1.pptx']);
    expect(full).toMatchObject({ justification_link: 'https://example.sharepoint.com/sites/ops/case.pptx', canEditDeck: false });
    await asActor(w.managerA, (tx) => submitForReview(tx, w.managerA, c.id, NO));
    await expect(add()).rejects.toThrow(/only while the change is a draft/);
    await expect(asActor(w.managerA, (tx) => setJustificationLink(tx, w.managerA, c.id, null))).rejects.toThrow(/only while the change is a draft/);
  });
});

