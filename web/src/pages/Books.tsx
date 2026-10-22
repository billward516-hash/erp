import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtMoney, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${today().slice(0, 4)}-01-01`;
const signed = (n: number) => (n < 0 ? `(${fmtMoney(-n)})` : fmtMoney(n));
const TABS = [['overview', 'Overview'], ['banking', 'Banking'], ['accounts', 'Chart of accounts'], ['journal', 'Journal'], ['statements', 'Statements'], ['reconcile', 'Reconcile'], ['settings', 'Settings']] as const;

/** The built-in books (D-136): invoices, bills, expenses and payments post here; bank lines are matched or categorized. */
export function Books() {
  const { data, loading, error, reload } = useApi<any>('/api/books');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  return (
    <>
      <PageHead eyebrow="Finance" title="Books" sub="Invoices, bills, expense reports and payments post here as they happen. Bring in bank statements, match or categorize each line, and reconcile." />
      <Async loading={loading && !data} error={error}>{() => (!data.set_up ? <Setup onDone={reload} connection={data.connection} /> : (
        <>
          <div className="row" role="tablist" aria-label="Books">
            {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}{k === 'banking' && data.toReview ? ` (${data.toReview})` : ''}</button>)}
          </div>
          {tab === 'overview' && <Overview o={data} />}
          {tab === 'banking' && <Banking onChange={reload} />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'journal' && <Journal />}
          {tab === 'statements' && <Statements />}
          {tab === 'reconcile' && <Reconcile />}
          {tab === 'settings' && <Settings o={data} onDone={reload} />}
        </>
      ))}</Async>
    </>
  );
}

function Setup({ onDone, connection }: { onDone: () => void; connection: any }) {
  const { can } = useAuth();
  const [f, setF] = useState({ bankName: 'Checking', bankLast4: '', openingBalance: '', startDate: today() });
  const setup = useAction(async () => {
    await api.post('/api/books/setup', { bankName: f.bankName, bankLast4: f.bankLast4 || null, openingBalance: f.openingBalance ? Number(f.openingBalance) : undefined, startDate: f.startDate });
    onDone();
  });
  if (!can('books.manage')) return <p className="muted">The books have not been set up yet.</p>;
  return (
    <section className="card stack">
      <h2>Set up the books</h2>
      {connection && connection.provider !== 'native_books'
        ? <p className="notice warn">"{connection.label}" is your accounting connection. Disconnect it under Accounting before using the built-in books.</p>
        : <p className="muted">Starts a small-business chart of accounts (rename or add accounts any time), your main bank account with its balance on the start date, and posts invoices, bills, expense reports and payments from then on.</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void setup.run(); }}>
        <input id="bk-bank" aria-label="Bank account name" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} style={{ maxWidth: 220 }} required />
        <input id="bk-last4" aria-label="Last four digits" placeholder="Last 4 digits" value={f.bankLast4} onChange={(e) => setF({ ...f, bankLast4: e.target.value })} style={{ width: 130 }} />
        <label className="row">Balance on<input id="bk-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} style={{ width: 160 }} /></label>
        <label className="row">$<input id="bk-opening" type="number" step="0.01" placeholder="Opening balance" value={f.openingBalance} onChange={(e) => setF({ ...f, openingBalance: e.target.value })} style={{ width: 150 }} /></label>
        <button className="primary" disabled={setup.busy}>Set up the books</button>
      </form>
      <ErrorNote message={setup.error} />
    </section>
  );
}

function Overview({ o }: { o: any }) {
  const cash = o.bank.filter((b: any) => b.subtype === 'bank').reduce((s: number, b: any) => s + b.balance, 0);
  return (
    <>
      <p className="answer">{fmtMoney(cash)} in the bank; {o.yearToDate.netIncome >= 0 ? 'net income' : 'net loss'} of {fmtMoney(Math.abs(o.yearToDate.netIncome))} this year on {fmtMoney(o.yearToDate.income)} of income.</p>
      <Kpis items={[
        ...o.bank.map((b: any) => ({ label: `${b.name}${b.last4 ? ` ··${b.last4}` : ''}`, value: signed(b.balance) })),
        { label: 'Customers owe', value: fmtMoney(o.receivable) }, { label: 'You owe suppliers', value: fmtMoney(o.payable) },
        { label: 'Net income this month', value: signed(o.month.netIncome), tone: o.month.netIncome >= 0 ? 'good' : 'bad' },
      ]} />
      {o.toReview > 0 && <p className="notice warn">{o.toReview} bank line{o.toReview === 1 ? '' : 's'} to review. <Link to="/books?tab=banking">Review them</Link></p>}
      {o.postingProblems > 0 && <p className="notice error">{o.postingProblems} record{o.postingProblems === 1 ? '' : 's'} could not post to the books. <Link to="/integrations">See why</Link></p>}
      <div className="grid two">
        <PlCard title="This month" p={o.month} />
        <PlCard title="This year" p={o.yearToDate} />
      </div>
    </>
  );
}

function PlCard({ title, p }: { title: string; p: any }) {
  return (
    <section className="card stack">
      <h2>{title}</h2>
      <dl className="facts">
        <dt>Income</dt><dd className="mono">{fmtMoney(p.income)}</dd>
        <dt>Gross profit</dt><dd className="mono">{signed(p.grossProfit)}</dd>
        <dt>Expenses</dt><dd className="mono">{fmtMoney(p.sections.find((s: any) => s.name === 'Expenses').total)}</dd>
        <dt><strong>Net income</strong></dt><dd className="mono"><strong>{signed(p.netIncome)}</strong></dd>
      </dl>
    </section>
  );
}

function Banking({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState('unreviewed');
  const { data, loading, error, reload } = useApi<any[]>(`/api/books/bank?status=${status}`);
  const accounts = useApi<any[]>('/api/books/accounts');
  const rules = useApi<any[]>('/api/books/rules');
  const [pick, setPick] = useState<Record<string, { accountId: string; remember: boolean }>>({});
  const after = async () => { await reload(); await rules.reload(); onChange(); };
  const categorize = useAction(async (t: any) => {
    const p = pick[t.id] ?? { accountId: t.suggested_account_id ?? '', remember: false };
    await api.post(`/api/books/bank/${t.id}/categorize`, { accountId: p.accountId, remember: p.remember ? t.description.replace(/[\d#]+/g, '').trim().slice(0, 40) : null });
    await after();
  });
  const match = useAction(async (t: any, lineId: string) => { await api.post(`/api/books/bank/${t.id}/match`, { journalLineId: lineId }); await after(); });
  const exclude = useAction(async (t: any) => { await api.post(`/api/books/bank/${t.id}/exclude`, { reason: 'Not a business transaction or already recorded' }); await after(); });
  const choices = (accounts.data ?? []).filter((a) => a.active && !['accounts_receivable', 'accounts_payable'].includes(a.subtype));
  return (
    <>
      <section className="card stack">
        <div className="spread">
          <h2>Bank and card lines</h2>
          <div className="row">
            <select id="bank-status" aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
              {['unreviewed', 'matched', 'categorized', 'excluded'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
            <Link className="btn" to="/imports">Import a statement</Link>
          </div>
        </div>
        <p className="muted">Import your bank's CSV (any layout) under Data import → Bank and card transactions. Match each line to a payment already recorded, or categorize it to an account; categorizing can remember a rule for next time.</p>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!} empty={status === 'unreviewed' ? 'Nothing to review.' : 'None.'} columns={[
            { key: 'posted_on', label: 'Date', render: (t: any) => fmtDate(t.posted_on) }, { key: 'description', label: 'Description', render: (t: any) => <>{t.description}<div className="faint">{t.bank_name}{t.reference ? ` · ${t.reference}` : ''}</div></> },
            { key: 'amount', label: 'Amount', numeric: true, render: (t: any) => <span className={t.amount < 0 ? '' : 'good-text'}>{signed(t.amount)}</span> },
            { key: 'action', label: status === 'unreviewed' ? 'Match or categorize' : 'Posted', render: (t: any) => (status !== 'unreviewed' ? (t.entry_number ? <>{t.entry_number}{t.posted_account ? ` → ${t.posted_account}` : ''}</> : t.exclude_reason ?? '—') : (
              <div className="stack" style={{ gap: 6 }}>
                {t.matches?.map((m: any) => <button key={m.id} onClick={() => match.run(t, m.id)} disabled={match.busy}>Match {m.number}: {m.party ?? m.memo} ({fmtDate(m.entry_date)})</button>)}
                <div className="row">
                  <select aria-label={`Account for ${t.description}`} value={pick[t.id]?.accountId ?? t.suggested_account_id ?? ''} onChange={(e) => setPick({ ...pick, [t.id]: { remember: pick[t.id]?.remember ?? false, accountId: e.target.value } })}>
                    <option value="">Account…</option>{choices.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
                  <label className="row"><input type="checkbox" aria-label={`Remember a rule for ${t.description}`} checked={pick[t.id]?.remember ?? false}
                    onChange={(e) => setPick({ ...pick, [t.id]: { accountId: pick[t.id]?.accountId ?? t.suggested_account_id ?? '', remember: e.target.checked } })} /> Rule</label>
                  <button className="primary" onClick={() => categorize.run(t)} disabled={categorize.busy || !(pick[t.id]?.accountId ?? t.suggested_account_id)}>Categorize</button>
                  <button className="link" onClick={() => exclude.run(t)}>Exclude</button>
                </div>
                {t.suggested_name && !pick[t.id] && <span className="faint">Suggested by a rule: {t.suggested_code} {t.suggested_name}</span>}
              </div>)) }]} />
        )}</Async>
        <ErrorNote message={categorize.error ?? match.error ?? exclude.error} />
      </section>
      <section className="card stack">
        <h2>Rules</h2>
        <Table rows={rules.data ?? []} empty="No rules yet: tick Rule when categorizing." columns={[{ key: 'contains', label: 'Description contains' }, { key: 'direction', label: 'Money', render: (r: any) => humanize(r.direction) },
          { key: 'account_name', label: 'Account', render: (r: any) => `${r.code} ${r.account_name}` }]} />
      </section>
    </>
  );
}

function Accounts() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/books/accounts');
  const [sel, setSel] = useState<string | null>(null);
  const reg = useApi<any>(sel ? `/api/books/accounts/${sel}/register?from=${yearStart()}` : null);
  const [f, setF] = useState({ code: '', name: '', type: 'expense', subtype: 'expense' });
  const add = useAction(async () => { await api.post('/api/books/accounts', f); setF({ code: '', name: '', type: 'expense', subtype: 'expense' }); await reload(); });
  const SUB: Record<string, string> = { asset: 'current_asset', liability: 'current_liability', equity: 'equity', income: 'income', expense: 'expense' };
  return (
    <>
      <section className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!.filter((a) => a.active)} onRow={(a) => setSel(a.id)} columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account', render: (a: any) => <>{a.name}{a.system && <span className="faint"> (system)</span>}</> },
            { key: 'type', label: 'Type', render: (a: any) => humanize(a.subtype) }, { key: 'balance', label: 'Balance', numeric: true, render: (a: any) => (a.debit || a.credit ? signed(a.balance) : '—') }]} />
        )}</Async>
      </section>
      {sel && reg.data && (
        <section className="card stack">
          <div className="spread"><h2>{reg.data.account.code} {reg.data.account.name}</h2><button className="link" onClick={() => setSel(null)}>Close</button></div>
          <p className="muted">From {fmtDate(reg.data.from)}: opening {signed(reg.data.opening)}, closing {signed(reg.data.closing)}</p>
          <Table rows={reg.data.lines} empty="No entries this year." columns={[{ key: 'entry_date', label: 'Date', render: (l: any) => fmtDate(l.entry_date) }, { key: 'number', label: 'Entry' },
            { key: 'memo', label: 'Description', render: (l: any) => l.party ?? l.memo ?? l.entry_memo }, { key: 'debit', label: 'Debit', numeric: true, render: (l: any) => (l.debit ? fmtMoney(l.debit) : '') },
            { key: 'credit', label: 'Credit', numeric: true, render: (l: any) => (l.credit ? fmtMoney(l.credit) : '') }, { key: 'balance', label: 'Balance', numeric: true, render: (l: any) => signed(l.balance) }]} />
        </section>
      )}
      {can('books.manage') && (
        <section className="card stack">
          <h2>Add an account</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            <input id="acct-code" aria-label="Code" placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required style={{ width: 100 }} />
            <input id="acct-name" aria-label="Name" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required style={{ flex: '1 1 220px' }} />
            <select id="acct-type" aria-label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, subtype: SUB[e.target.value]! })}>
              {Object.keys(SUB).map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</select>
            {f.type === 'asset' && <select aria-label="Kind" value={f.subtype} onChange={(e) => setF({ ...f, subtype: e.target.value })}>
              {['current_asset', 'bank', 'fixed_asset', 'inventory'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>}
            <button disabled={add.busy}>Add</button><ErrorNote message={add.error} />
          </form>
        </section>
      )}
    </>
  );
}

function Journal() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>(`/api/books/entries?from=${yearStart()}`);
  const accounts = useApi<any[]>('/api/books/accounts');
  const blank = () => ({ accountId: '', debit: '', credit: '' });
  const [f, setF] = useState({ date: today(), memo: '' });
  const [lines, setLines] = useState([blank(), blank()]);
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0); const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const post = useAction(async () => {
    await api.post('/api/books/entries', { ...f, lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: Number(l.debit || 0), credit: Number(l.credit || 0) })) });
    setLines([blank(), blank()]); setF({ date: today(), memo: '' }); await reload();
  });
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <>
      <section className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!} empty="No entries this year." columns={[{ key: 'entry_date', label: 'Date', render: (e: any) => fmtDate(e.entry_date) }, { key: 'number', label: 'Entry' },
            { key: 'memo', label: 'Description', render: (e: any) => <>{e.memo}{e.reverses_id && <> <Pill label="Reversal" /></>}{e.reversed_by_id && <> <Pill tone="bad" label="Reversed" /></>}
              <div className="faint">{e.lines.map((l: any) => `${l.code} ${l.debit ? `Dr ${fmtMoney(l.debit)}` : `Cr ${fmtMoney(l.credit)}`}`).join(' · ')}</div></> },
            { key: 'source', label: 'From', render: (e: any) => humanize(e.source) }, { key: 'amount', label: 'Amount', numeric: true, render: (e: any) => fmtMoney(e.amount) }]} />
        )}</Async>
      </section>
      {can('books.manage') && (
        <section className="card stack">
          <h2>Journal entry</h2>
          <p className="muted">For what does not come from an invoice, bill, expense report or bank line: owner contributions, loans, depreciation, corrections.</p>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void post.run(); }}>
            <div className="row"><input id="je-date" type="date" aria-label="Date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ width: 160 }} />
              <input id="je-memo" aria-label="Memo" placeholder="What the entry is for" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} required style={{ flex: '1 1 260px' }} /></div>
            {lines.map((l, i) => (
              <div key={i} className="row">
                <select aria-label={`Line ${i + 1} account`} value={l.accountId} onChange={(e) => set(i, 'accountId', e.target.value)} style={{ minWidth: 240 }}>
                  <option value="">Account…</option>{(accounts.data ?? []).filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
                <input aria-label={`Line ${i + 1} debit`} type="number" min="0" step="0.01" placeholder="Debit" value={l.debit} onChange={(e) => set(i, 'debit', e.target.value)} style={{ width: 120 }} />
                <input aria-label={`Line ${i + 1} credit`} type="number" min="0" step="0.01" placeholder="Credit" value={l.credit} onChange={(e) => set(i, 'credit', e.target.value)} style={{ width: 120 }} />
              </div>
            ))}
            <div className="row"><button type="button" onClick={() => setLines([...lines, blank()])}>Add line</button>
              <span className={Math.abs(dr - cr) < 0.005 ? 'good-text' : 'bad-text'}>Debits {fmtMoney(dr)} · credits {fmtMoney(cr)}{Math.abs(dr - cr) < 0.005 ? '' : ' (must be equal)'}</span></div>
            <div><button className="primary" disabled={post.busy || Math.abs(dr - cr) >= 0.005 || dr === 0}>Post entry</button></div>
            <ErrorNote message={post.error} />
          </form>
        </section>
      )}
    </>
  );
}

function Statements() {
  const [range, setRange] = useState({ from: yearStart(), to: today() });
  const pl = useApi<any>(`/api/books/profit-and-loss?from=${range.from}&to=${range.to}`);
  const bs = useApi<any>(`/api/books/balance-sheet?asOf=${range.to}`);
  const tb = useApi<any>(`/api/books/trial-balance?asOf=${range.to}`);
  const exportCsv = useAction(async () => api.download(`/api/books/export.csv?from=${range.from}&to=${range.to}`, 'journal.csv'));
  const lines = (xs: any[]) => xs.map((a) => <tr key={a.id}><td>{a.code} {a.name}</td><td className="n">{signed(a.amount)}</td></tr>);
  return (
    <>
      <div className="row">
        <label className="row">From<input id="st-from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 160 }} /></label>
        <label className="row">To<input id="st-to" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 160 }} /></label>
        <button onClick={() => exportCsv.run()} disabled={exportCsv.busy}>Export journal (CSV)</button>
        <Link to="/reports/profit-and-loss">Print or export the reports</Link>
      </div>
      <div className="grid two">
        <section className="card stack">
          <h2>Profit and loss</h2>
          {pl.data && <table className="statement"><tbody>
            {pl.data.sections.filter((s: any) => s.accounts.length).map((s: any) => [<tr key={s.name} className="head"><th colSpan={2} scope="colgroup">{s.name}</th></tr>, ...lines(s.accounts),
              <tr key={`${s.name}-t`} className="total"><td>Total {s.name.toLowerCase()}</td><td className="n">{signed(s.total)}</td></tr>])}
            <tr className="grand"><td>Net income</td><td className="n">{signed(pl.data.netIncome)}</td></tr>
          </tbody></table>}
        </section>
        <section className="card stack">
          <h2>Balance sheet <span className="faint" style={{ fontWeight: 400 }}>{fmtDate(range.to)}</span></h2>
          {bs.data && <table className="statement"><tbody>
            <tr className="head"><th colSpan={2} scope="colgroup">Assets</th></tr>{lines(bs.data.assets)}<tr className="total"><td>Total assets</td><td className="n">{signed(bs.data.totalAssets)}</td></tr>
            <tr className="head"><th colSpan={2} scope="colgroup">Liabilities</th></tr>{lines(bs.data.liabilities)}<tr className="total"><td>Total liabilities</td><td className="n">{signed(bs.data.totalLiabilities)}</td></tr>
            <tr className="head"><th colSpan={2} scope="colgroup">Equity</th></tr>{lines(bs.data.equity)}<tr className="total"><td>Total equity</td><td className="n">{signed(bs.data.totalEquity)}</td></tr>
            <tr className="grand"><td>Liabilities and equity</td><td className="n">{signed(bs.data.totalLiabilities + bs.data.totalEquity)}</td></tr>
          </tbody></table>}
          {bs.data && !bs.data.balanced && <p className="notice error">The balance sheet does not balance; check the journal.</p>}
        </section>
      </div>
      {tb.data && (
        <section className="card stack">
          <h2>Trial balance {tb.data.balanced ? <Pill tone="good" label="Balanced" /> : <Pill tone="bad" label="Out of balance" />}</h2>
          <Table rows={tb.data.rows} columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'debit', label: 'Debit', numeric: true, render: (r: any) => (r.debit ? fmtMoney(r.debit) : '') },
            { key: 'credit', label: 'Credit', numeric: true, render: (r: any) => (r.credit ? fmtMoney(r.credit) : '') }]} />
        </section>
      )}
      <ErrorNote message={exportCsv.error} />
    </>
  );
}

function Reconcile() {
  const list = useApi<any[]>('/api/books/reconciliations');
  const accounts = useApi<any[]>('/api/books/accounts');
  const open = (list.data ?? []).find((r) => r.status === 'open');
  const rec = useApi<any>(open ? `/api/books/reconciliations/${open.id}` : null);
  const banks = (accounts.data ?? []).filter((a) => ['bank', 'credit_card'].includes(a.subtype) && a.active);
  const [f, setF] = useState({ bankAccountId: '', statementDate: today(), statementBalance: '' });
  const start = useAction(async () => { await api.post('/api/books/reconciliations', { bankAccountId: f.bankAccountId || banks[0]?.id, statementDate: f.statementDate, statementBalance: Number(f.statementBalance) }); await list.reload(); });
  const toggle = useAction(async (id: string, cleared: boolean) => { await api.post(`/api/books/reconciliations/${open.id}/cleared`, { lineIds: [id], cleared }); await rec.reload(); });
  const finish = useAction(async () => { await api.post(`/api/books/reconciliations/${open.id}/finish`, {}); await list.reload(); });
  return (
    <>
      {!open && (
        <section className="card stack">
          <h2>Reconcile a statement</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void start.run(); }}>
            <select id="rec-bank" aria-label="Account" value={f.bankAccountId || banks[0]?.id || ''} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <label className="row">Statement date<input id="rec-date" type="date" value={f.statementDate} onChange={(e) => setF({ ...f, statementDate: e.target.value })} style={{ width: 160 }} /></label>
            <label className="row">Ending balance $<input id="rec-balance" type="number" step="0.01" value={f.statementBalance} onChange={(e) => setF({ ...f, statementBalance: e.target.value })} required style={{ width: 150 }} /></label>
            <button className="primary" disabled={start.busy}>Start</button>
          </form>
          <ErrorNote message={start.error} />
        </section>
      )}
      {open && rec.data && (
        <section className="card stack">
          <h2>{rec.data.bank_name}: statement of {fmtDate(rec.data.statement_date)}</h2>
          <Kpis items={[{ label: 'Statement balance', value: fmtMoney(rec.data.statement_balance) }, { label: 'Cleared in the books', value: fmtMoney(rec.data.cleared) },
            { label: 'Difference', value: fmtMoney(rec.data.difference), tone: rec.data.difference === 0 ? 'good' : 'bad' }]} />
          <Table rows={rec.data.lines} columns={[{ key: 'cleared', label: 'Cleared', render: (l: any) => <input type="checkbox" aria-label={`Cleared: ${l.description} ${l.debit || l.credit}`} checked={l.cleared} onChange={(e) => toggle.run(l.id, e.target.checked)} /> },
            { key: 'entry_date', label: 'Date', render: (l: any) => fmtDate(l.entry_date) }, { key: 'description', label: 'Description' },
            { key: 'debit', label: 'Deposit', numeric: true, render: (l: any) => (l.debit ? fmtMoney(l.debit) : '') }, { key: 'credit', label: 'Payment', numeric: true, render: (l: any) => (l.credit ? fmtMoney(l.credit) : '') }]} />
          <div className="row"><button className="primary" onClick={() => finish.run()} disabled={finish.busy || rec.data.difference !== 0}>Finish reconciliation</button><ErrorNote message={finish.error ?? toggle.error} /></div>
        </section>
      )}
      <section className="card">
        <h2>Finished</h2>
        <Table rows={(list.data ?? []).filter((r) => r.status === 'finished')} empty="None yet." columns={[{ key: 'bank_name', label: 'Account' }, { key: 'statement_date', label: 'Statement', render: (r: any) => fmtDate(r.statement_date) },
          { key: 'statement_balance', label: 'Balance', numeric: true, render: (r: any) => fmtMoney(r.statement_balance) }]} />
      </section>
    </>
  );
}

function Settings({ o, onDone }: { o: any; onDone: () => void }) {
  const [closed, setClosed] = useState(o.settings.closed_through?.slice(0, 10) ?? '');
  const save = useAction(async () => { await api.put('/api/books/settings', { closedThrough: closed || null }); onDone(); });
  return (
    <section className="card stack">
      <h2>Close a period</h2>
      <p className="muted">Nothing can be posted on or before the closing date: invoices, bills, expenses and bank lines dated earlier are refused with a clear message. Your accountant typically asks for this after year end.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <label className="row">Closed through<input id="set-closed" type="date" value={closed} onChange={(e) => setClosed(e.target.value)} style={{ width: 160 }} /></label>
        <button className="primary" disabled={save.busy}>Save</button><ErrorNote message={save.error} />
      </form>
      <p className="faint">Books started {fmtDate(o.settings.started_on)}. Moving to another accounting system later: export the journal from Statements and disconnect the books under Accounting.</p>
    </section>
  );
}
