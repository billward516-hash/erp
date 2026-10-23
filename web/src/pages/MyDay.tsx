import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { SignaturePad } from '../components/SignaturePad';
import { Async, ErrorNote, Pill } from '../components/ui';
import { fmtDate } from '../format';
import { useAction, useApi, useOutbox } from '../hooks';
import type { Queued } from '../offline';
import { discard, formClear, formGet, formPut, retry } from '../offline';

const today = () => new Date().toISOString().slice(0, 10);
type Result = 'ok' | 'issue' | 'na';
const visitOf = (q: Queued) => /\/service-visits\/([0-9a-f-]{36})(\/|$)/.exec(q.path)?.[1];
const kindOf = (q: Queued) => (q.path.endsWith('/start') ? 'start' : q.path.endsWith('/report/submit') ? 'submit' : 'draft');
const arrivedKey = (id: string) => `visit-arrived:${id}`;
const formName = (id: string) => `visit-report:${id}`;

/**
 * The technician's day on a tablet: the route with times and access notes, then the service report for the visit in hand.
 * Works without a connection (SC-002, D-183C): the day, each visit and its report draft are saved copies; starting a visit, saving the
 * report draft and submitting the report are kept in the outbox, with the same Idempotency-Key as the first try, and sent in order
 * when the connection returns. What the server refuses stays on the stop with its reason, to correct and send again or discard.
 */
