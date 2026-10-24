import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit, auditHistory } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one, withTx } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { featureSettings } from '../../platform/features.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { createInvoice, issueInvoice } from '../ar/service.js';
import { getSettings } from '../billing/rates.js';
import type { ChargeFacts, Interval, Period, PlanFacts } from './schedule.js';
import { addMonths, amountOn, duePeriods, INTERVAL_MONTHS, mrrOn, nextInvoiceDate, periodsThrough, periodStartOf, plusDays } from './schedule.js';

const SUBJECT = 'retainer_plan';
const money = (n: number) => Math.round((n + 1e-9 * Math.sign(n)) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
/** A plan that fell behind is caught up this many periods a day, so a long backlog does not arrive as one pile of invoices. */
const CATCH_UP_PER_RUN = 12;

interface PlanRow {
  id: string; facility_id: string; number: string; customer_id: string; customer_name: string; project_id: string | null; project_number: string | null; description: string;
  amount: number; billing_interval: Interval; start_date: string; end_date: string | null; auto_renew: boolean; renewal_term_months: number; notice_days: number; prorate: boolean;
  status: 'active' | 'paused' | 'cancelled'; cancel_on: string | null; cancel_reason: string | null; last_error: string | null; last_error_at: string | null; created_by: string; created_at: string;
}
export interface LoadedPlan { row: PlanRow; facts: PlanFacts; charges: (ChargeFacts & { id: string; amount: number; invoiceId: string | null; runId: string | null; coveredFrom: string; coveredTo: string; prorated: boolean; automatic: boolean; generatedAt: string; releasedAt: string | null; invoiceNumber: string | null; invoiceStatus: string | null })[] }

const PLAN_SELECT = `SELECT p.*, c.name AS customer_name, j.number AS project_number FROM retainer_plan p JOIN customer c ON c.id = p.customer_id LEFT JOIN project j ON j.id = p.project_id`;

async function hydrate(tx: Tx, rows: PlanRow[]): Promise<LoadedPlan[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const amounts = await many(tx, 'SELECT plan_id, effective_from, amount::float AS amount FROM retainer_plan_amount WHERE plan_id = ANY ($1) ORDER BY effective_from', [ids]);
  const pauses = await many(tx, 'SELECT plan_id, from_date, to_date FROM retainer_pause WHERE plan_id = ANY ($1) ORDER BY from_date', [ids]);
  const charges = await many(tx, `SELECT ch.id, ch.plan_id, ch.period_start, ch.status, ch.amount::float AS amount, ch.invoice_id, ch.run_id, ch.covered_from, ch.covered_to, ch.prorated, ch.automatic, ch.generated_at, ch.released_at,
      i.number AS invoice_number, i.status AS invoice_status FROM retainer_charge ch LEFT JOIN customer_invoice i ON i.id = ch.invoice_id WHERE ch.plan_id = ANY ($1) ORDER BY ch.period_start`, [ids]);
  return rows.map((row) => ({
    row,
    facts: { startDate: row.start_date, endDate: row.end_date, cancelOn: row.cancel_on, interval: row.billing_interval, prorate: row.prorate,
      amounts: amounts.filter((a) => a.plan_id === row.id).map((a) => ({ effectiveFrom: a.effective_from, amount: a.amount })),
      pauses: pauses.filter((a) => a.plan_id === row.id).map((a) => ({ from: a.from_date, to: a.to_date })) },
    charges: charges.filter((c) => c.plan_id === row.id).map((c) => ({ id: c.id, periodStart: c.period_start, status: c.status, amount: c.amount, invoiceId: c.invoice_id, runId: c.run_id, coveredFrom: c.covered_from,
      coveredTo: c.covered_to, prorated: c.prorated, automatic: c.automatic, generatedAt: c.generated_at, releasedAt: c.released_at, invoiceNumber: c.invoice_number, invoiceStatus: c.invoice_status })),
  }));
}
export async function loadPlans(tx: Tx, where = 'TRUE', params: unknown[] = []): Promise<LoadedPlan[]> {
  return hydrate(tx, await many<PlanRow>(tx, `${PLAN_SELECT} WHERE ${where} ORDER BY p.number`, params));
}

const view = (l: LoadedPlan, on: string) => {
  const r = l.row;
  const last = l.charges.filter((c) => c.status === 'generated').at(-1) ?? null;
  const next = r.status === 'cancelled' && !duePeriods(l.facts, l.charges, on).length ? null : nextInvoiceDate(l.facts, l.charges, on);
  return {
    id: r.id, number: r.number, facilityId: r.facility_id, customerId: r.customer_id, customerName: r.customer_name, projectId: r.project_id, projectNumber: r.project_number, description: r.description,
    interval: r.billing_interval, startDate: r.start_date, endDate: r.end_date, autoRenew: r.auto_renew, renewalTermMonths: r.renewal_term_months, noticeDays: r.notice_days, prorate: r.prorate,
    status: r.status, cancelOn: r.cancel_on, cancelReason: r.cancel_reason, lastError: r.last_error, lastErrorAt: r.last_error_at,
    amount: amountOn(l.facts, on), openingAmount: r.amount, mrr: money(mrrOn(l.facts, on)), nextInvoiceDate: next, behind: next !== null && next < on && r.status !== 'paused',
    lastInvoice: last ? { number: last.invoiceNumber, periodStart: last.periodStart, amount: last.amount, status: last.invoiceStatus } : null,
  };
};

export async function listPlans(tx: Tx, actor: Actor, q: { customerId?: string; status?: string; projectId?: string } = {}) {
  requirePermission(actor, 'retainers.view');
  const plans = await loadPlans(tx, `($1::uuid IS NULL OR p.customer_id = $1) AND ($2::text IS NULL OR p.status = $2) AND ($3::uuid IS NULL OR p.project_id = $3)`, [q.customerId ?? null, q.status ?? null, q.projectId ?? null]);
  const t = today();
  return plans.filter((l) => can(actor, 'retainers.view', l.row.facility_id)).map((l) => view(l, t));
}

export async function getPlan(tx: Tx, actor: Actor, id: string) {
  const [l] = await loadPlans(tx, 'p.id = $1', [id]);
  if (!l) throw notFound('retainer plan');
  requirePermission(actor, 'retainers.view', l.row.facility_id);
  const t = today();
  const due = duePeriods(l.facts, l.charges, t);
  return {
    ...view(l, t), canManage: can(actor, 'retainers.manage', l.row.facility_id),
    amounts: l.facts.amounts, pauses: l.facts.pauses,
    charges: l.charges.slice().reverse().map((c) => ({ id: c.id, periodStart: c.periodStart, coveredFrom: c.coveredFrom, coveredTo: c.coveredTo, amount: c.amount, prorated: c.prorated, status: c.status,
      invoiceId: c.invoiceId, invoiceNumber: c.invoiceNumber, invoiceStatus: c.invoiceStatus, automatic: c.automatic, generatedAt: c.generatedAt })),
    due: due.map((p) => ({ start: p.start, end: p.end, label: p.label, amount: p.amount, prorated: p.prorated, released: p.released })),
    upcoming: periodsThrough(l.facts, plusDays(t, 120)).filter((p) => p.start > t && !p.skipped).slice(0, 4).map((p) => ({ start: p.start, label: p.label, amount: p.amount, prorated: p.prorated })),
    history: await auditHistory(tx, SUBJECT, id),
  };
}

async function lockPlan(tx: Tx, id: string): Promise<LoadedPlan> {
  await tx.query('SELECT 1 FROM retainer_plan WHERE id = $1 FOR UPDATE', [id]);
  const [l] = await loadPlans(tx, 'p.id = $1', [id]);
  if (!l) throw notFound('retainer plan');
  return l;
}

export async function createPlan(tx: Tx, actor: Actor, input: { facilityId?: string | null; customerId: string; projectId?: string | null; description: string; amount: number; interval: Interval; startDate: string;
  endDate?: string | null; autoRenew?: boolean; renewalTermMonths?: number; noticeDays?: number; prorate?: boolean }) {
  if (!(input.amount > 0)) throw invalid('the amount must be more than zero');
  if (!(input.interval in INTERVAL_MONTHS)) throw invalid('the interval is month, quarter or year');
  if (!input.description?.trim()) throw invalid('describe what the customer pays for');
  if (input.endDate && input.endDate < input.startDate) throw invalid('the end date is before the start date');
  if (input.autoRenew && !input.endDate) throw invalid('a plan that renews itself needs a term end date');
  const c = await one(tx, 'SELECT id FROM customer WHERE id = $1', [input.customerId]);
  if (!c) throw notFound('customer');
  let facilityId = input.facilityId ?? null;
  if (input.projectId) {
    const p = await one(tx, 'SELECT customer_id, facility_id FROM project WHERE id = $1', [input.projectId]);
    if (!p) throw notFound('project');
    if (p.customer_id && p.customer_id !== input.customerId) throw invalid('the project belongs to another customer');
    facilityId = facilityId ?? p.facility_id;
  }
  facilityId = facilityId ?? actor.grants.find((g) => g.facilityId)?.facilityId ?? (await one(tx, 'SELECT id FROM facility ORDER BY created_at LIMIT 1'))?.id;
  requirePermission(actor, 'retainers.manage', facilityId);
  const number = `RP-${String(await nextSequence(tx, actor.tenantId, 'retainer_plan')).padStart(6, '0')}`;
  const p = await one(tx, `INSERT INTO retainer_plan (tenant_id, facility_id, number, customer_id, project_id, description, amount, billing_interval, start_date, end_date, auto_renew, renewal_term_months, notice_days, prorate, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
  [actor.tenantId, facilityId, number, input.customerId, input.projectId ?? null, input.description.trim(), money(input.amount), input.interval, input.startDate, input.endDate ?? null, input.autoRenew ?? false,
    input.renewalTermMonths ?? 12, input.noticeDays ?? 30, input.prorate ?? true, actor.userId]);
  await tx.query('INSERT INTO retainer_plan_amount (tenant_id, plan_id, effective_from, amount, created_by) VALUES ($1, $2, $3, $4, $5)', [actor.tenantId, p.id, input.startDate, money(input.amount), actor.userId]);
  await audit(tx, actor, { action: 'retainers.plan_created', entityType: SUBJECT, entityId: p.id, facilityId, data: { number, customerId: input.customerId, amount: money(input.amount), interval: input.interval, startDate: input.startDate, endDate: input.endDate ?? null } });
  return { id: p.id as string, number };
}

export async function updatePlan(tx: Tx, actor: Actor, id: string, input: { description?: string; noticeDays?: number; autoRenew?: boolean; renewalTermMonths?: number; prorate?: boolean }) {
  const l = await lockPlan(tx, id);
  requirePermission(actor, 'retainers.manage', l.row.facility_id);
  if (l.row.status === 'cancelled') throw conflict('the plan is cancelled');
  if (input.prorate !== undefined && input.prorate !== l.row.prorate && l.charges.length) throw conflict('proration cannot change once an invoice has been made');
  if (input.autoRenew && !l.row.end_date) throw invalid('a plan that renews itself needs a term end date');
  await tx.query(`UPDATE retainer_plan SET description = coalesce($2, description), notice_days = coalesce($3, notice_days), auto_renew = coalesce($4, auto_renew), renewal_term_months = coalesce($5, renewal_term_months),
    prorate = coalesce($6, prorate), updated_at = now() WHERE id = $1`, [id, input.description?.trim() || null, input.noticeDays ?? null, input.autoRenew ?? null, input.renewalTermMonths ?? null, input.prorate ?? null]);
  await audit(tx, actor, { action: 'retainers.plan_updated', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id, data: input });
}

export async function pausePlan(tx: Tx, actor: Actor, id: string, input: { from?: string; reason?: string | null }) {
  const l = await lockPlan(tx, id);
  requirePermission(actor, 'retainers.manage', l.row.facility_id);
  if (l.row.status !== 'active') throw conflict(`the plan is ${l.row.status}`);
  const from = input.from ?? today();
  await tx.query(`INSERT INTO retainer_pause (tenant_id, plan_id, from_date, reason, created_by) VALUES ($1, $2, $3, $4, $5)`, [actor.tenantId, id, from, input.reason?.trim() || null, actor.userId]);
  await tx.query(`UPDATE retainer_plan SET status = 'paused', updated_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'retainers.paused', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id, data: { from, reason: input.reason ?? null } });
}

