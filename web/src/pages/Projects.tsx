import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtMoney, fmtNum, fmtPct, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS_TONE: Record<string, 'good' | 'watch' | 'bad' | 'info' | 'neutral'> = { proposed: 'neutral', active: 'good', on_hold: 'watch', completed: 'info', cancelled: 'neutral' };
const STATUS_LABEL: Record<string, string> = { proposed: 'Proposed', active: 'Active', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
const BILLING: Record<string, string> = { time_materials: 'Time and materials', fixed_price: 'Fixed price', retainer: 'Retainer', non_billable: 'Non-billable (internal)' };
const MILESTONE_TONE: Record<string, 'good' | 'watch' | 'info' | 'neutral'> = { planned: 'neutral', reached: 'info', billed: 'good' };
const StatusPill = ({ v }: { v: string }) => <Pill tone={STATUS_TONE[v]} label={STATUS_LABEL[v] ?? humanize(v)} />;
const num = (v: string) => (v.trim() === '' ? null : Number(v));
const today = () => new Date().toISOString().slice(0, 10);

/** Projects (SC-009): the list, the cost-rate screen for people who may see cost, and the company's alert setting. */
export function Projects() {
  const { can } = useAuth();
  const seeCost = can('projects.see_cost');
  const manage = can('projects.manage');
  const tabs = ['projects', ...(seeCost ? ['rates'] : []), ...(manage || can('tenant.admin') ? ['settings'] : [])];
  const [params] = useSearchParams();
  const [tab, setTab] = useState(tabs.includes(params.get('tab') ?? '') ? params.get('tab')! : 'projects');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead eyebrow="Service companies" title="Projects" sub="Work for customers with a budget, a team, milestones and the hours and expenses booked to it."
        actions={manage && tab === 'projects' ? <button className="primary" onClick={() => setCreating(true)}>New project</button> : undefined} />
      {tabs.length > 1 && (
        <div className="row" role="tablist">
          {tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>{t === 'projects' ? 'Projects' : t === 'rates' ? 'Cost rates' : 'Settings'}</button>)}
        </div>
      )}
      {tab === 'projects' && (creating ? <NewProject onDone={() => setCreating(false)} /> : <ProjectList />)}
      {tab === 'rates' && <CostRates />}
      {tab === 'settings' && <ProjectSettings />}
    </>
  );
}

function ProjectList() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}), ...(search.trim() ? { search: search.trim() } : {}) }).toString();
  const { data, loading, error } = useApi<any[]>(`/api/projects${qs ? `?${qs}` : ''}`);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">Status
          <select id="pj-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Find<input id="pj-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or number" /></label>
        <label className="row" style={{ alignSelf: 'end' }}><input id="pj-mine" type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine (owner or team)</label>
      </div>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(p) => nav(`/projects/${p.id}`)} empty="No projects yet." exception={(p) => p.late_milestones > 0}
          columns={[{ key: 'number', label: 'Number', render: (p) => <Link to={`/projects/${p.id}`}>{p.number}</Link> }, { key: 'name', label: 'Project' }, { key: 'customer_name', label: 'Customer', render: (p) => p.customer_name ?? 'Internal' },
            { key: 'billing_type', label: 'Billing', render: (p) => BILLING[p.billing_type] ?? p.billing_type }, { key: 'status', label: 'Status', render: (p) => <StatusPill v={p.status} />, value: (p) => STATUS_LABEL[p.status] },
            { key: 'owner_name', label: 'Owner' }, { key: 'team', label: 'Team', numeric: true }, { key: 'hours_budget', label: 'Hours budget', numeric: true, render: (p) => fmtNum(p.hours_budget, 0) },
            { key: 'late_milestones', label: 'Late milestones', numeric: true, render: (p) => (p.late_milestones ? <Pill tone="bad" label={String(p.late_milestones)} /> : '') }]} />
      )}</Async>
    </section>
  );
}

