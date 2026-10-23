import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Attachments, RFQ_ACCEPT } from '../components/Attachments';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  received: { label: 'Needs a decision', tone: 'watch' }, bid: { label: 'Bidding', tone: 'info' }, no_bid: { label: 'No bid', tone: 'neutral' }, quoted: { label: 'Quoted', tone: 'info' },
  won: { label: 'Won', tone: 'good' }, lost: { label: 'Lost', tone: 'bad' }, cancelled: { label: 'Withdrawn', tone: 'neutral' },
};
const Status = ({ r }: { r: any }) => <><Pill tone={STATUS[r.status]?.tone} label={STATUS[r.status]?.label ?? r.status} />{r.overdue && <> <Pill tone="bad" label="Reply late" /></>}</>;
const left = (d: number) => (d < 0 ? `${-d} day${d === -1 ? '' : 's'} late` : d === 0 ? 'Today' : `${d} day${d === 1 ? '' : 's'}`);

/** Requests for quote received from customers, as a tab on the Sales page (SC-005 B). */
export function CustomerRfqList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(true);
  const board = useApi<any>('/api/customer-rfqs/board');
  const { data, loading, error } = useApi<any[]>(`/api/customer-rfqs${open ? '?open=true' : ''}`);
  const b = board.data;
  return (
    <section className="stack" aria-label="Customer requests for quote">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>Requests that customers send us. Record each one when it arrives, with the reply date, so nothing is missed; the quote you build from it keeps the status current.</p>
        {can('sales.quote') && <button className="primary" onClick={() => nav('/sales/rfq/new')}>Record a request</button>}
      </div>
      {b && <Kpis items={[{ label: 'Past the reply date', value: b.overdue.length, tone: b.overdue.length ? 'bad' : 'good' }, { label: 'Due today', value: b.today.length, tone: b.today.length ? 'watch' : 'good' },
        { label: 'Due in 7 days', value: b.thisWeek.length }, { label: 'Waiting for bid or no-bid', value: b.awaitingDecision, tone: b.awaitingDecision ? 'watch' : undefined }]} />}
      <label className="row"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only open requests</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(r) => r.id} onRow={(r) => nav(`/sales/rfq/${r.id}`)} exception={(r) => r.overdue} empty="No customer requests recorded."
          columns={[{ key: 'number', label: 'Request' }, { key: 'customer_name', label: 'Customer' }, { key: 'customer_ref', label: 'Their reference' }, { key: 'subject', label: 'Subject' },
            { key: 'response_due', label: 'Reply by', render: (r) => fmtDate(r.response_due) },
            { key: 'days_left', label: 'Time left', render: (r) => (['received', 'bid'].includes(r.status) ? left(r.days_left) : '—'), value: (r) => (['received', 'bid'].includes(r.status) ? r.days_left : null) },
            { key: 'owner_name', label: 'Owner' }, { key: 'status', label: 'Status', render: (r) => <Status r={r} />, value: (r) => r.status }]} />
      )}</Async>
    </section>
  );
}

