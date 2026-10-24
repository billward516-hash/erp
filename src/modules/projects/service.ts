import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { approvalHistory, closePendingRequests, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { contractValue, milestoneAmount, round2 } from './engine.js';

/**
 * Projects (SC-009 P1, D-188A). A project belongs to a site, optionally a customer, has a billing type, an owner, a team, tasks with
 * budgets, milestones and (for fixed price) a contract value changed only by approved change orders. Time and expenses are booked to
 * it from the timesheet and the expense report (see booking.ts); cost, margin and burn are in costing.ts.
 */
export const SUBJECT = 'project';
export const CO_SUBJECT = 'project_change_order';
const CO_PURPOSE = 'change_order';
export type BillingType = 'time_materials' | 'fixed_price' | 'retainer' | 'non_billable';
export type ProjectStatus = 'proposed' | 'active' | 'on_hold' | 'completed' | 'cancelled';
export const BILLING_LABEL: Record<BillingType, string> = { time_materials: 'Time and materials', fixed_price: 'Fixed price', retainer: 'Retainer', non_billable: 'Non-billable (internal)' };
const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  proposed: ['active', 'cancelled'], active: ['on_hold', 'completed', 'cancelled'], on_hold: ['active', 'cancelled'], completed: ['active'], cancelled: [],
};
/** These changes need a reason because they stop or restart work other people are booking time to. */
const NEEDS_REASON = new Set<ProjectStatus>(['on_hold', 'cancelled', 'active']);

registerApprovalSubject(CO_SUBJECT, {
  link: (id) => `/projects/co/${id}`,
  describe: async (tx, id) => {
    const r = await one(tx, `SELECT p.number, p.name, c.seq, c.amount::float AS amount FROM project_change_order c JOIN project p ON p.id = c.project_id WHERE c.id = $1`, [id]);
    return r ? `${r.number} ${r.name}: change order ${r.seq} (${r.amount >= 0 ? '+' : '-'}${Math.abs(r.amount).toLocaleString('en-US')})` : 'Project change order';
  },
  commentRequired: true,
});

export const projectNumber = (n: number) => `PRJ-${String(n).padStart(6, '0')}`;
export const today = () => new Date().toISOString().slice(0, 10);
const text = (s?: string | null) => s?.trim() || null;
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export const canSeeCost = (actor: Actor, facilityId: string | null) => can(actor, 'projects.see_cost', facilityId);
/** Whether projects are switched off for this person (Admin → Features). */
export const projectsHidden = (actor: Actor) => !!actor.hiddenFeatures?.includes('projects');

export interface ProjectRow {
  id: string; tenant_id: string; facility_id: string; number: string; name: string; customer_id: string | null; status: ProjectStatus; billing_type: BillingType;
  owner_user_id: string | null; start_date: string | null; end_date: string | null; description: string | null; open_to_all: boolean; hours_budget: number | null; amount_budget: number | null;
  contract_amount: number | null; status_reason: string | null; created_by: string; created_at: string; updated_at: string; customer_name: string | null; owner_name: string | null; facility_code: string;
}
const PROJECT_SQL = `SELECT p.id, p.tenant_id, p.facility_id, p.number, p.name, p.customer_id, p.status, p.billing_type, p.owner_user_id, p.start_date::text AS start_date, p.end_date::text AS end_date,
    p.description, p.open_to_all, p.hours_budget::float AS hours_budget, p.amount_budget::float AS amount_budget, p.contract_amount::float AS contract_amount, p.status_reason,
    p.created_by, p.created_at, p.updated_at, c.name AS customer_name, u.display_name AS owner_name, f.code AS facility_code
  FROM project p JOIN facility f ON f.id = p.facility_id LEFT JOIN customer c ON c.id = p.customer_id LEFT JOIN app_user u ON u.id = p.owner_user_id`;

const isOwner = (actor: Actor, p: { owner_user_id: string | null }) => !!p.owner_user_id && p.owner_user_id === actor.userId;
/** Managers at the site, and the project's owner, change the project. */
export const canManage = (actor: Actor, p: { facility_id: string; owner_user_id: string | null }) => can(actor, 'projects.manage', p.facility_id) || isOwner(actor, p);

async function isMember(tx: Tx, actor: Actor, projectId: string) {
  return !!actor.employeeId && !!(await one(tx, 'SELECT 1 FROM project_member WHERE project_id = $1 AND employee_id = $2 AND active', [projectId, actor.employeeId]));
}

/** Loads a project the actor may see: holders of projects.view at its site, its owner and its team. Anyone else gets "not found". */
export async function loadProject(tx: Tx, actor: Actor, id: string, opts: { lock?: boolean } = {}): Promise<ProjectRow> {
  if (projectsHidden(actor)) throw notFound('project');
  const p = await one<ProjectRow>(tx, `${PROJECT_SQL} WHERE p.id = $1${opts.lock ? ' FOR UPDATE OF p' : ''}`, [id]);
  if (!p) throw notFound('project');
  if (!(can(actor, 'projects.view', p.facility_id) || can(actor, 'projects.manage', p.facility_id) || isOwner(actor, p) || (await isMember(tx, actor, id)))) throw notFound('project');
  return p;
}

