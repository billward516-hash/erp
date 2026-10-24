import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ReportChart } from '../components/ReportChart';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

/**
 * Cleanroom environmental monitoring (SC-007 A, D-184A): rooms with an ISO 14644-1 class, monitoring points with their limits, readings,
 * excursions and the trend chart. The default particle limits are generated from the standard's formula and shown here so the company can
 * check them against its own copy of the standard; the platform does not certify them.
 */
const PARTICLES = ['p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1', 'p5'];
const LABEL: Record<string, string> = { p0_1: '0.1 µm', p0_2: '0.2 µm', p0_3: '0.3 µm', p0_5: '0.5 µm', p1: '1 µm', p5: '5 µm', dp: 'Differential pressure', temp: 'Temperature', rh: 'Relative humidity' };
const UNIT: Record<string, string> = { p0_1: '/m³', p0_2: '/m³', p0_3: '/m³', p0_5: '/m³', p1: '/m³', p5: '/m³', dp: 'Pa', temp: '°C', rh: '%RH' };
const COLUMN: Record<string, string> = { p0_1: 'p0_1', p0_2: 'p0_2', p0_3: 'p0_3', p0_5: 'p0_5', p1: 'p1', p5: 'p5', dp: 'dp_pa', temp: 'temp_c', rh: 'rh_pct' };
const ORDER = [...PARTICLES, 'dp', 'temp', 'rh'];
const TONE: Record<string, 'good' | 'watch' | 'bad' | 'neutral'> = { ok: 'good', alert: 'watch', action: 'bad', overdue: 'watch', 'no readings': 'neutral' };
const STATE_LABEL: Record<string, string> = { ok: 'ok', alert: 'over alert limit', action: 'over action limit', overdue: 'sampling overdue', 'no readings': 'no readings' };
const occ = (o: string) => (o === 'at_rest' ? 'at rest' : 'operational');
const fmtV = (v: number | null | undefined, c: string) => (v == null ? '—' : `${Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : fmtNum(v, 2)} ${UNIT[c]}`);

export const StandardNote = () => (
  <p className="muted">
    Default particle limits are generated from the ISO 14644-1 class formula (Cn = 10<sup>N</sup> × (0.1 / D)<sup>2.08</sup> particles per m³, rounded as in the standard&rsquo;s table).
    They are not certified: confirm them against your own copy of the standard before relying on them. Sizes the standard gives no limit for in a class are not limited unless a point sets its own.
  </p>
);

export function Cleanrooms() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, loading, error, reload } = useApi<any[]>('/api/cleanrooms');
  const [adding, setAdding] = useState(false);
  const rooms = data ?? [];
  return (
    <>
      <PageHead eyebrow="Quality & safety" title="Cleanrooms" sub="Particle counts, pressure, temperature and humidity against each room’s class limits. A reading over an action limit raises a nonconformance; sampling that falls behind shows on What is late."
        actions={<>
          <Link className="btn" to="/reports/cleanroom-monitoring">Monitoring report</Link>
          {can('imports.run') && can('cleanroom.record') && <Link className="btn" to="/imports?target=cleanroom_readings">Import counter file</Link>}
          {can('cleanroom.manage') && !adding && <button className="primary" onClick={() => setAdding(true)}>New room</button>}
        </>} />
      <StandardNote />
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <Kpis items={[{ label: 'Rooms', value: rooms.length },
            { label: 'Open excursions', value: rooms.reduce((s, r) => s + r.open_excursions, 0), tone: rooms.some((r) => r.open_excursions) ? 'bad' : 'good' },
            { label: 'Sampling overdue', value: rooms.reduce((s, r) => s + r.overdue_points, 0), tone: rooms.some((r) => r.overdue_points) ? 'watch' : 'good', note: 'points' },
            { label: 'Trends', value: rooms.reduce((s, r) => s + r.trend_points, 0), tone: rooms.some((r) => r.trend_points) ? 'watch' : 'good', note: 'points' }]} />
          {adding && <RoomForm onDone={(id) => { setAdding(false); if (id) nav(`/cleanrooms/${id}`); else void reload(); }} />}
          <div className="card stack">
            <Table rows={rooms} rowKey={(r) => r.id} onRow={(r) => nav(`/cleanrooms/${r.id}`)} exception={(r) => r.state === 'action'}
              empty={can('cleanroom.manage') ? 'No cleanrooms yet. Use New room to add the first one, then add its monitoring points.' : 'No cleanrooms at the sites you can see.'}
              columns={[{ key: 'code', label: 'Room', render: (r) => <><Link to={`/cleanrooms/${r.id}`}><strong>{r.code}</strong></Link> <span className="faint">{r.name}</span></> },
                { key: 'facility_code', label: 'Site' },
                { key: 'iso_class', label: 'Class', render: (r) => `ISO ${r.iso_class}`, value: (r) => r.iso_class },
                { key: 'occupancy', label: 'State', render: (r) => occ(r.occupancy) },
                { key: 'points', label: 'Points', numeric: true },
                { key: 'owner_name', label: 'Owner' },
                { key: 'state', label: 'Status', render: (r) => <><Pill tone={TONE[r.state]} label={STATE_LABEL[r.state] ?? r.state} />{r.trend_points > 0 && <> <Pill tone="watch" label="trend" /></>}</> }]} />
          </div>
        </>
      )}</Async>
    </>
  );
}

