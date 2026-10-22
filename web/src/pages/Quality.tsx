import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

type Tone = 'good' | 'watch' | 'bad' | 'info' | 'neutral';
const SEV: Record<string, Tone> = { minor: 'info', major: 'watch', critical: 'bad' };
const NCR_STATUS: Record<string, Tone> = { open: 'bad', contained: 'watch', dispositioned: 'info', closed: 'good', cancelled: 'neutral' };
const CAPA_STEPS = ['open', 'root_cause', 'actions', 'verification', 'closed'];
const CAPA_LABEL: Record<string, string> = { open: 'Containment', root_cause: 'Root cause', actions: 'Actions', verification: 'Effectiveness check', closed: 'Closed', cancelled: 'Cancelled' };
const DISPOSITIONS: [string, string][] = [['scrap', 'Scrap'], ['rework', 'Rework to drawing'], ['repair', 'Repair (concession)'], ['use_as_is', 'Use as is (concession)'], ['return_to_supplier', 'Return to supplier']];
const METHOD: Record<string, string> = { five_whys: '5 whys', fishbone: 'Fishbone (Ishikawa)', eight_d: '8D', other: 'Other' };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const TABS = [['ncrs', 'Nonconformances'], ['capas', 'Corrective actions'], ['actions', 'My actions']] as const;

export function Quality() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'ncrs';
  const { can } = useAuth();
  return (
    <>
      <PageHead eyebrow="Quality" title="Quality"
        sub="Raise nonconformances where problems are found, contain and disposition them, and fix causes with corrective actions that are checked for effectiveness." />
      <div className="row" role="tablist" aria-label="Quality">
        {TABS.filter(([k]) => k === 'actions' || can('quality.view')).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'ncrs' && <NcrList />}
      {tab === 'capas' && <CapaList />}
      {tab === 'actions' && <MyActions />}
    </>
  );
}

function NcrList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [open, setOpen] = useState(true);
  const { data, loading, error } = useApi<any[]>(open ? '/api/nonconformances?open=true' : '/api/nonconformances');
  const rows = data ?? [];
  return (
    <>
      <Kpis items={[
        { label: 'Open', value: rows.filter((r) => ['open', 'contained', 'dispositioned'].includes(r.status)).length },
        { label: 'Not yet contained', value: rows.filter((r) => r.status === 'open').length, tone: rows.some((r) => r.status === 'open') ? 'bad' : 'good' },
        { label: 'Major or critical without CAPA', value: rows.filter((r) => r.severity !== 'minor' && !r.capa_number && r.status !== 'closed').length },
      ]} />
      {can('quality.report') && <RaiseNcr onDone={(id) => nav(`/quality/ncr/${id}`)} />}
      <div className="card stack">
        <label className="row"><input id="ncr-open" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only open</label>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(r) => nav(`/quality/ncr/${r.id}`)} exception={(r) => r.status === 'open' && r.severity !== 'minor'} empty="No nonconformances."
            columns={[{ key: 'number', label: 'NCR', render: (r) => <strong>{r.number}</strong> }, { key: 'facility_code', label: 'Site' },
              { key: 'severity', label: 'Severity', render: (r) => <Pill tone={SEV[r.severity]} label={humanize(r.severity)} /> }, { key: 'source', label: 'Source', render: (r) => humanize(r.source) },
              { key: 'title', label: 'What' }, { key: 'qty', label: 'Qty', numeric: true, render: (r) => fmtNum(r.qty, 3) },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={NCR_STATUS[r.status]} label={humanize(r.status)} /> }, { key: 'capa_number', label: 'CAPA' },
              { key: 'age_days', label: 'Age', numeric: true, render: (r) => `${r.age_days} d` }]} />
        )}</Async>
      </div>
    </>
  );
}

