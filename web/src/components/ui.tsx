import type { ReactNode } from 'react';

export function PageHead({ eyebrow, title, sub, actions }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Async({ loading, error, children }: { loading: boolean; error?: Error; children: () => ReactNode }) {
  if (error) return <div className="notice error" role="alert">{error.message}</div>;
  if (loading) return <div className="empty">Loading…</div>;
  return <>{children()}</>;
}

export const ErrorNote = ({ message }: { message: string | null | undefined }) =>
  message ? <div className="notice error" role="alert">{message}</div> : null;

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

type Tone = 'good' | 'watch' | 'bad' | 'info' | 'neutral';
const TONE: Record<string, Tone> = {
  // work orders
  planned: 'neutral', scheduled: 'info', in_progress: 'info', on_hold: 'watch', completed: 'watch', verified: 'good', closed: 'good', cancelled: 'neutral',
  // asset states
  running: 'good', available: 'good', idle: 'neutral', planned_downtime: 'watch', unplanned_downtime: 'bad', out_of_service: 'bad',
  // MOC
  draft: 'neutral', review: 'info', approved: 'info', startup_review: 'watch', in_service: 'good', rejected: 'bad',
  // training & qualifications
  assigned: 'neutral', active: 'good', expiring: 'watch', expired: 'bad', revoked: 'bad', not_held: 'neutral',
  // generic
  open: 'neutral', done: 'good', pending: 'info', high: 'bad', medium: 'watch', low: 'neutral',
};
export function Pill({ value, label, tone }: { value?: string | null; label?: string; tone?: Tone }) {
  if (!value && !label) return <span className="faint">—</span>;
  const t = tone ?? TONE[value ?? ''] ?? 'neutral';
  return <span className={`pill ${t === 'neutral' ? '' : t}`}>{label ?? (value ?? '').replace(/_/g, ' ')}</span>;
}

export function Kpis({ items }: { items: { label: string; value: ReactNode; tone?: 'good' | 'watch' | 'bad'; note?: string }[] }) {
  return (
    <section className="kpis" aria-label="Key figures">
      {items.map((k) => (
        <div key={k.label} className={`kpi ${k.tone ?? ''}`}>
          <div className="v">{k.value}</div>
          <div className="l">{k.label}{k.note ? ` · ${k.note}` : ''}</div>
        </div>
      ))}
    </section>
  );
}

export interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; numeric?: boolean }
export function Table<T extends Record<string, any>>({ rows, columns, onRow, empty, rowKey, exception }: {
  rows: T[]; columns: Column<T>[]; onRow?: (row: T) => void; empty?: ReactNode; rowKey?: (row: T) => string; exception?: (row: T) => boolean;
}) {
  if (!rows.length) return <Empty>{empty ?? 'Nothing to show.'}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.numeric ? 'n' : ''} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r) : (r.id ?? i)} className={`${onRow ? 'click' : ''} ${exception?.(r) ? 'exception' : ''}`}
              onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined}
              onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(r); } : undefined}>
              {columns.map((c) => <td key={c.key} className={c.numeric ? 'n' : ''}>{c.render ? c.render(r) : (r[c.key] ?? <span className="faint">—</span>)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
