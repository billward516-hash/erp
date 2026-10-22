import { useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';
import { LotEntry, type LotSpec } from '../components/Lots';
import { Link, useSearchParams } from 'react-router-dom';
import { LotList, PartTracking } from './Lots';
import { KitList } from '../components/Materials';

export function Inventory() {
  const { can } = useAuth();
  const manage = can('inventory.manage');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'stock') as 'stock' | 'counts' | 'kits' | 'lots';
  const setTab = (t: string) => setParams({ tab: t });
  return (
    <>
      <PageHead eyebrow="Maintenance" title="Storerooms" sub="Stock on hand by storeroom. Every change is a ledger entry: receipts, issues to work orders, returns, transfers, adjustments and counts." />
      <div className="row" role="tablist">
        {(['stock', 'lots', 'kits', 'counts'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>{{ stock: 'Stock', lots: 'Lots', kits: 'Kits', counts: 'Cycle counts' }[t]}</button>)}
      </div>
      {tab === 'stock' ? <Stock manage={manage} /> : tab === 'lots' ? <LotList /> : tab === 'kits' ? <KitList /> : <Counts manage={manage} />}
    </>
  );
}

function Stock({ manage }: { manage: boolean }) {
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const [sel, setSel] = useState<any>(null);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(low ? { belowReorder: 'true' } : {}) }).toString();
  const { data, loading, error, reload } = useApi<any[]>(`/api/inventory${qs ? `?${qs}` : ''}`);
  const all = useApi<any[]>('/api/inventory');
  const rows = data ?? [];
  const every = all.data ?? [];
  const value = every.reduce((s, r) => s + (r.unit_cost ?? 0) * r.qty_on_hand, 0);
  return (
    <>
      <Kpis items={[
        { label: 'Stocked lines', value: every.length },
        { label: 'At or below reorder point', value: every.filter((r) => r.below_reorder).length, tone: every.some((r) => r.below_reorder) ? 'watch' : 'good' },
        { label: 'Out of stock', value: every.filter((r) => r.qty_on_hand === 0).length, tone: every.some((r) => r.qty_on_hand === 0) ? 'bad' : 'good' },
        { label: 'Stock value', value: fmtMoney(value), note: 'average cost' },
      ]} />
      <div className="card stack">
        <div className="form-grid">
          <label className="field">Search<input id="inv-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Part number or description" /></label>
          <label className="row" style={{ alignSelf: 'end' }}><input id="inv-low" type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Only at or below reorder point</label>
        </div>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} rowKey={(r) => `${r.location_id}:${r.part_id}`} onRow={setSel} exception={(r) => r.below_reorder}
            empty={low ? 'Nothing is at or below its reorder point.' : 'No stock recorded yet. Import opening balances or receive parts.'}
            columns={[{ key: 'location', label: 'Storeroom' }, { key: 'part_number', label: 'Part', render: (r) => <strong>{r.part_number}</strong> }, { key: 'description', label: 'Description' },
              { key: 'bin', label: 'Bin' }, { key: 'qty_on_hand', label: 'On hand', numeric: true, render: (r) => <>{fmtNum(r.qty_on_hand, 3)} <span className="faint">{r.uom}</span></> },
              { key: 'reorder_point', label: 'Reorder at', numeric: true, render: (r) => fmtNum(r.reorder_point, 3) },
              { key: 'state', label: '', render: (r) => r.qty_on_hand === 0 ? <Pill tone="bad" label="Out" /> : r.below_reorder ? <Pill tone="watch" label="Reorder" /> : null },
              { key: 'last_movement', label: 'Last movement', render: (r) => fmtDate(r.last_movement) }]} />
        )}</Async>
      </div>
      {sel && <PartPanel row={sel} manage={manage} onClose={() => setSel(null)} onChanged={() => { void reload(); void all.reload(); }} />}
      {manage && <ReceiveForm onDone={() => { void reload(); void all.reload(); }} />}
    </>
  );
}