async function activeUser(tx: Tx, id: string) {
  const u = await one(tx, `SELECT id, display_name FROM app_user WHERE id = $1 AND status = 'active'`, [id]);
  if (!u) throw invalid('the owner must be an active user');
  return u;
}

export interface ProjectInput {
  name: string; customerId?: string | null; billingType?: BillingType; ownerUserId?: string | null; startDate?: string | null; endDate?: string | null; description?: string | null;
  facilityId?: string | null; openToAll?: boolean; hoursBudget?: number | null; amountBudget?: number | null; contractAmount?: number | null; status?: 'proposed' | 'active';
}

function checkDates(start?: string | null, end?: string | null) {
  for (const d of [start, end]) if (d && !isDay(d)) throw invalid('dates look like 2027-03-31');
  if (start && end && end < start) throw invalid('the end date is before the start date');
}

export async function createProject(tx: Tx, actor: Actor, input: ProjectInput) {
  if (projectsHidden(actor)) throw forbidden('projects');
  if (!input.name?.trim()) throw invalid('give the project a name');
  const emp = actor.employeeId ? await one(tx, 'SELECT facility_id FROM employee WHERE id = $1', [actor.employeeId]) : null;
  const facilityId = input.facilityId ?? emp?.facility_id ?? actor.grants.find((g) => g.facilityId)?.facilityId ?? (await one(tx, 'SELECT id FROM facility ORDER BY created_at LIMIT 1'))?.id;
  if (!facilityId) throw invalid('choose the site this project belongs to');
  if (!(await one(tx, 'SELECT 1 FROM facility WHERE id = $1', [facilityId]))) throw notFound('site');
  requirePermission(actor, 'projects.manage', facilityId);
  const billingType = input.billingType ?? 'time_materials';
  if (billingType !== 'non_billable' && !input.customerId) throw invalid('choose the customer (only internal, non-billable projects have none)');
  if (input.customerId && !(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw notFound('customer');
  if (input.contractAmount != null && billingType !== 'fixed_price') throw invalid('a contract amount applies to fixed-price projects');
  if (billingType === 'fixed_price' && input.contractAmount == null) throw invalid('enter the contract amount of a fixed-price project');
  if (input.amountBudget != null) requirePermission(actor, 'projects.see_cost', facilityId);
  checkDates(input.startDate, input.endDate);
  const ownerId = input.ownerUserId ?? actor.userId;
  const owner = await activeUser(tx, ownerId);
  const number = projectNumber(await nextSequence(tx, actor.tenantId, 'project'));
  const p = await one(tx, `INSERT INTO project (tenant_id, facility_id, number, name, customer_id, status, billing_type, owner_user_id, start_date, end_date, description, open_to_all,
      hours_budget, amount_budget, contract_amount, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
  [actor.tenantId, facilityId, number, input.name.trim(), input.customerId ?? null, input.status ?? 'active', billingType, owner.id, input.startDate ?? null, input.endDate ?? null, text(input.description),
    input.openToAll ?? false, input.hoursBudget ?? null, input.amountBudget ?? null, input.contractAmount ?? null, actor.userId]);
  // The owner is on the team if they are an employee, so they can book time without a second step.
  const ownerEmp = await one(tx, 'SELECT employee_id FROM app_user WHERE id = $1', [owner.id]);
  if (ownerEmp?.employee_id) await tx.query(`INSERT INTO project_member (tenant_id, project_id, employee_id, role) VALUES ($1, $2, $3, 'Project owner') ON CONFLICT DO NOTHING`, [actor.tenantId, p.id, ownerEmp.employee_id]);
  await audit(tx, actor, { action: 'projects.created', entityType: SUBJECT, entityId: p.id, facilityId, data: { number, billingType, contractAmount: input.contractAmount ?? null, customerId: input.customerId ?? null } });
  return getProject(tx, actor, p.id);
}

export async function updateProject(tx: Tx, actor: Actor, id: string, patch: Partial<ProjectInput>) {
  const p = await loadProject(tx, actor, id, { lock: true });
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (p.status === 'cancelled') throw conflict('a cancelled project cannot be changed');
  const billingType = patch.billingType ?? p.billing_type;
  if (patch.billingType && patch.billingType !== p.billing_type && p.billing_type === 'fixed_price'
    && (await one(tx, 'SELECT 1 FROM project_change_order WHERE project_id = $1', [id]))) throw conflict('this project has change orders, so it stays fixed price');
  if (billingType !== 'non_billable' && patch.customerId === null) throw invalid('a billable project needs a customer');
  const customerId = patch.customerId === undefined ? p.customer_id : patch.customerId;
  if (billingType !== 'non_billable' && !customerId) throw invalid('choose the customer (only internal, non-billable projects have none)');
  if (patch.customerId && !(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [patch.customerId]))) throw notFound('customer');
  if (patch.contractAmount !== undefined && patch.contractAmount !== null && billingType !== 'fixed_price') throw invalid('a contract amount applies to fixed-price projects');
  if (patch.contractAmount !== undefined && patch.contractAmount !== p.contract_amount && p.status !== 'proposed') throw conflict('the contract value of a started project changes by change order, which keeps the history and needs approval');
  if (patch.amountBudget !== undefined) requirePermission(actor, 'projects.see_cost', p.facility_id);
  const start = patch.startDate === undefined ? p.start_date : patch.startDate;
  const end = patch.endDate === undefined ? p.end_date : patch.endDate;
  checkDates(start, end);
  if (patch.ownerUserId) await activeUser(tx, patch.ownerUserId);
  const set = (key: string, v: unknown) => (v === undefined ? null : [key, v] as const);
  const cols = [set('name', patch.name === undefined ? undefined : patch.name.trim()), set('customer_id', patch.customerId), set('billing_type', patch.billingType), set('owner_user_id', patch.ownerUserId),
    set('start_date', patch.startDate), set('end_date', patch.endDate), set('description', patch.description === undefined ? undefined : text(patch.description)), set('open_to_all', patch.openToAll),
    set('hours_budget', patch.hoursBudget), set('amount_budget', patch.amountBudget), set('contract_amount', patch.contractAmount)].filter(Boolean) as (readonly [string, unknown])[];
  if (patch.name !== undefined && !patch.name.trim()) throw invalid('give the project a name');
  if (!cols.length) return getProject(tx, actor, id);
  await tx.query(`UPDATE project SET ${cols.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...cols.map(([, v]) => v)]);
  const before: Record<string, unknown> = { name: p.name, customerId: p.customer_id, billingType: p.billing_type, ownerUserId: p.owner_user_id, startDate: p.start_date, endDate: p.end_date,
    openToAll: p.open_to_all, hoursBudget: p.hours_budget, amountBudget: p.amount_budget, contractAmount: p.contract_amount };
  // A cost budget is cost information, and the audit trail is readable by more people than may see cost: it records that it changed, not the figures.
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in before && before[k] !== v).map(([k, v]) => [k, k === 'amountBudget' ? '(changed)' : { from: before[k], to: v }]));
  await audit(tx, actor, { action: 'projects.updated', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { changed } });
  if (patch.ownerUserId && patch.ownerUserId !== p.owner_user_id) {
    await notify(tx, actor.tenantId, [patch.ownerUserId], { kind: 'project.owner', title: `You are now the owner of ${p.number} ${p.name}`, link: `/projects/${id}`, subjectType: SUBJECT, subjectId: id,
      dedupeKey: `project-owner:${id}:${patch.ownerUserId}:${Date.now()}` }, actor.userId);
  }
  return getProject(tx, actor, id);
}

