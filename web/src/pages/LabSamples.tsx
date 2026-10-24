import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, getToken } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS_TONE: Record<string, 'info' | 'watch' | 'good' | 'neutral' | 'bad'> = { received: 'neutral', in_testing: 'info', in_review: 'watch', released: 'good', on_hold: 'bad', disposed: 'neutral' };
const OUTCOME_TONE: Record<string, 'good' | 'bad' | 'neutral'> = { pass: 'good', fail: 'bad', reported: 'neutral' };
const TEST_TONE: Record<string, 'info' | 'watch' | 'good' | 'neutral'> = { assigned: 'info', entered: 'watch', reviewed: 'good', cancelled: 'neutral' };
const TABS = [['samples', 'Samples'], ['methods', 'Methods'], ['investigations', 'Investigations']] as const;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const limits = (lo?: number | null, hi?: number | null) => (lo != null && hi != null ? `${lo} to ${hi}` : hi != null ? `at most ${hi}` : lo != null ? `at least ${lo}` : 'no limit');

export function LabSamples() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'samples';
  return (
    <>
      <PageHead eyebrow="Quality & safety" title="Samples and test results"
        sub="A small record system for laboratory samples: where each one has been, who tested it with which method and calibrated instrument, a second person’s review, and a certificate of analysis. These records support your own quality system; they are not a laboratory information system and do not claim accreditation." />
      <div className="row">
        <div className="row" role="tablist" aria-label="Samples and test results">
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
        </div>
        <Link to="/reports" className="faint">Lab reports are in Reports</Link>
      </div>
      {tab === 'samples' && <SampleList />}
      {tab === 'methods' && <MethodList />}
      {tab === 'investigations' && <InvestigationList />}
    </>
  );
}

function SampleList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [open, setOpen] = useState(true);
  const { data, loading, error, reload } = useApi<any[]>(`/api/lab/samples${open ? '?open=true' : ''}`);
  const [show, setShow] = useState(false);
  const facilities = useApi<any[]>(show ? '/api/facilities' : null);
  const [f, setF] = useState({ facilityId: '', source: 'customer', customerId: '', customerReference: '', description: '', container: '', quantity: '', quantityUnit: '', storageLocation: '', dueOn: inDays(7), retentionUntil: '' });
  const opts = useApi<any>(show ? `/api/lab/options${f.facilityId ? `?facilityId=${f.facilityId}` : ''}` : null);
  const save = useAction(async () => {
    const s = await api.post('/api/lab/samples', { facilityId: f.facilityId, source: f.source, customerId: f.source === 'customer' && f.customerId ? f.customerId : null, customerReference: f.customerReference || null, description: f.description,
      container: f.container || null, quantity: f.quantity ? Number(f.quantity) : null, quantityUnit: f.quantityUnit || null, storageLocation: f.storageLocation || null, dueOn: f.dueOn, retentionUntil: f.retentionUntil || null });
    nav(`/lab/samples/${s.id}`);
  });
  const rows = data ?? [];
  const canReceive = can('lab.analyze');
  return (
    <>
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <Kpis items={[{ label: 'Open samples', value: rows.filter((r) => !['released', 'disposed'].includes(r.status)).length },
            { label: 'Past turnaround target', value: rows.filter((r) => r.overdue).length, tone: rows.some((r) => r.overdue) ? 'bad' : 'good' },
            { label: 'In review', value: rows.filter((r) => r.status === 'in_review').length, tone: rows.some((r) => r.status === 'in_review') ? 'watch' : undefined },
            { label: 'Open investigations', value: rows.reduce((n, r) => n + r.open_investigations, 0), tone: rows.some((r) => r.open_investigations) ? 'bad' : 'good' }]} />
          <div className="row">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Open samples only</label>
            {canReceive && !show && <button className="primary" onClick={() => setShow(true)}>Receive a sample</button>}
          </div>
          <div className="card">
            <Table rows={rows} onRow={(r) => nav(`/lab/samples/${r.id}`)} exception={(r) => r.overdue || r.open_investigations > 0} empty="No samples yet."
              columns={[{ key: 'number', label: 'Sample', render: (r) => <strong>{r.number}</strong> }, { key: 'facility_code', label: 'Site' },
                { key: 'description', label: 'Description', render: (r) => <>{r.description}<div className="faint">{r.customer_name ?? (r.source === 'internal' ? 'Internal' : 'Customer')}</div></> },
                { key: 'received_on', label: 'Received', render: (r) => fmtDate(r.received_on) },
                { key: 'due_on', label: 'Target', render: (r) => <>{fmtDate(r.due_on)}{r.overdue && <div><Pill tone="bad" label={`${r.days_late} d late`} /></div>}</> },
                { key: 'tests', label: 'Tests', numeric: true, render: (r) => `${r.tests_reviewed}/${r.tests}` },
                { key: 'open_investigations', label: 'Open OOS', numeric: true, render: (r) => (r.open_investigations ? <Pill tone="bad" label={String(r.open_investigations)} /> : '—') },
                { key: 'status', label: 'Status', render: (r) => <Pill tone={STATUS_TONE[r.status]} label={humanize(r.status)} /> }]} />
          </div>
        </>
      )}</Async>
      {show && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run().then(() => void reload()); }}>
          <h2>Receive a sample</h2>
          <div className="row">
            <select aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, customerId: '' })} required>
              <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
            </select>
            <select aria-label="Source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
              <option value="customer">From a customer</option><option value="internal">Internal</option>
            </select>
            {f.source === 'customer' && (
              <select aria-label="Customer (optional)" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}>
                <option value="">Customer (optional)…</option>{(opts.data?.customers ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            {f.source === 'customer' && <input aria-label="Customer reference" placeholder="Customer reference" value={f.customerReference} onChange={(e) => setF({ ...f, customerReference: e.target.value })} />}
          </div>
          <input aria-label="Description" placeholder="What the sample is (product, lot, batch)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required minLength={2} />
          <div className="row">
            <input aria-label="Container" placeholder="Container" value={f.container} onChange={(e) => setF({ ...f, container: e.target.value })} />
            <input aria-label="Quantity" type="number" min="0" step="any" placeholder="Quantity" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} style={{ maxWidth: 120 }} />
            <input aria-label="Quantity unit" placeholder="Unit (g, mL)" value={f.quantityUnit} onChange={(e) => setF({ ...f, quantityUnit: e.target.value })} style={{ maxWidth: 120 }} />
            <input aria-label="Storage location" placeholder="Storage location" value={f.storageLocation} onChange={(e) => setF({ ...f, storageLocation: e.target.value })} />
          </div>
          <div className="row">
            <label>Turnaround target <input type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} required /></label>
            <label>Keep until (retention) <input type="date" value={f.retentionUntil} onChange={(e) => setF({ ...f, retentionUntil: e.target.value })} /></label>
          </div>
          <ErrorNote message={save.error} />
          <div className="row"><button className="primary" disabled={save.busy}>Receive sample</button><button type="button" onClick={() => setShow(false)}>Cancel</button></div>
        </form>
      )}
    </>
  );
}

