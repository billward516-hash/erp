import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Async, Empty, ErrorNote, PageHead, Pill } from '../components/ui';
import { fmtDateTime, roleLabel } from '../format';
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
    </>
  );
}

function ApprovalCard({ q, onDone }: { q: any; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const act = useAction(async (decision: 'approve' | 'reject') => { await api.post(`/api/approvals/steps/${q.stepId}/decide`, { decision, comment: comment || null }); onDone(); });
  const link = q.subjectType === 'moc_change' ? `/changes/${q.subjectId}` : null;
  return (
    <section className="card stack">
      <div className="spread">
        <div>
          <div className="eyebrow">{q.purpose === 'moc.startup' ? 'Startup authorization' : 'Change review'} · {q.label}</div>
          <h2 style={{ margin: 0 }}>{link ? <Link to={link}>{q.subject?.number} {q.subject?.title}</Link> : q.subjectType}</h2>
        </div>
        <div className="row">{q.subject?.risk_level && <Pill value={q.subject.risk_level} label={`${q.subject.risk_level} risk`} />}<span className="faint">Requested {fmtDateTime(q.requestedAt)}</span></div>
      </div>
      <label className="field">Comment (required to reject)<textarea id={`c-${q.stepId}`} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What you checked, conditions, or why you reject" /></label>
      <ErrorNote message={act.error} />
      <div className="row">
        <button className="primary" disabled={act.busy} onClick={() => act.run('approve')}>Approve as {roleLabel(q.role)}</button>
        <button className="danger" disabled={act.busy || !comment.trim()} onClick={() => act.run('reject')}>Reject</button>
      </div>
    </section>
  );
}
