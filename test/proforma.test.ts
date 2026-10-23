import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import type { Line } from '../src/modules/proforma/engine.js';
import { DEFAULT_SCENARIOS, irrOf, npvOf, project, sensitivity } from '../src/modules/proforma/engine.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

/** Opportunity pro forma (D-162): the engine's arithmetic, then the business case lifecycle over HTTP. */
const flat = { years: 5, discountRatePct: 0, taxRatePct: 0, workingCapitalDays: 0 };

describe('the engine', () => {
  const simple: Line[] = [
    { section: 'revenue', label: 'Rent', method: 'fixed_monthly', amount: 5000 },
    { section: 'capital', label: 'Building work', method: 'one_time', amount: 120000, lifeYears: 5 },
  ];
  it('pays back in the month cumulative cash returns to zero, and reports the lowest point as funding needed', () => {
    const r = project(simple, flat);
    expect(r.months).toHaveLength(60);
    expect(r.paybackMonths).toBe(24); // -120,000 + 24 × 5,000 = 0
    expect(r.peakFunding).toBe(115000); // the first month already earns 5,000
    expect(r.npv).toBe(180000); // undiscounted: 60 × 5,000 - 120,000
    expect(r.totals).toMatchObject({ revenue: 300000, capital: 120000, cashFlow: 180000 });
    expect(r.breakevenMonth).toBe(1);
  });
  it('depreciates capital straight line from the month after it is spent', () => {
    const r = project(simple, flat);
    expect(r.months[0]!.depreciation).toBe(0);
    expect(r.months[1]!.depreciation).toBe(2000); // 120,000 over 60 months
    expect(r.years.reduce((s, y) => s + y.depreciation, 0)).toBe(118000); // 59 months fall inside the horizon
  });
  it('IRR is the rate at which NPV is zero; none when the cash never changes sign', () => {
    const r = project(simple, { ...flat, discountRatePct: 10 });
    const cash = r.months.map((m) => m.cash);
    expect(r.irrPct).toBeGreaterThan(30);
    expect(Math.abs(npvOf(cash, r.irrPct!))).toBeLessThan(200);
    expect(irrOf([100, 100])).toBeNull();
    expect(r.npv).toBeLessThan(180000);
  });
  it('grows a line at each anniversary and ramps revenue up over its first months', () => {
    const r = project([{ section: 'revenue', label: 'Units', method: 'units_price', amount: 100, qty: 10, growthPct: 10, rampMonths: 4 }], flat);
    expect(r.months.slice(0, 5).map((m) => m.revenue)).toEqual([250, 500, 750, 1000, 1000]);
    expect(r.months[12]!.revenue).toBeCloseTo(1100, 6);
    expect(r.months[24]!.revenue).toBeCloseTo(1210, 6);
  });
  it('carries losses forward before tax is due, and ties up working capital as days of revenue', () => {
    const lines: Line[] = [
      { section: 'revenue', label: 'Sales', method: 'fixed_monthly', amount: 3650 },
      { section: 'operating', label: 'Launch', method: 'one_time', amount: 10000 },
    ];
    const r = project(lines, { years: 1, discountRatePct: 0, taxRatePct: 20, workingCapitalDays: 30 });
    // Month 1: 3,650 - 10,000 = -6,350 loss carried; months 2+ earn 3,650 each, taxed only once the loss is used up.
    expect(r.months[0]!.tax).toBe(0);
    expect(r.months[1]!.tax).toBe(0);
    expect(r.years[0]!.tax).toBeCloseTo((3650 * 12 - 10000) * 0.2, 6);
    expect(r.months[0]!.workingCapital).toBeCloseTo(3600, 6); // 3,650 × 12 × 30 / 365
    expect(r.months[1]!.workingCapital).toBeCloseTo(0, 6);
  });
  it('scenarios scale revenue, costs and capital and can delay the launch; percent-of-revenue costs follow revenue', () => {
    const lines: Line[] = [
      { section: 'revenue', label: 'Sales', method: 'fixed_monthly', amount: 10000 },
      { section: 'cost_of_sales', label: 'Goods', method: 'pct_of_revenue', amount: 40 },
      { section: 'operating', label: 'Rent', method: 'fixed_monthly', amount: 2000 },
      { section: 'capital', label: 'Fit-out', method: 'one_time', amount: 100000 },
    ];
    const low = project(lines, flat, DEFAULT_SCENARIOS.low); const base = project(lines, flat);
    expect(low.months[0]!.revenue).toBe(0); // three months late
    expect(low.months[3]!.revenue).toBe(8000);
    expect(low.months[3]!.costOfSales).toBe(3200);
    expect(low.months[3]!.operating).toBeCloseTo(2200, 6);
    expect(low.totals.capital).toBe(115000);
    expect(low.npv).toBeLessThan(base.npv);
  });
  it('ranks what moves NPV most, largest spread first', () => {
    const lines: Line[] = [
      { section: 'revenue', label: 'Big line', method: 'fixed_monthly', amount: 20000 },
      { section: 'revenue', label: 'Small line', method: 'fixed_monthly', amount: 1000 },
      { section: 'operating', label: 'Staff', method: 'fixed_monthly', amount: 8000 },
      { section: 'capital', label: 'Equipment', method: 'one_time', amount: 50000 },
    ];
    const s = sensitivity(lines, { ...flat, discountRatePct: 10 });
    expect(s.map((d) => d.swing)).toEqual([...s.map((d) => d.swing)].sort((a, b) => b - a));
    expect(s[0]!.label).toMatch(/Revenue/);
    expect(s.find((d) => d.label === 'Small line ±20%')!.swing).toBeLessThan(s.find((d) => d.label === 'Big line ±20%')!.swing);
  });
});

