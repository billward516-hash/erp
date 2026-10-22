import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { assertAssignable, listActions } from '../quality/service.js';

const PLAN = 'continuity_plan';
const PURPOSE = 'continuity.approve';
/** Exercise kinds that actually time a recovery; a tabletop or walkthrough cannot demonstrate the RTO. */
const TIMED = ['simulation', 'full_test'];
const DOWN = ['unplanned_downtime', 'out_of_service'];

registerApprovalSubject(PLAN, {
  link: (id) => `/continuity/${id}`,
  describe: async (tx, id) => {
    const p = await one(tx, 'SELECT number, revision, title, rto_hours FROM continuity_plan WHERE id = $1', [id]);
    return p ? `${p.number} rev ${p.revision}: ${p.title} (RTO ${Number(p.rto_hours)} h)` : 'Continuity plan';
  },
});

async function lockPlan(tx: Tx, id: string) {
  const p = await one(tx, 'SELECT * FROM continuity_plan WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw notFound('continuity plan');
  return p;
}
const isOwner = (actor: Actor, p: any) => p.owner_user_id === actor.userId || p.alternate_user_id === actor.userId;
const editor = (actor: Actor, p: any) => isOwner(actor, p) || can(actor, 'continuity.manage', p.facility_id);
const viewer = (actor: Actor, p: any) => isOwner(actor, p) || can(actor, 'continuity.view', p.facility_id);
const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);
const iso = (d: any) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);

export interface PlanHeader {
  process: string; title: string; description?: string | null; criticality?: 'critical' | 'high' | 'medium'; rtoHours: number; rpoHours?: number | null;
  ownerUserId?: string; alternateUserId?: string | null; reviewIntervalMonths?: number; exerciseIntervalMonths?: number;
}

async function checkHeader(tx: Tx, facilityId: string, h: PlanHeader, ownerUserId: string) {
  if (!h.process?.trim() || !h.title?.trim()) throw invalid('name the critical process and give the plan a title');
  if (!(h.rtoHours > 0)) throw invalid('the recovery time objective (RTO) must be more than zero hours');
  if (h.rpoHours != null && h.rpoHours < 0) throw invalid('the recovery point objective cannot be negative');
  if (h.alternateUserId && h.alternateUserId === ownerUserId) throw invalid('the alternate must be someone other than the owner');
  await assertAssignable(tx, ownerUserId, facilityId);
  if (h.alternateUserId) await assertAssignable(tx, h.alternateUserId, facilityId);
}

