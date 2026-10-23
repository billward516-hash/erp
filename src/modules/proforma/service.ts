import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { approvalHistory, closePendingRequests, createApprovalRequest, registerApprovalSubject } from '../../platform/approvals/engine.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import type { Assumptions, Line, Method, Result, Scenario, ScenarioKey, Section } from './engine.js';
import { DEFAULT_SCENARIOS, METHODS, project, sensitivity } from './engine.js';

/**
 * Opportunity pro forma (D-162): a business case for a new site, product line, customer contract or capital project.
 * The owner builds it from driver lines, compares low, base and high scenarios, and submits it for approval by the
 * company owner or the approver an administrator names (D-167).
 * Approval freezes it and keeps the approved base case; reopening starts a new revision.
 */
const SUBJECT = 'proforma';
const PURPOSE = 'business_case';
export type Kind = 'new_site' | 'product_line' | 'customer_contract' | 'capital_project' | 'other';
export const KIND_LABEL: Record<Kind, string> = { new_site: 'New site or store', product_line: 'New product or service', customer_contract: 'Customer contract',
  capital_project: 'Capital project', other: 'Other opportunity' };

registerApprovalSubject(SUBJECT, {
  link: (id) => `/proforma/${id}`,
  describe: async (tx, id) => { const p = await one(tx, 'SELECT number, title FROM proforma WHERE id = $1', [id]); return p ? `${p.number} ${p.title}` : 'Pro forma'; },
  commentRequired: true,
});

export interface HeaderInput {
  facilityId?: string | null; title: string; kind: Kind; description?: string | null; startMonth: string; years?: number; discountRatePct?: number; taxRatePct?: number;
  workingCapitalDays?: number; ownerUserId?: string | null; scenarios?: Partial<Record<ScenarioKey, Scenario>>;
}
export interface LineInput extends Line { note?: string | null; /** Where it was pulled in from (D-163), e.g. "Budget 2027 operating budget". */ source?: string | null }

const month = (s: string) => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw invalid('the start month must look like 2027-01'); return `${s}-01`; };
const toLine = (r: any): LineInput => ({ section: r.section, label: r.label, method: r.method, amount: Number(r.amount), qty: r.qty == null ? null : Number(r.qty),
  growthPct: r.growth_pct == null ? null : Number(r.growth_pct), startMonth: r.start_month, endMonth: r.end_month, rampMonths: r.ramp_months,
  lifeYears: r.life_years == null ? null : Number(r.life_years), note: r.note, source: r.source ?? null });
const assumptionsOf = (p: any): Assumptions => ({ years: p.years, discountRatePct: Number(p.discount_rate_pct), taxRatePct: Number(p.tax_rate_pct), workingCapitalDays: p.working_capital_days });
const scenariosOf = (p: any): Record<ScenarioKey, Scenario> => ({ ...DEFAULT_SCENARIOS, ...(p.scenarios ?? {}) });
const monthOf = (d: unknown) => String(d instanceof Date ? d.toISOString() : d).slice(0, 7);
/** The parts of a case that a comparison sets side by side. */
const headerOf = (p: any) => ({ title: p.title, kind: p.kind, startMonth: monthOf(p.start_month), years: p.years, discountRatePct: Number(p.discount_rate_pct), taxRatePct: Number(p.tax_rate_pct),
  workingCapitalDays: p.working_capital_days, scenarios: scenariosOf(p) });

function canView(actor: Actor, p: { facility_id: string | null }) { return can(actor, 'proforma.view', p.facility_id) || can(actor, 'proforma.manage', p.facility_id); }
function canManage(actor: Actor, p: { facility_id: string | null; owner_user_id: string }) {
  return can(actor, 'proforma.manage', p.facility_id) || (p.owner_user_id === actor.userId && can(actor, 'proforma.view', p.facility_id));
}