export async function resumePlan(tx: Tx, actor: Actor, id: string, input: { on?: string }) {
  const l = await lockPlan(tx, id);
  requirePermission(actor, 'retainers.manage', l.row.facility_id);
  if (l.row.status !== 'paused') throw conflict(`the plan is ${l.row.status}`);
  const open = await one(tx, 'SELECT id, from_date FROM retainer_pause WHERE plan_id = $1 AND to_date IS NULL ORDER BY from_date DESC LIMIT 1', [id]);
  const on = input.on ?? today();
  if (open && on < open.from_date) throw invalid(`the pause began on ${open.from_date}; resume on or after that day`);
  if (open) await tx.query('UPDATE retainer_pause SET to_date = $2 WHERE id = $1', [open.id, on]);
  await tx.query(`UPDATE retainer_plan SET status = 'active', updated_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'retainers.resumed', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id, data: { on } });
}

/** A new amount from the first day of a period that has not been invoiced. */
export async function changeAmount(tx: Tx, actor: Actor, id: string, input: { effectiveFrom: string; amount: number; reason?: string | null }) {
  const l = await lockPlan(tx, id);
  requirePermission(actor, 'retainers.manage', l.row.facility_id);
  if (l.row.status === 'cancelled') throw conflict('the plan is cancelled');
  if (!(input.amount > 0)) throw invalid('the amount must be more than zero');
  if (periodStartOf(input.effectiveFrom, l.row.billing_interval) !== input.effectiveFrom) throw invalid(`a new amount starts on the first day of a ${l.row.billing_interval}, such as ${nextBoundary(l)}`);
  if (input.effectiveFrom <= l.row.start_date) throw invalid('the opening amount is changed by cancelling and creating a plan; a new amount starts after the plan does');
  const charged = l.charges.filter((c) => c.periodStart >= input.effectiveFrom);
  if (charged.length) throw conflict(`the period starting ${charged[0]!.periodStart} has already been invoiced; choose ${nextBoundary(l)} or later, or void that invoice first`);
  const ins = await tx.query('INSERT INTO retainer_plan_amount (tenant_id, plan_id, effective_from, amount, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (plan_id, effective_from) DO NOTHING', [actor.tenantId, id, input.effectiveFrom, money(input.amount), actor.userId]);
  if (!ins.rowCount) throw conflict(`an amount change from ${input.effectiveFrom} is already recorded; choose another period`);
  await audit(tx, actor, { action: 'retainers.amount_changed', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id,
    data: { from: input.effectiveFrom, previous: amountOn(l.facts, input.effectiveFrom), amount: money(input.amount), reason: input.reason ?? null } });
}
const nextBoundary = (l: LoadedPlan) => {
  const last = l.charges.at(-1)?.periodStart;
  const start = last ? periodStartOf(plusDays(last, 40), l.row.billing_interval) : periodStartOf(plusDays(l.row.start_date, 40), l.row.billing_interval);
  return start > today() ? start : periodStartOf(plusDays(today(), 40), l.row.billing_interval);
};

export async function cancelPlan(tx: Tx, actor: Actor, id: string, input: { effectiveOn: string; reason: string }) {
  const l = await lockPlan(tx, id);
  requirePermission(actor, 'retainers.manage', l.row.facility_id);
  if (l.row.status === 'cancelled') throw conflict('the plan is already cancelled');
  if (!input.reason?.trim()) throw invalid('say why the plan is cancelled');
  if (input.effectiveOn < l.row.start_date) throw invalid('the cancellation cannot be before the plan starts');
  const beyond = l.charges.filter((c) => c.status === 'generated' && c.coveredTo > input.effectiveOn);
  if (beyond.length) throw conflict(`the period ${beyond[0]!.coveredFrom} to ${beyond[0]!.coveredTo} is already invoiced; cancel from ${beyond[0]!.coveredTo} or void that invoice first`);
  const status = input.effectiveOn <= today() ? 'cancelled' : l.row.status;
  await tx.query(`UPDATE retainer_plan SET cancel_on = $2, cancel_reason = $3, status = $4, updated_at = now() WHERE id = $1`, [id, input.effectiveOn, input.reason.trim(), status]);
  if (l.row.status === 'paused') await tx.query('UPDATE retainer_pause SET to_date = $2 WHERE plan_id = $1 AND to_date IS NULL AND $2 >= from_date', [id, input.effectiveOn]);
  await audit(tx, actor, { action: 'retainers.cancelled', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id, data: { effectiveOn: input.effectiveOn, reason: input.reason.trim() } });
}

/** Extends the term (by the plan's renewal term, or to a date). A plan that ended with its term can be renewed back to life. */
export async function renewPlan(tx: Tx, actor: Actor, id: string, input: { endDate?: string; months?: number }, automatic = false) {
  const l = await lockPlan(tx, id);
  if (!automatic) requirePermission(actor, 'retainers.manage', l.row.facility_id);
  if (!l.row.end_date) throw invalid('an open-ended plan has no term to renew');
  const endedByTerm = l.row.status === 'cancelled' && l.row.cancel_on === l.row.end_date;
  if (l.row.status === 'cancelled' && !endedByTerm) throw conflict('the plan was cancelled; create a new plan');
  const end = input.endDate ?? addMonths(l.row.end_date, input.months ?? l.row.renewal_term_months);
  if (end <= l.row.end_date) throw invalid('the new end date must be after the current one');
  await tx.query(`UPDATE retainer_plan SET end_date = $2, status = CASE WHEN status = 'cancelled' THEN 'active' ELSE status END, cancel_on = CASE WHEN status = 'cancelled' THEN NULL ELSE cancel_on END,
    cancel_reason = CASE WHEN status = 'cancelled' THEN NULL ELSE cancel_reason END, updated_at = now() WHERE id = $1`, [id, end]);
  await audit(tx, actor, { action: automatic ? 'retainers.auto_renewed' : 'retainers.renewed', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id, data: { from: l.row.end_date, to: end } });
  return { endDate: end };
}

// ---- Generating invoices -----------------------------------------------------------------------------------------------

/** Scheduled invoices are made in the name of the person who set the plan up, with only the receivables right they need at this one site. */
function planActor(l: LoadedPlan, tenantId: string): Actor {
  return { userId: l.row.created_by, tenantId, employeeId: null, displayName: 'Scheduled billing',
    grants: [{ facilityId: l.row.facility_id, permissions: new Set(['ar.manage', 'ar.view']), roles: new Set() }] };
}
const retainerLine = (l: LoadedPlan, p: Period) =>
  `${l.row.description}, ${p.label}${p.prorated ? ` (prorated: ${p.coveredFrom} to ${p.coveredTo})` : ''}`;

/** Makes the charge and its draft (or issued) invoice for one period. Safe to repeat: a period with a live charge is refused. */
async function generatePeriod(tx: Tx, actor: Actor, l: LoadedPlan, p: Period, o: { automatic: boolean; blobs?: BlobStore; issue: boolean }) {
  const ch = await one(tx, `INSERT INTO retainer_charge (tenant_id, plan_id, period_start, period_end, covered_from, covered_to, amount, prorated, automatic, generated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (plan_id, period_start) DO UPDATE SET status = 'generated', released_at = NULL, invoice_id = NULL, run_id = NULL, amount = EXCLUDED.amount, covered_from = EXCLUDED.covered_from,
      covered_to = EXCLUDED.covered_to, prorated = EXCLUDED.prorated, automatic = EXCLUDED.automatic, generated_by = EXCLUDED.generated_by, generated_at = now()
      WHERE retainer_charge.status = 'released' RETURNING id`,
  [actor.tenantId, l.row.id, p.start, p.end, p.coveredFrom, p.coveredTo, p.amount, p.prorated, o.automatic, actor.userId]);
  if (!ch) throw conflict(`the period ${p.label} already has an invoice`);
  let invoiceId: string | null = null;
  if (p.amount >= 0.01) {
    const inv = await createInvoice(tx, actor, { customerId: l.row.customer_id, facilityId: l.row.facility_id, notes: `Retainer ${l.row.number}`,
      lines: [{ description: retainerLine(l, p), qty: 1, unitPrice: p.amount, accountKey: 'service_revenue' }] });
    invoiceId = inv.id;
    await tx.query('UPDATE customer_invoice_line SET project_id = $2, retainer_charge_id = $3 WHERE invoice_id = $1', [inv.id, l.row.project_id, ch.id]);
    await tx.query('UPDATE retainer_charge SET invoice_id = $2 WHERE id = $1', [ch.id, inv.id]);
    if (o.issue && o.blobs) await issueInvoice(tx, actor, o.blobs, inv.id);
  }
  await audit(tx, actor, { action: 'retainers.period_invoiced', entityType: SUBJECT, entityId: l.row.id, facilityId: l.row.facility_id,
    data: { period: p.start, amount: p.amount, prorated: p.prorated, invoiceId, automatic: o.automatic, issued: !!(invoiceId && o.issue) } });
  return { chargeId: ch.id as string, invoiceId };
}

/** By hand: invoice the plan's due periods (a released period too). One call makes at most the periods that are due now. */
export async function generateNow(tx: Tx, actor: Actor, blobs: BlobStore, id: string, input: { periodStart?: string } = {}) {
  const l = await lockPlan(tx, id);
  requirePermission(actor, 'retainers.manage', l.row.facility_id);
  requirePermission(actor, 'ar.manage', l.row.facility_id);
  const due = duePeriods(l.facts, l.charges, today()).filter((p) => !input.periodStart || p.start === input.periodStart);
  if (!due.length) throw invalid(input.periodStart ? 'that period is not due, or already has an invoice' : 'no period is due');
  const settings = await getSettings(tx);
  const made: { period: string; invoiceId: string | null }[] = [];
  for (const p of due.slice(0, CATCH_UP_PER_RUN)) {
    const r = await generatePeriod(tx, actor, l, p, { automatic: false, blobs, issue: settings.retainerIssueMode === 'issue' });
    made.push({ period: p.start, invoiceId: r.invoiceId });
  }
  await tx.query('UPDATE retainer_plan SET last_error = NULL, last_error_at = NULL WHERE id = $1', [id]);
  return { made };
}

/**
 * The daily job's step for one company: renew what renews itself, make each plan's due periods (one invoice per plan per period, drafts
 * unless the company issues them), then close plans whose term or cancellation date has passed. One plan failing is recorded on the plan
 * and does not stop the others.
 */
export async function runRetainers(tenantId: string, blobs?: BlobStore, on = today()) {
  return withTx({ tenantId, userId: null, facilityIds: [], allFacilities: true }, async (tx) => {
    const out = { generated: 0, issued: 0, failed: 0, renewed: 0, ended: 0, skipped: 0 };
    if ((await featureSettings(tx, tenantId)).get('retainers')?.mode === 'off') return out;
    const settings = await getSettings(tx);
    const ids = (await many(tx, `SELECT id FROM retainer_plan ORDER BY number`)).map((r) => r.id as string);
    for (const id of ids) {
      await tx.query('SAVEPOINT plan_step');
      try {
        let l = await lockPlan(tx, id);
        const sys = planActor(l, tenantId);
        // Renewal first: a plan that renews itself keeps billing past its old end date.
        if (l.row.auto_renew && l.row.end_date && l.row.end_date < on && !(l.row.cancel_on && l.row.cancel_on <= l.row.end_date)) {
          let guard = 0;
          while (l.row.end_date! < on && guard++ < 60) { await renewPlan(tx, sys, id, {}, true); l = await lockPlan(tx, id); out.renewed++; }
        }
        const due = duePeriods(l.facts, l.charges, on).filter((p) => !p.released);
        let n = 0;
        for (const p of due.slice(0, CATCH_UP_PER_RUN)) {
          const r = await generatePeriod(tx, sys, l, p, { automatic: true, blobs, issue: settings.retainerIssueMode === 'issue' });
          n++; out.generated++;
          if (r.invoiceId && settings.retainerIssueMode === 'issue' && blobs) out.issued++;
        }
        if (due.length > CATCH_UP_PER_RUN) out.skipped += due.length - CATCH_UP_PER_RUN;
        // Close: term ended without renewal, or the cancellation date has come.
        l = await lockPlan(tx, id);
        const remaining = duePeriods(l.facts, l.charges, on).filter((p) => !p.released).length;
        if (l.row.status !== 'cancelled' && !remaining) {
          if (l.row.cancel_on && l.row.cancel_on <= on) {
            await tx.query(`UPDATE retainer_plan SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
            await audit(tx, sys, { action: 'retainers.closed', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id, data: { reason: 'cancellation date reached', on: l.row.cancel_on, automatic: true } });
            out.ended++;
          } else if (l.row.end_date && l.row.end_date < on && !l.row.auto_renew) {
            await tx.query(`UPDATE retainer_plan SET status = 'cancelled', cancel_on = end_date, cancel_reason = 'Term ended without renewal', updated_at = now() WHERE id = $1`, [id]);
            await audit(tx, sys, { action: 'retainers.closed', entityType: SUBJECT, entityId: id, facilityId: l.row.facility_id, data: { reason: 'term ended without renewal', on: l.row.end_date, automatic: true } });
            out.ended++;
          }
        }
        if (n || l.row.last_error) await tx.query('UPDATE retainer_plan SET last_error = NULL, last_error_at = NULL WHERE id = $1', [id]);
        await tx.query('RELEASE SAVEPOINT plan_step');
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT plan_step');
        await tx.query('RELEASE SAVEPOINT plan_step');
        await tx.query('UPDATE retainer_plan SET last_error = $2, last_error_at = now() WHERE id = $1', [id, (e as Error).message.slice(0, 300)]);
        out.failed++;
      }
    }
    return out;
  });
}

