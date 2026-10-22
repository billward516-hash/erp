import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Pill, Table } from './ui';
import { fmtDate, fmtDateTime, fmtMoney, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const SLA_TONE: Record<string, 'good' | 'watch' | 'bad' | 'neutral'> = { met: 'good', on_track: 'neutral', at_risk: 'watch', missed: 'bad' };
const SLA_LABEL: Record<string, string> = { met: 'met', on_track: 'on track', at_risk: 'at risk', missed: 'missed' };

/** Response and completion against the service-level targets for the job's priority. */
export function SlaPills({ sla, compact = false }: { sla?: any; compact?: boolean }) {
  if (!sla) return null;
  const one = (label: string, s: any) => (s.state === 'none' ? null
    : <Pill tone={SLA_TONE[s.state]} label={compact ? `${label} ${SLA_LABEL[s.state]}` : `${label} ${SLA_LABEL[s.state]}${s.state !== 'met' && s.due ? ` · due ${fmtDateTime(s.due)}` : ''}`} />);
  return <span className="row" style={{ gap: 4 }}>{one('Response', sla.respond)}{one('Completion', sla.complete)}</span>;
}

/** Open requests (from users and from site request links): turn into a work order or decline with a reason. */
export function RequestInbox() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/maintenance-requests');
  const [open, setOpen] = useState<{ id: string; mode: 'wo' | 'reject'; title: string; priority: string; note: string } | null>(null);
  const toWo = useAction(async (r: any) => {
    const wo = await api.post('/api/work-orders', { assetId: r.asset_id, requestId: r.id, title: open!.title, priority: Number(open!.priority),
      description: [r.symptom, r.requester_contact ? `Contact: ${r.requester} ${r.requester_contact}` : '', r.entry_permission === true ? 'Permission to enter: yes' : r.entry_permission === false ? 'Permission to enter: no, arrange a time' : ''].filter(Boolean).join('\n') });
    nav(`/work-orders/${wo.id}`);
  });
  const reject = useAction(async (id: string) => { await api.post(`/api/maintenance-requests/${id}/reject`, { note: open!.note }); setOpen(null); await reload(); });
  return (
    <Async loading={loading && !data} error={error}>{() => (
      <div className="stack">
        <Table rows={data ?? []} empty="No open requests." rowKey={(r) => r.id} exception={(r) => r.severity === 'critical' || r.severity === 'high'}
          columns={[{ key: 'created_at', label: 'Received', render: (r) => fmtDateTime(r.created_at) }, { key: 'facility_code', label: 'Site' },
            { key: 'asset_name', label: 'Where / what', render: (r) => <Link to={`/assets/${r.asset_id}`}>{r.asset_name}</Link> },
            { key: 'symptom', label: 'Problem', render: (r) => <>{r.symptom}{r.asset_down && <> <Pill tone="bad" label="Down" /></>}{r.safety_impact && <> <Pill tone="bad" label="Safety" /></>}</> },
            { key: 'requester', label: 'From', render: (r) => <>{r.requester ?? '—'}{r.source === 'public' && <div className="faint">{r.requester_contact}{r.entry_permission === true ? ' · may enter' : r.entry_permission === false ? ' · call first' : ''}</div>}</> },
            { key: 'severity', label: 'Severity', render: (r) => <Pill value={r.severity} /> },
            { key: 'act', label: '', render: (r) => (can('work_orders.manage', r.facility_id) ? <span className="row">
              <button onClick={() => setOpen({ id: r.id, mode: 'wo', title: r.symptom.slice(0, 120), priority: String({ critical: 1, high: 2, medium: 3, low: 4 }[r.severity as 'low']), note: '' })}>Create work order</button>
              <button className="link" onClick={() => setOpen({ id: r.id, mode: 'reject', title: '', priority: '3', note: '' })}>Decline</button></span> : null) }]} />
        {open && (() => {
          const r = (data ?? []).find((x) => x.id === open.id);
          if (!r) return null;
          return open.mode === 'wo' ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void toWo.run(r); }}>
              <input id="req-title" aria-label="Work order title" value={open.title} onChange={(e) => setOpen({ ...open, title: e.target.value })} required style={{ flex: '1 1 320px' }} />
              <select id="req-priority" aria-label="Priority" value={open.priority} onChange={(e) => setOpen({ ...open, priority: e.target.value })}>
                <option value="1">1 Emergency</option><option value="2">2 High</option><option value="3">3 Normal</option><option value="4">4 Low</option>
              </select>
              <button className="primary" disabled={toWo.busy}>Create</button><button type="button" onClick={() => setOpen(null)}>Cancel</button><ErrorNote message={toWo.error} />
            </form>
          ) : (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void reject.run(r.id); }}>
              <input id="req-reject" aria-label="Why decline" placeholder="Why (duplicate, not a maintenance issue, resident's responsibility)" value={open.note} onChange={(e) => setOpen({ ...open, note: e.target.value })} required style={{ flex: '1 1 320px' }} />
              <button disabled={reject.busy || open.note.trim().length < 3}>Decline request</button><button type="button" onClick={() => setOpen(null)}>Cancel</button><ErrorNote message={reject.error} />
            </form>
          );
        })()}
      </div>
    )}</Async>
  );
}