export async function transitionProject(tx: Tx, actor: Actor, id: string, input: { to: ProjectStatus; reason?: string | null }) {
  const p = await loadProject(tx, actor, id, { lock: true });
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (!TRANSITIONS[p.status].includes(input.to)) throw conflict(`a ${p.status.replace('_', ' ')} project cannot become ${input.to.replace('_', ' ')}`);
  const reason = text(input.reason);
  if ((NEEDS_REASON.has(input.to) && p.status !== 'proposed' || input.to === 'cancelled') && !reason) throw invalid('say why');
  if (input.to === 'completed') {
    if (await one(tx, `SELECT 1 FROM project_change_order WHERE project_id = $1 AND status = 'pending'`, [id])) throw conflict('a change order is still waiting for approval; decide or withdraw it first');
  }
  await tx.query('UPDATE project SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1', [id, input.to, reason]);
  await audit(tx, actor, { action: 'projects.status_changed', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { from: p.status, to: input.to, reason } });
  return getProject(tx, actor, id);
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export async function addMember(tx: Tx, actor: Actor, projectId: string, input: { employeeId: string; role?: string | null }) {
  const p = await loadProject(tx, actor, projectId);
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (!(await one(tx, `SELECT 1 FROM employee WHERE id = $1 AND status = 'active'`, [input.employeeId]))) throw invalid('choose an active employee');
  const m = await one(tx, `INSERT INTO project_member (tenant_id, project_id, employee_id, role) VALUES ($1, $2, $3, $4)
    ON CONFLICT (project_id, employee_id) DO UPDATE SET active = true, role = coalesce(EXCLUDED.role, project_member.role) RETURNING *`, [actor.tenantId, projectId, input.employeeId, text(input.role)]);
  await audit(tx, actor, { action: 'projects.member_added', entityType: SUBJECT, entityId: projectId, facilityId: p.facility_id, data: { employeeId: input.employeeId, role: text(input.role) } });
  return m;
}

export async function updateMember(tx: Tx, actor: Actor, memberId: string, patch: { role?: string | null; active?: boolean }) {
  const m = await one(tx, 'SELECT * FROM project_member WHERE id = $1', [memberId]);
  if (!m) throw notFound('team member');
  const p = await loadProject(tx, actor, m.project_id);
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  const r = await one(tx, `UPDATE project_member SET role = CASE WHEN $2 THEN $3 ELSE role END, active = coalesce($4, active) WHERE id = $1 RETURNING *`, [memberId, patch.role !== undefined, text(patch.role), patch.active ?? null]);
  await audit(tx, actor, { action: patch.active === false ? 'projects.member_removed' : 'projects.member_changed', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { employeeId: m.employee_id, ...patch } });
  return r;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskInput { name: string; billable?: boolean; hoursBudget?: number | null; amountBudget?: number | null; sortNo?: number; active?: boolean }

export async function addTask(tx: Tx, actor: Actor, projectId: string, input: TaskInput) {
  const p = await loadProject(tx, actor, projectId);
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (!input.name?.trim()) throw invalid('give the task a name');
  if (input.amountBudget != null) requirePermission(actor, 'projects.see_cost', p.facility_id);
  const sort = input.sortNo ?? ((await one(tx, 'SELECT coalesce(max(sort_no), 0) + 10 AS n FROM project_task WHERE project_id = $1', [projectId]))!.n as number);
  const t = await one(tx, `INSERT INTO project_task (tenant_id, project_id, sort_no, name, billable, hours_budget, amount_budget) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.tenantId, projectId, sort, input.name.trim(), p.billing_type === 'non_billable' ? false : input.billable ?? true, input.hoursBudget ?? null, input.amountBudget ?? null]);
  await audit(tx, actor, { action: 'projects.task_added', entityType: SUBJECT, entityId: projectId, facilityId: p.facility_id, data: { taskId: t.id, name: input.name.trim(), hoursBudget: input.hoursBudget ?? null } });
  return one(tx, 'SELECT * FROM project_task WHERE id = $1', [t.id]);
}

export async function updateTask(tx: Tx, actor: Actor, taskId: string, patch: Partial<TaskInput>) {
  const t = await one(tx, 'SELECT * FROM project_task WHERE id = $1', [taskId]);
  if (!t) throw notFound('task');
  const p = await loadProject(tx, actor, t.project_id);
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (patch.amountBudget !== undefined) requirePermission(actor, 'projects.see_cost', p.facility_id);
  if (patch.name !== undefined && !patch.name.trim()) throw invalid('give the task a name');
  const r = await one(tx, `UPDATE project_task SET name = coalesce($2, name), billable = coalesce($3, billable), sort_no = coalesce($4, sort_no), active = coalesce($5, active),
      hours_budget = CASE WHEN $6 THEN $7 ELSE hours_budget END, amount_budget = CASE WHEN $8 THEN $9 ELSE amount_budget END WHERE id = $1 RETURNING *`,
  [taskId, patch.name?.trim() ?? null, p.billing_type === 'non_billable' ? false : patch.billable ?? null, patch.sortNo ?? null, patch.active ?? null, patch.hoursBudget !== undefined, patch.hoursBudget ?? null,
    patch.amountBudget !== undefined, patch.amountBudget ?? null]);
  await audit(tx, actor, { action: 'projects.task_changed', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { taskId, ...patch, ...(patch.amountBudget !== undefined ? { amountBudget: '(changed)' } : {}) } });
  return r;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export interface MilestoneInput { name: string; dueDate?: string | null; amount?: number | null; percent?: number | null; sortNo?: number }

async function currentContract(tx: Tx, p: ProjectRow) {
  const approved = await many(tx, `SELECT amount::float AS amount FROM project_change_order WHERE project_id = $1 AND status = 'approved'`, [p.id]);
  return contractValue(p.contract_amount, approved.map((a) => a.amount));
}

async function checkMilestoneTotals(tx: Tx, p: ProjectRow, excludeId: string | null) {
  const ms = await many(tx, `SELECT amount::float AS amount, percent::float AS percent FROM project_milestone WHERE project_id = $1 AND ($2::uuid IS NULL OR id <> $2)`, [p.id, excludeId]);
  return { ms, contract: await currentContract(tx, p) };
}

function checkMilestoneShape(p: ProjectRow, i: { dueDate?: string | null; amount?: number | null; percent?: number | null }) {
  if (i.dueDate && !isDay(i.dueDate)) throw invalid('dates look like 2027-03-31');
  if (i.amount != null && i.percent != null) throw invalid('give a fixed amount or a percent of the contract, not both');
  if ((i.amount != null || i.percent != null) && p.billing_type !== 'fixed_price') throw invalid('amounts and percents on milestones apply to fixed-price projects');
}

export async function addMilestone(tx: Tx, actor: Actor, projectId: string, input: MilestoneInput) {
  const p = await loadProject(tx, actor, projectId);
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (!input.name?.trim()) throw invalid('give the milestone a name');
  checkMilestoneShape(p, input);
  const { ms, contract } = await checkMilestoneTotals(tx, p, null);
  const pct = ms.reduce((s, m) => s + (m.percent ?? 0), 0) + (input.percent ?? 0);
  if (pct > 100.0001) throw invalid(`milestone percents add up to ${round2(pct)}% of the contract; the most is 100%`);
  const amt = ms.reduce((s, m) => s + milestoneAmount(m, contract)!, 0) + (milestoneAmount({ amount: input.amount ?? null, percent: input.percent ?? null }, contract) ?? 0);
  if (contract != null && amt > contract + 0.005) throw invalid(`milestones would add up to ${round2(amt)}, more than the contract value ${contract}`);
  const sort = input.sortNo ?? ((await one(tx, 'SELECT coalesce(max(sort_no), 0) + 10 AS n FROM project_milestone WHERE project_id = $1', [projectId]))!.n as number);
  const m = await one(tx, `INSERT INTO project_milestone (tenant_id, project_id, sort_no, name, due_date, amount, percent) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, projectId, sort, input.name.trim(), input.dueDate ?? null, input.amount ?? null, input.percent ?? null]);
  await audit(tx, actor, { action: 'projects.milestone_added', entityType: SUBJECT, entityId: projectId, facilityId: p.facility_id, data: { milestoneId: m.id, name: m.name, amount: input.amount ?? null, percent: input.percent ?? null } });
  return m;
}

export async function updateMilestone(tx: Tx, actor: Actor, milestoneId: string, patch: Partial<MilestoneInput>) {
  const m = await one(tx, 'SELECT * FROM project_milestone WHERE id = $1', [milestoneId]);
  if (!m) throw notFound('milestone');
  const p = await loadProject(tx, actor, m.project_id);
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (m.status === 'billed') throw conflict('a billed milestone cannot be changed');
  if (m.status === 'reached' && (patch.amount !== undefined || patch.percent !== undefined)) throw conflict('a reached milestone keeps its amount; take it back to planned first');
  if (patch.name !== undefined && !patch.name.trim()) throw invalid('give the milestone a name');
  const next = { dueDate: patch.dueDate === undefined ? m.due_date : patch.dueDate, amount: patch.amount === undefined ? (m.amount == null ? null : Number(m.amount)) : patch.amount,
    percent: patch.percent === undefined ? (m.percent == null ? null : Number(m.percent)) : patch.percent };
  // Giving one of amount and percent replaces the other.
  if (patch.amount != null && patch.percent === undefined) next.percent = null;
  if (patch.percent != null && patch.amount === undefined) next.amount = null;
  checkMilestoneShape(p, next);
  const { ms, contract } = await checkMilestoneTotals(tx, p, milestoneId);
  const pct = ms.reduce((s, x) => s + (x.percent ?? 0), 0) + (next.percent ?? 0);
  if (pct > 100.0001) throw invalid(`milestone percents add up to ${round2(pct)}% of the contract; the most is 100%`);
  const amt = ms.reduce((s, x) => s + milestoneAmount(x, contract)!, 0) + (milestoneAmount(next, contract) ?? 0);
  if (contract != null && amt > contract + 0.005) throw invalid(`milestones would add up to ${round2(amt)}, more than the contract value ${contract}`);
  const r = await one(tx, `UPDATE project_milestone SET name = coalesce($2, name), due_date = $3, amount = $4, percent = $5, sort_no = coalesce($6, sort_no) WHERE id = $1 RETURNING *`,
    [milestoneId, patch.name?.trim() ?? null, next.dueDate ?? null, next.amount, next.percent, patch.sortNo ?? null]);
  await audit(tx, actor, { action: 'projects.milestone_changed', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { milestoneId, ...patch } });
  return r;
}

export async function deleteMilestone(tx: Tx, actor: Actor, milestoneId: string) {
  const m = await one(tx, 'SELECT * FROM project_milestone WHERE id = $1', [milestoneId]);
  if (!m) throw notFound('milestone');
  const p = await loadProject(tx, actor, m.project_id);
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (m.status !== 'planned') throw conflict(`a ${m.status} milestone cannot be removed`);
  await tx.query('DELETE FROM project_milestone WHERE id = $1', [milestoneId]);
  await audit(tx, actor, { action: 'projects.milestone_removed', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { milestoneId, name: m.name } });
}

/** Reaching a milestone is what lets billing invoice it: only the project owner or a manager at the site, and it is audited. */
export async function reachMilestone(tx: Tx, actor: Actor, milestoneId: string, input: { reachedOn?: string | null } = {}) {
  const m = await one(tx, 'SELECT * FROM project_milestone WHERE id = $1 FOR UPDATE', [milestoneId]);
  if (!m) throw notFound('milestone');
  const p = await loadProject(tx, actor, m.project_id);
  if (!canManage(actor, p)) throw forbidden('only the project owner or a project manager can reach a milestone');
  if (m.status !== 'planned') throw conflict(`the milestone is already ${m.status}`);
  if (p.status !== 'active') throw conflict(`the project is ${p.status.replace('_', ' ')}; milestones are reached on active projects`);
  const on = input.reachedOn ?? today();
  if (!isDay(on) || on > today()) throw invalid('the date reached cannot be in the future');
  const r = await one(tx, `UPDATE project_milestone SET status = 'reached', reached_on = $2, reached_by = $3 WHERE id = $1 RETURNING *`, [milestoneId, on, actor.userId]);
  const contract = await currentContract(tx, p);
  await audit(tx, actor, { action: 'projects.milestone_reached', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id,
    data: { milestoneId, name: m.name, reachedOn: on, amount: milestoneAmount({ amount: m.amount == null ? null : Number(m.amount), percent: m.percent == null ? null : Number(m.percent) }, contract) } });
  if (p.owner_user_id && p.owner_user_id !== actor.userId) {
    await notify(tx, actor.tenantId, [p.owner_user_id], { kind: 'project.milestone', title: `Milestone reached on ${p.number} ${p.name}: ${m.name}`, link: `/projects/${p.id}`, subjectType: SUBJECT, subjectId: p.id,
      dedupeKey: `project-milestone:${milestoneId}` }, actor.userId);
  }
  return r;
}

export async function unreachMilestone(tx: Tx, actor: Actor, milestoneId: string, reason: string) {
  const m = await one(tx, 'SELECT * FROM project_milestone WHERE id = $1 FOR UPDATE', [milestoneId]);
  if (!m) throw notFound('milestone');
  const p = await loadProject(tx, actor, m.project_id);
  if (!canManage(actor, p)) throw forbidden('only the project owner or a project manager can change a milestone');
  if (m.status !== 'reached') throw conflict(m.status === 'billed' ? 'a billed milestone cannot be taken back; credit the invoice instead' : 'the milestone has not been reached');
  if (!reason?.trim()) throw invalid('say why it is being taken back');
  const r = await one(tx, `UPDATE project_milestone SET status = 'planned', reached_on = NULL, reached_by = NULL WHERE id = $1 RETURNING *`, [milestoneId]);
  await audit(tx, actor, { action: 'projects.milestone_unreached', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { milestoneId, name: m.name, reason: reason.trim() } });
  return r;
}

// ---------------------------------------------------------------------------
// Contract value and change orders
// ---------------------------------------------------------------------------

async function approverStep(tx: Tx, actor: Actor, p: ProjectRow) {
  if (p.owner_user_id && p.owner_user_id !== actor.userId) {
    const o = await one(tx, `SELECT display_name FROM app_user WHERE id = $1 AND status = 'active'`, [p.owner_user_id]);
    if (o) return { roleKey: 'admin', label: `Approval of the change order by ${o.display_name}`, assigneeUserId: p.owner_user_id };
  }
  return { roleKey: 'admin', label: 'Owner approval of the change order' };
}

export async function requestChangeOrder(tx: Tx, actor: Actor, projectId: string, input: { amount: number; reason: string; reference?: string | null }) {
  const p = await loadProject(tx, actor, projectId, { lock: true });
  if (!canManage(actor, p)) throw forbidden('projects.manage');
  if (p.billing_type !== 'fixed_price') throw invalid('change orders adjust the contract value of fixed-price projects');
  if (['completed', 'cancelled'].includes(p.status)) throw conflict(`the project is ${p.status}`);
  if (!Number.isFinite(input.amount) || round2(input.amount) === 0) throw invalid('the change must be more or less than zero');
  if (!input.reason?.trim() || input.reason.trim().length < 3) throw invalid('say why the contract changes');
  const current = await currentContract(tx, p);
  if (current! + input.amount < 0) throw invalid('the contract value cannot go below zero');
  const seq = (await one(tx, 'SELECT coalesce(max(seq), 0) + 1 AS n FROM project_change_order WHERE project_id = $1', [projectId]))!.n as number;
  const co = await one(tx, `INSERT INTO project_change_order (tenant_id, project_id, seq, amount, reason, reference, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, projectId, seq, round2(input.amount), input.reason.trim(), text(input.reference), actor.userId]);
  await createApprovalRequest(tx, actor, { facilityId: p.facility_id, subjectType: CO_SUBJECT, subjectId: co.id, subjectRevision: 1, purpose: CO_PURPOSE, stages: [{ steps: [await approverStep(tx, actor, p)] }] });
  await audit(tx, actor, { action: 'projects.change_order_requested', entityType: SUBJECT, entityId: projectId, facilityId: p.facility_id, data: { changeOrderId: co.id, seq, amount: round2(input.amount), reason: input.reason.trim(), reference: text(input.reference) } });
  return co;
}

export async function withdrawChangeOrder(tx: Tx, actor: Actor, id: string) {
  const co = await one(tx, 'SELECT * FROM project_change_order WHERE id = $1 FOR UPDATE', [id]);
  if (!co) throw notFound('change order');
  const p = await loadProject(tx, actor, co.project_id);
  if (!(canManage(actor, p) || co.requested_by === actor.userId)) throw forbidden('projects.manage');
  if (co.status !== 'pending') throw conflict(`the change order is ${co.status}`);
  await closePendingRequests(tx, actor, CO_SUBJECT, id, 'cancelled', 'withdrawn');
  await tx.query(`UPDATE project_change_order SET status = 'withdrawn', decided_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'projects.change_order_withdrawn', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { changeOrderId: id, seq: co.seq } });
}