// ---- Billing run integration -----------------------------------------------------------------------------------------------

/** Retainer periods due by `to` for a customer, as items a billing run can put on its invoice (those the daily job has not already invoiced). */
export async function retainerItemsDue(tx: Tx, s: { facilityIds: string[]; customerId: string; projectId: string | null; to: string }) {
  const plans = await loadPlans(tx, `p.customer_id = $1 AND p.facility_id = ANY ($2) AND ($3::uuid IS NULL OR p.project_id = $3)`, [s.customerId, s.facilityIds, s.projectId]);
  const items = [];
  for (const l of plans) {
    for (const p of duePeriods(l.facts, l.charges, s.to)) {
      items.push({
        key: `retainer:${l.row.id}:${p.start}`, kind: 'retainer' as const, sourceId: l.row.id, periodStart: p.start, facilityId: l.row.facility_id, projectId: l.row.project_id, projectNumber: l.row.project_number,
        projectName: null, taskId: null, taskName: null, date: p.start, who: null, note: null, recordedHours: null, hours: null, qty: 1, unitPrice: p.amount, listAmount: p.amount, rateId: null, rateWhy: null,
        defaultDescription: retainerLine(l, p), held: false, holdReason: null, blocked: p.amount < 0.01 ? 'The prorated amount rounds to nothing.' : null,
        retainerPeriodEnd: p.end, retainerPlanNumber: l.row.number,
      });
    }
  }
  return items;
}

