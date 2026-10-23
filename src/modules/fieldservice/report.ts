import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify, usersWithPermission } from '../../platform/notify/notify.js';
import { createInvoice } from '../ar/service.js';
import { addLabor, addPart, transitionWorkOrder } from '../maintenance/service.js';
import { createQuote } from '../sales/service.js';
import { getSettings } from './service.js';

/**
 * The service report (SC-002 F3): what the technician fills in on a tablet at the customer's site. It records the checklist, readings,
 * work done, labor, parts used (from the truck), findings, what else the customer should have done (recommended repairs) and the
 * customer's signature. Submitting it does the bookkeeping in one step: labor and parts go on the visit's work order, the work order
 * is completed, the visit is completed, and the report is marked for billing. A recommended repair becomes a draft quote for the
 * customer in one action.
 *
 * Billing rules (decided with the founder's "both per visit and flat monthly"): a visit on a per-visit agreement bills the unit's fee
 * (or the agreement's) plus parts, unless the agreement includes parts; a visit on a monthly agreement is covered by the monthly fee
 * and bills only parts that are not included; a call-out is billed as time and materials at the company labor rate. Parts are billed at
 * cost plus the company markup.
 */
const RESULTS = ['ok', 'issue', 'na'] as const;
const URGENCY = ['now', 'soon', 'when_convenient'] as const;
export interface ReportInput {
  arrivedAt?: string | null; departedAt?: string | null; laborHours?: number | null;
  checklistResults?: { item: string; result: (typeof RESULTS)[number]; note?: string | null }[];
  readings?: { name: string; value: number | string; unit?: string | null }[];
  workPerformed?: string | null; findings?: string | null;
  partsUsed?: { partId: string; qty: number; locationId?: string | null; lots?: { lot: string; qty: number }[] | null }[];
  recommendedRepairs?: { description: string; qty?: number; urgency?: (typeof URGENCY)[number]; partId?: string | null; unitPrice?: number | null }[];
  customerPresent?: boolean; customerSignedName?: string | null; signaturePng?: string | null; noSignatureReason?: string | null; resolved?: boolean | null;
}
const iso = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);

async function loadVisit(tx: Tx, actor: Actor, visitId: string) {
  const v = await one(tx, 'SELECT v.*, sp.checklist, sp.per_visit_fee AS plan_fee FROM service_visit v LEFT JOIN service_plan sp ON sp.id = v.plan_id WHERE v.id = $1 FOR UPDATE OF v', [visitId]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'fieldservice.execute', v.facility_id);
  if (v.technician_id !== actor.employeeId && !can(actor, 'fieldservice.manage', v.facility_id)) throw forbidden('this visit is assigned to someone else');
  return v;
}

function check(i: ReportInput, v: any, final: boolean) {
  const r = i.checklistResults ?? [];
  for (const c of r) {
    if (!RESULTS.includes(c.result)) throw invalid(`checklist result for “${c.item}” must be ok, issue or na`);
    if (c.result === 'issue' && !(c.note ?? '').trim()) throw invalid(`say what the issue is with “${c.item}”`);
  }
  for (const p of i.partsUsed ?? []) if (!(p.qty > 0)) throw invalid('parts used need a positive quantity');
  for (const x of i.recommendedRepairs ?? []) {
    if ((x.description ?? '').trim().length < 3) throw invalid('describe each recommended repair');
    if (x.urgency && !URGENCY.includes(x.urgency)) throw invalid('urgency is now, soon or when convenient');
    if (x.unitPrice != null && x.unitPrice < 0) throw invalid('a price cannot be negative');
  }
  if (i.laborHours != null && !(i.laborHours > 0 && i.laborHours <= 24)) throw invalid('labor hours are between 0 and 24');
  if (i.signaturePng && i.signaturePng.length > 400_000) throw invalid('the signature image is too large');
  if (!final) return;
  const list: string[] = v.checklist ?? [];
  const answered = new Set(r.map((c) => c.item));
  const missing = list.filter((c) => !answered.has(c));
  if (missing.length) throw invalid(`answer every checklist item; missing: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? '…' : ''}`);
  if ((i.workPerformed ?? '').trim().length < 5) throw invalid('describe the work performed');
  if (i.customerPresent !== false) {
    if ((i.customerSignedName ?? '').trim().length < 2 || !i.signaturePng) throw invalid('the customer signs (name and signature) before the report is submitted');
  } else if ((i.noSignatureReason ?? '').trim().length < 3) throw invalid('say why the customer did not sign (not on site, refused, locked out)');
}