/** Called by the shared approval engine's handler when the approver decides. Approval changes the contract value; rejection leaves it. */
export async function onProjectChangeDecided(tx: Tx, actor: Actor, id: string, purpose: string, status: string) {
  if (purpose !== CO_PURPOSE || status === 'pending') return;
  const co = await one(tx, 'SELECT * FROM project_change_order WHERE id = $1 FOR UPDATE', [id]);
  if (!co || co.status !== 'pending') return;
  const p = await one<ProjectRow>(tx, `${PROJECT_SQL} WHERE p.id = $1`, [co.project_id]);
  if (!p) return;
  const before = await currentContract(tx, p);
  const approved = status === 'approved';
  await tx.query(`UPDATE project_change_order SET status = $2, decided_at = now() WHERE id = $1`, [id, approved ? 'approved' : 'rejected']);
  await audit(tx, actor, { action: approved ? 'projects.change_order_approved' : 'projects.change_order_rejected', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id,
    data: { changeOrderId: id, seq: co.seq, amount: Number(co.amount), contractBefore: before, contractAfter: approved ? round2((before ?? 0) + Number(co.amount)) : before } });
  await notify(tx, actor.tenantId, [p.owner_user_id], { kind: 'project.change_order', title: `Change order ${co.seq} on ${p.number} ${p.name} ${approved ? 'approved' : 'rejected'}`, link: `/projects/${p.id}`,
    subjectType: SUBJECT, subjectId: p.id, dedupeKey: `project-co-decided:${id}:${status}` }, actor.userId);
}

