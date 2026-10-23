import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

/** Lots and serial numbers (D-147): what is in stock by lot, expiry and holds, and each lot's trace. */
const today = () => new Date().toISOString().slice(0, 10);
const StatusPill = ({ l }: { l: any }) => (l.status === 'hold' ? <Pill tone="bad" label="On hold" /> : l.status === 'scrapped' ? <Pill tone="neutral" label="Scrapped" />
  : l.expires_on && String(l.expires_on).slice(0, 10) < today() ? <Pill tone="bad" label="Expired" /> : <Pill tone="good" label="Available" />);

export function LotList() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(filter === 'hold' ? { status: 'hold' } : filter === 'expiring' ? { expiringDays: '30' } : {}) }).toString();
  const { data, loading, error } = useApi<any[]>(`/api/lots${qs ? `?${qs}` : ''}`);
  return (
    <section className="card stack">
      <div className="spread">
        <h2>Lots and serial numbers</h2>
        <div className="row">
          <input aria-label="Search lots" placeholder="Lot, serial, supplier lot or part" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
          <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">In stock</option><option value="expiring">Expired or expiring within 30 days</option><option value="hold">On hold</option>
          </select>
        </div>
      </div>
      <p className="muted">Parts with lot or serial tracking switched on (on the part, in Stock). Issues and shipments take the first lot to expire unless someone chooses another; lots on hold or past expiry are never issued or shipped.</p>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data!} onRow={(l) => nav(`/inventory/lots/${l.id}`)} empty="No tracked stock."
          columns={[{ key: 'part_number', label: 'Part', render: (l) => <>{l.part_number}<div className="faint">{l.description}</div></> },
            { key: 'number', label: 'Lot / serial', render: (l) => <>{l.number}{l.supplier_lot ? <div className="faint">supplier {l.supplier_lot}</div> : null}</> },
            { key: 'on_hand', label: 'On hand', numeric: true, render: (l) => `${fmtNum(l.on_hand, 3)} ${l.uom}` },
            { key: 'locations', label: 'Where', render: (l) => (l.locations ?? []).map((x: any) => `${x.location} ${fmtNum(x.qty, 3)}`).join(', ') || '—' },
            { key: 'expires_on', label: 'Expires', render: (l) => (l.expires_on ? fmtDate(l.expires_on) : '—') },
            { key: 'status', label: 'Status', render: (l) => <StatusPill l={l} /> }]} />
      )}</Async>
    </section>
  );
}