function RoomForm({ room, onDone }: { room?: any; onDone: (id?: string) => void }) {
  const { can } = useAuth();
  const sites = useApi<any[]>(room ? null : '/api/sites');
  const [f, setF] = useState({ facilityId: room?.facility_id ?? '', code: room?.code ?? '', name: room?.name ?? '', isoClass: String(room?.iso_class ?? 7), occupancy: room?.occupancy ?? 'operational',
    ownerUserId: room?.owner_user_id ?? '', alertPct: String(room?.alert_pct ?? 80), trendCount: String(room?.trend_count ?? 3), active: room?.active ?? true });
  const users = useApi<any[]>(f.facilityId ? `/api/assignable-users?facilityId=${f.facilityId}` : null);
  const save = useAction(async () => {
    const body = { code: f.code, name: f.name, isoClass: Number(f.isoClass), occupancy: f.occupancy, ownerUserId: f.ownerUserId, alertPct: Number(f.alertPct), trendCount: Number(f.trendCount), active: f.active };
    if (room) { await api.put(`/api/cleanrooms/${room.id}`, body); onDone(); } else { const r = await api.post('/api/cleanrooms', { ...body, facilityId: f.facilityId }); onDone(r.id); }
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label={room ? 'Edit room' : 'New room'}>
      <div className="row">
        {!room && <label className="field">Site<select value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, ownerUserId: '' })} required>
          <option value="">Choose…</option>{(sites.data ?? []).filter((s) => can('cleanroom.manage', s.id)).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></label>}
        <label className="field">Room code<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required maxLength={40} style={{ width: 120 }} /></label>
        <label className="field">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={200} /></label>
        <label className="field">ISO class (14644-1)<select value={f.isoClass} onChange={(e) => setF({ ...f, isoClass: e.target.value })}>{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>ISO {n}</option>)}</select></label>
        <label className="field">Monitored<select value={f.occupancy} onChange={(e) => setF({ ...f, occupancy: e.target.value })}><option value="operational">Operational</option><option value="at_rest">At rest</option></select></label>
        <label className="field">Owner (told of alerts)<select value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} required disabled={!f.facilityId}>
          <option value="">Choose…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
      </div>
      <div className="row">
        <label className="field">Alert limit, % of action limit<input type="number" min={10} max={99} value={f.alertPct} onChange={(e) => setF({ ...f, alertPct: e.target.value })} style={{ width: 110 }} /></label>
        <label className="field">Trend after this many alerts in a row<input type="number" min={2} max={20} value={f.trendCount} onChange={(e) => setF({ ...f, trendCount: e.target.value })} style={{ width: 110 }} /></label>
        {room && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Monitored (untick to retire the room)</label>}
      </div>
      <div className="row"><button className="primary" disabled={save.busy}>{room ? 'Save room' : 'Create room'}</button><button type="button" onClick={() => onDone()}>Cancel</button><ErrorNote message={save.error} /></div>
    </form>
  );
}

