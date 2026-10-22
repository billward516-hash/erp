import type { Actor } from '../auth/actor.js';
import { hasRole } from '../auth/actor.js';
import { audit } from '../audit/audit.js';
import type { Tx } from '../db/tx.js';
import { many, one } from '../db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { notify, usersWithRole } from '../notify/notify.js';

/**
 * Subject modules register how their records read in notifications (label and in-app link), so the
 * engine can tell approvers what is waiting without knowing each module's tables.
 */
export interface ApprovalSubject { link: (id: string) => string; describe: (tx: Tx, id: string) => Promise<string> }
const SUBJECTS = new Map<string, ApprovalSubject>();
export function registerApprovalSubject(type: string, s: ApprovalSubject) { SUBJECTS.set(type, s); }

/** How a subject reads in notices and queues: its registered label and in-app link. */
export async function subjectNotice(tx: Tx, type: string, id: string) {
  const s = SUBJECTS.get(type);
  return { label: s ? await s.describe(tx, id) : type, link: s?.link(id) ?? '/approvals' };
}

/** "Waiting for your sign-off" notices close themselves once their step is no longer pending (signed by anyone, skipped, superseded). */
async function closeStepNotices(tx: Tx, requestId: string) {
  await tx.query(`UPDATE notification SET read_at = now() WHERE read_at IS NULL AND dedupe_key IN
    (SELECT 'approval:' || id FROM approval_step WHERE request_id = $1 AND status <> 'pending')`, [requestId]);
}

/** Tells everyone who can sign the request's current stage that it is waiting for them. */
async function notifyCurrentStage(tx: Tx, actor: Actor, requestId: string) {
  const r = await one(tx, 'SELECT * FROM approval_request WHERE id = $1', [requestId]);
  const stage = await currentStage(tx, requestId);
  if (!r || stage === null) return;
  const steps = await many(tx, `SELECT id, role_key, label, assignee_user_id FROM approval_step WHERE request_id = $1 AND stage = $2 AND status = 'pending'`, [requestId, stage]);
  const signed = new Set((await many(tx, `SELECT decided_by, on_behalf_of FROM approval_step WHERE request_id = $1 AND decided_by IS NOT NULL`, [requestId]))
    .flatMap((x) => [x.decided_by, x.on_behalf_of]).filter(Boolean));
  const { label } = await subjectNotice(tx, r.subject_type, r.subject_id);
  for (const st of steps) {
    const candidates = await stepCandidates(tx, st, r.facility_id);
    let users = candidates.filter((u) => u !== r.requested_by && !(r.distinct_approvers && signed.has(u)));
    if (!users.length && candidates.includes(r.requested_by) && (await soleApprover(tx, r.requested_by, candidates))) users = [r.requested_by];
    await notify(tx, actor.tenantId, users, { kind: 'approval.waiting', title: `Waiting for your sign-off: ${label}`, body: st.label, link: '/approvals',
      subjectType: r.subject_type, subjectId: r.subject_id, dedupeKey: `approval:${st.id}` }, actor.userId);
  }
}

/**
 * Shared approval engine. A request belongs to any subject (MOC, purchase request, document…) and is
 * made of stages: stages run in order, the steps inside a stage run in parallel. Each step is
 * addressed to a ROLE at the subject's facility (or held at corporate scope).
 *
 * Built-in controls: the requester never approves their own request; with distinctApprovers one
 * person signs at most one step; a rejection ends the request; a material change to the subject
 * supersedes it (callers then raise a new request against the new revision).
 * Delegation: while an approval_delegation is active, the delegate may sign steps addressed to roles the
 * delegator holds; the step records on_behalf_of. Separation-of-duties checks apply to both people.
 * Not yet: time-based escalation.
 */
export interface StageInput { steps: { roleKey: string; label: string; /** Addressed to this person (and their active delegate) instead of the role. */ assigneeUserId?: string | null }[] }

