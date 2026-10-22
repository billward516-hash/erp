import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Attachments } from '../components/Attachments';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const PTONE: Record<string, 'bad' | 'watch' | 'good'> = { H: 'bad', M: 'watch', L: 'good' };
const PLABEL: Record<string, string> = { H: 'High', M: 'Medium', L: 'Low' };
export const Priority = ({ p }: { p?: string | null }) => (p ? <Pill tone={PTONE[p]} label={PLABEL[p]} /> : <span className="faint">—</span>);
const STATUS_TONE: Record<string, 'info' | 'watch' | 'good' | 'neutral'> = { draft: 'info', in_review: 'watch', approved: 'good', superseded: 'neutral' };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function FmeaList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/fmeas');
  const [show, setShow] = useState(false);
  const facilities = useApi<any[]>(show ? '/api/facilities' : null);
  const [f, setF] = useState({ facilityId: '', kind: 'process', title: '', scope: '', method: 'ap', rpnThreshold: '', assetId: '', team: '' });
  const assets = useApi<any[]>(show && f.facilityId && f.kind === 'equipment' ? `/api/assets?facilityId=${f.facilityId}&topLevel=true&limit=300` : null);
  const save = useAction(async () => {
    const x = await api.post('/api/fmeas', { ...f, rpnThreshold: f.method === 'rpn' ? Number(f.rpnThreshold) : null, assetId: f.assetId || null, team: f.team || null });
    nav(`/quality/fmea/${x.id}`);
  });
  return (
    <>
      <div className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data ?? []} onRow={(r) => nav(`/quality/fmea/${r.id}`)} exception={(r) => r.review_overdue} empty="No FMEAs yet."
            columns={[{ key: 'number', label: 'FMEA', render: (r) => <strong>{r.number} <span className="faint">rev {r.revision}</span></strong> }, { key: 'facility_code', label: 'Site' },
              { key: 'kind', label: 'Kind', render: (r) => humanize(r.kind) }, { key: 'title', label: 'Title' }, { key: 'subject', label: 'Asset / part', render: (r) => r.asset_tag ?? r.part_number ?? '—' },
              { key: 'high', label: 'High priority', numeric: true }, { key: 'open_actions', label: 'Open actions', numeric: true },
              { key: 'review_due', label: 'Review due', render: (r) => <>{fmtDate(r.review_due)}{r.review_overdue && <> <Pill tone="bad" label="Overdue" /></>}</> },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={STATUS_TONE[r.status]} label={humanize(r.status)} /> }]} />
        )}</Async>
      </div>
      {can('quality.manage') && !show && <div><button onClick={() => setShow(true)}>Start an FMEA</button></div>}
      {show && (
        <section className="card stack">
          <h2>Start an FMEA</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <div className="row">
              <select id="fmea-facility" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required>
                <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </select>
              <select id="fmea-kind" aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="process">Process FMEA</option><option value="design">Design FMEA</option><option value="equipment">Equipment FMEA</option>
              </select>
              {f.kind === 'equipment' && (
                <select id="fmea-asset" aria-label="Asset" value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })} required>
                  <option value="">Asset…</option>{(assets.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.asset_tag} · {a.name}</option>)}
                </select>
              )}
              <select id="fmea-method" aria-label="Scoring" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                <option value="ap">Action priority (AIAG-VDA)</option><option value="rpn">RPN with threshold</option>
              </select>
              {f.method === 'rpn' && <input id="fmea-threshold" type="number" min="1" max="1000" aria-label="RPN threshold" placeholder="Act at RPN ≥" value={f.rpnThreshold} onChange={(e) => setF({ ...f, rpnThreshold: e.target.value })} required style={{ width: 130 }} />}
            </div>
            <input id="fmea-title" aria-label="Title" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
            <input id="fmea-scope" aria-label="Scope" placeholder="Scope: process steps, functions or subsystems covered" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} required />
            <input id="fmea-team" aria-label="Team" placeholder="Team (names and roles)" value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} />
            <div className="row"><button className="primary" disabled={save.busy}>Create</button><button type="button" onClick={() => setShow(false)}>Cancel</button><ErrorNote message={save.error} /></div>
          </form>
        </section>
      )}
    </>
  );
}

