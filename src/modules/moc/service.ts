import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { approvalHistory, closePendingRequests, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit, auditHistory } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';
import type { Screening } from './screening.js';
import { PSSR_QUESTIONS, screen, SCREENING_RULES, ScreeningSchema } from './screening.js';

export const CHANGE_TYPES = ['equipment', 'process', 'procedure', 'material', 'controls_software', 'organizational', 'facility', 'other'] as const;
export const AFFECTED_TYPES = ['asset', 'document', 'course', 'qualification', 'part'] as const;
export const ACTION_KINDS = ['document_update', 'training', 'work_order', 'hazard_review', 'inspection', 'communication', 'restore', 'customer', 'consequence_review', 'other'] as const;
export const ORIGINS = ['planned', 'emergency', 'unintended'] as const;
export const CUSTOMER_IMPACTS = ['none', 'notify', 'approval'] as const;
const SUBJECT = 'moc_change';
registerApprovalSubject(SUBJECT, {
  link: (id) => `/changes/${id}`,
  describe: async (tx, id) => { const c = await one(tx, 'SELECT number, title FROM moc_change WHERE id = $1', [id]); return c ? `${c.number} ${c.title}` : 'change request'; },
  commentRequired: true,
});
const FINAL_AUTHORIZER = 'operations_manager';
const MAX_TEMPORARY_DAYS = 180;

type Affected = { entityType: (typeof AFFECTED_TYPES)[number]; entityId: string; note?: string | null };

export interface ChangeInput {
  facilityId: string;
  title: string;
  description: string;
  justification: string;
  changeType: (typeof CHANGE_TYPES)[number];
  isTemporary?: boolean;
  temporaryUntil?: string | null;
  targetDate?: string | null;
  ownerUserId?: string | null;
  affected?: Affected[];
  /** ISO 9001 (D-158): 8.1 planned, emergency or unintended; 6.3 a–d planning; 8.2.4 / 8.5.6 customers. */
  origin?: (typeof ORIGINS)[number];
  consequences?: string | null;
  qmsImpact?: string | null;
  resources?: string | null;
  responsibilities?: string | null;
  customerImpact?: (typeof CUSTOMER_IMPACTS)[number];
  customerNote?: string | null;
}

const txt = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
/** The planning ISO 9001 6.3 asks for, complete before review; customer impact explained (D-158). */
function checkPlanning(c: any) {
  const missing = [['consequences', 'the potential consequences of the change (6.3 a)'], ['qms_impact', 'what it changes in the quality management system: processes, documents, records (6.3 b)'],
    ['resources', 'the resources it needs and whether they are available (6.3 c)'], ['responsibilities', 'who is responsible and authorized, and any responsibilities that move (6.3 d)']]
    .filter(([k]) => !c[k!] || String(c[k!]).trim().length < 3).map(([, l]) => l);
  if (missing.length) throw invalid(`before review, describe ${missing.join('; ')}`, { missing });
  if (c.customer_impact !== 'none' && !c.customer_note?.trim()) throw invalid('say which customers are affected and what they must be told or approve');
}

const today = () => new Date().toISOString().slice(0, 10);

