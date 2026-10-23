import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ScanField, beep } from '../components/ScanField';
import { ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate } from '../format';
import { useApi } from '../hooks';

type Mode = 'receive' | 'issue' | 'count' | 'lookup' | 'labels' | 'barcodes';
type Say = { tone: 'good' | 'bad' | 'info'; text: string } | null;
const num = (v: string) => Number(v);

/**
 * Scan station (SC-006 A): a tablet screen for receiving, issuing and counting stock with a barcode scanner (or the camera, or
 * typing). Every scan is resolved on the server; every post goes through the same ledger rules as the typed screens.
 */
export function Scan() {
  const { can } = useAuth();
  const [mode, setMode] = useState<Mode>('receive');
  const [say, setSayRaw] = useState<Say>(null);
  const say_ = (tone: 'good' | 'bad' | 'info', text: string) => { setSayRaw({ tone, text }); if (tone !== 'info') beep(tone === 'good'); };
  const modes: [Mode, string][] = [['receive', 'Receive'], ['issue', 'Issue'], ['count', 'Count'], ['lookup', 'Look up'], ['labels', 'Labels'], ['barcodes', 'Barcodes']];
  return (
    <div className="scan-station stack">
      <PageHead eyebrow="Storerooms" title="Scan station" sub="Scan with a scanner or the camera, or type the code and press Enter." />
      <div className="row modes" role="tablist">
        {modes.filter(([m]) => m === 'lookup' || m === 'labels' || (m === 'barcodes' && can('inventory.manage')) || can('inventory.manage') || (m === 'receive' && can('purchasing.receive'))).map(([m, label]) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'primary' : ''} onClick={() => { setMode(m); setSayRaw(null); }}>{label}</button>))}
      </div>
      <div className={`banner ${say?.tone ?? 'info'}`} role="status" aria-live="polite">{say?.text ?? 'Ready. Scan to begin.'}</div>
      {mode === 'receive' && <Receive say={say_} />}
      {mode === 'issue' && <Issue say={say_} />}
      {mode === 'count' && <Count say={say_} />}
      {mode === 'lookup' && <Lookup say={say_} />}
      {mode === 'labels' && <Labels say={say_} />}
      {mode === 'barcodes' && <Barcodes say={say_} />}
    </div>
  );
}

const resolve = (code: string) => api.get<any>(`/api/scan/resolve?code=${encodeURIComponent(code)}`);

function Qty({ value, set, step = 1 }: { value: string; set: (v: string) => void; step?: number }) {
  return (
    <div className="qty-row">
      <button type="button" aria-label="Less" onClick={() => set(String(Math.max(0, num(value) - step)))}>−</button>
      <input aria-label="Quantity" type="number" inputMode="decimal" min="0" step="any" value={value} onChange={(e) => set(e.target.value)} />
      <button type="button" aria-label="More" onClick={() => set(String(num(value) + step))}>+</button>
    </div>
  );
}