export function LotDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: l, loading, error, reload } = useApi<any>(`/api/lots/${id}`);
  const [reason, setReason] = useState('');
  const [recall, setRecall] = useState<any>(null);
  const hold = useAction(async (on: boolean) => { await api.post(`/api/lots/${id}/hold`, { hold: on, reason: on ? reason : null }); setReason(''); await reload(); });
  const trace = useAction(async () => setRecall(await api.get(`/api/lots/${id}/trace`)));
  return (
    <Async loading={loading && !l} error={error}>{() => (
      <>
        <PageHead eyebrow={`${l.part_number} · ${l.kind === 'serial' ? 'Serial number' : 'Lot'}`} title={<>{l.number} <span className="muted" style={{ fontWeight: 400 }}>{l.description}</span></>}
          sub={<>{l.source === 'production' ? <>Made on <Link to={`/production/orders/${l.production_order_id ?? ''}`}>{l.production_order}</Link></> : `${l.supplier ? `From ${l.supplier}` : humanize(l.source)}${l.supplier_lot ? `, supplier lot ${l.supplier_lot}` : ''}`}
            {' · '}{l.made_on ? `dated ${fmtDate(l.made_on)}` : ''}{l.expires_on ? ` · expires ${fmtDate(l.expires_on)}` : ''}</>}
          actions={<><StatusPill l={l} /><button onClick={() => void api.openPost('/api/labels/pdf', { kind: 'lot', ids: [l.id] })}>Print label</button></>} />
        <Kpis items={[{ label: 'On hand', value: `${fmtNum(l.on_hand, 3)} ${l.uom}` }, { label: 'Went into production', value: fmtNum(l.wentInto.reduce((s: number, x: any) => s + x.qty, 0), 3) },
          { label: 'Shipped to customers', value: fmtNum(l.shipped.reduce((s: number, x: any) => s + x.qty, 0), 3) }, { label: 'Used on equipment', value: fmtNum(l.usedOn.reduce((s: number, x: any) => s + x.qty, 0), 3) }]} />
        {l.status === 'hold' && <div className="notice warn">On hold: {l.hold_reason}</div>}
        {can('inventory.manage') && l.status !== 'scrapped' && (
          <section className="card">
            {l.status === 'hold'
              ? <div className="row"><button onClick={() => hold.run(false)} disabled={hold.busy}>Release the hold</button><ErrorNote message={hold.error} /></div>
              : <form className="row" onSubmit={(e) => { e.preventDefault(); void hold.run(true); }}>
                <input aria-label="Reason for the hold" placeholder="Why this lot must not be used or shipped" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 320px' }} />
                <button className="danger" disabled={hold.busy || reason.trim().length < 3}>Put on hold</button><ErrorNote message={hold.error} />
              </form>}
          </section>
        )}
        {l.locations?.length > 0 && (
          <section className="card"><h2>Where it is</h2>
            <Table rows={l.locations} columns={[{ key: 'location', label: 'Storeroom' }, { key: 'qty', label: 'On hand', numeric: true, render: (x) => fmtNum(x.qty, 3) }]} />
          </section>
        )}
        {l.madeFrom.length > 0 && (
          <section className="card"><h2>Made from</h2>
            <Table rows={l.madeFrom} onRow={undefined} columns={[{ key: 'part_number', label: 'Component' }, { key: 'number', label: 'Lot', render: (x) => <Link to={`/inventory/lots/${x.id}`}>{x.number}</Link> },
              { key: 'supplier', label: 'Supplier', render: (x) => <>{x.supplier ?? '—'}{x.supplier_lot ? <span className="faint"> (lot {x.supplier_lot})</span> : null}</> },
              { key: 'qty', label: 'Used', numeric: true, render: (x) => `${fmtNum(x.qty, 3)} ${x.uom}` }]} />
          </section>
        )}
        <section className="card stack">
          <div className="spread"><h2>Where it went</h2><button onClick={() => trace.run()} disabled={trace.busy}>Find every customer who received it</button></div>
          {l.wentInto.length > 0 && <Table rows={l.wentInto} columns={[{ key: 'number', label: 'Production order', render: (x) => <Link to={`/production/orders/${x.id}`}>{x.number}</Link> },
            { key: 'part_number', label: 'Made' }, { key: 'qty', label: 'Used', numeric: true, render: (x) => fmtNum(x.qty, 3) },
            { key: 'made_lots', label: 'Lots made', render: (x) => (x.made_lots ?? []).map((m: any, i: number) => <span key={m.id}>{i ? ', ' : ''}<Link to={`/inventory/lots/${m.id}`}>{m.number}</Link></span>) }]} />}
          {l.shipped.length > 0 && <Table rows={l.shipped} columns={[{ key: 'shipped_on', label: 'Shipped', render: (x) => fmtDate(x.shipped_on) }, { key: 'shipment', label: 'Shipment' },
            { key: 'customer', label: 'Customer', render: (x) => <Link to={`/crm/customers/${x.customer_id}`}>{x.customer}</Link> }, { key: 'order_number', label: 'Order', render: (x) => <Link to={`/sales/orders/${x.order_id}`}>{x.order_number}</Link> },
            { key: 'qty', label: 'Qty', numeric: true, render: (x) => fmtNum(x.qty, 3) }]} />}
          {l.usedOn.length > 0 && <Table rows={l.usedOn} columns={[{ key: 'number', label: 'Work order', render: (x) => <Link to={`/work-orders/${x.id}`}>{x.number}</Link> },
            { key: 'asset_tag', label: 'Asset', render: (x) => `${x.asset_tag} ${x.asset}` }, { key: 'qty', label: 'Used', numeric: true, render: (x) => fmtNum(x.qty, 3) }]} />}
          {!l.wentInto.length && !l.shipped.length && !l.usedOn.length && <p className="muted">Not used or shipped yet.</p>}
          <ErrorNote message={trace.error} />
          {recall && (
            <div className="stack">
              <p className="answer">{recall.customers.length ? `${recall.customers.length} customer${recall.customers.length === 1 ? '' : 's'} received ${l.number} or something made from it.` : `No customer has received ${l.number} or anything made from it.`}</p>
              {recall.customers.length > 0 && <Table rows={recall.customers.flatMap((c: any) => c.shipments.map((s: any) => ({ ...s, customer: c.customer })))}
                columns={[{ key: 'customer', label: 'Customer' }, { key: 'part_number', label: 'Part' }, { key: 'lot', label: 'Lot' }, { key: 'shipment', label: 'Shipment' },
                  { key: 'shipped_on', label: 'Shipped', render: (x) => fmtDate(x.shipped_on) }, { key: 'qty', label: 'Qty', numeric: true, render: (x) => fmtNum(x.qty, 3) }]} />}
              <p className="faint">Followed {recall.lots.length} lot{recall.lots.length === 1 ? '' : 's'} through production.</p>
            </div>
          )}
        </section>
        <section className="card"><h2>Movements</h2>
          <Table rows={l.movements} empty="None."
            columns={[{ key: 'created_at', label: 'When', render: (m) => fmtDateTime(m.created_at) }, { key: 'txn_type', label: 'Movement', render: (m) => humanize(m.txn_type) },
              { key: 'qty', label: 'Qty', numeric: true, render: (m) => (m.qty > 0 ? `+${fmtNum(m.qty, 3)}` : fmtNum(m.qty, 3)) }, { key: 'location', label: 'Storeroom' },
              { key: 'ref', label: 'Reference', render: (m) => (m.work_order ? <Link to={`/work-orders/${m.work_order_id}`}>{m.work_order}</Link> : m.production_order ? <Link to={`/production/orders/${m.production_order_id}`}>{m.production_order}</Link> : m.reference ?? m.reason) },
              { key: 'by', label: 'By' }]} />
        </section>
      </>
    )}</Async>
  );
}