export function CleanroomDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [days, setDays] = useState('14');
  const { data: room, loading, error, reload } = useApi<any>(`/api/cleanrooms/${id}?days=${days}`);
  const [editing, setEditing] = useState(false);
  const [pointForm, setPointForm] = useState<any | null>(null);
  return (
    <Async loading={loading && !room} error={error}>{() => {
      const points: any[] = room.points;
      return (
        <>
          <PageHead eyebrow={`${room.facility_code} · ISO ${room.iso_class} · ${occ(room.occupancy)} · owner ${room.owner_name}`} title={<>{room.code} {room.name}</>}
            sub={<><Link to="/cleanrooms">All cleanrooms</Link> · <Link to={`/reports/cleanroom-monitoring?roomId=${room.id}&facilityId=${room.facility_id}`}>Monitoring report for this room</Link>{!room.active ? ' · retired' : ''}</>}
            actions={<>
              <Pill tone={TONE[room.state]} label={STATE_LABEL[room.state] ?? room.state} />
              {room.can_manage && !editing && <button onClick={() => setEditing(true)}>Edit room</button>}
              {room.can_manage && !pointForm && <button onClick={() => setPointForm({ label: '', channels: ['p0_5', 'p5'], intervalHours: '24', active: true })}>Add point</button>}
            </>} />
          {editing && <RoomForm room={room} onDone={() => { setEditing(false); void reload(); }} />}
          {pointForm && <PointForm roomId={room.id} point={pointForm} onDone={() => { setPointForm(null); void reload(); }} />}
          <Kpis items={[{ label: 'Points', value: points.filter((p) => p.active).length },
            { label: 'Open excursions', value: points.filter((p) => p.excursion_id).length, tone: points.some((p) => p.excursion_id) ? 'bad' : 'good' },
            { label: 'Sampling overdue', value: points.filter((p) => p.overdue).length, tone: points.some((p) => p.overdue) ? 'watch' : 'good' },
            { label: 'Trends', value: points.filter((p) => p.trend).length, tone: points.some((p) => p.trend) ? 'watch' : 'good', note: `${room.trend_count} alerts in a row` }]} />
          {points.map((p) => <PointCard key={p.id} room={room} point={p} reload={reload} onEdit={() => setPointForm({ id: p.id, label: p.label, channels: p.channels, intervalHours: String(p.interval_hours), active: p.active })} />)}
          {!points.length && <div className="card"><p className="muted">No monitoring points yet.{room.can_manage ? ' Use Add point to say where in the room readings are taken, what is measured there and how often.' : ''}</p></div>}
          <Trend room={room} days={days} setDays={setDays} />
          <section className="card stack">
            <h2>Excursions</h2>
            <p className="muted">An excursion starts with the first reading over an action limit at a point and ends with the first reading back under it. Each raises one nonconformance in Quality, however many readings are over the limit.</p>
            <Table rows={room.excursions} rowKey={(e) => e.id} empty="No excursions."
              exception={(e) => !e.ended_at}
              columns={[{ key: 'point', label: 'Point' }, { key: 'started_at', label: 'Started', render: (e) => fmtDateTime(e.started_at) },
                { key: 'ended_at', label: 'Ended', render: (e) => (e.ended_at ? fmtDateTime(e.ended_at) : <Pill tone="bad" label="open" />) },
                { key: 'readings', label: 'Readings', numeric: true },
                { key: 'channels', label: 'Over action limit', render: (e) => e.channels.map((c: string) => `${LABEL[c]} ${fmtV(e.peak?.[c]?.value, c)} (limit ${fmtV(e.peak?.[c]?.limit, c)})`).join('; '), plain: true },
                { key: 'ncr', label: 'Nonconformance', render: (e) => (e.nonconformance_id && can('quality.view') ? <Link to={`/quality/ncr/${e.nonconformance_id}`}>{e.ncr_number}</Link> : e.ncr_number ?? '—') }]} />
          </section>
          <section className="card stack">
            <h2>Recent readings</h2>
            <p className="muted">Particle counts are per m³.</p>
            <Table rows={room.readings.slice(0, 40)} rowKey={(r) => r.id} empty={`No readings in the last ${days} days.`} exception={(r) => r.status !== 'ok'}
              columns={[{ key: 'read_at', label: 'Read', render: (r) => fmtDateTime(r.read_at), value: (r) => r.read_at },
                { key: 'point', label: 'Point', render: (r) => points.find((p) => p.id === r.point_id)?.label ?? '' },
                ...ORDER.filter((c) => points.some((p) => p.channels.includes(c))).map((c) => ({ key: c, label: PARTICLES.includes(c) ? LABEL[c]! : ({ dp: 'ΔP (Pa)', temp: '°C', rh: '%RH' } as Record<string, string>)[c]!, numeric: true, render: (r: any) => fmtV(r[COLUMN[c]!], c).replace(` ${UNIT[c]}`, ''), value: (r: any) => r[COLUMN[c]!] })),
                { key: 'status', label: 'Status', render: (r) => <Pill tone={TONE[r.status]} label={STATE_LABEL[r.status]} /> },
                { key: 'note', label: 'Note / by', render: (r) => [r.note, r.recorded_by ?? r.source].filter(Boolean).join(' · ') }]} />
          </section>
          <section className="card stack">
            <h2>ISO {room.iso_class} default particle limits</h2>
            <StandardNote />
            <Table rows={room.class_limits} rowKey={(l) => l.channel} tools={false}
              columns={[{ key: 'label', label: 'Particle size (and larger)' }, { key: 'limit', label: 'Action limit per m³', numeric: true, render: (l) => (l.limit == null ? 'no limit in this class' : l.limit.toLocaleString()) },
                { key: 'alert', label: `Alert limit (${room.alert_pct}%)`, numeric: true, render: (l) => (l.limit == null ? '—' : (l.limit * room.alert_pct / 100).toLocaleString(undefined, { maximumFractionDigits: 1 })) }]} />
          </section>
        </>
      );
    }}</Async>
  );
}