async function load(tx: Tx, actor: Actor, id: string, lock = false) {
  const p = await one(tx, `SELECT * FROM proforma WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!p || !canView(actor, p)) throw notFound('pro forma');
  return p;
}
async function linesOf(tx: Tx, id: string) { return (await many(tx, 'SELECT * FROM proforma_line WHERE proforma_id = $1 ORDER BY seq', [id])).map(toLine); }

/** One sentence that answers the question the pro forma exists for. */
export function headline(r: Result, a: Assumptions) {
  if (!r.totals.revenue && !r.totals.capital) return 'No revenue or spending yet: add the drivers to see whether this pays.';
  const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
  const pay = r.paybackMonths == null ? `does not pay back within ${a.years} years` : r.paybackMonths === 0 ? 'never needs funding' : `pays back in ${r.paybackMonths} months`;
  return `Base case ${pay}; NPV ${usd(r.npv)} at ${a.discountRatePct}%${r.irrPct != null ? `, IRR ${r.irrPct}%` : ''}${r.peakFunding > 0 ? `; needs ${usd(r.peakFunding)} at its lowest point` : ''}.`;
}
const summaryOf = (r: Result) => ({ npv: r.npv, irrPct: r.irrPct, paybackMonths: r.paybackMonths, peakFunding: r.peakFunding, revenue: r.totals.revenue, netIncome: r.totals.netIncome,
  capital: r.totals.capital, breakevenMonth: r.breakevenMonth });

function validateLines(lines: LineInput[], years: number) {
  if (lines.length > 200) throw invalid('a pro forma holds up to 200 lines');
  for (const [i, l] of lines.entries()) {
    const n = `line ${i + 1}`;
    if (!l.label?.trim()) throw invalid(`${n}: a label is required`);
    if (!METHODS[l.section]?.includes(l.method)) throw invalid(`${n}: ${l.section.replace(/_/g, ' ')} lines cannot use ${l.method.replace(/_/g, ' ')}`);
    if (!(l.amount >= 0) || !Number.isFinite(l.amount)) throw invalid(`${n}: the amount must be zero or more`);
    if ((l.method === 'units_price' || l.method === 'headcount') && !(Number(l.qty) >= 0 && l.qty != null)) throw invalid(`${n}: ${l.method === 'headcount' ? 'the number of people' : 'units per month'} is required`);
    if (l.method === 'pct_of_revenue' && l.amount > 1000) throw invalid(`${n}: a percent of revenue above 1000% is not plausible`);
    if ((l.startMonth ?? 0) >= years * 12) throw invalid(`${n}: it starts after the ${years}-year horizon`);
    if (l.endMonth != null && l.endMonth <= (l.startMonth ?? 0)) throw invalid(`${n}: it must end after it starts`);
  }
}
function validateScenarios(s: Partial<Record<ScenarioKey, Scenario>> | undefined) {
  for (const [k, v] of Object.entries(s ?? {})) {
    if (!['low', 'base', 'high'].includes(k)) throw invalid(`unknown scenario ${k}`);
    for (const f of ['revenuePct', 'costPct', 'capitalPct', 'delayMonths'] as const) if (!Number.isFinite(v[f])) throw invalid(`${k} scenario: ${f} must be a number`);
    if (v.revenuePct < -100 || v.costPct < -100 || v.capitalPct < -100) throw invalid(`${k} scenario: a change below -100% is not possible`);
    if (v.delayMonths < 0 || v.delayMonths > 60 || !Number.isInteger(v.delayMonths)) throw invalid(`${k} scenario: the delay is 0 to 60 whole months`);
  }
}

/** Starter drivers for each kind, labelled as examples, so nobody faces an empty grid. Every amount is meant to be replaced. */
export function starterLines(kind: Kind): LineInput[] {
  const L = (section: Section, label: string, method: Method, amount: number, extra: Partial<LineInput> = {}): LineInput => ({ section, label, method, amount, ...extra });
  switch (kind) {
    case 'new_site': return [
      L('revenue', 'Sales (example)', 'fixed_monthly', 60000, { growthPct: 5, rampMonths: 6, startMonth: 3 }),
      L('cost_of_sales', 'Cost of goods (example)', 'pct_of_revenue', 55),
      L('operating', 'Rent (example)', 'fixed_monthly', 8000, { growthPct: 3 }),
      L('operating', 'Staff (example)', 'headcount', 42000, { qty: 6, growthPct: 3, startMonth: 2 }),
      L('operating', 'Utilities and services (example)', 'fixed_monthly', 2500),
      L('capital', 'Fit-out and equipment (example)', 'one_time', 250000, { lifeYears: 10 }),
    ];
    case 'product_line': return [
      L('revenue', 'Units sold (example)', 'units_price', 120, { qty: 400, growthPct: 15, rampMonths: 9 }),
      L('cost_of_sales', 'Material and labor per unit (example)', 'units_price', 70, { qty: 400 }),
      L('operating', 'Marketing (example)', 'fixed_monthly', 5000),
      L('capital', 'Tooling (example)', 'one_time', 90000, { lifeYears: 5 }),
    ];
    case 'customer_contract': return [
      L('revenue', 'Contract revenue (example)', 'fixed_monthly', 40000, { growthPct: 2, endMonth: 36 }),
      L('cost_of_sales', 'Direct cost (example)', 'pct_of_revenue', 62),
      L('operating', 'Account team (example)', 'headcount', 65000, { qty: 1 }),
      L('capital', 'Dedicated equipment (example)', 'one_time', 60000, { lifeYears: 3 }),
    ];
    case 'capital_project': return [
      L('revenue', 'Savings or added margin (example)', 'fixed_monthly', 9000, { startMonth: 4, rampMonths: 3 }),
      L('operating', 'Running cost (example)', 'fixed_monthly', 1200, { startMonth: 4 }),
      L('capital', 'Equipment and installation (example)', 'one_time', 220000, { lifeYears: 10 }),
    ];
    default: return [];
  }
}

async function writeLines(tx: Tx, actor: Actor, id: string, lines: LineInput[]) {
  await tx.query('DELETE FROM proforma_line WHERE proforma_id = $1', [id]);
  for (const [i, l] of lines.entries()) {
    await tx.query(`INSERT INTO proforma_line (tenant_id, proforma_id, seq, section, label, method, amount, qty, growth_pct, start_month, end_month, ramp_months, life_years, note, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [actor.tenantId, id, i + 1, l.section, l.label.trim(), l.method, l.amount, l.qty ?? null, l.growthPct ?? null, l.startMonth ?? 0, l.endMonth ?? null, l.rampMonths ?? null,
      l.section === 'capital' ? l.lifeYears ?? 5 : null, l.note?.trim() || null, l.source?.trim().slice(0, 200) || null]);
  }
}