function PartPanel({ row, manage, onClose, onChanged }: { row: any; manage: boolean; onClose: () => void; onChanged: () => void }) {
  const led = useApi<any[]>(`/api/inventory/ledger?partId=${row.part_id}&locationId=${row.location_id}&limit=50`);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [rp, setRp] = useState(row.reorder_point ?? '');
  const [rq, setRq] = useState(row.reorder_qty ?? '');
  const [adjLot, setAdjLot] = useState('');
  const adjust = useAction(async () => {
    await api.post('/api/inventory/adjustments', { locationId: row.location_id, partId: row.part_id, qty: Number(qty), reason,
      lots: row.tracking !== 'none' && adjLot.trim() ? [{ lot: adjLot.trim(), qty: Math.abs(Number(qty)) }] : null });
    setQty(''); setReason(''); setAdjLot(''); onChanged(); await led.reload();
  });
  const settings = useAction(async () => {
    await api.put('/api/inventory/settings', { locationId: row.location_id, partId: row.part_id, reorderPoint: rp === '' ? null : Number(rp), reorderQty: rq === '' ? null : Number(rq) });
    onChanged();
  });
  return (
    <section className="card stack" aria-label={`${row.part_number} at ${row.location}`}>
      <div className="spread"><h2>{row.part_number} at {row.location}</h2><button onClick={onClose}>Close</button></div>
      <p className="muted">{row.description}. Average cost {fmtMoney(row.unit_cost)}.</p>
      <Async loading={led.loading && !led.data} error={led.error}>{() => (
        <Table rows={led.data ?? []} empty="No movements."
          columns={[{ key: 'created_at', label: 'When', render: (t) => fmtDateTime(t.created_at) }, { key: 'txn_type', label: 'Movement', render: (t) => humanize(t.txn_type) },
            { key: 'qty', label: 'Qty', numeric: true, render: (t) => (t.qty > 0 ? `+${fmtNum(t.qty, 3)}` : fmtNum(t.qty, 3)) }, { key: 'balance_after', label: 'Balance', numeric: true },
            { key: 'ref', label: 'Reference', render: (t) => t.work_order ?? t.reference ?? t.reason }, { key: 'by', label: 'By' }]} />
      )}</Async>
      <PartUnits partId={row.part_id} />
      <PartLots row={row} onChanged={onChanged} />
      {manage && (
        <div className="grid two">
          <form className="form" onSubmit={(e) => { e.preventDefault(); void adjust.run(); }}>
            <h3>Adjust</h3>
            <div className="form-grid">
              <label className="field">Change (+ or −)<input id="adj-qty" type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} required /></label>
              <label className="field">Reason<input id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} placeholder="e.g. damaged in storage" /></label>
              {row.tracking !== 'none' && <label className="field">{row.tracking === 'serial' ? 'Serial number' : 'Lot'}<input id="adj-lot" value={adjLot} onChange={(e) => setAdjLot(e.target.value)}
                placeholder={Number(qty) < 0 ? 'Blank: first to expire' : 'Required when adding'} /></label>}
            </div>
            <ErrorNote message={adjust.error} />
            <div><button disabled={adjust.busy || !qty || reason.trim().length < 5}>Post adjustment</button></div>
          </form>
          <form className="form" onSubmit={(e) => { e.preventDefault(); void settings.run(); }}>
            <h3>Reorder settings</h3>
            <div className="form-grid">
              <label className="field">Reorder point<input id="set-rp" type="number" min="0" step="any" value={rp} onChange={(e) => setRp(e.target.value)} /></label>
              <label className="field">Reorder quantity<input id="set-rq" type="number" min="0" step="any" value={rq} onChange={(e) => setRq(e.target.value)} /></label>
            </div>
            <ErrorNote message={settings.error} />
            <div><button disabled={settings.busy}>Save</button></div>
          </form>
        </div>
      )}
    </section>
  );
}

