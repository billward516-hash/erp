import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtMoney, fmtNum, fmtPct } from '../format';
import { useAction, useApi } from '../hooks';

/** A rate as people say it: "0.06 per machine hour", or "1 per 90 units made" when it is small. */
const rateText = (rate: number, per: string) => (rate < 0.1 && Math.abs(1 / rate - Math.round(1 / rate)) < 0.01 * (1 / rate) ? `1 per ${Math.round(1 / rate)} ${per}s` : `${fmtNum(rate, 3)} per ${per}`);
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const loadTone = (u: number | null) => (u == null ? 'neutral' : u > 1 ? 'bad' : u > 0.85 ? 'watch' : 'good') as 'bad' | 'watch' | 'good' | 'neutral';

export function Planning() {
  const { can } = useAuth();
  const sites = useApi<any[]>('/api/sites?kind=plant');
  const [facilityId, setFacilityId] = useState('');
  const [tab, setTab] = useState<'plan' | 'forecasts' | 'calendars' | 'consumables'>('plan');
  const site = facilityId || sites.data?.[0]?.id || '';
  return (
    <>
      <PageHead eyebrow="Planning" title="Demand, capacity and materials" sub="Customer forecasts and firm orders turned into work-center load against demonstrated capacity, and into material needs with order-by dates." />
      <div className="row">
        <div className="row" role="tablist" aria-label="Planning views">
        {([['plan', 'Plan'], ['forecasts', 'Forecasts'], ...(can('planning.manage') ? [['calendars', 'Calendars'], ['consumables', 'Consumables']] : [])] as [string, string][]).map(([k, l]) =>
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k as any)}>{l}</button>)}
        </div>
        <select id="plan-site" aria-label="Site" value={site} onChange={(e) => setFacilityId(e.target.value)} style={{ width: 'auto' }}>
          {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
        </select>
      </div>
      {site && tab === 'plan' && <Plan key={site} facilityId={site} />}
      {site && tab === 'forecasts' && <Forecasts key={site} facilityId={site} />}
      {site && tab === 'calendars' && <Calendars key={site} facilityId={site} />}
      {site && tab === 'consumables' && <Consumables key={site} facilityId={site} />}
    </>
  );
}

