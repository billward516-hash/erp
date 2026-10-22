import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct, humanize, roleLabel } from '../format';
import { useAction, useApi } from '../hooks';

const Q_STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  draft: { label: 'Draft', tone: 'neutral' }, pending_approval: { label: 'Pricing approval', tone: 'info' }, approved: { label: 'Ready to send', tone: 'watch' },
  sent: { label: 'Sent', tone: 'info' }, accepted: { label: 'Accepted', tone: 'good' }, declined: { label: 'Declined', tone: 'bad' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const QuoteStatus = ({ v, expired }: { v: string; expired?: boolean }) => <>{<Pill tone={Q_STATUS[v]?.tone} label={Q_STATUS[v]?.label ?? v} />}{expired && <> <Pill tone="bad" label="Expired" /></>}</>;
const O_STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  open: { label: 'Open', tone: 'info' }, partially_shipped: { label: 'Partly shipped', tone: 'watch' }, shipped: { label: 'Shipped', tone: 'good' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const OrderStatus = ({ v, late }: { v: string; late?: boolean }) => <>{<Pill tone={O_STATUS[v]?.tone} label={O_STATUS[v]?.label ?? v} />}{late && <> <Pill tone="bad" label="Late" /></>}</>;

export function Sales() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'quotes' | 'orders' | 'catalog'>('quotes');
  return (
    <>
      <PageHead eyebrow="Sales" title="Quotes and orders" sub={`Quotes over ${15}% below list price or under ${20}% margin need a sales manager's approval. Accepting a quote creates the order.`} />
      <div className="row" role="tablist">
        {(['quotes', 'orders', 'catalog'] as const).filter((t) => t !== 'catalog' || can('sales.view')).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>{humanize(t)}</button>))}
      </div>
      {tab === 'quotes' && <QuoteList />}
      {tab === 'orders' && <OrderList />}
      {tab === 'catalog' && <Catalog />}
    </>
  );
}

function QuoteList() {
  const nav = useNavigate();
  const [open, setOpen] = useState(true);
  const { data, loading, error } = useApi<any[]>(`/api/quotes${open ? '?open=true' : ''}`);
  return (
    <section className="card stack">
      <label className="row"><input id="q-open" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only open quotes</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(q) => nav(`/sales/quotes/${q.id}`)} exception={(q) => q.expired} empty="No quotes. Start one from a customer."
          columns={[{ key: 'number', label: 'Quote', render: (q) => <strong>{q.number} <span className="faint">rev {q.revision}</span></strong> }, { key: 'customer_name', label: 'Customer' },
            { key: 'title', label: 'Title' }, { key: 'total', label: 'Total', numeric: true, render: (q) => fmtMoney(q.total) }, { key: 'valid_until', label: 'Valid until', render: (q) => fmtDate(q.valid_until) },
            { key: 'status', label: 'Status', render: (q) => <QuoteStatus v={q.status} expired={q.expired} /> }, { key: 'created_by_name', label: 'By' }]} />
      )}</Async>
    </section>
  );
}

function OrderList() {
  const nav = useNavigate();
  const [open, setOpen] = useState(true);
  const { data, loading, error } = useApi<any[]>(`/api/sales-orders${open ? '?open=true' : ''}`);
  return (
    <section className="card stack">
      <label className="row"><input id="so-open" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only open orders</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(o) => nav(`/sales/orders/${o.id}`)} exception={(o) => o.late} empty="No orders."
          columns={[{ key: 'number', label: 'Order', render: (o) => <strong>{o.number}</strong> }, { key: 'customer_name', label: 'Customer' }, { key: 'customer_po', label: 'Their PO' },
            { key: 'total', label: 'Total', numeric: true, render: (o) => fmtMoney(o.total) }, { key: 'promised_date', label: 'Promised', render: (o) => fmtDate(o.promised_date) },
            { key: 'status', label: 'Status', render: (o) => <OrderStatus v={o.status} late={o.late} /> }]} />
      )}</Async>
    </section>
  );
}