export async function getChangeOrder(tx: Tx, actor: Actor, id: string) {
  const co = await one(tx, 'SELECT id, project_id, seq, amount::float AS amount, reason, reference, status FROM project_change_order WHERE id = $1', [id]);
  if (!co) throw notFound('change order');
  await loadProject(tx, actor, co.project_id);
  return co;
}

/**
 * What a billing run needs about a fixed-price (or any) project's contract: the original amount, each approved change, the milestones with
 * their amounts at the current contract value, and what has been billed so far. Billed-to-date is a placeholder (0) that slice P2 fills.
 * Allowed for people who see the project or manage receivables at its site.
 */
export async function getBillableContract(tx: Tx, actor: Actor, projectId: string) {
  const p = await one<ProjectRow>(tx, `${PROJECT_SQL} WHERE p.id = $1`, [projectId]);
  if (!p || projectsHidden(actor)) throw notFound('project');
  if (!(can(actor, 'projects.view', p.facility_id) || can(actor, 'projects.manage', p.facility_id) || can(actor, 'ar.manage', p.facility_id) || isOwner(actor, p) || (await isMember(tx, actor, projectId)))) throw notFound('project');
  const changes = await many(tx, `SELECT c.id, c.seq, c.amount::float AS amount, c.reason, c.reference, c.decided_at, u.display_name AS requested_by
    FROM project_change_order c JOIN app_user u ON u.id = c.requested_by WHERE c.project_id = $1 AND c.status = 'approved' ORDER BY c.seq`, [projectId]);
  const contract = contractValue(p.contract_amount, changes.map((c) => c.amount));
  const milestones = (await many(tx, `SELECT id, name, due_date::text AS due_date, amount::float AS amount, percent::float AS percent, status, reached_on::text AS reached_on, sort_no
    FROM project_milestone WHERE project_id = $1 ORDER BY sort_no, due_date`, [projectId])).map((m) => ({ ...m, effectiveAmount: milestoneAmount(m, contract) }));
  return {
    projectId, number: p.number, name: p.name, customerId: p.customer_id, facilityId: p.facility_id, billingType: p.billing_type, status: p.status,
    originalAmount: p.contract_amount, changes, contractValue: contract, milestones,
    /** Placeholder: slice P2 (billing runs) fills this from invoice lines tied to the project. */
    billedToDate: 0,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listProjects(tx: Tx, actor: Actor, q: { status?: string; customerId?: string; mine?: boolean; search?: string } = {}) {
  if (projectsHidden(actor)) return [];
  const rows = await many(tx, `SELECT p.id, p.facility_id, f.code AS facility_code, p.number, p.name, p.status, p.billing_type, p.start_date::text AS start_date, p.end_date::text AS end_date, p.owner_user_id,
      u.display_name AS owner_name, c.name AS customer_name, p.customer_id, p.open_to_all, p.hours_budget::float AS hours_budget,
      (SELECT count(*)::int FROM project_member m WHERE m.project_id = p.id AND m.active) AS team,
      (SELECT count(*)::int FROM project_milestone m WHERE m.project_id = p.id AND m.status = 'planned' AND m.due_date < current_date) AS late_milestones,
      EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = p.id AND m.active AND m.employee_id = $4) AS i_am_member
    FROM project p JOIN facility f ON f.id = p.facility_id LEFT JOIN customer c ON c.id = p.customer_id LEFT JOIN app_user u ON u.id = p.owner_user_id
    WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.customer_id = $2) AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.number ILIKE '%' || $3 || '%')
    ORDER BY p.number DESC LIMIT 500`, [q.status ?? null, q.customerId ?? null, q.search?.trim() || null, actor.employeeId]);
  return rows.filter((r) => can(actor, 'projects.view', r.facility_id) || can(actor, 'projects.manage', r.facility_id) || r.owner_user_id === actor.userId || r.i_am_member)
    .filter((r) => !q.mine || r.owner_user_id === actor.userId || r.i_am_member)
    .map(({ i_am_member, ...r }) => ({ ...r, canManage: canManage(actor, r) }));
}

/** The project page without figures: header, team, tasks (budgets of cost only for those who may see cost), milestones, change orders. */
export async function getProject(tx: Tx, actor: Actor, id: string) {
  const p = await loadProject(tx, actor, id);
  const cost = canSeeCost(actor, p.facility_id);
  const members = await many(tx, `SELECT m.id, m.employee_id, m.role, m.active, e.employee_number, e.first_name || ' ' || e.last_name AS name, e.job_title
    FROM project_member m JOIN employee e ON e.id = m.employee_id WHERE m.project_id = $1 ORDER BY m.active DESC, e.last_name, e.first_name`, [id]);
  const tasks = (await many(tx, `SELECT id, sort_no, name, billable, active, hours_budget::float AS hours_budget, amount_budget::float AS amount_budget FROM project_task WHERE project_id = $1 ORDER BY sort_no, name`, [id]))
    .map((t) => (cost ? t : { ...t, amount_budget: undefined }));
  const changes = await many(tx, `SELECT c.id, c.seq, c.amount::float AS amount, c.reason, c.reference, c.status, c.requested_at, c.decided_at, u.display_name AS requested_by
    FROM project_change_order c JOIN app_user u ON u.id = c.requested_by WHERE c.project_id = $1 ORDER BY c.seq`, [id]);
  const approvals: (typeof changes[number] & { approval: Awaited<ReturnType<typeof approvalHistory>> })[] = [];
  for (const c of changes) approvals.push({ ...c, approval: await approvalHistory(tx, CO_SUBJECT, c.id) });
  const contract = await currentContract(tx, p);
  const milestones = (await many(tx, `SELECT m.id, m.sort_no, m.name, m.due_date::text AS due_date, m.amount::float AS amount, m.percent::float AS percent, m.status, m.reached_on::text AS reached_on, u.display_name AS reached_by,
      (m.status = 'planned' AND m.due_date < current_date) AS late FROM project_milestone m LEFT JOIN app_user u ON u.id = m.reached_by WHERE m.project_id = $1 ORDER BY m.sort_no, m.due_date`, [id]))
    .map((m) => ({ ...m, effective_amount: milestoneAmount(m, contract) }));
  const { amount_budget, ...rest } = p;
  return {
    ...rest, ...(cost ? { amount_budget } : {}), billing_label: BILLING_LABEL[p.billing_type], members, tasks, milestones, change_orders: approvals,
    contract_value: p.billing_type === 'fixed_price' ? contract : null,
    canManage: canManage(actor, p), canSeeCost: cost, allowedTransitions: canManage(actor, p) ? TRANSITIONS[p.status] : [],
  };
}

/** Choices for the project form: customers, active employees and users. */
export async function projectLookups(tx: Tx, actor: Actor) {
  if (!(can(actor, 'projects.manage') || can(actor, 'projects.view'))) throw forbidden('projects.view');
  return {
    customers: await many(tx, `SELECT id, name FROM customer ORDER BY name LIMIT 1000`),
    employees: await many(tx, `SELECT e.id, e.employee_number, e.first_name || ' ' || e.last_name AS name, f.code AS facility_code FROM employee e LEFT JOIN facility f ON f.id = e.facility_id WHERE e.status = 'active' ORDER BY e.last_name, e.first_name`),
    users: await many(tx, `SELECT id, display_name FROM app_user WHERE status = 'active' ORDER BY display_name`),
    facilities: (await many(tx, 'SELECT id, code, name FROM facility ORDER BY code')).filter((f) => can(actor, 'projects.manage', f.id)),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(tx: Tx, actor: Actor) {
  if (!(can(actor, 'projects.view') || can(actor, 'projects.manage'))) throw forbidden('projects.view');
  const s = await one(tx, 'SELECT budget_alert_pct FROM project_settings');
  return { budgetAlertPct: (s?.budget_alert_pct as number | undefined) ?? 90, canEdit: can(actor, 'projects.manage') || can(actor, 'tenant.admin') };
}
export async function alertPct(tx: Tx) { return ((await one(tx, 'SELECT budget_alert_pct FROM project_settings'))?.budget_alert_pct as number | undefined) ?? 90; }

export async function saveSettings(tx: Tx, actor: Actor, input: { budgetAlertPct: number }) {
  if (!(can(actor, 'projects.manage') || can(actor, 'tenant.admin'))) throw forbidden('projects.manage');
  if (!Number.isInteger(input.budgetAlertPct) || input.budgetAlertPct < 50 || input.budgetAlertPct > 100) throw invalid('the alert share is a whole percent from 50 to 100');
  await tx.query(`INSERT INTO project_settings (tenant_id, budget_alert_pct, updated_by) VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO UPDATE SET budget_alert_pct = EXCLUDED.budget_alert_pct, updated_by = EXCLUDED.updated_by, updated_at = now()`, [actor.tenantId, input.budgetAlertPct, actor.userId]);
  await audit(tx, actor, { action: 'projects.settings_changed', entityType: 'project_settings', entityId: actor.tenantId, data: { budgetAlertPct: input.budgetAlertPct } });
  return getSettings(tx, actor);
}