interface AnalyteEdit { name: string; unit: string; specLow: string; specHigh: string }
const blankAnalyte = (): AnalyteEdit => ({ name: '', unit: '', specLow: '', specHigh: '' });

function MethodList() {
  const { can } = useAuth();
  const [all, setAll] = useState(false);
  const { data, loading, error, reload } = useApi<any[]>(`/api/lab/methods${all ? '?all=true' : ''}`);
  const [form, setForm] = useState<null | { reviseId?: string; facilityId: string; code: string; name: string; description: string; documentId: string; qualificationId: string; instrumentClass: string; analytes: AnalyteEdit[] }>(null);
  const facilities = useApi<any[]>(form ? '/api/facilities' : null);
  const opts = useApi<any>(form ? `/api/lab/options${form.facilityId ? `?facilityId=${form.facilityId}` : ''}` : null);
  const save = useAction(async () => {
    const body = { name: form!.name, description: form!.description || null, documentId: form!.documentId || null, requiredQualificationId: form!.qualificationId || null,
      requiredInstrumentClass: form!.instrumentClass || null, analytes: form!.analytes.map((a) => ({ name: a.name, unit: a.unit, specLow: a.specLow === '' ? null : Number(a.specLow), specHigh: a.specHigh === '' ? null : Number(a.specHigh) })) };
    if (form!.reviseId) await api.post(`/api/lab/methods/${form!.reviseId}/revise`, body);
    else await api.post('/api/lab/methods', { ...body, facilityId: form!.facilityId, code: form!.code });
    setForm(null); await reload();
  });
  const retire = useAction(async (id: string) => { await api.post(`/api/lab/methods/${id}/retire`, {}); await reload(); });
  const rows = data ?? [];
  const manage = can('lab.manage');
  const setA = (i: number, v: Partial<AnalyteEdit>) => setForm({ ...form!, analytes: form!.analytes.map((a, j) => (j === i ? { ...a, ...v } : a)) });
  const classes = [...new Set((opts.data?.instruments ?? []).map((x: any) => x.category).filter(Boolean))] as string[];
  return (
    <>
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <div className="row">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include retired versions</label>
            {manage && !form && <button className="primary" onClick={() => setForm({ facilityId: '', code: '', name: '', description: '', documentId: '', qualificationId: '', instrumentClass: '', analytes: [blankAnalyte()] })}>New method</button>}
          </div>
          <ErrorNote message={retire.error} />
          <div className="card">
            <Table rows={rows} empty="No methods yet." columns={[
              { key: 'code', label: 'Method', render: (r) => <strong>{r.code} <span className="faint">v{r.version}</span></strong> }, { key: 'facility_code', label: 'Site' }, { key: 'name', label: 'Name' },
              { key: 'analytes', label: 'Analytes and limits', plain: true, render: (r) => <ul style={{ margin: 0, paddingLeft: 16 }}>{r.analytes.map((a: any) => <li key={a.id}>{a.name} ({a.unit}): {limits(a.specLow, a.specHigh)}</li>)}</ul> },
              { key: 'doc_number', label: 'Document', render: (r) => (r.doc_number ? <>{r.doc_number}{r.document_revision ? ` rev ${r.document_revision}` : ''}</> : '—') },
              { key: 'qualification_code', label: 'Qualification', render: (r) => r.qualification_code ?? <span className="faint">none</span> },
              { key: 'required_instrument_class', label: 'Instrument class', render: (r) => r.required_instrument_class ?? <span className="faint">any</span> },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={r.status === 'active' ? 'good' : 'neutral'} label={humanize(r.status)} /> },
              { key: 'act', label: '', plain: true, render: (r) => (r.canManage && r.status === 'active' ? (
                <span className="row">
                  <button type="button" onClick={() => setForm({ reviseId: r.id, facilityId: r.facility_id, code: r.code, name: r.name, description: r.description ?? '', documentId: r.document_id ?? '', qualificationId: r.required_qualification_id ?? '',
                    instrumentClass: r.required_instrument_class ?? '', analytes: r.analytes.map((a: any) => ({ name: a.name, unit: a.unit, specLow: a.specLow == null ? '' : String(a.specLow), specHigh: a.specHigh == null ? '' : String(a.specHigh) })) })}>Revise</button>
                  <button type="button" onClick={() => void retire.run(r.id)}>Retire</button>
                </span>) : null) },
            ]} />
          </div>
        </>
      )}</Async>
      {form && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <h2>{form.reviseId ? `Revise ${form.code}: saves a new version` : 'New method'}</h2>
          {form.reviseId && <p className="faint">A version used by a test is never edited. The new version replaces the current one for new tests; earlier results keep the limits they were judged against.</p>}
          <div className="row">
            {!form.reviseId && (
              <>
                <select aria-label="Site" value={form.facilityId} onChange={(e) => setForm({ ...form, facilityId: e.target.value })} required>
                  <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
                </select>
                <input aria-label="Method code" placeholder="Code (for example TITR-01)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
              </>
            )}
            <input aria-label="Method name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
          </div>
          <div className="row">
            <select aria-label="Controlled document" value={form.documentId} onChange={(e) => setForm({ ...form, documentId: e.target.value })}>
              <option value="">Controlled document (optional)…</option>{(opts.data?.documents ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.doc_number} · {d.title}</option>)}
            </select>
            <select aria-label="Required qualification" value={form.qualificationId} onChange={(e) => setForm({ ...form, qualificationId: e.target.value })}>
              <option value="">Qualification needed to enter results (optional)…</option>{(opts.data?.qualifications ?? []).map((q: any) => <option key={q.id} value={q.id}>{q.code} · {q.name}</option>)}
            </select>
            <input aria-label="Required instrument class" list="lab-classes" placeholder="Instrument class (asset category)" value={form.instrumentClass} onChange={(e) => setForm({ ...form, instrumentClass: e.target.value })} />
            <datalist id="lab-classes">{classes.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <h3>Analytes and specification limits</h3>
          <p className="faint">Either limit may be left empty (a one-sided specification). Limits are inclusive. With neither limit a result is only reported.</p>
          {form.analytes.map((a, i) => (
            <div className="row" key={i}>
              <input aria-label={`Analyte ${i + 1} name`} placeholder="Analyte" value={a.name} onChange={(e) => setA(i, { name: e.target.value })} required />
              <input aria-label={`Analyte ${i + 1} unit`} placeholder="Unit" value={a.unit} onChange={(e) => setA(i, { unit: e.target.value })} required style={{ maxWidth: 100 }} />
              <input aria-label={`Analyte ${i + 1} low limit`} type="number" step="any" placeholder="Low limit" value={a.specLow} onChange={(e) => setA(i, { specLow: e.target.value })} style={{ maxWidth: 130 }} />
              <input aria-label={`Analyte ${i + 1} high limit`} type="number" step="any" placeholder="High limit" value={a.specHigh} onChange={(e) => setA(i, { specHigh: e.target.value })} style={{ maxWidth: 130 }} />
              {form.analytes.length > 1 && <button type="button" className="link" onClick={() => setForm({ ...form, analytes: form.analytes.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          ))}
          <div><button type="button" onClick={() => setForm({ ...form, analytes: [...form.analytes, blankAnalyte()] })}>Add analyte</button></div>
          <ErrorNote message={save.error} />
          <div className="row"><button className="primary" disabled={save.busy}>{form.reviseId ? 'Save new version' : 'Save method'}</button><button type="button" onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      )}
    </>
  );
}

function InvestigationList() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/api/lab/investigations');
  return (
    <Async loading={loading && !data} error={error}>{() => (
      <div className="card">
        <Table rows={data ?? []} onRow={(r) => nav(`/lab/samples/${r.sample_id}`)} exception={(r) => r.status === 'open'} empty="No out-of-specification investigations."
          columns={[{ key: 'number', label: 'Investigation', render: (r) => <strong>{r.number}</strong> }, { key: 'sample_number', label: 'Sample' }, { key: 'facility_code', label: 'Site' },
            { key: 'method_code', label: 'Method', render: (r) => `${r.method_code} v${r.method_version}` },
            { key: 'analyte_name', label: 'Result', render: (r) => <>{r.analyte_name} {r.value} {r.unit}<div className="faint">limit {limits(r.spec_low, r.spec_high)}</div></> },
            { key: 'decision', label: 'Decision', render: (r) => (r.decision ? humanize(r.decision) : '—') },
            { key: 'quality', label: 'Quality record', render: (r) => r.ncr_number ?? r.capa_number ?? '—', value: (r) => r.ncr_number ?? r.capa_number },
            { key: 'status', label: 'Status', render: (r) => <Pill tone={r.status === 'open' ? 'bad' : 'good'} label={humanize(r.status)} /> }]} />
      </div>
    )}</Async>
  );
}