export async function createPlan(tx: Tx, actor: Actor, input: PlanHeader & { facilityId: string }) {
  requirePermission(actor, 'continuity.manage', input.facilityId);
  const owner = input.ownerUserId ?? actor.userId;
  await checkHeader(tx, input.facilityId, input, owner);
  const number = `BCP-${String(await nextSequence(tx, actor.tenantId, 'continuity_plan')).padStart(3, '0')}`;
  const p = await one(tx, `INSERT INTO continuity_plan (tenant_id, facility_id, number, process, title, description, criticality, rto_hours, rpo_hours, owner_user_id, alternate_user_id,
      review_interval_months, exercise_interval_months, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.process.trim(), input.title.trim(), input.description ?? null, input.criticality ?? 'high', input.rtoHours, input.rpoHours ?? null,
    owner, input.alternateUserId ?? null, input.reviewIntervalMonths ?? 12, input.exerciseIntervalMonths ?? 12, actor.userId]);
  await audit(tx, actor, { action: 'continuity.created', entityType: PLAN, entityId: p.id, facilityId: p.facility_id, data: { number, process: p.process, rto: input.rtoHours } });
  return p;
}

/** Edits the header of a draft (objectives, owner and alternate, review and exercise intervals). */
export async function updatePlan(tx: Tx, actor: Actor, id: string, h: PlanHeader) {
  const p = await lockPlan(tx, id);
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  if (p.status !== 'draft') throw conflict('only a draft can be edited; start a new revision');
  const owner = h.ownerUserId ?? p.owner_user_id;
  await checkHeader(tx, p.facility_id, h, owner);
  await tx.query(`UPDATE continuity_plan SET process = $2, title = $3, description = $4, criticality = $5, rto_hours = $6, rpo_hours = $7, owner_user_id = $8, alternate_user_id = $9,
      review_interval_months = $10, exercise_interval_months = $11 WHERE id = $1`,
  [id, h.process.trim(), h.title.trim(), h.description ?? null, h.criticality ?? p.criticality, h.rtoHours, h.rpoHours ?? null, owner, h.alternateUserId ?? null,
    h.reviewIntervalMonths ?? p.review_interval_months, h.exerciseIntervalMonths ?? p.exercise_interval_months]);
  await audit(tx, actor, { action: 'continuity.updated', entityType: PLAN, entityId: id, facilityId: p.facility_id, data: { rto: h.rtoHours, rpo: h.rpoHours ?? null } });
  return getPlan(tx, actor, id);
}

export interface DependencyInput {
  kind: 'asset' | 'supplier' | 'skill' | 'person' | 'other'; assetId?: string | null; supplierId?: string | null; qualificationId?: string | null; employeeId?: string | null;
  description: string; workaround?: string | null; minHolders?: number | null;
}
export interface ScenarioInput {
  scenario: string; impact?: string | null; recoverySteps: string; recoveryOwnerUserId: string; estRecoveryHours?: number | null; documentId?: string | null;
}

/** Replaces the dependencies and scenarios of a draft (the editor saves the whole plan body). */
export async function savePlanBody(tx: Tx, actor: Actor, id: string, body: { dependencies: DependencyInput[]; scenarios: ScenarioInput[] }) {
  const p = await lockPlan(tx, id);
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  if (p.status !== 'draft') throw conflict('only a draft can be edited; start a new revision');
  const REF = { asset: 'assetId', supplier: 'supplierId', skill: 'qualificationId', person: 'employeeId' } as const;
  for (const [i, d] of body.dependencies.entries()) {
    const n = `dependency ${i + 1}`;
    if (!d.description?.trim()) throw invalid(`${n}: describe what the process needs from it`);
    for (const [kind, key] of Object.entries(REF)) {
      if ((d.kind === kind) !== Boolean(d[key])) throw invalid(d.kind === kind ? `${n}: choose the ${kind === 'skill' ? 'qualification' : kind === 'person' ? 'employee' : kind}` : `${n}: only a ${kind} dependency refers to a ${kind}`);
    }
    if (d.assetId && !(await one(tx, 'SELECT 1 FROM asset WHERE id = $1 AND facility_id = $2', [d.assetId, p.facility_id]))) throw invalid(`${n}: the asset must be at the plan's facility`);
    if (d.supplierId && !(await one(tx, 'SELECT 1 FROM supplier WHERE id = $1', [d.supplierId]))) throw invalid(`${n}: unknown supplier`);
    if (d.qualificationId && !(await one(tx, 'SELECT 1 FROM qualification WHERE id = $1', [d.qualificationId]))) throw invalid(`${n}: unknown qualification`);
    if (d.employeeId && !(await one(tx, 'SELECT 1 FROM employee WHERE id = $1', [d.employeeId]))) throw invalid(`${n}: unknown employee`);
    if (d.minHolders != null && d.kind !== 'skill') throw invalid(`${n}: a minimum number of holders applies to skills`);
  }
  for (const [i, s] of body.scenarios.entries()) {
    const n = `scenario ${i + 1}`;
    if (!s.scenario?.trim() || !s.recoverySteps?.trim()) throw invalid(`${n}: describe the disruption and the recovery steps`);
    if (s.estRecoveryHours != null && !(s.estRecoveryHours > 0)) throw invalid(`${n}: the recovery estimate must be more than zero hours`);
    await assertAssignable(tx, s.recoveryOwnerUserId, p.facility_id);
    if (s.documentId && !(await one(tx, 'SELECT 1 FROM document WHERE id = $1', [s.documentId]))) throw invalid(`${n}: unknown document`);
  }
  await tx.query('DELETE FROM continuity_dependency WHERE plan_id = $1', [id]);
  await tx.query('DELETE FROM continuity_scenario WHERE plan_id = $1', [id]);
  for (const [i, d] of body.dependencies.entries()) {
    await tx.query(`INSERT INTO continuity_dependency (tenant_id, plan_id, seq, kind, asset_id, supplier_id, qualification_id, employee_id, description, workaround, min_holders)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [actor.tenantId, id, i + 1, d.kind, d.assetId ?? null, d.supplierId ?? null, d.qualificationId ?? null, d.employeeId ?? null, d.description.trim(), d.workaround?.trim() || null,
      d.kind === 'skill' ? d.minHolders ?? 2 : null]);
  }
  for (const [i, s] of body.scenarios.entries()) {
    await tx.query(`INSERT INTO continuity_scenario (tenant_id, plan_id, seq, scenario, impact, recovery_steps, recovery_owner_user_id, est_recovery_hours, document_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actor.tenantId, id, i + 1, s.scenario.trim(), s.impact?.trim() || null, s.recoverySteps.trim(), s.recoveryOwnerUserId, s.estRecoveryHours ?? null, s.documentId ?? null]);
  }
  await audit(tx, actor, { action: 'continuity.body_saved', entityType: PLAN, entityId: id, facilityId: p.facility_id, data: { dependencies: body.dependencies.length, scenarios: body.scenarios.length } });
  return getPlan(tx, actor, id);
}

