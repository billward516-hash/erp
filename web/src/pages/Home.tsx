import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../auth';
import { Markdown } from '../components/Markdown';
import { Async, Pill, Table } from '../components/ui';
import { fmtDate } from '../format';
import { useApi } from '../hooks';

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
export const KIND_LABEL: Record<string, string> = { news: 'News', event: 'Event', safety: 'Safety', people: 'People', it: 'IT' };
const KIND_TONE: Record<string, 'info' | 'bad' | 'good' | 'watch' | undefined> = { safety: 'bad', event: 'info', people: 'good', it: 'watch' };

/**
 * The intranet home (D-130): company news first, then the user's own work, what is coming up, quick links and people.
 * Operational tables follow for the people who use them.
 */
export function Home() {
  const { me, can, feature } = useAuth();
  const nav = useNavigate();
  const news = useApi<any[]>(feature('news') ? '/api/announcements' : null);
  const coming = useApi<any[]>(feature('news') ? '/api/announcements/upcoming' : null);
  const links = useApi<any[]>('/api/quick-links');
  const pending = useApi<any[]>(feature('policies') ? '/api/policies/pending' : null);
  const actions = useApi<any[]>('/api/actions/mine');
  const mine = useApi<any[]>(me?.employeeId && can('work_orders.view') ? '/api/work-orders?assigned=me&openOnly=true' : null);
  const open = useApi<any[]>(can('work_orders.view') ? '/api/work-orders?openOnly=true' : null);
  const queue = useApi<any[]>('/api/approvals/queue');
  const training = useApi<any[]>(me?.employeeId && can('learning.view') ? '/api/enrollments?mine=true' : null);
  const [who, setWho] = useState('');
  const myTraining = (training.data ?? []).filter((e) => e.status !== 'completed');
  const overdueWo = (open.data ?? []).filter((w) => w.overdue).length;
  const todo: { label: string; n: number | undefined; to: string; tone?: 'bad' | 'watch' }[] = [
    { label: 'Waiting for my sign-off', n: queue.data?.length, to: '/approvals', tone: 'watch' },
    ...(feature('policies') ? [{ label: 'Policies to read and acknowledge', n: pending.data?.length, to: '/policies?tab=all', tone: 'watch' as const }] : []),
    { label: 'My actions', n: actions.data?.length, to: '/quality?tab=actions', tone: (actions.data ?? []).some((a) => a.overdue) ? 'bad' : undefined },
    ...(me?.employeeId && can('work_orders.view') ? [{ label: 'My open work orders', n: mine.data?.length, to: '/work-orders' }] : []),
    ...(me?.employeeId && can('learning.view') ? [{ label: 'My training to do', n: training.data ? myTraining.length : undefined, to: '/training', tone: myTraining.some((e) => e.overdue) ? ('bad' as const) : undefined }] : []),
    ...(can('work_orders.view') ? [{ label: 'Overdue work orders at my sites', n: open.data ? overdueWo : undefined, to: '/work-orders', tone: overdueWo ? ('bad' as const) : undefined }] : []),
  ];
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <>
      <section className="hero">
        <div>
          <div className="hero-date">{today}</div>
          <h1>{greeting()}, {me?.displayName.split(' ')[0]}</h1>
          <p>Welcome to the {me?.tenantName ?? 'company'} intranet.</p>
        </div>
        <form className="hero-search" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/people?q=${encodeURIComponent(who)}`); }}>
          <input type="search" aria-label="Find a colleague" placeholder="Find a colleague: name, team or site" value={who} onChange={(e) => setWho(e.target.value)} />
        </form>
      </section>
      <div className="portal">
        {feature('news') && <section className="card stack news" aria-labelledby="news-h">
          <div className="spread"><h2 id="news-h">Company news</h2><Link to="/news">All news and events</Link></div>
          <Async loading={news.loading && !news.data} error={news.error}>{() => (news.data!.length ? (
            <div className="stack" style={{ gap: 14 }}>
              {news.data!.slice(0, 4).map((a) => (
                <article key={a.id} className="news-item">
                  <div className="row"><Pill tone={KIND_TONE[a.kind]} label={KIND_LABEL[a.kind]} />{a.pinned && <Pill tone="info" label="Pinned" />}
                    <span className="faint">{fmtDate(a.published_at)} · {a.author_name}{a.facility_code ? ` · ${a.facility_code}` : ''}{a.event_on ? ` · on ${fmtDate(a.event_on)}` : ''}</span></div>
                  <h3>{a.title}</h3>
                  <Markdown text={a.body} />
                </article>
              ))}
            </div>) : <p className="muted">No announcements yet.</p>)}</Async>
        </section>}
        <div className="stack portal-side" style={{ gap: 16 }}>
          <section className="card stack" aria-labelledby="todo-h">
            <h2 id="todo-h">My work</h2>
            <ul className="todo">
              {todo.map((t) => (
                <li key={t.label}><Link to={t.to}><span>{t.label}</span>
                  {t.n === undefined ? <span className="faint">…</span> : <span className={`todo-n${t.n && t.tone ? ` ${t.tone}` : ''}`}>{t.n}</span>}</Link></li>
              ))}
            </ul>
          </section>
          {feature('news') && <section className="card stack" aria-labelledby="coming-h">
            <h2 id="coming-h">Coming up</h2>
            {(coming.data ?? []).length ? (
              <ul className="coming">{coming.data!.map((e) => (
                <li key={e.id}><span className="date-chip"><b>{new Date(`${e.event_on}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric' })}</b>
                  {new Date(`${e.event_on}T12:00:00`).toLocaleDateString(undefined, { month: 'short' })}</span><span>{e.title}{e.facility_code ? <span className="faint"> · {e.facility_code}</span> : null}</span></li>))}
              </ul>) : <p className="muted">Nothing scheduled.</p>}
          </section>}
          <section className="card stack" aria-labelledby="links-h">
            <h2 id="links-h">Quick links</h2>
            <div className="tiles">
              {feature('policies') && <Link to="/policies" className="tile">Employee handbook</Link>}
              {feature('people') && <Link to="/people" className="tile">People directory</Link>}
              {(links.data ?? []).map((l) => (l.url.startsWith('/')
                ? <Link key={l.id} to={l.url} className="tile" title={l.description ?? undefined}>{l.title}</Link>
                : <a key={l.id} href={l.url} className="tile" target="_blank" rel="noopener noreferrer" title={l.description ?? undefined}>{l.title} <span aria-hidden="true">↗</span><span className="sr-only"> (opens another site)</span></a>))}
            </div>
          </section>
        </div>
      </div>
      <div className="grid two">
        {me?.employeeId && can('work_orders.view') && (
          <section className="card">
            <div className="spread"><h2>My work orders</h2><Link to="/work-orders">All work orders</Link></div>
            <Async loading={mine.loading} error={mine.error}>{() => (
              <Table rows={mine.data ?? []} onRow={(w) => nav(`/work-orders/${w.id}`)} empty="Nothing assigned to you." exception={(w) => w.overdue}
                columns={[{ key: 'number', label: 'WO' }, { key: 'asset_tag', label: 'Asset' }, { key: 'title', label: 'Title' },
                  { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> }, { key: 'due_at', label: 'Due', render: (w) => fmtDate(w.due_at) }]} />
            )}</Async>
          </section>
        )}
        <section className="card">
          <div className="spread"><h2>Waiting for my sign-off</h2><Link to="/approvals">Approvals</Link></div>
          <Async loading={queue.loading} error={queue.error}>{() => (
            <Table rows={queue.data ?? []} rowKey={(q) => q.stepId} empty="Nothing waiting for you." onRow={(q) => q.subjectType === 'moc_change' && nav(`/changes/${q.subjectId}`)}
              columns={[{ key: 'subject', label: 'Item', render: (q) => q.subject ? `${q.subject.number} ${q.subject.title}` : q.subjectType },
                { key: 'label', label: 'Your step' }]} />
          )}</Async>
        </section>
        {me?.employeeId && can('learning.view') && (
          <section className="card">
            <div className="spread"><h2>My training</h2><Link to="/training">Training</Link></div>
            <Async loading={training.loading} error={training.error}>{() => (
              <Table rows={myTraining} onRow={(e) => nav(`/training/enrollments/${e.id}`)} empty="No training assigned." exception={(e) => e.overdue}
                columns={[{ key: 'code', label: 'Course' }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status', render: (e) => <Pill value={e.status} /> },
                  { key: 'due_on', label: 'Due', render: (e) => fmtDate(e.due_on) }]} />
            )}</Async>
          </section>
        )}
        {!me?.employeeId && can('work_orders.view') && (
          <section className="card">
            <div className="spread"><h2>Open work orders</h2><Link to="/work-orders">All</Link></div>
            <Async loading={open.loading} error={open.error}>{() => (
              <Table rows={(open.data ?? []).slice(0, 8)} onRow={(w) => nav(`/work-orders/${w.id}`)} exception={(w) => w.overdue}
                columns={[{ key: 'number', label: 'WO' }, { key: 'asset_tag', label: 'Asset' }, { key: 'title', label: 'Title' },
                  { key: 'status', label: 'Status', render: (w) => <Pill value={w.status} /> }]} />
            )}</Async>
          </section>
        )}
      </div>
    </>
  );
}
