import { z } from 'zod';
import { balanceSheet, profitAndLoss } from '../books/service.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

/** Profit and loss from the built-in books (D-136): net income first, then the sections. */
export const profitAndLossReport: ReportDefinition = {
  id: 'profit-and-loss',
  name: 'Profit and loss',
  description: 'Income, cost of goods sold, expenses and net income from the built-in books for a period.',
  permission: 'books.view',
  params: z.object({ from: z.string().date().optional(), to: z.string().date().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const to = params.to ?? today(); const from = params.from ?? `${to.slice(0, 4)}-01-01`;
    const p = await profitAndLoss(tx, actor, { from, to });
    const rows = p.sections.flatMap((s) => [...s.accounts.map((a) => ({ section: s.name, account: `${a.code} ${a.name}`, amount: a.amount })), ...(s.accounts.length ? [{ section: s.name, account: `Total ${s.name.toLowerCase()}`, amount: s.total }] : [])]);
    const margin = p.income ? Math.round((p.netIncome / p.income) * 1000) / 10 : null;
    const top = p.sections.find((s) => s.name === 'Expenses')!.accounts.slice().sort((a, b) => b.amount - a.amount)[0];
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from, to }, scope: { facilities: [], description: 'The company' }, filters: { from, to },
      headline: `Net ${p.netIncome >= 0 ? 'income' : 'loss'} ${money(Math.abs(p.netIncome))} on ${money(p.income)} of income${margin != null ? ` (${margin}% margin)` : ''}`,
      kpis: [{ label: 'Income', value: p.income, type: 'currency', status: 'neutral' }, { label: 'Gross profit', value: p.grossProfit, type: 'currency', status: p.grossProfit >= 0 ? 'good' : 'bad' },
        { label: 'Net income', value: p.netIncome, type: 'currency', status: p.netIncome >= 0 ? 'good' : 'bad' }],
      insights: top ? [`Largest expense: ${top.name} (${money(top.amount)}).`] : [],
      columns: [{ key: 'section', label: 'Section', type: 'text', width: 1 }, { key: 'account', label: 'Account', type: 'text', width: 2 }, { key: 'amount', label: 'Amount', type: 'currency', width: 1 }],
      rows, exceptions: [], notes: ['Accrual basis: invoices count when issued, bills when approved, expense reports when approved.'], source: 'Built-in books (journal)',
    } as ReportResult;
  },
};

export const balanceSheetReport: ReportDefinition = {
  id: 'balance-sheet',
  name: 'Balance sheet',
  description: 'Assets, liabilities and equity from the built-in books as of a date, with this year\'s net income.',
  permission: 'books.view',
  params: z.object({ asOf: z.string().date().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const b = await balanceSheet(tx, actor, params.asOf ?? today());
    const rows = [...b.assets.map((a) => ({ section: 'Assets', account: `${a.code} ${a.name}`.trim(), amount: a.amount })), { section: 'Assets', account: 'Total assets', amount: b.totalAssets },
      ...b.liabilities.map((a) => ({ section: 'Liabilities', account: `${a.code} ${a.name}`.trim(), amount: a.amount })), { section: 'Liabilities', account: 'Total liabilities', amount: b.totalLiabilities },
      ...b.equity.map((a) => ({ section: 'Equity', account: `${a.code} ${a.name}`.trim(), amount: a.amount })), { section: 'Equity', account: 'Total equity', amount: b.totalEquity }];
    const cash = b.assets.filter((a) => a.subtype === 'bank').reduce((s, a) => s + a.amount, 0);
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from: b.asOf, to: b.asOf }, scope: { facilities: [], description: 'The company' }, filters: { asOf: b.asOf },
      headline: `${money(b.totalAssets)} of assets, ${money(b.totalLiabilities)} of liabilities and ${money(b.totalEquity)} of equity as of ${b.asOf}${b.balanced ? '' : ' (does not balance: check the journal)'}`,
      kpis: [{ label: 'Cash in bank', value: Math.round(cash * 100) / 100, type: 'currency', status: cash >= 0 ? 'good' : 'bad' }, { label: 'Total assets', value: b.totalAssets, type: 'currency', status: 'neutral' },
        { label: 'Total liabilities', value: b.totalLiabilities, type: 'currency', status: 'neutral' }, { label: 'Equity', value: b.totalEquity, type: 'currency', status: b.totalEquity >= 0 ? 'good' : 'bad' }],
      insights: [], columns: [{ key: 'section', label: 'Section', type: 'text', width: 1 }, { key: 'account', label: 'Account', type: 'text', width: 2 }, { key: 'amount', label: 'Amount', type: 'currency', width: 1 }],
      rows, exceptions: [], notes: ['Retained earnings are net income before this fiscal year; this year\'s net income is shown separately until the year closes.'], source: 'Built-in books (journal)',
    } as ReportResult;
  },
};