function PointForm({ roomId, point, onDone }: { roomId: string; point: any; onDone: () => void }) {
  const [f, setF] = useState(point);
  const save = useAction(async () => {
    const body = { id: f.id, label: f.label, channels: ORDER.filter((c) => f.channels.includes(c)), intervalHours: Number(f.intervalHours), active: f.active };
    if (f.id) await api.put(`/api/cleanrooms/${roomId}/points`, body); else await api.post(`/api/cleanrooms/${roomId}/points`, body);
    onDone();
  });
  const toggle = (c: string) => setF({ ...f, channels: f.channels.includes(c) ? f.channels.filter((x: string) => x !== c) : [...f.channels, c] });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label={f.id ? 'Edit monitoring point' : 'New monitoring point'}>
      <div className="row">
        <label className="field">Where in the room<input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required maxLength={200} placeholder="e.g. P1 Fill line" /></label>
        <label className="field">Sample every (hours)<input type="number" min={1} value={f.intervalHours} onChange={(e) => setF({ ...f, intervalHours: e.target.value })} required style={{ width: 110 }} /></label>
        {f.id && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Monitored</label>}
      </div>
      <fieldset className="row"><legend>What is measured here</legend>
        {ORDER.map((c) => <label key={c} className="row"><input type="checkbox" checked={f.channels.includes(c)} onChange={() => toggle(c)} /> {LABEL[c]}</label>)}
      </fieldset>
      <div className="row"><button className="primary" disabled={save.busy}>Save point</button><button type="button" onClick={onDone}>Cancel</button><ErrorNote message={save.error} /></div>
    </form>
  );
}