export function LabSampleDetail() {
  const { id } = useParams();
  const { data: s, loading, error, reload } = useApi<any>(`/api/lab/samples/${id}`);
  const opts = useApi<any>(s ? `/api/lab/options?facilityId=${s.facility_id}` : null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<null | 'hold' | 'dispose' | 'dates'>(null);
  const [confirmEarly, setConfirmEarly] = useState(false);
  const [dates, setDates] = useState({ dueOn: '', retentionUntil: '', reason: '' });
  const [cust, setCust] = useState<null | { kind: string; toWhere: string; note: string }>(null);
  const [addTest, setAddTest] = useState<null | { methodId: string; assignedUserId: string }>(null);
  const act = useAction(async (path: string, body: unknown = {}) => { await api.post(`/api/lab/samples/${id}/${path}`, body); setMode(null); setReason(''); setConfirmEarly(false); await reload(); });
  const saveDates = useAction(async () => {
    await api.put(`/api/lab/samples/${id}/dates`, { ...(dates.dueOn ? { dueOn: dates.dueOn } : {}), retentionUntil: dates.retentionUntil || null, reason: dates.reason }); setMode(null); await reload();
  });
  const saveCust = useAction(async () => { await api.post(`/api/lab/samples/${id}/custody`, { kind: cust!.kind, toWhere: cust!.toWhere, note: cust!.note || null }); setCust(null); await reload(); });
  const saveTest = useAction(async () => { await api.post(`/api/lab/samples/${id}/tests`, { methodId: addTest!.methodId, assignedUserId: addTest!.assignedUserId || null }); setAddTest(null); await reload(); });
  const certificate = useAction(async () => {
    const res = await fetch(`/api/lab/samples/${id}/certificate.pdf`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message ?? 'The certificate could not be made');
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  });
  return (
    <Async loading={loading && !s} error={error}>{() => {
      const closed = ['released', 'disposed'].includes(s.status);
      return (
        <>
          <PageHead eyebrow={`${s.facility_code} · Lab sample`} title={<>{s.number} <span className="muted" style={{ fontWeight: 400 }}>{s.description}</span></>}
            sub={<>{s.customer_name ? `${s.customer_name}${s.customer_reference ? `, reference ${s.customer_reference}` : ''}` : s.source === 'internal' ? 'Internal sample' : 'Customer sample'} · received {fmtDate(s.received_on)} by {s.received_by_name}</>}
            actions={<><Pill tone={STATUS_TONE[s.status]} label={humanize(s.status)} />{s.overdue && <Pill tone="bad" label={`${s.days_late} days past target`} />}</>} />
          <Kpis items={[{ label: 'Turnaround target', value: fmtDate(s.due_on), tone: s.overdue ? 'bad' : undefined }, { label: 'Storage', value: s.storage_location ?? '—' },
            { label: 'Container', value: [s.container, s.quantity != null ? `${Number(s.quantity)} ${s.quantity_unit ?? ''}` : null].filter(Boolean).join(' · ') || '—' }, { label: 'Retain until', value: fmtDate(s.retention_until) },
            { label: 'Tests reviewed', value: `${s.tests.filter((t: any) => t.status === 'reviewed').length} of ${s.tests.filter((t: any) => t.status !== 'cancelled').length}` }]} />
          {s.status === 'on_hold' && <div className="notice" role="status">On hold: {s.hold_reason}</div>}
          {s.status === 'released' && <div className="notice" role="status">Released {fmtDateTime(s.released_at)} by {s.released_by_name}{s.release_note ? `: ${s.release_note}` : ''}</div>}
          {s.status === 'disposed' && <div className="notice" role="status">Disposed of {fmtDateTime(s.disposed_at)} by {s.disposed_by_name}: {s.disposal_note}</div>}
          <ErrorNote message={act.error ?? certificate.error} />
          <div className="row">
            {s.status === 'released' && <button className="primary" onClick={() => void certificate.run()} disabled={certificate.busy}>Certificate of analysis (PDF)</button>}
            {s.canReview && !closed && s.status !== 'on_hold' && <button className="primary" onClick={() => void act.run('release', {})} disabled={act.busy}>Release sample</button>}
            {s.canReview && s.status === 'on_hold' && <button onClick={() => void act.run('resume', {})}>Resume</button>}
            {s.canReview && !['on_hold', 'disposed'].includes(s.status) && <button onClick={() => setMode('hold')}>Place on hold</button>}
            {s.canManage && s.status !== 'disposed' && <button onClick={() => setMode('dispose')}>Record disposal</button>}
            {s.canManage && s.status !== 'disposed' && <button onClick={() => { setDates({ dueOn: String(s.due_on).slice(0, 10), retentionUntil: s.retention_until ? String(s.retention_until).slice(0, 10) : '', reason: '' }); setMode('dates'); }}>Change dates</button>}
          </div>
          {mode === 'hold' && (
            <form className="card stack" onSubmit={(e) => { e.preventDefault(); void act.run('hold', { reason }); }}>
              <h2>Place on hold</h2>
              <input aria-label="Reason for the hold" placeholder="Why" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
              <div className="row"><button className="primary" disabled={act.busy}>Place on hold</button><button type="button" onClick={() => setMode(null)}>Cancel</button></div>
            </form>
          )}
          {mode === 'dispose' && (
            <form className="card stack" onSubmit={(e) => { e.preventDefault(); void act.run('dispose', { note: reason, confirmEarly }); }}>
              <h2>Record disposal</h2>
              <input aria-label="How and by whom the sample was disposed of" placeholder="How, and by whom" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
              {s.retention_until && String(s.retention_until).slice(0, 10) > new Date().toISOString().slice(0, 10) && (
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={confirmEarly} onChange={(e) => setConfirmEarly(e.target.checked)} /> Retention runs until {fmtDate(s.retention_until)}; dispose early anyway</label>
              )}
              <div className="row"><button className="primary" disabled={act.busy}>Record disposal</button><button type="button" onClick={() => setMode(null)}>Cancel</button></div>
            </form>
          )}
          {mode === 'dates' && (
            <form className="card stack" onSubmit={(e) => { e.preventDefault(); void saveDates.run(); }}>
              <h2>Change dates</h2>
              <div className="row">
                <label>Turnaround target <input type="date" value={dates.dueOn} onChange={(e) => setDates({ ...dates, dueOn: e.target.value })} /></label>
                <label>Retain until <input type="date" value={dates.retentionUntil} onChange={(e) => setDates({ ...dates, retentionUntil: e.target.value })} /></label>
              </div>
              <input aria-label="Reason for the change" placeholder="Why the date changes" value={dates.reason} onChange={(e) => setDates({ ...dates, reason: e.target.value })} required minLength={3} />
              <ErrorNote message={saveDates.error} />
              <div className="row"><button className="primary" disabled={saveDates.busy}>Save dates</button><button type="button" onClick={() => setMode(null)}>Cancel</button></div>
            </form>
          )}

          <h2>Tests and results</h2>
          {s.tests.length === 0 && <p className="muted">No tests yet. Add a test from a method.</p>}
          {s.tests.map((t: any) => <TestCard key={t.id} t={t} s={s} instruments={opts.data?.instruments ?? []} reload={reload} />)}
          {s.canAnalyze && !closed && s.status !== 'on_hold' && !addTest && <div><button onClick={() => setAddTest({ methodId: '', assignedUserId: '' })}>Add a test</button></div>}
          {addTest && <AddTest s={s} state={addTest} setState={setAddTest} users={opts.data?.users ?? []} save={saveTest} />}

          {s.investigations.length > 0 && <h2>Out-of-specification investigations</h2>}
          {s.investigations.map((i: any) => <InvestigationCard key={i.id} i={i} s={s} users={opts.data?.users ?? []} reload={reload} />)}

          <section className="card stack">
            <div className="spread"><h2>Chain of custody</h2>{s.canAnalyze && s.status !== 'disposed' && !cust && <button onClick={() => setCust({ kind: 'moved', toWhere: '', note: '' })}>Record a move or handover</button>}</div>
            <p className="faint">Each entry is added and never changed. Release, hold and disposal add their own entries.</p>
            {cust && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void saveCust.run(); }}>
                <div className="row">
                  <select aria-label="What happened" value={cust.kind} onChange={(e) => setCust({ ...cust, kind: e.target.value })}>
                    <option value="moved">Moved to a location</option><option value="handed_over">Handed over to a person</option><option value="returned">Returned</option>
                  </select>
                  <input aria-label="To where or whom" placeholder="To (location or person)" value={cust.toWhere} onChange={(e) => setCust({ ...cust, toWhere: e.target.value })} required />
                  <input aria-label="Note" placeholder="Note" value={cust.note} onChange={(e) => setCust({ ...cust, note: e.target.value })} />
                </div>
                <ErrorNote message={saveCust.error} />
                <div className="row"><button className="primary" disabled={saveCust.busy}>Add entry</button><button type="button" onClick={() => setCust(null)}>Cancel</button></div>
              </form>
            )}
            <Table rows={s.custody} tools={false} columns={[{ key: 'at', label: 'When', render: (r) => fmtDateTime(r.at) }, { key: 'by_name', label: 'Who' }, { key: 'kind', label: 'What', render: (r) => humanize(r.kind) },
              { key: 'from_where', label: 'From', render: (r) => r.from_where ?? '—' }, { key: 'to_where', label: 'To', render: (r) => r.to_where ?? '—' }, { key: 'note', label: 'Note', render: (r) => r.note ?? '—' }]} />
          </section>
        </>
      );
    }}</Async>
  );
}