async function checkHeader(tx: Tx, actor: Actor, h: HeaderInput) {
  if (h.facilityId && !(await one(tx, 'SELECT 1 FROM facility WHERE id = $1', [h.facilityId]))) throw notFound('site');
  requirePermission(actor, 'proforma.manage', h.facilityId ?? null);
  if (h.years != null && (h.years < 1 || h.years > 10 || !Number.isInteger(h.years))) throw invalid('the horizon is 1 to 10 whole years');
  validateScenarios(h.scenarios);
  if (h.ownerUserId && h.ownerUserId !== actor.userId) {
    const ok = await one(tx, `SELECT 1 FROM app_user u JOIN user_role_scope a ON a.user_id = u.id WHERE u.id = $1 AND u.status = 'active'
      AND ($2::uuid IS NULL OR a.facility_id IS NULL OR a.facility_id = $2) LIMIT 1`, [h.ownerUserId, h.facilityId ?? null]);
    if (!ok) throw invalid('the owner must be an active user with access to this site');
  }
}

export async function createProforma(tx: Tx, actor: Actor, h: HeaderInput & { lines?: LineInput[]; useStarter?: boolean }) {
  await checkHeader(tx, actor, h);
  const years = h.years ?? 5;
  const lines = h.lines ?? (h.useStarter === false ? [] : starterLines(h.kind));
  validateLines(lines, years);
  const number = `PF-${String(await nextSequence(tx, actor.tenantId, 'proforma')).padStart(5, '0')}`;
  const p = await one(tx, `INSERT INTO proforma (tenant_id, facility_id, number, title, kind, description, start_month, years, discount_rate_pct, tax_rate_pct, working_capital_days,
      scenarios, owner_user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
  [actor.tenantId, h.facilityId ?? null, number, h.title.trim(), h.kind, h.description?.trim() || null, month(h.startMonth), years, h.discountRatePct ?? 10, h.taxRatePct ?? 25,
    h.workingCapitalDays ?? 30, JSON.stringify({ ...DEFAULT_SCENARIOS, ...(h.scenarios ?? {}) }), h.ownerUserId ?? actor.userId, actor.userId]);
  await writeLines(tx, actor, p.id, lines);
  await audit(tx, actor, { action: 'proforma.created', entityType: SUBJECT, entityId: p.id, facilityId: p.facility_id, data: { number, kind: h.kind, lines: lines.length } });
  return p;
}

/** Saves the header and every line in one go (the editor sends the whole case). Only a draft can change. */
export async function saveProforma(tx: Tx, actor: Actor, id: string, h: HeaderInput & { lines: LineInput[] }) {
  const p = await load(tx, actor, id, true);
  if (!canManage(actor, p)) throw notFound('pro forma');
  if (p.status !== 'draft') throw conflict(`the pro forma is ${p.status}; reopen it to change it`);
  const facilityId = h.facilityId === undefined ? p.facility_id : h.facilityId;
  await checkHeader(tx, actor, { ...h, facilityId });
  const years = h.years ?? p.years;
  validateLines(h.lines, years);
  await tx.query(`UPDATE proforma SET facility_id = $2, title = $3, kind = $4, description = $5, start_month = $6, years = $7, discount_rate_pct = $8, tax_rate_pct = $9,
      working_capital_days = $10, scenarios = $11, owner_user_id = $12, updated_at = now() WHERE id = $1`,
  [id, facilityId, h.title.trim(), h.kind, h.description?.trim() || null, month(h.startMonth), years, h.discountRatePct ?? p.discount_rate_pct, h.taxRatePct ?? p.tax_rate_pct,
    h.workingCapitalDays ?? p.working_capital_days, JSON.stringify({ ...scenariosOf(p), ...(h.scenarios ?? {}) }), h.ownerUserId ?? p.owner_user_id]);
  await writeLines(tx, actor, id, h.lines);
  await audit(tx, actor, { action: 'proforma.saved', entityType: SUBJECT, entityId: id, facilityId, data: { revision: p.revision, lines: h.lines.length } });
  return getProforma(tx, actor, id);
}

export async function getProforma(tx: Tx, actor: Actor, id: string) {
  const p = await load(tx, actor, id);
  const lines = await linesOf(tx, id);
  const a = assumptionsOf(p); const sc = scenariosOf(p);
  const results = { low: project(lines, a, sc.low), base: project(lines, a, sc.base), high: project(lines, a, sc.high) };
  const strip = (r: Result) => ({ ...r, months: r.months.map((m) => ({ cash: Math.round(m.cash * 100) / 100, revenue: Math.round(m.revenue * 100) / 100 })) });
  const meta = await one(tx, `SELECT f.code AS facility_code, f.name AS facility_name, o.display_name AS owner_name FROM proforma p LEFT JOIN facility f ON f.id = p.facility_id
    JOIN app_user o ON o.id = p.owner_user_id WHERE p.id = $1`, [id]);
  return {
    ...p, ...meta, startMonth: String(p.start_month instanceof Date ? p.start_month.toISOString() : p.start_month).slice(0, 7), assumptions: a, scenarios: sc, lines,
    results: { low: strip(results.low), base: strip(results.base), high: strip(results.high) },
    sensitivity: sensitivity(lines, a, sc.base), answer: headline(results.base, a),
    approvals: await approvalHistory(tx, SUBJECT, id),
    revisions: await many(tx, `SELECT r.revision, r.status, r.summary, r.reason, r.closed_at, u.display_name AS closed_by FROM proforma_revision r JOIN app_user u ON u.id = r.closed_by
      WHERE r.proforma_id = $1 ORDER BY r.revision DESC`, [id]),
    canEdit: p.status === 'draft' && canManage(actor, p), canManage: canManage(actor, p),
  };
}

export async function listProformas(tx: Tx, actor: Actor, q: { status?: string } = {}) {
  if (!can(actor, 'proforma.view') && !can(actor, 'proforma.manage')) requirePermission(actor, 'proforma.view');
  const rows = await many(tx, `SELECT p.*, f.code AS facility_code, o.display_name AS owner_name FROM proforma p LEFT JOIN facility f ON f.id = p.facility_id
    JOIN app_user o ON o.id = p.owner_user_id WHERE ($1::text IS NULL OR p.status = $1) AND p.status <> CASE WHEN $1::text IS NULL THEN 'archived' ELSE '' END
    ORDER BY p.updated_at DESC LIMIT 500`, [q.status ?? null]);
  const visible = rows.filter((p) => canView(actor, p));
  const out = [];
  for (const p of visible) {
    const r = project(await linesOf(tx, p.id), assumptionsOf(p), scenariosOf(p).base);
    out.push({ id: p.id, number: p.number, revision: p.revision, title: p.title, kind: p.kind, kind_label: KIND_LABEL[p.kind as Kind], status: p.status, facility_code: p.facility_code,
      owner_name: p.owner_name, start_month: p.start_month, years: p.years, updated_at: p.updated_at, ...summaryOf(r) });
  }
  const approved = out.filter((p) => p.status === 'approved');
  const pending = out.filter((p) => p.status === 'submitted');
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const answer = !out.length ? 'No business cases yet. Start one for a new site, product, contract or capital project.'
    : `${out.length} business case${out.length === 1 ? '' : 's'}: ${approved.length} approved (NPV ${usd(approved.reduce((s, p) => s + p.npv, 0))}), ${pending.length} waiting for approval.`;
  return { answer, rows: out };
}

export async function submitProforma(tx: Tx, actor: Actor, id: string) {
  const p = await load(tx, actor, id, true);
  if (!canManage(actor, p)) throw notFound('pro forma');
  if (p.status !== 'draft') throw conflict(`the pro forma is ${p.status}`);
  const lines = await linesOf(tx, id);
  if (!lines.some((l) => l.section === 'revenue') && !lines.some((l) => l.section === 'capital')) throw invalid('add at least one revenue or capital line before submitting');
  if (lines.some((l) => /\(example\)/i.test(l.label))) throw invalid('replace or remove the example lines before submitting');
  await createApprovalRequest(tx, actor, { facilityId: p.facility_id, subjectType: SUBJECT, subjectId: id, subjectRevision: p.revision, purpose: PURPOSE,
    stages: [{ steps: [await approvalStep(tx, actor)] }] });
  await tx.query(`UPDATE proforma SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'proforma.submitted', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { revision: p.revision } });
  return getProforma(tx, actor, id);
}

