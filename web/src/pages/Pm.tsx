import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const DUE: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'neutral' }> = {
  not_due: { label: 'Not due', tone: 'neutral' }, due: { label: 'Due', tone: 'watch' }, overdue: { label: 'Overdue', tone: 'bad' },
};
export const DueState = ({ v }: { v: string }) => <Pill tone={DUE[v]?.tone} label={DUE[v]?.label ?? v} />;
export const nextDueText = (p: any) => (p.trigger_type === 'calendar'
  ? fmtDate(p.next_due_on)
  : `${fmtNum(p.next_due_meter, 0)} ${humanize(p.meter)}${p.latest_meter != null ? ` (now ${fmtNum(p.latest_meter, 0)})` : ' (no reading yet)'}`);
export const intervalText = (p: any) => (p.trigger_type === 'calendar' ? `Every ${p.interval_days} days` : `Every ${fmtNum(p.interval_meter, 0)} ${humanize(p.meter)}`);

export function PmSchedule() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/pm?horizonDays=60');
  const [result, setResult] = useState<any>(null);
  const gen = useAction(async () => { setResult(await api.post('/api/pm/generate', {})); await reload(); });
  const [adding, setAdding] = useState(false);
  const rows = data ?? [];
  const manage = can('work_orders.manage');
  return (
    <>
      <PageHead eyebrow="Maintenance" title="Preventive maintenance"
        sub="Plans run on the calendar or on a meter. A plan becomes due inside its lead window; generating creates one work order per due plan, never a duplicate. The plan moves forward when its work order is verified."
        actions={manage ? <>
          <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'New plan'}</button>
          <button className="primary" disabled={gen.busy} onClick={() => gen.run()}>Generate due work orders</button>
        </> : undefined} />
      <ErrorNote message={gen.error} />
      {result && (
        <div className="notice ok">
          {result.created.length ? `Created ${result.created.map((c: any) => `${c.workOrder} (${c.plan})`).join(', ')}.` : 'No new work orders: nothing else is due.'}
          {result.skipped.length > 0 && ` Already open: ${result.skipped.map((s: any) => s.plan).join(', ')}.`}
        </div>
      )}
      {adding && <PlanForm onDone={(id) => nav(`/pm/${id}`)} />}
      <Kpis items={[
        { label: 'Overdue', value: rows.filter((p) => p.due_state === 'overdue').length, tone: rows.some((p) => p.due_state === 'overdue') ? 'bad' : 'good' },
        { label: 'Due now', value: rows.filter((p) => p.due_state === 'due').length, tone: 'watch' },
        { label: 'Due without a work order', value: rows.filter((p) => p.due_state !== 'not_due' && !p.open_work_order).length, tone: rows.some((p) => p.due_state !== 'not_due' && !p.open_work_order) ? 'watch' : 'good' },
        { label: 'Short of parts', value: rows.filter((p) => p.parts_short > 0).length, tone: rows.some((p) => p.parts_short > 0) ? 'watch' : 'good' },
      ]} />
      <div className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(p) => nav(`/pm/${p.id}`)} exception={(p) => p.due_state === 'overdue'} empty="No active PM plans."
            columns={[{ key: 'code', label: 'Plan', render: (p) => <strong>{p.code}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'asset_tag', label: 'Asset' },
              { key: 'title', label: 'Title' }, { key: 'interval', label: 'Interval', render: intervalText }, { key: 'next', label: 'Next due', render: nextDueText },
              { key: 'due_state', label: 'State', render: (p) => <DueState v={p.due_state} /> },
              { key: 'wo', label: 'Work order', render: (p) => (p.open_work_order ? <Link to={`/work-orders/${p.open_work_order.id}`} onClick={(e) => e.stopPropagation()}>{p.open_work_order.number}</Link> : <span className="faint">—</span>) },
              { key: 'parts', label: 'Parts', render: (p) => (!p.parts.length ? <span className="faint">—</span> : p.parts_short ? <Pill tone="watch" label={`${p.parts_short} short`} /> : <Pill tone="good" label="In stock" />) }]} />
        )}</Async>
      </div>
    </>
  );
}

