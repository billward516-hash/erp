import { useState } from 'react';
import { api } from '../api';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';

interface Step { step: string; label: string; ok: boolean; text: string }

/** What a run did, one line per step, with the failures first and in words. */
function Steps({ steps }: { steps: Step[] }) {
  if (!steps.length) return <span className="faint">—</span>;
  return (
    <ul className="plain" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
      {steps.map((s) => (
        <li key={s.step}><strong>{s.label}:</strong> {s.ok ? s.text : <span className="pill bad">{s.text}</span>}</li>
      ))}
    </ul>
  );
}

/** The daily job (D-171, D-183B): when it last ran, what it did for this company, a way to run it now, and a test email. */
export function Jobs() {
  const { data, loading, error, reload } = useApi<any>('/api/job-runs');
  const [result, setResult] = useState<{ ok: boolean; steps: Step[]; at: string } | null>(null);
  const [mailResult, setMailResult] = useState<{ ok: boolean; delivered: boolean; sender: string | null; to: string | null; error: string | null } | null>(null);
  const run = useAction(async () => {
    const r = await api.post('/api/job-runs/run-now');
    setResult({ ok: r.ok, steps: r.steps, at: new Date().toISOString() });
    await reload();
  });
  const test = useAction(async () => { setMailResult(await api.post('/api/job-runs/test-email')); await reload(); });
  return (
    <>
      <PageHead eyebrow="Administration" title="Scheduled jobs"
        sub="Once a day the server sends reminders and email digests, syncs the accounting system, applies data retention, takes the company archive when it is due, and chases late document reviews and readings."
        actions={<button disabled={run.busy} onClick={() => void run.run()}>{run.busy ? 'Running…' : 'Run it now for this company'}</button>} />
      <ErrorNote message={run.error ?? test.error} />
      <div aria-live="polite">
        {result && (
          <section className={`card stack notice ${result.ok ? 'ok' : 'error'}`} role="status">
            <strong>{result.ok ? 'The run finished: every step was done.' : 'The run finished, but a step failed.'}</strong>
            <Steps steps={result.steps} />
          </section>
        )}
      </div>
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <p className="answer">{data.answer}</p>
          <section className="card stack" aria-label="Email">
            <h2>Email</h2>
            {data.mail.error
              ? <p className="notice error">The mail settings on the server are not valid: {data.mail.error}</p>
              : data.mail.configured
                ? <p>Email goes out through <strong>{data.mail.sender}</strong>. {data.mail.queued} waiting to be sent{data.mail.failed ? `, ${data.mail.failed} given up on` : ''}.</p>
                : <p className="notice warn">No mail server is set up on this server (SMTP_HOST is empty), so email is <strong>not delivered</strong>: digests are only written to files on the server. Ask whoever runs the server to set it up (see Operations).</p>}
            <p className="faint">Delivery has been tested only against a stand-in mail server in development; send a test email to yourself after connecting a real provider.</p>
            <div>
              <button disabled={test.busy} onClick={() => void test.run()}>{test.busy ? 'Sending…' : 'Send a test email to me'}</button>
            </div>
            <div aria-live="polite">
              {mailResult && (mailResult.ok
                ? <p className="notice ok" role="status">{mailResult.delivered ? `Test email sent to ${mailResult.to}. Check your inbox.` : `Nothing was sent: ${mailResult.sender}. The message was only written to a file on the server.`}</p>
                : <p className="notice error" role="alert">The test email failed{mailResult.sender ? ` (${mailResult.sender})` : ''}: {mailResult.error}</p>)}
            </div>
          </section>
          <section className="card stack">
            <Table rows={data.runs} rowKey={(r) => String(r.id)} empty="No runs yet."
              columns={[{ key: 'runDate', label: 'Day' }, { key: 'status', label: 'Result', render: (r) => <Pill tone={r.status === 'done' ? 'good' : r.status === 'failed' ? 'bad' : 'info'} label={r.status === 'done' ? 'Done' : r.status === 'failed' ? 'Failed' : 'Running'} /> },
                { key: 'trigger', label: 'Started by', render: (r) => (r.trigger === 'manual' ? `A person${r.startedBy ? ` (${r.startedBy})` : ''}` : 'The schedule') }, { key: 'startedAt', label: 'Started', render: (r) => fmtDateTime(r.startedAt) },
                { key: 'steps', label: 'This company', render: (r) => (r.mine ? <Steps steps={r.steps} /> : r.error ?? '—') }]} />
          </section>
        </>
      )}</Async>
    </>
  );
}
