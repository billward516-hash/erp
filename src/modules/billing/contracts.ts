import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { money } from './rates.js';

/**
 * Fixed-price terms (SC-009 a2). THE ADAPTER SEAM: `getBillableContract` is the one function the billing run, the WIP report and the
 * pages use to learn a project's contract value, method, progress and milestones. Here it reads this module's own tables
 * (billing_contract, billing_milestone, set in the Billing page). If the projects module provides its own contract record with the same
 * answer, change only this function (and `setTerms`) to read it. Nothing outside this file reads those tables for contract data.
 */
export interface BillableContract {
  projectId: string; projectNumber: string; projectName: string; customerId: string | null; facilityId: string; billingType: string;
  contractValue: number | null; method: 'milestone' | 'percent_complete' | null; percentComplete: number;
  /** Earned so far: percent of the contract value, or the sum of reached milestones. */
  earned: number;
  /** Billed so far, net of write-downs, on live invoices; and value written off. */
  billed: number; writtenOff: number;
  /** Earned and neither billed nor written off: what a billing run would bill now. */
  unbilledEarned: number;
  /** Contract value not yet earned. */
  remaining: number | null;
  milestones: { id: string; name: string; amount: number; dueDate: string | null; status: 'pending' | 'reached'; reachedOn: string | null; billed: boolean; held: boolean; holdReason: string | null }[];
}

async function projectOf(tx: Tx, projectId: string) {
  const p = await one(tx, 'SELECT id, number, name, customer_id, facility_id, billing_type FROM project WHERE id = $1', [projectId]);
  if (!p) throw notFound('project');
  return p;
}

/** Live claims on a project's fixed-price billing: list value consumed (billed or written off) and net billed. */
async function claimTotals(tx: Tx, projectId: string) {
  const r = await one(tx, `SELECT coalesce(sum(list_amount), 0)::float AS consumed, coalesce(sum(amount) FILTER (WHERE status = 'billed'), 0)::float AS billed,
      coalesce(sum(list_amount) FILTER (WHERE status = 'written_off'), 0)::float AS written_off,
      coalesce(sum(list_amount) FILTER (WHERE source_kind = 'percent'), 0)::float AS percent_consumed
    FROM billing_claim WHERE project_id = $1 AND source_kind IN ('milestone', 'percent') AND released_at IS NULL`, [projectId]);
  return { consumed: money(r.consumed), billed: money(r.billed), writtenOff: money(r.written_off), percentConsumed: money(r.percent_consumed) };
}

export async function getBillableContract(tx: Tx, actor: Actor, projectId: string): Promise<BillableContract> {
  const p = await projectOf(tx, projectId);
  requirePermission(actor, 'billing.view', p.facility_id);
  return readContract(tx, p);
}

export async function readContract(tx: Tx, p: { id: string; number: string; name: string; customer_id: string | null; facility_id: string; billing_type: string }): Promise<BillableContract> {
  const c = await one(tx, 'SELECT contract_value::float AS value, method, percent_complete::float AS pct FROM billing_contract WHERE project_id = $1', [p.id]);
  const ms = await many(tx, `SELECT m.id, m.name, m.amount::float AS amount, m.due_date, m.status, m.reached_on, h.reason AS hold_reason,
      EXISTS (SELECT 1 FROM billing_claim k WHERE k.source_kind = 'milestone' AND k.source_id = m.id AND k.released_at IS NULL) AS billed
    FROM billing_milestone m LEFT JOIN billing_hold h ON h.source_kind = 'milestone' AND h.source_id = m.id WHERE m.project_id = $1 ORDER BY m.sort_no, m.created_at`, [p.id]);
  const t = await claimTotals(tx, p.id);
  const value: number | null = c?.value ?? null;
  const method = (c?.method ?? null) as BillableContract['method'];
  const pct: number = c?.pct ?? 0;
  const earned = method === 'percent_complete' ? money(((value ?? 0) * pct) / 100) : method === 'milestone' ? money(ms.filter((m) => m.status === 'reached').reduce((s, m) => s + m.amount, 0)) : 0;
  return {
    projectId: p.id, projectNumber: p.number, projectName: p.name, customerId: p.customer_id, facilityId: p.facility_id, billingType: p.billing_type,
    contractValue: value, method, percentComplete: pct, earned, billed: t.billed, writtenOff: t.writtenOff, unbilledEarned: money(Math.max(0, earned - t.consumed)),
    remaining: value === null ? null : money(value - earned),
    milestones: ms.map((m) => ({ id: m.id, name: m.name, amount: m.amount, dueDate: m.due_date, status: m.status, reachedOn: m.reached_on, billed: m.billed, held: !!m.hold_reason, holdReason: m.hold_reason })),
  };
}

