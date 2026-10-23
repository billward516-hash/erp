import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STEP: Record<string, string> = { open: 'Containment', root_cause: 'Root cause', actions: 'Actions', verification: 'Effectiveness check' };
const SOURCES: [string, string][] = [
  ['internal', 'Internal finding'], ['customer_complaint', 'Customer complaint'], ['audit', 'Audit'], ['supplier', 'Supplier'], ['spc', 'SPC alarm'], ['change', 'Change'],
  ['fmea', 'FMEA'], ['management_review', 'Management review'], ['risk', 'Risk or trend'],
];
const PREVENTIVE_SOURCES = new Set(['internal', 'audit', 'spc', 'change', 'fmea', 'management_review', 'risk']);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** CAPA and 8D (D-160): the dashboard and every open corrective and preventive action, answer first. */
export function Capa() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [type, setType] = useState('');
  const { data, loading, error } = useApi<any>('/api/capa-dashboard');
  return (
    <>
      <PageHead eyebrow="Quality" title="CAPA and 8D"
        sub="Corrective actions for problems that happened, preventive actions for ones that have not, and 8D for customers. Each runs containment, root cause, actions and an effectiveness check the owner cannot sign."
        actions={can('quality.manage') ? <button className="primary" onClick={() => nav('/capa/new')}>Open a CAPA</button> : undefined} />
      <Async loading={loading && !data} error={error}>{() => {
        const k = data.kpis;
        const rows = data.open.filter((r: any) => !type || r.action_type === type);
        return (
          <>
            <p className="answer">{data.answer}</p>
            <Kpis items={[
              { label: 'Open', value: k.open, note: `${k.corrective} corrective, ${k.preventive} preventive` },
              { label: 'Overdue', value: k.overdue, tone: k.overdue ? 'bad' : 'good', note: k.overdueActions ? `${k.overdueActions} late actions` : undefined },
              { label: 'Effectiveness checks', value: k.inVerification, note: 'waiting' },
              { label: 'Fixes that held', value: k.effectivenessRate == null ? '—' : `${k.effectivenessRate}%`, tone: k.effectivenessRate == null ? undefined : k.effectivenessRate >= 80 ? 'good' : 'watch', note: 'last 12 months' },
              { label: 'Days to close', value: k.avgDaysToClose ?? '—', note: `average, ${k.closedLastYear} closed` },
              { label: '8D in progress', value: k.eightD },
            ]} />
            <div className="grid two">
              <section className="card stack">
                <h2>By step</h2>
                <Table rows={data.byStep} rowKey={(r) => r.step} columns={[{ key: 'label', label: 'Step' }, { key: 'n', label: 'Open', numeric: true }]} />
                <h2>By age</h2>
                <Table rows={data.byAge} rowKey={(r) => r.label} columns={[{ key: 'label', label: 'Open for' }, { key: 'n', label: 'Open', numeric: true }]} />
              </section>
              <section className="card stack">
                <h2>By source</h2>
                <Table rows={data.bySource} rowKey={(r) => r.label} empty="Nothing open." columns={[{ key: 'label', label: 'Source' }, { key: 'n', label: 'Open', numeric: true }]} />
                <h2>Repeat problems</h2>
                <Table rows={data.repeats} rowKey={(r) => `${r.kind}-${r.key}`} empty="No part or supplier needed more than one corrective action this year."
                  columns={[{ key: 'key', label: 'Part or supplier', render: (r) => <><strong>{r.key}</strong> <span className="faint">{r.name}</span></> },
                    { key: 'n', label: 'CAPAs', numeric: true }, { key: 'numbers', label: 'Which', render: (r) => r.numbers.join(', ') }]} />
              </section>
            </div>
            <section className="card stack">
              <div className="spread">
                <h2>Open</h2>
                <select aria-label="Corrective or preventive" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">Corrective and preventive</option><option value="corrective">Corrective only</option><option value="preventive">Preventive only</option>
                </select>
              </div>
              <Table rows={rows} rowKey={(r) => r.id} onRow={(r) => nav(`/quality/capa/${r.id}`)} exception={(r) => r.overdue} empty="Nothing open."
                columns={[{ key: 'number', label: 'CAPA', render: (r) => <><strong>{r.number}</strong>{r.format === 'eight_d' && <span className="faint"> · 8D</span>}</> },
                  { key: 'action_type', label: 'Type', render: (r) => <Pill tone={r.action_type === 'preventive' ? 'info' : undefined} label={humanize(r.action_type)} /> },
                  { key: 'facility_code', label: 'Site' }, { key: 'title', label: 'Title' },
                  { key: 'source', label: 'From', render: (r) => SOURCES.find(([k]) => k === r.source)?.[1] ?? humanize(r.source) },
                  { key: 'status', label: 'Step', render: (r) => STEP[r.status] }, { key: 'owner_name', label: 'Owner' }, { key: 'age_days', label: 'Age', numeric: true, render: (r) => `${r.age_days} d` },
                  { key: 'due_date', label: 'Due', render: (r) => <>{fmtDate(r.due_date)}{r.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> }]} />
            </section>
          </>
        );
      }}</Async>
    </>
  );
}