export interface ContactInput { name: string; role: string; phone?: string | null; email?: string | null; userId?: string | null; supplierId?: string | null }

/**
 * Replaces the call list. Allowed on the draft and on the approved revision (phone numbers change more often
 * than plans; every change is audited). While a newer draft exists, edit the draft's list instead.
 */
export async function saveContacts(tx: Tx, actor: Actor, id: string, contacts: ContactInput[]) {
  const p = await lockPlan(tx, id);
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  if (!['draft', 'approved'].includes(p.status)) throw conflict(`the plan is ${humanStatus(p.status)}`);
  if (p.status === 'approved') {
    const newer = await one(tx, `SELECT revision FROM continuity_plan WHERE tenant_id = $1 AND number = $2 AND status IN ('draft', 'in_review')`, [p.tenant_id, p.number]);
    if (newer) throw conflict(`revision ${newer.revision} is open; update the contacts there`);
  }
  for (const [i, c] of contacts.entries()) {
    if (!c.name?.trim() || !c.role?.trim()) throw invalid(`contact ${i + 1}: name and role are required`);
    if (!c.phone?.trim() && !c.email?.trim()) throw invalid(`contact ${i + 1}: a phone number or email is required`);
    if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email.trim())) throw invalid(`contact ${i + 1}: the email address is not valid`);
  }
  const before = await many(tx, 'SELECT name, role, phone, email FROM continuity_contact WHERE plan_id = $1 ORDER BY seq', [id]);
  await tx.query('DELETE FROM continuity_contact WHERE plan_id = $1', [id]);
  for (const [i, c] of contacts.entries()) {
    await tx.query(`INSERT INTO continuity_contact (tenant_id, plan_id, seq, name, role, phone, email, user_id, supplier_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [actor.tenantId, id, i + 1, c.name.trim(), c.role.trim(), c.phone?.trim() || null, c.email?.trim() || null, c.userId ?? null, c.supplierId ?? null]);
  }
  await audit(tx, actor, { action: 'continuity.contacts_saved', entityType: PLAN, entityId: id, facilityId: p.facility_id, data: { before, after: contacts.map((c) => ({ name: c.name, role: c.role, phone: c.phone ?? null, email: c.email ?? null })) } });
}
const humanStatus = (s: string) => s.replace(/_/g, ' ');

/**
 * Sends the plan for approval by the plant manager. A plan must say how each scenario is recovered and by whom,
 * and give someone to call; recovery estimates over the RTO are allowed (they are shown as gaps), because a
 * plan that admits a gap is better than no plan.
 */
export async function submitPlan(tx: Tx, actor: Actor, id: string) {
  const p = await lockPlan(tx, id);
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  if (p.status !== 'draft') throw conflict(`the plan is ${humanStatus(p.status)}`);
  const n = await one(tx, `SELECT (SELECT count(*)::int FROM continuity_scenario WHERE plan_id = $1) AS scenarios, (SELECT count(*)::int FROM continuity_contact WHERE plan_id = $1) AS contacts`, [id]);
  if (!n.scenarios) throw invalid('add at least one disruption scenario with its recovery steps');
  if (!n.contacts) throw invalid('add the call list (at least one contact)');
  await tx.query(`UPDATE continuity_plan SET status = 'in_review' WHERE id = $1`, [id]);
  await createApprovalRequest(tx, actor, { facilityId: p.facility_id, subjectType: PLAN, subjectId: id, subjectRevision: p.revision, purpose: PURPOSE,
    stages: [{ steps: [{ roleKey: 'operations_manager', label: 'Plant manager approval of the continuity plan' }] }] });
  await audit(tx, actor, { action: 'continuity.submitted', entityType: PLAN, entityId: id, facilityId: p.facility_id, data: { revision: p.revision } });
}

/** Approval engine callback: approval releases the revision (superseding the previous one); rejection returns it to draft. */
export async function onContinuityDecided(tx: Tx, actor: Actor, id: string, purpose: string, status: string) {
  if (purpose !== PURPOSE) return;
  const p = await lockPlan(tx, id);
  if (status === 'approved') {
    await tx.query(`UPDATE continuity_plan SET status = 'superseded' WHERE tenant_id = $1 AND number = $2 AND status = 'approved'`, [p.tenant_id, p.number]);
    await tx.query(`UPDATE continuity_plan SET status = 'approved', approved_at = now(), last_reviewed_at = now(), review_due = $2 WHERE id = $1`, [id, addMonths(today(), p.review_interval_months)]);
  } else if (status === 'rejected') {
    await tx.query(`UPDATE continuity_plan SET status = 'draft' WHERE id = $1`, [id]);
  }
  await notify(tx, p.tenant_id, [p.owner_user_id, p.alternate_user_id].filter(Boolean), { kind: 'approval.decided', title: `${p.number} rev ${p.revision} ${status === 'approved' ? 'approved' : 'sent back'}`,
    link: `/continuity/${id}`, subjectType: PLAN, subjectId: id, dedupeKey: `bcp-decided:${id}:${status}` }, actor.userId);
}

/** A new revision of the approved plan; the body and the call list carry over, open actions move with it. */
export async function revisePlan(tx: Tx, actor: Actor, id: string, reason: string) {
  const p = await lockPlan(tx, id);
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  if (p.status !== 'approved') throw conflict('only the approved revision can be revised');
  if (!reason?.trim()) throw invalid('say why (exercise findings, new equipment, supplier change, periodic review…)');
  const next = await one(tx, `INSERT INTO continuity_plan (tenant_id, facility_id, number, revision, process, title, description, criticality, rto_hours, rpo_hours, owner_user_id, alternate_user_id,
      review_interval_months, exercise_interval_months, revision_reason, created_by)
    SELECT tenant_id, facility_id, number, revision + 1, process, title, description, criticality, rto_hours, rpo_hours, owner_user_id, alternate_user_id,
      review_interval_months, exercise_interval_months, $2, $3 FROM continuity_plan WHERE id = $1 RETURNING *`, [id, reason.trim(), actor.userId]);
  await tx.query(`INSERT INTO continuity_dependency (tenant_id, plan_id, seq, kind, asset_id, supplier_id, qualification_id, employee_id, description, workaround, min_holders)
    SELECT tenant_id, $2, seq, kind, asset_id, supplier_id, qualification_id, employee_id, description, workaround, min_holders FROM continuity_dependency WHERE plan_id = $1`, [id, next.id]);
  await tx.query(`INSERT INTO continuity_scenario (tenant_id, plan_id, seq, scenario, impact, recovery_steps, recovery_owner_user_id, est_recovery_hours, document_id)
    SELECT tenant_id, $2, seq, scenario, impact, recovery_steps, recovery_owner_user_id, est_recovery_hours, document_id FROM continuity_scenario WHERE plan_id = $1`, [id, next.id]);
  await tx.query(`INSERT INTO continuity_contact (tenant_id, plan_id, seq, name, role, phone, email, user_id, supplier_id)
    SELECT tenant_id, $2, seq, name, role, phone, email, user_id, supplier_id FROM continuity_contact WHERE plan_id = $1`, [id, next.id]);
  await tx.query(`UPDATE action_item SET subject_id = $2 WHERE subject_type = $3 AND subject_id = $1 AND status = 'open'`, [id, next.id, PLAN]);
  await audit(tx, actor, { action: 'continuity.revised', entityType: PLAN, entityId: next.id, facilityId: p.facility_id, data: { from: p.revision, to: next.revision, reason } });
  return next;
}

/** Periodic review with no change needed: records who confirmed the plan is still right and sets the next review date. */
export async function confirmReview(tx: Tx, actor: Actor, id: string, note: string) {
  const p = await lockPlan(tx, id);
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  if (p.status !== 'approved') throw conflict('review the approved revision (or finish the open revision)');
  if (!note?.trim()) throw invalid('say what was checked (contacts called, dependencies still current…)');
  const due = addMonths(today(), p.review_interval_months);
  await tx.query('UPDATE continuity_plan SET last_reviewed_at = now(), last_review_note = $2, review_due = $3 WHERE id = $1', [id, note.trim(), due]);
  await audit(tx, actor, { action: 'continuity.reviewed', entityType: PLAN, entityId: id, facilityId: p.facility_id, data: { note: note.trim(), next: due } });
  return { reviewDue: due };
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

export async function scheduleExercise(tx: Tx, actor: Actor, planId: string, input: { kind: 'tabletop' | 'walkthrough' | 'simulation' | 'full_test'; scheduledOn: string; facilitatorUserId: string; scenarioId?: string | null }) {
  const p = await lockPlan(tx, planId);
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  if (p.status !== 'approved') throw conflict('exercise the approved revision of the plan');
  if (!input.scheduledOn) throw invalid('choose a date');
  await assertAssignable(tx, input.facilitatorUserId, p.facility_id);
  if (input.scenarioId && !(await one(tx, 'SELECT 1 FROM continuity_scenario WHERE id = $1 AND plan_id = $2', [input.scenarioId, planId]))) throw invalid('the scenario belongs to another plan');
  const e = await one(tx, `INSERT INTO continuity_exercise (tenant_id, facility_id, plan_id, scenario_id, kind, scheduled_on, facilitator_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, p.facility_id, planId, input.scenarioId ?? null, input.kind, input.scheduledOn, input.facilitatorUserId]);
  await notify(tx, actor.tenantId, [input.facilitatorUserId], { kind: 'continuity.exercise_scheduled', title: `Facilitate a ${input.kind.replace('_', ' ')} exercise of ${p.number}: ${p.title}`,
    body: `Scheduled for ${input.scheduledOn}`, link: `/continuity/${planId}`, subjectType: PLAN, subjectId: planId, dedupeKey: `bcp-exercise:${e.id}` }, actor.userId);
  await audit(tx, actor, { action: 'continuity.exercise_scheduled', entityType: PLAN, entityId: planId, facilityId: p.facility_id, data: { exerciseId: e.id, kind: input.kind, on: input.scheduledOn } });
  return e;
}