export function NewCustomerRfq() {
  const nav = useNavigate();
  const { can } = useAuth();
  const customers = useApi<any[]>('/api/customers');
  const facilities = useApi<any[]>('/api/facilities');
  const [customerId, setCustomerId] = useState('');
  const cust = useApi<any>(customerId ? `/api/customers/${customerId}` : null);
  const allowed = (facilities.data ?? []).filter((f) => can('sales.quote', f.id));
  const [f, setF] = useState({ facilityId: '', contactId: '', customerRef: '', subject: '', scope: '', source: 'email', receivedOn: new Date().toISOString().slice(0, 10), responseDue: '' });
  const facilityId = f.facilityId || allowed[0]?.id || '';
  const act = useAction(async () => {
    const r = await api.post('/api/customer-rfqs', { facilityId, customerId, contactId: f.contactId || null, customerRef: f.customerRef || null, subject: f.subject, scope: f.scope || null,
      source: f.source, receivedOn: f.receivedOn, responseDue: f.responseDue });
    nav(`/sales/rfq/${r.id}`);
  });
  return (
    <>
      <PageHead eyebrow="Sales" title="Record a customer request" sub="Enter the request as it arrived, then add the files the customer sent on the next page." />
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Customer<select id="crfq-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Choose…</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">Contact<select id="crfq-contact" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
              <option value="">—</option>{(cust.data?.contacts ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">Their reference<input id="crfq-ref" value={f.customerRef} onChange={(e) => setF({ ...f, customerRef: e.target.value })} placeholder="Their RFQ number" /></label>
            <label className="field">How it arrived<select id="crfq-source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
              {['email', 'portal', 'phone', 'meeting', 'other'].map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}</select></label>
            <label className="field">Received on<input id="crfq-received" type="date" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} required /></label>
            <label className="field">Reply due by<input id="crfq-due" type="date" value={f.responseDue} min={f.receivedOn} onChange={(e) => setF({ ...f, responseDue: e.target.value })} required /></label>
            <label className="field">Quoting site<select id="crfq-fac" value={facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>
              {allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
          </div>
          <label className="field">Subject<input id="crfq-subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required minLength={3} /></label>
          <label className="field">What they are asking for<textarea id="crfq-scope" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></label>
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy || !customerId}>Record request</button></div>
        </form>
      </section>
    </>
  );
}

export function CustomerRfqDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: r, loading, error, reload } = useApi<any>(`/api/customer-rfqs/${id}`);
  const [reason, setReason] = useState('');
  const [due, setDue] = useState('');
  const decide = useAction(async (decision: 'bid' | 'no_bid') => { await api.post(`/api/customer-rfqs/${id}/decision`, { decision, reason: reason || null }); setReason(''); await reload(); });
  const close = useAction(async (outcome: 'cancelled' | 'lost') => { await api.post(`/api/customer-rfqs/${id}/close`, { outcome, reason }); setReason(''); await reload(); });
  const move = useAction(async () => { await api.patch(`/api/customer-rfqs/${id}`, { responseDue: due }); setDue(''); await reload(); });
  return (
    <Async loading={loading && !r} error={error}>{() => {
      const open = ['received', 'bid'].includes(r.status);
      const mayAct = can('sales.quote', r.facility_id);
      return (
        <>
          <PageHead eyebrow={`Customer request · ${r.facility_code}`} title={`${r.number} · ${r.subject}`} sub={<>{r.customer_name}{r.customer_ref ? ` · their reference ${r.customer_ref}` : ''} · <Status r={r} /></>} />
          <Kpis items={[{ label: 'Reply due', value: fmtDate(r.response_due), tone: r.overdue ? 'bad' : undefined, note: open ? left(r.days_left) : undefined }, { label: 'Received', value: fmtDate(r.received_on), note: r.source },
            { label: 'Owner', value: r.owner_name }, { label: 'Quote', value: r.quote_number ?? '—' }]} />
          <section className="card stack">
            <h2>The request</h2>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.scope || <span className="faint">No description entered; see the files below.</span>}</p>
            {r.contact && <p className="muted" style={{ margin: 0 }}>Contact: {r.contact.name}{r.contact.email ? ` · ${r.contact.email}` : ''}{r.contact.phone ? ` · ${r.contact.phone}` : ''}</p>}
            {r.decision_reason && <p className="muted" style={{ margin: 0 }}>Decision note: {r.decision_reason}</p>}
            {r.outcome_reason && <p className="muted" style={{ margin: 0 }}>Closed because: {r.outcome_reason}</p>}
          </section>
          {mayAct && open && (
            <section className="card stack">
              <h2>What to do</h2>
              <div className="row">
                {r.status === 'received' && <button onClick={() => void decide.run('bid')} disabled={decide.busy}>We will bid</button>}
                <button className="primary" onClick={() => nav(`/sales/quotes/new?rfq=${r.id}`)}>{r.quote_id ? 'Quote already started' : 'Build the quote'}</button>
              </div>
              <label className="field">Reason (required for a no-bid or when closing)<input id="crfq-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <div className="row">
                {r.status === 'received' && <button onClick={() => void decide.run('no_bid')} disabled={decide.busy || reason.trim().length < 3}>No bid</button>}
                <button onClick={() => void close.run('cancelled')} disabled={close.busy || reason.trim().length < 3}>Customer withdrew it</button>
              </div>
              <div className="row"><label className="field">Move the reply date<input id="crfq-newdue" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
                <button onClick={() => void move.run()} disabled={!due || move.busy}>Change date</button></div>
              <ErrorNote message={decide.error ?? close.error ?? move.error} />
            </section>
          )}
          {r.quote_id && <section className="card"><button className="link" onClick={() => nav(`/sales/quotes/${r.quote_id}`)}>Open quote {r.quote_number} ({r.quote_status})</button></section>}
          <Attachments subjectType="inbound_rfq" subjectId={r.id} title="Files from the customer" accept={RFQ_ACCEPT} />
        </>
      );
    }}</Async>
  );
}