let app: FastifyInstance; let w: World;
beforeAll(async () => { app = buildApp(); w = await makeWorld('proforma'); });
afterAll(async () => { await app.close(); await closePools(); });
const call = (token: string | undefined, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe('business cases over HTTP', () => {
  it('runs from example drivers to approval, freezes, reopens as a new revision and keeps the approved figures', async () => {
    const created = await call(w.tokens.opsA, 'POST', '/api/proformas', { title: 'Second line at plant A', kind: 'product_line', facilityId: w.facilities.A, startMonth: '2027-01', years: 5 });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    let p = (await call(w.tokens.opsA, 'GET', `/api/proformas/${id}`)).json();
    expect(p).toMatchObject({ number: expect.stringMatching(/^PF-/), status: 'draft', canEdit: true });
    expect(p.lines.length).toBeGreaterThan(2);
    expect(p.results.base.years).toHaveLength(5);
    expect(p.answer).toMatch(/^Base case /);
    // Example lines must be replaced before it can be submitted.
    expect((await call(w.tokens.opsA, 'POST', `/api/proformas/${id}/submit`)).json().error.message).toMatch(/example lines/);
    const lines = p.lines.map((l: any) => ({ ...l, label: l.label.replace(' (example)', '') }));
    const saved = await call(w.tokens.opsA, 'PUT', `/api/proformas/${id}`, { title: p.title, kind: p.kind, startMonth: '2027-01', years: 5, lines });
    expect(saved.statusCode, saved.body).toBe(200);
    // A method that does not fit its section is refused with a reason.
    const bad = await call(w.tokens.opsA, 'PUT', `/api/proformas/${id}`, { title: p.title, kind: p.kind, startMonth: '2027-01', lines: [{ section: 'capital', label: 'Truck', method: 'fixed_monthly', amount: 1 }] });
    expect(bad.statusCode).toBe(422);
    expect((await call(w.tokens.opsA, 'POST', `/api/proformas/${id}/submit`)).statusCode).toBe(200);
    // Submitted: frozen.
    expect((await call(w.tokens.opsA, 'PUT', `/api/proformas/${id}`, { title: p.title, kind: p.kind, startMonth: '2027-01', lines })).statusCode).toBe(409);
    // The owner (an administrator) approves unless an administrator names an approver (D-167); finance no longer sees it.
    expect((await call(w.tokens.finance, 'GET', '/api/approvals/queue')).json().some((q: any) => q.subjectId === id)).toBe(false);
    const queue = (await call(w.tokens.admin, 'GET', '/api/approvals/queue')).json();
    const step = queue.find((q: any) => q.subjectType === 'proforma' && q.subjectId === id);
    expect(step).toBeTruthy();
    expect(step.label).toBe('Owner approval of the business case');
    const decided = await call(w.tokens.admin, 'POST', `/api/approvals/steps/${step.stepId}/decide`, { decision: 'approve', comment: 'Volumes match the customer forecast; capital in the plan.' });
    expect(decided.statusCode, decided.body).toBe(200);
    p = (await call(w.tokens.opsA, 'GET', `/api/proformas/${id}`)).json();
    expect(p.status).toBe('approved');
    expect(p.approved_summary).toMatchObject({ revision: 1, npv: p.results.base.npv });
    const reopened = await call(w.tokens.opsA, 'POST', `/api/proformas/${id}/reopen`, { reason: 'Customer doubled the volume' });
    expect(reopened.json()).toMatchObject({ status: 'draft', revision: 2, approved_summary: { revision: 1 } });
  });

  it('is limited to people who may see business cases at that site, and the list answers first', async () => {
    expect((await call(w.tokens.techA, 'GET', '/api/proformas')).statusCode).toBe(403);
    expect((await call(w.tokens.techA, 'POST', '/api/proformas', { title: 'Nope', kind: 'other', startMonth: '2027-01' })).statusCode).toBe(403);
    const list = (await call(w.tokens.exec, 'GET', '/api/proformas')).json();
    expect(list.answer).toMatch(/business case/);
    expect(list.rows.length).toBeGreaterThan(0);
    // Executives read but do not build.
    expect((await call(w.tokens.exec, 'POST', '/api/proformas', { title: 'Exec idea', kind: 'other', startMonth: '2027-01' })).statusCode).toBe(403);
    const report = await call(w.tokens.exec, 'GET', '/api/reports/proforma-portfolio');
    expect(report.statusCode).toBe(200);
    expect(report.json().headline).toMatch(/approved business case/);
  });

  it('copies a case into a new draft, and refuses a bad start month or horizon', async () => {
    const c = (await call(w.tokens.finance, 'POST', '/api/proformas', { title: 'Company truck fleet', kind: 'capital_project', startMonth: '2027-03', years: 7 })).json();
    const copy = await call(w.tokens.finance, 'POST', `/api/proformas/${c.id}/copy`);
    expect(copy.statusCode).toBe(201);
    expect(copy.json()).toMatchObject({ title: 'Company truck fleet (copy)', status: 'draft', years: 7 });
    expect((await call(w.tokens.finance, 'POST', '/api/proformas', { title: 'Bad month', kind: 'other', startMonth: '2027-13' })).statusCode).toBe(422);
    expect((await call(w.tokens.finance, 'POST', '/api/proformas', { title: 'Too long', kind: 'other', startMonth: '2027-01', years: 11 })).statusCode).toBe(422);
  });
});

describe('revisions, comparison and lines from other modules (D-163)', () => {
  const db = () => getAdminPool();
  it('keeps every closed revision whole and compares it with the current one', async () => {
    const c = (await call(w.tokens.opsA, 'POST', '/api/proformas', { title: 'Paint line upgrade', kind: 'capital_project', facilityId: w.facilities.A, startMonth: '2027-01', useStarter: false,
      lines: [{ section: 'revenue', label: 'Rework avoided', method: 'fixed_monthly', amount: 6000 }, { section: 'capital', label: 'Booth', method: 'one_time', amount: 150000, lifeYears: 10 }] })).json();
    expect((await call(w.tokens.opsA, 'POST', `/api/proformas/${c.id}/submit`)).statusCode).toBe(200);
    const re = (await call(w.tokens.opsA, 'POST', `/api/proformas/${c.id}/reopen`, { reason: 'Quote came in higher' })).json();
    expect(re.revisions).toEqual([expect.objectContaining({ revision: 1, status: 'submitted', reason: 'Quote came in higher', summary: expect.objectContaining({ capital: 150000 }) })]);
    await call(w.tokens.opsA, 'PUT', `/api/proformas/${c.id}`, { title: c.title, kind: c.kind, startMonth: '2027-01',
      lines: [{ section: 'revenue', label: 'Rework avoided', method: 'fixed_monthly', amount: 6000 }, { section: 'capital', label: 'Booth', method: 'one_time', amount: 190000, lifeYears: 10 }] });
    const cmp = await call(w.tokens.opsA, 'GET', `/api/proformas/compare?plans=${c.id}:1,${c.id}:2`);
    expect(cmp.statusCode, cmp.body).toBe(200);
    const body = cmp.json();
    expect(body.plans.map((x: any) => x.summary.capital)).toEqual([150000, 190000]);
    expect(body.answer).toMatch(/rev 1 has the highest NPV, \$[\d,]+, \$[\d,]+ more than PF-\d+ rev 2; /);
    expect(body.differences).toEqual([{ what: 'Booth (capital)', values: ['150000', '190000'] }]);
    // A different case can be compared too; one plan alone, or the same one twice, cannot.
    const other = (await call(w.tokens.opsA, 'POST', '/api/proformas', { title: 'Lease a booth instead', kind: 'capital_project', facilityId: w.facilities.A, startMonth: '2027-01', useStarter: false,
      lines: [{ section: 'revenue', label: 'Rework avoided', method: 'fixed_monthly', amount: 6000 }, { section: 'operating', label: 'Booth lease', method: 'fixed_monthly', amount: 3200 }] })).json();
    const three = (await call(w.tokens.opsA, 'GET', `/api/proformas/compare?plans=${c.id}:1,${c.id},${other.id}`)).json();
    expect(three.plans).toHaveLength(3);
    expect(three.differences.map((d: any) => d.what)).toEqual(expect.arrayContaining(['Booth (capital)', 'Booth lease (operating)']));
    expect((await call(w.tokens.opsA, 'GET', `/api/proformas/compare?plans=${c.id}`)).statusCode).toBe(422);
    expect((await call(w.tokens.opsA, 'GET', `/api/proformas/compare?plans=${c.id},${c.id}`)).statusCode).toBe(422);
    expect((await call(w.tokens.opsA, 'GET', `/api/proformas/compare?plans=${c.id}:9,${other.id}`)).statusCode).toBe(404);
  });

  it('pulls in a budget, a CRM opportunity and an asset, each line saying where it came from', async () => {
    const t = w.tenantId; const A = w.facilities.A; const admin = w.admin.userId;
    const cat = (await db().query(`INSERT INTO spend_category (tenant_id, code, name) VALUES ($1, 'PF-UTIL', 'Utilities (test)') RETURNING id`, [t])).rows[0].id;
    const b = (await db().query(`INSERT INTO budget (tenant_id, fiscal_year, name, status, created_by) VALUES ($1, 2027, 'Test 2027 budget', 'draft', $2) RETURNING id`, [t, admin])).rows[0].id;
    await db().query(`INSERT INTO budget_line (tenant_id, budget_id, facility_id, spend_category_id, amounts, updated_by) VALUES ($1, $2, $3, $4, array_fill(1000::numeric, ARRAY[12]), $5)`, [t, b, A, cat, admin]);
    await db().query(`UPDATE budget SET status = 'approved' WHERE id = $1`, [b]);
    const cust = (await db().query(`INSERT INTO customer (tenant_id, code, name, kind) VALUES ($1, 'PF-ACME', 'Acme Test', 'prospect') RETURNING id`, [t])).rows[0].id;
    const opp = (await db().query(`INSERT INTO opportunity (tenant_id, customer_id, title, stage, amount, probability, expected_close) VALUES ($1, $2, 'Bracket program', 'proposal', 240000, 60, '2027-04-15') RETURNING id`, [t, cust])).rows[0].id;
    const asset = (await db().query(`INSERT INTO asset (tenant_id, facility_id, asset_tag, name, replacement_cost, expected_life_years) VALUES ($1, $2, 'PF-CMP-1', 'Old compressor', 90000, 12) RETURNING id`, [t, A])).rows[0].id;
    const src = (await call(w.tokens.admin, 'GET', `/api/proformas/sources?facilityId=${A}`)).json();
    expect(src.budgets.map((x: any) => x.id)).toContain(b);
    expect(src.opportunities.map((x: any) => x.id)).toContain(opp);
    expect(src.assets.map((x: any) => x.id)).toContain(asset);
    const pull = async (body: object) => { const r = await call(w.tokens.admin, 'POST', '/api/proformas/import-lines', { facilityId: A, startMonth: '2027-01', ...body }); expect(r.statusCode, r.body).toBe(200); return r.json(); };
    expect((await pull({ source: 'budget', refId: b })).lines).toEqual([expect.objectContaining({ section: 'operating', label: 'Utilities (test)', method: 'fixed_monthly', amount: 1000, source: 'Budget: Test 2027 budget' })]);
    const o = await pull({ source: 'opportunity', refId: opp });
    expect(o.lines[0]).toMatchObject({ section: 'revenue', label: 'Acme Test: Bracket program', amount: 20000, startMonth: 3, endMonth: 15, source: 'CRM opportunity, 60% likely' });
    expect(o.answer).toMatch(/consider the low case/);
    expect((await pull({ source: 'asset', refId: asset })).lines[0]).toMatchObject({ section: 'capital', amount: 90000, lifeYears: 12, source: 'Asset replacement cost' });
    // A line pulled in keeps its source when saved.
    const c = (await call(w.tokens.admin, 'POST', '/api/proformas', { title: 'Bracket program', kind: 'customer_contract', facilityId: A, startMonth: '2027-01', lines: o.lines })).json();
    expect((await call(w.tokens.admin, 'GET', `/api/proformas/${c.id}`)).json().lines[0].source).toBe('CRM opportunity, 60% likely');
    // Pulling lines in is for people who build business cases.
    expect((await call(w.tokens.techA, 'POST', '/api/proformas/import-lines', { source: 'opportunity', facilityId: A, refId: opp })).statusCode).toBe(403);
  });
});

describe('who approves business cases (D-167)', () => {
  it('an administrator can name the approver; only administrators change it; a named approver never signs their own case', async () => {
    expect((await call(w.tokens.opsA, 'GET', '/api/proformas/settings')).json()).toMatchObject({ approverUserId: null, approver: 'The owner (administrators)', canChange: false });
    expect((await call(w.tokens.opsA, 'PUT', '/api/proformas/settings', { approverUserId: w.finance.userId })).statusCode).toBe(403);
    const set = await call(w.tokens.admin, 'PUT', '/api/proformas/settings', { approverUserId: w.finance.userId });
    expect(set.json()).toMatchObject({ approverUserId: w.finance.userId, approver: 'finance', canChange: true });
    const lines = [{ section: 'revenue', label: 'Savings', method: 'fixed_monthly', amount: 1000 }, { section: 'capital', label: 'Kit', method: 'one_time', amount: 20000 }];
    const a = (await call(w.tokens.opsA, 'POST', '/api/proformas', { title: 'Named approver case', kind: 'capital_project', facilityId: w.facilities.A, startMonth: '2027-01', lines })).json();
    await call(w.tokens.opsA, 'POST', `/api/proformas/${a.id}/submit`);
    const mine = (await call(w.tokens.finance, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === a.id);
    expect(mine).toMatchObject({ label: 'Approval of the business case by finance' });
    expect((await call(w.tokens.admin, 'GET', '/api/approvals/queue')).json().some((q: any) => q.subjectId === a.id)).toBe(false);
    // The named approver's own case goes to the owner.
    const b = (await call(w.tokens.finance, 'POST', '/api/proformas', { title: 'Approver\'s own case', kind: 'other', startMonth: '2027-01', lines })).json();
    await call(w.tokens.finance, 'POST', `/api/proformas/${b.id}/submit`);
    expect((await call(w.tokens.admin, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === b.id)).toMatchObject({ label: 'Owner approval of the business case' });
    await call(w.tokens.admin, 'PUT', '/api/proformas/settings', { approverUserId: null });
  });
});

describe('the approved plan against actuals (D-172)', () => {
  const dbq = (sql: string, p: unknown[] = []) => getAdminPool().query(sql, p);
  it('compares the approved base case with the site\'s posted books for each completed month, and keeps tracking a reopened case', async () => {
    const now = new Date(); const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)); const ym = start.toISOString().slice(0, 7);
    const lines = [{ section: 'revenue', label: 'Sales', method: 'fixed_monthly', amount: 10000 }, { section: 'cost_of_sales', label: 'Goods', method: 'pct_of_revenue', amount: 40 },
      { section: 'operating', label: 'Rent', method: 'fixed_monthly', amount: 2000 }, { section: 'capital', label: 'Fit-out', method: 'one_time', amount: 30000, lifeYears: 10 }];
    const c = (await call(w.tokens.admin, 'POST', '/api/proformas', { title: 'Tracked store', kind: 'new_site', facilityId: w.facilities.A, startMonth: ym, years: 3, lines })).json();
    expect((await call(w.tokens.admin, 'GET', `/api/proformas/${c.id}/actuals`)).statusCode).toBe(409); // not approved yet
    await call(w.tokens.admin, 'POST', `/api/proformas/${c.id}/submit`);
    // The submitter cannot approve; the approver is a second administrator.
    const second = await createUserWithToken(getAdminPool(), w.tenantId, { email: 'approver@proforma.example', displayName: 'Approver', roles: [{ role: 'admin', facility: null }] });
    const step = (await call(second.token, 'GET', '/api/approvals/queue')).json().find((q: any) => q.subjectId === c.id);
    await call(second.token, 'POST', `/api/approvals/steps/${step.stepId}/decide`, { decision: 'approve', comment: 'Plan agreed' });
    // Three months posted at the site: revenue 9,000 a month (90% of plan), cost of sales and rent as planned, and the fit-out at 36,000 in month 1.
    if (!(await dbq(`SELECT 1 FROM ledger_account WHERE tenant_id = $1 AND subtype = 'income'`, [w.tenantId])).rowCount) expect((await call(w.tokens.admin, 'POST', '/api/books/setup', { startDate: `${ym}-01` })).statusCode).toBeLessThan(300);
    const A = Object.fromEntries((await dbq(`SELECT DISTINCT ON (subtype) subtype, id FROM ledger_account WHERE tenant_id = $1 AND subtype IN ('income', 'cost_of_goods', 'expense', 'fixed_asset', 'bank') ORDER BY subtype, code`, [w.tenantId])).rows.map((r) => [r.subtype, r.id]));
    const client = await getAdminPool().connect();
    try {
      await client.query('BEGIN');
      let n = 0;
      const post = async (date: string, debit: string, credit: string, amount: number) => {
        const e = (await client.query(`INSERT INTO journal_entry (tenant_id, number, entry_date, memo, source, posted_by) VALUES ($1, $2, $3, 'plan test', 'manual', $4) RETURNING id`, [w.tenantId, `PVA-${ym}-${++n}`, date, w.admin.userId])).rows[0].id;
        await client.query(`INSERT INTO journal_line (tenant_id, entry_id, line_no, account_id, debit, credit, facility_id) VALUES ($1, $2, 1, $3, $5, 0, $6), ($1, $2, 2, $4, 0, $5, $6)`, [w.tenantId, e, A[debit], A[credit], amount, w.facilities.A]);
      };
      for (let i = 0; i < 3; i++) {
        const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 15)).toISOString().slice(0, 10);
        await post(date, 'bank', 'income', 9000); await post(date, 'cost_of_goods', 'bank', 3600); await post(date, 'expense', 'bank', 2000);
        if (i === 0) await post(date, 'fixed_asset', 'bank', 36000);
      }
      await client.query('COMMIT');
    } finally { client.release(); }
    const r = (await call(w.tokens.admin, 'GET', `/api/proformas/${c.id}/actuals`)).json();
    expect(r).toMatchObject({ started: true, monthsElapsed: 3, status: 'behind', ratio: 0.9 });
    expect(r.totals.plan).toMatchObject({ revenue: 30000, costOfSales: 12000, operating: 6000, capital: 30000, ebitda: 12000 });
    expect(r.totals.actual).toMatchObject({ revenue: 27000, costOfSales: 10800, operating: 6000, capital: 36000, ebitda: 10200 });
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ month: ym, plan: { capital: 30000 }, actual: { capital: 36000 } });
    expect(r.answer).toBe('Month 3 of 36: revenue is 90% of plan to date ($27,000 against $30,000); operating profit before depreciation is $1,800 behind plan; capital spent $36,000 against $30,000 planned.');
    // Reopened for a new revision: still tracked against the revision that was approved.
    await call(w.tokens.admin, 'POST', `/api/proformas/${c.id}/reopen`, { reason: 'Rent renegotiated' });
    expect((await call(w.tokens.admin, 'GET', `/api/proformas/${c.id}/actuals`)).json()).toMatchObject({ revision: 1, monthsElapsed: 3, ratio: 0.9 });
    // A reader of business cases who cannot see the books cannot see actuals; a case that has not started has nothing to compare.
    expect((await call(w.tokens.opsA, 'GET', `/api/proformas/${c.id}/actuals`)).statusCode).toBe(422);
  });
});
