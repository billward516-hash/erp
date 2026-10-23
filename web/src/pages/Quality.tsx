import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { SpcList } from './Spc';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';
import { Attachments } from '../components/Attachments';
import { FmeaList } from './Fmea';

type Tone = 'good' | 'watch' | 'bad' | 'info' | 'neutral';
const SEV: Record<string, Tone> = { minor: 'info', major: 'watch', critical: 'bad' };
const NCR_STATUS: Record<string, Tone> = { open: 'bad', contained: 'watch', dispositioned: 'info', closed: 'good', cancelled: 'neutral' };
const CAPA_STEPS = ['open', 'root_cause', 'actions', 'verification', 'closed'];
const CAPA_LABEL: Record<string, string> = { open: 'Containment', root_cause: 'Root cause', actions: 'Actions', verification: 'Effectiveness check', closed: 'Closed', cancelled: 'Cancelled' };
const DISPOSITIONS: [string, string][] = [['scrap', 'Scrap'], ['rework', 'Rework to drawing'], ['repair', 'Repair (concession)'], ['use_as_is', 'Use as is (concession)'], ['return_to_supplier', 'Return to supplier']];
const METHOD: Record<string, string> = { five_whys: '5 whys', fishbone: 'Fishbone (Ishikawa)', eight_d: '8D', other: 'Other' };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const TABS = [['ncrs', 'Nonconformances'], ['capas', 'Corrective actions'], ['fmea', 'FMEA'], ['spc', 'SPC'], ['calibration', 'Calibration'], ['audits', 'Audits'], ['actions', 'My actions']] as const;

export function Quality() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'ncrs';
  const { can, feature } = useAuth();
  return (
    <>
      <PageHead eyebrow="Quality" title="Quality"
        sub="Raise nonconformances where problems are found, contain and disposition them, and fix causes with corrective actions that are checked for effectiveness." />
      <div className="row" role="tablist" aria-label="Quality">
        {TABS.filter(([k]) => (k === 'actions' || can('quality.view')) && !(k === 'fmea' && !feature('fmea')) && !(k === 'spc' && !feature('spc'))).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'ncrs' && <NcrList />}
      {tab === 'capas' && <CapaList />}
      {tab === 'fmea' && feature('fmea') && <FmeaList />}
      {tab === 'spc' && feature('spc') && <SpcList />}
      {tab === 'calibration' && <CalibrationList />}
      {tab === 'audits' && <AuditList />}
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
  const [holdIds, setHoldIds] = useState<string[]>([]);
  const holdLots = useAction(async () => { await api.post(`/api/nonconformances/${id}/hold-lots`, { lotIds: holdIds }); setHoldIds([]); await reload(); });
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
              {n.supplier_name && <><dt>Supplier</dt><dd><Link to={`/purchasing/suppliers/${n.supplier_id}`}>{n.supplier_name}</Link>{!n.capa_id && <span className="faint"> · ask them for corrective action from their page</span>}</dd></>}
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
            {n.lots?.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <h3>Lots of {n.part_number}</h3>
                <p className="faint">Held lots cannot be issued or shipped. They are released when this closes after use as is, rework or repair; scrapped or returned lots stay held until they leave stock.</p>
                <Table rows={n.lots} columns={[
                  ...(manage && active ? [{ key: 'pick', label: 'Hold', render: (l: any) => (l.status === 'available'
                    ? <input type="checkbox" aria-label={`Hold lot ${l.number}`} checked={holdIds.includes(l.id)} onChange={(e) => setHoldIds(e.target.checked ? [...holdIds, l.id] : holdIds.filter((x) => x !== l.id))} /> : null) }] : []),
                  { key: 'number', label: 'Lot', render: (l: any) => <Link to={`/inventory/lots/${l.id}`}>{l.number}</Link> },
                  { key: 'on_hand', label: 'On hand', numeric: true, render: (l: any) => fmtNum(l.on_hand, 3) },
                  { key: 'status', label: 'Status', render: (l: any) => (l.status === 'hold' ? <Pill tone="bad" label={l.held_here ? 'Held for this' : 'On hold'} /> : <Pill tone="good" label="Available" />) }]} />
                {manage && active && <div className="row"><button onClick={() => holdLots.run()} disabled={holdLots.busy || !holdIds.length}>Put the chosen lots on hold</button><ErrorNote message={holdLots.error} /></div>}
              </div>
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
          <Attachments subjectType="nonconformance" subjectId={n.id} title="Photos and files" />
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
          columns={[{ key: 'number', label: 'CAPA', render: (r) => <><strong>{r.number}</strong>{r.format === 'eight_d' && <span className="faint"> · 8D</span>}</> }, { key: 'facility_code', label: 'Site' }, { key: 'title', label: 'Problem' },
            { key: 'source', label: 'From', render: (r) => humanize(r.source) }, { key: 'priority', label: 'Priority', render: (r) => humanize(r.priority) }, { key: 'owner_name', label: 'Owner' },
            { key: 'status', label: 'Step', render: (r) => CAPA_LABEL[r.status] }, { key: 'open_actions', label: 'Open actions', numeric: true },
            { key: 'due_date', label: 'Due', render: (r) => <>{fmtDate(r.due_date)}{r.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> }]} />
      )}</Async>
    </div>
  );
}

const ACTION_LINK: Record<string, string> = { corrective_action: '/quality/capa/', safety_incident: '/safety/', quality_audit: '/quality/audits/', fmea: '/quality/fmea/', continuity_plan: '/continuity/', site_visit: '/stores/visits/', improvement: '/improvements/' };