function Catalog() {
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>('/api/sales-items');
  const parts = useApi<any[]>(can('sales.orders') ? '/api/parts' : null);
  const [f, setF] = useState({ code: '', description: '', kind: 'product', uom: 'EA', listPrice: '', unitCost: '', partId: '' });
  const act = useAction(async () => {
    await api.post('/api/sales-items', { ...f, listPrice: f.listPrice ? Number(f.listPrice) : null, unitCost: f.unitCost ? Number(f.unitCost) : null, partId: f.partId || null, kind: f.kind });
    setF({ code: '', description: '', kind: 'product', uom: 'EA', listPrice: '', unitCost: '', partId: '' }); await reload();
  });
  return (
    <section className="card stack">
      <Table rows={data ?? []} empty="No catalog items yet."
        columns={[{ key: 'code', label: 'Code' }, { key: 'description', label: 'Description' }, { key: 'kind', label: 'Kind', render: (i) => humanize(i.kind) }, { key: 'uom', label: 'UOM' },
          { key: 'list_price', label: 'List price', numeric: true, render: (i) => fmtMoney(i.list_price) }, { key: 'unit_cost', label: 'Std cost', numeric: true, render: (i) => fmtMoney(i.unit_cost) },
          { key: 'part_number', label: 'Ships from stock as' }]} />
      {can('sales.orders') && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <input aria-label="Code" placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required style={{ width: 110 }} />
          <input aria-label="Description" placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required style={{ flex: '1 1 200px' }} />
          <select aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="product">Product</option><option value="service">Service</option></select>
          <input aria-label="List price" placeholder="List price" type="number" min="0" step="any" value={f.listPrice} onChange={(e) => setF({ ...f, listPrice: e.target.value })} style={{ width: 100 }} />
          <input aria-label="Standard cost" placeholder="Std cost" type="number" min="0" step="any" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} style={{ width: 100 }} />
          <select aria-label="Stocked part" value={f.partId} onChange={(e) => setF({ ...f, partId: e.target.value })} style={{ maxWidth: 200 }}>
            <option value="">Not stocked</option>{(parts.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.part_number}</option>)}</select>
          <button disabled={act.busy}>Add item</button>
          <ErrorNote message={act.error} />
        </form>
      )}
    </section>
  );
}

interface Line { itemId: string; description: string; qty: string; unitPrice: string }
const blank = (): Line => ({ itemId: '', description: '', qty: '1', unitPrice: '' });

function QuoteLines({ lines, setLines, items }: { lines: Line[]; setLines: (l: Line[]) => void; items: any[] }) {
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.unitPrice || items.find((x) => x.id === l.itemId)?.list_price || 0), 0);
  return (
    <div className="stack">
      {lines.map((l, i) => {
        const item = items.find((x) => x.id === l.itemId);
        const price = l.unitPrice === '' ? item?.list_price : Number(l.unitPrice);
        const disc = item?.list_price && price != null ? 1 - Number(price) / Number(item.list_price) : null;
        return (
          <div className="line-editor" key={i}>
            <select aria-label={`Line ${i + 1} item`} value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value })}>
              <option value="">Not in the catalog (describe it)</option>{items.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.description} · {fmtMoney(x.list_price)}</option>)}
            </select>
            {!l.itemId && <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Description" />}
            <input aria-label={`Line ${i + 1} quantity`} type="number" min="0.001" step="any" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} style={{ width: 80 }} />
            <input aria-label={`Line ${i + 1} unit price`} type="number" min="0" step="any" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })}
              placeholder={item ? `List ${fmtMoney(item.list_price)}` : 'Unit price'} style={{ width: 130 }} />
            {disc != null && disc > 0.0001 && <Pill tone={disc > 0.15 ? 'bad' : 'neutral'} label={`${fmtPct(disc)} off list`} />}
            <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}>Remove</button>
          </div>
        );
      })}
      <div className="spread"><button type="button" onClick={() => setLines([...lines, blank()])}>Add a line</button><strong>Total {fmtMoney(total)}</strong></div>
    </div>
  );
}
const toPayload = (l: Line) => ({ itemId: l.itemId || null, description: l.description || null, qty: Number(l.qty), unitPrice: l.unitPrice === '' ? null : Number(l.unitPrice) });