function hours(i: ReportInput): number | null {
  if (i.laborHours != null) return i.laborHours;
  if (i.arrivedAt && i.departedAt) { const h = (Date.parse(i.departedAt) - Date.parse(i.arrivedAt)) / 3_600_000; return h > 0 ? Math.round(h * 4) / 4 : null; }
  return null;
}

async function upsert(tx: Tx, actor: Actor, v: any, i: ReportInput, status: 'draft' | 'submitted') {
  const h = hours(i);
  const signedAt = i.signaturePng && i.customerSignedName ? new Date() : null;
  const r = await one(tx, `INSERT INTO service_report (tenant_id, facility_id, visit_id, technician_id, status, arrived_at, departed_at, labor_hours, checklist_results, readings, work_performed, findings, parts_used, recommended_repairs,
      customer_present, customer_signed_name, customer_signed_at, signature_png, no_signature_reason, first_time_fix, submitted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
    ON CONFLICT (visit_id) DO UPDATE SET status = EXCLUDED.status, arrived_at = EXCLUDED.arrived_at, departed_at = EXCLUDED.departed_at, labor_hours = EXCLUDED.labor_hours, checklist_results = EXCLUDED.checklist_results,
      readings = EXCLUDED.readings, work_performed = EXCLUDED.work_performed, findings = EXCLUDED.findings, parts_used = EXCLUDED.parts_used, recommended_repairs = EXCLUDED.recommended_repairs, customer_present = EXCLUDED.customer_present,
      customer_signed_name = EXCLUDED.customer_signed_name, customer_signed_at = EXCLUDED.customer_signed_at, signature_png = EXCLUDED.signature_png, no_signature_reason = EXCLUDED.no_signature_reason,
      first_time_fix = EXCLUDED.first_time_fix, submitted_at = EXCLUDED.submitted_at, updated_at = now() RETURNING *`,
  [actor.tenantId, v.facility_id, v.id, v.technician_id ?? actor.employeeId, status, i.arrivedAt ?? null, i.departedAt ?? null, h, JSON.stringify(i.checklistResults ?? []), JSON.stringify(i.readings ?? []), i.workPerformed?.trim() || null, i.findings?.trim() || null,
    JSON.stringify(i.partsUsed ?? []), JSON.stringify((i.recommendedRepairs ?? []).map((x) => ({ description: x.description.trim(), qty: x.qty ?? 1, urgency: x.urgency ?? 'soon', partId: x.partId ?? null, unitPrice: x.unitPrice ?? null }))),
    i.customerPresent ?? true, i.customerSignedName?.trim() || null, signedAt, i.signaturePng ?? null, i.noSignatureReason?.trim() || null, i.resolved ?? null, status === 'submitted' ? new Date() : null]);
  return r;
}

/** Saves the form as it stands (a draft the technician can come back to, also from the truck with a poor connection). */
export async function saveReportDraft(tx: Tx, actor: Actor, visitId: string, input: ReportInput) {
  const v = await loadVisit(tx, actor, visitId);
  if (!['scheduled', 'dispatched', 'in_progress'].includes(v.status)) throw conflict(`the visit is ${v.status}`);
  const existing = await one(tx, 'SELECT status FROM service_report WHERE visit_id = $1', [visitId]);
  if (existing?.status === 'submitted') throw conflict('the report has been submitted');
  check(input, v, false);
  const r = await upsert(tx, actor, v, input, 'draft');
  return publicReport(r);
}

const publicReport = (r: any) => { const { signature_png, ...rest } = r; return { ...rest, hasSignature: !!signature_png }; };

