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
const TABS = [['invoices', 'Invoices'], ['new', 'New invoice'], ['to-invoice', 'Ready to invoice'], ['collections', 'Collections'], ['payment', 'Record payment'], ['credits', 'Credit memos']] as const;

export function Receivables() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'invoices';
  const { can, me } = useAuth();
  const lite = me?.edition === 'lite';
  const open = useApi<any[]>('/api/customer-invoices?open=true');
  const issued = (open.data ?? []).filter((r) => r.status !== 'draft');
  return (
    <>
      <PageHead eyebrow="Accounts receivable" title="Customer invoices"
        sub={lite ? 'Invoice your customers, record what they pay, and follow up on what is overdue. Issued invoices and payments post to your books.'
          : 'Invoice what has shipped, record what customers pay, and work the overdue accounts. Issued invoices go to your accounting system, which stays the book of record.'} />
      <Kpis items={[
        { label: 'Open receivables', value: fmtMoney(issued.reduce((s, r) => s + r.balance, 0)) },
        { label: 'Overdue', value: fmtMoney(issued.filter((r) => r.overdue).reduce((s, r) => s + r.balance, 0)), tone: issued.some((r) => r.overdue) ? 'bad' : 'good' },
        { label: 'Drafts', value: (open.data ?? []).filter((r) => r.status === 'draft').length },
      ]} />
      <div className="row" role="tablist" aria-label="Receivables">
        {TABS.filter(([k]) => (!['payment', 'new'].includes(k) || can('ar.manage')) && !(lite && k === 'to-invoice')).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>
        ))}
      </div>
      {tab === 'invoices' && <InvoiceList />}
      {tab === 'to-invoice' && <ToInvoice />}
      {tab === 'new' && <NewInvoice />}
      {tab === 'collections' && <Collections />}
      {tab === 'payment' && <RecordPayment onDone={open.reload} />}
      {tab === 'credits' && <CreditList />}
    </>
  );
}

const CM_STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'info' | 'neutral' }> = { draft: { label: 'Draft', tone: 'info' }, issued: { label: 'Issued', tone: 'watch' }, void: { label: 'Void', tone: 'neutral' } };

/** Credit memos (D-146): returns, price corrections and goodwill credits, with what is left to apply or refund. */
function CreditList({ customerId }: { customerId?: string }) {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>(`/api/credit-memos${customerId ? `?customerId=${customerId}` : ''}`);
  return (
    <section className="card stack">
      <h2>Credit memos</h2>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data!} onRow={(r) => nav(`/receivables/credits/${r.id}`)} empty="No credit memos. Credit an invoice from its page, or a customer from their account."
          columns={[{ key: 'number', label: 'Credit memo', render: (r) => r.number ?? 'Draft' }, ...(customerId ? [] : [{ key: 'customer_name', label: 'Customer' }]),
            { key: 'invoice_number', label: 'For invoice' }, { key: 'reason', label: 'Reason' }, { key: 'total', label: 'Credit', numeric: true, render: (r: any) => fmtMoney(r.total) },
            { key: 'remaining', label: 'Left to use', numeric: true, render: (r: any) => (r.status === 'issued' ? fmtMoney(r.remaining) : '—') },
            { key: 'status', label: 'Status', render: (r: any) => <Pill tone={CM_STATUS[r.status]?.tone} label={CM_STATUS[r.status]?.label ?? r.status} /> }]} />
      )}</Async>
    </section>
  );
}

interface CreditLineDraft { description: string; qty: string; unitPrice: string; partId: string; locationId: string; lots?: string }