interface RowEdit { item: string; failureMode: string; effect: string; severity: string; cause: string; occurrence: string; preventionControls: string; detectionControls: string; detection: string; failureCode: string }
const blank = (): RowEdit => ({ item: '', failureMode: '', effect: '', severity: '', cause: '', occurrence: '', preventionControls: '', detectionControls: '', detection: '', failureCode: '' });

export function FmeaDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: f, loading, error, reload } = useApi<any>(`/api/fmeas/${id}`);
  const users = useApi<any[]>(f ? `/api/assignable-users?facilityId=${f.facility_id}` : null);
  const [rows, setRows] = useState<RowEdit[] | null>(null);
  const [act, setAct] = useState<{ rowId: string; title: string; ownerUserId: string; dueDate: string } | null>(null);
  const [ev, setEv] = useState<{ rowId: string; s: string; o: string; d: string } | null>(null);
  const [reason, setReason] = useState('');
  const save = useAction(async () => {
    await api.put(`/api/fmeas/${id}/rows`, { rows: rows!.map((r) => ({ ...r, severity: Number(r.severity), occurrence: Number(r.occurrence), detection: Number(r.detection),
      preventionControls: r.preventionControls || null, detectionControls: r.detectionControls || null, failureCode: r.failureCode || null })) });
    setRows(null); await reload();
  });
  const submit = useAction(async () => { await api.post(`/api/fmeas/${id}/submit`, {}); await reload(); });
  const addAct = useAction(async () => { await api.post('/api/actions', { subjectType: 'fmea', subjectId: id, fmeaRowId: act!.rowId, title: act!.title, ownerUserId: act!.ownerUserId, dueDate: act!.dueDate }); setAct(null); await reload(); });
  const evaluate = useAction(async () => { await api.post(`/api/fmea-rows/${ev!.rowId}/evaluate`, { severity: Number(ev!.s), occurrence: Number(ev!.o), detection: Number(ev!.d) }); setEv(null); await reload(); });
  const revise = useAction(async () => { const n = await api.post(`/api/fmeas/${id}/revise`, { reason }); setReason(''); nav(`/quality/fmea/${n.id}`); });
  const done = useAction(async (actionId: string, note: string) => { await api.post(`/api/actions/${actionId}/complete`, { note }); await reload(); });
  return (
    <Async loading={loading && !f} error={error}>{() => {
      const draft = f.status === 'draft' && f.canEdit;
      const startEdit = () => setRows(f.rows.length ? f.rows.map((r: any) => ({ item: r.item, failureMode: r.failure_mode, effect: r.effect, severity: String(r.severity), cause: r.cause,
        occurrence: String(r.occurrence), preventionControls: r.prevention_controls ?? '', detectionControls: r.detection_controls ?? '', detection: String(r.detection), failureCode: r.failure_code ?? '' })) : [blank()]);
      const cell = (i: number, k: keyof RowEdit, label: string, opts: { score?: boolean; wide?: boolean } = {}) => (
        <input aria-label={`Row ${i + 1} ${label}`} placeholder={label} value={rows![i]![k]} type={opts.score ? 'number' : 'text'} min={opts.score ? 1 : undefined} max={opts.score ? 10 : undefined}
          onChange={(e) => setRows(rows!.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)))} style={{ width: opts.score ? 56 : opts.wide ? 220 : 150 }} required={!['preventionControls', 'detectionControls', 'failureCode'].includes(k)} />
      );
      return (
        <>
          <PageHead eyebrow={`${f.facility_code} · ${humanize(f.kind)} FMEA · ${f.method === 'ap' ? 'Action priority (AIAG-VDA)' : `RPN, act at ≥ ${f.rpn_threshold}`}`}
            title={<>{f.number} <span className="muted" style={{ fontWeight: 400 }}>rev {f.revision} · {f.title}</span></>}
            sub={<>{f.scope}{f.asset_tag ? <> · <Link to={`/assets/${f.asset_id}`}>{f.asset_tag}</Link></> : ''} · owner {f.owner_name}{f.team ? ` · team: ${f.team}` : ''}</>}
            actions={<><Pill tone={STATUS_TONE[f.status]} label={humanize(f.status)} />{f.review_due && <> <Pill tone={f.review_overdue ? 'bad' : 'neutral'} label={`Review ${fmtDate(f.review_due)}`} /></>}</>} />
          <Kpis items={[{ label: 'High', value: f.summary.H, tone: f.summary.H ? 'bad' : 'good' }, { label: 'Medium', value: f.summary.M }, { label: 'Low', value: f.summary.L },
            { label: 'High after actions', value: f.summary.postH, tone: f.summary.postH ? 'bad' : 'good' }]} />
          {rows ? (
            <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
              <h2>Worksheet</h2>
              {rows.map((_, i) => (
                <div key={i} className="stack" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
                  <div className="row"><strong>{i + 1}</strong>{cell(i, 'item', 'Item / step')}{cell(i, 'failureMode', 'Failure mode', { wide: true })}{cell(i, 'effect', 'Effect', { wide: true })}{cell(i, 'severity', 'S', { score: true })}</div>
                  <div className="row">{cell(i, 'cause', 'Cause', { wide: true })}{cell(i, 'occurrence', 'O', { score: true })}{cell(i, 'preventionControls', 'Prevention controls', { wide: true })}
                    {cell(i, 'detectionControls', 'Detection controls', { wide: true })}{cell(i, 'detection', 'D', { score: true })}{f.kind === 'equipment' && cell(i, 'failureCode', 'Failure code')}
                    <button type="button" className="link" onClick={() => setRows(rows.filter((__, j) => j !== i))}>Remove</button></div>
                </div>
              ))}
              <div className="row"><button type="button" onClick={() => setRows([...rows, blank()])}>Add row</button><button className="primary" disabled={save.busy}>Save worksheet</button>
                <button type="button" onClick={() => setRows(null)}>Cancel</button><ErrorNote message={save.error} /></div>
              <p className="faint">Scores are 1–10. Priority is computed from S, O and D; it is never typed.</p>
            </form>
          ) : (
            <section className="card stack">
              <div className="spread"><h2>Worksheet</h2>{draft && <button onClick={startEdit}>Edit worksheet</button>}</div>
              <Table rows={f.rows} empty="No failure modes yet." exception={(r) => (r.post_priority ?? r.priority) === 'H'}
                columns={[{ key: 'seq', label: '#', numeric: true }, { key: 'item', label: 'Item' },
                  { key: 'failure_mode', label: 'Failure mode → effect', render: (r) => <><strong>{r.failure_mode}</strong><div className="faint">{r.effect}</div></> },
                  { key: 'cause', label: 'Cause', render: (r) => <>{r.cause}{r.occurrence_check && <div className="bad-text">{r.occurrence_check}</div>}</> },
                  { key: 'controls', label: 'Controls', render: (r) => <>{r.prevention_controls ?? '—'}<div className="faint">{r.detection_controls ?? ''}</div></> },
                  { key: 'sod', label: 'S·O·D', render: (r) => `${r.severity}·${r.occurrence}·${r.detection}` }, { key: 'priority', label: 'Priority', render: (r) => <Priority p={r.priority} /> },
                  { key: 'actions', label: 'Actions', render: (r) => <>{r.actions.map((a: any) => <div key={a.id}>{a.status === 'done' ? '✓ ' : ''}{a.title} <span className="faint">({a.owner_name}, {fmtDate(a.due_date)})</span>
                    {a.status === 'open' && can('quality.view') && <button className="link" onClick={() => { const note = prompt('What was done?'); if (note) void done.run(a.id, note); }}> done</button>}</div>)}
                    {r.capa_number && <div><Link to={`/quality/capa/${r.capa_id}`}>{r.capa_number}</Link></div>}
                    {f.canEdit && f.status !== 'superseded' && <button className="link" onClick={() => setAct({ rowId: r.id, title: '', ownerUserId: '', dueDate: inDays(30) })}>+ action</button>}</> },
                  { key: 'post', label: 'After actions', render: (r) => (r.post_priority ? <>{`${r.post_severity}·${r.post_occurrence}·${r.post_detection}`} <Priority p={r.post_priority} /></>
                    : f.status === 'approved' && f.canEdit && r.actions.length > 0 ? <button className="link" onClick={() => setEv({ rowId: r.id, s: String(r.severity), o: '', d: '' })}>Evaluate</button> : '—') },
                  ...(f.kind === 'equipment' ? [{ key: 'observed_12m', label: 'Failures 12 m', numeric: true, render: (r: any) => (r.failure_code ? `${r.observed_12m} (${r.failure_code})` : '—') }] : [])]} />
              <ErrorNote message={done.error} />
              {act && (
                <form className="row" onSubmit={(e) => { e.preventDefault(); void addAct.run(); }}>
                  <input id="fmea-action" aria-label="Recommended action" placeholder="Recommended action" value={act.title} onChange={(e) => setAct({ ...act, title: e.target.value })} required style={{ flex: '1 1 280px' }} />
                  <select id="fmea-action-owner" aria-label="Owner" value={act.ownerUserId} onChange={(e) => setAct({ ...act, ownerUserId: e.target.value })} required>
                    <option value="">Owner…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                  </select>
                  <input type="date" aria-label="Due" value={act.dueDate} onChange={(e) => setAct({ ...act, dueDate: e.target.value })} required />
                  <button className="primary" disabled={addAct.busy}>Add</button><button type="button" onClick={() => setAct(null)}>Cancel</button><ErrorNote message={addAct.error} />
                </form>
              )}
              {ev && (
                <form className="row" onSubmit={(e) => { e.preventDefault(); void evaluate.run(); }}>
                  <span>After actions:</span>
                  {(['s', 'o', 'd'] as const).map((k) => <input key={k} aria-label={`After ${k.toUpperCase()}`} placeholder={k.toUpperCase()} type="number" min="1" max="10" value={ev[k]} onChange={(e) => setEv({ ...ev, [k]: e.target.value })} required style={{ width: 60 }} />)}
                  <button className="primary" disabled={evaluate.busy}>Record</button><button type="button" onClick={() => setEv(null)}>Cancel</button><ErrorNote message={evaluate.error} />
                </form>
              )}
            </section>
          )}
          {draft && !rows && <div className="row"><button className="primary" onClick={() => submit.run()} disabled={submit.busy}>Send for quality review</button>
            <span className="faint">High-priority rows need a recommended action or a corrective action first.</span><ErrorNote message={submit.error} /></div>}
          {f.status === 'approved' && f.canEdit && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void revise.run(); }}>
              <input id="fmea-revise" aria-label="Why revise" placeholder="Why revise (periodic review, new failure, design change)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 320px' }} />
              <button disabled={revise.busy || reason.trim().length < 3}>Start revision {f.revision + 1}</button><ErrorNote message={revise.error} />
            </form>
          )}
          <section className="card">
            <h2>Revisions</h2>
            <Table rows={f.revisions} onRow={(r) => nav(`/quality/fmea/${r.id}`)}
              columns={[{ key: 'revision', label: 'Rev', numeric: true }, { key: 'status', label: 'Status', render: (r) => humanize(r.status) }, { key: 'approved_at', label: 'Approved', render: (r) => fmtDate(r.approved_at) }]} />
          </section>
          <Attachments subjectType="fmea" subjectId={f.id} title="Files (diagrams, data)" />
        </>
      );
    }}</Async>
  );
}