export function MyDay() {
  const [date, setDate] = useState(today());
  const { data, loading, error, reload, offlineAt } = useApi<any>(`/api/service-my-day?date=${date}`);
  const { items, online } = useOutbox();
  const [open, setOpen] = useState<string | null>(null);
  const start = useAction(async (id: string) => {
    formPut(arrivedKey(id), new Date().toISOString());
    await api.post(`/api/service-visits/${id}/start`); await reload(); setOpen(id);
  });
  // While there is a connection, keep each of today's visits, its report draft and the parts list ready for the next time there is none.
  const ids: string = (data?.stops ?? []).map((s: any) => s.id).join(',');
  useEffect(() => {
    if (!ids || !online) return;
    for (const id of ids.split(',')) { void api.get(`/api/service-visits/${id}`).catch(() => undefined); void api.get(`/api/service-visits/${id}/report`).catch(() => undefined); }
    void api.get('/api/parts').catch(() => undefined);
  }, [ids, online]);
  // When the outbox empties or shrinks while online, show what the server now says.
  const mineSig = items.filter((q) => visitOf(q)).map((q) => q.id).join(',');
  const prevSig = useRef(mineSig);
  useEffect(() => { if (prevSig.current !== mineSig && online) void reload(); prevSig.current = mineSig; }, [mineSig, online]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (d: number) => setDate(new Date(Date.parse(`${date}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10));
  return (
    <div className="scan-station stack">
      <section className="page-head"><div><div className="eyebrow">Field service</div><h1>My day</h1><p className="sub">{fmtDate(date)}</p></div>
        <div className="row"><button onClick={() => step(-1)} aria-label="Previous day">‹</button>
          <input aria-label="Day" type="date" value={date} onChange={(e) => setDate(e.target.value)} /><button onClick={() => step(1)} aria-label="Next day">›</button></div></section>
      {(offlineAt || !online || items.some((q) => visitOf(q))) && (
        <div className="notice" role="status" aria-label="Offline state">
          {!online && <p style={{ margin: 0 }}><strong>Offline.</strong> You can still start visits and fill in and submit reports; they are kept on this device and sent in order when you are back online.</p>}
          {offlineAt && <p className="muted" style={{ margin: 0 }}>Copy saved on this device {new Date(offlineAt).toLocaleString()}: no connection right now.</p>}
          {items.some((q) => visitOf(q)) && <p className="muted" style={{ margin: 0 }}>{items.filter((q) => visitOf(q) && !q.error).length} change(s) waiting to be sent{items.some((q) => visitOf(q) && q.error) ? `, ${items.filter((q) => q.error && visitOf(q)).length} refused` : ''}. <Link to="/outbox">see all</Link></p>}
        </div>
      )}
      <ErrorNote message={start.error} />
      <Async loading={loading && !data} error={error}>{() => (
        !data.technician ? <section className="card"><p className="muted">You are not set up as a technician. Ask your dispatcher.</p></section>
        : !data.stops.length ? <section className="card"><p className="muted">Nothing is scheduled for you on this day.</p></section>
        : <>{data.stops.map((s: any, i: number) => <Stop key={s.id} s={s} n={i + 1} queued={items.filter((q) => visitOf(q) === s.id)} open={open === s.id} onOpen={(v) => setOpen(v ? s.id : null)} start={start} reload={reload} />)}</>
      )}</Async>
    </div>
  );
}

function Stop({ s, n, queued, open, onOpen, start, reload }: { s: any; n: number; queued: Queued[]; open: boolean; onOpen: (v: boolean) => void; start: { run: (id: string) => unknown; busy: boolean }; reload: () => Promise<void> }) {
  const waiting = (k: string) => queued.some((q) => kindOf(q) === k && !q.error);
  // What the tablet knows before the server does: a start or a submitted report waiting in the outbox.
  const status: string = waiting('submit') ? 'completed' : waiting('start') && ['scheduled', 'dispatched'].includes(s.status) ? 'in_progress' : s.status;
  const refusedSubmit = queued.some((q) => kindOf(q) === 'submit' && q.error);
  const [details, setDetails] = useState(false);
  return (
    <section className="card stack" aria-label={`Stop ${n}`}>
      <div className="spread"><h2>{s.arrive} · {s.customer}</h2>
        <span className="row"><Pill tone={status === 'completed' ? 'good' : status === 'in_progress' ? 'watch' : 'info'} label={status.replace('_', ' ')} />{queued.some((q) => !q.error) && <Pill tone="watch" label="Waiting to send" />}</span></div>
      <p style={{ margin: 0, fontSize: 18 }}><strong>{s.title}</strong>{s.asset_tag ? ` · ${s.asset_tag} ${s.asset_name ?? ''}` : ''}</p>
      <p className="muted" style={{ margin: 0 }}>{s.site}{s.address?.line1 ? ` · ${s.address.line1}, ${s.address.city ?? ''}` : ''} · {s.driveMinutes} min drive{s.driveEstimate ? ' (estimate)' : ''} · {s.estimated_minutes} min on site</p>
      {s.access_notes && <p className="notice warn" style={{ margin: 0 }}>Access: {s.access_notes}</p>}
      {s.model && <p className="muted" style={{ margin: 0 }}>{s.manufacturer} {s.model}{s.serial_number ? ` · serial ${s.serial_number}` : ''}</p>}
      {queued.length > 0 && (
        <ul className="stack" style={{ margin: 0, paddingLeft: 18 }} aria-label="Changes made on this device">
          {queued.map((q) => (
            <li key={q.id}>{q.label}: {q.error ? <><Pill tone="bad" label="Refused" /> {q.error}{' '}
              {kindOf(q) !== 'draft' && <button className="link" onClick={() => retry(q.id)}>Try again</button>}{' '}
              {kindOf(q) === 'submit' && <button className="link" onClick={() => onOpen(true)}>Correct the report</button>}{' '}
              <button className="link" onClick={() => { if (window.confirm(`Discard "${q.label}"? It will not be recorded.`)) discard(q.id); }}>Discard</button></> : <Pill tone="watch" label="Waiting" />}</li>))}
        </ul>
      )}
      <div className="row big">
        {['scheduled', 'dispatched'].includes(status) && <button className="primary" disabled={start.busy} onClick={() => start.run(s.id)}>Start the visit</button>}
        {(status === 'in_progress' || refusedSubmit) && <button className="primary" onClick={() => onOpen(!open)}>{open ? 'Hide the report' : 'Service report'}</button>}
        {status === 'completed' && !waiting('submit') && <Link className="btn" to={`/service/visits/${s.id}`}>View report</Link>}
        <button onClick={() => setDetails(!details)} aria-expanded={details}>{details ? 'Hide details' : 'Visit details'}</button>
      </div>
      {details && <VisitDetails id={s.id} />}
      {open && (status === 'in_progress' || refusedSubmit) && <ReportForm stop={s} onDone={async () => { onOpen(false); await reload(); }} />}
    </section>
  );
}

/** One visit's full details: a saved copy is shown when there is no connection. */
function VisitDetails({ id }: { id: string }) {
  const { data: v, error, offlineAt } = useApi<any>(`/api/service-visits/${id}`);
  if (error) return <p className="muted">Details are not available: {error.message}</p>;
  if (!v) return <p className="muted">Loading…</p>;
  return (
    <dl className="facts" aria-label="Visit details">
      <dt>Visit</dt><dd>{v.number} · {v.title}</dd>
      <dt>Customer</dt><dd>{v.customer_name}{v.site_name ? `, ${v.site_name}` : ''}</dd>
      {v.agreement_number && <><dt>Agreement</dt><dd>{v.agreement_number}</dd></>}
      <dt>Due</dt><dd>{fmtDate(v.due_on)}</dd>
      {v.access_notes && <><dt>Access</dt><dd>{v.access_notes}</dd></>}
      {v.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{v.notes}</dd></>}
      {(v.checklist ?? []).length > 0 && <><dt>Checklist</dt><dd>{v.checklist.join('; ')}</dd></>}
      {offlineAt && <><dt>Copy</dt><dd className="muted">saved on this device {new Date(offlineAt).toLocaleString()}</dd></>}
    </dl>
  );
}

interface Form {
  at: string; res: Record<string, { result: Result; note: string }>; work: string; findings: string; hours: string; readings: { name: string; value: string; unit: string }[];
  used: { partId: string; qty: string }[]; recs: { description: string; urgency: string; unitPrice: string }[]; present: boolean; signed: string; png: string | null; hadServerSignature: boolean;
  why: string; resolved: boolean | null;
}
const blank = (): Form => ({ at: '', res: {}, work: '', findings: '', hours: '', readings: [], used: [], recs: [], present: true, signed: '', png: null, hadServerSignature: false, why: '', resolved: null });
/** The draft saved on the server, as form fields (the signature image itself stays on the server; an omitted one is kept). */
function fromDraft(d: any): Form {
  return {
    at: d.updated_at ?? '', work: d.work_performed ?? '', findings: d.findings ?? '', hours: d.labor_hours != null ? String(d.labor_hours) : '', present: d.customer_present !== false, signed: d.customer_signed_name ?? '',
    png: null, hadServerSignature: !!d.hasSignature, why: d.no_signature_reason ?? '', resolved: d.resolved ?? null,
    res: Object.fromEntries((d.checklist_results ?? []).map((c: any) => [c.item, { result: c.result, note: c.note ?? '' }])),
    readings: (d.readings ?? []).map((r: any) => ({ name: r.name, value: String(r.value), unit: r.unit ?? '' })),
    used: (d.parts_used ?? []).map((p: any) => ({ partId: p.partId, qty: String(p.qty) })),
    recs: (d.recommended_repairs ?? []).map((r: any) => ({ description: r.description, urgency: r.urgency ?? 'soon', unitPrice: r.unitPrice != null ? String(r.unitPrice) : '' })),
  };
}

function ReportForm({ stop, onDone }: { stop: any; onDone: () => Promise<void> }) {
  const items: string[] = stop.checklist ?? [];
  const draft = useApi<any>(`/api/service-visits/${stop.id}/report`);
  const stock = useApi<any[]>('/api/parts');
  const [f, setF] = useState<Form>(() => formGet<Form>(formName(stop.id)) ?? blank());
  const [ready, setReady] = useState(() => !!formGet<Form>(formName(stop.id)));
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch, at: new Date().toISOString() }));
  // Restore: the newer of the copy kept on this device and the draft saved on the server (this was the "fields start empty" defect).
  useEffect(() => {
    if (draft.loading) return;
    const d = draft.data;
    if (d && d.status === 'draft' && (!ready || (d.updated_at ?? '') > f.at)) setF(fromDraft(d));
    if (d && d.status === 'submitted') formClear(formName(stop.id));
    setReady(true);
  }, [draft.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep what is typed on this device so that a reload, a dead battery or a lost connection loses nothing.
  useEffect(() => { if (ready && f.at) formPut(formName(stop.id), f); }, [f, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const arrived = formGet<string>(arrivedKey(stop.id));
  const body = (final: boolean) => ({
    arrivedAt: arrived ?? null, departedAt: final ? new Date().toISOString() : null,
    checklistResults: items.map((item) => ({ item, result: f.res[item]?.result ?? 'ok', note: f.res[item]?.note || null })).filter((c) => f.res[c.item]),
    readings: f.readings.filter((r) => r.name && r.value !== '').map((r) => ({ name: r.name, value: Number.isNaN(Number(r.value)) ? r.value : Number(r.value), unit: r.unit || null })),
    workPerformed: f.work || null, findings: f.findings || null, laborHours: f.hours ? Number(f.hours) : null, partsUsed: f.used.filter((u) => u.partId && Number(u.qty) > 0).map((u) => ({ partId: u.partId, qty: Number(u.qty) })),
    recommendedRepairs: f.recs.filter((r) => r.description.trim().length >= 3).map((r) => ({ description: r.description, urgency: r.urgency, unitPrice: r.unitPrice ? Number(r.unitPrice) : null })),
    customerPresent: f.present, customerSignedName: f.present ? f.signed || null : null,
    // Omitted when the signature saved with the draft is still the one wanted: the server keeps it.
    signaturePng: f.present ? (f.png ?? (f.hadServerSignature ? undefined : null)) : null, noSignatureReason: f.present ? null : f.why || null, resolved: f.resolved,
  });
  /** The same rules the server applies, checked here so a technician without a connection is not told only later. */
  const check = () => {
    const missing = items.filter((i) => !f.res[i]);
    if (missing.length) return `Answer every checklist item (missing: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? '…' : ''}).`;
    for (const i of items) if (f.res[i]?.result === 'issue' && !f.res[i]!.note.trim()) return `Say what is wrong with "${i}".`;
    if (f.work.trim().length < 5) return 'Describe the work performed.';
    if (!(Number(f.hours) > 0)) return 'Enter the hours on site.';
    if (f.present && (f.signed.trim().length < 2 || !(f.png || f.hadServerSignature))) return 'The customer signs: enter the name and have them sign.';
    if (!f.present && f.why.trim().length < 3) return 'Say why the customer did not sign.';
    return null;
  };
  const saveDraft = useAction(async () => {
    const r = await api.put(`/api/service-visits/${stop.id}/report`, body(false));
    setSaved(r?.queued ? 'on this device; it will be sent when you are online' : new Date().toLocaleTimeString());
  });
  const submit = useAction(async () => {
    const p = check(); setProblem(p); if (p) return;
    const r = await api.post(`/api/service-visits/${stop.id}/report/submit`, body(true));
    if (!r?.queued) formClear(formName(stop.id)); // queued: the copy stays until the server has accepted it, in case it is refused and needs correcting
    await onDone();
  });
  const stockList: any[] = stock.data ?? [];
  const patchAt = <K extends 'readings' | 'used' | 'recs'>(k: K, i: number, p: Partial<Form[K][number]>) => set({ [k]: (f[k] as any[]).map((x, j) => (j === i ? { ...x, ...p } : x)) } as any);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit.run(); }} aria-label="Service report" data-no-draft>
      {draft.data?.status === 'draft' && <p className="muted">Draft restored{draft.data.updated_at ? ` (saved ${new Date(draft.data.updated_at).toLocaleTimeString()})` : ''}. Submit when complete.</p>}
      {items.length > 0 && (
        <fieldset className="stack"><legend><h3>Checklist</h3></legend>
          {items.map((item) => (
            <div key={item} className="stack" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
              <div className="row" style={{ flexWrap: 'wrap' }}><span style={{ flex: '1 1 260px', fontSize: 18 }}>{item}</span>
                {(['ok', 'issue', 'na'] as Result[]).map((r) => <button type="button" key={r} aria-pressed={f.res[item]?.result === r} className={f.res[item]?.result === r ? (r === 'issue' ? 'danger' : 'primary') : ''} onClick={() => set({ res: { ...f.res, [item]: { result: r, note: f.res[item]?.note ?? '' } } })}>{r === 'ok' ? 'OK' : r === 'issue' ? 'Issue' : 'N/A'}</button>)}</div>
              {f.res[item]?.result === 'issue' && <input aria-label={`What is wrong with ${item}`} placeholder="What is the issue?" value={f.res[item]!.note} onChange={(e) => set({ res: { ...f.res, [item]: { result: 'issue', note: e.target.value } } })} />}
            </div>))}
        </fieldset>
      )}
      <fieldset className="stack"><legend><h3>Readings</h3></legend>
        {f.readings.map((r, i) => <div key={i} className="row"><input aria-label="Reading name" placeholder="e.g. Amps" value={r.name} onChange={(e) => patchAt('readings', i, { name: e.target.value })} /><input aria-label="Reading value" placeholder="Value" value={r.value} onChange={(e) => patchAt('readings', i, { value: e.target.value })} style={{ width: 120 }} /><input aria-label="Unit" placeholder="Unit" value={r.unit} onChange={(e) => patchAt('readings', i, { unit: e.target.value })} style={{ width: 90 }} /></div>)}
        <div><button type="button" onClick={() => set({ readings: [...f.readings, { name: '', value: '', unit: '' }] })}>Add a reading</button></div></fieldset>
      <label className="field">Work performed<textarea id="rep-work" value={f.work} onChange={(e) => set({ work: e.target.value })} rows={4} /></label>
      <label className="field">Findings<textarea id="rep-findings" value={f.findings} onChange={(e) => set({ findings: e.target.value })} rows={3} /></label>
      <label className="field">Hours on site<input id="rep-hours" type="number" min="0.25" step="0.25" inputMode="decimal" value={f.hours} onChange={(e) => set({ hours: e.target.value })} style={{ maxWidth: 160 }} /></label>
      {stop.kind === 'callout' && <label className="row"><input type="checkbox" checked={f.resolved === true} onChange={(e) => set({ resolved: e.target.checked })} /> The problem is fixed</label>}
      <fieldset className="stack"><legend><h3>Parts used (from the truck)</h3></legend>
        {f.used.map((u, i) => <div key={i} className="row"><select aria-label="Part" value={u.partId} onChange={(e) => patchAt('used', i, { partId: e.target.value })}><option value="">Choose a part…</option>{stockList.map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}</select>
          <input aria-label="Quantity" type="number" min="1" step="any" value={u.qty} onChange={(e) => patchAt('used', i, { qty: e.target.value })} style={{ width: 100 }} /><button type="button" onClick={() => set({ used: f.used.filter((_, j) => j !== i) })}>Remove</button></div>)}
        <div><button type="button" onClick={() => set({ used: [...f.used, { partId: '', qty: '1' }] })}>Add a part</button></div></fieldset>
      <fieldset className="stack"><legend><h3>Other work the customer needs</h3></legend>
        {f.recs.map((r, i) => <div key={i} className="row"><input aria-label="Recommended repair" placeholder="What should be done" value={r.description} onChange={(e) => patchAt('recs', i, { description: e.target.value })} style={{ flex: '1 1 260px' }} />
          <select aria-label="How soon" value={r.urgency} onChange={(e) => patchAt('recs', i, { urgency: e.target.value })}><option value="now">Now</option><option value="soon">Soon</option><option value="when_convenient">When convenient</option></select>
          <input aria-label="Price if known" type="number" min="0" step="any" placeholder="Price" value={r.unitPrice} onChange={(e) => patchAt('recs', i, { unitPrice: e.target.value })} style={{ width: 110 }} /><button type="button" onClick={() => set({ recs: f.recs.filter((_, j) => j !== i) })}>Remove</button></div>)}
        <div><button type="button" onClick={() => set({ recs: [...f.recs, { description: '', urgency: 'soon', unitPrice: '' }] })}>Add a recommended repair</button></div>
        <p className="muted">Each one becomes a line on a draft quote the office can send.</p></fieldset>
      <fieldset className="stack"><legend><h3>Customer sign-off</h3></legend>
        <label className="row"><input type="checkbox" checked={f.present} onChange={(e) => set({ present: e.target.checked })} /> The customer is here to sign</label>
        {f.present ? <><label className="field">Name<input id="rep-signed" value={f.signed} onChange={(e) => set({ signed: e.target.value })} /></label>
          {f.hadServerSignature && !f.png && <p className="muted" role="status">A signature was saved with this draft. Sign again only to replace it.</p>}
          <SignaturePad initial={f.png} onChange={(png) => set({ png, hadServerSignature: false })} /></>
          : <label className="field">Why not signed<input id="rep-why" value={f.why} onChange={(e) => set({ why: e.target.value })} placeholder="Not on site, refused, locked out…" /></label>}
      </fieldset>
      <ErrorNote message={problem ?? submit.error ?? saveDraft.error} />
      <div className="row big"><button type="button" disabled={saveDraft.busy} onClick={() => saveDraft.run()}>Save draft</button><button className="primary" disabled={submit.busy}>Submit report</button>{saved && <span className="muted" role="status">Draft saved {saved}</span>}</div>
    </form>
  );
}
