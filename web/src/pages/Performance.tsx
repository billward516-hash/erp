import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Async, Empty, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { useAction, useApi } from '../hooks';

const KIND: Record<string, string> = { review: 'Performance review', check_in: 'Check-in' };
const STATUS: Record<string, [string, 'good' | 'watch' | 'bad' | undefined]> = {
  open: ['Open', 'watch'], shared: ['Waiting for acknowledgement', 'watch'], completed: ['Completed', 'good'], cancelled: ['Cancelled', undefined],
};
const statusPill = (r: any, today: string) => r.status !== 'completed' && r.status !== 'cancelled' && r.due_on < today
  ? <Pill tone="bad" label={`Overdue (due ${r.due_on})`} /> : <Pill tone={STATUS[r.status]?.[1]} label={STATUS[r.status]?.[0] ?? r.status} />;

/** Performance reviews (D-155): mine, my team's, and (HR) everyone's, with the programme's settings. */
export function Performance() {
  const { data, loading, error, reload } = useApi<any>('/api/performance');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'mine';
  const tabs: [string, string][] = [['mine', 'My reviews'], ['team', 'My team'], ...(data?.hr ? [['all', 'Everyone'], ['settings', 'Settings']] as [string, string][] : [])];
  return (
    <>
      <PageHead eyebrow="People" title="Performance"
        sub="Reviews with your manager at the frequency your company sets, check-ins in between, and the goals you agree. Only you, your reviewer and HR see them." />
      <div className="row" role="tablist" aria-label="Performance">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k }, { replace: true })}>{l}</button>)}
      </div>
      <Async loading={loading && !data} error={error}>{() => (
        <>
          {tab === 'mine' && <Mine data={data} />}
          {tab === 'team' && <List rows={data.team} today={data.today} empty="Nobody is waiting for a review from you." answer={data.team.length ? `${data.team.length} review${data.team.length === 1 ? '' : 's'} or check-in${data.team.length === 1 ? '' : 's'} to complete.` : null} />}
          {tab === 'all' && data.all && (
            <>
              <p className="answer">{data.counts.overdue ? `${data.counts.overdue} overdue` : 'Nothing overdue'}; {data.counts.open} open{data.counts.noReviewer ? `, ${data.counts.noReviewer} without a reviewer` : ''}.</p>
              <List rows={data.all} today={data.today} empty="No reviews yet. They open automatically before each is due once the programme is set up." showReviewer />
            </>
          )}
          {tab === 'settings' && data.hr && <Settings s={data.settings} onDone={reload} />}
        </>
      )}</Async>
    </>
  );
}

function Mine({ data }: { data: any }) {
  const open = data.mine.filter((r: any) => r.status === 'open' || r.status === 'shared');
  return (
    <>
      <p className="answer">{open.length ? `${open.length} review${open.length === 1 ? '' : 's'} in progress.` : 'Nothing in progress.'} {data.myGoals.length ? `${data.myGoals.length} open goal${data.myGoals.length === 1 ? '' : 's'}.` : ''}</p>
      <List rows={data.mine} today={data.today} empty="No reviews yet." />
      {data.myGoals.length > 0 && (
        <section className="card stack">
          <h2>My goals</h2>
          <ul style={{ margin: 0 }}>{data.myGoals.map((g: any) => <li key={g.id}><strong>{g.title}</strong>{g.measure ? `: ${g.measure}` : ''}{g.due_on ? ` (by ${g.due_on})` : ''}</li>)}</ul>
        </section>
      )}
    </>
  );
}

function List({ rows, today, empty, answer, showReviewer }: { rows: any[]; today: string; empty: string; answer?: string | null; showReviewer?: boolean }) {
  return (
    <>
      {answer && <p className="answer">{answer}</p>}
      <Table rows={rows} rowKey={(r) => r.id} empty={empty}
        columns={[
          { key: 'employee_name', label: 'Employee', render: (r: any) => <Link to={`/performance/${r.id}`}>{r.employee_name}</Link> },
          { key: 'kind', label: 'What', render: (r: any) => KIND[r.kind] },
          { key: 'due_on', label: 'Due' },
          ...(showReviewer ? [{ key: 'reviewer_name', label: 'Reviewer', render: (r: any) => r.reviewer_name ?? <Pill tone="bad" label="None" /> }] : []),
          { key: 'status', label: 'Status', render: (r: any) => statusPill(r, today) },
          { key: 'ratingLabel', label: 'Rating', render: (r: any) => r.ratingLabel ?? '' },
        ]} />
    </>
  );
}