function NewProject({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const lookups = useApi<any>('/api/projects/lookups');
  const [f, setF] = useState({ name: '', facilityId: '', customerId: '', billingType: 'time_materials', ownerUserId: '', startDate: '', endDate: '', hoursBudget: '', amountBudget: '', contractAmount: '', openToAll: false, description: '', status: 'active' });
  const create = useAction(async () => {
    const p = await api.post('/api/projects', {
      name: f.name, facilityId: f.facilityId || null, customerId: f.customerId || null, billingType: f.billingType, ownerUserId: f.ownerUserId || null, startDate: f.startDate || null, endDate: f.endDate || null,
      hoursBudget: num(f.hoursBudget), ...(can('projects.see_cost') ? { amountBudget: num(f.amountBudget) } : {}), contractAmount: f.billingType === 'fixed_price' ? num(f.contractAmount) : null,
      openToAll: f.openToAll, description: f.description || null, status: f.status,
    });
    nav(`/projects/${p.id}`);
  });
  const L = lookups.data;
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void create.run(); }} aria-label="New project">
      <h2>New project</h2>
      <Async loading={lookups.loading && !L} error={lookups.error}>{() => (
        <div className="form-grid">
          <label className="field">Name<input id="np-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></label>
          {L.facilities.length > 1 && <label className="field">Site<select id="np-site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required>
            <option value="">Choose…</option>{L.facilities.map((s: any) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label>}
          <label className="field">Billing<select id="np-billing" value={f.billingType} onChange={(e) => setF({ ...f, billingType: e.target.value })}>
            {Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Customer<select id="np-customer" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} required={f.billingType !== 'non_billable'}>
            <option value="">{f.billingType === 'non_billable' ? 'Internal (no customer)' : 'Choose…'}</option>{L.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          {f.billingType === 'fixed_price' && <label className="field">Contract amount ($)<input id="np-contract" type="number" min="0" step="0.01" value={f.contractAmount} onChange={(e) => setF({ ...f, contractAmount: e.target.value })} required /></label>}
          <label className="field">Owner<select id="np-owner" value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })}>
            <option value="">Me</option>{L.users.map((u: any) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
          <label className="field">Start<input id="np-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
          <label className="field">End<input id="np-end" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
          <label className="field">Hours budget<input id="np-hours" type="number" min="0" step="0.5" value={f.hoursBudget} onChange={(e) => setF({ ...f, hoursBudget: e.target.value })} /></label>
          {can('projects.see_cost') && <label className="field">Cost budget ($)<input id="np-cost" type="number" min="0" step="0.01" value={f.amountBudget} onChange={(e) => setF({ ...f, amountBudget: e.target.value })} /></label>}
          <label className="field">Starts as<select id="np-status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active (time can be booked)</option><option value="proposed">Proposed</option></select></label>
        </div>
      )}</Async>
      <label className="row"><input id="np-open" type="checkbox" checked={f.openToAll} onChange={(e) => setF({ ...f, openToAll: e.target.checked })} /> Any employee may book time to this project (otherwise only its team)</label>
      <label className="field">Description<textarea id="np-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <ErrorNote message={create.error} />
      <div className="row"><button className="primary" disabled={create.busy || !L}>Create project</button><button type="button" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function CostRates() {
  const overview = useApi<any[]>('/api/employee-cost-rates?overview=1');
  const [draft, setDraft] = useState<Record<string, { date: string; cost: string }>>({});
  const [history, setHistory] = useState<string | null>(null);
  const rates = useApi<any[]>(history ? `/api/employee-cost-rates?employeeId=${history}` : null);
  const save = useAction(async (employeeId: string) => {
    const d = draft[employeeId]!;
    await api.post('/api/employee-cost-rates', { employeeId, effectiveFrom: d.date, hourlyCost: Number(d.cost) });
    setDraft({ ...draft, [employeeId]: { date: today(), cost: '' } });
    await overview.reload(); if (history === employeeId) await rates.reload();
  });
  return (
    <section className="card stack">
      <h2>Cost rates</h2>
      <p className="muted">What an hour of each person costs the company, by date. Project cost uses the rate in force on the day the work was done. Only people with the cost permission see this page; a rate is never shown on a project to anyone else.</p>
      <Async loading={overview.loading && !overview.data} error={overview.error}>{() => (
        <Table rows={overview.data ?? []} rowKey={(r) => r.employee_id} empty="No employees."
          columns={[{ key: 'name', label: 'Person' }, { key: 'facility_code', label: 'Site' }, { key: 'current_rate', label: 'Cost per hour now', numeric: true, render: (r) => (r.current_rate == null ? <span className="faint">None set</span> : fmtMoney(r.current_rate)) },
            { key: 'since', label: 'Since', render: (r) => fmtDate(r.since) }, { key: 'next_change', label: 'Next change', render: (r) => fmtDate(r.next_change) },
            { key: 'set', label: 'New rate', plain: true, render: (r) => {
              const d = draft[r.employee_id] ?? { date: today(), cost: '' };
              return (
                <div className="row">
                  <input type="date" aria-label={`Effective from for ${r.name}`} value={d.date} onChange={(e) => setDraft({ ...draft, [r.employee_id]: { ...d, date: e.target.value } })} />
                  <input type="number" min="0" step="0.01" aria-label={`Cost per hour for ${r.name}`} placeholder="$ per hour" value={d.cost} onChange={(e) => setDraft({ ...draft, [r.employee_id]: { ...d, cost: e.target.value } })} style={{ width: 110 }} />
                  <button disabled={save.busy || d.cost === ''} onClick={() => save.run(r.employee_id)} aria-label={`Save rate for ${r.name}`}>Save</button>
                  <button className="link" onClick={() => setHistory(history === r.employee_id ? null : r.employee_id)} aria-label={`History for ${r.name}`}>{history === r.employee_id ? 'Hide history' : 'History'}</button>
                </div>); } }]} />
      )}</Async>
      <ErrorNote message={save.error} />
      {history && (
        <Async loading={rates.loading && !rates.data} error={rates.error}>{() => (
          <Table rows={rates.data ?? []} empty="No rates yet." columns={[{ key: 'employee_name', label: 'Person' }, { key: 'effective_from', label: 'Effective from', render: (r) => fmtDate(r.effective_from) },
            { key: 'hourly_cost', label: 'Cost per hour', numeric: true, render: (r) => fmtMoney(r.hourly_cost) }, { key: 'set_by', label: 'Set by' }]} />
        )}</Async>
      )}
    </section>
  );
}

function ProjectSettings() {
  const s = useApi<any>('/api/project-settings');
  const [pct, setPct] = useState('');
  useEffect(() => { if (s.data) setPct(String(s.data.budgetAlertPct)); }, [s.data]);
  const save = useAction(async () => { await api.put('/api/project-settings', { budgetAlertPct: Number(pct) }); await s.reload(); });
  return (
    <section className="card stack">
      <h2>Budget alerts</h2>
      <p className="muted">The project owner is told when an active project has used this share of its hours budget, and again when it goes over. Turn the reminder off, or change how often it repeats, under Admin → Reminders.</p>
      <Async loading={s.loading && !s.data} error={s.error}>{() => (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <label className="field">Warn at (% of hours budget)<input id="ps-pct" type="number" min="50" max="100" step="1" value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 120 }} /></label>
          <button className="primary" disabled={save.busy || !s.data.canEdit}>Save</button>
        </form>
      )}</Async>
      <ErrorNote message={save.error} />
    </section>
  );
}

