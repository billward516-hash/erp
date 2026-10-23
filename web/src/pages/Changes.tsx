import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, humanize, roleLabel } from '../format';
import { useAction, useApi } from '../hooks';
import { NoticeList } from './Notices';
import { TempChangeList } from './TempChanges';

const STAGES = [['draft', 'Draft'], ['review', 'Review'], ['approved', 'Implement'], ['startup_review', 'Pre-startup review'], ['in_service', 'In service'], ['closed', 'Closed']] as const;
const TYPES = ['equipment', 'process', 'procedure', 'material', 'controls_software', 'organizational', 'facility', 'other'];

export function Changes() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'changes' | 'notices' | 'temporary'>('changes');
  const { data, loading, error } = useApi<any[]>(`/api/moc${open ? '?open=true' : ''}`);
  return (
    <>
      <PageHead eyebrow="Management of change" title="Changes" sub="Every change to equipment, limits, materials, software, procedures or staffing is reviewed before use."
        actions={<>{can('moc.request') && <Link className="btn" to="/changes/new">Request a change</Link>}<Link className="btn" to="/reports/moc-register">Register report</Link></>} />
      <div className="row" role="tablist">
        {(['changes', 'notices', 'temporary'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>{t === 'notices' ? 'Change notices' : t === 'temporary' ? 'Temporary SOP changes' : 'Changes'}</button>)}
      </div>
      {tab === 'notices' && <NoticeList />}
      {tab === 'temporary' && <TempChangeList />}
      {tab === 'changes' && <div className="card stack">
        <label className="row"><input id="open-only" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Open changes only</label>
        <Async loading={loading} error={error}>{() => (
          <Table rows={data ?? []} onRow={(c) => nav(`/changes/${c.id}`)} empty="No changes." exception={(c) => c.overdue_actions > 0}
            columns={[{ key: 'number', label: 'MOC', render: (c) => <strong>{c.number}</strong> }, { key: 'facility_code', label: 'Site' }, { key: 'title', label: 'Title' },
              { key: 'risk_level', label: 'Risk', render: (c) => <Pill value={c.risk_level} /> }, { key: 'status', label: 'Stage', render: (c) => <Pill value={c.status} /> },
              { key: 'open_actions', label: 'Open actions', numeric: true },
              { key: 'is_temporary', label: 'Temporary', render: (c) => (c.is_temporary ? `until ${fmtDate(c.temporary_until)}` : '') }, { key: 'owner', label: 'Owner' }]} />
        )}</Async>
      </div>}
    </>
  );
}