export function MyActions() {
  const { data, loading, error, reload } = useApi<any[]>('/api/actions/mine');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const done = useAction(async (id: string) => { await api.post(`/api/actions/${id}/complete`, { note: notes[id] }); await reload(); });
  return (
    <div className="card stack">
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} empty="No open actions assigned to you." exception={(a) => a.overdue}
          columns={[{ key: 'subject_number', label: 'For', render: (a) => <Link to={`${ACTION_LINK[a.subject_type] ?? '/safety/'}${a.subject_id}`}>{a.subject_number}</Link> },
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
const DISCIPLINE: Record<string, string> = { containment: 'Containment (D3)', corrective: 'Corrective (D5)', preventive: 'Preventive (D7)' };

export function ActionList({ subjectType, subjectId, facilityId, actions, canPlan, open, onChange, disciplines = false }: {
  subjectType: 'corrective_action' | 'safety_incident' | 'quality_audit'; subjectId: string; facilityId: string; actions: any[]; canPlan: boolean; open: boolean; onChange: () => void;
  /** 8D: each action is containment, corrective or preventive. */ disciplines?: boolean }) {
  const { me } = useAuth();
  const users = useApi<any[]>(canPlan && open ? `/api/assignable-users?facilityId=${facilityId}` : null);
  const blank = { title: '', ownerUserId: '', dueDate: inDays(14), discipline: 'corrective' };
  const [f, setF] = useState(blank);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const add = useAction(async () => {
    const { discipline, ...rest } = f;
    await api.post('/api/actions', { subjectType, subjectId, ...rest, ...(disciplines ? { discipline } : {}) }); setF(blank); onChange();
  });
  const done = useAction(async (id: string) => { await api.post(`/api/actions/${id}/complete`, { note: notes[id] }); onChange(); });
  return (
    <section className="card stack">
      <h2>Actions</h2>
      <Table rows={actions} empty="No actions yet." exception={(a) => a.overdue}
        columns={[{ key: 'title', label: 'Action' }, ...(disciplines ? [{ key: 'discipline', label: 'Kind', render: (a: any) => (a.discipline ? DISCIPLINE[a.discipline] : '—') }] : []), { key: 'owner_name', label: 'Owner' }, { key: 'due_date', label: 'Due', render: (a) => fmtDate(a.due_date) },
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
          {disciplines && <select id="action-discipline" aria-label="Kind of action" value={f.discipline} onChange={(e) => setF({ ...f, discipline: e.target.value })}>
            {Object.entries(DISCIPLINE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
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
  const [f, setF] = useState({ title: '', problem: '', priority: 'medium', ownerUserId: '', dueDate: inDays(30), format: 'standard' as 'standard' | 'eight_d' });
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
            <label className="row"><input id="capa-8d" type="checkbox" checked={f.format === 'eight_d'} onChange={(e) => setF({ ...f, format: e.target.checked ? 'eight_d' : 'standard' })} /> Run as an 8D</label>
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
  const to8d = useAction(async () => { await api.patch(`/api/corrective-actions/${id}`, { format: 'eight_d' }); await reload(); });
  return (
    <Async loading={loading && !c} error={error}>{() => {
      const editor = c.canManage || c.owner_user_id === me?.userId;
      const open = !['closed', 'cancelled'].includes(c.status);
      const eightD = c.format === 'eight_d';
      const val = (k: string, fallback: any) => edit[k] ?? fallback ?? '';
      const field = (k: string, label: string, current: string | null, rows = 3) => (
        <label className="field">{label}
          {editor && open ? <textarea id={`capa-${k}`} rows={rows} value={val(k, current)} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /> : <p style={{ whiteSpace: 'pre-wrap' }}>{current ?? '—'}</p>}
        </label>
      );
      return (
        <>
          <PageHead eyebrow={`${c.facility_code} · ${c.action_type === 'preventive' ? 'Preventive action' : 'Corrective action'} · ${humanize(c.source)}`} title={<>{c.number} <span className="muted" style={{ fontWeight: 400 }}>{c.title}</span></>}
            sub={<>Owner {c.owner_name} · due {fmtDate(c.due_date)} · {humanize(c.priority)} priority{c.origin && <> · from <Link to={c.origin.link}>{c.origin.label}</Link></>}</>}
            actions={<>{c.overdue && <Pill tone="bad" label="Overdue" />} <Pill tone={c.status === 'closed' ? 'good' : c.status === 'cancelled' ? 'neutral' : 'watch'} label={CAPA_LABEL[c.status]} />
              {eightD && <button onClick={() => api.open(`/api/corrective-actions/${c.id}/8d.pdf`)}>8D report</button>}
              {!eightD && editor && c.status === 'open' && c.action_type !== 'preventive' && <button onClick={() => to8d.run()} disabled={to8d.busy}>Run as an 8D</button>}</>} />
          <ErrorNote message={to8d.error} />
          {eightD && <Disciplines list={c.disciplines} />}
          <div className="steps" aria-label="Steps">
            {CAPA_STEPS.map((s) => <span key={s} className={s === c.status ? 'now' : CAPA_STEPS.indexOf(s) < CAPA_STEPS.indexOf(c.status) ? 'done' : ''}>{CAPA_LABEL[s]}</span>)}
          </div>
          <section className="card stack">
            <h2>Problem</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.problem}</p>
            {c.ncrs.length > 0 && <p>Nonconformances: {c.ncrs.map((n: any) => <span key={n.id}><Link to={`/quality/ncr/${n.id}`}>{n.number}</Link> <span className="faint">({humanize(n.severity)}, {humanize(n.status)})</span> </span>)}</p>}
            {c.incidents.length > 0 && <p>Incidents: {c.incidents.map((i: any) => <span key={i.id}><Link to={`/safety/${i.id}`}>{i.number}</Link> </span>)}</p>}
          </section>
          {c.supplier_id && <SupplierResponse c={c} canEdit={editor && open} onDone={reload} />}
          {eightD && <EightDTeam c={c} editor={editor && open} onChange={reload} />}
          {eightD && <IsIsNot c={c} editor={editor && open} onChange={reload} />}
          <section className="card stack">
            <h2>{eightD ? 'D3 Containment and D4 root causes' : 'Containment and root cause'}</h2>
            {field('containment', 'Containment (what protects the customer until the fix is in)', c.containment, 2)}
            {eightD && field('containmentVerification', 'How we know the containment works (sort results, checks since)', c.containment_verification, 2)}
            <label className="field">How the root cause was found
              {editor && open ? (
                <select id="capa-rootCauseMethod" value={val('rootCauseMethod', c.root_cause_method)} onChange={(e) => setEdit({ ...edit, rootCauseMethod: e.target.value })}>
                  <option value="">Choose…</option>{Object.entries(METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>) : <p>{METHOD[c.root_cause_method] ?? '—'}</p>}
            </label>
            {field('rootCause', eightD ? 'Why it happened (occurrence root cause)' : 'Root cause', c.root_cause)}
            {eightD && <>
              {field('escapePoint', 'Where it should have been caught (escape point)', c.escape_point, 1)}
              {field('escapeRootCause', 'Why it was not caught there (escape root cause)', c.escape_root_cause, 2)}
              {field('rootCauseVerification', 'How the causes were confirmed (turned on and off, reproduced, data)', c.root_cause_verification, 2)}
            </>}
            {editor && open && Object.keys(edit).length > 0 && <div className="row"><button onClick={() => save.run()} disabled={save.busy}>Save</button><ErrorNote message={save.error} /></div>}
          </section>
          <ActionList subjectType="corrective_action" subjectId={c.id} facilityId={c.facility_id} actions={c.actions} canPlan={editor} open={open} onChange={reload} disciplines={eightD} />
          {eightD && <Prevention c={c} editor={editor && open} onChange={reload} />}
          <Attachments subjectType="corrective_action" subjectId={c.id} title="Evidence and files" />
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
          {eightD && c.status === 'closed' && <Recognition c={c} editor={editor} onChange={reload} />}
        </>
      );
    }}</Async>
  );
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

const CAL_TONE: Record<string, Tone> = { current: 'good', due_soon: 'watch', overdue: 'bad', failed: 'bad', inactive: 'neutral' };
const CAL_LABEL: Record<string, string> = { current: 'Current', due_soon: 'Due soon', overdue: 'Overdue', failed: 'Failed, out of service', inactive: 'Inactive' };

function CalibrationList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/calibration');
  const rows = data ?? [];
  const [show, setShow] = useState(false);
  const facilities = useApi<any[]>(show ? '/api/facilities' : null);
  const [f, setF] = useState({ facilityId: '', assetId: '', intervalDays: '365', tolerance: '', provider: 'internal', nextDue: inDays(0) });
  const assets = useApi<any[]>(f.facilityId ? `/api/assets?facilityId=${f.facilityId}&limit=500` : null);
  const save = useAction(async () => { await api.post('/api/calibration', { assetId: f.assetId, intervalDays: Number(f.intervalDays), tolerance: f.tolerance, provider: f.provider, nextDue: f.nextDue }); setShow(false); await reload(); });
  return (
    <>
      <Kpis items={[
        { label: 'Instruments under control', value: rows.filter((r) => r.active).length },
        { label: 'Overdue or failed', value: rows.filter((r) => ['overdue', 'failed'].includes(r.status)).length, tone: rows.some((r) => ['overdue', 'failed'].includes(r.status)) ? 'bad' : 'good' },
        { label: 'Due within 14 days', value: rows.filter((r) => r.status === 'due_soon').length },
      ]} />
      <div className="card stack">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(r) => nav(`/quality/calibration/${r.id}`)} exception={(r) => ['overdue', 'failed'].includes(r.status)} empty="No instruments under calibration control."
            columns={[{ key: 'asset_tag', label: 'Instrument', render: (r) => <strong>{r.asset_tag}</strong> }, { key: 'asset_name', label: 'Name' }, { key: 'facility_code', label: 'Site' },
              { key: 'tolerance', label: 'Tolerance' }, { key: 'interval_days', label: 'Every', numeric: true, render: (r) => `${r.interval_days} d` },
              { key: 'last_calibrated', label: 'Last', render: (r) => fmtDate(r.last_calibrated) }, { key: 'next_due', label: 'Next due', render: (r) => fmtDate(r.next_due) },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={CAL_TONE[r.status]} label={CAL_LABEL[r.status]} /> }]} />
        )}</Async>
        <p className="faint">Production runs cannot start on an instrument that is overdue or failed. A calibration found out of tolerance raises a nonconformance listing the runs measured since the last good calibration.</p>
      </div>
      {can('quality.manage') && !show && <div><button onClick={() => setShow(true)}>Put an instrument under calibration</button></div>}
      {show && (
        <section className="card stack">
          <h2>Calibration plan</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <div className="row">
              <select id="cal-facility" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, assetId: '' })} required>
                <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </select>
              <select id="cal-asset" aria-label="Instrument" value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })} required>
                <option value="">Instrument…</option>{(assets.data ?? []).filter((a) => !rows.some((r) => r.asset_id === a.id)).map((a) => <option key={a.id} value={a.id}>{a.asset_tag} · {a.name}</option>)}
              </select>
              <label className="row">Every<input id="cal-interval" type="number" min="1" value={f.intervalDays} onChange={(e) => setF({ ...f, intervalDays: e.target.value })} style={{ width: 80 }} required /> days</label>
              <select id="cal-provider" aria-label="Done by" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="internal">In house</option><option value="external">External lab</option></select>
              <label className="row">First due<input id="cal-next" type="date" value={f.nextDue} onChange={(e) => setF({ ...f, nextDue: e.target.value })} required /></label>
            </div>
            <input id="cal-tolerance" aria-label="Tolerance" placeholder="Tolerance it must meet, e.g. ±0.003 mm over 0–500 mm" value={f.tolerance} onChange={(e) => setF({ ...f, tolerance: e.target.value })} required />
            <div className="row"><button className="primary" disabled={save.busy}>Save plan</button><button type="button" onClick={() => setShow(false)}>Cancel</button></div>
            <ErrorNote message={save.error} />
          </form>
        </section>
      )}
    </>
  );
}