function AddTest({ s, state, setState, users, save }: { s: any; state: { methodId: string; assignedUserId: string }; setState: (v: any) => void; users: any[]; save: ReturnType<typeof useAction<[], void>> }) {
  const methods = useApi<any[]>(`/api/lab/methods?facilityId=${s.facility_id}`);
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <h2>Add a test</h2>
      <div className="row">
        <select aria-label="Method" value={state.methodId} onChange={(e) => setState({ ...state, methodId: e.target.value })} required>
          <option value="">Method…</option>{(methods.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.code} v{m.version} · {m.name}</option>)}
        </select>
        <select aria-label="Assign to (optional)" value={state.assignedUserId} onChange={(e) => setState({ ...state, assignedUserId: e.target.value })}>
          <option value="">Assign to (optional)…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      </div>
      <ErrorNote message={save.error} />
      <div className="row"><button className="primary" disabled={save.busy}>Add test</button><button type="button" onClick={() => setState(null)}>Cancel</button></div>
    </form>
  );
}

function TestCard({ t, s, instruments, reload }: { t: any; s: any; instruments: any[]; reload: () => Promise<void> | void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [inst, setInst] = useState('');
  const [note, setNote] = useState('');
  const [back, setBack] = useState<string | null>(null);
  const live = t.results.filter((r: any) => !r.superseded_at);
  const old = t.results.filter((r: any) => r.superseded_at);
  const missing = t.analytes.filter((a: any) => !live.some((r: any) => r.analyte_id === a.id));
  const usable = instruments.filter((x) => x.facility_id === s.facility_id && (!t.required_instrument_class || (x.category ?? '').toLowerCase() === t.required_instrument_class.toLowerCase()));
  const enter = useAction(async () => {
    const results = missing.filter((a: any) => vals[a.id] !== undefined && vals[a.id] !== '').map((a: any) => ({ analyteId: a.id, value: Number(vals[a.id]), instrumentId: inst || null }));
    await api.post(`/api/lab/tests/${t.id}/results`, { results });
    setVals({}); await reload();
  });
  const review = useAction(async () => { await api.post(`/api/lab/tests/${t.id}/review`, { note: note || null }); setNote(''); await reload(); });
  const ret = useAction(async () => { await api.post(`/api/lab/tests/${t.id}/return`, { reason: back }); setBack(null); await reload(); });
  const cancel = useAction(async () => { await api.post(`/api/lab/tests/${t.id}/cancel`, { reason: 'Cancelled from the sample page' }); await reload(); });
  const open = !['released', 'disposed', 'on_hold'].includes(s.status);
  return (
    <section className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>{t.method_code} <span className="faint">v{t.method_version}</span> · {t.method_name}</h3>
        <Pill tone={TEST_TONE[t.status]} label={humanize(t.status)} />
      </div>
      <p className="faint">
        {t.qualification_code ? `Needs qualification ${t.qualification_code}. ` : 'No qualification required. '}{t.required_instrument_class ? `Instrument class: ${t.required_instrument_class}. ` : 'Any calibrated instrument, or none. '}
        {t.assigned_name ? `Assigned to ${t.assigned_name}. ` : ''}{t.entered_by_name ? `Results by ${t.entered_by_name}. ` : ''}{t.reviewed_by_name ? `Reviewed by ${t.reviewed_by_name} ${fmtDateTime(t.reviewed_at)}.` : ''}
      </p>
      <Table rows={live} tools={false} empty="No results entered yet." columns={[{ key: 'analyte_name', label: 'Analyte' }, { key: 'value', label: 'Result', numeric: true, render: (r) => `${r.value} ${r.unit}` },
        { key: 'limits', label: 'Specification', render: (r) => limits(r.spec_low, r.spec_high), plain: true }, { key: 'outcome', label: 'Outcome', render: (r) => <Pill tone={OUTCOME_TONE[r.outcome]} label={r.outcome === 'reported' ? 'Reported' : humanize(r.outcome)} /> },
        { key: 'instrument_tag', label: 'Instrument', render: (r) => (r.instrument_tag ? <>{r.instrument_tag}<div className="faint">cal. due {fmtDate(r.instrument_cal_due)}</div></> : '—') },
        { key: 'entered_by_name', label: 'Entered by', render: (r) => <>{r.entered_by_name}<div className="faint">{fmtDateTime(r.entered_at)}</div></> }]} />
      {old.length > 0 && <details><summary>{old.length} earlier result{old.length === 1 ? '' : 's'} superseded</summary><ul>{old.map((r: any) => <li key={r.id}>{r.analyte_name} {r.value} {r.unit} ({humanize(r.outcome)}): {r.superseded_reason}</li>)}</ul></details>}
      {s.canAnalyze && open && t.status === 'assigned' && missing.length > 0 && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void enter.run(); }}>
          <h4 style={{ margin: 0 }}>Enter results</h4>
          <div className="row">
            {missing.map((a: any) => (
              <label key={a.id}>{a.name} ({a.unit}, {limits(a.specLow, a.specHigh)})
                <input type="number" step="any" value={vals[a.id] ?? ''} onChange={(e) => setVals({ ...vals, [a.id]: e.target.value })} style={{ maxWidth: 140 }} />
              </label>
            ))}
          </div>
          <select aria-label="Instrument used" value={inst} onChange={(e) => setInst(e.target.value)}>
            <option value="">{t.required_instrument_class ? `Instrument used (${t.required_instrument_class})…` : 'Instrument used (optional)…'}</option>
            {usable.map((x) => <option key={x.id} value={x.id} disabled={x.blocked}>{x.asset_tag} · {x.name} · calibration due {fmtDate(x.next_due)}{x.blocked ? ' (blocked)' : ''}</option>)}
          </select>
          <ErrorNote message={enter.error} />
          <div><button className="primary" disabled={enter.busy}>Save results</button></div>
        </form>
      )}
      {s.canReview && open && t.status === 'entered' && (
        <div className="stack">
          <input aria-label="Review note" placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <ErrorNote message={review.error ?? ret.error} />
          <div className="row">
            <button className="primary" onClick={() => void review.run()} disabled={review.busy}>Review: results are correct</button>
            {back === null ? <button onClick={() => setBack('')}>Return for correction</button> : (
              <>
                <input aria-label="What needs correcting" placeholder="What needs correcting" value={back} onChange={(e) => setBack(e.target.value)} />
                <button onClick={() => void ret.run()} disabled={ret.busy || back.length < 3}>Return test</button>
              </>
            )}
          </div>
        </div>
      )}
      {s.canAnalyze && open && ['assigned', 'entered'].includes(t.status) && <div><button className="link" onClick={() => void cancel.run()}>Cancel this test</button><ErrorNote message={cancel.error} /></div>}
    </section>
  );
}

