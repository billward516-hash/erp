import type { Actor } from '../../platform/auth/actor.js';
import { can, requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { toCsv } from '../reporting/render/csv.js';
import { type AccountType, DEFAULT_CHART, debitNormal } from './chart.js';
import { postEntry, reverseEntry } from './ledger.js';

/**
 * Built-in books (docs/ARCHITECTURE.md §12y, D-135 to D-138): setup, chart of accounts, manual entries, period lock,
 * statements, banking (statement lines matched or categorized, rules) and reconciliation. Operational events post
 * through the ledger adapter (ledger.ts); everything here reads or adds to the same journal.
 */
const money = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const view = (actor: Actor) => requirePermission(actor, 'books.view');
const manage = (actor: Actor) => requirePermission(actor, 'books.manage');

// ---------------------------------------------------------------------------
// Setup and accounts
// ---------------------------------------------------------------------------

export async function booksStatus(tx: Tx) {
  const s = await one(tx, 'SELECT * FROM books_settings');
  const conn = await one(tx, 'SELECT id, provider, label FROM integration_connection WHERE active');
  return { set_up: !!s, settings: s, connection: conn, active: conn?.provider === 'native_books' };
}

/**
 * Starts the books: the starter chart, settings, an opening balance for the main bank account (against owner's
 * equity), and the built-in books as the accounting connection (only when no other connection is active).
 */
export async function setupBooks(tx: Tx, actor: Actor, input: { startDate?: string; bankName?: string; bankLast4?: string | null; openingBalance?: number; fiscalYearStartMonth?: number; openItems?: boolean }) {
  manage(actor);
  if (await one(tx, 'SELECT 1 FROM books_settings')) throw conflict('the books are already set up');
  const other = await one(tx, `SELECT label FROM integration_connection WHERE active AND provider <> 'native_books'`);
  if (other) throw conflict(`"${other.label}" is the active accounting connection; disconnect it before using the built-in books`);
  for (const a of DEFAULT_CHART) {
    await tx.query(`INSERT INTO ledger_account (tenant_id, code, name, type, subtype, account_key, system) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actor.tenantId, a.code, a.code === '1000' && input.bankName ? input.bankName : a.name, a.type, a.subtype, a.key ?? null, a.system ?? false]);
  }
  const bank = await one(tx, `SELECT id FROM ledger_account WHERE code = '1000'`);
  if (input.bankLast4) await tx.query('UPDATE ledger_account SET bank_last4 = $2 WHERE id = $1', [bank.id, input.bankLast4]);
  const start = input.startDate ?? today();
  await tx.query(`INSERT INTO books_settings (tenant_id, fiscal_year_start_month, default_bank_account_id, started_on, updated_by) VALUES ($1, $2, $3, $4, $5)`,
    [actor.tenantId, input.fiscalYearStartMonth ?? 1, bank.id, start, actor.userId]);
  if (input.openingBalance) {
    const equity = await one(tx, `SELECT id FROM ledger_account WHERE account_key = 'opening_balance'`);
    const amt = money(input.openingBalance);
    await postEntry(tx, actor, { date: start, memo: 'Opening balance', source: 'opening', lines: amt > 0
      ? [{ accountId: bank.id, debit: amt }, { accountId: equity.id, credit: amt }] : [{ accountId: equity.id, debit: -amt }, { accountId: bank.id, credit: -amt }] });
  }
  if (!(await one(tx, `SELECT 1 FROM integration_connection WHERE active`))) {
    const last = Number((await one(tx, 'SELECT coalesce(max(id), 0) AS m FROM outbox_event')).m);
    await tx.query(`INSERT INTO integration_connection (tenant_id, provider, label, is_mock, created_by, starts_after_event) VALUES ($1, 'native_books', 'Built-in books', false, $2, $3)`,
      [actor.tenantId, actor.userId, last]);
  }
  const brought = input.openItems === false ? null : await bringInOpenItems(tx, actor);
  await audit(tx, actor, { action: 'books.set_up', entityType: 'books', entityId: actor.tenantId, data: { start, openingBalance: input.openingBalance ?? 0, openItems: brought } });
  return { ...(await booksStatus(tx)), openItems: brought };
}

/**
 * Opening receivables and payables (D-139): what is still owed on invoices, bills and expense reports recorded in the
 * platform before the books started. Each item posts what remains open against opening equity on the start date (or its own later date),
 * under the same key its own posting would have used, so a later payment settles it and a void reverses it. Running
 * this again adds nothing.
 */
export async function bringInOpenItems(tx: Tx, actor: Actor) {
  manage(actor);
  const s = await one(tx, 'SELECT started_on::text AS start FROM books_settings');
  if (!s) throw conflict('set up the books first');
  const keys = await many(tx, `SELECT id, account_key FROM ledger_account WHERE active AND account_key IN ('accounts_receivable', 'accounts_payable', 'employee_reimbursement', 'opening_balance')`);
  const acct = Object.fromEntries(keys.map((k) => [k.account_key, k.id as string]));
  const items = [
    ...(await many(tx, `SELECT 'invoice:' || i.id || ':issued' AS key, i.id, 'ar_invoice' AS source, 'accounts_receivable' AS control, 'Invoice ' || i.number AS label, c.name AS party, i.invoice_date::text AS item_on,
        ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_invoice_line l WHERE l.invoice_id = i.id) + i.freight_amount + i.tax_amount
          - (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.invoice_id = i.id))::float AS open
      FROM customer_invoice i JOIN customer c ON c.id = i.customer_id WHERE i.status IN ('issued', 'partially_paid')`)),
    // Credit a customer still holds (issued, not yet applied or refunded) lowers receivables.
    ...(await many(tx, `SELECT 'credit:' || m.id || ':issued' AS key, m.id, 'ar_credit_memo' AS source, 'accounts_receivable' AS control, 'Credit memo ' || m.number AS label, c.name AS party,
        m.memo_date::text AS item_on, ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM customer_credit_memo_line l WHERE l.memo_id = m.id) + m.tax_amount
          - (SELECT coalesce(sum(a.amount), 0) FROM payment_allocation a WHERE a.credit_memo_id = m.id)
          - (SELECT coalesce(sum(r.amount), 0) FROM customer_refund r WHERE r.credit_memo_id = m.id))::float AS open
      FROM customer_credit_memo m JOIN customer c ON c.id = m.customer_id WHERE m.status = 'issued'`)),
    ...(await many(tx, `SELECT 'bill:' || b.id || ':approved' AS key, b.id, 'ap_bill' AS source, 'accounts_payable' AS control, 'Bill ' || b.invoice_number AS label, s.name AS party, b.invoice_date::text AS item_on,
        ((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM supplier_invoice_line l WHERE l.invoice_id = b.id) + b.freight_amount + b.tax_amount)::float AS open
      FROM supplier_invoice b JOIN supplier s ON s.id = b.supplier_id WHERE b.status IN ('approved', 'exported')`)),
    ...(await many(tx, `SELECT 'expense:' || r.id || ':' || r.revision || ':approved' AS key, r.id, 'expense_report' AS source, 'employee_reimbursement' AS control,
        'Expense report ' || r.number AS label, u.display_name AS party, r.approved_at::date::text AS item_on, coalesce(r.approved_total, r.total)::float AS open
      FROM expense_report r JOIN app_user u ON u.id = r.user_id WHERE r.status = 'approved'`)),
  ];
  let posted = 0; let total = { receivable: 0, payable: 0, reimbursement: 0 };
  for (const it of items) {
    const amt = money(it.open);
    if (amt <= 0 || (await one(tx, 'SELECT 1 FROM journal_entry WHERE idempotency_key = $1', [it.key]))) continue;
    const control = acct[it.control]; const equity = acct.opening_balance;
    if (!control || !equity) throw invalid(`no account in the chart for ${!control ? it.control : 'opening_balance'}`);
    // Receivables are debits; credit held by a customer, payables and reimbursements are credits.
    const asset = it.control === 'accounts_receivable' && it.source !== 'ar_credit_memo';
    // An item dated after the start (recorded before the books were switched on) posts on its own date.
    const date = it.item_on && it.item_on > s.start ? it.item_on : s.start;
    await postEntry(tx, actor, { date, memo: `${date === s.start ? 'Opening balance' : 'Brought in'}: ${it.label} (${it.party})`, source: it.source, sourceId: it.id, idempotencyKey: it.key,
      lines: asset ? [{ accountId: control, debit: amt, party: it.party }, { accountId: equity, credit: amt }] : [{ accountId: equity, debit: amt }, { accountId: control, credit: amt, party: it.party }] });
    posted++;
    if (it.control === 'accounts_receivable') total.receivable += asset ? amt : -amt; else if (it.control === 'accounts_payable') total.payable += amt; else total.reimbursement += amt;
  }
  total = { receivable: money(total.receivable), payable: money(total.payable), reimbursement: money(total.reimbursement) };
  if (posted) await audit(tx, actor, { action: 'books.open_items', entityType: 'books', entityId: actor.tenantId, data: { posted, ...total } });
  return { posted, ...total };
}

/** Balances by account, for entries dated in [from, to] (from omitted: since the beginning). */
async function balances(tx: Tx, q: { from?: string | null; to: string }) {
  return many(tx, `SELECT a.id, a.code, a.name, a.type, a.subtype, a.active, a.system, a.account_key, a.bank_last4,
      coalesce(sum(l.debit), 0)::float AS debit, coalesce(sum(l.credit), 0)::float AS credit
    FROM ledger_account a LEFT JOIN journal_line l ON l.account_id = a.id
      AND l.entry_id IN (SELECT id FROM journal_entry e WHERE e.entry_date <= $2 AND ($1::date IS NULL OR e.entry_date >= $1))
    GROUP BY a.id ORDER BY a.code`, [q.from ?? null, q.to]);
}
const signed = (r: { type: AccountType; debit: number; credit: number }) => money(debitNormal(r.type) ? r.debit - r.credit : r.credit - r.debit);

export async function listAccounts(tx: Tx, actor: Actor) {
  view(actor);
  return (await balances(tx, { to: '9999-12-31' })).map((r) => ({ ...r, balance: signed(r) }));
}

/** The kinds of account each type can be. */
export const SUBTYPES: Record<AccountType, string[]> = {
  asset: ['bank', 'accounts_receivable', 'current_asset', 'inventory', 'fixed_asset'],
  liability: ['credit_card', 'accounts_payable', 'current_liability', 'long_term_liability'],
  equity: ['equity', 'retained_earnings'], income: ['income', 'other_income'], expense: ['cost_of_goods', 'expense', 'other_expense'],
};

export async function saveAccount(tx: Tx, actor: Actor, input: { id?: string; code: string; name: string; type: AccountType; subtype: string; active?: boolean; bankLast4?: string | null; description?: string | null }) {
  manage(actor);
  if (!SUBTYPES[input.type]?.includes(input.subtype)) throw invalid(`${/^[aeiou]/.test(input.type) ? 'an' : 'a'} ${input.type} account is one of: ${SUBTYPES[input.type]!.map((x) => x.replace(/_/g, ' ')).join(', ')}`);
  if (await one(tx, 'SELECT 1 FROM ledger_account WHERE lower(code) = lower($1) AND id IS DISTINCT FROM $2::uuid', [input.code.trim(), input.id ?? null])) throw conflict(`account ${input.code.trim()} already exists`);
  let id = input.id;
  if (input.id) {
    const a = await one(tx, 'SELECT * FROM ledger_account WHERE id = $1 FOR UPDATE', [input.id]);
    if (!a) throw notFound('account');
    if (a.system && (input.active === false || input.type !== a.type)) throw invalid(`${a.name} is a system account; it stays active and keeps its type`);
    const used = await one(tx, 'SELECT 1 FROM journal_line WHERE account_id = $1 LIMIT 1', [input.id]);
    if (used && input.type !== a.type) throw invalid('an account with entries keeps its type; create a new account and move the balance with an entry');
    await tx.query(`UPDATE ledger_account SET code = $2, name = $3, type = $4, subtype = $5, active = $6, bank_last4 = $7, description = $8 WHERE id = $1`,
      [input.id, input.code.trim(), input.name.trim(), input.type, input.subtype, input.active ?? true, input.bankLast4 ?? null, input.description ?? null]);
  } else {
    id = (await one(tx, `INSERT INTO ledger_account (tenant_id, code, name, type, subtype, bank_last4, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [actor.tenantId, input.code.trim(), input.name.trim(), input.type, input.subtype, input.bankLast4 ?? null, input.description ?? null])).id;
  }
  await audit(tx, actor, { action: 'books.account_saved', entityType: 'ledger_account', entityId: id!, data: input });
}

