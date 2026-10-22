import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { DocLink as ViewDoc } from './Documents';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  planned: { label: 'Planned', tone: 'neutral' }, released: { label: 'Released', tone: 'info' }, in_progress: { label: 'In progress', tone: 'watch' },
  completed: { label: 'Completed', tone: 'good' }, closed: { label: 'Closed', tone: 'neutral' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
export const MoStatus = ({ v, late }: { v: string; late?: boolean }) => (
  <><Pill tone={STATUS[v]?.tone} label={STATUS[v]?.label ?? v} />{late && <> <Pill tone="bad" label="Late" /></>}</>
);
const MACHINE_TONE: Record<string, 'good' | 'watch' | 'bad' | 'info' | 'neutral'> = { running: 'good', idle: 'info', available: 'info', planned_downtime: 'watch', unplanned_downtime: 'bad', out_of_service: 'bad' };
const MachineState = ({ s }: { s: string }) => <Pill tone={MACHINE_TONE[s] ?? 'neutral'} label={humanize(s)} />;
/** Opens the current approved version of a work instruction in the document viewer. */
const DocLink = ({ id, title }: { id: string; title: string }) => <ViewDoc id={id}>{title}</ViewDoc>;
const minutesSince = (t: string) => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
const TABS = [['orders', 'Orders'], ['floor', 'Shop floor'], ['products', 'Products'], ['work-centers', 'Work centers']] as const;

export function Production({ floor }: { floor?: boolean }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? (floor ? 'floor' : 'orders');
  return (
    <>
      <PageHead eyebrow="Production" title="Production"
        sub="Plan production orders from released product revisions, run operations on the floor, and receive finished goods into stock." />
      <div className="row" role="tablist" aria-label="Production">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'orders' && <Orders />}
      {tab === 'floor' && <Floor />}
      {tab === 'products' && <Products />}
      {tab === 'work-centers' && <WorkCenters />}
    </>
  );
}

function Orders() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [open, setOpen] = useState(true);
  const { data, loading, error } = useApi<any[]>(open ? '/api/production-orders?open=true' : '/api/production-orders');
  const rows = data ?? [];
  return (
    <>
      <Kpis items={[
        { label: 'Open orders', value: rows.filter((r) => ['planned', 'released', 'in_progress'].includes(r.status)).length },
        { label: 'Late', value: rows.filter((r) => r.late).length, tone: rows.some((r) => r.late) ? 'bad' : 'good' },
        { label: 'In progress', value: rows.filter((r) => r.status === 'in_progress').length },
      ]} />
      {can('production.manage') && <NewOrder onDone={(id) => nav(`/production/orders/${id}`)} />}
      <div className="card stack">
        <label className="row"><input id="mo-open" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only open and completed</label>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(r) => nav(`/production/orders/${r.id}`)} exception={(r) => r.late} empty="No production orders."
            columns={[{ key: 'number', label: 'Order', render: (r) => <strong>{r.number}</strong> }, { key: 'part_number', label: 'Part', render: (r) => <>{r.part_number} <span className="faint">rev {r.revision}</span></> },
              { key: 'facility_code', label: 'Site' }, { key: 'customer_name', label: 'For', render: (r) => (r.sales_order_number ? `${r.sales_order_number} · ${r.customer_name}` : 'Stock') },
              { key: 'qty', label: 'Qty', numeric: true, render: (r) => fmtNum(r.qty, 3) }, { key: 'made', label: 'Finished', numeric: true, render: (r) => fmtNum(r.made ?? 0, 3) },
              { key: 'current_op', label: 'At' }, { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) },
              { key: 'status', label: 'Status', render: (r) => <MoStatus v={r.status} late={r.late} /> }]} />
        )}</Async>
      </div>
    </>
  );
}

