import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  draft: { label: 'Draft', tone: 'info' }, issued: { label: 'Issued', tone: 'watch' }, partially_paid: { label: 'Part paid', tone: 'watch' },
  paid: { label: 'Paid', tone: 'good' }, void: { label: 'Void', tone: 'neutral' },
};
export const ArStatus = ({ v, overdue }: { v: string; overdue?: boolean }) => (
  <>{<Pill tone={STATUS[v]?.tone} label={STATUS[v]?.label ?? v} />}{overdue && <> <Pill tone="bad" label="Overdue" /></>}</>
);
const today = () => new Date().toISOString().slice(0, 10);
const TABS = [['invoices', 'Invoices'], ['to-invoice', 'Ready to invoice'], ['collections', 'Collections'], ['payment', 'Record payment']] as const;

export function Receivables() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'invoices';
  const { can } = useAuth();
  const open = useApi<any[]>('/api/customer-invoices?open=true');
  const issued = (open.data ?? []).filter((r) => r.status !== 'draft');
  return (
    <>
      <PageHead eyebrow="Accounts receivable" title="Customer invoices"
        sub="Invoice what has shipped, record what customers pay, and work the overdue accounts. Issued invoices go to your accounting system, which stays the book of record." />
      <Kpis items={[
        { label: 'Open receivables', value: fmtMoney(issued.reduce((s, r) => s + r.balance, 0)) },
        { label: 'Overdue', value: fmtMoney(issued.filter((r) => r.overdue).reduce((s, r) => s + r.balance, 0)), tone: issued.some((r) => r.overdue) ? 'bad' : 'good' },
        { label: 'Drafts', value: (open.data ?? []).filter((r) => r.status === 'draft').length },
      ]} />
      <div className="row" role="tablist" aria-label="Receivables">
        {TABS.filter(([k]) => k !== 'payment' || can('ar.manage')).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>
        ))}
      </div>
      {tab === 'invoices' && <InvoiceList />}
      {tab === 'to-invoice' && <ToInvoice />}
      {tab === 'collections' && <Collections />}
      {tab === 'payment' && <RecordPayment onDone={open.reload} />}
    </>
  );
}

function InvoiceList() {
  const nav = useNavigate();
  const [onlyOpen, setOnlyOpen] = useState(true);
  const { data, loading, error } = useApi<any[]>(onlyOpen ? '/api/customer-invoices?open=true' : '/api/customer-invoices');
  return (
    <div className="card stack">
      <label className="row"><input id="ar-open" type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only open</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(r) => nav(`/receivables/${r.id}`)} exception={(r) => r.overdue} empty="No customer invoices."
          columns={[{ key: 'customer_name', label: 'Customer' }, { key: 'number', label: 'Invoice', render: (r) => <strong>{r.number ?? 'Draft'}</strong> },
            { key: 'facility_code', label: 'Site' }, { key: 'order_number', label: 'Order' }, { key: 'invoice_date', label: 'Dated', render: (r) => fmtDate(r.invoice_date) },
            { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) }, { key: 'total', label: 'Amount', numeric: true, render: (r) => fmtMoney(r.total) },
            { key: 'balance', label: 'Balance', numeric: true, render: (r) => fmtMoney(r.balance) }, { key: 'status', label: 'Status', render: (r) => <ArStatus v={r.status} overdue={r.overdue} /> }]} />
      )}</Async>
    </div>
  );
}

function ToInvoice() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/customer-invoices/to-invoice');
  const draft = useAction(async (orderId: string) => { const inv = await api.post(`/api/sales-orders/${orderId}/invoice`, {}); nav(`/receivables/${inv.id}`); });
  return (
    <div className="card stack">
      <p className="muted">Orders with shipped quantity that has not been invoiced yet.</p>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} empty="Everything shipped has been invoiced."
          columns={[{ key: 'number', label: 'Order', render: (r) => <Link to={`/sales/orders/${r.id}`}>{r.number}</Link> }, { key: 'customer_name', label: 'Customer' },
            { key: 'last_shipped', label: 'Last shipped', render: (r) => fmtDate(r.last_shipped) }, { key: 'amount', label: 'To invoice', numeric: true, render: (r) => fmtMoney(r.amount) },
            { key: 'act', label: '', render: (r) => (can('ar.manage', r.facility_id) ? <button onClick={() => draft.run(r.id)} disabled={draft.busy}>Create invoice</button> : null) }]} />
      )}</Async>
      <ErrorNote message={draft.error} />
    </div>
  );
}

