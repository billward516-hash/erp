import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney } from '../format';
import { useAction, useApi } from '../hooks';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const VSTATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  planned: { label: 'To schedule', tone: 'neutral' }, scheduled: { label: 'Scheduled', tone: 'info' }, dispatched: { label: 'Dispatched', tone: 'info' }, in_progress: { label: 'On site', tone: 'watch' }, completed: { label: 'Done', tone: 'good' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
export const VisitStatus = ({ v }: { v: any }) => <><Pill tone={VSTATUS[v.status]?.tone} label={VSTATUS[v.status]?.label ?? v.status} />{v.overdue && <> <Pill tone="bad" label="Overdue" /></>}{v.kind === 'callout' && <> <Pill tone="watch" label="Call-out" /></>}</>;

/** Field service (SC-002): the coordinator's workspace. */
export function Service() {
  const { can } = useAuth();
  const tabs = ['dispatch', 'visits', 'agreements', 'crew', 'billing', 'settings'] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>('dispatch');
  const label: Record<string, string> = { dispatch: 'Dispatch', visits: 'Visits', agreements: 'Agreements', crew: 'Technicians, trucks and tools', billing: 'Billing', settings: 'Settings' };
  return (
    <>
      <PageHead eyebrow="Field service" title="Field service" sub="Agreements, scheduled visits, dispatch, technicians, trucks and tools." actions={<Link className="btn" to="/reports/service-performance">Performance report</Link>} />
      <div className="row" role="tablist">
        {tabs.filter((t) => (t !== 'billing' || can('ar.view')) && (t !== 'settings' || can('fieldservice.manage'))).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>{label[t]}</button>)}
      </div>
      {tab === 'dispatch' && <Dispatch />}
      {tab === 'visits' && <Visits />}
      {tab === 'agreements' && <Agreements />}
      {tab === 'crew' && <Crew />}
      {tab === 'billing' && <Billing />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

function Dispatch() {
  const { can } = useAuth();
  const [date, setDate] = useState(today());
  const board = useApi<any>(`/api/service-dispatch/board?date=${date}`);
  const [pick, setPick] = useState<any>(null);
  const sugg = useApi<any>(pick ? `/api/service-visits/${pick.id}/suggestions?date=${date}` : null);
  const assign = useAction(async (technicianId: string) => { await api.post(`/api/service-visits/${pick.id}/assign`, { technicianId, date }); setPick(null); await board.reload(); });
  const send = useAction(async (technicianId: string) => { await api.post('/api/service-dispatch/dispatch', { technicianId, date }); await board.reload(); });
  const unassign = useAction(async (id: string) => { await api.post(`/api/service-visits/${id}/unassign`); await board.reload(); });
  const manage = can('fieldservice.manage');
  return (
    <section className="stack" aria-label="Dispatch board">
      <div className="row">
        <button onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">‹</button>
        <label className="field" style={{ margin: 0 }}>Day<input id="disp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <button onClick={() => setDate(addDays(date, 1))} aria-label="Next day">›</button>
        <button onClick={() => setDate(today())}>Today</button>
        <span className="muted">Drive time = straight-line distance × {board.data?.settings.roadFactor} ÷ {board.data?.settings.avgSpeedMph} mph (estimate; set in Settings).</span>
      </div>
      <ErrorNote message={assign.error ?? send.error ?? unassign.error} />
      <Async loading={board.loading && !board.data} error={board.error}>{() => (
        <>
          <div className="grid two">
            {board.data.technicians.map((t: any) => (
              <section key={t.id} className="card stack" aria-label={t.name}>
                <div className="spread"><h2>{t.name}</h2>{t.working ? <Pill tone={t.overbooked ? 'bad' : t.loadPercent > 85 ? 'watch' : 'good'} label={`${t.loadPercent}% of the day`} /> : <Pill tone="neutral" label={t.off ?? 'Not working'} />}</div>
                <p className="muted" style={{ margin: 0 }}>{t.skills.join(', ') || 'no skills listed'} · {t.workMinutes} min on site + {t.driveMinutes} min driving of {t.capacityMinutes}</p>
                <Table tools={false} rows={t.stops} rowKey={(s) => s.id} empty="Nothing booked." columns={[{ key: 'arrive', label: 'Arrive' }, { key: 'number', label: 'Visit', render: (s) => <Link to={`/service/visits/${s.id}`}>{s.number}</Link> },
                  { key: 'customer', label: 'Customer', render: (s) => `${s.customer}${s.site ? ` · ${s.site}` : ''}` }, { key: 'driveMinutes', label: 'Drive', numeric: true, render: (s) => `${s.driveMinutes} min${s.driveEstimate ? '*' : ''}` },
                  { key: 'status', label: '', plain: true, render: (s) => (manage && ['scheduled', 'dispatched'].includes(s.status) ? <button onClick={() => unassign.run(s.id)}>Unassign</button> : <Pill value={s.status} />) }]} />
                {manage && t.stops.some((s: any) => s.status === 'scheduled') && <div><button className="primary" disabled={send.busy} onClick={() => send.run(t.id)}>Send the day to {t.name.split(' ')[0]}</button></div>}
              </section>
            ))}
            {!board.data.technicians.length && <section className="card"><p className="muted">No technicians are set up yet. Add them under “Technicians, trucks and tools”.</p></section>}
          </div>
          <section className="card stack">
            <h2>To schedule</h2>
            <Table rows={board.data.unassigned} rowKey={(v) => v.id} exception={(v) => v.overdue} empty="Nothing waiting to be scheduled in the next week."
              columns={[{ key: 'number', label: 'Visit', render: (v) => <Link to={`/service/visits/${v.id}`}>{v.number}</Link> }, { key: 'customer', label: 'Customer', render: (v) => `${v.customer}${v.site ? ` · ${v.site}` : ''}` }, { key: 'title', label: 'What' },
                { key: 'due_on', label: 'Due', render: (v) => fmtDate(v.due_on) }, { key: 'estimated_minutes', label: 'Minutes', numeric: true }, { key: 'required_skill', label: 'Skill' },
                { key: 'kind', label: '', plain: true, render: (v) => (manage ? <button className="primary" onClick={() => setPick(v)}>Assign…</button> : null) }]} />
          </section>
        </>
      )}</Async>
      {pick && (
        <section className="card stack" role="dialog" aria-label={`Assign ${pick.number}`}>
          <div className="spread"><h2>Assign {pick.number} on {fmtDate(date)}</h2><button onClick={() => setPick(null)}>Close</button></div>
          <p className="muted">{pick.customer} · {pick.title} · {pick.estimated_minutes} min{pick.required_skill ? ` · needs ${pick.required_skill}` : ''}</p>
          <Async loading={sugg.loading && !sugg.data} error={sugg.error}>{() => (
            <Table tools={false} rows={sugg.data.suggestions} rowKey={(s) => s.technicianId} empty="No technicians set up."
              columns={[{ key: 'name', label: 'Technician' }, { key: 'eligible', label: 'Fit', render: (s) => (s.eligible ? <Pill tone="good" label="Can take it" /> : <span className="muted">{s.reasons.join('; ')}</span>) },
                { key: 'addedDriveMinutes', label: 'Extra drive', numeric: true, render: (s) => `${s.addedDriveMinutes} min${s.driveEstimate ? '*' : ''}` }, { key: 'visitsThatDay', label: 'Already that day', numeric: true },
                { key: 'remainingMinutesAfter', label: 'Free after', numeric: true, render: (s) => `${s.remainingMinutesAfter} min` },
                { key: 'go', label: '', plain: true, render: (s) => <button className="primary" disabled={!s.eligible || assign.busy} onClick={() => assign.run(s.technicianId)}>Assign</button> }]} />
          )}</Async>
          <p className="faint">* a site or technician without map coordinates is assumed 20 minutes away.</p>
        </section>
      )}
    </section>
  );
}

function Visits() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [f, setF] = useState<'open' | 'overdue' | 'all'>('open');
  const { data, loading, error } = useApi<any[]>(`/api/service-visits${f === 'open' ? '?open=true' : f === 'overdue' ? '?overdue=true' : ''}`);
  return (
    <section className="stack" aria-label="Visits">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label className="field" style={{ margin: 0 }}>Show<select id="visit-filter" value={f} onChange={(e) => setF(e.target.value as any)}><option value="open">Open visits</option><option value="overdue">Overdue</option><option value="all">All</option></select></label>
        {can('fieldservice.manage') && <button className="primary" onClick={() => nav('/service/callouts/new')}>New call-out</button>}
      </div>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(v) => v.id} onRow={(v) => nav(`/service/visits/${v.id}`)} exception={(v) => v.overdue} empty="No visits."
          columns={[{ key: 'number', label: 'Visit', render: (v) => <strong>{v.number}</strong> }, { key: 'customer_name', label: 'Customer' }, { key: 'site_name', label: 'Site' }, { key: 'asset_tag', label: 'Equipment' }, { key: 'title', label: 'What' },
            { key: 'due_on', label: 'Due', render: (v) => fmtDate(v.due_on) }, { key: 'technician_name', label: 'Technician' }, { key: 'status', label: 'Status', render: (v) => <VisitStatus v={v} />, value: (v) => v.status }]} />
      )}</Async>
    </section>
  );
}

