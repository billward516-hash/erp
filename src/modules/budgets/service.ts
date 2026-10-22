import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, forbidden, invalid, notFound } from '../../platform/errors.js';
import { notify } from '../../platform/notify/notify.js';
import { allocate, fiscalMonth, fiscalMonths, historyStats, type Months, proposeFromHistory, reconcile, spread, sum, variance } from './engine.js';

/**
 * Budgets (docs/ARCHITECTURE.md §12x, D-133, D-134). Actual spend is read from the records, classified into spend
 * categories by account key:
 * - supplier invoices: every line except inventory purchases (stock is counted when used)
 * - stock issued from storerooms at its unit cost: to work orders as maintenance, otherwise production materials
 * - approved expense reports
 * - imported history from the previous system
 * Commitments are open purchase-order lines for non-stock items. Budgets are built bottom-up (lines per site,
 * department, category and month) and top-down (targets), reconciled, accepted, approved and then frozen.
 */
const NIL = '00000000-0000-0000-0000-000000000000';
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (m: string, n: number) => { const y = Number(m.slice(0, 4)); const mo = Number(m.slice(5, 7)) - 1 + n; return `${y + Math.floor(mo / 12)}-${String(((mo % 12) + 12) % 12 + 1).padStart(2, '0')}-01`; };

export interface SpendRow { facility_id: string; department_id: string | null; category_id: string | null; month: string; amount: number; source: string }

/** Actual spend between two months (inclusive, YYYY-MM-01), by site, department, category, month and source. */
export async function actualSpend(tx: Tx, q: { from: string; to: string; facilityIds?: string[] }): Promise<SpendRow[]> {
  const end = addMonths(q.to, 1);
  const rows = await many(tx, `WITH cat AS (SELECT id, unnest(account_keys) AS account_key FROM spend_category WHERE active),
    src AS (
      SELECT i.facility_id, NULL::uuid AS department_id, l.account_key, date_trunc('month', i.invoice_date)::date AS month, l.qty * l.unit_price AS amount, 'supplier invoices' AS source
        FROM supplier_invoice_line l JOIN supplier_invoice i ON i.id = l.invoice_id
        WHERE i.status IN ('approved', 'exported', 'paid') AND l.account_key <> 'inventory' AND i.invoice_date >= $1 AND i.invoice_date < $2
      UNION ALL SELECT i.facility_id, NULL, 'freight', date_trunc('month', i.invoice_date)::date, i.freight_amount, 'supplier invoices'
        FROM supplier_invoice i WHERE i.status IN ('approved', 'exported', 'paid') AND i.freight_amount > 0 AND i.invoice_date >= $1 AND i.invoice_date < $2
      UNION ALL SELECT i.facility_id, NULL, 'sales_tax', date_trunc('month', i.invoice_date)::date, i.tax_amount, 'supplier invoices'
        FROM supplier_invoice i WHERE i.status IN ('approved', 'exported', 'paid') AND i.tax_amount > 0 AND i.invoice_date >= $1 AND i.invoice_date < $2
      UNION ALL SELECT t.facility_id, NULL, CASE WHEN t.work_order_id IS NOT NULL THEN 'maintenance_expense' ELSE 'production_materials' END,
          date_trunc('month', t.created_at)::date, -t.qty * coalesce(t.unit_cost, p.unit_cost, 0), 'stock used'
        FROM inventory_txn t JOIN part p ON p.id = t.part_id WHERE t.txn_type IN ('issue', 'return') AND t.created_at >= $1 AND t.created_at < $2
      UNION ALL SELECT r.facility_id, r.department_id, c.account_key, date_trunc('month', l.spent_on)::date, l.amount, 'expense reports'
        FROM expense_line l JOIN expense_report r ON r.id = l.report_id JOIN expense_category c ON c.id = l.category_id
        WHERE r.status IN ('approved', 'paid') AND l.spent_on >= $1 AND l.spent_on < $2
    )
    SELECT s.facility_id, s.department_id, cat.id AS category_id, s.month::text AS month, sum(s.amount)::float AS amount, s.source
      FROM src s LEFT JOIN cat ON cat.account_key = s.account_key
      WHERE ($3::uuid[] IS NULL OR s.facility_id = ANY ($3)) GROUP BY 1, 2, 3, 4, 6
    UNION ALL
    SELECT h.facility_id, h.department_id, h.spend_category_id, h.month::text, sum(h.amount)::float, 'imported history'
      FROM spend_history h WHERE h.month >= $1 AND h.month < $2 AND ($3::uuid[] IS NULL OR h.facility_id = ANY ($3)) GROUP BY 1, 2, 3, 4`,
  [q.from, end, q.facilityIds ?? null]);
  return rows.filter((r) => Math.abs(r.amount) >= 0.005) as SpendRow[];
}

