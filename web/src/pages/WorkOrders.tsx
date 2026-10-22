import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { DocLink } from './Documents';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi, useOutbox } from '../hooks';
import { WorkOrderMaterials } from '../components/Materials';
import { ContractorPanel, RequestInbox, SlaPills } from '../components/Contractors';

export function WorkOrders() {
  const nav = useNavigate();
  const { me, can } = useAuth();
  const [view, setView] = useState<'open' | 'mine' | 'all' | 'requests'>('open');
  const path = view === 'requests' ? null : view === 'open' ? '/api/work-orders?openOnly=true' : view === 'mine' ? '/api/work-orders?assigned=me' : '/api/work-orders';
  const { data, loading, error } = useApi<any[]>(path);
  return (
    <>
      <PageHead eyebrow="Maintenance" title="Work orders" />
      <div className="card stack">
        <div className="row" role="group" aria-label="Filter">
          {(['open', ...(me?.employeeId ? ['mine'] : []), 'all', ...(can('work_orders.manage') ? ['requests'] : [])] as const).map((v) => (
            <button key={v} className={view === v ? 'primary' : ''} onClick={() => setView(v as any)}>{v === 'open' ? 'Open' : v === 'mine' ? 'Assigned to me' : v === 'requests' ? 'Requests' : 'All'}</button>
          ))}
        </div>
        {view === 'requests' ? <RequestInbox /> : <Async loading={loading} error={error}>{() => (
          <Table rows={data ?? []} onRow={(w) => nav(`/work-orders/${w.id}`)} exception={(w) => w.overdue}
            columns={[{ key: 'number', label: 'WO', render: (w) => <strong>{w.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'asset_tag', label: 'Asset' },
              { key: 'title', label: 'Title' }, { key: 'priority', label: 'Pri', numeric: true }, { key: 'wo_type', label: 'Type', render: (w) => humanize(w.wo_type) },
              { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> },
              { key: 'vendor_name', label: 'Contractor', render: (w) => (w.vendor_name ? <>{w.vendor_name} <span className="faint">{humanize(w.vendor_status)}</span></> : '—') },
              { key: 'sla', label: 'Service level', render: (w) => <SlaPills sla={w.sla} compact /> },
              { key: 'due_at', label: 'Due', render: (w) => <>{fmtDate(w.due_at)}{w.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> }]} />
        )}</Async>}
      </div>
    </>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams();
  const { can, me } = useAuth();
  const { data: saved, loading, error, reload, offlineAt } = useApi<any>(`/api/work-orders/${id}`);
  const { items: queued } = useOutbox();
  const pending = queued.filter((q) => q.path.startsWith(`/api/work-orders/${id}/`));
  // Status changes made offline show at once; the server confirms them when the outbox is sent.
  const lastMove = [...pending].reverse().find((q) => q.path.endsWith('/transition') && !q.error);
  const w = saved && lastMove ? { ...saved, status: (lastMove.body as any).to } : saved;
  const transition = useAction(async (to: string, extra: Record<string, unknown> = {}) => { await api.post(`/api/work-orders/${id}/transition`, { to, ...extra }); await reload(); });
  return (
    <Async loading={loading && !w} error={error}>{() => {
      const f = w.facility_id;
      const exec = can('work_orders.execute', f);
      return (
        <>
          <PageHead eyebrow={`${w.facility_code} · ${w.number} · ${humanize(w.wo_type)} · priority ${w.priority}`} title={w.title}
            sub={<>{w.asset_class === 'space' ? 'Where' : 'Asset'} <Link to={`/assets/${w.asset_id}`}>{w.asset_tag} {w.asset_name}</Link></>}
            actions={<><SlaPills sla={w.sla} /> <Pill value={w.status} /></>} />
          <ErrorNote message={transition.error} />
          {(offlineAt || pending.length > 0) && (
            <div className="card stack" role="status">
              {offlineAt && <p className="muted" style={{ margin: 0 }}>Copy saved on this device {new Date(offlineAt).toLocaleString()}: no connection right now.</p>}
              {pending.length > 0 && <p style={{ margin: 0 }}>Waiting to be sent: {pending.map((q) => <span key={q.id}>{q.label}{q.error ? <> (<span className="bad-text">refused: {q.error}</span>)</> : ''}; </span>)}
                <Link to="/outbox">see all</Link></p>}
            </div>
          )}
          <section className="card stack">
            <h2>Next step</h2>
            {w.description && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{w.description}</p>}
            {['planned', 'scheduled', 'on_hold'].includes(w.status) && exec && !w.vendor_supplier_id && <div><button className="primary" disabled={transition.busy} onClick={() => transition.run('in_progress')}>Start work</button></div>}
            {w.status === 'in_progress' && exec && !w.vendor_supplier_id && <CompleteForm requireRemedy={w.wo_type === 'corrective'} onComplete={(remedy, findings) => transition.run('completed', { remedy: remedy || undefined, findings: findings || undefined })} busy={transition.busy} />}
            {w.status === 'completed' && (can('work_orders.verify', f)
              ? <div className="row"><button className="primary" disabled={transition.busy} onClick={() => transition.run('verified')}>Verify and return to service</button>
                  <button disabled={transition.busy} onClick={() => transition.run('in_progress', { note: 'Verification failed' })}>Reopen</button></div>
              : <p className="muted">Completed by {w.completed_by_name}. Waiting for someone else to verify and return the asset to service.</p>)}
            {w.status === 'verified' && can('work_orders.manage', f) && <div><button className="primary" disabled={transition.busy} onClick={() => transition.run('closed')}>Close</button></div>}
            {['closed', 'cancelled'].includes(w.status) && <p className="muted">This work order is {w.status}.</p>}
            {w.safety_notes && <div className="notice warn"><strong>Safety:</strong> {w.safety_notes}</div>}
          </section>
          <ContractorPanel w={w} onDone={reload} />
          <div className="grid two">
            <section className="card stack">
              <h2>People</h2>
              <Table rows={w.assignments} rowKey={(a) => a.employee_id} empty="No one assigned yet."
                columns={[{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role', render: (a) => humanize(a.role) }]} />
              {can('work_orders.manage', f) && !['completed', 'verified', 'closed', 'cancelled'].includes(w.status) && <AssignForm woId={w.id} facilityId={f} onDone={reload} />}
            </section>
            <section className="card stack">
              <h2>Procedures</h2>
              <Table rows={w.procedures} rowKey={(p) => p.version_id} empty="No procedure attached."
                columns={[{ key: 'doc_number', label: 'Number' }, { key: 'title', label: 'Title' }, { key: 'version_label', label: 'Version' },
                  { key: 'status', label: '', render: (p) => <><Pill value={p.status === 'approved' ? 'current' : p.status} tone={p.status === 'approved' ? 'good' : 'watch'} />{' '}
                    <DocLink id={p.document_id} versionId={p.version_id}>Open</DocLink></> }]} />
            </section>
          </div>
          <div className="grid two">
            <section className="card stack">
              <div className="spread"><h2>Labor</h2><span className="muted">{fmtNum(w.costs.laborHours)} h · {fmtMoney(w.costs.laborCost)}</span></div>
              <Table rows={w.labor} empty="No labor recorded."
                columns={[{ key: 'work_date', label: 'Date', render: (l) => fmtDate(l.work_date) }, { key: 'employee', label: 'Who' }, { key: 'hours', label: 'Hours', numeric: true }, { key: 'note', label: 'Note' }]} />
              {exec && ['in_progress', 'on_hold'].includes(w.status) && me?.employeeId && <LaborForm woId={w.id} onDone={reload} />}
            </section>
            <section className="card stack">
              <div className="spread"><h2>Parts</h2><span className="muted">{fmtMoney(w.costs.partsCost)} used</span></div>
              <Table rows={w.parts} empty="No parts planned or used."
                columns={[{ key: 'part_number', label: 'Part', render: (p) => <span style={{ whiteSpace: 'nowrap' }}>{p.part_number}</span> }, { key: 'description', label: 'Description' }, { key: 'qty_planned', label: 'Planned', numeric: true },
                  { key: 'qty_used', label: 'Used', numeric: true }, { key: 'location', label: 'From' }, { key: 'substitute_for', label: 'Substitutes' },
                  { key: 'ret', label: '', render: (p) => (exec && p.location_id && p.qty_used > 0 && !['closed', 'cancelled'].includes(w.status) ? <ReturnButton line={p} onDone={reload} /> : null) }]} />
              {exec && w.status === 'in_progress' && <PartForm woId={w.id} facilityId={f} planned={w.parts.filter((p: any) => p.qty_planned > 0)} onDone={reload} />}
            </section>
          </div>
          <WorkOrderMaterials w={w} onDone={reload} />
          {(w.purchases?.length > 0 || (can('purchasing.request', f) && w.parts.some((p: any) => p.qty_planned > p.qty_used) && !['closed', 'cancelled'].includes(w.status))) && (
            <Purchases w={w} />
          )}
          <section className="card">
            <h2>History</h2>
            <ul className="timeline">
              {w.history.map((h: any) => <li key={h.id}><span className="muted">{fmtDateTime(h.occurred_at)}</span><span><strong>{h.actor ?? 'System'}</strong> {humanize(h.action.split('.')[1])}{h.data?.to ? ` → ${humanize(h.data.to)}` : ''}{h.data?.hours ? ` (${h.data.hours} h)` : ''}</span></li>)}
            </ul>
          </section>
        </>
      );
    }}</Async>
  );
}

function CompleteForm({ onComplete, busy, requireRemedy }: { onComplete: (remedy: string, findings: string) => void; busy: boolean; requireRemedy: boolean }) {
  const [remedy, setRemedy] = useState('');
  const [findings, setFindings] = useState('');
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); onComplete(remedy, findings); }}>
      <label className="field">{requireRemedy ? 'What fixed it? (required)' : 'Work done'}<textarea id="wo-remedy" value={remedy} onChange={(e) => setRemedy(e.target.value)} required={requireRemedy} /></label>
      <label className="field">Findings<textarea id="wo-findings" value={findings} onChange={(e) => setFindings(e.target.value)} /></label>
      <div><button className="primary" disabled={busy || (requireRemedy && !remedy.trim())}>Mark work complete</button></div>
    </form>
  );
}

function LaborForm({ woId, onDone }: { woId: string; onDone: () => void }) {
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const act = useAction(async () => { await api.post(`/api/work-orders/${woId}/labor`, { workDate: date, hours: Number(hours) }); setHours(''); onDone(); });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <input id="labor-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} aria-label="Work date" />
      <input id="labor-hours" type="number" min="0.25" max="24" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Hours" style={{ width: 100 }} aria-label="Hours" required />
      <button disabled={act.busy}>Add my hours</button>
      <ErrorNote message={act.error} />
    </form>
  );
}

/** Records part usage. A part stocked at this facility is issued from the storeroom chosen here (stock goes down). */
function PartForm({ woId, facilityId, planned, onDone }: { woId: string; facilityId: string; planned: any[]; onDone: () => void }) {
  const parts = useApi<any[]>('/api/parts');
  const [partId, setPartId] = useState('');
  const [qty, setQty] = useState('1');
  const [locationId, setLocationId] = useState('');
  const stock = useApi<any[]>(partId ? `/api/inventory?facilityId=${facilityId}&partId=${partId}` : null);
  const act = useAction(async () => {
    await api.post(`/api/work-orders/${woId}/parts`, { partId, qtyUsed: Number(qty), locationId: locationId || null });
    setPartId(''); setLocationId(''); setQty('1'); onDone();
  });
  const choose = (id: string) => { setPartId(id); setLocationId(''); };
  const plannedIds = new Set(planned.map((p) => p.part_id));
  const list = [...(parts.data ?? [])].filter((p) => p.active).sort((a, b) => Number(plannedIds.has(b.id)) - Number(plannedIds.has(a.id)));
  const stocked = stock.data ?? [];
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <div className="row">
        <select id="part" value={partId} onChange={(e) => choose(e.target.value)} required style={{ maxWidth: 280 }} aria-label="Part">
          <option value="">Choose a part…</option>
          {list.map((p) => <option key={p.id} value={p.id}>{plannedIds.has(p.id) ? '★ ' : ''}{p.part_number} · {p.description}</option>)}
        </select>
        {partId && stocked.length > 0 && (
          <select id="part-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)} required aria-label="Taken from storeroom" style={{ maxWidth: 220 }}>
            <option value="">Taken from…</option>
            {stocked.map((s) => <option key={s.location_id} value={s.location_id} disabled={s.qty_on_hand <= 0}>{s.location} · {fmtNum(s.qty_on_hand, 3)} on hand{s.bin ? ` · bin ${s.bin}` : ''}</option>)}
          </select>
        )}
        <input id="part-qty" type="number" min="0.001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 90 }} aria-label="Quantity used" />
        <button disabled={act.busy || !partId || (stocked.length > 0 && !locationId)}>Record use</button>
      </div>
      {partId && stock.data && !stocked.length && <span className="muted">Not stocked at this site: recorded without a stock movement.</span>}
      <ErrorNote message={act.error} />
    </form>
  );
}

