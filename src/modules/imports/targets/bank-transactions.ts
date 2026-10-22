import { many, one } from '../../../platform/db/tx.js';
import { addBankLine } from '../../books/service.js';
import type { TargetDefinition } from './types.js';

/**
 * Bank and card statement lines (D-136), in each bank's own CSV layout: a signed amount, or separate money-in and
 * money-out columns (debit/credit, withdrawal/deposit). Lines land unreviewed in the books' banking queue with the
 * suggestion of any matching rule. A line's key is the bank's transaction id when the file has one, otherwise its
 * date, amount, description and position among identical lines, so importing the same statement twice adds nothing.
 */
export const bankTransactionsTarget: TargetDefinition = {
  key: 'bank_transactions',
  label: 'Bank and card transactions',
  entityType: 'bank_txn',
  description: 'Statement lines from your bank or card export, into the books\' banking queue to match or categorize.',
  naturalKey: 'transaction_id',
  commitPermission: 'books.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'account', label: 'Bank account', type: 'string', description: 'Account code, name or last four digits; the default bank account when blank',
      synonyms: ['account', 'account number', 'bank account', 'card', 'card number', 'account name'] },
    { key: 'posted_on', label: 'Date', type: 'date', required: true, synonyms: ['date', 'posting date', 'posted date', 'transaction date', 'trans date', 'value date'] },
    { key: 'description', label: 'Description', type: 'string', required: true, synonyms: ['description', 'details', 'payee', 'memo', 'narrative', 'name', 'merchant'] },
    { key: 'amount', label: 'Amount (signed)', type: 'number', description: 'Positive money in, negative money out', synonyms: ['amount', 'transaction amount', 'net amount'] },
    { key: 'money_in', label: 'Money in', type: 'number', min: 0, synonyms: ['deposit', 'deposits', 'credit', 'credits', 'money in', 'paid in'] },
    { key: 'money_out', label: 'Money out', type: 'number', synonyms: ['withdrawal', 'withdrawals', 'debit', 'debits', 'money out', 'paid out', 'payment'] },
    { key: 'reference', label: 'Check or reference', type: 'string', synonyms: ['check', 'check number', 'check or slip #', 'reference', 'ref', 'slip'] },
    { key: 'transaction_id', label: 'Bank transaction id', type: 'string', synonyms: ['transaction id', 'fitid', 'id', 'unique id', 'bank reference'] },
  ],
  async validate(ctx, rows) {
    const accounts = await many(ctx.tx, `SELECT id, lower(code) AS code, lower(name) AS name, bank_last4 FROM ledger_account WHERE subtype IN ('bank', 'credit_card') AND active`);
    const settings = await one(ctx.tx, 'SELECT default_bank_account_id FROM books_settings');
    if (!settings) for (const r of rows) r.messages.push({ level: 'error', message: 'set up the books first' });
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const key = v.account != null ? String(v.account).trim().toLowerCase() : '';
      const acct = key ? accounts.find((a) => a.code === key || a.name === key || (a.bank_last4 && key.endsWith(a.bank_last4))) : accounts.find((a) => a.id === settings?.default_bank_account_id);
      if (!acct) row.messages.push({ level: 'error', field: 'account', message: key ? `no bank or card account "${v.account}" in the books` : 'no default bank account in the books' });
      v._account_id = acct?.id;
      const out = v.money_out == null ? null : Math.abs(Number(v.money_out));
      const amount = v.amount != null ? Number(v.amount) : (Number(v.money_in ?? 0) || 0) - (out ?? 0);
      if (v.amount == null && v.money_in == null && v.money_out == null) row.messages.push({ level: 'error', field: 'amount', message: 'no amount: map a signed amount or money in and money out' });
      else if (!amount) row.messages.push({ level: 'warning', field: 'amount', message: 'zero amount; skipped' });
      v._amount = Math.round(amount * 100) / 100;
      const base = v.transaction_id ? `id:${v.transaction_id}` : `${v.posted_on}|${v._amount}|${String(v.description ?? '').trim().toLowerCase()}`;
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      v._ref = v.transaction_id ? base : `${base}|${n}`;
      if (acct && !row.messages.some((m) => m.level === 'error')) {
        row.action = (await one(ctx.tx, 'SELECT 1 FROM bank_txn WHERE bank_account_id = $1 AND source_system = $2 AND ref = $3', [acct.id, ctx.sourceSystem, v._ref])) ? 'unchanged' : 'create';
      }
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    if (!v._amount) return { entityId: '', action: 'unchanged' };
    const r = await addBankLine(ctx.tx, ctx.actor, { bankAccountId: v._account_id as string, postedOn: String(v.posted_on), description: String(v.description), amount: v._amount as number,
      reference: v.reference != null ? String(v.reference) : null, sourceSystem: ctx.sourceSystem, ref: String(v._ref) });
    return { entityId: r.id ?? '', action: r.created ? 'create' : 'unchanged' };
  },
};
