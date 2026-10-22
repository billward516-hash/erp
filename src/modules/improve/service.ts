import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { listActions } from '../quality/service.js';

/**
 * Continuous improvement (docs/ARCHITECTURE.md §12r, D-124). Anyone suggests; a lead approves and names an owner; the
 * owner sets the metric and baseline, implements, and measures the result after at least four weeks; someone other than
 * the owner validates the savings, which closes it. Metrics from the records are measured the same way before and after.
 */
const SUBJECT = 'improvement';
export const MIN_RESULT_DAYS = 28;
const day = (d: any) => (d == null ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: any) => (v == null ? null : Number(v));

/** The metric over [from, to] (dates, inclusive), measured from the records. */
export async function measure(tx: Tx, m: { metric_kind: string; asset_id: string | null; work_center_id: string | null }, from: string, to: string) {
  const start = `${from}T00:00:00Z`; const end = `${addDays(to, 1)}T00:00:00Z`;
  if (m.metric_kind === 'asset_unplanned_downtime') {
    const r = await one(tx, `SELECT coalesce(sum(extract(epoch FROM least(coalesce(ended_at, now()), $3::timestamptz) - greatest(started_at, $2::timestamptz))), 0)::float / 3600 AS hours
      FROM asset_state_event WHERE asset_id = $1 AND state = 'unplanned_downtime' AND started_at < $3 AND coalesce(ended_at, now()) > $2`, [m.asset_id, start, end]);
    const weeks = (Date.parse(end) - Date.parse(start)) / (7 * 86_400_000);
    return { value: Math.round((r.hours / weeks) * 100) / 100, detail: `${Math.round(r.hours * 10) / 10} h unplanned downtime over ${Math.round(weeks * 10) / 10} weeks` };
  }
  if (m.metric_kind === 'work_center_scrap_rate') {
    const r = await one(tx, `SELECT coalesce(sum(e.qty_good), 0)::float AS good, coalesce(sum(e.qty_scrap), 0)::float AS scrap FROM production_entry e JOIN production_operation o ON o.id = e.operation_id
      WHERE o.work_center_id = $1 AND e.kind = 'run' AND e.started_at >= $2 AND e.started_at < $3`, [m.work_center_id, start, end]);
    const total = r.good + r.scrap;
    return { value: total ? Math.round((r.scrap / total) * 10000) / 100 : null, detail: `${r.scrap} scrapped of ${total} made` };
  }
  return { value: null, detail: 'entered by hand' };
}
const METRIC_DEFAULTS: Record<string, { name: string; unit: string }> = {
  asset_unplanned_downtime: { name: 'Unplanned downtime', unit: 'h/week' }, work_center_scrap_rate: { name: 'Scrap rate', unit: '%' },
};

async function lock(tx: Tx, id: string) {
  const m = await one(tx, 'SELECT * FROM improvement WHERE id = $1 FOR UPDATE', [id]);
  if (!m) throw notFound('improvement');
  return m;
}
const isOwnerOrLead = (a: Actor, m: any) => m.owner_user_id === a.userId || can(a, 'improve.manage', m.facility_id);