export async function submitReport(tx: Tx, actor: Actor, visitId: string, input: ReportInput) {
  const v = await loadVisit(tx, actor, visitId);
  if (!['scheduled', 'dispatched', 'in_progress'].includes(v.status)) throw conflict(`the visit is ${v.status}`);
  if (!v.work_order_id) throw invalid('the visit has no work order yet; it must be assigned first');
  check(input, v, true);
  const h = hours(input);
  if (h == null) throw invalid('enter the labor hours, or arrival and departure times');
  const techId = v.technician_id ?? actor.employeeId;
  if (v.status !== 'in_progress') {
    await tx.query(`UPDATE service_visit SET status = 'in_progress', started_at = coalesce(started_at, now()) WHERE id = $1`, [visitId]);
    await transitionWorkOrder(tx, actor, v.work_order_id, { to: 'in_progress' });
  }
  await addLabor(tx, actor, v.work_order_id, { employeeId: techId, workDate: new Date().toISOString().slice(0, 10), hours: h, note: `Service visit ${v.number}` });
  for (const p of input.partsUsed ?? []) await addPart(tx, actor, v.work_order_id, { partId: p.partId, qtyUsed: p.qty, locationId: p.locationId ?? (await truckLocation(tx, v)), lots: p.lots ?? null });
  const issues = (input.checklistResults ?? []).filter((c) => c.result === 'issue').map((c) => `${c.item}: ${c.note}`);
  await transitionWorkOrder(tx, actor, v.work_order_id, { to: 'completed', remedy: input.workPerformed!.trim(), findings: [input.findings?.trim(), ...issues].filter(Boolean).join('\n') || undefined });
  const r = await upsert(tx, actor, v, { ...input, laborHours: h }, 'submitted');
  await tx.query(`UPDATE service_visit SET status = 'completed', completed_at = now() WHERE id = $1`, [visitId]);
  const bill = await billingFor(tx, v, r);
  await tx.query('UPDATE service_report SET billing_status = $2 WHERE id = $1', [r.id, bill.status]);
  const recs = (input.recommendedRepairs ?? []).length;
  if (recs) await notify(tx, actor.tenantId, await usersWithPermission(tx, 'fieldservice.manage', v.facility_id), { kind: 'service.quote_opportunity', title: `${v.number}: ${recs} recommended repair${recs === 1 ? '' : 's'} to quote`, body: input.findings ?? null,
    link: `/service/visits/${visitId}`, subjectType: 'service_visit', subjectId: visitId, dedupeKey: `sv-recs:${visitId}` }, actor.userId);
  await audit(tx, actor, { action: 'service_report.submitted', entityType: 'service_visit', entityId: visitId, facilityId: v.facility_id, data: { number: v.number, hours: h, parts: (input.partsUsed ?? []).length, recommended: recs, billing: bill.status, signed: !!input.signaturePng } });
  return { ...publicReport({ ...r, billing_status: bill.status }), billing: bill };
}

