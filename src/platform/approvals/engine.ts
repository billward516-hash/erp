import type { Actor } from '../auth/actor.js';
import { hasRole } from '../auth/actor.js';
import { audit } from '../audit/audit.js';
import type { Tx } from '../db/tx.js';
import { many, one } from '../db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';

/**
 * Shared approval engine. A request belongs to any subject (MOC, purchase request, document…) and is
 * made of stages: stages run in order, the steps inside a stage run in parallel. Each step is
 * addressed to a ROLE at the subject's facility (or held at corporate scope).
 *
 * Built-in controls: the requester never approves their own request; with distinctApprovers one
 * person signs at most one step; a rejection ends the request; a material change to the subject
 * supersedes it (callers then raise a new request against the new revision).
 * Not yet: delegation, time-based escalation, amount thresholds (arrive with purchasing).
 */
export interface StageInput { steps: { roleKey: string; label: string }[] }

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
      await tx.query(`INSERT INTO approval_step (tenant_id, request_id, stage, role_key, label) VALUES ($1, $2, $3, $4, $5)`,
        [actor.tenantId, req.id, i + 1, step.roleKey, step.label]);
    }
  }
  await audit(tx, actor, { action: 'approval.requested', entityType: input.subjectType, entityId: input.subjectId, facilityId: input.facilityId,
    data: { requestId: req.id, purpose: input.purpose, revision: input.subjectRevision, stages: stages.map((s) => s.steps.map((x) => x.roleKey)) } });
  return req;
}

/** Lowest stage that still has pending steps (the only stage that can be decided). */
async function currentStage(tx: Tx, requestId: string): Promise<number | null> {
  const r = await one<{ s: number | null }>(tx, `SELECT min(stage) AS s FROM approval_step WHERE request_id = $1 AND status = 'pending'`, [requestId]);
  return r?.s ?? null;
}

export async function decideStep(tx: Tx, actor: Actor, stepId: string, input: { decision: 'approve' | 'reject'; comment?: string | null }) {
  const step = await one(tx, `SELECT s.*, r.status AS request_status, r.requested_by, r.facility_id, r.subject_type, r.subject_id, r.distinct_approvers, r.purpose
                              FROM approval_step s JOIN approval_request r ON r.id = s.request_id WHERE s.id = $1 FOR UPDATE OF r`, [stepId]);
  if (!step) throw notFound('approval step');
  if (step.request_status !== 'pending') throw conflict(`approval request is ${step.request_status}`);
  if (step.status !== 'pending') throw conflict('this step is already decided');
  if (!hasRole(actor, step.role_key, step.facility_id)) throw forbidden(`role ${step.role_key}`);
  if (step.requested_by === actor.userId) throw invalid('you cannot approve a request you raised');
  if (step.distinct_approvers) {
    const signed = await one(tx, `SELECT 1 FROM approval_step WHERE request_id = $1 AND decided_by = $2`, [step.request_id, actor.userId]);
    if (signed) throw invalid('you have already signed another step of this request; a different person must sign this one');
  }
  if ((await currentStage(tx, step.request_id)) !== step.stage) throw conflict('earlier approval stages are not complete yet');
  if (input.decision === 'reject' && !input.comment?.trim()) throw invalid('a rejection needs a comment explaining why');
  await tx.query(`UPDATE approval_step SET status = $2, decided_by = $3, decided_at = now(), comment = $4 WHERE id = $1`,
    [stepId, input.decision === 'approve' ? 'approved' : 'rejected', actor.userId, input.comment ?? null]);
  let requestStatus = 'pending';
  if (input.decision === 'reject') {
    requestStatus = 'rejected';
    await tx.query(`UPDATE approval_step SET status = 'skipped' WHERE request_id = $1 AND status = 'pending'`, [step.request_id]);
  } else if ((await currentStage(tx, step.request_id)) === null) {
    requestStatus = 'approved';
  }
  if (requestStatus !== 'pending') await tx.query(`UPDATE approval_request SET status = $2, decided_at = now() WHERE id = $1`, [step.request_id, requestStatus]);
  await audit(tx, actor, { action: `approval.${input.decision === 'approve' ? 'approved' : 'rejected'}`, entityType: step.subject_type, entityId: step.subject_id,
    facilityId: step.facility_id, data: { requestId: step.request_id, stepId, role: step.role_key, stage: step.stage, comment: input.comment ?? null, requestStatus } });
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
    await audit(tx, actor, { action: `approval.${status}`, entityType: subjectType, entityId: subjectId, data: { requestId: r.id, reason } });
  }
  return reqs.length;
}

export async function approvalHistory(tx: Tx, subjectType: string, subjectId: string) {
  const reqs = await many(tx, `SELECT r.id, r.purpose, r.subject_revision, r.status, r.created_at, r.decided_at, u.display_name AS requested_by
                               FROM approval_request r JOIN app_user u ON u.id = r.requested_by
                               WHERE r.subject_type = $1 AND r.subject_id = $2 ORDER BY r.created_at`, [subjectType, subjectId]);
  for (const r of reqs) {
    r.steps = await many(tx, `SELECT s.id, s.stage, s.role_key, s.label, s.status, s.decided_at, s.comment, u.display_name AS decided_by
                              FROM approval_step s LEFT JOIN app_user u ON u.id = s.decided_by WHERE s.request_id = $1 ORDER BY s.stage, s.label`, [r.id]);
  }
  return reqs;
}

/** Steps the actor can decide right now (current stage, role held at the subject's facility, not self-raised). */
export async function myApprovalQueue(tx: Tx, actor: Actor) {
  const rows = await many(
    tx,
    `SELECT s.id AS step_id, s.label, s.role_key, s.stage, r.id AS request_id, r.subject_type, r.subject_id, r.purpose, r.facility_id, r.created_at, r.requested_by, r.distinct_approvers,
            EXISTS (SELECT 1 FROM approval_step x WHERE x.request_id = r.id AND x.decided_by = $1) AS already_signed
     FROM approval_step s JOIN approval_request r ON r.id = s.request_id
     WHERE r.status = 'pending' AND s.status = 'pending'
       AND s.stage = (SELECT min(stage) FROM approval_step p WHERE p.request_id = r.id AND p.status = 'pending')
     ORDER BY r.created_at`,
    [actor.userId],
  );
  return rows.filter((r) => hasRole(actor, r.role_key, r.facility_id) && r.requested_by !== actor.userId && !(r.distinct_approvers && r.already_signed));
}
