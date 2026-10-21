import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { addPart, attachProcedure, createWorkOrder } from '../maintenance/service.js';
import { addDays, dueState, latestMeter } from './schedule.js';

export interface PlanInput {
  assetId: string;
  code: string;
  title: string;
  instructions?: string | null;
  triggerType: 'calendar' | 'meter';
  intervalDays?: number | null;
  meter?: string | null;
  intervalMeter?: number | null;
  scheduleBasis?: 'completion' | 'fixed';
  leadDays?: number;
  leadMeter?: number;
  firstDueOn?: string | null;
  firstDueMeter?: number | null;
  estimatedHours?: number | null;
  priority?: 1 | 2 | 3 | 4;
  documentId?: string | null;
  parts?: { partId: string; qty: number }[];
}

const today = () => new Date().toISOString().slice(0, 10);

export async function createPlan(tx: Tx, actor: Actor, input: PlanInput) {
  const asset = await one(tx, 'SELECT id, facility_id FROM asset WHERE id = $1', [input.assetId]);
  if (!asset) throw notFound('asset');
  requirePermission(actor, 'work_orders.manage', asset.facility_id);
  if (await one(tx, 'SELECT 1 FROM pm_plan WHERE code = $1', [input.code])) throw conflict(`PM plan ${input.code} already exists`);
  let nextDueOn: string | null = null;
  let nextDueMeter: number | null = null;
  if (input.triggerType === 'calendar') {
    if (!input.intervalDays) throw invalid('calendar plans need an interval in days');
    nextDueOn = input.firstDueOn ?? addDays(today(), input.intervalDays);
  } else {
    if (!input.meter || !input.intervalMeter) throw invalid('meter plans need a meter name and interval');
    const latest = await latestMeter(tx, asset.id, input.meter);
    nextDueMeter = input.firstDueMeter ?? (latest ?? 0) + input.intervalMeter;
  }
  if (input.documentId && !(await one(tx, 'SELECT 1 FROM document WHERE id = $1', [input.documentId]))) throw invalid('procedure document not found');
  const plan = await one(
    tx,
    `INSERT INTO pm_plan (tenant_id, facility_id, asset_id, code, title, instructions, trigger_type, interval_days, meter, interval_meter, schedule_basis,
       lead_days, lead_meter, next_due_on, next_due_meter, estimated_hours, priority, document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
    [actor.tenantId, asset.facility_id, asset.id, input.code, input.title, input.instructions ?? null, input.triggerType,
      input.triggerType === 'calendar' ? input.intervalDays : null, input.triggerType === 'meter' ? input.meter : null,
      input.triggerType === 'meter' ? input.intervalMeter : null, input.scheduleBasis ?? 'completion', input.leadDays ?? 7, input.leadMeter ?? 0,
      nextDueOn, nextDueMeter, input.estimatedHours ?? null, input.priority ?? 3, input.documentId ?? null],
  );
  for (const p of input.parts ?? []) {
    if (!(p.qty > 0)) throw invalid('parts list quantities must be positive');
    await tx.query('INSERT INTO pm_plan_part (tenant_id, plan_id, part_id, qty) VALUES ($1, $2, $3, $4)', [actor.tenantId, plan.id, p.partId, p.qty]);
  }
  await audit(tx, actor, { action: 'pm.plan_created', entityType: 'pm_plan', entityId: plan.id, facilityId: plan.facility_id,
    data: { code: plan.code, trigger: plan.trigger_type, nextDueOn, nextDueMeter } });
  return plan;
}

export async function setPlanActive(tx: Tx, actor: Actor, planId: string, active: boolean, reason: string) {
  const p = await one(tx, 'SELECT * FROM pm_plan WHERE id = $1 FOR UPDATE', [planId]);
  if (!p) throw notFound('PM plan');
  requirePermission(actor, 'work_orders.manage', p.facility_id);
  if (!reason || reason.trim().length < 5) throw invalid('a reason is required');
  await tx.query('UPDATE pm_plan SET active = $2 WHERE id = $1', [planId, active]);
  await audit(tx, actor, { action: active ? 'pm.plan_activated' : 'pm.plan_paused', entityType: 'pm_plan', entityId: planId, facilityId: p.facility_id, data: { reason } });
}

/** Meter readings must not go backwards (a replaced meter needs a reset procedure, not yet supported). */
export async function recordMeter(tx: Tx, actor: Actor, assetId: string, input: { meter: string; value: number; readAt?: Date }) {
  const a = await one(tx, 'SELECT id, facility_id FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'assets.record_state', a.facility_id);
  const prev = await one(tx, 'SELECT value, read_at FROM asset_meter_reading WHERE asset_id = $1 AND meter = $2 ORDER BY read_at DESC, id DESC LIMIT 1', [assetId, input.meter]);
  const at = input.readAt ?? new Date();
  if (prev && at < prev.read_at) throw invalid('a newer reading is already recorded');
  if (prev && input.value < Number(prev.value)) throw invalid(`reading ${input.value} is lower than the last reading ${prev.value}`);
  await tx.query('INSERT INTO asset_meter_reading (tenant_id, facility_id, asset_id, meter, value, read_at, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [actor.tenantId, a.facility_id, assetId, input.meter, input.value, at, actor.userId]);
  await audit(tx, actor, { action: 'asset.meter_recorded', entityType: 'asset', entityId: assetId, facilityId: a.facility_id, data: { meter: input.meter, value: input.value } });
}

/** Schedule with due state, open work order and parts availability (stock across the facility's storerooms). */
export async function pmSchedule(tx: Tx, actor: Actor, q: { facilityId?: string; assetId?: string; horizonDays?: number } = {}) {
  requirePermission(actor, 'work_orders.view', q.facilityId);
  const day = today();
  const horizon = addDays(day, q.horizonDays ?? 60);
  const plans = await many(
    tx,
    `SELECT p.*, a.asset_tag, a.name AS asset_name, f.code AS facility_code,
            (SELECT json_build_object('id', w.id, 'number', w.number, 'status', w.status) FROM work_order w
              WHERE w.pm_plan_id = p.id AND w.status IN ('planned','scheduled','in_progress','on_hold','completed') LIMIT 1) AS open_work_order
     FROM pm_plan p JOIN asset a ON a.id = p.asset_id JOIN facility f ON f.id = p.facility_id
     WHERE p.active AND ($1::uuid IS NULL OR p.facility_id = $1) AND ($2::uuid IS NULL OR p.asset_id = $2)
     ORDER BY p.next_due_on NULLS LAST, p.code`,
    [q.facilityId ?? null, q.assetId ?? null],
  );
  const out = [];
  for (const p of plans) {
    if (!can(actor, 'work_orders.view', p.facility_id)) continue;
    const latest = p.trigger_type === 'meter' ? await latestMeter(tx, p.asset_id, p.meter) : null;
    const parts = await many(
      tx,
      `SELECT pp.part_id, pp.qty, pt.part_number, pt.description,
              coalesce((SELECT sum(b.qty_on_hand) FROM inventory_balance b WHERE b.part_id = pp.part_id AND b.facility_id = $2), 0)::float AS on_hand,
              EXISTS (SELECT 1 FROM inventory_balance b WHERE b.part_id = pp.part_id AND b.facility_id = $2) AS stocked
       FROM pm_plan_part pp JOIN part pt ON pt.id = pp.part_id WHERE pp.plan_id = $1 ORDER BY pt.part_number`,
      [p.id, p.facility_id],
    );
    const state = dueState(p, day, latest);
    const remaining = p.trigger_type === 'meter' && latest != null ? Math.round((Number(p.next_due_meter) - latest) * 100) / 100 : null;
    out.push({
      ...p, latest_meter: latest, meter_remaining: remaining, due_state: state,
      within_horizon: p.trigger_type === 'calendar' ? p.next_due_on <= horizon : state !== 'not_due',
      parts: parts.map((x) => ({ ...x, short: x.stocked && x.on_hand < Number(x.qty) })),
      parts_short: parts.filter((x) => x.stocked && x.on_hand < Number(x.qty)).length,
    });
  }
  return out;
}

/**
 * Creates preventive work orders for every active plan that is due (within its lead window) and has
 * no open work order. Safe to run repeatedly (a unique index allows one open WO per plan). Planned
 * parts come from the plan's parts list; the plan's procedure is attached at its current approved version.
 */
export async function generatePmWorkOrders(tx: Tx, actor: Actor, q: { facilityId?: string } = {}) {
  requirePermission(actor, 'work_orders.manage', q.facilityId);
  const schedule = await pmSchedule(tx, actor, { facilityId: q.facilityId });
  const created: { plan: string; workOrder: string; dueState: string }[] = [];
  const skipped: { plan: string; reason: string }[] = [];
  for (const p of schedule) {
    if (p.due_state === 'not_due') continue;
    if (p.open_work_order) { skipped.push({ plan: p.code, reason: `open work order ${p.open_work_order.number}` }); continue; }
    if (!can(actor, 'work_orders.manage', p.facility_id)) { skipped.push({ plan: p.code, reason: 'no permission at facility' }); continue; }
    const dueAt = p.trigger_type === 'calendar' ? new Date(`${p.next_due_on}T17:00:00Z`).toISOString() : new Date(Date.now() + p.lead_days * 86_400_000).toISOString();
    const wo = await createWorkOrder(tx, actor, {
      assetId: p.asset_id, title: `PM: ${p.title}`, woType: 'preventive', priority: p.priority, dueAt,
      description: [p.instructions, p.trigger_type === 'meter' ? `Due at ${p.next_due_meter} ${p.meter} (latest reading ${p.latest_meter ?? 'none'}).` : `Due ${p.next_due_on}.`].filter(Boolean).join('\n'),
      estimatedLaborHours: p.estimated_hours,
    });
    await tx.query('UPDATE work_order SET pm_plan_id = $2, pm_due_meter = $3 WHERE id = $1', [wo.id, p.id, p.trigger_type === 'meter' ? p.next_due_meter : null]);
    for (const part of p.parts) await addPart(tx, actor, wo.id, { partId: part.part_id, qtyPlanned: Number(part.qty) });
    if (p.document_id) {
      const doc = await one(tx, 'SELECT current_version_id FROM document WHERE id = $1', [p.document_id]);
      if (doc?.current_version_id) await attachProcedure(tx, actor, wo.id, doc.current_version_id);
    }
    await audit(tx, actor, { action: 'pm.work_order_generated', entityType: 'pm_plan', entityId: p.id, facilityId: p.facility_id, data: { workOrderId: wo.id, number: wo.number, dueState: p.due_state } });
    created.push({ plan: p.code, workOrder: wo.number, dueState: p.due_state });
  }
  return { created, skipped };
}

export async function getPlan(tx: Tx, actor: Actor, planId: string) {
  const p = await one(tx, `SELECT p.*, a.asset_tag, a.name AS asset_name, d.doc_number FROM pm_plan p JOIN asset a ON a.id = p.asset_id
                           LEFT JOIN document d ON d.id = p.document_id WHERE p.id = $1`, [planId]);
  if (!p) throw notFound('PM plan');
  requirePermission(actor, 'work_orders.view', p.facility_id);
  const parts = await many(tx, 'SELECT pp.qty, pt.id AS part_id, pt.part_number, pt.description, pt.uom FROM pm_plan_part pp JOIN part pt ON pt.id = pp.part_id WHERE pp.plan_id = $1', [planId]);
  const history = await many(tx, `SELECT id, number, status, due_at, completed_at, verified_at,
      (completed_at IS NOT NULL AND completed_at::date <= due_at::date) AS on_time FROM work_order WHERE pm_plan_id = $1 ORDER BY due_at DESC LIMIT 20`, [planId]);
  const latest = p.trigger_type === 'meter' ? await latestMeter(tx, p.asset_id, p.meter) : null;
  return { ...p, parts, history, latest_meter: latest, due_state: dueState(p, today(), latest) };
}