export function NewCallout() {
  const nav = useNavigate();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const customers = useApi<any[]>('/api/customers');
  const [customerId, setCustomerId] = useState('');
  const equipment = useApi<any[]>(customerId ? `/api/customer-equipment?customerId=${customerId}` : null);
  const allowed = (facilities.data ?? []).filter((x) => can('fieldservice.manage', x.id) && x.modules?.includes('field_service'));
  const [f, setF] = useState({ facilityId: '', assetId: '', title: '', priority: '3', dueOn: today(), estimatedMinutes: '60', requiredSkill: '', notes: '' });
  const act = useAction(async () => { const v = await api.post('/api/service-visits', { facilityId: f.facilityId || allowed[0]?.id, customerId, assetId: f.assetId, title: f.title, priority: Number(f.priority), dueOn: f.dueOn, estimatedMinutes: Number(f.estimatedMinutes), requiredSkill: f.requiredSkill || null, notes: f.notes || null }); nav(`/service/visits/${v.id}`); });
  return (
    <>
      <PageHead eyebrow="Field service" title="New call-out" sub="An unscheduled call: choose the customer and the equipment it is about." />
      <section className="card"><form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
        <div className="form-grid">
          <label className="field">Customer<select id="co-cust" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setF({ ...f, assetId: '' }); }} required><option value="">Choose…</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">Equipment<select id="co-asset" value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })} required><option value="">Choose…</option>{(equipment.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.asset_tag} · {a.name} ({a.site_name})</option>)}</select></label>
          <label className="field">Priority<select id="co-pri" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="1">Emergency</option><option value="2">High</option><option value="3">Normal</option><option value="4">Low</option></select></label>
          <label className="field">Needed by<input id="co-due" type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} /></label>
          <label className="field">Minutes<input id="co-min" type="number" min="5" value={f.estimatedMinutes} onChange={(e) => setF({ ...f, estimatedMinutes: e.target.value })} /></label>
          <label className="field">Skill needed<input id="co-skill" value={f.requiredSkill} onChange={(e) => setF({ ...f, requiredSkill: e.target.value })} placeholder="e.g. refrigeration" /></label>
        </div>
        <label className="field">What is wrong<input id="co-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /></label>
        <label className="field">Notes<textarea id="co-notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <ErrorNote message={act.error} /><div><button className="primary" disabled={act.busy || !customerId || !f.assetId}>Create call-out</button></div>
      </form></section>
    </>
  );
}

