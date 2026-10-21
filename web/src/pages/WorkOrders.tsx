import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

export function WorkOrders() {
  const nav = useNavigate();
  const { me } = useAuth();
  const [view, setView] = useState<'open' | 'mine' | 'all'>('open');
  const path = view === 'open' ? '/api/work-orders?openOnly=true' : view === 'mine' ? '/api/work-orders?assigned=me' : '/api/work-orders';
  const { data, loading, error } = useApi<any[]>(path);
  return (
    <>
      <PageHead eyebrow="Maintenance" title="Work orders" />
      <div className="card stack">
        <div className="row" role="group" aria-label="Filter">
          {(['open', ...(me?.employeeId ? ['mine'] : []), 'all'] as const).map((v) => (
            <button key={v} className={view === v ? 'primary' : ''} onClick={() => setView(v as any)}>{v === 'open' ? 'Open' : v === 'mine' ? 'Assigned to me' : 'All'}</button>
          ))}
        </div>
        <Async loading={loading} error={error}>{() => (
          <Table rows={data ?? []} onRow={(w) => nav(`/work-orders/${w.id}`)} exception={(w) => w.overdue}
            columns={[{ key: 'number', label: 'WO', render: (w) => <strong>{w.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'asset_tag', label: 'Asset' },
              { key: 'title', label: 'Title' }, { key: 'priority', label: 'Pri', numeric: true }, { key: 'wo_type', label: 'Type', render: (w) => humanize(w.wo_type) },
              { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> },
              { key: 'due_at', label: 'Due', render: (w) => <>{fmtDate(w.due_at)}{w.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> }]} />
        )}</Async>
      </div>
    </>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams();
  const { can, me } = useAuth();
  const { data: w, loading, error, reload } = useApi<any>(`/api/work-orders/${id}`);
  const transition = useAction(async (to: string, extra: Record<string, unknown> = {}) => { await api.post(`/api/work-orders/${id}/transition`, { to, ...extra }); await reload(); });
  return (
    <Async loading={loading && !w} error={error}>{() => {
      const f = w.facility_id;
      const exec = can('work_orders.execute', f);
      return (
        <>
          <PageHead eyebrow={`${w.facility_code} · ${w.number} · ${humanize(w.wo_type)} · priority ${w.priority}`} title={w.title}
            sub={<>Asset <Link to={`/assets/${w.asset_id}`}>{w.asset_tag} {w.asset_name}</Link></>} actions={<Pill value={w.status} />} />
          <ErrorNote message={transition.error} />
          <section className="card stack">
            <h2>Next step</h2>
            {['planned', 'scheduled', 'on_hold'].includes(w.status) && exec && <div><button className="primary" disabled={transition.busy} onClick={() => transition.run('in_progress')}>Start work</button></div>}
            {w.status === 'in_progress' && exec && <CompleteForm onComplete={(remedy, findings) => transition.run('completed', { remedy, findings })} busy={transition.busy} />}
            {w.status === 'completed' && (can('work_orders.verify', f)
              ? <div className="row"><button className="primary" disabled={transition.busy} onClick={() => transition.run('verified')}>Verify and return to service</button>
                  <button disabled={transition.busy} onClick={() => transition.run('in_progress', { note: 'Verification failed' })}>Reopen</button></div>
              : <p className="muted">Completed by {w.completed_by_name}. Waiting for someone else to verify and return the asset to service.</p>)}
            {w.status === 'verified' && can('work_orders.manage', f) && <div><button className="primary" disabled={transition.busy} onClick={() => transition.run('closed')}>Close</button></div>}
            {['closed', 'cancelled'].includes(w.status) && <p className="muted">This work order is {w.status}.</p>}
            {w.safety_notes && <div className="notice warn"><strong>Safety:</strong> {w.safety_notes}</div>}
          </section>
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
                    <button onClick={() => api.download(`/api/document-versions/${p.version_id}/download`, p.doc_number)}>Open</button></> }]} />
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
                columns={[{ key: 'part_number', label: 'Part' }, { key: 'description', label: 'Description' }, { key: 'qty_planned', label: 'Planned', numeric: true },
                  { key: 'qty_used', label: 'Used', numeric: true }, { key: 'substitute_for', label: 'Substitutes' }]} />
              {exec && w.status === 'in_progress' && <PartForm woId={w.id} onDone={reload} />}
            </section>
          </div>
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

function CompleteForm({ onComplete, busy }: { onComplete: (remedy: string, findings: string) => void; busy: boolean }) {
  const [remedy, setRemedy] = useState('');
  const [findings, setFindings] = useState('');
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); onComplete(remedy, findings); }}>
      <label className="field">What fixed it? (required)<textarea id="wo-remedy" value={remedy} onChange={(e) => setRemedy(e.target.value)} required /></label>
      <label className="field">Findings<textarea id="wo-findings" value={findings} onChange={(e) => setFindings(e.target.value)} /></label>
      <div><button className="primary" disabled={busy || !remedy.trim()}>Mark work complete</button></div>
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

function PartForm({ woId, onDone }: { woId: string; onDone: () => void }) {
  const parts = useApi<any[]>('/api/parts');
  const [partId, setPartId] = useState('');
  const [qty, setQty] = useState('1');
  const act = useAction(async () => { await api.post(`/api/work-orders/${woId}/parts`, { partId, qtyUsed: Number(qty) }); onDone(); });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <select id="part" value={partId} onChange={(e) => setPartId(e.target.value)} required style={{ maxWidth: 280 }} aria-label="Part">
        <option value="">Choose a part…</option>
        {(parts.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}
      </select>
      <input id="part-qty" type="number" min="0.001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 90 }} aria-label="Quantity used" />
      <button disabled={act.busy || !partId}>Record use</button>
      <ErrorNote message={act.error} />
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
