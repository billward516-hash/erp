import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Async, Empty, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const PROVIDERS: Record<string, string> = {
  file_export: 'File export: a CSV of approved bills to import into any accounting system',
  mock_accounting: 'MOCK accounting system: for demos and testing only, not a real connection',
};

export function Integrations() {
  const conns = useApi<any[]>('/api/integrations');
  const active = conns.data?.find((c) => c.active);
  const [result, setResult] = useState<any>(null);
  const [runs, setRuns] = useState(0);
  const sync = useAction(async () => { setResult(await api.post('/api/integrations/sync')); await conns.reload(); setRuns((n) => n + 1); });
  return (
    <>
      <PageHead eyebrow="Settings" title="Accounting connection"
        sub="Approved supplier invoices are sent to your accounting system as bills; payment status comes back from it. Your accounting system stays the book of record."
        actions={active ? <button className="primary" disabled={sync.busy} onClick={() => sync.run()}>Sync now</button> : undefined} />
      <ErrorNote message={sync.error} />
      {result && <div className="notice ok">Sync finished: {result.delivered} sent, {result.failed} will retry, {result.dead} need attention, {result.payments} payment{result.payments === 1 ? '' : 's'} received.</div>}
      <Async loading={conns.loading && !conns.data} error={conns.error}>{() => (active ? <Connection key={`${active.id}:${runs}`} c={active} onChange={conns.reload} /> : <Connect onDone={conns.reload} />)}</Async>
      <Mappings />
    </>
  );
}

function Connect({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState('file_export');
  const [backfill, setBackfill] = useState('all');
  const act = useAction(async () => { await api.post('/api/integrations', { provider, backfill }); onDone(); });
  return (
    <section className="card stack">
      <h2>Connect</h2>
      <p className="muted">QuickBooks Online and Xero connections will be added for the first pilot customer's system. Until then, use the file export.</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
        <fieldset className="stack" style={{ border: 0, padding: 0 }}>
          {Object.entries(PROVIDERS).map(([k, v]) => <label key={k} className="row"><input type="radio" name="provider" value={k} checked={provider === k} onChange={() => setProvider(k)} /> {v}</label>)}
        </fieldset>
        <label className="field">Approved invoices not yet sent<select id="conn-backfill" value={backfill} onChange={(e) => setBackfill(e.target.value)}>
          <option value="all">Send them with the first sync</option><option value="none">Only send invoices approved from now on</option></select></label>
        <ErrorNote message={act.error} />
        <div><button className="primary" disabled={act.busy}>Connect</button></div>
      </form>
    </section>
  );
}

function Connection({ c, onChange }: { c: any; onChange: () => void }) {
  const [status, setStatus] = useState<string>('');
  const deliveries = useApi<any[]>(`/api/integrations/${c.id}/deliveries${status ? `?status=${status}` : ''}`);
  const files = useApi<any[]>(c.provider === 'file_export' ? `/api/integrations/${c.id}/files` : null);
  const off = useAction(async () => { await api.post(`/api/integrations/${c.id}/disconnect`); onChange(); });
  const retry = useAction(async (id: number) => { await api.post(`/api/sync-deliveries/${id}/retry`); await deliveries.reload(); onChange(); });
  const [notes, setNotes] = useState<Record<number, string>>({});
  const resolve = useAction(async (id: number) => { await api.post(`/api/sync-deliveries/${id}/resolve`, { note: notes[id] }); await deliveries.reload(); onChange(); });
  return (
    <>
      {c.is_mock && <div className="notice warn" role="note"><strong>MOCK connection.</strong> Bills go to a simulated accounting system inside this platform, for demos and testing. Nothing reaches a real accounting system.</div>}
      <section className="card stack">
        <div className="spread">
          <h2>{c.label}</h2>
          <div className="row">{c.is_mock ? <Pill tone="watch" label="MOCK" /> : <Pill tone="good" label="Connected" />}<button onClick={() => off.run()} disabled={off.busy}>Disconnect</button></div>
        </div>
        <div className="row">
          <span>{c.delivered} sent</span>·<span>{c.pending} queued</span>·<span className={c.dead ? 'bad-text' : ''}>{c.dead} need attention</span>·<span className="muted">last sent {fmtDateTime(c.last_delivery)}</span>
        </div>
        <ErrorNote message={off.error} />
      </section>
      <section className="card stack">
        <div className="spread">
          <h2>Sync queue</h2>
          <div className="row" role="group" aria-label="Filter">
            {[['', 'All'], ['dead', 'Needs attention'], ['pending', 'Queued'], ['delivered', 'Sent']].map(([k, l]) => <button key={k} className={status === k ? 'primary' : ''} onClick={() => setStatus(k!)}>{l}</button>)}
          </div>
        </div>
        <Async loading={deliveries.loading && !deliveries.data} error={deliveries.error}>{() => (
          <Table rows={deliveries.data ?? []} empty="Nothing here." exception={(d) => d.status === 'dead'}
            columns={[{ key: 'event_at', label: 'Queued', render: (d) => fmtDateTime(d.event_at) }, { key: 'topic', label: 'What', render: (d) => (d.topic === 'ap.bill.voided' ? 'Void bill' : 'Create bill') },
              { key: 'invoice_number', label: 'Invoice', render: (d) => <Link to={`/ap/${d.aggregate_id}`}>{d.invoice_number}</Link> }, { key: 'supplier_name', label: 'Supplier' },
              { key: 'status', label: 'Status', render: (d) => <Pill tone={d.status === 'delivered' ? 'good' : d.status === 'dead' ? 'bad' : d.status === 'pending' ? 'info' : 'neutral'} label={d.status === 'dead' ? 'Needs attention' : humanize(d.status)} /> },
              { key: 'attempts', label: 'Tries', numeric: true }, { key: 'external_id', label: 'Reference', render: (d) => d.external_id ?? d.resolution_note ?? '—' },
              { key: 'last_error', label: 'Problem', render: (d) => (d.status === 'delivered' ? '' : d.last_error) },
              { key: 'act', label: '', render: (d) => (d.status === 'dead' ? (
                <div className="row">
                  <button onClick={() => retry.run(d.id)} disabled={retry.busy}>Retry</button>
                  <input aria-label="How it was resolved" placeholder="Entered by hand as…" value={notes[d.id] ?? ''} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })} style={{ width: 160 }} />
                  <button onClick={() => resolve.run(d.id)} disabled={resolve.busy || (notes[d.id] ?? '').trim().length < 3}>Mark resolved</button>
                </div>) : null) }]} />
        )}</Async>
        <ErrorNote message={retry.error ?? resolve.error} />
        <p className="faint">Failed sends retry after 1, 5, 30, 120 and 720 minutes, then wait here for a person. Retrying never creates a duplicate bill: each send carries a unique key.</p>
      </section>
      {c.provider === 'file_export' && (
        <section className="card">
          <h2>Export files</h2>
          <Table rows={files.data ?? []} empty="No files yet. Approve invoices, then sync."
            columns={[{ key: 'file_name', label: 'File' }, { key: 'row_count', label: 'Rows', numeric: true }, { key: 'created_at', label: 'Created', render: (x) => fmtDateTime(x.created_at) },
              { key: 'downloaded_at', label: 'Downloaded', render: (x) => fmtDateTime(x.downloaded_at) },
              { key: 'dl', label: '', render: (x) => <button onClick={async () => { await api.download(`/api/export-files/${x.id}`, x.file_name); await files.reload(); }}>Download</button> }]} />
        </section>
      )}
      {c.is_mock && <MockPanel c={c} />}
    </>
  );
}