function NewOrder({ onDone }: { onDone: (id: string) => void }) {
  const [show, setShow] = useState(false);
  const products = useApi<any[]>(show ? '/api/products' : null);
  const facilities = useApi<any[]>(show ? '/api/facilities' : null);
  const locations = useApi<any[]>(show ? '/api/stock-locations' : null);
  const [f, setF] = useState({ partId: '', facilityId: '', qty: '', dueDate: '', outputLocationId: '' });
  const save = useAction(async () => {
    const o = await api.post('/api/production-orders', { partId: f.partId, facilityId: f.facilityId, qty: Number(f.qty), dueDate: f.dueDate || null, outputLocationId: f.outputLocationId || null });
    onDone(o.id);
  });
  if (!show) return <div><button className="primary" onClick={() => setShow(true)}>New production order</button></div>;
  return (
    <section className="card stack">
      <h2>New production order</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <select id="mo-part" aria-label="Part" value={f.partId} onChange={(e) => setF({ ...f, partId: e.target.value })} required>
          <option value="">Part to make…</option>
          {(products.data ?? []).filter((p) => p.released).map((p) => <option key={p.part_id} value={p.part_id}>{p.part_number} · {p.description} (rev {p.released.revision})</option>)}
        </select>
        <select id="mo-facility" aria-label="Facility" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, outputLocationId: '' })} required>
          <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
        </select>
        <input id="mo-qty" type="number" min="0.001" step="any" placeholder="Quantity" aria-label="Quantity" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} required style={{ width: 110 }} />
        <label className="row">Due<input id="mo-due" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
        <select id="mo-output" aria-label="Finished goods storeroom" value={f.outputLocationId} onChange={(e) => setF({ ...f, outputLocationId: e.target.value })}>
          <option value="">Finished goods to…</option>
          {(locations.data ?? []).filter((l) => l.facility_id === f.facilityId).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
        </select>
        <button className="primary" disabled={save.busy}>Create</button><button type="button" onClick={() => setShow(false)}>Cancel</button>
      </form>
      <ErrorNote message={save.error} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shop floor
// ---------------------------------------------------------------------------

function Floor() {
  const { data: wcs } = useApi<any[]>('/api/work-centers');
  const [params, setParams] = useSearchParams();
  const wc = params.get('wc') ?? '';
  // Default to the work center where the operator's own job runs, else the first with work waiting.
  const mine = useApi<any>(wcs?.length && !wc ? `/api/work-centers/${wcs[0].id}/floor` : null);
  useEffect(() => {
    if (wc || !wcs?.length || !mine.data) return;
    setParams({ tab: 'floor', wc: mine.data.mine?.work_center_id ?? wcs.find((w) => w.queued > 0)?.id ?? wcs[0].id }, { replace: true });
  }, [wcs, wc, mine.data, setParams]);
  return (
    <div className="stack">
      <label className="field">Work center
        <select id="floor-wc" value={wc} onChange={(e) => setParams({ tab: 'floor', wc: e.target.value })}>
          {(wcs ?? []).map((w) => <option key={w.id} value={w.id}>{w.facility_code} · {w.code} · {w.name}{w.queued ? ` (${w.queued} waiting)` : ''}</option>)}
        </select>
      </label>
      {wc && <FloorPanel key={wc} wcId={wc} />}
    </div>
  );
}

function FloorPanel({ wcId }: { wcId: string }) {
  const { me, can } = useAuth();
  const { data: q, loading, error, reload } = useApi<any>(`/api/work-centers/${wcId}/floor`);
  const [machine, setMachine] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<'run' | 'setup'>('run');
  const start = useAction(async (opId: string) => { await api.post(`/api/production-operations/${opId}/start`, { assetId: machine[opId] || q.machines[0]?.id || null, kind }); await reload(); });
  return (
    <Async loading={loading && !q} error={error}>{() => {
      const exec = can('production.execute', q.workCenter.facility_id);
      const mineHere = q.mine && q.mine.work_center_id === wcId ? q.mine : null;
      return (
        <>
          {q.machines.length > 0 && (
            <section className="card">
              <h2>Machines</h2>
              <Table rows={q.machines} rowKey={(m) => m.id}
                columns={[{ key: 'asset_tag', label: 'Machine', render: (m) => <Link to={`/assets/${m.id}`}>{m.asset_tag}</Link> }, { key: 'name', label: 'Name' },
                  { key: 'operational_state', label: 'State', render: (m) => <MachineState s={m.operational_state} /> },
                  { key: 'requires', label: 'Operators need', render: (m) => (m.requires?.length ? m.requires.join(', ') : '—') }]} />
            </section>
          )}
          {mineHere && <StopForm entry={mineHere} reasons={q.scrapReasons} onDone={reload} />}
          {q.mine && !mineHere && <div className="notice warn">You have a job running at another work center ({q.mine.number} op {q.mine.op_no}). Stop it before starting here.</div>}
          <section className="card stack">
            <div className="spread"><h2>Waiting here</h2>
              {exec && !q.mine && <label className="row">Record as
                <select id="floor-kind" value={kind} onChange={(e) => setKind(e.target.value as 'run' | 'setup')}><option value="run">Production run</option><option value="setup">Setup</option></select></label>}</div>
            <Table rows={q.queue} empty="Nothing waiting at this work center."
              columns={[{ key: 'number', label: 'Order', render: (x) => <Link to={`/production/orders/${x.order_id}`}>{x.number}</Link> },
                { key: 'op_no', label: 'Op', numeric: true }, { key: 'description', label: 'Operation', render: (x) => <>{x.description}{x.document_id && <> · <DocLink id={x.document_id} title={x.document_title} /></>}</> },
                { key: 'part_number', label: 'Part' }, { key: 'waiting', label: 'Waiting', numeric: true, render: (x) => (x.waiting > 0 ? fmtNum(x.waiting, 3) : <span className="faint">more to come</span>) },
                { key: 'due_date', label: 'Due', render: (x) => fmtDate(x.due_date) },
                { key: 'act', label: '', render: (x) => (exec && !q.mine && me?.employeeId && x.waiting > 0 ? (
                  <div className="row">
                    {q.machines.length > 1 && (
                      <select aria-label={`Machine for ${x.number} op ${x.op_no}`} value={machine[x.id] ?? q.machines[0].id} onChange={(e) => setMachine({ ...machine, [x.id]: e.target.value })}>
                        {q.machines.map((m: any) => <option key={m.id} value={m.id}>{m.asset_tag}</option>)}
                      </select>
                    )}
                    <button className="primary" onClick={() => start.run(x.id)} disabled={start.busy}>Start</button>
                  </div>) : null) }]} />
            <ErrorNote message={start.error} />
            {exec && !me?.employeeId && <p className="faint">Your user is not linked to an employee record, so you cannot start runs yourself.</p>}
          </section>
          <section className="card">
            <h2>Running now</h2>
            <Table rows={q.running} empty="Nothing running."
              columns={[{ key: 'operator', label: 'Operator' }, { key: 'asset_tag', label: 'Machine', render: (e) => e.asset_tag ?? '—' }, { key: 'number', label: 'Order' },
                { key: 'op_no', label: 'Op', numeric: true }, { key: 'kind', label: 'Kind', render: (e) => humanize(e.kind) },
                { key: 'started_at', label: 'For', render: (e) => `${minutesSince(e.started_at)} min` }]} />
          </section>
        </>
      );
    }}</Async>
  );
}

function StopForm({ entry, reasons, onDone }: { entry: any; reasons: any[]; onDone: () => void }) {
  const [f, setF] = useState({ good: '', scrap: '', rework: '', reason: '', note: '' });
  const stop = useAction(async () => {
    await api.post(`/api/production-entries/${entry.id}/stop`, { qtyGood: Number(f.good) || 0, qtyScrap: Number(f.scrap) || 0, qtyRework: Number(f.rework) || 0,
      scrapReason: Number(f.scrap) > 0 ? f.reason || null : null, note: f.note || null });
    onDone();
  });
  return (
    <section className="card stack" style={{ borderColor: 'var(--accent)' }}>
      <h2>Your job: {entry.number} op {entry.op_no} <span className="muted" style={{ fontWeight: 400 }}>{humanize(entry.kind)}, {minutesSince(entry.started_at)} min</span></h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void stop.run(); }}>
        <div className="row">
          {entry.kind === 'run' && <label className="row">Good<input id="stop-good" type="number" min="0" step="any" value={f.good} onChange={(e) => setF({ ...f, good: e.target.value })} style={{ width: 90 }} /></label>}
          <label className="row">Scrap<input id="stop-scrap" type="number" min="0" step="any" value={f.scrap} onChange={(e) => setF({ ...f, scrap: e.target.value })} style={{ width: 90 }} /></label>
          {entry.kind === 'run' && <label className="row">Of the good, reworked<input id="stop-rework" type="number" min="0" step="any" value={f.rework} onChange={(e) => setF({ ...f, rework: e.target.value })} style={{ width: 90 }} /></label>}
          {Number(f.scrap) > 0 && (
            <select id="stop-reason" aria-label="Scrap reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required>
              <option value="">Scrap reason…</option>{reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          )}
        </div>
        <input id="stop-note" aria-label="Note" placeholder="Note (optional): what happened, adjustments made" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <div><button className="primary" disabled={stop.busy}>Stop and record</button></div>
        <ErrorNote message={stop.error} />
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Order page
// ---------------------------------------------------------------------------

export function ProductionOrderDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const { data: o, loading, error, reload } = useApi<any>(`/api/production-orders/${id}`);
  const [issue, setIssue] = useState<Record<string, { qty: string; loc: string }>>({});
  const [recv, setRecv] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const release = useAction(async () => { const r = await api.post(`/api/production-orders/${id}/release`, {});
    setNote(r.shortages.length ? `Released. Short: ${r.shortages.map((s: any) => `${s.part_number} ${fmtNum(s.short, 3)}`).join(', ')}.` : 'Released; all materials are covered.'); await reload(); });
  const request = useAction(async () => { const pr = await api.post(`/api/production-orders/${id}/request-shortages`, {}); nav(`/purchasing/requests/${pr.id}`); });
  const makePart = useAction(async (x: any) => {
    const mo = await api.post('/api/production-orders', { facilityId: o.facility_id, partId: x.part_id, qty: x.short, dueDate: o.due_date ?? null, outputLocationId: x.stock[0]?.location_id ?? null,
      notes: `Components for ${o.number}` });
    nav(`/production/orders/${mo.id}`);
  });
  const doIssue = useAction(async () => {
    const lines = Object.entries(issue).filter(([, v]) => Number(v.qty) > 0).map(([materialId, v]) => ({ materialId, locationId: v.loc, qty: Number(v.qty) }));
    await api.post(`/api/production-orders/${id}/issue`, { lines }); setIssue({}); await reload();
  });
  const receive = useAction(async () => { await api.post(`/api/production-orders/${id}/receive`, { qty: Number(recv) }); setRecv(''); await reload(); });
  const short = useAction(async () => { await api.post(`/api/production-orders/${id}/complete-short`, { reason }); setReason(''); await reload(); });
  const cancel = useAction(async () => { await api.post(`/api/production-orders/${id}/cancel`, { reason }); setReason(''); await reload(); });
  const close = useAction(async () => { await api.post(`/api/production-orders/${id}/close`, {}); await reload(); });
  const raiseNcr = useAction(async (e: any) => {
    const n = await api.post('/api/nonconformances', { productionEntryId: e.id, description: `${e.qty_scrap} scrapped at op ${e.op_no} (${e.scrap_label})${e.note ? `: ${e.note}` : ''}` });
    nav(`/quality/ncr/${n.id}`);
  });
  const start = useAction(async (opId: string, assetId: string | null) => { await api.post(`/api/production-operations/${opId}/start`, { assetId }); nav(`/production?tab=floor&wc=${o.operations.find((x: any) => x.id === opId).work_center_id}`); });
  return (
    <Async loading={loading && !o} error={error}>{() => {
      const manage = can('production.manage', o.facility_id);
      const exec = can('production.execute', o.facility_id);
      const open = ['released', 'in_progress'].includes(o.status);
      const m = o.metrics;
      const issueDefaults = (x: any) => issue[x.id] ?? { qty: '', loc: x.stock[0]?.location_id ?? '' };
      return (
        <>
          <PageHead eyebrow={`${o.facility_code} · Production order`} title={<>{o.number} <span className="muted" style={{ fontWeight: 400 }}>{o.part_number} · {o.part_description}</span></>}
            sub={<>Revision <Link to={`/production/revisions/${o.revision_id}`}>{o.revision}</Link> · {fmtNum(o.qty, 3)} {o.uom} · due {fmtDate(o.due_date)}
              {o.sales_order_id && <> · for <Link to={`/sales/orders/${o.sales_order_id}`}>{o.sales_order_number}</Link> ({o.customer_name})</>}</>}
            actions={<MoStatus v={o.status} late={o.late} />} />
          <Kpis items={[
            { label: 'Finished', value: `${fmtNum(m.made, 3)} of ${fmtNum(o.qty, 3)}` }, { label: 'Received to stock', value: fmtNum(o.qty_received, 3) },
            { label: 'Scrapped', value: fmtNum(m.totalScrap, 3), tone: m.totalScrap ? 'watch' : undefined },
            { label: 'First-pass yield', value: m.firstPassYield == null ? '—' : `${m.firstPassYield}%` },
            { label: 'Hours (actual / standard)', value: `${fmtNum(m.actualHours, 2)} / ${fmtNum(m.standardHours, 2)}` },
          ]} />
          {note && <div className="notice ok">{note}</div>}
          {o.status === 'planned' && manage && (
            <div className="row"><button className="primary" onClick={() => release.run()} disabled={release.busy}>Release to the floor</button>
              <span className="faint">Copies materials and operations from the current released revision.</span><ErrorNote message={release.error} /></div>
          )}
          <section className="card stack">
            <h2>Operations</h2>
            <Table rows={o.operations} empty="Operations are copied when the order is released."
              columns={[{ key: 'op_no', label: 'Op', numeric: true }, { key: 'work_center', label: 'Work center', render: (x) => <Link to={`/production?tab=floor&wc=${x.work_center_id}`}>{x.work_center}</Link> },
                { key: 'description', label: 'Operation', render: (x) => <>{x.description}{x.document_id && <> · <DocLink id={x.document_id} title={x.document_title} /></>}</> },
                { key: 'input', label: 'Received', numeric: true, render: (x) => fmtNum(x.input, 3) }, { key: 'qty_good', label: 'Good', numeric: true, render: (x) => fmtNum(x.qty_good, 3) },
                { key: 'qty_scrap', label: 'Scrap', numeric: true, render: (x) => fmtNum(x.qty_scrap, 3) }, { key: 'qty_rework', label: 'Reworked', numeric: true, render: (x) => fmtNum(x.qty_rework, 3) },
                { key: 'actual_minutes', label: 'Minutes (actual / std)', numeric: true, render: (x) => `${fmtNum(x.actual_minutes, 0)} / ${fmtNum(x.qty_good + x.qty_scrap > 0 ? x.setup_minutes + x.run_minutes_per_unit * (x.qty_good + x.qty_scrap) : 0, 0)}` },
                { key: 'status', label: 'Status', render: (x) => <>{humanize(x.status)}{x.running > 0 && <> <Pill tone="good" label="Running" /></>}</> },
                { key: 'act', label: '', render: (x) => (exec && open && me?.employeeId && x.status !== 'done' && x.remaining > 0 && !x.running ? (
                  <button onClick={() => start.run(x.id, x.machines[0]?.id ?? null)} disabled={start.busy}>Start{x.machines[0] ? ` on ${x.machines[0].tag}` : ''}</button>) : null) }]} />
            <ErrorNote message={start.error} />
          </section>
          <section className="card stack">
            <div className="spread"><h2>Materials</h2>
              {open && can('purchasing.request', o.facility_id) && o.materials.some((x: any) => x.short > 0 && !x.made_in_house) && <button onClick={() => request.run()} disabled={request.busy}>Request what is short</button>}</div>
            <ErrorNote message={request.error ?? makePart.error} />
            <Table rows={o.materials} empty="Materials are copied when the order is released." exception={(x) => x.short > 0}
              columns={[{ key: 'part_number', label: 'Part', render: (x) => <>{x.part_number} <span className="faint">{x.description}</span>{x.made_in_house && <> <Pill tone="info" label="made in house" /></>}</> },
                { key: 'qty_required', label: 'Required', numeric: true, render: (x) => `${fmtNum(x.qty_required, 3)} ${x.uom}` },
                { key: 'qty_issued', label: 'Issued', numeric: true, render: (x) => fmtNum(x.qty_issued, 3) },
                { key: 'available', label: 'Available at site', numeric: true, render: (x) => fmtNum(x.available, 3) },
                { key: 'short', label: 'Short', numeric: true, render: (x) => (x.short > 0 ? <>
                  <span className="bad-text">{fmtNum(x.short, 3)}</span>
                  {x.made_in_house && manage && open && <> <button className="link" onClick={() => makePart.run(x)} disabled={makePart.busy}>Make {fmtNum(x.short, 3)}</button></>}</> : '—') },
                { key: 'variance_qty', label: 'Variance', numeric: true, render: (x) => (m.made > 0 ? fmtNum(x.variance_qty, 3) : '—') },
                ...(exec && open ? [{ key: 'issue', label: 'Issue now', render: (x: any) => (x.stock.length ? (
                  <div className="row">
                    <input aria-label={`Issue qty ${x.part_number}`} type="number" min="0" step="any" value={issueDefaults(x).qty} style={{ width: 90 }}
                      onChange={(e) => setIssue({ ...issue, [x.id]: { ...issueDefaults(x), qty: e.target.value } })} />
                    <select aria-label={`Issue from ${x.part_number}`} value={issueDefaults(x).loc} onChange={(e) => setIssue({ ...issue, [x.id]: { ...issueDefaults(x), loc: e.target.value } })}>
                      {x.stock.map((s: any) => <option key={s.location_id} value={s.location_id}>{s.location} ({fmtNum(s.on_hand, 3)})</option>)}
                    </select>
                  </div>) : <span className="faint">none in stock</span>) }] : [])]} />
            {exec && open && (
              <div className="row">
                <button onClick={() => setIssue(Object.fromEntries(o.materials.filter((x: any) => x.remaining > 0 && x.stock.length).map((x: any) => [x.id, { qty: String(Math.min(x.remaining, x.stock[0].on_hand)), loc: x.stock[0].location_id }])))}>Fill remaining</button>
                <button className="primary" onClick={() => doIssue.run()} disabled={doIssue.busy || !Object.values(issue).some((v) => Number(v.qty) > 0)}>Issue materials</button>
                <ErrorNote message={doIssue.error} />
              </div>
            )}
          </section>
          {open && exec && m.readyToReceive > 0 && (
            <section className="card">
              <h2>Receive finished goods</h2>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void receive.run(); }}>
                <input id="mo-receive" type="number" min="0.001" step="any" max={m.readyToReceive} placeholder={String(m.readyToReceive)} aria-label="Quantity to receive" value={recv} onChange={(e) => setRecv(e.target.value)} required style={{ width: 110 }} />
                <span className="muted">into {o.output_location ?? '(choose a storeroom on the order)'} at {fmtMoney(m.standardUnitCost)} standard material cost each</span>
                <button className="primary" disabled={receive.busy || !o.output_location_id}>Receive</button>
                <ErrorNote message={receive.error} />
              </form>
            </section>
          )}
          <section className="card">
            <h2>Shop-floor record</h2>
            <Table rows={o.entries} empty="No runs recorded yet."
              columns={[{ key: 'started_at', label: 'Started', render: (e) => fmtDateTime(e.started_at) }, { key: 'ended_at', label: 'Stopped', render: (e) => (e.ended_at ? fmtDateTime(e.ended_at) : <Pill tone="good" label="Running" />) },
                { key: 'op_no', label: 'Op', numeric: true }, { key: 'kind', label: 'Kind', render: (e) => humanize(e.kind) }, { key: 'operator', label: 'Operator' },
                { key: 'asset_tag', label: 'Machine', render: (e) => e.asset_tag ?? '—' }, { key: 'qty_good', label: 'Good', numeric: true, render: (e) => fmtNum(e.qty_good, 3) },
                { key: 'qty_scrap', label: 'Scrap', numeric: true, render: (e) => (e.qty_scrap ? `${fmtNum(e.qty_scrap, 3)} (${e.scrap_label})` : '—') },
                { key: 'note', label: 'Note' },
                ...(can('quality.report', o.facility_id) ? [{ key: 'ncr', label: '', render: (e: any) => (e.qty_scrap > 0 && e.ended_at ? (e.ncr_id
                  ? <Link to={`/quality/ncr/${e.ncr_id}`}>{e.ncr_number}</Link>
                  : <button className="link" onClick={() => raiseNcr.run(e)} disabled={raiseNcr.busy}>Raise NCR</button>) : null) }] : [])]} />
            <ErrorNote message={raiseNcr.error} />
          </section>
          <section className="card">
            <h2>Stock movements</h2>
            <Table rows={o.movements} empty="None yet."
              columns={[{ key: 'created_at', label: 'When', render: (t) => fmtDateTime(t.created_at) }, { key: 'txn_type', label: 'Movement', render: (t) => humanize(t.txn_type.replace('production_', '')) },
                { key: 'part_number', label: 'Part' }, { key: 'qty', label: 'Qty', numeric: true, render: (t) => fmtNum(t.qty, 3) }, { key: 'location', label: 'Storeroom' }, { key: 'by', label: 'By' }]} />
          </section>
          {o.short_reason && <div className="notice warn">Completed short: {o.short_reason}</div>}
          {o.cancel_reason && <div className="notice warn">Cancelled: {o.cancel_reason}</div>}
          {manage && (open || o.status === 'planned') && (
            <section className="card">
              <form className="row" onSubmit={(e) => e.preventDefault()}>
                <input id="mo-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (why it ends short, or why it is cancelled)" aria-label="Reason" style={{ flex: '1 1 320px' }} />
                {o.status === 'in_progress' && <button disabled={short.busy || reason.trim().length < 3} onClick={() => short.run()}>Complete short</button>}
                {['planned', 'released'].includes(o.status) && <button className="danger" disabled={cancel.busy || reason.trim().length < 3} onClick={() => cancel.run()}>Cancel order</button>}
                <ErrorNote message={short.error ?? cancel.error} />
              </form>
            </section>
          )}
          {manage && o.status === 'completed' && (
            <div className="row"><button className="primary" onClick={() => close.run()} disabled={close.busy}>Close order</button>
              <span className="faint">Material variance {fmtMoney(m.materialVariance)}. Return unused material before closing.</span><ErrorNote message={close.error} /></div>
          )}
        </>
      );
    }}</Async>
  );
}