export function CalibrationDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: p, loading, error, reload } = useApi<any>(`/api/calibration/${id}`);
  const [f, setF] = useState({ performedOn: inDays(0), performedBy: '', asFound: 'in_tolerance', asLeft: 'in_tolerance', certificateNo: '', notes: '' });
  const [result, setResult] = useState<any>(null);
  const record = useAction(async () => {
    const r = await api.post(`/api/calibration/${id}/records`, { ...f, certificateNo: f.certificateNo || null, notes: f.notes || null });
    setResult(r); setF({ ...f, certificateNo: '', notes: '' }); await reload();
  });
  return (
    <Async loading={loading && !p} error={error}>{() => (
      <>
        <PageHead eyebrow={`${p.facility_code} · Calibration`} title={<>{p.asset_tag} <span className="muted" style={{ fontWeight: 400 }}>{p.asset_name}</span></>}
          sub={<>Tolerance {p.tolerance} · every {p.interval_days} days · {p.provider === 'external' ? `external${p.supplier_name ? ` (${p.supplier_name})` : ''}` : 'in house'}</>}
          actions={<Pill tone={CAL_TONE[p.status]} label={`${CAL_LABEL[p.status]} · due ${fmtDate(p.next_due)}`} />} />
        {result?.ncrId && <div className="notice error">Found out of tolerance: <Link to={`/quality/ncr/${result.ncrId}`}>a nonconformance was raised</Link> to assess the product measured since the last good calibration.</div>}
        <section className="card stack">
          <h2>Used for production since the last good calibration ({fmtDate(p.usageSinceLastGood.since)})</h2>
          <Table rows={p.usageSinceLastGood.runs} rowKey={(r) => `${r.order_id}-${r.op_no}`} empty="No production runs."
            columns={[{ key: 'number', label: 'Order', render: (r) => <Link to={`/production/orders/${r.order_id}`}>{r.number}</Link> }, { key: 'part_number', label: 'Part' },
              { key: 'op_no', label: 'Op', numeric: true }, { key: 'good', label: 'Good units', numeric: true, render: (r) => fmtNum(r.good, 3) },
              { key: 'first_at', label: 'From', render: (r) => fmtDate(r.first_at) }, { key: 'last_at', label: 'To', render: (r) => fmtDate(r.last_at) }]} />
        </section>
        {can('quality.manage', p.facility_id) && (
          <section className="card stack">
            <h2>Record a calibration</h2>
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void record.run(); }}>
              <div className="row">
                <input id="calr-date" type="date" aria-label="Date" value={f.performedOn} onChange={(e) => setF({ ...f, performedOn: e.target.value })} required />
                <input id="calr-by" aria-label="By" placeholder="Calibrated by (person or lab)" value={f.performedBy} onChange={(e) => setF({ ...f, performedBy: e.target.value })} required />
                <label className="row">As found<select id="calr-found" value={f.asFound} onChange={(e) => setF({ ...f, asFound: e.target.value })}><option value="in_tolerance">In tolerance</option><option value="out_of_tolerance">Out of tolerance</option></select></label>
                <label className="row">As left<select id="calr-left" value={f.asLeft} onChange={(e) => setF({ ...f, asLeft: e.target.value })}><option value="in_tolerance">In tolerance</option><option value="adjusted">Adjusted into tolerance</option><option value="failed">Failed (out of service)</option></select></label>
                <input id="calr-cert" aria-label="Certificate number" placeholder="Certificate no." value={f.certificateNo} onChange={(e) => setF({ ...f, certificateNo: e.target.value })} style={{ width: 140 }} />
              </div>
              <input id="calr-notes" aria-label="Readings and notes" placeholder={f.asFound === 'out_of_tolerance' ? 'As-found readings (required)' : 'Readings and notes'} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
              <div><button className="primary" disabled={record.busy}>Record calibration</button></div>
              <ErrorNote message={record.error} />
            </form>
          </section>
        )}
        <section className="card">
          <h2>History</h2>
          <Table rows={p.records}
            columns={[{ key: 'performed_on', label: 'Date', render: (r) => fmtDate(r.performed_on) }, { key: 'performed_by', label: 'By' },
              { key: 'as_found', label: 'As found', render: (r) => (r.as_found === 'in_tolerance' ? 'In tolerance' : <Pill tone="bad" label="Out of tolerance" />) },
              { key: 'as_left', label: 'As left', render: (r) => humanize(r.as_left) }, { key: 'certificate_no', label: 'Certificate' }, { key: 'notes', label: 'Notes' },
              { key: 'ncr_number', label: 'NCR', render: (r) => (r.ncr_id ? <Link to={`/quality/ncr/${r.ncr_id}`}>{r.ncr_number}</Link> : '—') }]} />
        </section>
        {p.records[0] && <Attachments subjectType="calibration_record" subjectId={p.records[0].id} title={`Certificate for the ${fmtDate(p.records[0].performed_on)} calibration`} />}
      </>
    )}</Async>
  );
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

