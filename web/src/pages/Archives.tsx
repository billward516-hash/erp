import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const KIND: Record<string, string> = { scheduled: 'Scheduled', manual: 'Taken by hand', pre_rollback: 'Before a rollback' };
const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

/** Company archives and restore (D-165): every 30 days by default; download, bring records back, or roll the company back with a second administrator. */
export function Archives() {
  const { data, loading, error, reload } = useApi<any>('/api/archives');
  const [set, setSet] = useState<{ intervalDays: string; keepCount: string } | null>(null);
  const [rb, setRb] = useState<{ id: string; reason: string } | null>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); await reload(); });
  return (
    <>
      <PageHead eyebrow="Administration" title="Archives and restore"
        sub="A full copy of the company's data is archived on a schedule. Bring back records that were deleted or changed, or roll the whole company back to an archive; a rollback needs a second administrator." />
      <Async loading={loading && !data} error={error}>{() => {
        const pending = data.rollbacks.find((r: any) => r.status === 'pending');
        return (
          <>
            <p className="answer">{data.answer}</p>
            {pending && (
              <section className="card stack" role="alert">
                <h2>Rollback waiting for a second administrator</h2>
                <p>{pending.requested_by_name} asked {fmtDateTime(pending.requested_at)} to roll the company back to the archive of {fmtDateTime(pending.archive_created_at)}: “{pending.reason}”.
                  Everything entered since then will be replaced; users, sign-in, the audit trail and record numbers are kept, and the present state is archived first so it can be undone.</p>
                <div className="row">
                  {pending.requested_by !== data.me
                    ? <button className="primary" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/rollbacks/${pending.id}/confirm`))}>Confirm the rollback</button>
                    : <span className="muted">Another administrator must confirm it within 24 hours.</span>}
                  <button disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/rollbacks/${pending.id}/cancel`))}>Cancel it</button>
                </div>
              </section>
            )}
            <section className="card stack">
              <div className="spread">
                <h2>Archives</h2>
                <div className="row">
                  {!set && <button onClick={() => setSet({ intervalDays: String(data.settings.intervalDays), keepCount: String(data.settings.keepCount) })}>Schedule: every {data.settings.intervalDays} days, keep {data.settings.keepCount}</button>}
                  <button className="primary" disabled={act.busy} onClick={() => void act.run(() => api.post('/api/archives', {}))}>{act.busy ? 'Archiving…' : 'Archive now'}</button>
                </div>
              </div>
              {set && (
                <form className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api.put('/api/archives/settings', { intervalDays: Number(set.intervalDays), keepCount: Number(set.keepCount) }); setSet(null); }); }}>
                  <label className="field">Archive every (days)<input id="arch-interval" type="number" min="1" max="90" value={set.intervalDays} onChange={(e) => setSet({ ...set, intervalDays: e.target.value })} /></label>
                  <label className="field">Scheduled archives kept<input id="arch-keep" type="number" min="1" max="120" value={set.keepCount} onChange={(e) => setSet({ ...set, keepCount: e.target.value })} /></label>
                  <button className="primary" disabled={act.busy}>Save</button><button type="button" onClick={() => setSet(null)}>Cancel</button>
                </form>
              )}
              <Table rows={data.archives} rowKey={(a) => a.id} empty="No archive yet."
                columns={[{ key: 'created_at', label: 'Taken', render: (a) => fmtDateTime(a.created_at) }, { key: 'kind', label: 'Kind', render: (a) => KIND[a.kind] ?? humanize(a.kind) },
                  { key: 'row_count', label: 'Records', numeric: true, render: (a) => fmtNum(a.row_count, 0) }, { key: 'size_bytes', label: 'Size', numeric: true, render: (a) => size(a.size_bytes) },
                  { key: 'created_by', label: 'By', render: (a) => a.created_by ?? 'Schedule' }, { key: 'note', label: 'Note', render: (a) => a.note ?? '' },
                  { key: 'actions', label: '', render: (a) => <div className="row">
                    <Link to={`/archives/${a.id}`}>Bring records back</Link>
                    <button className="link" onClick={() => void api.download(`/api/archives/${a.id}/download`, 'archive.json.gz')}>Download</button>
                    {!pending && <button className="link" onClick={() => setRb({ id: a.id, reason: '' })}>Roll back to this</button>}
                  </div> }]} />
              {rb && (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api.post(`/api/archives/${rb.id}/rollback`, { reason: rb.reason }); setRb(null); }); }}>
                  <p><strong>Roll the whole company back to the archive of {fmtDateTime(data.archives.find((a: any) => a.id === rb.id)?.created_at)}?</strong> Everything entered since will be replaced.
                    {data.admins < 2 && ' A second administrator must confirm, and this company has only one; add another administrator first.'}</p>
                  <label className="field">Why<input id="rb-reason" value={rb.reason} onChange={(e) => setRb({ ...rb, reason: e.target.value })} required minLength={5} placeholder="A bad import overwrote prices" /></label>
                  <div className="row"><button className="primary" disabled={act.busy || data.admins < 2}>Ask a second administrator to confirm</button><button type="button" onClick={() => setRb(null)}>Cancel</button></div>
                </form>
              )}
              <ErrorNote message={act.error} />
            </section>
            {data.rollbacks.length > 0 && (
              <section className="card stack">
                <h2>Rollbacks</h2>
                <Table rows={data.rollbacks} rowKey={(r) => r.id} columns={[{ key: 'requested_at', label: 'Asked', render: (r) => fmtDateTime(r.requested_at) },
                  { key: 'archive_created_at', label: 'Back to', render: (r) => fmtDateTime(r.archive_created_at) }, { key: 'status', label: 'Status', render: (r) => <Pill value={r.status} /> },
                  { key: 'requested_by_name', label: 'Asked by' }, { key: 'confirmed_by_name', label: 'Confirmed by', render: (r) => r.confirmed_by_name ?? '—' }, { key: 'reason', label: 'Why' },
                  { key: 'error', label: 'Result', render: (r) => r.error ?? (r.result ? `${fmtNum(r.result.inserted, 0)} records restored` : '') }]} />
              </section>
            )}
            <p className="faint">Archives hold every record the company owns, from one consistent moment, with a checksum. Sign-in tokens, single sign-on secrets and people's unsaved drafts are never archived. The platform's own database backups (for disaster recovery) are separate and run by the operator.</p>
          </>
        );
      }}</Async>
    </>
  );
}