function Collections() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/collections');
  const [who, setWho] = useState<any | null>(null);
  const [f, setF] = useState({ summary: '', promiseDate: '' });
  const log = useAction(async () => {
    await api.post('/api/collections', { customerId: who.customer_id, summary: f.summary, promiseDate: f.promiseDate || null });
    setWho(null); setF({ summary: '', promiseDate: '' }); await reload();
  });
  return (
    <div className="card stack">
      <p className="muted">Customers with overdue invoices, longest overdue first.</p>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(r) => r.customer_id} empty="No overdue customers." exception={(r) => r.oldest_days > 60}
          columns={[{ key: 'customer_name', label: 'Customer', render: (r) => <Link to={`/receivables/customers/${r.customer_id}`}>{r.customer_name}</Link> },
            { key: 'contact_name', label: 'Contact', render: (r) => <>{r.contact_name ?? '—'}{r.phone ? <span className="faint"> · {r.phone}</span> : null}</> },
            { key: 'overdue', label: 'Overdue', numeric: true, render: (r) => fmtMoney(r.overdue) }, { key: 'open_balance', label: 'Total open', numeric: true, render: (r) => fmtMoney(r.open_balance) },
            { key: 'oldest_days', label: 'Oldest', numeric: true, render: (r) => `${r.oldest_days} days` },
            { key: 'last_contact', label: 'Last contact', render: (r) => (r.last_contact ? fmtDateTime(r.last_contact) : <Pill tone="watch" label="None" />) },
            { key: 'promised_by', label: 'Promised by', render: (r) => (r.promised_by ? <Pill tone={r.promised_by < today() ? 'bad' : 'info'} label={fmtDate(r.promised_by)} /> : '—') },
            { key: 'act', label: '', render: (r) => (can('ar.manage') ? <button onClick={() => setWho(r)}>Log call</button> : null) }]} />
      )}</Async>
      {who && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void log.run(); }}>
          <h3>Collections call: {who.customer_name}</h3>
          <label className="field">What was said<textarea id="col-summary" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} required /></label>
          <label className="field">Promised to pay by (optional)<input id="col-promise" type="date" value={f.promiseDate} onChange={(e) => setF({ ...f, promiseDate: e.target.value })} /></label>
          <div className="row"><button className="primary" disabled={log.busy}>Save</button><button type="button" onClick={() => setWho(null)}>Cancel</button></div>
          <ErrorNote message={log.error} />
        </form>
      )}
    </div>
  );
}

/** A payment from one customer applied across their open invoices (oldest first by default). */
function RecordPayment({ onDone, customerId: fixed }: { onDone: () => void; customerId?: string }) {
  const customers = useApi<any[]>(fixed ? null : '/api/customer-invoices?open=true');
  const [customerId, setCustomerId] = useState(fixed ?? '');
  const acct = useApi<any>(customerId ? `/api/customers/${customerId}/account` : null);
  const [f, setF] = useState({ receivedOn: today(), amount: '', method: 'check', reference: '' });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const open = (acct.data?.invoices ?? []).filter((i: any) => ['issued', 'partially_paid'].includes(i.status));
  const applied = Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0);
  const spread = (amount: number) => {
    let left = amount; const next: Record<string, string> = {};
    for (const i of [...open].sort((a, b) => a.due_date.localeCompare(b.due_date))) { const take = Math.min(left, i.balance); if (take > 0) next[i.id] = take.toFixed(2); left = Math.round((left - take) * 100) / 100; }
    setAlloc(next);
  };
  const save = useAction(async () => {
    await api.post('/api/customer-payments', { customerId, receivedOn: f.receivedOn, amount: Number(f.amount), method: f.method, reference: f.reference || null,
      allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })) });
    setDone(`Recorded ${fmtMoney(Number(f.amount))}.`); setAlloc({}); setF({ ...f, amount: '', reference: '' }); await acct.reload(); onDone();
  });
  const names = [...new Map((customers.data ?? []).filter((i) => i.status !== 'draft').map((i) => [i.customer_id, i.customer_name])).entries()];
  return (
    <section className="card stack">
      <h2>Record a customer payment</h2>
      {!fixed && (
        <label className="field">Customer
          <select id="pay-customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setAlloc({}); setDone(null); }}>
            <option value="">Choose a customer with open invoices…</option>
            {names.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      )}
      {acct.data && !acct.data.paymentsManual && <div className="notice warn">Payments come from the connected accounting system on each sync, so they are not typed in here.</div>}
      {acct.data?.paymentsManual && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="row">
            <input id="pay-received" type="date" aria-label="Received on" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} required />
            <input id="pay-amount" type="number" step="0.01" min="0.01" aria-label="Amount" placeholder="Amount" value={f.amount}
              onChange={(e) => { setF({ ...f, amount: e.target.value }); spread(Number(e.target.value) || 0); }} required style={{ width: 120 }} />
            <select id="pay-method" aria-label="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              {['check', 'ach', 'wire', 'card', 'other'].map((m) => <option key={m} value={m}>{m === 'ach' ? 'ACH' : humanize(m)}</option>)}
            </select>
            <input id="pay-reference" aria-label="Reference" placeholder="Check number / reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </div>
          <Table rows={open} empty="No open invoices for this customer."
            columns={[{ key: 'number', label: 'Invoice' }, { key: 'due_date', label: 'Due', render: (i) => fmtDate(i.due_date) }, { key: 'balance', label: 'Balance', numeric: true, render: (i) => fmtMoney(i.balance) },
              { key: 'apply', label: 'Apply', numeric: true, render: (i) => <input aria-label={`Apply to ${i.number}`} type="number" step="0.01" min="0" max={i.balance} value={alloc[i.id] ?? ''}
                onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} style={{ width: 110 }} /> }]} />
          <div className="row">
            <span className={Math.abs(applied - (Number(f.amount) || 0)) > 0.004 ? 'bad-text' : 'muted'}>Applied {fmtMoney(applied)} of {fmtMoney(Number(f.amount) || 0)}</span>
            <button className="primary" disabled={save.busy || !(Number(f.amount) > 0) || Math.abs(applied - Number(f.amount)) > 0.004}>Record payment</button>
          </div>
          <ErrorNote message={save.error} />
          {done && <div className="notice ok">{done}</div>}
        </form>
      )}
    </section>
  );
}

