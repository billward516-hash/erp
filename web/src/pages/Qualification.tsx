import { Fragment, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Attachments } from '../components/Attachments';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';
import { DocLink } from './Documents';

type Tone = 'good' | 'watch' | 'bad' | 'info' | 'neutral';
const STATE_TONE: Record<string, Tone> = { qualified: 'good', requalification_due: 'watch', requalification_required: 'bad', not_qualified: 'watch', off: 'neutral' };
const PROTOCOL_TONE: Record<string, Tone> = { draft: 'neutral', executed: 'watch', approved: 'good', failed: 'bad' };
const PROTOCOL_STATUS: Record<string, string> = { draft: 'Draft', executed: 'Executed, waiting for approval', approved: 'Approved', failed: 'Failed' };
const OUTCOME: Record<string, string> = { pending: 'Not recorded', pass: 'Pass', fail: 'Fail', na: 'Not applicable' };
const OUTCOME_TONE: Record<string, Tone> = { pending: 'neutral', pass: 'good', fail: 'bad', na: 'neutral' };
const TYPES: [string, string][] = [['IQ', 'Installation qualification (IQ)'], ['OQ', 'Operational qualification (OQ)'], ['PQ', 'Performance qualification (PQ)'], ['requalification', 'Requalification']];
const KIND_LABEL: Record<string, string> = { state: 'State change', work_order: 'Work order', calibration: 'Calibration', qualification: 'Qualification', change: 'Change', note: 'Note' };

