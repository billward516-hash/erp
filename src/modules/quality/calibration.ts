import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { applyState } from '../assets/service.js';
import { createNcr } from './service.js';

const PLAN = 'calibration_plan';
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DUE_SOON_DAYS = 14;

/** Refuses production use of an instrument whose calibration is overdue (called when a run starts on a machine). */
export async function assertCalibrated(tx: Tx, assetId: string) {
  const p = await one(tx, `SELECT p.next_due, a.asset_tag FROM calibration_plan p JOIN asset a ON a.id = p.asset_id WHERE p.asset_id = $1 AND p.active`, [assetId]);
  if (p && p.next_due < today()) throw conflict(`${p.asset_tag} is overdue for calibration (due ${p.next_due}); calibrate it before using it for production`);
}

const statusOf = (p: { next_due: string; active: boolean; operational_state?: string; last_as_left?: string | null }) =>
  !p.active ? 'inactive' : p.last_as_left === 'failed' ? 'failed' : p.next_due < today() ? 'overdue' : p.next_due <= addDays(today(), DUE_SOON_DAYS) ? 'due_soon' : 'current';

export async function listCalibration(tx: Tx, actor: Actor, q: { facilityId?: string } = {}) {
  requirePermission(actor, 'quality.view');
  const rows = await many(tx, `SELECT p.*, a.asset_tag, a.name AS asset_name, a.operational_state, f.code AS facility_code, s.name AS supplier_name,
      (SELECT max(r.performed_on) FROM calibration_record r WHERE r.plan_id = p.id) AS last_calibrated,
      (SELECT r.as_left FROM calibration_record r WHERE r.plan_id = p.id ORDER BY r.performed_on DESC, r.created_at DESC LIMIT 1) AS last_as_left
    FROM calibration_plan p JOIN asset a ON a.id = p.asset_id JOIN facility f ON f.id = p.facility_id LEFT JOIN supplier s ON s.id = p.supplier_id
    WHERE ($1::uuid IS NULL OR p.facility_id = $1) ORDER BY p.next_due`, [q.facilityId ?? null]);
  return rows.filter((r) => can(actor, 'quality.view', r.facility_id)).map((r) => ({ ...r, status: statusOf(r) }));
}

