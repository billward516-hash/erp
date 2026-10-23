import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtNum } from '../format';
import { useAction, useApi } from '../hooks';

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekStartOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const today = () => new Date().toISOString().slice(0, 10);
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  not_started: { label: 'Not started', tone: 'neutral' }, draft: { label: 'Draft', tone: 'neutral' }, submitted: { label: 'Waiting for approval', tone: 'info' },
  approved: { label: 'Approved', tone: 'good' }, rejected: { label: 'Sent back', tone: 'bad' }, exported: { label: 'Sent to payroll', tone: 'good' },
};
const SheetStatus = ({ v }: { v: string }) => <Pill tone={STATUS[v]?.tone} label={STATUS[v]?.label ?? v} />;

function WeekPicker({ week, setWeek }: { week: string; setWeek: (w: string) => void }) {
  return (
    <div className="row" role="group" aria-label="Week">
      <button onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">←</button>
      <strong>Week of {fmtDate(week)}</strong>
      <button onClick={() => setWeek(addDays(week, 7))} aria-label="Next week" disabled={week >= weekStartOf(today())}>→</button>
      {week !== weekStartOf(today()) && <button onClick={() => setWeek(weekStartOf(today()))}>This week</button>}
    </div>
  );
}

export function Time() {
  const { me, can } = useAuth();
  const tabs = [...(me?.employeeId ? ['mine'] : []), ...(can('time.approve') || can('time.view_all') ? ['team'] : []), ...(can('time.export') ? ['payroll'] : [])] as string[];
  const [tab, setTab] = useState(tabs[0] ?? 'mine');
  return (
    <>
      <PageHead eyebrow="Time" title="Timesheets" sub="Hours booked to work orders appear automatically. Add other time (training, meetings, leave), then submit the week for your supervisor to approve." />
      {tabs.length > 1 && (
        <div className="row" role="tablist">
          {tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>{t === 'mine' ? 'My time' : t === 'team' ? 'Team' : 'Payroll export'}</button>)}
        </div>
      )}
      {tab === 'mine' && (me?.employeeId ? <MyTime /> : <div className="card"><p className="muted">Your user is not linked to an employee record, so there is no timesheet for you.</p></div>)}
      {tab === 'team' && <Team />}
      {tab === 'payroll' && <Payroll />}
    </>
  );
}

function MyTime() {
  const [week, setWeek] = useState(weekStartOf(today()));
  const [sheet, setSheet] = useState<any>(null);
  const [loadedWeek, setLoadedWeek] = useState<string | null>(null);
  const load = useAction(async (w: string) => { setSheet(await api.post('/api/timesheets/open', { weekStart: w })); setLoadedWeek(w); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load.run(week); }, [week]);
  const history = useApi<any[]>('/api/timesheets/mine');
  return (
    <>
      <section className="card stack">
        <WeekPicker week={week} setWeek={setWeek} />
        <ErrorNote message={load.error} />
        {sheet && loadedWeek === week && <SheetView sheet={sheet} onChange={async () => { await load.run(week); await history.reload(); }} />}
      </section>
      <section className="card">
        <h2>Recent weeks</h2>
        <Table rows={history.data ?? []} onRow={(t) => setWeek(t.week_start)} empty="No timesheets yet."
          columns={[{ key: 'week_start', label: 'Week of', render: (t) => fmtDate(t.week_start) }, { key: 'hours', label: 'Hours', numeric: true, render: (t) => fmtNum(t.hours, 2) },
            { key: 'status', label: 'Status', render: (t) => <SheetStatus v={t.status} /> }, { key: 'decision_comment', label: 'Supervisor note' }]} />
      </section>
    </>
  );
}

