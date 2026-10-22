import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { createCapa, listActions } from './service.js';

const FMEA = 'fmea';
const PURPOSE = 'fmea.approve';
type P = 'H' | 'M' | 'L';

/**
 * Action priority from severity, occurrence and detection, following the AIAG-VDA FMEA Handbook (2019) table.
 * Severity dominates, then occurrence, then detection; unlike RPN, a high severity with a credible occurrence
 * stays high even when detection is good. Validate against the licensed handbook before relying on it.
 */
export function actionPriority(s: number, o: number, d: number): P {
  const D = d >= 7 ? 0 : d >= 5 ? 1 : d >= 2 ? 2 : 3; // detection bands 7–10, 5–6, 2–4, 1
  const row = (h: P[]) => h[D]!;
  if (s >= 9) {
    if (o >= 6) return 'H';
    if (o >= 4) return row(['H', 'H', 'H', 'M']);
    if (o >= 2) return row(['H', 'M', 'L', 'L']);
    return 'L';
  }
  if (s >= 7) {
    if (o >= 8) return 'H';
    if (o >= 6) return row(['H', 'H', 'H', 'M']);
    if (o >= 4) return row(['H', 'M', 'M', 'M']);
    if (o >= 2) return row(['M', 'M', 'L', 'L']);
    return 'L';
  }
  if (s >= 4) {
    if (o >= 8) return row(['H', 'H', 'M', 'M']);
    if (o >= 6) return row(['M', 'M', 'M', 'L']);
    if (o >= 4) return row(['M', 'L', 'L', 'L']);
    return 'L';
  }
  if (s >= 2) {
    if (o >= 8) return row(['M', 'M', 'L', 'L']);
    return 'L';
  }
  return 'L';
}

/** Priority under the FMEA's method: action priority, or RPN against the FMEA's threshold (half of it is medium). */
export function priorityOf(method: 'ap' | 'rpn', threshold: number | null, s: number, o: number, d: number): P {
  if (method === 'ap') return actionPriority(s, o, d);
  const rpn = s * o * d;
  return rpn >= threshold! ? 'H' : rpn >= threshold! / 2 ? 'M' : 'L';
}

registerApprovalSubject(FMEA, {
  link: (id) => `/quality/fmea/${id}`,
  describe: async (tx, id) => {
    const f = await one(tx, `SELECT number, revision, title, (SELECT count(*)::int FROM fmea_row r WHERE r.fmea_id = f.id AND r.priority = 'H') AS high FROM fmea f WHERE f.id = $1`, [id]);
    return f ? `${f.number} rev ${f.revision}: ${f.title} (${f.high} high-priority failure mode${f.high === 1 ? '' : 's'})` : 'FMEA';
  },
});

async function lockFmea(tx: Tx, id: string) {
  const f = await one(tx, 'SELECT * FROM fmea WHERE id = $1 FOR UPDATE', [id]);
  if (!f) throw notFound('FMEA');
  return f;
}
const editor = (actor: Actor, f: any) => f.owner_user_id === actor.userId || can(actor, 'quality.manage', f.facility_id);