/** A manual journal entry (adjustments, owner contributions, loans, depreciation). */
export async function manualEntry(tx: Tx, actor: Actor, input: { date: string; memo: string; lines: { accountId: string; debit?: number; credit?: number; memo?: string | null; party?: string | null }[] }) {
  manage(actor);
  if (!input.memo?.trim()) throw invalid('say what the entry is for');
  const accts = await many(tx, 'SELECT id, active FROM ledger_account WHERE id = ANY ($1)', [input.lines.map((l) => l.accountId)]);
  if (accts.length !== new Set(input.lines.map((l) => l.accountId)).size || accts.some((a) => !a.active)) throw invalid('use active accounts from the chart');
  const e = await postEntry(tx, actor, { date: input.date, memo: input.memo.trim(), source: 'manual', lines: input.lines });
  await audit(tx, actor, { action: 'books.entry_posted', entityType: 'journal_entry', entityId: e.id, data: { number: e.number, memo: input.memo } });
  return e;
}

export async function reverse(tx: Tx, actor: Actor, entryId: string, input: { date?: string } = {}) {
  manage(actor);
  const e = await one(tx, 'SELECT source, number FROM journal_entry WHERE id = $1', [entryId]);
  if (!e) throw notFound('journal entry');
  if (!['manual', 'bank', 'opening'].includes(e.source)) throw invalid(`${e.number} came from an invoice, bill or expense report; void or correct it there`);
  const r = await reverseEntry(tx, actor, entryId, { date: input.date });
  await tx.query(`UPDATE bank_txn SET status = 'unreviewed', journal_line_id = NULL, reviewed_by = NULL, reviewed_at = NULL
    WHERE journal_line_id IN (SELECT id FROM journal_line WHERE entry_id = $1)`, [entryId]);
  await audit(tx, actor, { action: 'books.entry_reversed', entityType: 'journal_entry', entityId: entryId, data: { reversal: r.number } });
  return r;
}

