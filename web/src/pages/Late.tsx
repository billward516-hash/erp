import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Kpis, PageHead, Table } from '../components/ui';
import { fmtMoney } from '../format';
import { useApi } from '../hooks';

/** Everything past its date, across invoices, bills, quotes, orders, work, maintenance, calibration and reviews (SC-005). */
export function Late() {
  const { data, loading, error } = useApi<any>('/api/what-is-late');
  const [byOwner, setByOwner] = useState(false);
  return (
    <>
      <PageHead eyebrow="Insight" title="What is late" sub="Every date that has passed that you can see: money owed in either direction, quotes and orders, work and maintenance, calibration and reviews."
        actions={<label className="row"><input type="checkbox" checked={byOwner} onChange={(e) => setByOwner(e.target.checked)} /> Group by owner</label>} />
      <Async loading={loading && !data} error={error}>{() => {
        const sections: any[] = data.sections;
        const owners = new Map<string, { owner: string; rows: any[] }>();
        for (const s of sections) for (const r of s.rows) { const k = r.owner ?? 'No owner recorded'; const g: { owner: string; rows: any[] } = owners.get(k) ?? { owner: k, rows: [] as any[] }; g.rows.push({ ...r, section: s.title }); owners.set(k, g); }
        return (
          <>
            <p className="answer">{data.answer}</p>
            <Kpis items={sections.slice(0, 5).map((s) => ({ label: s.title, value: s.count, tone: 'watch' as const, note: s.amount != null ? fmtMoney(s.amount) : undefined }))} />
            {byOwner ? [...owners.values()].sort((a, b) => b.rows.length - a.rows.length).map((g) => (
              <section key={g.owner} className="card stack" aria-label={g.owner}>
                <h2>{g.owner} <span className="muted" style={{ fontWeight: 400 }}>· {g.rows.length}</span></h2>
                <Table rows={g.rows} rowKey={(r) => `${r.section}-${r.label}`} columns={[{ key: 'section', label: 'Kind' }, { key: 'label', label: 'Item', render: (r: any) => <Link to={r.href}>{r.label}</Link>, value: (r: any) => r.label },
                  { key: 'daysLate', label: 'Days late', numeric: true }, { key: 'amount', label: 'Amount', numeric: true, render: (r: any) => (r.amount != null ? fmtMoney(r.amount) : ''), value: (r: any) => r.amount }]} />
              </section>)) : sections.map((s) => (
              <section key={s.key} className="card stack" aria-label={s.title}>
                <h2>{s.title} <span className="muted" style={{ fontWeight: 400 }}>· {s.count}{s.amount != null ? ` · ${fmtMoney(s.amount)}` : ''}</span></h2>
                <Table rows={s.rows} rowKey={(r) => r.label} columns={[{ key: 'label', label: 'Item', render: (r: any) => <Link to={r.href}>{r.label}</Link>, value: (r: any) => r.label }, { key: 'detail', label: 'What' },
                  { key: 'owner', label: 'Owner' }, { key: 'daysLate', label: 'Days late', numeric: true }, { key: 'amount', label: 'Amount', numeric: true, render: (r: any) => (r.amount != null ? fmtMoney(r.amount) : ''), value: (r: any) => r.amount }]} />
                {s.count > s.rows.length && <p className="faint" style={{ margin: 0 }}>Showing the {s.rows.length} most overdue of {s.count}.</p>}
              </section>))}
          </>
        );
      }}</Async>
    </>
  );
}