export async function createFmea(tx: Tx, actor: Actor, input: { facilityId: string; kind: 'process' | 'design' | 'equipment'; title: string; scope: string; method?: 'ap' | 'rpn';
  rpnThreshold?: number | null; assetId?: string | null; partId?: string | null; documentId?: string | null; team?: string | null; ownerUserId?: string; reviewDue?: string | null }) {
  requirePermission(actor, 'quality.manage', input.facilityId);
  if (!input.title?.trim() || !input.scope?.trim()) throw invalid('a title and the scope are required');
  if (input.kind === 'equipment' && !input.assetId) throw invalid('an equipment FMEA needs the asset');
  if ((input.method ?? 'ap') === 'rpn' && !input.rpnThreshold) throw invalid('the RPN method needs an action threshold');
  if (input.assetId) {
    const a = await one(tx, 'SELECT facility_id FROM asset WHERE id = $1', [input.assetId]);
    if (!a || a.facility_id !== input.facilityId) throw invalid('the asset must be at the same facility');
  }
  const number = `FMEA-${String(await nextSequence(tx, actor.tenantId, 'fmea')).padStart(4, '0')}`;
  const f = await one(tx, `INSERT INTO fmea (tenant_id, facility_id, number, kind, title, scope, method, rpn_threshold, asset_id, part_id, document_id, team, owner_user_id, review_due, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
  [actor.tenantId, input.facilityId, number, input.kind, input.title.trim(), input.scope.trim(), input.method ?? 'ap', input.rpnThreshold ?? null, input.assetId ?? null, input.partId ?? null,
    input.documentId ?? null, input.team ?? null, input.ownerUserId ?? actor.userId, input.reviewDue ?? null, actor.userId]);
  await audit(tx, actor, { action: 'fmea.created', entityType: FMEA, entityId: f.id, facilityId: f.facility_id, data: { number, kind: f.kind, method: f.method } });
  return f;
}

export interface RowInput {
  item: string; failureMode: string; effect: string; severity: number; cause: string; occurrence: number; preventionControls?: string | null; detectionControls?: string | null;
  detection: number; failureCode?: string | null; pmPlanId?: string | null;
}

/** Replaces the rows of a draft FMEA (the editor saves the whole sheet); priority is computed, never typed. */
export async function saveRows(tx: Tx, actor: Actor, id: string, rows: RowInput[]) {
  const f = await lockFmea(tx, id);
  if (!editor(actor, f)) throw forbidden('quality.manage (or own the FMEA)');
  if (f.status !== 'draft') throw conflict('only a draft can be edited; start a new revision');
  for (const [i, r] of rows.entries()) {
    for (const k of ['item', 'failureMode', 'effect', 'cause'] as const) if (!r[k]?.trim()) throw invalid(`row ${i + 1}: ${k.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)} is required`);
    for (const k of ['severity', 'occurrence', 'detection'] as const) if (!Number.isInteger(r[k]) || r[k] < 1 || r[k] > 10) throw invalid(`row ${i + 1}: ${k} must be a whole number from 1 to 10`);
    if (r.failureCode && f.kind !== 'equipment') throw invalid(`row ${i + 1}: failure codes link equipment FMEAs to work order history`);
    if (r.pmPlanId && !(await one(tx, 'SELECT 1 FROM pm_plan WHERE id = $1 AND ($2::uuid IS NULL OR asset_id = $2)', [r.pmPlanId, f.asset_id]))) throw invalid(`row ${i + 1}: the PM plan is not for this asset`);
  }
  // Keep row ids (actions and corrective actions point at them) by updating in place where the sequence matches.
  const existing = new Map((await many(tx, 'SELECT id, seq FROM fmea_row WHERE fmea_id = $1', [id])).map((r) => [r.seq as number, r.id as string]));
  for (const [i, r] of rows.entries()) {
    const seq = i + 1;
    const pr = priorityOf(f.method, f.rpn_threshold, r.severity, r.occurrence, r.detection);
    const vals = [r.item.trim(), r.failureMode.trim(), r.effect.trim(), r.severity, r.cause.trim(), r.occurrence, r.preventionControls ?? null, r.detectionControls ?? null, r.detection, pr, r.failureCode ?? null, r.pmPlanId ?? null];
    if (existing.has(seq)) {
      await tx.query(`UPDATE fmea_row SET item = $2, failure_mode = $3, effect = $4, severity = $5, cause = $6, occurrence = $7, prevention_controls = $8, detection_controls = $9,
        detection = $10, priority = $11, failure_code = $12, pm_plan_id = $13 WHERE id = $1`, [existing.get(seq), ...vals]);
      existing.delete(seq);
    } else {
      await tx.query(`INSERT INTO fmea_row (tenant_id, fmea_id, seq, item, failure_mode, effect, severity, cause, occurrence, prevention_controls, detection_controls, detection, priority, failure_code, pm_plan_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`, [actor.tenantId, id, seq, ...vals]);
    }
  }
  for (const rowId of existing.values()) {
    if (await one(tx, `SELECT 1 FROM action_item WHERE fmea_row_id = $1 AND status <> 'cancelled'`, [rowId])) throw conflict('a removed row has actions; cancel them first');
    await tx.query('DELETE FROM fmea_row WHERE id = $1', [rowId]);
  }
  await audit(tx, actor, { action: 'fmea.rows_saved', entityType: FMEA, entityId: id, facilityId: f.facility_id, data: { rows: rows.length } });
  return getFmea(tx, actor, id);
}

/**
 * Sends the FMEA for quality review. Every high-priority failure mode must have a recommended action or a
 * corrective action first (high priority means the team must act or record why not).
 */
export async function submitFmea(tx: Tx, actor: Actor, id: string) {
  const f = await lockFmea(tx, id);
  if (!editor(actor, f)) throw forbidden('quality.manage (or own the FMEA)');
  if (f.status !== 'draft') throw conflict(`FMEA is ${f.status}`);
  const rows = await many(tx, `SELECT r.seq, r.priority, r.capa_id, (SELECT count(*)::int FROM action_item a WHERE a.fmea_row_id = r.id AND a.status <> 'cancelled') AS actions
    FROM fmea_row r WHERE r.fmea_id = $1`, [id]);
  if (!rows.length) throw invalid('add at least one failure mode');
  const bare = rows.filter((r) => r.priority === 'H' && !r.actions && !r.capa_id).map((r) => r.seq);
  if (bare.length) throw invalid(`high-priority row${bare.length === 1 ? '' : 's'} ${bare.join(', ')} need${bare.length === 1 ? 's' : ''} a recommended action or a corrective action`);
  await tx.query(`UPDATE fmea SET status = 'in_review' WHERE id = $1`, [id]);
  await createApprovalRequest(tx, actor, { facilityId: f.facility_id, subjectType: FMEA, subjectId: id, subjectRevision: f.revision, purpose: PURPOSE,
    stages: [{ steps: [{ roleKey: 'quality_reviewer', label: 'Quality review of the FMEA' }] }] });
  await audit(tx, actor, { action: 'fmea.submitted', entityType: FMEA, entityId: id, facilityId: f.facility_id, data: { revision: f.revision, rows: rows.length } });
}

/** Approval engine callback: approval releases this revision (superseding the previous), rejection returns it to draft. */
export async function onFmeaDecided(tx: Tx, actor: Actor, id: string, purpose: string, status: string) {
  if (purpose !== PURPOSE) return;
  const f = await lockFmea(tx, id);
  if (status === 'approved') {
    await tx.query(`UPDATE fmea SET status = 'superseded' WHERE tenant_id = $1 AND number = $2 AND status = 'approved'`, [f.tenant_id, f.number]);
    await tx.query(`UPDATE fmea SET status = 'approved', approved_at = now(), review_due = coalesce(review_due, current_date + 365) WHERE id = $1`, [id]);
  } else if (status === 'rejected') {
    await tx.query(`UPDATE fmea SET status = 'draft' WHERE id = $1`, [id]);
  }
  await notify(tx, f.tenant_id, [f.owner_user_id], { kind: 'approval.decided', title: `${f.number} rev ${f.revision} ${status === 'approved' ? 'approved' : 'sent back'}`,
    link: `/quality/fmea/${id}`, subjectType: FMEA, subjectId: id, dedupeKey: `fmea-decided:${id}:${f.revision}:${status}` }, actor.userId);
}

/**
 * A new revision of an approved FMEA. Rows carry over; where actions were evaluated, the after-action scores
 * become the new baseline. Open actions stay with the rows they belong to.
 */
export async function reviseFmea(tx: Tx, actor: Actor, id: string, reason: string) {
  const f = await lockFmea(tx, id);
  if (!editor(actor, f)) throw forbidden('quality.manage (or own the FMEA)');
  if (f.status !== 'approved') throw conflict('only the approved revision can be revised');
  if (!reason?.trim()) throw invalid('say why (new failure, design change, periodic review…)');
  const next = await one(tx, `INSERT INTO fmea (tenant_id, facility_id, number, revision, kind, title, scope, method, rpn_threshold, asset_id, part_id, document_id, team, owner_user_id, review_due, created_by)
    SELECT tenant_id, facility_id, number, revision + 1, kind, title, scope, method, rpn_threshold, asset_id, part_id, document_id, team, owner_user_id, NULL, $2 FROM fmea WHERE id = $1 RETURNING *`, [id, actor.userId]);
  const rows = await many(tx, 'SELECT * FROM fmea_row WHERE fmea_id = $1 ORDER BY seq', [id]);
  for (const r of rows) {
    const s = r.post_severity ?? r.severity; const o = r.post_occurrence ?? r.occurrence; const d = r.post_detection ?? r.detection;
    const n = await one(tx, `INSERT INTO fmea_row (tenant_id, fmea_id, seq, item, failure_mode, effect, severity, cause, occurrence, prevention_controls, detection_controls, detection, priority, failure_code, pm_plan_id, capa_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [actor.tenantId, next.id, r.seq, r.item, r.failure_mode, r.effect, s, r.cause, o, r.prevention_controls, r.detection_controls, d, priorityOf(f.method, f.rpn_threshold, s, o, d), r.failure_code, r.pm_plan_id, r.capa_id]);
    await tx.query(`UPDATE action_item SET subject_id = $3, fmea_row_id = $2 WHERE fmea_row_id = $1 AND status = 'open'`, [r.id, n.id, next.id]);
  }
  await audit(tx, actor, { action: 'fmea.revised', entityType: FMEA, entityId: next.id, facilityId: f.facility_id, data: { from: f.revision, to: next.revision, reason } });
  return next;
}