function Settings({ s, onDone }: { s: any; onDone: () => void }) {
  const [v, setV] = useState({ enabled: s.configured ? s.enabled : true, intervalMonths: s.intervalMonths, anchor: s.anchor, calendarMonth: s.calendarMonth, firstReviewMonths: s.firstReviewMonths,
    checkinMonths: s.checkinMonths, selfAssessment: s.selfAssessment, openDaysBefore: s.openDaysBefore });
  const save = useAction(async () => { await api.put('/api/performance/settings', v); onDone(); });
  const num = (k: keyof typeof v) => (e: any) => setV({ ...v, [k]: Number(e.target.value) });
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return (
    <section className="card stack">
      <h2>How often</h2>
      {!s.configured && <p className="notice warn">Performance reviews are not set up yet. Saving these settings starts them; reviews open automatically before each is due.</p>}
      <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Run performance reviews</label>
      <div className="form-grid">
        <label>Review every (months)<input type="number" min={1} max={36} value={v.intervalMonths} onChange={num('intervalMonths')} /></label>
        <label>Timing
          <select value={v.anchor} onChange={(e) => setV({ ...v, anchor: e.target.value })}>
            <option value="calendar">Everyone in the same month</option><option value="hire_date">On each person’s hire anniversary</option>
          </select>
        </label>
        {v.anchor === 'calendar' && <label>Review month<select value={v.calendarMonth} onChange={num('calendarMonth')}>{months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>}
        <label>First review after hire (months)<input type="number" min={1} max={24} value={v.firstReviewMonths} onChange={num('firstReviewMonths')} /></label>
        <label>Check-ins every (months, 0 for none)<input type="number" min={0} max={12} value={v.checkinMonths} onChange={num('checkinMonths')} /></label>
        <label>Open each review (days before it is due)<input type="number" min={0} max={90} value={v.openDaysBefore} onChange={num('openDaysBefore')} /></label>
      </div>
      <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={v.selfAssessment} onChange={(e) => setV({ ...v, selfAssessment: e.target.checked })} /> Ask employees for a self-assessment</label>
      <p className="faint" style={{ margin: 0 }}>The reviewer is the employee’s manager (set on the employee or imported from payroll), else their department head; HR assigns one otherwise. Reminders to reviewers and to HR are set under Admin → Reminders.</p>
      <div className="row"><button className="primary" disabled={save.busy} onClick={() => save.run()}>Save settings</button></div>
      <ErrorNote message={save.error} />
    </section>
  );
}

/** One review or check-in: what each person may see and do depends on whether they are the employee, the reviewer or HR. */
export function PerformanceDetail() {
  const { id } = useParams();
  const { data: r, loading, error, reload } = useApi<any>(`/api/performance/${id}`);
  return (
    <Async loading={loading && !r} error={error}>{() => (
      <>
        <PageHead eyebrow={KIND[r.kind]} title={r.employee_name} sub={`${r.job_title ?? ''}${r.job_title ? ' · ' : ''}due ${r.due_on} · reviewer ${r.reviewer_name ?? 'not assigned'}`} />
        <p className="answer">{r.status === 'open' ? (r.role === 'employee' ? (r.kind === 'review' && r.selfAssessmentOn ? 'Your reviewer is preparing this. Add your self-assessment below.' : 'Your reviewer is preparing this.') : 'Write the assessment, agree goals, then share it.')
          : r.status === 'shared' ? (r.role === 'employee' ? 'Read your review and acknowledge it. You can add a comment.' : 'Shared; waiting for the employee to acknowledge it.')
          : r.status === 'completed' ? `Completed${r.acknowledged_at ? ', acknowledged by the employee' : ''}.` : `Cancelled: ${r.cancelled_reason}`}</p>
        {r.kind === 'review' && r.selfAssessmentOn && <SelfAssessment r={r} onDone={reload} />}
        <Assessment r={r} onDone={reload} />
        <Goals r={r} onDone={reload} />
        {r.status === 'shared' && r.role === 'employee' && <Acknowledge id={r.id} onDone={reload} />}
        {r.employee_comment && <section className="card"><h2>Employee’s comment</h2><p style={{ whiteSpace: 'pre-wrap' }}>{r.employee_comment}</p></section>}
        {r.role === 'hr' && <HrPanel r={r} onDone={reload} />}
      </>
    )}</Async>
  );
}

function SelfAssessment({ r, onDone }: { r: any; onDone: () => void }) {
  const [text, setText] = useState(r.self_assessment ?? '');
  const save = useAction(async () => { await api.post(`/api/performance/${r.id}/self-assessment`, { text }); onDone(); });
  const editable = r.role === 'employee' && r.status === 'open';
  return (
    <section className="card stack">
      <h2>Self-assessment</h2>
      {editable ? (
        <>
          <label htmlFor="self">What went well, what was hard, and what you would like to work on</label>
          <textarea id="self" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row"><button className="primary" disabled={save.busy || !text.trim()} onClick={() => save.run()}>{r.self_submitted_at ? 'Update self-assessment' : 'Submit self-assessment'}</button></div>
          <ErrorNote message={save.error} />
        </>
      ) : r.self_assessment ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.self_assessment}</p> : <p className="muted" style={{ margin: 0 }}>None submitted.</p>}
    </section>
  );
}