/** Open purchase-order value for non-stock lines (stock is counted when used), by site and category. */
export async function commitments(tx: Tx, facilityIds?: string[]) {
  return many(tx, `WITH cat AS (SELECT id, unnest(account_keys) AS account_key FROM spend_category WHERE active)
    SELECT o.facility_id, cat.id AS category_id, sum((l.qty_ordered - l.qty_received) * l.unit_price)::float AS amount
    FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id JOIN purchase_request_line rl ON rl.id = l.request_line_id JOIN purchase_request r ON r.id = rl.request_id
    LEFT JOIN cat ON cat.account_key = CASE WHEN r.spend_type = 'capex' THEN 'capital_projects' ELSE 'maintenance_expense' END
    WHERE o.status IN ('open', 'partially_received') AND l.qty_received < l.qty_ordered AND (l.part_id IS NULL OR l.location_id IS NULL)
      AND ($1::uuid[] IS NULL OR o.facility_id = ANY ($1))
    GROUP BY 1, 2`, [facilityIds ?? null]);
}

const viewable = (actor: Actor) => can(actor, 'budgets.view') || can(actor, 'budgets.manage');
function visibleFacilities(actor: Actor) {
  return actor.grants.some((g) => g.facilityId === null) ? undefined : [...new Set(actor.grants.map((g) => g.facilityId!).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Spend categories and history analysis
// ---------------------------------------------------------------------------

export async function listSpendCategories(tx: Tx) {
  return many(tx, 'SELECT id, code, name, account_keys, sort_order, active FROM spend_category ORDER BY sort_order, name');
}

export async function saveSpendCategory(tx: Tx, actor: Actor, input: { id?: string; code: string; name: string; accountKeys: string[]; sortOrder?: number; active?: boolean }) {
  requirePermission(actor, 'budgets.manage');
  const vals = [input.code.trim().toUpperCase(), input.name.trim(), input.accountKeys, input.sortOrder ?? 100, input.active ?? true];
  const c = input.id ? await one(tx, 'UPDATE spend_category SET code = $2, name = $3, account_keys = $4, sort_order = $5, active = $6 WHERE id = $1 RETURNING *', [input.id, ...vals])
    : await one(tx, 'INSERT INTO spend_category (tenant_id, code, name, account_keys, sort_order, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [actor.tenantId, ...vals]);
  if (!c) throw notFound('spend category');
  await audit(tx, actor, { action: 'spend_category.saved', entityType: 'spend_category', entityId: c.id, data: input });
  return c;
}

/**
 * Historic spend by category for the twelve complete months before `asOf` (default today): monthly figures, total,
 * average, last-quarter run rate, peak month and trend, by source, by site and department, and spend not mapped to a
 * category (an account key no category claims).
 */
export async function spendAnalysis(tx: Tx, actor: Actor, q: { facilityId?: string; departmentId?: string; asOf?: string } = {}) {
  if (!viewable(actor)) throw forbidden('budgets.view');
  const to = addMonths(monthStart(q.asOf ?? today()), -1); const from = addMonths(to, -11);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(from, i));
  const rows = (await actualSpend(tx, { from, to, facilityIds: q.facilityId ? [q.facilityId] : visibleFacilities(actor) }))
    .filter((r) => !q.departmentId || r.department_id === q.departmentId);
  const cats = await listSpendCategories(tx);
  const facilities = new Map((await many(tx, 'SELECT id, code FROM facility')).map((f) => [f.id, f.code]));
  const depts = new Map((await many(tx, 'SELECT id, name FROM department')).map((d) => [d.id, d.name]));
  const byCat = new Map<string, Months>();
  const bySource = new Map<string, Map<string, number>>();
  const byOrg = new Map<string, { facility: string; department: string | null; amount: number }>();
  let unmapped = 0;
  for (const r of rows) {
    if (!r.category_id) { unmapped += r.amount; continue; }
    const arr = byCat.get(r.category_id) ?? Array(12).fill(0);
    arr[months.indexOf(r.month)] += r.amount; byCat.set(r.category_id, arr);
    const s = bySource.get(r.category_id) ?? new Map(); s.set(r.source, (s.get(r.source) ?? 0) + r.amount); bySource.set(r.category_id, s);
    const k = `${r.facility_id}|${r.department_id ?? ''}`;
    const o = byOrg.get(k) ?? { facility: facilities.get(r.facility_id) ?? '?', department: r.department_id ? depts.get(r.department_id) ?? null : null, amount: 0 };
    o.amount += r.amount; byOrg.set(k, o);
  }
  const categories = cats.filter((c) => byCat.has(c.id)).map((c) => {
    const m = byCat.get(c.id)!.map((x) => Math.round(x * 100) / 100);
    return { id: c.id, code: c.code, name: c.name, ...historyStats(m), sources: Object.fromEntries([...bySource.get(c.id)!].map(([k, v]) => [k, Math.round(v * 100) / 100])) };
  }).sort((a, b) => b.total - a.total);
  const total = sum(categories.map((c) => c.total));
  return { from, to, months, total, unmapped: Math.round(unmapped * 100) / 100, categories: categories.map((c) => ({ ...c, share: total ? Math.round((c.total / total) * 1000) / 10 : 0 })),
    byOrg: [...byOrg.values()].map((o) => ({ ...o, amount: Math.round(o.amount * 100) / 100 })).sort((a, b) => b.amount - a.amount) };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

async function lockBudget(tx: Tx, id: string) {
  const b = await one(tx, 'SELECT * FROM budget WHERE id = $1 FOR UPDATE', [id]);
  if (!b) throw notFound('budget');
  return b;
}
function draftOnly(b: any) { if (b.status !== 'draft') throw conflict(`the budget is ${b.status}; copy it to a new version to change it`); }

/** Who may edit a site or department's lines: finance, or the head of that department while its submission is open. */
async function canEditCell(tx: Tx, actor: Actor, budgetId: string, facilityId: string, departmentId: string | null) {
  if (can(actor, 'budgets.manage')) return true;
  if (!departmentId) return false;
  const d = await one(tx, 'SELECT head_user_id FROM department WHERE id = $1', [departmentId]);
  if (d?.head_user_id !== actor.userId) return false;
  const s = await one(tx, `SELECT status FROM budget_submission WHERE budget_id = $1 AND facility_id = $2 AND coalesce(department_id, $4) = coalesce($3::uuid, $4)`, [budgetId, facilityId, departmentId, NIL]);
  return !s || ['draft', 'returned'].includes(s.status);
}

export async function createBudget(tx: Tx, actor: Actor, input: { fiscalYear: number; name: string; startMonth?: number; notes?: string | null; copyFrom?: string | null }) {
  requirePermission(actor, 'budgets.manage');
  if (!input.name?.trim()) throw invalid('name the budget (e.g. "2027 operating budget")');
  const b = await one(tx, `INSERT INTO budget (tenant_id, fiscal_year, name, start_month, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [actor.tenantId, input.fiscalYear, input.name.trim(), input.startMonth ?? 1, input.notes ?? null, actor.userId]).catch((e) => {
    if (String(e.message).includes('budget_tenant_id_fiscal_year_name_key')) throw conflict(`there is already a budget named "${input.name}" for ${input.fiscalYear}`);
    throw e;
  });
  if (input.copyFrom) {
    const src = await one(tx, 'SELECT * FROM budget WHERE id = $1', [input.copyFrom]);
    if (!src) throw notFound('budget to copy');
    if (src.start_month !== b!.start_month || src.fiscal_year !== b!.fiscal_year) throw invalid('copy within the same fiscal year');
    await tx.query(`INSERT INTO budget_line (tenant_id, budget_id, facility_id, department_id, spend_category_id, amounts, basis, note, updated_by)
      SELECT tenant_id, $2, facility_id, department_id, spend_category_id, amounts, basis, note, $3 FROM budget_line WHERE budget_id = $1`, [input.copyFrom, b!.id, actor.userId]);
    await tx.query(`INSERT INTO budget_target (tenant_id, budget_id, facility_id, department_id, spend_category_id, amount, note, set_by)
      SELECT tenant_id, $2, facility_id, department_id, spend_category_id, amount, note, $3 FROM budget_target WHERE budget_id = $1`, [input.copyFrom, b!.id, actor.userId]);
  }
  await audit(tx, actor, { action: 'budget.created', entityType: 'budget', entityId: b!.id, data: { ...input } });
  return b!;
}

export async function listBudgets(tx: Tx, actor: Actor) {
  if (!viewable(actor) && !(await one(tx, 'SELECT 1 FROM department WHERE head_user_id = $1', [actor.userId]))) throw forbidden('budgets.view');
  return many(tx, `SELECT b.id, b.fiscal_year, b.name, b.status, b.start_month, b.approved_at, u.display_name AS approved_by_name,
      (SELECT coalesce(sum(x), 0)::float FROM budget_line l, unnest(l.amounts) x WHERE l.budget_id = b.id) AS total,
      (SELECT coalesce(sum(amount), 0)::float FROM budget_target t WHERE t.budget_id = b.id AND t.facility_id IS NULL AND t.department_id IS NULL AND t.spend_category_id IS NULL) AS company_target
    FROM budget b LEFT JOIN app_user u ON u.id = b.approved_by ORDER BY b.fiscal_year DESC, b.created_at DESC`);
}

async function linesOf(tx: Tx, budgetId: string) {
  return many(tx, `SELECT l.id, l.facility_id, f.code AS facility_code, l.department_id, d.name AS department_name, l.spend_category_id AS category_id, c.code AS category_code, c.name AS category_name,
      (SELECT array_agg(x::float ORDER BY o) FROM unnest(l.amounts) WITH ORDINALITY AS a(x, o)) AS amounts, l.basis, l.note, u.display_name AS updated_by_name, l.updated_at
    FROM budget_line l JOIN facility f ON f.id = l.facility_id LEFT JOIN department d ON d.id = l.department_id JOIN spend_category c ON c.id = l.spend_category_id
    JOIN app_user u ON u.id = l.updated_by WHERE l.budget_id = $1 ORDER BY f.code, d.name NULLS FIRST, c.sort_order`, [budgetId]);
}

export async function getBudget(tx: Tx, actor: Actor, id: string) {
  const b = await one(tx, `SELECT b.*, u.display_name AS approved_by_name FROM budget b LEFT JOIN app_user u ON u.id = b.approved_by WHERE b.id = $1`, [id]);
  if (!b) throw notFound('budget');
  const heads = (await many(tx, 'SELECT id FROM department WHERE head_user_id = $1', [actor.userId])).map((d) => d.id);
  if (!viewable(actor) && !heads.length) throw forbidden('budgets.view');
  let lines = await linesOf(tx, id);
  if (!viewable(actor)) lines = lines.filter((l) => heads.includes(l.department_id));
  const targets = await many(tx, `SELECT t.id, t.facility_id, f.code AS facility_code, t.department_id, d.name AS department_name, t.spend_category_id AS category_id, c.name AS category_name,
      t.amount::float AS amount, t.note FROM budget_target t LEFT JOIN facility f ON f.id = t.facility_id LEFT JOIN department d ON d.id = t.department_id
      LEFT JOIN spend_category c ON c.id = t.spend_category_id WHERE t.budget_id = $1 ORDER BY t.facility_id NULLS FIRST, t.department_id NULLS FIRST, c.sort_order NULLS FIRST`, [id]);
  const submissions = await many(tx, `SELECT s.id, s.facility_id, f.code AS facility_code, s.department_id, d.name AS department_name, s.status, s.note, s.submitted_at, su.display_name AS submitted_by_name,
      s.decided_at, s.decision_note, du.display_name AS decided_by_name, hu.display_name AS head_name
    FROM budget_submission s JOIN facility f ON f.id = s.facility_id LEFT JOIN department d ON d.id = s.department_id LEFT JOIN app_user su ON su.id = s.submitted_by
    LEFT JOIN app_user du ON du.id = s.decided_by LEFT JOIN app_user hu ON hu.id = d.head_user_id WHERE s.budget_id = $1 ORDER BY f.code, d.name`, [id]);
  const cells = lines.map((l) => ({ facilityId: l.facility_id, departmentId: l.department_id, categoryId: l.category_id, annual: sum(l.amounts) }));
  const recon = reconcile(targets.map((t) => ({ facilityId: t.facility_id, departmentId: t.department_id, categoryId: t.category_id, amount: t.amount })), cells);
  const byMonth = Array.from({ length: 12 }, (_, i) => sum(lines.map((l) => l.amounts[i] ?? 0)));
  return {
    ...b, months: fiscalMonths(b.fiscal_year, b.start_month), lines: lines.map((l) => ({ ...l, annual: sum(l.amounts) })), targets: targets.map((t, i) => ({ ...t, ...recon[i] })),
    submissions, total: sum(byMonth), byMonth, canManage: can(actor, 'budgets.manage'), myDepartments: heads,
  };
}

/**
 * Sets a bottom-up line: twelve monthly amounts, or an annual amount spread like the line's history (or evenly).
 */
export async function saveBudgetLine(tx: Tx, actor: Actor, budgetId: string, input: { facilityId: string; departmentId?: string | null; categoryId: string;
  amounts?: number[]; annual?: number; spreadBy?: 'history' | 'even'; note?: string | null }) {
  const b = await lockBudget(tx, budgetId); draftOnly(b);
  if (!(await canEditCell(tx, actor, budgetId, input.facilityId, input.departmentId ?? null))) throw forbidden('budgets.manage (or be the department head while its budget is open)');
  let amounts = input.amounts; let basis = 'manual';
  if (!amounts) {
    if (input.annual == null) throw invalid('give twelve monthly amounts or an annual amount');
    const hist = input.spreadBy === 'even' ? undefined : await cellHistory(tx, b, input.facilityId, input.departmentId ?? null, input.categoryId);
    amounts = spread(input.annual, hist && sum(hist) > 0 ? hist : undefined); basis = 'spread';
  }
  if (amounts.length !== 12 || amounts.some((x) => !(x >= 0))) throw invalid('twelve amounts of zero or more');
  await upsertLine(tx, actor, budgetId, input.facilityId, input.departmentId ?? null, input.categoryId, amounts.map((x) => Math.round(x * 100) / 100), basis, input.note ?? null);
}

async function upsertLine(tx: Tx, actor: Actor, budgetId: string, facilityId: string, departmentId: string | null, categoryId: string, amounts: number[], basis: string, note: string | null) {
  await tx.query(`INSERT INTO budget_line (tenant_id, budget_id, facility_id, department_id, spend_category_id, amounts, basis, note, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (budget_id, facility_id, coalesce(department_id, '${NIL}'), spend_category_id)
    DO UPDATE SET amounts = EXCLUDED.amounts, basis = EXCLUDED.basis, note = coalesce(EXCLUDED.note, budget_line.note), updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, budgetId, facilityId, departmentId, categoryId, amounts, basis, note, actor.userId]);
  await audit(tx, actor, { action: 'budget.line_saved', entityType: 'budget', entityId: budgetId, facilityId, data: { departmentId, categoryId, annual: sum(amounts), basis } });
}

/**
 * The last twelve complete months of actual spend for a cell, arranged by fiscal month (calendar month matched), so a
 * proposal keeps the seasonal pattern.
 */
async function cellHistory(tx: Tx, b: any, facilityId: string, departmentId: string | null, categoryId: string): Promise<Months> {
  return (await historyByCell(tx, b, [facilityId]))
    .get(`${facilityId}|${departmentId ?? ''}|${categoryId}`) ?? Array(12).fill(0);
}

async function historyByCell(tx: Tx, b: any, facilityIds?: string[]) {
  const to = addMonths(monthStart(today()), -1); const from = addMonths(to, -11);
  const rows = await actualSpend(tx, { from, to, facilityIds });
  const out = new Map<string, Months>();
  for (const r of rows) {
    if (!r.category_id) continue;
    const k = `${r.facility_id}|${r.department_id ?? ''}|${r.category_id}`;
    const arr = out.get(k) ?? Array(12).fill(0);
    // Calendar month of the actual → fiscal month index for this budget.
    const cal = Number(r.month.slice(5, 7));
    arr[(cal - b.start_month + 12) % 12] += r.amount;
    out.set(k, arr);
  }
  return out;
}

/** Bottom-up from history: every category with spend at the site (and department) in the last twelve months, changed by a percentage. */
export async function proposeLines(tx: Tx, actor: Actor, budgetId: string, input: { facilityId: string; departmentId?: string | null; changePct?: number; overwrite?: boolean }) {
  const b = await lockBudget(tx, budgetId); draftOnly(b);
  if (!(await canEditCell(tx, actor, budgetId, input.facilityId, input.departmentId ?? null))) throw forbidden('budgets.manage (or be the department head while its budget is open)');
  const hist = await historyByCell(tx, b, [input.facilityId]);
  const existing = new Set((await linesOf(tx, budgetId)).filter((l) => l.facility_id === input.facilityId && l.department_id === (input.departmentId ?? null)).map((l) => l.category_id));
  const made: string[] = [];
  for (const [k, months] of hist) {
    const [fac, dept, cat] = k.split('|');
    if (fac !== input.facilityId || (dept || null) !== (input.departmentId ?? null) || sum(months) <= 0) continue;
    if (existing.has(cat!) && !input.overwrite) continue;
    await upsertLine(tx, actor, budgetId, fac!, dept || null, cat!, proposeFromHistory(months, input.changePct ?? 0), 'history',
      `Last 12 months${input.changePct ? ` ${input.changePct > 0 ? '+' : ''}${input.changePct}%` : ''}`);
    made.push(cat!);
  }
  return { lines: made.length };
}

export async function setTarget(tx: Tx, actor: Actor, budgetId: string, input: { facilityId?: string | null; departmentId?: string | null; categoryId?: string | null; amount: number; note?: string | null }) {
  requirePermission(actor, 'budgets.manage');
  const b = await lockBudget(tx, budgetId); draftOnly(b);
  if (input.amount < 0) throw invalid('a target cannot be negative');
  const t = await one(tx, `INSERT INTO budget_target (tenant_id, budget_id, facility_id, department_id, spend_category_id, amount, note, set_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (budget_id, coalesce(facility_id, '${NIL}'), coalesce(department_id, '${NIL}'), coalesce(spend_category_id, '${NIL}'))
    DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = now() RETURNING *`,
  [actor.tenantId, budgetId, input.facilityId ?? null, input.departmentId ?? null, input.categoryId ?? null, input.amount, input.note ?? null, actor.userId]);
  await audit(tx, actor, { action: 'budget.target_set', entityType: 'budget', entityId: budgetId, data: input });
  return t;
}

export async function deleteTarget(tx: Tx, actor: Actor, targetId: string) {
  requirePermission(actor, 'budgets.manage');
  const t = await one(tx, 'SELECT budget_id FROM budget_target WHERE id = $1', [targetId]);
  if (!t) throw notFound('target');
  draftOnly(await lockBudget(tx, t.budget_id));
  await tx.query('DELETE FROM budget_target WHERE id = $1', [targetId]);
}

/**
 * Top-down: allocates a target over the lines it covers, in proportion to their history (or their current bottom-up
 * amounts), each spread over the months like its history. Cells with neither get nothing; parts add up to the target.
 */
export async function allocateTarget(tx: Tx, actor: Actor, targetId: string, input: { basis: 'history' | 'bottom_up' }) {
  requirePermission(actor, 'budgets.manage');
  const t = await one(tx, 'SELECT * FROM budget_target WHERE id = $1', [targetId]);
  if (!t) throw notFound('target');
  const b = await lockBudget(tx, t.budget_id); draftOnly(b);
  const hist = await historyByCell(tx, b);
  const lines = await linesOf(tx, b.id);
  const inScope = (fac: string, dept: string | null, cat: string) => (!t.facility_id || fac === t.facility_id) && (!t.department_id || dept === t.department_id) && (!t.spend_category_id || cat === t.spend_category_id);
  const cells = new Map<string, { fac: string; dept: string | null; cat: string; hist: Months; current: number }>();
  for (const [k, months] of hist) {
    const [fac, dept, cat] = k.split('|');
    if (inScope(fac!, dept || null, cat!)) cells.set(k, { fac: fac!, dept: dept || null, cat: cat!, hist: months, current: 0 });
  }
  for (const l of lines) {
    if (!inScope(l.facility_id, l.department_id, l.category_id)) continue;
    const k = `${l.facility_id}|${l.department_id ?? ''}|${l.category_id}`;
    const c = cells.get(k) ?? { fac: l.facility_id, dept: l.department_id, cat: l.category_id, hist: Array(12).fill(0), current: 0 };
    c.current = sum(l.amounts); cells.set(k, c);
  }
  const list = [...cells.values()];
  const weights = list.map((c) => (input.basis === 'history' ? sum(c.hist) : c.current));
  if (!weights.some((w) => w > 0)) throw invalid(input.basis === 'history' ? 'there is no spend history in the target\'s scope to allocate by' : 'there are no bottom-up amounts in the target\'s scope to allocate by');
  const parts = allocate(Number(t.amount), weights);
  let n = 0;
  for (const [i, c] of list.entries()) {
    if (!(weights[i]! > 0)) continue;
    await upsertLine(tx, actor, b.id, c.fac, c.dept, c.cat, spread(parts[i]!, sum(c.hist) > 0 ? c.hist : undefined), 'allocated', `Allocated from a target by ${input.basis === 'history' ? 'history' : 'bottom-up'}`);
    n++;
  }
  return { lines: n };
}

/** A department head (or finance) submits their bottom-up budget for review; finance is told. */
export async function submitBudget(tx: Tx, actor: Actor, budgetId: string, input: { facilityId: string; departmentId?: string | null; note?: string | null }) {
  const b = await lockBudget(tx, budgetId); draftOnly(b);
  if (!(await canEditCell(tx, actor, budgetId, input.facilityId, input.departmentId ?? null))) throw forbidden('budgets.manage (or be the department head)');
  const lines = (await linesOf(tx, budgetId)).filter((l) => l.facility_id === input.facilityId && l.department_id === (input.departmentId ?? null));
  if (!lines.length) throw invalid('add the budget lines first (start from history or enter them)');
  const s = await one(tx, `INSERT INTO budget_submission (tenant_id, budget_id, facility_id, department_id, status, note, submitted_by, submitted_at) VALUES ($1, $2, $3, $4, 'submitted', $5, $6, now())
    ON CONFLICT (budget_id, facility_id, coalesce(department_id, '${NIL}')) DO UPDATE SET status = 'submitted', note = EXCLUDED.note, submitted_by = EXCLUDED.submitted_by, submitted_at = now(),
      decided_by = NULL, decided_at = NULL, decision_note = NULL RETURNING *`, [actor.tenantId, budgetId, input.facilityId, input.departmentId ?? null, input.note ?? null, actor.userId]);
  const finance = (await many(tx, `SELECT DISTINCT a.user_id FROM user_role_scope a JOIN role r ON r.id = a.role_id WHERE 'budgets.manage' = ANY (r.permissions)`)).map((x) => x.user_id);
  await notify(tx, actor.tenantId, finance, { kind: 'budget.submitted', title: `Budget submitted for review: ${b.name}`, body: `${lines.length} lines, ${sum(lines.map((l) => sum(l.amounts))).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`,
    link: `/budgets/${budgetId}`, subjectType: 'budget', subjectId: budgetId, dedupeKey: `budget-sub:${s!.id}:${Date.now()}` }, actor.userId);
  await audit(tx, actor, { action: 'budget.submitted', entityType: 'budget', entityId: budgetId, facilityId: input.facilityId, data: { departmentId: input.departmentId ?? null } });
  return s;
}

export async function decideSubmission(tx: Tx, actor: Actor, submissionId: string, input: { accept: boolean; note?: string | null }) {
  requirePermission(actor, 'budgets.manage');
  const s = await one(tx, 'SELECT * FROM budget_submission WHERE id = $1 FOR UPDATE', [submissionId]);
  if (!s) throw notFound('submission');
  draftOnly(await lockBudget(tx, s.budget_id));
  if (s.status !== 'submitted') throw conflict(`the submission is ${s.status}`);
  if (s.submitted_by === actor.userId) throw invalid('someone other than the submitter reviews it');
  if (!input.accept && !input.note?.trim()) throw invalid('say what to change when returning a budget');
  await tx.query(`UPDATE budget_submission SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [submissionId, input.accept ? 'accepted' : 'returned', actor.userId, input.note ?? null]);
  await notify(tx, actor.tenantId, [s.submitted_by], { kind: 'budget.decided', title: input.accept ? 'Your budget was accepted' : 'Your budget was returned for changes', body: input.note ?? null,
    link: `/budgets/${s.budget_id}`, subjectType: 'budget', subjectId: s.budget_id, dedupeKey: `budget-dec:${submissionId}:${Date.now()}` }, actor.userId);
  await audit(tx, actor, { action: input.accept ? 'budget.accepted' : 'budget.returned', entityType: 'budget', entityId: s.budget_id, data: { submissionId, note: input.note ?? null } });
}

/** Approval makes the budget the year's plan of record and freezes it; nothing may wait for review. */
export async function approveBudget(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'budgets.manage');
  const b = await lockBudget(tx, id); draftOnly(b);
  const waiting = await one(tx, `SELECT count(*)::int AS n FROM budget_submission WHERE budget_id = $1 AND status = 'submitted'`, [id]);
  if (waiting.n) throw invalid(`${waiting.n} submitted budget${waiting.n === 1 ? ' is' : 's are'} waiting for review; accept or return ${waiting.n === 1 ? 'it' : 'them'} first`);
  if (!(await one(tx, 'SELECT 1 FROM budget_line WHERE budget_id = $1', [id]))) throw invalid('the budget has no lines');
  const other = await one(tx, `SELECT name FROM budget WHERE fiscal_year = $1 AND status = 'approved' AND id <> $2`, [b.fiscal_year, id]);
  if (other) throw conflict(`"${other.name}" is already the approved budget for ${b.fiscal_year}; close it first`);
  await tx.query(`UPDATE budget SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'budget.approved', entityType: 'budget', entityId: id, data: { fiscalYear: b.fiscal_year } });
}

export async function closeBudget(tx: Tx, actor: Actor, id: string) {
  requirePermission(actor, 'budgets.manage');
  const b = await lockBudget(tx, id);
  if (b.status !== 'approved') throw conflict(`the budget is ${b.status}`);
  await tx.query(`UPDATE budget SET status = 'closed' WHERE id = $1`, [id]);
  await audit(tx, actor, { action: 'budget.closed', entityType: 'budget', entityId: id, data: {} });
}

/**
 * Budget against actual for a budget's fiscal year as of a date: for each site, department and category with a budget
 * or spend, the twelve months of each and the variance (engine). Spend with no budget line shows as unbudgeted.
 */
export async function budgetVsActual(tx: Tx, actor: Actor, id: string, q: { asOf?: string } = {}) {
  const b = await getBudget(tx, actor, id);
  const months = b.months as string[];
  const asOf = q.asOf ?? today();
  // Fiscal months completed before the as-of month (the current month is still open).
  const elapsed = months.filter((m) => m < monthStart(asOf)).length;
  const visible = visibleFacilities(actor);
  const spend = await actualSpend(tx, { from: months[0]!, to: months[11]!, facilityIds: visible });
  const committed = await commitments(tx, visible);
  const cats = new Map((await listSpendCategories(tx)).map((c) => [c.id, c]));
  const fac = new Map((await many(tx, 'SELECT id, code FROM facility')).map((f) => [f.id, f.code]));
  const dep = new Map((await many(tx, 'SELECT id, name FROM department')).map((d) => [d.id, d.name]));
  const rows = new Map<string, { facilityId: string; departmentId: string | null; categoryId: string | null; budget: Months; actual: Months; committed: number }>();
  const get = (f: string, d: string | null, c: string | null) => {
    const k = `${f}|${d ?? ''}|${c ?? ''}`;
    if (!rows.has(k)) rows.set(k, { facilityId: f, departmentId: d, categoryId: c, budget: Array(12).fill(0), actual: Array(12).fill(0), committed: 0 });
    return rows.get(k)!;
  };
  for (const l of b.lines) get(l.facility_id, l.department_id, l.category_id).budget = l.amounts.slice();
  for (const s of spend) {
    const m = fiscalMonth(s.month, b.fiscal_year, b.start_month);
    if (!m) continue;
    // Spend with a department that has no line of its own counts against the site's line (department not budgeted separately).
    const dept = s.department_id && rows.has(`${s.facility_id}|${s.department_id}|${s.category_id ?? ''}`) ? s.department_id : rows.has(`${s.facility_id}||${s.category_id ?? ''}`) ? null : s.department_id;
    const row = get(s.facility_id, dept, s.category_id);
    row.actual[m - 1] = (row.actual[m - 1] ?? 0) + s.amount;
  }
  for (const c of committed) {
    const r = rows.get(`${c.facility_id}||${c.category_id ?? ''}`) ?? [...rows.values()].find((x) => x.facilityId === c.facility_id && x.categoryId === c.category_id) ?? get(c.facility_id, null, c.category_id);
    r.committed += c.amount;
  }
  const out = [...rows.values()].map((r) => {
    const actual = r.actual.map((x) => Math.round(x * 100) / 100);
    const v = variance(r.budget, actual, elapsed, Math.round(r.committed * 100) / 100);
    return { ...r, actual, facility: fac.get(r.facilityId) ?? '?', department: r.departmentId ? dep.get(r.departmentId) ?? null : null,
      category: r.categoryId ? cats.get(r.categoryId)?.name ?? '?' : 'Not mapped to a category', unbudgeted: sum(r.budget) === 0 && sum(actual) > 0, ...v };
  }).sort((a, b2) => a.facility.localeCompare(b2.facility) || (a.department ?? '').localeCompare(b2.department ?? '') || a.category.localeCompare(b2.category));
  const totals = variance(Array.from({ length: 12 }, (_, i) => sum(out.map((r) => r.budget[i]!))), Array.from({ length: 12 }, (_, i) => sum(out.map((r) => r.actual[i]!))), elapsed,
    sum(out.map((r) => r.committed)));
  return { budget: { id: b.id, name: b.name, fiscal_year: b.fiscal_year, status: b.status, start_month: b.start_month }, months, asOf, elapsed, rows: out, totals };
}
