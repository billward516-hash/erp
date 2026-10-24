import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import type { Permission } from '../../platform/auth/permissions.js';
import { approvalHistory, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { getDocument } from '../documents/service.js';
import { listAttachments } from '../quality/attachments.js';
import { logQualificationEvent } from './triggers.js';

/**
 * Equipment qualification (SC-007 B, D-184B). A protocol (IQ, OQ, PQ or requalification) belongs to an asset that is under
 * qualification control. It is written (draft), its result entries are recorded, and it is executed; the executed protocol goes
 * to the approval engine, where the approver must be someone other than the person who executed it or recorded any result.
 * An approved passing protocol qualifies the tool or clears "requalification required" (see applyApproved); the return-to-service
 * gate itself is in gate.ts and the triggers that require requalification are in triggers.ts.
 */
export const PROTOCOL_TYPES = ['IQ', 'OQ', 'PQ', 'requalification'] as const;
export type ProtocolType = (typeof PROTOCOL_TYPES)[number];
export const PROTOCOL_LABEL: Record<ProtocolType, string> = { IQ: 'Installation qualification (IQ)', OQ: 'Operational qualification (OQ)', PQ: 'Performance qualification (PQ)', requalification: 'Requalification' };
const SUBJECT = 'qualification_protocol';
const PURPOSE = 'qualification.approve';
/** Protocol types that qualify a tool that has never been qualified. IQ and OQ are earlier stages. */
export const QUALIFYING_TYPES: ProtocolType[] = ['PQ', 'requalification'];
/** Protocol types that clear "requalification required" (IQ verifies the installation and does not stand in for a requalification). */
export const CLEARING_TYPES: ProtocolType[] = ['OQ', 'PQ', 'requalification'];
export const DEFAULT_INTERVALS: Record<ProtocolType, number | null> = { IQ: null, OQ: 12, PQ: 12, requalification: 12 };
export const DEFAULT_LEAD_DAYS = 30;
const today = () => new Date().toISOString().slice(0, 10);
const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);

registerApprovalSubject(SUBJECT, {
  link: (id) => `/qualification/protocols/${id}`,
  commentRequired: true,
  describe: async (tx, id) => {
    const p = await one(tx, `SELECT p.number, p.protocol_type, p.title, p.overall, a.asset_tag FROM qualification_protocol p JOIN asset a ON a.id = p.asset_id WHERE p.id = $1`, [id]);
    return p ? `${p.number} ${p.protocol_type} on ${p.asset_tag}: ${p.title}${p.overall === 'fail' ? ' (executed with failed steps)' : ''}` : 'Qualification protocol';
  },
});

const addMonths = (iso: string, months: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day0 = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day0, last));
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(tx: Tx, actor: Actor) {
  requirePermission(actor, 'qualification.view');
  const s = await one(tx, 'SELECT intervals, due_lead_days FROM qualification_setting');
  return { intervals: { ...DEFAULT_INTERVALS, ...(s?.intervals ?? {}) } as Record<ProtocolType, number | null>, dueLeadDays: (s?.due_lead_days as number | undefined) ?? DEFAULT_LEAD_DAYS };
}

export async function saveSettings(tx: Tx, actor: Actor, input: { intervals?: Partial<Record<ProtocolType, number | null>>; dueLeadDays?: number }) {
  requirePermission(actor, 'qualification.manage');
  const cur = await getSettings(tx, actor);
  const intervals = { ...cur.intervals, ...(input.intervals ?? {}) };
  for (const t of PROTOCOL_TYPES) {
    const m = intervals[t];
    if (m != null && !(Number.isInteger(m) && m >= 1 && m <= 120)) throw invalid(`the ${t} interval must be 1 to 120 months (or empty for none)`);
  }
  const lead = input.dueLeadDays ?? cur.dueLeadDays;
  if (!(Number.isInteger(lead) && lead >= 1 && lead <= 365)) throw invalid('the warning period must be 1 to 365 days');
  await tx.query(`INSERT INTO qualification_setting (tenant_id, intervals, due_lead_days, updated_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id) DO UPDATE SET intervals = excluded.intervals, due_lead_days = excluded.due_lead_days, updated_by = excluded.updated_by, updated_at = now()`,
  [actor.tenantId, JSON.stringify(intervals), lead, actor.userId]);
  await audit(tx, actor, { action: 'qualification.settings_changed', entityType: 'tenant', entityId: actor.tenantId, data: { intervals, dueLeadDays: lead } });
  return { intervals, dueLeadDays: lead };
}

// ---------------------------------------------------------------------------
// Qualification status of an asset
// ---------------------------------------------------------------------------