export function ServiceVisitDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: v, loading, error, reload } = useApi<any>(`/api/service-visits/${id}`);
  const report = useApi<any>(`/api/service-visits/${id}/report`);
  const [reason, setReason] = useState('');
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<number[]>([]);
  const cancel = useAction(async () => { await api.post(`/api/service-visits/${id}/cancel`, { reason }); setReason(''); await reload(); });
  const quote = useAction(async () => { const q = await api.post(`/api/service-visits/${id}/quote`, { items: picked.map((index) => ({ index, unitPrice: prices[index] ? Number(prices[index]) : null })) }); await report.reload(); window.location.assign(`/sales/quotes/${q.quoteId}`); });
  const bill = useAction(async () => { await api.post(`/api/service-visits/${id}/bill`); await report.reload(); });
  const [sig, setSig] = useState<string | null>(null);
  const showSig = async () => { const b = await api.blob(`/api/service-visits/${id}/report/signature`); setSig(b.url); };
  return (
    <Async loading={loading && !v} error={error}>{() => {
      const r = report.data;
      return (
        <>
          <PageHead eyebrow={`Field service · ${v.facility_code}`} title={`${v.number} · ${v.title}`} sub={<>{v.customer_name}{v.site_name ? ` · ${v.site_name}` : ''}{v.asset_tag ? ` · ${v.asset_tag}` : ''} · <VisitStatus v={v} /></>} />
          <Kpis items={[{ label: 'Due', value: fmtDate(v.due_on), tone: v.overdue ? 'bad' : undefined }, { label: 'Scheduled', value: v.scheduled_on ? `${fmtDate(v.scheduled_on)} ${v.scheduled_start?.slice(0, 5) ?? ''}` : '—' }, { label: 'Technician', value: v.technician_name ?? '—' }, { label: 'Estimated', value: `${v.estimated_minutes} min` }]} />
          <section className="card stack">
            <h2>The job</h2>
            <p style={{ margin: 0 }}>{v.notes ?? <span className="faint">No notes.</span>}</p>
            {v.access_notes && <p className="muted">Access: {v.access_notes}</p>}
            {v.agreement_number && <p className="muted">Agreement {v.agreement_number}</p>}
            {v.checklist?.length > 0 && <><h3>Checklist</h3><ol>{v.checklist.map((c: string) => <li key={c}>{c}</li>)}</ol></>}
            {v.work_order_id && <p><Link to={`/work-orders/${v.work_order_id}`}>Work order</Link></p>}
            {can('fieldservice.manage') && ['planned', 'scheduled', 'dispatched'].includes(v.status) && (
              <div className="row"><input id="visit-reason" aria-label="Reason" placeholder="Reason for cancelling" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 300px' }} /><button className="danger" disabled={cancel.busy || reason.trim().length < 3} onClick={() => cancel.run()}>Cancel visit</button></div>
            )}
            <ErrorNote message={cancel.error} />
          </section>
          {r && r.status === 'submitted' && (
            <section className="card stack">
              <h2>Service report</h2>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.work_performed}</p>
              {r.findings && <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>Findings: {r.findings}</p>}
              <p className="muted">{r.labor_hours} hours · {r.checklist_results.filter((c: any) => c.result === 'issue').length} issue(s) on the checklist · {r.customer_present ? `signed by ${r.customer_signed_name}` : `not signed: ${r.no_signature_reason}`}{r.hasSignature && <> <button className="link" onClick={showSig}>View signature</button></>}</p>
              {sig && <img src={sig} alt="Customer signature" style={{ maxWidth: 360, border: '1px solid var(--rule)', background: '#fff' }} />}
              {r.readings.length > 0 && <p className="muted">Readings: {r.readings.map((x: any) => `${x.name} ${x.value}${x.unit ?? ''}`).join(' · ')}</p>}
              <p>Billing: <Pill tone={r.billing_status === 'billed' ? 'good' : r.billing_status === 'ready' ? 'watch' : 'neutral'} label={r.billing_status === 'ready' ? 'Ready to invoice' : r.billing_status === 'covered' ? 'Covered by the agreement' : r.billing_status} />
                {r.billing_status === 'ready' && can('ar.manage') && <> <button className="primary" disabled={bill.busy} onClick={() => bill.run()}>Create invoice</button></>}</p>
              <ErrorNote message={bill.error} />
              {r.recommended_repairs.length > 0 && (
                <div className="stack"><h3>Recommended repairs {r.quote && <span className="muted" style={{ fontWeight: 400 }}>· quote {r.quote.number}</span>}</h3>
                  <Table tools={false} rows={r.recommended_repairs.map((x: any, i: number) => ({ ...x, i }))} rowKey={(x) => String(x.i)} columns={[
                    { key: 'pick', label: '', plain: true, render: (x) => (x.quoted ? <Pill tone="good" label={`On ${x.quoted}`} /> : can('sales.quote') ? <input type="checkbox" aria-label={`Quote ${x.description}`} checked={picked.includes(x.i)} onChange={() => setPicked(picked.includes(x.i) ? picked.filter((n) => n !== x.i) : [...picked, x.i])} /> : null) },
                    { key: 'description', label: 'Repair' }, { key: 'urgency', label: 'When', render: (x) => String(x.urgency).replace(/_/g, ' ') }, { key: 'qty', label: 'Qty', numeric: true },
                    { key: 'unitPrice', label: 'Price each', plain: true, render: (x) => (x.quoted ? fmtMoney(x.unitPrice) : <input aria-label={`Price for ${x.description}`} type="number" min="0" step="any" placeholder={x.unitPrice != null ? String(x.unitPrice) : 'Price'} value={prices[x.i] ?? ''} onChange={(e) => setPrices({ ...prices, [x.i]: e.target.value })} style={{ width: 110 }} />) }]} />
                  {can('sales.quote') && <div><button className="primary" disabled={!picked.length || quote.busy} onClick={() => quote.run()}>Create a draft quote from the selected repairs</button></div>}
                  <ErrorNote message={quote.error} /></div>
              )}
            </section>
          )}
        </>
      );
    }}</Async>
  );
}