const AUDIT_TONE: Record<string, Tone> = { planned: 'info', in_progress: 'watch', reported: 'watch', closed: 'good', cancelled: 'neutral' };
const RESULT: [string, string][] = [['conforming', 'Conforming'], ['observation', 'Observation'], ['minor_nc', 'Minor nonconformity'], ['major_nc', 'Major nonconformity'], ['not_applicable', 'Not applicable']];

function AuditList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/audits');
  const [show, setShow] = useState(false);
  const facilities = useApi<any[]>(show ? '/api/facilities' : null);
  const [f, setF] = useState({ facilityId: '', title: '', scope: '', kind: 'internal', plannedOn: inDays(7), leadAuditorId: '', auditeeUserId: '', items: '' });
  const users = useApi<any[]>(f.facilityId ? `/api/assignable-users?facilityId=${f.facilityId}` : null);
  const save = useAction(async () => {
    const a = await api.post('/api/audits', { ...f, auditeeUserId: f.auditeeUserId || null, items: f.items.split('\n').map((x) => x.trim()).filter(Boolean) });
    nav(`/quality/audits/${a.id}`);
  });
  return (
    <>
      <div className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data ?? []} onRow={(r) => nav(`/quality/audits/${r.id}`)} exception={(r) => r.overdue} empty="No audits yet."
            columns={[{ key: 'number', label: 'Audit', render: (r) => <strong>{r.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'title', label: 'Title' },
              { key: 'kind', label: 'Kind', render: (r) => humanize(r.kind) }, { key: 'planned_on', label: 'Planned', render: (r) => fmtDate(r.planned_on) },
              { key: 'lead_auditor_name', label: 'Lead auditor' }, { key: 'findings', label: 'Findings', numeric: true },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={AUDIT_TONE[r.status]} label={humanize(r.status)} /> }]} />
        )}</Async>
      </div>
      {can('quality.manage') && !show && <div><button onClick={() => setShow(true)}>Plan an audit</button></div>}
      {show && (
        <section className="card stack">
          <h2>Plan an audit</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <div className="row">
              <select id="aud-facility" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required>
                <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </select>
              <select id="aud-kind" aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['internal', 'certification', 'customer'].map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select>
              <label className="row">Planned<input id="aud-date" type="date" value={f.plannedOn} onChange={(e) => setF({ ...f, plannedOn: e.target.value })} required /></label>
              <select id="aud-lead" aria-label="Lead auditor" value={f.leadAuditorId} onChange={(e) => setF({ ...f, leadAuditorId: e.target.value })} required>
                <option value="">Lead auditor…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
              <select id="aud-auditee" aria-label="Area owner" value={f.auditeeUserId} onChange={(e) => setF({ ...f, auditeeUserId: e.target.value })}>
                <option value="">Owner of the audited area…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
            </div>
            <input id="aud-title" aria-label="Title" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
            <input id="aud-scope" aria-label="Scope" placeholder="Scope: process, area, standard and clauses" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} required />
            <label className="field">Checklist (one item per line)<textarea id="aud-items" rows={6} value={f.items} onChange={(e) => setF({ ...f, items: e.target.value })} required /></label>
            <div className="row"><button className="primary" disabled={save.busy}>Plan audit</button><button type="button" onClick={() => setShow(false)}>Cancel</button></div>
            <ErrorNote message={save.error} />
          </form>
        </section>
      )}
    </>
  );
}

