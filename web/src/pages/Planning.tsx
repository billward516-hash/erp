import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtNum, fmtPct } from '../format';
import { useAction, useApi } from '../hooks';

const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const loadTone = (u: number | null) => (u == null ? 'neutral' : u > 1 ? 'bad' : u > 0.85 ? 'watch' : 'good') as 'bad' | 'watch' | 'good' | 'neutral';

export function Planning() {
  const { can } = useAuth();
  const sites = useApi<any[]>('/api/sites?kind=plant');
  const [facilityId, setFacilityId] = useState('');
  const [tab, setTab] = useState<'plan' | 'forecasts' | 'calendars'>('plan');
  const site = facilityId || sites.data?.[0]?.id || '';
  return (
    <>
      <PageHead eyebrow="Planning" title="Demand, capacity and materials" sub="Customer forecasts and firm orders turned into work-center load against demonstrated capacity, and into material needs with order-by dates." />
      <div className="row" role="group" aria-label="Planning views">
        {([['plan', 'Plan'], ['forecasts', 'Forecasts'], ...(can('planning.manage') ? [['calendars', 'Calendars']] : [])] as [string, string][]).map(([k, l]) =>
          <button key={k} role="tab" className={tab === k ? 'primary' : ''} onClick={() => setTab(k as any)}>{l}</button>)}
        <select id="plan-site" aria-label="Site" value={site} onChange={(e) => setFacilityId(e.target.value)} style={{ width: 'auto' }}>
          {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
        </select>
      </div>
      {site && tab === 'plan' && <Plan facilityId={site} />}
      {site && tab === 'forecasts' && <Forecasts facilityId={site} />}
      {site && tab === 'calendars' && <Calendars facilityId={site} />}
    </>
  );
}

function Plan({ facilityId }: { facilityId: string }) {
  const { can } = useAuth();
  const [horizon, setHorizon] = useState(6);
  const [scenarioId, setScenarioId] = useState('');
  const scenarios = useApi<any[]>(`/api/planning-scenarios?facilityId=${facilityId}`);
  const { data: p, loading, error } = useApi<any>(`/api/plan?facilityId=${facilityId}&horizon=${horizon}${scenarioId ? `&scenarioId=${scenarioId}` : ''}`);
  const wcs = useApi<any[]>(can('planning.manage') ? `/api/work-centers?facilityId=${facilityId}` : null);
  const [sc, setSc] = useState<{ name: string; demandPct: string; wc: string; hours: string; units: string } | null>(null);
  const saveSc = useAction(async () => {
    const s = await api.post('/api/planning-scenarios', { facilityId, name: sc!.name, demandPct: Number(sc!.demandPct || 0),
      adjustments: sc!.wc ? [{ workCenterId: sc!.wc, extraHoursPerWeek: Number(sc!.hours || 0), extraUnits: Number(sc!.units || 0) }] : [] });
    setSc(null); await scenarios.reload(); setScenarioId(s.id);
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
        const firm = p.demand.reduce((s: number, d: any) => s + d.firm, 0); const total = p.demand.reduce((s: number, d: any) => s + d.total, 0);
        return (
          <>
            <Kpis items={[
              { label: 'Peak load', value: p.bottleneck ? fmtPct(p.bottleneck.utilization) : '—', tone: p.bottleneck ? (loadTone(p.bottleneck.utilization) === 'neutral' ? undefined : loadTone(p.bottleneck.utilization) as any) : undefined,
                note: p.bottleneck ? `${p.bottleneck.code}, ${mon(p.bottleneck.month)}${p.base?.bottleneck ? ` (was ${fmtPct(p.base.bottleneck.utilization)})` : ''}` : undefined },
              { label: 'Work-center months over', value: over.length, tone: over.length ? 'bad' : 'good' },
              { label: 'Materials short', value: short.length, tone: short.length ? 'bad' : 'good', note: p.base ? `was ${p.base.materialsShort}` : undefined },
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
                        {w.cells.map((c: any) => <td key={c.month} className="n" title={`open orders ${c.committed} h, firm ${c.firm} h, forecast ${c.forecast} h, capacity ${c.capacity} h`}>
                          <Pill tone={loadTone(c.utilization)} label={fmtPct(c.utilization)} /><div className="faint">{fmtNum(c.required, 0)} / {fmtNum(c.capacity, 0)} h</div></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="faint">Load = open production orders + planned production (firm and forecast) through the released routing. Capacity = calendar × machines × demonstrated availability.</p>
            </section>
            <section className="card stack">
              <h2>Materials</h2>
              <Table rows={p.materials} rowKey={(m) => m.partId} empty="No purchased materials needed in the horizon." exception={(m) => m.shortQty > 0}
                columns={[{ key: 'partNumber', label: 'Part', render: (m) => <><strong>{m.partNumber}</strong><div className="faint">{m.description}</div></> },
                  { key: 'available', label: 'Available', numeric: true, render: (m) => fmtNum(m.available, 0) },
                  { key: 'required', label: 'Needed', numeric: true, render: (m) => fmtNum(m.required.reduce((s: number, x: number) => s + x, 0), 0) },
                  { key: 'receipts', label: 'On order', numeric: true, render: (m) => fmtNum(m.receipts.reduce((s: number, x: number) => s + x, 0), 0) },
                  { key: 'shortQty', label: 'Short', numeric: true, render: (m) => (m.shortQty > 0 ? <span className="bad-text">{fmtNum(m.shortQty, 0)}</span> : '—') },
                  { key: 'needBy', label: 'Need by', render: (m) => fmtDate(m.needBy) },
                  { key: 'orderBy', label: 'Order by', render: (m) => (m.orderBy ? <>{fmtDate(m.orderBy)}{m.late && <> <Pill tone="bad" label="past" /></>}</> : '—') }]} />
            </section>
            <section className="card stack">
              <h2>Planned production</h2>
              <Table rows={p.production} rowKey={(x) => x.partId} empty="Nothing to make beyond open production orders."
                columns={[{ key: 'partNumber', label: 'Part', render: (x) => <strong>{x.partNumber}</strong> }, ...p.months.map((m: string, k: number) => ({ key: m, label: mon(m), numeric: true, render: (x: any) => fmtNum(x.qty[k], 0) }))]} />
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
  const [edit, setEdit] = useState<Record<string, { hours: string; units: string }>>({});
  const save = useAction(async (id: string) => {
    const e = edit[id]!;
    await api.put(`/api/work-centers/${id}/calendar`, { hoursPerWeek: e.hours ? Number(e.hours) : null, units: e.units ? Number(e.units) : null }); await reload();
  });
  return (
    <div className="card stack">
      <Table rows={(data ?? []).filter((w) => w.active)} rowKey={(w) => w.id} empty="No work centers at this site."
        columns={[{ key: 'code', label: 'Work center', render: (w) => <><strong>{w.code}</strong> <span className="faint">{w.name}</span></> },
          { key: 'assets', label: 'Machines', render: (w) => w.assets.map((a: any) => a.tag).join(', ') || 'by hand' },
          { key: 'cal', label: 'Hours a week × machines or crews', render: (w) => {
            const e = edit[w.id] ?? { hours: w.hours_per_week != null ? String(Number(w.hours_per_week)) : '', units: w.units != null ? String(w.units) : '' };
            return <span className="row">
              <input aria-label={`Hours per week for ${w.code}`} type="number" min="1" max="168" placeholder="40 (assumed)" value={e.hours} onChange={(x) => setEdit({ ...edit, [w.id]: { ...e, hours: x.target.value } })} style={{ width: 120 }} />
              <input aria-label={`Units for ${w.code}`} type="number" min="1" placeholder={String(Math.max(1, w.assets.length))} value={e.units} onChange={(x) => setEdit({ ...edit, [w.id]: { ...e, units: x.target.value } })} style={{ width: 90 }} />
              <button disabled={save.busy || !edit[w.id]} onClick={() => save.run(w.id)}>Save</button></span>;
          } }]} />
      <ErrorNote message={save.error} />
      <p className="faint">Hours a week the work center is scheduled per machine or crew (two 8-hour shifts, 5 days = 80). Machines or crews defaults to the machines assigned. Availability comes from the machines' recorded state.</p>
    </div>
  );
}
