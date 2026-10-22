import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import type { BlobStore } from '../../platform/storage/blob-store.js';
import { issueInvoice } from '../ar/service.js';
import { createWorkOrder } from '../maintenance/service.js';

const LEASE = 'lease';
const money = (n: number) => Math.round(n * 100) / 100;
const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const monthEnd = (p: string) => { const d = new Date(`${p}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };
const monthLabel = (p: string) => new Date(`${p}T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------------------
// Rental units
// ---------------------------------------------------------------------------

export interface UnitInput {
  assetId: string; unitType?: 'residential' | 'commercial' | 'storage' | 'parking' | 'other'; bedrooms?: number | null; bathrooms?: number | null;
  areaSqft?: number | null; marketRent?: number | null; offline?: boolean; offlineReason?: string | null;
}

/** Makes a space rentable (or updates its leasing details). One rental unit per space. */
export async function saveRentalUnit(tx: Tx, actor: Actor, input: UnitInput) {
  const a = await one(tx, 'SELECT id, facility_id, asset_class, asset_tag FROM asset WHERE id = $1', [input.assetId]);
  if (!a) throw notFound('space');
  requirePermission(actor, 'leasing.manage', a.facility_id);
  if (a.asset_class !== 'space') throw invalid(`${a.asset_tag} is not a space (unit, suite or room)`);
  if (input.offline && !input.offlineReason?.trim()) throw invalid('say why the unit is offline (renovation, model unit, office…)');
  const u = await one(tx, `INSERT INTO rental_unit (tenant_id, facility_id, asset_id, unit_type, bedrooms, bathrooms, area_sqft, market_rent, offline, offline_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (asset_id) DO UPDATE SET unit_type = EXCLUDED.unit_type, bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms, area_sqft = EXCLUDED.area_sqft,
      market_rent = EXCLUDED.market_rent, offline = EXCLUDED.offline, offline_reason = EXCLUDED.offline_reason RETURNING *`,
  [actor.tenantId, a.facility_id, a.id, input.unitType ?? 'residential', input.bedrooms ?? null, input.bathrooms ?? null, input.areaSqft ?? null, input.marketRent ?? null,
    input.offline ?? false, input.offline ? input.offlineReason!.trim() : null]);
  await audit(tx, actor, { action: 'leasing.unit_saved', entityType: 'rental_unit', entityId: u.id, facilityId: a.facility_id, data: { asset: a.asset_tag, marketRent: input.marketRent ?? null, offline: u.offline } });
  return u;
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export interface RenterInput { customerId?: string; name?: string; email?: string | null; phone?: string | null; organization?: boolean }
export interface LeaseInput {
  unitId: string; renter: RenterInput; startDate: string; endDate?: string | null; rentAmount: number; depositAmount?: number; graceDays?: number;
  charges?: { description: string; amount: number; startsOn?: string | null; endsOn?: string | null }[];
}

/** The renter as a customer, so invoices, payments, collections and the accounting sync work unchanged. */
async function renterId(tx: Tx, actor: Actor, r: RenterInput) {
  if (r.customerId) {
    if (!(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [r.customerId]))) throw notFound('renter');
    return r.customerId;
  }
  if (!r.name?.trim()) throw invalid('name the renter (or choose an existing customer)');
  if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim())) throw invalid('the renter\'s email address is not valid');
  const code = `R-${String(await nextSequence(tx, actor.tenantId, 'renter')).padStart(5, '0')}`;
  const c = await one(tx, `INSERT INTO customer (tenant_id, code, name, kind, party_type, email, phone, payment_terms) VALUES ($1, $2, $3, 'customer', $4, $5, $6, 'Due on receipt') RETURNING id`,
    [actor.tenantId, code, r.name.trim(), r.organization ? 'organization' : 'individual', r.email?.trim() || null, r.phone?.trim() || null]);
  if (r.email || r.phone) {
    await tx.query(`INSERT INTO contact (tenant_id, customer_id, name, email, phone, is_primary) VALUES ($1, $2, $3, $4, $5, true)`, [actor.tenantId, c.id, r.name.trim(), r.email?.trim() || null, r.phone?.trim() || null]);
  }
  await audit(tx, actor, { action: 'customer.created', entityType: 'customer', entityId: c.id, data: { code, name: r.name.trim(), via: 'lease' } });
  return c.id as string;
}