/** Opens a corrective or preventive action from any source; `?origin=spc_signal:<id>&facility=…&source=spc` links it back. */
export function NewCapaModule() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const facilities = useApi<any[]>('/api/facilities');
  const [originType, originId] = (params.get('origin') ?? '').split(':');
  const [f, setF] = useState({ facilityId: params.get('facility') ?? '', actionType: params.get('type') === 'preventive' ? 'preventive' : 'corrective', source: params.get('source') ?? 'internal',
    title: params.get('title') ?? '', problem: '', ownerUserId: '', priority: 'medium', dueDate: inDays(30), format: 'standard' });
  const users = useApi<any[]>(f.facilityId ? `/api/assignable-users?facilityId=${f.facilityId}` : null);
  const preventive = f.actionType === 'preventive';
  const save = useAction(async () => {
    const c = await api.post('/api/corrective-actions', { ...f, format: preventive ? 'standard' : f.format, originType: originType || null, originId: originId || null });
    nav(`/quality/capa/${c.id}`);
  });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 'eight_d' : 'standard') : e.target.value });
  return (
    <>
      <PageHead eyebrow="CAPA and 8D" title="Open a CAPA" sub={originType ? `Linked to the ${humanize(originType)} it came from.` : 'Nonconformances, incidents and audit findings open their corrective actions from their own pages.'} />
      <form className="card form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <fieldset className="row" style={{ gap: 12, border: 0, padding: 0, margin: 0, flexWrap: 'wrap' }}>
          <legend className="muted">Type</legend>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="capa-type" checked={!preventive} onChange={() => setF({ ...f, actionType: 'corrective' })} /> Corrective: a problem that happened</label>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="capa-type" checked={preventive} onChange={() => setF({ ...f, actionType: 'preventive', source: PREVENTIVE_SOURCES.has(f.source) ? f.source : 'risk', format: 'standard' })} /> Preventive: a problem that could happen</label>
        </fieldset>
        <div className="form-grid">
          <label className="field">Site<select id="capa-site" value={f.facilityId} onChange={set('facilityId')} required>
            <option value="">Choose…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
          <label className="field">Source<select id="capa-source" value={f.source} onChange={set('source')}>
            {SOURCES.filter(([k]) => !preventive || PREVENTIVE_SOURCES.has(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">Owner<select id="capa-owner-m" value={f.ownerUserId} onChange={set('ownerUserId')} required>
            <option value="">Choose…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
          <label className="field">Priority<select id="capa-priority-m" value={f.priority} onChange={set('priority')}>{['low', 'medium', 'high'].map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
          <label className="field">Due<input id="capa-due-m" type="date" value={f.dueDate} onChange={set('dueDate')} /></label>
        </div>
        <label className="field">Title<input id="capa-title-m" value={f.title} onChange={set('title')} required minLength={3} /></label>
        <label className="field">{preventive ? 'The potential problem, and why it could happen' : 'Problem statement: what, where, when, how many'}<textarea id="capa-problem-m" value={f.problem} onChange={set('problem')} required minLength={3} /></label>
        {!preventive && <label className="row" style={{ gap: 4 }}><input id="capa-8d-m" type="checkbox" checked={f.format === 'eight_d'} onChange={set('format')} /> Run as an 8D (customer complaints usually ask for one)</label>}
        <div><button className="primary" disabled={save.busy || !f.facilityId}>Open {preventive ? 'preventive' : 'corrective'} action</button></div>
        <ErrorNote message={save.error} />
      </form>
    </>
  );
}
