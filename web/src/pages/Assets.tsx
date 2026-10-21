import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../format';
import { DueState, intervalText, nextDueText } from './Pm';
import { useAction, useApi } from '../hooks';

export function Assets() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const params = new URLSearchParams({ ...(q ? { q } : {}), ...(state ? { state } : {}) });
  const { data, loading, error } = useApi<any[]>(`/api/assets?${params}`);
  return (
    <>
      <PageHead eyebrow="Assets" title="Equipment register" sub="Search by tag, name, model or serial number." />
      <div className="card stack">
        <div className="form-grid">
          <label className="field">Search<input id="asset-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. HMC-201, Haas, 1145872" /></label>
          <label className="field">Current state
            <select id="asset-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Any</option>
              {['running', 'available', 'idle', 'planned_downtime', 'unplanned_downtime', 'out_of_service'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </label>
        </div>
        <Async loading={loading} error={error}>{() => (
          <Table rows={data ?? []} onRow={(a) => nav(`/assets/${a.id}`)} empty="No assets match."
            columns={[
              { key: 'facility_code', label: 'Site' }, { key: 'asset_tag', label: 'Tag', render: (a) => <strong>{a.asset_tag}</strong> },
              { key: 'name', label: 'Name' }, { key: 'location_name', label: 'Location' },
              { key: 'criticality', label: 'Criticality', render: (a) => <Pill value={a.criticality} /> },
              { key: 'operational_state', label: 'State', render: (a) => <Pill value={a.operational_state} /> },
              { key: 'open_work_orders', label: 'Open WOs', numeric: true },
            ]} />
        )}</Async>
      </div>
    </>
  );
}

/** QR codes on equipment point at /a/<token>; resolve and show the asset page. */
export function AssetByQr() {
  const { token } = useParams();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.get(`/api/assets/qr/${token}`).then((a) => nav(`/assets/${a.id}`, { replace: true })).catch((e) => setErr(e.message)); }, [token, nav]);
  return err ? <ErrorNote message={err} /> : <div className="empty">Opening asset…</div>;
}

export function AssetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: a, loading, error, reload } = useApi<any>(`/api/assets/${id}`);
  return (
    <Async loading={loading && !a} error={error}>{() => (
      <>
        <PageHead eyebrow={`${a.facility_code} · ${a.locationPath.map((l: any) => l.name).join(' › ') || 'No location'}`}
          title={<>{a.asset_tag} <span className="muted" style={{ fontWeight: 400 }}>{a.name}</span></>}
          actions={<Pill value={a.operational_state} />} />
        {a.openChanges?.length > 0 && (
          <div className="notice warn">
            {a.openChanges.length === 1 ? 'A change affects this asset: ' : `${a.openChanges.length} changes affect this asset: `}
            {a.openChanges.map((c: any, i: number) => <span key={c.id}>{i > 0 && ', '}<Link to={`/changes/${c.id}`}>{c.number}</Link> {c.title}{c.is_temporary ? ` (temporary until ${c.temporary_until})` : ''}</span>)}
          </div>
        )}
        <div className="grid two">
          <section className="card">
            <h2>Details</h2>
            <dl className="facts">
              <dt>Class</dt><dd>{humanize(a.asset_class)}</dd>
              <dt>Manufacturer</dt><dd>{a.manufacturer ?? '—'} {a.model ?? ''}</dd>
              <dt>Serial</dt><dd className="mono">{a.serial_number ?? '—'}</dd>
              <dt>Criticality</dt><dd><Pill value={a.criticality} /></dd>
              <dt>In service since</dt><dd>{fmtDate(a.commissioned_on)}</dd>
              <dt>Current state</dt><dd>{humanize(a.currentState?.state ?? a.operational_state)}{a.currentState ? ` since ${fmtDateTime(a.currentState.started_at)}` : ''}</dd>
              {Object.entries(a.custom_fields ?? {}).map(([k, v]) => <Fragment key={k}><dt>{humanize(k)}</dt><dd>{String(v)}</dd></Fragment>)}
            </dl>
            {can('assets.record_state', a.facility_id) && <StateButtons assetId={a.id} current={a.operational_state} onDone={reload} />}
          </section>
          {can('work_orders.request', a.facility_id) && <RequestForm assetId={a.id} onDone={reload} />}
        </div>
        <section className="card">
          <h2>Technical documents</h2>
          <Table rows={a.documents} empty="No approved documents linked to this asset."
            columns={[{ key: 'doc_number', label: 'Number' }, { key: 'title', label: 'Title' }, { key: 'doc_type', label: 'Type', render: (d) => humanize(d.doc_type) },
              { key: 'current_version_label', label: 'Version' },
              { key: 'open', label: '', render: (d) => d.current_version_id
                ? <button onClick={() => api.download(`/api/document-versions/${d.current_version_id}/download`, d.doc_number)}>Open</button> : <span className="faint">No approved version</span> }]} />
        </section>
        {can('work_orders.view', a.facility_id) && <AssetPm assetId={a.id} facilityId={a.facility_id} />}
        <div className="grid two">
          <section className="card">
            <h2>Open work orders</h2>
            <Table rows={a.openWorkOrders} empty="No open work orders." onRow={(w) => nav(`/work-orders/${w.id}`)}
              columns={[{ key: 'number', label: 'WO', render: (w) => <Link to={`/work-orders/${w.id}`}>{w.number}</Link> }, { key: 'title', label: 'Title' },
                { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> }]} />
          </section>
          <section className="card">
            <h2>Components</h2>
            <Table rows={a.components} empty="No components recorded."
              columns={[{ key: 'asset_tag', label: 'Tag', render: (c) => <Link to={`/assets/${c.id}`}>{c.asset_tag}</Link> }, { key: 'name', label: 'Name' },
                { key: 'operational_state', label: 'State', render: (c) => <Pill value={c.operational_state} /> }]} />
          </section>
        </div>
      </>
    )}</Async>
  );
}