export async function createLease(tx: Tx, actor: Actor, input: LeaseInput & { source?: 'native' | 'import' }) {
  const u = await one(tx, 'SELECT ru.*, a.asset_tag FROM rental_unit ru JOIN asset a ON a.id = ru.asset_id WHERE ru.id = $1', [input.unitId]);
  if (!u) throw notFound('rental unit');
  requirePermission(actor, 'leasing.manage', u.facility_id);
  if (!input.startDate) throw invalid('the lease needs a start date');
  if (input.endDate && input.endDate < input.startDate) throw invalid('the lease ends before it starts');
  if (!(input.rentAmount >= 0)) throw invalid('rent cannot be negative');
  for (const c of input.charges ?? []) if (!c.description?.trim() || !(c.amount > 0)) throw invalid('each charge needs a description and a positive amount');
  const customerId = await renterId(tx, actor, input.renter);
  const number = `LSE-${String(await nextSequence(tx, actor.tenantId, 'lease')).padStart(5, '0')}`;
  const l = await one(tx, `INSERT INTO lease (tenant_id, facility_id, number, unit_id, customer_id, start_date, end_date, rent_amount, deposit_amount, grace_days, source, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
  [actor.tenantId, u.facility_id, number, u.id, customerId, input.startDate, input.endDate ?? null, input.rentAmount, input.depositAmount ?? 0, input.graceDays ?? 5, input.source ?? 'native', actor.userId]);
  for (const c of input.charges ?? []) {
    await tx.query('INSERT INTO lease_charge (tenant_id, lease_id, description, amount, starts_on, ends_on) VALUES ($1, $2, $3, $4, $5, $6)',
      [actor.tenantId, l.id, c.description.trim(), c.amount, c.startsOn ?? null, c.endsOn ?? null]);
  }
  await audit(tx, actor, { action: 'leasing.lease_created', entityType: LEASE, entityId: l.id, facilityId: u.facility_id, data: { number, unit: u.asset_tag, rent: input.rentAmount, start: input.startDate, end: input.endDate ?? null } });
  return l;
}

async function lockLease(tx: Tx, id: string) {
  const l = await one(tx, 'SELECT l.*, a.asset_tag, a.name AS unit_name, ru.offline FROM lease l JOIN rental_unit ru ON ru.id = l.unit_id JOIN asset a ON a.id = ru.asset_id WHERE l.id = $1 FOR UPDATE OF l', [id]);
  if (!l) throw notFound('lease');
  return l;
}

async function inForce(tx: Tx, unitId: string, from: string, to: string | null, exceptId: string) {
  return one(tx, `SELECT number FROM lease WHERE unit_id = $1 AND id <> $4 AND status IN ('active', 'notice', 'ended')
    AND daterange(start_date, move_out_on, '[]') && daterange($2::date, $3::date, '[]') LIMIT 1`, [unitId, from, to, exceptId]);
}

/** The lease is signed: it takes the unit from its start date. Refused while another lease holds the unit then. */
export async function activateLease(tx: Tx, actor: Actor, id: string, input: { depositReceivedOn?: string | null } = {}) {
  const l = await lockLease(tx, id);
  requirePermission(actor, 'leasing.manage', l.facility_id);
  if (l.status !== 'draft') throw conflict(`lease is ${l.status}`);
  if (l.offline) throw conflict(`${l.asset_tag} is offline; bring it back online first`);
  const clash = await inForce(tx, l.unit_id, iso(l.start_date)!, null, id);
  if (clash) throw conflict(`${l.asset_tag} is under ${clash.number} on those dates; record that renter's move-out first`);
  await tx.query(`UPDATE lease SET status = 'active', deposit_received_on = coalesce($2, deposit_received_on) WHERE id = $1`, [id, input.depositReceivedOn ?? null]);
  // A signed lease ends the unit's open make-ready (the unit is let).
  await tx.query(`UPDATE unit_turn SET status = 'ready', ready_on = coalesce(ready_on, least(current_date, $2::date)) WHERE unit_id = $1 AND status = 'open'`, [l.unit_id, iso(l.start_date)]);
  await audit(tx, actor, { action: 'leasing.lease_activated', entityType: LEASE, entityId: id, facilityId: l.facility_id, data: { number: l.number, deposit: input.depositReceivedOn ?? null } });
}

export async function cancelLease(tx: Tx, actor: Actor, id: string, reason: string) {
  const l = await lockLease(tx, id);
  requirePermission(actor, 'leasing.manage', l.facility_id);
  if (l.status !== 'draft') throw conflict('only a draft lease can be cancelled; give notice or record the move-out instead');
  if (!reason?.trim()) throw invalid('a reason is required');
  await tx.query(`UPDATE lease SET status = 'cancelled', ended_reason = $2 WHERE id = $1`, [id, reason.trim()]);
  await audit(tx, actor, { action: 'leasing.lease_cancelled', entityType: LEASE, entityId: id, facilityId: l.facility_id, data: { reason } });
}

/** Notice to vacate (from the renter or the landlord): the expected move-out date drives turn planning and the rent roll. */
export async function giveNotice(tx: Tx, actor: Actor, id: string, input: { noticeOn: string; moveOutOn: string }) {
  const l = await lockLease(tx, id);
  requirePermission(actor, 'leasing.manage', l.facility_id);
  if (l.status !== 'active') throw conflict(`lease is ${l.status}`);
  if (input.moveOutOn < iso(l.start_date)!) throw invalid('the move-out is before the lease started');
  await tx.query(`UPDATE lease SET status = 'notice', notice_given_on = $2, move_out_on = $3 WHERE id = $1`, [id, input.noticeOn, input.moveOutOn]);
  await audit(tx, actor, { action: 'leasing.notice', entityType: LEASE, entityId: id, facilityId: l.facility_id, data: { noticeOn: input.noticeOn, moveOutOn: input.moveOutOn } });
}

/** The renter has left: the lease ends and a unit turn opens with a target ready date. */
export async function recordMoveOut(tx: Tx, actor: Actor, id: string, input: { movedOutOn: string; turnDays?: number; reason?: string | null }) {
  const l = await lockLease(tx, id);
  requirePermission(actor, 'leasing.manage', l.facility_id);
  if (!['active', 'notice'].includes(l.status)) throw conflict(`lease is ${l.status}`);
  if (input.movedOutOn < iso(l.start_date)!) throw invalid('the move-out is before the lease started');
  if (input.movedOutOn > today()) throw invalid('record the move-out once it has happened (give notice for a future date)');
  const later = await one(tx, `SELECT number, start_date FROM lease WHERE unit_id = $1 AND id <> $2 AND status IN ('active', 'notice', 'ended') AND start_date > $3 ORDER BY start_date LIMIT 1`, [l.unit_id, id, iso(l.start_date)]);
  if (later && input.movedOutOn >= iso(later.start_date)!) throw conflict(`${later.number} starts ${iso(later.start_date)}; the move-out must be before that`);
  await tx.query(`UPDATE lease SET status = 'ended', move_out_on = $2, ended_reason = coalesce($3, ended_reason, 'moved out') WHERE id = $1`, [id, input.movedOutOn, input.reason ?? null]);
  const turn = await one(tx, `INSERT INTO unit_turn (tenant_id, facility_id, unit_id, prior_lease_id, move_out_on, target_ready_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.tenantId, l.facility_id, l.unit_id, id, input.movedOutOn, addDays(input.movedOutOn, input.turnDays ?? 7), actor.userId]);
  await audit(tx, actor, { action: 'leasing.moved_out', entityType: LEASE, entityId: id, facilityId: l.facility_id, data: { movedOutOn: input.movedOutOn, turnId: turn.id } });
  return { turnId: turn.id as string };
}

/** Renewal: a new lease for the same renter and unit from the day after the old one (no turn in between). */
export async function renewLease(tx: Tx, actor: Actor, id: string, input: { startDate?: string; endDate: string | null; rentAmount: number }) {
  const l = await lockLease(tx, id);
  requirePermission(actor, 'leasing.manage', l.facility_id);
  if (l.status !== 'active') throw conflict(l.status === 'notice' ? 'the renter has given notice; withdraw it before renewing' : `lease is ${l.status}`);
  const start = input.startDate ?? (l.end_date ? addDays(iso(l.end_date)!, 1) : today());
  if (start <= iso(l.start_date)!) throw invalid('the renewal must start after the current lease started');
  if (input.endDate && input.endDate < start) throw invalid('the renewal ends before it starts');
  await tx.query(`UPDATE lease SET status = 'ended', move_out_on = $2, ended_reason = 'renewed' WHERE id = $1`, [id, addDays(start, -1)]);
  const n = await one(tx, `INSERT INTO lease (tenant_id, facility_id, number, unit_id, customer_id, start_date, end_date, rent_amount, deposit_amount, deposit_received_on, grace_days, status, renewed_from_id, created_by)
    SELECT tenant_id, facility_id, $2, unit_id, customer_id, $3, $4, $5, deposit_amount, deposit_received_on, grace_days, 'active', id, $6 FROM lease WHERE id = $1 RETURNING *`,
  [id, `LSE-${String(await nextSequence(tx, actor.tenantId, 'lease')).padStart(5, '0')}`, start, input.endDate, input.rentAmount, actor.userId]);
  await tx.query(`INSERT INTO lease_charge (tenant_id, lease_id, description, amount, starts_on, ends_on) SELECT tenant_id, $2, description, amount, NULL, NULL FROM lease_charge
    WHERE lease_id = $1 AND (ends_on IS NULL OR ends_on >= $3)`, [id, n.id, start]);
  await audit(tx, actor, { action: 'leasing.renewed', entityType: LEASE, entityId: n.id, facilityId: l.facility_id,
    data: { from: l.number, start, end: input.endDate, rent: input.rentAmount, previousRent: Number(l.rent_amount) } });
  return n;
}

export async function getLease(tx: Tx, actor: Actor, id: string) {
  const l = await one(tx, `SELECT l.*, f.code AS facility_code, f.name AS facility_name, a.id AS asset_id, a.asset_tag, a.name AS unit_name, ru.market_rent, ru.unit_type,
      c.code AS renter_code, c.name AS renter_name, c.email AS renter_email, c.phone AS renter_phone, p.number AS renewed_from_number
    FROM lease l JOIN facility f ON f.id = l.facility_id JOIN rental_unit ru ON ru.id = l.unit_id JOIN asset a ON a.id = ru.asset_id JOIN customer c ON c.id = l.customer_id
    LEFT JOIN lease p ON p.id = l.renewed_from_id WHERE l.id = $1`, [id]);
  if (!l) throw notFound('lease');
  requirePermission(actor, 'leasing.view', l.facility_id);
  const charges = await many(tx, 'SELECT id, description, amount::float AS amount, starts_on, ends_on FROM lease_charge WHERE lease_id = $1 ORDER BY description', [id]);
  const invoices = await many(tx, `SELECT i.id, i.number, i.status, i.invoice_date, i.due_date, b.period,
      (SELECT coalesce(sum(x.qty * x.unit_price), 0) FROM customer_invoice_line x WHERE x.invoice_id = i.id)::float + i.tax_amount::float + i.freight_amount::float AS total,
      (SELECT coalesce(sum(pa.amount), 0) FROM payment_allocation pa WHERE pa.invoice_id = i.id)::float AS paid
    FROM customer_invoice i LEFT JOIN lease_billing b ON b.invoice_id = i.id WHERE i.lease_id = $1 AND i.status <> 'void' ORDER BY coalesce(b.period, i.invoice_date) DESC`, [id]);
  const open = invoices.filter((i) => ['issued', 'partially_paid'].includes(i.status));
  const graceCut = addDays(today(), -Number(l.grace_days));
  const balance = money(open.reduce((s, i) => s + i.total - i.paid, 0));
  const pastDue = money(open.filter((i) => iso(i.due_date)! < graceCut).reduce((s, i) => s + i.total - i.paid, 0));
  const later = await one(tx, `SELECT id, number FROM lease WHERE renewed_from_id = $1`, [id]);
  return { ...l, rent_amount: Number(l.rent_amount), deposit_amount: Number(l.deposit_amount), charges, invoices: invoices.map((i) => ({ ...i, total: money(i.total), open: money(i.total - i.paid) })),
    balance, pastDue, renewedBy: later ?? null, canManage: can(actor, 'leasing.manage', l.facility_id) };
}

// ---------------------------------------------------------------------------
// Rent roll
// ---------------------------------------------------------------------------

/**
 * One row per rental unit at a date: occupied, on notice, vacant or offline, with the lease in force, its rent,
 * the renter's open and past-due balance on that lease, the next lease if pre-leased, and days vacant.
 */
export async function rentRoll(tx: Tx, actor: Actor, q: { facilityId?: string; asOf?: string } = {}) {
  requirePermission(actor, 'leasing.view', q.facilityId);
  const asOf = q.asOf ?? today();
  const units = await many(tx, `SELECT ru.*, a.asset_tag, a.name AS unit_name, f.code AS facility_code, f.name AS facility_name, loc.name AS building
    FROM rental_unit ru JOIN asset a ON a.id = ru.asset_id JOIN facility f ON f.id = ru.facility_id LEFT JOIN functional_location loc ON loc.id = a.location_id
    WHERE ($1::uuid IS NULL OR ru.facility_id = $1) AND a.lifecycle_status = 'active' ORDER BY f.code, a.asset_tag`, [q.facilityId ?? null]);
  const ids = units.map((u) => u.id);
  const leases = await many(tx, `SELECT l.id, l.number, l.unit_id, l.status, l.start_date, l.end_date, l.move_out_on, l.rent_amount::float AS rent, l.deposit_amount::float AS deposit, l.grace_days,
      c.name AS renter, (SELECT coalesce(sum(x.amount), 0) FROM lease_charge x WHERE x.lease_id = l.id AND (x.ends_on IS NULL OR x.ends_on >= $2))::float AS charges
    FROM lease l JOIN customer c ON c.id = l.customer_id WHERE l.unit_id = ANY ($1) AND l.status IN ('draft', 'active', 'notice', 'ended') ORDER BY l.start_date`, [ids, asOf]);
  const balances = new Map((await many(tx, `SELECT i.lease_id, sum(t.total - t.paid)::float AS open,
      sum(CASE WHEN i.due_date + l.grace_days < $2::date THEN t.total - t.paid ELSE 0 END)::float AS past_due
    FROM customer_invoice i JOIN lease l ON l.id = i.lease_id
    CROSS JOIN LATERAL (SELECT (SELECT coalesce(sum(x.qty * x.unit_price), 0) FROM customer_invoice_line x WHERE x.invoice_id = i.id) + i.tax_amount + i.freight_amount AS total,
      (SELECT coalesce(sum(pa.amount), 0) FROM payment_allocation pa WHERE pa.invoice_id = i.id) AS paid) t
    WHERE l.unit_id = ANY ($1) AND i.status IN ('issued', 'partially_paid') GROUP BY i.lease_id`, [ids, asOf])).map((b) => [b.lease_id as string, b]));
  const turns = new Map((await many(tx, `SELECT id, unit_id, target_ready_on, move_out_on FROM unit_turn WHERE unit_id = ANY ($1) AND status = 'open'`, [ids])).map((t) => [t.unit_id as string, t]));
  return units.map((u) => {
    const ls = leases.filter((l) => l.unit_id === u.id);
    const cur = ls.find((l) => ['active', 'notice', 'ended'].includes(l.status) && iso(l.start_date)! <= asOf && (!l.move_out_on || iso(l.move_out_on)! >= asOf));
    const next = ls.find((l) => l !== cur && ['draft', 'active'].includes(l.status) && iso(l.start_date)! > asOf);
    const lastOut = ls.filter((l) => l.move_out_on && iso(l.move_out_on)! < asOf).map((l) => iso(l.move_out_on)!).sort().pop();
    const status = u.offline ? 'offline' : !cur ? 'vacant' : cur.status === 'notice' ? 'notice' : 'occupied';
    const bal = new Map<string, number>(); let pastDue = 0;
    for (const l of ls) { const b = balances.get(l.id); if (b) { bal.set(l.id, b.open); pastDue += b.past_due; } }
    const turn = turns.get(u.id);
    return {
      unitId: u.id, assetId: u.asset_id, facilityId: u.facility_id, facility: u.facility_code, facilityName: u.facility_name, unit: u.asset_tag, unitName: u.unit_name, building: u.building,
      unitType: u.unit_type, bedrooms: u.bedrooms == null ? null : Number(u.bedrooms), bathrooms: u.bathrooms == null ? null : Number(u.bathrooms), areaSqft: u.area_sqft,
      marketRent: u.market_rent == null ? null : Number(u.market_rent), status, offlineReason: u.offline_reason,
      leaseId: cur?.id ?? null, leaseNumber: cur?.number ?? null, renter: cur?.renter ?? null, leaseStart: iso(cur?.start_date), leaseEnd: iso(cur?.end_date), moveOutOn: iso(cur?.move_out_on),
      rent: cur ? cur.rent : null, charges: cur ? cur.charges : null, deposit: cur ? cur.deposit : null,
      monthToMonth: !!cur && (!cur.end_date || iso(cur.end_date)! < asOf),
      balance: money([...bal.values()].reduce((s, x) => s + x, 0)), pastDue: money(pastDue),
      nextLeaseId: next?.id ?? null, nextLease: next ? `${next.number} ${next.renter} from ${iso(next.start_date)}` : null,
      daysVacant: status === 'vacant' ? (lastOut ? daysBetween(lastOut, asOf) : null) : null,
      turnId: turn?.id ?? null, turnTarget: iso(turn?.target_ready_on),
    };
  });
}

// ---------------------------------------------------------------------------
// Rent billing
// ---------------------------------------------------------------------------

interface BillLine { description: string; amount: number; accountKey: 'rental_income' | 'tenant_charges' }

/**
 * What each lease owes for a month: rent, prorated by day for a move-in or move-out inside the month, plus the
 * recurring charges in force (prorated the same way). Leases already billed for the month are skipped.
 */
export async function billingPreview(tx: Tx, actor: Actor, q: { period: string; facilityId?: string }) {
  requirePermission(actor, 'leasing.manage', q.facilityId);
  if (!/^\d{4}-\d{2}$/.test(q.period)) throw invalid('the billing period is a month, e.g. 2026-11');
  const start = `${q.period}-01`; const end = monthEnd(start);
  const days = daysBetween(start, end) + 1;
  const leases = await many(tx, `SELECT l.id, l.number, l.facility_id, l.customer_id, l.start_date, l.move_out_on, l.rent_amount::float AS rent, a.asset_tag, a.name AS unit_name, c.name AS renter, f.code AS facility_code
    FROM lease l JOIN rental_unit ru ON ru.id = l.unit_id JOIN asset a ON a.id = ru.asset_id JOIN customer c ON c.id = l.customer_id JOIN facility f ON f.id = l.facility_id
    WHERE l.status IN ('active', 'notice', 'ended') AND l.start_date <= $2 AND (l.move_out_on IS NULL OR l.move_out_on >= $1) AND ($3::uuid IS NULL OR l.facility_id = $3)
      AND NOT EXISTS (SELECT 1 FROM lease_billing b WHERE b.lease_id = l.id AND b.period = $1) ORDER BY f.code, a.asset_tag`, [start, end, q.facilityId ?? null]);
  const charges = await many(tx, `SELECT lease_id, description, amount::float AS amount, starts_on, ends_on FROM lease_charge WHERE lease_id = ANY ($1)`, [leases.map((l) => l.id)]);
  const out = [];
  for (const l of leases) {
    if (!can(actor, 'leasing.manage', l.facility_id)) continue;
    const from = iso(l.start_date)! > start ? iso(l.start_date)! : start;
    const to = l.move_out_on && iso(l.move_out_on)! < end ? iso(l.move_out_on)! : end;
    const occupied = daysBetween(from, to) + 1;
    const part = occupied < days;
    const label = `${l.unit_name} (${l.asset_tag}), ${monthLabel(start)}`;
    const lines: BillLine[] = [{ description: part ? `Rent, ${label}: ${occupied} of ${days} days` : `Rent, ${label}`, amount: money(part ? (l.rent * occupied) / days : l.rent), accountKey: 'rental_income' }];
    for (const c of charges.filter((x) => x.lease_id === l.id && (!x.starts_on || iso(x.starts_on)! <= to) && (!x.ends_on || iso(x.ends_on)! >= from))) {
      lines.push({ description: part ? `${c.description}, ${monthLabel(start)}: ${occupied} of ${days} days` : `${c.description}, ${monthLabel(start)}`,
        amount: money(part ? (c.amount * occupied) / days : c.amount), accountKey: 'tenant_charges' });
    }
    out.push({ leaseId: l.id, lease: l.number, facilityId: l.facility_id, facility: l.facility_code, unit: l.asset_tag, renter: l.renter, customerId: l.customer_id,
      lines: lines.filter((x) => x.amount > 0), total: money(lines.reduce((s, x) => s + x.amount, 0)), prorated: part });
  }
  return { period: q.period, start, end, leases: out, total: money(out.reduce((s, x) => s + x.total, 0)) };
}

/**
 * Creates the month's rent invoices (drafts, or issued with the 1st of the month as the invoice date, due on
 * receipt). Safe to run again: a lease is billed once per month (lease_billing primary key).
 */
export async function runRentBilling(tx: Tx, actor: Actor, blobs: BlobStore, q: { period: string; facilityId?: string; issue?: boolean }) {
  const preview = await billingPreview(tx, actor, q);
  const created = [];
  for (const b of preview.leases) {
    if (!b.lines.length) continue;
    const inv = await one(tx, `INSERT INTO customer_invoice (tenant_id, facility_id, customer_id, lease_id, payment_terms, notes, created_by) VALUES ($1, $2, $3, $4, 'Due on receipt', $5, $6) RETURNING id`,
      [actor.tenantId, b.facilityId, b.customerId, b.leaseId, `${b.lease} · ${b.unit}`, actor.userId]);
    for (const [i, l] of b.lines.entries()) {
      await tx.query(`INSERT INTO customer_invoice_line (tenant_id, invoice_id, line_no, description, qty, uom, unit_price, account_key) VALUES ($1, $2, $3, $4, 1, 'MO', $5, $6)`,
        [actor.tenantId, inv.id, i + 1, l.description, l.amount, l.accountKey]);
    }
    await tx.query('INSERT INTO lease_billing (tenant_id, lease_id, period, invoice_id) VALUES ($1, $2, $3, $4)', [actor.tenantId, b.leaseId, preview.start, inv.id]);
    let number: string | null = null;
    if (q.issue) number = (await issueInvoice(tx, actor, blobs, inv.id, { invoiceDate: preview.start })).number;
    created.push({ invoiceId: inv.id as string, number, lease: b.lease, unit: b.unit, total: b.total });
  }
  await audit(tx, actor, { action: 'leasing.rent_billed', entityType: 'facility', entityId: q.facilityId ?? actor.tenantId, facilityId: q.facilityId ?? null,
    data: { period: q.period, invoices: created.length, total: money(created.reduce((s, c) => s + c.total, 0)), issued: !!q.issue } });
  return { period: q.period, created, total: money(created.reduce((s, c) => s + c.total, 0)) };
}

// ---------------------------------------------------------------------------
// Unit turns
// ---------------------------------------------------------------------------

export async function listTurns(tx: Tx, actor: Actor, q: { facilityId?: string; open?: boolean } = {}) {
  requirePermission(actor, 'leasing.view', q.facilityId);
  const rows = await many(tx, `SELECT t.*, a.id AS asset_id, a.asset_tag, a.name AS unit_name, f.code AS facility_code, ru.market_rent::float AS market_rent, pl.number AS prior_lease,
      (SELECT count(*)::int FROM work_order w WHERE w.unit_turn_id = t.id AND w.status <> 'cancelled') AS jobs,
      (SELECT count(*)::int FROM work_order w WHERE w.unit_turn_id = t.id AND w.status IN ('planned', 'scheduled', 'in_progress', 'on_hold')) AS open_jobs,
      (SELECT l.number || ' ' || c.name FROM lease l JOIN customer c ON c.id = l.customer_id WHERE l.unit_id = t.unit_id AND l.status IN ('draft', 'active') AND l.start_date > t.move_out_on ORDER BY l.start_date LIMIT 1) AS next_lease
    FROM unit_turn t JOIN rental_unit ru ON ru.id = t.unit_id JOIN asset a ON a.id = ru.asset_id JOIN facility f ON f.id = t.facility_id LEFT JOIN lease pl ON pl.id = t.prior_lease_id
    WHERE ($1::uuid IS NULL OR t.facility_id = $1) AND (NOT $2 OR t.status = 'open') ORDER BY t.status, t.target_ready_on`, [q.facilityId ?? null, q.open ?? false]);
  const now = today();
  return rows.filter((t) => can(actor, 'leasing.view', t.facility_id)).map((t) => ({
    ...t, move_out_on: iso(t.move_out_on), target_ready_on: iso(t.target_ready_on), ready_on: iso(t.ready_on),
    days: daysBetween(iso(t.move_out_on)!, iso(t.ready_on) ?? now), late: t.status === 'open' && iso(t.target_ready_on)! < now,
    // Rent not collected while the unit sits empty, at market rent, so far.
    lostRent: t.market_rent ? money((t.market_rent * 12 / 365) * Math.max(0, daysBetween(iso(t.move_out_on)!, iso(t.ready_on) ?? now))) : null,
  }));
}

/** Adds a make-ready job (paint, clean, carpet, repairs) as a work order on the unit, linked to the turn. */
export async function addTurnWork(tx: Tx, actor: Actor, turnId: string, input: { title: string; priority?: 1 | 2 | 3 | 4; description?: string | null }) {
  const t = await one(tx, 'SELECT t.*, ru.asset_id FROM unit_turn t JOIN rental_unit ru ON ru.id = t.unit_id WHERE t.id = $1', [turnId]);
  if (!t) throw notFound('unit turn');
  requirePermission(actor, 'leasing.manage', t.facility_id);
  if (t.status !== 'open') throw conflict(`the turn is ${t.status}`);
  const wo = await createWorkOrder(tx, actor, { assetId: t.asset_id, title: input.title, priority: input.priority ?? 3, description: input.description ?? null, dueAt: `${iso(t.target_ready_on)}T17:00:00Z` });
  await tx.query('UPDATE work_order SET unit_turn_id = $2 WHERE id = $1', [wo.id, turnId]);
  return wo;
}

/** The unit is rent-ready: every make-ready job is done. */
export async function markTurnReady(tx: Tx, actor: Actor, turnId: string, readyOn?: string) {
  const t = await one(tx, 'SELECT * FROM unit_turn WHERE id = $1 FOR UPDATE', [turnId]);
  if (!t) throw notFound('unit turn');
  requirePermission(actor, 'leasing.manage', t.facility_id);
  if (t.status !== 'open') throw conflict(`the turn is ${t.status}`);
  const open = await many(tx, `SELECT number FROM work_order WHERE unit_turn_id = $1 AND status IN ('planned', 'scheduled', 'in_progress', 'on_hold')`, [turnId]);
  if (open.length) throw conflict(`finish the make-ready work first: ${open.map((o) => o.number).join(', ')}`);
  const on = readyOn ?? today();
  if (on < iso(t.move_out_on)!) throw invalid('ready before the move-out?');
  await tx.query(`UPDATE unit_turn SET status = 'ready', ready_on = $2 WHERE id = $1`, [turnId, on]);
  await audit(tx, actor, { action: 'leasing.turn_ready', entityType: 'unit_turn', entityId: turnId, facilityId: t.facility_id, data: { readyOn: on, days: daysBetween(iso(t.move_out_on)!, on) } });
}