// ---------------------------------------------------------------------------
// Products and revisions
// ---------------------------------------------------------------------------

function Products() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/products');
  const [pn, setPn] = useState('');
  const parts = useApi<any[]>(pn.length >= 2 ? `/api/parts?q=${encodeURIComponent(pn)}&limit=20` : null);
  const create = useAction(async (partId: string) => { const r = await api.post('/api/product-revisions', { partId }); nav(`/production/revisions/${r.id}`); });
  return (
    <>
      <div className="card stack">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data ?? []} rowKey={(p) => p.part_id} empty="No products yet. Start one below, or import bills of materials."
            onRow={(p) => nav(`/production/revisions/${(p.draft ?? p.released).id}`)}
            columns={[{ key: 'part_number', label: 'Part', render: (p) => <strong>{p.part_number}</strong> }, { key: 'description', label: 'Description' },
              { key: 'released', label: 'Released', render: (p) => (p.released ? `rev ${p.released.revision}` : <Pill tone="watch" label="None" />) },
              { key: 'draft', label: 'Draft', render: (p) => (p.draft ? <Pill tone="info" label={`rev ${p.draft.revision}`} /> : '—') },
              { key: 'open_orders', label: 'Open orders', numeric: true }]} />
        )}</Async>
      </div>
      {can('production.manage') && (
        <section className="card stack">
          <h2>Make a new product</h2>
          <input id="prod-part" aria-label="Find a part" placeholder="Find the part to make (part number or description)" value={pn} onChange={(e) => setPn(e.target.value)} />
          <Table rows={(parts.data ?? []).filter((p) => !(data ?? []).some((x) => x.part_id === p.id))} empty={pn.length >= 2 ? 'No matching parts without a product structure.' : 'Type at least two characters.'}
            columns={[{ key: 'part_number', label: 'Part' }, { key: 'description', label: 'Description' }, { key: 'uom', label: 'Unit' },
              { key: 'act', label: '', render: (p) => <button onClick={() => create.run(p.id)} disabled={create.busy}>Start revision 1</button> }]} />
          <ErrorNote message={create.error} />
          <p className="faint">Bills of materials from another system can be loaded with Data import (target “Bills of materials”); they arrive as drafts for review.</p>
        </section>
      )}
    </>
  );
}