export function CustomerAccount() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: a, loading, error, reload } = useApi<any>(`/api/customers/${id}/account`);
  return (
    <Async loading={loading && !a} error={error}>{() => (
      <>
        <PageHead eyebrow="Customer account" title={a.customer.name} sub={<>{a.customer.payment_terms ?? 'No terms set'} · <Link to={`/crm/customers/${id}`}>Customer record</Link></>} />
        <Kpis items={[
          { label: 'Open invoices', value: fmtMoney(a.credit.openAr) }, { label: 'Ordered, not invoiced', value: fmtMoney(a.credit.uninvoicedOrders) },
          { label: 'Credit limit', value: a.credit.limit == null ? 'None' : fmtMoney(a.credit.limit) },
          { label: 'Exposure', value: fmtMoney(a.credit.exposure), tone: a.credit.over ? 'bad' : 'good', note: a.credit.over ? 'over the limit' : undefined },
        ]} />
        <section className="card">
          <h2>Invoices</h2>
          <Table rows={a.invoices} onRow={(r) => nav(`/receivables/${r.id}`)} exception={(r) => r.overdue} empty="No invoices."
            columns={[{ key: 'number', label: 'Invoice', render: (r) => r.number ?? 'Draft' }, { key: 'order_number', label: 'Order' }, { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) },
              { key: 'total', label: 'Amount', numeric: true, render: (r) => fmtMoney(r.total) }, { key: 'balance', label: 'Balance', numeric: true, render: (r) => fmtMoney(r.balance) },
              { key: 'status', label: 'Status', render: (r) => <ArStatus v={r.status} overdue={r.overdue} /> }]} />
        </section>
        <section className="card">
          <h2>Payments</h2>
          <Table rows={a.payments} empty="No payments yet."
            columns={[{ key: 'received_on', label: 'Received', render: (p) => fmtDate(p.received_on) }, { key: 'method', label: 'Method', render: (p) => humanize(p.method) },
              { key: 'reference', label: 'Reference' }, { key: 'source', label: 'From', render: (p) => (p.source === 'accounting' ? 'Accounting system' : 'Recorded here') },
              { key: 'amount', label: 'Amount', numeric: true, render: (p) => fmtMoney(p.amount) }]} />
        </section>
        {can('ar.manage') && <RecordPayment customerId={id} onDone={reload} />}
      </>
    )}</Async>
  );
}

