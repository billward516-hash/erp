import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize, roleLabel } from '../format';
import { useAction, useApi } from '../hooks';

const PR_STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  draft: { label: 'Draft', tone: 'neutral' }, pending_approval: { label: 'Awaiting approval', tone: 'info' }, approved: { label: 'Approved', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'bad' }, cancelled: { label: 'Cancelled', tone: 'neutral' }, closed: { label: 'Ordered', tone: 'good' },
};
const PO_STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  open: { label: 'Open', tone: 'info' }, partially_received: { label: 'Partly received', tone: 'watch' }, received: { label: 'Received', tone: 'good' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const PrStatus = ({ v }: { v: string }) => <Pill tone={PR_STATUS[v]?.tone} label={PR_STATUS[v]?.label ?? v} />;
const PoStatus = ({ v, late }: { v: string; late?: boolean }) => <>{<Pill tone={PO_STATUS[v]?.tone} label={PO_STATUS[v]?.label ?? v} />}{late && <> <Pill tone="bad" label="Late" /></>}</>;

export function Purchasing() {
  const { can } = useAuth();
  const nav = useNavigate();
  const tabs = ['requests', 'orders', 'suppliers'] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>(() => (sessionStorageGet('purchasing.tab') as any) ?? 'requests');
  const choose = (t: (typeof tabs)[number]) => { setTab(t); sessionStorageSet('purchasing.tab', t); };
  return (
    <>
      <PageHead eyebrow="Purchasing" title="Purchasing" sub="Requests are approved by amount and spend type, then ordered by a buyer and received into storerooms. Invoices and payments stay in your accounting system."
        actions={can('purchasing.request') ? <button className="primary" onClick={() => nav('/purchasing/requests/new')}>New request</button> : undefined} />
      <div className="row" role="tablist">
        {tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => choose(t)}>{humanize(t)}</button>)}
      </div>
      {tab === 'requests' && <Requests />}
      {tab === 'orders' && <Orders />}
      {tab === 'suppliers' && <Suppliers />}
    </>
  );
}
function sessionStorageGet(k: string) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked */ } }

function Requests() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [filter, setFilter] = useState<'open' | 'mine' | 'all'>('open');
  const { data, loading, error } = useApi<any[]>(filter === 'mine' ? '/api/purchase-requests?mine=true' : '/api/purchase-requests');
  const rows = (data ?? []).filter((r) => filter !== 'open' || ['draft', 'pending_approval', 'approved'].includes(r.status));
  const facilities = useApi<any[]>('/api/facilities');
  const [fac, setFac] = useState('');
  const reorder = useAction(async () => { const pr = await api.post('/api/purchase-requests/from-reorder', { facilityId: fac }); nav(`/purchasing/requests/${pr.id}`); });
  return (
    <div className="card stack">
      <div className="spread">
        <div className="row" role="group" aria-label="Filter">
          {(['open', 'mine', 'all'] as const).map((v) => <button key={v} className={filter === v ? 'primary' : ''} onClick={() => setFilter(v)}>{v === 'open' ? 'Open' : v === 'mine' ? 'Mine' : 'All'}</button>)}
        </div>
        {can('purchasing.request') && can('inventory.view') && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void reorder.run(); }}>
            <select id="reorder-fac" value={fac} onChange={(e) => setFac(e.target.value)} required aria-label="Facility" style={{ maxWidth: 200 }}>
              <option value="">Facility…</option>{(facilities.data ?? []).filter((f) => can('purchasing.request', f.id)).map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}
            </select>
            <button disabled={reorder.busy || !fac}>Draft from reorder report</button>
          </form>
        )}
      </div>
      <ErrorNote message={reorder.error} />
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={rows} onRow={(r) => nav(`/purchasing/requests/${r.id}`)} empty="No purchase requests."
          columns={[{ key: 'number', label: 'Request', render: (r) => <strong>{r.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'title', label: 'Title' },
            { key: 'requested_by_name', label: 'Requested by' }, { key: 'spend_type', label: 'Type', render: (r) => (r.spend_type === 'capex' ? 'Capital' : 'Operating') },
            { key: 'total', label: 'Estimate', numeric: true, render: (r) => fmtMoney(r.total) }, { key: 'status', label: 'Status', render: (r) => <PrStatus v={r.status} /> },
            { key: 'created_at', label: 'Raised', render: (r) => fmtDate(r.created_at) }]} />
      )}</Async>
    </div>
  );
}