function Receive({ say }: { say: (t: 'good' | 'bad' | 'info', s: string) => void }) {
  const [po, setPo] = useState<any>(null);
  const [loc, setLoc] = useState<any>(null);
  const [part, setPart] = useState<any>(null);
  const [line, setLine] = useState<any>(null);
  const [qty, setQty] = useState('');
  const [lot, setLot] = useState(''); const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const scan = async (code: string) => {
    setErr(null);
    try {
      const r = await resolve(code);
      if (r.kind === 'purchase_order') { setPo(r); setPart(null); setLine(null); say('good', `${r.number} from ${r.supplier}: ${r.lines.filter((l: any) => l.open > 0).length} open lines. Scan the parts as they come off the pallet.`); }
      else if (r.kind === 'location') { setLoc(r); say('good', `Receiving into ${r.code} · ${r.name}`); }
      else if (r.kind === 'part') {
        let l: any = null;
        if (po) {
          l = po.lines.find((x: any) => x.part_id === r.id && x.open > 0);
          if (!l) return say('bad', `${r.partNumber} is not an open line on ${po.number}`);
        }
        if (part?.id === r.id) setQty(String(Math.min(num(qty || '0') + r.qtyPerScan, l ? l.open : Infinity)));
        else { setPart(r); setLine(l); setQty(String(l ? Math.min(r.qtyPerScan, l.open) : r.qtyPerScan)); setLot(''); setExpires(''); }
        say('good', `${r.partNumber} · ${r.description}${l ? ` · ${l.open} still to come on ${po.number}` : ''}`);
      } else say('bad', 'Scan a purchase order, a location or a part to receive');
    } catch (e: any) { say('bad', e.message); }
  };
  const dest = line?.location_id ?? loc?.id;
  const tracked = part && part.tracking !== 'none';
  const ok = part && num(qty) > 0 && dest && (!tracked || lot.trim()) && !busy;
  const post = async () => {
    setBusy(true); setErr(null);
    try {
      const lots = tracked ? [{ lot: lot.trim(), qty: num(qty), expiresOn: expires || null }] : null;
      if (po && line) {
        await api.post(`/api/purchase-orders/${po.id}/receive`, { lines: [{ orderLineId: line.id, qty: num(qty), locationId: dest, lots }] });
        const fresh = await resolve(po.number); setPo(fresh);
        say('good', `Received ${qty} × ${part.partNumber} on ${po.number}. ${fresh.status === 'received' ? 'Order complete.' : `${fresh.lines.filter((l: any) => l.open > 0).length} lines still open.`}`);
      } else {
        await api.post('/api/inventory/receipts', { locationId: dest, partId: part.id, qty: num(qty), reference: po?.number ?? 'Scan receipt', lots });
        say('good', `Received ${qty} × ${part.partNumber} into ${loc.code}`);
      }
      setPart(null); setLine(null); setQty(''); setLot(''); setExpires('');
    } catch (e: any) { setErr(e.message); say('bad', e.message); } finally { setBusy(false); }
  };
  return (
    <section className="card stack big">
      <ScanField onScan={scan} label="Scan the purchase order, the shelf location, then each part" busy={busy} />
      <div className="row">
        <span>Order: {po ? <strong>{po.number}</strong> : <span className="faint">none (receiving without an order)</span>}</span>
        <span>Into: {dest ? <strong>{line?.location_id && po ? 'the line’s storeroom' : loc?.code}</strong> : <span className="faint">scan a location</span>}</span>
        {po && <button onClick={() => { setPo(null); setLine(null); setPart(null); }}>Clear order</button>}
      </div>
      {po && <Table tools={false} rows={po.lines} rowKey={(l) => l.id} columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'part_number', label: 'Part', render: (l) => l.part_number ?? l.description },
        { key: 'ordered', label: 'Ordered', numeric: true }, { key: 'received', label: 'Received', numeric: true }, { key: 'open', label: 'To come', numeric: true }]} />}
      {part && (
        <div className="stack">
          <h2>{part.partNumber} <span className="muted" style={{ fontWeight: 400 }}>{part.description}</span></h2>
          <Qty value={qty} set={setQty} step={part.qtyPerScan} />
          {tracked && (
            <div className="row">
              <label className="field">{part.tracking === 'serial' ? 'Serial number' : 'Lot number'}<input id="scan-lot" value={lot} onChange={(e) => setLot(e.target.value)} /></label>
              <label className="field">Expires<input id="scan-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
            </div>
          )}
          <div><button className="primary" disabled={!ok} onClick={post}>Receive {qty || 0}</button></div>
        </div>
      )}
      <ErrorNote message={err} />
    </section>
  );
}

function Issue({ say }: { say: (t: 'good' | 'bad' | 'info', s: string) => void }) {
  const [from, setFrom] = useState<any>(null);
  const [wo, setWo] = useState<any>(null);
  const [ref, setRef] = useState('');
  const [part, setPart] = useState<any>(null);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const scan = async (code: string) => {
    setErr(null);
    try {
      const r = await resolve(code);
      if (r.kind === 'location') { setFrom(r); say('good', `Issuing from ${r.code} · ${r.name}`); }
      else if (r.kind === 'work_order') { setWo(r); setRef(''); say('good', `For work order ${r.number} · ${r.title}`); }
      else if (r.kind === 'part') {
        if (part?.id === r.id) setQty(String(num(qty || '0') + r.qtyPerScan)); else { setPart(r); setQty(String(r.qtyPerScan)); }
        const here = from ? r.onHand.find((h: any) => h.location_id === from.id) : null;
        say(here || !from ? 'good' : 'bad', `${r.partNumber} · ${r.description}${from ? ` · ${here ? `${here.qty} on hand at ${from.code}` : `none at ${from.code}`}` : ''}`);
      } else say('bad', 'Scan a location, a work order or a part to issue');
    } catch (e: any) { say('bad', e.message); }
  };
  const lots = part && part.tracking !== 'none';
  const ok = from && part && num(qty) > 0 && (wo || ref.trim()) && !lots && !busy;
  const post = async () => {
    setBusy(true); setErr(null);
    try {
      if (wo) await api.post(`/api/work-orders/${wo.id}/parts`, { partId: part.id, qtyUsed: num(qty), locationId: from.id });
      else await api.post('/api/inventory/issues', { locationId: from.id, partId: part.id, qty: num(qty), reference: ref.trim() });
      say('good', `Issued ${qty} × ${part.partNumber} to ${wo ? wo.number : ref.trim()}`);
      setPart(null); setQty('');
    } catch (e: any) { setErr(e.message); say('bad', e.message); } finally { setBusy(false); }
  };
  return (
    <section className="card stack big">
      <ScanField onScan={scan} label="Scan the storeroom, the work order, then each part" busy={busy} />
      <div className="row">
        <span>From: {from ? <strong>{from.code}</strong> : <span className="faint">scan a location</span>}</span>
        <span>To: {wo ? <strong>{wo.number}</strong> : <span className="faint">scan a work order, or enter a reference</span>}</span>
        {wo && <button onClick={() => setWo(null)}>Clear work order</button>}
      </div>
      {!wo && <label className="field">Job, cost centre or line<input id="scan-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. JOB-1042" /></label>}
      {part && (
        <div className="stack">
          <h2>{part.partNumber} <span className="muted" style={{ fontWeight: 400 }}>{part.description}</span></h2>
          <Qty value={qty} set={setQty} step={part.qtyPerScan} />
          {lots && <p className="muted">This part is tracked by {part.tracking}. Issue it from the work order or the storeroom screen, where the lot is chosen.</p>}
          <div><button className="primary" disabled={!ok} onClick={post}>Issue {qty || 0}</button></div>
        </div>
      )}
      <ErrorNote message={err} />
    </section>
  );
}