export async function createApprovalRequest(
  tx: Tx, actor: Actor,
  input: { facilityId: string | null; subjectType: string; subjectId: string; subjectRevision: number; purpose: string; stages: StageInput[]; distinctApprovers?: boolean },
) {
  const stages = input.stages.filter((s) => s.steps.length);
  if (!stages.length) throw invalid('an approval request needs at least one step');
  const open = await one(tx, `SELECT id FROM approval_request WHERE subject_type = $1 AND subject_id = $2 AND purpose = $3 AND status = 'pending'`,
    [input.subjectType, input.subjectId, input.purpose]);
  if (open) throw conflict('an approval request for this subject is already pending');
  const req = await one(
    tx,
    `INSERT INTO approval_request (tenant_id, facility_id, subject_type, subject_id, subject_revision, purpose, requested_by, distinct_approvers)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [actor.tenantId, input.facilityId, input.subjectType, input.subjectId, input.subjectRevision, input.purpose, actor.userId, input.distinctApprovers ?? true],
  );
  for (const [i, s] of stages.entries()) {
    for (const step of s.steps) {
      await tx.query(`INSERT INTO approval_step (tenant_id, request_id, stage, role_key, label, assignee_user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [actor.tenantId, req.id, i + 1, step.roleKey, step.label, step.assigneeUserId ?? null]);
    }
  }
  await audit(tx, actor, { action: 'approval.requested', entityType: input.subjectType, entityId: input.subjectId, facilityId: input.facilityId,
    data: { requestId: req.id, purpose: input.purpose, revision: input.subjectRevision, stages: stages.map((s) => s.steps.map((x) => x.roleKey)) } });
  await notifyCurrentStage(tx, actor, req.id);
  return req;
}

/** Lowest stage that still has pending steps (the only stage that can be decided). */
async function currentStage(tx: Tx, requestId: string): Promise<number | null> {
  const r = await one<{ s: number | null }>(tx, `SELECT min(stage) AS s FROM approval_step WHERE request_id = $1 AND status = 'pending'`, [requestId]);
  return r?.s ?? null;
}

export interface DelegatedRole { delegatorId: string; delegatorName: string; roleKey: string; facilityId: string | null }

/** Roles the user may exercise today on someone else's behalf. */
export async function delegatedRoles(tx: Tx, userId: string): Promise<DelegatedRole[]> {
  const rows = await many(tx, `SELECT d.delegator_user_id, u.display_name, r.key, a.facility_id
      FROM approval_delegation d JOIN app_user u ON u.id = d.delegator_user_id
      JOIN user_role_scope a ON a.user_id = d.delegator_user_id JOIN role r ON r.id = a.role_id
      WHERE d.delegate_user_id = $1 AND d.revoked_at IS NULL AND current_date BETWEEN d.starts_on AND d.ends_on AND u.status = 'active'`, [userId]);
  return rows.map((r) => ({ delegatorId: r.delegator_user_id, delegatorName: r.display_name, roleKey: r.key, facilityId: r.facility_id }));
}
const coveredBy = (d: DelegatedRole[], roleKey: string, facilityId: string | null) =>
  d.find((x) => x.roleKey === roleKey && (x.facilityId === null || x.facilityId === facilityId));

/**
 * Single-person approval (D-138): in a company where the requester is the only person who could sign (a sole owner),
 * and the licence allows it, they may approve their own request; the audit records it as self-approved. Separation of
 * duties applies whenever someone else could sign.
 */
export async function soleApprover(tx: Tx, requesterId: string, candidates: string[]) {
  const s = await one(tx, 'SELECT single_person_approval FROM tenant_edition()');
  return !!s?.single_person_approval && candidates.every((u) => u === requesterId);
}
const stepCandidates = async (tx: Tx, s: { assignee_user_id: string | null; role_key: string }, facilityId: string | null) =>
  (s.assignee_user_id ? [s.assignee_user_id, ...(await delegatesOf(tx, s.assignee_user_id))] : await usersWithRole(tx, s.role_key, facilityId));

/** People who may currently sign for this person (active delegations). */
async function delegatesOf(tx: Tx, userId: string) {
  return (await many(tx, `SELECT delegate_user_id FROM approval_delegation WHERE delegator_user_id = $1 AND revoked_at IS NULL AND current_date BETWEEN starts_on AND ends_on`, [userId]))
    .map((r) => r.delegate_user_id as string);
}

