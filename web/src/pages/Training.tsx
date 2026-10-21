import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Empty, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const KIND: Record<string, string> = {
  video: 'Video', self_study: 'Self-study', instructor_led: 'Classroom', ojt_shadowing: 'On-the-job shadowing', practical_evaluation: 'Practical evaluation', assessment: 'Assessment',
};

export function Training() {
  const nav = useNavigate();
  const { me, can } = useAuth();
  const tabs = [...(me?.employeeId ? ['mine', 'quals'] : []), ...(can('learning.view_records') ? ['records'] : [])] as string[];
  const [tab, setTab] = useState(tabs[0] ?? 'mine');
  const mine = useApi<any[]>(tab === 'mine' && me?.employeeId ? '/api/enrollments?mine=true' : null);
  const quals = useApi<any>(tab === 'quals' && me?.employeeId ? `/api/employees/${me.employeeId}/qualifications` : null);
  const records = useApi<any[]>(tab === 'records' ? '/api/enrollments' : null);
  const enrollmentColumns = [
    { key: 'code', label: 'Course' }, { key: 'title', label: 'Title' }, { key: 'version_no', label: 'Ver', numeric: true },
    { key: 'status', label: 'Status', render: (e: any) => <Pill value={e.status} /> },
    { key: 'due_on', label: 'Due', render: (e: any) => <>{fmtDate(e.due_on)}{e.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> },
  ];
  return (
    <>
      <PageHead eyebrow="Training" title="Training and qualifications" sub="Completing a course does not authorize work on equipment; an authorized person grants qualifications." />
      {tabs.length > 1 && (
        <div className="row" role="tablist">
          {tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>
            {t === 'mine' ? 'My training' : t === 'quals' ? 'My qualifications' : 'Team records'}</button>)}
        </div>
      )}
      {tab === 'mine' && <section className="card"><Async loading={mine.loading} error={mine.error}>{() => (
        <Table rows={mine.data ?? []} onRow={(e) => nav(`/training/enrollments/${e.id}`)} exception={(e) => e.overdue} empty="No training assigned to you." columns={enrollmentColumns} />
      )}</Async></section>}
      {tab === 'quals' && <section className="card stack"><Async loading={quals.loading} error={quals.error}>{() => (
        <>
          <Table rows={quals.data.qualifications} empty="No qualifications on record."
            columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Qualification' }, { key: 'status', label: 'Status', render: (q) => <Pill value={q.status} /> },
              { key: 'effectiveOn', label: 'Since', render: (q) => fmtDate(q.effectiveOn) }, { key: 'expiresOn', label: 'Expires', render: (q) => (q.expiresOn ? fmtDate(q.expiresOn) : 'No expiry') },
              { key: 'certificate', label: '', render: (q) => (q.certificate ? <button onClick={() => api.open(`/api/certificates/${q.certificate.id}/pdf`)}>Certificate {q.certificate.number}</button> : null) }]} />
          {quals.data.externalCredentials.length > 0 && <>
            <h3>External credentials</h3>
            <Table rows={quals.data.externalCredentials} columns={[{ key: 'name', label: 'Credential' }, { key: 'issuer', label: 'Issued by' }, { key: 'expires_on', label: 'Expires', render: (c) => fmtDate(c.expires_on) }]} />
          </>}
        </>
      )}</Async></section>}
      {tab === 'records' && <section className="card"><Async loading={records.loading} error={records.error}>{() => (
        <Table rows={records.data ?? []} onRow={(e) => nav(`/training/enrollments/${e.id}`)} exception={(e) => e.overdue}
          columns={[{ key: 'employee', label: 'Employee' }, ...enrollmentColumns]} />
      )}</Async></section>}
    </>
  );
}

export function EnrollmentDetail() {
  const { id } = useParams();
  const { me, can } = useAuth();
  const { data: n, loading, error, reload } = useApi<any>(`/api/enrollments/${id}`);
  const [quiz, setQuiz] = useState<string | null>(null);
  return (
    <Async loading={loading && !n} error={error}>{() => {
      const self = me?.employeeId === n.employee_id;
      return (
        <>
          <PageHead eyebrow={`${n.course_code} · ${n.employee_name}`} title={n.course_title} actions={<Pill value={n.status} />}
            sub={n.due_on ? `Due ${fmtDate(n.due_on)}` : undefined} />
          {n.status === 'completed' && <div className="notice ok">Training completed {fmtDateTime(n.completed_at)}. A qualification still has to be granted by an authorized person.</div>}
          <div className="stack">
            {n.events.map((e: any) => {
              const latest = e.completions[e.completions.length - 1];
              const done = e.kind === 'practical_evaluation' || e.kind === 'assessment' ? latest?.outcome === 'passed' : !!latest;
              return (
                <section key={e.id} className="card stack">
                  <div className="spread">
                    <div><div className="eyebrow">{e.seq}. {KIND[e.kind]}</div><h2 style={{ margin: 0 }}>{e.title}</h2></div>
                    <div className="row">{done ? <Pill tone="good" label={humanize(latest.outcome)} /> : latest ? <Pill tone="watch" label={humanize(latest.outcome)} /> : <Pill label="Not done" />}</div>
                  </div>
                  {e.document_id && <div><button onClick={async () => { const d = await api.get(`/api/documents/${e.document_id}`); await api.download(`/api/document-versions/${d.current_version_id}/download`, d.doc_number); }}>Open {e.doc_number}</button></div>}
                  {e.completions.map((c: any) => (
                    <div key={c.id} className="faint" style={{ fontSize: 12.5 }}>{humanize(c.outcome)} · {fmtDateTime(c.completedAt)} · recorded by {c.recordedBy}{c.attestation ? ` · “${c.attestation}”` : ''}</div>
                  ))}
                  {e.attempts.length > 0 && <div className="faint" style={{ fontSize: 12.5 }}>Attempts: {e.attempts.map((a: any) => `#${a.attemptNo} ${a.score}% ${a.passed ? 'passed' : 'not passed'}`).join(' · ')}</div>}
                  {!done && n.status !== 'cancelled' && (
                    <EventAction e={e} self={self} enrollmentId={n.id} canInstruct={can('learning.instruct')} canEvaluate={can('learning.evaluate')}
                      onTakeQuiz={() => setQuiz(e.id)} onDone={reload} />
                  )}
                  {quiz === e.id && <Quiz enrollmentId={n.id} eventId={e.id} onDone={() => { setQuiz(null); void reload(); }} />}
                </section>
              );
            })}
          </div>
        </>
      );
    }}</Async>
  );
}