export function ReceivableDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: i, loading, error, reload } = useApi<any>(`/api/customer-invoices/${id}`);
  const [edit, setEdit] = useState<{ freight: string; tax: string; notes: string; qty: Record<string, string> } | null>(null);
  const [reason, setReason] = useState('');
  const [call, setCall] = useState({ summary: '', promiseDate: '' });
  const [sent, setSent] = useState<string | null>(null);
  const save = useAction(async () => {
    await api.patch(`/api/customer-invoices/${id}`, { freightAmount: Number(edit!.freight) || 0, taxAmount: Number(edit!.tax) || 0, notes: edit!.notes || null,
      lines: Object.entries(edit!.qty).map(([lineId, q]) => ({ lineId, qty: Number(q) || 0 })) });
    setEdit(null); await reload();
  });
  const issue = useAction(async () => { await api.post(`/api/customer-invoices/${id}/issue`, {}); await reload(); });
  const voidIt = useAction(async (draft: boolean) => {
    await api.post(`/api/customer-invoices/${id}/void`, { reason }); setReason('');
    if (draft) nav('/receivables'); else await reload();
  });
  const remind = useAction(async () => { const r = await api.post(`/api/customer-invoices/${id}/reminder`, {}); setSent(`Reminder queued to ${r.to}.`); await reload(); });
  const logCall = useAction(async () => {
    await api.post('/api/collections', { customerId: i.customer_id, invoiceId: id, summary: call.summary, promiseDate: call.promiseDate || null });
    setCall({ summary: '', promiseDate: '' }); await reload();
  });
  return (
    <Async loading={loading && !i} error={error}>{() => {
      const manage = can('ar.manage', i.facility_id);
      const open = ['issued', 'partially_paid'].includes(i.status);
      return (
        <>
          <PageHead eyebrow={`${i.facility_code} · Customer invoice`} title={<>{i.number ?? 'Draft invoice'} <span className="muted" style={{ fontWeight: 400 }}>{i.customer_name}</span></>}
            sub={<>{i.order_number && <>for <Link to={`/sales/orders/${i.order_id}`}>{i.order_number}</Link> · </>}{i.customer_po ? `their PO ${i.customer_po} · ` : ''}
              {i.payment_terms ?? 'Net 30'}{i.due_date ? ` · due ${fmtDate(i.due_date)}` : ''} · <Link to={`/receivables/customers/${i.customer_id}`}>Account</Link></>}
            actions={<><ArStatus v={i.status} overdue={i.overdue} /> <button onClick={() => api.open(`/api/customer-invoices/${id}/pdf`)}>{i.status === 'draft' ? 'Preview PDF' : 'PDF'}</button></>} />
          <Kpis items={[{ label: 'Total', value: fmtMoney(i.total) }, { label: 'Paid', value: fmtMoney(i.paid) }, { label: 'Balance', value: fmtMoney(i.balance), tone: i.overdue ? 'bad' : undefined }]} />
          <section className="card stack">
            <div className="spread"><h2>Lines</h2>{manage && i.status === 'draft' && !edit && (
              <button onClick={() => setEdit({ freight: String(i.freight || ''), tax: String(i.tax || ''), notes: i.notes ?? '', qty: Object.fromEntries(i.lines.map((l: any) => [l.id, String(l.qty)])) })}>Edit draft</button>)}</div>
            <Table rows={i.lines}
              columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Description' },
                { key: 'qty', label: 'Qty', numeric: true, render: (l) => (edit ? <input aria-label={`Invoice qty line ${l.line_no}`} type="number" min="0" max={l.qty} step="any" value={edit.qty[l.id] ?? ''}
                  onChange={(e) => setEdit({ ...edit, qty: { ...edit.qty, [l.id]: e.target.value } })} style={{ width: 90 }} /> : fmtNum(l.qty, 3)) },
                { key: 'uom', label: 'Unit' }, { key: 'unit_price', label: 'Price', numeric: true, render: (l) => fmtMoney(l.unit_price) }, { key: 'amount', label: 'Amount', numeric: true, render: (l) => fmtMoney(l.amount) }]} />
            {edit ? (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
                <div className="row">
                  <label className="row">Freight<input id="inv-freight" type="number" step="0.01" min="0" value={edit.freight} onChange={(e) => setEdit({ ...edit, freight: e.target.value })} style={{ width: 110 }} /></label>
                  <label className="row">Sales tax<input id="inv-tax" type="number" step="0.01" min="0" value={edit.tax} onChange={(e) => setEdit({ ...edit, tax: e.target.value })} style={{ width: 110 }} /></label>
                </div>
                <label className="field">Note on the invoice<textarea id="inv-notes" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
                <p className="faint">Set a quantity to 0 to leave that line for a later invoice.</p>
                <div className="row"><button className="primary" disabled={save.busy}>Save draft</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
                <ErrorNote message={save.error} />
              </form>
            ) : (
              <p style={{ textAlign: 'right' }}>Subtotal {fmtMoney(i.subtotal)}{i.freight ? ` · Freight ${fmtMoney(i.freight)}` : ''}{i.tax ? ` · Tax ${fmtMoney(i.tax)}` : ''} · <strong>Total {fmtMoney(i.total)}</strong></p>
            )}
            {manage && i.status === 'draft' && !edit && (
              <div className="row"><button className="primary" onClick={() => issue.run()} disabled={issue.busy}>Issue invoice {fmtMoney(i.total)}</button>
                <span className="faint">Issuing assigns the number, fixes the due date, stores the PDF and sends it to accounting on the next sync.</span>
                <ErrorNote message={issue.error} /></div>
            )}
          </section>
          {open && manage && (
            <section className="card stack">
              <div className="spread"><h2>Collections</h2>
                <div className="row"><button onClick={() => remind.run()} disabled={remind.busy || !i.contact_email}>Email payment reminder</button>
                  {!i.contact_email && <span className="faint">No primary contact email</span>}</div></div>
              <ErrorNote message={remind.error} />{sent && <div className="notice ok">{sent} It goes out with the next mail run.</div>}
              <form className="row" onSubmit={(e) => { e.preventDefault(); void logCall.run(); }}>
                <input id="call-summary" aria-label="What was said" placeholder="What was said" value={call.summary} onChange={(e) => setCall({ ...call, summary: e.target.value })} required style={{ flex: '1 1 320px' }} />
                <label className="row">Promised by<input id="call-promise" type="date" value={call.promiseDate} onChange={(e) => setCall({ ...call, promiseDate: e.target.value })} /></label>
                <button disabled={logCall.busy}>Log call</button>
              </form>
              <ErrorNote message={logCall.error} />
            </section>
          )}
          {open && manage && i.paymentsManual && <RecordPayment customerId={i.customer_id} onDone={reload} />}
          <section className="card">
            <h2>Payments</h2>
            <Table rows={i.payments} empty="No payments yet."
              columns={[{ key: 'received_on', label: 'Received', render: (p) => fmtDate(p.received_on) }, { key: 'method', label: 'Method', render: (p) => humanize(p.method) },
                { key: 'reference', label: 'Reference' }, { key: 'source', label: 'From', render: (p) => (p.source === 'accounting' ? 'Accounting system' : 'Recorded here') },
                { key: 'amount', label: 'Applied', numeric: true, render: (p) => fmtMoney(p.amount) }]} />
          </section>
          <section className="card">
            <h2>History</h2>
            <Table rows={i.notes} empty="Nothing yet."
              columns={[{ key: 'created_at', label: 'When', render: (n) => fmtDateTime(n.created_at) }, { key: 'kind', label: 'What', render: (n) => (n.kind === 'task' ? 'Follow-up' : humanize(n.kind)) },
                { key: 'summary', label: 'Summary', render: (n) => <>{n.summary}{n.due_on ? <span className="faint"> (due {fmtDate(n.due_on)})</span> : null}</> }, { key: 'by', label: 'By' }]} />
          </section>
          <section className="card">
            <h2>Accounting</h2>
            <Table rows={i.sync} empty={i.status === 'draft' ? 'Sent to accounting once issued.' : 'Not sent yet: no accounting connection, or the next sync has not run.'}
              columns={[{ key: 'topic', label: 'What', render: (s) => (s.topic === 'ar.invoice.voided' ? 'Void invoice' : 'Create invoice') },
                { key: 'connection', label: 'Connection', render: (s) => <>{s.connection}{s.is_mock && <> <Pill tone="watch" label="MOCK" /></>}</> },
                { key: 'status', label: 'Status', render: (s) => <Pill tone={s.status === 'delivered' ? 'good' : s.status === 'dead' ? 'bad' : 'info'} label={humanize(s.status)} /> },
                { key: 'external_id', label: 'Accounting reference' }, { key: 'last_error', label: 'Last error' }, { key: 'delivered_at', label: 'When', render: (s) => fmtDateTime(s.delivered_at) }]} />
          </section>
          {manage && ['draft', 'issued'].includes(i.status) && (
            <section className="card">
              <form className="row" onSubmit={(e) => { e.preventDefault(); void voidIt.run(i.status === 'draft'); }}>
                <input id="inv-void-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is void" aria-label="Void reason" style={{ flex: '1 1 320px' }} />
                <button className="danger" disabled={voidIt.busy || reason.trim().length < 3}>{i.status === 'draft' ? 'Discard draft' : 'Void invoice'}</button>
                <ErrorNote message={voidIt.error} />
              </form>
            </section>
          )}
          {i.status === 'void' && <div className="notice warn">Void: {i.void_reason}</div>}
        </>
      );
    }}</Async>
  );
}