export async function submitIdea(tx: Tx, actor: Actor, input: { facilityId: string; title: string; problem: string; idea?: string | null; category: string; assetId?: string | null; workCenterId?: string | null }) {
  requirePermission(actor, 'improve.submit', input.facilityId);
  if (!input.title?.trim() || !input.problem?.trim()) throw invalid('say what the problem is and give the idea a title');
  if (input.assetId && !(await one(tx, 'SELECT 1 FROM asset WHERE id = $1 AND facility_id = $2', [input.assetId, input.facilityId]))) throw invalid('the asset is not at this site');
  if (input.workCenterId && !(await one(tx, 'SELECT 1 FROM work_center WHERE id = $1 AND facility_id = $2', [input.workCenterId, input.facilityId]))) throw invalid('the work center is not at this site');
  const number = `IMP-${String(await nextSequence(tx, actor.tenantId, 'improvement')).padStart(6, '0')}`;
  const m = await one(tx, `INSERT INTO improvement (tenant_id, facility_id, number, title, problem, idea, category, submitted_by, asset_id, work_center_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [actor.tenantId, input.facilityId, number, input.title.trim(), input.problem.trim(), input.idea?.trim() || null, input.category, actor.userId, input.assetId ?? null, input.workCenterId ?? null]);
  await notify(tx, actor.tenantId, await usersWithPermission(tx, 'improve.manage', input.facilityId), { kind: 'improve.submitted', title: `New improvement idea ${number}: ${m.title}`,
    body: m.problem.slice(0, 300), link: `/improvements/${m.id}`, subjectType: SUBJECT, subjectId: m.id, dedupeKey: `imp:${m.id}` }, actor.userId);
  await audit(tx, actor, { action: 'improve.submitted', entityType: SUBJECT, entityId: m.id, facilityId: input.facilityId, data: { number, category: input.category } });
  return m;
}

/** A lead approves (naming an owner) or declines with a reason the submitter sees. */
export async function decide(tx: Tx, actor: Actor, id: string, input: { approve: boolean; ownerUserId?: string | null; note?: string | null }) {
  const m = await lock(tx, id);
  requirePermission(actor, 'improve.manage', m.facility_id);
  if (m.stage !== 'idea') throw conflict(`already ${m.stage}`);
  if (input.approve) {
    if (!input.ownerUserId) throw invalid('name the owner who will carry it out');
    await tx.query(`UPDATE improvement SET stage = 'approved', owner_user_id = $2, decided_by = $3, decision_note = $4 WHERE id = $1`, [id, input.ownerUserId, actor.userId, input.note?.trim() || null]);
    await notify(tx, actor.tenantId, [input.ownerUserId], { kind: 'improve.owner', title: `You own ${m.number}: ${m.title}`, link: `/improvements/${id}`, subjectType: SUBJECT, subjectId: id, dedupeKey: `imp-owner:${id}` }, actor.userId);
  } else {
    if (!input.note?.trim()) throw invalid('say why it is not going ahead');
    await tx.query(`UPDATE improvement SET stage = 'rejected', decided_by = $2, decision_note = $3, closed_at = now() WHERE id = $1`, [id, actor.userId, input.note.trim()]);
  }
  await notify(tx, actor.tenantId, [m.submitted_by], { kind: 'improve.decided', title: `${m.number} ${input.approve ? 'approved' : 'not taken forward'}: ${m.title}`, body: input.note ?? null,
    link: `/improvements/${id}`, subjectType: SUBJECT, subjectId: id, dedupeKey: `imp-decided:${id}` }, actor.userId);
  await audit(tx, actor, { action: input.approve ? 'improve.approved' : 'improve.rejected', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { owner: input.ownerUserId ?? null, note: input.note ?? null } });
}

/** The owner's plan: what is measured, the target and the expected savings. */
export async function planImprovement(tx: Tx, actor: Actor, id: string, input: { metricKind?: 'manual' | 'asset_unplanned_downtime' | 'work_center_scrap_rate'; metricName?: string | null; metricUnit?: string | null;
  lowerIsBetter?: boolean; targetValue?: number | null; estAnnualSavings?: number | null; oneTimeCost?: number | null; assetId?: string | null; workCenterId?: string | null }) {
  const m = await lock(tx, id);
  if (!isOwnerOrLead(actor, m)) throw forbidden('own the improvement or improve.manage');
  if (['closed', 'rejected', 'idea'].includes(m.stage)) throw conflict(m.stage === 'idea' ? 'approve the idea first' : `the improvement is ${m.stage}`);
  const kind = input.metricKind ?? m.metric_kind;
  const assetId = input.assetId === undefined ? m.asset_id : input.assetId; const wcId = input.workCenterId === undefined ? m.work_center_id : input.workCenterId;
  if (kind === 'asset_unplanned_downtime' && !assetId) throw invalid('choose the asset whose downtime is measured');
  if (kind === 'work_center_scrap_rate' && !wcId) throw invalid('choose the work center whose scrap is measured');
  if (kind !== m.metric_kind && m.baseline_value != null) throw conflict('the metric cannot change once a baseline is recorded');
  const def = METRIC_DEFAULTS[kind];
  await tx.query(`UPDATE improvement SET metric_kind = $2, metric_name = $3, metric_unit = $4, lower_is_better = $5, target_value = $6, est_annual_savings = $7, one_time_cost = $8, asset_id = $9, work_center_id = $10 WHERE id = $1`,
    [id, kind, input.metricName ?? m.metric_name ?? def?.name ?? null, input.metricUnit ?? m.metric_unit ?? def?.unit ?? null, input.lowerIsBetter ?? m.lower_is_better,
      input.targetValue === undefined ? m.target_value : input.targetValue, input.estAnnualSavings === undefined ? m.est_annual_savings : input.estAnnualSavings,
      input.oneTimeCost === undefined ? m.one_time_cost : input.oneTimeCost, assetId, wcId]);
  await audit(tx, actor, { action: 'improve.planned', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: input });
}

/** Baseline: from the records over a window before the change (default the 8 weeks to today), or a value entered by hand. */
export async function setBaseline(tx: Tx, actor: Actor, id: string, input: { from?: string; to?: string; value?: number | null }) {
  const m = await lock(tx, id);
  if (!isOwnerOrLead(actor, m)) throw forbidden('own the improvement or improve.manage');
  if (!['approved', 'in_progress'].includes(m.stage)) throw conflict('the baseline is set before the change is made');
  const to = input.to ?? today(); const from = input.from ?? addDays(to, -55);
  if (from > to) throw invalid('the window must end after it starts');
  let value: number | null;
  if (m.metric_kind === 'manual') {
    if (input.value == null) throw invalid('enter the baseline value');
    value = input.value;
  } else {
    value = (await measure(tx, m, from, to)).value;
    if (value == null) throw invalid('nothing was recorded in that window to measure; choose another window');
  }
  await tx.query(`UPDATE improvement SET baseline_value = $2, baseline_from = $3, baseline_to = $4, stage = 'in_progress' WHERE id = $1`, [id, value, from, to]);
  await audit(tx, actor, { action: 'improve.baseline', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { value, from, to } });
  return { value, from, to };
}

export async function markImplemented(tx: Tx, actor: Actor, id: string, input: { implementedOn?: string }) {
  const m = await lock(tx, id);
  if (!isOwnerOrLead(actor, m)) throw forbidden('own the improvement or improve.manage');
  if (m.stage !== 'in_progress') throw conflict(m.baseline_value == null ? 'record the baseline first' : `the improvement is ${m.stage}`);
  const on = input.implementedOn ?? today();
  if (on > today()) throw invalid('the change cannot be implemented in the future');
  if (m.baseline_to && on < day(m.baseline_to)!) throw invalid('the change must come after the baseline window');
  await tx.query(`UPDATE improvement SET stage = 'measuring', implemented_on = $2 WHERE id = $1`, [id, on]);
  await audit(tx, actor, { action: 'improve.implemented', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { on } });
}

/** The result: the same metric since the change, after at least four weeks (from the records), or entered by hand. */
export async function measureResult(tx: Tx, actor: Actor, id: string, input: { value?: number | null } = {}) {
  const m = await lock(tx, id);
  if (!isOwnerOrLead(actor, m)) throw forbidden('own the improvement or improve.manage');
  if (m.stage !== 'measuring') throw conflict('mark the change as implemented first');
  const from = day(m.implemented_on)!; const to = today();
  let value: number | null;
  if (m.metric_kind === 'manual') {
    if (input.value == null) throw invalid('enter the result value');
    value = input.value;
  } else {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (days < MIN_RESULT_DAYS) throw invalid(`measure at least ${MIN_RESULT_DAYS} days after the change (${Math.ceil(MIN_RESULT_DAYS - days)} to go), so a good week is not mistaken for a result`);
    value = (await measure(tx, m, from, to)).value;
  }
  await tx.query(`UPDATE improvement SET result_value = $2, result_from = $3, result_to = $4 WHERE id = $1`, [id, value, from, to]);
  await audit(tx, actor, { action: 'improve.measured', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { value, from, to } });
  return { value, from, to };
}

/** Someone other than the owner (a lead, typically with finance) validates the savings; this closes the improvement. */
export async function validateSavings(tx: Tx, actor: Actor, id: string, input: { amount: number; note: string }) {
  const m = await lock(tx, id);
  requirePermission(actor, 'improve.manage', m.facility_id);
  if (m.owner_user_id === actor.userId) throw invalid('savings are validated by someone other than the owner');
  if (m.stage !== 'measuring' || m.result_value == null) throw conflict('measure the result first');
  if (!(input.amount >= 0)) throw invalid('validated savings cannot be negative (record 0 when there were none)');
  if (!input.note?.trim()) throw invalid('say how the savings were worked out');
  await tx.query(`UPDATE improvement SET validated_savings = $2, validation_note = $3, validated_by = $4, validated_at = now(), stage = 'closed', closed_at = now() WHERE id = $1`,
    [id, input.amount, input.note.trim(), actor.userId]);
  await audit(tx, actor, { action: 'improve.validated', entityType: SUBJECT, entityId: id, facilityId: m.facility_id, data: { amount: input.amount } });
}

function outcome(m: any) {
  const b = num(m.baseline_value); const r = num(m.result_value);
  if (b == null || r == null) return null;
  const change = r - b; const pct = b !== 0 ? change / Math.abs(b) : null;
  const better = m.lower_is_better ? r < b : r > b;
  const t = num(m.target_value);
  return { change: Math.round(change * 1000) / 1000, pct: pct == null ? null : Math.round(pct * 1000) / 1000, better, metTarget: t == null ? null : m.lower_is_better ? r <= t : r >= t };
}

export async function getImprovement(tx: Tx, actor: Actor, id: string) {
  const m = await one(tx, `SELECT m.*, f.code AS facility_code, s.display_name AS submitted_by_name, o.display_name AS owner_name, v.display_name AS validated_by_name, d.display_name AS decided_by_name,
      a.asset_tag, wc.code AS work_center_code
    FROM improvement m JOIN facility f ON f.id = m.facility_id JOIN app_user s ON s.id = m.submitted_by LEFT JOIN app_user o ON o.id = m.owner_user_id LEFT JOIN app_user v ON v.id = m.validated_by
    LEFT JOIN app_user d ON d.id = m.decided_by LEFT JOIN asset a ON a.id = m.asset_id LEFT JOIN work_center wc ON wc.id = m.work_center_id WHERE m.id = $1`, [id]);
  if (!m) throw notFound('improvement');
  if (!can(actor, 'improve.submit', m.facility_id)) throw forbidden('improve.submit');
  const actions = await listActions(tx, 'improvement', id);
  // Live reading of a record-based metric: the last 4 weeks, or since the change.
  const live = m.metric_kind !== 'manual' && !['idea', 'rejected'].includes(m.stage)
    ? { ...(await measure(tx, m, m.implemented_on ? day(m.implemented_on)! : addDays(today(), -27), today())), from: m.implemented_on ? day(m.implemented_on) : addDays(today(), -27), to: today() } : null;
  const owners = can(actor, 'improve.manage', m.facility_id) ? await many(tx, `SELECT DISTINCT u.id, u.display_name FROM user_role_scope s JOIN app_user u ON u.id = s.user_id
    WHERE u.status = 'active' AND (s.facility_id IS NULL OR s.facility_id = $1) ORDER BY u.display_name`, [m.facility_id]) : [];
  const resultReadyOn = m.implemented_on ? addDays(day(m.implemented_on)!, MIN_RESULT_DAYS) : null;
  return { ...m, baseline_value: num(m.baseline_value), result_value: num(m.result_value), target_value: num(m.target_value), est_annual_savings: num(m.est_annual_savings),
    one_time_cost: num(m.one_time_cost), validated_savings: num(m.validated_savings), outcome: outcome(m), actions, live, owners, resultReadyOn,
    canLead: can(actor, 'improve.manage', m.facility_id), isOwner: m.owner_user_id === actor.userId };
}

export async function listImprovements(tx: Tx, actor: Actor, q: { facilityId?: string; stage?: string } = {}) {
  requirePermission(actor, 'improve.submit', q.facilityId);
  const rows = await many(tx, `SELECT m.id, m.number, m.title, m.category, m.stage, m.facility_id, f.code AS facility_code, o.display_name AS owner_name, s.display_name AS submitted_by_name,
      m.metric_name, m.metric_unit, m.baseline_value::float, m.result_value::float, m.target_value::float, m.lower_is_better, m.est_annual_savings::float, m.validated_savings::float,
      m.implemented_on, m.closed_at, m.created_at, (SELECT count(*)::int FROM action_item a WHERE a.subject_type = 'improvement' AND a.subject_id = m.id AND a.status = 'open') AS open_actions
    FROM improvement m JOIN facility f ON f.id = m.facility_id JOIN app_user s ON s.id = m.submitted_by LEFT JOIN app_user o ON o.id = m.owner_user_id
    WHERE ($1::uuid IS NULL OR m.facility_id = $1) AND ($2::text IS NULL OR m.stage = $2)
    ORDER BY array_position(ARRAY['idea', 'approved', 'in_progress', 'measuring', 'closed', 'rejected'], m.stage), m.created_at DESC`, [q.facilityId ?? null, q.stage ?? null]);
  return rows.filter((r) => can(actor, 'improve.submit', r.facility_id)).map((r) => ({ ...r, outcome: outcome(r) }));
}