function RaiseNcr({ onDone }: { onDone: (id: string) => void }) {
  const [show, setShow] = useState(false);
  const facilities = useApi<any[]>(show ? '/api/facilities' : null);
  const [pn, setPn] = useState('');
  const parts = useApi<any[]>(show && pn.length >= 2 ? `/api/parts?q=${encodeURIComponent(pn)}&limit=8` : null);
  const [f, setF] = useState({ facilityId: '', source: 'internal', severity: 'minor', partId: '', partLabel: '', qty: '', description: '' });
  const save = useAction(async () => {
    const n = await api.post('/api/nonconformances', { facilityId: f.facilityId, source: f.source, severity: f.severity, partId: f.partId || null, qty: f.qty ? Number(f.qty) : null, description: f.description });
    onDone(n.id);
  });
  if (!show) return <div><button className="primary" onClick={() => setShow(true)}>Raise a nonconformance</button></div>;
  return (
    <section className="card stack">
      <h2>Raise a nonconformance</h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="row">
          <select id="ncr-facility" aria-label="Facility" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required>
            <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </select>
          <select id="ncr-source" aria-label="Found at" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            {['internal', 'production', 'receiving', 'supplier', 'customer'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
          <select id="ncr-severity" aria-label="Severity" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            {['minor', 'major', 'critical'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
          <input id="ncr-qty" type="number" min="0" step="any" aria-label="Quantity affected" placeholder="Qty affected" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} style={{ width: 120 }} />
        </div>
        {f.partId ? <div className="row">Part: <strong>{f.partLabel}</strong><button type="button" className="link" onClick={() => setF({ ...f, partId: '', partLabel: '' })}>change</button></div> : (
          <div className="stack">
            <input id="ncr-part" aria-label="Part (optional)" placeholder="Part (optional): type a part number" value={pn} onChange={(e) => setPn(e.target.value)} />
            <div className="row">{(parts.data ?? []).map((p) => <button type="button" key={p.id} onClick={() => { setF({ ...f, partId: p.id, partLabel: `${p.part_number} · ${p.description}` }); setPn(''); }}>{p.part_number}</button>)}</div>
          </div>
        )}
        <label className="field">What is wrong<textarea id="ncr-description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /></label>
        <div className="row"><button className="primary" disabled={save.busy}>Raise</button><button type="button" onClick={() => setShow(false)}>Cancel</button></div>
        <ErrorNote message={save.error} />
      </form>
    </section>
  );
}

export function NcrDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: n, loading, error, reload } = useApi<any>(`/api/nonconformances/${id}`);
  const [containment, setContainment] = useState('');
  const [d, setD] = useState({ disposition: 'scrap', reason: '', cost: '' });
  const [capaId, setCapaId] = useState('');
  const [reason, setReason] = useState('');
  const contain = useAction(async () => { await api.post(`/api/nonconformances/${id}/contain`, { containment }); setContainment(''); await reload(); });
  const dispose = useAction(async () => { await api.post(`/api/nonconformances/${id}/disposition`, { disposition: d.disposition, reason: d.reason || null, cost: d.cost ? Number(d.cost) : null }); await reload(); });
  const link = useAction(async () => { await api.post(`/api/nonconformances/${id}/link`, { capaId }); await reload(); });
  const close = useAction(async () => { await api.post(`/api/nonconformances/${id}/close`, {}); await reload(); });
  const cancel = useAction(async () => { await api.post(`/api/nonconformances/${id}/cancel`, { reason }); await reload(); });
  return (
    <Async loading={loading && !n} error={error}>{() => {
      const manage = can('quality.manage', n.facility_id);
      const active = ['open', 'contained'].includes(n.status);
      const concession = ['use_as_is', 'repair'].includes(d.disposition) && n.severity !== 'minor';
      return (
        <>
          <PageHead eyebrow={`${n.facility_code} · Nonconformance · ${humanize(n.source)}`} title={<>{n.number} <span className="muted" style={{ fontWeight: 400 }}>{n.title}</span></>}
            sub={<>Raised {fmtDateTime(n.created_at)} by {n.reported_by_name}</>}
            actions={<><Pill tone={SEV[n.severity]} label={humanize(n.severity)} /> <Pill tone={NCR_STATUS[n.status]} label={humanize(n.status)} /></>} />
          <section className="card stack">
            <p style={{ whiteSpace: 'pre-wrap' }}>{n.description}</p>
            <dl className="facts">
              {n.part_number && <><dt>Part</dt><dd>{n.part_number} · {n.part_description}</dd></>}
              {n.qty != null && <><dt>Quantity</dt><dd>{fmtNum(n.qty, 3)} {n.uom ?? ''}</dd></>}
              {n.production_order_number && <><dt>Production order</dt><dd><Link to={`/production/orders/${n.production_order_id}`}>{n.production_order_number}</Link>{n.op_no ? ` op ${n.op_no}` : ''}{n.scrap_label ? ` · ${n.scrap_label}` : ''}</dd></>}
              {n.purchase_order_number && <><dt>Purchase order</dt><dd><Link to={`/purchasing/orders/${n.purchase_order_id}`}>{n.purchase_order_number}</Link></dd></>}
              {n.supplier_name && <><dt>Supplier</dt><dd>{n.supplier_name}</dd></>}
              {n.customer_name && <><dt>Customer</dt><dd>{n.customer_name}{n.sales_order_number ? ` · ${n.sales_order_number}` : ''}</dd></>}
              {n.asset_tag && <><dt>Equipment</dt><dd><Link to={`/assets/${n.asset_id}`}>{n.asset_tag}</Link></dd></>}
            </dl>
          </section>
          <section className="card stack">
            <h2>1. Containment</h2>
            {n.containment ? <p>{n.containment} <span className="faint">({n.contained_by_name}, {fmtDateTime(n.contained_at)})</span></p> : <p className="muted">Not contained yet.</p>}
            {manage && active && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void contain.run(); }}>
                <input id="ncr-containment" aria-label="Containment" placeholder="What was done to stop it spreading (quarantine, sort, hold)" value={containment} onChange={(e) => setContainment(e.target.value)} style={{ flex: '1 1 360px' }} />
                <button disabled={contain.busy || containment.trim().length < 3}>{n.containment ? 'Update' : 'Record containment'}</button><ErrorNote message={contain.error} />
              </form>
            )}
          </section>
          <section className="card stack">
            <h2>2. Disposition</h2>
            {n.disposition ? <p><strong>{DISPOSITIONS.find(([k]) => k === n.disposition)?.[1]}</strong>{n.disposition_reason ? `: ${n.disposition_reason}` : ''}
              {n.cost != null && <> · cost {fmtMoney(n.cost)}</>} <span className="faint">({n.dispositioned_by_name}, {fmtDateTime(n.dispositioned_at)})</span></p> : <p className="muted">Not decided yet.</p>}
            {manage && active && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void dispose.run(); }}>
                <div className="row">
                  <select id="ncr-disposition" aria-label="Disposition" value={d.disposition} onChange={(e) => setD({ ...d, disposition: e.target.value })}>
                    {DISPOSITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <input id="ncr-cost" type="number" min="0" step="0.01" aria-label="Cost" placeholder={d.disposition === 'scrap' ? 'Cost (blank = qty × unit cost)' : 'Cost (optional)'} value={d.cost} onChange={(e) => setD({ ...d, cost: e.target.value })} style={{ width: 220 }} />
                </div>
                <input id="ncr-reason" aria-label="Justification" placeholder={concession ? 'Justification (required): who accepted it and why' : 'Note (optional)'} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} />
                {concession && <p className="faint">Accepting a {n.severity} nonconformance is a concession: someone other than the reporter must record it, with a justification.</p>}
                <div><button className="primary" disabled={dispose.busy}>Record disposition</button></div><ErrorNote message={dispose.error} />
              </form>
            )}
          </section>
          <section className="card stack">
            <h2>3. Corrective action</h2>
            {n.capa_number ? <p><Link to={`/quality/capa/${n.capa_id}`}>{n.capa_number}</Link> <span className="faint">{CAPA_LABEL[n.capa_status]}</span></p>
              : <p className="muted">{n.severity === 'minor' ? 'Optional for a minor nonconformance.' : `Required before a ${n.severity} nonconformance closes.`}</p>}
            {manage && !n.capa_id && !['closed', 'cancelled'].includes(n.status) && (
              <div className="row">
                {n.openCapas.length > 0 && <>
                  <select id="ncr-capa" aria-label="Existing corrective action" value={capaId} onChange={(e) => setCapaId(e.target.value)}>
                    <option value="">Link to an open corrective action…</option>{n.openCapas.map((c: any) => <option key={c.id} value={c.id}>{c.number} · {c.title}</option>)}
                  </select>
                  <button onClick={() => link.run()} disabled={!capaId || link.busy}>Link</button>
                </>}
                <button onClick={() => nav(`/quality/capa/new?ncr=${n.id}&facility=${n.facility_id}`)}>Open a corrective action</button>
                <ErrorNote message={link.error} />
              </div>
            )}
          </section>
          {manage && n.status === 'dispositioned' && <div className="row"><button className="primary" onClick={() => close.run()} disabled={close.busy}>Close nonconformance</button><ErrorNote message={close.error} /></div>}
          {manage && !['closed', 'cancelled'].includes(n.status) && (
            <section className="card">
              <form className="row" onSubmit={(e) => { e.preventDefault(); void cancel.run(); }}>
                <input id="ncr-cancel" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is not a nonconformance (raised in error, duplicate…)" aria-label="Cancel reason" style={{ flex: '1 1 320px' }} />
                <button className="danger" disabled={cancel.busy || reason.trim().length < 3}>Cancel</button><ErrorNote message={cancel.error} />
              </form>
            </section>
          )}
          {n.status === 'cancelled' && <div className="notice warn">Cancelled: {n.cancel_reason}</div>}
        </>
      );
    }}</Async>
  );
}

