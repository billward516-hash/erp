import type { Actor } from '../../platform/auth/actor.js';
import { can, facilitiesWith, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';

export const money = (n: number) => Math.round((n + 1e-9 * Math.sign(n)) * 100) / 100;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Rate resolution order (SC-009): the most specific rate card that applies on the work date wins.
 *   1. project   a rate set for the project
 *   2. customer  a rate set for the customer
 *   3. person    a rate set for the person
 *   4. role      a rate set for the person's job title
 *   5. default   the company's standard rate
 * Inside a project or customer rate card, a line that names the person beats one that names the role, which beats one for everybody.
 * Inside one level, the rate with the latest start date that covers the work date wins. No match: no rate (the work is not billed until one exists).
 */
export const RESOLUTION_ORDER = ['project', 'customer', 'person', 'role', 'default'] as const;
export type RateScope = (typeof RESOLUTION_ORDER)[number];
export const SCOPE_LABEL: Record<RateScope, string> = { project: 'Project rate', customer: 'Customer rate', person: 'Person rate', role: 'Role rate', default: 'Company default rate' };

export interface RateRow {
  id: string; scope: RateScope; projectId: string | null; customerId: string | null; employeeId: string | null; roleKey: string | null; roleLabel: string | null;
  amount: number; effectiveFrom: string; effectiveTo: string | null; note: string | null; createdAt: string;
  projectLabel?: string | null; customerLabel?: string | null; employeeLabel?: string | null;
}
export interface RateContext { projectId: string | null; customerId: string | null; employeeId: string | null; roleKey: string | null; date: string }
export interface ResolvedRate { rateId: string; scope: RateScope; amount: number; why: string }

export const roleKeyOf = (title: string | null | undefined) => (title?.trim() ? title.trim().toLowerCase() : null);

const active = (r: RateRow, date: string) => r.effectiveFrom <= date && (r.effectiveTo === null || r.effectiveTo >= date);
/** 2 names the person, 1 names the role, 0 for everybody; -1 when the row names a different person or role (does not apply). */
function narrowing(r: RateRow, ctx: RateContext) {
  if (r.employeeId) return r.employeeId === ctx.employeeId ? 2 : -1;
  if (r.roleKey) return r.roleKey === ctx.roleKey ? 1 : -1;
  return 0;
}

export function resolveRate(rows: RateRow[], ctx: RateContext): ResolvedRate | null {
  for (const scope of RESOLUTION_ORDER) {
    const cands = rows.filter((r) => r.scope === scope && active(r, ctx.date)).filter((r) => {
      if (scope === 'project') return r.projectId === ctx.projectId && narrowing(r, ctx) >= 0;
      if (scope === 'customer') return r.customerId === ctx.customerId && ctx.customerId !== null && narrowing(r, ctx) >= 0;
      if (scope === 'person') return r.employeeId === ctx.employeeId && ctx.employeeId !== null;
      if (scope === 'role') return r.roleKey === ctx.roleKey && ctx.roleKey !== null;
      return true;
    });
    if (!cands.length) continue;
    cands.sort((a, b) => narrowing(b, ctx) - narrowing(a, ctx) || (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0) || (a.createdAt < b.createdAt ? 1 : -1));
    const r = cands[0]!;
    const target = scope === 'project' ? r.projectLabel : scope === 'customer' ? r.customerLabel : scope === 'person' ? r.employeeLabel : scope === 'role' ? r.roleLabel : null;
    const narrow = (scope === 'project' || scope === 'customer') && (r.employeeId || r.roleKey) ? ` for ${r.employeeId ? r.employeeLabel : r.roleLabel}` : '';
    const until = r.effectiveTo ? ` to ${r.effectiveTo}` : '';
    return { rateId: r.id, scope, amount: r.amount, why: `${SCOPE_LABEL[scope]}${target ? ` (${target})` : ''}${narrow}, ${r.amount.toFixed(2)} an hour, in force ${r.effectiveFrom}${until}` };
  }
  return null;
}

const RATE_SELECT = `SELECT r.id, r.scope, r.project_id AS "projectId", r.customer_id AS "customerId", r.employee_id AS "employeeId", r.role_key AS "roleKey", r.role_label AS "roleLabel",
    r.amount, r.effective_from AS "effectiveFrom", r.effective_to AS "effectiveTo", r.note, r.created_at::text AS "createdAt",
    p.number || ' ' || p.name AS "projectLabel", c.name AS "customerLabel", e.first_name || ' ' || e.last_name AS "employeeLabel", u.display_name AS "createdBy"
  FROM bill_rate r LEFT JOIN project p ON p.id = r.project_id LEFT JOIN customer c ON c.id = r.customer_id LEFT JOIN employee e ON e.id = r.employee_id LEFT JOIN app_user u ON u.id = r.created_by`;

export async function loadRates(tx: Tx): Promise<RateRow[]> {
  return many<RateRow>(tx, `${RATE_SELECT} ORDER BY r.scope, r.effective_from DESC`);
}

export async function listRates(tx: Tx, actor: Actor, q: { projectId?: string; customerId?: string; employeeId?: string; scope?: string } = {}) {
  requirePermission(actor, 'billing.view');
  const rows = await many(tx, `${RATE_SELECT} WHERE ($1::uuid IS NULL OR r.project_id = $1) AND ($2::uuid IS NULL OR r.customer_id = $2) AND ($3::uuid IS NULL OR r.employee_id = $3) AND ($4::text IS NULL OR r.scope = $4)
    ORDER BY array_position(ARRAY['project', 'customer', 'person', 'role', 'default'], r.scope), r.effective_from DESC`, [q.projectId ?? null, q.customerId ?? null, q.employeeId ?? null, q.scope ?? null]);
  return { order: RESOLUTION_ORDER.map((s) => ({ scope: s, label: SCOPE_LABEL[s] })), rates: rows };
}

/** Project and person cards belong to a site; the company-wide cards (customer, role, default, settings) need company-wide authority. */
function requireRates(actor: Actor, facilityId: string | null) {
  if (facilityId) requirePermission(actor, 'billing.rates', facilityId);
  else if (!facilitiesWith(actor, 'billing.rates').all) throw forbidden('billing.rates (company-wide)');
}

export async function createRate(tx: Tx, actor: Actor, input: { scope: RateScope; projectId?: string | null; customerId?: string | null; employeeId?: string | null; role?: string | null;
  amount: number; effectiveFrom: string; note?: string | null }) {
  const { scope } = input;
  const roleKey = roleKeyOf(input.role);
  if (!(input.amount >= 0)) throw invalid('the rate must be zero or more');
  if (input.employeeId && roleKey) throw invalid('a rate names a person or a role, not both');
  const want = { project: scope === 'project', customer: scope === 'customer', person: scope === 'person', role: scope === 'role' };
  if (want.project !== !!input.projectId) throw invalid(want.project ? 'choose the project' : 'only a project rate names a project');
  if (want.customer !== !!input.customerId) throw invalid(want.customer ? 'choose the customer' : 'only a customer rate names a customer');
  if (want.person && !input.employeeId) throw invalid('choose the person');
  if (want.role && !roleKey) throw invalid('name the role (job title)');
  if (scope === 'person' && roleKey) throw invalid('a person rate names a person');
  if (scope === 'role' && input.employeeId) throw invalid('a role rate names a role');
  if (scope === 'default' && (input.employeeId || roleKey)) throw invalid('the default rate applies to everybody');
  if (!want.person && !want.project && !want.customer && !want.role && scope !== 'default') throw invalid('unknown rate type');
  let facilityId: string | null = null;
  if (input.projectId) {
    const p = await one(tx, 'SELECT facility_id FROM project WHERE id = $1', [input.projectId]);
    if (!p) throw notFound('project');
    facilityId = p.facility_id;
  } else if (input.employeeId) {
    const e = await one(tx, 'SELECT facility_id FROM employee WHERE id = $1', [input.employeeId]);
    if (!e) throw notFound('employee');
    facilityId = e.facility_id;
  }
  if (input.customerId && !(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw notFound('customer');
  // A card that names a person inside a customer or project card is still the company-wide customer's, or the project's site card.
  requireRates(actor, input.customerId ? null : facilityId);
  const same = `scope = $1 AND project_id IS NOT DISTINCT FROM $2 AND customer_id IS NOT DISTINCT FROM $3 AND employee_id IS NOT DISTINCT FROM $4 AND role_key IS NOT DISTINCT FROM $5`;
  const key = [scope, input.projectId ?? null, input.customerId ?? null, input.employeeId ?? null, roleKey];
  if (await one(tx, `SELECT 1 FROM bill_rate WHERE ${same} AND effective_from >= $6`, [...key, input.effectiveFrom])) {
    throw conflict('a rate for the same target already starts on or after that date; end it first or choose a later start');
  }
  // The rate that was open on the new start date ends the day before: one rate per target and day.
  const ended = await many(tx, `UPDATE bill_rate SET effective_to = ($6::date - 1) WHERE ${same} AND effective_from < $6 AND (effective_to IS NULL OR effective_to >= $6) RETURNING id`, [...key, input.effectiveFrom]);
  const role = input.role?.trim() || null;
  const r = await one(tx, `INSERT INTO bill_rate (tenant_id, scope, project_id, customer_id, employee_id, role_key, role_label, amount, effective_from, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
  [actor.tenantId, scope, input.projectId ?? null, input.customerId ?? null, input.employeeId ?? null, roleKey, roleKey ? role : null, money(input.amount), input.effectiveFrom, input.note?.trim() || null, actor.userId]);
  await audit(tx, actor, { action: 'billing.rate_created', entityType: 'bill_rate', entityId: r.id, facilityId,
    data: { scope, projectId: input.projectId ?? null, customerId: input.customerId ?? null, employeeId: input.employeeId ?? null, role, amount: money(input.amount), effectiveFrom: input.effectiveFrom, endedPrevious: ended.map((x) => x.id) } });
  return { id: r.id as string, endedPrevious: ended.length };
}

export async function endRate(tx: Tx, actor: Actor, id: string, endOn: string) {
  const r = await one(tx, `SELECT r.*, p.facility_id AS project_facility, e.facility_id AS employee_facility FROM bill_rate r LEFT JOIN project p ON p.id = r.project_id LEFT JOIN employee e ON e.id = r.employee_id WHERE r.id = $1`, [id]);
  if (!r) throw notFound('rate');
  requireRates(actor, r.customer_id ? null : r.project_facility ?? r.employee_facility ?? null);
  if (endOn < r.effective_from) throw invalid('a rate cannot end before it starts');
  if (r.effective_to && r.effective_to <= endOn) throw conflict(`the rate already ends on ${r.effective_to}`);
  await tx.query('UPDATE bill_rate SET effective_to = $2 WHERE id = $1', [id, endOn]);
  await audit(tx, actor, { action: 'billing.rate_ended', entityType: 'bill_rate', entityId: id, data: { endOn, was: r.effective_to } });
}

/** "Why this rate": the rate for one person on one project on a date, with its source. */
export async function explainRate(tx: Tx, actor: Actor, q: { projectId: string; employeeId: string; date?: string }) {
  requirePermission(actor, 'billing.view');
  const p = await one(tx, 'SELECT id, customer_id FROM project WHERE id = $1', [q.projectId]);
  if (!p) throw notFound('project');
  const e = await one(tx, 'SELECT id, job_title FROM employee WHERE id = $1', [q.employeeId]);
  if (!e) throw notFound('employee');
  const date = q.date ?? today();
  const found = resolveRate(await loadRates(tx), { projectId: p.id, customerId: p.customer_id, employeeId: e.id, roleKey: roleKeyOf(e.job_title), date });
  return { date, rate: found?.amount ?? null, why: found?.why ?? 'No rate applies: add a project, customer, person, role or default rate that covers this date.', scope: found?.scope ?? null };
}

// ---- Company settings -------------------------------------------------------------------------------------------------

export interface BillingSettings { roundHoursTo: number | null; retainerIssueMode: 'draft' | 'issue' }
export async function getSettings(tx: Tx): Promise<BillingSettings> {
  const s = await one(tx, 'SELECT round_hours_to::float AS r, retainer_issue_mode AS m FROM billing_settings');
  return { roundHoursTo: s?.r ?? null, retainerIssueMode: s?.m ?? 'draft' };
}
export async function viewSettings(tx: Tx, actor: Actor) {
  requirePermission(actor, 'billing.view');
  return { ...(await getSettings(tx)), canEdit: facilitiesWith(actor, 'billing.rates').all };
}
export async function saveSettings(tx: Tx, actor: Actor, input: { roundHoursTo?: number | null; retainerIssueMode?: 'draft' | 'issue' }) {
  requireRates(actor, null);
  const prior = await getSettings(tx);
  const next = { roundHoursTo: input.roundHoursTo === undefined ? prior.roundHoursTo : input.roundHoursTo, retainerIssueMode: input.retainerIssueMode ?? prior.retainerIssueMode };
  if (next.roundHoursTo !== null && next.roundHoursTo !== 0.25) throw invalid('hours can be rounded to the nearest 0.25 hour, or not rounded');
  await tx.query(`INSERT INTO billing_settings (tenant_id, round_hours_to, retainer_issue_mode, updated_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id) DO UPDATE SET round_hours_to = EXCLUDED.round_hours_to, retainer_issue_mode = EXCLUDED.retainer_issue_mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, next.roundHoursTo, next.retainerIssueMode, actor.userId]);
  await audit(tx, actor, { action: 'billing.settings_changed', entityType: 'billing_settings', entityId: actor.tenantId, data: { from: prior, to: next } });
  return next;
}

/**
 * Hours billed for a time entry: as recorded, or (when the company rounds) to the nearest increment, half up, and never less than one
 * increment for a positive entry. Each entry is rounded on its own, so the same entry bills the same whichever run picks it up.
 */
export function billedHours(hours: number, increment: number | null) {
  if (!increment) return money(hours);
  const n = Math.floor(hours / increment + 0.5 + 1e-9);
  return money(Math.max(1, n) * increment);
}

export const canSee = (actor: Actor, facilityId: string) => can(actor, 'billing.view', facilityId);
