import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtMoney, fmtPct, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS_TONE: Record<string, 'good' | 'watch' | 'bad' | 'neutral' | 'info'> = { occupied: 'good', notice: 'watch', vacant: 'bad', offline: 'neutral' };
const todayIso = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => todayIso().slice(0, 7);
const nextMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7); };

export function Leasing() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'roll' | 'turns' | 'billing'>('roll');
  const sites = useApi<any[]>('/api/sites?kind=property');
  const [facilityId, setFacilityId] = useState('');
  return (
    <>
      <PageHead eyebrow="Property" title="Leasing" sub="Who rents what, at what rent, what they owe, and how fast empty units are made ready again." />
      <div className="row">
        <div className="row" role="tablist" aria-label="Leasing views">
        {([['roll', 'Rent roll'], ['turns', 'Unit turns'], ...(can('leasing.manage') ? [['billing', 'Rent billing']] as const : [])] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <select id="lease-site" aria-label="Property" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All my properties</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
        </select>
      </div>
      {tab === 'roll' && <RentRoll facilityId={facilityId} />}
      {tab === 'turns' && <Turns facilityId={facilityId} />}
      {tab === 'billing' && can('leasing.manage') && <Billing facilityId={facilityId} />}
    </>
  );
}

function RentRoll({ facilityId }: { facilityId: string }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>(`/api/rent-roll${facilityId ? `?facilityId=${facilityId}` : ''}`);
  const [newLease, setNewLease] = useState<any>(null);
  return (
    <Async loading={loading && !data} error={error}>{() => {
      const rows = data ?? [];
      const rentable = rows.filter((r) => r.status !== 'offline');
      const occ = rentable.filter((r) => r.status === 'occupied' || r.status === 'notice');
      return (
        <>
          <Kpis items={[{ label: 'Occupancy', value: fmtPct(rentable.length ? occ.length / rentable.length : null), note: `${occ.length} of ${rentable.length} units` },
            { label: 'Rent + charges a month', value: fmtMoney(occ.reduce((s, r) => s + (r.rent ?? 0) + (r.charges ?? 0), 0)) },
            { label: 'Vacant at market rent', value: fmtMoney(rentable.filter((r) => r.status === 'vacant').reduce((s, r) => s + (r.marketRent ?? 0), 0)), tone: rows.some((r) => r.status === 'vacant') ? 'watch' : undefined },
            { label: 'Past due', value: fmtMoney(rows.reduce((s, r) => s + r.pastDue, 0)), tone: rows.some((r) => r.pastDue > 0) ? 'bad' : 'good' }]} />
          <div className="card">
            <Table rows={rows} rowKey={(r) => r.unitId} empty="No rental units. Import a unit directory, then rental units and leases (Data import)." exception={(r) => r.pastDue > 0}
              onRow={(r) => r.leaseId && nav(`/leasing/leases/${r.leaseId}`)}
              columns={[{ key: 'facility', label: 'Property' }, { key: 'unit', label: 'Unit', render: (r) => <><strong>{r.unitName}</strong><div className="faint">{r.unit}{r.building ? ` · ${r.building}` : ''}</div></> },
                { key: 'size', label: 'Size', render: (r) => [r.bedrooms != null ? `${r.bedrooms} bd` : null, r.bathrooms != null ? `${r.bathrooms} ba` : null, r.areaSqft ? `${r.areaSqft} sf` : null].filter(Boolean).join(' · ') || humanize(r.unitType) },
                { key: 'status', label: 'Status', render: (r) => <><Pill tone={STATUS_TONE[r.status]} label={r.status === 'notice' ? `notice · out ${fmtDate(r.moveOutOn)}` : r.status} />
                  {r.status === 'vacant' && r.daysVacant != null && <div className="faint">{r.daysVacant} days</div>}{r.turnId && <div className="faint">make-ready to {fmtDate(r.turnTarget)}</div>}</> },
                { key: 'renter', label: 'Renter', render: (r) => r.renter ?? (r.nextLease ? <span className="faint">next: {r.nextLease}</span> : '—') },
                { key: 'lease', label: 'Lease', render: (r) => (r.leaseStart ? <>{fmtDate(r.leaseStart)} → {r.monthToMonth ? 'month to month' : fmtDate(r.leaseEnd)}</> : '—') },
                { key: 'rent', label: 'Rent', numeric: true, render: (r) => (r.rent != null ? <>{fmtMoney(r.rent)}{r.charges ? <div className="faint">+ {fmtMoney(r.charges)}</div> : null}</> : <span className="faint">{fmtMoney(r.marketRent)} market</span>) },
                { key: 'balance', label: 'Balance', numeric: true, render: (r) => <>{fmtMoney(r.balance)}{r.pastDue > 0 && <div className="bad-text">{fmtMoney(r.pastDue)} past due</div>}</> },
                { key: 'act', label: '', render: (r) => (r.status === 'vacant' && !r.nextLeaseId && can('leasing.manage', r.facilityId)
                  ? <button onClick={(e) => { e.stopPropagation(); setNewLease(r); }}>New lease</button> : null) }]} />
          </div>
          {newLease && <NewLease key={newLease.id} unit={newLease} onDone={(id) => { setNewLease(null); if (id) nav(`/leasing/leases/${id}`); else void reload(); }} />}
        </>
      );
    }}</Async>
  );
}

function NewLease({ unit, onDone }: { unit: any; onDone: (id?: string) => void }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', start: todayIso(), end: '', rent: String(unit.marketRent ?? ''), deposit: String(unit.marketRent ?? ''), charge: '', chargeAmount: '' });
  const save = useAction(async () => {
    const l = await api.post('/api/leases', { unitId: unit.unitId, startDate: f.start, endDate: f.end || null, rentAmount: Number(f.rent), depositAmount: f.deposit ? Number(f.deposit) : 0,
      renter: { name: f.name, email: f.email || null, phone: f.phone || null }, charges: f.charge && f.chargeAmount ? [{ description: f.charge, amount: Number(f.chargeAmount) }] : [] });
    onDone(l.id);
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <h2>New lease: {unit.unitName} ({unit.unit})</h2>
      <div className="row">
        <input id="lease-name" aria-label="Renter name" placeholder="Renter name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required style={{ flex: '1 1 200px' }} />
        <input id="lease-email" aria-label="Renter email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ flex: '1 1 180px' }} />
        <input aria-label="Renter phone" placeholder="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} style={{ width: 150 }} />
      </div>
      <div className="row">
        <label className="row">From <input id="lease-start" type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required /></label>
        <label className="row">To <input id="lease-end" type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
        <input id="lease-rent" type="number" min="0" step="0.01" aria-label="Monthly rent" placeholder="Rent" value={f.rent} onChange={(e) => setF({ ...f, rent: e.target.value })} required style={{ width: 120 }} />
        <input type="number" min="0" step="0.01" aria-label="Deposit" placeholder="Deposit" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} style={{ width: 120 }} />
        <input aria-label="Other monthly charge" placeholder="Other charge (parking…)" value={f.charge} onChange={(e) => setF({ ...f, charge: e.target.value })} style={{ width: 180 }} />
        <input type="number" min="0" step="0.01" aria-label="Charge amount" placeholder="Amount" value={f.chargeAmount} onChange={(e) => setF({ ...f, chargeAmount: e.target.value })} style={{ width: 100 }} />
      </div>
      <div className="row"><button className="primary" disabled={save.busy}>Create draft lease</button><button type="button" onClick={() => onDone()}>Cancel</button><ErrorNote message={save.error} />
        <span className="faint">Leave "To" empty for month to month. The lease takes the unit once you mark it signed.</span></div>
    </form>
  );
}

function Turns({ facilityId }: { facilityId: string }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(true);
  const { data, loading, error, reload } = useApi<any[]>(`/api/unit-turns?open=${open}${facilityId ? `&facilityId=${facilityId}` : ''}`);
  const [job, setJob] = useState<{ turnId: string; title: string } | null>(null);
  const add = useAction(async () => { await api.post(`/api/unit-turns/${job!.turnId}/work`, { title: job!.title }); setJob(null); await reload(); });
  const ready = useAction(async (id: string) => { await api.post(`/api/unit-turns/${id}/ready`, {}); await reload(); });
  return (
    <div className="card stack">
      <label className="row"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Open turns only</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(t) => t.id} empty="No unit turns." exception={(t) => t.late}
          columns={[{ key: 'facility_code', label: 'Property' }, { key: 'unit', label: 'Unit', render: (t) => <Link to={`/assets/${t.asset_id}`}>{t.unit_name} <span className="faint">{t.asset_tag}</span></Link> },
            { key: 'move_out_on', label: 'Moved out', render: (t) => fmtDate(t.move_out_on) }, { key: 'target_ready_on', label: 'Target ready', render: (t) => <>{fmtDate(t.target_ready_on)}{t.late && <> <Pill tone="bad" label="late" /></>}</> },
            { key: 'days', label: 'Days', numeric: true }, { key: 'jobs', label: 'Jobs', numeric: true, render: (t) => `${t.jobs - t.open_jobs} / ${t.jobs} done` },
            { key: 'lostRent', label: 'Rent lost so far', numeric: true, render: (t) => fmtMoney(t.lostRent) }, { key: 'next_lease', label: 'Next lease', render: (t) => t.next_lease ?? '—' },
            { key: 'status', label: '', render: (t) => (t.status === 'open' && can('leasing.manage', t.facility_id) ? <span className="row">
              <button className="link" onClick={() => setJob({ turnId: t.id, title: '' })}>+ job</button>
              <button className="link" disabled={ready.busy || t.open_jobs > 0} onClick={() => ready.run(t.id)}>Mark ready</button></span> : <Pill value={t.status} label={t.status === 'ready' ? `ready ${fmtDate(t.ready_on)}` : t.status} />) }]} />
      )}</Async>
      <ErrorNote message={ready.error} />
      {job && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <input id="turn-job" aria-label="Make-ready job" placeholder="Make-ready job (paint, clean, carpet, replace blinds)" value={job.title} onChange={(e) => setJob({ ...job, title: e.target.value })} required style={{ flex: '1 1 300px' }} />
          <button className="primary" disabled={add.busy}>Add work order</button><button type="button" onClick={() => setJob(null)}>Cancel</button><ErrorNote message={add.error} />
        </form>
      )}
      <p className="faint">A turn opens when a move-out is recorded; each job is a work order on the unit (send it to a contractor from the work order). Rent lost uses market rent per day.</p>
    </div>
  );
}

