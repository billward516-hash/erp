import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STAGES = ['idea', 'approved', 'in_progress', 'measuring', 'closed'] as const;
const STAGE_LABEL: Record<string, string> = { idea: 'Idea', approved: 'Approved', in_progress: 'Baseline set', measuring: 'Implemented, measuring', closed: 'Closed', rejected: 'Not taken forward' };
const STAGE_TONE: Record<string, 'info' | 'watch' | 'good' | 'neutral'> = { idea: 'info', approved: 'watch', in_progress: 'watch', measuring: 'watch', closed: 'good', rejected: 'neutral' };
const CATEGORIES = ['safety', 'quality', 'cost', 'delivery', 'maintenance', 'energy', 'workplace', 'other'];
const pctText = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);
const today = () => new Date().toISOString().slice(0, 10);

export function Improvements() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/api/improvements');
  const facilities = useApi<any[]>('/api/facilities');
  const [f, setF] = useState<{ facilityId: string; title: string; problem: string; idea: string; category: string } | null>(null);
  const submit = useAction(async () => { const m = await api.post('/api/improvements', { ...f, idea: f!.idea || null }); nav(`/improvements/${m.id}`); });
  const rows = data ?? [];
  const closed = rows.filter((m) => m.stage === 'closed');
  return (
    <>
      <PageHead eyebrow="Continuous improvement" title="Improvements" sub="Ideas from anyone, carried through by an owner, measured before and after from the records, and closed when someone else has checked the savings."
        actions={!f ? <button className="primary" onClick={() => setF({ facilityId: facilities.data?.[0]?.id ?? '', title: '', problem: '', idea: '', category: 'maintenance' })}>Suggest an improvement</button> : undefined} />
      {f && (
        <section className="card stack">
          <h2>Suggest an improvement</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit.run(); }}>
            <div className="row">
              <select id="imp-site" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required style={{ width: 'auto' }}>
                {(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </select>
              <select id="imp-cat" aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={{ width: 'auto' }}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </select>
              <input id="imp-title" aria-label="Title" placeholder="In a few words, e.g. Shadow board for press tools" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required style={{ flex: '1 1 260px' }} />
            </div>
            <textarea id="imp-problem" aria-label="Problem" rows={2} placeholder="What goes wrong today, and how often" value={f.problem} onChange={(e) => setF({ ...f, problem: e.target.value })} required />
            <textarea id="imp-idea" aria-label="Idea" rows={2} placeholder="Your idea to fix it (optional)" value={f.idea} onChange={(e) => setF({ ...f, idea: e.target.value })} />
            <div className="row"><button className="primary" disabled={submit.busy}>Send</button><button type="button" onClick={() => setF(null)}>Cancel</button><ErrorNote message={submit.error} /></div>
          </form>
        </section>
      )}
      <Kpis items={[
        { label: 'Ideas waiting', value: rows.filter((m) => m.stage === 'idea').length },
        { label: 'In progress', value: rows.filter((m) => ['approved', 'in_progress', 'measuring'].includes(m.stage)).length },
        { label: 'Closed', value: closed.length },
        { label: 'Validated savings / yr', value: fmtMoney(closed.reduce((t, m) => t + (m.validated_savings ?? 0), 0)), tone: 'good' },
      ]} />
      <div className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} rowKey={(m) => m.id} onRow={(m) => nav(`/improvements/${m.id}`)} empty="No improvements yet. Anyone can suggest one."
            columns={[{ key: 'number', label: 'No.', render: (m) => <strong>{m.number}</strong> }, { key: 'title', label: 'Improvement' }, { key: 'category', label: 'Category', render: (m) => humanize(m.category) },
              { key: 'stage', label: 'Stage', render: (m) => <Pill tone={STAGE_TONE[m.stage]!} label={STAGE_LABEL[m.stage]!} /> }, { key: 'owner_name', label: 'Owner', render: (m) => m.owner_name ?? '—' },
              { key: 'result', label: 'Before → after', render: (m) => (m.baseline_value == null ? '—' : `${fmtNum(m.baseline_value, 2)} → ${m.result_value == null ? '…' : fmtNum(m.result_value, 2)} ${m.metric_unit ?? ''}`) },
              { key: 'change', label: 'Change', numeric: true, render: (m) => (m.outcome ? <span className={m.outcome.better ? 'good-text' : 'bad-text'}>{pctText(m.outcome.pct)}</span> : '—') },
              { key: 'savings', label: 'Savings / yr', numeric: true, render: (m) => (m.validated_savings != null ? <strong>{fmtMoney(m.validated_savings)}</strong> : m.est_annual_savings != null ? <span className="faint">est. {fmtMoney(m.est_annual_savings)}</span> : '—') }]} />
        )}</Async>
      </div>
    </>
  );
}

