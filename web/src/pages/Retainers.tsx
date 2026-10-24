import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  active: { label: 'Active', tone: 'good' }, paused: { label: 'Paused', tone: 'watch' }, cancelled: { label: 'Cancelled', tone: 'neutral' } };
const PER: Record<string, string> = { month: 'a month', quarter: 'a quarter', year: 'a year' };
const today = () => new Date().toISOString().slice(0, 10);

/** Retainers and subscriptions (SC-009): plans that invoice themselves on schedule. */
export function Retainers() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/retainer-plans');
  return (
    <>
      <PageHead eyebrow="Service companies" title="Retainers and subscriptions" sub="A plan invoices a fixed amount each month, quarter or year. The daily job makes one invoice per plan per period, as a draft unless your company issues them automatically." />
      <Async loading={loading && !data} error={error}>{() => {
        const live = data!.filter((p) => p.status !== 'cancelled');
        const mrr = live.reduce((s, p) => s + p.mrr, 0);
        const behind = live.filter((p) => p.behind || p.lastError).length;
        return (
          <>
            <Kpis items={[{ label: 'Monthly recurring revenue', value: fmtMoney(mrr) }, { label: 'Annual recurring revenue', value: fmtMoney(mrr * 12) }, { label: 'Active plans', value: live.filter((p) => p.status === 'active').length },
              { label: 'Paused', value: live.filter((p) => p.status === 'paused').length }, { label: 'Behind schedule or failed', value: behind, tone: behind ? 'bad' : 'good' }]} />
            <section className="card stack">
              <h2>Plans</h2>
              <Table rows={data!} onRow={(r) => nav(`/retainers/${r.id}`)} exception={(r) => !!r.lastError || (r.behind && r.status === 'active')} empty="No retainer plans yet."
                columns={[{ key: 'number', label: 'Plan' }, { key: 'customerName', label: 'Customer' }, { key: 'description', label: 'For' },
                  { key: 'amount', label: 'Amount', numeric: true, render: (r: any) => `${fmtMoney(r.amount)} ${PER[r.interval]}`, value: (r: any) => r.amount }, { key: 'mrr', label: 'Monthly', numeric: true, render: (r: any) => fmtMoney(r.mrr) },
                  { key: 'status', label: 'Status', render: (r: any) => <Pill tone={STATUS[r.status]?.tone} label={`${STATUS[r.status]?.label ?? r.status}${r.cancelOn && r.status !== 'cancelled' ? ` (ends ${fmtDate(r.cancelOn)})` : ''}`} />, value: (r: any) => r.status },
                  { key: 'nextInvoiceDate', label: 'Next invoice', render: (r: any) => (r.lastError ? <span className="faint">Failed: see plan</span> : fmtDate(r.nextInvoiceDate)) }, { key: 'endDate', label: 'Term ends', render: (r: any) => (r.endDate ? `${fmtDate(r.endDate)}${r.autoRenew ? ' (renews)' : ''}` : 'Open-ended'), value: (r: any) => r.endDate }]} />
            </section>
            {can('retainers.manage') && <NewPlan onDone={reload} />}
          </>
        );
      }}</Async>
    </>
  );
}

