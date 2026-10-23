import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill } from '../components/ui';
import { fmtDate } from '../format';
import { useAction, useApi } from '../hooks';

const DEPTHS = [
  ['guided', 'Guided', 'The essentials: sites, people, customers, sign-in and cutover. For small companies that mostly set themselves up.'],
  ['standard', 'Standard', 'Adds equipment, parts, storerooms, suppliers, production, maintenance plans, finance and connections. The usual plan.'],
  ['full', 'Full', 'Everything, including history (work orders, downtime, qualifications), price lists and open orders. For larger companies with assisted steps.'],
] as const;
const TRACKS = [['data', 'Data to load'], ['connection', 'Connections'], ['cutover', 'Rehearse and go live']] as const;
const tone = (s: string) => (s === 'verified' ? 'good' : s === 'skipped' ? 'neutral' : s === 'loaded' ? 'info' : s === 'in_progress' ? 'info' : 'neutral');
const label = (s: string) => ({ todo: 'To do', in_progress: 'In progress', loaded: 'Loaded, check it', verified: 'Verified', skipped: 'Skipped' }[s] ?? s);

/** The implementation plan (SC-003): who loads what, in which order, and what is left before go-live. */
export function Implementation() {
  const { can } = useAuth();
  const admin = can('tenant.admin');
  const { data, loading, error, reload } = useApi<any>('/api/implementation');
  const users = useApi<any[]>(admin ? '/api/users' : null);
  const [depth, setDepth] = useState('standard');
  const [goLive, setGoLive] = useState('');
  const create = useAction(async () => { await api.post('/api/implementation', { depth, targetGoLive: goLive || null }); await reload(); });
  const change = useAction(async (d: string) => { await api.put('/api/implementation/depth', { depth: d }); await reload(); });

  return (
    <>
      <PageHead eyebrow="Administration" title="Implementation plan"
        sub="The order data and connections are set up in, who owns each step, and what is left before the company goes live." />
      <Async loading={loading && !data} error={error}>{() => !data.plan ? (
        <section className="card stack">
          <p className="answer">{data.answer}</p>
          <div className="stack" role="radiogroup" aria-label="How much guidance">
            {DEPTHS.map(([k, name, text]) => (
              <label key={k} className="row" style={{ alignItems: 'flex-start' }}>
                <input type="radio" name="depth" checked={depth === k} onChange={() => setDepth(k)} />
                <span><strong>{name}</strong><br /><span className="muted">{text}</span></span>
              </label>))}
          </div>
          <label className="field">Target go-live date (optional)<input id="impl-golive" type="date" value={goLive} onChange={(e) => setGoLive(e.target.value)} /></label>
          <ErrorNote message={create.error} />
          <div><button className="primary" disabled={!admin || create.busy} onClick={() => create.run()}>Build the plan</button>{!admin && <span className="muted"> An administrator builds the plan.</span>}</div>
        </section>
      ) : (
        <>
          <p className="answer">{data.answer}</p>
          <Kpis items={[
            { label: 'Ready', value: `${data.readiness.percent}%`, tone: data.readiness.canGoLive ? 'good' : undefined },
            { label: 'Verified', value: `${data.readiness.verified} of ${data.readiness.required}` },
            { label: 'Loaded, to check', value: data.readiness.loadedNotVerified, tone: data.readiness.loadedNotVerified ? 'watch' : undefined },
            { label: 'Target go-live', value: data.plan.targetGoLive ? fmtDate(data.plan.targetGoLive) : '—' },
          ]} />
          <section className="card row" style={{ flexWrap: 'wrap' }} aria-label="Who has what left">
            {data.readiness.byOwner.map((o: any) => <span key={o.owner}><Pill tone={o.open ? 'watch' : 'good'} label={`${o.owner}: ${o.open ? `${o.open} to go` : 'done'}`} /></span>)}
            {admin && <label className="row" style={{ marginLeft: 'auto' }}>Guidance
              <select aria-label="Plan depth" value={data.plan.depth} disabled={change.busy} onChange={(e) => change.run(e.target.value)} style={{ width: 'auto' }}>
                {DEPTHS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}</select></label>}
          </section>
          <ErrorNote message={change.error} />
          {TRACKS.map(([track, title]) => (
            <section key={track} className="stack" aria-label={title}>
              <h2>{title}</h2>
              {data.steps.filter((s: any) => s.track === track).map((s: any) => <Step key={s.key} s={s} admin={admin} users={users.data ?? []} reload={reload} />)}
            </section>
          ))}
        </>
      )}</Async>
    </>
  );
}