/** Opens a change order from its approval link. */
export function ChangeOrderRedirect() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error } = useApi<any>(`/api/project-change-orders/${id}`);
  useEffect(() => { if (data) nav(`/projects/${data.project_id}`, { replace: true }); }, [data, nav]);
  return error ? <div className="notice error" role="alert">{error.message}</div> : <div className="empty">Opening…</div>;
}

export function ProjectDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const p = useApi<any>(`/api/projects/${id}`);
  const fig = useApi<any>(`/api/projects/${id}/figures`);
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') ?? 'budget');
  const reload = async () => { await p.reload(); await fig.reload(); };
  const d = p.data;
  const f = fig.data;
  const [reason, setReason] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  const move = useAction(async (to: string) => { await api.post(`/api/projects/${id}/transition`, { to, reason: reason || null }); setReason(''); setMoving(null); await reload(); });
  const tabs: [string, string][] = [['budget', 'Budget and actual'], ['team', 'Team'], ['milestones', 'Milestones'], ...(d?.billing_type === 'fixed_price' ? [['contract', 'Contract'] as [string, string]] : []), ['details', 'Details']];
  return (
    <>
      <PageHead eyebrow="Projects" title={d ? `${d.number} ${d.name}` : 'Project'} sub={<Link to="/projects">Back to projects</Link>}
        actions={d && d.allowedTransitions.length ? d.allowedTransitions.map((to: string) => (
          <button key={to} className={to === 'cancelled' ? 'danger' : ''} onClick={() => (['on_hold', 'cancelled', 'active'].includes(to) && d.status !== 'proposed' ? setMoving(to) : move.run(to))} disabled={move.busy}>
            {to === 'active' ? (d.status === 'proposed' ? 'Start' : d.status === 'completed' ? 'Reopen' : 'Resume') : to === 'on_hold' ? 'Put on hold' : to === 'completed' ? 'Mark completed' : 'Cancel project'}</button>)) : undefined} />
      <Async loading={(p.loading && !d) || (fig.loading && !f)} error={p.error ?? fig.error}>{() => (
        <>
          {moving && (
            <form className="card stack" onSubmit={(e) => { e.preventDefault(); void move.run(moving); }} aria-label="Change status">
              <label className="field">Why? (recorded on the project)<input id="pj-reason" value={reason} onChange={(e) => setReason(e.target.value)} required /></label>
              <div className="row"><button className="primary" disabled={move.busy}>Confirm</button><button type="button" onClick={() => setMoving(null)}>Not now</button></div>
            </form>
          )}
          <ErrorNote message={move.error} />
          <div className="row"><StatusPill v={d.status} /><span className="muted">{BILLING[d.billing_type]} · {d.customer_name ?? 'Internal'} · owner {d.owner_name ?? '—'} · site {d.facility_code}</span></div>
          {f.warnings.map((w: any) => <div key={w.code} className={`notice ${w.level === 'bad' ? 'error' : 'warn'}`}>{w.text}</div>)}
          <Kpis items={[
            { label: 'Hours used', value: f.hours.budget == null ? `${fmtNum(f.hours.actual, 1)} h` : `${fmtNum(f.hours.actual, 1)} of ${fmtNum(f.hours.budget, 1)} h`, tone: f.hours.used != null && f.hours.used > 1 ? 'bad' : f.hours.used != null && f.hours.used >= f.alertPct / 100 ? 'watch' : undefined, note: f.hours.used != null ? fmtPct(f.hours.used) : 'no budget' },
            { label: 'Waiting for approval', value: `${fmtNum(f.hours.waiting, 1)} h` }, { label: 'Billable share', value: f.hours.billableShare == null ? '—' : fmtPct(f.hours.billableShare) },
            { label: 'Pace', value: `${fmtNum(f.burn.hoursPerWeek, 1)} h/wk`, note: f.burn.projectedFinish ? `budget runs out ${fmtDate(f.burn.projectedFinish)}` : undefined },
            ...(f.contractValue != null ? [{ label: 'Contract value', value: fmtMoney(f.contractValue) }] : []), { label: 'Billed', value: fmtMoney(f.billed) },
            ...(f.cost ? [{ label: 'Cost to date', value: fmtMoney(f.cost.total), note: f.cost.budget.used != null ? `${fmtPct(f.cost.budget.used)} of budget` : undefined },
              { label: 'Margin', value: fmtMoney(f.margin.amount), tone: f.margin.amount < 0 && f.billed > 0 ? 'bad' as const : undefined, note: f.margin.pct != null ? fmtPct(f.margin.pct) : 'billed less cost' }] : []),
          ]} />
          <div className="row" role="tablist">{tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{label}</button>)}</div>
          {tab === 'budget' && <BudgetTab d={d} f={f} onChange={reload} />}
          {tab === 'team' && <TeamTab d={d} onChange={reload} />}
          {tab === 'milestones' && <MilestonesTab d={d} onChange={reload} />}
          {tab === 'contract' && <ContractTab d={d} onChange={reload} />}
          {tab === 'details' && <DetailsTab d={d} onChange={reload} canCost={can('projects.see_cost', d.facility_id)} />}
          {f.projectedMargin && tab === 'budget' && <p className="muted">{f.projectedMargin.basis}: {fmtMoney(f.projectedMargin.amount)}{f.projectedMargin.pct != null ? ` (${fmtPct(f.projectedMargin.pct)})` : ''}.</p>}
        </>
      )}</Async>
    </>
  );
}

