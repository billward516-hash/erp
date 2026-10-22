import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, ['good' | 'watch' | 'info', string]> = { draft: ['info', 'Draft'], handed_over: ['watch', 'Handed over, not yet read'], acknowledged: ['good', 'Acknowledged'] };
const CAT_TONE: Record<string, 'bad' | 'watch' | 'info' | 'neutral'> = { safety: 'bad', equipment: 'watch', quality: 'watch', production: 'info', people: 'neutral', other: 'neutral' };
const CATS = ['safety', 'equipment', 'quality', 'production', 'people', 'other'];
const span = (a: string, b: string) => `${new Date(a).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} – ${new Date(b).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;

export function ShiftLog() {
  const nav = useNavigate();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const [facilityId, setFacilityId] = useState('');
  const site = facilityId || facilities.data?.[0]?.id || '';
  const { data, loading, error } = useApi<any[]>(site ? `/api/shift-logs?facilityId=${site}` : null);
  const [area, setArea] = useState('');
  const writer = can('work_orders.execute') || can('production.execute') || can('work_orders.manage') || can('production.manage');
  const start = useAction(async () => { const h = await api.post('/api/shift-logs', { facilityId: site, area: area || null }); nav(`/shift-log/${h.id}`); });
  return (
    <>
      <PageHead eyebrow="Shift passdown" title="Shift log" sub="What the next shift needs to know: what is down, what is urgent, what was made and scrapped, what happened, and what is still open. Facts come from the records; open items carry over until resolved." />
      <div className="row">
        <select id="shift-site" aria-label="Site" value={site} onChange={(e) => setFacilityId(e.target.value)} style={{ width: 'auto' }}>
          {(facilities.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.code} {f.name}</option>)}
        </select>
        {writer && <>
          <input id="shift-area" aria-label="Area" placeholder="Area (blank = whole site)" value={area} onChange={(e) => setArea(e.target.value)} style={{ width: 220 }} />
          <button className="primary" disabled={start.busy || !site} onClick={() => start.run()}>Write up this shift</button>
        </>}
        <ErrorNote message={start.error} />
      </div>
      <div className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data ?? []} rowKey={(h) => h.id} onRow={(h) => nav(`/shift-log/${h.id}`)} exception={(h) => h.status === 'handed_over' || h.open_safety > 0} empty="No shift logs yet at this site."
            columns={[{ key: 'period_end', label: 'Shift', render: (h) => <><strong>{h.shift_label}</strong> <span className="faint">{span(h.period_start, h.period_end)}</span></> },
              { key: 'area', label: 'Area' }, { key: 'written_by', label: 'Written by' },
              { key: 'status', label: 'Status', render: (h) => <Pill tone={STATUS[h.status]![0]} label={STATUS[h.status]![1]} /> },
              { key: 'open_items', label: 'Open items', numeric: true, render: (h) => <>{h.open_items}{h.open_safety ? <> <Pill tone="bad" label={`${h.open_safety} safety`} /></> : null}</> },
              { key: 'machines_down', label: 'Machines down', numeric: true }, { key: 'acknowledged_by', label: 'Read by', render: (h) => h.acknowledged_by ?? '—' }]} />
        )}</Async>
      </div>
    </>
  );
}

export function ShiftLogDetail() {
  const { id } = useParams();
  const { data: h, loading, error, reload } = useApi<any>(`/api/shift-logs/${id}`);
  const [notes, setNotes] = useState<{ notes?: string; safetyNotes?: string }>({});
  const [item, setItem] = useState({ category: 'equipment', text: '' });
  const [resolve, setResolve] = useState<Record<string, string>>({});
  const [ack, setAck] = useState('');
  const save = useAction(async (extra: any = {}) => { await api.put(`/api/shift-logs/${id}`, { ...notes, ...extra }); setNotes({}); await reload(); });
  const handOver = useAction(async () => { if (Object.keys(notes).length) await api.put(`/api/shift-logs/${id}`, notes); await api.post(`/api/shift-logs/${id}/hand-over`); setNotes({}); await reload(); });
  const acknowledge = useAction(async () => { await api.post(`/api/shift-logs/${id}/acknowledge`, { note: ack || null }); await reload(); });
  return (
    <Async loading={loading && !h} error={error}>{() => {
      const f = h.facts; const draft = h.status === 'draft'; const edit = draft && h.canWrite;
      const open = h.items.filter((i: any) => !i.resolved);
      const totals = f.production.reduce((t: any, p: any) => ({ good: t.good + p.good, scrap: t.scrap + p.scrap }), { good: 0, scrap: 0 });
      return (
        <>
          <PageHead eyebrow={`${h.facility_code} · ${h.area} · shift log`} title={`${h.shift_label} shift, ${span(h.period_start, h.period_end)}`}
            sub={<>Written by {h.written_by_name}{h.handed_over_at ? ` · handed over ${fmtDateTime(h.handed_over_at)}` : ''}{h.acknowledged_at ? ` · read by ${h.acknowledged_by_name} ${fmtDateTime(h.acknowledged_at)}` : ''}</>}
            actions={<Pill tone={STATUS[h.status]![0]} label={STATUS[h.status]![1]} />} />
          {draft && <p className="faint" style={{ margin: 0 }}>The facts below are live until you hand over; then they are frozen with the log.</p>}
          <Kpis items={[
            { label: 'Machines down', value: f.machinesDown.length, tone: f.machinesDown.length ? 'bad' : 'good' },
            { label: 'Urgent work open', value: f.urgentWork.length, tone: f.urgentWork.length ? 'watch' : undefined },
            { label: 'Made this shift', value: fmtNum(totals.good, 0), note: totals.scrap ? `${fmtNum(totals.scrap, 0)} scrapped` : 'no scrap' },
            { label: 'Open items', value: open.length, tone: open.some((i: any) => i.category === 'safety') ? 'bad' : undefined },
          ]} />
          {(h.safety_notes || edit) && (
            <section className="card stack" style={{ borderLeft: '3px solid var(--bad)' }}>
              <h2>Safety</h2>
              {edit ? <textarea id="shift-safety" aria-label="Safety notes" rows={2} placeholder="Hazards the next shift must know (spills, bypassed guards, lockouts in place)" value={notes.safetyNotes ?? h.safety_notes ?? ''} onChange={(e) => setNotes({ ...notes, safetyNotes: e.target.value })} />
                : <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{h.safety_notes}</p>}
              {f.incidents.length > 0 && <p className="muted" style={{ margin: 0 }}>Reported this shift: {f.incidents.map((i: any, k: number) => <span key={i.id}>{k ? ', ' : ''}<Link to={`/safety/${i.id}`}>{i.number}</Link> {humanize(i.kind)}{i.location ? ` (${i.location})` : ''}</span>)}</p>}
            </section>
          )}
          <section className="card stack">
            <h2>Open items {open.length > 0 && <span className="faint">· carry to the next shift until resolved</span>}</h2>
            {h.items.length === 0 && <p className="muted">No items.</p>}
            {h.items.map((i: any) => (
              <div key={i.id} className="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div style={{ flex: '1 1 300px' }}>
                  <Pill tone={CAT_TONE[i.category]!} label={humanize(i.category)} /> {i.resolved ? <s>{i.text}</s> : <strong>{i.text}</strong>}
                  {i.asset_tag && <> · <Link to={`/assets/${i.asset_id}`}>{i.asset_tag}</Link></>}{i.work_order_number && <> · <Link to={`/work-orders/${i.work_order_id}`}>{i.work_order_number}</Link></>}
                  <div className="faint">{i.carried_from ? `carried from ${i.carried_from}` : `added by ${i.created_by_name}`}{i.resolved ? ` · resolved: ${i.resolved_note}` : ''}</div>
                </div>
                {edit && !i.resolved && <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run({ items: [{ id: i.id, category: i.category, text: i.text, assetId: i.asset_id, workOrderId: i.work_order_id, resolved: true, resolvedNote: resolve[i.id] }] }); }}>
                  <input aria-label={`How "${i.text}" was resolved`} placeholder="How it was resolved" value={resolve[i.id] ?? ''} onChange={(e) => setResolve({ ...resolve, [i.id]: e.target.value })} required style={{ width: 220 }} />
                  <button disabled={save.busy}>Resolved</button></form>}
              </div>
            ))}
            {edit && <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run({ items: [{ category: item.category, text: item.text }] }).then(() => setItem({ ...item, text: '' })); }}>
              <select id="shift-item-cat" aria-label="Category" value={item.category} onChange={(e) => setItem({ ...item, category: e.target.value })} style={{ width: 'auto' }}>{CATS.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select>
              <input id="shift-item-text" aria-label="Item" placeholder="What the next shift needs to follow up" value={item.text} onChange={(e) => setItem({ ...item, text: e.target.value })} required style={{ flex: '1 1 300px' }} />
              <button disabled={save.busy}>Add</button></form>}
            <ErrorNote message={save.error} />
          </section>
          <section className="card stack">
            <h2>Notes</h2>
            {edit ? <textarea id="shift-notes" aria-label="Notes" rows={4} placeholder="How the shift went, what was changed, anything unusual" value={notes.notes ?? h.notes ?? ''} onChange={(e) => setNotes({ ...notes, notes: e.target.value })} />
              : <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{h.notes || '—'}</p>}
            {edit && Object.keys(notes).length > 0 && <div><button onClick={() => save.run()} disabled={save.busy}>Save notes</button></div>}
          </section>
          <div className="grid two">
            <section className="card stack">
              <h2>Equipment</h2>
              {f.machinesDown.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{f.machinesDown.map((m: any) => <li key={m.id}><Link to={`/assets/${m.id}`}>{m.asset_tag}</Link> {m.name}: <span className="bad-text">{humanize(m.state)}</span>{m.since ? ` since ${fmtDateTime(m.since)}` : ''}</li>)}</ul> : <p className="muted" style={{ margin: 0 }}>Nothing down.</p>}
              {f.urgentWork.length > 0 && <p style={{ margin: 0 }}>Urgent work open: {f.urgentWork.map((x: any, k: number) => <span key={x.id}>{k ? ', ' : ''}<Link to={`/work-orders/${x.id}`}>{x.number}</Link> {x.title} (P{x.priority}, {humanize(x.status)})</span>)}</p>}
              {f.workDone.length > 0 && <p className="muted" style={{ margin: 0 }}>Completed this shift: {f.workDone.map((x: any, k: number) => <span key={x.id}>{k ? ', ' : ''}<Link to={`/work-orders/${x.id}`}>{x.number}</Link> {x.title}</span>)}</p>}
              {f.excursions.length > 0 && <p style={{ margin: 0 }}>Out of limits: {f.excursions.map((x: any) => `${x.asset_tag} ${x.measure} ${x.worst} ${x.unit}`).join(', ')}</p>}
            </section>
            <section className="card stack">
              <h2>Production and quality</h2>
              {f.production.length ? <Table rows={f.production} rowKey={(p) => p.work_center}
                columns={[{ key: 'work_center', label: 'Work center' }, { key: 'good', label: 'Good', numeric: true, render: (p) => fmtNum(p.good, 0) },
                  { key: 'scrap', label: 'Scrap', numeric: true, render: (p) => (p.scrap ? <span className="bad-text">{fmtNum(p.scrap, 0)}</span> : '0') }, { key: 'scrap_reasons', label: 'Why', render: (p) => p.scrap_reasons ?? '—' }]} />
                : <p className="muted" style={{ margin: 0 }}>No production recorded this shift.</p>}
              {f.lateOrders.length > 0 && <p style={{ margin: 0 }}>Behind: {f.lateOrders.map((o: any, k: number) => <span key={o.id}>{k ? ', ' : ''}<Link to={`/production/orders/${o.id}`}>{o.number}</Link> {o.part_number} ({fmtNum(o.remaining, 0)} left, due {o.due_date})</span>)}</p>}
              {f.ncrs.length > 0 && <p style={{ margin: 0 }}>Nonconformances: {f.ncrs.map((n: any, k: number) => <span key={n.id}>{k ? ', ' : ''}<Link to={`/quality/ncr/${n.id}`}>{n.number}</Link> {n.title}</span>)}</p>}
              {f.signals.length > 0 && <p style={{ margin: 0 }}>Open SPC signals: {[...new Map(f.signals.map((s: any) => [s.characteristic_id, s])).values()].map((s: any, k: number) => {
                const n = f.signals.filter((x: any) => x.characteristic_id === s.characteristic_id).length;
                return <span key={s.characteristic_id}>{k ? ', ' : ''}<Link to={`/quality/spc/${s.characteristic_id}`}>{s.code}</Link> ({n} signal{n === 1 ? '' : 's'})</span>;
              })}</p>}
            </section>
          </div>
          {edit && h.mine && <div className="row"><button className="primary" disabled={handOver.busy} onClick={() => handOver.run()}>Hand over to the next shift</button><ErrorNote message={handOver.error} /></div>}
          {h.status === 'handed_over' && h.canWrite && !h.mine && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void acknowledge.run(); }}>
              <input id="shift-ack" aria-label="Note on taking over" placeholder="Note on taking over (optional)" value={ack} onChange={(e) => setAck(e.target.value)} style={{ flex: '1 1 300px' }} />
              <button className="primary" disabled={acknowledge.busy}>I have read this and taken over</button><ErrorNote message={acknowledge.error} />
            </form>
          )}
          {h.ack_note && <p className="muted">On taking over: {h.ack_note}</p>}
        </>
      );
    }}</Async>
  );
}