/** One week: day totals, entries, warnings and the actions available to the viewer. */
function SheetView({ sheet: s, onChange }: { sheet: any; onChange: () => void }) {
  const { me, can } = useAuth();
  const own = me?.employeeId === s.employee_id;
  const editable = ['draft', 'rejected'].includes(s.status) && (own || can('time.approve', s.facility_id));
  const [f, setF] = useState({ workDate: s.week_start, earningCode: 'REG', hours: '', note: '' });
  const [comment, setComment] = useState('');
  const add = useAction(async () => { await api.post(`/api/timesheets/${s.id}/entries`, { workDate: f.workDate, earningCode: f.earningCode, hours: Number(f.hours), note: f.note || null }); setF({ ...f, hours: '', note: '' }); onChange(); });
  const remove = useAction(async (id: string) => { await api.delete(`/api/time-entries/${id}`); onChange(); });
  const submit = useAction(async () => { await api.post(`/api/timesheets/${s.id}/submit`); onChange(); });
  const decide = useAction(async (decision: 'approve' | 'reject') => { await api.post(`/api/timesheets/${s.id}/decide`, { decision, comment: comment || null }); setComment(''); onChange(); });
  const reopen = useAction(async () => { await api.post(`/api/timesheets/${s.id}/reopen`, { reason: comment }); setComment(''); onChange(); });
  const canDecide = s.status === 'submitted' && !own && can('time.approve', s.facility_id) && s.submitted_by !== me?.userId;
  return (
    <div className="stack">
      <div className="spread">
        <div><strong>{s.employee_name}</strong> <span className="muted">{s.employee_number} · {s.facility_code}</span></div>
        <div className="row"><SheetStatus v={s.status} /><strong>{fmtNum(s.total, 2)} h</strong></div>
      </div>
      {s.status === 'rejected' && s.decision_comment && <div className="notice error">Sent back by {s.decided_by_name}: {s.decision_comment}</div>}
      {s.warnings.map((w: string) => <div key={w} className="notice warn">{w}</div>)}
      <div className="week-grid" aria-label="Hours by day">
        {s.days.map((d: any, i: number) => <div key={d.date} className={`day ${d.date === today() ? 'today' : ''}`}><span className="muted">{DOW[i]} {d.date.slice(5)}</span><strong>{d.hours ? fmtNum(d.hours, 2) : '–'}</strong></div>)}
      </div>
      <Table rows={s.entries} rowKey={(e) => e.id ?? `wo-${e.work_order_id}-${e.work_date}-${e.hours}`} empty="No hours yet."
        columns={[{ key: 'work_date', label: 'Day', render: (e) => `${DOW[(new Date(`${e.work_date}T00:00:00Z`).getUTCDay() + 6) % 7]} ${e.work_date.slice(5)}` },
          { key: 'earning_code', label: 'Type' }, { key: 'hours', label: 'Hours', numeric: true, render: (e) => fmtNum(e.hours, 2) },
          { key: 'what', label: 'What', render: (e) => (e.source === 'work_order' ? <Link to={`/work-orders/${e.work_order_id}`}>{e.work_order_number}</Link> : e.note ?? '') },
          { key: 'src', label: '', render: (e) => (e.source === 'work_order' ? <span className="faint">from work order</span>
            : editable && e.id ? <button onClick={() => remove.run(e.id)} disabled={remove.busy}>Remove</button> : null) }]} />
      <p className="muted">By type: {s.byCode.map((c: any) => `${c.label} ${fmtNum(c.hours, 2)} h`).join(' · ') || '—'}. Work orders {fmtNum(s.workOrderHours, 2)} h.</p>
      {editable && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <select id="te-date" value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value })} aria-label="Day">
            {s.days.map((d: any, i: number) => <option key={d.date} value={d.date}>{DOW[i]} {d.date.slice(5)}</option>)}</select>
          <select id="te-code" value={f.earningCode} onChange={(e) => setF({ ...f, earningCode: e.target.value })} aria-label="Type">
            {s.codes.map((c: any) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}</select>
          <input id="te-hours" type="number" min="0.25" max="24" step="0.25" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} placeholder="Hours" aria-label="Hours" style={{ width: 90 }} required />
          <input id="te-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Note (e.g. training)" aria-label="Note" style={{ flex: '1 1 200px' }} />
          <button disabled={add.busy}>Add time</button>
        </form>
      )}
      <ErrorNote message={add.error ?? remove.error ?? submit.error ?? decide.error ?? reopen.error} />
      {editable && <div><button className="primary" disabled={submit.busy || !s.total} onClick={() => submit.run()}>Submit week for approval</button></div>}
      {s.status === 'submitted' && own && <p className="muted">Submitted {fmtDateTime(s.submitted_at)}. Work-order hours for this week are now locked; ask your supervisor to send it back if something changes.</p>}
      {(canDecide || (s.status === 'approved' && can('time.approve', s.facility_id) && !own)) && (
        <div className="stack">
          <label className="field">{canDecide ? 'Note (required to send back)' : 'Reason to reopen'}<textarea id="ts-comment" value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <div className="row">
            {canDecide && <button className="primary" disabled={decide.busy} onClick={() => decide.run('approve')}>Approve {fmtNum(s.total, 2)} h</button>}
            {canDecide && <button className="danger" disabled={decide.busy || !comment.trim()} onClick={() => decide.run('reject')}>Send back</button>}
            {s.status === 'approved' && <button disabled={reopen.busy || comment.trim().length < 3} onClick={() => reopen.run()}>Reopen</button>}
          </div>
        </div>
      )}
      {s.status === 'submitted' && !own && s.submitted_by === me?.userId && <p className="muted">You entered this week on the employee's behalf, so another approver must approve it.</p>}
    </div>
  );
}