export function PmPlanDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: p, loading, error, reload } = useApi<any>(`/api/pm/${id}`);
  const sched = useApi<any[]>(p ? `/api/pm?assetId=${p.asset_id}` : null);
  const [reason, setReason] = useState('');
  const toggle = useAction(async () => { await api.post(`/api/pm/${id}/active`, { active: !p.active, reason }); setReason(''); await reload(); });
  return (
    <Async loading={loading && !p} error={error}>{() => {
      const parts = sched.data?.find((s) => s.id === p.id)?.parts ?? [];
      return (
        <>
          <PageHead eyebrow={`Preventive maintenance · ${p.code}`} title={p.title}
            sub={<>Asset <Link to={`/assets/${p.asset_id}`}>{p.asset_tag} {p.asset_name}</Link></>}
            actions={p.active ? <DueState v={p.due_state} /> : <Pill tone="neutral" label="Paused" />} />
          <div className="grid two">
            <section className="card">
              <h2>Schedule</h2>
              <dl className="facts">
                <dt>Trigger</dt><dd>{intervalText(p)}, {p.schedule_basis === 'fixed' ? 'fixed schedule (keeps its dates)' : 'counted from when the work is done'}</dd>
                <dt>Next due</dt><dd>{nextDueText(p)}</dd>
                <dt>Lead window</dt><dd>{p.trigger_type === 'calendar' ? `${p.lead_days} days before` : `${fmtNum(p.lead_meter, 0)} ${humanize(p.meter)} before`}</dd>
                <dt>Last done</dt><dd>{fmtDate(p.last_done_on)}{p.last_done_meter != null ? ` at ${fmtNum(p.last_done_meter, 0)} ${humanize(p.meter)}` : ''}</dd>
                <dt>Estimated time</dt><dd>{p.estimated_hours ? `${fmtNum(p.estimated_hours)} h` : '—'}</dd>
                <dt>Procedure</dt><dd>{p.doc_number ?? '—'}</dd>
              </dl>
              {p.instructions && <p>{p.instructions}</p>}
            </section>
            <section className="card stack">
              <h2>Parts list</h2>
              <Table rows={parts.length ? parts : p.parts} rowKey={(x) => x.part_id} empty="No parts on this plan."
                columns={[{ key: 'part_number', label: 'Part' }, { key: 'description', label: 'Description' }, { key: 'qty', label: 'Qty', numeric: true },
                  { key: 'on_hand', label: 'On hand at site', numeric: true, render: (x) => (x.stocked === false ? <span className="faint">not stocked</span> : fmtNum(x.on_hand, 3)) },
                  { key: 'short', label: '', render: (x) => (x.short ? <Pill tone="watch" label="Short" /> : null) }]} />
            </section>
          </div>
          <section className="card stack">
            <h2>Work orders from this plan</h2>
            <Table rows={p.history} onRow={(w) => nav(`/work-orders/${w.id}`)} empty="None yet."
              columns={[{ key: 'number', label: 'WO' }, { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> }, { key: 'due_at', label: 'Due', render: (w) => fmtDate(w.due_at) },
                { key: 'completed_at', label: 'Completed', render: (w) => fmtDate(w.completed_at) },
                { key: 'on_time', label: '', render: (w) => (w.completed_at ? <Pill tone={w.on_time ? 'good' : 'watch'} label={w.on_time ? 'On time' : 'Late'} /> : null) }]} />
          </section>
          {can('work_orders.manage', p.facility_id) && (
            <section className="card">
              <form className="row" onSubmit={(e) => { e.preventDefault(); void toggle.run(); }}>
                <input id="pm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={p.active ? 'Reason for pausing (e.g. asset idle until Q1)' : 'Reason for resuming'} style={{ maxWidth: 360 }} aria-label="Reason" />
                <button disabled={toggle.busy || reason.trim().length < 5}>{p.active ? 'Pause plan' : 'Resume plan'}</button>
                <ErrorNote message={toggle.error} />
              </form>
            </section>
          )}
        </>
      );
    }}</Async>
  );
}