function NewPlan({ onDone }: { onDone: () => Promise<void> }) {
  const nav = useNavigate();
  const customers = useApi<any[]>('/api/customers');
  const sites = useApi<any[]>('/api/facilities');
  const [customerId, setCustomerId] = useState(''); const [projectId, setProjectId] = useState(''); const [facilityId, setFacilityId] = useState('');
  const [description, setDescription] = useState(''); const [amount, setAmount] = useState(''); const [interval, setInterval] = useState('month');
  const [startDate, setStartDate] = useState(today()); const [endDate, setEndDate] = useState(''); const [autoRenew, setAutoRenew] = useState(false);
  const [term, setTerm] = useState('12'); const [notice, setNotice] = useState('30'); const [prorate, setProrate] = useState(true);
  const projects = useApi<any[]>(customerId ? `/api/billing-projects?customerId=${customerId}` : null);
  const save = useAction(async () => {
    const r = await api.post('/api/retainer-plans', { customerId, projectId: projectId || null, facilityId: facilityId || null, description, amount: Number(amount), interval, startDate, endDate: endDate || null,
      autoRenew, renewalTermMonths: Number(term), noticeDays: Number(notice), prorate });
    await onDone(); nav(`/retainers/${r.id}`);
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label="New retainer plan">
      <h2>New plan</h2>
      <div className="row">
        <label className="field">Customer<select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setProjectId(''); }} required><option value="">Choose a customer</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field">Project (optional)<select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!customerId}><option value="">None</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></label>
        {(sites.data?.length ?? 0) > 1 && !projectId && <label className="field">Site that invoices<select value={facilityId} onChange={(e) => setFacilityId(e.target.value)}><option value="">My site</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></label>}
        <label className="field" style={{ flex: '1 1 260px' }}>What the customer pays for<input value={description} onChange={(e) => setDescription(e.target.value)} required placeholder="e.g. Managed IT support" /></label>
      </div>
      <div className="row">
        <label className="field">Amount<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
        <label className="field">Billed every<select value={interval} onChange={(e) => setInterval(e.target.value)}><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></select></label>
        <label className="field">Starts<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required /></label>
        <label className="field">Term ends (optional)<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
        <label className="field">Notice days before the end<input type="number" min="0" max="365" value={notice} onChange={(e) => setNotice(e.target.value)} /></label>
      </div>
      <div className="row">
        <label className="row"><input type="checkbox" checked={autoRenew} disabled={!endDate} onChange={(e) => setAutoRenew(e.target.checked)} /> Renews by itself at the end of the term</label>
        {autoRenew && <label className="field">Renews for (months)<input type="number" min="1" max="60" value={term} onChange={(e) => setTerm(e.target.value)} /></label>}
        <label className="row"><input type="checkbox" checked={prorate} onChange={(e) => setProrate(e.target.checked)} /> Charge a part period for the days covered (first and last period)</label>
      </div>
      <p className="muted" style={{ margin: 0 }}>Periods are calendar months, quarters or years. A plan that starts mid-period is charged for the days it covers when proration is on, and the full amount when it is off.</p>
      <ErrorNote message={save.error} />
      <div><button className="primary" disabled={save.busy || !customerId || !description || !amount}>Create the plan</button></div>
    </form>
  );
}