function Team() {
  const nav = useNavigate();
  const [week, setWeek] = useState(addDays(weekStartOf(today()), -7));
  const { data, loading, error } = useApi<any[]>(`/api/timesheets/team?weekStart=${week}`);
  const rows = data ?? [];
  const openSheet = useAction(async (employeeId: string) => { const s = await api.post('/api/timesheets/open', { employeeId, weekStart: week }); nav(`/time/${s.id}`); });
  return (
    <section className="card stack">
      <WeekPicker week={week} setWeek={setWeek} />
      <p className="muted">{rows.filter((r) => r.status === 'submitted').length} waiting for approval · {rows.filter((r) => ['approved', 'exported'].includes(r.status)).length} approved · {rows.filter((r) => ['not_started', 'draft', 'rejected'].includes(r.status)).length} not submitted</p>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={rows} rowKey={(r) => r.employee_id} onRow={(r) => (r.id ? nav(`/time/${r.id}`) : openSheet.run(r.employee_id))} exception={(r) => r.status === 'submitted'}
          columns={[{ key: 'facility_code', label: 'Site' }, { key: 'name', label: 'Name' }, { key: 'job_title', label: 'Job' },
            { key: 'hours', label: 'Hours', numeric: true, render: (r) => fmtNum(r.hours, 2) }, { key: 'wo_hours', label: 'On work orders', numeric: true, render: (r) => fmtNum(r.wo_hours, 2) },
            { key: 'status', label: 'Status', render: (r) => <SheetStatus v={r.status} /> }]} />
      )}</Async>
      <ErrorNote message={openSheet.error} />
    </section>
  );
}

export function TimesheetDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<any>(`/api/timesheets/${id}`);
  return (
    <>
      <PageHead eyebrow="Time" title={data ? `Week of ${fmtDate(data.week_start)}` : 'Timesheet'} sub={<Link to="/time">Back to timesheets</Link>} />
      <section className="card"><Async loading={loading && !data} error={error}>{() => <SheetView sheet={data} onChange={reload} />}</Async></section>
    </>
  );
}

