import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Table } from '../components/ui';
import { fmtDate, fmtMoney, fmtNum, fmtPct } from '../format';
import { useAction, useApi } from '../hooks';

export function Reports() {
  const { data, loading, error } = useApi<any[]>('/api/reports');
  return (
    <>
      <PageHead eyebrow="Reports" title="Reports" sub="Every report shows the same numbers on screen and in CSV, Excel and PDF, for the same filters." />
      <Async loading={loading} error={error}>{() => (
        <div className="grid two">
          {data!.map((r) => (
            <Link key={r.id} to={`/reports/${r.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
              <h2>{r.name}</h2><p className="muted" style={{ margin: 0 }}>{r.description}</p>
            </Link>
          ))}
        </div>
      )}</Async>
    </>
  );
}

function cell(v: any, type: string) {
  if (v === null || v === undefined || v === '') return <span className="faint">—</span>;
  switch (type) {
    case 'percent': return fmtPct(v);
    case 'hours': case 'number': return fmtNum(v);
    case 'integer': return fmtNum(v, 0);
    case 'currency': return fmtMoney(v);
    case 'date': return fmtDate(v);
    case 'datetime': return String(v).replace('T', ' ').slice(0, 16);
    default: return String(v);
  }
}

/** One filter control, from the report's own parameter description. */
function FilterInput({ f, value, onChange, facilities }: { f: any; value: string; onChange: (v: string) => void; facilities: any[] }) {
  const id = `flt-${f.key}`;
  const placeholder = f.default != null ? String(f.default) : undefined;
  let input;
  if (f.type === 'facility') {
    input = <select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">All my sites</option>{facilities.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select>;
  } else if (f.type === 'choice') {
    input = <select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">{f.default ? `Default (${f.default})` : 'Any'}</option>{f.values.map((v: string) => <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>)}</select>;
  } else if (f.type === 'boolean') {
    input = <select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Default</option><option value="true">Yes</option><option value="false">No</option></select>;
  } else if (f.type === 'date') {
    input = <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  } else if (f.type === 'integer' || f.type === 'number') {
    input = <input id={id} type="number" value={value} min={f.min} max={f.max} step={f.type === 'integer' ? 1 : 'any'} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ width: 120 }} />;
  } else return null; // record ids are set by links, not typed
  return <label className="field" htmlFor={id}>{f.label}{f.ratio ? ' (0–1)' : ''}{input}</label>;
}

export function ReportView() {
  const { id } = useParams();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const facilities = useApi<any[]>('/api/facilities');
  const views = useApi<any[]>(`/api/reports/${id}/views`);
  const qs = params.toString();
  const { data: r, loading, error } = useApi<any>(`/api/reports/${id}${qs ? `?${qs}` : ''}`);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(params));
  const [viewName, setViewName] = useState('');
  const [share, setShare] = useState(false);
  const exp = useAction(async (format: 'csv' | 'xlsx' | 'pdf') => api.download(`/api/reports/${id}?${new URLSearchParams({ ...Object.fromEntries(params), format })}`, `${id}.${format}`));
  const apply = (next: Record<string, string>) => { const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '')); setDraft(clean); setParams(clean); };
  const save = useAction(async () => { await api.post(`/api/reports/${id}/views`, { name: viewName, params: Object.fromEntries(params), shared: share }); setViewName(''); await views.reload(); });
  const remove = useAction(async (vid: string) => { await api.delete(`/api/report-views/${vid}`); await views.reload(); });
  const current = (views.data ?? []).find((v) => JSON.stringify(v.params) === JSON.stringify(Object.fromEntries(params)));
  return (
    <Async loading={loading && !r} error={error}>{() => (
      <>
        <PageHead eyebrow={r.name} title={r.headline}
          sub={`${r.period ? `${fmtDate(r.period.from)} to ${fmtDate(r.period.to)} · ` : ''}${r.scope.description} · generated ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC`}
          actions={can('reports.export') && <><button disabled={exp.busy} onClick={() => exp.run('csv')}>CSV</button><button disabled={exp.busy} onClick={() => exp.run('xlsx')}>Excel</button><button disabled={exp.busy} onClick={() => exp.run('pdf')}>PDF</button></>} />
        <section className="card stack" aria-label="Filters and saved views">
          <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); apply(draft); }}>
            {(r.filterDefs ?? []).map((f: any) => <FilterInput key={f.key} f={f} value={draft[f.key] ?? ''} facilities={facilities.data ?? []} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />)}
            <button className="primary">Apply</button>
            {qs && <button type="button" className="link" onClick={() => apply({})}>Reset</button>}
          </form>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="row" htmlFor="rep-view">Saved views
              <select id="rep-view" value={current?.id ?? ''} onChange={(e) => { const v = (views.data ?? []).find((x) => x.id === e.target.value); apply(v ? Object.fromEntries(Object.entries(v.params).map(([k, x]) => [k, String(x)])) : {}); }} style={{ width: 'auto' }}>
                <option value="">{current ? '' : 'Choose a view…'}</option>
                {(views.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? ` (shared${v.mine ? '' : ` by ${v.owner}`})` : ''}</option>)}
              </select>
            </label>
            {current && (current.mine || can('tenant.admin')) && <button className="link" onClick={() => remove.run(current.id)} disabled={remove.busy}>Delete view</button>}
            <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
              <input aria-label="View name" placeholder="Name these filters" value={viewName} onChange={(e) => setViewName(e.target.value)} minLength={2} maxLength={80} required style={{ width: 200 }} />
              {can('reports.export') && <label className="row"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share with the company</label>}
              <button disabled={save.busy || viewName.trim().length < 2}>Save view</button>
            </form>
          </div>
          <ErrorNote message={save.error ?? remove.error ?? exp.error} />
        </section>
        <Kpis items={r.kpis.map((k: any) => ({ label: k.label, value: <>{cell(k.value, k.type)}{k.type === 'hours' && k.value != null ? ' h' : ''}</>, note: k.note,
          tone: k.status && k.status !== 'neutral' ? k.status : undefined }))} />
        {r.insights.length > 0 && <section className="card"><ul className="insights">{r.insights.map((i: string) => <li key={i}>{i}</li>)}</ul></section>}
        <section className="card">
          <Table rows={r.rows.map((row: any, i: number) => ({ ...row, __i: i }))} rowKey={(row) => String(row.__i)} exception={(row) => (r.exceptions ?? []).includes(row.__i)}
            empty="No records match the current scope and filters."
            columns={[...r.columns.map((c: any) => ({ key: c.key, label: `${c.label}${c.unit ? ` (${c.unit})` : ''}`, numeric: !['text', 'date', 'datetime'].includes(c.type), render: (row: any) => cell(row[c.key], c.type) })),
              ...((r.links ?? []).some(Boolean) ? [{ key: '__open', label: 'Record', render: (row: any) => (r.links[row.__i] ? <Link to={r.links[row.__i]} aria-label={`Open ${row[r.columns[0].key] ?? 'record'}`}>Open</Link> : null) }] : [])]} />
        </section>
        <div className="faint" style={{ fontSize: 12 }}>
          <p>— = no data available (not zero).{r.exceptions?.length ? ' Rows marked with a red edge need attention.' : ''}</p>
          {r.notes.map((n: string) => <p key={n} style={{ margin: '2px 0' }}>{n}</p>)}
          <p>Source: {r.source}.</p>
        </div>
      </>
    )}</Async>
  );
}