/**
 * Records the result (final once recorded). A timed exercise that took longer than the RTO cannot be recorded as
 * met, and anything short of met needs written findings; the plan then shows the gap until an action addresses it.
 */
export async function recordExercise(tx: Tx, actor: Actor, exerciseId: string, input: { conductedOn: string; participants: string; outcome: 'met' | 'partly_met' | 'not_met';
  achievedRecoveryHours?: number | null; findings?: string | null }) {
  const e = await one(tx, 'SELECT e.*, p.number, p.title, p.rto_hours, p.owner_user_id, p.alternate_user_id FROM continuity_exercise e JOIN continuity_plan p ON p.id = e.plan_id WHERE e.id = $1 FOR UPDATE OF e', [exerciseId]);
  if (!e) throw notFound('exercise');
  if (e.facilitator_user_id !== actor.userId && !editor(actor, e)) throw forbidden('facilitate the exercise or hold continuity.manage');
  if (e.status !== 'scheduled') throw conflict(`the exercise is ${e.status}`);
  if (!input.conductedOn || input.conductedOn > today()) throw invalid('record the date the exercise took place (not in the future)');
  if (!input.participants?.trim()) throw invalid('list who took part');
  const rto = Number(e.rto_hours);
  if (TIMED.includes(e.kind) && input.achievedRecoveryHours == null) throw invalid('a simulation or full test records how long recovery took');
  if (input.achievedRecoveryHours != null && input.achievedRecoveryHours > rto && input.outcome === 'met') {
    throw invalid(`recovery took ${input.achievedRecoveryHours} h against an RTO of ${rto} h; the objective was not met`);
  }
  if (input.outcome !== 'met' && !input.findings?.trim()) throw invalid('say what fell short (findings)');
  await tx.query(`UPDATE continuity_exercise SET status = 'completed', conducted_on = $2, participants = $3, outcome = $4, achieved_recovery_hours = $5, findings = $6, recorded_by = $7 WHERE id = $1`,
    [exerciseId, input.conductedOn, input.participants.trim(), input.outcome, input.achievedRecoveryHours ?? null, input.findings?.trim() || null, actor.userId]);
  if (input.outcome !== 'met') {
    await notify(tx, actor.tenantId, [e.owner_user_id, e.alternate_user_id].filter(Boolean), { kind: 'continuity.exercise_failed',
      title: `${e.number} exercise ${input.outcome === 'not_met' ? 'did not meet' : 'partly met'} its objectives`, body: input.findings!.trim().slice(0, 300),
      link: `/continuity/${e.plan_id}`, subjectType: PLAN, subjectId: e.plan_id, dedupeKey: `bcp-exercise-result:${exerciseId}` }, actor.userId);
  }
  await audit(tx, actor, { action: 'continuity.exercise_recorded', entityType: PLAN, entityId: e.plan_id, facilityId: e.facility_id,
    data: { exerciseId, outcome: input.outcome, achieved: input.achievedRecoveryHours ?? null, rto } });
}