const used = (v: any) => (v.used == null ? '—' : fmtPct(v.used));
function BudgetTab({ d, f, onChange }: { d: any; f: any; onChange: () => void }) {
  const [t, setT] = useState({ name: '', hours: '', amount: '', billable: true });
  const add = useAction(async () => { await api.post(`/api/projects/${d.id}/tasks`, { name: t.name, hoursBudget: num(t.hours), ...(f.canSeeCost ? { amountBudget: num(t.amount) } : {}), billable: t.billable }); setT({ name: '', hours: '', amount: '', billable: true }); onChange(); });
  const toggle = useAction(async (taskId: string, active: boolean) => { await api.patch(`/api/project-tasks/${taskId}`, { active }); onChange(); });
  return (
    <section className="card stack">
      <h2>Budget against actual</h2>
      <p className="muted">Actual counts approved timesheet hours. {f.canSeeCost ? 'Cost is hours at each person’s cost rate on the day worked, plus approved expenses; money budgets on tasks are cost budgets.' : ''}</p>
      <Table rows={f.tasks} rowKey={(r) => r.id ?? 'none'} empty="No tasks yet. Hours can be booked to the project without a task."
        columns={[{ key: 'name', label: 'Task', render: (r) => <>{r.name}{r.billable === false && <span className="faint"> · non-billable</span>}{r.active === false && <span className="faint"> · closed</span>}</> },
          { key: 'hb', label: 'Hours budget', numeric: true, render: (r) => fmtNum(r.hours.budget, 1) }, { key: 'ha', label: 'Actual', numeric: true, render: (r) => fmtNum(r.hours.actual, 1) },
          { key: 'hr', label: 'Left', numeric: true, render: (r) => fmtNum(r.hours.remaining, 1) }, { key: 'hu', label: 'Used', numeric: true, render: (r) => used(r.hours) },
          { key: 'hw', label: 'Waiting', numeric: true, render: (r) => fmtNum(r.waitingHours, 1) },
          ...(f.canSeeCost ? [{ key: 'ab', label: 'Cost budget', numeric: true, render: (r: any) => fmtMoney(r.cost.budget) }, { key: 'aa', label: 'Cost', numeric: true, render: (r: any) => fmtMoney(r.cost.actual) },
            { key: 'au', label: 'Used', numeric: true, render: (r: any) => used(r.cost) }] : []),
          ...(d.canManage ? [{ key: 'x', label: '', plain: true, render: (r: any) => (r.id ? <button className="link" disabled={toggle.busy} onClick={() => toggle.run(r.id, !r.active)}>{r.active ? 'Close' : 'Reopen'}</button> : null) }] : [])]} />
      <ErrorNote message={toggle.error} />
      {f.cost && <p className="muted">Labor {fmtMoney(f.cost.labor)} + expenses {fmtMoney(f.cost.expenses)} = {fmtMoney(f.cost.total)}{f.cost.unratedHours ? `. ${fmtNum(f.cost.unratedHours, 1)} h have no cost rate yet.` : '.'}</p>}
      <h3>People</h3>
      <Table rows={f.people} rowKey={(r) => r.employeeId} empty="No approved hours yet." columns={[{ key: 'name', label: 'Person' }, { key: 'hours', label: 'Hours', numeric: true, render: (r) => fmtNum(r.hours, 1) }, { key: 'billableHours', label: 'Billable', numeric: true, render: (r) => fmtNum(r.billableHours, 1) }]} />
      {d.canManage && (
        <form className="stack line-form" onSubmit={(e) => { e.preventDefault(); void add.run(); }} aria-label="Add a task">
          <h3>Add a task</h3>
          <div className="row">
            <input id="tk-name" aria-label="Task name" placeholder="Task or phase" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} required style={{ flex: '1 1 200px' }} />
            <input id="tk-hours" aria-label="Hours budget" type="number" min="0" step="0.5" placeholder="Hours budget" value={t.hours} onChange={(e) => setT({ ...t, hours: e.target.value })} style={{ width: 130 }} />
            {f.canSeeCost && <input id="tk-amount" aria-label="Cost budget" type="number" min="0" step="0.01" placeholder="Cost budget $" value={t.amount} onChange={(e) => setT({ ...t, amount: e.target.value })} style={{ width: 140 }} />}
            <label className="row"><input id="tk-billable" type="checkbox" checked={t.billable} onChange={(e) => setT({ ...t, billable: e.target.checked })} /> Billable</label>
            <button disabled={add.busy}>Add task</button>
          </div>
          <ErrorNote message={add.error} />
        </form>
      )}
    </section>
  );
}