/** One archive: pick a kind of record, find it, see whether it was deleted or changed since, and bring it back. */
export function ArchiveDetail() {
  const { id } = useParams();
  const contents = useApi<any>(`/api/archives/${id}/contents`);
  const [table, setTable] = useState(''); const [q, setQ] = useState(''); const [search, setSearch] = useState('');
  const rows = useApi<any>(table ? `/api/archives/${id}/rows?table=${table}${search ? `&q=${encodeURIComponent(search)}` : ''}` : null);
  const [picked, setPicked] = useState<string[]>([]); const [children, setChildren] = useState(true); const [done, setDone] = useState<string | null>(null);
  const restore = useAction(async () => {
    const keys = rows.data.rows.filter((r: any) => picked.includes(JSON.stringify(r.key))).map((r: any) => r.key);
    const r = await api.post(`/api/archives/${id}/restore`, { table, keys, withChildren: children });
    setDone(r.answer); setPicked([]); await rows.reload();
  });
  return (
    <>
      <PageHead eyebrow="Archives" title="Bring records back" sub={contents.data ? `From the archive of ${fmtDateTime(contents.data.archive.created_at)}.` : undefined} />
      <Async loading={contents.loading && !contents.data} error={contents.error}>{() => (
        <section className="card stack">
          <form className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); setSearch(q); }}>
            <label className="field">Kind of record<select id="arch-table" value={table} onChange={(e) => { setTable(e.target.value); setPicked([]); setDone(null); }}>
              <option value="">Choose…</option>{contents.data.tables.map((t: any) => <option key={t.name} value={t.name}>{t.label} ({fmtNum(t.rows, 0)})</option>)}</select></label>
            <label className="field" style={{ flex: '1 1 220px' }}>Find<input id="arch-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A number, name or any text in the record" /></label>
            <button disabled={!table}>Search</button>
          </form>
          {done && <p className="answer">{done}</p>}
          {table && <Async loading={rows.loading && !rows.data} error={rows.error}>{() => (
            <>
              <p className="muted">{rows.data.counts.deleted} deleted and {rows.data.counts.changed} changed since the archive; {fmtNum(rows.data.counts.now, 0)} now. Showing up to 50, deleted first.</p>
              <Table rows={rows.data.rows} rowKey={(r) => JSON.stringify(r.key)} empty="Nothing in the archive matches."
                columns={[{ key: 'pick', label: 'Bring back', render: (r) => r.state === 'same' ? '' : <input type="checkbox" aria-label={`Bring back ${summary(r.values)}`}
                    checked={picked.includes(JSON.stringify(r.key))} onChange={() => { const k = JSON.stringify(r.key); setPicked(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]); }} /> },
                  { key: 'state', label: 'Since the archive', render: (r) => <Pill tone={r.state === 'deleted' ? 'bad' : r.state === 'changed' ? 'watch' : undefined} label={r.state === 'same' ? 'Unchanged' : humanize(r.state)} /> },
                  { key: 'values', label: 'Record', render: (r) => summary(r.values) }]} />
              <div className="row">
                <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={children} onChange={(e) => setChildren(e.target.checked)} /> Include the records that belong to them (lines, steps, contacts)</label>
                <button className="primary" disabled={!picked.length || restore.busy} onClick={() => void restore.run()}>Bring back {picked.length || ''}</button>
              </div>
              <ErrorNote message={restore.error} />
            </>
          )}</Async>}
        </section>
      )}</Async>
    </>
  );
}

/** A readable line for an archived row: its number, code, name or title first. */
function summary(v: Record<string, unknown>) {
  const first = ['number', 'code', 'asset_tag', 'part_number', 'name', 'title', 'display_name', 'description', 'label'].map((k) => v[k]).filter((x) => x != null && x !== '');
  const rest = Object.entries(v).filter(([k, x]) => !/(^id$|_id$|tenant)/.test(k) && x != null && x !== '' && typeof x !== 'object').slice(0, 4).map(([k, x]) => `${humanize(k)}: ${String(x).slice(0, 40)}`);
  return [first.slice(0, 2).join(' · '), ...rest].filter(Boolean).join(' · ').slice(0, 220);
}