export async function onProformaDecided(tx: Tx, actor: Actor, id: string, purpose: string, status: string) {
  if (purpose !== PURPOSE || status === 'pending') return;
  const p = await one(tx, 'SELECT * FROM proforma WHERE id = $1 FOR UPDATE', [id]);
  if (!p) return;
  if (status === 'approved') {
    const r = project(await linesOf(tx, id), assumptionsOf(p), scenariosOf(p).base);
    await tx.query(`UPDATE proforma SET status = 'approved', decided_at = now(), approved_summary = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify({ ...summaryOf(r), revision: p.revision })]);
  } else {
    // Sent back: the owner edits and resubmits the same revision.
    await tx.query(`UPDATE proforma SET status = 'draft', decided_at = now(), updated_at = now() WHERE id = $1`, [id]);
  }
  await audit(tx, actor, { action: `proforma.${status === 'approved' ? 'approved' : 'sent_back'}`, entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { revision: p.revision } });
  await notify(tx, p.tenant_id, [p.owner_user_id], { kind: 'approval.decided', title: `${p.number} ${p.title} ${status === 'approved' ? 'approved' : 'sent back'}`,
    link: `/proforma/${id}`, subjectType: SUBJECT, subjectId: id, dedupeKey: `proforma-decided:${id}:${p.revision}:${status}` }, actor.userId);
}

/** Reopens a submitted or approved case as a new revision; a pending approval is withdrawn, the last approved figures are kept for comparison. */
export async function reopenProforma(tx: Tx, actor: Actor, id: string, reason: string) {
  const p = await load(tx, actor, id, true);
  if (!canManage(actor, p)) throw notFound('pro forma');
  if (!['submitted', 'approved'].includes(p.status)) throw conflict(`the pro forma is ${p.status}`);
  if (!reason?.trim() || reason.trim().length < 3) throw invalid('say why it is being reopened');
  // The revision being closed is kept whole, so it can still be opened and compared (D-163).
  const lines = await linesOf(tx, id);
  const summary = summaryOf(project(lines, assumptionsOf(p), scenariosOf(p).base));
  await tx.query(`INSERT INTO proforma_revision (tenant_id, proforma_id, revision, status, header, lines, summary, closed_by, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [p.tenant_id, id, p.revision, p.status, JSON.stringify(headerOf(p)), JSON.stringify(lines), JSON.stringify(summary), actor.userId, reason.trim()]);
  await closePendingRequests(tx, actor, SUBJECT, id, 'superseded', reason.trim());
  await tx.query(`UPDATE proforma SET status = 'draft', revision = revision + 1, submitted_at = NULL, updated_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'proforma.reopened', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: { from: p.status, revision: p.revision + 1, reason: reason.trim() } });
  return getProforma(tx, actor, id);
}

export async function copyProforma(tx: Tx, actor: Actor, id: string) {
  const p = await load(tx, actor, id);
  const copy = await createProforma(tx, actor, { facilityId: p.facility_id, title: `${p.title} (copy)`.slice(0, 200), kind: p.kind, description: p.description,
    startMonth: String(p.start_month instanceof Date ? p.start_month.toISOString() : p.start_month).slice(0, 7), years: p.years, discountRatePct: Number(p.discount_rate_pct),
    taxRatePct: Number(p.tax_rate_pct), workingCapitalDays: p.working_capital_days, scenarios: scenariosOf(p), lines: await linesOf(tx, id) });
  return copy;
}

export async function archiveProforma(tx: Tx, actor: Actor, id: string) {
  const p = await load(tx, actor, id, true);
  if (!canManage(actor, p)) throw notFound('pro forma');
  if (p.status === 'submitted') throw conflict('it is waiting for approval; reopen it first');
  await tx.query(`UPDATE proforma SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'proforma.archived', entityType: SUBJECT, entityId: id, facilityId: p.facility_id, data: {} });
}

/**
 * Last 12 full months of a site's books as monthly lines, to start an expansion case from what the site does today.
 * Income becomes revenue, cost of goods becomes cost of sales, and expenses become operating lines, one per account.
 */
export async function baselineFromBooks(tx: Tx, actor: Actor, facilityId: string) {
  requirePermission(actor, 'proforma.manage', facilityId);
  if (!can(actor, 'books.view', facilityId)) throw invalid('starting from the books needs permission to see the books');
  const rows = await many(tx, `SELECT a.name, a.subtype, sum(CASE WHEN a.type = 'income' THEN l.credit - l.debit ELSE l.debit - l.credit END)::float AS total
    FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN ledger_account a ON a.id = l.account_id
    WHERE l.facility_id = $1 AND a.subtype IN ('income', 'cost_of_goods', 'expense') AND e.entry_date >= date_trunc('month', current_date) - interval '12 months'
      AND e.entry_date < date_trunc('month', current_date)
    GROUP BY a.name, a.subtype HAVING sum(l.debit + l.credit) > 0 ORDER BY a.subtype, a.name`, [facilityId]);
  const lines: LineInput[] = rows.filter((r) => r.total > 0).map((r) => ({ section: r.subtype === 'income' ? 'revenue' : r.subtype === 'cost_of_goods' ? 'cost_of_sales' : 'operating',
    label: `${r.name} (last 12 months)`, method: 'fixed_monthly', amount: Math.round((r.total / 12) * 100) / 100 }));
  return { lines, answer: lines.length ? `${lines.length} account${lines.length === 1 ? '' : 's'} with activity in the last 12 months, as monthly averages.` : 'No posted activity at this site in the last 12 months.' };
}

// ---------------------------------------------------------------------------
// Comparing plans and revisions (D-163)
// ---------------------------------------------------------------------------

export interface PlanRef { id: string; revision?: number | null }

/**
 * Up to three plans side by side: different cases (buy or lease, one site or another) or revisions of one case. Each
 * is projected in its base scenario with its own assumptions; the answer names the best by NPV, and the differences
 * list the assumptions and lines that are not the same in every plan.
 */
export async function compareProformas(tx: Tx, actor: Actor, refs: PlanRef[]) {
  if (refs.length < 2 || refs.length > 3) throw invalid('compare two or three plans');
  const plans = [];
  for (const ref of refs) {
    const p = await load(tx, actor, ref.id);
    let header = headerOf(p); let lines = await linesOf(tx, p.id); let revision = p.revision; let status = p.status;
    if (ref.revision != null && ref.revision !== p.revision) {
      const r = await one(tx, 'SELECT * FROM proforma_revision WHERE proforma_id = $1 AND revision = $2', [p.id, ref.revision]);
      if (!r) throw notFound(`revision ${ref.revision} of ${p.number}`);
      header = r.header; lines = r.lines; revision = r.revision; status = r.status;
    }
    const a: Assumptions = { years: header.years, discountRatePct: header.discountRatePct, taxRatePct: header.taxRatePct, workingCapitalDays: header.workingCapitalDays };
    const res = project(lines, a, { ...DEFAULT_SCENARIOS.base, ...(header.scenarios?.base ?? {}) });
    plans.push({ id: p.id, number: p.number, revision, status, label: `${p.number} rev ${revision}`, header, lines, summary: summaryOf(res), years: res.years, answer: headline(res, a) });
  }
  const keys = new Set(plans.map((x) => `${x.id}:${x.revision}`));
  if (keys.size < plans.length) throw invalid('the same plan is listed twice');
  const differences: { what: string; values: string[] }[] = [];
  const show = (v: unknown) => (v == null ? '—' : String(v));
  for (const [k, label] of [['startMonth', 'First month'], ['years', 'Years'], ['discountRatePct', 'Discount rate %'], ['taxRatePct', 'Tax rate %'], ['workingCapitalDays', 'Working capital days']] as const) {
    const values = plans.map((x) => show((x.header as any)[k]));
    if (new Set(values).size > 1) differences.push({ what: label, values });
  }
  const describe = (l: LineInput) => `${l.method === 'units_price' ? `${l.qty} × ${l.amount}` : l.method === 'headcount' ? `${l.qty} × ${l.amount}/yr` : l.method === 'pct_of_revenue' ? `${l.amount}%` : l.amount}`
    + `${l.growthPct ? ` +${l.growthPct}%/yr` : ''}${l.startMonth ? ` from m${l.startMonth + 1}` : ''}${l.endMonth ? ` to m${l.endMonth}` : ''}`;
  const labels = [...new Set(plans.flatMap((x) => x.lines.map((l) => `${l.section}|${l.label}`)))];
  for (const key of labels) {
    const [section, label] = key.split('|') as [Section, string];
    const values = plans.map((x) => { const l = x.lines.find((y) => y.section === section && y.label === label); return l ? describe(l) : 'not in this plan'; });
    if (new Set(values).size > 1) differences.push({ what: `${label} (${section.replace(/_/g, ' ')})`, values });
  }
  const best = [...plans].sort((x, y) => y.summary.npv - x.summary.npv)[0]!;
  const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
  const second = [...plans].sort((x, y) => y.summary.npv - x.summary.npv)[1]!;
  const answer = `${best.label} has the highest NPV, ${usd(best.summary.npv)}, ${usd(best.summary.npv - second.summary.npv)} more than ${second.label}; `
    + `${plans.filter((x) => x.summary.paybackMonths != null).sort((x, y) => x.summary.paybackMonths! - y.summary.paybackMonths!)[0]?.label ?? 'none'} pays back soonest.`;
  return { answer, plans: plans.map(({ lines: _l, ...rest }) => rest), differences };
}

// ---------------------------------------------------------------------------
// Pulling lines in from the rest of the platform (D-163)
// ---------------------------------------------------------------------------

/** What this site has that a case can start from: the books, budgets, open opportunities, the rent roll, assets and labor rates. */
export async function importSources(tx: Tx, actor: Actor, facilityId: string | null) {
  requirePermission(actor, 'proforma.manage', facilityId);
  const budgets = can(actor, 'budgets.view') ? await many(tx, `SELECT id, name, fiscal_year, status FROM budget ORDER BY fiscal_year DESC, status = 'approved' DESC LIMIT 6`) : [];
  const opportunities = can(actor, 'crm.view') ? await many(tx, `SELECT o.id, o.title, c.name AS customer, o.amount::float AS amount, o.probability, o.expected_close, o.stage FROM opportunity o
    JOIN customer c ON c.id = o.customer_id WHERE o.stage NOT IN ('won', 'lost') AND o.amount > 0 ORDER BY o.amount DESC LIMIT 50`) : [];
  const leases = facilityId && can(actor, 'leasing.view', facilityId) ? await one(tx, `SELECT count(*)::int AS n, coalesce(sum(rent_amount), 0)::float AS rent FROM lease WHERE facility_id = $1 AND status IN ('active', 'notice')`, [facilityId]) : null;
  const assets = can(actor, 'assets.view', facilityId) ? await many(tx, `SELECT id, asset_tag, name, replacement_cost::float AS replacement_cost, expected_life_years FROM asset
    WHERE lifecycle_status <> 'disposed' AND ($1::uuid IS NULL OR facility_id = $1) ORDER BY replacement_cost DESC NULLS LAST, asset_tag LIMIT 200`, [facilityId]) : [];
  const labor = can(actor, 'work_orders.view', facilityId) ? await one(tx, `SELECT round(sum(l.hours * l.hourly_rate) / nullif(sum(l.hours), 0), 2)::float AS rate, coalesce(sum(l.hours), 0)::float AS hours
    FROM work_order_labor l JOIN work_order w ON w.id = l.work_order_id WHERE l.hourly_rate IS NOT NULL AND l.work_date >= current_date - 365 ${facilityId ? 'AND w.facility_id = $1' : 'AND $1::uuid IS NULL'}`, [facilityId]) : null;
  return { books: !!facilityId && can(actor, 'books.view', facilityId), budgets, opportunities, rentRoll: leases?.n ? leases : null, assets, laborRate: labor?.rate ? labor : null };
}

export type ImportInput = { source: 'books' | 'budget' | 'opportunity' | 'rent_roll' | 'asset' | 'labor'; facilityId?: string | null; refId?: string | null; startMonth?: string | null };

/** Lines drawn from another module, labelled with where they came from; the editor adds them to the draft for the owner to adjust. */
export async function importLines(tx: Tx, actor: Actor, input: ImportInput): Promise<{ lines: LineInput[]; answer: string }> {
  const facilityId = input.facilityId ?? null;
  requirePermission(actor, 'proforma.manage', facilityId);
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  switch (input.source) {
    case 'books': {
      if (!facilityId) throw invalid('choose a site to start from its books');
      const r = await baselineFromBooks(tx, actor, facilityId);
      return { lines: r.lines.map((l) => ({ ...l, source: 'Books, last 12 months' })), answer: r.answer };
    }
    case 'budget': {
      if (!can(actor, 'budgets.view')) throw invalid('pulling in a budget needs permission to see budgets');
      const b = await one(tx, 'SELECT id, name FROM budget WHERE id = $1', [input.refId]);
      if (!b) throw notFound('budget');
      const rows = await many(tx, `SELECT c.name, sum((SELECT sum(x) FROM unnest(l.amounts) x))::float AS total FROM budget_line l JOIN spend_category c ON c.id = l.spend_category_id
        WHERE l.budget_id = $1 AND ($2::uuid IS NULL OR l.facility_id = $2) GROUP BY c.name HAVING sum((SELECT sum(x) FROM unnest(l.amounts) x)) > 0 ORDER BY 2 DESC`, [b.id, facilityId]);
      const lines: LineInput[] = rows.map((r) => ({ section: 'operating', label: r.name, method: 'fixed_monthly', amount: Math.round((r.total / 12) * 100) / 100, source: `Budget: ${b.name}` }));
      return { lines, answer: lines.length ? `${lines.length} spend categories from ${b.name}, as monthly averages (${usd(rows.reduce((s, r) => s + r.total, 0))} a year).` : `${b.name} has nothing budgeted here.` };
    }
    case 'opportunity': {
      if (!can(actor, 'crm.view')) throw invalid('pulling in an opportunity needs permission to see customers');
      const o = await one(tx, `SELECT o.title, o.amount::float AS amount, o.probability, o.expected_close, c.name AS customer FROM opportunity o JOIN customer c ON c.id = o.customer_id WHERE o.id = $1`, [input.refId]);
      if (!o) throw notFound('opportunity');
      // The opportunity's value is spread over a year from the month it is expected to close.
      const start = input.startMonth && o.expected_close ? Math.max(0, monthsBetween(input.startMonth, monthOf(o.expected_close))) : 0;
      return { lines: [{ section: 'revenue', label: `${o.customer}: ${o.title}`, method: 'fixed_monthly', amount: Math.round(((o.amount ?? 0) / 12) * 100) / 100, startMonth: start, endMonth: start + 12,
        source: `CRM opportunity${o.probability != null ? `, ${o.probability}% likely` : ''}` }],
      answer: `${usd(o.amount ?? 0)} over 12 months from ${o.expected_close ? monthOf(o.expected_close) : 'the first month'}${o.probability != null ? `; the CRM puts it at ${o.probability}%, so consider the low case` : ''}.` };
    }
    case 'rent_roll': {
      if (!facilityId || !can(actor, 'leasing.view', facilityId)) throw invalid('the rent roll needs a property you can see leases for');
      const r = await one(tx, `SELECT count(*)::int AS n, coalesce(sum(rent_amount), 0)::float AS rent FROM lease WHERE facility_id = $1 AND status IN ('active', 'notice')`, [facilityId]);
      const charges = await one(tx, `SELECT coalesce(sum(x.amount), 0)::float AS amount FROM lease_charge x JOIN lease l ON l.id = x.lease_id WHERE l.facility_id = $1 AND l.status IN ('active', 'notice')
        AND (x.starts_on IS NULL OR x.starts_on <= current_date) AND (x.ends_on IS NULL OR x.ends_on >= current_date)`, [facilityId]);
      const lines: LineInput[] = [{ section: 'revenue', label: 'Rent roll', method: 'fixed_monthly', amount: r.rent, source: `Rent roll, ${r.n} leases` }];
      if (charges.amount > 0) lines.push({ section: 'revenue', label: 'Other recurring charges', method: 'fixed_monthly', amount: charges.amount, source: 'Rent roll charges' });
      return { lines, answer: `${r.n} active leases: ${usd(r.rent)} rent a month${charges.amount > 0 ? ` plus ${usd(charges.amount)} in other charges` : ''}.` };
    }
    case 'asset': {
      const a = await one(tx, 'SELECT id, facility_id, asset_tag, name, replacement_cost::float AS replacement_cost, expected_life_years, downtime_cost_per_hour::float AS downtime_rate FROM asset WHERE id = $1', [input.refId]);
      if (!a || !can(actor, 'assets.view', a.facility_id)) throw notFound('asset');
      const { assetCostHistory } = await import('../assets/lifecycle.js');
      const history = (await assetCostHistory(tx, a.id)).slice(-3);
      const upkeep = history.length ? history.reduce((s, h) => s + h.maintenance, 0) / history.length : 0;
      const downtime = history.length && a.downtime_rate ? (history.reduce((s, h) => s + h.downtimeHours, 0) / history.length) * a.downtime_rate : 0;
      const lines: LineInput[] = [];
      if (a.replacement_cost) lines.push({ section: 'capital', label: `Replace ${a.asset_tag} ${a.name}`, method: 'one_time', amount: a.replacement_cost, lifeYears: a.expected_life_years ?? 10, source: 'Asset replacement cost' });
      if (upkeep > 0) lines.push({ section: 'revenue', label: `Upkeep avoided on ${a.asset_tag}`, method: 'fixed_monthly', amount: Math.round((upkeep / 12) * 100) / 100, startMonth: 1,
        source: `Asset maintenance history, ${history.length}-year average`, note: 'Savings count as revenue in a capital case; a new machine still has some upkeep (add it as an operating line).' });
      if (downtime > 0) lines.push({ section: 'revenue', label: `Downtime avoided on ${a.asset_tag}`, method: 'fixed_monthly', amount: Math.round((downtime / 12) * 100) / 100, startMonth: 1, source: 'Asset downtime history × downtime cost per hour' });
      return { lines, answer: lines.length ? `${a.asset_tag}: ${a.replacement_cost ? `${usd(a.replacement_cost)} to replace` : 'no replacement cost recorded'}, ${usd(upkeep)} a year in upkeep${downtime ? ` and ${usd(downtime)} in downtime` : ''} over the last ${history.length || 0} years.`
        : `${a.asset_tag} has no replacement cost and no maintenance history to draw on.` };
    }
    case 'labor': {
      const r = await one(tx, `SELECT round(sum(l.hours * l.hourly_rate) / nullif(sum(l.hours), 0), 2)::float AS rate, coalesce(sum(l.hours), 0)::float AS hours FROM work_order_labor l
        JOIN work_order w ON w.id = l.work_order_id WHERE l.hourly_rate IS NOT NULL AND l.work_date >= current_date - 365 AND ($1::uuid IS NULL OR w.facility_id = $1)`, [facilityId]);
      if (!r?.rate) throw invalid('no labor with a recorded rate in the last 12 months here');
      // 2,080 paid hours a year; the rate recorded on work orders is an operational cost, not payroll (no benefits load).
      return { lines: [{ section: 'operating', label: 'Technicians', method: 'headcount', amount: Math.round(r.rate * 2080), qty: 1, source: `Work-order labor rate, ${Math.round(r.hours)} hours` }],
        answer: `$${r.rate} an hour on work orders over the last 12 months (${Math.round(r.hours)} hours), about ${usd(r.rate * 2080)} a year per person before benefits.` };
    }
  }
}
const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));

