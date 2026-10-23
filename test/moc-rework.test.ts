import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools } from '../src/platform/db/pool.js';
import { many, one } from '../src/platform/db/tx.js';
import { decideApproval } from '../src/modules/approvals/service.js';
import { createChange, getChange, reviseChange, submitForReview } from '../src/modules/moc/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** A rejected change is reworked and resubmitted as a new approval round (SC-001, D-183C). */
let w: World;
const PLAN = { consequences: 'Higher spindle load', qmsImpact: 'Setup sheet changes', resources: 'Holders on hand', responsibilities: 'Owner: the requester' };
const NO = { affects_safety_systems: false, new_or_changed_chemical: true, changes_operating_limits: false, affects_controls_software: false,
  affects_product_quality: false, affects_environmental: false, requires_procedure_change: false, requires_training: false, affects_staffing: false };
beforeAll(async () => { w = await makeWorld('mocrw'); });
afterAll(closePools);

const reject = async (id: string, comment: string) => {
  const step = await asActor(w.admin, (tx) => one(tx, `SELECT s.id FROM approval_step s JOIN approval_request r ON r.id = s.request_id
    WHERE r.subject_id = $1 AND r.status = 'pending' AND s.role_key = 'ehs_reviewer' AND s.status = 'pending'`, [id]));
  await asActor(w.ehsA, (tx) => decideApproval(tx, w.ehsA, step.id, { decision: 'reject', comment }));
};

describe('rework of a rejected change', () => {
  let id: string;
  it('shows who rejected it and why', async () => {
    id = (await asActor(w.techA, (tx) => createChange(tx, w.techA, { ...PLAN, facilityId: w.facilities.A!, title: 'New cutting fluid', changeType: 'material',
      description: 'Replace the semi-synthetic coolant with a new vendor product.', justification: 'Vendor offers 12% lower price per gallon.' }))).id;
    await asActor(w.techA, (tx) => submitForReview(tx, w.techA, id, NO));
    await reject(id, 'No SDS provided.');
    const c = await asActor(w.techA, (tx) => getChange(tx, w.techA, id));
    expect(c.status).toBe('rejected');
    expect(c.revision).toBe(1);
    expect(c.rejection).toMatchObject({ comment: 'No SDS provided.', decided_by: expect.any(String), revision: 1 });
  });

  it('can be resubmitted as it stands: a new revision, a fresh pending round, the old round kept', async () => {
    const r = await asActor(w.techA, (tx) => submitForReview(tx, w.techA, id, NO));
    expect(r.status).toBe('review');
    const c = await asActor(w.techA, (tx) => getChange(tx, w.techA, id));
    expect(c.status).toBe('review');
    expect(c.revision).toBe(2);
    expect(c.rejection).toBeNull();
    const rounds = c.approvals.filter((a: any) => a.purpose === 'moc.authorize');
    expect(rounds.map((a: any) => [a.subject_revision, a.status])).toEqual([[1, 'rejected'], [2, 'pending']]);
    expect(rounds[0].steps.find((s: any) => s.status === 'rejected').comment).toBe('No SDS provided.');
    expect(rounds[1].steps.every((s: any) => s.status === 'pending')).toBe(true);
    // the plan is not duplicated by the second submission
    const open = await asActor(w.admin, (tx) => many(tx, `SELECT title FROM moc_action WHERE change_id = $1 AND generated AND status = 'open'`, [id]));
    expect(new Set(open.map((a) => a.title)).size).toBe(open.length);
    expect((await asActor(w.admin, (tx) => one(tx, `SELECT count(*)::int AS n FROM audit_event WHERE entity_id = $1 AND action = 'moc.resubmitted'`, [id]))).n).toBe(1);
  });

  it('can be edited while rejected: the edit returns it to draft as a new revision, and submitting opens another round', async () => {
    await reject(id, 'SDS shows a skin sensitizer; say how it is handled.');
    expect((await asActor(w.techA, (tx) => getChange(tx, w.techA, id))).status).toBe('rejected');
    const edited = await asActor(w.techA, (tx) => reviseChange(tx, w.techA, id, { justification: 'Vendor offers 12% lower price; SDS attached, gloves specified.' }));
    expect(edited.status).toBe('draft');
    expect(edited.revision).toBe(3);
    await asActor(w.techA, (tx) => submitForReview(tx, w.techA, id, NO));
    const c = await asActor(w.techA, (tx) => getChange(tx, w.techA, id));
    expect(c.revision).toBe(3);
    expect(c.approvals.filter((a: any) => a.purpose === 'moc.authorize').map((a: any) => [a.subject_revision, a.status])).toEqual([[1, 'rejected'], [2, 'rejected'], [3, 'pending']]);
    expect(c.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['moc.reworked', 'moc.resubmitted']));
  });

  it('is refused for people who are neither the author nor a coordinator, and for changes that are not rejected or draft', async () => {
    await reject(id, 'Still not enough.');
    await expect(asActor(w.ehsA, (tx) => reviseChange(tx, w.ehsA, id, { title: 'Hijacked title' }))).rejects.toThrow(/moc\.(request|manage)/);
    await expect(asActor(w.ehsA, (tx) => submitForReview(tx, w.ehsA, id, NO))).rejects.toThrow(/moc.manage/);
    await asActor(w.techA, (tx) => submitForReview(tx, w.techA, id, NO));
    await expect(asActor(w.techA, (tx) => submitForReview(tx, w.techA, id, NO))).rejects.toThrow(/draft or rejected/);
  });
});