export function NewQuote() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const customers = useApi<any[]>('/api/customers');
  const facilities = useApi<any[]>('/api/facilities');
  const items = useApi<any[]>('/api/sales-items');
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const cust = useApi<any>(customerId ? `/api/customers/${customerId}` : null);
  const allowed = (facilities.data ?? []).filter((f) => can('sales.quote', f.id));
  const [f, setF] = useState({ facilityId: '', title: '', contactId: '', opportunityId: '', validUntil: '', notes: '' });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const facilityId = f.facilityId || allowed[0]?.id || '';
  const act = useAction(async () => {
    const q = await api.post('/api/quotes', { facilityId, customerId, title: f.title, contactId: f.contactId || null, opportunityId: f.opportunityId || null,
      validUntil: f.validUntil || null, notes: f.notes || null, lines: lines.map(toPayload) });
    nav(`/sales/quotes/${q.id}`);
  });
  return (
    <>
      <PageHead eyebrow="Sales" title="New quote" sub="Saved as a draft. You can preview the PDF before finishing it." />
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Customer<select id="q-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Choose…</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">Title<input id="q-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /></label>
            <label className="field">Contact<select id="q-contact" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
              <option value="">—</option>{(cust.data?.contacts ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">Opportunity<select id="q-opp" value={f.opportunityId} onChange={(e) => setF({ ...f, opportunityId: e.target.value })}>
              <option value="">—</option>{(cust.data?.opportunities ?? []).filter((o: any) => !['won', 'lost'].includes(o.stage)).map((o: any) => <option key={o.id} value={o.id}>{o.title}</option>)}</select></label>
            <label className="field">Selling site<select id="q-fac" value={facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>
              {allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
            <label className="field">Valid until<input id="q-valid" type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} title="Default: 30 days" /></label>
          </div>
          <h3>Lines</h3>
          <QuoteLines lines={lines} setLines={setLines} items={items.data ?? []} />
          <label className="field">Notes shown on the quote<textarea id="q-notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy || !customerId}>Save draft</button></div>
        </form>
      </section>
    </>
  );
}

export function QuoteDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: q, loading, error, reload } = useApi<any>(`/api/quotes/${id}`);
  const items = useApi<any[]>('/api/sales-items');
  const [editing, setEditing] = useState<Line[] | null>(null);
  const [text, setText] = useState('');
  const [po, setPo] = useState('');
  const save = useAction(async () => { await api.patch(`/api/quotes/${id}`, { lines: editing!.map(toPayload) }); setEditing(null); await reload(); });
  const submit = useAction(async () => { await api.post(`/api/quotes/${id}/submit`); await reload(); });
  const send = useAction(async () => { await api.post(`/api/quotes/${id}/send`, { sentTo: text || null }); setText(''); await reload(); });
  const revise = useAction(async () => { await api.post(`/api/quotes/${id}/revise`, { reason: text }); setText(''); await reload(); });
  const accept = useAction(async () => { const so = await api.post(`/api/quotes/${id}/accept`, { customerPo: po || null }); nav(`/sales/orders/${so.id}`); });
  const decline = useAction(async () => { await api.post(`/api/quotes/${id}/decline`, { reason: text }); setText(''); await reload(); });
  return (
    <Async loading={loading && !q} error={error}>{() => {
      const mine = can('sales.quote', q.facility_id);
      const err = save.error ?? submit.error ?? send.error ?? revise.error ?? accept.error ?? decline.error;
      return (
        <>
          <PageHead eyebrow={`${q.facility_code} · Quote · revision ${q.revision}`} title={<>{q.number} <span className="muted" style={{ fontWeight: 400 }}>{q.title}</span></>}
            sub={<><Link to={`/crm/customers/${q.customer_id}`}>{q.customer_name}</Link>{q.contact_name ? ` · ${q.contact_name}` : ''} · valid until {fmtDate(q.valid_until)}{q.opportunity_title ? ` · ${q.opportunity_title}` : ''}</>}
            actions={<><QuoteStatus v={q.status} expired={q.expired} /><button onClick={() => api.open(`/api/quotes/${q.id}/pdf?preview=true`)}>Preview PDF</button></>} />
          {q.approval_reasons?.length > 0 && q.status !== 'accepted' && <div className="notice warn">Needs a sales manager's approval: {q.approval_reasons.join('; ')}.</div>}
          <section className="card stack">
            <div className="spread"><h2>Lines</h2><div className="row"><strong>{fmtMoney(q.total)}</strong><span className="muted">margin {q.margin == null ? '—' : fmtPct(q.margin)} (internal)</span></div></div>
            {editing ? (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
                <QuoteLines lines={editing} setLines={setEditing} items={items.data ?? []} />
                <div className="row"><button className="primary" disabled={save.busy}>Save lines</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
              </form>
            ) : (
              <>
                <Table rows={q.lines} rowKey={(l) => String(l.line_no)}
                  columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Description' }, { key: 'qty', label: 'Qty', numeric: true, render: (l) => fmtNum(l.qty, 3) },
                    { key: 'list_price', label: 'List', numeric: true, render: (l) => fmtMoney(l.list_price) }, { key: 'unit_price', label: 'Price', numeric: true, render: (l) => fmtMoney(l.unit_price) },
                    { key: 'discount', label: 'Off list', numeric: true, render: (l) => (l.discount ? fmtPct(l.discount) : '—') }, { key: 'amount', label: 'Amount', numeric: true, render: (l) => fmtMoney(l.amount) }]} />
                {mine && q.status === 'draft' && <div><button onClick={() => setEditing(q.lines.map((l: any) => ({ itemId: '', description: l.description, qty: String(l.qty), unitPrice: String(l.unit_price) })))}>Edit lines</button></div>}
              </>
            )}
          </section>
          {mine && (
            <section className="card stack">
              <h2>Next step</h2>
              {q.status === 'draft' && <div><button className="primary" disabled={submit.busy} onClick={() => submit.run()}>Finish quote</button> <span className="muted">Checks pricing; goes to a sales manager only if it is outside the limits.</span></div>}
              {q.status === 'pending_approval' && <p className="muted">Waiting for a sales manager to approve the pricing.</p>}
              {q.status === 'approved' && (
                <div className="row"><input id="q-sendto" aria-label="Send to" placeholder={q.contact_email ?? 'Recipient email'} value={text} onChange={(e) => setText(e.target.value)} style={{ width: 240 }} />
                  <button className="primary" disabled={send.busy} onClick={() => send.run()}>Mark as sent (stores the PDF)</button></div>
              )}
              {q.status === 'sent' && (
                <div className="stack">
                  <div className="row"><input id="q-po" aria-label="Customer PO" placeholder="Customer PO number" value={po} onChange={(e) => setPo(e.target.value)} style={{ width: 200 }} />
                    <button className="primary" disabled={accept.busy || q.expired} onClick={() => accept.run()}>Customer accepted: create order</button></div>
                  {q.expired && <p className="muted">This quote has expired. Revise it to confirm prices before accepting.</p>}
                </div>
              )}
              {['pending_approval', 'approved', 'sent', 'declined'].includes(q.status) && (
                <div className="row">
                  <input id="q-reason" aria-label="Reason" placeholder={q.status === 'sent' ? 'Reason (revise or declined)' : 'What changes in the new revision'} value={text} onChange={(e) => setText(e.target.value)} style={{ flex: '1 1 260px' }} />
                  <button disabled={revise.busy || text.trim().length < 3} onClick={() => revise.run()}>New revision</button>
                  {q.status === 'sent' && <button className="danger" disabled={decline.busy || text.trim().length < 3} onClick={() => decline.run()}>Customer declined</button>}
                </div>
              )}
              {q.status === 'accepted' && q.order && <p>Order <Link to={`/sales/orders/${q.order.id}`}>{q.order.number}</Link>{q.customer_po ? ` (their PO ${q.customer_po})` : ''}.</p>}
              {q.status === 'declined' && <p className="muted">Declined: {q.decline_reason}</p>}
              <ErrorNote message={err} />
            </section>
          )}
          <div className="grid two">
            <section className="card">
              <h2>Sent</h2>
              <Table rows={q.sent} rowKey={(s) => String(s.revision)} empty="Not sent yet."
                columns={[{ key: 'revision', label: 'Rev', numeric: true }, { key: 'total', label: 'Total', numeric: true, render: (s) => fmtMoney(s.total) }, { key: 'sent_to', label: 'To' },
                  { key: 'sent_at', label: 'When', render: (s) => `${fmtDateTime(s.sent_at)} by ${s.sent_by}` },
                  { key: 'pdf', label: '', render: (s) => <button onClick={() => api.open(`/api/quotes/${q.id}/pdf?revision=${s.revision}`)}>PDF</button> }]} />
            </section>
            <section className="card">
              <h2>Pricing approvals</h2>
              <Table rows={q.approvals.flatMap((a: any) => a.steps.map((s: any) => ({ ...s, rev: a.subject_revision, req: a.status })))} empty="None needed so far."
                columns={[{ key: 'rev', label: 'Rev', numeric: true }, { key: 'role_key', label: 'Role', render: (s) => roleLabel(s.role_key) }, { key: 'status', label: 'Status', render: (s) => humanize(s.status) },
                  { key: 'decided_by', label: 'By' }, { key: 'comment', label: 'Comment' }]} />
            </section>
          </div>
        </>
      );
    }}</Async>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: o, loading, error, reload } = useApi<any>(`/api/sales-orders/${id}`);
  const [promised, setPromised] = useState('');
  const promise = useAction(async () => { await api.post(`/api/sales-orders/${id}/promise`, { promisedDate: promised }); await reload(); });
  const nav = useNavigate();
  const [release, setRelease] = useState('');
  const invoice = useAction(async () => { const inv = await api.post(`/api/sales-orders/${id}/invoice`, {}); nav(`/receivables/${inv.id}`); });
  const releaseHold = useAction(async () => { await api.post(`/api/sales-orders/${id}/release-credit`, { note: release }); setRelease(''); await reload(); });
  return (
    <Async loading={loading && !o} error={error}>{() => {
      const manage = can('sales.orders', o.facility_id);
      return (
        <>
          <PageHead eyebrow={`${o.facility_code} · Sales order`} title={<>{o.number} <span className="muted" style={{ fontWeight: 400 }}>{o.customer_name}</span></>}
            sub={<>{o.customer_po ? `Their PO ${o.customer_po} · ` : ''}{o.quote_number ? <>from <Link to={`/sales/quotes/${o.quote_id}`}>{o.quote_number}</Link> · </> : ''}promised {fmtDate(o.promised_date)}</>}
            actions={<OrderStatus v={o.status} late={o.late} />} />
          {o.credit_hold && (
            <section className="card stack" style={{ borderColor: 'var(--bad)' }}>
              <div className="notice error"><strong>Credit hold.</strong> {o.credit_hold_note} Nothing can ship until finance releases the order.</div>
              {can('ar.credit', o.facility_id) && (
                <form className="row" onSubmit={(e) => { e.preventDefault(); void releaseHold.run(); }}>
                  <input id="so-release" aria-label="Why it can ship" placeholder="Why it can ship (payment received, limit raised, prepaid…)" value={release} onChange={(e) => setRelease(e.target.value)} style={{ flex: '1 1 320px' }} />
                  <button className="primary" disabled={releaseHold.busy || release.trim().length < 3}>Release hold</button>
                  <ErrorNote message={releaseHold.error} />
                </form>
              )}
            </section>
          )}
          {!o.credit_hold && o.credit_hold_note && <div className="notice ok">{o.credit_hold_note}</div>}
          <section className="card stack">
            <div className="spread"><h2>Lines</h2><strong>{fmtMoney(o.total)}</strong></div>
            <Table rows={o.lines}
              columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Description' }, { key: 'qty', label: 'Ordered', numeric: true, render: (l) => fmtNum(l.qty, 3) },
                { key: 'qty_shipped', label: 'Shipped', numeric: true, render: (l) => fmtNum(l.qty_shipped, 3) }, { key: 'qty_invoiced', label: 'Invoiced', numeric: true, render: (l) => fmtNum(l.qty_invoiced, 3) },
                { key: 'unit_price', label: 'Price', numeric: true, render: (l) => fmtMoney(l.unit_price) },
                { key: 'amount', label: 'Amount', numeric: true, render: (l) => fmtMoney(l.amount) },
                { key: 'stock', label: 'Stock', render: (l) => (l.stock ? l.stock.map((s: any) => `${s.location} ${fmtNum(s.on_hand, 3)}`).join(', ') : l.item_kind === 'service' ? 'service' : '—') }]} />
            {manage && ['open', 'partially_shipped'].includes(o.status) && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void promise.run(); }}>
                <label className="row">Promise ship date<input id="so-promise" type="date" value={promised} onChange={(e) => setPromised(e.target.value)} required /></label>
                <button disabled={promise.busy}>Set</button><ErrorNote message={promise.error} />
              </form>
            )}
          </section>
          {manage && !o.credit_hold && ['open', 'partially_shipped'].includes(o.status) && <ShipForm o={o} onDone={reload} />}
          <section className="card">
            <h2>Shipments</h2>
            <Table rows={o.shipments} empty="Nothing shipped yet."
              columns={[{ key: 'number', label: 'Shipment' }, { key: 'shipped_on', label: 'Shipped', render: (s) => fmtDate(s.shipped_on) }, { key: 'carrier', label: 'Carrier' }, { key: 'tracking', label: 'Tracking' },
                { key: 'lines', label: 'Lines', render: (s) => (s.lines ?? []).map((l: any) => `#${l.line_no} × ${fmtNum(l.qty, 3)}${l.location ? ` from ${l.location}` : ''}`).join(', ') },
                { key: 'created_by_name', label: 'By' }]} />
          </section>
          {can('ar.view', o.facility_id) && (
            <section className="card stack">
              <div className="spread"><h2>Invoices</h2>
                {can('ar.manage', o.facility_id) && o.lines.some((l: any) => l.qty_shipped > l.qty_invoiced) && !o.invoices.some((x: any) => x.status === 'draft') && (
                  <button className="primary" onClick={() => invoice.run()} disabled={invoice.busy}>Invoice what has shipped</button>)}</div>
              <ErrorNote message={invoice.error} />
              <Table rows={o.invoices} onRow={(x) => nav(`/receivables/${x.id}`)} empty="Not invoiced yet."
                columns={[{ key: 'number', label: 'Invoice', render: (x) => x.number ?? 'Draft' }, { key: 'invoice_date', label: 'Dated', render: (x) => fmtDate(x.invoice_date) },
                  { key: 'due_date', label: 'Due', render: (x) => fmtDate(x.due_date) }, { key: 'total', label: 'Amount', numeric: true, render: (x) => fmtMoney(x.total) },
                  { key: 'status', label: 'Status', render: (x) => humanize(x.status) }]} />
            </section>
          )}
        </>
      );
    }}</Async>
  );
}