function Agreements() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/service-agreements');
  return (
    <section className="stack" aria-label="Agreements">
      <div className="row" style={{ justifyContent: 'flex-end' }}>{can('fieldservice.manage') && <button className="primary" onClick={() => nav('/service/agreements/new')}>New agreement</button>}</div>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(a) => a.id} onRow={(a) => nav(`/service/agreements/${a.id}`)} exception={(a) => a.overdue_visits > 0} empty="No service agreements yet."
          columns={[{ key: 'number', label: 'Agreement', render: (a) => <strong>{a.number}</strong> }, { key: 'customer_name', label: 'Customer' }, { key: 'status', label: 'Status', render: (a) => <Pill value={a.status} />, value: (a) => a.status },
            { key: 'billing_model', label: 'Billing', render: (a) => (a.billing_model === 'monthly' ? `${fmtMoney(a.monthly_fee)} a month` : `${fmtMoney(a.per_visit_fee)} a visit`), value: (a) => a.billing_model },
            { key: 'covered_units', label: 'Units', numeric: true }, { key: 'next_visit_due', label: 'Next visit due', render: (a) => (a.next_visit_due ? fmtDate(a.next_visit_due) : '—') }, { key: 'overdue_visits', label: 'Overdue', numeric: true }]} />
      )}</Async>
    </section>
  );
}