export async function cancelExercise(tx: Tx, actor: Actor, exerciseId: string, reason: string) {
  const e = await one(tx, 'SELECT e.*, p.owner_user_id, p.alternate_user_id FROM continuity_exercise e JOIN continuity_plan p ON p.id = e.plan_id WHERE e.id = $1 FOR UPDATE OF e', [exerciseId]);
  if (!e) throw notFound('exercise');
  if (!editor(actor, e)) throw forbidden('continuity.manage (or own the plan)');
  if (e.status !== 'scheduled') throw conflict(`the exercise is ${e.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE continuity_exercise SET status = 'cancelled', cancel_reason = $2, recorded_by = $3 WHERE id = $1`, [exerciseId, reason.trim(), actor.userId]);
  await audit(tx, actor, { action: 'continuity.exercise_cancelled', entityType: PLAN, entityId: e.plan_id, facilityId: e.facility_id, data: { exerciseId, reason } });
}

// ---------------------------------------------------------------------------
// Reading and assessment
// ---------------------------------------------------------------------------

export interface Gap { severity: 'high' | 'watch'; area: string; text: string }

/**
 * Checks the plan against live records: recovery estimates against the RTO, skills with too few current
 * holders, people and suppliers with no fallback, equipment that is down right now, and whether the plan has
 * been reviewed, exercised and shown to recover within its RTO. Used by the plan page and the readiness report.
 */
