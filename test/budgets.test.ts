import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { allocate, fiscalMonth, fiscalMonths, historyStats, proposeFromHistory, reconcile, spread, sum, variance } from '../src/modules/budgets/engine.js';
import {
  actualSpend, allocateTarget, approveBudget, budgetVsActual, createBudget, decideSubmission, getBudget, proposeLines, saveBudgetLine, setTarget, spendAnalysis, submitBudget,
} from '../src/modules/budgets/service.js';
import { setDepartmentHead } from '../src/modules/expenses/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

describe('budget arithmetic', () => {
  it('allocates to the cent so parts add up to the total', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
    expect(allocate(1000, [0, 0])).toEqual([500, 500]);
    expect(sum(allocate(12345.67, [3, 1, 7, 2]))).toBe(12345.67);
  });
  it('keeps the seasonal pattern when proposing and spreading', () => {
    const hist = [100, 100, 100, 100, 100, 100, 200, 200, 200, 200, 200, 200]; // 1,800
    expect(proposeFromHistory(hist, 10)).toEqual([...Array(6).fill(110), ...Array(6).fill(220)]); // 1,980
    expect(spread(1200)).toEqual(Array(12).fill(100));
    expect(historyStats(hist)).toMatchObject({ total: 1800, average: 150, trailing3: 2400, peakMonth: 7, trendPct: 100 });
  });
  it('reconciles targets with the bottom-up lines they cover', () => {
    const cells = [{ facilityId: 'A', departmentId: 'm', categoryId: 'c1', annual: 60_000 }, { facilityId: 'A', departmentId: 'p', categoryId: 'c1', annual: 45_000 },
      { facilityId: 'B', departmentId: null, categoryId: 'c2', annual: 10_000 }];
    const r = reconcile([{ facilityId: null, departmentId: null, categoryId: 'c1', amount: 100_000 }, { facilityId: null, departmentId: null, categoryId: null, amount: 116_000 },
      { facilityId: 'B', departmentId: null, categoryId: null, amount: 10_100 }], cells);
    expect(r.map((x) => [x.bottomUp, x.gap, x.gapPct, x.status])).toEqual([[105_000, 5_000, 5, 'over'], [115_000, -1_000, -0.9, 'ok'], [10_000, -100, -1, 'ok']]);
  });
  it('variance: to date, commitments, forecast and run rate', () => {
    const budget = Array(12).fill(1000);
    expect(variance(budget, [1000, 1100, 1200, ...Array(9).fill(0)], 3)).toMatchObject({ budgetYtd: 3000, actualYtd: 3300, variance: 300, variancePct: 10, forecast: 12_300, runRate: 13_200, status: 'over' });
    expect(variance(budget, [900, 950, 1000, ...Array(9).fill(0)], 3, 100)).toMatchObject({ variance: -150, status: 'ok' });
    // 4% over after nine months: within 5% to date, but the forecast (9,360 + 3,000) is more than 2% over the year.
    expect(variance(budget, [...Array(9).fill(1040), 0, 0, 0], 9).status).toBe('watch');
  });
  it('fiscal months for a year starting in July', () => {
    expect(fiscalMonths(2027, 7).slice(0, 2)).toEqual(['2026-07-01', '2026-08-01']);
    expect(fiscalMonth('2026-07-15', 2027, 7)).toBe(1);
    expect(fiscalMonth('2027-06-01', 2027, 7)).toBe(12);
    expect(fiscalMonth('2027-07-01', 2027, 7)).toBeNull();
  });
});

const db = () => getAdminPool();
let w: World;
let cat: Record<string, string>;
let mnt: string;
const monthsAgo = (n: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 10); };