function Step({ s, admin, users, reload }: { s: any; admin: boolean; users: any[]; reload: () => Promise<unknown> }) {
  const { me } = useAuth();
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const mine = s.assigneeId && me?.userId === s.assigneeId;
  const act = useAction(async (what: string, body?: unknown) => { await api.post(`/api/implementation/steps/${s.key}/${what}`, body ?? {}); await reload(); });
  const assign = useAction(async (id: string) => { await api.patch(`/api/implementation/steps/${s.key}`, { assigneeUserId: id || null }); await reload(); });
  const done = s.status === 'verified' || s.status === 'skipped';
  const may = admin || mine;
  return (
    <article className="card stack" aria-label={s.title}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div><strong>{s.title}</strong>{s.optional && <span className="faint"> (optional)</span>} <span className="muted">· {s.owner}</span></div>
        <div className="row">
          {s.target && s.loadedCount > 0 && <span className="muted">{s.loadedCount.toLocaleString()} loaded{s.expected ? ` of ${s.expected.toLocaleString()}` : ''}</span>}
          {s.locked ? <Pill tone="neutral" label="Locked" /> : <Pill tone={tone(s.status)} label={label(s.status)} />}
        </div>
      </div>
      {s.locked && <p className="muted" style={{ margin: 0 }}>Waits for: {s.waitingFor.join(', ')}.{s.overrideReason ? '' : ''}</p>}
      {s.skippedReason && <p className="muted" style={{ margin: 0 }}>Skipped: {s.skippedReason}</p>}
      {s.overrideReason && <p className="muted" style={{ margin: 0 }}>Started early: {s.overrideReason}</p>}
      <p style={{ margin: 0 }}>{s.help}</p>
      <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>What to bring and how you know it is right</summary>
        {open && <div className="stack"><p><strong>Bring:</strong> {s.bring}</p><p><strong>Done when:</strong> {s.doneWhen}</p></div>}
      </details>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {s.target && (s.importReady ? (<>
          <Link className="button primary" to={`/imports?target=${s.target}`}>Open the import</Link>
          <button onClick={() => void api.download(`/api/imports/targets/${s.target}/template?format=xlsx`)}>Template (Excel)</button>
          <button onClick={() => void api.download(`/api/imports/targets/${s.target}/template?format=csv`)}>Template (CSV)</button></>) : <span className="muted">Import coming; enter these by hand for now.</span>)}
        {admin && (
          <label className="row">Owner
            <select aria-label={`Who does ${s.title}`} value={s.assigneeId ?? ''} disabled={assign.busy} onChange={(e) => assign.run(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
        )}
        {!admin && s.assignee && <span className="muted">Owner: {s.assignee}</span>}
      </div>
      {!done && may && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {s.status === 'todo' && !s.locked && <button disabled={act.busy} onClick={() => act.run('start')}>Start</button>}
          {s.status === 'todo' && s.locked && admin && (<>
            <input aria-label={`Why ${s.title} starts early`} placeholder="Why start early?" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 220 }} />
            <button disabled={act.busy || reason.trim().length < 5} onClick={() => act.run('start', { overrideReason: reason })}>Start anyway</button></>)}
          {(s.status === 'loaded' || s.status === 'in_progress' || (s.track !== 'data' && s.status === 'todo' && !s.locked)) && (<>
            <input aria-label={`Note for ${s.title}`} placeholder={`How you checked it (${s.doneWhen.slice(0, 40)}…)`} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 260px' }} />
            <button className="primary" disabled={act.busy || (s.track === 'data' && s.status !== 'loaded')} onClick={() => act.run('verify', { note })}>Verify</button></>)}
          {admin && <button className="link" disabled={act.busy} onClick={() => { const r = window.prompt('Why is this step not needed?'); if (r) void act.run('skip', { reason: r }); }}>Skip</button>}
        </div>
      )}
      {done && admin && <div><button className="link" disabled={act.busy} onClick={() => act.run('reopen')}>Reopen</button></div>}
      <ErrorNote message={act.error ?? assign.error} />
    </article>
  );
}