function CapaList() {
  const nav = useNavigate();
  const [mine, setMine] = useState(false);
  const { data, loading, error } = useApi<any[]>(`/api/corrective-actions?open=true${mine ? '&mine=true' : ''}`);
  return (
    <div className="card stack">
      <label className="row"><input id="capa-mine" type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(r) => nav(`/quality/capa/${r.id}`)} exception={(r) => r.overdue} empty="No open corrective actions."
          columns={[{ key: 'number', label: 'CAPA', render: (r) => <strong>{r.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'title', label: 'Problem' },
            { key: 'source', label: 'From', render: (r) => humanize(r.source) }, { key: 'priority', label: 'Priority', render: (r) => humanize(r.priority) }, { key: 'owner_name', label: 'Owner' },
            { key: 'status', label: 'Step', render: (r) => CAPA_LABEL[r.status] }, { key: 'open_actions', label: 'Open actions', numeric: true },
            { key: 'due_date', label: 'Due', render: (r) => <>{fmtDate(r.due_date)}{r.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> }]} />
      )}</Async>
    </div>
  );
}

export function MyActions() {
  const { data, loading, error, reload } = useApi<any[]>('/api/actions/mine');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const done = useAction(async (id: string) => { await api.post(`/api/actions/${id}/complete`, { note: notes[id] }); await reload(); });
  return (
    <div className="card stack">
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} empty="No open actions assigned to you." exception={(a) => a.overdue}
          columns={[{ key: 'subject_number', label: 'For', render: (a) => <Link to={a.subject_type === 'corrective_action' ? `/quality/capa/${a.subject_id}` : `/safety/${a.subject_id}`}>{a.subject_number}</Link> },
            { key: 'title', label: 'Action' }, { key: 'due_date', label: 'Due', render: (a) => <>{fmtDate(a.due_date)}{a.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> },
            { key: 'done', label: '', render: (a) => (
              <div className="row">
                <input aria-label={`What was done: ${a.title}`} placeholder="What was done" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                <button onClick={() => done.run(a.id)} disabled={done.busy || (notes[a.id] ?? '').trim().length < 3}>Done</button>
              </div>) }]} />
      )}</Async>
      <ErrorNote message={done.error} />
    </div>
  );
}