beforeAll(async () => {
  w = await makeWorld('bud');
  cat = Object.fromEntries((await db().query('SELECT code, id FROM spend_category WHERE tenant_id = $1', [w.tenantId])).rows.map((r) => [r.code, r.id]));
  mnt = (await db().query(`INSERT INTO department (tenant_id, facility_id, code, name) VALUES ($1, $2, 'MNT', 'Maintenance') RETURNING id`, [w.tenantId, w.facilities.A])).rows[0].id;
  await asActor(w.admin, (tx) => setDepartmentHead(tx, w.admin, mnt, w.managerA.userId));
  // Twelve months of imported history: maintenance at A in the department (2,000 a month for the last six months, 1,000 before); travel at B.
  for (let i = 1; i <= 12; i++) {
    await db().query(`INSERT INTO spend_history (tenant_id, facility_id, department_id, spend_category_id, month, amount, source_system, ref) VALUES ($1, $2, $3, $4, $5, $6, 'gl', $7)`,
      [w.tenantId, w.facilities.A, mnt, cat.MAINT, monthsAgo(i), i <= 6 ? 2000 : 1000, `m${i}`]);
    await db().query(`INSERT INTO spend_history (tenant_id, facility_id, spend_category_id, month, amount, source_system, ref) VALUES ($1, $2, $3, $4, 500, 'gl', $5)`,
      [w.tenantId, w.facilities.B, cat.TRAVEL, monthsAgo(i), `t${i}`]);
  }
  // A supplier invoice approved last month: a maintenance line counts, an inventory line does not; freight counts.
  const sup = (await db().query(`INSERT INTO supplier (tenant_id, code, name) VALUES ($1, 'S1', 'Supplier') RETURNING id`, [w.tenantId])).rows[0].id;
  const inv = (await db().query(`INSERT INTO supplier_invoice (tenant_id, facility_id, supplier_id, invoice_number, invoice_date, status, freight_amount, captured_by)
    VALUES ($1, $2, $3, 'INV-1', $4, 'approved', 40, $5) RETURNING id`, [w.tenantId, w.facilities.A, sup, monthsAgo(1), w.admin.userId])).rows[0].id;
  await db().query(`INSERT INTO supplier_invoice_line (tenant_id, invoice_id, line_no, description, qty, unit_price, account_key) VALUES ($1, $2, 1, 'Pump rebuild', 1, 800, 'maintenance_expense'),
    ($1, $2, 2, 'Bearings to stock', 10, 30, 'inventory')`, [w.tenantId, inv]);
});
afterAll(closePools);