export function NewAgreement() {
  const nav = useNavigate();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const customers = useApi<any[]>('/api/customers');
  const allowed = (facilities.data ?? []).filter((x) => can('fieldservice.manage', x.id) && x.modules?.includes('field_service'));
  const [f, setF] = useState({ facilityId: '', customerId: '', startsOn: today(), endsOn: '', billingModel: 'per_visit', monthlyFee: '', perVisitFee: '', responseHours: '', partsIncluded: false, autoRenew: false, terms: '' });
  const act = useAction(async () => {
    const a = await api.post('/api/service-agreements', { facilityId: f.facilityId || allowed[0]?.id, customerId: f.customerId, startsOn: f.startsOn, endsOn: f.endsOn || null, billingModel: f.billingModel, monthlyFee: f.monthlyFee ? Number(f.monthlyFee) : null,
      perVisitFee: f.perVisitFee ? Number(f.perVisitFee) : null, responseHours: f.responseHours ? Number(f.responseHours) : null, partsIncluded: f.partsIncluded, autoRenew: f.autoRenew, terms: f.terms || null });
    nav(`/service/agreements/${a.id}`);
  });
  return (
    <>
      <PageHead eyebrow="Field service" title="New service agreement" sub="Saved as a draft. Add the equipment it covers, then activate it to generate the visits." />
      <section className="card"><form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
        <div className="form-grid">
          <label className="field">Customer<select id="ag-cust" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} required><option value="">Choose…</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">Servicing site<select id="ag-fac" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>{allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
          <label className="field">Starts<input id="ag-start" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} required /></label>
          <label className="field">Ends (blank = open-ended)<input id="ag-end" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></label>
          <label className="field">Billing<select id="ag-model" value={f.billingModel} onChange={(e) => setF({ ...f, billingModel: e.target.value })}><option value="per_visit">Per visit</option><option value="monthly">Flat monthly</option></select></label>
          {f.billingModel === 'monthly' ? <label className="field">Monthly fee<input id="ag-monthly" type="number" min="0" step="any" value={f.monthlyFee} onChange={(e) => setF({ ...f, monthlyFee: e.target.value })} required /></label>
            : <label className="field">Fee per visit (default)<input id="ag-visit" type="number" min="0" step="any" value={f.perVisitFee} onChange={(e) => setF({ ...f, perVisitFee: e.target.value })} required /></label>}
          <label className="field">Response time for call-outs (hours)<input id="ag-resp" type="number" min="1" value={f.responseHours} onChange={(e) => setF({ ...f, responseHours: e.target.value })} /></label>
        </div>
        <label className="row"><input type="checkbox" checked={f.partsIncluded} onChange={(e) => setF({ ...f, partsIncluded: e.target.checked })} /> Parts are included in the fee</label>
        <label className="row"><input type="checkbox" checked={f.autoRenew} onChange={(e) => setF({ ...f, autoRenew: e.target.checked })} /> Renews automatically</label>
        <label className="field">Terms<textarea id="ag-terms" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} /></label>
        <ErrorNote message={act.error} /><div><button className="primary" disabled={act.busy || !f.customerId}>Save draft</button></div>
      </form></section>
    </>
  );
}