function ShipForm({ o, onDone }: { o: any; onDone: () => void }) {
  const open = o.lines.filter((l: any) => l.qty_shipped < l.qty);
  // Default to what can actually ship: the open quantity, capped by stock in the first storeroom for stocked items.
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l: any) => [l.id,
    String(Math.max(0, Math.min(l.qty - l.qty_shipped, l.stock ? Number(l.stock[0]?.on_hand ?? 0) : Infinity)))])));
  const [loc, setLoc] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l: any) => [l.id, l.stock?.[0]?.location_id ?? ''])));
  const [f, setF] = useState({ carrier: '', tracking: '' });
  const act = useAction(async () => {
    await api.post(`/api/sales-orders/${o.id}/ship`, { carrier: f.carrier || null, tracking: f.tracking || null,
      lines: open.filter((l: any) => Number(qty[l.id]) > 0).map((l: any) => ({ orderLineId: l.id, qty: Number(qty[l.id]), locationId: l.stock ? loc[l.id] || null : null })) });
    onDone();
  });
  return (
    <section className="card stack">
      <h2>Ship</h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
        <Table rows={open} columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Item' },
          { key: 'left', label: 'To ship', numeric: true, render: (l) => fmtNum(l.qty - l.qty_shipped, 3) },
          { key: 'qty', label: 'Shipping now', numeric: true, render: (l) => <input aria-label={`Ship qty line ${l.line_no}`} type="number" min="0" max={l.qty - l.qty_shipped} step="any" value={qty[l.id] ?? ''}
            onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} style={{ width: 90 }} /> },
          { key: 'from', label: 'From', render: (l) => (l.stock ? (
            <select aria-label={`Ship from line ${l.line_no}`} value={loc[l.id] ?? ''} onChange={(e) => setLoc({ ...loc, [l.id]: e.target.value })}>
              {l.stock.map((s: any) => <option key={s.location_id} value={s.location_id}>{s.location} ({fmtNum(s.on_hand, 3)} on hand)</option>)}</select>) : <span className="faint">not stocked</span>) }]} />
        <div className="row">
          <input id="ship-carrier" aria-label="Carrier" placeholder="Carrier" value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} style={{ width: 140 }} />
          <input id="ship-tracking" aria-label="Tracking" placeholder="Tracking number" value={f.tracking} onChange={(e) => setF({ ...f, tracking: e.target.value })} style={{ width: 180 }} />
          <button className="primary" disabled={act.busy}>Record shipment</button>
        </div>
        <ErrorNote message={act.error} />
      </form>
    </section>
  );
}
