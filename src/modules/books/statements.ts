import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';
import { fiscalYearStart } from './service.js';
import { type AccountType, debitNormal } from './chart.js';

/**
 * Financial statements with comparisons and splits (D-189): a profit and loss with prior-period, prior-year, month-by-month or
 * site-by-site columns; a balance sheet with comparison dates; and a cash flow statement (indirect method) that must tie to the
 * change in the bank accounts. All of it reads the same journal as the older statements and changes nothing.
 */
const money = (n: number) => Math.round(n * 100) / 100;
const view = (actor: Actor) => requirePermission(actor, 'books.view');
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const endOfMonth = (d: string) => addDays(addMonths(`${d.slice(0, 7)}-01`, 1), -1);
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface Col { key: string; label: string; from: string | null; to: string; facilityId?: string | null }
interface AccountSums { id: string; code: string; name: string; type: AccountType; subtype: string; debit: number; credit: number }

/** Sums by account for entries in [from, to] (from null: since the beginning), optionally one site (lines with that site only). */
async function sums(tx: Tx, c: { from: string | null; to: string; facilityId?: string | null }): Promise<AccountSums[]> {
  return many(tx, `SELECT a.id, a.code, a.name, a.type, a.subtype, coalesce(sum(l.debit), 0)::float AS debit, coalesce(sum(l.credit), 0)::float AS credit
    FROM ledger_account a LEFT JOIN journal_line l ON l.account_id = a.id AND ($3::uuid IS NULL OR l.facility_id = $3)
      AND l.entry_id IN (SELECT id FROM journal_entry e WHERE e.entry_date <= $2 AND ($1::date IS NULL OR e.entry_date >= $1))
    GROUP BY a.id ORDER BY a.code`, [c.from, c.to, c.facilityId ?? null]);
}
const amount = (r: { type: AccountType; debit: number; credit: number }) => money(debitNormal(r.type) ? r.debit - r.credit : r.credit - r.debit);

// ---- Profit and loss -------------------------------------------------------------------------------------------------

export type Compare = 'none' | 'prior_period' | 'prior_year';
export type SplitBy = 'none' | 'month' | 'site';

export async function incomeStatement(tx: Tx, actor: Actor, q: { from: string; to: string; compare?: Compare; by?: SplitBy; facilityId?: string | null }) {
  view(actor);
  if (q.to < q.from) throw invalid('the end date is before the start date');
  const compare = q.compare ?? 'none'; const by = q.by ?? 'none';
  if (by !== 'none' && compare !== 'none') throw invalid('choose either a comparison or a split, not both');
  const fac = q.facilityId ?? null;
  const cols: Col[] = [];
  if (by === 'month') {
    let s = q.from;
    while (s <= q.to && cols.length < 36) {
      const e = endOfMonth(s) < q.to ? endOfMonth(s) : q.to;
      cols.push({ key: s.slice(0, 7), label: `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`, from: s, to: e, facilityId: fac });
      s = addDays(endOfMonth(s), 1);
    }
  } else if (by === 'site') {
    const sites = await many(tx, 'SELECT id, code FROM facility ORDER BY code');
    for (const f of sites) cols.push({ key: f.id, label: f.code, from: q.from, to: q.to, facilityId: f.id });
    cols.push({ key: 'unassigned', label: 'No site', from: q.from, to: q.to });
  } else {
    cols.push({ key: 'current', label: 'This period', from: q.from, to: q.to, facilityId: fac });
    if (compare === 'prior_period') { const n = days(q.from, q.to); cols.push({ key: 'prior', label: 'Prior period', from: addDays(q.from, -n), to: addDays(q.from, -1), facilityId: fac }); }
    if (compare === 'prior_year') cols.push({ key: 'prior', label: 'Same period last year', from: addMonths(q.from, -12), to: addMonths(q.to, -12), facilityId: fac });
  }
  const data: AccountSums[][] = [];
  for (const c of cols) {
    if (by === 'site' && c.key === 'unassigned') {
      // Lines posted with no site: the company total less every named site.
      const total = await sums(tx, { from: q.from, to: q.to });
      data.push(total.map((t) => ({ ...t, debit: t.debit - data.reduce((s, col) => s + (col.find((x) => x.id === t.id)?.debit ?? 0), 0), credit: t.credit - data.reduce((s, col) => s + (col.find((x) => x.id === t.id)?.credit ?? 0), 0) })));
    } else data.push(await sums(tx, c));
  }
  const accounts = data[0]!.filter((a) => ['income', 'expense'].includes(a.type));
  const SEC: [string, (s: string) => boolean][] = [['Income', (s) => s === 'income'], ['Cost of goods sold', (s) => s === 'cost_of_goods'], ['Expenses', (s) => s === 'expense'], ['Other income', (s) => s === 'other_income'], ['Other expenses', (s) => s === 'other_expense']];
  const at = (i: number, id: string) => { const r = data[i]!.find((x) => x.id === id); return r ? amount(r) : 0; };
  const sections = SEC.map(([name, test]) => {
    const rows = accounts.filter((a) => test(a.subtype)).map((a) => ({ id: a.id, code: a.code, name: a.name, amounts: cols.map((_, i) => at(i, a.id)) })).filter((r) => r.amounts.some((v) => v !== 0));
    return { name, accounts: rows, totals: cols.map((_, i) => money(rows.reduce((s, r) => s + r.amounts[i]!, 0))) };
  });
  const t = (name: string) => sections.find((s) => s.name === name)!.totals;
  const gross = cols.map((_, i) => money(t('Income')[i]! - t('Cost of goods sold')[i]!));
  const operating = cols.map((_, i) => money(gross[i]! - t('Expenses')[i]!));
  const net = cols.map((_, i) => money(operating[i]! + t('Other income')[i]! - t('Other expenses')[i]!));
  const sumCols = (xs: number[]) => money(xs.reduce((s, v) => s + v, 0));
  return {
    from: q.from, to: q.to, compare, by, columns: cols.map((c) => ({ key: c.key, label: c.label, from: c.from, to: c.to })), sections,
    grossProfit: gross, operatingIncome: operating, netIncome: net, income: t('Income'),
    totalColumn: by === 'none' ? null : { grossProfit: sumCols(gross), operatingIncome: sumCols(operating), netIncome: sumCols(net), sections: sections.map((s) => ({ name: s.name, total: sumCols(s.totals) })) },
    variance: compare !== 'none' ? { netIncome: money(net[0]! - net[1]!), netIncomePct: net[1] ? money(((net[0]! - net[1]!) / Math.abs(net[1]!)) * 100) : null, income: money(t('Income')[0]! - t('Income')[1]!) } : null,
  };
}