function PointCard({ room, point: p, reload, onEdit }: { room: any; point: any; reload: () => Promise<void>; onEdit: () => void }) {
  const [limits, setLimits] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [state, setState] = useState(room.occupancy);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const channels = ORDER.filter((c) => p.channels.includes(c));
  const record = useAction(async () => {
    const values = Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
    const r = await api.post(`/api/cleanrooms/points/${p.id}/readings`, { values, note: note || null, readAt: when ? new Date(when).toISOString() : undefined, occupancy: state });
    setMsg(r.excursion?.opened ? { text: 'Over an action limit: an excursion is open and a nonconformance has been raised.', bad: true }
      : r.status === 'action' ? { text: 'Still over an action limit; recorded on the open excursion.', bad: true }
        : r.status === 'alert' ? { text: `Over an alert limit: the room owner has been told.${r.trend ? ' This is a trend.' : ''}` , bad: true }
          : r.excursion?.closed ? { text: 'Back under the action limit; the excursion is closed.', bad: false } : { text: 'Recorded.', bad: false });
    setVals({}); setNote(''); setWhen(''); await reload();
  });
  const lim = (c: string) => p.limits[c];
  return (
    <section className="card stack" aria-label={`Point ${p.label}`}>
      <div className="spread">
        <h2>{p.label}</h2>
        <span className="row">
          {!p.active && <Pill tone="neutral" label="not monitored" />}
          {p.excursion_id ? <Pill tone="bad" label={`over action limit since ${fmtDateTime(p.excursion_started_at)}`} /> : p.last_status === 'alert' ? <Pill tone="watch" label="over alert limit" /> : p.last_status ? <Pill tone="good" label="within limits" /> : <Pill tone="neutral" label="no readings" />}
          {p.overdue && p.active && <Pill tone="watch" label={`sampling overdue ${p.hours_overdue} h`} />}
          {p.trend && <Pill tone="watch" label={`trend: ${p.run} in a row`} />}
        </span>
      </div>
      <p className="muted">Sampled every {p.interval_hours} h · last reading {p.last_read_at ? fmtDateTime(p.last_read_at) : 'none'}
        {p.ncr_number && <> · open excursion raised <strong>{p.ncr_number}</strong></>}</p>
      <Table rows={channels.map((c) => ({ c }))} rowKey={(x) => x.c} tools={false} empty="" columns={[
        { key: 'c', label: 'Measure', render: (x) => LABEL[x.c] },
        { key: 'a', label: 'Alert limit', render: (x) => limitText(lim(x.c), 'alert', x.c) },
        { key: 'x', label: 'Action limit', render: (x) => limitText(lim(x.c), 'action', x.c) },
        { key: 's', label: 'Source', render: (x) => (lim(x.c).source === 'class' ? `ISO ${room.iso_class} default` : lim(x.c).source === 'point' ? 'this point' : 'not limited') }]} />
      {p.active && room.can_record && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void record.run(); }} aria-label={`Record a reading at ${p.label}`}>
          <div className="row">
            {channels.map((c) => <label key={c} className="field">{LABEL[c]} ({UNIT[c]})<input type="number" step="any" min={PARTICLES.includes(c) || c === 'rh' ? 0 : undefined} max={c === 'rh' ? 100 : undefined} value={vals[c] ?? ''} onChange={(e) => setVals({ ...vals, [c]: e.target.value })} style={{ width: PARTICLES.includes(c) ? 120 : 100 }} /></label>)}
          </div>
          <div className="row">
            <label className="field">Room was<select value={state} onChange={(e) => setState(e.target.value)}><option value="operational">operational</option><option value="at_rest">at rest</option></select></label>
            <label className="field">Read at (blank = now)<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
            <label className="field" style={{ flex: '1 1 220px' }}>Note<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
            <button className="primary" disabled={record.busy || !Object.values(vals).some((v) => v !== '')}>Record reading</button>
          </div>
          {msg && <div className={msg.bad ? 'bad-text' : 'muted'} role="status">{msg.text}</div>}<ErrorNote message={record.error} />
        </form>
      )}
      {room.can_manage && (
        <div className="row">
          <button type="button" onClick={onEdit}>Edit point</button>
          <button type="button" aria-expanded={limits} onClick={() => setLimits(!limits)}>{limits ? 'Hide limits' : 'Set limits for this point'}</button>
        </div>
      )}
      {limits && <LimitsEditor point={p} onDone={() => { setLimits(false); void reload(); }} />}
    </section>
  );
}

function limitText(l: any, level: 'alert' | 'action', c: string) {
  const hi = level === 'alert' ? l.alertHigh : l.actionHigh; const lo = level === 'alert' ? l.alertLow : l.actionLow;
  if (hi == null && lo == null) return <span className="faint">none</span>;
  return [lo != null ? `below ${fmtV(lo, c)}` : null, hi != null ? `above ${fmtV(hi, c)}` : null].filter(Boolean).join(', ');
}