export function NewChange() {
  const nav = useNavigate();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const [f, setF] = useState({ facilityId: '', title: '', description: '', justification: '', changeType: 'equipment', isTemporary: false, temporaryUntil: '', targetDate: '',
    origin: 'planned', consequences: '', qmsImpact: '', resources: '', responsibilities: '', customerImpact: 'none', customerNote: '' });
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const assets = useApi<any[]>(f.facilityId ? `/api/assets?facilityId=${f.facilityId}` : null);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const act = useAction(async () => {
    const c = await api.post('/api/moc', { ...f, temporaryUntil: f.isTemporary ? f.temporaryUntil : null, targetDate: f.targetDate || null,
      affected: assetIds.map((id) => ({ entityType: 'asset', entityId: id })) });
    nav(`/changes/${c.id}`);
  });
  const allowed = (facilities.data ?? []).filter((x) => can('moc.request', x.id));
  return (
    <>
      <PageHead eyebrow="Management of change" title="Request a change" sub="Describe the change. You will answer the screening questions on the next step." />
      <form className="card form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
        <div className="form-grid">
          <label className="field">Facility<select id="mc-fac" value={f.facilityId} onChange={(e) => { setF({ ...f, facilityId: e.target.value }); setAssetIds([]); }} required>
            <option value="">Choose…</option>{allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
          <label className="field">Type of change<select id="mc-type" value={f.changeType} onChange={set('changeType')}>{TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</select></label>
        </div>
        <label className="field">Title<input id="mc-title" value={f.title} onChange={set('title')} required minLength={3} placeholder="e.g. Raise HMC-201 spindle limit to 12,000 rpm" /></label>
        <label className="field">What will change?<textarea id="mc-desc" value={f.description} onChange={set('description')} required minLength={10} /></label>
        <label className="field">Why?<textarea id="mc-why" value={f.justification} onChange={set('justification')} required minLength={10} /></label>
        <fieldset className="stack" style={{ border: '1px solid var(--rule)', borderRadius: 6, padding: 12 }}>
          <legend className="muted">Planning the change (ISO 9001 6.3; needed before review)</legend>
          <label className="field">Is it planned?<select id="mc-origin" value={f.origin} onChange={set('origin')}>
            <option value="planned">Planned: nothing changes until it is approved</option><option value="emergency">Emergency: already made to protect people, product or equipment</option>
            <option value="unintended">Unintended: found after it happened</option></select></label>
          <label className="field">What could it affect? Intended and unintended consequences<textarea id="mc-cons" value={f.consequences} onChange={set('consequences')} /></label>
          <label className="field">What it changes in the quality system: processes, documents, records<textarea id="mc-qms" value={f.qmsImpact} onChange={set('qmsImpact')} /></label>
          <label className="field">Resources it needs, and whether they are available<textarea id="mc-res" value={f.resources} onChange={set('resources')} /></label>
          <label className="field">Who is responsible and authorized; any responsibilities that move<textarea id="mc-resp" value={f.responsibilities} onChange={set('responsibilities')} /></label>
          <label className="field">Customers<select id="mc-cust" value={f.customerImpact} onChange={set('customerImpact')}>
            <option value="none">No effect on what customers receive</option><option value="notify">Customers must be told</option><option value="approval">Customers must approve it first</option></select></label>
          {f.customerImpact !== 'none' && <label className="field">Which customers, and what they must be told or approve<textarea id="mc-cust-note" value={f.customerNote} onChange={set('customerNote')} required /></label>}
        </fieldset>
        <div className="form-grid">
          <label className="field">Target date<input id="mc-target" type="date" value={f.targetDate} onChange={set('targetDate')} /></label>
          <label className="row" style={{ alignSelf: 'end' }}><input id="mc-temp" type="checkbox" checked={f.isTemporary} onChange={set('isTemporary')} /> Temporary change</label>
          {f.isTemporary && <label className="field">Remove by (max 180 days)<input id="mc-until" type="date" value={f.temporaryUntil} onChange={set('temporaryUntil')} required /></label>}
        </div>
        {f.facilityId && (
          <fieldset className="stack" style={{ border: '1px solid var(--rule)', borderRadius: 6, padding: 12 }}>
            <legend className="muted">Affected equipment</legend>
            <div className="row" style={{ maxHeight: 180, overflow: 'auto' }}>
              {(assets.data ?? []).map((a) => (
                <label key={a.id} className="row" style={{ minWidth: 220 }}>
                  <input type="checkbox" checked={assetIds.includes(a.id)} onChange={(e) => setAssetIds(e.target.checked ? [...assetIds, a.id] : assetIds.filter((x) => x !== a.id))} />
                  {a.asset_tag} <span className="faint">{a.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <ErrorNote message={act.error} />
        <div><button className="primary" disabled={act.busy}>Save draft</button></div>
      </form>
    </>
  );
}

export function ChangeDetail() {
  const { id } = useParams();
  const { can, me } = useAuth();
  const { data: c, loading, error, reload } = useApi<any>(`/api/moc/${id}`);
  const post = useAction(async (path: string, body?: unknown) => { await api.post(path, body); await reload(); });
  const notices = useApi<any[]>(`/api/change-notices?changeId=${id}`);
  const nav = useNavigate();
  return (
    <Async loading={loading && !c} error={error}>{() => {
      const manage = can('moc.manage', c.facility_id);
      const stageIdx = STAGES.findIndex(([s]) => s === c.status);
      const canRework = ['draft', 'rejected'].includes(c.status) && (c.requested_by === me?.userId || c.owner_user_id === me?.userId || manage);
      const startupOpen = c.actions.filter((a: any) => a.required_before === 'startup' && a.status === 'open').length;
      return (
        <>
          <PageHead eyebrow={`${c.facility_code} · ${c.number} · revision ${c.revision} · ${humanize(c.change_type)}${c.is_temporary ? ` · temporary until ${fmtDate(c.temporary_until)}` : ''}`}
            title={c.title} actions={<>{c.risk_level && <Pill value={c.risk_level} label={`${c.risk_level} risk`} />}<Pill value={c.status} /></>} />
          <section className="card stack" aria-label="Notices for this change">
            <div className="spread"><h2>Notices</h2>{manage && !['rejected', 'cancelled'].includes(c.status) && <Link className="btn" to={`/changes/notices/new?change=${c.id}&kind=ecn`}>Raise a change notice</Link>}</div>
            <Table tools={false} rows={notices.data ?? []} rowKey={(n) => n.id} onRow={(n) => nav(`/changes/notices/${n.id}`)} empty="No notices raised for this change."
              columns={[{ key: 'number', label: 'Notice' }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status', render: (n) => <Pill value={n.status} /> },
                { key: 'acknowledged', label: 'Acknowledged', render: (n) => (n.status === 'draft' ? '—' : `${n.acknowledged} of ${n.acknowledged + n.outstanding}`) }]} />
          </section>
          {c.status === 'rejected'
            ? <div className="notice error" role="status" aria-label="Rejected">Rejected{c.rejection ? <> in the {c.rejection.label.toLowerCase()} by {c.rejection.decided_by ?? 'a reviewer'}{c.rejection.decided_at ? ` on ${fmtDate(c.rejection.decided_at)}` : ''} (revision {c.rejection.revision}): <strong>{c.rejection.comment}</strong></> : '.'}
              {canRework ? ' Rework the change below and send it for review again; the earlier round stays in the sign-offs.' : ' Its author or a change coordinator can rework it.'}</div>
            : c.status === 'cancelled' ? <div className="notice error">This change was cancelled.{c.closure_note ? ` ${c.closure_note}` : ''}</div>
            : <div className="steps" aria-label="Progress">{STAGES.filter(([s]) => s !== 'startup_review' || c.pssr_required).map(([s, l]) => {
                const i = STAGES.findIndex(([x]) => x === s);
                return <span key={s} className={i < stageIdx ? 'done' : i === stageIdx ? 'now' : ''}>{l}</span>;
              })}</div>}
          <ErrorNote message={post.error} />
          {canRework && <EditChange c={c} onDone={reload} />}
          {canRework && <ScreeningForm id={c.id} resubmit={c.status === 'rejected'} onDone={reload} />}
          {c.status === 'approved' && manage && (
            <section className="card spread">
              <span>{startupOpen ? `${startupOpen} startup action(s) must be done before startup.` : 'All startup actions are done.'}</span>
              <button className="primary" disabled={post.busy || startupOpen > 0} onClick={() => post.run(`/api/moc/${c.id}/startup`)}>{c.pssr_required ? 'Open pre-startup review' : 'Put into service'}</button>
            </section>
          )}
          {c.status === 'startup_review' && <PssrForm c={c} canEdit={manage} onDone={reload} />}
          {c.status === 'in_service' && manage && <CloseForm c={c} onDone={reload} />}
          <div className="grid two">
            <section className="card">
              <h2>The change</h2>
              <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{c.description}</p>
              <h3>Why</h3><p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{c.justification}</p>
              <JustificationDeck c={c} onDone={reload} />
              <h3>Planning (ISO 9001 6.3)</h3>
              <dl className="facts">
                <dt>Origin</dt><dd>{c.origin === 'planned' ? 'Planned' : c.origin === 'emergency' ? 'Emergency change' : 'Unintended change'}</dd>
                <dt>Consequences</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.consequences ?? <span className="bad-text">not yet described</span>}</dd>
                <dt>Quality system</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.qms_impact ?? <span className="bad-text">not yet described</span>}</dd>
                <dt>Resources</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.resources ?? <span className="bad-text">not yet described</span>}</dd>
                <dt>Responsibilities</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.responsibilities ?? <span className="bad-text">not yet described</span>}</dd>
                <dt>Customers</dt><dd>{c.customer_impact === 'none' ? 'Not affected' : `${c.customer_impact === 'approval' ? 'Must approve' : 'Must be told'}: ${c.customer_note ?? ''}`}</dd>
                {c.outcome_achieved != null && <><dt>Outcome</dt><dd>{c.outcome_achieved ? 'Achieved its purpose' : 'Did not achieve its purpose'}: {c.effectiveness_note}
                  {c.outcome_achieved === false && <> <Link to={`/capa/new?source=change&origin=moc_change:${c.id}&facility=${c.facility_id}&title=${encodeURIComponent(`${c.number} did not achieve its purpose`)}`}>Open a corrective action</Link></>}</dd></>}
              </dl>
              <dl className="facts">
                <dt>Requested by</dt><dd>{c.requested_by_name}</dd><dt>Owner</dt><dd>{c.owner_name}</dd><dt>Target date</dt><dd>{fmtDate(c.target_date)}</dd>
                {c.screening_rules && <><dt>Screened with</dt><dd className="mono">{c.screening_rules}</dd></>}
              </dl>
            </section>
            <section className="card">
              <h2>Affects</h2>
              <Table rows={c.affected} rowKey={(a) => a.entity_type + a.entity_id} empty="Nothing linked."
                columns={[{ key: 'entity_type', label: 'Type', render: (a) => humanize(a.entity_type) },
                  { key: 'label', label: 'Item', render: (a) => (a.entity_type === 'asset' ? <Link to={`/assets/${a.entity_id}`}>{a.label}</Link> : a.label) }]} />
            </section>
          </div>
          <section className="card">
            <h2>Sign-offs</h2>
            {c.approvals.length ? c.approvals.map((r: any) => (
              <div key={r.id} className="stack" style={{ marginBottom: 12 }}>
                <div className="row"><strong>{r.purpose === 'moc.startup' ? 'Startup authorization' : `Change authorization${c.approvals.filter((x: any) => x.purpose === 'moc.authorize').length > 1 ? `, round ${c.approvals.filter((x: any) => x.purpose === 'moc.authorize').indexOf(r) + 1}` : ''}`}</strong><span className="faint">revision {r.subject_revision}</span><Pill value={r.status} tone={r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : r.status === 'pending' ? 'info' : 'neutral'} /></div>
                <Table rows={r.steps} columns={[{ key: 'stage', label: 'Stage', numeric: true }, { key: 'label', label: 'Step' }, { key: 'role_key', label: 'Role', render: (s) => roleLabel(s.role_key) },
                  { key: 'status', label: 'Status', render: (s) => <Pill value={s.status} tone={s.status === 'approved' ? 'good' : s.status === 'rejected' ? 'bad' : 'neutral'} /> },
                  { key: 'decided_by', label: 'By' }, { key: 'comment', label: 'Comment' }]} />
              </div>
            )) : <p className="muted">Not submitted yet.</p>}
          </section>
          <section className="card stack">
            <h2>Action plan</h2>
            <Table rows={c.actions} exception={(a) => a.overdue}
              columns={[{ key: 'title', label: 'Action' }, { key: 'required_before', label: 'Before', render: (a) => humanize(a.required_before) },
                { key: 'owner_name', label: 'Owner' }, { key: 'due_on', label: 'Due', render: (a) => fmtDate(a.due_on) },
                { key: 'status', label: 'Status', render: (a) => <><Pill value={a.status} />{a.verification?.document && <span className="faint"> {a.verification.document} {a.verification.version}</span>}{a.verification?.workOrder && <span className="faint"> {a.verification.workOrder}</span>}</> },
                { key: 'do', label: '', render: (a) => a.status === 'open' && ['approved', 'startup_review', 'in_service'].includes(c.status) && (manage || a.owner_user_id === me?.userId)
                  ? <div className="stack">{a.kind === 'work_order' && !a.work_order_id && manage && <LinkWorkOrder action={a} facilityId={c.facility_id} onDone={reload} />}<ActionDone action={a} onDone={reload} /></div> : null }]} />
          </section>
          <section className="card">
            <h2>History</h2>
            <ul className="timeline">{c.history.map((h: any) => <li key={h.id}><span className="muted">{fmtDateTime(h.occurred_at)}</span><span><strong>{h.actor}</strong> {humanize(h.action.split('.')[1])}{h.data?.reason ? `: ${h.data.reason}` : ''}</span></li>)}</ul>
          </section>
        </>
      );
    }}</Async>
  );
}

/** Edits a draft or a rejected change (rework). Saving a rejected change returns it to draft as a new revision; screening and submitting then starts a fresh approval round. */
function EditChange({ c, onDone }: { c: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const init = () => ({ title: c.title, description: c.description, justification: c.justification, targetDate: c.target_date ?? '', origin: c.origin, consequences: c.consequences ?? '', qmsImpact: c.qms_impact ?? '',
    resources: c.resources ?? '', responsibilities: c.responsibilities ?? '', customerImpact: c.customer_impact, customerNote: c.customer_note ?? '' });
  const [f, setF] = useState(init);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const act = useAction(async () => { await api.patch(`/api/moc/${c.id}`, { ...f, targetDate: f.targetDate || null }); setOpen(false); onDone(); });
  if (!open) return <section className="card spread"><span className="muted">{c.status === 'rejected' ? 'Address the reviewer’s reasons by editing the change, or attach a better deck and send it again unchanged.' : 'You can still edit the change before it is submitted.'}</span>
    <button onClick={() => { setF(init()); setOpen(true); }}>{c.status === 'rejected' ? 'Rework the change' : 'Edit the change'}</button></section>;
  return (
    <form className="card form" aria-label="Edit the change" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
      <h2>{c.status === 'rejected' ? 'Rework the change' : 'Edit the change'}</h2>
      <label className="field">Title<input id="ed-title" value={f.title} onChange={set('title')} required minLength={3} /></label>
      <label className="field">What will change?<textarea id="ed-desc" value={f.description} onChange={set('description')} required minLength={10} /></label>
      <label className="field">Why?<textarea id="ed-why" value={f.justification} onChange={set('justification')} required minLength={10} /></label>
      <label className="field">Consequences<textarea id="ed-cons" value={f.consequences} onChange={set('consequences')} /></label>
      <label className="field">Quality system<textarea id="ed-qms" value={f.qmsImpact} onChange={set('qmsImpact')} /></label>
      <label className="field">Resources<textarea id="ed-res" value={f.resources} onChange={set('resources')} /></label>
      <label className="field">Responsibilities<textarea id="ed-resp" value={f.responsibilities} onChange={set('responsibilities')} /></label>
      <label className="field">Customers<select id="ed-cust" value={f.customerImpact} onChange={set('customerImpact')}><option value="none">No effect on what customers receive</option><option value="notify">Customers must be told</option><option value="approval">Customers must approve it first</option></select></label>
      {f.customerImpact !== 'none' && <label className="field">Which customers, and what they must be told or approve<textarea id="ed-cust-note" value={f.customerNote} onChange={set('customerNote')} required /></label>}
      <label className="field">Target date<input id="ed-target" type="date" value={f.targetDate} onChange={set('targetDate')} /></label>
      <ErrorNote message={act.error} />
      <div className="row"><button className="primary" disabled={act.busy}>Save changes</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function ScreeningForm({ id, resubmit, onDone }: { id: string; resubmit?: boolean; onDone: () => void }) {
  const qs = useApi<{ key: string; question: string }[]>('/api/moc/screening-questions');
  const [answers, setAnswers] = useState<Record<string, boolean | undefined>>({});
  const act = useAction(async () => { await api.post(`/api/moc/${id}/submit`, { screening: answers }); onDone(); });
  const complete = qs.data && qs.data.every((q) => answers[q.key] !== undefined);
  return (
    <section className="card stack">
      <h2>{resubmit ? 'Screening and resubmission' : 'Screening'}</h2>
      <p className="muted" style={{ margin: 0 }}>Answer every question. The answers set the risk level, who reviews, and the action plan.{resubmit ? ' Submitting starts a new approval round at the next revision; the reviewers who rejected it see it again.' : ''}</p>
      {(qs.data ?? []).map((q) => (
        <fieldset key={q.key} className="spread" style={{ border: 0, borderBottom: '1px solid var(--rule)', padding: '6px 0', margin: 0 }}>
          <legend style={{ float: 'left', padding: 0, maxWidth: '70ch' }}>{q.question}</legend>
          <div className="row">
            {[true, false].map((v) => <label key={String(v)} className="row"><input type="radio" name={q.key} checked={answers[q.key] === v} onChange={() => setAnswers({ ...answers, [q.key]: v })} /> {v ? 'Yes' : 'No'}</label>)}
          </div>
        </fieldset>
      ))}
      <ErrorNote message={act.error} />
      <div><button className="primary" disabled={act.busy || !complete} onClick={() => act.run()}>{resubmit ? 'Resubmit for review' : 'Submit for review'}</button></div>
    </section>
  );
}

function ActionDone({ action, onDone }: { action: any; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const verified = (action.kind === 'document_update' && action.document_id) || (action.kind === 'work_order' && action.work_order_id) || (action.kind === 'training' && action.course_id);
  const act = useAction(async () => { await api.post(`/api/moc-actions/${action.id}/complete`, { note: note || null }); onDone(); });
  if (!open) return <button onClick={() => setOpen(true)}>Mark done</button>;
  return (
    <div className="stack" style={{ minWidth: 240 }}>
      {verified ? <span className="faint">The platform checks the linked record.</span>
        : <textarea id={`note-${action.id}`} aria-label="What was done" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done" />}
      <ErrorNote message={act.error} />
      <div className="row"><button className="primary" disabled={act.busy} onClick={() => act.run()}>Confirm</button><button className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}

function LinkWorkOrder({ action, facilityId, onDone }: { action: any; facilityId: string; onDone: () => void }) {
  const wos = useApi<any[]>(`/api/work-orders?facilityId=${facilityId}`);
  const [woId, setWoId] = useState('');
  const act = useAction(async () => { await api.post(`/api/moc-actions/${action.id}/work-order`, { workOrderId: woId }); onDone(); });
  return (
    <div className="row">
      <select aria-label="Work order" value={woId} onChange={(e) => setWoId(e.target.value)} style={{ maxWidth: 220 }}>
        <option value="">Link a work order…</option>{(wos.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.number} · {w.title}</option>)}
      </select>
      <button disabled={!woId || act.busy} onClick={() => act.run()}>Link</button>
      <ErrorNote message={act.error} />
    </div>
  );
}

function PssrForm({ c, canEdit, onDone }: { c: any; canEdit: boolean; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<number, { response?: string; note?: string }>>(
    Object.fromEntries(c.pssr.map((p: any) => [p.seq, { response: p.response ?? undefined, note: p.note ?? '' }])));
  const act = useAction(async () => {
    const body = Object.entries(answers).filter(([, a]) => a.response).map(([seq, a]) => ({ seq: Number(seq), response: a.response, note: a.note || null }));
    const r = await api.post(`/api/moc/${c.id}/pssr`, { answers: body });
    onDone();
    return r;
  });
  return (
    <section className="card stack">
      <h2>Pre-startup safety review</h2>
      <p className="muted" style={{ margin: 0 }}>Every item must be Yes or N/A. A No blocks startup until it is fixed. When complete, safety and operations sign the startup.</p>
      {c.pssr.map((p: any) => (
        <div key={p.seq} className="stack" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
          <div className="spread"><span>{p.seq}. {p.question}</span>
            <div className="row">{['yes', 'no', 'na'].map((r) => <label key={r} className="row"><input type="radio" name={`pssr-${p.seq}`} disabled={!canEdit} checked={answers[p.seq]?.response === r}
              onChange={() => setAnswers({ ...answers, [p.seq]: { ...answers[p.seq], response: r } })} /> {r === 'na' ? 'N/A' : humanize(r)}</label>)}</div></div>
          {answers[p.seq]?.response && answers[p.seq]?.response !== 'yes' && (
            <input aria-label={`Note for item ${p.seq}`} value={answers[p.seq]?.note ?? ''} placeholder="Explain" disabled={!canEdit}
              onChange={(e) => setAnswers({ ...answers, [p.seq]: { ...answers[p.seq], note: e.target.value } })} />
          )}
          {p.responded_by && <span className="faint" style={{ fontSize: 12 }}>Answered by {p.responded_by}, {fmtDateTime(p.responded_at)}</span>}
        </div>
      ))}
      <ErrorNote message={act.error} />
      {canEdit && <div><button className="primary" disabled={act.busy} onClick={() => act.run()}>Save answers</button></div>}
    </section>
  );
}

function CloseForm({ c, onDone }: { c: any; onDone: () => void }) {
  const id = c.id as string;
  const [note, setNote] = useState('');
  const [achieved, setAchieved] = useState<boolean | null>(null);
  const [evidence, setEvidence] = useState('');
  const act = useAction(async () => { await api.post(`/api/moc/${id}/close`, { note, outcomeAchieved: achieved, evidence }); onDone(); });
  return (
    <section className="card stack">
      <h2>Close the change</h2>
      <label className="field">Outcome<textarea id="close-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="How the change performed in service" /></label>
      <fieldset className="row" style={{ gap: 12, border: 0, padding: 0, margin: 0, flexWrap: 'wrap' }}>
        <legend className="muted">Did it achieve its purpose? (ISO 9001 6.3, 9.1)</legend>
        <label className="row" style={{ gap: 4 }}><input type="radio" name="close-achieved" checked={achieved === true} onChange={() => setAchieved(true)} /> Yes</label>
        <label className="row" style={{ gap: 4 }}><input type="radio" name="close-achieved" checked={achieved === false} onChange={() => setAchieved(false)} /> No (name the new change or corrective action that follows)</label>
      </fieldset>
      {achieved === false && <p className="muted">Name the follow-up by its number (MOC-… or CA-…), or <Link to={`/capa/new?source=change&origin=moc_change:${c.id}&facility=${c.facility_id}&title=${encodeURIComponent(`${c.number} did not achieve its purpose`)}`}>open a corrective action from this change</Link> first.</p>}
      <label className="field">Evidence<textarea id="close-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Measurements, results or records that show it" /></label>
      <ErrorNote message={act.error} />
      <div><button className="primary" disabled={act.busy || note.trim().length < 10 || achieved === null || evidence.trim().length < 10} onClick={() => act.run()}>Close change</button></div>
    </section>
  );
}

const DECK_ACCEPT = '.pptx,.ppt,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint';
const deckMime = (f: File) => f.type || (/\.pptx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : /\.ppt$/i.test(f.name) ? 'application/vnd.ms-powerpoint' : 'application/pdf');

/** The presentation behind the justification (D-159): uploaded deck (every version kept) or a link; changeable only in draft. */
function JustificationDeck({ c, onDone }: { c: any; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState<string>(c.justification_link ?? '');
  const upload = useAction(async () => {
    await api.post('/api/attachments', { subjectType: 'moc_change', subjectId: c.id, fileName: file!.name, mime: deckMime(file!), contentBase64: await fileToBase64(file!) });
    setFile(null); onDone();
  });
  const saveLink = useAction(async () => { await api.put(`/api/moc/${c.id}/presentation-link`, { url: link.trim() || null }); onDone(); });
  const [current, ...older] = c.presentations as any[];
  return (
    <div className="stack justification-deck" style={{ gap: 6, marginBottom: 12 }}>
      <h3 style={{ marginBottom: 0 }}>Justification presentation</h3>
      {current ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="link" onClick={() => api.open(`/api/attachments/${current.id}`)}>{current.file_name}</button>
          <span className="faint">{current.mime === 'application/pdf' ? 'opens in the browser' : 'PowerPoint, downloads'} · {Math.max(1, Math.round(current.size_bytes / 1024))} KB · {current.uploaded_by_name}, {fmtDateTime(current.created_at)}</span>
        </div>
      ) : !c.justification_link && <span className="muted">No presentation attached.</span>}
      {c.justification_link && <a href={c.justification_link} target="_blank" rel="noopener noreferrer">Presentation kept elsewhere</a>}
      {older.length > 0 && <span className="faint">Earlier versions: {older.map((o) => o.file_name).join(', ')}</span>}
      {c.canEditDeck ? (
        <>
          <form className="row" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void upload.run(); }}>
            <input type="file" aria-label="Presentation file (PowerPoint or PDF)" accept={DECK_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button disabled={!file || upload.busy}>{current ? 'Replace presentation' : 'Attach presentation'}</button>
          </form>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input aria-label="Link to a presentation (https)" placeholder="https://… (SharePoint, OneDrive, Google Slides)" value={link} onChange={(e) => setLink(e.target.value)} style={{ flex: '1 1 260px' }} />
            <button disabled={saveLink.busy || link.trim() === (c.justification_link ?? '')} onClick={() => saveLink.run()}>Save link</button>
          </div>
          <ErrorNote message={upload.error ?? saveLink.error} />
        </>
      ) : (c.presentations.length > 0 || c.justification_link) && c.status !== 'draft' && <span className="faint">Reviewers see this deck; changing it means revising the change.</span>}
    </div>
  );
}