function Billing({ facilityId }: { facilityId: string }) {
  const [period, setPeriod] = useState(new Date().getUTCDate() > 20 ? nextMonth() : thisMonth());
  const { data, loading, error, reload } = useApi<any>(`/api/rent-billing/preview?period=${period}${facilityId ? `&facilityId=${facilityId}` : ''}`);
  const [result, setResult] = useState<any>(null);
  const run = useAction(async (issue: boolean) => { setResult(await api.post('/api/rent-billing', { period, facilityId: facilityId || undefined, issue })); await reload(); });
  return (
    <div className="card stack">
      <div className="row">
        <label className="row">Month <input id="bill-period" type="month" value={period} onChange={(e) => { setPeriod(e.target.value); setResult(null); }} /></label>
        <button className="primary" disabled={run.busy || !data?.leases?.length} onClick={() => run.run(true)}>Issue {data?.leases?.length ?? 0} rent invoices</button>
        <button disabled={run.busy || !data?.leases?.length} onClick={() => run.run(false)}>Create as drafts</button>
        <ErrorNote message={run.error} />
      </div>
      {result && <div className="notice">{result.created.length} invoice{result.created.length === 1 ? '' : 's'} for {result.period}, {fmtMoney(result.total)} in total{result.created[0]?.number ? ` (${result.created[0].number}…)` : ' (drafts in Receivables)'}.</div>}
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data.leases} rowKey={(b) => b.leaseId} empty={`Nothing left to bill for ${period}: every lease in force has its invoice.`}
          columns={[{ key: 'facility', label: 'Property' }, { key: 'unit', label: 'Unit' }, { key: 'lease', label: 'Lease' }, { key: 'renter', label: 'Renter' },
            { key: 'lines', label: 'Lines', render: (b) => b.lines.map((l: any, i: number) => <div key={i}>{l.description} <span className="faint">{fmtMoney(l.amount)}</span></div>) },
            { key: 'total', label: 'Total', numeric: true, render: (b) => <>{fmtMoney(b.total)}{b.prorated && <div className="faint">prorated</div>}</> }]} />
      )}</Async>
      <p className="faint">Rent invoices are dated the 1st and due on receipt; late means unpaid after the lease's grace days. Running the same month again only bills leases not yet billed. Invoices, payments and reminders are in Receivables.</p>
    </div>
  );
}

