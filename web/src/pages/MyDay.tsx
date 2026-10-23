import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { SignaturePad } from '../components/SignaturePad';
import { Async, ErrorNote, Pill } from '../components/ui';
import { fmtDate } from '../format';
import { useAction, useApi } from '../hooks';

const today = () => new Date().toISOString().slice(0, 10);
type Result = 'ok' | 'issue' | 'na';

/** The technician's day on a tablet: the route with times and access notes, then the service report for the visit in hand. */
export function MyDay() {
  const [date, setDate] = useState(today());
  const { data, loading, error, reload } = useApi<any>(`/api/service-my-day?date=${date}`);
  const [open, setOpen] = useState<string | null>(null);
  const start = useAction(async (id: string) => { await api.post(`/api/service-visits/${id}/start`); await reload(); setOpen(id); });
  return (
    <div className="scan-station stack">
      <section className="page-head"><div><div className="eyebrow">Field service</div><h1>My day</h1><p className="sub">{fmtDate(date)}</p></div>
        <div className="row"><button onClick={() => setDate(new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10))} aria-label="Previous day">‹</button>
          <input aria-label="Day" type="date" value={date} onChange={(e) => setDate(e.target.value)} /><button onClick={() => setDate(new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10))} aria-label="Next day">›</button></div></section>
      <ErrorNote message={start.error} />
      <Async loading={loading && !data} error={error}>{() => (
        !data.technician ? <section className="card"><p className="muted">You are not set up as a technician. Ask your dispatcher.</p></section>
        : !data.stops.length ? <section className="card"><p className="muted">Nothing is scheduled for you on this day.</p></section>
        : <>{data.stops.map((s: any, i: number) => (
          <section key={s.id} className="card stack" aria-label={`Stop ${i + 1}`}>
            <div className="spread"><h2>{s.arrive} · {s.customer}</h2><Pill tone={s.status === 'completed' ? 'good' : s.status === 'in_progress' ? 'watch' : 'info'} label={s.status.replace('_', ' ')} /></div>
            <p style={{ margin: 0, fontSize: 18 }}><strong>{s.title}</strong>{s.asset_tag ? ` · ${s.asset_tag} ${s.asset_name ?? ''}` : ''}</p>
            <p className="muted" style={{ margin: 0 }}>{s.site}{s.address?.line1 ? ` · ${s.address.line1}, ${s.address.city ?? ''}` : ''} · {s.driveMinutes} min drive{s.driveEstimate ? ' (estimate)' : ''} · {s.estimated_minutes} min on site</p>
            {s.access_notes && <p className="notice warn" style={{ margin: 0 }}>Access: {s.access_notes}</p>}
            {s.model && <p className="muted" style={{ margin: 0 }}>{s.manufacturer} {s.model}{s.serial_number ? ` · serial ${s.serial_number}` : ''}</p>}
            <div className="row big">
              {['scheduled', 'dispatched'].includes(s.status) && <button className="primary" disabled={start.busy} onClick={() => start.run(s.id)}>Start the visit</button>}
              {s.status === 'in_progress' && <button className="primary" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide the report' : 'Service report'}</button>}
              {s.status === 'completed' && <Link className="btn" to={`/service/visits/${s.id}`}>View report</Link>}
            </div>
            {open === s.id && s.status === 'in_progress' && <ReportForm stop={s} onDone={async () => { setOpen(null); await reload(); }} />}
          </section>))}</>
      )}</Async>
    </div>
  );
}