function Plan({ facilityId }: { facilityId: string }) {
  const { can } = useAuth();
  const [horizon, setHorizon] = useState(6);
  const [scenarioId, setScenarioId] = useState('');
  const scenarios = useApi<any[]>(`/api/planning-scenarios?facilityId=${facilityId}`);
  const { data: p, loading, error, reload } = useApi<any>(`/api/plan?facilityId=${facilityId}&horizon=${horizon}${scenarioId ? `&scenarioId=${scenarioId}` : ''}`);
  const wcs = useApi<any[]>(can('planning.manage') ? `/api/work-centers?facilityId=${facilityId}` : null);
  const [sc, setSc] = useState<{ name: string; demandPct: string; wc: string; hours: string; units: string } | null>(null);
  const saveSc = useAction(async () => {
    const s = await api.post('/api/planning-scenarios', { facilityId, name: sc!.name, demandPct: Number(sc!.demandPct || 0),
      adjustments: sc!.wc ? [{ workCenterId: sc!.wc, extraHoursPerWeek: Number(sc!.hours || 0), extraUnits: Number(sc!.units || 0) }] : [] });
    setSc(null); await scenarios.reload(); setScenarioId(s.id);
  });
  // Acting on the plan: only the plan as it stands (no scenario), by someone who may plan and buy or make.
  const act = !scenarioId && can('planning.manage');
  const [done, setDone] = useState<{ request?: any; orders?: any[] } | null>(null);
  const request = useAction(async () => { const r = await api.post('/api/plan/purchase-request', { facilityId, horizon }); setDone({ request: r }); await reload(); });
  const makeOrders = useAction(async (lines: { partId: string; month: string }[]) => {
    const o = await api.post('/api/plan/production-orders', { facilityId, horizon, lines }); setDone({ orders: o }); await reload();
  });
  return (
    <>
      <div className="row">
        <select id="plan-horizon" aria-label="Horizon" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} style={{ width: 'auto' }}>
          {[3, 6, 9, 12].map((n) => <option key={n} value={n}>{n} months</option>)}
        </select>
        <select id="plan-scenario" aria-label="Scenario" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} style={{ width: 'auto' }}>
          <option value="">As planned (no scenario)</option>{(scenarios.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {can('planning.manage') && !sc && <button onClick={() => setSc({ name: '', demandPct: '0', wc: '', hours: '', units: '' })}>New scenario</button>}
      </div>
      {sc && (
        <form className="card row" onSubmit={(e) => { e.preventDefault(); void saveSc.run(); }}>
          <input id="sc-name" aria-label="Scenario name" placeholder='Name, e.g. "Second shift on lathes"' value={sc.name} onChange={(e) => setSc({ ...sc, name: e.target.value })} required style={{ flex: '1 1 220px' }} />
          <label className="row">Forecast <input id="sc-pct" type="number" aria-label="Forecast change %" value={sc.demandPct} onChange={(e) => setSc({ ...sc, demandPct: e.target.value })} style={{ width: 80 }} /> %</label>
          <select id="sc-wc" aria-label="Work center" value={sc.wc} onChange={(e) => setSc({ ...sc, wc: e.target.value })} style={{ width: 'auto' }}>
            <option value="">No capacity change</option>{(wcs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
          {sc.wc && <><input id="sc-hours" type="number" aria-label="Extra hours per week" placeholder="+ h/week" value={sc.hours} onChange={(e) => setSc({ ...sc, hours: e.target.value })} style={{ width: 100 }} />
            <input type="number" aria-label="Extra machines or crews" placeholder="+ machines" value={sc.units} onChange={(e) => setSc({ ...sc, units: e.target.value })} style={{ width: 110 }} /></>}
          <button className="primary" disabled={saveSc.busy}>Save and show</button><button type="button" onClick={() => setSc(null)}>Cancel</button><ErrorNote message={saveSc.error} />
        </form>
      )}
      <Async loading={loading && !p} error={error}>{() => {
        const short = p.materials.filter((m: any) => m.shortQty > 0);
        const over = p.workCenters.flatMap((w: any) => w.cells.filter((c: any) => (c.utilization ?? 0) > 1));
        const toRequest = p.materials.filter((m: any) => m.toRequest > 0);
        const firm = p.demand.reduce((s: number, d: any) => s + d.firm, 0); const total = p.demand.reduce((s: number, d: any) => s + d.total, 0);
        return (
          <>
            <Kpis items={[
              { label: 'Peak load', value: p.bottleneck ? fmtPct(p.bottleneck.utilization) : '—', tone: p.bottleneck ? (loadTone(p.bottleneck.utilization) === 'neutral' ? undefined : loadTone(p.bottleneck.utilization) as any) : undefined,
                note: p.bottleneck ? `${p.bottleneck.code}, ${mon(p.bottleneck.month)}${p.base?.bottleneck ? ` (was ${fmtPct(p.base.bottleneck.utilization)})` : ''}` : undefined },
              { label: 'Work-center months over', value: over.length, tone: over.length ? 'bad' : 'good' },
              { label: 'Materials short', value: short.length, tone: short.length ? 'bad' : 'good', note: p.base ? `was ${p.base.materialsShort}` : undefined },
              ...(p.labor ? [{ label: 'Operator shortfall', value: p.labor.workCenters.reduce((s: number, w: any) => s + w.shortMonths, 0), tone: (p.labor.workCenters.some((w: any) => w.shortMonths) ? 'bad' : 'good') as any,
                note: 'work-center months short of qualified people' }] : []),
              { label: 'Firm share of demand', value: fmtPct(total ? firm / total : null) }]} />
            <section className="card stack">
              <h2>Work-center load</h2>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Work center</th>{p.months.map((m: string) => <th key={m} className="n">{mon(m)}</th>)}</tr></thead>
                  <tbody>
                    <tr><td className="muted">Demand (firm + forecast)</td>{p.demand.map((d: any) => <td key={d.month} className="n">{fmtNum(d.firm, 0)} + {fmtNum(d.forecast, 0)}</td>)}</tr>
                    {p.workCenters.map((w: any) => (
                      <tr key={w.id}>
                        <td><strong>{w.code}</strong> <span className="faint">{w.name}</span><div className="faint">{w.hoursPerWeek} h/wk × {w.units}{w.availability != null ? ` × ${fmtPct(w.availability)} avail.` : ''}</div></td>
                        {w.cells.map((c: any) => <td key={c.month} className="n" title={`open orders ${c.committed} h, firm ${c.firm} h, forecast ${c.forecast} h, capacity ${c.capacity} h${c.maintenance ? ` after ${c.maintenance} h preventive maintenance` : ''}`}>
                          <Pill tone={loadTone(c.utilization)} label={fmtPct(c.utilization)} /><div className="faint">{fmtNum(c.required, 0)} / {fmtNum(c.capacity, 0)} h</div>
                          {c.maintenance > 0 && <div className="faint">PM {fmtNum(c.maintenance, 0)} h</div>}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="faint">Load = open production orders + planned production (firm and forecast) through the released routing. Capacity = calendar × machines × demonstrated availability, less preventive maintenance projected from the machines' calendar PM plans.</p>
            </section>
            {p.labor && (
              <section className="card stack">
                <h2>Qualified operators</h2>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Work center</th>{p.months.map((m: string) => <th key={m} className="n">{mon(m)}</th>)}</tr></thead>
                    <tbody>{p.labor.workCenters.map((w: any) => (
                      <tr key={w.id}>
                        <td><strong>{w.code}</strong> <span className="faint">needs {w.qualifications.join(' + ')}</span>
                          <div className="faint">{w.qualifiedNow} qualified{w.laborRatio !== 1 ? ` · ${w.laborRatio} operator h per machine h` : ''} {w.singlePoint && <Pill tone="watch" label={w.qualifiedNow ? 'one person' : 'nobody'} />}</div></td>
                        {w.cells.map((c: any) => <td key={c.month} className="n" title={`${c.qualified} qualified, ${c.available} h if they did nothing else`}>
                          {c.short > 0 ? <span className="bad-text">{fmtNum(c.short, 0)} h short</span> : <span className="muted">covered</span>}
                          <div className="faint">{fmtNum(c.required, 0)} h needed</div></td>)}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {p.labor.lapses.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{p.labor.lapses.map((l: any) => <li key={`${l.workCenter}${l.person}${l.qualification}`}>
                  {l.person}'s {l.qualification} expires {fmtDate(l.expiresOn)}; {l.workCenter} then has {l.leaves} qualified {l.leaves === 1 ? 'person' : 'people'}.</li>)}</ul>}
                <p className="faint">People are shared: someone qualified on two work centers is counted once across both (the shortfall is what no assignment of their hours can cover). Hours are demonstrated from approved timesheets where there are enough.</p>
              </section>
            )}
            <section className="card stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2>Materials</h2>
                {act && can('purchasing.request') && toRequest.length > 0 && <button className="primary" onClick={() => request.run()} disabled={request.busy}>
                  Draft a purchase request for {toRequest.length} short material{toRequest.length === 1 ? '' : 's'}</button>}
              </div>
              <ErrorNote message={request.error} />
              {done?.request && <p className="good-text">Drafted <Link to={`/purchasing/requests/${done.request.id}`}>{done.request.number}</Link>; review and submit it for approval.</p>}
              <Table rows={p.materials} rowKey={(m) => m.partId} empty="No purchased materials needed in the horizon." exception={(m) => m.shortQty > 0}
                columns={[{ key: 'partNumber', label: 'Part', render: (m) => <><strong>{m.partNumber}</strong><div className="faint">{m.description}</div></> },
                  { key: 'from', label: 'For', render: (m) => [m.bySource.production ? 'production' : null, m.bySource.consumables ? 'consumption' : null, m.bySource.maintenance ? 'PM' : null].filter(Boolean).join(' + ') || '—' },
                  { key: 'available', label: 'Available', numeric: true, render: (m) => fmtNum(m.available, 0) },
                  { key: 'required', label: 'Needed', numeric: true, render: (m) => fmtNum(m.required.reduce((s: number, x: number) => s + x, 0), 0) },
                  { key: 'receipts', label: 'On order', numeric: true, render: (m) => fmtNum(m.receipts.reduce((s: number, x: number) => s + x, 0), 0) },
                  { key: 'shortQty', label: 'Short', numeric: true, render: (m) => (m.shortQty > 0 ? <span className="bad-text">{fmtNum(m.shortQty, 0)}</span> : '—') },
                  { key: 'requested', label: 'Requested', numeric: true, render: (m) => (m.requested > 0 ? fmtNum(m.requested, 0) : '—') },
                  { key: 'needBy', label: 'Need by', render: (m) => fmtDate(m.needBy) },
                  { key: 'orderBy', label: 'Order by', render: (m) => (m.orderBy ? <>{fmtDate(m.orderBy)}{m.late && <> <Pill tone="bad" label="past" /></>}</> : '—') }]} />
            </section>
            {(p.consumption.length > 0 || p.maintenanceParts.length > 0) && (
              <section className="card stack">
                <h2>Consumables, chemicals and PM parts</h2>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Part</th><th>Used by</th>{p.months.map((m: string) => <th key={m} className="n">{mon(m)}</th>)}</tr></thead>
                    <tbody>
                      {p.consumption.map((c: any) => (
                        <tr key={c.id}><td><strong>{c.partNumber}</strong><div className="faint">{c.description}</div></td>
                          <td>{c.workCenter ?? 'site'} <span className="faint">· {rateText(c.rate, c.basis === 'machine_hour' ? 'machine hour' : c.basis === 'unit' ? 'unit' : 'month')}</span></td>
                          {c.qty.map((q: number, k: number) => <td key={k} className="n">{fmtNum(q, 1)}</td>)}</tr>
                      ))}
                      {p.maintenanceParts.map((m: any, i: number) => (
                        <tr key={`pm${i}`}><td><strong>{m.partNumber}</strong><div className="faint">{m.description}</div></td><td>PM {m.plan}</td>
                          {m.qty.map((q: number, k: number) => <td key={k} className="n">{q ? fmtNum(q, 1) : '—'}</td>)}</tr>
                      ))}
                      <tr><td colSpan={2} className="muted">Cost (consumption + PM parts)</td>
                        {p.months.map((m: string, k: number) => <td key={m} className="n">{fmtMoney(p.consumablesCost.consumables[k] + p.consumablesCost.maintenance[k])}</td>)}</tr>
                    </tbody>
                  </table>
                </div>
                <p className="faint">Per machine hour follows the work center's load above; per unit follows what is made there; PM parts follow each calendar plan's schedule. All of it is in the material projection. Production consumption is production cost, not maintenance cost.</p>
              </section>
            )}
            <section className="card stack">
              <h2>Planned production</h2>
              <ErrorNote message={makeOrders.error} />
              {done?.orders && <p className="good-text">Created {done.orders.map((o: any, i: number) => <span key={o.id}>{i ? ', ' : ''}<Link to={`/production/orders/${o.id}`}>{o.number}</Link> ({o.partNumber} × {fmtNum(o.qty, 0)})</span>)} as planned orders; release them when ready.</p>}
              <Table rows={p.production} rowKey={(x) => x.partId} empty="Nothing to make beyond open production orders."
                columns={[{ key: 'partNumber', label: 'Part', render: (x) => <strong>{x.partNumber}</strong> }, ...p.months.map((m: string, k: number) => ({ key: m, label: mon(m), numeric: true, render: (x: any) => <>
                  {fmtNum(x.qty[k], 0)}
                  {act && can('production.manage') && x.qty[k] > 0 && <div><button className="link" aria-label={`Create order for ${x.partNumber} ${m}`} disabled={makeOrders.busy} onClick={() => makeOrders.run([{ partId: x.partId, month: m }])}>create order</button></div>}</> }))]} />
              {scenarioId && <p className="faint">Orders and requests are created from the plan as it stands; clear the scenario to act on it.</p>}
            </section>
            {p.assumptions.length > 0 && (
              <section className="card stack">
                <h2>Assumptions this plan had to make</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>{p.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul>
              </section>
            )}
          </>
        );
      }}</Async>
    </>
  );
}

function Forecasts({ facilityId }: { facilityId: string }) {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>(`/api/forecasts?facilityId=${facilityId}`);
  return (
    <div className="card stack">
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(f) => f.id} empty="No forecasts yet. Import a customer's forecast (Data import → Customer forecasts)." onRow={(f) => nav(`/planning/forecasts/${f.id}`)}
          columns={[{ key: 'customer', label: 'Customer' }, { key: 'version', label: 'Version', numeric: true }, { key: 'status', label: 'Status', render: (f) => <Pill tone={f.status === 'active' ? 'good' : f.status === 'draft' ? 'info' : 'neutral'} label={f.status} /> },
            { key: 'range', label: 'Months', render: (f) => (f.first_month ? `${String(f.first_month).slice(0, 7)} → ${String(f.last_month).slice(0, 7)}` : '—') },
            { key: 'total', label: 'Total', numeric: true, render: (f) => fmtNum(f.total, 0) }, { key: 'received_on', label: 'Received', render: (f) => fmtDate(f.received_on) }, { key: 'source', label: 'Source' }]} />
      )}</Async>
    </div>
  );
}

export function ForecastDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: f, loading, error, reload } = useApi<any>(`/api/forecasts/${id}`);
  const activate = useAction(async () => { await api.post(`/api/forecasts/${id}/activate`, {}); await reload(); });
  return (
    <Async loading={loading && !f} error={error}>{() => (
      <>
        <PageHead eyebrow={`${f.facility_code} · forecast version ${f.version}${f.previousVersion ? ` (replaces version ${f.previousVersion})` : ''}`} title={f.customer}
          actions={<Pill tone={f.status === 'active' ? 'good' : f.status === 'draft' ? 'info' : 'neutral'} label={f.status} />} />
        <Kpis items={[{ label: 'Total', value: fmtNum(f.total, 0) }, { label: 'Previous version', value: f.previousTotal == null ? '—' : fmtNum(f.previousTotal, 0),
          note: f.previousTotal ? `${f.total >= f.previousTotal ? '+' : ''}${fmtPct((f.total - f.previousTotal) / f.previousTotal)}` : undefined },
          { label: 'Months where firm orders exceed it', value: f.rows.reduce((s: number, r: any) => s + r.cells.filter((c: any) => c.firmOver).length, 0) }]} />
        <section className="card stack">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Part</th>{f.months.map((m: string) => <th key={m} className="n">{mon(m)}</th>)}</tr></thead>
              <tbody>{f.rows.map((r: any) => (
                <tr key={r.partId}><td><strong>{r.partNumber}</strong><div className="faint">{r.description}</div></td>
                  {r.cells.map((c: any) => <td key={c.month} className="n">{fmtNum(c.qty, 0)}
                    {c.change != null && c.change !== 0 && <div className={c.change > 0 ? 'muted' : 'bad-text'}>{c.change > 0 ? '+' : ''}{fmtNum(c.change, 0)}</div>}
                    {c.firm > 0 && <div className={c.firmOver ? 'bad-text' : 'faint'}>firm {fmtNum(c.firm, 0)}</div>}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
          <p className="faint">Changes are against the version in force before this one. Firm = open sales orders for this customer and part in the month; in the plan the larger of the two counts.</p>
        </section>
        {f.status === 'draft' && can('planning.manage') && <div className="row"><button className="primary" onClick={() => activate.run()} disabled={activate.busy}>Use this version in the plan</button><ErrorNote message={activate.error} /></div>}
      </>
    )}</Async>
  );
}

function Calendars({ facilityId }: { facilityId: string }) {
  const { data, reload } = useApi<any[]>(`/api/work-centers?facilityId=${facilityId}`);
  const [edit, setEdit] = useState<Record<string, { hours: string; units: string; ratio: string }>>({});
  const save = useAction(async (id: string) => {
    const e = edit[id]!;
    await api.put(`/api/work-centers/${id}/calendar`, { hoursPerWeek: e.hours ? Number(e.hours) : null, units: e.units ? Number(e.units) : null, laborRatio: e.ratio ? Number(e.ratio) : null }); await reload();
  });
  return (
    <div className="card stack">
      <Table rows={(data ?? []).filter((w) => w.active)} rowKey={(w) => w.id} empty="No work centers at this site."
        columns={[{ key: 'code', label: 'Work center', render: (w) => <><strong>{w.code}</strong> <span className="faint">{w.name}</span></> },
          { key: 'assets', label: 'Machines', render: (w) => w.assets.map((a: any) => a.tag).join(', ') || 'by hand' },
          { key: 'cal', label: 'Hours a week × machines or crews · operators per machine hour', render: (w) => {
            const e = edit[w.id] ?? { hours: w.hours_per_week != null ? String(Number(w.hours_per_week)) : '', units: w.units != null ? String(w.units) : '', ratio: w.labor_ratio != null ? String(Number(w.labor_ratio)) : '' };
            return <span className="row">
              <input aria-label={`Hours per week for ${w.code}`} type="number" min="1" max="168" placeholder="40 (assumed)" value={e.hours} onChange={(x) => setEdit({ ...edit, [w.id]: { ...e, hours: x.target.value } })} style={{ width: 120 }} />
              <input aria-label={`Units for ${w.code}`} type="number" min="1" placeholder={String(Math.max(1, w.assets.length))} value={e.units} onChange={(x) => setEdit({ ...edit, [w.id]: { ...e, units: x.target.value } })} style={{ width: 90 }} />
              <input aria-label={`Operators per machine hour for ${w.code}`} type="number" min="0.05" step="0.05" placeholder="1 operator" value={e.ratio} onChange={(x) => setEdit({ ...edit, [w.id]: { ...e, ratio: x.target.value } })} style={{ width: 110 }} />
              <button disabled={save.busy || !edit[w.id]} onClick={() => save.run(w.id)}>Save</button></span>;
          } }]} />
      <ErrorNote message={save.error} />
      <p className="faint">Hours a week the work center is scheduled per machine or crew (two 8-hour shifts, 5 days = 80). Machines or crews defaults to the machines assigned. Availability comes from the machines' recorded state.</p>
    </div>
  );
}

function Consumables({ facilityId }: { facilityId: string }) {
  const { data, loading, error, reload } = useApi<any[]>(`/api/consumption-rates?facilityId=${facilityId}`);
  const wcs = useApi<any[]>(`/api/work-centers?facilityId=${facilityId}`);
  const [pn, setPn] = useState('');
  const parts = useApi<any[]>(pn.length >= 2 ? `/api/parts?q=${encodeURIComponent(pn)}&limit=8` : null);
  const [f, setF] = useState({ partId: '', partLabel: '', workCenterId: '', basis: 'machine_hour', qty: '', per: '1', note: '' });
  const save = useAction(async () => {
    await api.post('/api/consumption-rates', { facilityId, partId: f.partId, workCenterId: f.workCenterId || null, basis: f.basis, rate: Number(f.qty) / Number(f.per || 1), note: f.note || null });
    setF({ partId: '', partLabel: '', workCenterId: '', basis: 'machine_hour', qty: '', per: '1', note: '' }); setPn(''); await reload();
  });
  const remove = useAction(async (r: any) => { await api.post('/api/consumption-rates', { facilityId, partId: r.part_id, workCenterId: r.work_center_id, basis: r.basis, rate: 0 }); await reload(); });
  return (
    <div className="card stack">
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(r) => r.id} empty="No consumption rates yet. Add coolant, inserts, chemicals or gases by work center, or import a usage sheet (Data import → Consumables and chemicals usage)."
          columns={[{ key: 'part_number', label: 'Part', render: (r) => <><strong>{r.part_number}</strong> <span className="faint">{r.description}</span></> },
            { key: 'work_center', label: 'Work center', render: (r) => r.work_center ?? 'site-wide' },
            { key: 'rate', label: 'Rate', render: (r) => `${rateText(r.rate, r.basis === 'machine_hour' ? 'machine hour' : r.basis === 'unit' ? 'unit' : 'month')} (${r.uom})` },
            { key: 'unit_cost', label: 'Unit cost', numeric: true, render: (r) => fmtMoney(r.unit_cost) }, { key: 'note', label: 'Note' },
            { key: 'x', label: '', render: (r) => <button className="link" onClick={() => remove.run(r)} disabled={remove.busy}>Remove</button> }]} />
      )}</Async>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <h3>Add a rate</h3>
        {f.partId ? <div className="row">Part: <strong>{f.partLabel}</strong><button type="button" className="link" onClick={() => setF({ ...f, partId: '', partLabel: '' })}>change</button></div> : (
          <div className="stack">
            <input id="cons-part" aria-label="Find the part" placeholder="Find the consumable by part number or description" value={pn} onChange={(e) => setPn(e.target.value)} />
            {(parts.data ?? []).length > 0 && <div className="row">{parts.data!.map((x) => <button type="button" key={x.id} onClick={() => setF({ ...f, partId: x.id, partLabel: `${x.part_number} ${x.description}` })}>{x.part_number}</button>)}</div>}
          </div>
        )}
        <div className="row">
          <input id="cons-qty" aria-label="Quantity" type="number" step="any" min="0" placeholder="Qty" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} required style={{ width: 90 }} />
          <span>per</span>
          <input id="cons-per" aria-label="Per how many" type="number" step="any" min="0" value={f.per} onChange={(e) => setF({ ...f, per: e.target.value })} style={{ width: 80 }} />
          <select id="cons-basis" aria-label="Basis" value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} style={{ width: 'auto' }}>
            <option value="machine_hour">machine hours</option><option value="unit">units made</option><option value="month">months</option>
          </select>
          <span>at</span>
          <select id="cons-wc" aria-label="Work center" value={f.workCenterId} onChange={(e) => setF({ ...f, workCenterId: e.target.value })} style={{ width: 'auto' }}>
            <option value="">the whole site</option>{(wcs.data ?? []).filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
          <input aria-label="Note" placeholder="Note (source of the rate)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ flex: '1 1 160px' }} />
          <button className="primary" disabled={save.busy || !f.partId}>Add</button>
        </div>
        <ErrorNote message={save.error ?? remove.error} />
      </form>
      <p className="faint">Write the rate the way it is known: "1 per 120 units made", "0.5 per 10 machine hours", "2 per 1 month". A new rate for the same part, work center and basis replaces the old one.</p>
    </div>
  );
}