function Count({ say }: { say: (t: 'good' | 'bad' | 'info', s: string) => void }) {
  const due = useApi<any[]>('/api/inventory/counts-due');
  const [count, setCount] = useState<any>(null);
  const [part, setPart] = useState<any>(null);
  const [lot, setLot] = useState('');
  const [qty, setQty] = useState('');
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = async (id: string) => { const c = await api.get<any>(`/api/inventory/counts/${id}`); setCount(c); return c; };
  const startAt = async (locationId: string, code: string, dueOnly: boolean) => {
    setErr(null);
    try {
      const open = (await api.get<any[]>('/api/inventory/counts')).find((c) => c.location === code && c.status === 'open');
      if (open) { await load(open.id); say('info', `Continuing the open count at ${code}`); return; }
      const c = dueOnly ? await api.post<any>(`/api/inventory/counts-due/${locationId}/open`, { blind: true }) : await api.post<any>('/api/inventory/counts', { locationId, blind: true, note: 'Cycle count' });
      await load(c.id); await due.reload(); say('good', `Count opened at ${code}. Scan each part and enter what is on the shelf.`);
    } catch (e: any) { setErr(e.message); say('bad', e.message); }
  };
  const scan = async (code: string) => {
    setErr(null);
    try {
      const r = await resolve(code);
      if (r.kind === 'location') { if (!count) { await startAt(r.id, r.code, false); } else say('info', `This count is at ${count.location}. Finish it first.`); return; }
      if (!count) return say('bad', 'Scan the shelf location first to open or continue a count');
      if (r.kind !== 'part') return say('bad', 'Scan a part');
      const lines = count.lines.filter((l: any) => l.part_id === r.id);
      if (!lines.length) return say('bad', `${r.partNumber} is not on this count sheet`);
      setPart({ ...r, lines }); setLot(lines.length === 1 ? lines[0].lot_number ?? '' : ''); setQty(lines.length === 1 && lines[0].counted_qty != null ? String(lines[0].counted_qty) : '');
      say('good', `${r.partNumber} · ${r.description}. Count what is on the shelf${lines[0].bin ? ` (bin ${lines[0].bin})` : ''}.`);
    } catch (e: any) { say('bad', e.message); }
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/inventory/counts/${count.id}/lines`, { lines: [{ partId: part.id, countedQty: num(qty), lot: lot.trim() || null }] });
      await load(count.id); say('good', `Counted ${qty} × ${part.partNumber}`); setPart(null); setQty(''); setLot('');
    } catch (e: any) { setErr(e.message); say('bad', e.message); } finally { setBusy(false); }
  };
  const finish = async (acceptMovement = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<any>(`/api/inventory/counts/${count.id}/post`, { acceptMovement });
      say('good', r.variances.length ? `Posted. ${r.variances.length} difference${r.variances.length === 1 ? '' : 's'}: ${r.variances.map((v: any) => `${v.partNumber} ${v.delta > 0 ? '+' : ''}${v.delta}`).join(', ')}` : 'Posted. Everything matched.');
      setCount(null); setMoved(false); await due.reload();
    } catch (e: any) { if (e.code === 'stock_moved') { setMoved(true); say('bad', e.message); } else { setErr(e.message); say('bad', e.message); } } finally { setBusy(false); }
  };
  const left = count ? count.lines.filter((l: any) => l.counted_qty == null) : [];
  return (
    <section className="card stack big">
      {!count && (
        <>
          <ScanField onScan={scan} label="Scan the shelf location to start or continue a count" busy={busy} />
          <h2>Due for counting</h2>
          <Table tools={false} rows={due.data ?? []} rowKey={(g) => g.locationId} empty="Nothing is due. Parts are scheduled for counting by setting a count interval on the part's storeroom detail (Count every … days)."
            columns={[{ key: 'location', label: 'Location', render: (g) => <strong>{g.location}</strong> }, { key: 'locationName', label: 'Name' }, { key: 'parts', label: 'Parts due', numeric: true, render: (g) => g.parts.length, value: (g) => g.parts.length },
              { key: 'go', label: '', render: (g) => <button className="primary" onClick={() => startAt(g.locationId, g.location, true)}>{g.countOpen ? 'Continue' : 'Count these'}</button> }]} />
        </>
      )}
      {count && (
        <>
          <Kpis items={[{ label: 'Counting at', value: count.location }, { label: 'Counted', value: `${count.lines.length - left.length} of ${count.lines.length}` }, { label: 'Mode', value: count.blind ? 'Blind' : 'Shows expected' }]} />
          <ScanField onScan={scan} label="Scan each part, then enter the quantity on the shelf" busy={busy} />
          {part && (
            <div className="stack">
              <h2>{part.partNumber} <span className="muted" style={{ fontWeight: 400 }}>{part.description}</span></h2>
              {part.tracking !== 'none' && (
                <label className="field">{part.tracking === 'serial' ? 'Serial number' : 'Lot number'}
                  <select id="scan-count-lot" value={lot} onChange={(e) => setLot(e.target.value)}><option value="">Choose…</option>{part.lines.map((l: any) => <option key={l.lot_number} value={l.lot_number}>{l.lot_number}</option>)}</select></label>
              )}
              <Qty value={qty} set={setQty} />
              <div className="row"><button className="primary" disabled={busy || qty === '' || (part.tracking !== 'none' && !lot)} onClick={save}>Save count</button><button onClick={() => setPart(null)}>Cancel</button></div>
            </div>
          )}
          <h2>{left.length ? `Still to count (${left.length})` : 'Everything is counted'}</h2>
          <Table tools={false} rows={left} rowKey={(l) => `${l.part_id}${l.lot_number}`} columns={[{ key: 'bin', label: 'Bin' }, { key: 'part_number', label: 'Part' }, { key: 'description', label: 'Description' }, { key: 'lot_number', label: 'Lot' }]} />
          <div className="row">
            <button className="primary" disabled={busy || left.length > 0} onClick={() => finish(false)}>Finish and post</button>
            {moved && <button className="danger" disabled={busy} onClick={() => finish(true)}>Stock moved during the count: post against current quantities</button>}
            <button onClick={() => { setCount(null); setPart(null); }}>Leave it open</button>
          </div>
        </>
      )}
      <ErrorNote message={err} />
    </section>
  );
}

function Lookup({ say }: { say: (t: 'good' | 'bad' | 'info', s: string) => void }) {
  const [r, setR] = useState<any>(null);
  const scan = async (code: string) => { try { const x = await resolve(code); setR(x); say('good', `${x.kind.replace('_', ' ')}: ${x.partNumber ?? x.number ?? x.code}`); } catch (e: any) { setR(null); say('bad', e.message); } };
  return (
    <section className="card stack big">
      <ScanField onScan={scan} label="Scan anything to see what it is" />
      {r?.kind === 'part' && (<><h2>{r.partNumber} <span className="muted" style={{ fontWeight: 400 }}>{r.description}</span></h2><p className="muted">Found by {r.via.replace('_', ' ')}. Counted in {r.uom}{r.qtyPerScan !== 1 ? `; one scan is ${r.qtyPerScan}` : ''}{r.tracking !== 'none' ? ` · tracked by ${r.tracking}` : ''}.</p>
        <Table tools={false} rows={r.onHand} rowKey={(h) => h.location_id} empty="None on hand anywhere you can see." columns={[{ key: 'location', label: 'Location' }, { key: 'bin', label: 'Bin' }, { key: 'qty', label: 'On hand', numeric: true }]} /></>)}
      {r?.kind === 'location' && <h2>{r.code} <span className="muted" style={{ fontWeight: 400 }}>{r.name}</span> {!r.active && <Pill tone="watch" label="Inactive" />}</h2>}
      {r?.kind === 'lot' && <p><strong>{r.partNumber}</strong> {r.lotKind} {r.lot} · <Pill value={r.status} />{r.expiresOn ? ` · expires ${fmtDate(r.expiresOn)}` : ''}</p>}
      {r?.kind === 'purchase_order' && <p><strong>{r.number}</strong> from {r.supplier} · {r.status.replace(/_/g, ' ')} · {r.lines.filter((l: any) => l.open > 0).length} open lines</p>}
      {r?.kind === 'work_order' && <p><strong>{r.number}</strong> {r.title} · {r.status.replace(/_/g, ' ')}</p>}
    </section>
  );
}

function Labels({ say }: { say: (t: 'good' | 'bad' | 'info', s: string) => void }) {
  const [kind, setKind] = useState<'part' | 'location'>('location');
  const parts = useApi<any[]>(kind === 'part' ? '/api/parts' : null);
  const locs = useApi<any[]>(kind === 'location' ? '/api/stock-locations' : null);
  const [picked, setPicked] = useState<string[]>([]);
  const rows = (kind === 'part' ? parts.data : locs.data) ?? [];
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const print = async () => { try { await api.openPost('/api/labels/pdf', { kind, ids: picked }); say('good', `${picked.length} labels ready: print the sheet on Avery 5160 (30 per page).`); } catch (e: any) { say('bad', e.message); } };
  return (
    <section className="card stack">
      <div className="row"><label className="field">Label for<select id="label-kind" value={kind} onChange={(e) => { setKind(e.target.value as any); setPicked([]); }}><option value="location">Storeroom locations</option><option value="part">Parts</option></select></label>
        <button className="primary" disabled={!picked.length} onClick={print}>Print {picked.length || ''} labels</button></div>
      <Table rows={rows} rowKey={(r) => r.id} empty="Nothing to label."
        columns={[{ key: 'pick', label: '', plain: true, render: (r) => <input type="checkbox" aria-label={`Label ${r.part_number ?? r.code}`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /> },
          { key: kind === 'part' ? 'part_number' : 'code', label: kind === 'part' ? 'Part' : 'Code' }, { key: kind === 'part' ? 'description' : 'name', label: kind === 'part' ? 'Description' : 'Name' }]} />
      <p className="muted">Lot and serial labels are printed from the lot page. Suppliers’ own barcodes (UPC, EAN, carton codes) are mapped to a part from its record so they scan too.</p>
    </section>
  );
}

/** Maps a supplier's barcode (UPC, EAN, carton) to a part so it scans like our own label. */
function Barcodes({ say }: { say: (t: 'good' | 'bad' | 'info', s: string) => void }) {
  const parts = useApi<any[]>('/api/parts');
  const [partId, setPartId] = useState('');
  const list = useApi<any[]>(partId ? `/api/parts/${partId}/barcodes` : null);
  const [f, setF] = useState({ code: '', kind: 'upc', qty: '1' });
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    try { await api.post(`/api/parts/${partId}/barcodes`, { code: f.code, kind: f.kind, qtyPerScan: num(f.qty) }); setF({ ...f, code: '' }); await list.reload(); say('good', 'Barcode added. It now scans as this part.'); }
    catch (e: any) { setErr(e.message); say('bad', e.message); }
  };
  return (
    <section className="card stack">
      <label className="field">Part<select id="bc-part" value={partId} onChange={(e) => setPartId(e.target.value)}><option value="">Choose…</option>{(parts.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}</select></label>
      {partId && (
        <>
          <Table tools={false} rows={list.data ?? []} rowKey={(b) => b.id} empty="No supplier barcodes mapped yet." columns={[{ key: 'code', label: 'Code' }, { key: 'kind', label: 'Kind' }, { key: 'qty_per_scan', label: 'Quantity per scan', numeric: true },
            { key: 'rm', label: '', plain: true, render: (b) => <button onClick={async () => { await api.delete(`/api/parts/${partId}/barcodes/${b.id}`); await list.reload(); }}>Remove</button> }]} />
          <form className="row" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <label className="field">Code<input id="bc-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} minLength={3} required /></label>
            <label className="field">Kind<select id="bc-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="upc">UPC</option><option value="ean">EAN</option><option value="carton">Carton</option><option value="supplier">Supplier code</option></select></label>
            <label className="field">Quantity per scan<input id="bc-qty" type="number" min="0.001" step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
            <button className="primary">Add barcode</button>
          </form>
          <ErrorNote message={err} />
        </>
      )}
    </section>
  );
}
