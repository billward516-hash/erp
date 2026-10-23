import { api } from '../api';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';

/** The daily job (D-171): when it last ran, what it did for this company, and a way to run it now. */
export function Jobs() {
  const { data, loading, error, reload } = useApi<any>('/api/job-runs');
  const run = useAction(async () => { await api.post('/api/job-runs/run-now'); await reload(); });
  return (
    <>
      <PageHead eyebrow="Administration" title="Scheduled jobs"
        sub="Once a day the server sends reminders and digests, applies data retention, takes the company archive when it is due, and chases late document reviews and readings."
        actions={<button disabled={run.busy} onClick={() => void run.run()}>{run.busy ? 'Running…' : 'Run it now for this company'}</button>} />
      <ErrorNote message={run.error} />
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <p className="answer">{data.answer}</p>
          <section className="card stack">
            <Table rows={data.runs} rowKey={(r) => String(r.id)} empty="No runs yet."
              columns={[{ key: 'runDate', label: 'Day' }, { key: 'status', label: 'Result', render: (r) => <Pill tone={r.status === 'done' ? 'good' : r.status === 'failed' ? 'bad' : 'info'} label={r.status === 'done' ? 'Done' : r.status === 'failed' ? 'Failed' : 'Running'} /> },
                { key: 'trigger', label: 'Started by', render: (r) => (r.trigger === 'manual' ? 'A person' : 'The schedule') }, { key: 'startedAt', label: 'Started', render: (r) => fmtDateTime(r.startedAt) },
                { key: 'mine', label: 'This company', render: (r) => (r.mine ? (r.mine.ok ? 'All steps done' : `A step failed: ${Object.entries(r.mine).filter(([k]) => k.endsWith('Error')).map(([k, v]) => `${k.replace('Error', '')}: ${v}`).join('; ')}`) : '—') }]} />
          </section>
        </>
      )}</Async>
    </>
  );
}