/** Records the risk after the recommended actions on an approved FMEA (the "post" columns). */
export async function evaluateRow(tx: Tx, actor: Actor, rowId: string, input: { severity: number; occurrence: number; detection: number }) {
  const r = await one(tx, 'SELECT r.*, f.owner_user_id, f.facility_id, f.method, f.rpn_threshold, f.status FROM fmea_row r JOIN fmea f ON f.id = r.fmea_id WHERE r.id = $1', [rowId]);
  if (!r) throw notFound('FMEA row');
  if (!editor(actor, r)) throw forbidden('quality.manage (or own the FMEA)');
  if (r.status !== 'approved') throw conflict('evaluate actions on the approved revision');
  for (const k of ['severity', 'occurrence', 'detection'] as const) if (!Number.isInteger(input[k]) || input[k] < 1 || input[k] > 10) throw invalid(`${k} must be a whole number from 1 to 10`);
  if (input.severity > r.severity) throw invalid('actions do not raise severity; if the effect is worse than thought, revise the FMEA');
  const open = await one(tx, `SELECT count(*)::int AS n FROM action_item WHERE fmea_row_id = $1 AND status = 'open'`, [rowId]);
  if (open.n) throw conflict('finish the row\'s actions before evaluating their effect');
  const pr = priorityOf(r.method, r.rpn_threshold, input.severity, input.occurrence, input.detection);
  await tx.query('UPDATE fmea_row SET post_severity = $2, post_occurrence = $3, post_detection = $4, post_priority = $5 WHERE id = $1', [rowId, input.severity, input.occurrence, input.detection, pr]);
  await audit(tx, actor, { action: 'fmea.row_evaluated', entityType: FMEA, entityId: r.fmea_id, facilityId: r.facility_id, data: { seq: r.seq, before: [r.severity, r.occurrence, r.detection, r.priority], after: [input.severity, input.occurrence, input.detection, pr] } });
  return { priority: pr };
}