export const QualPill = ({ state, label }: { state: string; label: string }) => <Pill tone={STATE_TONE[state] ?? 'neutral'} label={label} />;
const dueText = (days: number | null | undefined, date?: string | null) =>
  !date ? '—' : days == null ? fmtDate(date) : `${fmtDate(date)} (${days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`})`;

/** The Qualification list: every tool under qualification control, its state and what is open. */
export function Qualification() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [state, setState] = useState('');
  const { data, loading, error, reload } = useApi<any>(`/api/qualification${state ? `?state=${state}` : ''}`);
  const protocols = useApi<any[]>('/api/qualification/protocols?open=true');
  return (
    <>
      <PageHead eyebrow="Maintenance" title="Equipment qualification"
        sub="Tools under qualification control: whether each is qualified, when it must be requalified, and the protocols that prove it. A tool that needs requalification cannot return to service until a protocol is executed and approved by someone else."
        actions={<><Link className="btn" to="/reports/equipment-qualification">Status report</Link><Link className="btn" to="/reports/tool-states">Tool states report</Link></>} />
      <Async loading={loading && !data} error={error}>{() => {
        const c = data.counts;
        return (
          <>
            <Kpis items={[{ label: 'Under control', value: c.underControl }, { label: 'Qualified', value: c.qualified, tone: 'good' },
              { label: 'Requalification due', value: c.due, tone: c.due ? 'watch' : 'good' }, { label: 'Requalification required', value: c.required, tone: c.required ? 'bad' : 'good' },
              { label: 'Not qualified', value: c.notQualified, tone: c.notQualified ? 'watch' : 'good' }]} />
            <section className="card stack">
              <div className="spread"><h2>Tools</h2>
                <label className="row">Show
                  <select id="qual-state" value={state} onChange={(e) => setState(e.target.value)}>
                    <option value="">All states</option><option value="requalification_required">Requalification required</option><option value="requalification_due">Requalification due</option>
                    <option value="not_qualified">Not qualified</option><option value="qualified">Qualified</option>
                  </select></label></div>
              <Table rows={data.tools} rowKey={(r) => r.asset_id} onRow={(r) => nav(`/qualification/assets/${r.asset_id}`)} exception={(r) => r.state === 'requalification_required'}
                empty="No tools are under qualification control yet. Put a tool under control below, or from its Qualification page."
                columns={[{ key: 'facility_code', label: 'Site' },
                  { key: 'asset_tag', label: 'Tool', render: (r) => <Link to={`/qualification/assets/${r.asset_id}`}><strong>{r.asset_tag}</strong> {r.name}</Link>, value: (r) => `${r.asset_tag} ${r.name}` },
                  { key: 'operational_state', label: 'Tool state', render: (r) => <Pill value={r.operational_state} /> },
                  { key: 'stateLabel', label: 'Qualification', render: (r) => <QualPill state={r.state} label={r.stateLabel} /> },
                  { key: 'qualified_on', label: 'Qualified on', render: (r) => fmtDate(r.qualified_on) },
                  { key: 'requal_due_on', label: 'Requalification due', render: (r) => dueText(r.dueInDays, r.requal_due_on), value: (r) => r.requal_due_on },
                  { key: 'open_protocols', label: 'Open protocols', numeric: true, render: (r) => (r.open_protocols ? `${r.open_protocols}${r.awaiting_approval ? ` (${r.awaiting_approval} waiting for approval)` : ''}` : '0') }]} />
            </section>
            <section className="card stack">
              <h2>Protocols not yet decided</h2>
              <Async loading={protocols.loading && !protocols.data} error={protocols.error}>{() => (
                <Table rows={protocols.data ?? []} onRow={(p) => nav(`/qualification/protocols/${p.id}`)} empty="No draft or executed protocols."
                  columns={[{ key: 'number', label: 'Protocol', render: (p) => <Link to={`/qualification/protocols/${p.id}`}><strong>{p.number}</strong></Link> }, { key: 'protocol_type', label: 'Type' },
                    { key: 'title', label: 'Title' }, { key: 'asset_tag', label: 'Tool' }, { key: 'status', label: 'Status', render: (p) => <Pill tone={PROTOCOL_TONE[p.status]} label={PROTOCOL_STATUS[p.status]} /> },
                    { key: 'executed_by_name', label: 'Executed by' }]} />
              )}</Async>
            </section>
            {can('qualification.manage') && <PutUnderControl onDone={async (id) => { await reload(); nav(`/qualification/assets/${id}`); }} />}
            {can('qualification.manage') && <Settings settings={data.settings} onSaved={reload} />}
          </>
        );
      }}</Async>
    </>
  );
}

function PutUnderControl({ onDone }: { onDone: (assetId: string) => void }) {
  const { can } = useAuth();
  const assets = useApi<any[]>('/api/assets?limit=500');
  const [assetId, setAssetId] = useState('');
  const [requalify, setRequalify] = useState(true);
  const save = useAction(async () => { await api.post(`/api/qualification/assets/${assetId}/switch-on`, { requalifyAfterWork: requalify }); onDone(assetId); });
  const options = (assets.data ?? []).filter((a) => can('qualification.manage', a.facility_id) && a.lifecycle_status !== 'disposed');
  return (
    <section className="card stack">
      <h2>Put a tool under qualification control</h2>
      <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <label className="field">Tool
          <select id="qual-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
            <option value="">Choose a tool…</option>{options.map((a) => <option key={a.id} value={a.id}>{a.facility_code} · {a.asset_tag} {a.name}</option>)}
          </select></label>
        <label className="row"><input id="qual-requalify" type="checkbox" checked={requalify} onChange={(e) => setRequalify(e.target.checked)} /> Requalify after finished work or an implemented change</label>
        <button className="primary" disabled={!assetId || save.busy}>Put under control</button>
      </form>
      <ErrorNote message={save.error} />
      <p className="faint">From then on the tool cannot return to service from downtime or out of service until it is qualified. A tool qualified before it was entered here is recorded on its own page, with the basis.</p>
    </section>
  );
}

function Settings({ settings, onSaved }: { settings: { intervals: Record<string, number | null>; dueLeadDays: number }; onSaved: () => void }) {
  const [f, setF] = useState<{ intervals: Record<string, string>; lead: string } | null>(null);
  const save = useAction(async () => {
    await api.put('/api/qualification/settings', { intervals: Object.fromEntries(TYPES.map(([k]) => [k, f!.intervals[k] === '' ? null : Number(f!.intervals[k])])), dueLeadDays: Number(f!.lead) });
    setF(null); onSaved();
  });
  return (
    <section className="card stack">
      <div className="spread"><h2>Requalification intervals</h2>{!f && <button onClick={() => setF({ intervals: Object.fromEntries(TYPES.map(([k]) => [k, settings.intervals[k] == null ? '' : String(settings.intervals[k])])), lead: String(settings.dueLeadDays) })}>Change</button>}</div>
      {!f ? (
        <p style={{ margin: 0 }}>{TYPES.map(([k, l]) => `${l.replace(/ \(.*\)/, '')}: ${settings.intervals[k] ? `${settings.intervals[k]} months` : 'none'}`).join(' · ')}. A tool shows “requalification due” {settings.dueLeadDays} days before its date.</p>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="form-grid">
            {TYPES.map(([k, l]) => (
              <label key={k} className="field">{l.replace(/ \(.*\)/, '')} (months)
                <input id={`qual-int-${k}`} type="number" min="1" max="120" placeholder="none" value={f.intervals[k]} onChange={(e) => setF({ ...f, intervals: { ...f.intervals, [k]: e.target.value } })} /></label>
            ))}
            <label className="field">Warn this many days ahead<input id="qual-lead" type="number" min="1" max="365" value={f.lead} onChange={(e) => setF({ ...f, lead: e.target.value })} required /></label>
          </div>
          <div className="row"><button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={() => setF(null)}>Cancel</button></div>
          <ErrorNote message={save.error} />
        </form>
      )}
      <p className="faint">The interval is the starting value for new protocols of each type; a protocol can use its own. The date is set when a protocol with an interval is approved. Leave a type empty for no periodic requalification.</p>
    </section>
  );
}

/** A short card for the asset page: the tool's qualification state and where to go. */
export function AssetQualificationCard({ assetId }: { assetId: string }) {
  const { data } = useApi<any>(`/api/qualification/assets/${assetId}`);
  if (!data) return null;
  return (
    <section className="card stack" aria-label="Qualification">
      <div className="spread"><h2>Qualification and logbook</h2><QualPill state={data.state} label={data.stateLabel} /></div>
      {data.state === 'requalification_required' && <div className="notice warn">Requalification required since {fmtDate(data.requiredSince)}: {data.requiredReason}. This tool cannot return to service until a protocol is executed and approved.</div>}
      {data.enabled ? <p className="muted" style={{ margin: 0 }}>{data.qualifiedOn ? `Qualified ${fmtDate(data.qualifiedOn)}. ` : ''}{data.requalDueOn ? `Requalification due ${dueText(data.dueInDays, data.requalDueOn)}.` : ''}</p>
        : <p className="muted" style={{ margin: 0 }}>This tool is not under qualification control. Its logbook is available.</p>}
      <div><Link className="btn" to={`/qualification/assets/${assetId}`}>Open qualification and logbook</Link></div>
    </section>
  );
}

/** One tool: its qualification, protocols and logbook. */
export function QualificationAsset() {
  const { assetId } = useParams();
  return <Fragment key={assetId}><QualificationAssetPage /></Fragment>;
}

function QualificationAssetPage() {
  const { assetId } = useParams();
  const { can } = useAuth();
  const { data: q, loading, error, reload } = useApi<any>(`/api/qualification/assets/${assetId}`);
  return (
    <Async loading={loading && !q} error={error}>{() => {
      const a = q.asset;
      return (
        <>
          <PageHead eyebrow="Qualification" title={<>{a.asset_tag} <span className="muted" style={{ fontWeight: 400 }}>{a.name}</span></>}
            sub={<><Link to={`/assets/${a.id}`}>Asset page</Link> · <Link to="/qualification">All tools under control</Link></>} actions={<QualPill state={q.state} label={q.stateLabel} />} />
          <Status q={q} onChange={reload} />
          {q.enabled && <Protocols q={q} />}
          <Logbook assetId={a.id} facilityId={a.facility_id} canNote={can('qualification.execute', a.facility_id)} canState={can('assets.record_state', a.facility_id)} />
        </>
      );
    }}</Async>
  );
}

function Status({ q, onChange }: { q: any; onChange: () => void }) {
  const a = q.asset;
  const [requalify, setRequalify] = useState(true);
  const [decl, setDecl] = useState<{ qualifiedOn: string; basis: string; requalDueOn: string } | null>(null);
  const [off, setOff] = useState<string | null>(null);
  const on = useAction(async () => { await api.post(`/api/qualification/assets/${a.id}/switch-on`, { requalifyAfterWork: requalify }); onChange(); });
  const patch = useAction(async (v: boolean) => { await api.patch(`/api/qualification/assets/${a.id}`, { requalifyAfterWork: v }); onChange(); });
  const declare = useAction(async () => { await api.post(`/api/qualification/assets/${a.id}/declare`, { qualifiedOn: decl!.qualifiedOn, basis: decl!.basis, requalDueOn: decl!.requalDueOn || null }); setDecl(null); onChange(); });
  const switchOff = useAction(async () => { await api.post(`/api/qualification/assets/${a.id}/switch-off`, { reason: off }); setOff(null); onChange(); });
  return (
    <section className="card stack">
      <h2>Status</h2>
      {!q.enabled ? (
        <>
          <p style={{ margin: 0 }}>This tool is not under qualification control, so nothing is gated when it returns to service.</p>
          {q.canManage && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void on.run(); }}>
              <label className="row"><input id="qa-requalify" type="checkbox" checked={requalify} onChange={(e) => setRequalify(e.target.checked)} /> Requalify after finished work or an implemented change</label>
              <button className="primary" disabled={on.busy}>Put under qualification control</button>
            </form>
          )}
          <ErrorNote message={on.error} />
        </>
      ) : (
        <>
          {q.state === 'requalification_required' && (
            <div className="notice warn" role="status"><strong>Requalification required</strong> since {fmtDateTime(q.requiredSince)}: {q.requiredReason}. The tool cannot return to service until a protocol (OQ, PQ or requalification) is executed after that date and approved by someone other than the people who executed it.</div>
          )}
          {q.state === 'not_qualified' && <div className="notice warn" role="status">This tool is under control but not qualified. It cannot come out of downtime or out of service until a PQ or requalification is approved{q.canManage ? ', or its existing qualification is recorded below' : ''}.</div>}
          <dl className="facts">
            <dt>Qualification</dt><dd>{q.stateLabel}</dd>
            <dt>Qualified on</dt><dd>{fmtDate(q.qualifiedOn)}</dd>
            <dt>Requalification due</dt><dd>{dueText(q.dueInDays, q.requalDueOn)}</dd>
            <dt>Requalify after work</dt>
            <dd>{q.canManage
              ? <label className="row"><input id="qa-after-work" type="checkbox" checked={q.requalifyAfterWork} disabled={patch.busy} onChange={(e) => void patch.run(e.target.checked)} /> A finished work order, or a change put in service, makes this tool need requalification</label>
              : q.requalifyAfterWork ? 'Yes' : 'No'}</dd>
          </dl>
          <ErrorNote message={patch.error} />
          {q.canManage && q.state === 'not_qualified' && !decl && <div><button onClick={() => setDecl({ qualifiedOn: new Date().toISOString().slice(0, 10), basis: '', requalDueOn: '' })}>Record existing qualification</button></div>}
          {decl && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void declare.run(); }} aria-label="Record existing qualification">
              <p className="faint" style={{ margin: 0 }}>For a tool that was qualified before it was entered here. The basis is kept in the history. Only a tool never qualified here can be recorded this way.</p>
              <div className="form-grid">
                <label className="field">Qualified on<input id="qa-decl-on" type="date" value={decl.qualifiedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDecl({ ...decl, qualifiedOn: e.target.value })} required /></label>
                <label className="field">Requalification due (optional)<input id="qa-decl-due" type="date" value={decl.requalDueOn} onChange={(e) => setDecl({ ...decl, requalDueOn: e.target.value })} /></label>
              </div>
              <label className="field">Basis: which earlier protocol, report or document shows it was qualified<textarea id="qa-decl-basis" value={decl.basis} onChange={(e) => setDecl({ ...decl, basis: e.target.value })} required minLength={10} /></label>
              <div className="row"><button className="primary" disabled={declare.busy}>Record</button><button type="button" onClick={() => setDecl(null)}>Cancel</button></div>
              <ErrorNote message={declare.error} />
            </form>
          )}
          {q.canManage && off === null && <div><button className="link" onClick={() => setOff('')}>Switch qualification control off for this tool</button></div>}
          {off !== null && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void switchOff.run(); }}>
              <input id="qa-off-reason" aria-label="Why qualification control is switched off" placeholder="Why (kept in the history)" value={off} onChange={(e) => setOff(e.target.value)} required minLength={5} style={{ width: 320 }} />
              <button disabled={switchOff.busy}>Switch off</button><button type="button" onClick={() => setOff(null)}>Cancel</button><ErrorNote message={switchOff.error} />
            </form>
          )}
        </>
      )}
    </section>
  );
}

function Protocols({ q }: { q: any }) {
  const nav = useNavigate();
  const a = q.asset;
  const [open, setOpen] = useState(false);
  const users = useApi<any[]>(open ? `/api/assignable-users?facilityId=${a.facility_id}` : null);
  const [f, setF] = useState({ protocolType: 'OQ', title: '', acceptanceCriteria: '', intervalMonths: '', approverUserId: '', steps: '' });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const create = useAction(async () => {
    const steps = f.steps.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [step, ...rest] = l.split('|'); return { step: step!.trim(), expected: rest.join('|').trim() || undefined }; });
    const p = await api.post<any>('/api/qualification/protocols', { assetId: a.id, protocolType: f.protocolType, title: f.title.trim(), acceptanceCriteria: f.acceptanceCriteria.trim() || undefined,
      ...(f.intervalMonths !== '' ? { intervalMonths: Number(f.intervalMonths) } : {}), approverUserId: f.approverUserId || null, steps });
    nav(`/qualification/protocols/${p.id}`);
  });
  return (
    <section className="card stack">
      <div className="spread"><h2>Protocols</h2>{q.canManage && <button onClick={() => setOpen(!open)} aria-expanded={open}>New protocol</button>}</div>
      <Table rows={q.protocols} onRow={(p: any) => nav(`/qualification/protocols/${p.id}`)} empty="No protocols for this tool yet."
        columns={[{ key: 'number', label: 'Protocol', render: (p: any) => <Link to={`/qualification/protocols/${p.id}`}><strong>{p.number}</strong></Link> }, { key: 'protocol_type', label: 'Type' }, { key: 'title', label: 'Title' },
          { key: 'status', label: 'Status', render: (p: any) => <Pill tone={PROTOCOL_TONE[p.status]} label={PROTOCOL_STATUS[p.status]} /> },
          { key: 'overall', label: 'Result', render: (p: any) => (p.overall ? <Pill tone={p.overall === 'pass' ? 'good' : 'bad'} label={p.overall === 'pass' ? 'All steps passed' : `${p.failed_steps} failed`} /> : <span className="faint">—</span>) },
          { key: 'executed_at', label: 'Executed', render: (p: any) => (p.executed_at ? `${fmtDate(p.executed_at)} by ${p.executed_by_name}` : '—') }, { key: 'requal_due_on', label: 'Requalification due', render: (p: any) => fmtDate(p.requal_due_on) }]} />
      {open && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void create.run(); }} aria-label="New protocol">
          <div className="form-grid">
            <label className="field">Type<select id="np-type" value={f.protocolType} onChange={(e) => set('protocolType', e.target.value)}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">Title<input id="np-title" value={f.title} onChange={(e) => set('title', e.target.value)} required minLength={3} maxLength={200} placeholder={`e.g. OQ after the ${a.asset_tag} chamber rebuild`} /></label>
            <label className="field">Requalification interval (months)<input id="np-interval" type="number" min="1" max="120" value={f.intervalMonths} onChange={(e) => set('intervalMonths', e.target.value)} placeholder={`default for ${f.protocolType}: ${q.intervals[f.protocolType] ?? 'none'}`} /></label>
            <label className="field">Approver
              <select id="np-approver" value={f.approverUserId} onChange={(e) => set('approverUserId', e.target.value)}>
                <option value="">Anyone holding the Quality manager role</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select></label>
          </div>
          <label className="field">Acceptance criteria<textarea id="np-criteria" value={f.acceptanceCriteria} onChange={(e) => set('acceptanceCriteria', e.target.value)} placeholder="What the tool must show for the protocol to pass" /></label>
          <label className="field">Steps, one per line: the step, then | and what is expected<textarea id="np-steps" value={f.steps} onChange={(e) => set('steps', e.target.value)} rows={5} placeholder={'Run the leak-up test | Below 5 mTorr/min\nCycle the lid 50 times | No faults'} /></label>
          <div className="row"><button className="primary" disabled={create.busy}>Create draft</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
          <ErrorNote message={create.error} />
          <p className="faint">The approver must be someone other than the people who execute the protocol or record its results. Documents are linked on the protocol page.</p>
        </form>
      )}
    </section>
  );
}

function Logbook({ assetId, facilityId, canNote, canState }: { assetId: string; facilityId: string; canNote: boolean; canState: boolean }) {
  const [kind, setKind] = useState('');
  const [order, setOrder] = useState('desc');
  const qs = new URLSearchParams({ order, ...(kind ? { kind } : {}) });
  const { data: b, loading, error, reload } = useApi<any>(`/api/qualification/assets/${assetId}/logbook?${qs}`);
  const [note, setNote] = useState('');
  const [st, setSt] = useState({ state: 'running', engineering: false, note: '' });
  const addNote = useAction(async () => { await api.post(`/api/qualification/assets/${assetId}/notes`, { body: note }); setNote(''); await reload(); });
  const record = useAction(async () => {
    await api.post(`/api/assets/${assetId}/state`, { state: st.state, ...(st.engineering ? { engineering: true } : {}), note: st.note || null });
    setSt({ ...st, note: '', engineering: false }); await reload();
  });
  const exp = useAction(async (format: 'csv' | 'xlsx' | 'pdf') => api.download(`/api/reports/equipment-logbook?${new URLSearchParams({ assetId, order, ...(kind ? { kind } : {}), format })}`, `equipment-logbook.${format}`));
  const { can } = useAuth();
  void facilityId;
  return (
    <section className="card stack">
      <div className="spread"><h2>Equipment logbook</h2>
        {can('reports.export') && <div className="row"><button disabled={exp.busy} onClick={() => exp.run('pdf')}>PDF</button><button disabled={exp.busy} onClick={() => exp.run('csv')}>CSV</button><button disabled={exp.busy} onClick={() => exp.run('xlsx')}>Excel</button></div>}</div>
      <ErrorNote message={exp.error} />
      <p className="faint" style={{ margin: 0 }}>State changes, work orders, calibrations, qualification events and changes are read from their own records. Notes are added here and cannot be edited or removed: a correction is a new note.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="row">Show<select id="log-kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Everything</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="row">Order<select id="log-order" value={order} onChange={(e) => setOrder(e.target.value)}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
      </div>
      <Async loading={loading && !b} error={error}>{() => (
        <>
          {b.omitted.length > 0 && <div className="notice warn" role="status">Not shown, because you may not see them: {b.omitted.join(', ')}. This logbook is not complete.</div>}
          <Table rows={b.entries} rowKey={(e: any) => `${e.at}-${e.kind}-${e.title}`} empty="Nothing recorded for this tool yet." tools={b.entries.length > 12}
            columns={[{ key: 'at', label: 'When', render: (e: any) => fmtDateTime(e.at), value: (e: any) => e.at }, { key: 'kind', label: 'Type', render: (e: any) => KIND_LABEL[e.kind] },
              { key: 'title', label: 'Entry', render: (e: any) => (e.ref ? <Link to={e.ref.href}>{e.title}</Link> : e.title) }, { key: 'detail', label: 'Detail' }, { key: 'actor', label: 'By' }]} />
          {b.truncated && <p className="faint">Only the first {b.entries.length} entries are shown; export for the rest.</p>}
        </>
      )}</Async>
      {canNote && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void addNote.run(); }} aria-label="Add a note">
          <label className="field">Add a note to the logbook<textarea id="log-note" value={note} onChange={(e) => setNote(e.target.value)} required maxLength={4000} placeholder="What was done or seen, for the next person" /></label>
          <div className="row"><button disabled={addNote.busy || !note.trim()}>Add note</button><ErrorNote message={addNote.error} /></div>
        </form>
      )}
      {canState && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void record.run(); }} aria-label="Record a state change">
          <h3>Record a state change</h3>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="field">New state
              <select id="log-state" value={st.state} onChange={(e) => setSt({ ...st, state: e.target.value, engineering: ['available', 'running', 'idle'].includes(e.target.value) ? st.engineering : false })}>
                {['available', 'running', 'idle', 'planned_downtime', 'unplanned_downtime', 'out_of_service'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </select></label>
            <label className="field">Note<input id="log-state-note" value={st.note} onChange={(e) => setSt({ ...st, note: e.target.value })} maxLength={2000} /></label>
            <label className="row"><input id="log-engineering" type="checkbox" checked={st.engineering} disabled={!['available', 'running', 'idle'].includes(st.state)} onChange={(e) => setSt({ ...st, engineering: e.target.checked })} /> Engineering use (trials, process work, qualification runs)</label>
            <button disabled={record.busy}>Record</button>
          </div>
          <ErrorNote message={record.error} />
          <p className="faint">Engineering use counts as engineering time in the tool states report, not as productive or standby time.</p>
        </form>
      )}
    </section>
  );
}

/** One protocol: steps and results, linked documents, files, execution and approval. */
export function ProtocolDetail() {
  const { id } = useParams();
  const { data: p, loading, error, reload } = useApi<any>(`/api/qualification/protocols/${id}`);
  return (
    <Async loading={loading && !p} error={error}>{() => <ProtocolBody p={p} reload={reload} />}</Async>
  );
}

function ProtocolBody({ p, reload }: { p: any; reload: () => Promise<void> }) {
  const nav = useNavigate();
  const draft = p.status === 'draft';
  const [rec, setRec] = useState<{ id: string; actual: string; outcome: string; note: string } | null>(null);
  const [step, setStep] = useState({ step: '', expected: '' });
  const [conclusion, setConclusion] = useState('');
  const [edit, setEdit] = useState<{ title: string; acceptanceCriteria: string; intervalMonths: string; approverUserId: string } | null>(null);
  const [cancel, setCancel] = useState<string | null>(null);
  const users = useApi<any[]>(edit ? `/api/assignable-users?facilityId=${p.facility_id}` : null);
  const addStep = useAction(async () => { await api.post(`/api/qualification/protocols/${p.id}/steps`, { step: step.step, expected: step.expected || undefined }); setStep({ step: '', expected: '' }); await reload(); });
  const record = useAction(async () => { await api.put(`/api/qualification/steps/${rec!.id}/result`, { actual: rec!.actual || null, outcome: rec!.outcome, note: rec!.note || null }); setRec(null); await reload(); });
  const removeStep = useAction(async (sid: string) => { await api.delete(`/api/qualification/steps/${sid}`); await reload(); });
  const execute = useAction(async () => { await api.post(`/api/qualification/protocols/${p.id}/execute`, { conclusion }); setConclusion(''); await reload(); });
  const save = useAction(async () => {
    await api.patch(`/api/qualification/protocols/${p.id}`, { title: edit!.title, acceptanceCriteria: edit!.acceptanceCriteria, intervalMonths: edit!.intervalMonths === '' ? null : Number(edit!.intervalMonths), approverUserId: edit!.approverUserId || null });
    setEdit(null); await reload();
  });
  const cancelIt = useAction(async () => { await api.post(`/api/qualification/protocols/${p.id}/cancel`, { reason: cancel }); nav(`/qualification/assets/${p.asset_id}`); });
  const failed = p.steps.filter((s: any) => s.outcome === 'fail').length;
  const pending = p.steps.filter((s: any) => s.outcome === 'pending').length;
  return (
    <>
      <PageHead eyebrow={`${p.facility_code} · ${p.number} · ${p.typeLabel}`} title={p.title}
        sub={<>Tool <Link to={`/qualification/assets/${p.asset_id}`}>{p.asset_tag} {p.asset_name}</Link> · created by {p.created_by_name}</>}
        actions={<Pill tone={PROTOCOL_TONE[p.status]} label={PROTOCOL_STATUS[p.status]} />} />
      {p.status === 'executed' && <div className="notice warn" role="status">Executed by {p.executed_by_name} on {fmtDateTime(p.executed_at)}: {p.overall === 'pass' ? 'all steps passed' : `${failed} step${failed === 1 ? '' : 's'} failed`}. {p.approver_name ? `Waiting for ${p.approver_name}` : 'Waiting for a quality manager'} to approve; the approver must be someone who did not run the protocol. <span><Link to="/approvals">Approvals</Link></span></div>}
      {p.status === 'approved' && <div className="notice ok" role="status">Approved{p.requal_due_on ? `; requalification due ${fmtDate(p.requal_due_on)}` : ''}.</div>}
      {p.status === 'failed' && <div className="notice error" role="status">The approver reviewed this run and it is recorded as failed: {failed} step{failed === 1 ? '' : 's'} did not pass. Write a new protocol once the cause is dealt with.</div>}
      <section className="card stack">
        <div className="spread"><h2>Details</h2>{draft && p.canManage && !edit && <button onClick={() => setEdit({ title: p.title, acceptanceCriteria: p.acceptance_criteria, intervalMonths: p.interval_months == null ? '' : String(p.interval_months), approverUserId: p.approver_user_id ?? '' })}>Edit</button>}</div>
        {!edit ? (
          <dl className="facts">
            <dt>Acceptance criteria</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.acceptance_criteria || '—'}</dd>
            <dt>Requalification interval</dt><dd>{p.interval_months ? `${p.interval_months} months after approval` : 'None'}</dd>
            <dt>Approver</dt><dd>{p.approver_name ?? 'Anyone holding the Quality manager role'}</dd>
            {p.executed_at && <><dt>Executed</dt><dd>{fmtDateTime(p.executed_at)} by {p.executed_by_name}</dd><dt>Conclusion</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.conclusion}</dd></>}
          </dl>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <label className="field">Title<input id="pd-title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} required minLength={3} /></label>
            <label className="field">Acceptance criteria<textarea id="pd-criteria" value={edit.acceptanceCriteria} onChange={(e) => setEdit({ ...edit, acceptanceCriteria: e.target.value })} /></label>
            <div className="form-grid">
              <label className="field">Requalification interval (months)<input id="pd-interval" type="number" min="1" max="120" value={edit.intervalMonths} onChange={(e) => setEdit({ ...edit, intervalMonths: e.target.value })} placeholder="none" /></label>
              <label className="field">Approver<select id="pd-approver" value={edit.approverUserId} onChange={(e) => setEdit({ ...edit, approverUserId: e.target.value })}><option value="">Anyone holding the Quality manager role</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
            </div>
            <div className="row"><button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={() => setEdit(null)}>Cancel</button><ErrorNote message={save.error} /></div>
          </form>
        )}
      </section>
      <section className="card stack">
        <h2>Controlled documents</h2>
        <Table rows={p.documents} rowKey={(d: any) => `${d.id}-${d.link_role}`} empty="No documents linked."
          columns={[{ key: 'doc_number', label: 'Document', render: (d: any) => <DocLink id={d.id}>{d.doc_number}</DocLink> }, { key: 'title', label: 'Title' }, { key: 'link_role', label: 'Used as', render: (d: any) => humanize(d.link_role) },
            { key: 'pinned_label', label: 'Version when linked' }, { key: 'current_label', label: 'Version in force now' },
            { key: 'revised_since', label: '', render: (d: any) => (d.revised_since ? <Pill tone="watch" label="Revised since linked" /> : null) }]} />
        {draft && p.canManage && <LinkDocument protocolId={p.id} onDone={reload} />}
      </section>
      <section className="card stack">
        <h2>Steps and results</h2>
        <Table rows={p.steps} rowKey={(s: any) => s.id} empty="No steps yet. Add the steps with what is expected."
          columns={[{ key: 'seq', label: '#', numeric: true }, { key: 'step', label: 'Step' }, { key: 'expected', label: 'Expected' }, { key: 'actual', label: 'Actual' },
            { key: 'outcome', label: 'Result', render: (s: any) => <Pill tone={OUTCOME_TONE[s.outcome]} label={OUTCOME[s.outcome]} /> },
            { key: 'recorded_by_name', label: 'Recorded by', render: (s: any) => (s.recorded_by_name ? `${s.recorded_by_name}, ${fmtDateTime(s.recorded_at)}` : '—') },
            { key: 'act', label: '', plain: true, render: (s: any) => (draft ? <span className="row">
              {p.canExecute && <button onClick={() => setRec({ id: s.id, actual: s.actual ?? '', outcome: s.outcome === 'pending' ? 'pass' : s.outcome, note: s.note ?? '' })}>{s.outcome === 'pending' ? 'Record result' : 'Change result'}</button>}
              {p.canManage && s.outcome === 'pending' && <button className="link" disabled={removeStep.busy} onClick={() => removeStep.run(s.id)}>Remove</button>}</span> : null) }]} />
        <ErrorNote message={removeStep.error} />
        {rec && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void record.run(); }} aria-label="Record a result">
            <h3>Result for step {p.steps.find((s: any) => s.id === rec.id)?.seq}</h3>
            <div className="form-grid">
              <label className="field">Result<select id="rs-outcome" value={rec.outcome} onChange={(e) => setRec({ ...rec, outcome: e.target.value })}><option value="pass">Pass</option><option value="fail">Fail</option><option value="na">Not applicable</option></select></label>
              <label className="field">What was found (the actual result)<input id="rs-actual" value={rec.actual} onChange={(e) => setRec({ ...rec, actual: e.target.value })} maxLength={4000} required={rec.outcome !== 'na'} /></label>
              <label className="field">Note (optional)<input id="rs-note" value={rec.note} onChange={(e) => setRec({ ...rec, note: e.target.value })} maxLength={4000} /></label>
            </div>
            <div className="row"><button className="primary" disabled={record.busy}>Save result</button><button type="button" onClick={() => setRec(null)}>Cancel</button><ErrorNote message={record.error} /></div>
            <Attachments subjectType="qualification_result" subjectId={rec.id} base={`/api/qualification/steps/${rec.id}/files`} title="Evidence for this step (photos, instrument printouts)" />
          </form>
        )}
        {draft && (p.canManage || p.canExecute) && (
          <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void addStep.run(); }} aria-label="Add a step">
            <label className="field">Step<input id="ps-step" value={step.step} onChange={(e) => setStep({ ...step, step: e.target.value })} required maxLength={2000} style={{ minWidth: 280 }} /></label>
            <label className="field">Expected<input id="ps-expected" value={step.expected} onChange={(e) => setStep({ ...step, expected: e.target.value })} maxLength={2000} style={{ minWidth: 220 }} /></label>
            <button disabled={addStep.busy}>Add step</button><ErrorNote message={addStep.error} />
          </form>
        )}
      </section>
      <Attachments subjectType="qualification_protocol" subjectId={p.id} base={`/api/qualification/protocols/${p.id}/files`} title="Files (reports, certificates, raw data)" canAdd={p.canExecute && ['draft', 'executed'].includes(p.status)} />
      {draft && p.canExecute && (
        <section className="card stack">
          <h2>Execute</h2>
          {pending > 0 ? <p className="muted" style={{ margin: 0 }}>{pending} step{pending === 1 ? ' has' : 's have'} no result yet. Record each as pass, fail or not applicable, then execute the protocol.</p> : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void execute.run(); }}>
              <p style={{ margin: 0 }}>{failed ? `${failed} step${failed === 1 ? '' : 's'} failed, so the protocol will be recorded as failed once reviewed.` : 'Every step has a result and none failed.'} Executing sends it to the approver and locks the results.</p>
              <label className="field">Conclusion: does the tool meet the acceptance criteria<textarea id="pd-conclusion" value={conclusion} onChange={(e) => setConclusion(e.target.value)} required minLength={5} maxLength={4000} /></label>
              <div className="row"><button className="primary" disabled={execute.busy}>Execute and send for approval</button><ErrorNote message={execute.error} /></div>
            </form>
          )}
        </section>
      )}
      {p.approvals.length > 0 && (
        <section className="card stack">
          <h2>Approval</h2>
          {p.approvals.map((r: any) => (
            <div key={r.id} className="stack">
              <p style={{ margin: 0 }}><strong>Requested {fmtDateTime(r.created_at)} by {r.requested_by}</strong> · {humanize(r.status)}</p>
              <Table rows={r.steps} rowKey={(s: any) => s.id} columns={[{ key: 'label', label: 'Step' }, { key: 'status', label: 'Status', render: (s: any) => <Pill value={s.status} /> },
                { key: 'decided_by', label: 'Decided by', render: (s: any) => (s.decided_by ? `${s.decided_by}${s.on_behalf_of ? ` for ${s.on_behalf_of}` : ''}, ${fmtDateTime(s.decided_at)}` : s.assignee_name ? `Waiting for ${s.assignee_name}` : '—') },
                { key: 'comment', label: 'Comment' }]} />
            </div>
          ))}
        </section>
      )}
      {draft && p.canManage && (
        <section className="card stack">
          {cancel === null ? <div><button className="link" onClick={() => setCancel('')}>Cancel this draft protocol</button></div> : (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void cancelIt.run(); }}>
              <input id="pd-cancel" aria-label="Why this protocol is cancelled" placeholder="Why" value={cancel} onChange={(e) => setCancel(e.target.value)} required minLength={3} style={{ width: 300 }} />
              <button disabled={cancelIt.busy}>Cancel the protocol</button><button type="button" onClick={() => setCancel(null)}>Keep it</button><ErrorNote message={cancelIt.error} />
            </form>)}
        </section>
      )}
      {p.tookPart && p.status === 'executed' && <p className="faint">You took part in running this protocol, so you cannot approve it.</p>}
    </>
  );
}

function LinkDocument({ protocolId, onDone }: { protocolId: string; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [docId, setDocId] = useState('');
  const [role, setRole] = useState('procedure');
  const docs = useApi<any[]>(q.trim().length >= 2 ? `/api/documents?q=${encodeURIComponent(q.trim())}&limit=20` : null);
  const link = useAction(async () => { await api.post(`/api/qualification/protocols/${protocolId}/documents`, { documentId: docId, role }); setQ(''); setDocId(''); onDone(); });
  return (
    <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void link.run(); }} aria-label="Link a controlled document">
      <label className="field">Find a document<input id="ld-q" type="search" value={q} onChange={(e) => { setQ(e.target.value); setDocId(''); }} placeholder="Number or title" style={{ minWidth: 220 }} /></label>
      <label className="field">Document
        <select id="ld-doc" value={docId} onChange={(e) => setDocId(e.target.value)} required>
          <option value="">{q.trim().length < 2 ? 'Type to search…' : docs.loading ? 'Searching…' : 'Choose…'}</option>
          {(docs.data ?? []).map((d) => <option key={d.id} value={d.id} disabled={!d.current_version_id}>{d.doc_number} · {d.title}{d.current_version_id ? '' : ' (no approved version)'}</option>)}
        </select></label>
      <label className="field">Used as<select id="ld-role" value={role} onChange={(e) => setRole(e.target.value)}><option value="procedure">Procedure</option><option value="reference">Reference</option></select></label>
      <button disabled={!docId || link.busy}>Link document</button><ErrorNote message={link.error} />
    </form>
  );
}