export type QualState = 'off' | 'not_qualified' | 'qualified' | 'requalification_due' | 'requalification_required';
export const STATE_LABEL: Record<QualState, string> = { off: 'Not under qualification control', not_qualified: 'Not qualified', qualified: 'Qualified', requalification_due: 'Requalification due', requalification_required: 'Requalification required' };

/** The four states people see: qualified, requalification due (with its date), requalification required, not qualified. */
export function qualState(q: { enabled: boolean; status: string; requal_due_on: unknown } | undefined | null, leadDays: number, now = today()) {
  if (!q || !q.enabled) return { state: 'off' as QualState, dueInDays: null as number | null, overdue: false };
  const due = day(q.requal_due_on);
  const dueInDays = due ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) / 86_400_000) : null;
  if (q.status === 'requalification_required') return { state: 'requalification_required' as QualState, dueInDays, overdue: dueInDays != null && dueInDays < 0 };
  if (q.status === 'not_qualified') return { state: 'not_qualified' as QualState, dueInDays, overdue: false };
  return { state: (dueInDays != null && dueInDays <= leadDays ? 'requalification_due' : 'qualified') as QualState, dueInDays, overdue: dueInDays != null && dueInDays < 0 };
}

async function assetFor(tx: Tx, actor: Actor, assetId: string, perm: Permission) {
  const a = await one(tx, 'SELECT id, facility_id, asset_tag, name, parent_asset_id FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, perm, a.facility_id);
  return a;
}
const lockQ = (tx: Tx, assetId: string) => one(tx, 'SELECT * FROM asset_qualification WHERE asset_id = $1 FOR UPDATE', [assetId]);

/** Puts a tool under qualification control. `requalifyAfterWork` (default yes) says whether finished work or an implemented change makes it need requalification. */
export async function switchOn(tx: Tx, actor: Actor, assetId: string, input: { requalifyAfterWork?: boolean } = {}) {
  const a = await assetFor(tx, actor, assetId, 'qualification.manage');
  const cur = await lockQ(tx, assetId);
  if (cur?.enabled) throw conflict(`${a.asset_tag} is already under qualification control`);
  if (cur) await tx.query('UPDATE asset_qualification SET enabled = true, requalify_after_work = $2 WHERE id = $1', [cur.id, input.requalifyAfterWork ?? cur.requalify_after_work]);
  else await tx.query(`INSERT INTO asset_qualification (tenant_id, facility_id, asset_id, requalify_after_work, created_by) VALUES ($1, $2, $3, $4, $5)`, [actor.tenantId, a.facility_id, assetId, input.requalifyAfterWork ?? true, actor.userId]);
  await logQualificationEvent(tx, actor, { facilityId: a.facility_id, assetId, kind: 'switched_on', summary: `${a.asset_tag} put under qualification control` });
  await audit(tx, actor, { action: 'qualification.switched_on', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { requalifyAfterWork: input.requalifyAfterWork ?? cur?.requalify_after_work ?? true } });
  return getAssetQualification(tx, actor, assetId);
}

export async function switchOff(tx: Tx, actor: Actor, assetId: string, reason: string) {
  const a = await assetFor(tx, actor, assetId, 'qualification.manage');
  const cur = await lockQ(tx, assetId);
  if (!cur?.enabled) throw conflict(`${a.asset_tag} is not under qualification control`);
  if (!reason?.trim() || reason.trim().length < 5) throw invalid('say why qualification control is switched off for this tool');
  await tx.query('UPDATE asset_qualification SET enabled = false WHERE id = $1', [cur.id]);
  await logQualificationEvent(tx, actor, { facilityId: a.facility_id, assetId, kind: 'switched_off', summary: `Qualification control switched off: ${reason.trim()}` });
  await audit(tx, actor, { action: 'qualification.switched_off', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { reason: reason.trim(), statusWas: cur.status } });
  return getAssetQualification(tx, actor, assetId);
}

export async function setRequalifyAfterWork(tx: Tx, actor: Actor, assetId: string, value: boolean) {
  const a = await assetFor(tx, actor, assetId, 'qualification.manage');
  const cur = await lockQ(tx, assetId);
  if (!cur) throw conflict(`${a.asset_tag} is not under qualification control`);
  if (cur.requalify_after_work === value) return getAssetQualification(tx, actor, assetId);
  await tx.query('UPDATE asset_qualification SET requalify_after_work = $2 WHERE id = $1', [cur.id, value]);
  await logQualificationEvent(tx, actor, { facilityId: a.facility_id, assetId, kind: 'setting_changed', summary: `Requalify after work or a change: ${value ? 'yes' : 'no'}` });
  await audit(tx, actor, { action: 'qualification.setting_changed', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { requalifyAfterWork: value } });
  return getAssetQualification(tx, actor, assetId);
}

/**
 * Records that a tool was qualified before it was entered here (existing equipment), with the basis. Only a tool that has never
 * been qualified here can be declared; "requalification required" is cleared only by an approved protocol.
 */
export async function declareQualified(tx: Tx, actor: Actor, assetId: string, input: { qualifiedOn: string; basis: string; requalDueOn?: string | null }) {
  const a = await assetFor(tx, actor, assetId, 'qualification.manage');
  const cur = await lockQ(tx, assetId);
  if (!cur?.enabled) throw conflict(`${a.asset_tag} is not under qualification control`);
  if (cur.status !== 'not_qualified') throw conflict(cur.status === 'qualified' ? `${a.asset_tag} is already qualified` : 'requalification is cleared only by an approved protocol, not by a declaration');
  if (!input.basis?.trim() || input.basis.trim().length < 10) throw invalid('give the basis: which earlier protocol, report or document shows the tool was qualified');
  if (input.qualifiedOn > today()) throw invalid('the qualification date cannot be in the future');
  if (input.requalDueOn && input.requalDueOn < input.qualifiedOn) throw invalid('the requalification due date is before the qualification date');
  await tx.query(`UPDATE asset_qualification SET status = 'qualified', qualified_on = $2, requal_due_on = $3 WHERE id = $1`, [cur.id, input.qualifiedOn, input.requalDueOn ?? null]);
  await logQualificationEvent(tx, actor, { facilityId: a.facility_id, assetId, kind: 'declared', summary: `Existing qualification recorded (${input.qualifiedOn}): ${input.basis.trim()}`, data: { qualifiedOn: input.qualifiedOn, requalDueOn: input.requalDueOn ?? null } });
  await audit(tx, actor, { action: 'qualification.declared', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { qualifiedOn: input.qualifiedOn, basis: input.basis.trim(), requalDueOn: input.requalDueOn ?? null } });
  return getAssetQualification(tx, actor, assetId);
}

/** One asset: its status, protocols, history and the open work that would be affected. */
export async function getAssetQualification(tx: Tx, actor: Actor, assetId: string) {
  const a = await assetFor(tx, actor, assetId, 'qualification.view');
  const settings = await getSettings(tx, actor);
  const q = await one(tx, 'SELECT * FROM asset_qualification WHERE asset_id = $1', [assetId]);
  const s = qualState(q, settings.dueLeadDays);
  const protocols = await many(tx, `SELECT p.id, p.number, p.protocol_type, p.title, p.status, p.overall, p.executed_at, p.decided_at, p.requal_due_on, p.interval_months, p.created_at, u.display_name AS executed_by_name,
      (SELECT count(*)::int FROM qualification_result r WHERE r.protocol_id = p.id) AS steps, (SELECT count(*)::int FROM qualification_result r WHERE r.protocol_id = p.id AND r.outcome = 'fail') AS failed_steps
    FROM qualification_protocol p LEFT JOIN app_user u ON u.id = p.executed_by WHERE p.asset_id = $1 AND p.status <> 'cancelled' ORDER BY p.created_at DESC`, [assetId]);
  const events = await many(tx, `SELECT e.id, e.kind, e.occurred_at, e.summary, e.protocol_id, e.ref_type, e.ref_id, u.display_name AS actor FROM qualification_event e LEFT JOIN app_user u ON u.id = e.actor_user_id
    WHERE e.asset_id = $1 ORDER BY e.occurred_at DESC, e.id DESC LIMIT 100`, [assetId]);
  return {
    asset: { id: a.id, facility_id: a.facility_id, asset_tag: a.asset_tag, name: a.name }, enabled: !!q?.enabled, status: q?.status ?? null, state: s.state, stateLabel: STATE_LABEL[s.state],
    requalifyAfterWork: q?.requalify_after_work ?? true, qualifiedOn: day(q?.qualified_on), requalDueOn: day(q?.requal_due_on), dueInDays: s.dueInDays, overdue: s.overdue,
    requiredSince: q?.required_since ?? null, requiredReason: q?.required_reason ?? null, requiredRefType: q?.required_ref_type ?? null, requiredRefId: q?.required_ref_id ?? null,
    intervals: settings.intervals, protocols, events,
    canManage: can(actor, 'qualification.manage', a.facility_id), canExecute: can(actor, 'qualification.execute', a.facility_id),
  };
}

/** Tools under qualification control, with their state, for the Qualification page. */
export async function listQualification(tx: Tx, actor: Actor, q: { facilityId?: string; state?: QualState } = {}) {
  requirePermission(actor, 'qualification.view', q.facilityId);
  const settings = await getSettings(tx, actor);
  const rows = await many(tx, `SELECT a.id AS asset_id, a.asset_tag, a.name, a.operational_state, a.facility_id, f.code AS facility_code, x.enabled, x.status, x.qualified_on, x.requal_due_on, x.required_since, x.required_reason, x.requalify_after_work,
      (SELECT count(*)::int FROM qualification_protocol p WHERE p.asset_id = a.id AND p.status IN ('draft', 'executed')) AS open_protocols,
      (SELECT p.number FROM qualification_protocol p WHERE p.asset_id = a.id AND p.status = 'executed' ORDER BY p.executed_at DESC LIMIT 1) AS awaiting_approval
    FROM asset_qualification x JOIN asset a ON a.id = x.asset_id JOIN facility f ON f.id = a.facility_id
    WHERE x.enabled AND ($1::uuid IS NULL OR a.facility_id = $1) ORDER BY f.code, a.asset_tag`, [q.facilityId ?? null]);
  return rows.filter((r) => can(actor, 'qualification.view', r.facility_id)).map((r) => ({ ...r, ...qualState(r, settings.dueLeadDays), stateLabel: STATE_LABEL[qualState(r, settings.dueLeadDays).state] }))
    .filter((r) => !q.state || r.state === q.state);
}

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

export interface ProtocolInput {
  assetId: string; protocolType: ProtocolType; title: string; acceptanceCriteria?: string; intervalMonths?: number | null; approverUserId?: string | null;
  steps?: { step: string; expected?: string }[];
}

async function lockProtocol(tx: Tx, id: string) {
  const p = await one(tx, 'SELECT * FROM qualification_protocol WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw notFound('qualification protocol');
  return p;
}
const assertDraft = (p: any) => { if (p.status !== 'draft') throw conflict(`the protocol is ${p.status}; only a draft can be changed`); };
async function checkApprover(tx: Tx, facilityId: string, userId: string | null | undefined) {
  if (!userId) return;
  const u = await one(tx, `SELECT u.id FROM app_user u WHERE u.id = $1 AND u.status = 'active'`, [userId]);
  if (!u) throw invalid('the approver was not found or is not active');
}

export async function createProtocol(tx: Tx, actor: Actor, input: ProtocolInput) {
  const a = await assetFor(tx, actor, input.assetId, 'qualification.manage');
  const q = await one(tx, 'SELECT enabled FROM asset_qualification WHERE asset_id = $1', [input.assetId]);
  if (!q?.enabled) throw conflict(`put ${a.asset_tag} under qualification control first`);
  if (!PROTOCOL_TYPES.includes(input.protocolType)) throw invalid('protocol type must be IQ, OQ, PQ or requalification');
  if (!input.title?.trim() || input.title.trim().length < 3) throw invalid('give the protocol a title');
  await checkApprover(tx, a.facility_id, input.approverUserId);
  const months = input.intervalMonths === undefined ? (await getSettings(tx, actor)).intervals[input.protocolType] : input.intervalMonths;
  if (months != null && !(Number.isInteger(months) && months >= 1 && months <= 120)) throw invalid('the requalification interval must be 1 to 120 months');
  const number = `QP-${String(await nextSequence(tx, actor.tenantId, SUBJECT)).padStart(4, '0')}`;
  const p = await one(tx, `INSERT INTO qualification_protocol (tenant_id, facility_id, asset_id, number, protocol_type, title, acceptance_criteria, interval_months, approver_user_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
  [actor.tenantId, a.facility_id, a.id, number, input.protocolType, input.title.trim(), input.acceptanceCriteria?.trim() ?? '', months, input.approverUserId ?? null, actor.userId]);
  for (const [i, s] of (input.steps ?? []).entries()) {
    if (!s.step?.trim()) throw invalid(`step ${i + 1} is empty`);
    await tx.query(`INSERT INTO qualification_result (tenant_id, facility_id, protocol_id, seq, step, expected) VALUES ($1, $2, $3, $4, $5, $6)`, [actor.tenantId, a.facility_id, p.id, i + 1, s.step.trim(), s.expected?.trim() ?? '']);
  }
  await audit(tx, actor, { action: 'qualification.protocol_created', entityType: SUBJECT, entityId: p.id, facilityId: a.facility_id, data: { number, type: input.protocolType, assetId: a.id } });
  return p;
}

export async function updateProtocol(tx: Tx, actor: Actor, id: string, patch: { title?: string; acceptanceCriteria?: string; intervalMonths?: number | null; approverUserId?: string | null }) {
  const p = await lockProtocol(tx, id);
  requirePermission(actor, 'qualification.manage', p.facility_id);
  assertDraft(p);
  if (patch.title !== undefined && patch.title.trim().length < 3) throw invalid('give the protocol a title');
  if (patch.intervalMonths != null && !(Number.isInteger(patch.intervalMonths) && patch.intervalMonths >= 1 && patch.intervalMonths <= 120)) throw invalid('the requalification interval must be 1 to 120 months');
  if (patch.approverUserId) await checkApprover(tx, p.facility_id, patch.approverUserId);
  const next = {
    title: patch.title?.trim() ?? p.title, criteria: patch.acceptanceCriteria?.trim() ?? p.acceptance_criteria,
    months: patch.intervalMonths === undefined ? p.interval_months : patch.intervalMonths, approver: patch.approverUserId === undefined ? p.approver_user_id : patch.approverUserId,
  };
  await tx.query(`UPDATE qualification_protocol SET title = $2, acceptance_criteria = $3, interval_months = $4, approver_user_id = $5 WHERE id = $1`, [id, next.title, next.criteria, next.months, next.approver]);
  await audit(tx, actor, { action: 'qualification.protocol_updated', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { fields: Object.keys(patch) } });
  return getProtocol(tx, actor, id);
}

export async function cancelProtocol(tx: Tx, actor: Actor, id: string, reason: string) {
  const p = await lockProtocol(tx, id);
  requirePermission(actor, 'qualification.manage', p.facility_id);
  assertDraft(p);
  if (!reason?.trim() || reason.trim().length < 3) throw invalid('say why the protocol is cancelled');
  await tx.query(`UPDATE qualification_protocol SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason.trim()]);
  await audit(tx, actor, { action: 'qualification.protocol_cancelled', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { reason: reason.trim() } });
}

/** A step (what to do and what to expect). Executors may add steps found necessary during the run. */
export async function addStep(tx: Tx, actor: Actor, protocolId: string, input: { step: string; expected?: string }) {
  const p = await lockProtocol(tx, protocolId);
  if (!can(actor, 'qualification.manage', p.facility_id) && !can(actor, 'qualification.execute', p.facility_id)) throw forbidden('qualification.execute');
  assertDraft(p);
  if (!input.step?.trim()) throw invalid('describe the step');
  const seq = ((await one(tx, 'SELECT coalesce(max(seq), 0)::int AS n FROM qualification_result WHERE protocol_id = $1', [protocolId]))?.n ?? 0) + 1;
  const r = await one(tx, `INSERT INTO qualification_result (tenant_id, facility_id, protocol_id, seq, step, expected) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [actor.tenantId, p.facility_id, protocolId, seq, input.step.trim(), input.expected?.trim() ?? '']);
  await audit(tx, actor, { action: 'qualification.step_added', entityType: SUBJECT, entityId: protocolId, facilityId: p.facility_id, data: { seq } });
  return r;
}

export async function removeStep(tx: Tx, actor: Actor, resultId: string) {
  const r = await one(tx, 'SELECT * FROM qualification_result WHERE id = $1', [resultId]);
  if (!r) throw notFound('step');
  const p = await lockProtocol(tx, r.protocol_id);
  requirePermission(actor, 'qualification.manage', p.facility_id);
  assertDraft(p);
  if (r.outcome !== 'pending') throw conflict('a step with a recorded result cannot be removed; record it as not applicable instead');
  await tx.query('DELETE FROM qualification_result WHERE id = $1', [resultId]);
  await audit(tx, actor, { action: 'qualification.step_removed', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { seq: r.seq } });
}

/** Records what was found for a step and whether it passed. The person recording is kept on the entry. */
export async function recordResult(tx: Tx, actor: Actor, resultId: string, input: { actual?: string | null; outcome: 'pass' | 'fail' | 'na'; note?: string | null }) {
  const r = await one(tx, 'SELECT * FROM qualification_result WHERE id = $1', [resultId]);
  if (!r) throw notFound('step');
  const p = await lockProtocol(tx, r.protocol_id);
  requirePermission(actor, 'qualification.execute', p.facility_id);
  assertDraft(p);
  if (!['pass', 'fail', 'na'].includes(input.outcome)) throw invalid('the outcome is pass, fail or not applicable');
  if (input.outcome !== 'na' && !input.actual?.trim()) throw invalid('record what was found (the actual result)');
  if (input.outcome === 'fail' && !(input.note?.trim() || input.actual?.trim())) throw invalid('say what failed');
  const row = await one(tx, `UPDATE qualification_result SET actual = $2, outcome = $3, note = $4, recorded_by = $5, recorded_at = now() WHERE id = $1 RETURNING *`,
    [resultId, input.actual?.trim() ?? null, input.outcome, input.note?.trim() ?? null, actor.userId]);
  await audit(tx, actor, { action: 'qualification.result_recorded', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { seq: r.seq, outcome: input.outcome } });
  return row;
}

/** Links a controlled document to the protocol (its procedure or a reference), pinned to the version in force now. */
export async function linkProtocolDocument(tx: Tx, actor: Actor, protocolId: string, documentId: string, role: 'procedure' | 'reference' = 'procedure') {
  const p = await lockProtocol(tx, protocolId);
  requirePermission(actor, 'qualification.manage', p.facility_id);
  assertDraft(p);
  const doc = await getDocument(tx, actor, documentId); // refuses a document the person may not see
  if (doc.status !== 'active') throw invalid('that document has been withdrawn');
  if (!doc.current_version_id) throw invalid('that document has no approved version yet; link it once it is approved');
  await tx.query(`INSERT INTO document_link (tenant_id, document_id, entity_type, entity_id, link_role, pinned_version_id) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (document_id, entity_type, entity_id, link_role) DO UPDATE SET pinned_version_id = excluded.pinned_version_id`, [actor.tenantId, documentId, SUBJECT, protocolId, role, doc.current_version_id]);
  await audit(tx, actor, { action: 'qualification.document_linked', entityType: SUBJECT, entityId: protocolId, facilityId: p.facility_id, data: { documentId, docNumber: doc.doc_number, role, versionId: doc.current_version_id } });
}

export async function unlinkProtocolDocument(tx: Tx, actor: Actor, protocolId: string, documentId: string) {
  const p = await lockProtocol(tx, protocolId);
  requirePermission(actor, 'qualification.manage', p.facility_id);
  assertDraft(p);
  await tx.query(`DELETE FROM document_link WHERE document_id = $1 AND entity_type = $2 AND entity_id = $3`, [documentId, SUBJECT, protocolId]);
  await audit(tx, actor, { action: 'qualification.document_unlinked', entityType: SUBJECT, entityId: protocolId, facilityId: p.facility_id, data: { documentId } });
}

/** People who took part in running the protocol: the executor and anyone who recorded a result. They may not approve it. */
async function participants(tx: Tx, protocolId: string, executedBy: string | null) {
  const rows = await many(tx, 'SELECT DISTINCT recorded_by FROM qualification_result WHERE protocol_id = $1 AND recorded_by IS NOT NULL', [protocolId]);
  return new Set<string>([...rows.map((r) => r.recorded_by as string), ...(executedBy ? [executedBy] : [])]);
}

/**
 * Executes the protocol: every step has a result, the overall result is fail if any step failed, and the protocol goes to its
 * approver. The person executing is the requester in the approval engine and, with anyone who recorded a result, cannot approve.
 */
export async function executeProtocol(tx: Tx, actor: Actor, id: string, conclusion: string) {
  const p = await lockProtocol(tx, id);
  requirePermission(actor, 'qualification.execute', p.facility_id);
  assertDraft(p);
  const steps = await many(tx, 'SELECT outcome FROM qualification_result WHERE protocol_id = $1', [id]);
  if (!steps.length) throw invalid('add at least one step with its expected result');
  const pending = steps.filter((s) => s.outcome === 'pending').length;
  if (pending) throw invalid(`${pending} step${pending === 1 ? ' has' : 's have'} no result yet; record each as pass, fail or not applicable`);
  if (!steps.some((s) => s.outcome !== 'na')) throw invalid('every step is marked not applicable; nothing was demonstrated');
  if (!conclusion?.trim() || conclusion.trim().length < 5) throw invalid('write the conclusion: does the equipment meet the acceptance criteria');
  if (p.approver_user_id) {
    if ((await participants(tx, id, actor.userId)).has(p.approver_user_id)) throw invalid('the named approver took part in running this protocol; choose another approver (the approver must differ from the people who executed it)');
  }
  const overall = steps.some((s) => s.outcome === 'fail') ? 'fail' : 'pass';
  await tx.query(`UPDATE qualification_protocol SET status = 'executed', overall = $2, executed_by = $3, executed_at = now(), conclusion = $4 WHERE id = $1`, [id, overall, actor.userId, conclusion.trim()]);
  const asset = await one(tx, 'SELECT asset_tag FROM asset WHERE id = $1', [p.asset_id]);
  await createApprovalRequest(tx, actor, { facilityId: p.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: 1, purpose: PURPOSE, distinctApprovers: true,
    stages: [{ steps: [{ roleKey: 'quality_manager', label: `Approval of ${p.number} (${p.protocol_type})`, assigneeUserId: p.approver_user_id }] }] });
  await logQualificationEvent(tx, actor, { facilityId: p.facility_id, assetId: p.asset_id, kind: 'protocol_executed', protocolId: id,
    summary: `${p.number} ${p.protocol_type} executed on ${asset.asset_tag}: ${overall === 'pass' ? 'all steps passed' : 'one or more steps failed'}; waiting for approval`, data: { overall } });
  await audit(tx, actor, { action: 'qualification.protocol_executed', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { overall, conclusion: conclusion.trim() } });
  return getProtocol(tx, actor, id);
}

/**
 * Approval engine callback. Approval records the protocol as approved (all steps passed) or failed (the approver reviewed and
 * accepted the record of a failed run), and updates the tool's qualification; rejection returns the protocol to draft.
 */
export async function onQualificationDecided(tx: Tx, actor: Actor, id: string, purpose: string, status: string) {
  if (purpose !== PURPOSE || status === 'pending') return;
  const p = await lockProtocol(tx, id);
  if (p.status !== 'executed') return;
  const asset = await one(tx, 'SELECT asset_tag FROM asset WHERE id = $1', [p.asset_id]);
  const step = await one(tx, `SELECT s.decided_by, s.on_behalf_of, s.comment FROM approval_step s JOIN approval_request r ON r.id = s.request_id
    WHERE r.subject_type = $1 AND r.subject_id = $2 AND s.decided_by IS NOT NULL ORDER BY s.decided_at DESC LIMIT 1`, [SUBJECT, id]);
  if (status === 'rejected') {
    await tx.query(`UPDATE qualification_protocol SET status = 'draft', overall = NULL, executed_by = NULL, executed_at = NULL WHERE id = $1`, [id]);
    await logQualificationEvent(tx, actor, { facilityId: p.facility_id, assetId: p.asset_id, kind: 'protocol_rejected', protocolId: id, summary: `${p.number} returned to draft by the approver: ${step?.comment ?? ''}` });
    await audit(tx, actor, { action: 'qualification.protocol_rejected', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { comment: step?.comment ?? null } });
    return;
  }
  const doers = await participants(tx, id, p.executed_by);
  for (const who of [step?.decided_by, step?.on_behalf_of]) {
    if (who && doers.has(who)) throw invalid('the approver must differ from the people who executed this protocol or recorded its results');
  }
  const pass = p.overall === 'pass';
  const final = pass ? 'approved' : 'failed';
  const dueOn = pass && p.interval_months ? addMonths(today(), p.interval_months) : null;
  await tx.query(`UPDATE qualification_protocol SET status = $2, decided_at = now(), requal_due_on = $3 WHERE id = $1`, [id, final, dueOn]);
  await logQualificationEvent(tx, actor, { facilityId: p.facility_id, assetId: p.asset_id, kind: pass ? 'protocol_approved' : 'protocol_failed', protocolId: id,
    summary: pass ? `${p.number} ${p.protocol_type} approved on ${asset.asset_tag}${dueOn ? `; requalification due ${dueOn}` : ''}` : `${p.number} ${p.protocol_type} recorded as failed on ${asset.asset_tag}` });
  await audit(tx, actor, { action: pass ? 'qualification.protocol_approved' : 'qualification.protocol_failed', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { type: p.protocol_type, requalDueOn: dueOn } });
  await applyDecided(tx, actor, p, pass, dueOn);
}

async function applyDecided(tx: Tx, actor: Actor, p: any, pass: boolean, dueOn: string | null) {
  const q = await lockQ(tx, p.asset_id);
  if (!q?.enabled) return;
  const type = p.protocol_type as ProtocolType;
  const sets: string[] = ['last_protocol_id = $2'];
  const vals: unknown[] = [q.id, p.id];
  const set = (c: string, v: unknown) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
  if (!pass) {
    // A failed protocol on a tool that was qualified means it is no longer known to be: requalification is required from now.
    if (q.status === 'qualified') {
      set('status', 'requalification_required'); set('required_since', new Date()); set('required_reason', `${p.number} ${type} failed`); set('required_ref_type', 'qualification_protocol'); set('required_ref_id', p.id);
      await logQualificationEvent(tx, actor, { facilityId: p.facility_id, assetId: p.asset_id, kind: 'requal_required', protocolId: p.id, refType: 'qualification_protocol', refId: p.id, summary: `Requalification required: ${p.number} ${type} failed` });
    }
  } else if (q.status === 'requalification_required') {
    const executedAfter = new Date(p.executed_at) > new Date(q.required_since);
    if (CLEARING_TYPES.includes(type) && executedAfter) {
      set('status', 'qualified'); set('required_since', null); set('required_reason', null); set('required_ref_type', null); set('required_ref_id', null); set('qualified_on', today());
      if (dueOn) set('requal_due_on', dueOn);
      await logQualificationEvent(tx, actor, { facilityId: p.facility_id, assetId: p.asset_id, kind: 'requal_cleared', protocolId: p.id, summary: `Requalification complete: ${p.number} ${type} approved` });
    } else {
      await logQualificationEvent(tx, actor, { facilityId: p.facility_id, assetId: p.asset_id, kind: 'setting_changed', protocolId: p.id,
        summary: `${p.number} ${type} approved but does not clear requalification: ${!executedAfter ? `it was executed before requalification became required (${day(q.required_since)})` : 'an IQ does not stand in for a requalification'}` });
    }
  } else if (q.status === 'not_qualified' && QUALIFYING_TYPES.includes(type)) {
    set('status', 'qualified'); set('qualified_on', today());
    if (dueOn) set('requal_due_on', dueOn);
    await logQualificationEvent(tx, actor, { facilityId: p.facility_id, assetId: p.asset_id, kind: 'declared', protocolId: p.id, summary: `Qualified: ${p.number} ${type} approved` });
  } else if (q.status === 'qualified' && dueOn) {
    set('requal_due_on', dueOn);
  }
  await tx.query(`UPDATE asset_qualification SET ${sets.join(', ')} WHERE id = $1`, vals);
}

export async function getProtocol(tx: Tx, actor: Actor, id: string) {
  const p = await one(tx, `SELECT p.*, a.asset_tag, a.name AS asset_name, f.code AS facility_code, cu.display_name AS created_by_name, eu.display_name AS executed_by_name, au.display_name AS approver_name
    FROM qualification_protocol p JOIN asset a ON a.id = p.asset_id JOIN facility f ON f.id = p.facility_id JOIN app_user cu ON cu.id = p.created_by
    LEFT JOIN app_user eu ON eu.id = p.executed_by LEFT JOIN app_user au ON au.id = p.approver_user_id WHERE p.id = $1`, [id]);
  if (!p) throw notFound('qualification protocol');
  requirePermission(actor, 'qualification.view', p.facility_id);
  const steps = await many(tx, `SELECT r.id, r.seq, r.step, r.expected, r.actual, r.outcome, r.note, r.recorded_at, u.display_name AS recorded_by_name FROM qualification_result r
    LEFT JOIN app_user u ON u.id = r.recorded_by WHERE r.protocol_id = $1 ORDER BY r.seq`, [id]);
  const documents = can(actor, 'documents.view', p.facility_id) ? await many(tx, `SELECT d.id, d.doc_number, d.title, d.doc_type, l.link_role, l.pinned_version_id, pv.version_label AS pinned_label, d.current_version_id, cv.version_label AS current_label,
      (l.pinned_version_id IS DISTINCT FROM d.current_version_id) AS revised_since
    FROM document_link l JOIN document d ON d.id = l.document_id LEFT JOIN document_version pv ON pv.id = l.pinned_version_id LEFT JOIN document_version cv ON cv.id = d.current_version_id
    WHERE l.entity_type = $1 AND l.entity_id = $2 ORDER BY d.doc_number`, [SUBJECT, id]) : [];
  const participantsNow = [...(await participants(tx, id, p.executed_by))];
  const mine = participantsNow.includes(actor.userId);
  return {
    ...p, steps, documents, approvals: await approvalHistory(tx, SUBJECT, id), attachments: await listAttachments(tx, actor, 'qualification_protocol', id),
    canManage: can(actor, 'qualification.manage', p.facility_id), canExecute: can(actor, 'qualification.execute', p.facility_id), tookPart: mine, typeLabel: PROTOCOL_LABEL[p.protocol_type as ProtocolType],
  };
}

export async function listProtocols(tx: Tx, actor: Actor, q: { facilityId?: string; assetId?: string; status?: string; open?: boolean } = {}) {
  requirePermission(actor, 'qualification.view', q.facilityId);
  const rows = await many(tx, `SELECT p.id, p.number, p.protocol_type, p.title, p.status, p.overall, p.facility_id, f.code AS facility_code, p.asset_id, a.asset_tag, a.name AS asset_name, p.executed_at, p.decided_at, p.requal_due_on, p.created_at,
      eu.display_name AS executed_by_name
    FROM qualification_protocol p JOIN asset a ON a.id = p.asset_id JOIN facility f ON f.id = p.facility_id LEFT JOIN app_user eu ON eu.id = p.executed_by
    WHERE ($1::uuid IS NULL OR p.facility_id = $1) AND ($2::uuid IS NULL OR p.asset_id = $2) AND ($3::text IS NULL OR p.status = $3) AND (NOT $4 OR p.status IN ('draft', 'executed')) AND p.status <> 'cancelled'
    ORDER BY p.created_at DESC LIMIT 500`, [q.facilityId ?? null, q.assetId ?? null, q.status ?? null, q.open ?? false]);
  return rows.filter((r) => can(actor, 'qualification.view', r.facility_id));
}

/** Protocols for the Qualification page / other modules: counts needing attention at the sites the reader may see. */
export async function attentionCounts(tx: Tx, actor: Actor) {
  const list = await listQualification(tx, actor);
  return {
    underControl: list.length, qualified: list.filter((r) => r.state === 'qualified').length, due: list.filter((r) => r.state === 'requalification_due').length,
    required: list.filter((r) => r.state === 'requalification_required').length, notQualified: list.filter((r) => r.state === 'not_qualified').length,
  };
}
