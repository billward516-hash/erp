import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/platform/db/pool.js';
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
    const queue = (await call(w.tokens.finance, 'GET', '/api/approvals/queue')).json();
    const step = queue.find((q: any) => q.subjectType === 'proforma' && q.subjectId === id);
    expect(step).toBeTruthy();
    const decided = await call(w.tokens.finance, 'POST', `/api/approvals/steps/${step.stepId}/decide`, { decision: 'approve', comment: 'Volumes match the customer forecast; capital in the plan.' });
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