/** Contractor on a work order: dispatch with a not-to-exceed, record what the contractor reports, invoices against the limit. */
export function ContractorPanel({ w, onDone }: { w: any; onDone: () => void }) {
  const { can } = useAuth();
  const manage = can('work_orders.manage', w.facility_id);
  const [trade, setTrade] = useState('');
  const [show, setShow] = useState(false);
  const contractors = useApi<any[]>(show ? `/api/contractors${trade ? `?trade=${encodeURIComponent(trade)}` : ''}` : null);
  const [f, setF] = useState({ supplierId: '', nte: '', note: '' });
  const [upd, setUpd] = useState<{ event: string; note: string; reference: string } | null>(null);
  const dispatch = useAction(async () => {
    const r = await api.post(`/api/work-orders/${w.id}/dispatch`, { supplierId: f.supplierId, nteAmount: f.nte ? Number(f.nte) : null, note: f.note || null });
    setShow(false); setF({ supplierId: '', nte: '', note: '' }); onDone();
    return r;
  });
  const update = useAction(async () => { await api.post(`/api/work-orders/${w.id}/vendor-update`, { event: upd!.event, note: upd!.note || null, reference: upd!.reference || null }); setUpd(null); onDone(); });
  const closed = ['completed', 'verified', 'closed', 'cancelled'].includes(w.status);
  if (!w.vendor_supplier_id && (!manage || closed) && !w.vendorSpend) return null;
  const next: Record<string, [string, string][]> = { dispatched: [['accepted', 'Accepted'], ['declined', 'Declined'], ['on_site', 'On site']], accepted: [['on_site', 'On site'], ['completed', 'Completed']], on_site: [['completed', 'Completed']] };
  return (
    <section className="card stack">
      <div className="spread"><h2>Contractor</h2>{w.vendor_status && <Pill tone={w.vendor_status === 'completed' ? 'good' : 'info'} label={humanize(w.vendor_status)} />}</div>
      {w.vendor_supplier_id ? (
        <div className="stack">
          <div><strong>{w.vendor_name}</strong>{w.vendor_phone && <> · <a href={`tel:${w.vendor_phone}`}>{w.vendor_phone}</a></>}{w.vendor_email && <> · {w.vendor_email}</>}
            {w.vendor_reference && <span className="faint"> · their ref {w.vendor_reference}</span>}</div>
          <div className="muted">Dispatched {fmtDateTime(w.dispatched_at)}{w.vendor_accepted_at ? ` · accepted ${fmtDateTime(w.vendor_accepted_at)}` : ''}{w.nte_amount ? ` · not to exceed ${fmtMoney(Number(w.nte_amount))}` : ''}
            {w.vendor_insurance_expires_on ? ` · insurance to ${fmtDate(w.vendor_insurance_expires_on)}` : ''}</div>
          {manage && next[w.vendor_status] && !upd && <div className="row">{next[w.vendor_status]!.map(([e, l]) => <button key={e} onClick={() => setUpd({ event: e, note: '', reference: '' })}>{l}</button>)}</div>}
          {upd && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void update.run(); }}>
              <strong>{humanize(upd.event)}</strong>
              {upd.event === 'completed' && <input id="vendor-remedy" aria-label="What the contractor did" placeholder="What the contractor did" value={upd.note} onChange={(e) => setUpd({ ...upd, note: e.target.value })} required style={{ flex: '1 1 260px' }} />}
              {upd.event !== 'completed' && <input aria-label="Note" placeholder="Note (optional)" value={upd.note} onChange={(e) => setUpd({ ...upd, note: e.target.value })} style={{ flex: '1 1 200px' }} />}
              <input aria-label="Contractor reference" placeholder="Their job number" value={upd.reference} onChange={(e) => setUpd({ ...upd, reference: e.target.value })} style={{ width: 150 }} />
              <button className="primary" disabled={update.busy}>Record</button><button type="button" onClick={() => setUpd(null)}>Cancel</button><ErrorNote message={update.error} />
            </form>
          )}
        </div>
      ) : manage && !closed && (show ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void dispatch.run(); }}>
          <div className="row">
            <input aria-label="Trade" placeholder="Trade (e.g. plumbing)" value={trade} onChange={(e) => setTrade(e.target.value.toLowerCase())} style={{ width: 170 }} />
            <select id="dispatch-contractor" aria-label="Contractor" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })} required>
              <option value="">Contractor…</option>
              {(contractors.data ?? []).map((c) => <option key={c.id} value={c.id} disabled={c.insurance_lapsed}>{c.name}{c.trades.length ? ` (${c.trades.join(', ')})` : ''}{c.insurance_lapsed ? ' — insurance lapsed' : ''}{c.open_jobs ? ` · ${c.open_jobs} open` : ''}</option>)}
            </select>
            <input id="dispatch-nte" type="number" min="1" step="0.01" aria-label="Not to exceed" placeholder="Not to exceed ($)" value={f.nte} onChange={(e) => setF({ ...f, nte: e.target.value })} style={{ width: 160 }} />
          </div>
          <input aria-label="Note to contractor" placeholder="Note to the contractor (access, contact)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <div className="row"><button className="primary" disabled={dispatch.busy}>Dispatch</button><button type="button" onClick={() => setShow(false)}>Cancel</button><ErrorNote message={dispatch.error} />
            <span className="faint">Emailed when the contractor has an email on file. Contractors with a lapsed certificate of insurance cannot be dispatched.</span></div>
        </form>
      ) : <div><button onClick={() => setShow(true)}>Send to a contractor</button></div>)}
      {w.vendorSpend && (
        <div className="stack">
          <div className="spread"><strong>Invoices</strong><span className={w.vendorSpend.overNte ? 'bad-text' : 'muted'}>{fmtMoney(w.vendorSpend.total)}{w.nte_amount ? ` of ${fmtMoney(Number(w.nte_amount))} limit` : ''}{w.vendorSpend.overNte ? ' — over the limit' : ''}</span></div>
          <Table rows={w.vendorSpend.invoices} rowKey={(i) => i.id} empty="No invoices yet."
            columns={[{ key: 'invoice_number', label: 'Invoice', render: (i) => <Link to={`/ap/${i.id}`}>{i.invoice_number}</Link> }, { key: 'supplier_name', label: 'From' },
              { key: 'status', label: 'Status', render: (i) => <Pill value={i.status} /> }, { key: 'total', label: 'Total', numeric: true, render: (i) => fmtMoney(i.total) }]} />
        </div>
      )}
    </section>
  );
}