/** A billing run puts a due period on its own invoice line: the charge is recorded against the run and the invoice. */
export async function claimPeriodForRun(tx: Tx, actor: Actor, o: { planId: string; periodStart: string; runId: string; invoiceId: string; lineId: string; expectAmount: number }) {
  const l = await lockPlan(tx, o.planId);
  const p = duePeriods(l.facts, l.charges, plusDays(o.periodStart, 0)).find((x) => x.start === o.periodStart);
  if (!p) throw conflict(`retainer ${l.row.number}: the period starting ${o.periodStart} was invoiced meanwhile`);
  if (Math.abs(p.amount - o.expectAmount) > 0.004) throw conflict(`retainer ${l.row.number}: the amount for ${p.label} changed; reload the run`);
  const ch = await one(tx, `INSERT INTO retainer_charge (tenant_id, plan_id, period_start, period_end, covered_from, covered_to, amount, prorated, automatic, generated_by, invoice_id, run_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11)
    ON CONFLICT (plan_id, period_start) DO UPDATE SET status = 'generated', released_at = NULL, invoice_id = EXCLUDED.invoice_id, run_id = EXCLUDED.run_id, amount = EXCLUDED.amount, automatic = false,
      generated_by = EXCLUDED.generated_by, generated_at = now() WHERE retainer_charge.status = 'released' RETURNING id`,
  [actor.tenantId, o.planId, p.start, p.end, p.coveredFrom, p.coveredTo, p.amount, p.prorated, actor.userId, o.invoiceId, o.runId]);
  if (!ch) throw conflict(`retainer ${l.row.number}: ${p.label} already has an invoice`);
  await tx.query('UPDATE customer_invoice_line SET retainer_charge_id = $2 WHERE id = $1', [o.lineId, ch.id]);
  await audit(tx, actor, { action: 'retainers.period_invoiced', entityType: SUBJECT, entityId: o.planId, facilityId: l.row.facility_id, data: { period: p.start, amount: p.amount, invoiceId: o.invoiceId, runId: o.runId, automatic: false } });
}