/** A step addressed to a person: they sign it, or their active delegate on their behalf. */
async function personalStep(tx: Tx, actor: Actor, assigneeId: string): Promise<{ ok: boolean; onBehalfOf?: DelegatedRole }> {
  if (assigneeId === actor.userId) return { ok: true };
  const d = await one(tx, `SELECT d.delegator_user_id, u.display_name FROM approval_delegation d JOIN app_user u ON u.id = d.delegator_user_id
    WHERE d.delegator_user_id = $1 AND d.delegate_user_id = $2 AND d.revoked_at IS NULL AND current_date BETWEEN d.starts_on AND d.ends_on AND u.status = 'active'`, [assigneeId, actor.userId]);
  return d ? { ok: true, onBehalfOf: { delegatorId: d.delegator_user_id, delegatorName: d.display_name, roleKey: '', facilityId: null } } : { ok: false };
}

export async function decideStep(tx: Tx, actor: Actor, stepId: string, input: { decision: 'approve' | 'reject'; comment?: string | null }) {
  const step = await one(tx, `SELECT s.*, r.status AS request_status, r.requested_by, r.facility_id, r.subject_type, r.subject_id, r.distinct_approvers, r.purpose
                              FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE s.id = $1 FOR UPDATE OF r`, [stepId]);
  if (!step) throw notFound('approval step');
  if (step.request_status !== 'pending') throw conflict(`approval request is ${step.request_status}`);
  if (step.status !== 'pending') throw conflict('this step is already decided');
  let onBehalfOf: DelegatedRole | undefined;
  if (step.assignee_user_id) {
    const p = await personalStep(tx, actor, step.assignee_user_id);
    if (!p.ok) throw forbidden(`this step is for ${(await one(tx, 'SELECT display_name FROM app_user WHERE id = $1', [step.assignee_user_id]))?.display_name ?? 'someone else'}`);
    onBehalfOf = p.onBehalfOf;
  } else if (!hasRole(actor, step.role_key, step.facility_id)) {
    onBehalfOf = coveredBy(await delegatedRoles(tx, actor.userId), step.role_key, step.facility_id);
    if (!onBehalfOf) throw forbidden(`role ${step.role_key}`);
  }
  let selfApproved = false;
  if (step.requested_by === actor.userId) {
    if (!(await soleApprover(tx, actor.userId, await stepCandidates(tx, step, step.facility_id)))) throw invalid('you cannot approve a request you raised');
    selfApproved = true;
  }
  if (onBehalfOf && step.requested_by === onBehalfOf.delegatorId) throw invalid(`${onBehalfOf.delegatorName} raised this request, so it cannot be approved on their behalf`);
  if (step.distinct_approvers) {
    const people = [actor.userId, ...(onBehalfOf ? [onBehalfOf.delegatorId] : [])];
    const signed = await one(tx, `SELECT 1 FROM approval_step WHERE request_id = $1 AND (decided_by = ANY ($2) OR on_behalf_of = ANY ($2))`, [step.request_id, people]);
    if (signed) throw invalid('you have already signed another step of this request; a different person must sign this one');
  }
  if ((await currentStage(tx, step.request_id)) !== step.stage) throw conflict('earlier approval stages are not complete yet');
  if (input.decision === 'reject' && !input.comment?.trim()) throw invalid('a rejection needs a comment explaining why');
  await tx.query(`UPDATE approval_step SET status = $2, decided_by = $3, decided_at = now(), comment = $4, on_behalf_of = $5 WHERE id = $1`,
    [stepId, input.decision === 'approve' ? 'approved' : 'rejected', actor.userId, input.comment ?? null, onBehalfOf?.delegatorId ?? null]);
  let requestStatus = 'pending';
  if (input.decision === 'reject') {
    requestStatus = 'rejected';
    await tx.query(`UPDATE approval_step SET status = 'skipped' WHERE request_id = $1 AND status = 'pending'`, [step.request_id]);
  } else if ((await currentStage(tx, step.request_id)) === null) {
    requestStatus = 'approved';
  }
  await closeStepNotices(tx, step.request_id);
  if (requestStatus !== 'pending') {
    await tx.query(`UPDATE approval_request SET status = $2, decided_at = now() WHERE id = $1`, [step.request_id, requestStatus]);
    const { label, link } = await subjectNotice(tx, step.subject_type, step.subject_id);
    await notify(tx, actor.tenantId, [step.requested_by], { kind: 'approval.decided', title: `${requestStatus === 'approved' ? 'Approved' : 'Rejected'}: ${label}`,
      body: input.decision === 'reject' ? `${step.label}: ${input.comment}` : null, link, subjectType: step.subject_type, subjectId: step.subject_id,
      dedupeKey: `approval-decided:${step.request_id}` }, actor.userId);
  } else if ((await currentStage(tx, step.request_id)) !== step.stage) {
    await notifyCurrentStage(tx, actor, step.request_id);
  }
  await audit(tx, actor, { action: `approval.${input.decision === 'approve' ? 'approved' : 'rejected'}`, entityType: step.subject_type, entityId: step.subject_id,
    facilityId: step.facility_id, data: { requestId: step.request_id, stepId, role: step.role_key, stage: step.stage, comment: input.comment ?? null, requestStatus, onBehalfOf: onBehalfOf?.delegatorId ?? null,
      ...(selfApproved ? { selfApproved: true, reason: 'single-person approval: nobody else could sign' } : {}) } });
  return { requestId: step.request_id as string, subjectType: step.subject_type as string, subjectId: step.subject_id as string, purpose: step.purpose as string, requestStatus };
}