async function lockChange(tx: Tx, id: string) {
  const c = await one(tx, 'SELECT * FROM moc_change WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw notFound('change');
  return c;
}

function validateTemporary(isTemporary: boolean | undefined, until: string | null | undefined) {
  if (!isTemporary) return;
  if (!until) throw invalid('temporary changes need an end date');
  const days = (Date.parse(until) - Date.parse(today())) / 86_400_000;
  if (days <= 0) throw invalid('the temporary end date must be in the future');
  if (days > MAX_TEMPORARY_DAYS) throw invalid(`temporary changes may last at most ${MAX_TEMPORARY_DAYS} days; make it permanent instead`);
}

const AFFECTED_SQL: Record<string, string> = {
  asset: 'SELECT facility_id FROM asset WHERE id = $1',
  document: 'SELECT facility_id FROM document WHERE id = $1',
  course: 'SELECT facility_id FROM course WHERE id = $1',
  qualification: 'SELECT NULL::uuid AS facility_id FROM qualification WHERE id = $1',
  part: 'SELECT NULL::uuid AS facility_id FROM part WHERE id = $1',
};

async function writeAffected(tx: Tx, actor: Actor, changeId: string, facilityId: string, affected: Affected[]) {
  await tx.query('DELETE FROM moc_affected WHERE change_id = $1', [changeId]);
  for (const a of affected) {
    const row = await one(tx, AFFECTED_SQL[a.entityType]!, [a.entityId]);
    if (!row) throw invalid(`${a.entityType} ${a.entityId} not found`);
    if (row.facility_id && row.facility_id !== facilityId) throw invalid(`${a.entityType} belongs to another facility`);
    await tx.query('INSERT INTO moc_affected (tenant_id, change_id, entity_type, entity_id, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [actor.tenantId, changeId, a.entityType, a.entityId, a.note ?? null]);
  }
}

export async function createChange(tx: Tx, actor: Actor, input: ChangeInput) {
  requirePermission(actor, 'moc.request', input.facilityId);
  validateTemporary(input.isTemporary, input.temporaryUntil);
  const owner = input.ownerUserId ?? actor.userId;
  if (owner !== actor.userId && !(await one(tx, `SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [owner]))) throw invalid('owner not found');
  const number = `MOC-${String(await nextSequence(tx, actor.tenantId, 'moc')).padStart(6, '0')}`;
  const c = await one(
    tx,
    `INSERT INTO moc_change (tenant_id, facility_id, number, title, description, justification, change_type, is_temporary, temporary_until,
       target_date, requested_by, owner_user_id, origin, consequences, qms_impact, resources, responsibilities, customer_impact, customer_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
    [actor.tenantId, input.facilityId, number, input.title, input.description, input.justification, input.changeType, input.isTemporary ?? false,
      input.isTemporary ? input.temporaryUntil : null, input.targetDate ?? null, actor.userId, owner, input.origin ?? 'planned', txt(input.consequences), txt(input.qmsImpact),
      txt(input.resources), txt(input.responsibilities), input.customerImpact ?? 'none', input.customerImpact && input.customerImpact !== 'none' ? txt(input.customerNote) : null],
  );
  await writeAffected(tx, actor, c.id, input.facilityId, input.affected ?? []);
  await audit(tx, actor, { action: 'moc.created', entityType: SUBJECT, entityId: c.id, facilityId: c.facility_id, data: { number, title: c.title, changeType: c.change_type } });
  return c;
}

/**
 * Edits a change. In draft this is ordinary editing (requester or coordinator). Once submitted, any edit
 * is a MATERIAL CHANGE: the revision increments, approvals given so far are superseded, and the change
 * returns to draft for re-screening and re-approval. A reason is required and recorded.
 */
export async function reviseChange(tx: Tx, actor: Actor, id: string, patch: Partial<Omit<ChangeInput, 'facilityId'>>, reason?: string) {
  const c = await lockChange(tx, id);
  const draft = c.status === 'draft' || c.status === 'rejected';
  if (draft) {
    if (c.requested_by !== actor.userId) requirePermission(actor, 'moc.manage', c.facility_id);
    else requirePermission(actor, 'moc.request', c.facility_id);
  } else {
    if (!['review', 'approved', 'startup_review'].includes(c.status)) throw conflict(`a ${c.status} change cannot be revised`);
    requirePermission(actor, 'moc.manage', c.facility_id);
    if (!reason || reason.trim().length < 5) throw invalid('explain the material change (reason)');
  }
  const next = {
    title: patch.title ?? c.title, description: patch.description ?? c.description, justification: patch.justification ?? c.justification,
    change_type: patch.changeType ?? c.change_type, is_temporary: patch.isTemporary ?? c.is_temporary,
    temporary_until: patch.temporaryUntil !== undefined ? patch.temporaryUntil : c.temporary_until, target_date: patch.targetDate !== undefined ? patch.targetDate : c.target_date,
    owner_user_id: patch.ownerUserId ?? c.owner_user_id,
    origin: patch.origin ?? c.origin, consequences: patch.consequences !== undefined ? txt(patch.consequences) : c.consequences,
    qms_impact: patch.qmsImpact !== undefined ? txt(patch.qmsImpact) : c.qms_impact, resources: patch.resources !== undefined ? txt(patch.resources) : c.resources,
    responsibilities: patch.responsibilities !== undefined ? txt(patch.responsibilities) : c.responsibilities,
    customer_impact: patch.customerImpact ?? c.customer_impact, customer_note: patch.customerNote !== undefined ? txt(patch.customerNote) : c.customer_note,
  };
  validateTemporary(next.is_temporary, next.temporary_until);
  const revision = draft ? c.revision : c.revision + 1;
  await tx.query(
    `UPDATE moc_change SET title = $2, description = $3, justification = $4, change_type = $5, is_temporary = $6, temporary_until = $7,
       target_date = $8, owner_user_id = $9, revision = $10, status = 'draft', approved_at = CASE WHEN $11 THEN approved_at END,
       origin = $12, consequences = $13, qms_impact = $14, resources = $15, responsibilities = $16, customer_impact = $17, customer_note = $18 WHERE id = $1`,
    [id, next.title, next.description, next.justification, next.change_type, next.is_temporary, next.is_temporary ? next.temporary_until : null,
      next.target_date, next.owner_user_id, revision, draft, next.origin, next.consequences, next.qms_impact, next.resources, next.responsibilities,
      next.customer_impact, next.customer_impact === 'none' ? null : next.customer_note],
  );
  if (patch.affected) await writeAffected(tx, actor, id, c.facility_id, patch.affected);
  if (!draft) {
    await closePendingRequests(tx, actor, SUBJECT, id, 'superseded', reason!);
    await tx.query(`UPDATE moc_pssr_item SET response = NULL, responded_by = NULL, responded_at = NULL, note = NULL WHERE change_id = $1`, [id]);
  }
  await audit(tx, actor, { action: draft ? 'moc.edited' : 'moc.revised', entityType: SUBJECT, entityId: id, facilityId: c.facility_id,
    data: { revision, reason: reason ?? null, fields: Object.keys(patch) } });
  return one(tx, 'SELECT * FROM moc_change WHERE id = $1', [id]);
}

/** Screens the change, builds the action plan from the answers, and opens cross-functional review. */
export async function submitForReview(tx: Tx, actor: Actor, id: string, rawScreening: unknown) {
  const c = await lockChange(tx, id);
  if (c.status !== 'draft') throw conflict(`only draft changes can be submitted (this one is ${c.status})`);
  if (c.requested_by !== actor.userId && c.owner_user_id !== actor.userId) requirePermission(actor, 'moc.manage', c.facility_id);
  checkPlanning(c);
  const parsed = ScreeningSchema.safeParse(rawScreening);
  if (!parsed.success) throw invalid('answer every screening question with true or false', parsed.error.flatten());
  const s: Screening = parsed.data;
  const result = screen(c.change_type, s, c.is_temporary);
  await tx.query(
    `UPDATE moc_change SET status = 'review', screening = $2, screening_rules = $3, risk_level = $4, required_reviews = $5, pssr_required = $6 WHERE id = $1`,
    [id, s, SCREENING_RULES, result.riskLevel, result.reviews, result.pssrRequired],
  );
  await generateActions(tx, actor, { ...c, screening: s, pssr_required: result.pssrRequired, risk_level: result.riskLevel });
  await createApprovalRequest(tx, actor, {
    facilityId: c.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: c.revision, purpose: 'moc.authorize',
    stages: [
      { steps: result.reviews.filter((r) => r !== FINAL_AUTHORIZER).map((r) => ({ roleKey: r, label: REVIEW_LABELS[r] ?? r })) },
      { steps: [{ roleKey: FINAL_AUTHORIZER, label: 'Authorize the change' }] },
    ],
  });
  await audit(tx, actor, { action: 'moc.submitted', entityType: SUBJECT, entityId: id, facilityId: c.facility_id,
    data: { revision: c.revision, riskLevel: result.riskLevel, reviews: result.reviews, pssrRequired: result.pssrRequired, reasons: result.reasons } });
  return { ...result, status: 'review' };
}

export const REVIEW_LABELS: Record<string, string> = {
  ehs_reviewer: 'Safety & environmental review',
  quality_reviewer: 'Quality review',
  maintenance_manager: 'Maintenance & engineering review',
  operations_manager: 'Authorize the change',
};

/** Replaces open generated actions with the plan implied by the current screening and affected items. */
async function generateActions(tx: Tx, actor: Actor, c: any) {
  await tx.query(`UPDATE moc_action SET status = 'cancelled', completion_note = 'replaced after re-screening' WHERE change_id = $1 AND generated AND status = 'open'`, [c.id]);
  const affected = await many(tx, `SELECT a.entity_type, a.entity_id, d.doc_number, d.title AS doc_title, co.code AS course_code, co.title AS course_title
                                   FROM moc_affected a LEFT JOIN document d ON a.entity_type = 'document' AND d.id = a.entity_id
                                   LEFT JOIN course co ON a.entity_type = 'course' AND co.id = a.entity_id WHERE a.change_id = $1`, [c.id]);
  const s: Screening = c.screening;
  const plan: { kind: string; title: string; before: 'startup' | 'closeout'; document_id?: string; course_id?: string }[] = [];
  const docs = affected.filter((a) => a.entity_type === 'document');
  const courses = affected.filter((a) => a.entity_type === 'course');
  for (const d of docs) plan.push({ kind: 'document_update', title: `Revise and approve ${d.doc_number} ${d.doc_title}`, before: 'startup', document_id: d.entity_id });
  if (s.requires_procedure_change && !docs.length) plan.push({ kind: 'document_update', title: 'Write or revise the affected procedures', before: 'startup' });
  for (const co of courses) plan.push({ kind: 'training', title: `Update ${co.course_code} and train affected people`, before: 'startup', course_id: co.entity_id });
  if (s.requires_training && !courses.length) plan.push({ kind: 'training', title: 'Train affected employees before use', before: 'startup' });
  if (['equipment', 'controls_software', 'facility'].includes(c.change_type)) plan.push({ kind: 'work_order', title: 'Implement the change (link the work order)', before: 'startup' });
  if (c.risk_level === 'high') plan.push({ kind: 'hazard_review', title: 'Complete a hazard review (what-if, HAZOP or FMEA) and resolve findings', before: 'startup' });
  if (s.affects_safety_systems) plan.push({ kind: 'inspection', title: 'Function-test affected safety devices before startup', before: 'startup' });
  plan.push({ kind: 'communication', title: 'Brief affected shifts on the change', before: 'startup' });
  // ISO 9001 (D-158): customers told or asking for their approval before changed product reaches them (8.2.4, 8.5.6);
  // an emergency or unintended change has its consequences reviewed and adverse effects mitigated (8.1).
  if (c.customer_impact === 'approval') plan.push({ kind: 'customer', title: 'Obtain the customer’s approval before changed product ships; record who approved and when', before: 'startup' });
  if (c.customer_impact === 'notify') plan.push({ kind: 'customer', title: 'Notify the affected customers of the change; record who was told and when', before: 'startup' });
  if (c.origin !== 'planned') plan.push({ kind: 'consequence_review', title: `Review the consequences of this ${c.origin} change and act to mitigate any adverse effects`, before: 'closeout' });
  if (c.is_temporary) plan.push({ kind: 'restore', title: `Remove the temporary change and restore the original condition by ${c.temporary_until}`, before: 'closeout' });
  for (const p of plan) {
    await tx.query(
      `INSERT INTO moc_action (tenant_id, change_id, kind, title, required_before, owner_user_id, due_on, document_id, course_id, generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
      [actor.tenantId, c.id, p.kind, p.title, p.before, c.owner_user_id, p.kind === 'restore' ? c.temporary_until : c.target_date, p.document_id ?? null, p.course_id ?? null],
    );
  }
}

/** Applies an approval outcome to the change (called after the approval engine records a decision). */
export async function onApprovalDecided(tx: Tx, actor: Actor, changeId: string, purpose: string, requestStatus: string) {
  if (requestStatus === 'pending') return;
  const c = await lockChange(tx, changeId);
  if (purpose === 'moc.authorize' && c.status === 'review') {
    const status = requestStatus === 'approved' ? 'approved' : 'rejected';
    await tx.query(`UPDATE moc_change SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN now() END WHERE id = $1`, [changeId, status]);
    await audit(tx, actor, { action: `moc.${status}`, entityType: SUBJECT, entityId: changeId, facilityId: c.facility_id, data: { revision: c.revision } });
  }
  if (purpose === 'moc.startup' && c.status === 'startup_review') {
    const status = requestStatus === 'approved' ? 'in_service' : 'approved';
    await tx.query(`UPDATE moc_change SET status = $2, in_service_at = CASE WHEN $2 = 'in_service' THEN now() END WHERE id = $1`, [changeId, status]);
    await audit(tx, actor, { action: status === 'in_service' ? 'moc.started_up' : 'moc.startup_rejected', entityType: SUBJECT, entityId: changeId, facilityId: c.facility_id });
  }
}

export async function addAction(
  tx: Tx, actor: Actor, changeId: string,
  input: { kind: (typeof ACTION_KINDS)[number]; title: string; requiredBefore: 'startup' | 'closeout'; ownerUserId?: string | null; dueOn?: string | null;
    documentId?: string | null; courseId?: string | null; workOrderId?: string | null },
) {
  const c = await lockChange(tx, changeId);
  requirePermission(actor, 'moc.manage', c.facility_id);
  if (['closed', 'cancelled', 'rejected'].includes(c.status)) throw conflict(`change is ${c.status}`);
  if (input.workOrderId) await assertWorkOrderOnFacility(tx, input.workOrderId, c.facility_id);
  const a = await one(
    tx,
    `INSERT INTO moc_action (tenant_id, change_id, kind, title, required_before, owner_user_id, due_on, document_id, course_id, work_order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [actor.tenantId, changeId, input.kind, input.title, input.requiredBefore, input.ownerUserId ?? c.owner_user_id, input.dueOn ?? null,
      input.documentId ?? null, input.courseId ?? null, input.workOrderId ?? null],
  );
  await audit(tx, actor, { action: 'moc.action_added', entityType: SUBJECT, entityId: changeId, facilityId: c.facility_id, data: { actionId: a.id, kind: a.kind } });
  return a;
}

async function assertWorkOrderOnFacility(tx: Tx, workOrderId: string, facilityId: string) {
  const wo = await one(tx, 'SELECT facility_id FROM work_order WHERE id = $1', [workOrderId]);
  if (!wo) throw invalid('work order not found');
  if (wo.facility_id !== facilityId) throw invalid('work order belongs to another facility');
}

export async function linkActionWorkOrder(tx: Tx, actor: Actor, actionId: string, workOrderId: string) {
  const a = await one(tx, `SELECT a.*, c.facility_id FROM moc_action a JOIN moc_change c ON c.id = a.change_id WHERE a.id = $1 FOR UPDATE OF a`, [actionId]);
  if (!a) throw notFound('action');
  requirePermission(actor, 'moc.manage', a.facility_id);
  if (a.status !== 'open') throw conflict(`action is ${a.status}`);
  await assertWorkOrderOnFacility(tx, workOrderId, a.facility_id);
  await tx.query('UPDATE moc_action SET work_order_id = $2 WHERE id = $1', [actionId, workOrderId]);
  await audit(tx, actor, { action: 'moc.action_linked', entityType: SUBJECT, entityId: a.change_id, facilityId: a.facility_id, data: { actionId, workOrderId } });
}

/**
 * Completes an action. Where the platform holds the evidence it checks it instead of trusting a tick:
 * a document action needs an approved revision released after the change was authorized; a work-order
 * action needs the work order verified or closed; a training action needs a course version published
 * after authorization. Other actions need a written completion note.
 */
export async function completeAction(tx: Tx, actor: Actor, actionId: string, input: { note?: string | null }) {
  const a = await one(tx, `SELECT a.*, c.facility_id, c.status AS change_status, c.approved_at FROM moc_action a JOIN moc_change c ON c.id = a.change_id
                           WHERE a.id = $1 FOR UPDATE OF a`, [actionId]);
  if (!a) throw notFound('action');
  if (a.owner_user_id !== actor.userId) requirePermission(actor, 'moc.manage', a.facility_id);
  else requirePermission(actor, 'moc.view', a.facility_id);
  if (a.status !== 'open') throw conflict(`action is ${a.status}`);
  if (!['approved', 'startup_review', 'in_service'].includes(a.change_status)) throw conflict('actions are completed after the change is authorized');
  const verification: Record<string, unknown> = { checkedAt: new Date().toISOString() };
  if (a.kind === 'document_update' && a.document_id) {
    const d = await one(tx, `SELECT d.doc_number, v.version_label, v.approved_at FROM document d JOIN document_version v ON v.id = d.current_version_id WHERE d.id = $1`, [a.document_id]);
    if (!d || !(d.approved_at > a.approved_at)) {
      throw new AppError(422, 'not_verified', `no revision of the document has been approved since the change was authorized${d ? ` (current: ${d.version_label})` : ''}`);
    }
    Object.assign(verification, { document: d.doc_number, version: d.version_label, approvedAt: d.approved_at });
  } else if (a.kind === 'work_order' && a.work_order_id) {
    const wo = await one(tx, 'SELECT number, status FROM work_order WHERE id = $1', [a.work_order_id]);
    if (!['verified', 'closed'].includes(wo.status)) throw new AppError(422, 'not_verified', `work order ${wo.number} is ${wo.status}; it must be verified or closed`);
    Object.assign(verification, { workOrder: wo.number, status: wo.status });
  } else if (a.kind === 'training' && a.course_id) {
    const v = await one(tx, `SELECT v.id, v.version_no, v.published_at FROM course_version v WHERE v.course_id = $1 AND v.status = 'published'`, [a.course_id]);
    if (!v || !(v.published_at > a.approved_at)) throw new AppError(422, 'not_verified', 'publish an updated course version after the change was authorized, then assign it');
    const stats = await one(tx, `SELECT count(*)::int AS assigned, count(*) FILTER (WHERE status = 'completed')::int AS completed FROM enrollment WHERE course_version_id = $1 AND status <> 'cancelled'`, [v.id]);
    if (!stats.assigned) throw new AppError(422, 'not_verified', 'the updated course has not been assigned to anyone');
    Object.assign(verification, { courseVersion: v.version_no, ...stats });
  } else if (!input.note || input.note.trim().length < 10) {
    throw invalid('describe what was done (at least a sentence)');
  }
  await tx.query(`UPDATE moc_action SET status = 'done', completed_by = $2, completed_at = now(), completion_note = $3, verification = $4 WHERE id = $1`,
    [actionId, actor.userId, input.note ?? null, verification]);
  await audit(tx, actor, { action: 'moc.action_completed', entityType: SUBJECT, entityId: a.change_id, facilityId: a.facility_id, data: { actionId, kind: a.kind, verification } });
  return { actionId, verification };
}

export async function cancelAction(tx: Tx, actor: Actor, actionId: string, reason: string) {
  const a = await one(tx, `SELECT a.*, c.facility_id FROM moc_action a JOIN moc_change c ON c.id = a.change_id WHERE a.id = $1 FOR UPDATE OF a`, [actionId]);
  if (!a) throw notFound('action');
  requirePermission(actor, 'moc.manage', a.facility_id);
  if (a.status !== 'open') throw conflict(`action is ${a.status}`);
  if (a.kind === 'restore') throw invalid('the restore action of a temporary change cannot be cancelled; revise the change to make it permanent');
  if (!reason || reason.trim().length < 5) throw invalid('a reason is required');
  await tx.query(`UPDATE moc_action SET status = 'cancelled', completed_by = $2, completed_at = now(), completion_note = $3 WHERE id = $1`, [actionId, actor.userId, reason]);
  await audit(tx, actor, { action: 'moc.action_cancelled', entityType: SUBJECT, entityId: a.change_id, facilityId: a.facility_id, data: { actionId, reason } });
}

/**
 * Moves an authorized change toward service. All 'startup' actions must be done. When a pre-startup
 * safety review is required, the checklist opens; otherwise the coordinator puts the change in service.
 */
export async function requestStartup(tx: Tx, actor: Actor, id: string) {
  const c = await lockChange(tx, id);
  requirePermission(actor, 'moc.manage', c.facility_id);
  if (c.status !== 'approved') throw conflict(`change is ${c.status}; it must be authorized first`);
  const open = await many(tx, `SELECT title FROM moc_action WHERE change_id = $1 AND required_before = 'startup' AND status = 'open'`, [id]);
  if (open.length) throw new AppError(422, 'actions_open', `${open.length} startup action(s) still open: ${open.map((o) => o.title).join('; ')}`, { open });
  if (!c.pssr_required) {
    await tx.query(`UPDATE moc_change SET status = 'in_service', in_service_at = now() WHERE id = $1`, [id]);
    await audit(tx, actor, { action: 'moc.started_up', entityType: SUBJECT, entityId: id, facilityId: c.facility_id, data: { pssr: false } });
    return { status: 'in_service' };
  }
  const existing = await one(tx, 'SELECT count(*)::int AS n FROM moc_pssr_item WHERE change_id = $1', [id]);
  if (!existing.n) {
    for (const [i, q] of PSSR_QUESTIONS.entries()) {
      if (i === 6 && !c.is_temporary) continue;
      await tx.query('INSERT INTO moc_pssr_item (tenant_id, change_id, seq, question) VALUES ($1, $2, $3, $4)', [actor.tenantId, id, i + 1, q]);
    }
  }
  await tx.query(`UPDATE moc_change SET status = 'startup_review' WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'moc.pssr_opened', entityType: SUBJECT, entityId: id, facilityId: c.facility_id });
  return { status: 'startup_review' };
}

/**
 * Records pre-startup review answers. A "no" blocks startup until fixed; when every item is yes or n/a,
 * startup authorization goes to safety and operations for sign-off.
 */
export async function answerPssr(tx: Tx, actor: Actor, id: string, answers: { seq: number; response: 'yes' | 'no' | 'na'; note?: string | null }[]) {
  const c = await lockChange(tx, id);
  requirePermission(actor, 'moc.manage', c.facility_id);
  if (c.status !== 'startup_review') throw conflict('the pre-startup review is not open');
  for (const a of answers) {
    if (a.response !== 'yes' && !a.note?.trim()) throw invalid(`item ${a.seq}: explain a "${a.response}" answer`);
    const r = await one(tx, `UPDATE moc_pssr_item SET response = $3, note = $4, responded_by = $5, responded_at = now() WHERE change_id = $1 AND seq = $2 RETURNING id`,
      [id, a.seq, a.response, a.note ?? null, actor.userId]);
    if (!r) throw invalid(`no checklist item ${a.seq}`);
  }
  const items = await many(tx, 'SELECT seq, response FROM moc_pssr_item WHERE change_id = $1 ORDER BY seq', [id]);
  const blocking = items.filter((i) => i.response === 'no').map((i) => i.seq);
  const unanswered = items.filter((i) => !i.response).map((i) => i.seq);
  await audit(tx, actor, { action: 'moc.pssr_answered', entityType: SUBJECT, entityId: id, facilityId: c.facility_id, data: { answers, blocking, unanswered } });
  let startupApproval = false;
  if (!blocking.length && !unanswered.length) {
    const pending = await one(tx, `SELECT 1 FROM approval_request WHERE subject_type = $1 AND subject_id = $2 AND purpose = 'moc.startup' AND status = 'pending'`, [SUBJECT, id]);
    if (!pending) {
      await createApprovalRequest(tx, actor, { facilityId: c.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: c.revision, purpose: 'moc.startup',
        stages: [{ steps: [{ roleKey: 'ehs_reviewer', label: 'Pre-startup safety sign-off' }, { roleKey: FINAL_AUTHORIZER, label: 'Authorize startup' }] }] });
      startupApproval = true;
    }
  }
  return { blocking, unanswered, startupApprovalRequested: startupApproval };
}

/**
 * Closes a change in service once every action is done, with its verified outcome (ISO 9001 6.3 a, 9.1, D-158): did it
 * achieve its purpose, and the evidence. A change that did not is closed only with a note of what follows (a new
 * change, a corrective action).
 */
export async function closeChange(tx: Tx, actor: Actor, id: string, note: string, outcome?: { achieved: boolean; evidence: string }) {
  const c = await lockChange(tx, id);
  requirePermission(actor, 'moc.manage', c.facility_id);
  if (c.status !== 'in_service') throw conflict(`change is ${c.status}; only changes in service can be closed`);
  const open = await many(tx, `SELECT title FROM moc_action WHERE change_id = $1 AND status = 'open'`, [id]);
  if (open.length) throw new AppError(422, 'actions_open', `${open.length} action(s) still open: ${open.map((o) => o.title).join('; ')}`, { open });
  if (!note || note.trim().length < 10) throw invalid('summarize the outcome in the closure note');
  if (!outcome) throw invalid('say whether the change achieved its purpose, with the evidence');
  if (!outcome.evidence?.trim() || outcome.evidence.trim().length < 10) throw invalid('give the evidence that shows whether the change achieved its purpose');
  if (!outcome.achieved && !/(MOC-|CA-|NCR-|new change|corrective)/i.test(`${note} ${outcome.evidence}`)) throw invalid('a change that did not achieve its purpose needs a follow-up: name the new change or corrective action');
  await tx.query(`UPDATE moc_change SET status = 'closed', closed_at = now(), closure_note = $2, outcome_achieved = $3, effectiveness_note = $4 WHERE id = $1`,
    [id, note, outcome.achieved, outcome.evidence.trim()]);
  await audit(tx, actor, { action: 'moc.closed', entityType: SUBJECT, entityId: id, facilityId: c.facility_id, data: { note, outcomeAchieved: outcome.achieved, evidence: outcome.evidence.trim() } });
}

/** A link to the justification deck kept elsewhere (SharePoint, OneDrive, Google Slides), while the change is a draft (D-159). */
export async function setJustificationLink(tx: Tx, actor: Actor, id: string, url: string | null) {
  const c = await lockChange(tx, id);
  if (c.requested_by !== actor.userId && c.owner_user_id !== actor.userId) requirePermission(actor, 'moc.manage', c.facility_id);
  if (!['draft', 'rejected'].includes(c.status)) throw invalid('the presentation can be changed only while the change is a draft; revise the change first');
  const link = url?.trim() || null;
  if (link && !/^https:\/\/\S+$/.test(link)) throw invalid('link to the presentation with an https:// address');
  await tx.query('UPDATE moc_change SET justification_link = $2 WHERE id = $1', [id, link]);
  await audit(tx, actor, { action: 'moc.presentation_linked', entityType: SUBJECT, entityId: id, facilityId: c.facility_id, data: { from: c.justification_link, to: link } });
}

export async function cancelChange(tx: Tx, actor: Actor, id: string, reason: string) {
  const c = await lockChange(tx, id);
  if (c.requested_by !== actor.userId) requirePermission(actor, 'moc.manage', c.facility_id);
  if (['in_service', 'closed', 'cancelled'].includes(c.status)) throw conflict(`a ${c.status} change cannot be cancelled${c.status === 'in_service' ? '; reverse it with a new change' : ''}`);
  if (!reason || reason.trim().length < 5) throw invalid('a reason is required');
  await closePendingRequests(tx, actor, SUBJECT, id, 'cancelled', reason);
  await tx.query(`UPDATE moc_change SET status = 'cancelled', closure_note = $2, closed_at = now() WHERE id = $1`, [id, reason]);
  await audit(tx, actor, { action: 'moc.cancelled', entityType: SUBJECT, entityId: id, facilityId: c.facility_id, data: { reason } });
}

export async function getChange(tx: Tx, actor: Actor, id: string) {
  const c = await one(
    tx,
    `SELECT c.*, f.code AS facility_code, ru.display_name AS requested_by_name, ou.display_name AS owner_name
     FROM moc_change c JOIN facility f ON f.id = c.facility_id JOIN app_user ru ON ru.id = c.requested_by JOIN app_user ou ON ou.id = c.owner_user_id WHERE c.id = $1`,
    [id],
  );
  if (!c) throw notFound('change');
  requirePermission(actor, 'moc.view', c.facility_id);
  const affected = await many(
    tx,
    `SELECT a.entity_type, a.entity_id, a.note,
            coalesce(ast.asset_tag || ' ' || ast.name, d.doc_number || ' ' || d.title, co.code || ' ' || co.title, q.code || ' ' || q.name, p.part_number || ' ' || p.description) AS label
     FROM moc_affected a
     LEFT JOIN asset ast ON a.entity_type = 'asset' AND ast.id = a.entity_id LEFT JOIN document d ON a.entity_type = 'document' AND d.id = a.entity_id
     LEFT JOIN course co ON a.entity_type = 'course' AND co.id = a.entity_id LEFT JOIN qualification q ON a.entity_type = 'qualification' AND q.id = a.entity_id
     LEFT JOIN part p ON a.entity_type = 'part' AND p.id = a.entity_id
     WHERE a.change_id = $1 ORDER BY a.entity_type, label`,
    [id],
  );
  const actions = await many(tx, `SELECT a.*, u.display_name AS owner_name, w.number AS work_order_number, (a.status = 'open' AND a.due_on < current_date) AS overdue
                                  FROM moc_action a LEFT JOIN app_user u ON u.id = a.owner_user_id LEFT JOIN work_order w ON w.id = a.work_order_id
                                  WHERE a.change_id = $1 ORDER BY a.required_before DESC, a.created_at`, [id]);
  const pssr = await many(tx, `SELECT p.seq, p.question, p.response, p.note, p.responded_at, u.display_name AS responded_by FROM moc_pssr_item p
                               LEFT JOIN app_user u ON u.id = p.responded_by WHERE p.change_id = $1 ORDER BY p.seq`, [id]);
  // The justification deck (D-159): every version uploaded, newest first; the first is the current one.
  const presentations = await many(tx, `SELECT x.id, x.file_name, x.mime, x.size_bytes, x.created_at, u.display_name AS uploaded_by_name FROM attachment x JOIN app_user u ON u.id = x.uploaded_by
    WHERE x.subject_type = 'moc_change' AND x.subject_id = $1 AND x.purpose = 'justification_presentation' ORDER BY x.created_at DESC`, [id]);
  const canEditDeck = ['draft', 'rejected'].includes(c.status) && (c.requested_by === actor.userId || c.owner_user_id === actor.userId || can(actor, 'moc.manage', c.facility_id));
  return { ...c, affected, actions, pssr, presentations, canEditDeck, approvals: await approvalHistory(tx, SUBJECT, id), history: await auditHistory(tx, SUBJECT, id) };
}

export async function listChanges(tx: Tx, actor: Actor, q: { facilityId?: string; status?: string[]; openOnly?: boolean; entityType?: string; entityId?: string }) {
  requirePermission(actor, 'moc.view', q.facilityId);
  const rows = await many(
    tx,
    `SELECT c.id, c.number, c.facility_id, f.code AS facility_code, c.title, c.change_type, c.status, c.risk_level, c.is_temporary, c.temporary_until,
            c.revision, c.target_date, c.created_at, ou.display_name AS owner,
            (SELECT count(*)::int FROM moc_action a WHERE a.change_id = c.id AND a.status = 'open') AS open_actions,
            (SELECT count(*)::int FROM moc_action a WHERE a.change_id = c.id AND a.status = 'open' AND a.due_on < current_date) AS overdue_actions
     FROM moc_change c JOIN facility f ON f.id = c.facility_id JOIN app_user ou ON ou.id = c.owner_user_id
     WHERE ($1::uuid IS NULL OR c.facility_id = $1) AND ($2::text[] IS NULL OR c.status = ANY ($2))
       AND (NOT $3 OR c.status NOT IN ('closed', 'cancelled', 'rejected'))
       AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM moc_affected a WHERE a.change_id = c.id AND a.entity_type = $4 AND a.entity_id = $5))
     ORDER BY c.created_at DESC`,
    [q.facilityId ?? null, q.status ?? null, q.openOnly ?? false, q.entityType ?? null, q.entityId ?? null],
  );
  return rows.filter((r) => can(actor, 'moc.view', r.facility_id));
}
