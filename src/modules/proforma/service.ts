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
 * The owner builds it from driver lines, compares low, base and high scenarios, and submits it for finance approval.
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
export interface LineInput extends Line { note?: string | null }

const month = (s: string) => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw invalid('the start month must look like 2027-01'); return `${s}-01`; };
const toLine = (r: any): LineInput => ({ section: r.section, label: r.label, method: r.method, amount: Number(r.amount), qty: r.qty == null ? null : Number(r.qty),
  growthPct: r.growth_pct == null ? null : Number(r.growth_pct), startMonth: r.start_month, endMonth: r.end_month, rampMonths: r.ramp_months,
  lifeYears: r.life_years == null ? null : Number(r.life_years), note: r.note });
const assumptionsOf = (p: any): Assumptions => ({ years: p.years, discountRatePct: Number(p.discount_rate_pct), taxRatePct: Number(p.tax_rate_pct), workingCapitalDays: p.working_capital_days });
const scenariosOf = (p: any): Record<ScenarioKey, Scenario> => ({ ...DEFAULT_SCENARIOS, ...(p.scenarios ?? {}) });

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
    await tx.query(`INSERT INTO proforma_line (tenant_id, proforma_id, seq, section, label, method, amount, qty, growth_pct, start_month, end_month, ramp_months, life_years, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [actor.tenantId, id, i + 1, l.section, l.label.trim(), l.method, l.amount, l.qty ?? null, l.growthPct ?? null, l.startMonth ?? 0, l.endMonth ?? null, l.rampMonths ?? null,
      l.section === 'capital' ? l.lifeYears ?? 5 : null, l.note?.trim() || null]);
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
    approvals: await approvalHistory(tx, SUBJECT, id), canEdit: p.status === 'draft' && canManage(actor, p), canManage: canManage(actor, p),
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
    stages: [{ steps: [{ roleKey: 'finance_approver', label: 'Finance review of the business case' }] }] });
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