/** Tracking setting and this storeroom's lots for a part (D-147). */
function PartLots({ row, onChanged }: { row: any; onChanged: () => void }) {
  const stock = useApi<any[]>(`/api/inventory?partId=${row.part_id}`);
  const lots = useApi<any[]>(row.tracking !== 'none' ? `/api/lots?partId=${row.part_id}` : null);
  const here = (lots.data ?? []).map((l) => ({ ...l, qty: l.locations.find((x: any) => x.location_id === row.location_id)?.qty ?? 0 })).filter((l) => l.qty > 0);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {stock.data && <PartTracking part={{ id: row.part_id, tracking: row.tracking, shelf_life_days: row.shelf_life_days, uom: row.uom }}
        stock={stock.data.map((s) => ({ location_id: s.location_id, location: s.location, qty: Number(s.qty_on_hand) }))} onDone={onChanged} />}
      {row.tracking !== 'none' && (
        <Table rows={here} empty="No lots here." columns={[{ key: 'number', label: row.tracking === 'serial' ? 'Serial' : 'Lot', render: (l) => <Link to={`/inventory/lots/${l.id}`}>{l.number}</Link> },
          { key: 'qty', label: 'Here', numeric: true, render: (l) => fmtNum(l.qty, 3) }, { key: 'expires_on', label: 'Expires', render: (l) => (l.expires_on ? fmtDate(l.expires_on) : '—') },
          { key: 'status', label: 'Status', render: (l) => (l.status === 'hold' ? <Pill tone="bad" label="On hold" /> : l.expired ? <Pill tone="bad" label="Expired" /> : <Pill tone="good" label="Available" />) }]} />
      )}
    </div>
  );
}

/** Units a part is bought or counted in besides its stock unit (D-143): a box of 100, a drum of 55 gallons. */
function PartUnits({ partId }: { partId: string }) {
  const { can } = useAuth();
  const { data, reload } = useApi<any>(`/api/parts/${partId}/units`);
  const [f, setF] = useState({ uom: '', per: '' });
  const save = useAction(async () => { await api.put(`/api/parts/${partId}/units/${encodeURIComponent(f.uom)}`, { perUnit: Number(f.per) }); setF({ uom: '', per: '' }); await reload(); });
  const remove = useAction(async (uom: string) => { await api.delete(`/api/parts/${partId}/units/${encodeURIComponent(uom)}`); await reload(); });
  if (!data) return null;
  const common = data.standard.filter((u: any) => ['L', 'ML', 'QT', 'FT', 'IN', 'M', 'LB', 'KG', 'DZ', 'PR'].includes(u.uom)).slice(0, 4);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3>Units</h3>
      <p className="muted">Stocked and counted in <strong>{data.stockUom}</strong>.{data.own.length ? ' Also bought in:' : ' Add a unit when it is bought in packs, boxes, cases or drums.'}</p>
      {data.own.map((u: any) => (
        <div className="row" key={u.uom}>
          <span>1 {u.uom} = {fmtNum(u.perUnit, 6)} {data.stockUom}{u.suppliers.length ? <span className="faint"> · priced this way by {u.suppliers.join(', ')}</span> : null}</span>
          {can('parts.manage') && !u.suppliers.length && <button className="link" onClick={() => remove.run(u.uom)} disabled={remove.busy}>Remove</button>}
        </div>
      ))}
      {common.length > 0 && <p className="faint">Converts by fixed factors from {common.map((u: any) => `${u.uom} (${fmtNum(u.perUnit, 4)} ${data.stockUom})`).join(', ')}.</p>}
      {can('parts.manage') && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          1 <input aria-label="Unit" placeholder="BOX" value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value.toUpperCase() })} maxLength={10} style={{ width: 80 }} required /> =
          <input aria-label={`How many ${data.stockUom}`} type="number" min="0" step="any" value={f.per} onChange={(e) => setF({ ...f, per: e.target.value })} style={{ width: 100 }} required /> {data.stockUom}
          <button disabled={save.busy}>Add unit</button>
        </form>
      )}
      <ErrorNote message={save.error ?? remove.error} />
    </div>
  );
}