export function AgreementDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: a, loading, error, reload } = useApi<any>(`/api/service-agreements/${id}`);
  const equipment = useApi<any[]>(a ? `/api/customer-equipment?customerId=${a.customer_id}` : null);
  const [p, setP] = useState({ assetId: '', title: '', everyN: '3', unit: 'month', firstDueOn: today(), estimatedMinutes: '60', requiredSkill: '', checklist: '', perVisitFee: '' });
  const [reason, setReason] = useState('');
  const addPlan = useAction(async () => { await api.post(`/api/service-agreements/${id}/plans`, { assetId: p.assetId, title: p.title, everyN: Number(p.everyN), unit: p.unit, firstDueOn: p.firstDueOn, estimatedMinutes: Number(p.estimatedMinutes), requiredSkill: p.requiredSkill || null,
    checklist: p.checklist.split('\n').map((x) => x.trim()).filter(Boolean), perVisitFee: p.perVisitFee ? Number(p.perVisitFee) : null }); setP({ ...p, title: '', checklist: '' }); await reload(); });
  const act = useAction(async (path: string, body?: unknown) => { await api.post(`/api/service-agreements/${id}/${path}`, body); setReason(''); await reload(); });
  const planActive = useAction(async (pid: string, active: boolean) => { await api.post(`/api/service-plans/${pid}/active`, { active }); await reload(); });
  return (
    <Async loading={loading && !a} error={error}>{() => {
      const manage = can('fieldservice.manage', a.facility_id);
      return (
        <>
          <PageHead eyebrow={`Service agreement · ${a.facility_code}`} title={`${a.number} · ${a.customer_name}`} sub={<><Pill value={a.status} /> · {a.billing_model === 'monthly' ? `${fmtMoney(a.monthly_fee)} a month` : `${fmtMoney(a.per_visit_fee)} a visit`}{a.parts_included ? ', parts included' : ''}{a.response_hours ? ` · responds within ${a.response_hours} h` : ''}</>} />
          <Kpis items={[{ label: 'Starts', value: fmtDate(a.starts_on) }, { label: 'Ends', value: a.ends_on ? fmtDate(a.ends_on) : 'Open-ended' }, { label: 'Covered units', value: a.covered_units }, { label: 'Overdue visits', value: a.overdue_visits, tone: a.overdue_visits ? 'bad' : 'good' }]} />
          <section className="card stack">
            <h2>Covered equipment</h2>
            <Table tools={false} rows={a.plans} rowKey={(x) => x.id} empty="Nothing covered yet." columns={[{ key: 'asset_tag', label: 'Unit', render: (x) => `${x.asset_tag} · ${x.asset_name}` }, { key: 'site_name', label: 'Site' }, { key: 'title', label: 'Service' },
              { key: 'every_n', label: 'Every', render: (x) => `${x.every_n} ${x.unit}${x.every_n > 1 ? 's' : ''}` }, { key: 'next_due_on', label: 'Next to generate', render: (x) => fmtDate(x.next_due_on) }, { key: 'estimated_minutes', label: 'Minutes', numeric: true },
              { key: 'active', label: '', plain: true, render: (x) => (manage ? <button onClick={() => planActive.run(x.id, !x.active)}>{x.active ? 'Remove' : 'Restore'}</button> : null) }]} />
            {manage && !['ended', 'cancelled'].includes(a.status) && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void addPlan.run(); }}>
                <h3>Add a covered unit</h3>
                <div className="form-grid">
                  <label className="field">Equipment<select id="pl-asset" value={p.assetId} onChange={(e) => setP({ ...p, assetId: e.target.value })} required><option value="">Choose…</option>{(equipment.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.asset_tag} · {x.name} ({x.site_name})</option>)}</select></label>
                  <label className="field">Service<input id="pl-title" value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} required placeholder="e.g. Quarterly PM" /></label>
                  <label className="field">Every<input id="pl-every" type="number" min="1" value={p.everyN} onChange={(e) => setP({ ...p, everyN: e.target.value })} /></label>
                  <label className="field">Unit<select id="pl-unit" value={p.unit} onChange={(e) => setP({ ...p, unit: e.target.value })}><option value="week">weeks</option><option value="month">months</option><option value="year">years</option></select></label>
                  <label className="field">First due<input id="pl-first" type="date" value={p.firstDueOn} onChange={(e) => setP({ ...p, firstDueOn: e.target.value })} /></label>
                  <label className="field">Minutes<input id="pl-min" type="number" min="5" value={p.estimatedMinutes} onChange={(e) => setP({ ...p, estimatedMinutes: e.target.value })} /></label>
                  <label className="field">Skill needed<input id="pl-skill" value={p.requiredSkill} onChange={(e) => setP({ ...p, requiredSkill: e.target.value })} /></label>
                  <label className="field">Fee for this unit (overrides the agreement)<input id="pl-fee" type="number" min="0" step="any" value={p.perVisitFee} onChange={(e) => setP({ ...p, perVisitFee: e.target.value })} /></label>
                </div>
                <label className="field">Checklist (one item per line)<textarea id="pl-list" value={p.checklist} onChange={(e) => setP({ ...p, checklist: e.target.value })} /></label>
                <div><button className="primary" disabled={addPlan.busy || !p.assetId}>Add</button></div><ErrorNote message={addPlan.error} />
              </form>
            )}
          </section>
          {manage && !['ended', 'cancelled'].includes(a.status) && (
            <section className="card stack"><h2>Status</h2>
              <div className="row">{['draft', 'suspended'].includes(a.status) && <button className="primary" disabled={act.busy} onClick={() => act.run('activate')}>Activate (generates the visits)</button>}</div>
              <div className="row"><input id="ag-reason" aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 300px' }} />
                {a.status === 'active' && <button disabled={act.busy || reason.trim().length < 3} onClick={() => act.run('suspend', { reason })}>Suspend</button>}
                <button disabled={act.busy || reason.trim().length < 3} onClick={() => act.run('end', { outcome: 'ended', reason })}>End</button>
                <button className="danger" disabled={act.busy || reason.trim().length < 3} onClick={() => act.run('end', { outcome: 'cancelled', reason })}>Cancel</button></div>
              <ErrorNote message={act.error ?? planActive.error} /></section>
          )}
          <section className="card"><h2>Visits</h2>
            <Table rows={a.visits} rowKey={(v) => v.id} empty="No visits yet." columns={[{ key: 'number', label: 'Visit', render: (v) => <Link to={`/service/visits/${v.id}`}>{v.number}</Link> }, { key: 'title', label: 'Service' }, { key: 'due_on', label: 'Due', render: (v) => fmtDate(v.due_on) },
              { key: 'status', label: 'Status', render: (v) => <VisitStatus v={v} />, value: (v) => v.status }]} /></section>
        </>
      );
    }}</Async>
  );
}