export function LeaseDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: l, loading, error, reload } = useApi<any>(`/api/leases/${id}`);
  const [form, setForm] = useState<null | { kind: 'notice' | 'moveout' | 'renew'; a: string; b: string; c: string }>(null);
  const act = useAction(async (path: string, body: any = {}) => { const r = await api.post(`/api/leases/${id}/${path}`, body); setForm(null); if (path === 'renew') nav(`/leasing/leases/${r.id}`); else await reload(); });
  return (
    <Async loading={loading && !l} error={error}>{() => (
      <>
        <PageHead eyebrow={`${l.facility_code} · Lease ${l.number}${l.source === 'import' ? ' · imported' : ''}`} title={<>{l.renter_name} <span className="muted" style={{ fontWeight: 400 }}>· {l.unit_name}</span></>}
          sub={<>{fmtDate(l.start_date)} → {l.end_date ? fmtDate(l.end_date) : 'month to month'}{l.renewed_from_number ? ` · renews ${l.renewed_from_number}` : ''}{l.renter_email ? ` · ${l.renter_email}` : ''}{l.renter_phone ? ` · ${l.renter_phone}` : ''}</>}
          actions={<Pill tone={l.status === 'active' ? 'good' : l.status === 'notice' ? 'watch' : l.status === 'draft' ? 'info' : 'neutral'} label={l.status === 'notice' ? `notice · out ${fmtDate(l.move_out_on)}` : l.status} />} />
        <Kpis items={[{ label: 'Rent', value: fmtMoney(l.rent_amount), note: l.market_rent ? `market ${fmtMoney(Number(l.market_rent))}` : undefined },
          { label: 'Other charges', value: fmtMoney(l.charges.reduce((s: number, c: any) => s + c.amount, 0)) },
          { label: 'Deposit', value: fmtMoney(l.deposit_amount), note: l.deposit_received_on ? `received ${fmtDate(l.deposit_received_on)}` : 'not received' },
          { label: 'Balance', value: fmtMoney(l.balance), tone: l.pastDue > 0 ? 'bad' : undefined, note: l.pastDue > 0 ? `${fmtMoney(l.pastDue)} past due` : `grace ${l.grace_days} days` }]} />
        {l.canManage && (
          <section className="card stack">
            <h2>Next step</h2>
            <div className="row">
              {l.status === 'draft' && <button className="primary" disabled={act.busy} onClick={() => act.run('activate', { depositReceivedOn: todayIso() })}>Signed: start the lease</button>}
              {l.status === 'active' && <button onClick={() => setForm({ kind: 'renew', a: '', b: l.end_date ? '' : '', c: String(l.rent_amount) })}>Renew</button>}
              {l.status === 'active' && <button onClick={() => setForm({ kind: 'notice', a: todayIso(), b: '', c: '' })}>Notice to vacate</button>}
              {['active', 'notice'].includes(l.status) && <button onClick={() => setForm({ kind: 'moveout', a: l.move_out_on && l.move_out_on <= todayIso() ? l.move_out_on : todayIso(), b: '7', c: '' })}>Record move-out</button>}
              {l.renewedBy && <span>Renewed by <Link to={`/leasing/leases/${l.renewedBy.id}`}>{l.renewedBy.number}</Link></span>}
            </div>
            {form?.kind === 'notice' && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run('notice', { noticeOn: form.a, moveOutOn: form.b }); }}>
                <label className="row">Notice given <input type="date" value={form.a} onChange={(e) => setForm({ ...form, a: e.target.value })} required /></label>
                <label className="row">Moving out <input id="notice-out" type="date" value={form.b} onChange={(e) => setForm({ ...form, b: e.target.value })} required /></label>
                <button className="primary" disabled={act.busy}>Record notice</button><button type="button" onClick={() => setForm(null)}>Cancel</button>
              </form>
            )}
            {form?.kind === 'moveout' && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run('move-out', { movedOutOn: form.a, turnDays: Number(form.b) }); }}>
                <label className="row">Moved out <input id="moveout-date" type="date" max={todayIso()} value={form.a} onChange={(e) => setForm({ ...form, a: e.target.value })} required /></label>
                <label className="row">Make ready within <input type="number" min="0" max="120" value={form.b} onChange={(e) => setForm({ ...form, b: e.target.value })} style={{ width: 70 }} /> days</label>
                <button className="primary" disabled={act.busy}>Record move-out</button><button type="button" onClick={() => setForm(null)}>Cancel</button>
              </form>
            )}
            {form?.kind === 'renew' && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run('renew', { endDate: form.b || null, rentAmount: Number(form.c) }); }}>
                <label className="row">New end <input id="renew-end" type="date" value={form.b} onChange={(e) => setForm({ ...form, b: e.target.value })} /></label>
                <input id="renew-rent" type="number" min="0" step="0.01" aria-label="New rent" value={form.c} onChange={(e) => setForm({ ...form, c: e.target.value })} required style={{ width: 120 }} />
                <button className="primary" disabled={act.busy}>Renew</button><button type="button" onClick={() => setForm(null)}>Cancel</button>
                <span className="faint">Starts the day after {l.end_date ? fmtDate(l.end_date) : 'today'}; no turn in between.</span>
              </form>
            )}
            <ErrorNote message={act.error} />
          </section>
        )}
        <div className="grid two">
          <section className="card stack">
            <h2>Recurring charges</h2>
            <Table rows={l.charges} rowKey={(c) => c.id} empty="Rent only." columns={[{ key: 'description', label: 'Charge' }, { key: 'amount', label: 'Monthly', numeric: true, render: (c) => fmtMoney(c.amount) }]} />
          </section>
          <section className="card stack">
            <h2>Invoices</h2>
            <Table rows={l.invoices} rowKey={(i) => i.id} empty="Not billed yet (Leasing → Rent billing)."
              columns={[{ key: 'number', label: 'Invoice', render: (i) => <Link to={`/receivables/${i.id}`}>{i.number ?? 'draft'}</Link> }, { key: 'period', label: 'Month', render: (i) => (i.period ? String(i.period).slice(0, 7) : '—') },
                { key: 'total', label: 'Amount', numeric: true, render: (i) => fmtMoney(i.total) }, { key: 'open', label: 'Open', numeric: true, render: (i) => fmtMoney(i.open) },
                { key: 'status', label: 'Status', render: (i) => <Pill value={i.status} /> }]} />
          </section>
        </div>
        <p className="faint">The renter is customer {l.renter_code}: payments, statements and reminders are in Receivables. The deposit is recorded as agreed; the accounting system holds it.</p>
      </>
    )}</Async>
  );
}