export async function listEntries(tx: Tx, actor: Actor, q: { from?: string; to?: string; accountId?: string; source?: string } = {}) {
  view(actor);
  const entries = await many(tx, `SELECT e.id, e.number, e.entry_date::text AS entry_date, e.memo, e.source, e.source_id, e.reverses_id, e.reversed_by_id, u.display_name AS posted_by_name,
      (SELECT sum(debit)::float FROM journal_line l WHERE l.entry_id = e.id) AS amount
    FROM journal_entry e JOIN app_user u ON u.id = e.posted_by
    WHERE ($1::date IS NULL OR e.entry_date >= $1) AND ($2::date IS NULL OR e.entry_date <= $2) AND ($3::text IS NULL OR e.source = $3)
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM journal_line l WHERE l.entry_id = e.id AND l.account_id = $4))
    ORDER BY e.entry_date DESC, e.number DESC LIMIT 500`, [q.from ?? null, q.to ?? null, q.source ?? null, q.accountId ?? null]);
  const lines = await many(tx, `SELECT l.entry_id, l.line_no, a.code, a.name, l.debit::float AS debit, l.credit::float AS credit, l.memo, l.party FROM journal_line l JOIN ledger_account a ON a.id = l.account_id
    WHERE l.entry_id = ANY ($1) ORDER BY l.line_no`, [entries.map((e) => e.id)]);
  return entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entry_id === e.id) }));
}