function Orders() {
  const nav = useNavigate();
  const [open, setOpen] = useState(true);
  const { data, loading, error } = useApi<any[]>(open ? '/api/purchase-orders?openOnly=true' : '/api/purchase-orders');
  return (
    <div className="card stack">
      <label className="row"><input id="po-open" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only open orders</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(o) => nav(`/purchasing/orders/${o.id}`)} exception={(o) => o.late} empty="No purchase orders."
          columns={[{ key: 'number', label: 'Order', render: (o) => <strong>{o.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'supplier_name', label: 'Supplier' },
            { key: 'total', label: 'Total', numeric: true, render: (o) => fmtMoney(o.total) }, { key: 'expected_on', label: 'Expected', render: (o) => fmtDate(o.expected_on) },
            { key: 'status', label: 'Status', render: (o) => <PoStatus v={o.status} late={o.late} /> }]} />
      )}</Async>
    </div>
  );
}

function Suppliers() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useApi<any[]>(`/api/suppliers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const [f, setF] = useState({ code: '', name: '', email: '', paymentTerms: '' });
  const add = useAction(async () => { await api.post('/api/suppliers', { code: f.code, name: f.name, email: f.email || null, paymentTerms: f.paymentTerms || null }); setF({ code: '', name: '', email: '', paymentTerms: '' }); await reload(); });
  return (
    <div className="card stack">
      <label className="field">Search<input id="sup-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or name" /></label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(s) => nav(`/purchasing/suppliers/${s.id}`)} empty="No suppliers yet. Add one, or import your vendor list."
          columns={[{ key: 'code', label: 'Code', render: (s) => <strong>{s.code}</strong> }, { key: 'name', label: 'Name' }, { key: 'contact_name', label: 'Contact' },
            { key: 'payment_terms', label: 'Terms' }, { key: 'parts', label: 'Priced parts', numeric: true }, { key: 'open_orders', label: 'Open orders', numeric: true },
            { key: 'active', label: '', render: (s) => (s.active ? null : <Pill tone="neutral" label="Inactive" />) }]} />
      )}</Async>
      {can('purchasing.manage') && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <h3>Add a supplier</h3>
          <div className="form-grid">
            <label className="field">Code<input id="sup-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></label>
            <label className="field">Name<input id="sup-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label className="field">Order email<input id="sup-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            <label className="field">Payment terms<input id="sup-terms" value={f.paymentTerms} onChange={(e) => setF({ ...f, paymentTerms: e.target.value })} placeholder="e.g. Net 30" /></label>
          </div>
          <ErrorNote message={add.error} />
          <div><button disabled={add.busy}>Add supplier</button></div>
        </form>
      )}
    </div>
  );
}

export function SupplierDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: s, loading, error, reload } = useApi<any>(`/api/suppliers/${id}`);
  const parts = useApi<any[]>(can('purchasing.manage') ? '/api/parts' : null);
  const [p, setP] = useState({ partId: '', unitPrice: '', leadTimeDays: '', supplierPartNumber: '', preferred: false });
  const price = useAction(async () => {
    await api.put(`/api/suppliers/${id}/parts/${p.partId}`, { unitPrice: p.unitPrice ? Number(p.unitPrice) : null, leadTimeDays: p.leadTimeDays ? Number(p.leadTimeDays) : null,
      supplierPartNumber: p.supplierPartNumber || null, preferred: p.preferred });
    setP({ partId: '', unitPrice: '', leadTimeDays: '', supplierPartNumber: '', preferred: false }); await reload();
  });
  return (
    <Async loading={loading && !s} error={error}>{() => (
      <>
        <PageHead eyebrow={`Supplier · ${s.code}`} title={s.name} actions={s.active ? undefined : <Pill tone="neutral" label="Inactive" />}
          sub={[s.contact_name, s.email, s.phone, s.payment_terms].filter(Boolean).join(' · ') || undefined} />
        <section className="card stack">
          <h2>Prices</h2>
          <Table rows={s.parts} rowKey={(x) => x.part_id} empty="No prices recorded for this supplier."
            columns={[{ key: 'part_number', label: 'Part' }, { key: 'description', label: 'Description' }, { key: 'supplier_part_number', label: 'Their part number' },
              { key: 'unit_price', label: 'Price', numeric: true, render: (x) => fmtMoney(x.unit_price) }, { key: 'lead_time_days', label: 'Lead time', numeric: true, render: (x) => (x.lead_time_days == null ? '—' : `${x.lead_time_days} d`) },
              { key: 'preferred', label: '', render: (x) => (x.preferred ? <Pill tone="good" label="Preferred" /> : null) }]} />
          {can('purchasing.manage') && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void price.run(); }}>
              <select id="sp-part" value={p.partId} onChange={(e) => setP({ ...p, partId: e.target.value })} required aria-label="Part" style={{ maxWidth: 260 }}>
                <option value="">Part…</option>{(parts.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.part_number} · {x.description}</option>)}
              </select>
              <input id="sp-price" type="number" min="0" step="any" value={p.unitPrice} onChange={(e) => setP({ ...p, unitPrice: e.target.value })} placeholder="Price" aria-label="Price" style={{ width: 100 }} />
              <input id="sp-lead" type="number" min="0" value={p.leadTimeDays} onChange={(e) => setP({ ...p, leadTimeDays: e.target.value })} placeholder="Lead days" aria-label="Lead time days" style={{ width: 100 }} />
              <input id="sp-spn" value={p.supplierPartNumber} onChange={(e) => setP({ ...p, supplierPartNumber: e.target.value })} placeholder="Their part number" aria-label="Their part number" style={{ width: 160 }} />
              <label className="row"><input type="checkbox" checked={p.preferred} onChange={(e) => setP({ ...p, preferred: e.target.checked })} /> Preferred</label>
              <button disabled={price.busy || !p.partId}>Save price</button>
              <ErrorNote message={price.error} />
            </form>
          )}
        </section>
        <section className="card">
          <h2>Orders</h2>
          <Table rows={s.orders} onRow={(o) => nav(`/purchasing/orders/${o.id}`)} empty="No orders yet."
            columns={[{ key: 'number', label: 'Order' }, { key: 'facility_code', label: 'Site' }, { key: 'total', label: 'Total', numeric: true, render: (o) => fmtMoney(o.total) },
              { key: 'expected_on', label: 'Expected', render: (o) => fmtDate(o.expected_on) }, { key: 'status', label: 'Status', render: (o) => <PoStatus v={o.status} /> }]} />
        </section>
      </>
    )}</Async>
  );
}

// ---------------------------------------------------------------------------
// Request form and detail
// ---------------------------------------------------------------------------
interface LineDraft { partId: string; description: string; qty: string; estUnitPrice: string; supplierId: string; locationId: string }
const blankLine = (): LineDraft => ({ partId: '', description: '', qty: '1', estUnitPrice: '', supplierId: '', locationId: '' });
const toPayload = (l: LineDraft) => ({
  partId: l.partId || null, description: l.description || null, qty: Number(l.qty), estUnitPrice: l.estUnitPrice === '' ? null : Number(l.estUnitPrice),
  supplierId: l.supplierId || null, locationId: l.locationId || null,
});

function LinesEditor({ lines, setLines, facilityId }: { lines: LineDraft[]; setLines: (l: LineDraft[]) => void; facilityId: string }) {
  const parts = useApi<any[]>('/api/parts');
  const suppliers = useApi<any[]>('/api/suppliers');
  const locs = useApi<any[]>('/api/stock-locations');
  const set = (i: number, k: keyof LineDraft, v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <div className="stack">
      {lines.map((l, i) => (
        <div className="line-editor" key={i}>
          <select aria-label={`Line ${i + 1} part`} value={l.partId} onChange={(e) => set(i, 'partId', e.target.value)}>
            <option value="">Not a catalog part (describe it)</option>
            {(parts.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}
          </select>
          {!l.partId && <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => set(i, 'description', e.target.value)} placeholder="What to buy" />}
          <input aria-label={`Line ${i + 1} quantity`} type="number" min="0.001" step="any" value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} style={{ width: 80 }} />
          <input aria-label={`Line ${i + 1} estimated unit price`} type="number" min="0" step="any" value={l.estUnitPrice} onChange={(e) => set(i, 'estUnitPrice', e.target.value)}
            placeholder={l.partId ? 'Price (supplier list)' : 'Unit price'} style={{ width: 140 }} />
          <select aria-label={`Line ${i + 1} supplier`} value={l.supplierId} onChange={(e) => set(i, 'supplierId', e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">{l.partId ? 'Preferred supplier' : 'Supplier (buyer decides)'}</option>
            {(suppliers.data ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
          </select>
          {l.partId && (
            <select aria-label={`Line ${i + 1} storeroom`} value={l.locationId} onChange={(e) => set(i, 'locationId', e.target.value)} style={{ maxWidth: 170 }}>
              <option value="">No storeroom (direct use)</option>
              {(locs.data ?? []).filter((x) => x.facility_id === facilityId).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
            </select>
          )}
          <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}>Remove</button>
        </div>
      ))}
      <div><button type="button" onClick={() => setLines([...lines, blankLine()])}>Add a line</button></div>
    </div>
  );
}

export function NewPurchaseRequest() {
  const nav = useNavigate();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const allowed = (facilities.data ?? []).filter((f) => can('purchasing.request', f.id));
  const [f, setF] = useState({ facilityId: '', title: '', justification: '', spendType: 'opex', neededBy: '' });
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const facilityId = f.facilityId || allowed[0]?.id || '';
  const act = useAction(async () => {
    const pr = await api.post('/api/purchase-requests', { facilityId, title: f.title, justification: f.justification || null, spendType: f.spendType, neededBy: f.neededBy || null, lines: lines.map(toPayload) });
    nav(`/purchasing/requests/${pr.id}`);
  });
  return (
    <>
      <PageHead eyebrow="Purchasing" title="New purchase request" sub="Saved as a draft. Submit it for approval from the next screen, where you will see who has to sign." />
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Facility<select id="pr-fac" value={facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required>
              {allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
            <label className="field">Title<input id="pr-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /></label>
            <label className="field">Spend type<select id="pr-type" value={f.spendType} onChange={(e) => setF({ ...f, spendType: e.target.value })}>
              <option value="opex">Operating (repairs, consumables)</option><option value="capex">Capital (asset, improvement)</option></select></label>
            <label className="field">Needed by<input id="pr-needed" type="date" value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} /></label>
          </div>
          <label className="field">Why is this needed?<textarea id="pr-why" value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} /></label>
          <h3>Lines</h3>
          <LinesEditor lines={lines} setLines={setLines} facilityId={facilityId} />
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy || !facilityId}>Save draft</button></div>
        </form>
      </section>
    </>
  );
}

export function PurchaseRequestDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const { data: r, loading, error, reload } = useApi<any>(`/api/purchase-requests/${id}`);
  const [editing, setEditing] = useState<LineDraft[] | null>(null);
  const submit = useAction(async () => { await api.post(`/api/purchase-requests/${id}/submit`); await reload(); });
  const save = useAction(async () => { await api.patch(`/api/purchase-requests/${id}`, { lines: editing!.map(toPayload) }); setEditing(null); await reload(); });
  const [reason, setReason] = useState('');
  const cancel = useAction(async () => { await api.post(`/api/purchase-requests/${id}/cancel`, { reason }); await reload(); });
  return (
    <Async loading={loading && !r} error={error}>{() => {
      const mine = r.requested_by === me?.userId || can('purchasing.manage', r.facility_id);
      const editable = mine && ['draft', 'pending_approval', 'approved', 'rejected'].includes(r.status) && !r.lines.some((l: any) => l.po);
      return (
        <>
          <PageHead eyebrow={`${r.facility_code} · ${r.number} · revision ${r.revision} · ${r.spend_type === 'capex' ? 'capital' : 'operating'}`} title={r.title}
            sub={<>Requested by {r.requested_by_name}{r.needed_by ? `, needed by ${fmtDate(r.needed_by)}` : ''}{r.work_order_id && <> for <Link to={`/work-orders/${r.work_order_id}`}>{r.work_order_number}</Link></>}</>}
            actions={<PrStatus v={r.status} />} />
          {r.justification && <p className="muted">{r.justification}</p>}
          <section className="card stack">
            <div className="spread"><h2>Lines</h2><strong>{fmtMoney(r.total)}{r.approved_total != null && r.status !== 'draft' ? <span className="muted"> · approved {fmtMoney(r.approved_total)}</span> : null}</strong></div>
            {editing ? (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
                {r.status !== 'draft' && <div className="notice warn">Saving changes after submission voids the approvals; the request goes back to draft and must be approved again.</div>}
                <LinesEditor lines={editing} setLines={setEditing} facilityId={r.facility_id} />
                <ErrorNote message={save.error} />
                <div className="row"><button className="primary" disabled={save.busy}>Save lines</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
              </form>
            ) : (
              <>
                <Table rows={r.lines}
                  columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Item', render: (l) => l.description },
                    { key: 'qty', label: 'Qty', numeric: true, render: (l) => `${fmtNum(l.qty, 3)} ${l.uom}` }, { key: 'est_unit_price', label: 'Unit price', numeric: true, render: (l) => fmtMoney(l.est_unit_price) },
                    { key: 'est_total', label: 'Amount', numeric: true, render: (l) => fmtMoney(l.est_total) }, { key: 'supplier_code', label: 'Supplier', render: (l) => l.supplier_name ?? <span className="faint">not chosen</span> },
                    { key: 'location_code', label: 'Into' },
                    { key: 'po', label: 'Order', render: (l) => (l.po ? <Link to={`/purchasing/orders/${l.po.id}`}>{l.po.number}</Link> : null) }]} />
                {editable && <div><button onClick={() => setEditing(r.lines.map((l: any) => ({ partId: l.part_id ?? '', description: l.part_id ? '' : l.description, qty: String(l.qty),
                  estUnitPrice: l.est_unit_price == null ? '' : String(l.est_unit_price), supplierId: l.supplier_id ?? '', locationId: l.location_id ?? '' })))}>Edit lines</button></div>}
              </>
            )}
          </section>
          {r.status === 'draft' && mine && (
            <section className="card stack">
              <h2>Submit for approval</h2>
              {r.route?.length ? <p>Sign-off route for {fmtMoney(r.total)}: {r.route.map((s: any, i: number) => <span key={i}>{i > 0 && ' → '}{s.steps.map((x: any) => x.label).join(' + ')}</span>)}.</p>
                : <p className="muted">No approval rule matches this request yet.</p>}
              <ErrorNote message={submit.error} />
              <div><button className="primary" disabled={submit.busy} onClick={() => submit.run()}>Submit for approval</button></div>
            </section>
          )}
          {r.status === 'approved' && can('purchasing.manage', r.facility_id) && <OrderForm r={r} onDone={(orders) => (orders.length === 1 ? nav(`/purchasing/orders/${orders[0].id}`) : reload())} />}
          <section className="card stack">
            <h2>Sign-offs</h2>
            {r.approvals.length ? r.approvals.map((a: any) => (
              <div key={a.id} className="stack">
                <div className="row"><strong>Revision {a.subject_revision}</strong><Pill value={a.status} tone={a.status === 'approved' ? 'good' : a.status === 'rejected' ? 'bad' : a.status === 'pending' ? 'info' : 'neutral'} /></div>
                <Table rows={a.steps} columns={[{ key: 'stage', label: 'Stage', numeric: true }, { key: 'label', label: 'Step' }, { key: 'role_key', label: 'Role', render: (s) => roleLabel(s.role_key) },
                  { key: 'status', label: 'Status', render: (s) => <Pill value={s.status} tone={s.status === 'approved' ? 'good' : s.status === 'rejected' ? 'bad' : s.status === 'pending' ? 'info' : 'neutral'} /> },
                  { key: 'decided_by', label: 'Signed by', render: (s) => (s.decided_by ? `${s.decided_by}${s.on_behalf_of ? ` for ${s.on_behalf_of}` : ''}` : '—') },
                  { key: 'decided_at', label: 'When', render: (s) => fmtDateTime(s.decided_at) }, { key: 'comment', label: 'Comment' }]} />
              </div>
            )) : <p className="muted">Not submitted yet.</p>}
          </section>
          {mine && !['cancelled', 'closed'].includes(r.status) && !r.lines.some((l: any) => l.po) && (
            <section className="card">
              <form className="row" onSubmit={(e) => { e.preventDefault(); void cancel.run(); }}>
                <input id="pr-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for cancelling" aria-label="Reason" style={{ maxWidth: 360 }} />
                <button className="danger" disabled={cancel.busy || reason.trim().length < 3}>Cancel request</button>
                <ErrorNote message={cancel.error} />
              </form>
            </section>
          )}
        </>
      );
    }}</Async>
  );
}

function OrderForm({ r, onDone }: { r: any; onDone: (orders: any[]) => void }) {
  const open = r.lines.filter((l: any) => !l.po);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [expectedOn, setExpectedOn] = useState('');
  const total = open.reduce((s: number, l: any) => s + Number(l.qty) * Number(prices[l.id] ?? l.est_unit_price ?? 0), 0);
  const act = useAction(async () => {
    const res = await api.post(`/api/purchase-requests/${r.id}/order`, { expectedOn: expectedOn || null,
      lines: open.map((l: any) => ({ requestLineId: l.id, unitPrice: prices[l.id] !== undefined && prices[l.id] !== '' ? Number(prices[l.id]) : undefined })) });
    onDone(res.orders);
  });
  if (!open.length) return null;
  const suppliers = new Set(open.map((l: any) => l.supplier_id ?? 'none'));
  return (
    <section className="card stack">
      <h2>Place the order</h2>
      <p className="muted">Creates {suppliers.size === 1 ? 'one purchase order' : `${suppliers.size} purchase orders (one per supplier)`}. Orders up to 10% above the approved amount are allowed; beyond that, edit the request for re-approval.</p>
      <Table rows={open} columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Item' }, { key: 'supplier_name', label: 'Supplier' },
        { key: 'qty', label: 'Qty', numeric: true },
        { key: 'price', label: 'Order price', numeric: true, render: (l) => <input aria-label={`Order price line ${l.line_no}`} type="number" min="0" step="any" style={{ width: 110 }}
          value={prices[l.id] ?? (l.est_unit_price ?? '')} onChange={(e) => setPrices({ ...prices, [l.id]: e.target.value })} /> }]} />
      <div className="row">
        <label className="row">Expected delivery<input id="po-expected" type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} /></label>
        <span className="muted">Order total {fmtMoney(total)} (approved {fmtMoney(r.approved_total)})</span>
      </div>
      <ErrorNote message={act.error} />
      <div><button className="primary" disabled={act.busy} onClick={() => act.run()}>Create purchase order{suppliers.size > 1 ? 's' : ''}</button></div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------------
export function PurchaseOrderDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: o, loading, error, reload } = useApi<any>(`/api/purchase-orders/${id}`);
  const [reason, setReason] = useState('');
  const cancel = useAction(async () => { await api.post(`/api/purchase-orders/${id}/cancel`, { reason }); await reload(); });
  return (
    <Async loading={loading && !o} error={error}>{() => (
      <>
        <PageHead eyebrow={`${o.facility_code} · Purchase order`} title={<>{o.number} <span className="muted" style={{ fontWeight: 400 }}>{o.supplier_name}</span></>}
          sub={<>Expected {fmtDate(o.expected_on)} · {o.payment_terms ?? 'terms not set'} · raised by {o.created_by_name}</>}
          actions={<><PoStatus v={o.status} late={o.late} /><button onClick={() => api.open(`/api/purchase-orders/${o.id}/pdf`)}>PDF</button></>} />
        <section className="card stack">
          <div className="spread"><h2>Lines</h2><strong>{fmtMoney(o.total)}</strong></div>
          <Table rows={o.lines}
            columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'part_number', label: 'Part', render: (l) => <span style={{ whiteSpace: 'nowrap' }}>{l.part_number ?? '—'}</span> },
              { key: 'description', label: 'Description' }, { key: 'qty_ordered', label: 'Ordered', numeric: true, render: (l) => fmtNum(l.qty_ordered, 3) },
              { key: 'qty_received', label: 'Received', numeric: true, render: (l) => fmtNum(l.qty_received, 3) }, { key: 'unit_price', label: 'Price', numeric: true, render: (l) => fmtMoney(l.unit_price) },
              { key: 'location_code', label: 'Into' },
              { key: 'request_number', label: 'For', render: (l) => <><Link to={`/purchasing/requests/${l.request_id}`}>{l.request_number}</Link>{l.work_order_id && <> · <Link to={`/work-orders/${l.work_order_id}`}>{l.work_order_number}</Link></>}</> }]} />
        </section>
        {['open', 'partially_received'].includes(o.status) && can('purchasing.receive', o.facility_id) && <ReceiveForm o={o} onDone={reload} />}
        <section className="card">
          <h2>Receipts</h2>
          <Table rows={o.receipts} empty="Nothing received yet."
            columns={[{ key: 'received_at', label: 'When', render: (x) => fmtDateTime(x.received_at) }, { key: 'line_no', label: 'Line', numeric: true }, { key: 'qty', label: 'Qty', numeric: true },
              { key: 'location_code', label: 'Into', render: (x) => x.location_code ?? 'direct use' }, { key: 'packing_slip', label: 'Packing slip' }, { key: 'received_by', label: 'By' }]} />
        </section>
        {o.status === 'open' && can('purchasing.manage', o.facility_id) && (
          <section className="card">
            <form className="row" onSubmit={(e) => { e.preventDefault(); void cancel.run(); }}>
              <input id="po-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for cancelling" aria-label="Reason" style={{ maxWidth: 360 }} />
              <button className="danger" disabled={cancel.busy || reason.trim().length < 3}>Cancel order</button>
              <ErrorNote message={cancel.error} />
            </form>
          </section>
        )}
      </>
    )}</Async>
  );
}

function ReceiveForm({ o, onDone }: { o: any; onDone: () => void }) {
  const locs = useApi<any[]>('/api/stock-locations');
  const open = o.lines.filter((l: any) => l.qty_received < l.qty_ordered);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l: any) => [l.id, String(l.qty_ordered - l.qty_received)])));
  const [loc, setLoc] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l: any) => [l.id, l.location_id ?? ''])));
  const [slip, setSlip] = useState('');
  const act = useAction(async () => {
    const lines = open.filter((l: any) => Number(qty[l.id]) > 0).map((l: any) => ({ orderLineId: l.id, qty: Number(qty[l.id]), locationId: loc[l.id] || null }));
    await api.post(`/api/purchase-orders/${o.id}/receive`, { lines, packingSlip: slip || null });
    onDone();
  });
  const siteLocs = (locs.data ?? []).filter((x) => x.facility_id === o.facility_id);
  return (
    <section className="card stack">
      <h2>Receive delivery</h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
        <Table rows={open} columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Item' },
          { key: 'open', label: 'Outstanding', numeric: true, render: (l) => fmtNum(l.qty_ordered - l.qty_received, 3) },
          { key: 'qty', label: 'Received now', numeric: true, render: (l) => <input aria-label={`Received now line ${l.line_no}`} type="number" min="0" max={l.qty_ordered - l.qty_received} step="any"
            style={{ width: 90 }} value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /> },
          { key: 'loc', label: 'Into storeroom', render: (l) => (l.part_id ? (
            <select aria-label={`Storeroom line ${l.line_no}`} value={loc[l.id] ?? ''} onChange={(e) => setLoc({ ...loc, [l.id]: e.target.value })}>
              <option value="">Direct use (not stocked)</option>{siteLocs.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
            </select>) : <span className="faint">direct use</span>) }]} />
        <div className="row">
          <input id="po-slip" value={slip} onChange={(e) => setSlip(e.target.value)} placeholder="Packing slip number" aria-label="Packing slip" style={{ maxWidth: 220 }} />
          <button className="primary" disabled={act.busy}>Record receipt</button>
        </div>
        <ErrorNote message={act.error} />
      </form>
    </section>
  );
}
