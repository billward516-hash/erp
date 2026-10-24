import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const TABS = [['unbilled', 'Unbilled work'], ['runs', 'Billing runs'], ['rates', 'Rates'], ['fixed', 'Fixed price'], ['settings', 'Settings']] as const;
const monthStart = (back = 0) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 10); };
const monthEnd = (back = 0) => { const d = new Date(`${monthStart(back)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const RUN_STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  open: { label: 'Open', tone: 'info' }, invoiced: { label: 'Invoiced', tone: 'good' }, closed: { label: 'Written off', tone: 'watch' }, cancelled: { label: 'Cancelled', tone: 'neutral' } };

/** Rates, billing runs and fixed-price billing for service companies (SC-009). */
export function Billing() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'unbilled';
  const { can } = useAuth();
  return (
    <>
      <PageHead eyebrow="Service companies" title="Billing runs" sub="Turn approved time, billable expenses, reached milestones and retainer charges into a draft invoice. Nothing is billed twice, and a voided invoice gives its work back." />
      <div className="row" role="tablist" aria-label="Billing">
        {TABS.filter(([k]) => k !== 'settings' || can('billing.view')).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>
        ))}
      </div>
      {tab === 'unbilled' && <Unbilled />}
      {tab === 'runs' && <Runs />}
      {tab === 'rates' && <RateCards />}
      {tab === 'fixed' && <FixedPrice />}
      {tab === 'settings' && <BillingSettings />}
    </>
  );
}

// ---- Unbilled work ------------------------------------------------------------------------------------------------------------------

function Unbilled() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any>('/api/billing-wip');
  return (
    <Async loading={loading && !data} error={error}>{() => (
      <>
        <Kpis items={[{ label: 'Unbilled work', value: fmtMoney(data.totals.total), tone: data.totals.total ? 'watch' : 'good' }, { label: 'Unbilled hours', value: fmtNum(data.totals.hours) },
          { label: 'On hold', value: fmtMoney(data.totals.held) }, { label: 'Entries with no rate', value: data.totals.blockedItems, tone: data.totals.blockedItems ? 'bad' : 'good' }]} />
        <section className="card stack">
          <h2>Approved work not yet invoiced, by project</h2>
          <Table rows={data.rows} rowKey={(r: any) => r.projectId} empty="No approved billable work is waiting. Time counts once its timesheet is approved and the hours are marked billable."
            columns={[{ key: 'number', label: 'Project', render: (r: any) => <span>{r.number} <span className="muted">{r.name}</span></span>, value: (r: any) => `${r.number} ${r.name}` }, { key: 'customerName', label: 'Customer' },
              { key: 'timeHours', label: 'Hours', numeric: true, render: (r: any) => fmtNum(r.timeHours, 2) }, { key: 'timeValue', label: 'Time', numeric: true, render: (r: any) => fmtMoney(r.timeValue) },
              { key: 'expenseValue', label: 'Expenses', numeric: true, render: (r: any) => fmtMoney(r.expenseValue) }, { key: 'milestoneValue', label: 'Milestones', numeric: true, render: (r: any) => fmtMoney(r.milestoneValue) },
              { key: 'percentValue', label: 'Percent complete', numeric: true, render: (r: any) => fmtMoney(r.percentValue) }, { key: 'total', label: 'Unbilled', numeric: true, render: (r: any) => <strong>{fmtMoney(r.total)}</strong> },
              { key: 'oldest', label: 'Oldest', render: (r: any) => fmtDate(r.oldest) },
              { key: 'contract', label: 'Billed of contract', numeric: true, render: (r: any) => (r.contractValue ? `${fmtMoney(r.billedToDate)} of ${fmtMoney(r.contractValue)}` : '—'), value: (r: any) => r.billedToDate },
              ...(can('billing.manage') ? [{ key: 'act', label: '', plain: true, render: (r: any) => (r.customerId && r.total ? <button type="button" aria-label={`Start a billing run for ${r.number}`} onClick={() => nav(`/billing?tab=runs&customer=${r.customerId}&project=${r.projectId}`)}>Bill</button> : null) }] : [])]} />
          {data.rows.some((r: any) => r.heldValue || r.blockedItems) && <p className="muted" style={{ margin: 0 }}>Held: {data.rows.filter((r: any) => r.heldValue).map((r: any) => `${r.number} ${fmtMoney(r.heldValue)}`).join(', ') || 'none'}. No rate: {data.rows.filter((r: any) => r.blockedItems).map((r: any) => `${r.number} ${fmtNum(r.blockedHours, 2)} h`).join(', ') || 'none'}. Neither is in the total.</p>}
          {data.excluded.map((e: any) => <p key={e.reason} className="muted" style={{ margin: 0 }}>{e.reason}: {e.entries} billable {e.entries === 1 ? 'entry' : 'entries'}, {fmtNum(e.hours, 2)} hours, not billed by the hour.</p>)}
          {!data.expenseColumns && <p className="muted" style={{ margin: 0 }}>Billable expenses are not counted yet: expense lines do not carry a project and a billable flag in this installation.</p>}
        </section>
      </>
    )}</Async>
  );
}

// ---- Runs ---------------------------------------------------------------------------------------------------------------------------

function Runs() {
  const nav = useNavigate();
  const { can } = useAuth();
  const runs = useApi<any[]>('/api/billing-runs');
  return (
    <>
      {can('billing.manage') && <NewRun />}
      <section className="card stack">
        <h2>Billing runs</h2>
        <Async loading={runs.loading && !runs.data} error={runs.error}>{() => (
          <Table rows={runs.data!} onRow={(r) => nav(`/billing/runs/${r.id}`)} empty="No billing runs yet. Start one above, or from a project on the Unbilled work tab."
            columns={[{ key: 'number', label: 'Run' }, { key: 'customer_name', label: 'Customer' }, { key: 'project_number', label: 'Project' }, { key: 'period', label: 'Period', render: (r: any) => `${fmtDate(r.period_from)} to ${fmtDate(r.period_to)}`, value: (r: any) => r.period_from },
              { key: 'status', label: 'Status', render: (r: any) => <Pill tone={RUN_STATUS[r.status]?.tone} label={RUN_STATUS[r.status]?.label ?? r.status} />, value: (r: any) => r.status },
              { key: 'invoice_number', label: 'Invoice', render: (r: any) => r.invoice_number ?? (r.status === 'invoiced' ? 'Draft' : '—') },
              { key: 'billed', label: 'Invoiced', numeric: true, render: (r: any) => (r.status === 'open' ? '—' : fmtMoney(r.billed)) },
              { key: 'writtendown', label: 'Written down', numeric: true, render: (r: any) => (r.writtendown ? fmtMoney(r.writtendown) : '—') }, { key: 'writtenoff', label: 'Written off', numeric: true, render: (r: any) => (r.writtenoff ? fmtMoney(r.writtenoff) : '—') }]} />
        )}</Async>
      </section>
    </>
  );
}

function NewRun() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const customers = useApi<any[]>('/api/customers');
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const [from, setFrom] = useState(monthStart(1));
  const [to, setTo] = useState(monthEnd(1));
  const [facilityId, setFacilityId] = useState('');
  const projects = useApi<any[]>(customerId ? `/api/billing-projects?customerId=${customerId}` : null);
  const sites = useApi<any[]>('/api/facilities');
  const start = useAction(async () => {
    const r = await api.post('/api/billing-runs', { customerId, projectId: projectId || null, facilityId: facilityId || null, periodFrom: from, periodTo: to });
    nav(`/billing/runs/${r.id}`);
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void start.run(); }} aria-label="New billing run">
      <h2>New billing run</h2>
      <div className="row">
        <label className="field">Customer<select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setProjectId(''); }} required>
          <option value="">Choose a customer</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field">Project (optional)<select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!customerId}>
          <option value="">All of the customer’s projects</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></label>
        <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
        <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>
        {(sites.data?.length ?? 0) > 1 && !projectId && <label className="field">Site (only if the customer has projects at several)<select value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
          <option value="">Choose for me</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></label>}
      </div>
      <ErrorNote message={start.error} />
      <div><button className="primary" disabled={start.busy || !customerId || !from || !to}>Prepare the run</button></div>
    </form>
  );
}

const LINE_STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  billable: { label: 'Will be billed', tone: 'good' }, held: { label: 'On hold', tone: 'watch' }, blocked: { label: 'No rate', tone: 'bad' }, written_off: { label: 'Written off', tone: 'neutral' } };
const KIND: Record<string, string> = { time: 'Time', expense: 'Expense', milestone: 'Milestone', percent: 'Percent complete', retainer: 'Retainer' };

/** One billing run: its draft invoice grouped by project and task, with edits, holds, write-downs, and the button that creates the draft in receivables. */
export function BillingRun() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: r, loading, error, reload } = useApi<any>(`/api/billing-runs/${id}`);
  const [reason, setReason] = useState('');
  const create = useAction(async () => { const x = await api.post(`/api/billing-runs/${id}/invoice`); await reload(); if (x.invoiceId) nav(`/receivables/${x.invoiceId}`); });
  const cancel = useAction(async () => { await api.post(`/api/billing-runs/${id}/cancel`, { reason }); await reload(); });
  return (
    <Async loading={loading && !r} error={error}>{() => {
      const t = r.totals;
      return (
        <>
          <PageHead eyebrow="Billing run" title={`${r.number}: ${r.customerName}`}
            sub={`${r.projectNumber ? `Project ${r.projectNumber}, ` : ''}${fmtDate(r.periodFrom)} to ${fmtDate(r.periodTo)}. Prepared by ${r.createdBy}.`}
            actions={<><Link to="/billing?tab=runs">All billing runs</Link><Pill tone={RUN_STATUS[r.status]?.tone} label={RUN_STATUS[r.status]?.label ?? r.status} /></>} />
          {r.status === 'invoiced' && <div className="notice ok">Draft invoice made: <Link to={`/receivables/${r.invoiceId}`}>{r.invoiceNumber ?? 'open the invoice'}</Link>. It was {fmtMoney(r.outcome.billed)} on {r.outcome.lines} lines{r.outcome.writtenDown ? `, ${fmtMoney(r.outcome.writtenDown)} written down` : ''}{r.outcome.writtenOff ? `, ${fmtMoney(r.outcome.writtenOff)} written off` : ''}. Voiding the invoice gives the work back and reopens this run.</div>}
          {r.status === 'closed' && <div className="notice warn">Everything in this run was written off: {fmtMoney(r.outcome.writtenOff)}. No invoice was made.</div>}
          {r.status === 'cancelled' && <div className="notice warn">Cancelled: {r.cancelReason}</div>}
          {r.outcome?.writtenOffItems?.length > 0 && <WrittenOff items={r.outcome.writtenOffItems} canReverse={r.canWriteOff} reload={reload} />}
          {t && (
            <Kpis items={[{ label: 'Lines to bill', value: t.lines }, { label: 'Hours', value: fmtNum(t.hours, 2) }, { label: 'Draft invoice total', value: fmtMoney(t.net), tone: t.net ? 'good' : undefined },
              { label: 'Written down', value: fmtMoney(t.writedown), tone: t.writedown ? 'watch' : undefined }, { label: 'Written off', value: fmtMoney(t.writtenOff), tone: t.writtenOff ? 'watch' : undefined },
              { label: 'On hold', value: fmtMoney(t.heldValue) }, { label: 'No rate', value: t.blockedCount, tone: t.blockedCount ? 'bad' : 'good' }]} />
          )}
          {r.status === 'open' && (
            <>
              {r.groups.length === 0 && <div className="empty">Nothing is waiting for this customer and period. Time counts once its timesheet is approved and the hours are marked billable; milestones once they are reached; retainer periods once they are due.</div>}
              {r.groups.map((g: any) => (
                <section key={g.projectId ?? 'none'} className="card stack" aria-label={g.projectNumber ?? 'Not on a project'}>
                  <div className="spread"><h2>{g.projectNumber ? `${g.projectNumber} ${g.projectName ?? ''}` : 'Not tied to a project'}</h2><strong>{fmtMoney(g.subtotal)}</strong></div>
                  {g.tasks.map((tk: any) => (
                    <div key={tk.taskId ?? 'none'} className="stack">
                      {(tk.taskName || g.tasks.length > 1) && <div className="spread"><h3>{tk.taskName ?? 'No task'}</h3><span className="muted">{fmtMoney(tk.subtotal)}</span></div>}
                      <div className="table-wrap"><table>
                        <thead><tr><th scope="col">What</th><th scope="col">Date</th><th scope="col" className="n">Hours</th><th scope="col" className="n">Rate</th><th scope="col" className="n">Amount</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Edit</span></th></tr></thead>
                        <tbody>{tk.lines.map((l: any) => <LineRows key={l.key} run={r} line={l} reload={reload} />)}</tbody>
                      </table></div>
                    </div>
                  ))}
                </section>
              ))}
              {r.excluded.map((e: any) => <p key={e.reason} className="muted">{e.reason}: {e.entries} billable {e.entries === 1 ? 'entry' : 'entries'}, {fmtNum(e.hours, 2)} hours, not billed by the hour.</p>)}
              {!r.expenseColumns && <p className="muted">Billable expenses are not counted: expense lines do not carry a project and a billable flag in this installation.</p>}
              <ErrorNote message={create.error || cancel.error} />
              <div className="row">
                {r.canInvoice
                  ? <button className="primary" disabled={create.busy || (!t.lines && !t.writtenOffCount)} onClick={() => void create.run()}>Create draft invoice</button>
                  : <span className="muted">Making the invoice needs billing and receivables authority at this site.</span>}
                {r.canManage && <>
                  <label className="field" style={{ minWidth: 220 }}><span className="sr-only">Reason for cancelling</span><input aria-label="Reason for cancelling the run" placeholder="Reason, to cancel this run" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                  <button disabled={cancel.busy || reason.trim().length < 3} onClick={() => void cancel.run()}>Cancel run</button></>}
              </div>
            </>
          )}
        </>
      );
    }}</Async>
  );
}

/** Work written off in a finished run; a person with the write-off permission can bring it back, and it then appears in the next run. */
function WrittenOff({ items, canReverse, reload }: { items: any[]; canReverse: boolean; reload: () => Promise<void> }) {
  const [why, setWhy] = useState('');
  const back = useAction(async (it: any) => { await api.post('/api/billing-holds/restore-writeoff', { kind: it.kind, sourceId: it.sourceId, reason: why }); setWhy(''); await reload(); });
  return (
    <section className="card stack">
      <h2>Written off in this run</h2>
      <Table rows={items} rowKey={(i: any) => i.sourceId} columns={[{ key: 'kind', label: 'What', render: (i: any) => KIND[i.kind] ?? i.kind }, { key: 'amount', label: 'Amount', numeric: true, render: (i: any) => fmtMoney(i.amount) }, { key: 'reason', label: 'Reason' },
        ...(canReverse ? [{ key: 'act', label: '', plain: true, render: (i: any) => <button type="button" aria-label={`Reverse the write-off of ${fmtMoney(i.amount)}`} disabled={back.busy || why.trim().length < 3} onClick={() => void back.run(i)}>Reverse</button> }] : [])]} />
      {canReverse && <label className="field" style={{ maxWidth: 420 }}>Reason to reverse a write-off<input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Needed to reverse" /></label>}
      <ErrorNote message={back.error} />
    </section>
  );
}

function LineRows({ run, line: l, reload }: { run: any; line: any; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState<string>(l.customDescription ?? '');
  const [down, setDown] = useState<string>(l.writedown ? String(l.writedown) : '');
  const [off, setOff] = useState<boolean>(l.writeOff);
  const [why, setWhy] = useState<string>(l.adjustReason ?? '');
  const [holdWhy, setHoldWhy] = useState('');
  const holdable = ['time', 'expense', 'milestone'].includes(l.kind);
  const save = useAction(async () => {
    const money = run.canWriteOff;
    await api.post(`/api/billing-runs/${run.id}/adjust`, { key: l.key, description: desc, ...(money ? { writedown: Number(down) || 0, writeOff: off, reason: why } : {}) });
    setOpen(false); await reload();
  });
  const clear = useAction(async () => { await api.post(`/api/billing-runs/${run.id}/adjust`, { key: l.key, clear: true }); setOpen(false); await reload(); });
  const hold = useAction(async () => { await api.post('/api/billing-holds', { kind: l.kind, sourceId: l.sourceId, reason: holdWhy }); setHoldWhy(''); await reload(); });
  const release = useAction(async () => { await api.post('/api/billing-holds/release', { kind: l.kind, sourceId: l.sourceId }); await reload(); });
  const label = `${KIND[l.kind] ?? l.kind}: ${l.description}`;
  return (
    <>
      <tr className={l.status === 'billable' ? '' : 'exception'}>
        <td>{l.description}{l.customDescription ? <span className="faint"> (edited)</span> : null}
          {l.rateWhy && <details><summary className="muted">Why this rate</summary><span className="muted">{l.rateWhy}</span></details>}
          {l.blocked && <div className="notice error">{l.blocked}</div>}
          {l.holdReason && <div className="muted">Held: {l.holdReason}</div>}
          {l.adjustReason && <div className="muted">{l.writeOff ? 'Written off' : 'Written down'}: {l.adjustReason}</div>}</td>
        <td>{fmtDate(l.date)}</td>
        <td className="n">{l.hours != null ? <>{fmtNum(l.hours, 2)}{l.recordedHours !== l.hours ? <span className="faint"> ({fmtNum(l.recordedHours, 2)} recorded)</span> : null}</> : '—'}</td>
        <td className="n">{l.kind === 'time' ? fmtMoney(l.unitPrice) : '—'}</td>
        <td className="n">{l.writedown ? <><s className="faint">{fmtMoney(l.listAmount)}</s> {fmtMoney(l.net)}</> : fmtMoney(l.status === 'written_off' ? l.listAmount : l.net)}</td>
        <td><Pill tone={LINE_STATUS[l.status]?.tone} label={LINE_STATUS[l.status]?.label ?? l.status} /></td>
        <td>{run.canManage && <button type="button" aria-expanded={open} aria-label={`${open ? 'Close' : 'Edit'} ${label}`} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Edit'}</button>}</td>
      </tr>
      {open && (
        <tr><td colSpan={7}>
          <div className="stack" role="group" aria-label={`Edit ${label}`}>
            {!l.held && <label className="field">Description on the invoice<input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={l.defaultDescription} /></label>}
            {!l.held && run.canWriteOff && (
              <div className="row">
                <label className="field">Write down by (amount)<input type="number" min="0" step="0.01" value={down} disabled={off} onChange={(e) => setDown(e.target.value)} /></label>
                <label className="row"><input type="checkbox" checked={off} onChange={(e) => setOff(e.target.checked)} /> Write the whole line off (no invoice line)</label>
                <label className="field" style={{ flex: '1 1 260px' }}>Reason (kept in the audit trail)<input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Needed to write down or off" /></label>
              </div>
            )}
            {!l.held && !run.canWriteOff && <p className="muted" style={{ margin: 0 }}>Writing work down or off needs a separate permission.</p>}
            <ErrorNote message={save.error || clear.error || hold.error || release.error} />
            <div className="row">
              {!l.held && <button className="primary" disabled={save.busy} onClick={() => void save.run()}>Save changes</button>}
              {!l.held && (l.customDescription || l.writedown > 0 || l.writeOff) && <button disabled={clear.busy} onClick={() => void clear.run()}>Undo my edits</button>}
              {holdable && !l.held && <><input aria-label="Reason to hold this entry" placeholder="Reason to hold it back" value={holdWhy} onChange={(e) => setHoldWhy(e.target.value)} style={{ maxWidth: 260 }} />
                <button disabled={hold.busy || holdWhy.trim().length < 3} onClick={() => void hold.run()}>Hold this entry</button></>}
              {l.held && <button disabled={release.busy} onClick={() => void release.run()}>Release the hold</button>}
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}

// ---- Rates ---------------------------------------------------------------------------------------------------------------------------

function RateCards() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>('/api/bill-rates');
  const settings = useApi<any>('/api/billing-settings');
  const canSet = can('billing.rates');
  const end = useAction(async (id: string, on: string) => { await api.post(`/api/bill-rates/${id}/end`, { endOn: on }); await reload(); });
  return (
    <>
      <section className="card stack">
        <h2>Which rate applies</h2>
        <p className="muted" style={{ margin: 0 }}>The most specific rate that covers the work date wins, in this order: {data?.order?.map((o: any, i: number) => `${i + 1}. ${o.label}`).join('; ') ?? '…'}. A project or customer rate may name one person or role, and then beats the same card for everybody. Time with no rate is not billed until one exists, and the billing run says so.</p>
        {settings.data && <p className="muted" style={{ margin: 0 }}>Hours are {settings.data.roundHoursTo ? `rounded to the nearest ${settings.data.roundHoursTo} hour (half up, at least one step per entry)` : 'billed as recorded'}. Change this under Settings.</p>}
        <Why />
      </section>
      <section className="card stack">
        <h2>Rate cards</h2>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data.rates} rowKey={(r: any) => r.id} empty="No rates yet. Add a company default rate first, then more specific ones."
            columns={[{ key: 'scope', label: 'Applies to', render: (r: any) => humanize(r.scope) },
              { key: 'who', label: 'For', render: (r: any) => [r.projectLabel, r.customerLabel, r.employeeLabel, r.roleLabel].filter(Boolean).join(' · ') || 'Everybody' }, { key: 'amount', label: 'Rate per hour', numeric: true, render: (r: any) => fmtMoney(r.amount) },
              { key: 'effectiveFrom', label: 'From', render: (r: any) => fmtDate(r.effectiveFrom) }, { key: 'effectiveTo', label: 'To', render: (r: any) => (r.effectiveTo ? fmtDate(r.effectiveTo) : 'Open') }, { key: 'note', label: 'Note' },
              ...(canSet ? [{ key: 'act', label: '', plain: true, render: (r: any) => (!r.effectiveTo ? <button type="button" aria-label={`End the ${humanize(r.scope)} rate of ${fmtMoney(r.amount)} from ${fmtDate(r.effectiveFrom)}`} disabled={end.busy}
                onClick={() => { const d = window.prompt('Last day this rate applies (YYYY-MM-DD)', new Date().toISOString().slice(0, 10)); if (d) void end.run(r.id, d); }}>End</button> : null) }] : [])]} />
        )}</Async>
        <ErrorNote message={end.error} />
      </section>
      {canSet ? <NewRate onDone={reload} /> : <p className="muted">Setting rates needs the rates permission, which is kept apart from preparing billing runs.</p>}
    </>
  );
}

function Why() {
  const projects = useApi<any[]>('/api/billing-projects');
  const people = useApi<any[]>('/api/bill-rates/people');
  const [projectId, setProjectId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [answer, setAnswer] = useState<any>(null);
  const check = useAction(async () => setAnswer(await api.get(`/api/bill-rates/explain?projectId=${projectId}&employeeId=${employeeId}&date=${date}`)));
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void check.run(); }} aria-label="Check a rate">
      <label className="field">Project<select value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">Choose</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></label>
      <label className="field">Person<select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required><option value="">Choose</option>{(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">On<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
      <button disabled={check.busy || !projectId || !employeeId}>Why this rate?</button>
      {answer && <span role="status"><strong>{answer.rate != null ? `${fmtMoney(answer.rate)} an hour` : 'No rate'}</strong> <span className="muted">{answer.why}</span></span>}
      <ErrorNote message={check.error} />
    </form>
  );
}

function NewRate({ onDone }: { onDone: () => Promise<void> }) {
  const [scope, setScope] = useState('default');
  const [projectId, setProjectId] = useState(''); const [customerId, setCustomerId] = useState(''); const [employeeId, setEmployeeId] = useState(''); const [role, setRole] = useState('');
  const [amount, setAmount] = useState(''); const [from, setFrom] = useState(new Date().toISOString().slice(0, 10)); const [note, setNote] = useState('');
  const customers = useApi<any[]>('/api/customers'); const projects = useApi<any[]>('/api/billing-projects'); const people = useApi<any[]>('/api/bill-rates/people');
  const save = useAction(async () => {
    await api.post('/api/bill-rates', { scope, projectId: scope === 'project' ? projectId : null, customerId: scope === 'customer' ? customerId : null, employeeId: employeeId || null, role: role.trim() || null, amount: Number(amount), effectiveFrom: from, note: note || null });
    setAmount(''); setNote(''); await onDone();
  });
  const narrow = scope === 'project' || scope === 'customer';
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label="Add a rate">
      <h2>Add a rate</h2>
      <p className="muted" style={{ margin: 0 }}>A new rate for the same target ends the one that is open the day before it starts.</p>
      <div className="row">
        <label className="field">Applies to<select value={scope} onChange={(e) => { setScope(e.target.value); setEmployeeId(''); setRole(''); }}>
          <option value="default">Company default (everybody)</option><option value="role">A role (job title)</option><option value="person">One person</option><option value="customer">A customer</option><option value="project">A project</option></select></label>
        {scope === 'project' && <label className="field">Project<select value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">Choose</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></label>}
        {scope === 'customer' && <label className="field">Customer<select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required><option value="">Choose</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        {(scope === 'person' || narrow) && <label className="field">{narrow ? 'Only for this person (optional)' : 'Person'}<select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); if (e.target.value) setRole(''); }} required={scope === 'person'}>
          <option value="">{narrow ? 'Everybody' : 'Choose'}</option>{(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        {(scope === 'role' || narrow) && <label className="field">{narrow ? 'Or only for this role (optional)' : 'Role (job title)'}<input value={role} disabled={!!employeeId} onChange={(e) => setRole(e.target.value)} required={scope === 'role'} placeholder="e.g. Senior consultant" /></label>}
        <label className="field">Rate per hour<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
        <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
        <label className="field" style={{ flex: '1 1 220px' }}>Note<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <ErrorNote message={save.error} />
      <div><button className="primary" disabled={save.busy || !amount}>Add the rate</button></div>
    </form>
  );
}

// ---- Fixed price -----------------------------------------------------------------------------------------------------------------------

function FixedPrice() {
  const [projectId, setProjectId] = useState('');
  const projects = useApi<any[]>('/api/billing-projects');
  const fixed = (projects.data ?? []).filter((p) => p.customer_id);
  return (
    <section className="card stack">
      <h2>Fixed-price projects</h2>
      <p className="muted" style={{ margin: 0 }}>Set a contract value and bill it by milestone or by percent complete. Billing runs then bill each reached milestone, or the earned share of the contract less what was billed before, once.</p>
      <label className="field" style={{ maxWidth: 420 }}>Project<select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">Choose a project</option>
        {fixed.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name} ({humanize(p.billing_type)})</option>)}</select></label>
      {projectId && <Contract key={projectId} projectId={projectId} />}
    </section>
  );
}

function Contract({ projectId }: { projectId: string }) {
  const { can } = useAuth();
  const { data: c, loading, error, reload } = useApi<any>(`/api/billing-contracts/${projectId}`);
  const [value, setValue] = useState(''); const [method, setMethod] = useState('milestone'); const [pct, setPct] = useState('');
  const [mName, setMName] = useState(''); const [mAmount, setMAmount] = useState(''); const [mDue, setMDue] = useState('');
  const manage = can('billing.manage');
  const save = useAction(async () => { await api.put(`/api/billing-contracts/${projectId}`, { contractValue: Number(value || c.contractValue), method: c.method ?? method, ...(((c.method ?? method) === 'percent_complete') ? { percentComplete: Number(pct === '' ? c.percentComplete : pct) } : {}) }); setValue(''); setPct(''); await reload(); });
  const add = useAction(async () => { await api.post(`/api/billing-contracts/${projectId}/milestones`, { name: mName, amount: Number(mAmount), dueDate: mDue || null }); setMName(''); setMAmount(''); setMDue(''); await reload(); });
  const reach = useAction(async (id: string) => { await api.post(`/api/billing-milestones/${id}/reach`, { reachedOn: new Date().toISOString().slice(0, 10) }); await reload(); });
  return (
    <Async loading={loading && !c} error={error}>{() => (
      <div className="stack">
        {c.contractValue != null ? (
          <Kpis items={[{ label: 'Contract value', value: fmtMoney(c.contractValue) }, { label: c.method === 'percent_complete' ? `Earned (${c.percentComplete}% complete)` : 'Earned (milestones reached)', value: fmtMoney(c.earned) },
            { label: 'Billed to date', value: fmtMoney(c.billed) }, { label: 'Written off', value: fmtMoney(c.writtenOff) }, { label: 'Earned, not yet billed', value: fmtMoney(c.unbilledEarned), tone: c.unbilledEarned ? 'watch' : 'good' }]} />
        ) : <p className="muted">No fixed-price terms yet.</p>}
        {manage && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label="Fixed-price terms">
            <label className="field">Contract value<input type="number" min="0" step="0.01" value={value} placeholder={c.contractValue != null ? String(c.contractValue) : ''} onChange={(e) => setValue(e.target.value)} required={c.contractValue == null} /></label>
            {c.method == null ? <label className="field">Billed by<select value={method} onChange={(e) => setMethod(e.target.value)}><option value="milestone">Milestones</option><option value="percent_complete">Percent complete</option></select></label>
              : <span className="muted">Billed by {c.method === 'milestone' ? 'milestones' : 'percent complete'}</span>}
            {(c.method ?? method) === 'percent_complete' && <label className="field">Percent complete now<input type="number" min="0" max="100" step="0.5" value={pct} placeholder={String(c.percentComplete)} onChange={(e) => setPct(e.target.value)} /></label>}
            <button className="primary" disabled={save.busy}>{c.contractValue == null ? 'Set terms' : 'Update terms'}</button>
          </form>
        )}
        <ErrorNote message={save.error || add.error || reach.error} />
        {c.method === 'milestone' && (
          <>
            <Table rows={c.milestones} rowKey={(m: any) => m.id} empty="No milestones yet."
              columns={[{ key: 'name', label: 'Milestone' }, { key: 'amount', label: 'Amount', numeric: true, render: (m: any) => fmtMoney(m.amount) }, { key: 'dueDate', label: 'Due', render: (m: any) => fmtDate(m.dueDate) },
                { key: 'status', label: 'State', render: (m: any) => <Pill tone={m.billed ? 'good' : m.status === 'reached' ? 'watch' : 'neutral'} label={m.billed ? 'Billed' : m.status === 'reached' ? `Reached ${fmtDate(m.reachedOn)}${m.held ? ', on hold' : ''}` : 'Not reached'} />, value: (m: any) => m.status },
                ...(manage ? [{ key: 'act', label: '', plain: true, render: (m: any) => (m.status === 'pending' ? <button type="button" aria-label={`Mark ${m.name} reached today`} disabled={reach.busy} onClick={() => void reach.run(m.id)}>Mark reached today</button> : null) }] : [])]} />
            {manage && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }} aria-label="Add a milestone">
                <label className="field">Milestone<input value={mName} onChange={(e) => setMName(e.target.value)} required /></label>
                <label className="field">Amount<input type="number" min="0.01" step="0.01" value={mAmount} onChange={(e) => setMAmount(e.target.value)} required /></label>
                <label className="field">Due (optional)<input type="date" value={mDue} onChange={(e) => setMDue(e.target.value)} /></label>
                <button disabled={add.busy}>Add milestone</button>
              </form>
            )}
          </>
        )}
      </div>
    )}</Async>
  );
}

// ---- Settings ------------------------------------------------------------------------------------------------------------------------

function BillingSettings() {
  const { data, loading, error, reload } = useApi<any>('/api/billing-settings');
  const save = useAction(async (patch: object) => { await api.put('/api/billing-settings', patch); await reload(); });
  return (
    <section className="card stack">
      <h2>Company billing settings</h2>
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <label className="row"><input type="checkbox" checked={data.roundHoursTo === 0.25} disabled={!data.canEdit || save.busy} onChange={(e) => void save.run({ roundHoursTo: e.target.checked ? 0.25 : null })} />
            Round each entry’s hours to the nearest quarter hour when billing (half up, never less than a quarter hour). Off by default.</label>
          <label className="field" style={{ maxWidth: 420 }}>Scheduled retainer invoices are
            <select value={data.retainerIssueMode} disabled={!data.canEdit || save.busy} onChange={(e) => void save.run({ retainerIssueMode: e.target.value })}>
              <option value="draft">Made as drafts for someone to review and issue</option><option value="issue">Issued automatically (number, PDF and accounting entry)</option></select></label>
          {!data.canEdit && <p className="muted" style={{ margin: 0 }}>Changing these needs the company-wide rates permission.</p>}
          <ErrorNote message={save.error} />
        </>
      )}</Async>
    </section>
  );
}