function ReceiveForm({ onDone }: { onDone: () => void }) {
  const locs = useApi<any[]>('/api/stock-locations');
  const parts = useApi<any[]>('/api/parts');
  const [f, setF] = useState({ locationId: '', partId: '', qty: '', unitCost: '', reference: '' });
  const [ok, setOk] = useState<string | null>(null);
  const [lots, setLots] = useState<LotSpec[] | null>(null);
  const part = (parts.data ?? []).find((p) => p.id === f.partId);
  const act = useAction(async () => {
    const r = await api.post('/api/inventory/receipts', { locationId: f.locationId, partId: f.partId, qty: Number(f.qty), unitCost: f.unitCost ? Number(f.unitCost) : null, reference: f.reference || null, lots });
    setOk(`Received. ${r.part.part_number} at ${r.location.code} is now ${r.balanceAfter}.`);
    setF({ ...f, partId: '', qty: '', unitCost: '' }); onDone();
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="card">
      <h2>Receive parts</h2>
      <form className="form" onSubmit={(e) => { e.preventDefault(); setOk(null); void act.run(); }}>
        <div className="form-grid">
          <label className="field">Storeroom<select id="rcv-loc" value={f.locationId} onChange={set('locationId')} required>
            <option value="">Choose…</option>{(locs.data ?? []).filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label>
          <label className="field">Part<select id="rcv-part" value={f.partId} onChange={set('partId')} required>
            <option value="">Choose…</option>{(parts.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}</select></label>
          <label className="field">Quantity<input id="rcv-qty" type="number" min="0.001" step="any" value={f.qty} onChange={set('qty')} required /></label>
          <label className="field">Unit cost (USD)<input id="rcv-cost" type="number" min="0" step="any" value={f.unitCost} onChange={set('unitCost')} /></label>
          <label className="field">Packing slip / PO<input id="rcv-ref" value={f.reference} onChange={set('reference')} /></label>
        </div>
        {part && part.tracking !== 'none' && <div className="field"><span>{part.tracking === 'serial' ? 'Serial numbers' : 'Lot'}{part.shelf_life_days ? <span className="faint"> (shelf life {part.shelf_life_days} days)</span> : null}</span>
          <LotEntry key={f.partId} tracking={part.tracking} qty={Number(f.qty) || 0} label={part.part_number} onChange={setLots} /></div>}
        <ErrorNote message={act.error} />
        {ok && <div className="notice ok">{ok}</div>}
        <div><button className="primary" disabled={act.busy}>Receive</button></div>
      </form>
    </section>
  );
}

function Counts({ manage }: { manage: boolean }) {
  const list = useApi<any[]>('/api/inventory/counts');
  const locs = useApi<any[]>('/api/stock-locations');
  const [open, setOpen] = useState<string | null>(null);
  const [loc, setLoc] = useState('');
  const start = useAction(async () => { const c = await api.post('/api/inventory/counts', { locationId: loc }); await list.reload(); setOpen(c.id); });
  return (
    <>
      <section className="card stack">
        <h2>Counts</h2>
        <Async loading={list.loading && !list.data} error={list.error}>{() => (
          <Table rows={list.data ?? []} onRow={(c) => setOpen(c.id)} empty="No counts yet."
            columns={[{ key: 'location', label: 'Storeroom' }, { key: 'status', label: 'Status', render: (c) => <Pill value={c.status} tone={c.status === 'posted' ? 'good' : 'info'} /> },
              { key: 'progress', label: 'Counted', render: (c) => `${c.counted} of ${c.lines}` }, { key: 'created_at', label: 'Opened', render: (c) => fmtDateTime(c.created_at) },
              { key: 'posted_at', label: 'Posted', render: (c) => fmtDateTime(c.posted_at) }]} />
        )}</Async>
        {manage && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void start.run(); }}>
            <select id="count-loc" value={loc} onChange={(e) => setLoc(e.target.value)} required aria-label="Storeroom to count" style={{ maxWidth: 280 }}>
              <option value="">Storeroom to count…</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
            </select>
            <button disabled={start.busy || !loc}>Start a count</button>
            <ErrorNote message={start.error} />
          </form>
        )}
      </section>
      {open && <CountSheet id={open} manage={manage} onChanged={list.reload} />}
    </>
  );
}