/** Ends pending requests for a subject (material change or cancellation). Decided steps stay on record. */
export async function closePendingRequests(tx: Tx, actor: Actor, subjectType: string, subjectId: string, status: 'superseded' | 'cancelled', reason: string) {
  // Superseding also voids an approval already given: it applied to the previous revision.
  const from = status === 'superseded' ? ['pending', 'approved'] : ['pending'];
  const reqs = await many(tx, `UPDATE approval_request SET status = $3, decided_at = now()
                               WHERE subject_type = $1 AND subject_id = $2 AND status = ANY ($4) RETURNING id`, [subjectType, subjectId, status, from]);
  for (const r of reqs) {
    await tx.query(`UPDATE approval_step SET status = 'skipped' WHERE request_id = $1 AND status = 'pending'`, [r.id]);
    await closeStepNotices(tx, r.id);
    await audit(tx, actor, { action: `approval.${status}`, entityType: subjectType, entityId: subjectId, data: { requestId: r.id, reason } });
  }
  return reqs.length;
}

export async function approvalHistory(tx: Tx, subjectType: string, subjectId: string) {
  const reqs = await many(tx, `SELECT r.id, r.purpose, r.subject_revision, r.status, r.created_at, r.decided_at, u.display_name AS requested_by
                               FROM approval_request r JOIN app_user u ON u.id = r.requested_by
                               WHERE r.subject_type = $1 AND r.subject_id = $2 ORDER BY r.created_at`, [subjectType, subjectId]);
  for (const r of reqs) {
    r.steps = await many(tx, `SELECT s.id, s.stage, s.role_key, s.label, s.status, s.decided_at, s.comment, u.display_name AS decided_by, ob.display_name AS on_behalf_of,
                                     s.assignee_user_id, au.display_name AS assignee_name
                              FROM approval_step s LEFT JOIN app_user u ON u.id = s.decided_by LEFT JOIN app_user ob ON ob.id = s.on_behalf_of LEFT JOIN app_user au ON au.id = s.assignee_user_id
                              WHERE s.request_id = $1 ORDER BY s.stage, s.label`, [r.id]);
  }
  return reqs;
}