function Assessment({ r, onDone }: { r: any; onDone: () => void }) {
  const [v, setV] = useState({ rating: r.rating ?? '', strengths: r.strengths ?? '', development: r.development ?? '', summary: r.summary ?? '' });
  const save = useAction(async () => { await api.put(`/api/performance/${r.id}/assessment`, { ...v, rating: v.rating ? Number(v.rating) : null }); onDone(); });
  const share = useAction(async () => { await api.put(`/api/performance/${r.id}/assessment`, { ...v, rating: v.rating ? Number(v.rating) : null }); await api.post(`/api/performance/${r.id}/share`, {}); onDone(); });
  const editable = r.role !== 'employee' && r.status === 'open';
  if (!editable && r.role === 'employee' && r.status === 'open') return null;
  return (
    <section className="card stack">
      <h2>{r.kind === 'review' ? 'Assessment' : 'Check-in notes'}</h2>
      {editable ? (
        <>
          {r.kind === 'review' && (
            <label>Overall rating
              <select value={v.rating} onChange={(e) => setV({ ...v, rating: e.target.value })}>
                <option value="">Choose…</option>{r.ratings.map((l: string, i: number) => <option key={l} value={i + 1}>{i + 1}. {l}</option>)}
              </select>
            </label>
          )}
          {r.kind === 'review' && <label>Strengths<textarea rows={3} value={v.strengths} onChange={(e) => setV({ ...v, strengths: e.target.value })} /></label>}
          {r.kind === 'review' && <label>To develop<textarea rows={3} value={v.development} onChange={(e) => setV({ ...v, development: e.target.value })} /></label>}
          <label>{r.kind === 'review' ? 'Summary' : 'What was discussed'}<textarea rows={4} value={v.summary} onChange={(e) => setV({ ...v, summary: e.target.value })} /></label>
          <div className="row">
            <button disabled={save.busy} onClick={() => save.run()}>Save draft</button>
            <button className="primary" disabled={share.busy || !v.summary.trim() || (r.kind === 'review' && !v.rating)} onClick={() => share.run()}>{r.kind === 'review' ? 'Share with the employee' : 'Complete check-in'}</button>
          </div>
          <ErrorNote message={save.error ?? share.error} />
        </>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          {r.ratingLabel && <p style={{ margin: 0 }}><strong>Rating:</strong> {r.rating}. {r.ratingLabel}</p>}
          {r.strengths && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}><strong>Strengths:</strong> {r.strengths}</p>}
          {r.development && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}><strong>To develop:</strong> {r.development}</p>}
          {r.summary && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.summary}</p>}
        </div>
      )}
    </section>
  );
}

