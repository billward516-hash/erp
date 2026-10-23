import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const STAGE_TONE: Record<string, 'good' | 'watch' | 'bad' | 'info' | 'neutral'> = { lead: 'neutral', qualified: 'info', proposal: 'info', negotiation: 'watch', won: 'good', lost: 'bad' };
export const Stage = ({ v }: { v: string }) => <Pill tone={STAGE_TONE[v]} label={humanize(v)} />;

export function Crm() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useState<'customers' | 'pipeline' | 'tasks'>('customers');
  return (
    <>
      <PageHead eyebrow="Sales" title="Customers" sub="Accounts, contacts, opportunities and follow-ups. Quotes and orders start from a customer."
        actions={can('crm.manage') ? <button className="primary" onClick={() => nav('/crm/customers/new')}>New customer</button> : undefined} />
      <div className="row" role="tablist">
        {(['customers', 'pipeline', 'tasks'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>
          {t === 'customers' ? 'Customers' : t === 'pipeline' ? 'Pipeline' : 'My follow-ups'}</button>)}
      </div>
      {tab === 'customers' && <CustomerList />}
      {tab === 'pipeline' && <Pipeline />}
      {tab === 'tasks' && <Tasks />}
    </>
  );
}

function CustomerList() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const { data, loading, error } = useApi<any[]>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  return (
    <section className="card stack">
      <label className="field">Search<input id="cust-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or code" /></label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(c) => nav(`/crm/customers/${c.id}`)} empty="No customers yet. Add one, or import your customer list."
          columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name', render: (c) => <strong>{c.name}</strong> }, { key: 'kind', label: 'Type', render: (c) => <Pill tone={c.kind === 'customer' ? 'good' : 'info'} label={humanize(c.kind)} /> },
            { key: 'industry', label: 'Industry' }, { key: 'owner', label: 'Owner' }, { key: 'open_opportunities', label: 'Open opportunities', numeric: true },
            { key: 'last_activity', label: 'Last activity', render: (c) => fmtDate(c.last_activity) }]} />
      )}</Async>
    </section>
  );
}