function ReturnButton({ line, onDone }: { line: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(line.qty_used));
  const act = useAction(async () => { await api.post(`/api/work-order-parts/${line.id}/return`, { qty: Number(qty) }); setOpen(false); onDone(); });
  if (!open) return <button onClick={() => setOpen(true)}>Return</button>;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <input aria-label={`Quantity to return to ${line.location}`} type="number" min="0.001" max={line.qty_used} step="any" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 70 }} />
      <button disabled={act.busy}>Return to {line.location}</button>
      {act.error && <span className="faint">{act.error}</span>}
    </form>
  );
}

function AssignForm({ woId, facilityId, onDone }: { woId: string; facilityId: string; onDone: () => void }) {
  const emps = useApi<any[]>(`/api/employees?facilityId=${facilityId}`);
  const [employeeId, setEmployeeId] = useState('');
  const act = useAction(async () => { await api.post(`/api/work-orders/${woId}/assignments`, { employeeId }); setEmployeeId(''); onDone(); });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <div className="row">
        <select id="assign-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required style={{ maxWidth: 280 }} aria-label="Technician">
          <option value="">Assign a technician…</option>
          {(emps.data ?? []).filter((e) => e.status === 'active').map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name} · {e.job_title ?? ''}</option>)}
        </select>
        <button disabled={act.busy || !employeeId}>Assign</button>
      </div>
      <ErrorNote message={act.error} />
    </form>
  );
}