function TeamTab({ d, onChange }: { d: any; onChange: () => void }) {
  const lookups = useApi<any>(d.canManage ? '/api/projects/lookups' : null);
  const [m, setM] = useState({ employeeId: '', role: '' });
  const add = useAction(async () => { await api.post(`/api/projects/${d.id}/members`, { employeeId: m.employeeId, role: m.role || null }); setM({ employeeId: '', role: '' }); onChange(); });
  const set = useAction(async (id: string, patch: object) => { await api.patch(`/api/project-members/${id}`, patch); onChange(); });
  const onTeam = new Set(d.members.filter((x: any) => x.active).map((x: any) => x.employee_id));
  return (
    <section className="card stack">
      <h2>Team</h2>
      <p className="muted">{d.open_to_all ? 'This project is open to every employee, so anyone may book time to it. The team lists the people assigned.' : 'Only these people may book time and expenses to the project.'}</p>
      <Table rows={d.members} empty="Nobody yet." columns={[{ key: 'name', label: 'Person' }, { key: 'employee_number', label: 'Number' }, { key: 'role', label: 'Role' }, { key: 'active', label: 'On the team', render: (r) => (r.active ? 'Yes' : <span className="faint">Removed</span>) },
        ...(d.canManage ? [{ key: 'x', label: '', plain: true, render: (r: any) => <button className="link" disabled={set.busy} onClick={() => set.run(r.id, { active: !r.active })} aria-label={`${r.active ? 'Remove' : 'Restore'} ${r.name}`}>{r.active ? 'Remove' : 'Restore'}</button> }] : [])]} />
      <ErrorNote message={set.error} />
      {d.canManage && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }} aria-label="Add a team member">
          <label className="field">Person<select id="tm-emp" value={m.employeeId} onChange={(e) => setM({ ...m, employeeId: e.target.value })} required>
            <option value="">Choose…</option>{(lookups.data?.employees ?? []).filter((e: any) => !onTeam.has(e.id)).map((e: any) => <option key={e.id} value={e.id}>{e.name} · {e.employee_number}</option>)}</select></label>
          <label className="field">Role<input id="tm-role" value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })} placeholder="e.g. Senior consultant" /></label>
          <button disabled={add.busy} style={{ alignSelf: 'end' }}>Add to team</button>
        </form>
      )}
      <ErrorNote message={add.error} />
    </section>
  );
}