function PlanForm({ onDone }: { onDone: (id: string) => void }) {
  const assets = useApi<any[]>('/api/assets');
  const parts = useApi<any[]>('/api/parts');
  const [f, setF] = useState({ assetId: '', code: '', title: '', triggerType: 'calendar', intervalDays: '30', meter: 'run_hours', intervalMeter: '500', firstDue: '', scheduleBasis: 'completion', estimatedHours: '' });
  const [lines, setLines] = useState<{ partId: string; qty: string }[]>([]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const act = useAction(async () => {
    const cal = f.triggerType === 'calendar';
    const plan = await api.post('/api/pm', {
      assetId: f.assetId, code: f.code, title: f.title, triggerType: f.triggerType, scheduleBasis: f.scheduleBasis,
      intervalDays: cal ? Number(f.intervalDays) : null, meter: cal ? null : f.meter, intervalMeter: cal ? null : Number(f.intervalMeter),
      firstDueOn: cal && f.firstDue ? f.firstDue : null, firstDueMeter: !cal && f.firstDue ? Number(f.firstDue) : null,
      estimatedHours: f.estimatedHours ? Number(f.estimatedHours) : null,
      parts: lines.filter((l) => l.partId && Number(l.qty) > 0).map((l) => ({ partId: l.partId, qty: Number(l.qty) })),
    });
    onDone(plan.id);
  });
  const cal = f.triggerType === 'calendar';
  return (
    <section className="card">
      <h2>New PM plan</h2>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
        <div className="form-grid">
          <label className="field">Asset<select id="pm-asset" value={f.assetId} onChange={set('assetId')} required>
            <option value="">Choose…</option>{(assets.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.asset_tag} · {a.name}</option>)}</select></label>
          <label className="field">Plan code<input id="pm-code" value={f.code} onChange={set('code')} required placeholder="e.g. PM-CNC-102-M" /></label>
          <label className="field">Title<input id="pm-title" value={f.title} onChange={set('title')} required minLength={3} /></label>
          <label className="field">Trigger<select id="pm-trigger" value={f.triggerType} onChange={set('triggerType')}>
            <option value="calendar">Calendar</option><option value="meter">Meter reading</option></select></label>
          {cal
            ? <label className="field">Every (days)<input id="pm-days" type="number" min="1" value={f.intervalDays} onChange={set('intervalDays')} required /></label>
            : <>
                <label className="field">Meter<input id="pm-meter" value={f.meter} onChange={set('meter')} required /></label>
                <label className="field">Every (meter units)<input id="pm-every" type="number" min="1" step="any" value={f.intervalMeter} onChange={set('intervalMeter')} required /></label>
              </>}
          <label className="field">{cal ? 'First due date' : 'First due reading'}<input id="pm-first" type={cal ? 'date' : 'number'} value={f.firstDue} onChange={set('firstDue')} placeholder="default: one interval from now" /></label>
          <label className="field">Schedule<select id="pm-basis" value={f.scheduleBasis} onChange={set('scheduleBasis')}>
            <option value="completion">Count from when work is done</option><option value="fixed">Keep fixed dates</option></select></label>
          <label className="field">Estimated hours<input id="pm-hours" type="number" min="0" step="0.25" value={f.estimatedHours} onChange={set('estimatedHours')} /></label>
        </div>
        <div className="stack">
          <h3>Parts list</h3>
          {lines.map((l, i) => (
            <div className="row" key={i}>
              <select aria-label="Part" value={l.partId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, partId: e.target.value } : x)))} style={{ maxWidth: 280 }}>
                <option value="">Choose a part…</option>{(parts.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}
              </select>
              <input aria-label="Quantity" type="number" min="0.001" step="any" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} style={{ width: 90 }} />
              <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div><button type="button" onClick={() => setLines([...lines, { partId: '', qty: '1' }])}>Add a part</button></div>
        </div>
        <ErrorNote message={act.error} />
        <div><button className="primary" disabled={act.busy}>Create plan</button></div>
      </form>
    </section>
  );
}
