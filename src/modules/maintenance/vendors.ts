import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { transitionWorkOrder } from './service.js';

const HOUR = 3_600_000;
const money = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

async function lockWo(tx: Tx, id: string) {
  const w = await one(tx, `SELECT w.*, a.asset_tag, a.name AS asset_name, f.code AS facility_code, f.name AS facility_name, f.address
    FROM work_order w JOIN asset a ON a.id = w.asset_id JOIN facility f ON f.id = w.facility_id WHERE w.id = $1 FOR UPDATE OF w`, [id]);
  if (!w) throw notFound('work order');
  return w;
}
const addressLine = (a: any) => [a?.line1, a?.city, a?.region, a?.postal].filter(Boolean).join(', ');

/**
 * Sends a work order to a contractor (a supplier) with an optional not-to-exceed amount. The contractor's
 * certificate of insurance must be current. With an email on file the dispatch is queued through the mail
 * adapter (D-045); otherwise it is recorded as phoned in. One contractor at a time; re-dispatch after a decline.
 */
export async function dispatchVendor(tx: Tx, actor: Actor, woId: string, input: { supplierId: string; nteAmount?: number | null; note?: string | null }) {
  const w = await lockWo(tx, woId);
  requirePermission(actor, 'work_orders.manage', w.facility_id);
  if (!['planned', 'scheduled', 'on_hold'].includes(w.status)) throw conflict(`work order is ${w.status}`);
  if (w.vendor_supplier_id) throw conflict('already dispatched; record the contractor\'s decline first');
  const s = await one(tx, 'SELECT id, code, name, email, active, insurance_expires_on FROM supplier WHERE id = $1', [input.supplierId]);
  if (!s || !s.active) throw invalid('choose an active contractor');
  if (!s.insurance_expires_on) throw invalid(`${s.name} has no certificate of insurance on file`);
  if (String(s.insurance_expires_on).slice(0, 10) < today()) throw invalid(`${s.name}'s certificate of insurance expired on ${String(s.insurance_expires_on).slice(0, 10)}`);
  if (input.nteAmount != null && !(input.nteAmount > 0)) throw invalid('the not-to-exceed amount must be positive');
  await tx.query(`UPDATE work_order SET vendor_supplier_id = $2, nte_amount = $3, vendor_status = 'dispatched', dispatched_at = now(), vendor_accepted_at = NULL,
      status = CASE WHEN status = 'planned' THEN 'scheduled' ELSE status END WHERE id = $1`, [woId, s.id, input.nteAmount ?? null]);
  let emailed: string | null = null;
  if (s.email) {
    const body = [`Work order ${w.number}: ${w.title}`, `Site: ${w.facility_name}${addressLine(w.address) ? ` (${addressLine(w.address)})` : ''}`, `Location / equipment: ${w.asset_tag} ${w.asset_name}`,
      w.description ? `Details: ${w.description}` : '', input.nteAmount ? `Not to exceed: $${input.nteAmount.toFixed(2)} without written approval.` : '',
      input.note ? `Note: ${input.note}` : '', `Please reply to accept and quote ${w.number} on your invoice.`].filter(Boolean).join('\n');
    await tx.query(`INSERT INTO email_message (tenant_id, supplier_id, to_address, subject, body_text, kind, dedupe_key) VALUES ($1, $2, $3, $4, $5, 'vendor_dispatch', $6)
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [actor.tenantId, s.id, s.email, `Work order ${w.number} at ${w.facility_name}`, body, `dispatch:${woId}:${s.id}:${Date.now()}`]);
    emailed = s.email;
  }
  await audit(tx, actor, { action: 'work_order.dispatched', entityType: 'work_order', entityId: woId, facilityId: w.facility_id,
    data: { supplier: s.code, nte: input.nteAmount ?? null, emailed, note: input.note ?? null } });
  return { emailed };
}

/**
 * What the contractor reports, recorded by staff: accepted (the response clock stops), declined (the work order
 * is free to dispatch again), on site (work in progress), completed (with what was done; the work order moves
 * to completed and still needs verification by someone else, D-063 style).
 */
export async function recordVendorUpdate(tx: Tx, actor: Actor, woId: string, input: { event: 'accepted' | 'declined' | 'on_site' | 'completed'; note?: string | null; reference?: string | null }) {
  const w = await lockWo(tx, woId);
  requirePermission(actor, 'work_orders.manage', w.facility_id);
  if (!w.vendor_supplier_id) throw conflict('not dispatched to a contractor');
  const order = ['dispatched', 'accepted', 'on_site', 'completed'];
  if (w.vendor_status === 'completed') throw conflict('the contractor already completed this work');
  if (input.event !== 'declined' && order.indexOf(input.event) <= order.indexOf(w.vendor_status)) throw conflict(`the contractor is already ${w.vendor_status.replace('_', ' ')}`);
  if (input.reference) await tx.query('UPDATE work_order SET vendor_reference = $2 WHERE id = $1', [woId, input.reference]);
  if (input.event === 'declined') {
    if (w.vendor_status !== 'dispatched') throw conflict('only a dispatch not yet accepted can be declined');
    await tx.query(`UPDATE work_order SET vendor_supplier_id = NULL, vendor_status = NULL, nte_amount = NULL, dispatched_at = NULL WHERE id = $1`, [woId]);
  } else if (input.event === 'accepted') {
    await tx.query(`UPDATE work_order SET vendor_status = 'accepted', vendor_accepted_at = now(), responded_at = coalesce(responded_at, now()) WHERE id = $1`, [woId]);
  } else if (input.event === 'on_site') {
    await tx.query(`UPDATE work_order SET vendor_status = 'on_site', vendor_accepted_at = coalesce(vendor_accepted_at, now()), responded_at = coalesce(responded_at, now()) WHERE id = $1`, [woId]);
    if (['planned', 'scheduled', 'on_hold'].includes(w.status)) await transitionWorkOrder(tx, actor, woId, { to: 'in_progress' });
  } else {
    if (!input.note?.trim()) throw invalid('say what the contractor did (the remedy)');
    await tx.query(`UPDATE work_order SET vendor_status = 'completed', vendor_accepted_at = coalesce(vendor_accepted_at, now()), responded_at = coalesce(responded_at, now()) WHERE id = $1`, [woId]);
    if (w.status !== 'in_progress') await transitionWorkOrder(tx, actor, woId, { to: 'in_progress' });
    await transitionWorkOrder(tx, actor, woId, { to: 'completed', remedy: `${input.note.trim()} (contractor)` });
  }
  await audit(tx, actor, { action: `work_order.vendor_${input.event}`, entityType: 'work_order', entityId: woId, facilityId: w.facility_id,
    data: { supplierId: w.vendor_supplier_id, note: input.note ?? null, reference: input.reference ?? null } });
}

/** Contractor spend on a work order: non-void supplier invoices tied to it, against the not-to-exceed. */
export async function vendorSpend(tx: Tx, woId: string) {
  const inv = await many(tx, `SELECT i.id, i.invoice_number, i.status, s.name AS supplier_name,
      (SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM supplier_invoice_line l WHERE l.invoice_id = i.id)::float + i.tax_amount::float + i.freight_amount::float AS total
    FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id WHERE i.work_order_id = $1 AND i.status <> 'void' ORDER BY i.invoice_date`, [woId]);
  return { invoices: inv.map((i) => ({ ...i, total: money(i.total) })), total: money(inv.reduce((s, i) => s + i.total, 0)) };
}

// ---------------------------------------------------------------------------
// Service levels
// ---------------------------------------------------------------------------

export async function serviceLevels(tx: Tx) {
  const rows = await many(tx, 'SELECT priority, respond_hours::float AS respond_hours, complete_hours::float AS complete_hours FROM service_level ORDER BY priority');
  return new Map(rows.map((r) => [r.priority as number, r]));
}

export async function saveServiceLevels(tx: Tx, actor: Actor, levels: { priority: number; respondHours: number | null; completeHours: number | null }[]) {
  requirePermission(actor, 'tenant.admin');
  for (const l of levels) {
    if (l.respondHours != null && l.completeHours != null && l.completeHours < l.respondHours) throw invalid(`priority ${l.priority}: completion target is shorter than the response target`);
    await tx.query(`INSERT INTO service_level (tenant_id, priority, respond_hours, complete_hours) VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, priority) DO UPDATE SET respond_hours = EXCLUDED.respond_hours, complete_hours = EXCLUDED.complete_hours`, [actor.tenantId, l.priority, l.respondHours, l.completeHours]);
  }
  await audit(tx, actor, { action: 'service_levels.saved', entityType: 'tenant', entityId: actor.tenantId, data: { levels } });
}

export type SlaState = 'met' | 'missed' | 'at_risk' | 'on_track' | 'none';
/**
 * Response and completion against the targets for the work order's priority, on the wall clock from creation
 * (business hours are not modelled, D-088). At risk = open with under a quarter of the time left.
 */
export function slaOf(w: { priority: number; created_at: Date; responded_at: Date | null; completed_at: Date | null; status: string }, levels: Map<number, any>, now = new Date()) {
  const l = levels.get(w.priority);
  const one = (hours: number | null, doneAt: Date | null) => {
    if (hours == null) return { due: null, state: 'none' as SlaState };
    const due = new Date(new Date(w.created_at).getTime() + hours * HOUR);
    if (doneAt) return { due: due.toISOString(), state: (new Date(doneAt) <= due ? 'met' : 'missed') as SlaState };
    if (w.status === 'cancelled') return { due: due.toISOString(), state: 'none' as SlaState };
    if (now > due) return { due: due.toISOString(), state: 'missed' as SlaState };
    return { due: due.toISOString(), state: ((due.getTime() - now.getTime()) < hours * HOUR * 0.25 ? 'at_risk' : 'on_track') as SlaState };
  };
  return { respond: one(l?.respond_hours ?? null, w.responded_at), complete: one(l?.complete_hours ?? null, w.completed_at) };
}

/** Contractors for a site's dispatch picker: active suppliers with trades, insurance state and open jobs. */
export async function listContractors(tx: Tx, actor: Actor, trade?: string) {
  if (!can(actor, 'work_orders.manage') && !can(actor, 'purchasing.view')) requirePermission(actor, 'work_orders.manage');
  const rows = await many(tx, `SELECT s.id, s.code, s.name, s.email, s.phone, s.trades, s.insurance_expires_on,
      (s.insurance_expires_on IS NULL OR s.insurance_expires_on < current_date) AS insurance_lapsed,
      (SELECT count(*)::int FROM work_order w WHERE w.vendor_supplier_id = s.id AND w.status NOT IN ('completed', 'verified', 'closed', 'cancelled')) AS open_jobs
    FROM supplier s WHERE s.active AND (cardinality(s.trades) > 0 OR s.insurance_expires_on IS NOT NULL) AND ($1::text IS NULL OR $1 = ANY (s.trades)) ORDER BY s.name`, [trade ?? null]);
  return rows;
}

/** A supplier's contractor details: trades they are called for and when their certificate of insurance expires. */
export async function saveContractor(tx: Tx, actor: Actor, supplierId: string, input: { trades: string[]; insuranceExpiresOn: string | null }) {
  if (!can(actor, 'purchasing.manage')) requirePermission(actor, 'work_orders.manage');
  const trades = [...new Set(input.trades.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
  const s = await one(tx, 'UPDATE supplier SET trades = $2, insurance_expires_on = $3 WHERE id = $1 RETURNING id, code, trades, insurance_expires_on', [supplierId, trades, input.insuranceExpiresOn]);
  if (!s) throw notFound('supplier');
  await audit(tx, actor, { action: 'supplier.contractor_saved', entityType: 'supplier', entityId: supplierId, data: { trades, insuranceExpiresOn: input.insuranceExpiresOn } });
  return s;
}