/** Actions on a corrective action or incident: list, add (for whoever plans them), complete. */
export function ActionList({ subjectType, subjectId, facilityId, actions, canPlan, open, onChange }: {
  subjectType: 'corrective_action' | 'safety_incident'; subjectId: string; facilityId: string; actions: any[]; canPlan: boolean; open: boolean; onChange: () => void }) {
  const { me } = useAuth();
  const users = useApi<any[]>(canPlan && open ? `/api/assignable-users?facilityId=${facilityId}` : null);
  const [f, setF] = useState({ title: '', ownerUserId: '', dueDate: inDays(14) });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const add = useAction(async () => { await api.post('/api/actions', { subjectType, subjectId, ...f }); setF({ title: '', ownerUserId: '', dueDate: inDays(14) }); onChange(); });
  const done = useAction(async (id: string) => { await api.post(`/api/actions/${id}/complete`, { note: notes[id] }); onChange(); });
  return (
    <section className="card stack">
      <h2>Actions</h2>
      <Table rows={actions} empty="No actions yet." exception={(a) => a.overdue}
        columns={[{ key: 'title', label: 'Action' }, { key: 'owner_name', label: 'Owner' }, { key: 'due_date', label: 'Due', render: (a) => fmtDate(a.due_date) },
          { key: 'status', label: 'Status', render: (a) => (a.status === 'done' ? <><Pill tone="good" label="Done" /> <span className="faint">{a.completion_note}</span></> : a.status === 'cancelled' ? 'Cancelled' : a.overdue ? <Pill tone="bad" label="Overdue" /> : 'Open') },
          { key: 'act', label: '', render: (a) => (a.status === 'open' && (a.owner_user_id === me?.userId || canPlan) ? (
            <div className="row">
              <input aria-label={`What was done: ${a.title}`} placeholder="What was done" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
              <button onClick={() => done.run(a.id)} disabled={done.busy || (notes[a.id] ?? '').trim().length < 3}>Done</button>
            </div>) : null) }]} />
      <ErrorNote message={done.error} />
      {canPlan && open && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <input id="action-title" aria-label="New action" placeholder="New action" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required style={{ flex: '1 1 280px' }} />
          <select id="action-owner" aria-label="Owner" value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} required>
            <option value="">Owner…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
          <input id="action-due" type="date" aria-label="Due" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} required />
          <button disabled={add.busy}>Add action</button><ErrorNote message={add.error} />
        </form>
      )}
    </section>
  );
}