function Purchases({ w }: { w: any }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const act = useAction(async () => { const pr = await api.post(`/api/work-orders/${w.id}/purchase-request`); nav(`/purchasing/requests/${pr.id}`); });
  return (
    <section className="card stack">
      <h2>Purchasing</h2>
      <Table rows={w.purchases} empty="Nothing requested for this work order."
        columns={[{ key: 'request_number', label: 'Request', render: (p) => <Link to={`/purchasing/requests/${p.request_id}`}>{p.request_number}</Link> },
          { key: 'description', label: 'Item', render: (p) => p.part_number ?? p.description }, { key: 'qty', label: 'Qty', numeric: true },
          { key: 'request_status', label: 'Request', render: (p) => humanize(p.request_status === 'closed' ? 'ordered' : p.request_status) },
          { key: 'order', label: 'Order', render: (p) => (p.order_id ? <><Link to={`/purchasing/orders/${p.order_id}`}>{p.order_number}</Link> · {humanize(p.order_status)}{p.expected_on ? `, expected ${fmtDate(p.expected_on)}` : ''}</> : '—') },
          { key: 'qty_received', label: 'Received', numeric: true, render: (p) => (p.qty_received == null ? '—' : fmtNum(p.qty_received, 3)) }]} />
      {can('purchasing.request', w.facility_id) && !['closed', 'cancelled'].includes(w.status) && w.parts.some((p: any) => p.qty_planned > p.qty_used) && (
        <div className="row"><button onClick={() => act.run()} disabled={act.busy}>Request parts not in stock</button><ErrorNote message={act.error} /></div>
      )}
    </section>
  );
}