export async function savePlan(tx: Tx, actor: Actor, input: { assetId: string; intervalDays: number; tolerance: string; method?: string | null; provider?: 'internal' | 'external';
  supplierId?: string | null; procedureDocumentId?: string | null; nextDue?: string | null; active?: boolean }) {
  const a = await one(tx, 'SELECT id, facility_id, asset_tag FROM asset WHERE id = $1', [input.assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'quality.manage', a.facility_id);
  if (!(input.intervalDays >= 1)) throw invalid('the interval must be at least one day');
  if (!input.tolerance?.trim()) throw invalid('state the tolerance the instrument must meet');
  if (input.provider === 'external' && !input.supplierId) throw invalid('choose the calibration lab (supplier)');
  const p = await one(tx, `INSERT INTO calibration_plan (tenant_id, facility_id, asset_id, interval_days, tolerance, method, provider, supplier_id, procedure_document_id, next_due, active, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, true), $12)
    ON CONFLICT (asset_id) DO UPDATE SET interval_days = EXCLUDED.interval_days, tolerance = EXCLUDED.tolerance, method = EXCLUDED.method, provider = EXCLUDED.provider,
      supplier_id = EXCLUDED.supplier_id, procedure_document_id = EXCLUDED.procedure_document_id, next_due = coalesce($13, calibration_plan.next_due), active = EXCLUDED.active
    RETURNING *`,
  [actor.tenantId, a.facility_id, a.id, input.intervalDays, input.tolerance.trim(), input.method ?? null, input.provider ?? 'internal', input.supplierId ?? null,
    input.procedureDocumentId ?? null, input.nextDue ?? today(), input.active ?? null, actor.userId, input.nextDue ?? null]);
  await audit(tx, actor, { action: 'calibration.plan_saved', entityType: PLAN, entityId: p.id, facilityId: p.facility_id, data: { asset: a.asset_tag, intervalDays: input.intervalDays, tolerance: input.tolerance } });
  return p;
}

/** Production runs on the instrument since its last good (as-found in tolerance) calibration: the measurements now in doubt. */
async function suspectRuns(tx: Tx, planId: string, assetId: string, until: string) {
  const since = (await one(tx, `SELECT max(performed_on) AS d FROM calibration_record WHERE plan_id = $1 AND as_found = 'in_tolerance' AND performed_on <= $2`, [planId, until]))?.d
    ?? (await one(tx, 'SELECT created_at::date AS d FROM calibration_plan WHERE id = $1', [planId])).d;
  const runs = await many(tx, `SELECT o.id AS order_id, o.number, p.part_number, op.op_no, sum(e.qty_good)::float AS good, min(e.started_at) AS first_at, max(e.ended_at) AS last_at
    FROM production_entry e JOIN production_order o ON o.id = e.order_id JOIN production_operation op ON op.id = e.operation_id JOIN part p ON p.id = o.part_id
    WHERE e.asset_id = $1 AND e.started_at >= $2::date AND e.started_at < ($3::date + 1) GROUP BY o.id, o.number, p.part_number, op.op_no ORDER BY min(e.started_at)`, [assetId, since, until]);
  return { since: since as string, runs };
}

/**
 * Records a calibration. As-found out of tolerance means measurements since the last good calibration are in
 * doubt: a major nonconformance is raised listing the production runs that used the instrument, for quality
 * to assess. As-left failed takes the instrument out of service; a later passing calibration returns it.
 */
export async function recordCalibration(tx: Tx, actor: Actor, planId: string, input: { performedOn: string; performedBy: string; asFound: 'in_tolerance' | 'out_of_tolerance';
  asLeft: 'in_tolerance' | 'adjusted' | 'failed'; certificateNo?: string | null; notes?: string | null }) {
  const p = await one(tx, `SELECT p.*, a.asset_tag, a.operational_state FROM calibration_plan p JOIN asset a ON a.id = p.asset_id WHERE p.id = $1 FOR UPDATE OF p`, [planId]);
  if (!p) throw notFound('calibration plan');
  requirePermission(actor, 'quality.manage', p.facility_id);
  if (input.performedOn > today()) throw invalid('the calibration date cannot be in the future');
  if (!input.performedBy?.trim()) throw invalid('say who calibrated it (person or lab)');
  if (input.asFound === 'out_of_tolerance' && !input.notes?.trim()) throw invalid('record the as-found readings that were out of tolerance');
  if (input.asFound === 'out_of_tolerance' && input.asLeft === 'in_tolerance') throw invalid('an instrument found out of tolerance must be adjusted (or failed) before it is in tolerance');
  let ncrId: string | null = null;
  if (input.asFound === 'out_of_tolerance') {
    const s = await suspectRuns(tx, planId, p.asset_id, input.performedOn);
    const lines = s.runs.map((r) => `${r.number} op ${r.op_no} (${r.part_number}): ${r.good} good units measured ${String(r.first_at).slice(0, 10)}–${String(r.last_at ?? r.first_at).slice(0, 10)}`);
    const n = await createNcr(tx, actor, { facilityId: p.facility_id, source: 'internal', severity: 'major', assetId: p.asset_id,
      title: `${p.asset_tag} found out of tolerance at calibration on ${input.performedOn}`,
      description: [`As found: ${input.notes!.trim()}`, `Tolerance: ${p.tolerance}.`, '',
        s.runs.length ? `Measurements since the last good calibration (${s.since}) are in doubt. Assess the product from these runs:` : `No production runs used ${p.asset_tag} since the last good calibration (${s.since}).`,
        ...lines].join('\n') });
    ncrId = n.id;
  }
  const nextDue = input.asLeft === 'failed' ? null : addDays(input.performedOn, p.interval_days);
  const r = await one(tx, `INSERT INTO calibration_record (tenant_id, facility_id, plan_id, asset_id, performed_on, performed_by, as_found, as_left, certificate_no, notes, next_due, ncr_id, recorded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
  [actor.tenantId, p.facility_id, planId, p.asset_id, input.performedOn, input.performedBy.trim(), input.asFound, input.asLeft, input.certificateNo ?? null, input.notes ?? null, nextDue, ncrId, actor.userId]);
  if (nextDue) await tx.query('UPDATE calibration_plan SET next_due = $2 WHERE id = $1', [planId, nextDue]);
  if (input.asLeft === 'failed' && p.operational_state !== 'out_of_service') {
    await applyState(tx, actor, p.asset_id, { state: 'out_of_service', note: `Failed calibration ${input.performedOn}` });
  } else if (input.asLeft !== 'failed' && p.operational_state === 'out_of_service') {
    const last = await one(tx, `SELECT as_left FROM calibration_record WHERE plan_id = $1 AND id <> $2 ORDER BY performed_on DESC, created_at DESC LIMIT 1`, [planId, r.id]);
    if (last?.as_left === 'failed') await applyState(tx, actor, p.asset_id, { state: 'available', note: `Passed calibration ${input.performedOn}` });
  }
  await audit(tx, actor, { action: 'calibration.recorded', entityType: PLAN, entityId: planId, facilityId: p.facility_id,
    data: { asset: p.asset_tag, performedOn: input.performedOn, asFound: input.asFound, asLeft: input.asLeft, nextDue, ncrId, certificate: input.certificateNo ?? null } });
  return { id: r.id as string, nextDue, ncrId };
}

export async function getPlan(tx: Tx, actor: Actor, id: string) {
  const p = (await listCalibration(tx, actor)).find((x) => x.id === id);
  if (!p) throw notFound('calibration plan');
  const records = await many(tx, `SELECT r.*, n.number AS ncr_number, u.display_name AS recorded_by_name FROM calibration_record r LEFT JOIN nonconformance n ON n.id = r.ncr_id
    JOIN app_user u ON u.id = r.recorded_by WHERE r.plan_id = $1 ORDER BY r.performed_on DESC, r.created_at DESC`, [id]);
  const usage = await suspectRuns(tx, id, p.asset_id, today());
  return { ...p, records, usageSinceLastGood: usage };
}