export async function assessPlan(tx: Tx, p: any) {
  const rto = Number(p.rto_hours);
  const deps = await many(tx, `SELECT d.*, a.asset_tag, a.name AS asset_name, a.operational_state, s.code AS supplier_code, s.name AS supplier_name, s.active AS supplier_active,
      q.code AS qualification_code, q.name AS qualification_name, e.first_name || ' ' || e.last_name AS employee_name, e.status AS employee_status
    FROM continuity_dependency d LEFT JOIN asset a ON a.id = d.asset_id LEFT JOIN supplier s ON s.id = d.supplier_id LEFT JOIN qualification q ON q.id = d.qualification_id
    LEFT JOIN employee e ON e.id = d.employee_id WHERE d.plan_id = $1 ORDER BY d.seq`, [p.id]);
  const scenarios = await many(tx, `SELECT s.*, u.display_name AS recovery_owner_name, doc.title AS document_title, doc.doc_number AS document_number
    FROM continuity_scenario s JOIN app_user u ON u.id = s.recovery_owner_user_id LEFT JOIN document doc ON doc.id = s.document_id WHERE s.plan_id = $1 ORDER BY s.seq`, [p.id]);
  const contacts = await many(tx, 'SELECT * FROM continuity_contact WHERE plan_id = $1 ORDER BY seq', [p.id]);
  // All exercises of the plan, across revisions.
  const exercises = await many(tx, `SELECT e.*, p.revision, f.display_name AS facilitator_name, s.seq AS scenario_seq, s.scenario,
      (SELECT count(*)::int FROM action_item x WHERE x.continuity_exercise_id = e.id AND x.status <> 'cancelled') AS actions
    FROM continuity_exercise e JOIN continuity_plan p ON p.id = e.plan_id JOIN app_user f ON f.id = e.facilitator_user_id LEFT JOIN continuity_scenario s ON s.id = e.scenario_id
    WHERE p.tenant_id = $1 AND p.number = $2 ORDER BY coalesce(e.conducted_on, e.scheduled_on) DESC, e.created_at DESC`, [p.tenant_id, p.number]);
  const gaps: Gap[] = [];
  const now = today();

  for (const s of scenarios) {
    if (s.est_recovery_hours == null) gaps.push({ severity: 'watch', area: 'Scenarios', text: `Scenario ${s.seq} (${s.scenario}) has no recovery estimate to compare with the ${rto} h RTO` });
    else if (Number(s.est_recovery_hours) > rto) gaps.push({ severity: 'high', area: 'Scenarios', text: `Scenario ${s.seq} (${s.scenario}): estimated ${Number(s.est_recovery_hours)} h recovery exceeds the ${rto} h RTO` });
  }
  const skillIds = deps.filter((d) => d.qualification_id).map((d) => d.qualification_id);
  const holders = skillIds.length ? await many(tx, `SELECT g.qualification_id, e.first_name || ' ' || e.last_name AS name, g.expires_on
      FROM employee_qualification g JOIN employee e ON e.id = g.employee_id
      WHERE g.qualification_id = ANY ($1) AND g.revoked_at IS NULL AND (g.expires_on IS NULL OR g.expires_on >= current_date) AND e.status = 'active' AND e.facility_id = $2
        AND NOT EXISTS (SELECT 1 FROM employee_qualification n WHERE n.employee_id = g.employee_id AND n.qualification_id = g.qualification_id AND n.revoked_at IS NULL
                        AND coalesce(n.expires_on, 'infinity') > coalesce(g.expires_on, 'infinity'))`, [skillIds, p.facility_id]) : [];
  const supplierIds = deps.filter((d) => d.supplier_id).map((d) => d.supplier_id);
  const soleSource = supplierIds.length ? new Map((await many(tx, `SELECT sp.supplier_id, count(*)::int AS n FROM supplier_part sp
      WHERE sp.supplier_id = ANY ($1) AND NOT EXISTS (SELECT 1 FROM supplier_part o JOIN supplier os ON os.id = o.supplier_id WHERE o.part_id = sp.part_id AND o.supplier_id <> sp.supplier_id AND os.active)
      GROUP BY sp.supplier_id`, [supplierIds])).map((r) => [r.supplier_id as string, r.n as number])) : new Map<string, number>();

  const enriched = deps.map((d) => {
    let status: string | null = null;
    const label = d.asset_tag ?? d.supplier_name ?? d.qualification_name ?? d.employee_name ?? d.description;
    if (d.kind === 'asset') {
      status = d.operational_state.replace(/_/g, ' ');
      if (DOWN.includes(d.operational_state)) gaps.push({ severity: 'high', area: 'Dependencies', text: `${d.asset_tag} is ${status} now${d.workaround ? `; workaround: ${d.workaround}` : ' and there is no workaround'}` });
      else if (!d.workaround) gaps.push({ severity: 'watch', area: 'Dependencies', text: `No workaround recorded if ${d.asset_tag} fails` });
    }
    if (d.kind === 'skill') {
      const h = holders.filter((x) => x.qualification_id === d.qualification_id);
      const soon = h.filter((x) => x.expires_on && iso(x.expires_on)! <= addMonths(now, 2));
      status = `${h.length} current holder${h.length === 1 ? '' : 's'}${h.length ? `: ${h.map((x) => x.name).join(', ')}` : ''}`;
      if (h.length < d.min_holders) gaps.push({ severity: 'high', area: 'People', text: `Only ${h.length} current holder${h.length === 1 ? '' : 's'} of ${d.qualification_name} (the plan needs ${d.min_holders})` });
      else if (h.length - soon.length < d.min_holders) gaps.push({ severity: 'watch', area: 'People', text: `${d.qualification_name}: ${soon.length} of ${h.length} holders expire within 2 months` });
    }
    if (d.kind === 'person') {
      status = d.employee_status;
      if (d.employee_status !== 'active') gaps.push({ severity: 'high', area: 'People', text: `${d.employee_name} is ${d.employee_status}; the plan still depends on them` });
      else if (!d.workaround) gaps.push({ severity: 'high', area: 'People', text: `Single point of failure: ${d.employee_name}, with no cover arranged` });
    }
    if (d.kind === 'supplier') {
      const n = soleSource.get(d.supplier_id) ?? 0;
      status = d.supplier_active ? (n ? `sole source for ${n} part${n === 1 ? '' : 's'}` : 'active') : 'inactive';
      if (!d.supplier_active) gaps.push({ severity: 'high', area: 'Suppliers', text: `${d.supplier_name} is inactive; the plan still depends on them` });
      else if (n && !d.workaround) gaps.push({ severity: 'watch', area: 'Suppliers', text: `${d.supplier_name} is the only source for ${n} part${n === 1 ? '' : 's'} and no second source is noted` });
    }
    return { ...d, label, live_status: status };
  });

  if (!contacts.length) gaps.push({ severity: 'high', area: 'Contacts', text: 'No call list' });
  if (!p.alternate_user_id) gaps.push({ severity: 'watch', area: 'Ownership', text: 'No alternate owner' });

  const done = exercises.filter((e) => e.status === 'completed');
  const last = done[0] ?? null;
  const timed = done.filter((e) => TIMED.includes(e.kind) && e.achieved_recovery_hours != null);
  const demonstrated = timed.find((e) => Number(e.achieved_recovery_hours) <= rto) ?? null;
  const base = iso(last?.conducted_on) ?? iso(p.approved_at);
  const exerciseDue = base ? addMonths(base, p.exercise_interval_months) : null;
  if (p.status === 'approved' || p.status === 'superseded') {
    if (iso(p.review_due) && iso(p.review_due)! < now) gaps.push({ severity: 'watch', area: 'Review', text: `Review was due ${iso(p.review_due)}` });
    if (!done.length) gaps.push({ severity: p.criticality === 'critical' ? 'high' : 'watch', area: 'Exercises', text: 'Never exercised' });
    else if (exerciseDue && exerciseDue < now) gaps.push({ severity: 'watch', area: 'Exercises', text: `Exercise was due ${exerciseDue} (last ${iso(last!.conducted_on)})` });
    if (!demonstrated) gaps.push({ severity: 'watch', area: 'Exercises', text: timed.length ? `No timed exercise has recovered within the ${rto} h RTO` : `The ${rto} h RTO has not been demonstrated by a simulation or full test` });
    for (const e of done.filter((x) => x.outcome !== 'met' && !x.actions)) {
      gaps.push({ severity: 'high', area: 'Exercises', text: `${humanStatus(e.kind)} on ${iso(e.conducted_on)} ${e.outcome === 'not_met' ? 'did not meet' : 'partly met'} its objectives and has no action` });
    }
  }
  return { dependencies: enriched, scenarios, contacts, exercises, gaps,
    readiness: { lastExercise: iso(last?.conducted_on), lastOutcome: last?.outcome ?? null, exerciseDue, demonstratedHours: demonstrated ? Number(demonstrated.achieved_recovery_hours) : null,
      bestTimedHours: timed.length ? Math.min(...timed.map((e) => Number(e.achieved_recovery_hours))) : null } };
}