function ReportForm({ stop, onDone }: { stop: any; onDone: () => Promise<void> }) {
  const items: string[] = stop.checklist ?? [];
  const draft = useApi<any>(`/api/service-visits/${stop.id}/report`);
  const [res, setRes] = useState<Record<string, { result: Result; note: string }>>({});
  const [work, setWork] = useState(''); const [findings, setFindings] = useState(''); const [hours, setHours] = useState('');
  const [readings, setReadings] = useState<{ name: string; value: string; unit: string }[]>([]);
  const [used, setUsed] = useState<{ partId: string; qty: string }[]>([]);
  const [recs, setRecs] = useState<{ description: string; urgency: string; unitPrice: string }[]>([]);
  const [present, setPresent] = useState(true); const [signed, setSigned] = useState(''); const [png, setPng] = useState<string | null>(null); const [why, setWhy] = useState('');
  const [resolved, setResolved] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const stock = useApi<any[]>('/api/parts');
  const body = () => ({
    checklistResults: items.map((item) => ({ item, result: res[item]?.result ?? 'ok', note: res[item]?.note || null })).filter((c) => res[c.item]),
    readings: readings.filter((r) => r.name && r.value !== '').map((r) => ({ name: r.name, value: Number.isNaN(Number(r.value)) ? r.value : Number(r.value), unit: r.unit || null })),
    workPerformed: work || null, findings: findings || null, laborHours: hours ? Number(hours) : null, partsUsed: used.filter((u) => u.partId && Number(u.qty) > 0).map((u) => ({ partId: u.partId, qty: Number(u.qty) })),
    recommendedRepairs: recs.filter((r) => r.description.trim().length >= 3).map((r) => ({ description: r.description, urgency: r.urgency, unitPrice: r.unitPrice ? Number(r.unitPrice) : null })),
    customerPresent: present, customerSignedName: present ? signed || null : null, signaturePng: present ? png : null, noSignatureReason: present ? null : why || null, resolved,
  });
  const saveDraft = useAction(async () => { await api.put(`/api/service-visits/${stop.id}/report`, body()); setSaved(new Date().toLocaleTimeString()); });
  const submit = useAction(async () => { await api.post(`/api/service-visits/${stop.id}/report/submit`, body()); await onDone(); });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit.run(); }} aria-label="Service report" data-no-draft>
      {draft.data?.status === 'draft' && <p className="muted">A draft was saved {new Date(draft.data.updated_at).toLocaleTimeString()}. The fields below start empty; submit when complete.</p>}
      {items.length > 0 && (
        <fieldset className="stack"><legend><h3>Checklist</h3></legend>
          {items.map((item) => (
            <div key={item} className="stack" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
              <div className="row" style={{ flexWrap: 'wrap' }}><span style={{ flex: '1 1 260px', fontSize: 18 }}>{item}</span>
                {(['ok', 'issue', 'na'] as Result[]).map((r) => <button type="button" key={r} aria-pressed={res[item]?.result === r} className={res[item]?.result === r ? (r === 'issue' ? 'danger' : 'primary') : ''} onClick={() => setRes({ ...res, [item]: { result: r, note: res[item]?.note ?? '' } })}>{r === 'ok' ? 'OK' : r === 'issue' ? 'Issue' : 'N/A'}</button>)}</div>
              {res[item]?.result === 'issue' && <input aria-label={`What is wrong with ${item}`} placeholder="What is the issue?" value={res[item]!.note} onChange={(e) => setRes({ ...res, [item]: { result: 'issue', note: e.target.value } })} />}
            </div>))}
        </fieldset>
      )}
      <fieldset className="stack"><legend><h3>Readings</h3></legend>
        {readings.map((r, i) => <div key={i} className="row"><input aria-label="Reading name" placeholder="e.g. Amps" value={r.name} onChange={(e) => setReadings(readings.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /><input aria-label="Reading value" placeholder="Value" value={r.value} onChange={(e) => setReadings(readings.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ width: 120 }} /><input aria-label="Unit" placeholder="Unit" value={r.unit} onChange={(e) => setReadings(readings.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} style={{ width: 90 }} /></div>)}
        <div><button type="button" onClick={() => setReadings([...readings, { name: '', value: '', unit: '' }])}>Add a reading</button></div></fieldset>
      <label className="field">Work performed<textarea id="rep-work" value={work} onChange={(e) => setWork(e.target.value)} rows={4} /></label>
      <label className="field">Findings<textarea id="rep-findings" value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} /></label>
      <label className="field">Hours on site<input id="rep-hours" type="number" min="0.25" step="0.25" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} style={{ maxWidth: 160 }} /></label>
      {stop.kind === 'callout' && <label className="row"><input type="checkbox" checked={resolved === true} onChange={(e) => setResolved(e.target.checked)} /> The problem is fixed</label>}
      <fieldset className="stack"><legend><h3>Parts used (from the truck)</h3></legend>
        {used.map((u, i) => <div key={i} className="row"><select aria-label="Part" value={u.partId} onChange={(e) => setUsed(used.map((x, j) => (j === i ? { ...x, partId: e.target.value } : x)))}><option value="">Choose a part…</option>{(stock.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}</select>
          <input aria-label="Quantity" type="number" min="1" step="any" value={u.qty} onChange={(e) => setUsed(used.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} style={{ width: 100 }} /><button type="button" onClick={() => setUsed(used.filter((_, j) => j !== i))}>Remove</button></div>)}
        <div><button type="button" onClick={() => setUsed([...used, { partId: '', qty: '1' }])}>Add a part</button></div></fieldset>
      <fieldset className="stack"><legend><h3>Other work the customer needs</h3></legend>
        {recs.map((r, i) => <div key={i} className="row"><input aria-label="Recommended repair" placeholder="What should be done" value={r.description} onChange={(e) => setRecs(recs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} style={{ flex: '1 1 260px' }} />
          <select aria-label="How soon" value={r.urgency} onChange={(e) => setRecs(recs.map((x, j) => (j === i ? { ...x, urgency: e.target.value } : x)))}><option value="now">Now</option><option value="soon">Soon</option><option value="when_convenient">When convenient</option></select>
          <input aria-label="Price if known" type="number" min="0" step="any" placeholder="Price" value={r.unitPrice} onChange={(e) => setRecs(recs.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} style={{ width: 110 }} /><button type="button" onClick={() => setRecs(recs.filter((_, j) => j !== i))}>Remove</button></div>)}
        <div><button type="button" onClick={() => setRecs([...recs, { description: '', urgency: 'soon', unitPrice: '' }])}>Add a recommended repair</button></div>
        <p className="muted">Each one becomes a line on a draft quote the office can send.</p></fieldset>
      <fieldset className="stack"><legend><h3>Customer sign-off</h3></legend>
        <label className="row"><input type="checkbox" checked={present} onChange={(e) => setPresent(e.target.checked)} /> The customer is here to sign</label>
        {present ? <><label className="field">Name<input id="rep-signed" value={signed} onChange={(e) => setSigned(e.target.value)} /></label><SignaturePad onChange={setPng} /></>
          : <label className="field">Why not signed<input id="rep-why" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Not on site, refused, locked out…" /></label>}
      </fieldset>
      <ErrorNote message={submit.error ?? saveDraft.error} />
      <div className="row big"><button type="button" disabled={saveDraft.busy} onClick={() => saveDraft.run()}>Save draft</button><button className="primary" disabled={submit.busy}>Submit report</button>{saved && <span className="muted" role="status">Draft saved {saved}</span>}</div>
    </form>
  );
}
