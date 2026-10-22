import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Async, Empty, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, roleLabel } from '../format';
import { useAction, useApi } from '../hooks';

export function Approvals() {
  const { data, loading, error, reload } = useApi<any[]>('/api/approvals/queue');
  return (
    <>
      <PageHead eyebrow="Approvals" title="Waiting for my sign-off" sub="Only steps you can sign right now are listed: earlier stages are done, you hold the role, and you did not raise the request." />
      <Async loading={loading} error={error}>{() => (
        data!.length ? <div className="stack">{data!.map((q) => <ApprovalCard key={q.stepId} q={q} onDone={reload} />)}</div>
          : <div className="card"><Empty>Nothing is waiting for you.</Empty></div>
      )}</Async>
      <Delegations />
    </>
  );
}

function ApprovalCard({ q, onDone }: { q: any; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const act = useAction(async (decision: 'approve' | 'reject') => { await api.post(`/api/approvals/steps/${q.stepId}/decide`, { decision, comment: comment || null }); onDone(); });
  const link = q.subjectType === 'moc_change' ? `/changes/${q.subjectId}` : q.subjectType === 'purchase_request' ? `/purchasing/requests/${q.subjectId}` : q.subjectType === 'quote' ? `/sales/quotes/${q.subjectId}` : null;
  const kind = q.subjectType === 'quote' ? `Quote pricing for ${q.subject?.customer_name ?? 'a customer'}` : q.subjectType === 'purchase_request' ? 'Purchase request' : q.purpose === 'moc.startup' ? 'Startup authorization' : 'Change review';
  return (
    <section className="card stack">
      <div className="spread">
        <div>
          <div className="eyebrow">{kind} · {q.label}{q.onBehalfOf ? ` · on behalf of ${q.onBehalfOf.name}` : ''}</div>
          <h2 style={{ margin: 0 }}>{link ? <Link to={link}>{q.subject?.number} {q.subject?.title}</Link> : q.subjectType}</h2>
        </div>
        <div className="row">{q.subject?.risk_level && <Pill value={q.subject.risk_level} label={`${q.subject.risk_level} risk`} />}
          {q.subject?.total != null && <strong>{fmtMoney(q.subject.total)}{q.subject.spend_type === 'capex' ? ' capital' : ''}</strong>}
          {q.subject?.requested_by && <span className="muted">from {q.subject.requested_by}</span>}
          {q.subject?.approval_reasons?.length > 0 && <span className="muted">{q.subject.approval_reasons.join('; ')}</span>}<span className="faint">Requested {fmtDateTime(q.requestedAt)}</span></div>
      </div>
      <label className="field">Comment (required to reject)<textarea id={`c-${q.stepId}`} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What you checked, conditions, or why you reject" /></label>
      <ErrorNote message={act.error} />
      <div className="row">
        <button className="primary" disabled={act.busy} onClick={() => act.run('approve')}>Approve as {roleLabel(q.role)}{q.onBehalfOf ? ` for ${q.onBehalfOf.name}` : ''}</button>
        <button className="danger" disabled={act.busy || !comment.trim()} onClick={() => act.run('reject')}>Reject</button>
      </div>
    </section>
  );
}

/** Hand your sign-offs to someone else while you are away; their signature records that it was on your behalf. */
function Delegations() {
  const list = useApi<any[]>('/api/approval-delegations');
  const users = useApi<any[]>('/api/users');
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ delegateUserId: '', startsOn: today, endsOn: '', reason: '' });
  const add = useAction(async () => { await api.post('/api/approval-delegations', f); setF({ ...f, delegateUserId: '', endsOn: '', reason: '' }); await list.reload(); });
  const revoke = useAction(async (id: string) => { await api.post(`/api/approval-delegations/${id}/revoke`); await list.reload(); });
  return (
    <section className="card stack">
      <h2>Away? Delegate your sign-offs</h2>
      <Async loading={list.loading && !list.data} error={list.error}>{() => (
        <Table rows={list.data ?? []} empty="No delegations."
          columns={[{ key: 'delegator', label: 'From' }, { key: 'delegate', label: 'To' }, { key: 'dates', label: 'Dates', render: (d) => `${fmtDate(d.starts_on)} – ${fmtDate(d.ends_on)}` },
            { key: 'reason', label: 'Reason' },
            { key: 'state', label: '', render: (d) => (d.revoked_at ? <Pill tone="neutral" label="Ended" /> : d.active ? <Pill tone="good" label="Active" /> : <Pill tone="info" label="Scheduled" />) },
            { key: 'end', label: '', render: (d) => (!d.revoked_at ? <button onClick={() => revoke.run(d.id)} disabled={revoke.busy}>End</button> : null) }]} />
      )}</Async>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
        <div className="form-grid">
          <label className="field">Delegate to<select id="del-user" value={f.delegateUserId} onChange={(e) => setF({ ...f, delegateUserId: e.target.value })} required>
            <option value="">Choose a person…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
          <label className="field">From<input id="del-from" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} required /></label>
          <label className="field">Until<input id="del-to" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} required /></label>
          <label className="field">Reason<input id="del-reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={3} placeholder="e.g. vacation" /></label>
        </div>
        <ErrorNote message={add.error ?? revoke.error} />
        <div><button disabled={add.busy}>Delegate</button></div>
      </form>
    </section>
  );
}
