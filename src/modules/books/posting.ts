import { billLines } from '../integrations/accounts.js';

/**
 * Posting rules (D-137): how each operational event becomes a balanced journal entry. Pure: lines name platform account
 * keys (or 'bank' for the payment's bank account); the ledger resolves them to accounts. Voids post the reversal of
 * the original entry, so they are handled by the ledger, not here.
 */
export interface PostLine { key: string; debit?: number; credit?: number; memo?: string; party?: string }
export interface Posting { source: string; date: string; memo: string; lines: PostLine[]; bankAccountId?: string | null }

const money = (n: number) => Math.round(n * 100) / 100;
const total = (ls: { amount: number }[]) => money(ls.reduce((s, l) => s + l.amount, 0));

export function postingFor(topic: string, p: any): Posting | null {
  switch (topic) {
    case 'ar.invoice.issued': {
      const lines = billLines(p, 'ar');
      const t = total(lines);
      return { source: 'ar_invoice', date: p.invoiceDate, memo: `Invoice ${p.invoiceNumber}: ${p.customer.name}`,
        lines: [{ key: 'accounts_receivable', debit: t, party: p.customer.name, memo: `Invoice ${p.invoiceNumber}` },
          ...lines.map((l) => ({ key: l.accountKey, credit: money(l.amount), memo: l.description, party: p.customer.name }))] };
    }
    case 'ap.bill.approved': {
      const lines = billLines(p, 'ap');
      const t = total(lines);
      return { source: 'ap_bill', date: p.invoiceDate, memo: `Bill ${p.invoiceNumber}: ${p.supplier.name}`,
        lines: [...lines.map((l) => ({ key: l.accountKey, debit: money(l.amount), memo: l.description, party: p.supplier.name })),
          { key: 'accounts_payable', credit: t, party: p.supplier.name, memo: `Bill ${p.invoiceNumber}` }] };
    }
    case 'ar.credit_memo.issued': {
      // The mirror of an invoice (D-146): income (and sales tax) back, receivables down.
      const lines = billLines(p, 'ar');
      const t = total(lines);
      return { source: 'ar_credit_memo', date: p.invoiceDate, memo: `Credit memo ${p.invoiceNumber}: ${p.customer.name}${p.appliesTo ? ` (invoice ${p.appliesTo})` : ''}`,
        lines: [...lines.map((l) => ({ key: l.accountKey, debit: money(l.amount), memo: l.description, party: p.customer.name })),
          { key: 'accounts_receivable', credit: t, party: p.customer.name, memo: `Credit memo ${p.invoiceNumber}` }] };
    }
    case 'ar.refund.paid':
      return { source: 'ar_refund', date: p.paidOn, memo: `Refund to ${p.customer.name} of credit ${p.creditMemoNumber}`, bankAccountId: p.bankAccountId ?? null,
        lines: [{ key: 'accounts_receivable', debit: money(p.amount), party: p.customer.name }, { key: 'bank', credit: money(p.amount), party: p.customer.name }] };
    case 'expense.report.approved': {
      const t = total(p.lines);
      return { source: 'expense_report', date: p.invoiceDate, memo: `Expense report ${p.invoiceNumber}: ${p.supplier.name}`,
        lines: [...p.lines.map((l: any) => ({ key: l.accountKey, debit: money(l.amount), memo: l.description, party: p.supplier.name })),
          { key: 'employee_reimbursement', credit: t, party: p.supplier.name, memo: `Expense report ${p.invoiceNumber}` }] };
    }
    case 'expense.report.paid':
      return { source: 'expense_payment', date: p.paidOn, memo: `Reimbursed ${p.invoiceNumber}: ${p.supplier.name}`, bankAccountId: p.bankAccountId ?? null,
        lines: [{ key: 'employee_reimbursement', debit: money(p.total), party: p.supplier.name }, { key: 'bank', credit: money(p.total), party: p.supplier.name }] };
    case 'ar.payment.received':
      return { source: 'ar_payment', date: p.receivedOn, memo: `Payment from ${p.customer.name}${p.reference ? ` (${p.reference})` : ''}`, bankAccountId: p.bankAccountId ?? null,
        lines: [{ key: 'bank', debit: money(p.amount), party: p.customer.name }, { key: 'accounts_receivable', credit: money(p.amount), party: p.customer.name }] };
    case 'ap.bill.paid':
      return { source: 'ap_payment', date: p.paidOn, memo: `Payment of bill ${p.invoiceNumber}: ${p.supplier.name}`, bankAccountId: p.bankAccountId ?? null,
        lines: [{ key: 'accounts_payable', debit: money(p.amount), party: p.supplier.name }, { key: 'bank', credit: money(p.amount), party: p.supplier.name }] };
    default:
      return null;
  }
}

/** Topics whose posting is the reversal of an earlier posting (the original's idempotency key). */
export const REVERSALS: Record<string, (p: any, aggregateId: string) => string> = {
  'ar.invoice.voided': (_p, id) => `invoice:${id}:issued`,
  'ap.bill.voided': (_p, id) => `bill:${id}:approved`,
  'ar.credit_memo.voided': (_p, id) => `credit:${id}:issued`,
};
