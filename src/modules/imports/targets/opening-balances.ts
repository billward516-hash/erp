import { many, one } from '../../../platform/db/tx.js';
import { postEntry, reverseEntry } from '../../books/ledger.js';
import type { TargetDefinition } from './types.js';

const CONTROL = new Set(['accounts_receivable', 'accounts_payable', 'employee_reimbursement']);
const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const money = (n: number) => Math.round(n * 100) / 100;
/** A new account's subtype from its type (the chart's general subtypes). */
const SUBTYPE: Record<string, string> = { asset: 'current_asset', liability: 'current_liability', equity: 'equity', income: 'income', expense: 'expense' };

/**
 * Opening balances from the previous accounting system (D-139): its trial balance, in its own layout (debit and credit
 * columns, or one signed balance with debits positive). Each account posts against opening equity on the as-of date,
 * normally the day before the books start. Receivables, payables and employee reimbursements are refused: they come
 * from the open invoices, bills and expense reports recorded in the platform, so the ledger and the lists agree.
 * Importing the same file again changes nothing; a changed amount reverses the earlier opening entry and posts the new one.
 */
export const openingBalancesTarget: TargetDefinition = {
  key: 'opening_balances',
  label: 'Opening balances (trial balance)',
  entityType: 'journal_entry',
  description: 'The previous accounting system\'s trial balance, as opening balances in the built-in books.',
  naturalKey: 'account',
  commitPermission: 'books.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'account', label: 'Account', type: 'string', required: true, description: 'Account number or name; "1000 · Checking" style labels are matched by either part',
      synonyms: ['account', 'account number', 'account no', 'gl account', 'acct', 'account code', 'number'] },
    { key: 'account_name', label: 'Account name', type: 'string', description: 'Used to create an account the chart does not have (with a type)', synonyms: ['account name', 'name', 'description', 'account description'] },
    { key: 'type', label: 'Account type', type: 'enum', values: TYPES, description: 'Needed only to create a missing account',
      valueSynonyms: { asset: ['assets', 'bank', 'other current asset', 'fixed asset', 'current asset', 'other asset', 'accounts receivable'],
        liability: ['liabilities', 'credit card', 'other current liability', 'long term liability', 'accounts payable'],
        equity: ['equity', 'capital'], income: ['income', 'revenue', 'other income', 'sales'], expense: ['expense', 'expenses', 'cost of goods sold', 'cogs', 'other expense'] },
      synonyms: ['type', 'account type', 'class'] },
    { key: 'debit', label: 'Debit', type: 'number', min: 0, synonyms: ['debit', 'debits', 'dr'] },
    { key: 'credit', label: 'Credit', type: 'number', min: 0, synonyms: ['credit', 'credits', 'cr'] },
    { key: 'balance', label: 'Balance (debits positive)', type: 'number', synonyms: ['balance', 'net', 'amount', 'ending balance'] },
    { key: 'as_of', label: 'As of', type: 'date', description: 'Defaults to the day before the books start', synonyms: ['as of', 'date', 'balance date', 'period end'] },
  ],
  async validate(ctx, rows) {
    const s = await one(ctx.tx, `SELECT (started_on - 1)::text AS as_of, closed_through::text AS closed FROM books_settings`);
    const accounts = await many(ctx.tx, 'SELECT id, code, lower(name) AS name, account_key, subtype FROM ledger_account');
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      if (!s) { row.messages.push({ level: 'error', message: 'set up the books first' }); continue; }
      const raw = String(v.account ?? '').trim();
      // QuickBooks prints "1000 · Checking"; Sage and others print "1000 - Checking" or separate columns.
      const [codePart, ...rest] = raw.split(/\s+[·\-–:]\s+/);
      const keys = [raw.toLowerCase(), codePart!.toLowerCase(), rest.join(' ').toLowerCase()].filter(Boolean);
      let acct = accounts.find((a) => keys.includes(a.code.toLowerCase())) ?? accounts.find((a) => keys.includes(a.name));
      if (/^total\b/i.test(raw)) { row.messages.push({ level: 'warning', field: 'account', message: 'a total line; skipped' }); v._skip = true; continue; }
      if (!acct) {
        if (!v.type) { row.messages.push({ level: 'error', field: 'account', message: `no account "${raw}" in the chart; add it, or give an account type to create it` }); continue; }
        v._create = { code: codePart, name: String(v.account_name ?? (rest.join(' ') || raw)), type: v.type };
      } else if (CONTROL.has(acct.account_key ?? '') || CONTROL.has(acct.subtype)) {
        row.messages.push({ level: 'error', field: 'account', message: `${acct.code} is a control account: its opening balance comes from the open invoices, bills and expense reports in the platform (Books → Bring in open items)` });
        continue;
      } else if (acct.account_key === 'opening_balance') {
        row.messages.push({ level: 'warning', field: 'account', message: 'opening equity balances the other lines; skipped' }); v._skip = true; continue;
      }
      const amount = v.debit != null || v.credit != null ? money(Number(v.debit ?? 0) - Number(v.credit ?? 0)) : v.balance != null ? money(Number(v.balance)) : null;
      if (amount == null) { row.messages.push({ level: 'error', field: 'debit', message: 'no amount: map debit and credit, or a signed balance' }); continue; }
      if (!amount) { row.messages.push({ level: 'warning', field: 'debit', message: 'zero balance; skipped' }); v._skip = true; continue; }
      v._amount = amount;
      v._as_of = v.as_of ? String(v.as_of) : s.as_of;
      if (s.closed && String(v._as_of) <= s.closed) row.messages.push({ level: 'error', field: 'as_of', message: `the books are closed through ${s.closed}` });
      const id = acct?.id ?? `new:${codePart}`;
      if (seen.has(`${id}|${v._as_of}`)) row.messages.push({ level: 'error', field: 'account', message: 'the same account appears twice for this date' });
      seen.add(`${id}|${v._as_of}`);
      v._account_id = acct?.id ?? null;
      if (acct && (await one(ctx.tx, `SELECT 1 FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.source = 'opening' AND e.source_id IS NULL`, [acct.id]))) {
        row.messages.push({ level: 'warning', field: 'account', message: `${acct.code} already has the opening balance typed at setup; this adds to it` });
      }
      if (acct && !row.messages.some((m) => m.level === 'error')) {
        const prior = await priorEntry(ctx.tx, acct.id, String(v._as_of));
        row.action = !prior ? 'create' : prior.amount === amount ? 'unchanged' : 'update';
      } else if (!acct) row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    if (v._skip) return { entityId: '', action: 'unchanged' };
    let accountId = v._account_id as string | null;
    if (!accountId) {
      const c = v._create as { code: string; name: string; type: string };
      accountId = (await one(ctx.tx, `INSERT INTO ledger_account (tenant_id, code, name, type, subtype) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [ctx.actor.tenantId, c.code, c.name, c.type, SUBTYPE[c.type]])).id;
    }
    const asOf = String(v._as_of); const amount = v._amount as number;
    const prior = await priorEntry(ctx.tx, accountId!, asOf);
    if (prior && prior.amount === amount) return { entityId: prior.id, action: 'unchanged' };
    if (prior) await reverseEntry(ctx.tx, ctx.actor, prior.id, { date: asOf, memo: `Replaced opening balance (${ctx.sourceSystem})` });
    const equity = (await one(ctx.tx, `SELECT id FROM ledger_account WHERE account_key = 'opening_balance'`)).id;
    const e = await postEntry(ctx.tx, ctx.actor, { date: asOf, memo: `Opening balance from ${ctx.sourceSystem}`, source: 'opening', sourceId: accountId,
      lines: amount > 0 ? [{ accountId: accountId!, debit: amount }, { accountId: equity, credit: amount }] : [{ accountId: equity, debit: -amount }, { accountId: accountId!, credit: -amount }] });
    return { entityId: e.id, action: prior ? 'update' : 'create' };
  },
};

/** The account's current (not reversed) imported opening entry for a date, with its signed amount on the account. */
async function priorEntry(tx: import('../../../platform/db/tx.js').Tx, accountId: string, asOf: string) {
  const r = await one(tx, `SELECT e.id, (l.debit - l.credit)::float AS amount FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id AND l.account_id = $1
    WHERE e.source = 'opening' AND e.source_id = $1 AND e.entry_date = $2 AND e.reversed_by_id IS NULL ORDER BY e.created_at DESC LIMIT 1`, [accountId, asOf]);
  return r ? { id: r.id as string, amount: money(r.amount) } : null;
}