/** Tracking switch on a part, counting any stock on hand into lots at the same moment. */
export function PartTracking({ part, stock, onDone }: { part: any; stock: { location_id: string; location: string; qty: number }[]; onDone: () => void }) {
  const { can } = useAuth();
  const [mode, setMode] = useState<string>(part.tracking ?? 'none');
  const [shelf, setShelf] = useState(part.shelf_life_days ? String(part.shelf_life_days) : '');
  const [existing, setExisting] = useState<Record<string, { lot: string; expiresOn: string }>>({});
  const save = useAction(async () => {
    await api.put(`/api/parts/${part.id}/tracking`, { tracking: mode, shelfLifeDays: shelf ? Number(shelf) : null,
      existing: mode !== 'none' && part.tracking === 'none' ? stock.filter((s) => s.qty > 0).map((s) => ({ locationId: s.location_id, lot: existing[s.location_id]?.lot ?? '', qty: s.qty, expiresOn: existing[s.location_id]?.expiresOn || null })) : undefined });
    onDone();
  });
  if (!can('parts.manage')) return <p className="muted">Tracking: {part.tracking === 'none' ? 'off' : part.tracking === 'lot' ? 'by lot' : 'by serial number'}.</p>;
  const counting = mode === 'lot' && part.tracking === 'none' && stock.some((s) => s.qty > 0);
  return (
    <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <h3>Lot and serial tracking</h3>
      <div className="row">
        <select aria-label="Tracking" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="none">Not tracked</option><option value="lot">By lot</option><option value="serial">By serial number</option>
        </select>
        <label className="row">Shelf life<input aria-label="Shelf life in days" type="number" min="1" value={shelf} onChange={(e) => setShelf(e.target.value)} style={{ width: 90 }} /> days</label>
        <button disabled={save.busy}>Save</button>
      </div>
      {counting && (
        <div className="stack" style={{ gap: 4 }}>
          <p className="muted">Stock already on hand goes into a lot now:</p>
          {stock.filter((s) => s.qty > 0).map((s) => (
            <div className="row" key={s.location_id}>
              <span style={{ width: 160 }}>{s.location}: {fmtNum(s.qty, 3)} {part.uom}</span>
              <input aria-label={`Lot for stock at ${s.location}`} placeholder="Lot" value={existing[s.location_id]?.lot ?? ''} onChange={(e) => setExisting({ ...existing, [s.location_id]: { ...existing[s.location_id], lot: e.target.value, expiresOn: existing[s.location_id]?.expiresOn ?? '' } })} style={{ width: 140 }} />
              <input aria-label={`Expiry for stock at ${s.location}`} type="date" value={existing[s.location_id]?.expiresOn ?? ''} onChange={(e) => setExisting({ ...existing, [s.location_id]: { lot: existing[s.location_id]?.lot ?? '', expiresOn: e.target.value } })} />
            </div>
          ))}
        </div>
      )}
      {mode === 'serial' && part.tracking === 'none' && stock.some((s) => s.qty > 0) && <p className="notice warn">Count the stock out to zero before tracking by serial number, or track by lot.</p>}
      <ErrorNote message={save.error} />
    </form>
  );
}