export async function getPlan(tx: Tx, actor: Actor, id: string) {
  const p = await one(tx, `SELECT p.*, f.code AS facility_code, o.display_name AS owner_name, a.display_name AS alternate_name
    FROM continuity_plan p JOIN facility f ON f.id = p.facility_id JOIN app_user o ON o.id = p.owner_user_id LEFT JOIN app_user a ON a.id = p.alternate_user_id WHERE p.id = $1`, [id]);
  if (!p) throw notFound('continuity plan');
  if (!viewer(actor, p)) throw forbidden('continuity.view');
  const assessed = await assessPlan(tx, p);
  const revisions = await many(tx, 'SELECT id, revision, status, approved_at, revision_reason FROM continuity_plan WHERE tenant_id = $1 AND number = $2 ORDER BY revision DESC', [p.tenant_id, p.number]);
  return { ...p, rto_hours: Number(p.rto_hours), rpo_hours: p.rpo_hours == null ? null : Number(p.rpo_hours), ...assessed, actions: await listActions(tx, PLAN, id), revisions,
    canEdit: editor(actor, p) };
}

/**
 * Choices for the plan editor (assets and people at the site, suppliers, qualifications, controlled documents).
 * Served here so a plan owner can reference them without holding purchasing or HR permissions.
 */