interface MatRow { partId: string; partNumber: string; qtyPer: string; scrapPct: string; opNo: string }
interface OpRow { opNo: string; workCenterId: string; description: string; setupMinutes: string; runMinutesPerUnit: string }

export function RevisionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: r, loading, error, reload } = useApi<any>(`/api/product-revisions/${id}`);
  const wcs = useApi<any[]>('/api/work-centers');
  const [edit, setEdit] = useState<{ mats: MatRow[]; ops: OpRow[] } | null>(null);
  const [find, setFind] = useState('');
  const parts = useApi<any[]>(edit && find.length >= 2 ? `/api/parts?q=${encodeURIComponent(find)}&limit=10` : null);
  const save = useAction(async () => {
    await api.put(`/api/product-revisions/${id}`, {
      materials: edit!.mats.map((m) => ({ partId: m.partId, qtyPer: Number(m.qtyPer), scrapPct: Number(m.scrapPct) || 0, opNo: m.opNo ? Number(m.opNo) : null })),
      operations: edit!.ops.map((o) => ({ opNo: Number(o.opNo), workCenterId: o.workCenterId, description: o.description, setupMinutes: Number(o.setupMinutes) || 0, runMinutesPerUnit: Number(o.runMinutesPerUnit) || 0 })),
    });
    setEdit(null); await reload();
  });
  const release = useAction(async () => { await api.post(`/api/product-revisions/${id}/release`, {}); await reload(); });
  const revise = useAction(async () => { const n = await api.post('/api/product-revisions', { partId: r.part_id }); nav(`/production/revisions/${n.id}`); });
  return (
    <Async loading={loading && !r} error={error}>{() => {
      const manage = can('production.manage');
      const startEdit = () => setEdit({
        mats: r.materials.map((m: any) => ({ partId: m.part_id, partNumber: m.part_number, qtyPer: String(m.qty_per), scrapPct: String(m.scrap_pct || ''), opNo: m.op_no ? String(m.op_no) : '' })),
        ops: r.operations.map((o: any) => ({ opNo: String(o.op_no), workCenterId: o.work_center_id, description: o.description, setupMinutes: String(o.setup_minutes || ''), runMinutesPerUnit: String(o.run_minutes_per_unit || '') })),
      });
      return (
        <>
          <PageHead eyebrow="Product revision" title={<>{r.part_number} <span className="muted" style={{ fontWeight: 400 }}>rev {r.revision} · {r.part_description}</span></>}
            sub={<>{r.released_at ? `Released ${fmtDate(r.released_at)} by ${r.released_by_name}` : `Created by ${r.created_by_name}`}{r.notes ? ` · ${r.notes}` : ''}</>}
            actions={<Pill tone={r.status === 'released' ? 'good' : r.status === 'draft' ? 'info' : 'neutral'} label={humanize(r.status)} />} />
          <Kpis items={[
            { label: 'Standard material cost', value: fmtMoney(r.standard.materialCost), note: r.standard.uncosted.length ? `not costed: ${r.standard.uncosted.join(', ')}` : undefined },
            { label: 'Run minutes per unit', value: fmtNum(r.operations.reduce((s: number, o: any) => s + o.run_minutes_per_unit, 0), 2) },
            { label: 'Setup minutes per batch', value: fmtNum(r.operations.reduce((s: number, o: any) => s + o.setup_minutes, 0), 0) },
          ]} />
          {edit ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
              <section className="card stack">
                <h2>Routing</h2>
                {edit.ops.map((o, i) => (
                  <div className="row" key={i}>
                    <input aria-label={`Op ${i + 1} number`} type="number" min="1" value={o.opNo} onChange={(e) => setEdit({ ...edit, ops: edit.ops.map((x, j) => (j === i ? { ...x, opNo: e.target.value } : x)) })} style={{ width: 70 }} required />
                    <select aria-label={`Op ${i + 1} work center`} value={o.workCenterId} onChange={(e) => setEdit({ ...edit, ops: edit.ops.map((x, j) => (j === i ? { ...x, workCenterId: e.target.value } : x)) })} required>
                      <option value="">Work center…</option>{(wcs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.facility_code} · {w.code}</option>)}
                    </select>
                    <input aria-label={`Op ${i + 1} description`} placeholder="What is done" value={o.description} onChange={(e) => setEdit({ ...edit, ops: edit.ops.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} style={{ flex: '1 1 240px' }} required />
                    <label className="row">Setup min<input aria-label={`Op ${i + 1} setup minutes`} type="number" min="0" step="any" value={o.setupMinutes} onChange={(e) => setEdit({ ...edit, ops: edit.ops.map((x, j) => (j === i ? { ...x, setupMinutes: e.target.value } : x)) })} style={{ width: 80 }} /></label>
                    <label className="row">Run min/unit<input aria-label={`Op ${i + 1} run minutes`} type="number" min="0" step="any" value={o.runMinutesPerUnit} onChange={(e) => setEdit({ ...edit, ops: edit.ops.map((x, j) => (j === i ? { ...x, runMinutesPerUnit: e.target.value } : x)) })} style={{ width: 80 }} /></label>
                    <button type="button" onClick={() => setEdit({ ...edit, ops: edit.ops.filter((_, j) => j !== i) })}>Remove</button>
                  </div>
                ))}
                <div><button type="button" onClick={() => setEdit({ ...edit, ops: [...edit.ops, { opNo: String((Math.max(0, ...edit.ops.map((o) => Number(o.opNo) || 0)) + 10)), workCenterId: '', description: '', setupMinutes: '', runMinutesPerUnit: '' }] })}>Add operation</button></div>
              </section>
              <section className="card stack">
                <h2>Materials per unit</h2>
                {edit.mats.map((m, i) => (
                  <div className="row" key={m.partId}>
                    <strong style={{ minWidth: 160 }}>{m.partNumber}</strong>
                    <label className="row">Qty per<input aria-label={`Qty per ${m.partNumber}`} type="number" min="0" step="any" value={m.qtyPer} onChange={(e) => setEdit({ ...edit, mats: edit.mats.map((x, j) => (j === i ? { ...x, qtyPer: e.target.value } : x)) })} style={{ width: 90 }} required /></label>
                    <label className="row">Scrap %<input aria-label={`Scrap % ${m.partNumber}`} type="number" min="0" max="99" step="any" value={m.scrapPct} onChange={(e) => setEdit({ ...edit, mats: edit.mats.map((x, j) => (j === i ? { ...x, scrapPct: e.target.value } : x)) })} style={{ width: 70 }} /></label>
                    <label className="row">At op<input aria-label={`Op for ${m.partNumber}`} type="number" min="1" value={m.opNo} onChange={(e) => setEdit({ ...edit, mats: edit.mats.map((x, j) => (j === i ? { ...x, opNo: e.target.value } : x)) })} style={{ width: 70 }} /></label>
                    <button type="button" onClick={() => setEdit({ ...edit, mats: edit.mats.filter((_, j) => j !== i) })}>Remove</button>
                  </div>
                ))}
                <input id="rev-find-part" aria-label="Add a material" placeholder="Add a material: type a part number" value={find} onChange={(e) => setFind(e.target.value)} />
                {(parts.data ?? []).filter((p) => p.id !== r.part_id && !edit.mats.some((m) => m.partId === p.id)).slice(0, 6).map((p) => (
                  <button type="button" key={p.id} onClick={() => { setEdit({ ...edit, mats: [...edit.mats, { partId: p.id, partNumber: p.part_number, qtyPer: '1', scrapPct: '', opNo: '' }] }); setFind(''); }}>
                    + {p.part_number} · {p.description} ({p.uom})</button>
                ))}
              </section>
              <div className="row"><button className="primary" disabled={save.busy}>Save draft</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
              <ErrorNote message={save.error} />
            </form>
          ) : (
            <>
              <section className="card">
                <h2>Routing</h2>
                <Table rows={r.operations} empty="No operations yet."
                  columns={[{ key: 'op_no', label: 'Op', numeric: true }, { key: 'work_center', label: 'Work center', render: (o) => `${o.facility_code} · ${o.work_center}` }, { key: 'description', label: 'Operation' },
                    { key: 'setup_minutes', label: 'Setup min', numeric: true, render: (o) => fmtNum(o.setup_minutes, 1) }, { key: 'run_minutes_per_unit', label: 'Run min/unit', numeric: true, render: (o) => fmtNum(o.run_minutes_per_unit, 2) },
                    { key: 'document_title', label: 'Work instruction', render: (o) => (o.document_id ? <DocLink id={o.document_id} title={o.document_title} /> : '—') }]} />
              </section>
              <section className="card">
                <h2>Materials per unit</h2>
                <Table rows={r.materials} empty="No materials."
                  columns={[{ key: 'part_number', label: 'Part', render: (m) => <>{m.part_number}{m.made_rev && <> <Pill tone="info" label="made in house" /></>}</> }, { key: 'description', label: 'Description' },
                    { key: 'qty_per', label: 'Qty per', numeric: true, render: (m) => `${fmtNum(m.qty_per, 4)} ${m.uom}` }, { key: 'scrap_pct', label: 'Scrap %', numeric: true, render: (m) => (m.scrap_pct ? fmtNum(m.scrap_pct, 1) : '—') },
                    { key: 'op_no', label: 'At op', numeric: true, render: (m) => m.op_no ?? '—' }, { key: 'unit_cost', label: 'Unit cost', numeric: true, render: (m) => fmtMoney(m.unit_cost) }]} />
              </section>
              {manage && (
                <div className="row">
                  {r.status === 'draft' && <><button onClick={startEdit}>Edit draft</button><button className="primary" onClick={() => release.run()} disabled={release.busy}>Release revision {r.revision}</button></>}
                  {r.status === 'released' && !r.revisions.some((x: any) => x.status === 'draft') && <button onClick={() => revise.run()} disabled={revise.busy}>Start revision {Math.max(...r.revisions.map((x: any) => x.revision)) + 1}</button>}
                  <ErrorNote message={release.error ?? revise.error} />
                </div>
              )}
              {r.status === 'draft' && <p className="faint">Releasing makes this the revision new production orders use; the previous released revision becomes obsolete. Orders already released keep the revision they were released with.</p>}
            </>
          )}
          <section className="card">
            <h2>Revisions</h2>
            <Table rows={r.revisions} onRow={(x) => nav(`/production/revisions/${x.id}`)}
              columns={[{ key: 'revision', label: 'Revision', numeric: true }, { key: 'status', label: 'Status', render: (x) => humanize(x.status) }, { key: 'released_at', label: 'Released', render: (x) => fmtDate(x.released_at) }]} />
            {r.usedIn.length > 0 && <p className="muted">Used in: {r.usedIn.map((u: any) => <Link key={u.revision_id} to={`/production/revisions/${u.revision_id}`}>{u.part_number} rev {u.revision} </Link>)}</p>}
          </section>
        </>
      );
    }}</Async>
  );
}