export function NewCapa() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const facilityId = params.get('facility') ?? '';
  const ncr = params.get('ncr');
  const incident = params.get('incident');
  const users = useApi<any[]>(facilityId ? `/api/assignable-users?facilityId=${facilityId}` : null);
  const n = useApi<any>(ncr ? `/api/nonconformances/${ncr}` : null);
  const [f, setF] = useState({ title: '', problem: '', priority: 'medium', ownerUserId: '', dueDate: inDays(30) });
  const save = useAction(async () => {
    const c = await api.post('/api/corrective-actions', { facilityId, ...f, title: f.title || n.data?.title, problem: f.problem || n.data?.description,
      source: incident ? 'incident' : ncr ? 'nonconformance' : 'internal', ncrIds: ncr ? [ncr] : [], incidentId: incident });
    nav(`/quality/capa/${c.id}`);
  });
  return (
    <>
      <PageHead eyebrow="Quality" title="Open a corrective action" sub={n.data ? `For ${n.data.number}: ${n.data.title}` : incident ? 'For a safety incident' : undefined} />
      <section className="card stack">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <input id="capa-title" aria-label="Title" placeholder={n.data?.title ?? 'Title'} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required={!n.data} />
          <label className="field">Problem statement<textarea id="capa-problem" placeholder={n.data?.description} value={f.problem} onChange={(e) => setF({ ...f, problem: e.target.value })} required={!n.data} /></label>
          <div className="row">
            <select id="capa-owner" aria-label="Owner" value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} required>
              <option value="">Owner…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
            <select id="capa-priority" aria-label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['low', 'medium', 'high'].map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select>
            <label className="row">Due<input id="capa-due" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
          </div>
          <div><button className="primary" disabled={save.busy || !facilityId}>Open corrective action</button></div>
          <ErrorNote message={save.error} />
        </form>
      </section>
    </>
  );
}