describe('spend history and budgets', () => {
  it('actual spend excludes inventory purchases and classifies by account', async () => {
    const rows = await asActor(w.finance, (tx) => actualSpend(tx, { from: monthsAgo(1), to: monthsAgo(1) }));
    const a = rows.filter((r) => r.facility_id === w.facilities.A && r.source === 'supplier invoices');
    expect(a.map((r) => [r.category_id === cat.MAINT ? 'MAINT' : r.category_id === cat.FREIGHT ? 'FREIGHT' : '?', r.amount]).sort()).toEqual([['FREIGHT', 40], ['MAINT', 800]]);
    const an = await asActor(w.finance, (tx) => spendAnalysis(tx, w.finance));
    expect(an.categories.map((c) => [c.code, c.total])).toEqual([['MAINT', 18_800], ['TRAVEL', 6000], ['FREIGHT', 40]]);
    expect(an.categories[0]!.sources).toEqual({ 'imported history': 18_000, 'supplier invoices': 800 });
    await expect(asActor(w.techA, (tx) => spendAnalysis(tx, w.techA))).rejects.toThrow(/budgets.view/);
  });

  let budget: any;
  it('bottom-up: the department head proposes from history; others cannot touch it', async () => {
    const year = new Date().getUTCFullYear() + 1;
    budget = await asActor(w.finance, (tx) => createBudget(tx, w.finance, { fiscalYear: year, name: `${year} operating budget` }));
    await expect(asActor(w.managerA, (tx) => createBudget(tx, w.managerA, { fiscalYear: year, name: 'Mine' }))).rejects.toThrow(/budgets.manage/);
    expect(await asActor(w.managerA, (tx) => proposeLines(tx, w.managerA, budget.id, { facilityId: w.facilities.A!, departmentId: mnt, changePct: 5 }))).toEqual({ lines: 1 });
    const b = await asActor(w.managerA, (tx) => getBudget(tx, w.managerA, budget.id));
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toMatchObject({ category_code: 'MAINT', department_name: 'Maintenance', basis: 'history', annual: 18_900 }); // 18,000 history in the department + 5%
    await expect(asActor(w.techA, (tx) => saveBudgetLine(tx, w.techA, budget.id, { facilityId: w.facilities.A!, departmentId: mnt, categoryId: cat.MAINT!, annual: 1 }))).rejects.toThrow(/budgets.manage/);
    // Finance adds site lines: travel at B by annual amount, spread like its (flat) history.
    await asActor(w.finance, (tx) => saveBudgetLine(tx, w.finance, budget.id, { facilityId: w.facilities.B!, categoryId: cat.TRAVEL!, annual: 7200 }));
    expect((await asActor(w.finance, (tx) => getBudget(tx, w.finance, budget.id))).lines.find((l: any) => l.category_code === 'TRAVEL').amounts).toEqual(Array(12).fill(600));
  });

  it('top-down: a target shows the gap and allocation closes it exactly', async () => {
    await asActor(w.finance, (tx) => setTarget(tx, w.finance, budget.id, { amount: 24_000, note: 'Board ceiling' }));
    let b = await asActor(w.finance, (tx) => getBudget(tx, w.finance, budget.id));
    expect(b.targets[0]).toMatchObject({ target: 24_000, bottomUp: 26_100, gap: 2100, status: 'over' });
    await asActor(w.finance, (tx) => allocateTarget(tx, w.finance, b.targets[0].id, { basis: 'bottom_up' }));
    b = await asActor(w.finance, (tx) => getBudget(tx, w.finance, budget.id));
    expect(b.total).toBe(24_000);
    expect(b.targets[0]).toMatchObject({ bottomUp: 24_000, gap: 0, status: 'ok' });
    expect(b.lines.map((l: any) => l.basis)).toEqual(['allocated', 'allocated']);
  });

  it('submission, review and approval freeze the budget', async () => {
    await asActor(w.managerA, (tx) => submitBudget(tx, w.managerA, budget.id, { facilityId: w.facilities.A!, departmentId: mnt, note: 'Pump rebuilds in Q3' }));
    await expect(asActor(w.managerA, (tx) => proposeLines(tx, w.managerA, budget.id, { facilityId: w.facilities.A!, departmentId: mnt }))).rejects.toThrow(/budgets.manage/); // locked while submitted
    await expect(asActor(w.finance, (tx) => approveBudget(tx, w.finance, budget.id))).rejects.toThrow(/1 submitted budget is waiting for review/);
    const sub = (await asActor(w.finance, (tx) => getBudget(tx, w.finance, budget.id))).submissions[0];
    await expect(asActor(w.finance, (tx) => decideSubmission(tx, w.finance, sub.id, { accept: false }))).rejects.toThrow(/say what to change/);
    await asActor(w.finance, (tx) => decideSubmission(tx, w.finance, sub.id, { accept: true }));
    await asActor(w.finance, (tx) => approveBudget(tx, w.finance, budget.id));
    await expect(db().query('UPDATE budget_line SET note = $2 WHERE budget_id = $1', [budget.id, 'x'])).rejects.toThrow(/approved and cannot change/);
    const copy = await asActor(w.finance, (tx) => createBudget(tx, w.finance, { fiscalYear: budget.fiscal_year, name: 'Reforecast', copyFrom: budget.id }));
    await expect(asActor(w.finance, (tx) => approveBudget(tx, w.finance, copy.id))).rejects.toThrow(/is already the approved budget/);
  });

  it('budget against actual for the current year', async () => {
    const year = new Date().getUTCFullYear();
    const cur = await asActor(w.finance, (tx) => createBudget(tx, w.finance, { fiscalYear: year, name: `${year} budget` }));
    await asActor(w.finance, (tx) => saveBudgetLine(tx, w.finance, cur.id, { facilityId: w.facilities.A!, departmentId: mnt, categoryId: cat.MAINT!, amounts: Array(12).fill(1000) }));
    const v = await asActor(w.finance, (tx) => budgetVsActual(tx, w.finance, cur.id));
    const elapsed = new Date().getUTCMonth(); // complete months before this one
    expect(v.elapsed).toBe(elapsed);
    const line = v.rows.find((r) => r.categoryId === cat.MAINT && r.departmentId === mnt)!;
    // History this year in the department: 2,000 a month for months 1–6 ago, 1,000 for 7–12 ago (those in this year only).
    const expected = Array.from({ length: elapsed }, (_, m) => { const ago = elapsed - m; return ago <= 6 ? 2000 : 1000; }).reduce((s, x) => s + x, 0);
    expect(line.actualYtd).toBe(expected);
    expect(line.budgetYtd).toBe(1000 * elapsed);
    // The supplier invoice (no department) at A has no site line of its own: shown unbudgeted, not hidden.
    expect(v.rows.some((r) => r.unbudgeted && r.facilityId === w.facilities.A && r.departmentId === null)).toBe(elapsed >= 1 && monthsAgo(1).startsWith(String(year)));
  });
});