function MilestonesTab({ d, onChange }: { d: any; onChange: () => void }) {
  const fixed = d.billing_type === 'fixed_price';
  const [m, setM] = useState({ name: '', dueDate: '', amount: '', percent: '' });
  const add = useAction(async () => { await api.post(`/api/projects/${d.id}/milestones`, { name: m.name, dueDate: m.dueDate || null, amount: fixed ? num(m.amount) : null, percent: fixed ? num(m.percent) : null }); setM({ name: '', dueDate: '', amount: '', percent: '' }); onChange(); });
  const [taking, setTaking] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const reach = useAction(async (id: string) => { await api.post(`/api/project-milestones/${id}/reach`, {}); onChange(); });
  const back = useAction(async (id: string) => { await api.post(`/api/project-milestones/${id}/unreach`, { reason: why }); setTaking(null); setWhy(''); onChange(); });
  const del = useAction(async (id: string) => { await api.delete(`/api/project-milestones/${id}`); onChange(); });
  return (
    <section className="card stack">
      <h2>Milestones</h2>
      <p className="muted">{fixed ? 'A milestone has a fixed amount or a percent of the contract value. Once reached, billing can invoice it.' : 'Milestones mark deliveries and dates. Amounts and percents apply to fixed-price projects.'} Only the project owner or a project manager can mark one reached; it is recorded.</p>
      <Table rows={d.milestones} empty="No milestones yet." exception={(r) => r.late}
        columns={[{ key: 'name', label: 'Milestone' }, { key: 'due_date', label: 'Due', render: (r) => <>{fmtDate(r.due_date)}{r.late && <Pill tone="bad" label="Late" />}</> },
          ...(fixed ? [{ key: 'amount', label: 'Amount', numeric: true, render: (r: any) => (r.effective_amount == null ? '—' : <>{fmtMoney(r.effective_amount)}{r.percent != null && <span className="faint"> · {r.percent}%</span>}</>) }] : []),
          { key: 'status', label: 'Status', render: (r) => <Pill tone={MILESTONE_TONE[r.status]} label={humanize(r.status)} /> }, { key: 'reached_on', label: 'Reached', render: (r) => (r.reached_on ? `${fmtDate(r.reached_on)} by ${r.reached_by ?? ''}` : '') },
          ...(d.canManage ? [{ key: 'x', label: '', plain: true, render: (r: any) => (
            <div className="row">
              {r.status === 'planned' && d.status === 'active' && <button disabled={reach.busy} onClick={() => reach.run(r.id)} aria-label={`Mark ${r.name} reached`}>Mark reached</button>}
              {r.status === 'planned' && <button className="link" disabled={del.busy} onClick={() => del.run(r.id)} aria-label={`Remove ${r.name}`}>Remove</button>}
              {r.status === 'reached' && <button className="link" onClick={() => setTaking(r.id)} aria-label={`Take ${r.name} back`}>Take back</button>}
            </div>) }] : [])]} />
      <ErrorNote message={reach.error ?? del.error} />
      {taking && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void back.run(taking); }} aria-label="Take a milestone back">
          <label className="field">Why is it being taken back?<input id="ms-why" value={why} onChange={(e) => setWhy(e.target.value)} required minLength={3} /></label>
          <button className="primary" disabled={back.busy} style={{ alignSelf: 'end' }}>Take back</button><button type="button" onClick={() => setTaking(null)} style={{ alignSelf: 'end' }}>Cancel</button>
          <ErrorNote message={back.error} />
        </form>
      )}
      {d.canManage && (
        <form className="stack line-form" onSubmit={(e) => { e.preventDefault(); void add.run(); }} aria-label="Add a milestone">
          <h3>Add a milestone</h3>
          <div className="row">
            <input id="ms-name" aria-label="Milestone name" placeholder="Milestone" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} required style={{ flex: '1 1 200px' }} />
            <input id="ms-due" aria-label="Due date" type="date" value={m.dueDate} onChange={(e) => setM({ ...m, dueDate: e.target.value })} />
            {fixed && <input id="ms-amount" aria-label="Amount" type="number" min="0" step="0.01" placeholder="Amount $" value={m.amount} onChange={(e) => setM({ ...m, amount: e.target.value, percent: '' })} style={{ width: 130 }} />}
            {fixed && <input id="ms-percent" aria-label="Percent of contract" type="number" min="0" max="100" step="0.1" placeholder="or % of contract" value={m.percent} onChange={(e) => setM({ ...m, percent: e.target.value, amount: '' })} style={{ width: 150 }} />}
            <button disabled={add.busy}>Add milestone</button>
          </div>
          <ErrorNote message={add.error} />
        </form>
      )}
    </section>
  );
}