function Crew() {
  const { can } = useAuth();
  const techs = useApi<any[]>('/api/technicians');
  const vehicles = useApi<any[]>('/api/vehicles');
  const tools = useApi<any[]>('/api/service-tools');
  const restock = useApi<any[]>('/api/truck-restock');
  const employees = useApi<any[]>('/api/employees');
  const facilities = useApi<any[]>('/api/facilities');
  const [t, setT] = useState({ employeeId: '', skills: '', homeLat: '', homeLon: '' });
  const [v, setV] = useState({ tag: '', name: '', plate: '' });
  const [err, setErr] = useState<string | null>(null);
  const manage = can('fieldservice.manage');
  const fac = (facilities.data ?? []).find((x) => x.modules?.includes('field_service'))?.id;
  const saveT = async () => { setErr(null); try { await api.put(`/api/technicians/${t.employeeId}`, { skills: t.skills.split(',').map((x) => x.trim()).filter(Boolean), homeLat: t.homeLat ? Number(t.homeLat) : null, homeLon: t.homeLon ? Number(t.homeLon) : null }); setT({ employeeId: '', skills: '', homeLat: '', homeLon: '' }); await techs.reload(); } catch (e: any) { setErr(e.message); } };
  const saveV = async () => { setErr(null); try { await api.post('/api/vehicles', { facilityId: fac, tag: v.tag, name: v.name, plate: v.plate || null }); setV({ tag: '', name: '', plate: '' }); await vehicles.reload(); } catch (e: any) { setErr(e.message); } };
  const checkout = async (id: string) => { setErr(null); try { await api.post(`/api/service-tools/${id}/checkout`, {}); await tools.reload(); } catch (e: any) { setErr(e.message); } };
  const back = async (id: string) => { setErr(null); try { await api.post(`/api/service-tools/${id}/return`, {}); await tools.reload(); } catch (e: any) { setErr(e.message); } };
  return (
    <section className="stack" aria-label="Technicians, trucks and tools">
      <ErrorNote message={err} />
      <section className="card stack"><h2>Technicians</h2>
        <Table tools={false} rows={techs.data ?? []} rowKey={(x) => x.id} empty="No technicians set up." columns={[{ key: 'last_name', label: 'Name', render: (x) => `${x.first_name} ${x.last_name}` }, { key: 'skills', label: 'Skills', render: (x) => x.skills.join(', ') || '—' },
          { key: 'work_days', label: 'Hours', render: (x) => `${x.day_start.slice(0, 5)}–${x.day_end.slice(0, 5)}` }, { key: 'vehicle_tag', label: 'Truck' }, { key: 'visits_today', label: 'Visits today', numeric: true }]} />
        {manage && <form className="row" onSubmit={(e) => { e.preventDefault(); void saveT(); }}>
          <label className="field">Employee<select id="tech-emp" value={t.employeeId} onChange={(e) => setT({ ...t, employeeId: e.target.value })} required><option value="">Choose…</option>{(employees.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.first_name} {x.last_name}</option>)}</select></label>
          <label className="field">Skills (comma separated)<input id="tech-skills" value={t.skills} onChange={(e) => setT({ ...t, skills: e.target.value })} /></label>
          <label className="field">Home latitude<input id="tech-lat" value={t.homeLat} onChange={(e) => setT({ ...t, homeLat: e.target.value })} /></label>
          <label className="field">Home longitude<input id="tech-lon" value={t.homeLon} onChange={(e) => setT({ ...t, homeLon: e.target.value })} /></label>
          <button className="primary" disabled={!t.employeeId}>Save technician</button></form>}
      </section>
      <section className="card stack"><h2>Trucks</h2>
        <Table tools={false} rows={vehicles.data ?? []} rowKey={(x) => x.id} empty="No trucks." columns={[{ key: 'asset_tag', label: 'Truck' }, { key: 'name', label: 'Name' }, { key: 'plate', label: 'Plate' }]} />
        {manage && <form className="row" onSubmit={(e) => { e.preventDefault(); void saveV(); }}>
          <label className="field">Tag<input id="veh-tag" value={v.tag} onChange={(e) => setV({ ...v, tag: e.target.value })} required /></label><label className="field">Name<input id="veh-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required /></label>
          <label className="field">Plate<input id="veh-plate" value={v.plate} onChange={(e) => setV({ ...v, plate: e.target.value })} /></label><button className="primary">Add truck</button></form>}
        <h3>Restock list</h3>
        <Table tools={false} rows={restock.data ?? []} rowKey={(x) => `${x.vehicle_id}${x.part_id}`} empty="Every truck is at or above its minimums." columns={[{ key: 'asset_tag', label: 'Truck' }, { key: 'part_number', label: 'Part' }, { key: 'qty', label: 'On truck', numeric: true }, { key: 'min', label: 'Minimum', numeric: true },
          { key: 'needed', label: 'To par', numeric: true }, { key: 'canSupply', label: 'Storerooms can supply', numeric: true }]} />
      </section>
      <section className="card stack"><h2>Tools</h2>
        <Table tools={false} rows={tools.data ?? []} rowKey={(x) => x.id} empty="No tools. Add assets of class tool." exception={(x) => x.calibration_overdue} columns={[{ key: 'asset_tag', label: 'Tool' }, { key: 'name', label: 'Name' },
          { key: 'calibration_due', label: 'Calibration due', render: (x) => (x.calibration_due ? <>{fmtDate(x.calibration_due)} {x.calibration_overdue && <Pill tone="bad" label="Overdue" />}</> : '—') }, { key: 'held_by', label: 'With' },
          { key: 'go', label: '', plain: true, render: (x) => (x.held_by ? <button onClick={() => back(x.id)}>Return</button> : <button disabled={x.calibration_overdue} onClick={() => checkout(x.id)} title={x.calibration_overdue ? 'Overdue for calibration' : undefined}>Check out to me</button>) }]} />
      </section>
    </section>
  );
}

