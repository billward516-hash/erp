import { useMemo, useState } from 'react';
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

export interface Column<T> {
  key: string; label: string; render?: (row: T) => ReactNode; numeric?: boolean;
  /** What to sort and search by when the cell shows something other than the row's own value (a formatted date, a pill). */
  value?: (row: T) => string | number | null | undefined;
  /** Switch sorting and the column filter off for this column (action buttons, free-form content). */
  plain?: boolean;
}

const cellValue = <T extends Record<string, any>>(c: Column<T>, r: T): string | number | null => {
  const v = c.value ? c.value(r) : r[c.key];
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  return null;
};
const compare = (a: string | number | null, b: string | number | null) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // blanks last whichever way it is sorted
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};
const rowText = <T extends Record<string, any>>(columns: Column<T>[], r: T) =>
  [...columns.map((c) => cellValue(c, r)), ...Object.values(r).filter((v) => typeof v === 'string' || typeof v === 'number')].filter((v) => v != null).join(' ').toLowerCase();

/**
 * Lists: click a heading to sort (again to reverse, a third time to clear), search the rows shown, and filter by column.
 * The tools appear once a table has 8 or more rows (`tools` forces them on or off) and work on the rows already loaded;
 * pages that fetch a limited list say so in their own filters. Sorting never changes the order a page chose until asked.
 */
export function Table<T extends Record<string, any>>({ rows, columns, onRow, empty, rowKey, exception, tools }: {
  rows: T[]; columns: Column<T>[]; onRow?: (row: T) => void; empty?: ReactNode; rowKey?: (row: T) => string; exception?: (row: T) => boolean; tools?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const withTools = tools ?? rows.length >= 8;
  const sortable = (c: Column<T>) => !c.plain && rows.some((r) => cellValue(c, r) != null);
  const shown = useMemo(() => {
    let out = rows;
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((r) => q.split(/\s+/).every((w) => rowText(columns, r).includes(w)));
    for (const [key, text] of Object.entries(filters)) {
      const c = columns.find((x) => x.key === key); const t = text.trim().toLowerCase();
      if (c && t) out = out.filter((r) => String(cellValue(c, r) ?? '').toLowerCase().includes(t));
    }
    const c = sort && columns.find((x) => x.key === sort.key);
    if (c && sort) out = [...out].sort((x, y) => sort.dir * compare(cellValue(c, x), cellValue(c, y)));
    return out;
  }, [rows, columns, sort, search, filters]);
  if (!rows.length) return <Empty>{empty ?? 'Nothing to show.'}</Empty>;
  const narrowed = !!search.trim() || Object.values(filters).some((v) => v.trim());
  const clickSort = (key: string) => setSort((s) => (!s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));
  return (
    <div className="table-wrap">
      {withTools && (
        <div className="table-tools row" role="search">
          <input type="search" aria-label="Search this table" placeholder="Search this table" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
          <button type="button" className="link" aria-pressed={showFilters} onClick={() => setShowFilters((v) => !v)}>{showFilters ? 'Hide column filters' : 'Column filters'}</button>
          {(narrowed || sort) && <button type="button" className="link" onClick={() => { setSearch(''); setFilters({}); setSort(null); }}>Reset</button>}
          <span className="faint" aria-live="polite">{narrowed ? `Showing ${shown.length} of ${rows.length}` : `${rows.length} rows`}</span>
        </div>
      )}
      <table>
        <thead>
          <tr>{columns.map((c) => {
            const can = withTools && sortable(c); const on = sort?.key === c.key;
            return (
              <th key={c.key} className={c.numeric ? 'n' : ''} scope="col" aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}>
                {can ? <button type="button" className="sort" onClick={() => clickSort(c.key)} title="Sort by this column">{c.label}<span aria-hidden="true">{on ? (sort!.dir === 1 ? ' ▲' : ' ▼') : ''}</span></button> : c.label}
              </th>);
          })}</tr>
          {withTools && showFilters && (
            <tr className="filters">{columns.map((c) => (
              <th key={c.key} scope="col">{sortable(c) ? <input aria-label={`Filter ${c.label}`} placeholder="contains…" value={filters[c.key] ?? ''} onChange={(e) => setFilters({ ...filters, [c.key]: e.target.value })} /> : null}</th>))}</tr>
          )}
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={rowKey ? rowKey(r) : (r.id ?? i)} className={`${onRow ? 'click' : ''} ${exception?.(r) ? 'exception' : ''}`}
              onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined}
              onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(r); } : undefined}>
              {columns.map((c) => <td key={c.key} className={c.numeric ? 'n' : ''}>{c.render ? c.render(r) : (r[c.key] ?? <span className="faint">—</span>)}</td>)}
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={columns.length} className="faint">Nothing matches. <button type="button" className="link" onClick={() => { setSearch(''); setFilters({}); }}>Clear the search and filters</button></td></tr>}
        </tbody>
      </table>
    </div>
  );
}