function ContractTab({ d, onChange }: { d: any; onChange: () => void }) {
  const [c, setC] = useState({ amount: '', reason: '', reference: '' });
  const request = useAction(async () => { await api.post(`/api/projects/${d.id}/change-orders`, { amount: Number(c.amount), reason: c.reason, reference: c.reference || null }); setC({ amount: '', reason: '', reference: '' }); onChange(); });
  const withdraw = useAction(async (id: string) => { await api.post(`/api/project-change-orders/${id}/withdraw`); onChange(); });
  return (
    <section className="card stack">
      <h2>Contract value</h2>
      <p>Original <strong>{fmtMoney(d.contract_amount)}</strong>{d.change_orders.some((c: any) => c.status === 'approved') ? <> plus approved changes = <strong>{fmtMoney(d.contract_value)}</strong></> : null}.</p>
      <Table rows={d.change_orders} empty="No change orders." columns={[{ key: 'seq', label: 'No.', numeric: true }, { key: 'amount', label: 'Change', numeric: true, render: (r) => `${r.amount > 0 ? '+' : ''}${fmtMoney(r.amount)}` },
        { key: 'reason', label: 'Reason', render: (r) => <>{r.reason}{r.reference && <span className="faint"> · {r.reference}</span>}</> }, { key: 'requested_by', label: 'Asked by' },
        { key: 'status', label: 'Status', render: (r) => <Pill tone={r.status === 'approved' ? 'good' : r.status === 'pending' ? 'info' : 'neutral'} label={humanize(r.status)} /> },
        { key: 'approval', label: 'Decision', render: (r) => (r.approval?.[0] ? `${r.approval[0].status}${r.approval[0].decided_at ? ` ${fmtDate(r.approval[0].decided_at)}` : ''}` : '') },
        ...(d.canManage ? [{ key: 'x', label: '', plain: true, render: (r: any) => (r.status === 'pending' ? <button className="link" disabled={withdraw.busy} onClick={() => withdraw.run(r.id)} aria-label={`Withdraw change order ${r.seq}`}>Withdraw</button> : null) }] : [])]} />
      <ErrorNote message={withdraw.error} />
      {d.canManage && !['completed', 'cancelled'].includes(d.status) && (
        <form className="stack line-form" onSubmit={(e) => { e.preventDefault(); void request.run(); }} aria-label="Ask for a change order">
          <h3>Change the contract value</h3>
          <p className="muted">A change order is a signed adjustment (negative reduces the contract). It is approved by the project owner (or an administrator when you are the owner) before it counts.</p>
          <div className="row">
            <input id="co-amount" aria-label="Change in contract value" type="number" step="0.01" placeholder="Change $ (e.g. 12000 or -3000)" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value })} required style={{ width: 230 }} />
            <input id="co-reason" aria-label="Reason" placeholder="Reason" value={c.reason} onChange={(e) => setC({ ...c, reason: e.target.value })} required minLength={3} style={{ flex: '1 1 220px' }} />
            <input id="co-ref" aria-label="Customer reference" placeholder="Customer's signed reference" value={c.reference} onChange={(e) => setC({ ...c, reference: e.target.value })} style={{ width: 220 }} />
            <button disabled={request.busy}>Ask for approval</button>
          </div>
          <ErrorNote message={request.error} />
        </form>
      )}
    </section>
  );
}