function StateButtons({ assetId, current, onDone }: { assetId: string; current: string; onDone: () => void }) {
  const act = useAction(async (state: string) => { await api.post(`/api/assets/${assetId}/state`, { state }); onDone(); });
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="row">
        {[['running', 'Running'], ['idle', 'Idle'], ['unplanned_downtime', 'Down (unplanned)'], ['planned_downtime', 'Planned stop']].map(([s, l]) => (
          <button key={s} disabled={act.busy || current === s} onClick={() => act.run(s!)}>{l}</button>
        ))}
      </div>
      <ErrorNote message={act.error} />
    </div>
  );
}

function RequestForm({ assetId, onDone }: { assetId: string; onDone: () => void }) {
  const [symptom, setSymptom] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [down, setDown] = useState(false);
  const [sent, setSent] = useState(false);
  const act = useAction(async () => {
    await api.post('/api/maintenance-requests', { assetId, symptom, severity, assetDown: down });
    setSymptom(''); setDown(false); setSent(true); onDone();
  });
  return (
    <section className="card">
      <h2>Report a problem</h2>
      <form className="form" onSubmit={(e) => { e.preventDefault(); setSent(false); void act.run(); }}>
        <label className="field">What is wrong?<textarea id="req-symptom" value={symptom} onChange={(e) => setSymptom(e.target.value)} required minLength={3} placeholder="e.g. Spindle noise above 6k rpm" /></label>
        <div className="form-grid">
          <label className="field">Severity
            <select id="req-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {['low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </label>
          <label className="row" style={{ alignSelf: 'end' }}><input id="req-down" type="checkbox" checked={down} onChange={(e) => setDown(e.target.checked)} /> Machine is down</label>
        </div>
        <ErrorNote message={act.error} />
        {sent && <div className="notice ok">Request sent to maintenance.</div>}
        <div><button className="primary" disabled={act.busy}>Send request</button></div>
      </form>
    </section>
  );
}

function AssetPm({ assetId, facilityId }: { assetId: string; facilityId: string }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const plans = useApi<any[]>(`/api/pm?assetId=${assetId}`);
  const meters = [...new Set((plans.data ?? []).filter((p) => p.trigger_type === 'meter').map((p) => p.meter as string))];
  const [meter, setMeter] = useState('');
  const [value, setValue] = useState('');
  const [ok, setOk] = useState(false);
  const act = useAction(async () => { await api.post(`/api/assets/${assetId}/meters`, { meter: meter || meters[0] || 'run_hours', value: Number(value) }); setValue(''); setOk(true); await plans.reload(); });
  return (
    <section className="card stack">
      <h2>Preventive maintenance</h2>
      <Async loading={plans.loading && !plans.data} error={plans.error}>{() => (
        <Table rows={plans.data ?? []} onRow={(p) => nav(`/pm/${p.id}`)} empty="No PM plans for this asset."
          columns={[{ key: 'code', label: 'Plan' }, { key: 'title', label: 'Title' }, { key: 'interval', label: 'Interval', render: intervalText },
            { key: 'next', label: 'Next due', render: nextDueText }, { key: 'due_state', label: 'State', render: (p) => <DueState v={p.due_state} /> }]} />
      )}</Async>
      {can('assets.record_state', facilityId) && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); setOk(false); void act.run(); }}>
          <input id="meter-name" list="meter-names" value={meter} onChange={(e) => setMeter(e.target.value)} placeholder={meters[0] ?? 'run_hours'} aria-label="Meter" style={{ width: 140 }} />
          <datalist id="meter-names">{meters.map((m) => <option key={m} value={m} />)}</datalist>
          <input id="meter-value" type="number" min="0" step="any" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Reading" aria-label="Meter reading" style={{ width: 120 }} required />
          <button disabled={act.busy || !value}>Record meter reading</button>
          {ok && <span className="muted">Saved{(() => { const p = (plans.data ?? []).find((x) => x.trigger_type === 'meter'); return p ? `. ${p.code}: ${fmtNum(p.meter_remaining, 0)} to go.` : '.'; })()}</span>}
          <ErrorNote message={act.error} />
        </form>
      )}
    </section>
  );
}