function Payroll() {
  const last = addDays(weekStartOf(today()), -7);
  const [range, setRange] = useState({ from: addDays(last, -7), to: last, layout: 'summary' });
  const preview = useApi<any>(`/api/payroll/preview?from=${range.from}&to=${range.to}`);
  const exports = useApi<any[]>('/api/payroll/exports');
  const codes = useApi<any[]>('/api/earning-codes');
  const run = useAction(async () => { await api.post('/api/payroll/exports', range); await preview.reload(); await exports.reload(); });
  const [ext, setExt] = useState<Record<string, string>>({});
  const saveCode = useAction(async (code: string) => { await api.patch(`/api/earning-codes/${code}`, { externalCode: ext[code] || null }); await codes.reload(); });
  const p = preview.data;
  return (
    <>
      <section className="card stack">
        <h2>Export approved hours</h2>
        <div className="form-grid">
          <label className="field">From week<input id="pay-from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: weekStartOf(e.target.value) })} /></label>
          <label className="field">To week<input id="pay-to" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: weekStartOf(e.target.value) })} /></label>
          <label className="field">Layout<select id="pay-layout" value={range.layout} onChange={(e) => setRange({ ...range, layout: e.target.value })}>
            <option value="summary">One line per person, week and earning code</option><option value="daily">One line per person, day and earning code</option></select></label>
        </div>
        <Async loading={preview.loading && !p} error={preview.error}>{() => (
          <>
            <p><strong>{p.ready.length} approved timesheet{p.ready.length === 1 ? '' : 's'} ready</strong> ({fmtNum(p.ready.reduce((s: number, r: any) => s + r.hours, 0), 2)} h).
              {p.alreadyExported.length > 0 && ` ${p.alreadyExported.length} already sent to payroll.`}</p>
            {p.notReady.length > 0 && (
              <div className="notice warn stack">
                <span>{p.notReady.length} not ready; they stay out of this file and can go in a later one:</span>
                <Table rows={p.notReady} rowKey={(r) => `${r.week_start}-${r.employee_number}`}
                  columns={[{ key: 'week_start', label: 'Week', render: (r) => fmtDate(r.week_start) }, { key: 'name', label: 'Name' }, { key: 'status', label: 'Status', render: (r) => <SheetStatus v={r.status} /> }]} />
              </div>
            )}
            <div><button className="primary" disabled={run.busy || !p.ready.length} onClick={() => run.run()}>Create payroll file</button></div>
          </>
        )}</Async>
        <ErrorNote message={run.error} />
        <p className="faint">Overtime, pay rates, taxes and payments are handled by your payroll provider. Exported weeks are locked here; corrections after export are made in payroll.</p>
      </section>
      <section className="card">
        <h2>Payroll files</h2>
        <Table rows={exports.data ?? []} empty="None yet."
          columns={[{ key: 'file_name', label: 'File' }, { key: 'period', label: 'Weeks', render: (x) => `${fmtDate(x.period_from)} – ${fmtDate(x.period_to)}` }, { key: 'timesheets', label: 'Timesheets', numeric: true },
            { key: 'row_count', label: 'Rows', numeric: true }, { key: 'created_at', label: 'Created', render: (x) => `${fmtDateTime(x.created_at)} by ${x.created_by}` },
            { key: 'dl', label: '', render: (x) => <button onClick={() => api.download(`/api/payroll/exports/${x.id}`, x.file_name)}>Download</button> }]} />
      </section>
      <section className="card stack">
        <h2>Earning codes</h2>
        <p className="muted">The code your payroll provider expects for each type of hours (leave empty to use the same code).</p>
        <Table rows={codes.data ?? []} rowKey={(c) => c.code}
          columns={[{ key: 'code', label: 'Code' }, { key: 'label', label: 'Meaning' }, { key: 'kind', label: 'Counts as', render: (c) => (c.kind === 'worked' ? 'Worked' : c.kind === 'paid_leave' ? 'Paid leave' : 'Unpaid') },
            { key: 'ext', label: 'Payroll code', render: (c) => <input aria-label={`Payroll code for ${c.code}`} value={ext[c.code] ?? c.external_code ?? ''} onChange={(e) => setExt({ ...ext, [c.code]: e.target.value })} style={{ width: 100 }} /> },
            { key: 'save', label: '', render: (c) => (ext[c.code] !== undefined && ext[c.code] !== (c.external_code ?? '') ? <button onClick={() => saveCode.run(c.code)} disabled={saveCode.busy}>Save</button> : null) }]} />
        <ErrorNote message={saveCode.error} />
      </section>
    </>
  );
}