/** Drafts a credit memo for a customer, optionally correcting one invoice (its lines offered as a start). */
function NewCreditMemo({ customerId, invoice, facilityId }: { customerId: string; invoice?: any; facilityId?: string }) {
  const nav = useNavigate();
  const { can, me } = useAuth();
  // Returned goods go back to stock only where there is stock to go back to (not in Lite, D-135) and the user can see parts.
  const stock = me?.edition !== 'lite' && can('parts.view') && can('inventory.view');
  const parts = useApi<any[]>(stock ? '/api/parts' : null);
  const locs = useApi<any[]>(stock ? '/api/stock-locations' : null);
  const [reason, setReason] = useState('');
  const [tax, setTax] = useState('');
  const [lines, setLines] = useState<CreditLineDraft[]>(() => (invoice?.lines?.length
    ? invoice.lines.map((l: any) => ({ description: l.description, qty: '', unitPrice: String(l.unit_price), partId: '', locationId: '' }))
    : [{ description: '', qty: '1', unitPrice: '', partId: '', locationId: '' }]));
  const set = (i: number, k: keyof CreditLineDraft, v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const create = useAction(async () => {
    const m = await api.post('/api/credit-memos', { customerId, invoiceId: invoice?.id ?? null, facilityId: facilityId ?? invoice?.facility_id ?? null, reason, taxAmount: Number(tax) || 0,
      lines: lines.filter((l) => Number(l.qty) > 0).map((l) => ({ description: l.description, qty: Number(l.qty), unitPrice: Number(l.unitPrice), partId: l.partId || null, locationId: l.locationId || null, lots: l.lots?.trim() || null })) });
    nav(`/receivables/credits/${m.id}`);
  });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
      <p className="muted">{invoice ? `Enter the quantity to credit on each line of ${invoice.number}. ` : ''}Goods coming back go into the storeroom you choose when the memo is issued.</p>
      {lines.map((l, i) => (
        <div className="line-editor" key={i}>
          <input aria-label={`Credit line ${i + 1} description`} value={l.description} onChange={(e) => set(i, 'description', e.target.value)} placeholder="What is credited" required style={{ flex: '2 1 220px' }} />
          <input aria-label={`Credit line ${i + 1} quantity`} type="number" min="0" step="any" value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} placeholder="Qty" style={{ width: 80 }} />
          <input aria-label={`Credit line ${i + 1} unit price`} type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => set(i, 'unitPrice', e.target.value)} placeholder="Price" style={{ width: 110 }} />
          {stock && <select aria-label={`Credit line ${i + 1} returned part`} value={l.partId} onChange={(e) => set(i, 'partId', e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Nothing comes back</option>{(parts.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.part_number}</option>)}
          </select>}
          {l.partId && <select aria-label={`Credit line ${i + 1} storeroom`} value={l.locationId} onChange={(e) => set(i, 'locationId', e.target.value)} style={{ maxWidth: 170 }}>
            <option value="">Not into stock (scrapped)</option>{(locs.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </select>}
          {l.partId && l.locationId && (parts.data ?? []).find((p) => p.id === l.partId)?.tracking !== 'none' && (
            <input aria-label={`Credit line ${i + 1} lot or serial numbers`} value={l.lots ?? ''} onChange={(e) => set(i, 'lots', e.target.value)}
              placeholder={(parts.data ?? []).find((p) => p.id === l.partId)?.tracking === 'serial' ? 'Serial numbers, comma separated' : 'Lot returned'} style={{ width: 200 }} />
          )}
        </div>
      ))}
      <div className="row">
        <button type="button" onClick={() => setLines([...lines, { description: '', qty: '1', unitPrice: '', partId: '', locationId: '' }])}>Add a line</button>
        <label className="row">Sales tax credited<input aria-label="Sales tax credited" type="number" min="0" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} style={{ width: 110 }} /></label>
      </div>
      <label className="field">Reason (shown on the credit memo)<input id="cm-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} placeholder="e.g. one unit returned damaged" /></label>
      <ErrorNote message={create.error} />
      <div><button className="primary" disabled={create.busy || reason.trim().length < 3 || !lines.some((l) => Number(l.qty) > 0)}>Draft credit memo</button></div>
    </form>
  );
}