function LimitsEditor({ point: p, onDone }: { point: any; onDone: () => void }) {
  const channels = ORDER.filter((c) => p.channels.includes(c));
  const start = () => Object.fromEntries(channels.map((c) => { const o = p.overrides?.[c] ?? {}; return [c, { alertLow: o.alertLow ?? '', alertHigh: o.alertHigh ?? '', actionLow: o.actionLow ?? '', actionHigh: o.actionHigh ?? '' }]; }));
  const [f, setF] = useState<Record<string, Record<string, string | number>>>(start);
  const save = useAction(async () => {
    const limits = Object.fromEntries(channels.map((c) => {
      const v = f[c]!; const n = (x: string | number) => (x === '' ? null : Number(x));
      const all = { alertLow: n(v.alertLow!), alertHigh: n(v.alertHigh!), actionLow: n(v.actionLow!), actionHigh: n(v.actionHigh!) };
      return [c, Object.values(all).every((x) => x == null) ? null : all];
    }));
    await api.put(`/api/cleanrooms/points/${p.id}/limits`, { limits });
    onDone();
  });
  const set = (c: string, k: string, v: string) => setF({ ...f, [c]: { ...f[c]!, [k]: v } });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label={`Limits for ${p.label}`}>
      <p className="muted">Leave a box empty to keep the default. Particle counts have an upper limit only; pressure, temperature and humidity are limited only by the range you set here. Clear every box in a row to go back to the default.</p>
      <div className="table-wrap"><table><thead><tr><th scope="col">Measure</th><th scope="col">Alert below</th><th scope="col">Alert above</th><th scope="col">Action below</th><th scope="col">Action above</th></tr></thead>
        <tbody>{channels.map((c) => (
          <tr key={c}><th scope="row">{LABEL[c]} ({UNIT[c]})</th>
            {(['alertLow', 'alertHigh', 'actionLow', 'actionHigh'] as const).map((k) => {
              const particle = PARTICLES.includes(c);
              const eff = p.limits[c]?.[k];
              return <td key={k}>{particle && (k === 'alertLow' || k === 'actionLow') ? <span className="faint">—</span>
                : <input type="number" step="any" aria-label={`${LABEL[c]} ${k.startsWith('alert') ? 'alert' : 'action'} ${k.endsWith('Low') ? 'below' : 'above'}`} value={f[c]![k]} placeholder={eff != null && f[c]![k] === '' ? String(eff) : ''} onChange={(e) => set(c, k, e.target.value)} style={{ width: 110 }} />}</td>;
            })}</tr>))}</tbody></table></div>
      <div className="row"><button className="primary" disabled={save.busy}>Save limits</button><button type="button" onClick={onDone}>Cancel</button><ErrorNote message={save.error} /></div>
    </form>
  );
}

function Trend({ room, days, setDays }: { room: any; days: string; setDays: (d: string) => void }) {
  const points: any[] = room.points;
  const [pid, setPid] = useState('');
  const point = points.find((p) => p.id === pid) ?? points[0];
  const [ch, setCh] = useState('');
  if (!point) return null;
  const channels = ORDER.filter((c) => point.channels.includes(c));
  const channel = channels.includes(ch) ? ch : channels.find((c) => PARTICLES.includes(c)) ?? channels[0]!;
  const rows = [...room.readings].filter((r: any) => r.point_id === point.id && r[COLUMN[channel]!] != null).reverse();
  const l = point.limits[channel];
  const spec = {
    kind: 'line' as const, title: `${LABEL[channel]} at ${point.label}, last ${days} days`, category: { key: 't', label: 'Read at' }, series: [{ key: 'v', label: `${LABEL[channel]} (${UNIT[channel]})` }],
    valueType: 'number', unit: UNIT[channel], data: rows.map((r: any) => ({ t: fmtDateTime(r.read_at), v: r[COLUMN[channel]!] })),
    reference: l?.actionHigh != null ? { value: l.actionHigh, label: 'Action limit' } : undefined,
  };
  return (
    <section className="card stack">
      <div className="spread"><h2>Trend</h2>
        <span className="row">
          <label className="row">Point <select aria-label="Trend point" value={point.id} onChange={(e) => { setPid(e.target.value); setCh(''); }}>{points.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
          <label className="row">Measure <select aria-label="Trend measure" value={channel} onChange={(e) => setCh(e.target.value)}>{channels.map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}</select></label>
          <label className="row">Period <select aria-label="Trend period" value={days} onChange={(e) => setDays(e.target.value)}>{['7', '14', '30', '90', '365'].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
        </span>
      </div>
      {rows.length < 2 ? <p className="muted">Not enough readings in this period to draw a trend.</p> : <ReportChart spec={spec} />}
      <p className="muted">{l?.actionHigh != null ? `The dashed line is the action limit (${fmtV(l.actionHigh, channel)}); the alert limit is ${fmtV(l.alertHigh, channel)}.` : 'This measure has no action limit; set a range under Set limits for this point.'}{' '}
        {humanize(room.occupancy) === 'Operational' ? 'Room monitored in the operational state.' : 'Room monitored at rest.'}</p>
    </section>
  );
}