export function AuditDetail() {
  const { id } = useParams();
  const { data: a, loading, error, reload } = useApi<any>(`/api/audits/${id}`);
  const [res, setRes] = useState<Record<string, { result: string; evidence: string }>>({});
  const [summary, setSummary] = useState('');
  const [itemAction, setItemAction] = useState<{ itemId: string; title: string; ownerUserId: string; dueDate: string } | null>(null);
  const users = useApi<any[]>(a && itemAction ? `/api/assignable-users?facilityId=${a.facility_id}` : null);
  const start = useAction(async () => { await api.post(`/api/audits/${id}/start`, {}); await reload(); });
  const saveItem = useAction(async (itemId: string) => { await api.post(`/api/audit-items/${itemId}`, { result: res[itemId]!.result, evidence: res[itemId]!.evidence || null }); await reload(); });
  const report = useAction(async () => { await api.post(`/api/audits/${id}/report`, { summary }); await reload(); });
  const capa = useAction(async (itemId: string) => { await api.post(`/api/audit-items/${itemId}/capa`, {}); await reload(); });
  const act = useAction(async () => { await api.post('/api/actions', { subjectType: 'quality_audit', subjectId: id, auditItemId: itemAction!.itemId, title: itemAction!.title, ownerUserId: itemAction!.ownerUserId, dueDate: itemAction!.dueDate }); setItemAction(null); await reload(); });
  const close = useAction(async () => { await api.post(`/api/audits/${id}/close`, {}); await reload(); });
  return (
    <Async loading={loading && !a} error={error}>{() => {
      const recording = a.status === 'in_progress' && a.isAuditor;
      const answering = a.status === 'reported';
      return (
        <>
          <PageHead eyebrow={`${a.facility_code} · ${humanize(a.kind)} audit`} title={<>{a.number} <span className="muted" style={{ fontWeight: 400 }}>{a.title}</span></>}
            sub={<>{a.scope} · planned {fmtDate(a.planned_on)} · lead auditor {a.lead_auditor_name}{a.auditee_name ? ` · area owner ${a.auditee_name}` : ''}</>}
            actions={<Pill tone={AUDIT_TONE[a.status]} label={humanize(a.status)} />} />
          {a.status === 'planned' && a.isAuditor && <div className="row"><button className="primary" onClick={() => start.run()} disabled={start.busy}>Start audit</button><ErrorNote message={start.error} /></div>}
          <section className="card stack">
            <h2>Checklist</h2>
            <Table rows={a.items}
              columns={[{ key: 'seq', label: '#', numeric: true }, { key: 'requirement', label: 'Requirement' },
                { key: 'result', label: 'Result', render: (i) => (recording ? (
                  <select aria-label={`Result for item ${i.seq}`} value={res[i.id]?.result ?? i.result ?? ''} onChange={(e) => setRes({ ...res, [i.id]: { result: e.target.value, evidence: res[i.id]?.evidence ?? i.evidence ?? '' } })}>
                    <option value="">Choose…</option>{RESULT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>) : i.result ? <Pill tone={i.result === 'major_nc' ? 'bad' : i.result === 'minor_nc' ? 'watch' : i.result === 'observation' ? 'info' : 'good'} label={RESULT.find(([k]) => k === i.result)![1]} /> : '—') },
                { key: 'evidence', label: 'Evidence', render: (i) => (recording ? (
                  <div className="row">
                    <input aria-label={`Evidence for item ${i.seq}`} value={res[i.id]?.evidence ?? i.evidence ?? ''} placeholder="Objective evidence"
                      onChange={(e) => setRes({ ...res, [i.id]: { result: res[i.id]?.result ?? i.result ?? '', evidence: e.target.value } })} />
                    <button onClick={() => saveItem.run(i.id)} disabled={saveItem.busy || !res[i.id]?.result}>Save</button>
                  </div>) : i.evidence) },
                { key: 'response', label: 'Response', render: (i) => (['minor_nc', 'major_nc'].includes(i.result) ? (i.capa_id ? <Link to={`/quality/capa/${i.capa_id}`}>{i.capa_number}</Link>
                  : i.actions ? `${i.actions} action${i.actions === 1 ? '' : 's'}` : answering ? (
                    <div className="row">
                      {a.canManage && <button onClick={() => capa.run(i.id)} disabled={capa.busy}>Corrective action</button>}
                      <button onClick={() => setItemAction({ itemId: i.id, title: '', ownerUserId: '', dueDate: inDays(30) })}>Action</button>
                    </div>) : <Pill tone="bad" label="Unanswered" />) : null) }]} />
            <ErrorNote message={saveItem.error ?? capa.error} />
            {itemAction && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
                <input id="aud-action-title" aria-label="Action" placeholder="Action to answer the finding" value={itemAction.title} onChange={(e) => setItemAction({ ...itemAction, title: e.target.value })} required style={{ flex: '1 1 260px' }} />
                <select id="aud-action-owner" aria-label="Owner" value={itemAction.ownerUserId} onChange={(e) => setItemAction({ ...itemAction, ownerUserId: e.target.value })} required>
                  <option value="">Owner…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
                <input type="date" aria-label="Due" value={itemAction.dueDate} onChange={(e) => setItemAction({ ...itemAction, dueDate: e.target.value })} required />
                <button className="primary" disabled={act.busy}>Add</button><button type="button" onClick={() => setItemAction(null)}>Cancel</button><ErrorNote message={act.error} />
              </form>
            )}
          </section>
          {recording && (
            <section className="card stack">
              <h2>Report</h2>
              <textarea id="aud-summary" aria-label="Summary" placeholder="Summary: what was looked at, overall conclusion, strengths" value={summary} onChange={(e) => setSummary(e.target.value)} />
              <div><button className="primary" onClick={() => report.run()} disabled={report.busy || summary.trim().length < 3}>Issue report</button></div><ErrorNote message={report.error} />
            </section>
          )}
          {a.summary && <section className="card"><h2>Summary</h2><p style={{ whiteSpace: 'pre-wrap' }}>{a.summary}</p><p className="muted">{a.findings} finding{a.findings === 1 ? '' : 's'}, {a.observations} observation{a.observations === 1 ? '' : 's'}.</p></section>}
          {a.actions.length > 0 && <ActionList subjectType="quality_audit" subjectId={a.id} facilityId={a.facility_id} actions={a.actions} canPlan={false} open={a.status !== 'closed'} onChange={reload} />}
          <Attachments subjectType="quality_audit" subjectId={a.id} title="Audit files" />
          {answering && a.canManage && <div className="row"><button className="primary" onClick={() => close.run()} disabled={close.busy}>Close audit</button><ErrorNote message={close.error} /></div>}
        </>
      );
    }}</Async>
  );
}