// ---------------------------------------------------------------------------
// Who approves business cases (D-167)
// ---------------------------------------------------------------------------

/**
 * The company owner (its administrators) approves business cases, unless an administrator has named an approver. A named
 * approver who submits a case of their own cannot sign it, so it goes to the owner instead.
 */
async function approvalStep(tx: Tx, actor: Actor) {
  const s = await one(tx, `SELECT st.approver_user_id, u.display_name FROM proforma_settings st JOIN app_user u ON u.id = st.approver_user_id AND u.status = 'active'`);
  if (s?.approver_user_id && s.approver_user_id !== actor.userId) return { roleKey: 'admin', label: `Approval of the business case by ${s.display_name}`, assigneeUserId: s.approver_user_id as string };
  return { roleKey: 'admin', label: 'Owner approval of the business case' };
}

export async function proformaSettings(tx: Tx, actor: Actor) {
  if (!can(actor, 'proforma.view') && !can(actor, 'proforma.manage') && !can(actor, 'tenant.admin')) requirePermission(actor, 'proforma.view');
  const s = await one(tx, `SELECT st.approver_user_id, u.display_name AS approver_name FROM proforma_settings st LEFT JOIN app_user u ON u.id = st.approver_user_id`);
  const candidates = can(actor, 'tenant.admin') ? await many(tx, `SELECT id, display_name FROM app_user WHERE status = 'active' ORDER BY display_name`) : [];
  return { approverUserId: s?.approver_user_id ?? null, approverName: s?.approver_name ?? null, approver: s?.approver_name ?? 'The owner (administrators)', canChange: can(actor, 'tenant.admin'), candidates };
}

export async function saveProformaSettings(tx: Tx, actor: Actor, input: { approverUserId: string | null }) {
  requirePermission(actor, 'tenant.admin');
  if (input.approverUserId && !(await one(tx, `SELECT 1 FROM app_user WHERE id = $1 AND status = 'active'`, [input.approverUserId]))) throw invalid('the approver must be an active user');
  await tx.query(`INSERT INTO proforma_settings (tenant_id, approver_user_id, updated_by) VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO UPDATE SET approver_user_id = EXCLUDED.approver_user_id, updated_by = EXCLUDED.updated_by, updated_at = now()`, [actor.tenantId, input.approverUserId, actor.userId]);
  await audit(tx, actor, { action: 'proforma.approver_changed', entityType: 'proforma_settings', entityId: actor.tenantId, data: { approverUserId: input.approverUserId } });
  return proformaSettings(tx, actor);
}
