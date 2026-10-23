import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtPct } from '../format';
import { useAction, useApi } from '../hooks';

const STATE_TONE: Record<string, 'good' | 'watch' | 'bad' | 'neutral'> = { ok: 'good', out: 'bad', missed: 'watch', 'no readings': 'neutral' };
const fmtV = (v: number | null, unit: string) => (v == null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`);

export function Stores() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'conditions' | 'visits' | 'checklists'>('conditions');
  return (
    <>
      <PageHead eyebrow="Store operations" title="Conditions and store visits" sub="Cooler and freezer logs with their limits, and checklists walked at each site. Anything out of limits or failed becomes a request or an action." />
      <div className="row" role="tablist" aria-label="Store views">
        {([['conditions', 'Conditions'], ['visits', 'Visits'], ...(can('visits.conduct') ? [['checklists', 'Checklists']] : [])] as [string, string][]).map(([k, l]) =>
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k as any)}>{l}</button>)}
      </div>
      {tab === 'conditions' && <Conditions />}
      {tab === 'visits' && <Visits />}
      {tab === 'checklists' && <Checklists />}
    </>
  );
}

function Conditions() {
  const { data, loading, error, reload } = useApi<any[]>('/api/condition-points');
  return (
    <Async loading={loading && !data} error={error}>{() => {
      const rows = data ?? [];
      return (
        <>
          <Kpis items={[{ label: 'Points logged', value: rows.length }, { label: 'Out of limits now', value: rows.filter((r) => r.state === 'out').length, tone: rows.some((r) => r.state === 'out') ? 'bad' : 'good' },
            { label: 'Readings overdue', value: rows.filter((r) => r.state === 'missed').length, tone: rows.some((r) => r.state === 'missed') ? 'watch' : 'good' }]} />
          <div className="card stack">
            <Table rows={rows} rowKey={(p) => p.id} empty="No condition logs set up. Add limits to a cooler or freezer from its asset page." exception={(p) => p.state !== 'ok'}
              columns={[{ key: 'facility_code', label: 'Site' }, { key: 'asset', label: 'Equipment', render: (p) => <Link to={`/assets/${p.asset_id}`}>{p.asset_name} <span className="faint">{p.asset_tag}</span></Link> },
                { key: 'limits', label: 'Limits', render: (p) => <>{p.limits}{p.interval_hours ? <div className="faint">every {p.interval_hours} h</div> : null}</> },
                { key: 'last', label: 'Last reading', render: (p) => <>{fmtV(p.last_value, p.unit)}<div className="faint">{fmtDateTime(p.last_read_at)}</div></> },
                { key: 'state', label: 'State', render: (p) => <><Pill tone={STATE_TONE[p.state]} label={p.state === 'out' ? `out since ${fmtDateTime(p.excursion_started_at)}` : p.state} />
                  {p.state === 'out' && <div className="bad-text">worst {fmtV(p.worst_value, p.unit)}</div>}</> },
                { key: 'log', label: '', render: (p) => <ReadingForm point={p} onDone={reload} /> }]} />
          </div>
        </>
      );
    }}</Async>
  );
}

/** Quick reading entry (also on the asset page, reached from the equipment's QR code). */
export function ReadingForm({ point, onDone }: { point: any; onDone: () => void }) {
  const { can } = useAuth();
  const [v, setV] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const save = useAction(async () => {
    const r = await api.post(`/api/condition-points/${point.id}/readings`, { value: Number(v), note: note || null });
    setMsg(r.inRange ? (r.excursion?.closed ? 'Back in range; the excursion is closed.' : 'Logged.') : r.excursion?.opened ? 'Out of limits: maintenance has been asked to check it.' : 'Still out of limits; logged on the open excursion.');
    setV(''); setNote(''); onDone();
  });
  if (!can('assets.record_state', point.facility_id)) return null;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <input aria-label={`Reading for ${point.asset_tag}`} type="number" step="0.1" placeholder={point.unit} value={v} onChange={(e) => setV(e.target.value)} required style={{ width: 80 }} />
      <input aria-label={`Note for ${point.asset_tag}`} placeholder="Note / action taken" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 180 }} />
      <button disabled={save.busy}>Log</button>
      {msg && <span className={msg.startsWith('Out') || msg.startsWith('Still') ? 'bad-text' : 'muted'}>{msg}</span>}<ErrorNote message={save.error} />
    </form>
  );
}

/** Condition logs of one asset with recent readings and excursions (asset page). */
export function AssetConditions({ assetId, facilityId }: { assetId: string; facilityId: string }) {
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>(`/api/condition-points?assetId=${assetId}`);
  const [f, setF] = useState<{ unit: string; low: string; high: string; every: string } | null>(null);
  const first = data?.[0];
  const hist = useApi<any>(first ? `/api/condition-points/${first.id}/readings?days=7` : null);
  const save = useAction(async () => {
    await api.put('/api/condition-points', { assetId, unit: f!.unit, low: f!.low === '' ? null : Number(f!.low), high: f!.high === '' ? null : Number(f!.high), intervalHours: f!.every ? Number(f!.every) : null });
    setF(null); await reload();
  });
  if (!data || (!data.length && !can('assets.manage', facilityId))) return null;
  return (
    <section className="card stack">
      <div className="spread"><h2>Condition log</h2>{can('assets.manage', facilityId) && !f && <button onClick={() => setF({ unit: first?.unit ?? '°F', low: first?.low != null ? String(first.low) : '', high: first?.high != null ? String(first.high) : '', every: first?.interval_hours ? String(first.interval_hours) : '12' })}>{first ? 'Edit limits' : 'Log temperature'}</button>}</div>
      {f && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <input aria-label="Unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} style={{ width: 60 }} />
          <input aria-label="Low limit" type="number" step="0.1" placeholder="Low" value={f.low} onChange={(e) => setF({ ...f, low: e.target.value })} style={{ width: 80 }} />
          <input aria-label="High limit" type="number" step="0.1" placeholder="High" value={f.high} onChange={(e) => setF({ ...f, high: e.target.value })} style={{ width: 80 }} />
          <label className="row">every <input aria-label="Interval hours" type="number" min="1" value={f.every} onChange={(e) => setF({ ...f, every: e.target.value })} style={{ width: 70 }} /> h</label>
          <button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={() => setF(null)}>Cancel</button><ErrorNote message={save.error} />
        </form>
      )}
      {data.map((p) => (
        <div key={p.id} className="stack">
          <div className="spread"><span><strong>{p.measure}</strong> · limits {p.limits}{p.interval_hours ? ` · every ${p.interval_hours} h` : ''}</span><Pill tone={STATE_TONE[p.state]} label={p.state} /></div>
          <ReadingForm point={p} onDone={() => { void reload(); void hist.reload(); }} />
        </div>
      ))}
      {hist.data && (
        <>
          <Table rows={hist.data.readings.slice(0, 14)} rowKey={(r) => r.id} empty="No readings in the last 7 days." exception={(r) => !r.in_range}
            columns={[{ key: 'read_at', label: 'Read', render: (r) => fmtDateTime(r.read_at) }, { key: 'value', label: 'Value', numeric: true, render: (r) => fmtV(r.value, first.unit) },
              { key: 'recorded_by', label: 'By', render: (r) => r.recorded_by ?? r.source }, { key: 'note', label: 'Note' }]} />
          {hist.data.excursions.length > 0 && <p className="muted">Excursions: {hist.data.excursions.slice(0, 3).map((e: any) => `${fmtDateTime(e.started_at)} → ${e.ended_at ? fmtDateTime(e.ended_at) : 'open'} (worst ${fmtV(e.worst_value, first.unit)}${e.work_order ? `, ${e.work_order}` : ''})`).join('; ')}</p>}
        </>
      )}
    </section>
  );
}

function Visits() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/site-visits');
  const sites = useApi<any[]>(can('visits.conduct') ? '/api/sites' : null);
  const templates = useApi<any[]>('/api/visit-templates');
  const [f, setF] = useState({ facilityId: '', templateId: '' });
  const start = useAction(async () => { const v = await api.post('/api/site-visits', f); nav(`/stores/visits/${v.id}`); });
  return (
    <div className="card stack">
      {can('visits.conduct') && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void start.run(); }}>
          <select id="visit-site" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required style={{ width: 'auto' }}>
            <option value="">Site…</option>{(sites.data ?? []).filter((s) => can('visits.conduct', s.id)).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
          </select>
          <select id="visit-template" aria-label="Checklist" value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })} required style={{ width: 'auto' }}>
            <option value="">Checklist…</option>{(templates.data ?? []).filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="primary" disabled={start.busy}>Start visit</button><ErrorNote message={start.error} />
        </form>
      )}
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(v) => v.id} empty="No visits yet." onRow={(v) => nav(`/stores/visits/${v.id}`)} exception={(v) => v.critical_fails > 0}
          columns={[{ key: 'number', label: 'Visit', render: (v) => <strong>{v.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'title', label: 'Checklist' },
            { key: 'visited_on', label: 'Date', render: (v) => fmtDate(v.visited_on) }, { key: 'visited_by', label: 'By' },
            { key: 'score', label: 'Score', numeric: true, render: (v) => (v.status === 'completed' ? <>{fmtPct(v.score)}{v.critical_fails ? <div className="bad-text">{v.critical_fails} critical</div> : null}</> : <Pill tone="info" label="in progress" />) },
            { key: 'open_actions', label: 'Open fixes', numeric: true }]} />
      )}</Async>
    </div>
  );
}

function Checklists() {
  const { data, reload } = useApi<any[]>('/api/visit-templates');
  const [t, setT] = useState<{ id?: string; code: string; name: string; text: string } | null>(null);
  const save = useAction(async () => {
    const items = t!.text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const crit = l.startsWith('!'); const body = l.replace(/^!\s*/, ''); const [area, ...rest] = body.split(':'); return rest.length ? { area: area!.trim(), text: rest.join(':').trim(), critical: crit } : { area: null, text: body, critical: crit }; });
    const body = { code: t!.code, name: t!.name, items };
    if (t!.id) await api.put(`/api/visit-templates/${t!.id}`, body); else await api.post('/api/visit-templates', body);
    setT(null); await reload();
  });
  return (
    <div className="card stack">
      <Table rows={data ?? []} rowKey={(x) => x.id} empty="No checklists yet."
        columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'items', label: 'Items', numeric: true, render: (x) => `${x.items.length} (${x.items.filter((i: any) => i.critical).length} critical)` },
          { key: 'e', label: '', render: (x) => <button className="link" onClick={() => setT({ id: x.id, code: x.code, name: x.name, text: x.items.map((i: any) => `${i.critical ? '! ' : ''}${i.area ? `${i.area}: ` : ''}${i.text}`).join('\n') })}>Edit</button> }]} />
      {t ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="row"><input aria-label="Checklist code" placeholder="Code" value={t.code} onChange={(e) => setT({ ...t, code: e.target.value })} required style={{ width: 120 }} />
            <input aria-label="Checklist name" placeholder="Name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} required style={{ flex: '1 1 240px' }} /></div>
          <textarea aria-label="Checklist items" rows={10} value={t.text} onChange={(e) => setT({ ...t, text: e.target.value })} placeholder={'One item per line, "Area: item". Start with ! for critical.\nFront: Entrance clean and doors working\n! Cold chain: Coolers in range, logs complete'} />
          <div className="row"><button className="primary" disabled={save.busy}>Save checklist</button><button type="button" onClick={() => setT(null)}>Cancel</button><ErrorNote message={save.error} /></div>
          <p className="faint">Changing a checklist does not change visits already started: each visit keeps its own copy of the items.</p>
        </form>
      ) : <div><button onClick={() => setT({ code: '', name: '', text: '' })}>New checklist</button></div>}
    </div>
  );
}

export function VisitDetail() {
  const { id } = useParams();
  const { data: v, loading, error, reload } = useApi<any>(`/api/site-visits/${id}`);
  const assets = useApi<any[]>(v?.status === 'in_progress' ? `/api/assets?facilityId=${v.facility_id}&limit=500` : null);
  const users = useApi<any[]>(v?.status === 'in_progress' ? `/api/assignable-users?facilityId=${v.facility_id}` : null);
  const [notes, setNotes] = useState<Record<string, { note: string; assetId: string }>>({});
  const [fin, setFin] = useState({ summary: '', owner: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const record = useAction(async (itemId: string, result: string) => {
    const n = notes[itemId] ?? { note: '', assetId: '' };
    await api.post(`/api/site-visit-items/${itemId}`, { result, note: n.note || null, assetId: n.assetId || null }); setEditing(null); await reload();
  });
  const complete = useAction(async () => { await api.post(`/api/site-visits/${id}/complete`, { summary: fin.summary || null, actionOwnerUserId: fin.owner || null }); await reload(); });
  return (
    <Async loading={loading && !v} error={error}>{() => {
      const open = v.status === 'in_progress' && v.canConduct;
      const answered = v.items.filter((i: any) => i.result).length;
      return (
        <>
          <PageHead eyebrow={`${v.facility_code} · ${v.number} · ${fmtDate(v.visited_on)} · ${v.visited_by_name}`} title={v.title}
            actions={v.status === 'completed' ? <Pill tone={v.critical_fails ? 'bad' : v.score >= 0.85 ? 'good' : 'watch'} label={`${fmtPct(v.score)}${v.critical_fails ? ` · ${v.critical_fails} critical` : ''}`} /> : <Pill tone="info" label={`${answered} of ${v.items.length} answered`} />} />
          {v.previous && <p className="muted">Previous visit {v.previous.number} on {fmtDate(v.previous.visited_on)}: {fmtPct(v.previous.score)}.</p>}
          <section className="card stack">
            {v.items.map((i: any) => (
              <div key={i.id} className="stack" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
                <div className="spread">
                  <span>{i.area && <span className="faint">{i.area} · </span>}<strong>{i.text}</strong>{i.critical && <> <Pill tone="bad" label="critical" /></>}{i.repeat && <> <Pill tone="watch" label="failed last time too" /></>}</span>
                  <span className="row">{i.result && <Pill tone={i.result === 'pass' ? 'good' : i.result === 'fail' ? 'bad' : 'neutral'} label={i.result === 'na' ? 'n/a' : i.result} />}
                    {open && i.result && editing !== i.id && <button className="link" onClick={() => setEditing(i.id)}>change</button>}</span>
                </div>
                {i.note && <div className="muted">{i.note}{i.asset_name ? ` (${i.asset_name})` : ''}{i.work_order_id ? <> · <Link to={`/work-orders/${i.work_order_id}`}>work order</Link></> : i.request_id ? ' · maintenance request raised' : ''}{i.action_status ? ` · fix ${i.action_status}` : ''}</div>}
                {open && (!i.result || editing === i.id) && (
                  <div className="row visit-answer">
                    <button disabled={record.busy} onClick={() => record.run(i.id, 'pass')}>Pass</button>
                    <input aria-label={`What is wrong: ${i.text}`} placeholder="If it fails: what is wrong" value={notes[i.id]?.note ?? ''} onChange={(e) => setNotes({ ...notes, [i.id]: { note: e.target.value, assetId: notes[i.id]?.assetId ?? '' } })} style={{ flex: '1 1 220px' }} />
                    <select aria-label={`Equipment for ${i.text}`} value={notes[i.id]?.assetId ?? ''} onChange={(e) => setNotes({ ...notes, [i.id]: { note: notes[i.id]?.note ?? '', assetId: e.target.value } })} style={{ width: 'auto' }}>
                      <option value="">Not equipment (an action)</option>{(assets.data ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.asset_tag} {a.name}</option>)}
                    </select>
                    <button disabled={record.busy} onClick={() => record.run(i.id, 'fail')}>Fail</button>
                    <button className="link" disabled={record.busy} onClick={() => record.run(i.id, 'na')}>n/a</button>
                  </div>
                )}
              </div>
            ))}
            <ErrorNote message={record.error} />
          </section>
          {open && (
            <form className="card row" onSubmit={(e) => { e.preventDefault(); void complete.run(); }}>
              <input id="visit-summary" aria-label="Summary" placeholder="Summary for the store" value={fin.summary} onChange={(e) => setFin({ ...fin, summary: e.target.value })} style={{ flex: '1 1 260px' }} />
              <select id="visit-owner" aria-label="Who fixes non-maintenance items" value={fin.owner} onChange={(e) => setFin({ ...fin, owner: e.target.value })} style={{ width: 'auto' }}>
                <option value="">Who fixes the rest…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
              <button className="primary" disabled={complete.busy}>Complete visit</button><ErrorNote message={complete.error} />
            </form>
          )}
          {v.summary && <p>{v.summary}</p>}
        </>
      );
    }}</Async>
  );
}
