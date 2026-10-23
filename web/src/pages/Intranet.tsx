import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Markdown } from '../components/Markdown';
import { Async, ErrorNote, PageHead, Pill } from '../components/ui';
import { fmtDate } from '../format';
import { useAction, useApi } from '../hooks';
import { KIND_LABEL } from './Home';

/** All announcements and events; people with announcements.post write them and keep the quick links. */
export function News() {
  const { can } = useAuth();
  const poster = can('announcements.post');
  const { data, loading, error, reload } = useApi<any[]>(`/api/announcements${poster ? '?all=true' : ''}`);
  const sites = useApi<any[]>(poster ? '/api/facilities' : null);
  const links = useApi<any[]>(poster ? '/api/quick-links' : null);
  const blank = { title: '', body: '', kind: 'news', facilityId: '', eventOn: '', pinned: false, expiresOn: '', notifyEveryone: false };
  const [f, setF] = useState(blank);
  const [l, setL] = useState({ title: '', url: '' });
  const post = useAction(async () => {
    await api.post('/api/announcements', { ...f, facilityId: f.facilityId || null, eventOn: f.eventOn || null, expiresOn: f.expiresOn || null });
    setF(blank); await reload();
  });
  const withdraw = useAction(async (id: string) => { await api.post(`/api/announcements/${id}/withdraw`, {}); await reload(); });
  const addLink = useAction(async () => { await api.post('/api/quick-links', l); setL({ title: '', url: '' }); await links.reload(); });
  const delLink = useAction(async (id: string) => { await api.delete(`/api/quick-links/${id}`); await links.reload(); });
  return (
    <>
      <PageHead eyebrow="Company" title="News and events" sub="Announcements, events and holidays for everyone or for your site." />
      {poster && (
        <section className="card stack">
          <h2>Post an announcement</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void post.run(); }}>
            <input id="ann-title" aria-label="Headline" placeholder="Headline" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
            <textarea id="ann-body" aria-label="Message" placeholder="Message (## headings, - lists, **bold**)" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required />
            <div className="row">
              <select id="ann-kind" aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select id="ann-site" aria-label="For" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>
                <option value="">Everyone</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select>
              <label className="row">Event date<input id="ann-event" type="date" value={f.eventOn} onChange={(e) => setF({ ...f, eventOn: e.target.value })} /></label>
              <label className="row">Show until<input id="ann-expires" type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></label>
              <label className="row"><input id="ann-pinned" type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top</label>
              <label className="row"><input id="ann-notify" type="checkbox" checked={f.notifyEveryone || f.kind === 'safety'} disabled={f.kind === 'safety'} onChange={(e) => setF({ ...f, notifyEveryone: e.target.checked })} /> Also send a notification</label>
            </div>
            <div><button className="primary" disabled={post.busy}>Post</button></div><ErrorNote message={post.error} />
          </form>
        </section>
      )}
      <section className="card stack">
        <Async loading={loading && !data} error={error}>{() => (data!.length ? data!.map((a) => (
          <article key={a.id} className="news-item">
            <div className="row"><Pill label={KIND_LABEL[a.kind]} />{a.pinned && <Pill tone="info" label="Pinned" />}{a.withdrawn_at && <Pill tone="bad" label="Withdrawn" />}
              <span className="faint">{fmtDate(a.published_at)} · {a.author_name}{a.facility_code ? ` · ${a.facility_code}` : ' · everyone'}{a.event_on ? ` · on ${fmtDate(a.event_on)}` : ''}</span>
              {poster && !a.withdrawn_at && <button className="link" disabled={withdraw.busy} onClick={() => withdraw.run(a.id)}>Withdraw</button>}</div>
            <h3>{a.title}</h3>
            <Markdown text={a.body} />
          </article>)) : <p className="muted">No announcements yet.</p>)}</Async>
        <ErrorNote message={withdraw.error} />
      </section>
      {poster && (
        <section className="card stack">
          <h2>Quick links on the home page</h2>
          <ul className="checklist">{(links.data ?? []).map((x) => <li key={x.id}>{x.title} <span className="faint">{x.url}</span> <button className="link" disabled={delLink.busy} onClick={() => delLink.run(x.id)}>Remove</button></li>)}</ul>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void addLink.run(); }}>
            <input id="link-title" aria-label="Link title" placeholder="Title (e.g. Benefits portal)" value={l.title} onChange={(e) => setL({ ...l, title: e.target.value })} required style={{ flex: '1 1 180px' }} />
            <input id="link-url" aria-label="Link address" placeholder="https://… or /page" value={l.url} onChange={(e) => setL({ ...l, url: e.target.value })} required style={{ flex: '2 1 260px' }} />
            <button disabled={addLink.busy}>Add link</button>
          </form>
          <ErrorNote message={addLink.error ?? delLink.error} />
        </section>
      )}
    </>
  );
}

/** The people directory: everyone in the company, with work contact details. */
export function People() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const { data, loading, error } = useApi<any[]>(`/api/directory${q ? `?search=${encodeURIComponent(q)}` : ''}`);
  const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead eyebrow="Company" title="People" sub="Everyone at the company, with work contact details." />
      <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); setParams(text ? { q: text } : {}); }}>
        <input id="people-search" type="search" aria-label="Search people" placeholder="Name, job, team or site" value={text} onChange={(e) => setText(e.target.value)} style={{ maxWidth: 420 }} />
        <button>Search</button>
      </form>
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <p className="muted">{data!.length} {data!.length === 1 ? 'person' : 'people'}{q ? ` matching "${q}"` : ''}</p>
          <div className="people">
            {data!.map((p) => (
              <div key={p.person_key} className="person card">
                <span className="avatar big" aria-hidden="true">{initials(p.name)}</span>
                <div>
                  <strong>{p.name}</strong>
                  <div className="muted">{[p.job_title, p.department].filter(Boolean).join(' · ') || '—'}</div>
                  <div className="faint">{p.site_name ? `${p.site_name}${p.office_location ? `, ${p.office_location}` : ''}` : p.office_location ?? ''}</div>
                  <div className="row" style={{ gap: 12 }}>{p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}{p.work_phone && <a href={`tel:${p.work_phone}`}>{p.work_phone}</a>}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}</Async>
    </>
  );
}

/** Results of the top-bar search, grouped by kind. */
export function SearchResults() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data, loading, error } = useApi<any>(q ? `/api/search?q=${encodeURIComponent(q)}` : null);
  return (
    <>
      <PageHead eyebrow="Search" title={`Results for "${q}"`} />
      <Async loading={loading && !data} error={error}>{() => (data?.groups.length ? (
        <div className="grid two">
          {data.groups.map((g: any) => (
            <section key={g.kind} className="card stack">
              <h2>{g.label}</h2>
              <ul className="checklist">{g.items.map((i: any, k: number) => <li key={k}><Link to={i.link}>{i.title}</Link>{i.detail && <span className="faint"> · {i.detail}</span>}</li>)}</ul>
            </section>
          ))}
        </div>) : <p className="muted">Nothing found. Try a name, an asset tag or a word from a policy.</p>)}</Async>
    </>
  );
}