/** Steps the actor can decide right now (current stage, role held or delegated at the subject's facility, not self-raised). */
export async function myApprovalQueue(tx: Tx, actor: Actor) {
  const rows = await many(
    tx,
    `SELECT s.id AS step_id, s.label, s.role_key, s.stage, s.assignee_user_id, r.id AS request_id, r.subject_type, r.subject_id, r.purpose, r.facility_id, r.created_at, r.requested_by, r.distinct_approvers,
            (SELECT array_agg(x.decided_by) || array_agg(x.on_behalf_of) FROM approval_step x WHERE x.request_id = r.id AND x.decided_by IS NOT NULL) AS signers
     FROM approval_step s JOIN approval_request r ON r.id = s.request_id
     WHERE r.status = 'pending' AND s.status = 'pending'
       AND s.stage = (SELECT min(stage) FROM approval_step p WHERE p.request_id = r.id AND p.status = 'pending')
     ORDER BY r.created_at`,
  );
  const delegated = await delegatedRoles(tx, actor.userId);
  const forPeople = new Map(delegated.map((x) => [x.delegatorId, x]));
  const out = [];
  for (const r of rows) {
    if (r.requested_by === actor.userId && !(await soleApprover(tx, actor.userId, await stepCandidates(tx, r, r.facility_id)))) continue;
    const signers: (string | null)[] = r.signers ?? [];
    const own = r.assignee_user_id ? r.assignee_user_id === actor.userId : hasRole(actor, r.role_key, r.facility_id);
    const d = own ? undefined : r.assignee_user_id ? forPeople.get(r.assignee_user_id) : coveredBy(delegated, r.role_key, r.facility_id);
    if (!own && (!d || d.delegatorId === r.requested_by)) continue;
    if (r.distinct_approvers && (signers.includes(actor.userId) || (d && signers.includes(d.delegatorId)))) continue;
    out.push({ ...r, on_behalf_of: d ? { id: d.delegatorId, name: d.delegatorName } : null });
  }
  return out;
}

export async function createDelegation(tx: Tx, actor: Actor, input: { delegatorUserId?: string; delegateUserId: string; startsOn: string; endsOn: string; reason: string }) {
  const delegator = input.delegatorUserId ?? actor.userId;
  if (delegator !== actor.userId && !actor.grants.some((g) => g.facilityId === null && g.permissions.has('tenant.admin'))) {
    throw forbidden('only an administrator can delegate on behalf of someone else');
  }
  if (delegator === input.delegateUserId) throw invalid('choose someone other than the person delegating');
  if (input.endsOn < input.startsOn) throw invalid('the end date is before the start date');
  if (!input.reason?.trim()) throw invalid('a reason is required (e.g. vacation)');
  const delegate = await one(tx, `SELECT id, status FROM app_user WHERE id = $1`, [input.delegateUserId]);
  if (!delegate || delegate.status !== 'active') throw invalid('delegate not found or inactive');
  const d = await one(tx, `INSERT INTO approval_delegation (tenant_id, delegator_user_id, delegate_user_id, starts_on, ends_on, reason, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [actor.tenantId, delegator, input.delegateUserId, input.startsOn, input.endsOn, input.reason, actor.userId]);
  await audit(tx, actor, { action: 'approval.delegated', entityType: 'app_user', entityId: delegator, data: { delegationId: d.id, delegate: input.delegateUserId, startsOn: input.startsOn, endsOn: input.endsOn } });
  return d;
}

export async function revokeDelegation(tx: Tx, actor: Actor, id: string) {
  const d = await one(tx, `SELECT * FROM approval_delegation WHERE id = $1 FOR UPDATE`, [id]);
  if (!d) throw notFound('delegation');
  const admin = actor.grants.some((g) => g.facilityId === null && g.permissions.has('tenant.admin'));
  if (d.delegator_user_id !== actor.userId && !admin) throw forbidden('only the delegator or an administrator can end a delegation');
  if (d.revoked_at) return;
  await tx.query(`UPDATE approval_delegation SET revoked_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'approval.delegation_revoked', entityType: 'app_user', entityId: d.delegator_user_id, data: { delegationId: id } });
}

export async function listDelegations(tx: Tx, actor: Actor) {
  return many(tx, `SELECT d.id, d.starts_on, d.ends_on, d.reason, d.revoked_at, d.delegator_user_id, a.display_name AS delegator, d.delegate_user_id, b.display_name AS delegate,
      (d.revoked_at IS NULL AND current_date BETWEEN d.starts_on AND d.ends_on) AS active
    FROM approval_delegation d JOIN app_user a ON a.id = d.delegator_user_id JOIN app_user b ON b.id = d.delegate_user_id
    WHERE d.delegator_user_id = $1 OR d.delegate_user_id = $1 OR $2 ORDER BY d.starts_on DESC`,
    [actor.userId, actor.grants.some((g) => g.facilityId === null && g.permissions.has('tenant.admin'))]);
}
