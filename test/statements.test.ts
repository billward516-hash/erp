import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { LocalBlobStore } from '../src/platform/storage/blob-store.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';
import { setupBooks } from '../src/modules/books/service.js';
import { balanceSheetCompare, cashFlow, incomeStatement } from '../src/modules/books/statements.js';
import { buildStatements, statementsPdf, statementsXlsx } from '../src/modules/books/statements-pack.js';

/** Financial statements with comparisons, splits and cash flow (D-189), on a small journal whose answers can be worked out by hand. */
const db = () => getAdminPool();
let app: FastifyInstance; let admin: Actor; let token: string; let tenantId: string; let siteA: string; let siteB: string;
let acct: Record<string, string> = {};

async function entry(date: string, memo: string, site: string | null, lines: [string, number, number][]) {
  const c = await db().connect();
  try {
    await c.query('BEGIN');
    const n = `T-${Math.random().toString(36).slice(2, 10)}`;
    const e = (await c.query(`INSERT INTO journal_entry (tenant_id, number, entry_date, memo, source, posted_by) VALUES ($1, $2, $3, $4, 'manual', $5) RETURNING id`, [tenantId, n, date, memo, admin.userId])).rows[0].id;
    let i = 1;
    for (const [account, debit, credit] of lines) await c.query(`INSERT INTO journal_line (tenant_id, entry_id, line_no, account_id, debit, credit, facility_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [tenantId, e, i++, acct[account], debit, credit, site]);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
}

beforeAll(async () => {
  app = buildApp({ blobs: new LocalBlobStore('./.storage/test') });
  const n = `stm-${process.pid}-${Date.now() % 100000}`;
  const t = await provisionTenant(db(), { slug: n, name: 'Statement Test Co', legalEntity: 'Statement Test Co LLC', facilities: [{ code: 'A', name: 'Site A', timezone: 'America/Chicago' }, { code: 'B', name: 'Site B', timezone: 'America/Chicago' }] });
  tenantId = t.tenantId; siteA = t.facilities.A!; siteB = t.facilities.B!;
  const u = await createUserWithToken(db(), tenantId, { email: `a@${n}.example`, displayName: 'Admin', roles: [{ role: 'admin', facility: null }] });
  admin = (await loadActor(tenantId, u.userId))!; token = u.token;
  await asActor(admin, (tx) => setupBooks(tx, admin, { startDate: '2026-01-01', openingBalance: 0 }));
  const rows = (await db().query('SELECT id, code, name, type, subtype FROM ledger_account WHERE tenant_id = $1', [tenantId])).rows;
  const pick = (f: (r: any) => boolean) => rows.find(f)!.id as string;
  acct = {
    bank: pick((r) => r.subtype === 'bank'), ar: pick((r) => r.subtype === 'accounts_receivable'), ap: pick((r) => r.subtype === 'accounts_payable'),
    income: pick((r) => r.subtype === 'income'), expense: pick((r) => r.subtype === 'expense'), fixed: pick((r) => r.subtype === 'fixed_asset' && !/accumulated|depreciation/i.test(r.name)),
    capital: pick((r) => r.subtype === 'equity'),
  };
  await entry('2026-01-05', 'Owner capital', null, [['bank', 10000, 0], ['capital', 0, 10000]]);
  await entry('2026-01-10', 'Invoice at A', siteA, [['ar', 2000, 0], ['income', 0, 2000]]);
  await entry('2026-01-20', 'Supplies at A', siteA, [['expense', 500, 0], ['bank', 0, 500]]);
  await entry('2026-02-05', 'Sale at B', siteB, [['bank', 1500, 0], ['income', 0, 1500]]);
  await entry('2026-02-15', 'Bill at B', siteB, [['expense', 300, 0], ['ap', 0, 300]]);
  await entry('2026-02-20', 'Equipment bought', null, [['fixed', 4000, 0], ['bank', 0, 4000]]);
  await entry('2026-03-01', 'Collection at A', siteA, [['bank', 2000, 0], ['ar', 0, 2000]]);
});
afterAll(async () => { await app.close(); await closePools(); });
const q = (fn: (tx: any) => Promise<any>) => asActor(admin, fn);

describe('profit and loss', () => {
  it('splits by month, with a total, from the journal', async () => {
    const r = await q((tx) => incomeStatement(tx, admin, { from: '2026-01-01', to: '2026-03-31', by: 'month' }));
    expect(r.columns.map((c: any) => c.label)).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
    expect(r.income).toEqual([2000, 1500, 0]); expect(r.netIncome).toEqual([1500, 1200, 0]);
    expect(r.totalColumn.netIncome).toBe(2700);
  });
  it('splits by site and puts lines with no site in their own column, so the columns add to the company', async () => {
    const r = await q((tx) => incomeStatement(tx, admin, { from: '2026-01-01', to: '2026-03-31', by: 'site' }));
    expect(r.columns.map((c: any) => c.label)).toEqual(['A', 'B', 'No site']);
    expect(r.netIncome).toEqual([1500, 1200, 0]); expect(r.totalColumn.netIncome).toBe(2700);
    const one = await q((tx) => incomeStatement(tx, admin, { from: '2026-01-01', to: '2026-03-31', facilityId: siteB }));
    expect(one.netIncome).toEqual([1200]);
  });
  it('compares with the prior period and the prior year, with variance', async () => {
    const r = await q((tx) => incomeStatement(tx, admin, { from: '2026-02-01', to: '2026-03-31', compare: 'prior_period' }));
    expect(r.columns.map((c: any) => c.label)).toEqual(['This period', 'Prior period']);
    expect(r.columns[1].from).toBe('2025-12-04'); expect(r.columns[1].to).toBe('2026-01-31');
    expect(r.netIncome).toEqual([1200, 1500]); expect(r.variance).toMatchObject({ netIncome: -300, netIncomePct: -20, income: -500 });
    const y = await q((tx) => incomeStatement(tx, admin, { from: '2026-01-01', to: '2026-03-31', compare: 'prior_year' }));
    expect(y.netIncome).toEqual([2700, 0]); expect(y.columns[1].from).toBe('2025-01-01');
  });
  it('refuses a comparison together with a split, and an end before the start', async () => {
    await expect(q((tx) => incomeStatement(tx, admin, { from: '2026-01-01', to: '2026-03-31', by: 'month', compare: 'prior_year' }))).rejects.toThrow(/either a comparison or a split/);
    await expect(q((tx) => incomeStatement(tx, admin, { from: '2026-03-01', to: '2026-01-31' }))).rejects.toThrow(/before the start/);
  });
});

describe('balance sheet', () => {
  it('balances, and compares with the end of the previous month', async () => {
    const r = await q((tx) => balanceSheetCompare(tx, admin, { asOf: '2026-03-31', compare: 'prior_month' }));
    expect(r.columns.map((c: any) => c.asOf)).toEqual(['2026-03-31', '2026-02-28']);
    expect(r.totalAssets).toEqual([13000, 13000]); expect(r.totalLiabilities).toEqual([300, 300]); expect(r.totalEquity).toEqual([12700, 12700]); expect(r.balanced).toEqual([true, true]);
    const bank = r.assets.find((a: any) => a.subtype === 'bank'); expect(bank.amounts).toEqual([9000, 7000]);
    const ar = r.assets.find((a: any) => a.subtype === 'accounts_receivable'); expect(ar.amounts).toEqual([0, 2000]);
  });
  it('compares with the same date last year', async () => {
    const r = await q((tx) => balanceSheetCompare(tx, admin, { asOf: '2026-03-31', compare: 'prior_year' }));
    expect(r.columns[1].asOf).toBe('2025-03-31'); expect(r.totalAssets).toEqual([13000, 0]);
  });
});

describe('cash flow', () => {
  it('ties to the change in the bank accounts for the quarter', async () => {
    const r = await q((tx) => cashFlow(tx, admin, { from: '2026-01-01', to: '2026-03-31' }));
    expect(r.netIncome).toBe(2700); expect(r.operatingTotal).toBe(3000); expect(r.investingTotal).toBe(-4000); expect(r.financingTotal).toBe(10000);
    expect(r.netChange).toBe(9000); expect(r.cashStart).toBe(0); expect(r.cashEnd).toBe(9000); expect(r.ties).toBe(true); expect(r.difference).toBe(0);
  });
  it('ties for a month that starts with balances', async () => {
    const r = await q((tx) => cashFlow(tx, admin, { from: '2026-02-01', to: '2026-02-28' }));
    expect(r.cashStart).toBe(9500); expect(r.netIncome).toBe(1200); expect(r.operatingTotal).toBe(1500); expect(r.investingTotal).toBe(-4000);
    expect(r.cashEnd).toBe(7000); expect(r.ties).toBe(true);
  });
});

describe('over the API, and the pack', () => {
  const get = (url: string, tok = token) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}` } });
  it('serves the statements to people who can view the books and refuses others', async () => {
    const ok = await get('/api/books/statements/income?from=2026-01-01&to=2026-03-31&by=month');
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json().totalColumn.netIncome).toBe(2700);
    expect((await get('/api/books/statements/cash-flow?from=2026-01-01&to=2026-03-31')).json().ties).toBe(true);
    const other = await createUserWithToken(db(), tenantId, { email: `op@${tenantId}.example`, displayName: 'Operator', roles: [{ role: 'operator', facility: siteA }] });
    expect((await get('/api/books/statements/income?from=2026-01-01&to=2026-03-31', other.token)).statusCode).toBe(403);
    expect((await get('/api/books/statements/income?from=2026-03-01&to=2026-01-01')).statusCode).toBe(422);
  });
  it('produces a PDF and an Excel pack with all three statements', async () => {
    const pdf = await get('/api/books/statements/pack.pdf?from=2026-01-01&to=2026-03-31&compare=prior_year');
    expect(pdf.statusCode).toBe(200); expect(pdf.headers['content-type']).toBe('application/pdf'); expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const xlsx = await get('/api/books/statements/pack.xlsx?from=2026-01-01&to=2026-03-31');
    expect(xlsx.statusCode).toBe(200); expect(xlsx.rawPayload.length).toBeGreaterThan(2000);
    const pack = await q((tx) => buildStatements(tx, admin, { from: '2026-01-01', to: '2026-03-31' }));
    expect(pack.statements.map((s: { title: string }) => s.title)).toEqual(['Profit and loss', 'Balance sheet', 'Cash flow']); expect(pack.company).toBe('Statement Test Co');
    expect((await statementsPdf(pack)).length).toBeGreaterThan(3000); expect((await statementsXlsx(pack)).length).toBeGreaterThan(2000);
  });
});
