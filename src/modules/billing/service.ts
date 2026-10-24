import { randomUUID } from 'node:crypto';
import type { Actor } from '../../platform/auth/actor.js';
import { can, facilitiesWith, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { createInvoice } from '../ar/service.js';
import { claimPeriodForRun } from '../retainers/service.js';
import { getSettings, loadRates, money, today } from './rates.js';
import type { Item, ItemKind, Scope } from './sources.js';
import { collect, expenseColumnsExist } from './sources.js';

export const SUBJECT = 'billing_run';

export interface RunRow { id: string; facility_id: string; number: string; customer_id: string; customer_name: string; project_id: string | null; project_number: string | null; period_from: string; period_to: string;
  status: 'open' | 'invoiced' | 'closed' | 'cancelled'; invoice_id: string | null; invoice_number: string | null; invoice_status: string | null; notes: string | null; cancel_reason: string | null;
  created_by_name: string; created_at: string; invoiced_at: string | null }

const RUN_SELECT = `SELECT r.*, c.name AS customer_name, p.number AS project_number, i.number AS invoice_number, i.status AS invoice_status, u.display_name AS created_by_name
  FROM billing_run r JOIN customer c ON c.id = r.customer_id LEFT JOIN project p ON p.id = r.project_id LEFT JOIN customer_invoice i ON i.id = r.invoice_id JOIN app_user u ON u.id = r.created_by`;

async function runOf(tx: Tx, id: string, lock = false): Promise<RunRow> {
  if (lock) await tx.query('SELECT 1 FROM billing_run WHERE id = $1 FOR UPDATE', [id]);
  const r = await one<RunRow>(tx, `${RUN_SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw notFound('billing run');
  return r;
}

export async function createRun(tx: Tx, actor: Actor, input: { customerId: string; projectId?: string | null; facilityId?: string | null; periodFrom: string; periodTo: string; notes?: string | null }) {
  if (input.periodTo < input.periodFrom) throw invalid('the period ends before it starts');
  const c = await one(tx, 'SELECT id FROM customer WHERE id = $1', [input.customerId]);
  if (!c) throw notFound('customer');
  let facilityId = input.facilityId ?? null;
  if (input.projectId) {
    const p = await one(tx, 'SELECT customer_id, facility_id FROM project WHERE id = $1', [input.projectId]);
    if (!p) throw notFound('project');
    if (p.customer_id !== input.customerId) throw invalid('the project belongs to another customer');
    if (facilityId && facilityId !== p.facility_id) throw invalid('the project belongs to another site');
    facilityId = p.facility_id;
  }
  if (!facilityId) {
    const sites = (await many(tx, 'SELECT DISTINCT facility_id FROM project WHERE customer_id = $1', [input.customerId])).map((r) => r.facility_id as string).filter((f) => can(actor, 'billing.manage', f));
    if (sites.length === 1) facilityId = sites[0]!;
    else if (sites.length > 1) throw invalid('this customer has projects at more than one site; choose the site to bill from');
    else facilityId = actor.grants.find((g) => g.facilityId)?.facilityId ?? (await one(tx, 'SELECT id FROM facility ORDER BY created_at LIMIT 1'))?.id;
  }
  requirePermission(actor, 'billing.manage', facilityId);
  const number = `BR-${String(await nextSequence(tx, actor.tenantId, 'billing_run')).padStart(6, '0')}`;
  const r = await one(tx, `INSERT INTO billing_run (tenant_id, facility_id, number, customer_id, project_id, period_from, period_to, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [actor.tenantId, facilityId, number, input.customerId, input.projectId ?? null, input.periodFrom, input.periodTo, input.notes?.trim() || null, actor.userId]);
  await audit(tx, actor, { action: 'billing.run_created', entityType: SUBJECT, entityId: r.id, facilityId, data: { number, customerId: input.customerId, projectId: input.projectId ?? null, from: input.periodFrom, to: input.periodTo } });
  return { id: r.id as string, number };
}

// ---- The run, priced ------------------------------------------------------------------------------------------------------

export type LineStatus = 'billable' | 'held' | 'blocked' | 'written_off';
export interface Line extends Item {
  description: string; customDescription: string | null; writedown: number; writeOff: boolean; adjustReason: string | null; net: number; status: LineStatus;
  /** What goes on the invoice line. */
  invQty: number; invUnit: number; invDescription: string;
}
interface Adj { source_key: string; description: string | null; writedown: number; write_off: boolean; reason: string | null }

function priceLine(it: Item, adj: Adj | undefined): Line {
  const customDescription = adj?.description?.trim() || null;
  const description = customDescription ?? it.defaultDescription;
  const writeOff = !!adj?.write_off;
  const writedown = writeOff ? 0 : Math.min(adj?.writedown ?? 0, it.listAmount);
  const net = writeOff ? 0 : money(it.listAmount - writedown);
  const status: LineStatus = it.held ? 'held' : it.blocked ? 'blocked' : writeOff ? 'written_off' : 'billable';
  let invQty = 1, invUnit = net, invDescription = description;
  if (it.kind === 'time' && it.hours && it.hours > 0) {
    const unit = writedown === 0 ? it.unitPrice : Math.round((net / it.hours) * 10000) / 10000;
    if (Math.abs(it.hours * unit - net) <= 0.005) { invQty = it.hours; invUnit = unit; } else invDescription = `${description} (${it.hours} h)`;
  }
  return { ...it, description, customDescription, writedown, writeOff, adjustReason: adj?.reason ?? null, net, status, invQty, invUnit, invDescription };
}

export interface Group { projectId: string | null; projectNumber: string | null; projectName: string | null; subtotal: number; tasks: { taskId: string | null; taskName: string | null; lines: Line[]; subtotal: number }[] }

export function totalsOf(lines: Line[]) {
  const billable = lines.filter((l) => l.status === 'billable');
  const exact = billable.reduce((s, l) => s + l.invQty * l.invUnit, 0);
  const byKind: Partial<Record<ItemKind, number>> = {};
  for (const l of billable) byKind[l.kind] = money((byKind[l.kind] ?? 0) + l.net);
  return {
    lines: billable.length, hours: money(billable.reduce((s, l) => s + (l.hours ?? 0), 0)), list: money(billable.reduce((s, l) => s + l.listAmount, 0)), writedown: money(billable.reduce((s, l) => s + l.writedown, 0)),
    net: money(exact), writtenOffCount: lines.filter((l) => l.status === 'written_off').length, writtenOff: money(lines.filter((l) => l.status === 'written_off').reduce((s, l) => s + l.listAmount, 0)),
    heldCount: lines.filter((l) => l.status === 'held').length, heldValue: money(lines.filter((l) => l.status === 'held').reduce((s, l) => s + l.listAmount, 0)),
    blockedCount: lines.filter((l) => l.status === 'blocked').length, byKind,
  };
}

function groupLines(lines: Line[]): Group[] {
  const groups: Group[] = [];
  for (const l of lines) {
    let g = groups.find((x) => x.projectId === l.projectId);
    if (!g) { g = { projectId: l.projectId, projectNumber: l.projectNumber, projectName: l.projectName, subtotal: 0, tasks: [] }; groups.push(g); }
    let t = g.tasks.find((x) => x.taskId === l.taskId);
    if (!t) { t = { taskId: l.taskId, taskName: l.taskName, lines: [], subtotal: 0 }; g.tasks.push(t); }
    t.lines.push(l);
    if (l.status === 'billable') { t.subtotal = money(t.subtotal + l.net); g.subtotal = money(g.subtotal + l.net); }
  }
  return groups;
}

const runScope = (r: RunRow): Scope => ({ facilityIds: [r.facility_id], customerId: r.customer_id, projectId: r.project_id, from: r.period_from, to: r.period_to });

/** The run as it stands now: sources, rates, holds and the person's edits. Computed on every read, so it is never stale. */
export async function computeRun(tx: Tx, r: RunRow) {
  const settings = await getSettings(tx);
  const rates = await loadRates(tx);
  const { items, excluded } = await collect(tx, runScope(r), settings, rates, today(), { retainers: true });
  const adjs = await many<Adj>(tx, 'SELECT source_key, description, writedown::float AS writedown, write_off, reason FROM billing_adjustment WHERE run_id = $1', [r.id]);
  const by = new Map(adjs.map((a) => [a.source_key, a]));
  const lines = items.map((i) => priceLine(i, by.get(i.key)));
  return { lines, groups: groupLines(lines), totals: totalsOf(lines), excluded, settings };
}

export async function getRun(tx: Tx, actor: Actor, id: string) {
  const r = await runOf(tx, id);
  requirePermission(actor, 'billing.view', r.facility_id);
  const base = {
    id: r.id, number: r.number, facilityId: r.facility_id, customerId: r.customer_id, customerName: r.customer_name, projectId: r.project_id, projectNumber: r.project_number,
    periodFrom: r.period_from, periodTo: r.period_to, status: r.status, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, invoiceStatus: r.invoice_status, notes: r.notes,
    cancelReason: r.cancel_reason, createdBy: r.created_by_name, createdAt: r.created_at, invoicedAt: r.invoiced_at,
    canManage: can(actor, 'billing.manage', r.facility_id), canWriteOff: can(actor, 'billing.writeoff', r.facility_id), canInvoice: can(actor, 'billing.manage', r.facility_id) && can(actor, 'ar.manage', r.facility_id),
  };
  if (r.status !== 'open') {
    const claims = await many(tx, `SELECT k.source_kind, k.source_id, k.status, k.list_amount::float AS list, k.writedown::float AS writedown, k.amount::float AS amount, k.writedown_reason, k.released_at FROM billing_claim k WHERE k.run_id = $1 ORDER BY k.claimed_at`, [id]);
    const live = claims.filter((c) => !c.released_at);
    return { ...base, groups: [] as Group[], excluded: [], totals: null, outcome: { billed: money(live.filter((c) => c.status === 'billed').reduce((s, c) => s + c.amount, 0)), lines: live.filter((c) => c.status === 'billed').length,
      writtenDown: money(live.reduce((s, c) => s + (c.status === 'billed' ? c.writedown : 0), 0)), writtenOff: money(live.filter((c) => c.status === 'written_off').reduce((s, c) => s + c.list, 0)),
      writtenOffItems: live.filter((c) => c.status === 'written_off').map((c) => ({ kind: c.source_kind, sourceId: c.source_id, amount: c.list, reason: c.writedown_reason })) } };
  }
  const c = await computeRun(tx, r);
  return { ...base, groups: c.groups, excluded: c.excluded, totals: c.totals, outcome: null, settings: c.settings, expenseColumns: await expenseColumnsExist(tx) };
}

export async function listRuns(tx: Tx, actor: Actor, q: { status?: string; customerId?: string; projectId?: string } = {}) {
  requirePermission(actor, 'billing.view');
  const rows = await many(tx, `SELECT r.id, r.number, r.facility_id, r.status, r.period_from, r.period_to, r.created_at, r.customer_id, c.name AS customer_name, p.number AS project_number, i.number AS invoice_number, i.status AS invoice_status,
      coalesce((SELECT sum(k.amount) FROM billing_claim k WHERE k.run_id = r.id AND k.released_at IS NULL AND k.status = 'billed'), 0)::float AS billed,
      coalesce((SELECT sum(k.writedown) FROM billing_claim k WHERE k.run_id = r.id AND k.released_at IS NULL AND k.status = 'billed'), 0)::float AS writtendown,
      coalesce((SELECT sum(k.list_amount) FROM billing_claim k WHERE k.run_id = r.id AND k.released_at IS NULL AND k.status = 'written_off'), 0)::float AS writtenoff
    FROM billing_run r JOIN customer c ON c.id = r.customer_id LEFT JOIN project p ON p.id = r.project_id LEFT JOIN customer_invoice i ON i.id = r.invoice_id
    WHERE ($1::text IS NULL OR r.status = $1) AND ($2::uuid IS NULL OR r.customer_id = $2) AND ($3::uuid IS NULL OR r.project_id = $3) ORDER BY r.created_at DESC LIMIT 300`, [q.status ?? null, q.customerId ?? null, q.projectId ?? null]);
  return rows.filter((r) => can(actor, 'billing.view', r.facility_id));
}

// ---- Edits ----------------------------------------------------------------------------------------------------------------

/** A new description for a line, a write-down (part of the price) or a write-off (all of it). Write-downs and write-offs need a reason and `billing.writeoff`. */
export async function adjustLine(tx: Tx, actor: Actor, runId: string, input: { key: string; description?: string | null; writedown?: number; writeOff?: boolean; reason?: string | null; clear?: boolean }) {
  const r = await runOf(tx, runId, true);
  requirePermission(actor, 'billing.manage', r.facility_id);
  if (r.status !== 'open') throw conflict(`the run is ${r.status}`);
  const c = await computeRun(tx, r);
  const line = c.lines.find((l) => l.key === input.key);
  if (!line) throw notFound('line in this run');
  if (input.clear) {
    const had = await one(tx, 'DELETE FROM billing_adjustment WHERE run_id = $1 AND source_key = $2 RETURNING writedown, write_off', [runId, input.key]);
    if (had && (had.writedown > 0 || had.write_off)) requirePermission(actor, 'billing.writeoff', r.facility_id);
    await audit(tx, actor, { action: 'billing.adjustment_cleared', entityType: SUBJECT, entityId: runId, facilityId: r.facility_id, data: { key: input.key } });
    return;
  }
  const cur = await one(tx, 'SELECT description, writedown::float AS writedown, write_off, reason FROM billing_adjustment WHERE run_id = $1 AND source_key = $2', [runId, input.key]);
  const touchesMoney = input.writedown !== undefined || input.writeOff !== undefined;
  if (touchesMoney) requirePermission(actor, 'billing.writeoff', r.facility_id);
  if (line.held) throw conflict('release the hold first');
  let writedown = cur?.writedown ?? 0, writeOff = cur?.write_off ?? false, reason = cur?.reason ?? null;
  if (touchesMoney) {
    writeOff = input.writeOff ?? false;
    writedown = writeOff ? 0 : money(input.writedown ?? 0);
    if (writedown < 0) throw invalid('a write-down is zero or more');
    if (!writeOff && writedown >= line.listAmount && writedown > 0) throw invalid(`a write-down must be less than the line's ${line.listAmount.toFixed(2)}; write the line off to drop all of it`);
    if (writeOff || writedown > 0) {
      if (!input.reason || input.reason.trim().length < 3) throw invalid('say why the work is written down or off');
      reason = input.reason.trim();
    } else reason = null;
  }
  const description = input.description !== undefined ? (input.description?.trim() || null) : cur?.description ?? null;
  await tx.query(`INSERT INTO billing_adjustment (tenant_id, run_id, source_key, description, writedown, write_off, reason, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (run_id, source_key) DO UPDATE SET description = EXCLUDED.description, writedown = EXCLUDED.writedown, write_off = EXCLUDED.write_off, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, runId, input.key, description, writedown, writeOff, reason, actor.userId]);
  if (touchesMoney && (writeOff || writedown > 0 || (cur && (cur.writedown > 0 || cur.write_off)))) {
    await audit(tx, actor, { action: writeOff ? 'billing.writeoff' : writedown > 0 ? 'billing.writedown' : 'billing.writedown_removed', entityType: SUBJECT, entityId: runId, facilityId: r.facility_id,
      data: { key: input.key, kind: line.kind, project: line.projectNumber, listAmount: line.listAmount, writedown, writeOff, reason, previous: cur ? { writedown: cur.writedown, writeOff: cur.write_off } : null } });
  }
  if (input.description !== undefined) await audit(tx, actor, { action: 'billing.line_edited', entityType: SUBJECT, entityId: runId, facilityId: r.facility_id, data: { key: input.key, description } });
}

/** Holds: an entry that must not be billed yet (disputed, awaiting a decision) stays out of every run until released. */
async function sourceFacility(tx: Tx, kind: string, id: string): Promise<string | null> {
  if (kind === 'time') return (await one(tx, 'SELECT p.facility_id FROM time_entry x JOIN project p ON p.id = x.project_id WHERE x.id = $1', [id]))?.facility_id ?? null;
  if (kind === 'milestone') return (await one(tx, 'SELECT p.facility_id FROM billing_milestone m JOIN project p ON p.id = m.project_id WHERE m.id = $1', [id]))?.facility_id ?? null;
  if (kind === 'expense' && (await expenseColumnsExist(tx))) return (await one(tx, 'SELECT p.facility_id FROM expense_line l JOIN project p ON p.id = l.project_id WHERE l.id = $1', [id]))?.facility_id ?? null;
  return null;
}
export async function holdEntry(tx: Tx, actor: Actor, input: { kind: 'time' | 'expense' | 'milestone'; sourceId: string; reason: string }) {
  const facilityId = await sourceFacility(tx, input.kind, input.sourceId);
  if (!facilityId) throw notFound('entry');
  requirePermission(actor, 'billing.manage', facilityId);
  if (!input.reason || input.reason.trim().length < 3) throw invalid('say why the entry is held');
  if (await one(tx, `SELECT 1 FROM billing_claim WHERE source_kind = $1 AND source_id = $2 AND released_at IS NULL`, [input.kind, input.sourceId])) throw conflict('the entry has already been billed or written off');
  const h = await tx.query(`INSERT INTO billing_hold (tenant_id, source_kind, source_id, reason, held_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source_kind, source_id) DO NOTHING`,
    [actor.tenantId, input.kind, input.sourceId, input.reason.trim(), actor.userId]);
  if (!h.rowCount) throw conflict('the entry is already on hold');
  await audit(tx, actor, { action: 'billing.entry_held', entityType: 'billing_hold', entityId: input.sourceId, facilityId, data: { kind: input.kind, reason: input.reason.trim() } });
}
export async function releaseHold(tx: Tx, actor: Actor, input: { kind: 'time' | 'expense' | 'milestone'; sourceId: string }) {
  const facilityId = await sourceFacility(tx, input.kind, input.sourceId);
  if (!facilityId) throw notFound('entry');
  requirePermission(actor, 'billing.manage', facilityId);
  const h = await tx.query(`DELETE FROM billing_hold WHERE source_kind = $1 AND source_id = $2`, [input.kind, input.sourceId]);
  if (!h.rowCount) throw conflict('the entry is not on hold');
  await audit(tx, actor, { action: 'billing.hold_released', entityType: 'billing_hold', entityId: input.sourceId, facilityId, data: { kind: input.kind } });
}

export async function cancelRun(tx: Tx, actor: Actor, id: string, reason: string) {
  const r = await runOf(tx, id, true);
  requirePermission(actor, 'billing.manage', r.facility_id);
  if (r.status !== 'open') throw conflict(`the run is ${r.status}`);
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE billing_run SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason.trim()]);
  await audit(tx, actor, { action: 'billing.run_cancelled', entityType: SUBJECT, entityId: id, facilityId: r.facility_id, data: { reason: reason.trim() } });
}

/** Brings written-off work back: it appears in the next run again. */
export async function restoreWriteOff(tx: Tx, actor: Actor, input: { kind: 'time' | 'expense' | 'milestone' | 'percent'; sourceId: string; reason: string }) {
  const c = await one(tx, `SELECT k.id, k.project_id, p.facility_id FROM billing_claim k LEFT JOIN project p ON p.id = k.project_id WHERE k.source_kind = $1 AND k.source_id = $2 AND k.released_at IS NULL AND k.status = 'written_off'`, [input.kind, input.sourceId]);
  if (!c) throw notFound('written-off work');
  requirePermission(actor, 'billing.writeoff', c.facility_id);
  if (!input.reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE billing_claim SET released_at = now(), release_reason = $2 WHERE id = $1`, [c.id, `write-off reversed: ${input.reason.trim()}`]);
  await audit(tx, actor, { action: 'billing.writeoff_reversed', entityType: 'billing_claim', entityId: c.id, facilityId: c.facility_id, data: { kind: input.kind, sourceId: input.sourceId, reason: input.reason.trim() } });
}

// ---- The draft invoice -----------------------------------------------------------------------------------------------------

/**
 * Makes the draft invoice in receivables through the ordinary service (so numbering on issue, the PDF and the accounting outbox are unchanged),
 * tags each line with where it came from, and stamps every source so it cannot be billed again. Needs `billing.manage` and, for the invoice, `ar.manage`.
 * Written-off lines are stamped as written off and appear on no invoice.
 */
export async function createDraftInvoice(tx: Tx, actor: Actor, runId: string) {
  const r = await runOf(tx, runId, true);
  requirePermission(actor, 'billing.manage', r.facility_id);
  requirePermission(actor, 'ar.manage', r.facility_id);
  if (r.status !== 'open') throw conflict(`the run is ${r.status}`);
  // Two runs must not both bill the same earned percent: serialise on the contracts of this customer's projects.
  await tx.query(`SELECT 1 FROM billing_contract c JOIN project p ON p.id = c.project_id WHERE p.customer_id = $1 AND p.facility_id = $2 ORDER BY c.project_id FOR UPDATE OF c`, [r.customer_id, r.facility_id]);
  const c = await computeRun(tx, r);
  const bill = c.lines.filter((l) => l.status === 'billable');
  const off = c.lines.filter((l) => l.status === 'written_off');
  if (!bill.length && !off.length) throw invalid('there is nothing to bill: no approved billable time, expenses, reached milestones or retainer charges are waiting');
  const stamp = async (l: Line, o: { invoiceId: string | null; lineId: string | null; status: 'billed' | 'written_off' }) => {
    if (l.kind === 'retainer') return;
    const id = l.kind === 'percent' ? randomUUID() : l.sourceId;
    const k = await tx.query(`INSERT INTO billing_claim (tenant_id, run_id, project_id, source_kind, source_id, invoice_id, invoice_line_id, status, list_amount, writedown, amount, writedown_reason, claimed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING RETURNING id`,
    [actor.tenantId, runId, l.projectId, l.kind, id, o.invoiceId, o.lineId, o.status, l.listAmount, o.status === 'written_off' ? l.listAmount : l.writedown, o.status === 'written_off' ? 0 : money(l.invQty * l.invUnit), l.adjustReason, actor.userId]);
    if (!k.rowCount) throw conflict(`${l.defaultDescription} was billed by someone else a moment ago; reload the run`);
  };
  let invoiceId: string | null = null;
  if (bill.length) {
    const inv = await createInvoice(tx, actor, { customerId: r.customer_id, facilityId: r.facility_id, notes: `Billing run ${r.number}, ${r.period_from} to ${r.period_to}`,
      lines: bill.map((l) => ({ description: l.invDescription, qty: l.invQty, unitPrice: l.invUnit, accountKey: 'service_revenue' })) });
    invoiceId = inv.id;
    const ids = await many(tx, 'SELECT id, line_no FROM customer_invoice_line WHERE invoice_id = $1 ORDER BY line_no', [inv.id]);
    for (const [i, l] of bill.entries()) {
      const lineId = ids[i]!.id as string;
      await tx.query(`UPDATE customer_invoice_line SET project_id = $2, time_entry_id = $3, expense_line_id = $4, milestone_id = $5, billing_run_id = $6 WHERE id = $1`,
        [lineId, l.projectId, l.kind === 'time' ? l.sourceId : null, l.kind === 'expense' ? l.sourceId : null, l.kind === 'milestone' ? l.sourceId : null, runId]);
      if (l.kind === 'retainer') await claimPeriodForRun(tx, actor, { planId: l.sourceId, periodStart: l.periodStart!, runId, invoiceId: inv.id, lineId, expectAmount: l.net });
      else await stamp(l, { invoiceId: inv.id, lineId, status: 'billed' });
    }
  }
  for (const l of off) await stamp(l, { invoiceId: null, lineId: null, status: 'written_off' });
  const t = c.totals;
  await tx.query(`UPDATE billing_run SET status = $2, invoice_id = $3, invoiced_by = $4, invoiced_at = now() WHERE id = $1`, [runId, invoiceId ? 'invoiced' : 'closed', invoiceId, actor.userId]);
  await audit(tx, actor, { action: 'billing.run_invoiced', entityType: SUBJECT, entityId: runId, facilityId: r.facility_id,
    data: { number: r.number, invoiceId, lines: t.lines, net: t.net, writedown: t.writedown, writtenOff: t.writtenOff, held: t.heldCount, blocked: t.blockedCount, byKind: t.byKind } });
  return { invoiceId, lines: t.lines, net: t.net, writtenOff: t.writtenOff };
}

// ---- Unbilled work (WIP) ---------------------------------------------------------------------------------------------------

export interface WipRow { projectId: string; number: string; name: string; customerId: string | null; customerName: string | null; facilityId: string; billingType: string;
  timeHours: number; timeValue: number; expenseValue: number; milestoneValue: number; percentValue: number; total: number; items: number; oldest: string | null; heldValue: number; blockedHours: number; blockedItems: number;
  contractValue: number | null; billedToDate: number }

/** Approved work not yet invoiced, by project; held and unrated work is shown separately and not counted in the total. */
export async function unbilledWork(tx: Tx, actor: Actor, q: { customerId?: string | null; projectId?: string | null; facilityId?: string | null; asOf?: string } = {}) {
  requirePermission(actor, 'billing.view');
  const allowed = facilitiesWith(actor, 'billing.view');
  const sites = await many(tx, 'SELECT id FROM facility');
  const facilityIds = sites.map((f) => f.id as string).filter((f) => (allowed.all || allowed.ids.includes(f)) && (!q.facilityId || f === q.facilityId));
  const c = await collect(tx, { facilityIds, customerId: q.customerId ?? null, projectId: q.projectId ?? null, from: null, to: q.asOf ?? null }, await getSettings(tx), await loadRates(tx), today());
  const projects = await many(tx, `SELECT p.id, p.number, p.name, p.customer_id, cu.name AS customer_name, p.facility_id, p.billing_type, k.contract_value::float AS contract_value,
      coalesce((SELECT sum(x.amount) FROM billing_claim x WHERE x.project_id = p.id AND x.released_at IS NULL AND x.status = 'billed'), 0)::float AS billed
    FROM project p LEFT JOIN customer cu ON cu.id = p.customer_id LEFT JOIN billing_contract k ON k.project_id = p.id WHERE p.facility_id = ANY ($1)`, [facilityIds]);
  const pmap = new Map(projects.map((p) => [p.id as string, p]));
  const rows = new Map<string, WipRow>();
  for (const it of c.items) {
    if (!it.projectId || !pmap.has(it.projectId)) continue;
    const p = pmap.get(it.projectId)!;
    const w = rows.get(it.projectId) ?? { projectId: p.id, number: p.number, name: p.name, customerId: p.customer_id, customerName: p.customer_name, facilityId: p.facility_id, billingType: p.billing_type, timeHours: 0, timeValue: 0, expenseValue: 0,
      milestoneValue: 0, percentValue: 0, total: 0, items: 0, oldest: null, heldValue: 0, blockedHours: 0, blockedItems: 0, contractValue: p.contract_value, billedToDate: money(p.billed) };
    rows.set(it.projectId, w);
    if (it.held) { w.heldValue = money(w.heldValue + it.listAmount); continue; }
    if (it.blocked) { w.blockedItems++; w.blockedHours = money(w.blockedHours + (it.hours ?? 0)); continue; }
    w.items++;
    w.oldest = !w.oldest || it.date < w.oldest ? it.date : w.oldest;
    if (it.kind === 'time') { w.timeHours = money(w.timeHours + (it.hours ?? 0)); w.timeValue = money(w.timeValue + it.listAmount); }
    else if (it.kind === 'expense') w.expenseValue = money(w.expenseValue + it.listAmount);
    else if (it.kind === 'milestone') w.milestoneValue = money(w.milestoneValue + it.listAmount);
    else if (it.kind === 'percent') w.percentValue = money(w.percentValue + it.listAmount);
    w.total = money(w.total + it.listAmount);
  }
  // Fixed-price projects with a contract but nothing waiting still show billed against contract.
  for (const p of projects) {
    if (rows.has(p.id) || (p.contract_value === null && p.billed === 0)) continue;
    if (q.projectId && p.id !== q.projectId) continue;
    if (q.customerId && p.customer_id !== q.customerId) continue;
    rows.set(p.id, { projectId: p.id, number: p.number, name: p.name, customerId: p.customer_id, customerName: p.customer_name, facilityId: p.facility_id, billingType: p.billing_type, timeHours: 0, timeValue: 0, expenseValue: 0,
      milestoneValue: 0, percentValue: 0, total: 0, items: 0, oldest: null, heldValue: 0, blockedHours: 0, blockedItems: 0, contractValue: p.contract_value, billedToDate: money(p.billed) });
  }
  const list = [...rows.values()].sort((a, b) => b.total - a.total || a.number.localeCompare(b.number));
  return { rows: list, excluded: c.excluded, totals: { total: money(list.reduce((s, w) => s + w.total, 0)), hours: money(list.reduce((s, w) => s + w.timeHours, 0)), held: money(list.reduce((s, w) => s + w.heldValue, 0)),
    blockedItems: list.reduce((s, w) => s + w.blockedItems, 0), projects: list.filter((w) => w.items).length }, expenseColumns: await expenseColumnsExist(tx) };
}