export async function editorOptions(tx: Tx, actor: Actor, id: string) {
  const p = await one(tx, 'SELECT * FROM continuity_plan WHERE id = $1', [id]);
  if (!p) throw notFound('continuity plan');
  if (!editor(actor, p)) throw forbidden('continuity.manage (or own the plan)');
  const [assets, suppliers, qualifications, employees, documents, users] = await Promise.all([
    many(tx, `SELECT id, asset_tag, name FROM asset WHERE facility_id = $1 AND lifecycle_status = 'active' ORDER BY asset_tag`, [p.facility_id]),
    many(tx, 'SELECT id, code, name FROM supplier WHERE active ORDER BY name'),
    many(tx, 'SELECT id, code, name FROM qualification WHERE active ORDER BY name'),
    many(tx, `SELECT id, employee_number, first_name || ' ' || last_name AS name FROM employee WHERE facility_id = $1 AND status = 'active' ORDER BY last_name, first_name`, [p.facility_id]),
    many(tx, `SELECT d.id, d.doc_number, d.title FROM document d WHERE (d.facility_id IS NULL OR d.facility_id = $1) AND NOT d.restricted ORDER BY d.doc_number`, [p.facility_id]),
    many(tx, `SELECT DISTINCT u.id, u.display_name FROM app_user u JOIN user_role_scope a ON a.user_id = u.id
      WHERE u.status = 'active' AND (a.facility_id IS NULL OR a.facility_id = $1) ORDER BY u.display_name`, [p.facility_id]),
  ]);
  return { assets, suppliers, qualifications, employees, documents, users };
}

export async function listPlans(tx: Tx, actor: Actor) {
  const rows = await many(tx, `SELECT p.*, f.code AS facility_code, o.display_name AS owner_name,
      (SELECT count(*)::int FROM action_item x WHERE x.subject_type = 'continuity_plan' AND x.subject_id = p.id AND x.status = 'open') AS open_actions
    FROM continuity_plan p JOIN facility f ON f.id = p.facility_id JOIN app_user o ON o.id = p.owner_user_id
    WHERE p.status <> 'superseded' ORDER BY CASE p.criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, p.number`);
  const visible = rows.filter((p) => viewer(actor, p));
  const out = [];
  for (const p of visible) {
    const a = await assessPlan(tx, p);
    out.push({ id: p.id, number: p.number, revision: p.revision, process: p.process, title: p.title, criticality: p.criticality, status: p.status, facility_code: p.facility_code,
      owner_name: p.owner_name, rto_hours: Number(p.rto_hours), rpo_hours: p.rpo_hours == null ? null : Number(p.rpo_hours), review_due: iso(p.review_due), open_actions: p.open_actions,
      high_gaps: a.gaps.filter((g) => g.severity === 'high').length, gaps: a.gaps.length, ...a.readiness });
  }
  return out;
}