/** Controls for the simulated accounting system: pay a bill "in accounting", or simulate an outage. */
function MockPanel({ c }: { c: any }) {
  const bills = useApi<any[]>(`/api/integrations/${c.id}/mock/bills`);
  const pay = useAction(async (externalId: string) => { await api.post(`/api/integrations/${c.id}/mock/pay`, { externalId }); await bills.reload(); });
  const outage = useAction(async (failures: number) => { await api.post(`/api/integrations/${c.id}/mock/outage`, { failures }); });
  return (
    <section className="card stack">
      <div className="spread"><h2>Inside the MOCK accounting system</h2><Pill tone="watch" label="MOCK" /></div>
      <Table rows={bills.data ?? []} rowKey={(b) => b.external_id} empty="No bills yet."
        columns={[{ key: 'external_id', label: 'Bill' }, { key: 'vendor_id', label: 'Vendor' }, { key: 'supplier', label: 'Supplier' }, { key: 'invoice_number', label: 'Invoice' },
          { key: 'total', label: 'Total', numeric: true }, { key: 'status', label: 'Status', render: (b) => <Pill tone={b.status === 'paid' ? 'good' : b.status === 'void' ? 'neutral' : 'info'} label={humanize(b.status)} /> },
          { key: 'pay', label: '', render: (b) => (b.status === 'open' ? <button onClick={() => pay.run(b.external_id)} disabled={pay.busy}>Pay in accounting</button> : null) }]} />
      <div className="row">
        <button onClick={() => outage.run(3)} disabled={outage.busy}>Simulate an outage (next 3 sends fail)</button>
        <button onClick={() => outage.run(0)} disabled={outage.busy}>End outage</button>
      </div>
      <ErrorNote message={pay.error ?? outage.error} />
      <p className="faint">Payments made here reach the platform on the next sync, as they would from a real accounting system.</p>
    </section>
  );
}

function Mappings() {
  const { data, loading, error, reload } = useApi<any[]>('/api/account-mappings');
  const [edit, setEdit] = useState<Record<string, { code: string; name: string }>>({});
  const save = useAction(async (key: string) => { await api.put(`/api/account-mappings/${key}`, { externalCode: edit[key]!.code || null, externalName: edit[key]!.name || null }); setEdit(({ [key]: _, ...rest }) => rest); await reload(); });
  return (
    <section className="card stack">
      <h2>Chart of accounts</h2>
      <p className="muted">Which account in your accounting system each kind of invoice line goes to. Bills with an unmapped line wait in the queue until it is mapped.</p>
      <Async loading={loading && !data} error={error}>{() => (data!.length ? (
        <Table rows={data!} rowKey={(m) => m.key}
          columns={[{ key: 'description', label: 'Invoice lines for' },
            { key: 'code', label: 'Account number', render: (m) => <input aria-label={`Account number for ${m.key}`} value={edit[m.key]?.code ?? m.externalCode ?? ''} style={{ width: 110 }}
              onChange={(e) => setEdit({ ...edit, [m.key]: { code: e.target.value, name: edit[m.key]?.name ?? m.externalName ?? '' } })} /> },
            { key: 'name', label: 'Account name', render: (m) => <input aria-label={`Account name for ${m.key}`} value={edit[m.key]?.name ?? m.externalName ?? ''}
              onChange={(e) => setEdit({ ...edit, [m.key]: { code: edit[m.key]?.code ?? m.externalCode ?? '', name: e.target.value } })} /> },
            { key: 'save', label: '', render: (m) => (edit[m.key] ? <button onClick={() => save.run(m.key)} disabled={save.busy}>Save</button> : m.externalCode ? <Pill tone="good" label="Mapped" /> : <Pill tone="watch" label="Not mapped" />) }]} />
      ) : <Empty>No account keys.</Empty>)}</Async>
      <ErrorNote message={save.error} />
    </section>
  );
}