// ---------------------------------------------------------------------------
// Work centers
// ---------------------------------------------------------------------------

function WorkCenters() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/work-centers');
  const facilities = useApi<any[]>('/api/facilities');
  const [f, setF] = useState<{ id?: string; facilityId: string; code: string; name: string; assetIds: string[] } | null>(null);
  const assets = useApi<any[]>(f?.facilityId ? `/api/assets?facilityId=${f.facilityId}&topLevel=true&limit=200` : null);
  const save = useAction(async () => { await api.post('/api/work-centers', f); setF(null); await reload(); });
  const assetRows = assets.data ?? [];
  return (
    <>
      <div className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data ?? []} empty="No work centers yet."
            onRow={(w) => can('production.manage', w.facility_id) && setF({ id: w.id, facilityId: w.facility_id, code: w.code, name: w.name, assetIds: w.assets.map((a: any) => a.id) })}
            columns={[{ key: 'facility_code', label: 'Site' }, { key: 'code', label: 'Code', render: (w) => <strong>{w.code}</strong> }, { key: 'name', label: 'Name' },
              { key: 'assets', label: 'Machines', render: (w) => (w.assets.length ? w.assets.map((a: any) => a.tag).join(', ') : 'Manual work') },
              { key: 'queued', label: 'Operations waiting', numeric: true }]} />
        )}</Async>
      </div>
      {can('production.manage') && !f && <div><button onClick={() => setF({ facilityId: '', code: '', name: '', assetIds: [] })}>Add work center</button></div>}
      {f && (
        <section className="card stack">
          <h2>{f.id ? `Edit ${f.code}` : 'New work center'}</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <div className="row">
              <select id="wc-facility" aria-label="Facility" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, assetIds: [] })} disabled={!!f.id} required>
                <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </select>
              <input id="wc-code" aria-label="Code" placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required style={{ width: 110 }} />
              <input id="wc-name" aria-label="Name" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required style={{ flex: '1 1 240px' }} />
            </div>
            {f.facilityId && (
              <fieldset className="stack"><legend>Machines that can run work here (none = manual work)</legend>
                <div className="row">{assetRows.map((a: any) => (
                  <label key={a.id} className="row"><input type="checkbox" checked={f.assetIds.includes(a.id)}
                    onChange={(e) => setF({ ...f, assetIds: e.target.checked ? [...f.assetIds, a.id] : f.assetIds.filter((x) => x !== a.id) })} />{a.asset_tag}</label>
                ))}</div>
              </fieldset>
            )}
            <div className="row"><button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={() => setF(null)}>Cancel</button></div>
            <ErrorNote message={save.error} />
          </form>
        </section>
      )}
    </>
  );
}