export async function setTerms(tx: Tx, actor: Actor, projectId: string, input: { contractValue: number; method: 'milestone' | 'percent_complete'; percentComplete?: number }) {
  const p = await projectOf(tx, projectId);
  requirePermission(actor, 'billing.manage', p.facility_id);
  if (!p.customer_id) throw invalid('an internal project has no customer to bill');
  if (!(input.contractValue >= 0)) throw invalid('the contract value must be zero or more');
  const prior = await one(tx, 'SELECT project_id FROM billing_contract WHERE project_id = $1 FOR UPDATE', [projectId]);
  const cur = await readContract(tx, p);
  const t = await claimTotals(tx, projectId);
  if (prior && cur.method && cur.method !== input.method && t.consumed > 0) throw conflict('the project has already been billed by ' + (cur.method === 'milestone' ? 'milestone' : 'percent complete') + '; the method cannot change');
  if (input.contractValue < t.consumed) throw invalid(`the contract value cannot be less than the ${t.consumed.toFixed(2)} already billed or written off`);
  const msTotal = cur.milestones.reduce((s, m) => s + m.amount, 0);
  if (input.method === 'milestone' && input.contractValue + 0.004 < msTotal) throw invalid(`the milestones add up to ${msTotal.toFixed(2)}, more than the contract value`);
  const pct = input.method === 'percent_complete' ? (input.percentComplete ?? cur.percentComplete) : 0;
  if (!(pct >= 0 && pct <= 100)) throw invalid('percent complete is 0 to 100');
  if (input.method === 'percent_complete' && money((input.contractValue * pct) / 100) < t.percentConsumed) {
    throw invalid(`${pct}% of ${input.contractValue.toFixed(2)} is less than the ${t.percentConsumed.toFixed(2)} already billed on percent complete`);
  }
  await tx.query(`INSERT INTO billing_contract (project_id, tenant_id, contract_value, method, percent_complete, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (project_id) DO UPDATE SET contract_value = EXCLUDED.contract_value, method = EXCLUDED.method, percent_complete = EXCLUDED.percent_complete, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [projectId, actor.tenantId, money(input.contractValue), input.method, pct, actor.userId]);
  await audit(tx, actor, { action: 'billing.terms_set', entityType: 'project', entityId: projectId, facilityId: p.facility_id,
    data: { from: prior ? { contractValue: cur.contractValue, method: cur.method, percentComplete: cur.percentComplete } : null, to: { contractValue: money(input.contractValue), method: input.method, percentComplete: pct } } });
  return readContract(tx, p);
}

export async function addMilestone(tx: Tx, actor: Actor, projectId: string, input: { name: string; amount: number; dueDate?: string | null }) {
  const p = await projectOf(tx, projectId);
  requirePermission(actor, 'billing.manage', p.facility_id);
  const c = await one(tx, 'SELECT contract_value::float AS value, method FROM billing_contract WHERE project_id = $1 FOR UPDATE', [projectId]);
  if (!c || c.method !== 'milestone') throw invalid('set fixed-price terms billed by milestone for this project first');
  if (!input.name?.trim()) throw invalid('name the milestone');
  if (!(input.amount > 0)) throw invalid('the milestone amount must be more than zero');
  const sum = (await one(tx, 'SELECT coalesce(sum(amount), 0)::float AS s, coalesce(max(sort_no), 0) + 1 AS next FROM billing_milestone WHERE project_id = $1', [projectId]))!;
  if (money(sum.s + input.amount) > c.value + 0.004) throw invalid(`the milestones would add up to ${money(sum.s + input.amount).toFixed(2)}, more than the contract value ${c.value.toFixed(2)}`);
  const m = await one(tx, `INSERT INTO billing_milestone (tenant_id, project_id, sort_no, name, amount, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.tenantId, projectId, sum.next, input.name.trim(), money(input.amount), input.dueDate ?? null, actor.userId]);
  await audit(tx, actor, { action: 'billing.milestone_added', entityType: 'project', entityId: projectId, facilityId: p.facility_id, data: { milestoneId: m.id, name: input.name.trim(), amount: money(input.amount) } });
  return { id: m.id as string };
}

async function milestoneOf(tx: Tx, id: string) {
  const m = await one(tx, `SELECT m.*, p.facility_id FROM billing_milestone m JOIN project p ON p.id = m.project_id WHERE m.id = $1 FOR UPDATE OF m`, [id]);
  if (!m) throw notFound('milestone');
  return m;
}

/** A milestone is reached when the customer's acceptance or the deliverable is done; from then on a billing run can bill it. */
export async function reachMilestone(tx: Tx, actor: Actor, id: string, input: { reachedOn: string }) {
  const m = await milestoneOf(tx, id);
  requirePermission(actor, 'billing.manage', m.facility_id);
  if (m.status === 'reached') throw conflict('the milestone is already marked reached');
  await tx.query(`UPDATE billing_milestone SET status = 'reached', reached_on = $2, reached_by = $3 WHERE id = $1`, [id, input.reachedOn, actor.userId]);
  await audit(tx, actor, { action: 'billing.milestone_reached', entityType: 'project', entityId: m.project_id, facilityId: m.facility_id, data: { milestoneId: id, name: m.name, reachedOn: input.reachedOn, amount: m.amount } });
}

export async function reopenMilestone(tx: Tx, actor: Actor, id: string, reason: string) {
  const m = await milestoneOf(tx, id);
  requirePermission(actor, 'billing.manage', m.facility_id);
  if (m.status !== 'reached') throw conflict('the milestone is not marked reached');
  if (await one(tx, `SELECT 1 FROM billing_claim WHERE source_kind = 'milestone' AND source_id = $1 AND released_at IS NULL`, [id])) throw conflict('the milestone has been billed or written off; void the invoice first');
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE billing_milestone SET status = 'pending', reached_on = NULL, reached_by = NULL WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'billing.milestone_reopened', entityType: 'project', entityId: m.project_id, facilityId: m.facility_id, data: { milestoneId: id, reason } });
}
