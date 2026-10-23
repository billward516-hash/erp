import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Attachments, RFQ_ACCEPT } from '../components/Attachments';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, string> = { draft: 'Draft', pending_approval: 'Waiting for approval', approved: 'Approved, not started', active: 'In force', expired: 'Expired: needs a decision', permanent_pending: 'Becoming permanent',
  reverted: 'Reverted', made_permanent: 'Made permanent', cancelled: 'Cancelled', rejected: 'Not approved' };
const LEVEL: Record<string, 'good' | 'watch' | 'bad'> = { green: 'good', amber: 'watch', red: 'bad', expired: 'bad' };
const left = (t: any) => (['active', 'approved', 'expired', 'permanent_pending'].includes(t.status) ? (t.days_left < 0 ? `${-t.days_left} days over` : t.days_left === 0 ? 'Ends today' : `${t.days_left} days`) : '—');
const today = () => new Date().toISOString().slice(0, 10);

/** The temporary SOP changes tab on the Changes page (SC-006 C). */
export function TempChangeList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [live, setLive] = useState(true);
  const { data, loading, error } = useApi<any[]>(`/api/temporary-changes${live ? '?live=true' : ''}`);
  const rows = data ?? [];
  return (
    <section className="stack" aria-label="Temporary procedure changes">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>A procedure changed for a stated period. Readers see a banner with the end date; the owner is alerted as it nears, and an expired change must be reverted, extended or made permanent.</p>
        {can('moc.request') && <button className="primary" onClick={() => nav('/changes/temporary/new')}>New temporary change</button>}
      </div>
      <Kpis items={[{ label: 'In force', value: rows.filter((t) => t.status === 'active').length }, { label: 'Ending within 14 days', value: rows.filter((t) => ['amber', 'red'].includes(t.level)).length, tone: rows.some((t) => t.level === 'red') ? 'bad' : undefined },
        { label: 'Past the end date', value: rows.filter((t) => t.level === 'expired').length, tone: rows.some((t) => t.level === 'expired') ? 'bad' : 'good' }]} />
      <label className="row"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Only changes in force or waiting to start</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={rows} rowKey={(t) => t.id} onRow={(t) => nav(`/changes/temporary/${t.id}`)} exception={(t) => t.level === 'expired'} empty="No temporary changes."
          columns={[{ key: 'number', label: 'Change', render: (t) => <strong>{t.number}</strong> }, { key: 'doc_number', label: 'Procedure' }, { key: 'title', label: 'What' },
            { key: 'expires_on', label: 'Ends', render: (t) => fmtDate(t.expires_on) },
            { key: 'days_left', label: 'Time left', render: (t) => (t.level ? <Pill tone={LEVEL[t.level]} label={left(t)} /> : '—'), value: (t) => (t.level ? t.days_left : null) },
            { key: 'status', label: 'Status', render: (t) => STATUS[t.status], value: (t) => STATUS[t.status] }, { key: 'owner_name', label: 'Owner' }]} />
      )}</Async>
    </section>
  );
}

export function NewTempChange() {
  const nav = useNavigate();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const docs = useApi<any[]>('/api/documents?status=active');
  const allowed = (facilities.data ?? []).filter((f) => can('moc.request', f.id));
  const [f, setF] = useState({ facilityId: '', documentId: '', title: '', whatChanges: '', reason: '', startsOn: today(), expiresOn: '' });
  const facilityId = f.facilityId || allowed[0]?.id || '';
  const act = useAction(async () => { const t = await api.post('/api/temporary-changes', { ...f, facilityId }); nav(`/changes/temporary/${t.id}`); });
  const sops = (docs.data ?? []).filter((d) => ['sop', 'work_instruction', 'procedure', 'method', 'repair_procedure', 'manual', 'troubleshooting_guide'].includes(d.doc_type));
  return (
    <>
      <PageHead eyebrow="Management of change" title="New temporary change" sub="Say what is different, why, and for how long. Someone else approves it before it takes effect." />
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Site<select id="tc-fac" value={facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>{allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
            <label className="field">Procedure<select id="tc-doc" value={f.documentId} onChange={(e) => setF({ ...f, documentId: e.target.value })} required><option value="">Choose…</option>{sops.map((d) => <option key={d.id} value={d.id}>{d.doc_number} · {d.title}</option>)}</select></label>
            <label className="field">Starts<input id="tc-start" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} required /></label>
            <label className="field">Ends<input id="tc-end" type="date" value={f.expiresOn} min={f.startsOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} required /></label>
          </div>
          <label className="field">Title<input id="tc-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /></label>
          <label className="field">What is different while it is in force<textarea id="tc-what" value={f.whatChanges} onChange={(e) => setF({ ...f, whatChanges: e.target.value })} required minLength={10} /></label>
          <label className="field">Why it is needed<textarea id="tc-why" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} /></label>
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy || !f.documentId}>Save draft</button></div>
        </form>
      </section>
    </>
  );
}