export function RetainerDetail() {
  const { id } = useParams();
  const { data: p, loading, error, reload } = useApi<any>(`/api/retainer-plans/${id}`);
  return (
    <Async loading={loading && !p} error={error}>{() => (
      <>
        <PageHead eyebrow="Retainer plan" title={`${p.number}: ${p.customerName}`} sub={`${p.description}${p.projectNumber ? `, project ${p.projectNumber}` : ''}`}
          actions={<><Link to="/retainers">All plans</Link><Pill tone={STATUS[p.status]?.tone} label={STATUS[p.status]?.label ?? p.status} /></>} />
        {p.lastError && <div className="notice error" role="alert">The scheduled invoice could not be made: {p.lastError}. Fix the cause and press Invoice now, or wait for the next daily run.</div>}
        {p.cancelOn && p.status !== 'cancelled' && <div className="notice warn">Cancellation is set for {fmtDate(p.cancelOn)}: {p.cancelReason}</div>}
        {p.status === 'cancelled' && <div className="notice warn">{p.cancelReason ?? 'Cancelled'} (last day {fmtDate(p.cancelOn)}).</div>}
        <Kpis items={[{ label: 'Amount now', value: `${fmtMoney(p.amount)} ${PER[p.interval]}` }, { label: 'Monthly recurring', value: fmtMoney(p.mrr) }, { label: 'Next invoice', value: p.nextInvoiceDate ? fmtDate(p.nextInvoiceDate) : '—', tone: p.behind ? 'bad' : undefined },
          { label: 'Term', value: p.endDate ? `to ${fmtDate(p.endDate)}` : 'Open-ended', note: p.endDate ? (p.autoRenew ? `renews for ${p.renewalTermMonths} months; ${p.noticeDays} days notice` : `${p.noticeDays} days notice`) : undefined }]} />
        {p.due.length > 0 && <Due plan={p} reload={reload} />}
        {p.canManage && p.status !== 'cancelled' && <Actions plan={p} reload={reload} />}
        <section className="card stack">
          <h2>Invoices made from this plan</h2>
          <Table rows={p.charges} rowKey={(c: any) => c.id} empty="No invoice has been made yet."
            columns={[{ key: 'periodStart', label: 'Period', render: (c: any) => `${fmtDate(c.coveredFrom)} to ${fmtDate(c.coveredTo)}${c.prorated ? ' (part period)' : ''}`, value: (c: any) => c.periodStart },
              { key: 'amount', label: 'Amount', numeric: true, render: (c: any) => fmtMoney(c.amount) },
              { key: 'invoiceNumber', label: 'Invoice', render: (c: any) => (c.invoiceId ? <Link to={`/receivables/${c.invoiceId}`}>{c.invoiceNumber ?? 'Draft'}</Link> : '—'), value: (c: any) => c.invoiceNumber },
              { key: 'status', label: 'State', render: (c: any) => (c.status === 'released' ? <Pill tone="watch" label="Released (invoice voided)" /> : <Pill tone="neutral" label={humanize(c.invoiceStatus ?? 'no invoice')} />), value: (c: any) => c.status },
              { key: 'automatic', label: 'Made by', render: (c: any) => (c.automatic ? 'Daily job' : 'A person'), value: (c: any) => (c.automatic ? 'job' : 'person') }]} />
          {p.upcoming.length > 0 && <p className="muted" style={{ margin: 0 }}>Next: {p.upcoming.map((u: any) => `${u.label} ${fmtMoney(u.amount)}`).join('; ')}.</p>}
        </section>
        <section className="card stack">
          <h2>Amounts and pauses</h2>
          <Table rows={p.amounts} rowKey={(a: any) => a.effectiveFrom} columns={[{ key: 'effectiveFrom', label: 'From', render: (a: any) => fmtDate(a.effectiveFrom) }, { key: 'amount', label: 'Amount', numeric: true, render: (a: any) => fmtMoney(a.amount) }]} />
          {p.pauses.length > 0 && <Table rows={p.pauses} rowKey={(a: any) => a.from} columns={[{ key: 'from', label: 'Paused from', render: (a: any) => fmtDate(a.from) }, { key: 'to', label: 'Resumed', render: (a: any) => (a.to ? fmtDate(a.to) : 'Still paused') }]} />}
        </section>
        <section className="card stack">
          <h2>History</h2>
          <Table rows={p.history} rowKey={(h: any) => String(h.id)} empty="Nothing recorded." columns={[{ key: 'occurred_at', label: 'When', render: (h: any) => fmtDateTime(h.occurred_at) }, { key: 'actor', label: 'Who', render: (h: any) => h.actor ?? 'Daily job' },
            { key: 'action', label: 'What', render: (h: any) => humanize(String(h.action).replace(/^retainers\./, '')) }]} />
        </section>
      </>
    )}</Async>
  );
}