export function CapaDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const { data: c, loading, error, reload } = useApi<any>(`/api/corrective-actions/${id}`);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [v, setV] = useState({ effective: 'true', note: '' });
  const save = useAction(async () => { await api.patch(`/api/corrective-actions/${id}`, edit); setEdit({}); await reload(); });
  const advance = useAction(async () => { await api.post(`/api/corrective-actions/${id}/advance`, {}); await reload(); });
  const verify = useAction(async () => { await api.post(`/api/corrective-actions/${id}/verify`, { effective: v.effective === 'true', note: v.note }); await reload(); });
  return (
    <Async loading={loading && !c} error={error}>{() => {
      const editor = c.canManage || c.owner_user_id === me?.userId;
      const open = !['closed', 'cancelled'].includes(c.status);
      const val = (k: string, fallback: any) => edit[k] ?? fallback ?? '';
      const field = (k: string, label: string, current: string | null, rows = 3) => (
        <label className="field">{label}
          {editor && open ? <textarea id={`capa-${k}`} rows={rows} value={val(k, current)} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /> : <p style={{ whiteSpace: 'pre-wrap' }}>{current ?? '—'}</p>}
        </label>
      );
      return (
        <>
          <PageHead eyebrow={`${c.facility_code} · Corrective action · ${humanize(c.source)}`} title={<>{c.number} <span className="muted" style={{ fontWeight: 400 }}>{c.title}</span></>}
            sub={<>Owner {c.owner_name} · due {fmtDate(c.due_date)} · {humanize(c.priority)} priority</>}
            actions={<>{c.overdue && <Pill tone="bad" label="Overdue" />} <Pill tone={c.status === 'closed' ? 'good' : c.status === 'cancelled' ? 'neutral' : 'watch'} label={CAPA_LABEL[c.status]} /></>} />
          <div className="steps" aria-label="Steps">
            {CAPA_STEPS.map((s) => <span key={s} className={s === c.status ? 'now' : CAPA_STEPS.indexOf(s) < CAPA_STEPS.indexOf(c.status) ? 'done' : ''}>{CAPA_LABEL[s]}</span>)}
          </div>
          <section className="card stack">
            <h2>Problem</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.problem}</p>
            {c.ncrs.length > 0 && <p>Nonconformances: {c.ncrs.map((n: any) => <span key={n.id}><Link to={`/quality/ncr/${n.id}`}>{n.number}</Link> <span className="faint">({humanize(n.severity)}, {humanize(n.status)})</span> </span>)}</p>}
            {c.incidents.length > 0 && <p>Incidents: {c.incidents.map((i: any) => <span key={i.id}><Link to={`/safety/${i.id}`}>{i.number}</Link> </span>)}</p>}
          </section>
          <section className="card stack">
            <h2>Containment and root cause</h2>
            {field('containment', 'Containment (what protects the customer until the fix is in)', c.containment, 2)}
            <label className="field">How the root cause was found
              {editor && open ? (
                <select id="capa-rootCauseMethod" value={val('rootCauseMethod', c.root_cause_method)} onChange={(e) => setEdit({ ...edit, rootCauseMethod: e.target.value })}>
                  <option value="">Choose…</option>{Object.entries(METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>) : <p>{METHOD[c.root_cause_method] ?? '—'}</p>}
            </label>
            {field('rootCause', 'Root cause', c.root_cause)}
            {editor && open && Object.keys(edit).length > 0 && <div className="row"><button onClick={() => save.run()} disabled={save.busy}>Save</button><ErrorNote message={save.error} /></div>}
          </section>
          <ActionList subjectType="corrective_action" subjectId={c.id} facilityId={c.facility_id} actions={c.actions} canPlan={editor} open={open} onChange={reload} />
          {editor && ['open', 'root_cause', 'actions'].includes(c.status) && (
            <div className="row"><button className="primary" onClick={() => advance.run()} disabled={advance.busy}>Move to {CAPA_LABEL[CAPA_STEPS[CAPA_STEPS.indexOf(c.status) + 1]!]}</button><ErrorNote message={advance.error} /></div>
          )}
          {(c.status === 'verification' || c.verified_at || c.effectiveness_note) && (
            <section className="card stack">
              <h2>Effectiveness check</h2>
              {c.effectiveness_note && <p>{c.effective ? <Pill tone="good" label="Effective" /> : <Pill tone="bad" label="Not effective" />} {c.effectiveness_note}{c.verified_by_name ? <span className="faint"> ({c.verified_by_name}, {fmtDateTime(c.verified_at)})</span> : null}</p>}
              {c.status === 'verification' && <p className="muted">Due {fmtDate(c.verify_after)}. Checked by quality, not by the owner.</p>}
              {c.status === 'verification' && c.canManage && c.owner_user_id !== me?.userId && (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
                  <div className="row">
                    <select id="capa-effective" aria-label="Result" value={v.effective} onChange={(e) => setV({ ...v, effective: e.target.value })}><option value="true">Effective: close it</option><option value="false">Not effective: more actions needed</option></select>
                  </div>
                  <input id="capa-evidence" aria-label="Evidence" placeholder="Evidence: data, audits, samples since the actions" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} required />
                  <div><button className="primary" disabled={verify.busy}>Record check</button></div><ErrorNote message={verify.error} />
                </form>
              )}
            </section>
          )}
        </>
      );
    }}</Async>
  );
}