export function TempChangeDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const myId = (me as any)?.id ?? (me as any)?.userId;
  const { data: t, loading, error, reload } = useApi<any>(`/api/temporary-changes/${id}`);
  const people = useApi<any[]>('/api/users');
  const nav = useNavigate();
  const [approver, setApprover] = useState('');
  const [ext, setExt] = useState({ date: '', reason: '' });
  const [note, setNote] = useState('');
  const submit = useAction(async () => { await api.post(`/api/temporary-changes/${id}/submit`, { approverId: approver }); await reload(); });
  const extend = useAction(async () => { await api.post(`/api/temporary-changes/${id}/extend`, { newExpiresOn: ext.date, reason: ext.reason, approverId: approver }); setExt({ date: '', reason: '' }); await reload(); });
  const revert = useAction(async () => { await api.post(`/api/temporary-changes/${id}/revert`, { note }); setNote(''); await reload(); });
  const cancel = useAction(async () => { await api.post(`/api/temporary-changes/${id}/cancel`, { reason: note }); setNote(''); await reload(); });
  const permanent = useAction(async () => { const r = await api.post(`/api/temporary-changes/${id}/make-permanent`, {}); nav(`/changes/${r.change.id}`); });
  return (
    <Async loading={loading && !t} error={error}>{() => {
      const live = ['active', 'expired', 'permanent_pending'].includes(t.status);
      const mine = t.owner_user_id === myId || t.canManage;
      const err = submit.error ?? extend.error ?? revert.error ?? cancel.error ?? permanent.error;
      const choose = (
        <label className="field">Approver (a change coordinator)<select id="tc-approver" value={approver} onChange={(e) => setApprover(e.target.value)}><option value="">Choose…</option>{(people.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
      );
      return (
        <>
          <PageHead eyebrow={`Temporary change · ${t.facility_code}`} title={`${t.number} · ${t.title}`} sub={<><Link to={`/documents/${t.document_id}`}>{t.doc_number} {t.document_title}</Link> · <Pill tone={t.level ? LEVEL[t.level] : 'neutral'} label={STATUS[t.status]} /> · owner {t.owner_name}</>} />
          {t.level === 'expired' && <div className="notice error" role="alert">This change ended on {fmtDate(t.expires_on)} and is still on the procedure. Revert it, request an extension or make it permanent.</div>}
          <Kpis items={[{ label: 'Starts', value: fmtDate(t.starts_on) }, { label: 'Ends', value: fmtDate(t.expires_on), tone: t.level ? LEVEL[t.level] : undefined, note: left(t) !== '—' ? left(t) : undefined },
            { label: 'Extensions', value: t.extensions, tone: t.extensions >= 2 ? 'watch' : undefined }, { label: 'Longest single period', value: `${t.ceilingDays} days` }]} />
          {t.extensions >= 2 && <div className="notice warn">Extended {t.extensions} times: if this is still needed, make it permanent instead.</div>}
          <section className="card stack"><h2>What is different</h2><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{t.what_changes}</p><h3>Why</h3><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{t.reason}</p>
            {t.change_number && <p>Change <Link to={`/changes/${t.change_id}`}>{t.change_number}</Link> ({t.change_status?.replace('_', ' ')})</p>}
            {t.close_note && <p className="muted">Closed: {t.close_note}</p>}
            {t.pending_expires_on && <p className="notice warn">Extension to {fmtDate(t.pending_expires_on)} is waiting for {t.approver_name}: {t.pending_reason}</p>}</section>
          {mine && (
            <section className="card stack">
              <h2>Next step</h2>
              {['draft', 'rejected'].includes(t.status) && <div className="row">{choose}<button className="primary" disabled={submit.busy || !approver} onClick={() => submit.run()}>Submit for approval</button></div>}
              {t.status === 'pending_approval' && <p className="muted">Waiting for {t.approver_name} to approve. It takes effect on approval.</p>}
              {['active', 'expired'].includes(t.status) && !t.pending_expires_on && (
                <div className="stack"><h3>Extend</h3>
                  <div className="row"><label className="field">New end date<input id="tc-ext-date" type="date" min={today()} value={ext.date} onChange={(e) => setExt({ ...ext, date: e.target.value })} /></label>
                    <label className="field" style={{ flex: '1 1 260px' }}>Reason<input id="tc-ext-reason" value={ext.reason} onChange={(e) => setExt({ ...ext, reason: e.target.value })} /></label>{choose}
                    <button disabled={extend.busy || !ext.date || ext.reason.trim().length < 5 || !approver} onClick={() => extend.run()}>Request extension</button></div></div>
              )}
              {['active', 'expired'].includes(t.status) && <div><button disabled={permanent.busy} onClick={() => permanent.run()}>Make it permanent (opens a change)</button></div>}
              {(live || t.status === 'approved' || ['draft', 'pending_approval', 'rejected'].includes(t.status)) && (
                <div className="row"><input id="tc-note" aria-label="Note" placeholder={live ? 'Confirm the procedure is back to its approved form and people have been told' : 'Reason for cancelling'} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 360px' }} />
                  {(live || t.status === 'approved') && <button disabled={revert.busy || note.trim().length < 5} onClick={() => revert.run()}>Revert: procedure is back to normal</button>}
                  {['draft', 'pending_approval', 'rejected'].includes(t.status) && <button className="danger" disabled={cancel.busy || note.trim().length < 3} onClick={() => cancel.run()}>Cancel</button>}</div>
              )}
              <ErrorNote message={err} />
            </section>
          )}
          <section className="card"><h2>History</h2>
            <Table tools={false} rows={t.events} rowKey={(e) => `${e.kind}${e.at}`} empty="Nothing yet." columns={[{ key: 'at', label: 'When', render: (e) => fmtDateTime(e.at) }, { key: 'kind', label: 'What', render: (e) => e.kind.replace(/_/g, ' ') },
              { key: 'to_date', label: 'Dates', render: (e) => (e.to_date ? `${e.from_date ? `${fmtDate(e.from_date)} → ` : ''}${fmtDate(e.to_date)}` : '') }, { key: 'reason', label: 'Reason' }, { key: 'by_name', label: 'By' }]} /></section>
          <Attachments subjectType="temporary_change" subjectId={t.id} title="Files (marked-up pages, approvals, photos)" accept={RFQ_ACCEPT} />
        </>
      );
    }}</Async>
  );
}