export function CreditMemoDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: m, loading, error, reload } = useApi<any>(`/api/credit-memos/${id}`);
  const open = useApi<any[]>(m ? `/api/customer-invoices?open=true&customerId=${m.customer_id}` : null);
  const [apply, setApply] = useState({ invoiceId: '', amount: '' });
  const [refund, setRefund] = useState({ amount: '', method: 'check', reference: '', paidOn: today() });
  const [reason, setReason] = useState('');
  const issue = useAction(async () => { await api.post(`/api/credit-memos/${id}/issue`, {}); await reload(); await open.reload(); });
  const doApply = useAction(async () => { await api.post(`/api/credit-memos/${id}/apply`, { invoiceId: apply.invoiceId, amount: Number(apply.amount) }); setApply({ invoiceId: '', amount: '' }); await reload(); await open.reload(); });
  const doRefund = useAction(async () => { await api.post(`/api/credit-memos/${id}/refund`, { ...refund, amount: Number(refund.amount), reference: refund.reference || null }); setRefund({ amount: '', method: 'check', reference: '', paidOn: today() }); await reload(); });
  const doVoid = useAction(async () => { await api.post(`/api/credit-memos/${id}/void`, { reason }); setReason(''); await reload(); });
  return (
    <Async loading={loading && !m} error={error}>{() => {
      const manage = can('ar.manage', m.facility_id);
      const invoices = (open.data ?? []).filter((x) => x.status !== 'draft' && x.balance > 0);
      return (
        <>
          <PageHead eyebrow={`${m.facility_code} · Credit memo`} title={<>{m.number ?? 'Draft credit memo'} <span className="muted" style={{ fontWeight: 400 }}>{m.customer_name}</span></>}
            sub={<>{m.reason}{m.invoice_number && <> · for <Link to={`/receivables/${m.invoice_id}`}>{m.invoice_number}</Link></>} · <Link to={`/receivables/customers/${m.customer_id}`}>Account</Link></>}
            actions={<><Pill tone={CM_STATUS[m.status]?.tone} label={CM_STATUS[m.status]?.label ?? m.status} /> <button onClick={() => api.open(`/api/credit-memos/${id}/pdf`)}>{m.status === 'draft' ? 'Preview PDF' : 'PDF'}</button></>} />
          <Kpis items={[{ label: 'Credit', value: fmtMoney(m.total) }, { label: 'Applied to invoices', value: fmtMoney(m.applied) }, { label: 'Refunded', value: fmtMoney(m.refunded) },
            { label: 'Left to use', value: fmtMoney(m.status === 'issued' ? m.remaining : 0), tone: m.status === 'issued' && m.remaining > 0 ? 'watch' : undefined }]} />
          <section className="card stack">
            <h2>Lines</h2>
            <Table rows={m.lines} columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Description' }, { key: 'qty', label: 'Qty', numeric: true, render: (l) => fmtNum(l.qty, 3) },
              { key: 'unit_price', label: 'Price', numeric: true, render: (l) => fmtMoney(l.unit_price) }, { key: 'amount', label: 'Amount', numeric: true, render: (l) => fmtMoney(l.amount) },
              { key: 'part_number', label: 'Returned', render: (l) => (l.part_number ? `${l.part_number}${l.location_code ? ` into ${l.location_code}` : ' (not into stock)'}` : '—') }]} />
            <p style={{ textAlign: 'right' }}>Subtotal {fmtMoney(m.subtotal)}{m.tax ? ` · Tax ${fmtMoney(m.tax)}` : ''} · <strong>Credit {fmtMoney(m.total)}</strong></p>
            {manage && m.status === 'draft' && (
              <div className="row"><button className="primary" onClick={() => issue.run()} disabled={issue.busy}>Issue credit memo {fmtMoney(m.total)}</button>
                <span className="faint">Issuing numbers it, stores the PDF, returns goods to stock{m.invoice_number ? `, and applies it to ${m.invoice_number}` : ''}.</span><ErrorNote message={issue.error} /></div>
            )}
          </section>
          {manage && m.status === 'issued' && m.remaining > 0 && (
            <section className="card stack">
              <h2>Use the credit</h2>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void doApply.run(); }}>
                <select aria-label="Invoice to apply to" value={apply.invoiceId} onChange={(e) => { const inv = invoices.find((x) => x.id === e.target.value); setApply({ invoiceId: e.target.value, amount: inv ? String(Math.min(inv.balance, m.remaining)) : '' }); }}>
                  <option value="">Apply to an open invoice…</option>{invoices.map((x) => <option key={x.id} value={x.id}>{x.number} · owes {fmtMoney(x.balance)}</option>)}
                </select>
                <input aria-label="Amount to apply" type="number" min="0" step="0.01" value={apply.amount} onChange={(e) => setApply({ ...apply, amount: e.target.value })} style={{ width: 120 }} />
                <button disabled={doApply.busy || !apply.invoiceId || !(Number(apply.amount) > 0)}>Apply</button>
              </form>
              <ErrorNote message={doApply.error} />
              <form className="row" onSubmit={(e) => { e.preventDefault(); void doRefund.run(); }}>
                <span>Or refund</span>
                <input aria-label="Refund amount" type="number" min="0" step="0.01" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} placeholder={fmtMoney(m.remaining)} style={{ width: 120 }} />
                <select aria-label="Refund method" value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>{['check', 'ach', 'wire', 'card', 'other'].map((x) => <option key={x} value={x}>{x.toUpperCase() === 'ACH' ? 'ACH' : humanize(x)}</option>)}</select>
                <input aria-label="Refund reference" value={refund.reference} onChange={(e) => setRefund({ ...refund, reference: e.target.value })} placeholder="Check or reference" style={{ width: 150 }} />
                <input aria-label="Refund date" type="date" value={refund.paidOn} onChange={(e) => setRefund({ ...refund, paidOn: e.target.value })} />
                <button disabled={doRefund.busy || !(Number(refund.amount) > 0)}>Record refund</button>
              </form>
              <ErrorNote message={doRefund.error} />
            </section>
          )}
          {(m.applications.length > 0 || m.refunds.length > 0) && (
            <section className="card">
              <h2>Where the credit went</h2>
              <Table rows={[...m.applications.map((a: any) => ({ ...a, what: <>Applied to <Link to={`/receivables/${a.invoice_id}`}>{a.invoice_number}</Link></>, on: a.applied_on })),
                ...m.refunds.map((r: any) => ({ ...r, what: `Refunded by ${humanize(r.method)}${r.reference ? ` (${r.reference})` : ''}`, on: r.paid_on }))]}
                columns={[{ key: 'on', label: 'Date', render: (r) => fmtDate(r.on) }, { key: 'what', label: 'What', render: (r) => r.what }, { key: 'amount', label: 'Amount', numeric: true, render: (r) => fmtMoney(r.amount) }]} />
            </section>
          )}
          {manage && m.status !== 'void' && m.applied === 0 && m.refunded === 0 && (
            <section className="card">
              <form className="row" onSubmit={(e) => { e.preventDefault(); void doVoid.run(); }}>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is void" aria-label="Void reason" style={{ flex: '1 1 320px' }} />
                <button className="danger" disabled={doVoid.busy || reason.trim().length < 3}>{m.status === 'draft' ? 'Discard draft' : 'Void credit memo'}</button>
                <ErrorNote message={doVoid.error} />
              </form>
            </section>
          )}
          {m.status === 'void' && <div className="notice warn">Void: {m.void_reason}</div>}
        </>
      );
    }}</Async>
  );
}