/** The truck stocked for the technician (F4 links a vehicle to its truck stock location); absent until a truck location exists. */
async function truckLocation(tx: Tx, v: any): Promise<string | null> {
  if (!v.vehicle_id) return null;
  const r = await one(tx, 'SELECT truck_location_id FROM vehicle_profile WHERE asset_id = $1', [v.vehicle_id]).catch(() => null);
  return (r?.truck_location_id as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
interface BillLine { description: string; qty: number; unitPrice: number; accountKey: 'service_revenue' | 'sales_revenue' }
export async function billingFor(tx: Tx, v: any, report: any): Promise<{ status: 'ready' | 'covered'; lines: BillLine[]; total: number }> {
  const s = await getSettings(tx);
  const agr = v.agreement_id ? await one(tx, 'SELECT * FROM service_agreement WHERE id = $1', [v.agreement_id]) : null;
  const wo = v.work_order_id ? await many(tx, `SELECT p.qty_used::float AS qty, p.unit_cost::float AS unit_cost, pt.part_number, pt.description FROM work_order_part p JOIN part pt ON pt.id = p.part_id WHERE p.work_order_id = $1 AND p.qty_used > 0`, [v.work_order_id]) : [];
  const lines: BillLine[] = [];
  const partsLines = () => wo.map((p) => ({ description: `${p.part_number} ${p.description}`, qty: p.qty, unitPrice: Math.round((p.unit_cost ?? 0) * (1 + s.partsMarkupPercent / 100) * 100) / 100, accountKey: 'sales_revenue' as const }));
  const callout = v.kind === 'callout';
  if (callout) {
    lines.push({ description: `Service call ${v.number}: ${v.title} (labor)`, qty: Number(report.labor_hours), unitPrice: s.laborRatePerHour, accountKey: 'service_revenue' });
    if (!(agr?.billing_model === 'monthly' && agr.parts_included)) lines.push(...partsLines());
  } else if (agr?.billing_model === 'monthly') {
    if (!agr.parts_included) lines.push(...partsLines());
  } else {
    const fee = v.plan_fee != null ? Number(v.plan_fee) : agr?.per_visit_fee != null ? Number(agr.per_visit_fee) : 0;
    lines.push({ description: `${v.title}: service visit ${v.number}`, qty: 1, unitPrice: fee, accountKey: 'service_revenue' });
    if (!agr?.parts_included) lines.push(...partsLines());
  }
  const total = Math.round(lines.reduce((x, l) => x + l.qty * l.unitPrice, 0) * 100) / 100;
  return { status: lines.length ? 'ready' : 'covered', lines, total };
}

export async function readyToBill(tx: Tx, actor: Actor) {
  requirePermission(actor, 'ar.view');
  const rows = await many(tx, `SELECT r.id, r.visit_id, r.labor_hours::float AS labor_hours, r.submitted_at, r.facility_id, v.number, v.title, v.kind, v.customer_id, c.name AS customer, a.asset_tag, v.agreement_id, sa.number AS agreement_number
    FROM service_report r JOIN service_visit v ON v.id = r.visit_id JOIN customer c ON c.id = v.customer_id LEFT JOIN asset a ON a.id = v.asset_id LEFT JOIN service_agreement sa ON sa.id = v.agreement_id
    WHERE r.billing_status = 'ready' ORDER BY r.submitted_at`);
  const out = [];
  for (const r of rows.filter((x) => can(actor, 'ar.view', x.facility_id))) {
    const v = await one(tx, 'SELECT v.*, sp.per_visit_fee AS plan_fee FROM service_visit v LEFT JOIN service_plan sp ON sp.id = v.plan_id WHERE v.id = $1', [r.visit_id]);
    const b = await billingFor(tx, v, { labor_hours: r.labor_hours });
    out.push({ ...r, total: b.total, lines: b.lines });
  }
  return out;
}

export async function billVisit(tx: Tx, actor: Actor, visitId: string) {
  const v = await one(tx, 'SELECT v.*, sp.per_visit_fee AS plan_fee FROM service_visit v LEFT JOIN service_plan sp ON sp.id = v.plan_id WHERE v.id = $1', [visitId]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'ar.manage', v.facility_id);
  const r = await one(tx, 'SELECT * FROM service_report WHERE visit_id = $1 FOR UPDATE', [visitId]);
  if (!r || r.status !== 'submitted') throw conflict('the service report has not been submitted');
  if (r.billing_status === 'billed') throw conflict('this visit has already been invoiced');
  if (r.billing_status !== 'ready') throw conflict('this visit is covered by the agreement and has nothing to invoice');
  const b = await billingFor(tx, v, r);
  const inv = await createInvoice(tx, actor, { customerId: v.customer_id, facilityId: v.facility_id, lines: b.lines, notes: `Service visit ${v.number}${v.asset_id ? '' : ''}`, paymentTerms: null });
  await tx.query(`UPDATE service_report SET billing_status = 'billed', invoice_id = $2 WHERE id = $1`, [r.id, inv.id]);
  await audit(tx, actor, { action: 'service_report.billed', entityType: 'service_visit', entityId: visitId, facilityId: v.facility_id, data: { invoiceId: inv.id, total: b.total } });
  return { invoiceId: inv.id, total: b.total };
}

/** One invoice per agreement per month for flat-fee agreements, from the month they start (the full fee; no proration). Safe to run twice. */
export async function runMonthlyBilling(tx: Tx, actor: Actor, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw invalid('month looks like 2026-11');
  const period = `${month}-01`;
  const next = new Date(`${period}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  const nextIso = next.toISOString().slice(0, 10);
  if (period > new Date().toISOString().slice(0, 10)) throw invalid('that month has not started yet');
  const agrs = await many(tx, `SELECT a.*, c.name AS customer_name, (SELECT count(*)::int FROM service_plan p WHERE p.agreement_id = a.id AND p.active) AS units FROM service_agreement a JOIN customer c ON c.id = a.customer_id
    WHERE a.billing_model = 'monthly' AND a.status IN ('active', 'ended') AND a.starts_on < $2 AND (a.ends_on IS NULL OR a.ends_on >= $1) AND NOT EXISTS (SELECT 1 FROM service_billing b WHERE b.agreement_id = a.id AND b.period = $1) ORDER BY a.number`, [period, nextIso]);
  const label = new Date(`${period}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const billed = [];
  for (const a of agrs) {
    requirePermission(actor, 'ar.manage', a.facility_id);
    const inv = await createInvoice(tx, actor, { customerId: a.customer_id, facilityId: a.facility_id, lines: [{ description: `Service agreement ${a.number}: ${label} (${a.units} covered unit${a.units === 1 ? '' : 's'})`, qty: 1, unitPrice: Number(a.monthly_fee), accountKey: 'service_revenue' }], paymentTerms: a.payment_terms });
    await tx.query('INSERT INTO service_billing (tenant_id, agreement_id, period, amount, invoice_id, billed_by) VALUES ($1, $2, $3, $4, $5, $6)', [actor.tenantId, a.id, period, a.monthly_fee, inv.id, actor.userId]);
    billed.push({ agreement: a.number, customer: a.customer_name, amount: Number(a.monthly_fee), invoiceId: inv.id });
  }
  await audit(tx, actor, { action: 'service_billing.run', entityType: 'service_agreement', entityId: actor.tenantId, data: { month, invoices: billed.length } });
  return { month, invoices: billed };
}

// ---------------------------------------------------------------------------
// Recommended repairs to quotes
// ---------------------------------------------------------------------------
export async function getReport(tx: Tx, actor: Actor, visitId: string) {
  const r = await one(tx, 'SELECT r.*, v.number AS visit_number, v.title AS visit_title FROM service_report r JOIN service_visit v ON v.id = r.visit_id WHERE r.visit_id = $1', [visitId]);
  if (!r) return null;
  requirePermission(actor, 'fieldservice.view', r.facility_id);
  const q = r.quote_id ? await one(tx, 'SELECT number, status FROM quote WHERE id = $1', [r.quote_id]) : null;
  return { ...publicReport(r), quote: q };
}

export async function reportSignature(tx: Tx, actor: Actor, visitId: string) {
  const r = await one(tx, 'SELECT signature_png, facility_id FROM service_report WHERE visit_id = $1', [visitId]);
  if (!r?.signature_png) throw notFound('signature');
  requirePermission(actor, 'fieldservice.view', r.facility_id);
  return Buffer.from(String(r.signature_png).replace(/^data:image\/png;base64,/, ''), 'base64');
}

/** One draft quote for the customer from the chosen recommended repairs; each needs a price (entered here if the technician left it blank). */
export async function quoteFromReport(tx: Tx, actor: Actor, visitId: string, input: { items: { index: number; unitPrice?: number | null }[]; validUntil?: string | null }) {
  const v = await one(tx, 'SELECT v.*, a.asset_tag FROM service_visit v LEFT JOIN asset a ON a.id = v.asset_id WHERE v.id = $1', [visitId]);
  if (!v) throw notFound('visit');
  requirePermission(actor, 'sales.quote', v.facility_id);
  const r = await one(tx, 'SELECT * FROM service_report WHERE visit_id = $1 FOR UPDATE', [visitId]);
  if (!r || r.status !== 'submitted') throw conflict('the service report has not been submitted');
  const recs = r.recommended_repairs as any[];
  if (!input.items.length) throw invalid('choose at least one repair to quote');
  const lines = input.items.map((it) => {
    const rec = recs[it.index];
    if (!rec) throw invalid('that recommended repair does not exist');
    if (rec.quoted) throw conflict(`“${rec.description}” is already on quote ${rec.quoted}`);
    const price = it.unitPrice ?? rec.unitPrice;
    if (price == null) throw invalid(`enter a price for “${rec.description}”`);
    return { description: `${rec.description}${v.asset_tag ? ` (${v.asset_tag})` : ''}`, qty: rec.qty ?? 1, unitPrice: Number(price) };
  });
  const q = await createQuote(tx, actor, { facilityId: v.facility_id, customerId: v.customer_id, title: `Recommended repairs${v.asset_tag ? ` for ${v.asset_tag}` : ''} (visit ${v.number})`, validUntil: input.validUntil ?? null,
    notes: `Found during service visit ${v.number}${r.findings ? `: ${r.findings}` : ''}`, lines });
  for (const it of input.items) recs[it.index] = { ...recs[it.index], quoted: q.number, unitPrice: it.unitPrice ?? recs[it.index].unitPrice };
  await tx.query('UPDATE service_report SET recommended_repairs = $2, quote_id = coalesce(quote_id, $3) WHERE id = $1', [r.id, JSON.stringify(recs), q.id]);
  await audit(tx, actor, { action: 'service_report.quoted', entityType: 'service_visit', entityId: visitId, facilityId: v.facility_id, data: { quote: q.number, lines: lines.length } });
  return { quoteId: q.id, quoteNumber: q.number };
}
