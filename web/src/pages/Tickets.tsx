import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';

/*
 * Support tickets (SC-009 P4): the queue, a ticket with its timeline, and setup (service levels, business hours, lists, public links).
 * Service-level states always carry a text label (Breached, At risk, On track, Paused, Met, Missed), never colour alone.
 */
type Tone = 'good' | 'watch' | 'bad' | 'info' | 'neutral';
const PRIORITY_TONE: Record<string, Tone> = { urgent: 'bad', high: 'watch', normal: 'neutral', low: 'neutral' };
const STATUS_TONE: Record<string, Tone> = { new: 'info', open: 'info', reopened: 'watch', waiting_customer: 'neutral', waiting_third_party: 'neutral', resolved: 'good', closed: 'good' };
const STATUS_LABEL: Record<string, string> = { new: 'New', open: 'Open', waiting_customer: 'Waiting on customer', waiting_third_party: 'Waiting on third party', resolved: 'Resolved', closed: 'Closed', reopened: 'Reopened' };
const SLA_TONE: Record<string, Tone> = { breached: 'bad', missed: 'bad', at_risk: 'watch', on_track: 'good', met: 'good', paused: 'info', none: 'neutral' };
const CHANNELS: [string, string][] = [['phone', 'Phone'], ['email', 'Email (typed in)'], ['in_person', 'In person']];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

export const PriorityPill = ({ v }: { v: string }) => <Pill tone={PRIORITY_TONE[v]} label={humanize(v)} />;
export const StatusPill = ({ v }: { v: string }) => <Pill tone={STATUS_TONE[v]} label={STATUS_LABEL[v] ?? humanize(v)} />;

function Timer({ label, t }: { label: string; t: any }) {
  if (t.state === 'none') return null;
  const when = t.state === 'met' || t.state === 'missed' ? (t.at ? ` · ${fmtDateTime(t.at)}` : '') : t.dueAt ? ` · due ${fmtDateTime(t.dueAt)}` : '';
  return <Pill tone={SLA_TONE[t.state]} label={`${label}: ${t.label}${when}`} />;
}
/** Both timers of a ticket, each with its state in words and the time it is due. */
export function SlaPills({ sla }: { sla: any }) {
  const none = sla.firstResponse.state === 'none' && sla.resolution.state === 'none';
  return <span className="row" style={{ gap: 4 }}>{none ? <Pill label="No service level" /> : <><Timer label="First response" t={sla.firstResponse} /><Timer label="Resolution" t={sla.resolution} /></>}{sla.paused && <Pill tone="info" label="Clock paused" />}</span>;
}
const nextDue = (r: any) => {
  const s = r.sla;
  const open = !['resolved', 'closed'].includes(r.status);
  if (!open || s.overall === 'none') return null;
  const f = s.firstResponse.state !== 'met' && s.firstResponse.state !== 'missed' && s.firstResponse.dueAt ? s.firstResponse.dueAt : null;
  const x = s.resolution.dueAt;
  return f && x ? (f < x ? f : x) : f ?? x;
};

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

