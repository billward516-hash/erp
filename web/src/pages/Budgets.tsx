import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const monthLabel = (m: string) => new Date(`${m}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
const whole = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
const STATUS_TONE: Record<string, 'good' | 'watch' | 'bad' | 'neutral'> = { ok: 'good', watch: 'watch', over: 'bad', under: 'watch', draft: 'neutral', approved: 'good', closed: 'neutral' };

/** Twelve monthly bars for one series (identity comes from the row; values are in the table beside it). */
function MonthBars({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(1, ...values);
  const W = 132, H = 28, gap = 2, bw = (W - gap * 11) / 12;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="month-bars" role="img" aria-label={`Monthly: ${values.map((v, i) => `${labels[i]} ${whole(v)}`).join(', ')}`}>
      <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} className="baseline" />
      {values.map((v, i) => {
        const h = Math.max(v > 0 ? 2 : 0, (v / max) * (H - 2));
        const x = i * (bw + gap); const y = H - 1 - h;
        return <path key={i} d={h > 4 ? `M${x},${H - 1} V${y + 2} Q${x},${y} ${x + 2},${y} H${x + bw - 2} Q${x + bw},${y} ${x + bw},${y + 2} V${H - 1} Z` : `M${x},${H - 1} V${y} H${x + bw} V${H - 1} Z`}>
          <title>{`${labels[i]}: ${whole(v)}`}</title></path>;
      })}
    </svg>
  );
}

export function Budgets() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'history';
  const tabs = [['history', 'Spend history'], ['budgets', 'Budgets'], ...(can('budgets.manage') ? [['categories', 'Spend categories']] : [])];
  return (
    <>
      <PageHead eyebrow="Finance" title="Budgets" sub="What the business spends by category, and next year's budget built bottom-up by sites and departments and top-down from targets." />
      <div className="row" role="tablist" aria-label="Budgets">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k! })}>{l}</button>)}
      </div>
      {tab === 'history' && <SpendHistory />}
      {tab === 'budgets' && <BudgetList />}
      {tab === 'categories' && <Categories />}
    </>
  );
}

function SpendHistory() {
  const sites = useApi<any[]>('/api/facilities');
  const [site, setSite] = useState('');
  const { data, loading, error } = useApi<any>(`/api/spend-analysis${site ? `?facilityId=${site}` : ''}`);
  return (
    <Async loading={loading && !data} error={error}>{() => {
      const labels = data.months.map(monthLabel);
      const top = data.categories[0];
      return (
        <>
          <section className="card stack">
            <p className="answer">{data.total ? <>{whole(data.total)} spent in the last twelve months{top ? <>, {top.share}% of it on {top.name.toLowerCase()}</> : null}.</> : 'No spend recorded in the last twelve months yet.'}</p>
            <div className="row">
              <select id="hist-site" aria-label="Site" value={site} onChange={(e) => setSite(e.target.value)}><option value="">All sites</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select>
              <span className="faint">{monthLabel(data.from)} to {monthLabel(data.to)} · supplier invoices (not stock purchases), stock used, expense reports and imported history</span>
            </div>
            {data.unmapped ? <p className="notice warn">{whole(data.unmapped)} of spend is on accounts no spend category includes; add those accounts to a category.</p> : null}
            <Table rows={data.categories} rowKey={(c: any) => c.id} empty="Import last year's spend (Data import → Spend history) or record invoices and expenses to see history here."
              columns={[{ key: 'name', label: 'Category' }, { key: 'months', label: 'By month', render: (c: any) => <MonthBars values={c.months} labels={labels} /> },
                { key: 'total', label: '12 months', numeric: true, render: (c: any) => whole(c.total) }, { key: 'share', label: 'Share', numeric: true, render: (c: any) => `${c.share}%` },
                { key: 'average', label: 'Per month', numeric: true, render: (c: any) => whole(c.average) },
                { key: 'trailing3', label: 'Run rate (last 3 mo × 4)', numeric: true, render: (c: any) => whole(c.trailing3) },
                { key: 'trendPct', label: '2nd half vs 1st', numeric: true, render: (c: any) => (c.trendPct == null ? '—' : `${c.trendPct > 0 ? '+' : ''}${c.trendPct}%`) },
                { key: 'sources', label: 'From', render: (c: any) => <span className="faint">{Object.entries(c.sources).map(([k, v]) => `${k} ${whole(v as number)}`).join(' · ')}</span> }]} />
          </section>
          {data.byOrg.length > 0 && (
            <section className="card">
              <h2>By site and department</h2>
              <Table rows={data.byOrg} rowKey={(o: any) => `${o.facility}|${o.department}`} columns={[{ key: 'facility', label: 'Site' }, { key: 'department', label: 'Department', render: (o: any) => o.department ?? <span className="faint">Not assigned</span> },
                { key: 'amount', label: '12 months', numeric: true, render: (o: any) => whole(o.amount) }]} />
            </section>
          )}
        </>
      );
    }}</Async>
  );
}

function BudgetList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/budgets');
  const next = new Date().getFullYear() + 1;
  const [f, setF] = useState({ fiscalYear: String(next), name: `${next} operating budget`, startMonth: '1' });
  const create = useAction(async () => { const b = await api.post('/api/budgets', { fiscalYear: Number(f.fiscalYear), name: f.name, startMonth: Number(f.startMonth) }); nav(`/budgets/${b.id}`); });
  return (
    <>
      <section className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!} onRow={(b) => nav(`/budgets/${b.id}`)} empty="No budgets yet."
            columns={[{ key: 'fiscal_year', label: 'Year' }, { key: 'name', label: 'Budget' }, { key: 'status', label: 'Status', render: (b) => <Pill tone={STATUS_TONE[b.status]} label={humanize(b.status)} /> },
              { key: 'total', label: 'Bottom-up total', numeric: true, render: (b) => whole(b.total) }, { key: 'company_target', label: 'Company target', numeric: true, render: (b) => (b.company_target ? whole(b.company_target) : '—') },
              { key: 'approved_at', label: 'Approved', render: (b) => (b.approved_at ? `${fmtDate(b.approved_at)} by ${b.approved_by_name}` : '') }]} />
        )}</Async>
      </section>
      {can('budgets.manage') && (
        <section className="card stack">
          <h2>New budget</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
            <label className="row">Fiscal year<input id="bud-year" type="number" min="2000" max="2100" value={f.fiscalYear} onChange={(e) => setF({ ...f, fiscalYear: e.target.value })} style={{ width: 100 }} /></label>
            <input id="bud-name" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required style={{ flex: '1 1 240px' }} />
            <label className="row">Starts in<select id="bud-start" value={f.startMonth} onChange={(e) => setF({ ...f, startMonth: e.target.value })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' })}</option>)}</select></label>
            <button className="primary" disabled={create.busy}>Create</button>
          </form>
          <ErrorNote message={create.error} />
        </section>
      )}
    </>
  );
}

function Categories() {
  const { data, loading, error, reload } = useApi<any[]>('/api/spend-categories');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = useAction(async (c: any) => {
    await api.post('/api/spend-categories', { id: c.id, code: c.code, name: c.name, sortOrder: c.sort_order, active: c.active, accountKeys: edit[c.id]!.split(',').map((x) => x.trim()).filter(Boolean) });
    const { [c.id]: _x, ...rest } = edit; setEdit(rest); await reload();
  });
  return (
    <section className="card stack">
      <h2>Spend categories</h2>
      <p className="muted">Each category collects spend from the platform's accounts (supplier invoice lines, expense categories, stock used). An account belongs to one category only, so nothing counts twice; imported history is classified through the account mapping.</p>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data!} columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Category' },
          { key: 'account_keys', label: 'Accounts', render: (c: any) => (edit[c.id] != null
            ? <input aria-label={`Accounts for ${c.name}`} value={edit[c.id]} onChange={(e) => setEdit({ ...edit, [c.id]: e.target.value })} />
            : <span className="mono">{c.account_keys.join(', ')}</span>) },
          { key: 'x', label: '', render: (c: any) => (edit[c.id] != null ? <button onClick={() => save.run(c)} disabled={save.busy}>Save</button>
            : <button onClick={() => setEdit({ ...edit, [c.id]: c.account_keys.join(', ') })} aria-label={`Edit ${c.name}`}>Edit</button>) }]} />
      )}</Async>
      <ErrorNote message={save.error} />
    </section>
  );
}

export function BudgetDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'lines';
  const { data: b, loading, error, reload } = useApi<any>(`/api/budgets/${id}`);
  const approve = useAction(async () => { await api.post(`/api/budgets/${id}/approve`, {}); await reload(); });
  const close = useAction(async () => { await api.post(`/api/budgets/${id}/close`, {}); await reload(); });
  return (
    <Async loading={loading && !b} error={error}>{() => {
      const target = b.targets.find((t: any) => !t.facility_id && !t.department_id && !t.category_id);
      const draft = b.status === 'draft';
      return (
        <>
          <PageHead eyebrow={`Budget · fiscal ${b.fiscal_year}${b.start_month !== 1 ? ` (from ${monthLabel(b.months[0])})` : ''}`} title={b.name}
            sub={b.approved_at ? `Approved ${fmtDate(b.approved_at)} by ${b.approved_by_name}` : 'Draft: sites and departments build it bottom-up; finance sets targets, reviews and approves.'}
            actions={<><Pill tone={STATUS_TONE[b.status]} label={humanize(b.status)} />
              {b.canManage && draft && <button className="primary" onClick={() => approve.run()} disabled={approve.busy}>Approve budget</button>}
              {b.canManage && b.status === 'approved' && <button onClick={() => close.run()} disabled={close.busy}>Close</button>}</>} />
          <ErrorNote message={approve.error ?? close.error} />
          <Kpis items={[{ label: 'Bottom-up total', value: whole(b.total) }, ...(target ? [{ label: 'Company target', value: whole(target.amount), tone: (target.status === 'ok' ? 'good' : 'watch') as any,
            note: target.gap ? `${target.gap > 0 ? 'over' : 'under'} by ${whole(Math.abs(target.gap))}` : 'matched' }] : []),
            { label: 'Lines', value: b.lines.length }, { label: 'Waiting for review', value: b.submissions.filter((s: any) => s.status === 'submitted').length }]} />
          <div className="row" role="tablist" aria-label="Budget">
            {[['lines', 'Bottom-up lines'], ['targets', 'Top-down targets'], ['reviews', 'Reviews'], ['actual', 'Against actual']].map(([k, l]) =>
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k! })}>{l}</button>)}
          </div>
          {tab === 'lines' && <Lines b={b} reload={reload} />}
          {tab === 'targets' && <Targets b={b} reload={reload} />}
          {tab === 'reviews' && <Reviews b={b} reload={reload} />}
          {tab === 'actual' && <VsActual id={b.id} />}
        </>
      );
    }}</Async>
  );
}

function Lines({ b, reload }: { b: any; reload: () => Promise<void> }) {
  const sites = useApi<any[]>('/api/facilities');
  const depts = useApi<any[]>('/api/departments');
  const cats = useApi<any[]>('/api/spend-categories');
  const draft = b.status === 'draft';
  const [p, setP] = useState({ facilityId: '', departmentId: '', changePct: '3' });
  const [l, setL] = useState({ facilityId: '', departmentId: '', categoryId: '', annual: '', spreadBy: 'history' });
  const [months, setMonths] = useState<Record<string, string[]>>({});
  const propose = useAction(async () => { await api.post(`/api/budgets/${b.id}/propose`, { facilityId: p.facilityId, departmentId: p.departmentId || null, changePct: Number(p.changePct) }); await reload(); });
  const add = useAction(async () => {
    await api.post(`/api/budgets/${b.id}/lines`, { facilityId: l.facilityId, departmentId: l.departmentId || null, categoryId: l.categoryId, annual: Number(l.annual), spreadBy: l.spreadBy });
    setL({ ...l, categoryId: '', annual: '' }); await reload();
  });
  const saveMonths = useAction(async (x: any) => {
    await api.post(`/api/budgets/${b.id}/lines`, { facilityId: x.facility_id, departmentId: x.department_id, categoryId: x.category_id, amounts: months[x.id]!.map(Number) });
    const { [x.id]: _y, ...rest } = months; setMonths(rest); await reload();
  });
  const submit = useAction(async (facilityId: string, departmentId: string | null) => { await api.post(`/api/budgets/${b.id}/submit`, { facilityId, departmentId }); await reload(); });
  const groups = new Map<string, any[]>();
  for (const x of b.lines) { const k = `${x.facility_id}|${x.department_id ?? ''}`; groups.set(k, [...(groups.get(k) ?? []), x]); }
  const labels = b.months.map(monthLabel);
  const deptOptions = (fac: string) => (depts.data ?? []).filter((d) => !d.facility_id || d.facility_id === fac);
  return (
    <>
      {[...groups.entries()].map(([k, rows]) => {
        const [fac, dept] = k.split('|');
        const sub = b.submissions.find((s: any) => s.facility_id === fac && (s.department_id ?? '') === dept);
        const editable = draft && (b.canManage || (dept && b.myDepartments.includes(dept))) && (!sub || ['draft', 'returned'].includes(sub.status) || b.canManage);
        return (
          <section key={k} className="card stack">
            <div className="spread">
              <h2>{rows[0].facility_code}{rows[0].department_name ? ` · ${rows[0].department_name}` : ' · site'} <span className="muted" style={{ fontWeight: 400 }}>{whole(rows.reduce((s, x) => s + x.annual, 0))}</span></h2>
              <div className="row">{sub && <Pill tone={sub.status === 'accepted' ? 'good' : sub.status === 'returned' ? 'bad' : 'info'} label={humanize(sub.status)} />}
                {editable && (!sub || ['draft', 'returned'].includes(sub.status)) && <button onClick={() => submit.run(fac!, dept || null)} disabled={submit.busy}>Submit for review</button>}</div>
            </div>
            {sub?.status === 'returned' && sub.decision_note && <p className="notice warn">Returned: {sub.decision_note}</p>}
            <div className="table-wrap" tabIndex={0} role="region" aria-label={`Monthly budget, ${rows[0].facility_code}${rows[0].department_name ? ` ${rows[0].department_name}` : ''}`}>
              <table className="budget-grid">
                <thead><tr><th scope="col">Category</th>{labels.map((m: string) => <th key={m} scope="col" className="n">{m}</th>)}<th scope="col" className="n">Year</th><th scope="col">Basis</th>{editable && <th scope="col"></th>}</tr></thead>
                <tbody>{rows.map((x) => (
                  <tr key={x.id}>
                    <th scope="row">{x.category_name}</th>
                    {x.amounts.map((a: number, i: number) => <td key={i} className="n">{months[x.id]
                      ? <input aria-label={`${x.category_name} ${labels[i]}`} type="number" min="0" value={months[x.id]![i]} onChange={(e) => { const m = [...months[x.id]!]; m[i] = e.target.value; setMonths({ ...months, [x.id]: m }); }} style={{ width: 80 }} />
                      : Math.round(a).toLocaleString()}</td>)}
                    <td className="n"><strong>{whole(x.annual)}</strong></td>
                    <td><span className="faint" title={x.note ?? undefined}>{humanize(x.basis)}</span></td>
                    {editable && <td>{months[x.id] ? <button onClick={() => saveMonths.run(x)} disabled={saveMonths.busy}>Save</button>
                      : <button onClick={() => setMonths({ ...months, [x.id]: x.amounts.map((a: number) => String(a)) })} aria-label={`Edit months for ${x.category_name}`}>Edit</button>}</td>}
                  </tr>))}</tbody>
              </table>
            </div>
            <ErrorNote message={saveMonths.error ?? submit.error} />
          </section>
        );
      })}
      {!b.lines.length && <p className="muted">No lines yet. Start a site or department from its history below, or add lines by hand.</p>}
      {draft && (
        <section className="card stack">
          <h2>Start from history</h2>
          <p className="muted">Proposes a line for every category the site (or department) spent on in the last twelve months, keeping its monthly pattern, changed by a percentage.</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void propose.run(); }}>
            <select id="prop-site" aria-label="Site" value={p.facilityId} onChange={(e) => setP({ ...p, facilityId: e.target.value, departmentId: '' })} required><option value="">Site…</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>
            <select id="prop-dept" aria-label="Department" value={p.departmentId} onChange={(e) => setP({ ...p, departmentId: e.target.value })}><option value="">Whole site (no department)</option>{deptOptions(p.facilityId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
            <label className="row">Change %<input id="prop-pct" type="number" step="0.5" value={p.changePct} onChange={(e) => setP({ ...p, changePct: e.target.value })} style={{ width: 80 }} /></label>
            <button className="primary" disabled={propose.busy}>Propose lines</button>
          </form>
          <ErrorNote message={propose.error} />
          <h3>Add a line</h3>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            <select id="line-site" aria-label="Line site" value={l.facilityId} onChange={(e) => setL({ ...l, facilityId: e.target.value, departmentId: '' })} required><option value="">Site…</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>
            <select id="line-dept" aria-label="Line department" value={l.departmentId} onChange={(e) => setL({ ...l, departmentId: e.target.value })}><option value="">Whole site</option>{deptOptions(l.facilityId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
            <select id="line-cat" aria-label="Line category" value={l.categoryId} onChange={(e) => setL({ ...l, categoryId: e.target.value })} required><option value="">Category…</option>{(cats.data ?? []).filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <label className="row">Year $<input id="line-annual" type="number" min="0" value={l.annual} onChange={(e) => setL({ ...l, annual: e.target.value })} required style={{ width: 120 }} /></label>
            <select id="line-spread" aria-label="Spread" value={l.spreadBy} onChange={(e) => setL({ ...l, spreadBy: e.target.value })}><option value="history">Spread like history</option><option value="even">Spread evenly</option></select>
            <button disabled={add.busy}>Add line</button>
          </form>
          <ErrorNote message={add.error} />
        </section>
      )}
    </>
  );
}

function Targets({ b, reload }: { b: any; reload: () => Promise<void> }) {
  const sites = useApi<any[]>('/api/facilities');
  const depts = useApi<any[]>('/api/departments');
  const cats = useApi<any[]>('/api/spend-categories');
  const [t, setT] = useState({ facilityId: '', departmentId: '', categoryId: '', amount: '', note: '' });
  const set = useAction(async () => { await api.post(`/api/budgets/${b.id}/targets`, { facilityId: t.facilityId || null, departmentId: t.departmentId || null, categoryId: t.categoryId || null, amount: Number(t.amount), note: t.note || null }); setT({ ...t, amount: '', note: '' }); await reload(); });
  const allocate = useAction(async (id: string, basis: 'history' | 'bottom_up') => { await api.post(`/api/budget-targets/${id}/allocate`, { basis }); await reload(); });
  const del = useAction(async (id: string) => { await api.delete(`/api/budget-targets/${id}`); await reload(); });
  const draft = b.status === 'draft' && b.canManage;
  return (
    <section className="card stack">
      <h2>Targets and the bottom-up</h2>
      <p className="muted">A target with no site, department or category covers everything. The gap is bottom-up minus target; allocating spreads the target over the lines it covers in proportion to their history or their bottom-up amounts, so they add up exactly.</p>
      <Table rows={b.targets} empty="No targets yet." columns={[
        { key: 'scope', label: 'Covers', render: (x: any) => [x.facility_code ?? 'All sites', x.department_name, x.category_name ?? 'all categories'].filter(Boolean).join(' · ') },
        { key: 'target', label: 'Target', numeric: true, render: (x: any) => whole(x.target) }, { key: 'bottomUp', label: 'Bottom-up', numeric: true, render: (x: any) => whole(x.bottomUp) },
        { key: 'gap', label: 'Gap', numeric: true, render: (x: any) => <>{x.gap > 0 ? '+' : ''}{whole(x.gap)}{x.gapPct != null ? <span className="faint"> ({x.gapPct > 0 ? '+' : ''}{x.gapPct}%)</span> : null}</> },
        { key: 'status', label: '', render: (x: any) => <Pill tone={STATUS_TONE[x.status]} label={x.status === 'ok' ? 'Within 2%' : x.status === 'over' ? 'Bottom-up over' : 'Bottom-up under'} /> },
        { key: 'note', label: 'Note', render: (x: any) => x.note ?? '' },
        ...(draft ? [{ key: 'x', label: '', render: (x: any) => <div className="row"><button onClick={() => allocate.run(x.id, 'bottom_up')} disabled={allocate.busy}>Allocate by bottom-up</button>
          <button onClick={() => allocate.run(x.id, 'history')} disabled={allocate.busy}>by history</button><button className="link" onClick={() => del.run(x.id)}>Remove</button></div> }] : [])]} />
      <ErrorNote message={allocate.error ?? del.error} />
      {draft && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void set.run(); }}>
          <select id="tgt-site" aria-label="Target site" value={t.facilityId} onChange={(e) => setT({ ...t, facilityId: e.target.value })}><option value="">All sites</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>
          <select id="tgt-dept" aria-label="Target department" value={t.departmentId} onChange={(e) => setT({ ...t, departmentId: e.target.value })}><option value="">All departments</option>{(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select id="tgt-cat" aria-label="Target category" value={t.categoryId} onChange={(e) => setT({ ...t, categoryId: e.target.value })}><option value="">All categories</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <label className="row">$<input id="tgt-amount" type="number" min="0" value={t.amount} onChange={(e) => setT({ ...t, amount: e.target.value })} required style={{ width: 130 }} /></label>
          <input id="tgt-note" aria-label="Note" placeholder="Note (e.g. board ceiling)" value={t.note} onChange={(e) => setT({ ...t, note: e.target.value })} />
          <button className="primary" disabled={set.busy}>Set target</button><ErrorNote message={set.error} />
        </form>
      )}
    </section>
  );
}

function Reviews({ b, reload }: { b: any; reload: () => Promise<void> }) {
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = useAction(async (id: string, accept: boolean) => { await api.post(`/api/budget-submissions/${id}/decide`, { accept, note: note[id] || null }); await reload(); });
  return (
    <section className="card stack">
      <h2>Submissions</h2>
      <Table rows={b.submissions} empty="Nothing submitted yet. Department heads submit their lines for review." columns={[
        { key: 'who', label: 'Site · department', render: (s: any) => `${s.facility_code}${s.department_name ? ` · ${s.department_name}` : ''}` }, { key: 'head_name', label: 'Head', render: (s: any) => s.head_name ?? '—' },
        { key: 'status', label: 'Status', render: (s: any) => <Pill tone={s.status === 'accepted' ? 'good' : s.status === 'returned' ? 'bad' : 'info'} label={humanize(s.status)} /> },
        { key: 'submitted', label: 'Submitted', render: (s: any) => (s.submitted_at ? `${fmtDate(s.submitted_at)} by ${s.submitted_by_name}` : '') }, { key: 'note', label: 'Note', render: (s: any) => s.decision_note ?? s.note ?? '' },
        ...(b.canManage && b.status === 'draft' ? [{ key: 'x', label: '', render: (s: any) => (s.status === 'submitted' ? (
          <div className="row"><input aria-label={`Note for ${s.department_name ?? s.facility_code}`} placeholder="Note" value={note[s.id] ?? ''} onChange={(e) => setNote({ ...note, [s.id]: e.target.value })} />
            <button className="primary" onClick={() => decide.run(s.id, true)} disabled={decide.busy}>Accept</button><button onClick={() => decide.run(s.id, false)} disabled={decide.busy}>Return</button></div>) : null) }] : [])]} />
      <ErrorNote message={decide.error} />
    </section>
  );
}

function VsActual({ id }: { id: string }) {
  const { data, loading, error } = useApi<any>(`/api/budgets/${id}/vs-actual`);
  return (
    <Async loading={loading && !data} error={error}>{() => (
      <section className="card stack">
        <p className="answer">{data.elapsed ? <>{whole(data.totals.actualYtd)} spent against {whole(data.totals.budgetYtd)} budgeted for {data.elapsed} month{data.elapsed === 1 ? '' : 's'}; forecast {whole(data.totals.forecast)} for the year against {whole(data.totals.budgetYear)}.</>
          : <>The fiscal year has not started; {whole(data.totals.budgetYear)} budgeted.</>}</p>
        <Table rows={data.rows} rowKey={(r: any) => `${r.facilityId}|${r.departmentId}|${r.categoryId}`} exception={(r: any) => r.status === 'over' || r.unbudgeted}
          columns={[{ key: 'facility', label: 'Site' }, { key: 'department', label: 'Department', render: (r: any) => r.department ?? '—' }, { key: 'category', label: 'Category' },
            { key: 'budgetYtd', label: 'Budget to date', numeric: true, render: (r: any) => whole(r.budgetYtd) }, { key: 'actualYtd', label: 'Actual to date', numeric: true, render: (r: any) => whole(r.actualYtd) },
            { key: 'committed', label: 'Committed', numeric: true, render: (r: any) => (r.committed ? whole(r.committed) : '—') },
            { key: 'variance', label: 'Variance', numeric: true, render: (r: any) => `${r.variance > 0 ? '+' : ''}${whole(r.variance)}` },
            { key: 'forecast', label: 'Forecast (year)', numeric: true, render: (r: any) => whole(r.forecast) }, { key: 'budgetYear', label: 'Budget (year)', numeric: true, render: (r: any) => whole(r.budgetYear) },
            { key: 'status', label: 'Status', render: (r: any) => (r.unbudgeted ? <Pill tone="watch" label="No budget" /> : <Pill tone={STATUS_TONE[r.status]} label={r.status === 'ok' ? 'On track' : r.status === 'over' ? 'Over' : 'Heading over'} />) }]} />
        <p className="faint">Forecast = actual to date plus the budget for the months left. Committed = open purchase orders for non-stock items.</p>
      </section>
    )}</Async>
  );
}