function CountSheet({ id, manage, onChanged }: { id: string; manage: boolean; onChanged: () => void }) {
  const { data: c, loading, error, reload } = useApi<any>(`/api/inventory/counts/${id}`);
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [moved, setMoved] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [found, setFound] = useState({ partId: '', lot: '', qty: '' });
  // Lines are per part, and per lot for tracked parts (D-147).
  const key = (l: any) => `${l.part_id}|${l.lot_number ?? ''}`;
  const save = useAction(async () => {
    const lines = Object.entries(entered).filter(([, v]) => v !== '').map(([k, v]) => { const [partId, lot] = k.split('|'); return { partId, countedQty: Number(v), lot: lot || null }; });
    if (found.partId && found.lot.trim() && found.qty !== '') lines.push({ partId: found.partId, countedQty: Number(found.qty), lot: found.lot.trim() });
    setFound({ partId: '', lot: '', qty: '' });
    if (lines.length) await api.post(`/api/inventory/counts/${id}/lines`, { lines });
    setEntered({}); await reload(); onChanged();
  });
  const post = useAction(async (acceptMovement: boolean) => {
    try {
      setResult(await api.post(`/api/inventory/counts/${id}/post`, { acceptMovement }));
      setMoved(null); await reload(); onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stock_moved') { setMoved(e.message); return; }
      throw e;
    }
  });
  return (
    <Async loading={loading && !c} error={error}>{() => {
      const editable = manage && c.status === 'open';
      return (
        <section className="card stack" aria-label="Count sheet">
          <div className="spread"><h2>Count at {c.location}</h2><Pill value={c.status} tone={c.status === 'posted' ? 'good' : 'info'} /></div>
          <p className="muted">Expected quantities are as of {fmtDateTime(c.created_at)}. Count what is on the shelf; the system posts the difference.</p>
          <Table rows={c.lines} rowKey={key}
            columns={[{ key: 'bin', label: 'Bin' }, { key: 'part_number', label: 'Part', render: (l) => <strong>{l.part_number}</strong> }, { key: 'description', label: 'Description' },
              ...(c.lines.some((l: any) => l.lot_number) ? [{ key: 'lot_number', label: 'Lot / serial' }] : []),
              { key: 'expected_qty', label: 'Expected', numeric: true },
              { key: 'counted_qty', label: 'Counted', numeric: true, render: (l) => editable
                ? <input aria-label={`Counted ${l.part_number}${l.lot_number ? ` lot ${l.lot_number}` : ''}`} type="number" min="0" step="any" style={{ width: 90 }} value={entered[key(l)] ?? (l.counted_qty ?? '')}
                    onChange={(e) => setEntered({ ...entered, [key(l)]: e.target.value })} />
                : fmtNum(l.counted_qty, 3) },
              { key: 'var', label: 'Variance', numeric: true, render: (l) => (l.counted_qty == null ? '—' : fmtNum(l.counted_qty - l.expected_qty, 3)) }]} />
          {editable && c.lines.some((l: any) => l.tracking !== 'none') && (
            <div className="row">
              <span className="muted">Found a lot that is not on the sheet:</span>
              <select aria-label="Part of the lot found" value={found.partId} onChange={(e) => setFound({ ...found, partId: e.target.value })}>
                <option value="">Part…</option>{[...new Map(c.lines.filter((l: any) => l.tracking !== 'none').map((l: any) => [l.part_id, l.part_number])).entries()].map(([id, pn]) => <option key={id as string} value={id as string}>{pn as string}</option>)}
              </select>
              <input aria-label="Lot or serial found" placeholder="Lot / serial" value={found.lot} onChange={(e) => setFound({ ...found, lot: e.target.value })} style={{ width: 130 }} />
              <input aria-label="Quantity found" type="number" min="0" step="any" placeholder="Qty" value={found.qty} onChange={(e) => setFound({ ...found, qty: e.target.value })} style={{ width: 80 }} />
            </div>
          )}
          <ErrorNote message={save.error ?? post.error} />
          {moved && (
            <div className="notice warn stack">
              <span>{moved}</span>
              <div><button onClick={() => post.run(true)} disabled={post.busy}>Post against current quantities</button></div>
            </div>
          )}
          {result && <div className="notice ok">Posted. {result.variances.length ? result.variances.map((v: any) => `${v.partNumber} ${v.delta > 0 ? '+' : ''}${v.delta}`).join(', ') : 'No variances.'}</div>}
          {editable && (
            <div className="row">
              <button onClick={() => save.run()} disabled={save.busy || !Object.keys(entered).length}>Save counts</button>
              <button className="primary" onClick={() => post.run(false)} disabled={post.busy || c.lines.some((l: any) => l.counted_qty == null)}>Post count</button>
            </div>
          )}
        </section>
      );
    }}</Async>
  );
}