/** Opens a corrective action for a failure mode (for example after it actually occurred) and links it to the row. */
export async function capaForRow(tx: Tx, actor: Actor, rowId: string, input: { ownerUserId: string }) {
  const r = await one(tx, 'SELECT r.*, f.number, f.facility_id, f.status FROM fmea_row r JOIN fmea f ON f.id = r.fmea_id WHERE r.id = $1', [rowId]);
  if (!r) throw notFound('FMEA row');
  if (r.capa_id) throw conflict('this failure mode already has a corrective action');
  const c = await createCapa(tx, actor, { facilityId: r.facility_id, source: 'fmea', ownerUserId: input.ownerUserId, priority: r.priority === 'H' ? 'high' : 'medium',
    title: `${r.number} row ${r.seq}: ${r.failure_mode}`.slice(0, 200), problem: `Failure mode: ${r.failure_mode}\nEffect: ${r.effect}\nCause: ${r.cause}\nCurrent controls: ${r.prevention_controls ?? '—'} / ${r.detection_controls ?? '—'}` });
  await tx.query('UPDATE fmea_row SET capa_id = $2 WHERE id = $1', [rowId, c.id]);
  return c;
}

export async function getFmea(tx: Tx, actor: Actor, id: string) {
  const f = await one(tx, `SELECT f.*, fc.code AS facility_code, a.asset_tag, p.part_number, d.title AS document_title, u.display_name AS owner_name,
      (f.status = 'approved' AND f.review_due < current_date) AS review_overdue
    FROM fmea f JOIN facility fc ON fc.id = f.facility_id LEFT JOIN asset a ON a.id = f.asset_id LEFT JOIN part p ON p.id = f.part_id LEFT JOIN document d ON d.id = f.document_id
    JOIN app_user u ON u.id = f.owner_user_id WHERE f.id = $1`, [id]);
  if (!f) throw notFound('FMEA');
  if (!can(actor, 'quality.view', f.facility_id) && f.owner_user_id !== actor.userId) throw forbidden('quality.view');
  const rows = await many(tx, `SELECT r.*, pm.code AS pm_code, c.number AS capa_number, c.status AS capa_status,
      (r.severity * r.occurrence * r.detection) AS rpn, (r.post_severity * r.post_occurrence * r.post_detection) AS post_rpn
    FROM fmea_row r LEFT JOIN pm_plan pm ON pm.id = r.pm_plan_id LEFT JOIN corrective_action c ON c.id = r.capa_id WHERE r.fmea_id = $1 ORDER BY r.seq`, [id]);
  const actions = await listActions(tx, 'fmea', id);
  // Equipment FMEA: how often each failure mode actually happened (corrective work orders with its failure code).
  const observed = f.asset_id ? new Map((await many(tx, `SELECT failure_code, count(*)::int AS n, max(completed_at) AS last FROM work_order
      WHERE asset_id = $1 AND wo_type = 'corrective' AND failure_code IS NOT NULL AND created_at > now() - interval '365 days' GROUP BY failure_code`, [f.asset_id])).map((x) => [x.failure_code as string, x])) : new Map();
  const enriched = rows.map((r) => {
    const obs = r.failure_code ? observed.get(r.failure_code) : undefined;
    return { ...r, actions: actions.filter((a: any) => a.fmea_row_id === r.id), observed_12m: obs?.n ?? (r.failure_code ? 0 : null), last_observed: obs?.last ?? null,
      // Two or more real failures in a year sits badly with an occurrence rating of 3 or less.
      occurrence_check: obs && obs.n >= 2 && r.occurrence <= 3 ? `happened ${obs.n} times in 12 months; occurrence ${r.occurrence} may be too low` : null };
  });
  const revisions = await many(tx, 'SELECT id, revision, status, approved_at FROM fmea WHERE tenant_id = $1 AND number = $2 ORDER BY revision DESC', [f.tenant_id, f.number]);
  return { ...f, rows: enriched, actions, revisions, canEdit: editor(actor, f),
    summary: { H: rows.filter((r) => r.priority === 'H').length, M: rows.filter((r) => r.priority === 'M').length, L: rows.filter((r) => r.priority === 'L').length,
      postH: rows.filter((r) => (r.post_priority ?? r.priority) === 'H').length } };
}

export async function listFmeas(tx: Tx, actor: Actor) {
  const rows = await many(tx, `SELECT f.id, f.number, f.revision, f.kind, f.title, f.status, f.method, f.review_due, f.facility_id, f.owner_user_id, fc.code AS facility_code,
      a.asset_tag, p.part_number, u.display_name AS owner_name, (f.status = 'approved' AND f.review_due < current_date) AS review_overdue,
      (SELECT count(*)::int FROM fmea_row r WHERE r.fmea_id = f.id AND coalesce(r.post_priority, r.priority) = 'H') AS high,
      (SELECT count(*)::int FROM action_item x WHERE x.subject_type = 'fmea' AND x.subject_id = f.id AND x.status = 'open') AS open_actions
    FROM fmea f JOIN facility fc ON fc.id = f.facility_id LEFT JOIN asset a ON a.id = f.asset_id LEFT JOIN part p ON p.id = f.part_id JOIN app_user u ON u.id = f.owner_user_id
    WHERE f.status <> 'superseded' ORDER BY f.number`);
  return rows.filter((r) => can(actor, 'quality.view', r.facility_id) || r.owner_user_id === actor.userId);
}