function Goals({ r, onDone }: { r: any; onDone: () => void }) {
  const [g, setG] = useState({ title: '', measure: '', dueOn: '' });
  const add = useAction(async () => { await api.post(`/api/performance/${r.id}/goals`, { title: g.title, measure: g.measure || null, dueOn: g.dueOn || null }); setG({ title: '', measure: '', dueOn: '' }); onDone(); });
  const outcome = useAction(async (goalId: string, status: string) => { await api.put(`/api/performance/${r.id}/goals/${goalId}`, { status }); onDone(); });
  const canAdd = r.status === 'open';
  const reviewer = r.role !== 'employee' && r.status === 'open';
  if (!r.goals.length && !canAdd) return null;
  return (
    <section className="card stack">
      <h2>Goals</h2>
      {r.goals.length ? (
        <ul style={{ margin: 0 }} className="stack">
          {r.goals.map((x: any) => (
            <li key={x.id}>
              <strong>{x.title}</strong>{x.measure ? `: ${x.measure}` : ''}{x.due_on ? ` (by ${x.due_on})` : ''} <Pill tone={x.status === 'met' ? 'good' : x.status === 'open' ? undefined : 'watch'} label={x.status.replace('_', ' ')} />
              {reviewer && (
                <select aria-label={`Outcome of ${x.title}`} value={x.status} onChange={(e) => outcome.run(x.id, e.target.value)} style={{ marginLeft: 8 }}>
                  {['open', 'met', 'partly_met', 'not_met', 'dropped'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </select>
              )}
            </li>
          ))}
        </ul>
      ) : <Empty>No goals yet.</Empty>}
      {canAdd && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input aria-label="New goal" placeholder="Goal" value={g.title} onChange={(e) => setG({ ...g, title: e.target.value })} />
          <input aria-label="How it is measured" placeholder="Measure" value={g.measure} onChange={(e) => setG({ ...g, measure: e.target.value })} />
          <input aria-label="Goal due date" type="date" value={g.dueOn} onChange={(e) => setG({ ...g, dueOn: e.target.value })} />
          <button disabled={add.busy || !g.title.trim()} onClick={() => add.run()}>Add goal</button>
        </div>
      )}
      <ErrorNote message={add.error ?? outcome.error} />
    </section>
  );
}

function Acknowledge({ id, onDone }: { id: string; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const ack = useAction(async () => { await api.post(`/api/performance/${id}/acknowledge`, { comment: comment || null }); onDone(); });
  return (
    <section className="card stack">
      <h2>Acknowledge</h2>
      <p className="muted" style={{ margin: 0 }}>Acknowledging says you have read the review; it does not mean you agree with all of it.</p>
      <label htmlFor="ack-comment">Your comment (optional)</label>
      <textarea id="ack-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="row"><button className="primary" disabled={ack.busy} onClick={() => ack.run()}>Acknowledge</button></div>
      <ErrorNote message={ack.error} />
    </section>
  );
}

function HrPanel({ r, onDone }: { r: any; onDone: () => void }) {
  const users = useApi<any[]>('/api/users');
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(async (body: any) => { await api.post(`/api/performance/${r.id}/hr`, body); onDone(); });
  if (r.status === 'completed' || r.status === 'cancelled') return null;
  return (
    <section className="card stack">
      <h2>HR</h2>
      {r.status === 'open' && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select aria-label="Reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
            <option value="">Choose a reviewer…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
          <button disabled={!reviewer || act.busy} onClick={() => act.run({ action: 'assign', reviewerUserId: reviewer })}>Assign reviewer</button>
        </div>
      )}
      {r.status === 'shared' && <div className="row"><button disabled={act.busy} onClick={() => act.run({ action: 'close_unacknowledged' })}>Close without acknowledgement</button></div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="Reason to cancel" placeholder="Reason (leaver, long leave…)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button disabled={!reason.trim() || act.busy} onClick={() => act.run({ action: 'cancel', reason })}>Cancel this review</button>
      </div>
      <ErrorNote message={act.error} />
    </section>
  );
}
