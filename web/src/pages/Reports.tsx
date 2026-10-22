import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Table } from '../components/ui';
import { fmtDate, fmtMoney, fmtNum, fmtPct } from '../format';
import { useAction, useApi } from '../hooks';

export function Reports() {
  const { data, loading, error } = useApi<any[]>('/api/reports');
  return (
    <>
      <PageHead eyebrow="Reports" title="Reports" sub="Every report shows the same numbers on screen, in CSV and in PDF." />
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

export function ReportView() {
  const { id } = useParams();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const [facilityId, setFacilityId] = useState('');
  const qs = facilityId ? `?facilityId=${facilityId}` : '';
  const { data: r, loading, error } = useApi<any>(`/api/reports/${id}${qs}`);
  const exp = useAction(async (format: 'csv' | 'pdf') => api.download(`/api/reports/${id}?format=${format}${facilityId ? `&facilityId=${facilityId}` : ''}`, `${id}.${format}`));
  return (
    <Async loading={loading && !r} error={error}>{() => (
      <>
        <PageHead eyebrow={r.name} title={r.headline}
          sub={`${r.period ? `${fmtDate(r.period.from)} to ${fmtDate(r.period.to)} · ` : ''}${r.scope.description} · generated ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC`}
          actions={<>
            <select id="rep-fac" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} aria-label="Facility" style={{ width: 'auto' }}>
              <option value="">All my facilities</option>{(facilities.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.code}</option>)}
            </select>
            {can('reports.export') && <><button disabled={exp.busy} onClick={() => exp.run('csv')}>CSV</button><button disabled={exp.busy} onClick={() => exp.run('pdf')}>PDF</button></>}
          </>} />
        <ErrorNote message={exp.error} />
        <Kpis items={r.kpis.map((k: any) => ({ label: k.label, value: <>{cell(k.value, k.type)}{k.type === 'hours' && k.value != null ? ' h' : ''}</>, note: k.note,
          tone: k.status && k.status !== 'neutral' ? k.status : undefined }))} />
        {r.insights.length > 0 && <section className="card"><ul className="insights">{r.insights.map((i: string) => <li key={i}>{i}</li>)}</ul></section>}
        <section className="card">
          <Table rows={r.rows.map((row: any, i: number) => ({ ...row, __i: i }))} rowKey={(row) => String(row.__i)} exception={(row) => (r.exceptions ?? []).includes(row.__i)}
            empty="No records match the current scope and filters."
            columns={r.columns.map((c: any) => ({ key: c.key, label: `${c.label}${c.unit ? ` (${c.unit})` : ''}`, numeric: !['text', 'date', 'datetime'].includes(c.type), render: (row: any) => cell(row[c.key], c.type) }))} />
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