// ---- Reminders ---------------------------------------------------------------------------------------------------------------

type Sweep = { on: (k: string) => boolean; lead: (k: string) => number; period: (k: string) => string };
/** Plans reaching their notice window, and plans whose scheduled invoice failed. Dedupe keys keep each notice from repeating. */
export async function retainerReminders(tx: Tx, tenantId: string, on: string, R: Sweep) {
  const counts = { renewals: 0, failed: 0 };
  if (R.on('retainer_renewal')) {
    const plans = await many(tx, `SELECT p.id, p.number, p.facility_id, p.end_date, p.auto_renew, p.notice_days, c.name AS customer FROM retainer_plan p JOIN customer c ON c.id = p.customer_id
      WHERE p.status <> 'cancelled' AND p.end_date IS NOT NULL AND p.end_date >= $1::date AND p.end_date - $1::date <= p.notice_days`, [on]);
    for (const p of plans) {
      counts.renewals += await notify(tx, tenantId, await usersWithPermission(tx, 'retainers.manage', p.facility_id), { kind: 'reminder.retainer_renewal',
        title: `Retainer ${p.number} for ${p.customer} ${p.auto_renew ? 'renews' : 'ends'} ${p.end_date}`,
        body: p.auto_renew ? 'It renews by itself unless the customer gives notice. Confirm the terms and price now.' : 'It ends then unless it is renewed. Renew it or let it end.',
        link: `/retainers/${p.id}`, subjectType: SUBJECT, subjectId: p.id, dedupeKey: `retainer-renewal:${p.id}:${p.end_date}:${R.period('retainer_renewal')}` });
    }
  }
  if (R.on('retainer_failed')) {
    const bad = await many(tx, `SELECT p.id, p.number, p.facility_id, p.last_error, c.name AS customer FROM retainer_plan p JOIN customer c ON c.id = p.customer_id WHERE p.last_error IS NOT NULL AND p.status <> 'cancelled'`);
    for (const p of bad) {
      counts.failed += await notify(tx, tenantId, await usersWithPermission(tx, 'retainers.manage', p.facility_id), { kind: 'reminder.retainer_failed',
        title: `The scheduled invoice for retainer ${p.number} (${p.customer}) could not be made`, body: p.last_error, link: `/retainers/${p.id}`, subjectType: SUBJECT, subjectId: p.id,
        dedupeKey: `retainer-failed:${p.id}:${R.period('retainer_failed')}` });
    }
  }
  return counts;
}

/** What is late: plans whose invoice is behind schedule or failed. */
export async function lateRetainers(tx: Tx, facilityIds: string[], on = today()) {
  const plans = await loadPlans(tx, `p.facility_id = ANY ($1) AND (p.status <> 'cancelled' OR p.last_error IS NOT NULL)`, [facilityIds]);
  const rows: { id: string; number: string; customer: string; detail: string; daysLate: number; amount: number | null; owner: string | null }[] = [];
  for (const l of plans) {
    const next = nextInvoiceDate(l.facts, l.charges, on);
    const behind = next !== null && next < plusDays(on, -3) && l.row.status !== 'paused';
    if (!behind && !l.row.last_error) continue;
    rows.push({ id: l.row.id, number: l.row.number, customer: l.row.customer_name, detail: l.row.last_error ? `Scheduled invoice failed: ${l.row.last_error}` : `Invoice for the period starting ${next} has not been made`,
      daysLate: next ? Math.max(0, Math.round((Date.parse(`${on}T00:00:00Z`) - Date.parse(`${next}T00:00:00Z`)) / 86_400_000)) : 0, amount: next ? periodsThrough(l.facts, next).find((p) => p.start === next)?.amount ?? null : null, owner: null });
  }
  return rows;
}

export { addMonths };