function InvestigationCard({ i, s, users, reload }: { i: any; s: any; users: any[]; reload: () => Promise<void> | void }) {
  const [cause, setCause] = useState(i.cause ?? '');
  const [retest, setRetest] = useState(i.retest_result ?? '');
  const [close, setClose] = useState<null | { decision: string; conclusion: string; invalidReason: string }>(null);
  const [q, setQ] = useState<null | { kind: 'ncr' | 'capa'; ownerUserId: string; severity: string }>(null);
  const save = useAction(async () => { await api.put(`/api/lab/investigations/${i.id}`, { cause, retestResult: retest }); await reload(); });
  const doClose = useAction(async () => { await api.post(`/api/lab/investigations/${i.id}/close`, { decision: close!.decision, conclusion: close!.conclusion, invalidReason: close!.decision === 'invalidated' ? close!.invalidReason : null }); setClose(null); await reload(); });
  const raise = useAction(async () => { await api.post(`/api/lab/investigations/${i.id}/quality`, { kind: q!.kind, ownerUserId: q!.kind === 'capa' && q!.ownerUserId ? q!.ownerUserId : null, severity: q!.kind === 'ncr' ? q!.severity : undefined }); setQ(null); await reload(); });
  return (
    <section className="card stack">
      <div className="spread"><h3 style={{ margin: 0 }}>{i.number}: {i.analyte_name} {i.value} {i.unit}</h3><Pill tone={i.status === 'open' ? 'bad' : 'good'} label={i.status === 'open' ? 'Open: blocks release' : humanize(i.decision)} /></div>
      {i.status === 'open' ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <label>Cause (or that none was found)<textarea rows={2} value={cause} onChange={(e) => setCause(e.target.value)} disabled={!s.canAnalyze} /></label>
          <label>Retest result<textarea rows={2} value={retest} onChange={(e) => setRetest(e.target.value)} disabled={!s.canAnalyze} /></label>
          <ErrorNote message={save.error ?? doClose.error} />
          <div className="row">
            {s.canAnalyze && <button disabled={save.busy}>Save investigation</button>}
            {s.canReview && !close && <button className="primary" type="button" onClick={() => setClose({ decision: 'confirmed_oos', conclusion: '', invalidReason: '' })}>Close with a decision</button>}
          </div>
        </form>
      ) : (
        <dl>
          <dt>Cause</dt><dd>{i.cause}</dd>{i.retest_result && <><dt>Retest</dt><dd>{i.retest_result}</dd></>}
          <dt>Conclusion</dt><dd>{i.conclusion}{i.invalid_reason ? ` Reason the result is invalid: ${i.invalid_reason}` : ''}</dd>
          <dt>Closed</dt><dd>{fmtDateTime(i.closed_at)}</dd>
          {(i.ncr_number || i.capa_number) && <><dt>Quality record</dt><dd>{i.ncr_number ?? i.capa_number}</dd></>}
        </dl>
      )}
      {close && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void doClose.run(); }}>
          <p className="faint">A different reviewer than the person who entered the result closes it.</p>
          <select aria-label="Decision" value={close.decision} onChange={(e) => setClose({ ...close, decision: e.target.value })}>
            <option value="confirmed_oos">Confirmed out of specification</option><option value="invalidated">Invalidated (the result is not valid)</option>
          </select>
          {close.decision === 'invalidated' && <input aria-label="Reason the result is invalid" placeholder="Reason it is invalid" value={close.invalidReason} onChange={(e) => setClose({ ...close, invalidReason: e.target.value })} required />}
          <textarea aria-label="Conclusion" placeholder="Conclusion" rows={2} value={close.conclusion} onChange={(e) => setClose({ ...close, conclusion: e.target.value })} required />
          <div className="row"><button className="primary" disabled={doClose.busy}>Close investigation</button><button type="button" onClick={() => setClose(null)}>Cancel</button></div>
        </form>
      )}
      {i.status === 'closed' && i.decision === 'confirmed_oos' && !i.ncr_number && !i.capa_number && s.canReview && (
        q ? (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void raise.run(); }}>
            <div className="row">
              <select aria-label="Raise in Quality" value={q.kind} onChange={(e) => setQ({ ...q, kind: e.target.value as 'ncr' | 'capa' })}>
                <option value="ncr">Nonconformance</option><option value="capa">Corrective action</option>
              </select>
              {q.kind === 'ncr' && <select aria-label="Severity" value={q.severity} onChange={(e) => setQ({ ...q, severity: e.target.value })}><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select>}
              {q.kind === 'capa' && <select aria-label="Owner" value={q.ownerUserId} onChange={(e) => setQ({ ...q, ownerUserId: e.target.value })}><option value="">Owner (you)…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>}
            </div>
            <ErrorNote message={raise.error} />
            <div className="row"><button className="primary" disabled={raise.busy}>Raise it</button><button type="button" onClick={() => setQ(null)}>Cancel</button></div>
          </form>
        ) : <div><button onClick={() => setQ({ kind: 'ncr', ownerUserId: '', severity: 'major' })}>Raise a nonconformance or corrective action</button><span className="faint"> One per investigation.</span></div>
      )}
    </section>
  );
}