const INCOME: [string, string][] = [['service_revenue', 'Services'], ['sales_revenue', 'Products'], ['rental_income', 'Rent'], ['freight_income', 'Freight']];

/** A simple invoice typed in (no sales order); it stays a draft until issued from its page. */
function NewInvoice() {
  const nav = useNavigate();
  const customers = useApi<any[]>('/api/customers');
  const blank = () => ({ description: '', qty: '1', unitPrice: '', accountKey: 'service_revenue' });
  const [f, setF] = useState({ customerId: '', customerPo: '', taxAmount: '' });
  const [lines, setLines] = useState([blank()]);
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.unitPrice || 0), 0) + Number(f.taxAmount || 0);
  const save = useAction(async () => {
    const inv = await api.post('/api/customer-invoices', { customerId: f.customerId, customerPo: f.customerPo || null, taxAmount: Number(f.taxAmount || 0),
      lines: lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description, qty: Number(l.qty), unitPrice: Number(l.unitPrice), accountKey: l.accountKey })) });
    nav(`/receivables/${inv.id}`);
  });
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <section className="card stack">
      <h2>New invoice</h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="row">
          <select id="ni-customer" aria-label="Customer" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} required>
            <option value="">Customer…</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input id="ni-po" aria-label="Customer PO" placeholder="Their PO (optional)" value={f.customerPo} onChange={(e) => setF({ ...f, customerPo: e.target.value })} style={{ maxWidth: 220 }} />
        </div>
        {lines.map((l, i) => (
          <div key={i} className="row">
            <input aria-label={`Line ${i + 1} description`} placeholder="Description" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} style={{ flex: '2 1 260px' }} />
            <input aria-label={`Line ${i + 1} quantity`} type="number" min="0.001" step="any" value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} style={{ width: 90 }} />
            <input aria-label={`Line ${i + 1} price`} type="number" min="0" step="0.01" placeholder="Price" value={l.unitPrice} onChange={(e) => set(i, 'unitPrice', e.target.value)} style={{ width: 120 }} />
            <select aria-label={`Line ${i + 1} income type`} value={l.accountKey} onChange={(e) => set(i, 'accountKey', e.target.value)}>{INCOME.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </div>
        ))}
        <div className="row"><button type="button" onClick={() => setLines([...lines, blank()])}>Add line</button>
          <label className="row">Sales tax $<input id="ni-tax" type="number" min="0" step="0.01" value={f.taxAmount} onChange={(e) => setF({ ...f, taxAmount: e.target.value })} style={{ width: 100 }} /></label>
          <strong>Total {fmtMoney(total)}</strong></div>
        <div><button className="primary" disabled={save.busy}>Create draft</button></div>
        <ErrorNote message={save.error} />
      </form>
    </section>
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
        <CreditList customerId={id} />
        {can('ar.manage') && <RecordPayment customerId={id} onDone={reload} />}
        {can('ar.manage') && a.paymentsManual && (
          <section className="card stack"><h2>New credit memo</h2><NewCreditMemo customerId={id!} /></section>
        )}
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
          {manage && i.paymentsManual && ['issued', 'partially_paid', 'paid'].includes(i.status) && (
            <details className="card">
              <summary><strong>Credit this invoice</strong> <span className="faint">(a return, a price correction or goodwill)</span></summary>
              <NewCreditMemo customerId={i.customer_id} invoice={i} />
            </details>
          )}
          <section className="card">
            <h2>Payments</h2>
            <Table rows={i.payments} empty="No payments yet."
              columns={[{ key: 'received_on', label: 'Received', render: (p) => fmtDate(p.received_on) }, { key: 'method', label: 'Method', render: (p) => humanize(p.method) },
                { key: 'reference', label: 'Reference' }, { key: 'source', label: 'From', render: (p) => (p.source === 'accounting' ? 'Accounting system' : 'Recorded here') },
                { key: 'amount', label: 'Applied', numeric: true, render: (p) => fmtMoney(p.amount) }]} />
          </section>
          <section className="card">
            <h2>History</h2>
            <Table rows={i.activity} empty="Nothing yet."
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