function EventAction({ e, self, enrollmentId, canInstruct, canEvaluate, onTakeQuiz, onDone }: {
  e: any; self: boolean; enrollmentId: string; canInstruct: boolean; canEvaluate: boolean; onTakeQuiz: () => void; onDone: () => void;
}) {
  const [outcome, setOutcome] = useState('passed');
  const [attestation, setAttestation] = useState('');
  const act = useAction(async (body: Record<string, unknown>) => { await api.post(`/api/enrollments/${enrollmentId}/events/${e.id}/complete`, body); onDone(); });
  if (e.kind === 'assessment') return self ? <div><button className="primary" onClick={onTakeQuiz}>Take the assessment</button></div> : <p className="muted">The learner takes this assessment.</p>;
  if (e.completion_by === 'learner' && (self || canInstruct)) return <div className="row"><button className="primary" disabled={act.busy} onClick={() => act.run({})}>{self ? 'I have completed this' : 'Record as completed'}</button><ErrorNote message={act.error} /></div>;
  if (e.completion_by === 'instructor') {
    if (self) return <p className="muted">A trainer records this for you.</p>;
    if (!canInstruct) return null;
    return <div className="row"><button className="primary" disabled={act.busy} onClick={() => act.run({})}>{e.kind === 'instructor_led' ? 'Record attendance' : 'Sign off shadowing'}</button><ErrorNote message={act.error} /></div>;
  }
  if (e.completion_by === 'evaluator') {
    if (self) return <p className="muted">An evaluator observes and signs this. You cannot sign your own evaluation.</p>;
    if (!canEvaluate) return null;
    return (
      <form className="form" onSubmit={(ev) => { ev.preventDefault(); void act.run({ outcome, attestation }); }}>
        <div className="row">{[['passed', 'Competent'], ['not_yet_competent', 'Not yet competent']].map(([v, l]) => (
          <label key={v} className="row"><input type="radio" name={`o-${e.id}`} checked={outcome === v} onChange={() => setOutcome(v!)} /> {l}</label>))}</div>
        <label className="field">What you observed (required)<textarea id={`att-${e.id}`} value={attestation} onChange={(ev) => setAttestation(ev.target.value)} minLength={10} required /></label>
        <ErrorNote message={act.error} />
        <div><button className="primary" disabled={act.busy}>Sign evaluation</button></div>
      </form>
    );
  }
  return null;
}

function Quiz({ enrollmentId, eventId, onDone }: { enrollmentId: string; eventId: string; onDone: () => void }) {
  const { data, loading, error } = useApi<any>(`/api/enrollments/${enrollmentId}/events/${eventId}/assessment`);
  const [answers, setAnswers] = useState<Record<string, number[]>>({});
  const [result, setResult] = useState<any>(null);
  const act = useAction(async () => setResult(await api.post(`/api/enrollments/${enrollmentId}/events/${eventId}/attempts`, { responses: answers })));
  return (
    <Async loading={loading} error={error}>{() => {
      if (data.attemptsUsed >= data.maxAttempts && !result) return <Empty>No attempts left. Ask your trainer to re-assign the course.</Empty>;
      if (result) return (
        <div className={`notice ${result.passed ? 'ok' : 'warn'} stack`}>
          <strong>{result.passed ? `Passed with ${result.score}%.` : `Scored ${result.score}%; ${data.passingScore}% is needed.`}</strong>
          {!result.passed && <span>{result.attemptsRemaining} attempt(s) left.</span>}
          <div><button onClick={onDone}>Done</button></div>
        </div>
      );
      return (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <p className="muted" style={{ margin: 0 }}>Pass mark {data.passingScore}% · attempt {data.attemptsUsed + 1} of {data.maxAttempts}. Select all that apply where marked.</p>
          {data.questions.map((q: any, qi: number) => (
            <fieldset key={q.id} style={{ border: '1px solid var(--rule)', borderRadius: 6, padding: 12 }}>
              <legend><strong>{qi + 1}.</strong> {q.prompt}{q.type === 'multi' && <span className="faint"> (select all that apply)</span>}</legend>
              <div className="stack">{q.options.map((o: string, oi: number) => (
                <label key={oi} className="row">
                  <input type={q.type === 'multi' ? 'checkbox' : 'radio'} name={q.id} checked={(answers[q.id] ?? []).includes(oi)}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: q.type === 'multi'
                      ? (e.target.checked ? [...(answers[q.id] ?? []), oi] : (answers[q.id] ?? []).filter((x) => x !== oi)) : [oi] })} /> {o}
                </label>))}</div>
            </fieldset>
          ))}
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy}>Submit answers</button></div>
        </form>
      );
    }}</Async>
  );
}