function Due({ plan, reload }: { plan: any; reload: () => Promise<void> }) {
  const { can } = useAuth();
  const make = useAction(async (periodStart?: string) => { await api.post(`/api/retainer-plans/${plan.id}/generate`, periodStart ? { periodStart } : {}); await reload(); });
  return (
    <section className="card stack">
      <h2>Due now</h2>
      <p className="muted" style={{ margin: 0 }}>These periods have no invoice. The daily job makes them by itself, except a period whose invoice was voided: that one waits for a person.</p>
      <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>{plan.due.map((d: any) => (
        <li key={d.start}>{d.label}: {fmtMoney(d.amount)}{d.prorated ? ' (part period)' : ''}{d.released ? ', released by a voided invoice' : ''}
          {plan.canManage && can('ar.manage') && <> <button type="button" aria-label={`Invoice ${d.label} now`} disabled={make.busy} onClick={() => void make.run(d.start)}>Invoice now</button></>}</li>))}</ul>
      <ErrorNote message={make.error} />
    </section>
  );
}

function Actions({ plan, reload }: { plan: any; reload: () => Promise<void> }) {
  const [pauseWhy, setPauseWhy] = useState(''); const [amtFrom, setAmtFrom] = useState(''); const [amount, setAmount] = useState(''); const [amtWhy, setAmtWhy] = useState('');
  const [months, setMonths] = useState(''); const [notice, setNotice] = useState(String(plan.noticeDays)); const [auto, setAuto] = useState<boolean>(plan.autoRenew);
  const [cancelOn, setCancelOn] = useState(''); const [cancelWhy, setCancelWhy] = useState('');
  const act = useAction(async (path: string, body: object) => { await api.post(`/api/retainer-plans/${plan.id}/${path}`, body); await reload(); });
  const save = useAction(async () => { await api.patch(`/api/retainer-plans/${plan.id}`, { noticeDays: Number(notice), autoRenew: auto }); await reload(); });
  return (
    <section className="card stack">
      <h2>Change this plan</h2>
      <div className="row">
        {plan.status === 'active' && <>
          <input aria-label="Reason for pausing" placeholder="Reason for pausing" value={pauseWhy} onChange={(e) => setPauseWhy(e.target.value)} style={{ maxWidth: 240 }} />
          <button disabled={act.busy} onClick={() => void act.run('pause', { reason: pauseWhy || null })}>Pause from today</button></>}
        {plan.status === 'paused' && <button disabled={act.busy} onClick={() => void act.run('resume', {})}>Resume today</button>}
      </div>
      <div className="row">
        <label className="field">New amount<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field">From (first day of a period)<input type="date" value={amtFrom} onChange={(e) => setAmtFrom(e.target.value)} /></label>
        <label className="field">Reason (optional)<input value={amtWhy} onChange={(e) => setAmtWhy(e.target.value)} /></label>
        <button disabled={act.busy || !amount || !amtFrom} onClick={() => void act.run('amount', { effectiveFrom: amtFrom, amount: Number(amount), reason: amtWhy || null })}>Change the amount</button>
      </div>
      {plan.endDate && <div className="row">
        <label className="field">Renew for (months)<input type="number" min="1" max="60" value={months} placeholder={String(plan.renewalTermMonths)} onChange={(e) => setMonths(e.target.value)} /></label>
        <button disabled={act.busy} onClick={() => void act.run('renew', months ? { months: Number(months) } : {})}>Renew the term</button>
      </div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label="Notice and renewal">
        <label className="field">Notice days before the end<input type="number" min="0" max="365" value={notice} onChange={(e) => setNotice(e.target.value)} /></label>
        {plan.endDate && <label className="row"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Renews by itself</label>}
        <button disabled={save.busy}>Save</button>
      </form>
      <div className="row">
        <label className="field">Cancel from (last day covered)<input type="date" value={cancelOn} onChange={(e) => setCancelOn(e.target.value)} /></label>
        <label className="field" style={{ flex: '1 1 240px' }}>Reason<input value={cancelWhy} onChange={(e) => setCancelWhy(e.target.value)} placeholder="Why the plan is ending" /></label>
        <button disabled={act.busy || !cancelOn || cancelWhy.trim().length < 3} onClick={() => void act.run('cancel', { effectiveOn: cancelOn, reason: cancelWhy })}>Cancel the plan</button>
      </div>
      <ErrorNote message={act.error || save.error} />
    </section>
  );
}