export function ImprovementDetail() {
  const { id } = useParams();
  const { me, can } = useAuth();
  const { data: m, loading, error, reload } = useApi<any>(`/api/improvements/${id}`);
  const assets = useApi<any[]>(m?.facility_id && can('assets.view') ? `/api/assets?facilityId=${m.facility_id}&limit=500` : null);
  const wcs = useApi<any[]>(m?.facility_id && can('production.view') ? `/api/work-centers?facilityId=${m.facility_id}` : null);
  const [dec, setDec] = useState({ owner: '', note: '' });
  const [plan, setPlan] = useState<Record<string, any> | null>(null);
  const [value, setValue] = useState('');
  const [val, setVal] = useState({ amount: '', note: '' });
  const [action, setAction] = useState({ title: '', due: '' });
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); await reload(); return true; });
  return (
    <Async loading={loading && !m} error={error}>{() => {
      const lead = m.canLead; const own = m.isOwner || lead; const open = !['closed', 'rejected'].includes(m.stage);
      const unit = m.metric_unit ?? '';
      const p = plan ?? { metricKind: m.metric_kind, metricName: m.metric_name ?? '', metricUnit: m.metric_unit ?? '', lowerIsBetter: m.lower_is_better, targetValue: m.target_value ?? '',
        estAnnualSavings: m.est_annual_savings ?? '', oneTimeCost: m.one_time_cost ?? '', assetId: m.asset_id ?? '', workCenterId: m.work_center_id ?? '' };
      const numOrNull = (v: any) => (v === '' || v == null ? null : Number(v));
      return (
        <>
          <PageHead eyebrow={`${m.facility_code} · improvement · ${humanize(m.category)}`} title={<>{m.number} <span className="muted" style={{ fontWeight: 400 }}>{m.title}</span></>}
            sub={<>Suggested by {m.submitted_by_name} {fmtDate(m.created_at)}{m.owner_name ? ` · owner ${m.owner_name}` : ''}{m.asset_tag ? ` · ${m.asset_tag}` : ''}{m.work_center_code ? ` · ${m.work_center_code}` : ''}</>}
            actions={<Pill tone={STAGE_TONE[m.stage]!} label={STAGE_LABEL[m.stage]!} />} />
          {m.stage !== 'rejected' && <div className="steps" aria-label="Stages">{STAGES.map((s) => <span key={s} className={s === m.stage ? 'now' : STAGES.indexOf(s) < STAGES.indexOf(m.stage) ? 'done' : ''}>{STAGE_LABEL[s]}</span>)}</div>}
          <section className="card stack">
            <h2>Problem</h2><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{m.problem}</p>
            {m.idea && <><h3>Idea</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{m.idea}</p></>}
            {m.decision_note && <p className="muted" style={{ margin: 0 }}>{m.stage === 'rejected' ? 'Not taken forward' : 'Approved'} by {m.decided_by_name}: {m.decision_note}</p>}
          </section>
          {m.stage === 'idea' && lead && (
            <section className="card stack">
              <h2>Decision</h2>
              <div className="row">
                <select id="imp-owner" aria-label="Owner" value={dec.owner} onChange={(e) => setDec({ ...dec, owner: e.target.value })} style={{ width: 'auto' }}>
                  <option value="">Owner…</option>{m.owners.map((u: any) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
                <input id="imp-note" aria-label="Note" placeholder="Note (required to decline)" value={dec.note} onChange={(e) => setDec({ ...dec, note: e.target.value })} style={{ flex: '1 1 260px' }} />
                <button className="primary" disabled={act.busy || !dec.owner} onClick={() => act.run(() => api.post(`/api/improvements/${id}/decide`, { approve: true, ownerUserId: dec.owner, note: dec.note || null }))}>Approve</button>
                <button disabled={act.busy} onClick={() => act.run(() => api.post(`/api/improvements/${id}/decide`, { approve: false, note: dec.note }))}>Decline</button>
              </div>
            </section>
          )}
          {!['idea', 'rejected'].includes(m.stage) && (
            <section className="card stack">
              <h2>Measure</h2>
              <Kpis items={[
                { label: `Before${m.baseline_from ? ` (${fmtDate(m.baseline_from)} to ${fmtDate(m.baseline_to)})` : ''}`, value: m.baseline_value == null ? '—' : `${fmtNum(m.baseline_value, 2)} ${unit}` },
                { label: 'Target', value: m.target_value == null ? '—' : `${fmtNum(m.target_value, 2)} ${unit}` },
                { label: `After${m.result_from ? ` (since ${fmtDate(m.result_from)})` : ''}`, value: m.result_value == null ? '—' : `${fmtNum(m.result_value, 2)} ${unit}`,
                  tone: m.outcome ? (m.outcome.better ? 'good' : 'bad') : undefined, note: m.outcome ? `${pctText(m.outcome.pct)}${m.outcome.metTarget === true ? ', target met' : m.outcome.metTarget === false ? ', target not met' : ''}` : undefined },
                { label: 'Savings / yr', value: m.validated_savings != null ? fmtMoney(m.validated_savings) : m.est_annual_savings != null ? `est. ${fmtMoney(m.est_annual_savings)}` : '—',
                  tone: m.validated_savings != null ? 'good' : undefined, note: m.one_time_cost ? `one-time cost ${fmtMoney(m.one_time_cost)}` : undefined },
              ]} />
              <p className="muted" style={{ margin: 0 }}>{m.metric_kind === 'manual' ? `${m.metric_name ?? 'Metric'} entered by hand.` : `${m.metric_name} measured from the records (${m.metric_kind === 'asset_unplanned_downtime' ? `unplanned downtime of ${m.asset_tag}` : `scrap at ${m.work_center_code}`}), ${m.lower_is_better ? 'lower is better' : 'higher is better'}.`}
                {m.live ? ` Now: ${m.live.value == null ? 'no data' : `${fmtNum(m.live.value, 2)} ${unit}`} (${m.live.detail}, ${fmtDate(m.live.from)} to ${fmtDate(m.live.to)}).` : ''}</p>
              {open && own && ['approved', 'in_progress'].includes(m.stage) && (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(() => api.put(`/api/improvements/${id}/plan`, { metricKind: p.metricKind, metricName: p.metricName || null, metricUnit: p.metricUnit || null,
                  lowerIsBetter: p.lowerIsBetter, targetValue: numOrNull(p.targetValue), estAnnualSavings: numOrNull(p.estAnnualSavings), oneTimeCost: numOrNull(p.oneTimeCost),
                  assetId: p.assetId || null, workCenterId: p.workCenterId || null })).then((ok) => ok && setPlan(null)); }}>
                  <div className="row">
                    <select id="imp-metric" aria-label="What is measured" value={p.metricKind} onChange={(e) => setPlan({ ...p, metricKind: e.target.value })} disabled={m.baseline_value != null} style={{ width: 'auto' }}>
                      <option value="asset_unplanned_downtime">Unplanned downtime of an asset (from records)</option><option value="work_center_scrap_rate">Scrap rate at a work center (from records)</option><option value="manual">Something else, entered by hand</option>
                    </select>
                    {p.metricKind === 'asset_unplanned_downtime' && <select aria-label="Asset" value={p.assetId} onChange={(e) => setPlan({ ...p, assetId: e.target.value })} style={{ width: 'auto' }}>
                      <option value="">Asset…</option>{(assets.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.asset_tag} {a.name}</option>)}</select>}
                    {p.metricKind === 'work_center_scrap_rate' && <select aria-label="Work center" value={p.workCenterId} onChange={(e) => setPlan({ ...p, workCenterId: e.target.value })} style={{ width: 'auto' }}>
                      <option value="">Work center…</option>{(wcs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>}
                    {p.metricKind === 'manual' && <><input aria-label="Metric name" placeholder="Metric, e.g. Changeover time" value={p.metricName} onChange={(e) => setPlan({ ...p, metricName: e.target.value })} style={{ width: 200 }} />
                      <input aria-label="Unit" placeholder="Unit" value={p.metricUnit} onChange={(e) => setPlan({ ...p, metricUnit: e.target.value })} style={{ width: 80 }} />
                      <label className="row"><input type="checkbox" checked={p.lowerIsBetter} onChange={(e) => setPlan({ ...p, lowerIsBetter: e.target.checked })} /> lower is better</label></>}
                  </div>
                  <div className="row">
                    <input id="imp-target" aria-label="Target" type="number" step="any" placeholder="Target" value={p.targetValue} onChange={(e) => setPlan({ ...p, targetValue: e.target.value })} style={{ width: 110 }} />
                    <input id="imp-est" aria-label="Estimated annual savings" type="number" min="0" step="any" placeholder="Est. savings / yr" value={p.estAnnualSavings} onChange={(e) => setPlan({ ...p, estAnnualSavings: e.target.value })} style={{ width: 160 }} />
                    <input aria-label="One-time cost" type="number" min="0" step="any" placeholder="One-time cost" value={p.oneTimeCost} onChange={(e) => setPlan({ ...p, oneTimeCost: e.target.value })} style={{ width: 140 }} />
                    <button disabled={act.busy}>Save the plan</button>
                  </div>
                </form>
              )}
              {open && own && ['approved', 'in_progress'].includes(m.stage) && m.metric_name && (
                <div className="row">
                  {m.metric_kind === 'manual' && <input id="imp-value" aria-label="Baseline value" type="number" step="any" placeholder="Baseline value" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 140 }} />}
                  <button disabled={act.busy || (m.metric_kind === 'manual' && value.trim() === '')} onClick={() => act.run(() => api.post(`/api/improvements/${id}/baseline`, m.metric_kind === 'manual' ? { value: Number(value) } : {})).then((ok) => ok && setValue(''))}>
                    {m.baseline_value == null ? (m.metric_kind === 'manual' ? 'Record the baseline' : 'Measure the baseline (last 8 weeks)') : 'Measure the baseline again'}</button>
                  {m.stage === 'in_progress' && <button className="primary" disabled={act.busy} onClick={() => act.run(() => api.post(`/api/improvements/${id}/implemented`, {}))}>The change is in place (today)</button>}
                </div>
              )}
              {open && own && m.stage === 'measuring' && (
                <div className="row">
                  {m.metric_kind === 'manual' && <input id="imp-result" aria-label="Result value" type="number" step="any" placeholder="Result value" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 140 }} />}
                  <button className="primary" disabled={act.busy || (m.metric_kind !== 'manual' && m.resultReadyOn > today()) || (m.metric_kind === 'manual' && value.trim() === '')} onClick={() => act.run(() => api.post(`/api/improvements/${id}/result`, m.metric_kind === 'manual' ? { value: Number(value) } : {})).then((ok) => ok && setValue(''))}>
                    {m.result_value == null ? 'Measure the result' : 'Measure the result again'}</button>
                  {m.metric_kind !== 'manual' && m.resultReadyOn > today() && <span className="muted">The result can be measured from {fmtDate(m.resultReadyOn)} (four weeks after the change).</span>}
                </div>
              )}
              {open && lead && m.stage === 'measuring' && m.result_value != null && m.owner_user_id !== me?.userId && (
                <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(() => api.post(`/api/improvements/${id}/validate`, { amount: Number(val.amount), note: val.note })); }}>
                  <input id="imp-validated" aria-label="Validated annual savings" type="number" min="0" step="any" placeholder="Validated savings / yr" value={val.amount} onChange={(e) => setVal({ ...val, amount: e.target.value })} required style={{ width: 180 }} />
                  <input id="imp-validation-note" aria-label="How the savings were worked out" placeholder="How the savings were worked out" value={val.note} onChange={(e) => setVal({ ...val, note: e.target.value })} required style={{ flex: '1 1 260px' }} />
                  <button className="primary" disabled={act.busy}>Validate and close</button>
                </form>
              )}
              {m.validated_at && <p className="muted" style={{ margin: 0 }}>Savings validated by {m.validated_by_name} {fmtDateTime(m.validated_at)}: {m.validation_note}</p>}
              <ErrorNote message={act.error} />
            </section>
          )}
          {!['idea', 'rejected'].includes(m.stage) && (
            <section className="card stack">
              <h2>Actions</h2>
              <Table rows={m.actions} rowKey={(a) => a.id} empty="No actions yet."
                columns={[{ key: 'title', label: 'Action' }, { key: 'owner_name', label: 'Owner' }, { key: 'due_date', label: 'Due', render: (a) => fmtDate(a.due_date) },
                  { key: 'status', label: 'Status', render: (a) => <Pill tone={a.status === 'done' ? 'good' : 'watch'} label={humanize(a.status)} /> }]} />
              {open && own && (
                <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(() => api.post('/api/actions', { subjectType: 'improvement', subjectId: id, title: action.title, ownerUserId: m.owner_user_id, dueDate: action.due })).then((ok) => ok && setAction({ title: '', due: '' })); }}>
                  <input id="imp-action" aria-label="Action" placeholder="Next step" value={action.title} onChange={(e) => setAction({ ...action, title: e.target.value })} required style={{ flex: '1 1 260px' }} />
                  <input aria-label="Due" type="date" value={action.due} onChange={(e) => setAction({ ...action, due: e.target.value })} required style={{ width: 160 }} />
                  <button disabled={act.busy}>Add</button>
                </form>
              )}
            </section>
          )}
        </>
      );
    }}</Async>
  );
}
