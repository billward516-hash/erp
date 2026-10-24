import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtNum, fmtPct } from '../format';
import { useAction, useApi } from '../hooks';

/**
 * Staffing and utilization (SC-009 P3, D-188C). Capacity grid (people down, weeks across), assignments of people to projects with
 * conflict warnings, utilization against targets, time off, and the company setup (default week, holidays, targets).
 */
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekStartOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const today = () => new Date().toISOString().slice(0, 10);
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const h = (n: number | null | undefined) => (n == null ? '—' : `${fmtNum(n, 1)} h`);

type CellStatus = 'over' | 'full' | 'partial' | 'unbooked' | 'off';
const SYMBOL: Record<CellStatus, string> = { over: '▲', full: '●', partial: '◐', unbooked: '○', off: '–' };
const TONE: Record<CellStatus, 'bad' | 'good' | 'info' | 'watch' | 'neutral'> = { over: 'bad', full: 'good', partial: 'info', unbooked: 'watch', off: 'neutral' };
const LEGEND: [CellStatus, string][] = [['over', 'Over-allocated: booked above available hours'], ['full', 'Fully booked'], ['partial', 'Part booked: some hours free'], ['unbooked', 'Unbooked: hours available, nothing booked'], ['off', 'Not working: no available hours']];

export function Staffing() {
  const { can, me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const manage = can('staffing.manage');
  const tabs: [string, string][] = [['capacity', 'Capacity'], ['utilization', 'Utilization'], ['timeoff', 'Time off'], ...(manage ? [['setup', 'Setup'] as [string, string]] : [])];
  const tab = tabs.some(([k]) => k === sp.get('tab')) ? sp.get('tab')! : 'capacity';
  const setTab = (t: string) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  return (
    <>
      <PageHead eyebrow="Service companies" title="Staffing" sub="Who is booked on which project, how much capacity is left once holidays and time off are taken out, and how much of the available time is billed." />
      <div className="row" role="tablist" aria-label="Staffing views">
        {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'capacity' && <Capacity sp={sp} setSp={setSp} />}
      {tab === 'utilization' && <Utilization />}
      {tab === 'timeoff' && <TimeOff ownId={me?.employeeId ?? null} />}
      {tab === 'setup' && manage && <Setup />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Capacity grid
// ---------------------------------------------------------------------------------------------------------------------
function Capacity({ sp, setSp }: { sp: URLSearchParams; setSp: (p: URLSearchParams, o?: { replace?: boolean }) => void }) {
  const [from, setFrom] = useState(weekStartOf(sp.get('from') ?? today()));
  const [weeks, setWeeks] = useState(8);
  const [site, setSite] = useState(''); const [dept, setDept] = useState(''); const [mgr, setMgr] = useState('');
  const person = sp.get('person'); const project = sp.get('project');
  const q = new URLSearchParams({ from, weeks: String(weeks) });
  if (site) q.set('facilityId', site); if (dept) q.set('departmentId', dept); if (mgr) q.set('managerId', mgr); if (project) q.set('projectId', project);
  const grid = useApi<any>(`/api/staffing/overview?${q}`);
  const pick = (key: 'person' | 'project', id: string | null) => { const n = new URLSearchParams(sp); if (id) n.set(key, id); else n.delete(key); setSp(n, { replace: true }); };
  const d = grid.data;
  const rows: any[] = d?.rows ?? [];
  return (
    <>
      <section className="card stack">
        <div className="row" role="group" aria-label="Weeks shown">
          <button onClick={() => setFrom(addDays(from, -7 * Math.max(1, Math.floor(weeks / 2))))} aria-label="Earlier weeks">←</button>
          <strong>Weeks from {shortDay(from)}</strong>
          <button onClick={() => setFrom(addDays(from, 7 * Math.max(1, Math.floor(weeks / 2))))} aria-label="Later weeks">→</button>
          {from !== weekStartOf(today()) && <button onClick={() => setFrom(weekStartOf(today()))}>This week</button>}
          <label className="field"><span className="sr-only">Number of weeks</span>
            <select aria-label="Number of weeks" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[4, 8, 13, 26].map((n) => <option key={n} value={n}>{n} weeks</option>)}</select></label>
          {d?.sites?.length > 1 && <select aria-label="Site" value={site} onChange={(e) => setSite(e.target.value)}><option value="">All sites</option>{d.sites.map((s: any) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>}
          {d?.departments?.length > 0 && <select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{d.departments.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          {d?.managers?.length > 0 && <select aria-label="Manager" value={mgr} onChange={(e) => setMgr(e.target.value)}><option value="">Everyone</option>{d.managers.map((s: any) => <option key={s.id} value={s.id}>Reports to {s.name}</option>)}</select>}
        </div>
        <ul className="row legend" aria-label="What each state means" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {LEGEND.map(([k, text]) => <li key={k}><span className={`pill ${TONE[k] === 'neutral' ? '' : TONE[k]}`}><span aria-hidden="true">{SYMBOL[k]}</span> {text}</span></li>)}
        </ul>
        {project && <div className="notice warn" role="status">Showing only people booked on this project. <button className="link" onClick={() => pick('project', null)}>Show everyone</button></div>}
        <Async loading={grid.loading} error={grid.error}>{() => (
          !rows.length ? <div className="empty">{project ? 'Nobody is booked on this project in these weeks.' : 'No people to show. People appear here once they are employees with a home site; ask an administrator if someone is missing.'}</div> : (
            <div className="table-wrap">
              <table className="cap-grid" aria-label="Capacity by person and week">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    {d.weeks.map((w: string) => <th key={w} scope="col" className="n">{shortDay(w)}</th>)}
                    <th scope="col" className="n">Booked / available</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.person.id} className={person === r.person.id ? 'selected' : ''}>
                      <th scope="row">
                        <button className="link" onClick={() => pick('person', r.person.id)} aria-label={`Open ${r.person.name}`}>{r.person.name}</button>
                        <div className="faint">{r.person.job_title ?? ''}{d.sites.length > 1 ? ` · ${r.person.facility_code}` : ''}{r.person.excluded ? ' · not staffed on projects' : ''}</div>
                      </th>
                      {r.cells.map((c: any) => (
                        <td key={c.weekStart} className="n">
                          <button className={`cap-cell s-${c.status}`} onClick={() => pick('person', r.person.id)}
                            aria-label={`${r.person.name}, week of ${shortDay(c.weekStart)}: ${c.label}. ${fmtNum(c.booked, 1)} hours booked of ${fmtNum(c.available, 1)} available${c.over ? `, ${fmtNum(c.over, 1)} over` : ''}${c.tentative ? `, ${fmtNum(c.tentative, 1)} tentative` : ''}`}>
                            <span className="cap-num">{fmtNum(c.booked, 1)} / {fmtNum(c.available, 1)}</span>
                            <span className="cap-label"><span aria-hidden="true">{SYMBOL[c.status as CellStatus]}</span> {c.label}{c.tentative > 0 ? ' · incl. tentative' : ''}</span>
                            {typeof c.project === 'number' && <span className="cap-label">This project: {fmtNum(c.project, 1)} h</span>}
                          </button>
                        </td>
                      ))}
                      <td className="n">{fmtNum(r.booked, 1)} / {fmtNum(r.available, 1)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Everyone shown</th>
                    {d.weeks.map((w: string, i: number) => {
                      const cap = rows.reduce((s, r) => s + r.cells[i].available, 0); const bk = rows.reduce((s, r) => s + r.cells[i].booked, 0);
                      return <td key={w} className="n">{fmtNum(bk, 1)} / {fmtNum(cap, 1)}</td>;
                    })}
                    <td className="n">{fmtNum(rows.reduce((s, r) => s + r.booked, 0), 1)} / {fmtNum(rows.reduce((s, r) => s + r.available, 0), 1)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ))}
        </Async>
        <p className="faint">Each cell is hours booked / hours available that week. Available hours are the working pattern less company holidays and approved time off. Tentative bookings count as booked. Open a person to see and change their bookings.</p>
      </section>
      {person && <PersonPanel key={person} id={person} from={from} onClose={() => pick('person', null)} onChanged={() => void grid.reload()} onProject={(id) => pick('project', id)} people={rows.map((r) => ({ id: r.person.id, name: r.person.name }))} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// One person: capacity by week, assignments, time off, working pattern
// ---------------------------------------------------------------------------------------------------------------------
function PersonPanel({ id, from, onClose, onChanged, onProject, people }: { id: string; from: string; onClose: () => void; onChanged: () => void; onProject: (id: string) => void; people: { id: string; name: string }[] }) {
  const detail = useApi<any>(`/api/staffing/people/${id}?from=${from}&weeks=12`);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const reload = async () => { await detail.reload(); onChanged(); };
  const remove = useAction(async (a: any) => {
    const reason = window.prompt(`Remove ${a.project_number ?? 'this assignment'} from ${a.employee_name}? Say why (optional).`, '');
    if (reason === null) return;
    await api.delete(`/api/staffing/assignments/${a.id}${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`); await reload();
  });
  return (
    <section className="card stack" aria-label="Person detail">
      <Async loading={detail.loading} error={detail.error}>{() => {
        const d = detail.data; const p = d.person; const u = d.utilization;
        return (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div><h2>{p.name}</h2><p className="muted">{p.job_title ?? 'No job title'} · {p.facility_code}{p.manager ? ` · reports to ${p.manager}` : ''}</p></div>
              <button onClick={onClose}>Close</button>
            </div>
            <Kpis items={[
              { label: 'Utilization, last 90 days', value: u?.utilization == null ? 'No approved time' : fmtPct(u.utilization), note: u?.utilization == null ? undefined : `${h(u.billable)} of ${h(u.available)}`, tone: u?.gap == null ? undefined : u.gap >= 0 ? 'good' : 'watch' },
              { label: 'Target', value: `${d.target.pct}%`, note: d.target.source === 'person' ? 'personal' : d.target.source === 'role' ? 'for the job title' : 'company' },
            ]} />
            <h3>Capacity by week</h3>
            <Table rows={d.grid.cells} rowKey={(c: any) => c.weekStart} tools={false} empty="No weeks."
              columns={[{ key: 'weekStart', label: 'Week of', render: (c: any) => shortDay(c.weekStart) },
                { key: 'scheduled', label: 'Scheduled', numeric: true, render: (c: any) => h(c.scheduled) },
                { key: 'holiday', label: 'Holiday', numeric: true, render: (c: any) => h(c.holiday) },
                { key: 'timeOff', label: 'Time off', numeric: true, render: (c: any) => h(c.timeOff) },
                { key: 'available', label: 'Available', numeric: true, render: (c: any) => h(c.available) },
                { key: 'booked', label: 'Booked', numeric: true, render: (c: any) => `${h(c.booked)}${c.tentative ? ` (${h(c.tentative)} tentative)` : ''}` },
                { key: 'status', label: 'State', render: (c: any) => <Pill tone={TONE[c.status as CellStatus]} label={`${SYMBOL[c.status as CellStatus]} ${c.label}${c.over ? ` by ${fmtNum(c.over, 1)} h` : c.free ? ` · ${fmtNum(c.free, 1)} h free` : ''}`} /> }]} />
            <div className="row" style={{ justifyContent: 'space-between' }}><h3>Assignments</h3>{d.canManage && editing === null && <button className="primary" onClick={() => setEditing('new')}>Add an assignment</button>}</div>
            <ErrorNote message={remove.error} />
            {editing !== null && <AssignmentForm key={editing === 'new' ? 'new' : editing.id} employeeId={id} editing={editing === 'new' ? null : editing} people={people} onDone={async () => { setEditing(null); await reload(); }} onCancel={() => setEditing(null)} />}
            <Table rows={d.assignments} tools={false} empty="Not assigned to any project."
              columns={[{ key: 'project', label: 'Project', render: (a: any) => a.project_number ? <button className="link" onClick={() => onProject(a.project_id)}>{a.project_number} {a.project_name}</button> : <span className="faint">Project at another site</span> },
                { key: 'role', label: 'Role' },
                { key: 'hours_per_week', label: 'Hours a week', numeric: true, render: (a: any) => fmtNum(a.hours_per_week, 1) },
                { key: 'dates', label: 'Dates', render: (a: any) => `${fmtDate(a.start_date)} to ${fmtDate(a.end_date)}` },
                { key: 'state', label: 'State', render: (a: any) => <Pill tone={a.state === 'confirmed' ? 'good' : 'watch'} label={a.state === 'confirmed' ? 'Confirmed' : 'Tentative'} /> },
                { key: 'billable', label: 'Billable', render: (a: any) => (a.billable ? 'Yes' : 'No') },
                { key: 'override_reason', label: 'Conflict note', render: (a: any) => a.override_reason ?? '' },
                { key: 'act', label: 'Actions', plain: true, render: (a: any) => (
                  <span className="row">
                    {d.canManage && <button onClick={() => setEditing(a)} aria-label={`Edit or move ${a.project_number ?? 'assignment'}`}>Edit or move</button>}
                    <button onClick={() => setHistoryOf(historyOf === a.id ? null : a.id)} aria-expanded={historyOf === a.id}>History</button>
                    {d.canManage && <button className="danger" onClick={() => void remove.run(a)} disabled={remove.busy}>Remove</button>}
                  </span>) }]} />
            {historyOf && <History id={historyOf} />}
            <h3>Time off</h3>
            <Table rows={d.timeOff} tools={false} empty="No time off recorded." columns={[{ key: 'from_date', label: 'From', render: (t: any) => fmtDate(t.from_date) }, { key: 'to_date', label: 'To', render: (t: any) => fmtDate(t.to_date) },
              { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status', render: (t: any) => <Pill value={t.status} tone={t.status === 'approved' ? 'good' : t.status === 'requested' ? 'info' : 'neutral'} /> }]} />
            <Patterns personId={id} patterns={d.patterns} canManage={d.canManage} defaultHours={d.settings.defaultHours} onChanged={reload} />
            {d.canManage && <Tracking personId={id} excluded={p.excluded} onChanged={reload} />}
          </>
        );
      }}</Async>
    </section>
  );
}

function History({ id }: { id: string }) {
  const hist = useApi<any[]>(`/api/staffing/assignments/${id}/history`);
  return (
    <section className="card" aria-label="Assignment history">
      <h3>History of this assignment</h3>
      <Async loading={hist.loading} error={hist.error}>{() => (
        <ul className="timeline">
          {(hist.data ?? []).map((e) => (
            <li key={e.id}><span className="faint">{new Date(e.occurred_at).toLocaleString()}</span>
              <span><strong>{e.actor ?? 'System'}</strong> {String(e.action).replace('staffing.assignment_', '').replace(/_/g, ' ')}
                {e.data?.changed ? `: ${Object.entries(e.data.changed).map(([k, v]: any) => `${k} ${v.from ?? '—'} → ${v.to ?? '—'}`).join('; ')}` : ''}
                {e.data?.overrideReason ? ` (conflict note: ${e.data.overrideReason})` : ''}{e.data?.reason ? ` (${e.data.reason})` : ''}</span></li>))}
        </ul>)}
      </Async>
    </section>
  );
}

function AssignmentForm({ employeeId, editing, people, onDone, onCancel }: { employeeId: string; editing: any | null; people: { id: string; name: string }[]; onDone: () => Promise<void>; onCancel: () => void }) {
  const projects = useApi<any[]>('/api/staffing/project-options');
  const [f, setF] = useState({
    projectId: editing?.project_id ?? '', employeeId: editing?.employee_id ?? employeeId, role: editing?.role ?? '', hoursPerWeek: String(editing?.hours_per_week ?? 20),
    startDate: editing?.start_date ?? weekStartOf(today()), endDate: editing?.end_date ?? addDays(weekStartOf(today()), 27), state: editing?.state ?? 'tentative', billable: editing?.billable ?? true, note: editing?.note ?? '',
  });
  const [warnings, setWarnings] = useState<any[] | null>(null);
  const [reason, setReason] = useState(editing?.override_reason ?? '');
  const body = () => ({ ...f, hoursPerWeek: Number(f.hoursPerWeek), role: f.role.trim() || null, note: f.note.trim() || null, overrideReason: reason.trim() || null });
  const save = useAction(async (confirmed: boolean) => {
    if (!confirmed) {
      const pre = await api.post('/api/staffing/assignments/preview', { ...body(), ...(editing ? { assignmentId: editing.id } : {}) });
      if (pre.warnings.length) { setWarnings(pre.warnings); return; }
    }
    if (editing) await api.patch(`/api/staffing/assignments/${editing.id}`, body()); else await api.post('/api/staffing/assignments', body());
    await onDone();
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setWarnings(null); void save.run(false); };
  const set = (k: string, v: unknown) => { setF({ ...f, [k]: v }); setWarnings(null); };
  return (
    <form className="card form" onSubmit={submit} aria-label={editing ? 'Edit or move the assignment' : 'New assignment'}>
      <h3>{editing ? 'Edit or move the assignment' : 'New assignment'}</h3>
      <div className="form-grid">
        <label className="field">Project
          <select required value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>
            <option value="">Choose a project</option>
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
            {editing && !(projects.data ?? []).some((p) => p.id === editing.project_id) && <option value={editing.project_id}>{editing.project_number}</option>}
          </select></label>
        {editing && <label className="field">Person
          <select value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        <label className="field">Role on the project<input value={f.role} onChange={(e) => set('role', e.target.value)} placeholder="Lead consultant" maxLength={100} /></label>
        <label className="field">Hours a week<input type="number" min="0.5" max="168" step="0.5" required value={f.hoursPerWeek} onChange={(e) => set('hoursPerWeek', e.target.value)} /></label>
        <label className="field">From<input type="date" required value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></label>
        <label className="field">Until<input type="date" required value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></label>
        <label className="field">State
          <select value={f.state} onChange={(e) => set('state', e.target.value)}><option value="tentative">Tentative</option><option value="confirmed">Confirmed</option></select></label>
        <label className="field"><span>Billable</span><span className="row"><input type="checkbox" checked={f.billable} onChange={(e) => set('billable', e.target.checked)} /> Time on this assignment is billable</span></label>
      </div>
      <label className="field">Note<input value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={1000} /></label>
      {warnings && (
        <div className="notice warn" role="alert">
          <strong>This overbooks {warnings.length === 1 ? 'one week' : `${warnings.length} weeks`}.</strong> You can still save it.
          <ul>{warnings.slice(0, 8).map((w) => <li key={w.weekStart}>Week of {shortDay(w.weekStart)}: {h(w.total)} booked against {h(w.available)} available ({h(w.over)} over).</li>)}{warnings.length > 8 && <li>and {warnings.length - 8} more weeks</li>}</ul>
          <label className="field">Why save it anyway? (kept with the assignment)<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></label>
          <div className="row"><button type="button" className="primary" onClick={() => void save.run(true)} disabled={save.busy}>Save anyway</button><button type="button" onClick={() => setWarnings(null)}>Change the plan</button></div>
        </div>
      )}
      <ErrorNote message={save.error} />
      <div className="row"><button className="primary" type="submit" disabled={save.busy || !f.projectId}>{editing ? 'Check and save' : 'Check and add'}</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function Patterns({ personId, patterns, canManage, defaultHours, onChanged }: { personId: string; patterns: any[]; canManage: boolean; defaultHours: number[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(today());
  const [hours, setHours] = useState<string[]>(defaultHours.map(String));
  const save = useAction(async () => { await api.post('/api/staffing/patterns', { employeeId: personId, effectiveFrom: from, hours: hours.map(Number) }); setOpen(false); await onChanged(); });
  const del = useAction(async (id: string) => { await api.delete(`/api/staffing/patterns/${id}`); await onChanged(); });
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}><h3>Working pattern</h3>{canManage && !open && <button onClick={() => setOpen(true)}>Set a pattern</button>}</div>
      <p className="muted">{patterns.length ? 'Hours per weekday from the date shown. The latest pattern that has started applies.' : `No pattern of their own: the company week applies (${defaultHours.map((x, i) => `${DOW[i]} ${x}`).join(', ')}).`}</p>
      <ErrorNote message={save.error ?? del.error} />
      {patterns.length > 0 && <Table rows={patterns} tools={false} columns={[{ key: 'effective_from', label: 'From', render: (p: any) => fmtDate(p.effective_from) },
        { key: 'hours', label: 'Hours', render: (p: any) => p.hours.map((x: number, i: number) => `${DOW[i]} ${x}`).join(', ') },
        { key: 'act', label: '', plain: true, render: (p: any) => canManage ? <button className="danger" onClick={() => void del.run(p.id)}>Remove</button> : null }]} />}
      {open && (
        <form className="card form" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label="Working pattern">
          <label className="field">Starting on<input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <div className="week-grid">{DOW.map((d, i) => <label key={d} className="field">{d}<input type="number" min="0" max="24" step="0.25" value={hours[i]} onChange={(e) => setHours(hours.map((x, j) => (j === i ? e.target.value : x)))} /></label>)}</div>
          <div className="row"><button className="primary" type="submit" disabled={save.busy}>Save pattern</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
    </>
  );
}

function Tracking({ personId, excluded, onChanged }: { personId: string; excluded: boolean; onChanged: () => Promise<void> }) {
  const set = useAction(async (staffed: boolean) => { await api.put(`/api/staffing/people/${personId}/tracking`, { staffed }); await onChanged(); });
  return (
    <div className="row">
      <span className="muted">{excluded ? 'Not staffed on projects: left out of utilization, the bench report, the forecast and reminders.' : 'Staffed on projects: counted in utilization, the bench report, the forecast and reminders.'}</span>
      <button onClick={() => void set.run(excluded)} disabled={set.busy}>{excluded ? 'Count this person as staffed' : 'Leave this person out'}</button>
      <ErrorNote message={set.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Utilization
// ---------------------------------------------------------------------------------------------------------------------
function Utilization() {
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`); const [to, setTo] = useState(today()); const [by, setBy] = useState('person');
  const u = useApi<any>(`/api/staffing/utilization?from=${from}&to=${to}&by=${by}`);
  const label = ({ person: 'Person', department: 'Department', manager: 'Manager', site: 'Site', role: 'Job title' } as Record<string, string>)[by] ?? 'Group';
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="field">Group by<select value={by} onChange={(e) => setBy(e.target.value)}><option value="person">Person</option><option value="department">Department</option><option value="manager">Manager</option><option value="site">Site</option><option value="role">Job title</option></select></label>
      </div>
      <Async loading={u.loading} error={u.error}>{() => {
        const d = u.data; const t = d.total;
        return (
          <>
            {!d.anyData && <div className="notice warn" role="status">No approved timesheets in this period, so utilization cannot be calculated yet. It is the billable share of available hours, taken from approved timesheets with hours marked billable. Available hours are shown so you can see the capacity.</div>}
            <Kpis items={[
              { label: 'Utilization', value: t?.utilization == null ? 'No approved time' : fmtPct(t.utilization), note: t?.target == null ? undefined : `target ${fmtNum(t.target, 0)}%`, tone: t?.gap == null ? undefined : t.gap >= 0 ? 'good' : 'watch' },
              { label: 'Billable hours', value: h(t?.billable ?? 0) }, { label: 'Available hours', value: h(t?.available ?? 0) },
              { label: 'People with approved time', value: `${t?.peopleWithData ?? 0} of ${t?.people ?? 0}` },
            ]} />
            <Table rows={d.groups} rowKey={(g: any) => g.key} empty="Nobody to show." exception={(g: any) => g.gap != null && g.gap < 0}
              columns={[{ key: 'label', label }, { key: 'peopleWithData', label: 'People with approved time', numeric: true, render: (g: any) => `${g.peopleWithData} of ${g.people}` },
                { key: 'available', label: 'Available', numeric: true, render: (g: any) => h(g.available) }, { key: 'billable', label: 'Billable', numeric: true, render: (g: any) => h(g.billable) },
                { key: 'pendingBillable', label: 'Billable, not yet approved', numeric: true, render: (g: any) => h(g.pendingBillable) },
                { key: 'utilization', label: 'Utilization', numeric: true, render: (g: any) => (g.utilization == null ? 'No approved time' : fmtPct(g.utilization)), value: (g: any) => g.utilization },
                { key: 'target', label: 'Target', numeric: true, render: (g: any) => (g.target == null ? '—' : `${fmtNum(g.target, 0)}%`) },
                { key: 'gap', label: 'Against target', render: (g: any) => (g.gap == null ? <span className="faint">—</span> : <Pill tone={g.gap >= 0 ? 'good' : 'watch'} label={g.gap >= 0 ? `On or above target (+${(g.gap * 100).toFixed(1)} pts)` : `Below target (${(g.gap * 100).toFixed(1)} pts)`} />), value: (g: any) => g.gap }]} />
            <p className="faint">Counted through {fmtDate(d.throughDate)}: whole days that have passed. Only approved timesheets count; hours on submitted timesheets are shown as not yet approved. Team figures include only people with approved time. People left out of staffing are not shown.</p>
          </>
        );
      }}</Async>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------------------------------------------------
function TimeOff({ ownId }: { ownId: string | null }) {
  const { can, me } = useAuth();
  const manage = can('staffing.manage');
  const list = useApi<any[]>('/api/staffing/time-off');
  const people = useApi<any[]>(manage ? '/api/staffing/people' : null);
  const [f, setF] = useState({ employeeId: ownId ?? '', fromDate: today(), toDate: today(), hoursPerDay: '', kind: 'vacation', note: '' });
  const ask = useAction(async () => {
    await api.post('/api/staffing/time-off', { ...(f.employeeId && f.employeeId !== ownId ? { employeeId: f.employeeId } : {}), fromDate: f.fromDate, toDate: f.toDate, hoursPerDay: f.hoursPerDay ? Number(f.hoursPerDay) : null, kind: f.kind, note: f.note.trim() || null });
    setF({ ...f, note: '' }); await list.reload();
  });
  const act = useAction(async (id: string, what: 'approve' | 'reject' | 'cancel') => {
    if (what === 'cancel') await api.post(`/api/staffing/time-off/${id}/cancel`, {});
    else await api.post(`/api/staffing/time-off/${id}/decide`, { decision: what });
    await list.reload();
  });
  const forSomeoneElse = !!f.employeeId && f.employeeId !== ownId;
  return (
    <>
      <section className="card stack">
        <h2>{forSomeoneElse ? 'Enter time off for someone' : 'Ask for time off'}</h2>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void ask.run(); }} aria-label="Time off request">
          <div className="form-grid">
            {manage && <label className="field">Person<select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>{ownId ? null : <option value="">Choose a person</option>}{(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === ownId ? ' (me)' : ''}</option>)}</select></label>}
            <label className="field">First day<input type="date" required value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value, toDate: e.target.value > f.toDate ? e.target.value : f.toDate })} /></label>
            <label className="field">Last day<input type="date" required value={f.toDate} min={f.fromDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></label>
            <label className="field">Hours per day (blank: whole days)<input type="number" min="0.5" max="24" step="0.5" value={f.hoursPerDay} onChange={(e) => setF({ ...f, hoursPerDay: e.target.value })} /></label>
            <label className="field">Kind<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['vacation', 'sick', 'personal', 'training', 'other'].map((k) => <option key={k} value={k}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}</select></label>
          </div>
          <label className="field">Note<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} /></label>
          <p className="faint">{forSomeoneElse ? 'Time off a manager enters for someone else is recorded as approved.' : 'Your request waits for a manager. It reduces your available hours once approved.'}</p>
          <ErrorNote message={ask.error} />
          <div><button className="primary" type="submit" disabled={ask.busy || !f.employeeId}>{forSomeoneElse ? 'Record time off' : 'Send request'}</button></div>
        </form>
      </section>
      <section className="card stack">
        <h2>Time off</h2>
        <ErrorNote message={act.error} />
        <Async loading={list.loading} error={list.error}>{() => (
          <Table rows={list.data ?? []} rowKey={(t: any) => `${t.source}${t.id}`} empty="No time off recorded."
            columns={[{ key: 'employee_name', label: 'Person' }, { key: 'from_date', label: 'From', render: (t: any) => fmtDate(t.from_date) }, { key: 'to_date', label: 'To', render: (t: any) => fmtDate(t.to_date) },
              { key: 'hours_per_day', label: 'Hours a day', numeric: true, render: (t: any) => (t.hours_per_day ? fmtNum(t.hours_per_day, 1) : 'Whole day') }, { key: 'kind', label: 'Kind' },
              { key: 'status', label: 'Status', render: (t: any) => <Pill tone={t.status === 'approved' ? 'good' : t.status === 'requested' ? 'info' : 'neutral'} label={t.source === 'field_service' ? 'Approved (field service)' : t.status[0].toUpperCase() + t.status.slice(1)} /> },
              { key: 'note', label: 'Note' },
              { key: 'act', label: 'Actions', plain: true, render: (t: any) => t.source === 'field_service' ? null : (
                <span className="row">
                  {manage && t.status === 'requested' && t.employee_id !== me?.employeeId && <><button onClick={() => void act.run(t.id, 'approve')} disabled={act.busy}>Approve</button><button onClick={() => void act.run(t.id, 'reject')} disabled={act.busy}>Reject</button></>}
                  {['requested', 'approved'].includes(t.status) && (t.employee_id === me?.employeeId || manage) && <button onClick={() => void act.run(t.id, 'cancel')} disabled={act.busy}>Cancel</button>}
                </span>) }]} />)}
        </Async>
        <p className="faint">Field service technician time off (from the Field service page) counts as full days off and is listed here read-only.</p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Setup: company default week, thresholds, holidays, targets
// ---------------------------------------------------------------------------------------------------------------------
function Setup() {
  const { me } = useAuth();
  const wide = !!me?.grants.some((g) => g.facilityId === null && g.permissions.includes('staffing.manage'));
  const settings = useApi<any>('/api/staffing/settings');
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const holidays = useApi<any[]>(`/api/staffing/holidays?year=${year}`);
  const targets = useApi<any>('/api/staffing/targets');
  const people = useApi<any[]>('/api/staffing/people');
  const sites = useApi<any[]>('/api/facilities');
  const [s, setS] = useState<any>(null);
  const cur = s ?? (settings.data && { hours: settings.data.defaultHours.map(String), targetPct: String(settings.data.targetPct), benchPct: String(settings.data.benchPct), toleranceH: String(settings.data.toleranceH) });
  const saveSettings = useAction(async () => {
    await api.put('/api/staffing/settings', { defaultHours: cur.hours.map(Number), targetPct: Number(cur.targetPct), benchPct: Number(cur.benchPct), toleranceH: Number(cur.toleranceH) });
    setS(null); await settings.reload();
  });
  const [hol, setHol] = useState({ date: today(), name: '', facilityId: '', hoursOff: '' });
  const holSite = hol.facilityId || (wide ? '' : (sites.data ?? [])[0]?.id ?? '');
  const addHol = useAction(async () => { await api.post('/api/staffing/holidays', { date: hol.date, name: hol.name, facilityId: holSite || null, hoursOff: hol.hoursOff ? Number(hol.hoursOff) : null }); setHol({ ...hol, name: '' }); await holidays.reload(); });
  const delHol = useAction(async (id: string) => { await api.delete(`/api/staffing/holidays/${id}`); await holidays.reload(); });
  const [tg, setTg] = useState({ kind: wide ? 'job_title' : 'employee', jobTitle: '', employeeId: '', pct: '75' });
  const addTarget = useAction(async () => { await api.put('/api/staffing/targets', { ...(tg.kind === 'job_title' ? { jobTitle: tg.jobTitle.trim() } : { employeeId: tg.employeeId }), targetPct: Number(tg.pct) }); setTg({ ...tg, jobTitle: '' }); await targets.reload(); });
  const delTarget = useAction(async (id: string) => { await api.delete(`/api/staffing/targets/${id}`); await targets.reload(); });
  return (
    <>
      <section className="card stack">
        <h2>Company settings</h2>
        <Async loading={settings.loading} error={settings.error}>{() => cur && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void saveSettings.run(); }} aria-label="Company staffing settings">
            {!wide && <div className="notice warn" role="status">Company-wide settings, holidays for every site and job-title targets can be changed only by someone with the staffing permission at all sites. You can set holidays for your sites and targets for people.</div>}
            <fieldset className="stack" disabled={!wide}><legend>Default working week (hours per weekday, for anyone without a pattern of their own)</legend>
              <div className="week-grid">{DOW.map((d, i) => <label key={d} className="field">{d}<input type="number" min="0" max="24" step="0.25" value={cur.hours[i]} onChange={(e) => setS({ ...cur, hours: cur.hours.map((x: string, j: number) => (j === i ? e.target.value : x)) })} /></label>)}</div></fieldset>
            <fieldset className="form-grid" disabled={!wide} style={{ border: 0, padding: 0, margin: 0 }}>
              <label className="field">Company utilization target (%)<input type="number" min="0" max="100" step="1" value={cur.targetPct} onChange={(e) => setS({ ...cur, targetPct: e.target.value })} /></label>
              <label className="field">Bench threshold (% of capacity booked)<input type="number" min="0" max="100" step="1" value={cur.benchPct} onChange={(e) => setS({ ...cur, benchPct: e.target.value })} /></label>
              <label className="field">Hours over capacity ignored<input type="number" min="0" max="20" step="0.25" value={cur.toleranceH} onChange={(e) => setS({ ...cur, toleranceH: e.target.value })} /></label>
            </fieldset>
            <ErrorNote message={saveSettings.error} />
            <div><button className="primary" type="submit" disabled={saveSettings.busy || !s || !wide}>Save settings</button></div>
            {!settings.data.saved && <p className="faint">Showing the built-in defaults (40 hours Monday to Friday, 75% target, 50% bench threshold). Nothing is saved until you press Save.</p>}
          </form>)}
        </Async>
      </section>
      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Company holidays</h2>
          <label className="field">Year<input type="number" min="2000" max="2100" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} style={{ width: 90 }} /></label>
        </div>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void addHol.run(); }} aria-label="Add a holiday">
          <div className="form-grid">
            <label className="field">Date<input type="date" required value={hol.date} onChange={(e) => setHol({ ...hol, date: e.target.value })} /></label>
            <label className="field">Name<input required maxLength={100} value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} /></label>
            <label className="field">Applies to<select value={holSite} onChange={(e) => setHol({ ...hol, facilityId: e.target.value })}>{wide && <option value="">Every site</option>}{(sites.data ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.code}</option>)}</select></label>
            <label className="field">Hours off (blank: whole day)<input type="number" min="0.5" max="24" step="0.5" value={hol.hoursOff} onChange={(e) => setHol({ ...hol, hoursOff: e.target.value })} /></label>
          </div>
          <ErrorNote message={addHol.error ?? delHol.error} />
          <div><button className="primary" type="submit" disabled={addHol.busy}>Add holiday</button></div>
        </form>
        <Table rows={holidays.data ?? []} tools={false} empty={`No holidays recorded for ${year}. Holidays you add reduce everyone's available hours that day (and shrink bookings in proportion).`}
          columns={[{ key: 'holiday_date', label: 'Date', render: (r: any) => fmtDate(r.holiday_date) }, { key: 'name', label: 'Holiday' }, { key: 'facility_code', label: 'Applies to', render: (r: any) => r.facility_code ?? 'Every site' },
            { key: 'hours_off', label: 'Hours off', numeric: true, render: (r: any) => (r.hours_off ? fmtNum(r.hours_off, 1) : 'Whole day') },
            { key: 'act', label: '', plain: true, render: (r: any) => <button className="danger" onClick={() => void delHol.run(r.id)} aria-label={`Remove ${r.name}`}>Remove</button> }]} />
      </section>
      <section className="card stack">
        <h2>Utilization targets</h2>
        <p className="muted">A person's own target wins, then their job title's, then the company target of {targets.data?.company ?? '…'}%.</p>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void addTarget.run(); }} aria-label="Set a target">
          <div className="form-grid">
            <label className="field">For<select value={tg.kind} onChange={(e) => setTg({ ...tg, kind: e.target.value })}>{wide && <option value="job_title">A job title</option>}<option value="employee">A person</option></select></label>
            {tg.kind === 'job_title'
              ? <label className="field">Job title (as on the employee record)<input required value={tg.jobTitle} onChange={(e) => setTg({ ...tg, jobTitle: e.target.value })} maxLength={100} /></label>
              : <label className="field">Person<select required value={tg.employeeId} onChange={(e) => setTg({ ...tg, employeeId: e.target.value })}><option value="">Choose a person</option>{(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
            <label className="field">Target (%)<input type="number" required min="0" max="100" step="1" value={tg.pct} onChange={(e) => setTg({ ...tg, pct: e.target.value })} /></label>
          </div>
          <ErrorNote message={addTarget.error ?? delTarget.error} />
          <div><button className="primary" type="submit" disabled={addTarget.busy}>Save target</button></div>
        </form>
        <Table rows={targets.data?.targets ?? []} tools={false} empty="No job-title or personal targets: everyone uses the company target."
          columns={[{ key: 'kind', label: 'For', render: (t: any) => (t.kind === 'job_title' ? `Job title: ${t.job_title}` : `Person: ${t.employee_name}`) }, { key: 'target_pct', label: 'Target', numeric: true, render: (t: any) => `${fmtNum(t.target_pct, 0)}%` },
            { key: 'act', label: '', plain: true, render: (t: any) => <button className="danger" onClick={() => void delTarget.run(t.id)}>Remove</button> }]} />
      </section>
    </>
  );
}