export function Tickets() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'setup' ? 'setup' : 'queue';
  const canWork = can('tickets.work'); const canManage = can('tickets.manage');
  return (
    <>
      <PageHead eyebrow="Service companies" title="Tickets" sub="Customer requests with response and resolution targets in business hours. Timers pause while a ticket waits on the customer or a third party."
        actions={canWork ? <button className="primary" onClick={() => nav('/tickets/new')}>New ticket</button> : undefined} />
      {canManage && (
        <div className="row" role="tablist" aria-label="Tickets sections">
          <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'primary' : ''} onClick={() => setParams({})}>Queue</button>
          <button role="tab" aria-selected={tab === 'setup'} className={tab === 'setup' ? 'primary' : ''} onClick={() => setParams({ tab: 'setup' })}>Service levels and setup</button>
        </div>
      )}
      {tab === 'queue' ? <Queue /> : <Setup />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const VIEWS: [string, string, string][] = [['open', 'Open', 'open'], ['mine', 'Mine', 'mine'], ['unassigned', 'Unassigned', 'unassigned'], ['breached', 'Breached', 'breached'], ['at_risk', 'At risk', 'at_risk'], ['waiting', 'Waiting', 'waiting'], ['all', 'All', '']];

function Queue() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'open';
  const [q, setQ] = useState(''); const [priority, setPriority] = useState(''); const [customerId, setCustomerId] = useState(''); const [assigneeId, setAssigneeId] = useState('');
  const [sort, setSort] = useState('due'); const [dir, setDir] = useState('asc');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ view, sort, dir });
    if (q.trim()) p.set('q', q.trim());
    if (priority) p.set('priority', priority);
    if (customerId) p.set('customerId', customerId);
    if (assigneeId) p.set('assigneeId', assigneeId);
    return p.toString();
  }, [view, q, priority, customerId, assigneeId, sort, dir]);
  const { data, loading, error, reload } = useApi<any>(`/api/tickets?${qs}`);
  const customers = useApi<any[]>('/api/tickets/customers');
  const rows: any[] = data?.rows ?? [];
  const chosen = rows.filter((r) => picked.has(r.id));
  const sites = [...new Set(chosen.map((r) => r.facility_id))];
  const lookups = useApi<any>(sites.length === 1 ? `/api/tickets/lookups?facilityId=${sites[0]}` : null);
  const everyone = useApi<any>(can('tickets.work') ? '/api/tickets/lookups' : null);
  const assign = useAction(async () => {
    const out = await api.post('/api/tickets/assign', { ids: chosen.map((r) => r.id), assigneeUserId: assignTo === 'none' ? null : assignTo });
    setPicked(new Set(out.failed.map((f: any) => f.id)));
    if (out.failed.length) throw new Error(`${out.assigned} assigned. ${out.failed.length} not: ${out.failed[0].message}`);
    setAssignTo(''); await reload();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'n' && can('tickets.work')) { e.preventDefault(); nav('/tickets/new'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nav, can]);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const c = data?.counts;
  return (
    <>
      {c && <Kpis items={[{ label: 'Open', value: c.open }, { label: 'Mine', value: c.mine }, { label: 'Unassigned', value: c.unassigned, tone: c.unassigned ? 'watch' : 'good' },
        { label: 'Breached', value: c.breached, tone: c.breached ? 'bad' : 'good' }, { label: 'At risk', value: c.at_risk, tone: c.at_risk ? 'watch' : 'good' }, { label: 'Waiting', value: c.waiting }]} />}
      <section className="card stack">
        <div className="row" role="group" aria-label="Queue views">
          {VIEWS.map(([key, label]) => (
            <button key={key} aria-pressed={view === key} className={view === key ? 'primary' : ''} onClick={() => { setParams(key === 'open' ? {} : { view: key }); setPicked(new Set()); }}>
              {label}{c && key !== 'all' ? ` (${key === 'at_risk' ? c.at_risk : c[key]})` : ''}</button>
          ))}
        </div>
        <div className="row">
          <label className="field">Search<input ref={searchRef} id="tk-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, subject or customer" /></label>
          <label className="field">Customer<select id="tk-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Any</option>{(customers.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label className="field">Priority<select id="tk-priority" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">Any</option>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
          <label className="field">Assignee<select id="tk-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}><option value="">Anyone</option>{(everyone.data?.assignees ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
          <label className="field">Sort by<select id="tk-sort" value={sort} onChange={(e) => setSort(e.target.value)}><option value="due">Next due</option><option value="priority">Priority</option><option value="created">Newest or oldest</option><option value="updated">Last updated</option><option value="number">Number</option></select></label>
          <label className="field">Order<select id="tk-dir" value={dir} onChange={(e) => setDir(e.target.value)}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        </div>
        <p className="faint">Keyboard: <kbd>/</kbd> searches, <kbd>n</kbd> starts a new ticket. The service level shows the state as of now; alerts are sent once a day.</p>
        {picked.size > 0 && (
          <form className="row" aria-label="Assign the selected tickets" onSubmit={(e) => { e.preventDefault(); void assign.run(); }}>
            <strong>{picked.size} selected</strong>
            <label className="field">Assign to
              <select id="tk-bulk" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} disabled={sites.length !== 1}>
                <option value="">Choose…</option><option value="none">Nobody (unassign)</option>{(lookups.data?.assignees ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
              </select></label>
            <button disabled={!assignTo || assign.busy || sites.length !== 1}>Assign</button>
            <button type="button" className="link" onClick={() => setPicked(new Set())}>Clear selection</button>
            {sites.length > 1 && <span className="faint">Choose tickets from one site to assign them together.</span>}
          </form>
        )}
        <ErrorNote message={assign.error} />
        <Async loading={loading && !data} error={error}>{() => (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th scope="col"><input type="checkbox" aria-label="Select all tickets shown" checked={rows.length > 0 && picked.size === rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                <th scope="col">Ticket</th><th scope="col">Customer</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Assignee</th><th scope="col">Service level</th><th scope="col">Next due</th><th scope="col">Updated</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.sla.overall === 'breached' ? 'exception' : ''}>
                    <td><input type="checkbox" aria-label={`Select ${r.number}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td><Link to={`/tickets/${r.id}`}><strong>{r.number}</strong></Link> {r.subject}</td>
                    <td>{r.customer_name}</td>
                    <td><PriorityPill v={r.priority} /></td>
                    <td><StatusPill v={r.status} /></td>
                    <td>{r.assignee_name ?? <span className="faint">Unassigned</span>}</td>
                    <td><Pill tone={SLA_TONE[r.sla.overall]} label={r.sla.overallLabel} />{r.sla.paused && <> <span className="faint">(paused)</span></>}</td>
                    <td>{nextDue(r) ? fmtDateTime(nextDue(r)) : <span className="faint">—</span>}</td>
                    <td>{fmtDate(r.updated_at)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={9} className="faint">No tickets in this view.</td></tr>}
              </tbody>
            </table>
          </div>
        )}</Async>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// A new ticket
// ---------------------------------------------------------------------------

export function NewTicket() {
  const nav = useNavigate();
  const { can } = useAuth();
  const lookups = useApi<any>('/api/tickets/lookups');
  const [f, setF] = useState({ facilityId: '', customerId: '', contactId: '', subject: '', description: '', priority: 'normal', categoryId: '', channel: 'phone', assigneeUserId: '', projectId: '', assetId: '', workOrderId: '', serviceVisitId: '', retainerCovered: false });
  const [cq, setCq] = useState('');
  const customers = useApi<any[]>(`/api/tickets/customers${cq ? `?q=${encodeURIComponent(cq)}` : ''}`);
  const contacts = useApi<any[]>(f.customerId ? `/api/tickets/customers/${f.customerId}/contacts` : null);
  const options = useApi<any>(f.facilityId && f.customerId ? `/api/tickets/link-options?facilityId=${f.facilityId}&customerId=${f.customerId}` : null);
  const site = useApi<any>(f.facilityId ? `/api/tickets/lookups?facilityId=${f.facilityId}` : null);
  useEffect(() => { const s = lookups.data?.sites; if (s?.length === 1 && !f.facilityId) setF((x) => ({ ...x, facilityId: s[0].id })); }, [lookups.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const nul = (v: string) => v || null;
  const save = useAction(async () => {
    const t = await api.post('/api/tickets', { facilityId: f.facilityId, customerId: f.customerId, contactId: nul(f.contactId), subject: f.subject, description: nul(f.description), priority: f.priority, categoryId: nul(f.categoryId),
      channel: f.channel, assigneeUserId: nul(f.assigneeUserId), projectId: nul(f.projectId), assetId: nul(f.assetId), workOrderId: nul(f.workOrderId), serviceVisitId: nul(f.serviceVisitId), retainerCovered: f.retainerCovered });
    nav(`/tickets/${t.id}`);
  });
  const me = useAuth().me;
  return (
    <>
      <PageHead eyebrow="Tickets" title="New ticket" sub="Record a request that came in by phone, by email, or in person. The service-level timers start when you save." />
      <Async loading={lookups.loading && !lookups.data} error={lookups.error}>{() => (
        <form className="card stack" aria-label="New ticket" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="row">
            <label className="field">Site<select id="nt-site" value={f.facilityId} onChange={(e) => set('facilityId', e.target.value)} required><option value="">Choose…</option>{(lookups.data?.sites ?? []).filter((s: any) => can('tickets.work', s.id)).map((s: any) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></label>
            <label className="field">Find a customer<input id="nt-cq" type="search" value={cq} onChange={(e) => setCq(e.target.value)} placeholder="Name or code" /></label>
            <label className="field">Customer<select id="nt-customer" value={f.customerId} onChange={(e) => setF((x) => ({ ...x, customerId: e.target.value, contactId: '', projectId: '', serviceVisitId: '' }))} required><option value="">Choose…</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">Contact<select id="nt-contact" value={f.contactId} onChange={(e) => set('contactId', e.target.value)} disabled={!f.customerId}><option value="">None</option>{(contacts.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_primary ? ' (primary)' : ''}</option>)}</select></label>
          </div>
          <label className="field">Subject<input id="nt-subject" value={f.subject} onChange={(e) => set('subject', e.target.value)} required maxLength={300} /></label>
          <label className="field">Description<textarea id="nt-description" rows={5} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
          <div className="row">
            <label className="field">Priority<select id="nt-priority" value={f.priority} onChange={(e) => set('priority', e.target.value)}>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
            <label className="field">Category<select id="nt-category" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}><option value="">None</option>{(lookups.data?.categories ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">How it arrived<select id="nt-channel" value={f.channel} onChange={(e) => set('channel', e.target.value)}>{CHANNELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">Assign to<select id="nt-assignee" value={f.assigneeUserId} onChange={(e) => set('assigneeUserId', e.target.value)} disabled={!f.facilityId}>
              <option value="">Leave unassigned</option>{me && <option value={me.userId}>Me</option>}{(site.data?.assignees ?? []).filter((a: any) => a.id !== me?.userId && can('tickets.manage', f.facilityId)).map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
          </div>
          <details>
            <summary>Related records (optional)</summary>
            <div className="row">
              <label className="field">Project<select id="nt-project" value={f.projectId} onChange={(e) => set('projectId', e.target.value)}><option value="">None</option>{(options.data?.projects ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></label>
              <label className="field">Asset<select id="nt-asset" value={f.assetId} onChange={(e) => set('assetId', e.target.value)}><option value="">None</option>{(options.data?.assets ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.asset_tag} {p.name}</option>)}</select></label>
              <label className="field">Work order<select id="nt-wo" value={f.workOrderId} onChange={(e) => set('workOrderId', e.target.value)}><option value="">None</option>{(options.data?.workOrders ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.number} {p.title}</option>)}</select></label>
              <label className="field">Field-service visit<select id="nt-visit" value={f.serviceVisitId} onChange={(e) => set('serviceVisitId', e.target.value)}><option value="">None</option>{(options.data?.serviceVisits ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.number} {p.title}</option>)}</select></label>
            </div>
            <label className="row"><input id="nt-retainer" type="checkbox" checked={f.retainerCovered} onChange={(e) => set('retainerCovered', e.target.checked)} /> Covered by the customer’s retainer (a note on the ticket; billing is handled elsewhere)</label>
          </details>
          <div className="row"><button className="primary" disabled={save.busy}>Create ticket</button><Link to="/tickets" className="btn">Cancel</Link><ErrorNote message={save.error} /></div>
        </form>
      )}</Async>
    </>
  );
}

// ---------------------------------------------------------------------------
// One ticket
// ---------------------------------------------------------------------------

const ENTRY_LABEL: Record<string, string> = { reply: 'Reply to customer', customer_reply: 'Customer reply', note: 'Internal note', event: 'Activity' };

export function TicketDetail() {
  const { id } = useParams();
  const { data: t, loading, error, reload } = useApi<any>(`/api/tickets/${id}`);
  return (
    <Async loading={loading && !t} error={error}>{() => t && <TicketBody t={t} reload={reload} />}</Async>
  );
}

function TicketBody({ t, reload }: { t: any; reload: () => Promise<void> }) {
  const lookups = useApi<any>(`/api/tickets/lookups?facilityId=${t.facility_id}`);
  const contacts = useApi<any[]>(`/api/tickets/customers/${t.customer_id}/contacts`);
  const options = useApi<any>(t.can.work ? `/api/tickets/link-options?facilityId=${t.facility_id}&customerId=${t.customer_id}` : null);
  const [kind, setKind] = useState('reply'); const [body, setBody] = useState(''); const [after, setAfter] = useState('');
  const [note, setNote] = useState('');
  const send = useAction(async () => { await api.post(`/api/tickets/${t.id}/entries`, { kind, body, statusAfter: after || undefined }); setBody(''); setAfter(''); await reload(); });
  const move = useAction(async (status: string) => { await api.post(`/api/tickets/${t.id}/status`, { status, note: note || null }); setNote(''); await reload(); });
  const patch = useAction(async (p: Record<string, unknown>) => { await api.patch(`/api/tickets/${t.id}`, p); await reload(); });
  const assign = useAction(async (userId: string | null) => { await api.post(`/api/tickets/${t.id}/assign`, { assigneeUserId: userId }); await reload(); });
  const { me } = useAuth();
  const closed = t.status === 'closed';
  return (
    <>
      <PageHead eyebrow={`${t.number} · ${t.facility_code}`} title={t.subject} sub={<>For <Link to={`/crm/customers/${t.customer_id}`}>{t.customer_name}</Link>{t.contact_name ? `, ${t.contact_name}` : t.requester_name ? `, ${t.requester_name} (${t.requester_contact})` : ''} · {humanize(t.channel === 'email' ? 'email_typed_in' : t.channel)} · raised {fmtDateTime(t.created_at)}</>}
        actions={<Link className="btn" to="/tickets">Back to the queue</Link>} />
      <section className="card stack" aria-label="Status and service level">
        <div className="row"><StatusPill v={t.status} /><PriorityPill v={t.priority} />{t.retainer_covered && <Pill tone="info" label="Covered by retainer" />}<SlaPills sla={t.sla} /></div>
        {t.description && <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>}
        {t.can.work && !closed && (
          <div className="row">
            <strong>Move to</strong>
            {t.next.map((s: string) => <button key={s} disabled={move.busy} onClick={() => move.run(s)}>{STATUS_LABEL[s]}</button>)}
            <label className="field">Note for the history (optional)<input id="tk-status-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></label>
          </div>
        )}
        {closed && t.can.manage && <button onClick={() => move.run('reopened')} disabled={move.busy}>Reopen</button>}
        <ErrorNote message={move.error} />
      </section>

      <div className="grid two">
        <section className="card stack">
          <h2>Timeline</h2>
          <ol className="stack" style={{ listStyle: 'none', padding: 0 }} aria-label="Conversation and activity">
            {t.entries.map((e: any) => (
              <li key={e.id} className={`ticket-entry ${e.kind}`} style={{ borderLeft: `3px solid ${e.customer_visible ? 'var(--accent)' : 'var(--border)'}`, paddingLeft: 10 }}>
                <div className="faint"><strong>{ENTRY_LABEL[e.kind]}</strong> · {e.author_name} · {fmtDateTime(e.created_at)}{e.customer_visible ? ' · the customer can see this' : ' · inside only'}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>
              </li>
            ))}
          </ol>
          {t.can.work && !closed && (
            <form className="stack" aria-label="Add to the ticket" onSubmit={(e) => { e.preventDefault(); void send.run(); }}>
              <div className="row">
                <label className="field">Add<select id="tk-kind" value={kind} onChange={(e) => { setKind(e.target.value); setAfter(''); }}>
                  <option value="reply">Reply to the customer</option><option value="note">Internal note</option><option value="customer_reply">Customer replied (typed in)</option></select></label>
                <label className="field">Insert a canned reply<select id="tk-canned" value="" onChange={(e) => { const c = (lookups.data?.cannedReplies ?? []).find((x: any) => x.id === e.target.value); if (c) setBody((b) => (b ? `${b}\n${c.body}` : c.body)); }}>
                  <option value="">Choose…</option>{(lookups.data?.cannedReplies ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
                {kind !== 'customer_reply' && (
                  <label className="field">Then set status<select id="tk-after" value={after} onChange={(e) => setAfter(e.target.value)}><option value="">Leave as it is</option>{t.next.filter((s: string) => s !== 'closed').map((s: string) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
                )}
              </div>
              <label className="field">Message<textarea id="tk-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} required /></label>
              <p className="faint">{kind === 'reply' ? 'A reply the customer can see answers the first-response target. Nothing is emailed from here: send it by your own channel.' : kind === 'note' ? 'Only your team sees an internal note.' : 'Record what the customer wrote or said. A ticket waiting on the customer picks up again, and the assignee is told.'}</p>
              <div className="row"><button className="primary" disabled={send.busy || !body.trim()}>{kind === 'reply' ? 'Send reply' : kind === 'note' ? 'Add note' : 'Record customer reply'}</button><ErrorNote message={send.error} /></div>
            </form>
          )}
        </section>

        <div className="stack">
          <section className="card stack" aria-label="Details">
            <h2>Details</h2>
            <dl className="facts">
              <dt>Assignee</dt><dd>{t.assignee_name ?? 'Unassigned'}</dd>
            </dl>
            {t.can.work && !closed && (
              <div className="row">
                <label className="field">Assign to<select id="tk-assign" value={t.assignee_user_id ?? ''} onChange={(e) => assign.run(e.target.value || null)}>
                  <option value="">Unassigned</option>{me && <option value={me.userId}>Me</option>}{(lookups.data?.assignees ?? []).filter((a: any) => a.id !== me?.userId && t.can.manage).map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
                <label className="field">Priority<select id="tk-prio" value={t.priority} onChange={(e) => patch.run({ priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
                <label className="field">Category<select id="tk-cat" value={t.category_id ?? ''} onChange={(e) => patch.run({ categoryId: e.target.value || null })}><option value="">None</option>{(lookups.data?.categories ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                <label className="field">Contact<select id="tk-contact" value={t.contact_id ?? ''} onChange={(e) => patch.run({ contactId: e.target.value || null })}><option value="">None</option>{(contacts.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              </div>
            )}
            <ErrorNote message={assign.error ?? patch.error} />
            <dl className="facts">
              <dt>Targets</dt><dd>{t.first_response_target_min ? `First response in ${hours(t.first_response_target_min)}` : 'No first-response target'}; {t.resolution_target_min ? `resolution in ${hours(t.resolution_target_min)}` : 'no resolution target'} (business hours{t.at_risk_pct ? `, at risk from ${t.at_risk_pct}%` : ''})</dd>
              {t.category_name && <><dt>Category</dt><dd>{t.category_name}</dd></>}
              {t.project_id && <><dt>Project</dt><dd>{t.project_number} {t.project_name}</dd></>}
              {t.asset_id && <><dt>Asset</dt><dd><Link to={`/assets/${t.asset_id}`}>{t.asset_tag} {t.asset_name}</Link></dd></>}
              {t.work_order_id && <><dt>Work order</dt><dd><Link to={`/work-orders/${t.work_order_id}`}>{t.work_order_number} {t.work_order_title}</Link></dd></>}
              {t.service_visit_id && <><dt>Visit</dt><dd><Link to={`/service/visits/${t.service_visit_id}`}>{t.service_visit_number}</Link></dd></>}
            </dl>
            {t.can.work && !closed && options.data && <Related t={t} options={options.data} patch={patch} />}
          </section>
          <TimeSection t={t} reload={reload} />
          <Files t={t} reload={reload} />
        </div>
      </div>
    </>
  );
}

const hours = (m: number) => (m % 60 === 0 ? `${m / 60} h` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

function Related({ t, options, patch }: { t: any; options: any; patch: { run: (p: Record<string, unknown>) => Promise<unknown>; busy: boolean } }) {
  const [r, setR] = useState({ projectId: t.project_id ?? '', assetId: t.asset_id ?? '', workOrderId: t.work_order_id ?? '', serviceVisitId: t.service_visit_id ?? '', retainerCovered: !!t.retainer_covered });
  return (
    <details>
      <summary>Related records and retainer</summary>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void patch.run({ projectId: r.projectId || null, assetId: r.assetId || null, workOrderId: r.workOrderId || null, serviceVisitId: r.serviceVisitId || null, retainerCovered: r.retainerCovered }); }}>
        <label className="field">Project<select id="tk-project" value={r.projectId} onChange={(e) => setR({ ...r, projectId: e.target.value })}><option value="">None</option>{options.projects.map((p: any) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></label>
        <label className="field">Asset<select id="tk-asset" value={r.assetId} onChange={(e) => setR({ ...r, assetId: e.target.value })}><option value="">None</option>{options.assets.map((p: any) => <option key={p.id} value={p.id}>{p.asset_tag} {p.name}</option>)}</select></label>
        <label className="field">Work order<select id="tk-wo" value={r.workOrderId} onChange={(e) => setR({ ...r, workOrderId: e.target.value })}><option value="">None</option>{options.workOrders.map((p: any) => <option key={p.id} value={p.id}>{p.number} {p.title}</option>)}</select></label>
        <label className="field">Field-service visit<select id="tk-visit" value={r.serviceVisitId} onChange={(e) => setR({ ...r, serviceVisitId: e.target.value })}><option value="">None</option>{options.serviceVisits.map((p: any) => <option key={p.id} value={p.id}>{p.number} {p.title}</option>)}</select></label>
        <label className="row"><input id="tk-retainer" type="checkbox" checked={r.retainerCovered} onChange={(e) => setR({ ...r, retainerCovered: e.target.checked })} /> Covered by the customer’s retainer</label>
        <div><button disabled={patch.busy}>Save related records</button></div>
      </form>
    </details>
  );
}

function TimeSection({ t, reload }: { t: any; reload: () => Promise<void> }) {
  const [f, setF] = useState({ hours: '', workDate: new Date().toISOString().slice(0, 10), note: '', billable: false });
  const log = useAction(async () => { await api.post(`/api/tickets/${t.id}/time`, { hours: Number(f.hours), workDate: f.workDate, note: f.note || null, billable: f.billable }); setF({ ...f, hours: '', note: '' }); await reload(); });
  const remove = useAction(async (id: string) => { await api.delete(`/api/tickets/${t.id}/time/${id}`); await reload(); });
  return (
    <section className="card stack" aria-label="Time">
      <h2>Time logged · {t.timeTotal} h</h2>
      <Table rows={t.time} empty="No time logged yet." columns={[{ key: 'work_date', label: 'Date', render: (x) => fmtDate(x.work_date) }, { key: 'who', label: 'Who' }, { key: 'hours', label: 'Hours', numeric: true },
        { key: 'billable', label: 'Billable', render: (x) => (x.billable ? 'Yes' : 'No') }, { key: 'note', label: 'Note' }, { key: 'x', label: '', plain: true, render: (x) => <button className="link" disabled={remove.busy} onClick={() => remove.run(x.id)}>Remove</button> }]} />
      {t.can.work && (
        <form className="stack" aria-label="Log time" onSubmit={(e) => { e.preventDefault(); void log.run(); }}>
          <div className="row">
            <label className="field">Hours<input id="tk-hours" type="number" min="0.25" max="24" step="0.25" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} required style={{ width: 90 }} /></label>
            <label className="field">Date<input id="tk-date" type="date" value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value })} required /></label>
            <label className="field">Note<input id="tk-time-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} /></label>
            <label className="row"><input id="tk-billable" type="checkbox" checked={f.billable} disabled={!t.project_id} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable{!t.project_id && <span className="faint"> (needs a project on the ticket)</span>}</label>
          </div>
          <p className="faint">Goes on your timesheet for that week{t.project_id ? ' as project time' : ' as ordinary time'}. A week that is already submitted is closed.</p>
          <div className="row"><button disabled={log.busy}>Log time</button><ErrorNote message={log.error ?? remove.error} /></div>
        </form>
      )}
    </section>
  );
}

function Files({ t, reload }: { t: any; reload: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const up = useAction(async () => { await api.post(`/api/tickets/${t.id}/files`, { fileName: file!.name, mime: file!.type || 'application/octet-stream', contentBase64: await fileToBase64(file!) }); setFile(null); await reload(); });
  return (
    <section className="card stack" aria-label="Files">
      <h2>Files</h2>
      <Table rows={t.files} empty="No files yet." columns={[{ key: 'file_name', label: 'File', render: (f) => <button className="link" onClick={() => api.open(`/api/tickets/${t.id}/files/${f.id}`)}>{f.file_name}</button> },
        { key: 'uploaded_by_name', label: 'Added by' }, { key: 'created_at', label: 'When', render: (f) => fmtDateTime(f.created_at) }]} />
      {t.can.work && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void up.run(); }}>
          <input type="file" aria-label="Add a file" accept="application/pdf,image/png,image/jpeg,image/heic,image/webp,text/plain,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button disabled={!file || up.busy}>Add file</button><ErrorNote message={up.error} />
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Setup: service levels, business hours, lists, public links
// ---------------------------------------------------------------------------

function Setup() {
  const { data: lookups } = useApi<any>('/api/tickets/lookups');
  return (
    <div className="stack">
      <ServiceLevels />
      <Hours sites={lookups?.sites ?? []} />
      <Lists />
      <Links sites={lookups?.sites ?? []} />
    </div>
  );
}

function ServiceLevels() {
  const { data, reload } = useApi<any[]>('/api/tickets/service-levels');
  const customers = useApi<any[]>('/api/tickets/customers');
  const blank = { id: '', name: '', priority: 'normal', customerId: '', first: '', resolution: '', pct: '80', active: true };
  const [f, setF] = useState(blank);
  const save = useAction(async () => {
    const body = { name: f.name, priority: f.priority, customerId: f.customerId || null, firstResponseMinutes: f.first ? Math.round(Number(f.first) * 60) : null, resolutionMinutes: f.resolution ? Math.round(Number(f.resolution) * 60) : null, atRiskPct: Number(f.pct), active: f.active };
    if (f.id) await api.put(`/api/tickets/service-levels/${f.id}`, body); else await api.post('/api/tickets/service-levels', body);
    setF(blank); await reload();
  });
  return (
    <section className="card stack" aria-label="Service levels">
      <h2>Service levels</h2>
      <p className="muted">Targets are in business hours (the site’s calendar below). One active row per priority applies to everyone; a row naming a customer overrides it for that customer. Changing a row affects tickets raised or re-prioritised afterwards, never a promise already made.</p>
      <Table rows={data ?? []} empty="No service levels yet. Without one, tickets of that priority have no timers." columns={[{ key: 'name', label: 'Name' }, { key: 'priority', label: 'Priority', render: (r) => <PriorityPill v={r.priority} /> },
        { key: 'customer_name', label: 'Customer', render: (r) => r.customer_name ?? 'Everyone' }, { key: 'first_response_minutes', label: 'First response', render: (r) => (r.first_response_minutes ? hours(r.first_response_minutes) : 'None') },
        { key: 'resolution_minutes', label: 'Resolution', render: (r) => (r.resolution_minutes ? hours(r.resolution_minutes) : 'None') }, { key: 'at_risk_pct', label: 'At risk from', render: (r) => `${r.at_risk_pct}%` },
        { key: 'active', label: 'State', render: (r) => (r.active ? 'Active' : 'Off') },
        { key: 'e', label: '', plain: true, render: (r) => <button className="link" onClick={() => setF({ id: r.id, name: r.name, priority: r.priority, customerId: r.customer_id ?? '', first: r.first_response_minutes ? String(r.first_response_minutes / 60) : '', resolution: r.resolution_minutes ? String(r.resolution_minutes / 60) : '', pct: String(r.at_risk_pct), active: r.active })}>Edit</button> }]} />
      <form className="stack" aria-label="Service level" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="row">
          <label className="field">Name<input id="sl-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="field">Priority<select id="sl-priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
          <label className="field">Customer (blank = everyone)<select id="sl-customer" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Everyone</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">First response (business hours)<input id="sl-first" type="number" min="0.25" step="0.25" value={f.first} onChange={(e) => setF({ ...f, first: e.target.value })} style={{ width: 110 }} /></label>
          <label className="field">Resolution (business hours)<input id="sl-res" type="number" min="0.25" step="0.25" value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} style={{ width: 110 }} /></label>
          <label className="field">At risk from (%)<input id="sl-pct" type="number" min="1" max="99" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} style={{ width: 80 }} /></label>
          <label className="row"><input id="sl-active" type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        </div>
        <div className="row"><button className="primary" disabled={save.busy}>{f.id ? 'Save service level' : 'Add service level'}</button>{f.id && <button type="button" onClick={() => setF(blank)}>Cancel</button>}<ErrorNote message={save.error} /></div>
      </form>
    </section>
  );
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function Hours({ sites }: { sites: any[] }) {
  const [site, setSite] = useState('');
  useEffect(() => { if (!site && sites.length) setSite(sites[0].id); }, [sites, site]);
  const { data, reload } = useApi<any>(site ? `/api/tickets/calendars/${site}` : null);
  const [tz, setTz] = useState(''); const [days, setDays] = useState<Record<string, [string, string] | null>>({});
  useEffect(() => { if (data) { setTz(data.timeZone); setDays(Object.fromEntries(Object.entries(data.days).map(([k, v]) => [k, v as [string, string] | null]))); } }, [data]);
  const save = useAction(async () => { const r = await api.put(`/api/tickets/calendars/${site}`, { timeZone: tz, days }); await reload(); return r; });
  const [h, setH] = useState({ day: '', name: '', all: false });
  const addH = useAction(async () => { await api.post('/api/tickets/holidays', { facilityId: h.all ? null : site, day: h.day, name: h.name }); setH({ day: '', name: '', all: false }); await reload(); });
  const delH = useAction(async (id: string) => { await api.delete(`/api/tickets/holidays/${id}`); await reload(); });
  return (
    <section className="card stack" aria-label="Business hours">
      <h2>Business hours and holidays</h2>
      <p className="muted">Timers count only inside these hours and pause on holidays. {data && !data.saved ? 'This site has no saved hours yet: Monday to Friday, 9:00 to 17:00 in the site’s time zone applies.' : ''}</p>
      <label className="field">Site<select id="bh-site" value={site} onChange={(e) => setSite(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></label>
      {data && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <label className="field">Time zone<input id="bh-tz" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/New_York" required /></label>
          <table><thead><tr><th scope="col">Day</th><th scope="col">Open</th><th scope="col">From</th><th scope="col">To</th></tr></thead>
            <tbody>{WEEKDAYS.map((name, i) => {
              const k = String(i + 1); const d = days[k] ?? null;
              return (
                <tr key={k}>
                  <th scope="row">{name}</th>
                  <td><input type="checkbox" aria-label={`${name} open`} checked={!!d} onChange={(e) => setDays({ ...days, [k]: e.target.checked ? ['09:00', '17:00'] : null })} /></td>
                  <td><input type="time" aria-label={`${name} opens`} disabled={!d} value={d?.[0] ?? ''} onChange={(e) => setDays({ ...days, [k]: [e.target.value, d![1]] })} /></td>
                  <td><input type="time" aria-label={`${name} closes`} disabled={!d} value={d?.[1] === '24:00' ? '23:59' : d?.[1] ?? ''} onChange={(e) => setDays({ ...days, [k]: [d![0], e.target.value] })} /></td>
                </tr>);
            })}</tbody></table>
          <div className="row"><button className="primary" disabled={save.busy}>Save business hours</button><ErrorNote message={save.error} /></div>
          <p className="faint">Saving recalculates the due times of this site’s open tickets against the new hours.</p>
        </form>
      )}
      <h3>Holidays</h3>
      <Table rows={data?.holidays ?? []} empty="No holidays listed." columns={[{ key: 'day', label: 'Date' }, { key: 'name', label: 'Name' }, { key: 'facility_id', label: 'Applies to', render: (x) => (x.facility_id ? 'This site' : 'All sites') },
        { key: 'x', label: '', plain: true, render: (x) => <button className="link" disabled={delH.busy} onClick={() => delH.run(x.id)}>Remove</button> }]} />
      <form className="row" aria-label="Add a holiday" onSubmit={(e) => { e.preventDefault(); void addH.run(); }}>
        <label className="field">Date<input id="hol-day" type="date" value={h.day} onChange={(e) => setH({ ...h, day: e.target.value })} required /></label>
        <label className="field">Name<input id="hol-name" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} required /></label>
        <label className="row"><input id="hol-all" type="checkbox" checked={h.all} onChange={(e) => setH({ ...h, all: e.target.checked })} /> All sites</label>
        <button disabled={addH.busy}>Add holiday</button><ErrorNote message={addH.error ?? delH.error} />
      </form>
    </section>
  );
}

function Lists() {
  const cats = useApi<any[]>('/api/tickets/categories'); const canned = useApi<any[]>('/api/tickets/canned-replies');
  const [c, setC] = useState(''); const [r, setR] = useState({ title: '', body: '' });
  const addC = useAction(async () => { await api.post('/api/tickets/categories', { name: c }); setC(''); await cats.reload(); });
  const toggleC = useAction(async (x: any) => { await api.put(`/api/tickets/categories/${x.id}`, { name: x.name, active: !x.active }); await cats.reload(); });
  const addR = useAction(async () => { await api.post('/api/tickets/canned-replies', r); setR({ title: '', body: '' }); await canned.reload(); });
  const toggleR = useAction(async (x: any) => { await api.put(`/api/tickets/canned-replies/${x.id}`, { title: x.title, body: x.body, active: !x.active }); await canned.reload(); });
  return (
    <section className="card stack" aria-label="Categories and canned replies">
      <h2>Categories</h2>
      <Table rows={cats.data ?? []} empty="No categories yet." tools={false} columns={[{ key: 'name', label: 'Category' }, { key: 'active', label: 'State', render: (x) => (x.active ? 'Active' : 'Off') },
        { key: 'x', label: '', plain: true, render: (x) => <button className="link" onClick={() => toggleC.run(x)}>{x.active ? 'Turn off' : 'Turn on'}</button> }]} />
      <form className="row" aria-label="Add a category" onSubmit={(e) => { e.preventDefault(); void addC.run(); }}>
        <label className="field">New category<input id="cat-name" value={c} onChange={(e) => setC(e.target.value)} required /></label><button disabled={addC.busy}>Add category</button><ErrorNote message={addC.error ?? toggleC.error} />
      </form>
      <h2>Canned replies</h2>
      <Table rows={canned.data ?? []} empty="No canned replies yet." tools={false} columns={[{ key: 'title', label: 'Title' }, { key: 'body', label: 'Text' }, { key: 'active', label: 'State', render: (x) => (x.active ? 'Active' : 'Off') },
        { key: 'x', label: '', plain: true, render: (x) => <button className="link" onClick={() => toggleR.run(x)}>{x.active ? 'Turn off' : 'Turn on'}</button> }]} />
      <form className="stack" aria-label="Add a canned reply" onSubmit={(e) => { e.preventDefault(); void addR.run(); }}>
        <label className="field">Title<input id="cr-title" value={r.title} onChange={(e) => setR({ ...r, title: e.target.value })} required /></label>
        <label className="field">Text<textarea id="cr-body" rows={3} value={r.body} onChange={(e) => setR({ ...r, body: e.target.value })} required /></label>
        <div className="row"><button disabled={addR.busy}>Add canned reply</button><ErrorNote message={addR.error ?? toggleR.error} /></div>
      </form>
    </section>
  );
}

function Links({ sites }: { sites: any[] }) {
  const [site, setSite] = useState('');
  useEffect(() => { if (!site && sites.length) setSite(sites[0].id); }, [sites, site]);
  const { data, reload } = useApi<any[]>(site ? `/api/tickets/intake-links?facilityId=${site}` : null);
  const customers = useApi<any[]>('/api/tickets/customers');
  const [f, setF] = useState({ customerId: '', label: '' }); const [created, setCreated] = useState<string | null>(null);
  const create = useAction(async () => { const l = await api.post('/api/tickets/intake-links', { facilityId: site, customerId: f.customerId, label: f.label }); setCreated(`${window.location.origin}/t/${l.token}`); setF({ customerId: '', label: '' }); await reload(); });
  const revoke = useAction(async (id: string) => { await api.post(`/api/tickets/intake-links/${id}/revoke`, {}); await reload(); });
  return (
    <section className="card stack" aria-label="Public ticket links">
      <h2>Public ticket links</h2>
      <p className="muted">A link for one customer’s staff to raise a ticket without signing in. It can only raise a new ticket for that customer at this site (never the top priority), at most 20 an hour. Give each customer their own link; revoke it if it leaks.</p>
      <label className="field">Site<select id="pl-site" value={site} onChange={(e) => setSite(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></label>
      {created && <div className="notice"><strong>Copy this link now</strong> (it is not shown again): <span className="mono" id="ticket-link-url">{created}</span></div>}
      <Table rows={data ?? []} empty="No links yet." columns={[{ key: 'label', label: 'Label' }, { key: 'customer_name', label: 'Customer' }, { key: 'created_at', label: 'Created', render: (l) => `${fmtDateTime(l.created_at)} by ${l.created_by}` },
        { key: 'tickets', label: 'Tickets', numeric: true }, { key: 'active', label: '', plain: true, render: (l) => (l.active ? <button className="link" disabled={revoke.busy} onClick={() => revoke.run(l.id)}>Revoke</button> : <Pill label="revoked" />) }]} />
      <form className="row" aria-label="Create a link" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
        <label className="field">Customer<select id="pl-customer" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} required><option value="">Choose…</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field">Label<input id="pl-label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder='For example "Acme staff, help page"' required /></label>
        <button disabled={create.busy || !site}>Create link</button><ErrorNote message={create.error ?? revoke.error} />
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The no-sign-in form behind a customer's ticket link. Talks only to /public/tickets/:token.
// ---------------------------------------------------------------------------

export function PublicTicket() {
  const { token } = useParams();
  const [form, setForm] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', contact: '', subject: '', description: '', categoryId: '', urgent: false });
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/public/tickets/${encodeURIComponent(token ?? '')}`).then(async (r) => (r.ok ? setForm(await r.json()) : setErr('This link is not active. Please contact your support team.'))).catch(() => setErr('Could not load the form.'));
  }, [token]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/public/tickets/${encodeURIComponent(token ?? '')}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: f.name, contact: f.contact, subject: f.subject, description: f.description, categoryId: f.categoryId || null, urgent: f.urgent }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error?.message ?? 'Could not send the request.');
      setDone(b.reference);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <main className="public-page" style={{ maxWidth: 560, margin: '0 auto', padding: 16 }}>
      {done ? (
        <section className="card stack">
          <h1 style={{ margin: 0 }}>Thank you</h1>
          <p>Your request has reached the support team. Your reference is <strong className="mono">{done}</strong>. Please quote it if you contact us about this.</p>
        </section>
      ) : !form ? <section className="card">{err ?? 'Loading…'}</section> : (
        <form className="card stack" aria-label="Raise a support ticket" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="eyebrow">{form.site} · {form.customer}</div>
          <h1 style={{ margin: 0 }}>Ask for support</h1>
          <label className="field">Your name<input id="pt-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="field">Phone or email<input id="pt-contact" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} required minLength={3} /></label>
          <label className="field">What do you need help with? (a short title)<input id="pt-subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required maxLength={300} /></label>
          <label className="field">Tell us more<textarea id="pt-description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required minLength={5} rows={5} /></label>
          {form.categories.length > 0 && <label className="field">Topic<select id="pt-category" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">Not sure</option>{form.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <label className="row"><input id="pt-urgent" type="checkbox" checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })} /> This is urgent (work is stopped)</label>
          <div className="row"><button className="primary" disabled={busy}>Send request</button><ErrorNote message={err} /></div>
        </form>
      )}
    </main>
  );
}
