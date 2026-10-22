import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, nextSequence, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import type { AccountingAdapter, DeliveryResult, OutboxEvent } from '../../platform/integration/adapter.js';
import { postingFor, REVERSALS } from './posting.js';

/**
 * The ledger (docs/ARCHITECTURE.md §12y, D-136, D-137). Entries are posted once (idempotency key), balance (checked at
 * commit by the database), never change (corrections are reversals) and never fall in a closed period.
 */
const money = (n: number) => Math.round(n * 100) / 100;

export interface EntryLine { accountId: string; debit?: number; credit?: number; memo?: string | null; party?: string | null; facilityId?: string | null }

export async function postEntry(tx: Tx, actor: Actor, e: { date: string; memo: string; source: string; sourceId?: string | null; idempotencyKey?: string | null;
  reversesId?: string | null; lines: EntryLine[] }) {
  if (e.idempotencyKey) {
    const prior = await one(tx, 'SELECT id, number FROM journal_entry WHERE idempotency_key = $1', [e.idempotencyKey]);
    if (prior) return prior as { id: string; number: string };
  }
  const lines = e.lines.map((l) => ({ ...l, debit: money(l.debit ?? 0), credit: money(l.credit ?? 0) })).filter((l) => l.debit > 0 || l.credit > 0);
  const d = money(lines.reduce((s, l) => s + l.debit, 0)); const c = money(lines.reduce((s, l) => s + l.credit, 0));
  if (lines.length < 2) throw invalid('an entry needs at least two lines with amounts');
  if (d !== c) throw invalid(`debits (${d.toFixed(2)}) and credits (${c.toFixed(2)}) must be equal`);
  if (lines.some((l) => l.debit > 0 && l.credit > 0)) throw invalid('a line is either a debit or a credit');
  const number = `JE-${String(await nextSequence(tx, actor.tenantId, 'journal')).padStart(6, '0')}`;
  const entry = await one(tx, `INSERT INTO journal_entry (tenant_id, number, entry_date, memo, source, source_id, idempotency_key, reverses_id, posted_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, number`,
  [actor.tenantId, number, e.date, e.memo, e.source, e.sourceId ?? null, e.idempotencyKey ?? null, e.reversesId ?? null, actor.userId]);
  for (const [i, l] of lines.entries()) {
    await tx.query(`INSERT INTO journal_line (tenant_id, entry_id, line_no, account_id, debit, credit, memo, party, facility_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [actor.tenantId, entry!.id, i + 1, l.accountId, l.debit, l.credit, l.memo ?? null, l.party ?? null, l.facilityId ?? null]);
  }
  return entry as { id: string; number: string };
}

/** Posts the mirror image of an entry (debits and credits swapped) and links the two. */
export async function reverseEntry(tx: Tx, actor: Actor, entryId: string, input: { date?: string; memo?: string; idempotencyKey?: string | null } = {}) {
  const e = await one(tx, 'SELECT * FROM journal_entry WHERE id = $1 FOR UPDATE', [entryId]);
  if (!e) throw notFound('journal entry');
  if (e.reversed_by_id) throw conflict(`${e.number} is already reversed`);
  if (e.reverses_id) throw conflict(`${e.number} is itself a reversal`);
  const lines = await many(tx, 'SELECT account_id, debit::float AS debit, credit::float AS credit, memo, party, facility_id FROM journal_line WHERE entry_id = $1 ORDER BY line_no', [entryId]);
  const r = await postEntry(tx, actor, { date: input.date ?? new Date().toISOString().slice(0, 10), memo: input.memo ?? `Reversal of ${e.number}: ${e.memo}`, source: 'reversal', sourceId: e.source_id,
    idempotencyKey: input.idempotencyKey ?? null, reversesId: entryId,
    lines: lines.map((l) => ({ accountId: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo, party: l.party, facilityId: l.facility_id })) });
  await tx.query('UPDATE journal_entry SET reversed_by_id = $2 WHERE id = $1', [entryId, r.id]);
  return r;
}

/** The account a platform key posts to; a clear error when the chart has none. */
export async function accountsForKeys(tx: Tx, keys: string[]) {
  const rows = await many(tx, 'SELECT id, account_key FROM ledger_account WHERE active AND account_key = ANY ($1)', [keys]);
  const map = new Map(rows.map((r) => [r.account_key as string, r.id as string]));
  const missing = [...new Set(keys)].filter((k) => !map.has(k));
  return { map, missing };
}

export async function defaultBank(tx: Tx) {
  return (await one(tx, `SELECT s.default_bank_account_id AS id FROM books_settings s`))?.id
    ?? (await one(tx, `SELECT id FROM ledger_account WHERE subtype = 'bank' AND active ORDER BY code LIMIT 1`))?.id ?? null;
}

/** Posts one operational event (or its reversal). Returns the entry number. */
export async function postEvent(tx: Tx, actor: Actor, e: OutboxEvent): Promise<string> {
  const p = e.payload;
  if (REVERSALS[e.topic]) {
    const original = await one(tx, 'SELECT id, number, reversed_by_id FROM journal_entry WHERE idempotency_key = $1', [REVERSALS[e.topic]!(p, e.aggregate_id)]);
    if (!original) throw invalid('the original entry was never posted to the books');
    if (original.reversed_by_id) return (await one(tx, 'SELECT number FROM journal_entry WHERE id = $1', [original.reversed_by_id])).number;
    return (await reverseEntry(tx, actor, original.id, { memo: `Void: ${p.invoiceNumber}${p.reason ? ` (${p.reason})` : ''}`, idempotencyKey: e.idempotency_key })).number;
  }
  const posting = postingFor(e.topic, p);
  if (!posting) throw invalid(`the books do not post ${e.topic}`);
  const { map, missing } = await accountsForKeys(tx, posting.lines.filter((l) => l.key !== 'bank').map((l) => l.key));
  if (missing.length) throw invalid(`no account in the chart for: ${missing.join(', ')}; give an account that key`);
  const bank = posting.lines.some((l) => l.key === 'bank') ? posting.bankAccountId ?? (await defaultBank(tx)) : null;
  if (posting.lines.some((l) => l.key === 'bank') && !bank) throw invalid('no bank account in the books to pay from or into');
  const facility = p.facility?.code ? (await one(tx, 'SELECT id FROM facility WHERE code = $1', [p.facility.code]))?.id ?? null : null;
  const entry = await postEntry(tx, actor, { date: String(posting.date).slice(0, 10), memo: posting.memo, source: posting.source, sourceId: e.aggregate_id, idempotencyKey: e.idempotency_key,
    lines: posting.lines.map((l) => ({ accountId: l.key === 'bank' ? bank! : map.get(l.key)!, debit: l.debit, credit: l.credit, memo: l.memo, party: l.party, facilityId: facility })) });
  return entry.number;
}

/**
 * The built-in books as an accounting connection: it receives the same events as an external system, and posts them
 * inline (in the same transaction as the business change) when it is the active connection.
 */
export const nativeBooksAdapter: AccountingAdapter = {
  provider: 'native_books',
  isMock: false,
  inline: true,
  topics: ['ar.invoice.issued', 'ar.invoice.voided', 'ap.bill.approved', 'ap.bill.voided', 'expense.report.approved', 'expense.report.paid', 'ar.payment.received', 'ap.bill.paid',
    'ar.credit_memo.issued', 'ar.credit_memo.voided', 'ar.refund.paid'],
  async deliver(tx, actor, _connection, events) {
    const out: DeliveryResult[] = [];
    for (const e of events) {
      try {
        await tx.query('SAVEPOINT books_post');
        out.push({ eventId: e.id, ok: true, externalId: await postEvent(tx, actor, e) });
        await tx.query('RELEASE SAVEPOINT books_post');
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT books_post');
        out.push({ eventId: e.id, ok: false, error: (err as Error).message, permanent: true });
      }
    }
    return out;
  },
};