// ---- Balance sheet ---------------------------------------------------------------------------------------------------

export type BsCompare = 'none' | 'prior_month' | 'prior_year';
export async function balanceSheetCompare(tx: Tx, actor: Actor, q: { asOf: string; compare?: BsCompare; facilityId?: string | null }) {
  view(actor);
  const compare = q.compare ?? 'none'; const fac = q.facilityId ?? null;
  const dates = [{ key: 'current', label: q.asOf, asOf: q.asOf }];
  if (compare === 'prior_month') {
    const eom = q.asOf === endOfMonth(q.asOf);
    const d = eom ? endOfMonth(addMonths(`${q.asOf.slice(0, 7)}-01`, -1)) : addMonths(q.asOf, -1);
    dates.push({ key: 'prior', label: d, asOf: d });
  }
  if (compare === 'prior_year') { const d = addMonths(q.asOf, -12); dates.push({ key: 'prior', label: d, asOf: d }); }
  const ni = (rs: AccountSums[]) => money(rs.filter((r) => ['income', 'expense'].includes(r.type)).reduce((s, r) => s + (r.type === 'income' ? r.credit - r.debit : -(r.debit - r.credit)), 0));
  const cols = [] as { asOf: string; rows: AccountSums[]; retained: number; current: number }[];
  for (const d of dates) {
    const rows = await sums(tx, { from: null, to: d.asOf, facilityId: fac });
    const fy = await fiscalYearStart(tx, d.asOf);
    const retained = ni(await sums(tx, { from: null, to: addDays(fy, -1), facilityId: fac }));
    const current = ni(await sums(tx, { from: fy, to: d.asOf, facilityId: fac }));
    cols.push({ asOf: d.asOf, rows, retained, current });
  }
  const group = (type: AccountType) => cols[0]!.rows.filter((a) => a.type === type).map((a) => ({ id: a.id, code: a.code, name: a.name, subtype: a.subtype,
    amounts: cols.map((c) => amount(c.rows.find((x) => x.id === a.id)!)) })).filter((r) => r.amounts.some((v) => v !== 0));
  const assets = group('asset'), liabilities = group('liability'), equity = group('equity');
  equity.push({ id: 'retained', code: '', name: 'Retained earnings (earlier years)', subtype: 'retained_earnings', amounts: cols.map((c) => c.retained) });
  equity.push({ id: 'current', code: '', name: 'Net income this year', subtype: 'current_earnings', amounts: cols.map((c) => c.current) });
  const sum = (xs: { amounts: number[] }[]) => cols.map((_, i) => money(xs.reduce((s, x) => s + x.amounts[i]!, 0)));
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities), totalEquity = sum(equity);
  return {
    columns: dates.map((d) => ({ key: d.key, label: d.label, asOf: d.asOf })), assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity,
    balanced: cols.map((_, i) => totalAssets[i] === money(totalLiabilities[i]! + totalEquity[i]!)),
    siteNote: fac ? 'Only journal lines posted to this site are included; lines with no site (for example bank and tax accounts) are not, so a single-site balance sheet will not balance.' : null,
  };
}