export async function saveSettings(tx: Tx, actor: Actor, input: { closedThrough?: string | null; defaultBankAccountId?: string | null; fiscalYearStartMonth?: number }) {
  manage(actor);
  const s = await one(tx, 'SELECT * FROM books_settings FOR UPDATE');
  if (!s) throw invalid('set up the books first');
  if (input.closedThrough && input.closedThrough > today()) throw invalid('the books cannot be closed through a future date');
  if (input.defaultBankAccountId && !(await one(tx, `SELECT 1 FROM ledger_account WHERE id = $1 AND subtype IN ('bank', 'credit_card') AND active`, [input.defaultBankAccountId]))) {
    throw invalid('the default payment account must be an active bank or card account');
  }
  await tx.query(`UPDATE books_settings SET closed_through = CASE WHEN $1 THEN $2::date ELSE closed_through END, default_bank_account_id = coalesce($3, default_bank_account_id),
    fiscal_year_start_month = coalesce($4, fiscal_year_start_month), updated_by = $5, updated_at = now()`,
  [input.closedThrough !== undefined, input.closedThrough ?? null, input.defaultBankAccountId ?? null, input.fiscalYearStartMonth ?? null, actor.userId]);
  await audit(tx, actor, { action: 'books.settings_saved', entityType: 'books', entityId: actor.tenantId, data: input });
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** First day of the fiscal year containing `date`. */
async function fiscalYearStart(tx: Tx, date: string) {
  const m = Number((await one(tx, 'SELECT fiscal_year_start_month AS m FROM books_settings'))?.m ?? 1);
  const y = Number(date.slice(0, 4)); const mo = Number(date.slice(5, 7));
  return `${mo >= m ? y : y - 1}-${String(m).padStart(2, '0')}-01`;
}

export async function trialBalance(tx: Tx, actor: Actor, asOf = today()) {
  view(actor);
  const rows = (await balances(tx, { to: asOf })).map((r) => {
    const net = money(r.debit - r.credit);
    return { id: r.id, code: r.code, name: r.name, type: r.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  }).filter((r) => r.debit || r.credit);
  const debit = money(rows.reduce((s, r) => s + r.debit, 0)); const credit = money(rows.reduce((s, r) => s + r.credit, 0));
  return { asOf, rows, debit, credit, balanced: debit === credit };
}

const SECTIONS: [string, (s: string) => boolean][] = [['Income', (s) => s === 'income'], ['Cost of goods sold', (s) => s === 'cost_of_goods'], ['Expenses', (s) => s === 'expense'],
  ['Other income', (s) => s === 'other_income'], ['Other expenses', (s) => s === 'other_expense']];

export async function profitAndLoss(tx: Tx, actor: Actor, q: { from: string; to: string }) {
  view(actor);
  const rows = (await balances(tx, q)).filter((r) => ['income', 'expense'].includes(r.type) && (r.debit || r.credit));
  const sections = SECTIONS.map(([name, test]) => {
    const accounts = rows.filter((r) => test(r.subtype)).map((r) => ({ id: r.id, code: r.code, name: r.name, amount: signed(r) }));
    return { name, accounts, total: money(accounts.reduce((s, a) => s + a.amount, 0)) };
  });
  const t = (n: string) => sections.find((s) => s.name === n)!.total;
  const gross = money(t('Income') - t('Cost of goods sold'));
  const operating = money(gross - t('Expenses'));
  const net = money(operating + t('Other income') - t('Other expenses'));
  return { from: q.from, to: q.to, sections, income: t('Income'), grossProfit: gross, operatingIncome: operating, netIncome: net };
}

/** Net income (income − expenses) for entries in [from, to]. */
async function netIncome(tx: Tx, from: string | null, to: string) {
  const rows = (await balances(tx, { from, to })).filter((r) => ['income', 'expense'].includes(r.type));
  return money(rows.reduce((s, r) => s + (r.type === 'income' ? r.credit - r.debit : -(r.debit - r.credit)), 0));
}

/** Assets = liabilities + equity, with retained earnings (before this fiscal year) and this year's net income. */
export async function balanceSheet(tx: Tx, actor: Actor, asOf = today()) {
  view(actor);
  const rows = (await balances(tx, { to: asOf })).filter((r) => ['asset', 'liability', 'equity'].includes(r.type) && (r.debit || r.credit));
  const fy = await fiscalYearStart(tx, asOf);
  const dayBefore = new Date(Date.parse(`${fy}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const retained = await netIncome(tx, null, dayBefore);
  const current = await netIncome(tx, fy, asOf);
  const group = (type: string) => rows.filter((r) => r.type === type).map((r) => ({ id: r.id, code: r.code, name: r.name, subtype: r.subtype, amount: signed(r) })).filter((a) => a.amount !== 0);
  const assets = group('asset'); const liabilities = group('liability'); const equity = group('equity');
  if (retained) equity.push({ id: 'retained', code: '', name: 'Retained earnings (earlier years)', subtype: 'retained_earnings', amount: retained });
  equity.push({ id: 'current', code: '', name: 'Net income this year', subtype: 'current_earnings', amount: current });
  const sum = (xs: { amount: number }[]) => money(xs.reduce((s, x) => s + x.amount, 0));
  const totalAssets = sum(assets); const totalLiabilities = sum(liabilities); const totalEquity = sum(equity);
  return { asOf, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === money(totalLiabilities + totalEquity) };
}

/** One account's lines with a running balance. */
export async function register(tx: Tx, actor: Actor, accountId: string, q: { from?: string; to?: string } = {}) {
  view(actor);
  const a = await one(tx, 'SELECT * FROM ledger_account WHERE id = $1', [accountId]);
  if (!a) throw notFound('account');
  const from = q.from ?? '1900-01-01'; const to = q.to ?? today();
  const open = await one(tx, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date < $2`, [accountId, from]);
  const sign = debitNormal(a.type) ? 1 : -1;
  let bal = money(sign * open.n);
  const lines = (await many(tx, `SELECT l.id, e.id AS entry_id, e.number, e.entry_date::text AS entry_date, e.memo AS entry_memo, e.source, l.memo, l.party, l.debit::float AS debit, l.credit::float AS credit,
      l.reconciliation_id IS NOT NULL AS cleared
    FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3 ORDER BY e.entry_date, e.number, l.line_no`, [accountId, from, to]))
    .map((l) => { bal = money(bal + sign * (l.debit - l.credit)); return { ...l, balance: bal }; });
  return { account: a, from, to, opening: money(sign * open.n), closing: bal, lines };
}

/** The whole journal as CSV, for moving to another accounting system or the accountant. */
export async function exportJournal(tx: Tx, actor: Actor, q: { from?: string; to?: string } = {}) {
  view(actor);
  const rows = await many(tx, `SELECT e.number, e.entry_date::text AS date, e.memo, e.source, l.line_no, a.code AS account, a.name AS account_name, l.debit::float AS debit, l.credit::float AS credit,
      l.party, l.memo AS line_memo FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN ledger_account a ON a.id = l.account_id
    WHERE ($1::date IS NULL OR e.entry_date >= $1) AND ($2::date IS NULL OR e.entry_date <= $2) ORDER BY e.entry_date, e.number, l.line_no`, [q.from ?? null, q.to ?? null]);
  const header = ['Entry', 'Date', 'Memo', 'Source', 'Line', 'Account', 'Account name', 'Debit', 'Credit', 'Name', 'Line memo'];
  return toCsv(header, rows.map((r) => ({ Entry: r.number, Date: r.date, Memo: r.memo, Source: r.source, Line: r.line_no, Account: r.account, 'Account name': r.account_name,
    Debit: r.debit || '', Credit: r.credit || '', Name: r.party ?? '', 'Line memo': r.line_memo ?? '' })));
}

/** Cash, receivables, payables, this month and year to date, bank lines to review: the books at a glance. */
export async function overview(tx: Tx, actor: Actor) {
  view(actor);
  const status = await booksStatus(tx);
  if (!status.set_up) return { ...status };
  const t = today();
  const accounts = await listAccounts(tx, actor);
  const fy = await fiscalYearStart(tx, t);
  const month = `${t.slice(0, 7)}-01`;
  const review = await one(tx, `SELECT count(*)::int AS n FROM bank_txn WHERE status = 'unreviewed'`);
  const dead = await one(tx, `SELECT count(*)::int AS n FROM sync_delivery d JOIN integration_connection c ON c.id = d.connection_id WHERE c.active AND c.provider = 'native_books' AND d.status = 'dead'`);
  return {
    ...status,
    bank: accounts.filter((a) => ['bank', 'credit_card'].includes(a.subtype) && a.active).map((a) => ({ id: a.id, name: a.name, code: a.code, last4: a.bank_last4, balance: a.balance, subtype: a.subtype })),
    receivable: accounts.find((a) => a.subtype === 'accounts_receivable')?.balance ?? 0,
    payable: accounts.find((a) => a.subtype === 'accounts_payable')?.balance ?? 0,
    month: await profitAndLoss(tx, actor, { from: month, to: t }), yearToDate: await profitAndLoss(tx, actor, { from: fy, to: t }),
    toReview: review.n, postingProblems: dead.n,
  };
}

// ---------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------

/** The best rule for a statement line (first by priority, then longest match). */
export function ruleFor(rules: { id: string; contains: string; direction: string; account_id: string; priority: number }[], description: string, amount: number) {
  const d = description.toLowerCase();
  return rules.filter((r) => d.includes(r.contains.toLowerCase()) && (r.direction === 'any' || (r.direction === 'in') === amount > 0))
    .sort((a, b) => a.priority - b.priority || b.contains.length - a.contains.length)[0] ?? null;
}

/** Posted bank-side lines a statement line could be: same account, same amount and direction, within a week, not yet matched. */
async function matchCandidates(tx: Tx, t: { bank_account_id: string; amount: number; posted_on: string }) {
  return many(tx, `SELECT l.id, e.number, e.entry_date::text AS entry_date, e.memo, l.party, abs(e.entry_date - $3::date) AS days
    FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
    WHERE l.account_id = $1 AND (CASE WHEN $2::numeric > 0 THEN l.debit = $2::numeric ELSE l.credit = -$2::numeric END) AND abs(e.entry_date - $3::date) <= 7
      AND e.reversed_by_id IS NULL AND e.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM bank_txn b WHERE b.journal_line_id = l.id)
    ORDER BY abs(e.entry_date - $3::date), e.number LIMIT 5`, [t.bank_account_id, t.amount, t.posted_on]);
}

/** Adds a statement line (import target), with the rule's suggested account; re-imports of the same line are ignored. */
export async function addBankLine(tx: Tx, actor: Actor, input: { bankAccountId: string; postedOn: string; description: string; amount: number; reference?: string | null; sourceSystem: string; ref: string }) {
  const rules = await many(tx, 'SELECT * FROM bank_rule');
  const rule = ruleFor(rules, input.description, input.amount);
  const r = await one(tx, `INSERT INTO bank_txn (tenant_id, bank_account_id, posted_on, description, amount, reference, source_system, ref, suggested_account_id, suggested_rule_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (tenant_id, bank_account_id, source_system, ref) DO NOTHING RETURNING id`,
  [actor.tenantId, input.bankAccountId, input.postedOn, input.description.trim(), money(input.amount), input.reference ?? null, input.sourceSystem, input.ref, rule?.account_id ?? null, rule?.id ?? null]);
  return r ? { id: r.id as string, created: true } : { id: null, created: false };
}

export async function reviewQueue(tx: Tx, actor: Actor, q: { bankAccountId?: string; status?: string } = {}) {
  view(actor);
  const rows = await many(tx, `SELECT t.id, t.bank_account_id, b.name AS bank_name, t.posted_on::text AS posted_on, t.description, t.amount::float AS amount, t.reference, t.status,
      t.suggested_account_id, sa.code AS suggested_code, sa.name AS suggested_name, t.exclude_reason, l.entry_id, e.number AS entry_number, ra.name AS posted_account
    FROM bank_txn t JOIN ledger_account b ON b.id = t.bank_account_id LEFT JOIN ledger_account sa ON sa.id = t.suggested_account_id
    LEFT JOIN journal_line l ON l.id = t.journal_line_id LEFT JOIN journal_entry e ON e.id = l.entry_id
    LEFT JOIN LATERAL (SELECT a.name FROM journal_line x JOIN ledger_account a ON a.id = x.account_id WHERE x.entry_id = l.entry_id AND x.id <> l.id LIMIT 1) ra ON true
    WHERE ($1::uuid IS NULL OR t.bank_account_id = $1) AND ($2::text IS NULL OR t.status = $2) ORDER BY t.posted_on DESC, t.created_at DESC LIMIT 500`, [q.bankAccountId ?? null, q.status ?? null]);
  for (const r of rows) if (r.status === 'unreviewed') r.matches = await matchCandidates(tx, { bank_account_id: r.bank_account_id, amount: r.amount, posted_on: r.posted_on });
  return rows;
}

async function lockTxn(tx: Tx, id: string) {
  const t = await one(tx, 'SELECT *, amount::float AS amount, posted_on::text AS posted_on FROM bank_txn WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('bank line');
  if (t.status !== 'unreviewed') throw conflict(`this line is already ${t.status}`);
  return t;
}

/** The statement line is an entry already in the books (a payment recorded from an invoice, bill or expense report). */
export async function matchBankLine(tx: Tx, actor: Actor, id: string, journalLineId: string) {
  manage(actor);
  const t = await lockTxn(tx, id);
  if (!(await matchCandidates(tx, t)).some((c) => c.id === journalLineId)) throw invalid('that entry is not a match for this line (account, amount and date within a week)');
  await tx.query(`UPDATE bank_txn SET status = 'matched', journal_line_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [id, journalLineId, actor.userId]);
  await audit(tx, actor, { action: 'books.bank_matched', entityType: 'bank_txn', entityId: id, data: { journalLineId } });
}

/** Posts the statement line to an account (money out: debit the account; money in: credit it), and optionally remembers a rule. */
export async function categorizeBankLine(tx: Tx, actor: Actor, id: string, input: { accountId: string; memo?: string | null; payee?: string | null; remember?: string | null }) {
  manage(actor);
  const t = await lockTxn(tx, id);
  const acct = await one(tx, 'SELECT id, active, subtype FROM ledger_account WHERE id = $1', [input.accountId]);
  if (!acct || !acct.active) throw invalid('choose an active account');
  if (acct.id === t.bank_account_id) throw invalid('choose the other side of the transaction, not the bank account itself');
  if (['accounts_receivable', 'accounts_payable'].includes(acct.subtype)) throw invalid('record customer payments and bill payments from the invoice or bill, then match this line');
  const amt = Math.abs(t.amount);
  const lines = t.amount > 0 ? [{ accountId: t.bank_account_id, debit: amt }, { accountId: acct.id, credit: amt }] : [{ accountId: acct.id, debit: amt }, { accountId: t.bank_account_id, credit: amt }];
  const e = await postEntry(tx, actor, { date: t.posted_on, memo: input.memo?.trim() || t.description, source: 'bank', sourceId: id,
    lines: lines.map((l) => ({ ...l, party: input.payee ?? null, memo: t.description })) });
  const bankLine = await one(tx, 'SELECT id FROM journal_line WHERE entry_id = $1 AND account_id = $2', [e.id, t.bank_account_id]);
  await tx.query(`UPDATE bank_txn SET status = 'categorized', journal_line_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [id, bankLine.id, actor.userId]);
  if (input.remember?.trim()) await saveRule(tx, actor, { contains: input.remember.trim(), direction: t.amount > 0 ? 'in' : 'out', accountId: acct.id, payee: input.payee ?? null });
  await audit(tx, actor, { action: 'books.bank_categorized', entityType: 'bank_txn', entityId: id, data: { entry: e.number, accountId: acct.id } });
  return e;
}

export async function excludeBankLine(tx: Tx, actor: Actor, id: string, reason: string) {
  manage(actor);
  await lockTxn(tx, id);
  if (!reason?.trim()) throw invalid('say why (duplicate, already recorded, not this business)');
  await tx.query(`UPDATE bank_txn SET status = 'excluded', exclude_reason = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [id, reason.trim(), actor.userId]);
}

export async function listRules(tx: Tx, actor: Actor) {
  view(actor);
  return many(tx, `SELECT r.id, r.contains, r.direction, r.account_id, a.code, a.name AS account_name, r.payee, r.priority FROM bank_rule r JOIN ledger_account a ON a.id = r.account_id ORDER BY r.priority, r.contains`);
}

export async function saveRule(tx: Tx, actor: Actor, input: { id?: string; contains: string; direction?: 'in' | 'out' | 'any'; accountId: string; payee?: string | null; priority?: number }) {
  manage(actor);
  if ((input.contains?.trim().length ?? 0) < 2) throw invalid('a rule needs at least two characters to look for');
  const vals = [input.contains.trim(), input.direction ?? 'any', input.accountId, input.payee ?? null, input.priority ?? 100];
  const r = input.id ? await one(tx, 'UPDATE bank_rule SET contains = $2, direction = $3, account_id = $4, payee = $5, priority = $6 WHERE id = $1 RETURNING *', [input.id, ...vals])
    : await one(tx, 'INSERT INTO bank_rule (tenant_id, contains, direction, account_id, payee, priority, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [actor.tenantId, ...vals, actor.userId]);
  // New suggestions for lines still waiting.
  const rules = await many(tx, 'SELECT * FROM bank_rule');
  for (const t of await many(tx, `SELECT id, description, amount::float AS amount FROM bank_txn WHERE status = 'unreviewed'`)) {
    const best = ruleFor(rules, t.description, t.amount);
    await tx.query('UPDATE bank_txn SET suggested_account_id = $2, suggested_rule_id = $3 WHERE id = $1', [t.id, best?.account_id ?? null, best?.id ?? null]);
  }
  return r;
}

export async function deleteRule(tx: Tx, actor: Actor, id: string) {
  manage(actor);
  await tx.query('UPDATE bank_txn SET suggested_rule_id = NULL, suggested_account_id = NULL WHERE suggested_rule_id = $1 AND status = $2', [id, 'unreviewed']);
  await tx.query('UPDATE bank_txn SET suggested_rule_id = NULL WHERE suggested_rule_id = $1', [id]);
  await tx.query('DELETE FROM bank_rule WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export async function startReconciliation(tx: Tx, actor: Actor, input: { bankAccountId: string; statementDate: string; statementBalance: number }) {
  manage(actor);
  if (!(await one(tx, `SELECT 1 FROM ledger_account WHERE id = $1 AND subtype IN ('bank', 'credit_card')`, [input.bankAccountId]))) throw invalid('reconcile a bank or card account');
  const last = await one(tx, `SELECT max(statement_date)::text AS d FROM bank_reconciliation WHERE bank_account_id = $1 AND status = 'finished'`, [input.bankAccountId]);
  if (last?.d && input.statementDate <= last.d) throw invalid(`the last reconciliation ended on ${last.d}; use a later statement`);
  const r = await one(tx, `INSERT INTO bank_reconciliation (tenant_id, bank_account_id, statement_date, statement_balance, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [actor.tenantId, input.bankAccountId, input.statementDate, input.statementBalance, actor.userId]).catch((e) => {
    if (String(e.message).includes('bank_reconciliation_one_open')) throw conflict('a reconciliation is already open for this account; finish it first');
    throw e;
  });
  // Lines matched or categorized from statement lines up to the statement date start out cleared.
  await tx.query(`UPDATE journal_line l SET reconciliation_id = $2 FROM journal_entry e, bank_txn b
    WHERE e.id = l.entry_id AND b.journal_line_id = l.id AND l.account_id = $1 AND l.reconciliation_id IS NULL AND e.entry_date <= $3 AND b.posted_on <= $3`,
  [input.bankAccountId, r!.id, input.statementDate]);
  return r!;
}

export async function getReconciliation(tx: Tx, actor: Actor, id: string) {
  view(actor);
  const r = await one(tx, `SELECT r.*, r.statement_date::text AS statement_date, r.statement_balance::float AS statement_balance, a.name AS bank_name, a.code AS bank_code, a.type
    FROM bank_reconciliation r JOIN ledger_account a ON a.id = r.bank_account_id WHERE r.id = $1`, [id]);
  if (!r) throw notFound('reconciliation');
  const sign = debitNormal(r.type) ? 1 : -1;
  const opening = await one(tx, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS n FROM journal_line l JOIN bank_reconciliation x ON x.id = l.reconciliation_id
    WHERE l.account_id = $1 AND x.status = 'finished' AND x.id <> $2`, [r.bank_account_id, id]);
  const lines = await many(tx, `SELECT l.id, e.number, e.entry_date::text AS entry_date, coalesce(l.party, e.memo) AS description, l.debit::float AS debit, l.credit::float AS credit,
      (l.reconciliation_id = $2) AS cleared
    FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
    WHERE l.account_id = $1 AND e.entry_date <= $3 AND (l.reconciliation_id IS NULL OR l.reconciliation_id = $2) ORDER BY e.entry_date, e.number`, [r.bank_account_id, id, r.statement_date]);
  const cleared = money(sign * (opening.n + lines.filter((l) => l.cleared).reduce((s, l) => s + l.debit - l.credit, 0)));
  return { ...r, opening: money(sign * opening.n), cleared, difference: money(r.statement_balance - cleared), lines };
}

export async function setCleared(tx: Tx, actor: Actor, id: string, input: { lineIds: string[]; cleared: boolean }) {
  manage(actor);
  const r = await one(tx, 'SELECT * FROM bank_reconciliation WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw notFound('reconciliation');
  if (r.status !== 'open') throw conflict('this reconciliation is finished');
  await tx.query(`UPDATE journal_line SET reconciliation_id = $3 WHERE id = ANY ($1) AND account_id = $2 AND (reconciliation_id IS NULL OR reconciliation_id = $4)`,
    [input.lineIds, r.bank_account_id, input.cleared ? id : null, id]);
}

/** Finishing needs the cleared balance to equal the statement to the cent. */
export async function finishReconciliation(tx: Tx, actor: Actor, id: string) {
  manage(actor);
  const g = await getReconciliation(tx, actor, id);
  if (g.status !== 'open') throw conflict('this reconciliation is finished');
  if (g.difference !== 0) throw invalid(`the cleared balance (${g.cleared.toFixed(2)}) differs from the statement (${g.statement_balance.toFixed(2)}) by ${g.difference.toFixed(2)}`);
  await tx.query(`UPDATE bank_reconciliation SET status = 'finished', finished_by = $2, finished_at = now() WHERE id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'books.reconciled', entityType: 'bank_reconciliation', entityId: id, data: { statementDate: g.statement_date, balance: g.statement_balance } });
}

export async function listReconciliations(tx: Tx, actor: Actor) {
  view(actor);
  return many(tx, `SELECT r.id, r.statement_date::text AS statement_date, r.statement_balance::float AS statement_balance, r.status, r.finished_at, a.name AS bank_name
    FROM bank_reconciliation r JOIN ledger_account a ON a.id = r.bank_account_id ORDER BY r.statement_date DESC`);
}

export const canManageBooks = (actor: Actor) => can(actor, 'books.manage');