function SupplierResponse({ c, canEdit, onDone }: { c: any; canEdit: boolean; onDone: () => Promise<void> | void }) {
  const [f, setF] = useState({ response: '', rootCause: '', containment: '' });
  const save = useAction(async () => {
    await api.post(`/api/capas/${c.id}/supplier-response`, { response: f.response, rootCause: f.rootCause || null, containment: f.containment || null });
    setF({ response: '', rootCause: '', containment: '' }); await onDone();
  });
  return (
    <section className="card stack">
      <h2>Supplier: <Link to={`/purchasing/suppliers/${c.supplier_id}`}>{c.supplier_name}</Link>{' '}
        {c.supplier_responded_at ? <Pill tone="good" label="Answered" /> : c.supplier_response_overdue ? <Pill tone="bad" label="No answer, past due" /> : <Pill tone="watch" label="Waiting" />}</h2>
      <p className="muted">Answer due {fmtDate(c.supplier_response_due)}{c.supplier_responded_at ? ` · answered ${fmtDateTime(c.supplier_responded_at)}` : ''}</p>
      {c.supplier_response && <p style={{ whiteSpace: 'pre-wrap' }}>{c.supplier_response}</p>}
      {canEdit && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <textarea id="scar-response" aria-label="Supplier's answer" rows={3} placeholder="What the supplier sent (8D, email, letter): containment, root cause, actions and dates" value={f.response} onChange={(e) => setF({ ...f, response: e.target.value })} required />
          <div className="row">
            <input aria-label="Their root cause" placeholder="Their root cause (copied to the corrective action)" value={f.rootCause} onChange={(e) => setF({ ...f, rootCause: e.target.value })} style={{ flex: '1 1 240px' }} />
            <input aria-label="Their containment" placeholder="Their containment" value={f.containment} onChange={(e) => setF({ ...f, containment: e.target.value })} style={{ flex: '1 1 240px' }} />
            <button className="primary" disabled={save.busy}>{c.supplier_response ? 'Record a further answer' : 'Record their answer'}</button>
          </div>
          <ErrorNote message={save.error} />
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 8D (D-126): the disciplines on top of the corrective action
// ---------------------------------------------------------------------------

/** The eight disciplines, each with what it still needs; the server checks the same list before each step. */
function Disciplines({ list }: { list: { key: string; title: string; done: boolean; missing: string[] }[] }) {
  const left = list.filter((d) => !d.done);
  return (
    <section className="card stack" aria-labelledby="disciplines-h">
      <h2 id="disciplines-h">8D disciplines</h2>
      <p className="muted">{left.length === 0 ? 'All eight disciplines are complete.' : `${8 - left.length} of 8 complete. Each step needs its disciplines before it moves on.`}</p>
      <ul className="checklist">
        {list.map((d) => (
          <li key={d.key}><Pill tone={d.done ? 'good' : 'watch'} label={d.done ? 'Done' : 'To do'} /> <strong>{d.key} {d.title}</strong>
            {!d.done && <span className="muted">: {d.missing.join('; ')}</span>}</li>
        ))}
      </ul>
    </section>
  );
}

function EightDTeam({ c, editor, onChange }: { c: any; editor: boolean; onChange: () => void }) {
  const users = useApi<any[]>(editor ? `/api/assignable-users?facilityId=${c.facility_id}` : null);
  const [f, setF] = useState({ userId: '', expertise: '' });
  const champion = useAction(async (userId: string) => { await api.patch(`/api/corrective-actions/${c.id}`, { championUserId: userId || null }); onChange(); });
  const add = useAction(async () => { await api.post(`/api/corrective-actions/${c.id}/team`, { userId: f.userId, expertise: f.expertise || null }); setF({ userId: '', expertise: '' }); onChange(); });
  const remove = useAction(async (userId: string) => { await api.delete(`/api/corrective-actions/${c.id}/team/${userId}`); onChange(); });
  const others = (users.data ?? []).filter((u) => u.id !== c.owner_user_id);
  return (
    <section className="card stack">
      <h2>D1 Team</h2>
      <dl className="facts">
        <dt>Leader</dt><dd>{c.owner_name} <span className="faint">(the owner)</span></dd>
        <dt>Champion</dt>
        <dd>{editor ? (
          <select id="capa-champion" aria-label="Champion" value={c.champion_user_id ?? ''} onChange={(e) => champion.run(e.target.value)} disabled={champion.busy}>
            <option value="">Choose…</option>{others.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>) : (c.champion_name ?? '—')}</dd>
      </dl>
      <ErrorNote message={champion.error} />
      <Table rows={c.team} empty="No team members yet." columns={[{ key: 'display_name', label: 'Member' }, { key: 'expertise', label: 'Brings' },
        ...(editor ? [{ key: 'x', label: '', render: (t: any) => <button onClick={() => remove.run(t.user_id)} disabled={remove.busy} aria-label={`Remove ${t.display_name}`}>Remove</button> }] : [])]} />
      <ErrorNote message={remove.error} />
      {editor && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <select id="team-user" aria-label="Team member" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} required>
            <option value="">Add a member…</option>{others.filter((u) => !c.team.some((t: any) => t.user_id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
          <input id="team-expertise" aria-label="What they bring" placeholder="What they bring (operator, process engineer…)" value={f.expertise} onChange={(e) => setF({ ...f, expertise: e.target.value })} style={{ flex: '1 1 220px' }} />
          <button disabled={add.busy}>Add</button><ErrorNote message={add.error} />
        </form>
      )}
    </section>
  );
}

const IIN: [string, string][] = [['what', 'What (part, defect)'], ['where', 'Where (line, machine, place on the part)'], ['when', 'When (first seen, shift, pattern)'], ['extent', 'How many (quantity, rate, trend)']];

/** D2: the problem as is / is not. What it is not narrows the cause as much as what it is. */
function IsIsNot({ c, editor, onChange }: { c: any; editor: boolean; onChange: () => void }) {
  const [v, setV] = useState<Record<string, { is?: string; isNot?: string }> | null>(null);
  const cur: Record<string, { is?: string; isNot?: string }> = v ?? c.is_is_not ?? {};
  const set = (k: string, side: 'is' | 'isNot', text: string) => setV({ ...cur, [k]: { ...cur[k], [side]: text } });
  const save = useAction(async () => { await api.patch(`/api/corrective-actions/${c.id}`, { isIsNot: cur }); setV(null); onChange(); });
  return (
    <section className="card stack">
      <h2>D2 Problem description: is / is not</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col"></th><th scope="col">Is</th><th scope="col">Is not</th></tr></thead>
          <tbody>
            {IIN.map(([k, label]) => (
              <tr key={k}>
                <th scope="row">{label}</th>
                {(['is', 'isNot'] as const).map((side) => (
                  <td key={side}>{editor
                    ? <textarea id={`iin-${k}-${side}`} aria-label={`${label}: ${side === 'is' ? 'is' : 'is not'}`} rows={2} value={cur[k]?.[side] ?? ''} onChange={(e) => set(k, side, e.target.value)} />
                    : <span style={{ whiteSpace: 'pre-wrap' }}>{cur[k]?.[side] || '—'}</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editor && v && <div className="row"><button onClick={() => save.run()} disabled={save.busy}>Save</button><ErrorNote message={save.error} /></div>}
    </section>
  );
}

/** D7: systemic changes and read-across. */
function Prevention({ c, editor, onChange }: { c: any; editor: boolean; onChange: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [scope, setScope] = useState('');
  const [d, setD] = useState<Record<string, { applies: string; note: string }>>({});
  const save = useAction(async () => { await api.patch(`/api/corrective-actions/${c.id}`, { preventionNote: note }); setNote(null); onChange(); });
  const add = useAction(async () => { await api.post(`/api/corrective-actions/${c.id}/read-across`, { scope }); setScope(''); onChange(); });
  const decide = useAction(async (id: string) => { const x = d[id]!; await api.post(`/api/read-across/${id}/decide`, { applies: x.applies === 'true', note: x.note }); onChange(); });
  return (
    <section className="card stack">
      <h2>D7 Prevent recurrence</h2>
      <label className="field">Systemic changes (FMEA, control plan, procedures, training), or why none are needed
        {editor ? <textarea id="capa-prevention" rows={3} value={note ?? c.prevention_note ?? ''} onChange={(e) => setNote(e.target.value)} /> : <p style={{ whiteSpace: 'pre-wrap' }}>{c.prevention_note ?? '—'}</p>}
      </label>
      {editor && note != null && <div className="row"><button onClick={() => save.run()} disabled={save.busy}>Save</button><ErrorNote message={save.error} /></div>}
      <h3>Read-across: where else could the same cause act?</h3>
      <Table rows={c.readAcross} empty="None listed yet." columns={[{ key: 'scope', label: 'Where' },
        { key: 'applies', label: 'Decision', render: (r: any) => (r.applies == null ? (editor ? (
          <div className="row">
            <select aria-label={`Applies to ${r.scope}`} value={d[r.id]?.applies ?? 'true'} onChange={(e) => setD({ ...d, [r.id]: { note: d[r.id]?.note ?? '', applies: e.target.value } })}>
              <option value="true">Applies</option><option value="false">Does not apply</option></select>
            <input aria-label={`What was found at ${r.scope}`} placeholder="What was found or done" value={d[r.id]?.note ?? ''} onChange={(e) => setD({ ...d, [r.id]: { applies: d[r.id]?.applies ?? 'true', note: e.target.value } })} />
            <button onClick={() => decide.run(r.id)} disabled={decide.busy || (d[r.id]?.note ?? '').trim().length < 5}>Decide</button>
          </div>) : <Pill tone="watch" label="Not decided" />) : <>{r.applies ? 'Applies' : 'Does not apply'} <span className="faint">{r.note} ({r.decided_by_name})</span></>) }]} />
      <ErrorNote message={decide.error} />
      {editor && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <input id="read-across-scope" aria-label="Where else" placeholder="Other line, part family, process or site" value={scope} onChange={(e) => setScope(e.target.value)} required style={{ flex: '1 1 280px' }} />
          <button disabled={add.busy}>Add</button><ErrorNote message={add.error} />
        </form>
      )}
    </section>
  );
}

/** D8: recognizing the team, once the effectiveness check has closed the 8D. */
function Recognition({ c, editor, onChange }: { c: any; editor: boolean; onChange: () => void }) {
  const [note, setNote] = useState('');
  const save = useAction(async () => { await api.post(`/api/corrective-actions/${c.id}/recognize`, { note }); onChange(); });
  return (
    <section className="card stack">
      <h2>D8 Team recognized</h2>
      {c.recognition_note ? <p>{c.recognition_note} <span className="faint">({fmtDateTime(c.recognized_at)})</span></p>
        : editor ? (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <textarea id="capa-recognition" aria-label="What the team achieved" placeholder="What the team achieved; the team is told" rows={2} value={note} onChange={(e) => setNote(e.target.value)} required />
            <div><button className="primary" disabled={save.busy}>Recognize the team</button></div><ErrorNote message={save.error} />
          </form>) : <p className="muted">Not yet recorded.</p>}
    </section>
  );
}