function Billing() {
  const ready = useApi<any[]>('/api/service-billing/ready');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [result, setResult] = useState<any>(null);
  const bill = useAction(async (id: string) => { await api.post(`/api/service-visits/${id}/bill`); await ready.reload(); });
  const run = useAction(async () => { setResult(await api.post('/api/service-billing/monthly', { month })); });
  return (
    <section className="stack" aria-label="Billing">
      <section className="card stack"><h2>Visits ready to invoice</h2>
        <Table tools={false} rows={ready.data ?? []} rowKey={(r) => r.id} empty="Nothing waiting." columns={[{ key: 'number', label: 'Visit', render: (r) => <Link to={`/service/visits/${r.visit_id}`}>{r.number}</Link> }, { key: 'customer', label: 'Customer' }, { key: 'title', label: 'What' }, { key: 'asset_tag', label: 'Equipment' },
          { key: 'total', label: 'Amount', numeric: true, render: (r) => fmtMoney(r.total) }, { key: 'go', label: '', plain: true, render: (r) => <button className="primary" disabled={bill.busy} onClick={() => bill.run(r.visit_id)}>Create invoice</button> }]} />
        <ErrorNote message={bill.error} />
      </section>
      <section className="card stack"><h2>Flat monthly fees</h2>
        <p className="muted">One invoice per flat-fee agreement for the month, from the month it starts (the full fee, no proration). Running a month twice is safe.</p>
        <div className="row"><label className="field">Month<input id="bill-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label><button className="primary" disabled={run.busy} onClick={() => run.run()}>Create the month’s invoices</button></div>
        <ErrorNote message={run.error} />
        {result && <p role="status">{result.invoices.length ? `${result.invoices.length} invoice${result.invoices.length === 1 ? '' : 's'} created: ${result.invoices.map((i: any) => `${i.customer} ${fmtMoney(i.amount)}`).join(', ')}.` : 'Nothing new to invoice for that month.'}</p>}
      </section>
    </section>
  );
}

function Settings() {
  const { data, reload } = useApi<any>('/api/service-settings');
  const [f, setF] = useState<any>(null);
  const save = useAction(async () => { await api.put('/api/service-settings', { roadFactor: Number(f.roadFactor), avgSpeedMph: Number(f.avgSpeedMph), horizonDays: Number(f.horizonDays), defaultVisitMinutes: Number(f.defaultVisitMinutes), laborRatePerHour: Number(f.laborRatePerHour), partsMarkupPercent: Number(f.partsMarkupPercent) }); setF(null); await reload(); });
  if (!data) return null;
  return (
    <section className="card stack"><div className="spread"><h2>Settings</h2>{!f && <button onClick={() => setF({ ...data })}>Change</button>}</div>
      {!f ? <dl className="facts"><dt>Road factor</dt><dd>{data.roadFactor}× the straight-line distance</dd><dt>Average speed</dt><dd>{data.avgSpeedMph} mph</dd><dt>Generate visits</dt><dd>{data.horizonDays} days ahead</dd><dt>Default visit</dt><dd>{data.defaultVisitMinutes} minutes</dd><dt>Call-out labor rate</dt><dd>{fmtMoney(data.laborRatePerHour)} an hour</dd><dt>Parts markup</dt><dd>{data.partsMarkupPercent}% over cost</dd></dl>
        : <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} data-no-draft><div className="form-grid">
          <label className="field">Road factor<input id="fs-road" type="number" step="0.05" value={f.roadFactor} onChange={(e) => setF({ ...f, roadFactor: e.target.value })} /></label>
          <label className="field">Average speed (mph)<input id="fs-speed" type="number" value={f.avgSpeedMph} onChange={(e) => setF({ ...f, avgSpeedMph: e.target.value })} /></label>
          <label className="field">Generate visits (days ahead)<input id="fs-horizon" type="number" value={f.horizonDays} onChange={(e) => setF({ ...f, horizonDays: e.target.value })} /></label>
          <label className="field">Default visit (minutes)<input id="fs-minutes" type="number" value={f.defaultVisitMinutes} onChange={(e) => setF({ ...f, defaultVisitMinutes: e.target.value })} /></label>
          <label className="field">Call-out labor rate ($/hour)<input id="fs-rate" type="number" value={f.laborRatePerHour} onChange={(e) => setF({ ...f, laborRatePerHour: e.target.value })} /></label>
          <label className="field">Parts markup (%)<input id="fs-markup" type="number" value={f.partsMarkupPercent} onChange={(e) => setF({ ...f, partsMarkupPercent: e.target.value })} /></label></div>
          <div className="row"><button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={() => setF(null)}>Cancel</button></div><ErrorNote message={save.error} /></form>}
    </section>
  );
}
void fmtDateTime;