function Pipeline() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/api/opportunities');
  const rows = data ?? [];
  return (
    <section className="card stack">
      <p className="muted">{rows.length} open · {fmtMoney(rows.reduce((s, o) => s + Number(o.amount ?? 0), 0))} total · {fmtMoney(rows.reduce((s, o) => s + o.weighted, 0))} weighted by probability</p>
      <Async loading={loading && !data} error={error}>{() => (
        <div className="pipeline">
          {STAGES.slice(0, 4).map((st) => (
            <div key={st} className="pipeline-col">
              <h3><Stage v={st} /> <span className="muted">{fmtMoney(rows.filter((o) => o.stage === st).reduce((s, o) => s + Number(o.amount ?? 0), 0))}</span></h3>
              {rows.filter((o) => o.stage === st).map((o) => (
                <button key={o.id} className="opp-card" onClick={() => nav(`/crm/customers/${o.customer_id}`)}>
                  <strong>{o.customer_name}</strong><span>{o.title}</span>
                  <span className="muted">{fmtMoney(o.amount)} · {o.probability}% · close {fmtDate(o.expected_close)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}</Async>
    </section>
  );
}

function Tasks() {
  const { data, loading, error, reload } = useApi<any[]>('/api/activities?mineOpen=true');
  const done = useAction(async (id: string) => { await api.post(`/api/activities/${id}/done`); await reload(); });
  return (
    <section className="card stack">
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} empty="No open follow-ups." exception={(a) => a.due_on < new Date().toISOString().slice(0, 10)}
          columns={[{ key: 'due_on', label: 'Due', render: (a) => fmtDate(a.due_on) }, { key: 'customer_name', label: 'Customer', render: (a) => <Link to={`/crm/customers/${a.customer_id}`}>{a.customer_name}</Link> },
            { key: 'summary', label: 'Follow-up' }, { key: 'done', label: '', render: (a) => <button onClick={() => done.run(a.id)} disabled={done.busy}>Done</button> }]} />
      )}</Async>
      <ErrorNote message={done.error} />
    </section>
  );
}

export function NewCustomer() {
  const nav = useNavigate();
  const [f, setF] = useState({ code: '', name: '', industry: '', phone: '', website: '', billingAddress: '', paymentTerms: 'Net 30' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const act = useAction(async () => {
    const c = await api.post('/api/customers', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v || null])));
    nav(`/crm/customers/${c.id}`);
  });
  return (
    <>
      <PageHead eyebrow="Sales" title="New customer" />
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Code<input id="cust-code" value={f.code} onChange={set('code')} required placeholder="e.g. ACME" /></label>
            <label className="field">Name<input id="cust-name" value={f.name} onChange={set('name')} required /></label>
            <label className="field">Industry<input id="cust-industry" value={f.industry} onChange={set('industry')} /></label>
            <label className="field">Phone<input id="cust-phone" value={f.phone} onChange={set('phone')} /></label>
            <label className="field">Website<input id="cust-web" value={f.website} onChange={set('website')} /></label>
            <label className="field">Payment terms<input id="cust-terms" value={f.paymentTerms} onChange={set('paymentTerms')} /></label>
          </div>
          <label className="field">Billing address<textarea id="cust-bill" value={f.billingAddress} onChange={set('billingAddress')} /></label>
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy}>Save customer</button></div>
        </form>
      </section>
    </>
  );
}

export function CustomerDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const sales = can('sales.view') && me?.edition !== 'lite';
  const { data: c, loading, error, reload } = useApi<any>(`/api/customers/${id}`);
  const quotes = useApi<any[]>(sales ? `/api/quotes?customerId=${id}` : null);
  const orders = useApi<any[]>(sales ? `/api/sales-orders?customerId=${id}` : null);
  const manage = can('crm.manage');
  return (
    <Async loading={loading && !c} error={error}>{() => (
      <>
        <PageHead eyebrow={`Customer · ${c.code}`} title={c.name} sub={[c.industry, c.phone, c.website, c.payment_terms && `Terms: ${c.payment_terms}`].filter(Boolean).join(' · ') || undefined}
          actions={<><Pill tone={c.kind === 'customer' ? 'good' : 'info'} label={humanize(c.kind)} />
            {can('sales.quote') && <button className="primary" onClick={() => nav(`/sales/quotes/new?customer=${c.id}`)}>New quote</button>}</>} />
        <CustomerSpecs customerId={c.id} />
        <div className="grid two">
          <section className="card stack">
            <h2>Contacts</h2>
            <Table rows={c.contacts} empty="No contacts yet."
              columns={[{ key: 'name', label: 'Name', render: (x) => <>{x.name}{x.is_primary && <> <Pill tone="info" label="Primary" /></>}</> }, { key: 'title', label: 'Title' },
                { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }]} />
            {manage && <ContactForm customerId={c.id} onDone={reload} />}
          </section>
          <section className="card stack">
            <h2>Opportunities</h2>
            <Table rows={c.opportunities} empty="No opportunities yet."
              columns={[{ key: 'title', label: 'Opportunity' }, { key: 'stage', label: 'Stage', render: (o) => <Stage v={o.stage} /> }, { key: 'amount', label: 'Amount', numeric: true, render: (o) => fmtMoney(o.amount) },
                { key: 'expected_close', label: 'Close', render: (o) => fmtDate(o.expected_close) },
                ...(manage ? [{ key: 'move', label: '', render: (o: any) => (['won', 'lost'].includes(o.stage) ? null : <StageMover o={o} onDone={reload} />) }] : [])]} />
            {manage && <OpportunityForm customerId={c.id} onDone={reload} />}
          </section>
        </div>
        <div className="grid two">
          <section className="card">
            <h2>Quotes</h2>
            <Table rows={quotes.data ?? []} onRow={(q) => nav(`/sales/quotes/${q.id}`)} empty="No quotes yet."
              columns={[{ key: 'number', label: 'Quote', render: (q) => `${q.number} rev ${q.revision}` }, { key: 'title', label: 'Title' }, { key: 'total', label: 'Total', numeric: true, render: (q) => fmtMoney(q.total) },
                { key: 'status', label: 'Status', render: (q) => humanize(q.status) }]} />
          </section>
          <section className="card">
            <h2>Orders</h2>
            <Table rows={orders.data ?? []} onRow={(o) => nav(`/sales/orders/${o.id}`)} empty="No orders yet."
              columns={[{ key: 'number', label: 'Order' }, { key: 'customer_po', label: 'Their PO' }, { key: 'total', label: 'Total', numeric: true, render: (o) => fmtMoney(o.total) },
                { key: 'status', label: 'Status', render: (o) => humanize(o.status) }]} />
          </section>
        </div>
        <section className="card stack">
          <h2>Activity</h2>
          {manage && <ActivityForm customerId={c.id} opportunities={c.opportunities} onDone={reload} />}
          <ul className="timeline">
            {c.activities.map((a: any) => (
              <li key={a.id}><span className="muted">{a.kind === 'task' ? `Due ${fmtDate(a.due_on)}` : fmtDateTime(a.created_at)}</span>
                <span><strong>{humanize(a.kind)}</strong>{a.kind === 'task' && (a.done_at ? ' (done)' : ' (open)')} · {a.summary}{a.opportunity_title ? ` · ${a.opportunity_title}` : ''} <span className="faint">{a.created_by_name}</span></span></li>
            ))}
          </ul>
        </section>
      </>
    )}</Async>
  );
}

function ContactForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [f, setF] = useState({ name: '', title: '', email: '', phone: '', isPrimary: false });
  const act = useAction(async () => { await api.post('/api/contacts', { customerId, ...f, title: f.title || null, email: f.email || null, phone: f.phone || null }); setF({ name: '', title: '', email: '', phone: '', isPrimary: false }); onDone(); });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <input aria-label="Contact name" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required style={{ width: 140 }} />
      <input aria-label="Contact title" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ width: 120 }} />
      <input aria-label="Contact email" placeholder="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ width: 170 }} />
      <label className="row"><input type="checkbox" checked={f.isPrimary} onChange={(e) => setF({ ...f, isPrimary: e.target.checked })} /> Primary</label>
      <button disabled={act.busy}>Add contact</button>
      <ErrorNote message={act.error} />
    </form>
  );
}

function OpportunityForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [f, setF] = useState({ title: '', amount: '', expectedClose: '' });
  const act = useAction(async () => { await api.post('/api/opportunities', { customerId, title: f.title, amount: f.amount ? Number(f.amount) : null, expectedClose: f.expectedClose || null }); setF({ title: '', amount: '', expectedClose: '' }); onDone(); });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <input id="opp-title" aria-label="Opportunity" placeholder="New opportunity" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} style={{ flex: '1 1 160px' }} />
      <input id="opp-amount" aria-label="Amount" placeholder="Amount" type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ width: 110 }} />
      <input id="opp-close" aria-label="Expected close" type="date" value={f.expectedClose} onChange={(e) => setF({ ...f, expectedClose: e.target.value })} />
      <button disabled={act.busy}>Add</button>
      <ErrorNote message={act.error} />
    </form>
  );
}

function StageMover({ o, onDone }: { o: any; onDone: () => void }) {
  const [stage, setStage] = useState(o.stage);
  const [reason, setReason] = useState('');
  const act = useAction(async () => { await api.post('/api/opportunities', { id: o.id, customerId: o.customer_id, title: o.title, stage, amount: o.amount, expectedClose: o.expected_close, source: o.source, ownerUserId: o.owner_user_id, lostReason: reason || null }); onDone(); });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <select aria-label={`Stage for ${o.title}`} value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
      {stage === 'lost' && <input aria-label="Why lost" placeholder="Why lost?" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 120 }} />}
      {stage !== o.stage && <button disabled={act.busy}>Move</button>}
      {act.error && <span className="faint">{act.error}</span>}
    </form>
  );
}

function ActivityForm({ customerId, opportunities, onDone }: { customerId: string; opportunities: any[]; onDone: () => void }) {
  const [f, setF] = useState({ kind: 'call', summary: '', dueOn: '', opportunityId: '' });
  const act = useAction(async () => {
    await api.post('/api/activities', { customerId, kind: f.kind, summary: f.summary, dueOn: f.kind === 'task' ? f.dueOn : null, opportunityId: f.opportunityId || null });
    setF({ ...f, summary: '', dueOn: '' }); onDone();
  });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <select id="act-kind" aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
        {['call', 'email', 'meeting', 'note', 'task'].map((k) => <option key={k} value={k}>{k === 'task' ? 'Follow-up task' : humanize(k)}</option>)}</select>
      <input id="act-summary" aria-label="Summary" placeholder={f.kind === 'task' ? 'What to do' : 'What happened'} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} required style={{ flex: '1 1 260px' }} />
      {f.kind === 'task' && <input id="act-due" aria-label="Due" type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} required />}
      {opportunities.some((o) => !['won', 'lost'].includes(o.stage)) && (
        <select aria-label="Opportunity" value={f.opportunityId} onChange={(e) => setF({ ...f, opportunityId: e.target.value })} style={{ maxWidth: 180 }}>
          <option value="">No opportunity</option>{opportunities.filter((o) => !['won', 'lost'].includes(o.stage)).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}</select>
      )}
      <button disabled={act.busy}>Log</button>
      <ErrorNote message={act.error} />
    </form>
  );
}

/** The customer's specifications in the document server (D-169), with the revision in force. */
function CustomerSpecs({ customerId }: { customerId: string }) {
  const { can } = useAuth();
  const { data } = useApi<any[]>(can('documents.view') ? `/api/documents?entityType=customer&entityId=${customerId}` : null);
  if (!data?.length) return null;
  return (
    <section className="card stack">
      <h2>Specifications</h2>
      <ul>{data.map((d) => <li key={d.id}><Link to={`/documents/${d.id}`}>{d.doc_number}</Link> {d.title}{d.issuer_doc_number ? ` (${d.issuer_doc_number}` : ''}{d.current_issuer_revision ? ` rev ${d.current_issuer_revision})` : d.issuer_doc_number ? ')' : ''}</li>)}</ul>
    </section>
  );
}
