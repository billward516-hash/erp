import { useState } from 'react';
import { api } from '../api';
import { Async, ErrorNote, PageHead } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';

const LABELS: Record<string, string> = {
  import_rows: 'import rows', abandoned_imports: 'unfinished imports cancelled', notifications_read: 'read notifications', notifications_unread: 'unread notifications',
  emails: 'sent emails', tokens: 'expired tokens', sso_attempts: 'sign-in attempts', saved_replies: 'saved replies',
};
const summary = (removed: Record<string, number>) => Object.entries(removed).map(([k, n]) => `${n.toLocaleString()} ${LABELS[k] ?? k}`).join(', ') || 'nothing due';

/**
 * Admin → Data retention (D-151): how long short-lived working data is kept before the daily sweep removes it, what
 * the next sweep would remove, and what is never removed.
 */
export function Retention() {
  const { data, loading, error, reload } = useApi<any>('/api/retention');
  return (
    <>
      <PageHead eyebrow="Admin" title="Data retention"
        sub="Working data that is only useful for a while is removed by a daily sweep after the period set here. Business records, documents and the audit log are never removed." />
      <Async loading={loading && !data} error={error}>{() => {
        const due = data.categories.reduce((s: number, c: any) => s + c.due, 0);
        return (
          <>
            <p className="answer">{due ? `The next daily sweep will remove ${due.toLocaleString()} item${due === 1 ? '' : 's'} past their period.` : 'Nothing is past its period; the next sweep has nothing to remove.'}</p>
            <section className="card stack">
              <h2>Removed after a period</h2>
              {data.categories.map((c: any) => <RetentionRow key={c.key} c={c} onDone={reload} />)}
              {data.fixed.map((f: any) => (
                <div key={f.label} className="stack" style={{ gap: 4, borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
                  <strong>{f.label}</strong><span className="faint">{f.description} Kept {f.days} days; not adjustable.</span>
                </div>
              ))}
            </section>
            <section className="card stack">
              <h2>Never removed</h2>
              <ul style={{ margin: 0 }}>{data.kept.map((k: string) => <li key={k}>{k}</li>)}</ul>
            </section>
            <section className="card stack">
              <h2>Recent sweeps</h2>
              {data.runs.length ? (
                <ul style={{ margin: 0 }}>{data.runs.map((r: any) => <li key={r.ran_at}>{fmtDateTime(r.ran_at)}: {summary(r.removed)}</li>)}</ul>
              ) : <p className="muted" style={{ margin: 0 }}>No sweep has run yet. It runs with the daily reminders.</p>}
            </section>
          </>
        );
      }}</Async>
    </>
  );
}

function RetentionRow({ c, onDone }: { c: any; onDone: () => void }) {
  const [days, setDays] = useState<string>(String(c.days));
  const n = Number(days);
  const ok = Number.isInteger(n) && n >= c.min && n <= c.max;
  const dirty = n !== c.days;
  const save = useAction(async () => { await api.put(`/api/retention/${c.key}`, { days: n }); onDone(); });
  const id = `ret-${c.key}`;
  return (
    <div className="stack retention-row" style={{ gap: 6, borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
      <div className="spread">
        <div>
          <strong>{c.label}</strong>
          <div className="faint">{c.description}</div>
        </div>
        <div className="row">
          <label htmlFor={id}>Keep for</label>
          <input id={id} type="number" inputMode="numeric" min={c.min} max={c.max} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} aria-describedby={`${id}-hint`} />
          <span>days</span>
          <button className={dirty && ok ? 'primary' : ''} disabled={!dirty || !ok || save.busy} onClick={() => save.run()}>Save</button>
        </div>
      </div>
      <span id={`${id}-hint`} className="faint">
        {c.min} to {c.max} days{c.days !== c.defaultDays ? `; default ${c.defaultDays}` : ' (default)'}.{' '}
        {c.due ? `${c.due.toLocaleString()} due for removal${c.abandonedImports ? `, including ${c.abandonedImports} unfinished import${c.abandonedImports === 1 ? '' : 's'}` : ''}.` : 'Nothing due.'}
        {c.updatedAt ? ` Changed ${fmtDateTime(c.updatedAt)} by ${c.updatedBy}.` : ''}
      </span>
      <ErrorNote message={save.error} />
    </div>
  );
}
