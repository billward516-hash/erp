import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';

/**
 * PM scheduling rules (pure functions + one hook), kept free of maintenance imports so the work-order
 * module can call advancePlanOnCompletion without a circular dependency.
 *
 * - Due window: a calendar plan is due from (next_due_on − lead_days); a meter plan is due once the
 *   latest reading reaches (next_due_meter − lead_meter). Overdue = past the due date / due reading.
 * - Next due after completion:
 *     'completion' basis → interval counted from when the work was actually done (floating);
 *     'fixed' basis      → interval counted from the previous due point, skipping cycles already
 *                          passed, so the schedule keeps its anchor (e.g. every quarter-start).
 */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type DueState = 'not_due' | 'due' | 'overdue';

export interface PlanLike {
  trigger_type: 'calendar' | 'meter';
  interval_days: number | null;
  interval_meter: number | null;
  schedule_basis: 'completion' | 'fixed';
  lead_days: number;
  lead_meter: number;
  next_due_on: string | null;
  next_due_meter: number | null;
}

export function dueState(plan: PlanLike, today: string, latestMeter: number | null): DueState {
  if (plan.trigger_type === 'calendar') {
    if (today > plan.next_due_on!) return 'overdue';
    return today >= addDays(plan.next_due_on!, -plan.lead_days) ? 'due' : 'not_due';
  }
  if (latestMeter == null) return 'not_due';
  if (latestMeter > Number(plan.next_due_meter)) return 'overdue';
  return latestMeter >= Number(plan.next_due_meter) - Number(plan.lead_meter) ? 'due' : 'not_due';
}

export function nextDue(plan: PlanLike, doneOn: string, doneMeter: number | null): { nextDueOn?: string; nextDueMeter?: number } {
  if (plan.trigger_type === 'calendar') {
    const step = plan.interval_days!;
    if (plan.schedule_basis === 'completion') return { nextDueOn: addDays(doneOn, step) };
    let next = addDays(plan.next_due_on!, step);
    while (next <= doneOn) next = addDays(next, step);
    return { nextDueOn: next };
  }
  const step = Number(plan.interval_meter);
  const base = doneMeter ?? Number(plan.next_due_meter);
  if (plan.schedule_basis === 'completion') return { nextDueMeter: Math.round((base + step) * 100) / 100 };
  let next = Number(plan.next_due_meter) + step;
  while (next <= base) next += step;
  return { nextDueMeter: Math.round(next * 100) / 100 };
}

export async function latestMeter(tx: Tx, assetId: string, meter: string): Promise<number | null> {
  const r = await one(tx, 'SELECT value FROM asset_meter_reading WHERE asset_id = $1 AND meter = $2 ORDER BY read_at DESC, id DESC LIMIT 1', [assetId, meter]);
  return r ? Number(r.value) : null;
}

/** Called when a PM work order is verified (work confirmed done): records completion and moves the plan forward. */
export async function advancePlanOnCompletion(tx: Tx, wo: { pm_plan_id: string | null; completed_at: Date | null; asset_id: string }) {
  if (!wo.pm_plan_id) return null;
  const plan = await one(tx, 'SELECT * FROM pm_plan WHERE id = $1 FOR UPDATE', [wo.pm_plan_id]);
  if (!plan) return null;
  const doneOn = (wo.completed_at ?? new Date()).toISOString().slice(0, 10);
  const doneMeter = plan.trigger_type === 'meter' ? await latestMeter(tx, wo.asset_id, plan.meter) : null;
  const n = nextDue(plan, doneOn, doneMeter);
  await tx.query(
    `UPDATE pm_plan SET last_done_on = $2, last_done_meter = $3, next_due_on = coalesce($4, next_due_on), next_due_meter = coalesce($5, next_due_meter) WHERE id = $1`,
    [plan.id, doneOn, doneMeter, n.nextDueOn ?? null, n.nextDueMeter ?? null],
  );
  return { planId: plan.id as string, doneOn, ...n };
}