// ---- Cash flow (indirect) --------------------------------------------------------------------------------------------

export async function cashFlow(tx: Tx, actor: Actor, q: { from: string; to: string; facilityId?: string | null }) {
  view(actor);
  if (q.to < q.from) throw invalid('the end date is before the start date');
  const fac = q.facilityId ?? null;
  const start = await sums(tx, { from: null, to: addDays(q.from, -1), facilityId: fac });
  const end = await sums(tx, { from: null, to: q.to, facilityId: fac });
  const period = await sums(tx, { from: q.from, to: q.to, facilityId: fac });
  const bal = (rs: AccountSums[], id: string) => amount(rs.find((x) => x.id === id)!);
  const delta = (id: string) => money(bal(end, id) - bal(start, id));
  const netIncome = money(period.filter((r) => ['income', 'expense'].includes(r.type)).reduce((s, r) => s + (r.type === 'income' ? r.credit - r.debit : -(r.debit - r.credit)), 0));
  type Line = { label: string; amount: number };
  const operating: Line[] = []; const investing: Line[] = []; const financing: Line[] = [];
  const classify = (r: AccountSums): 'cash' | 'operating' | 'noncash' | 'investing' | 'financing' | 'result' => {
    if (['income', 'expense'].includes(r.type)) return 'result';
    if (r.subtype === 'bank') return 'cash';
    if (r.type === 'asset') return r.subtype === 'fixed_asset' ? (/accumulated|depreciation/i.test(r.name) ? 'noncash' : 'investing') : 'operating';
    if (r.type === 'liability') return r.subtype === 'long_term_liability' ? 'financing' : 'operating';
    return 'financing';
  };
  for (const r of end) {
    const k = classify(r); if (k === 'result' || k === 'cash') continue;
    const d = delta(r.id); const e = r.type === 'asset' ? money(-d) : d; if (e === 0) continue;
    const label = k === 'noncash' ? `${r.name} (non-cash)` : r.type === 'asset' ? `${e < 0 ? 'Increase' : 'Decrease'} in ${r.name.toLowerCase()}` : r.type === 'liability' ? `${e > 0 ? 'Increase' : 'Decrease'} in ${r.name.toLowerCase()}` : `Change in ${r.name.toLowerCase()}`;
    (k === 'investing' ? investing : k === 'financing' ? financing : operating).push({ label, amount: e });
  }
  const sum = (xs: Line[]) => money(xs.reduce((s, l) => s + l.amount, 0));
  const operatingTotal = money(netIncome + sum(operating)); const investingTotal = sum(investing); const financingTotal = sum(financing);
  const netChange = money(operatingTotal + investingTotal + financingTotal);
  const banks = end.filter((r) => r.subtype === 'bank');
  const cashStart = money(banks.reduce((s, r) => s + bal(start, r.id), 0)); const cashEnd = money(banks.reduce((s, r) => s + bal(end, r.id), 0));
  return {
    from: q.from, to: q.to, netIncome, operating, operatingTotal, investing, investingTotal, financing, financingTotal, netChange, cashStart, cashEnd,
    ties: money(cashStart + netChange) === cashEnd, difference: money(cashEnd - cashStart - netChange),
    notes: ['Indirect method: starts from net income and adjusts for the change in every other account.', 'Accumulated depreciation is recognized by its name; other fixed-asset changes are shown as investing, long-term liabilities and equity as financing.',
      ...(fac ? ['One site only: lines with no site (such as bank accounts) are excluded, so a single-site statement will not tie.'] : [])],
  };
}