function DetailsTab({ d, onChange, canCost }: { d: any; onChange: () => void; canCost: boolean }) {
  const lookups = useApi<any>(d.canManage ? '/api/projects/lookups' : null);
  const [f, setF] = useState({ name: d.name, customerId: d.customer_id ?? '', ownerUserId: d.owner_user_id ?? '', startDate: d.start_date ?? '', endDate: d.end_date ?? '', hoursBudget: d.hours_budget == null ? '' : String(d.hours_budget),
    amountBudget: d.amount_budget == null ? '' : String(d.amount_budget), contractAmount: d.contract_amount == null ? '' : String(d.contract_amount), openToAll: d.open_to_all, description: d.description ?? '' });
  const save = useAction(async () => {
    await api.patch(`/api/projects/${d.id}`, { name: f.name, customerId: f.customerId || null, ownerUserId: f.ownerUserId || undefined, startDate: f.startDate || null, endDate: f.endDate || null, hoursBudget: num(f.hoursBudget),
      ...(canCost ? { amountBudget: num(f.amountBudget) } : {}), ...(d.billing_type === 'fixed_price' && d.status === 'proposed' ? { contractAmount: num(f.contractAmount) } : {}), openToAll: f.openToAll, description: f.description || null });
    onChange();
  });
  const L = lookups.data;
  if (!d.canManage) return <section className="card stack"><h2>Details</h2><p>{d.description ?? 'No description.'}</p><p className="muted">{fmtDate(d.start_date)} to {fmtDate(d.end_date)}</p></section>;
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label="Project details">
      <h2>Details</h2>
      <div className="form-grid">
        <label className="field">Name<input id="pd-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></label>
        <label className="field">Customer<select id="pd-customer" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} required={d.billing_type !== 'non_billable'}>
          <option value="">{d.billing_type === 'non_billable' ? 'Internal' : 'Choose…'}</option>{(L?.customers ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field">Owner<select id="pd-owner" value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })}>
          {(L?.users ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
        <label className="field">Start<input id="pd-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
        <label className="field">End<input id="pd-end" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        <label className="field">Hours budget<input id="pd-hours" type="number" min="0" step="0.5" value={f.hoursBudget} onChange={(e) => setF({ ...f, hoursBudget: e.target.value })} /></label>
        {canCost && <label className="field">Cost budget ($)<input id="pd-cost" type="number" min="0" step="0.01" value={f.amountBudget} onChange={(e) => setF({ ...f, amountBudget: e.target.value })} /></label>}
        {d.billing_type === 'fixed_price' && d.status === 'proposed' && <label className="field">Contract amount ($)<input id="pd-contract" type="number" min="0" step="0.01" value={f.contractAmount} onChange={(e) => setF({ ...f, contractAmount: e.target.value })} /></label>}
      </div>
      <label className="row"><input id="pd-open" type="checkbox" checked={f.openToAll} onChange={(e) => setF({ ...f, openToAll: e.target.checked })} /> Any employee may book time to this project</label>
      <label className="field">Description<textarea id="pd-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <p className="muted">With no hours budget on the project, the sum of its task budgets is used. The contract value of a fixed-price project can be edited here only while it is proposed; after that, use a change order (Contract tab).</p>
      <ErrorNote message={save.error} />
      <div><button className="primary" disabled={save.busy}>Save changes</button></div>
    </form>
  );
}
