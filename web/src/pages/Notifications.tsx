import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Async, Empty, ErrorNote, PageHead } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';

export function Notifications() {
  const nav = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, loading, error, reload } = useApi<any[]>(`/api/notifications${unreadOnly ? '?unreadOnly=true' : ''}`);
  const all = useAction(async () => { await api.post('/api/notifications/read', { ids: 'all' }); await reload(); });
  const open = useAction(async (n: any) => {
    if (!n.read_at) await api.post('/api/notifications/read', { ids: [n.id] });
    if (n.link) nav(n.link); else await reload();
  });
  const rows = data ?? [];
  return (
    <>
      <PageHead eyebrow="Notifications" title="For you" sub="Things waiting for you and updates on your requests. Unread items are also emailed once a day if you choose."
        actions={rows.some((n) => !n.read_at) ? <button onClick={() => all.run()} disabled={all.busy}>Mark all read</button> : undefined} />
      <section className="card stack">
        <label className="row"><input id="ntf-unread" type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Only unread</label>
        <Async loading={loading && !data} error={error}>{() => (rows.length ? (
          <ul className="notice-list">
            {rows.map((n) => (
              <li key={n.id} className={n.read_at ? 'read' : 'unread'}>
                <button className="notice-item" onClick={() => open.run(n)}>
                  <span className="t">{!n.read_at && <span className="dot" aria-label="unread" />}{n.title}</span>
                  {n.body && <span className="b">{n.body}</span>}
                  <span className="when">{fmtDateTime(n.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <Empty>Nothing here. You are all caught up.</Empty>)}</Async>
        <ErrorNote message={all.error ?? open.error} />
      </section>
      <Preferences />
    </>
  );
}

function Preferences() {
  const { data: p, reload } = useApi<any>('/api/notification-preferences');
  const save = useAction(async (patch: Record<string, unknown>) => { await api.put('/api/notification-preferences', patch); await reload(); });
  if (!p) return null;
  const muted = new Set<string>(p.mutedKinds);
  return (
    <section className="card stack">
      <h2>Settings</h2>
      <label className="row"><input id="ntf-digest" type="checkbox" checked={p.emailDigest} onChange={(e) => save.run({ emailDigest: e.target.checked })} />
        Email me a daily summary of unread items{p.email ? ` (${p.email})` : ''}</label>
      <fieldset className="stack" style={{ border: 0, padding: 0 }}>
        <legend className="muted">Notify me when…</legend>
        {Object.entries(p.kinds as Record<string, string>).map(([k, label]) => (
          <label key={k} className="row"><input type="checkbox" checked={!muted.has(k)}
            onChange={(e) => { const next = new Set(muted); if (e.target.checked) next.delete(k); else next.add(k); void save.run({ mutedKinds: [...next] }); }} /> {label}</label>
        ))}
      </fieldset>
      <ErrorNote message={save.error} />
    </section>
  );
}
