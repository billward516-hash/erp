import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

/** Chemicals and reagents (SC-007 C): containers, preparations, chemical parts with their safety data sheets, storage rules and limits. */
const TABS = [['containers', 'Containers'], ['preparations', 'Preparations'], ['parts', 'Chemical parts'], ['storage', 'Storage rules'], ['limits', 'Limits and settings']] as const;
type Tab = (typeof TABS)[number][0];
const today = () => new Date().toISOString().slice(0, 10);

export function Chemicals() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t[0] === params.get('tab')) ? params.get('tab') : 'containers') as Tab;
  const manage = can('chemicals.manage');
  const ov = useApi<any>('/api/chemicals/overview');
  const o = ov.data;
  return (
    <>
      <PageHead eyebrow="Maintenance" title="Chemicals" sub="Containers with their lot, quantity, location and beyond-use date; reagent and standard preparations; safety data sheets; and storage rules that refuse an incompatible neighbour." />
      {o && (
        <Kpis items={[
          { label: 'Containers in storage', value: o.containers },
          { label: 'Past use-by', value: o.pastUseBy, tone: o.pastUseBy ? 'bad' : 'good' },
          { label: 'Chemical parts without a safety data sheet', value: o.noSds, tone: o.noSds ? 'bad' : 'good' },
          { label: 'Sheets older than the limit', value: o.oldSds, tone: o.oldSds ? 'watch' : 'good', note: `${o.settings.sdsMaxAgeYears} years` },
          { label: 'Preparations expired', value: o.preparationsExpired, tone: o.preparationsExpired ? 'bad' : 'good' },
        ]} />
      )}
      <div className="row" role="tablist" aria-label="Chemicals sections">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{label}</button>)}
      </div>
      {tab === 'containers' ? <Containers manage={manage} onChanged={() => void ov.reload()} />
        : tab === 'preparations' ? <Preparations manage={manage} onChanged={() => void ov.reload()} />
          : tab === 'parts' ? <Parts manage={manage} onChanged={() => void ov.reload()} />
            : tab === 'storage' ? <Storage manage={manage} /> : <Limits manage={manage} onChanged={() => void ov.reload()} />}
    </>
  );
}

const useLocations = () => useApi<any[]>('/api/chemicals/locations');

/** Runs a placement that the storage rule may refuse; offers the override to people who hold it. */
function useOverridable(run: (overrideReason: string | null) => Promise<void>) {
  const { can } = useAuth();
  const [refused, setRefused] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (withOverride: boolean) => {
    setBusy(true); setError(null);
    try { await run(withOverride ? reason.trim() : null); setRefused(null); setReason(''); } catch (e) {
      if (e instanceof ApiError && e.code === 'incompatible_storage') setRefused(e.message); else setError((e as Error).message);
    } finally { setBusy(false); }
  };
  const view = (
    <>
      <ErrorNote message={error} />
      {refused && (
        <div className="notice warn" role="alert">
          <strong>Not placed.</strong> {refused}
          {can('chemicals.override') ? (
            <div className="row" style={{ marginTop: 8 }}>
              <input aria-label="Reason for placing it anyway" placeholder="Why it must go here anyway (kept in the audit trail)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 320px' }} />
              <button type="button" className="danger" onClick={() => void go(true)} disabled={busy || reason.trim().length < 5}>Place it anyway</button>
            </div>
          ) : <p className="muted">Only a person who holds the override permission can place it here anyway.</p>}
        </div>
      )}
    </>
  );
  return { go, busy, view, clear: () => { setRefused(null); setError(null); } };
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------
function stateOf(c: any) {
  if (c.status === 'disposed') return <Pill tone="neutral" label="Disposed" />;
  if (c.status === 'empty') return <Pill tone="neutral" label="Empty" />;
  if (c.state === 'beyond_use') return <Pill tone="bad" label="Beyond use" />;
  if (c.state === 'expired') return <Pill tone="bad" label="Expired" />;
  if (c.lot_status === 'hold') return <Pill tone="watch" label="Lot on hold" />;
  if (c.days_left != null && c.days_left <= 14) return <Pill tone="watch" label={`${c.days_left} days left`} />;
  return <Pill tone="good" label={c.status === 'in_use' ? 'In use' : 'In storage'} />;
}

function Containers({ manage, onChanged }: { manage: boolean; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [locationId, setLocationId] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const locs = useLocations();
  const qs = new URLSearchParams({ status, ...(q ? { q } : {}), ...(locationId ? { locationId } : {}) }).toString();
  const { data, loading, error, reload } = useApi<any[]>(`/api/chemicals/containers?${qs}`);
  const changed = () => { void reload(); onChanged(); };
  return (
    <>
      <section className="card stack">
        <div className="form-grid">
          <label className="field">Search<input id="chem-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Part, container number or lot" /></label>
          <label className="field">Show<select id="chem-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">In storage or in use</option><option value="all">Everything, including empty and disposed</option><option value="empty">Empty</option><option value="disposed">Disposed</option></select></label>
          <label className="field">Location<select id="chem-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.facility_code} {l.code}</option>)}</select></label>
        </div>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!} onRow={(c) => setSel(c.id)} exception={(c) => c.state === 'expired' || c.state === 'beyond_use'} empty="No containers match. Receive a chemical part into a storeroom, or register a container below."
            columns={[{ key: 'number', label: 'Container', render: (c) => <strong>{c.number}</strong> },
              { key: 'part_number', label: 'Chemical', render: (c) => <>{c.part_number}<div className="faint">{c.description}</div></> },
              { key: 'lot_number', label: 'Lot' },
              { key: 'location_code', label: 'Where', render: (c) => `${c.facility_code} ${c.location_code}` },
              { key: 'qty', label: 'Quantity', numeric: true, render: (c) => `${fmtNum(c.qty, 3)} ${c.uom}` },
              { key: 'opened_on', label: 'Opened', render: (c) => fmtDate(c.opened_on) },
              { key: 'use_by', label: 'Use by', render: (c) => (c.use_by ? fmtDate(c.use_by) : '—') },
              { key: 'status', label: 'State', render: stateOf, value: (c) => c.state ?? c.status }]} />
        )}</Async>
      </section>
      {sel && <ContainerPanel key={sel} id={sel} manage={manage} onClose={() => setSel(null)} onChanged={changed} />}
      {manage && <AddContainer onDone={changed} />}
    </>
  );
}

function ContainerPanel({ id, manage, onClose, onChanged }: { id: string; manage: boolean; onClose: () => void; onChanged: () => void }) {
  const { data: c, loading, error, reload } = useApi<any>(`/api/chemicals/containers/${id}`);
  const locs = useLocations();
  const [useQty, setUseQty] = useState(''); const [useRef, setUseRef] = useState('');
  const [to, setTo] = useState(''); const [note, setNote] = useState(''); const [openedOn, setOpenedOn] = useState(today());
  const after = async () => { await reload(); onChanged(); };
  const open = useAction(async () => { await api.post(`/api/chemicals/containers/${id}/open`, { openedOn }); await after(); });
  const use = useAction(async () => { await api.post(`/api/chemicals/containers/${id}/use`, { qty: Number(useQty), reference: useRef.trim() }); setUseQty(''); setUseRef(''); await after(); });
  const empty = useAction(async () => { await api.post(`/api/chemicals/containers/${id}/empty`, {}); await after(); });
  const dispose = useAction(async () => { await api.post(`/api/chemicals/containers/${id}/dispose`, { note: note.trim() }); setNote(''); await after(); });
  const move = useOverridable(async (overrideReason) => { await api.post(`/api/chemicals/containers/${id}/move`, { toLocationId: to, overrideReason }); setTo(''); await after(); });
  return (
    <section className="card stack" aria-label="Container detail">
      <Async loading={loading && !c} error={error}>{() => {
        const live = c.status === 'in_storage' || c.status === 'in_use';
        return (
          <>
            <div className="spread">
              <h2>{c.number} <span className="muted" style={{ fontWeight: 400 }}>{c.part_number} · lot {c.lot_number}</span></h2>
              <div className="row">{stateOf(c)}<button onClick={() => void api.openPost('/api/chemicals/labels/pdf', { kind: 'container', ids: [id] })}>Print label</button><button onClick={onClose}>Close</button></div>
            </div>
            <p className="muted">
              {c.description}. {fmtNum(c.qty, 3)} of {fmtNum(c.initial_qty, 3)} {c.uom} left at {c.facility_code} {c.location_code}.
              {c.group_code ? ` Storage group ${c.group_code} (${c.group_name}).` : ' No storage group set for this part.'}
              {c.signal_word && c.signal_word !== 'none' ? ` Signal word: ${c.signal_word}.` : ''} {(c.hazard_classes ?? []).length ? `Hazards: ${c.hazard_classes.map(humanize).join(', ')}.` : ''}
            </p>
            <div className="form-grid">
              <div><div className="faint">Expires</div>{c.expires_on ? fmtDate(c.expires_on) : 'No expiry on the lot'}</div>
              <div><div className="faint">Opened</div>{c.opened_on ? fmtDate(c.opened_on) : 'Not opened'}</div>
              <div><div className="faint">Beyond-use date</div>{c.beyond_use_on ? `${fmtDate(c.beyond_use_on)}${c.in_use_days ? ` (${c.in_use_days} days after opening, never past the expiry)` : ''}` : '—'}</div>
              <div><div className="faint">Use by</div><strong>{c.use_by ? fmtDate(c.use_by) : '—'}</strong></div>
            </div>
            {c.lot_status === 'hold' && <div className="notice warn">The lot is on hold{c.hold_reason ? `: ${c.hold_reason}` : ''}; it cannot be used.</div>}
            {c.status === 'disposed' && <div className="notice">Disposed {fmtDate(c.disposed_on)}: {c.disposal_note}</div>}
            {manage && live && (
              <div className="grid two">
                {c.status === 'in_storage' && (
                  <form className="form" onSubmit={(e) => { e.preventDefault(); void open.run(); }}>
                    <h3>Open it</h3>
                    <label className="field">Opened on<input id="ct-opened" type="date" max={today()} value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} /></label>
                    <ErrorNote message={open.error} /><div><button disabled={open.busy}>Open container</button></div>
                  </form>
                )}
                <form className="form" onSubmit={(e) => { e.preventDefault(); void use.run(); }}>
                  <h3>Record use</h3>
                  <div className="form-grid">
                    <label className="field">Quantity used ({c.uom})<input id="ct-use-qty" type="number" min="0" step="any" value={useQty} onChange={(e) => setUseQty(e.target.value)} required /></label>
                    <label className="field">Used for<input id="ct-use-ref" value={useRef} onChange={(e) => setUseRef(e.target.value)} required placeholder="Job, test or bath" /></label>
                  </div>
                  <ErrorNote message={use.error} /><div><button disabled={use.busy || !useQty || !useRef.trim()}>Post use</button></div>
                </form>
                <form className="form" onSubmit={(e) => { e.preventDefault(); move.clear(); void move.go(false); }}>
                  <h3>Move it</h3>
                  <label className="field">To location<select id="ct-move" value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="">Choose…</option>{(locs.data ?? []).filter((l) => l.id !== c.location_id).map((l) => <option key={l.id} value={l.id}>{l.facility_code} {l.code} ({l.containers} containers)</option>)}</select></label>
                  {move.view}<div><button disabled={move.busy || !to}>Move container</button></div>
                </form>
                <div className="form">
                  <h3>Finish with it</h3>
                  <div><button onClick={() => void empty.run()} disabled={empty.busy}>Mark empty</button></div>
                  <ErrorNote message={empty.error} />
                  <form className="form" onSubmit={(e) => { e.preventDefault(); void dispose.run(); }}>
                    <label className="field">Disposal note<input id="ct-dispose" value={note} onChange={(e) => setNote(e.target.value)} placeholder="How and where it was disposed of" /></label>
                    <ErrorNote message={dispose.error} /><div><button className="danger" disabled={dispose.busy || note.trim().length < 3}>Dispose of it</button></div>
                  </form>
                  <p className="faint">Marking empty or disposing writes any quantity left off the stock ledger.</p>
                </div>
              </div>
            )}
            <h3>History</h3>
            <Table rows={c.events} empty="No history." columns={[{ key: 'created_at', label: 'When', render: (e) => fmtDateTime(e.created_at) }, { key: 'kind', label: 'What', render: (e) => humanize(e.kind) },
              { key: 'detail', label: 'Detail', plain: true, render: (e) => Object.entries(e.data ?? {}).map(([k, v]) => `${humanize(k.replace(/([A-Z])/g, ' $1').toLowerCase())}: ${Array.isArray(v) ? v.join('; ') : String(v)}`).join(' · ') }, { key: 'by', label: 'By' }]} />
          </>
        );
      }}</Async>
    </section>
  );
}

function AddContainer({ onDone }: { onDone: () => void }) {
  const parts = useApi<any[]>('/api/chemicals/parts');
  const locs = useLocations();
  const [f, setF] = useState({ partId: '', locationId: '', lot: '', qty: '', size: '', expiresOn: '', receive: true });
  const set = (k: keyof typeof f, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));
  const part = (parts.data ?? []).find((p) => p.part_id === f.partId);
  const add = useOverridable(async (overrideReason) => {
    await api.post('/api/chemicals/containers', { partId: f.partId, locationId: f.locationId, lot: f.lot.trim(), qty: Number(f.qty), receiveIntoStock: f.receive,
      containerSize: f.size ? Number(f.size) : null, expiresOn: f.expiresOn || null, overrideReason });
    setF({ ...f, lot: '', qty: '', size: '', expiresOn: '' }); onDone();
  });
  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); add.clear(); void add.go(false); }}>
      <h2>Add containers</h2>
      <p className="muted">Receiving a chemical part in Storerooms or against a purchase order makes its containers by itself. Use this to receive a delivery here, or to register containers for stock already on the ledger. A container cannot hold more than the ledger shows for its lot at that location.</p>
      <div className="form-grid">
        <label className="field">Chemical part<select id="ac-part" value={f.partId} onChange={(e) => set('partId', e.target.value)} required>
          <option value="">Choose…</option>{(parts.data ?? []).map((p) => <option key={p.part_id} value={p.part_id}>{p.part_number} {p.description}</option>)}</select></label>
        <label className="field">Location<select id="ac-loc" value={f.locationId} onChange={(e) => set('locationId', e.target.value)} required>
          <option value="">Choose…</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.facility_code} {l.code}</option>)}</select></label>
        <label className="field">Lot<input id="ac-lot" value={f.lot} onChange={(e) => set('lot', e.target.value)} required placeholder="Supplier lot" /></label>
        <label className="field">Total quantity{part ? ` (${part.uom})` : ''}<input id="ac-qty" type="number" min="0" step="any" value={f.qty} onChange={(e) => set('qty', e.target.value)} required /></label>
        <label className="field">Size of each container<input id="ac-size" type="number" min="0" step="any" value={f.size} onChange={(e) => set('size', e.target.value)} placeholder="Blank: one container" disabled={!f.receive} /></label>
        <label className="field">Lot expiry<input id="ac-exp" type="date" value={f.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} disabled={!f.receive} /></label>
        <label className="row" style={{ alignSelf: 'end' }}><input id="ac-receive" type="checkbox" checked={f.receive} onChange={(e) => set('receive', e.target.checked)} /> Also receive into stock</label>
      </div>
      {add.view}
      <div><button disabled={add.busy || !f.partId || !f.locationId || !f.lot.trim() || !f.qty}>Add</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Preparations
// ---------------------------------------------------------------------------
function Preparations({ manage, onChanged }: { manage: boolean; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const { data, loading, error, reload } = useApi<any[]>(`/api/chemicals/preparations?status=${all ? 'all' : 'active'}`);
  const changed = () => { void reload(); onChanged(); };
  return (
    <>
      <section className="card stack">
        <div className="spread"><h2>Reagents and standards</h2><label className="row"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include used up and discarded</label></div>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!} onRow={(p) => setSel(p.id)} exception={(p) => p.expired} empty="No preparations yet."
            columns={[{ key: 'number', label: 'Number', render: (p) => <strong>{p.number}</strong> }, { key: 'name', label: 'Name', render: (p) => <>{p.name}{p.concentration ? <div className="faint">{p.concentration}</div> : null}</> },
              { key: 'kind', label: 'Kind', render: (p) => humanize(p.kind) }, { key: 'prepared_by_name', label: 'Prepared by', render: (p) => <>{p.prepared_by_name}<div className="faint">{fmtDate(p.prepared_on)}</div></> },
              { key: 'qty_remaining', label: 'Left', numeric: true, render: (p) => `${fmtNum(p.qty_remaining, 3)} ${p.uom}` }, { key: 'expires_on', label: 'Expires', render: (p) => fmtDate(p.expires_on) },
              { key: 'status', label: 'State', render: (p) => (p.expired ? <Pill tone="bad" label="Expired" /> : p.status === 'active' ? <Pill tone="good" label="Active" /> : <Pill tone="neutral" label={humanize(p.status)} />), value: (p) => (p.expired ? 'expired' : p.status) }]} />
        )}</Async>
      </section>
      {sel && <PreparationPanel key={sel} id={sel} manage={manage} onClose={() => setSel(null)} onChanged={changed} />}
      {manage && <NewPreparation onDone={changed} />}
    </>
  );
}

function PreparationPanel({ id, manage, onClose, onChanged }: { id: string; manage: boolean; onClose: () => void; onChanged: () => void }) {
  const { data: p, loading, error, reload } = useApi<any>(`/api/chemicals/preparations/${id}`);
  const [qty, setQty] = useState(''); const [note, setNote] = useState('');
  const after = async () => { await reload(); onChanged(); };
  const use = useAction(async () => { await api.post(`/api/chemicals/preparations/${id}/use`, { qty: Number(qty) }); setQty(''); await after(); });
  const discard = useAction(async () => { await api.post(`/api/chemicals/preparations/${id}/discard`, { note: note.trim() }); setNote(''); await after(); });
  return (
    <section className="card stack" aria-label="Preparation detail">
      <Async loading={loading && !p} error={error}>{() => (
        <>
          <div className="spread"><h2>{p.number} <span className="muted" style={{ fontWeight: 400 }}>{p.name}</span></h2>
            <div className="row"><button onClick={() => void api.openPost('/api/chemicals/labels/pdf', { kind: 'preparation', ids: [id] })}>Print label</button><button onClick={onClose}>Close</button></div></div>
          <p className="muted">{humanize(p.kind)}{p.concentration ? `, ${p.concentration}` : ''}. Prepared by {p.prepared_by_name} on {fmtDate(p.prepared_on)}; {fmtNum(p.qty_remaining, 3)} of {fmtNum(p.qty, 3)} {p.uom} left.
            {' '}Expires <strong>{fmtDate(p.expires_on)}</strong>: the earliest of its components' use-by dates{p.shelf_life_days ? ` and the ${p.shelf_life_days}-day shelf life stated for it` : ''}.</p>
          {p.status === 'discarded' && <div className="notice">Discarded {fmtDate(p.discarded_on)}: {p.discard_note}</div>}
          <h3>What went into it</h3>
          <Table rows={p.components} columns={[{ key: 'what', label: 'From', render: (k) => (k.container_number ? <>{k.container_number} {k.part_number}<div className="faint">lot {k.lot_number}</div></> : <>{k.source_number} {k.source_name}</>), plain: true },
            { key: 'qty', label: 'Quantity', numeric: true, render: (k) => `${fmtNum(k.qty, 3)} ${k.uom}` }, { key: 'use_by', label: 'Its use-by', render: (k) => fmtDate(k.use_by) }]} />
          {manage && p.status === 'active' && (
            <div className="grid two">
              <form className="form" onSubmit={(e) => { e.preventDefault(); void use.run(); }}>
                <h3>Draw some</h3>
                <label className="field">Quantity ({p.uom})<input id="pp-use" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
                <ErrorNote message={use.error} /><div><button disabled={use.busy || !qty}>Record</button></div>
              </form>
              <form className="form" onSubmit={(e) => { e.preventDefault(); void discard.run(); }}>
                <h3>Discard</h3>
                <label className="field">Note<input id="pp-discard" value={note} onChange={(e) => setNote(e.target.value)} placeholder="How it was discarded" /></label>
                <ErrorNote message={discard.error} /><div><button className="danger" disabled={discard.busy || note.trim().length < 3}>Discard</button></div>
              </form>
            </div>
          )}
        </>
      )}</Async>
    </section>
  );
}

function NewPreparation({ onDone }: { onDone: () => void }) {
  const locs = useLocations();
  const sites = [...new Map((locs.data ?? []).map((l) => [l.facility_id, l.facility_code])).entries()];
  const [f, setF] = useState({ facilityId: '', name: '', kind: 'reagent', concentration: '', qty: '', uom: 'L', shelfLifeDays: '', notes: '' });
  const [rows, setRows] = useState<{ from: string; qty: string }[]>([{ from: '', qty: '' }]);
  const containers = useApi<any[]>(f.facilityId ? `/api/chemicals/containers?facilityId=${f.facilityId}` : null);
  const preps = useApi<any[]>(f.facilityId ? `/api/chemicals/preparations?facilityId=${f.facilityId}` : null);
  const make = useAction(async () => {
    await api.post('/api/chemicals/preparations', { facilityId: f.facilityId, name: f.name.trim(), kind: f.kind, concentration: f.concentration.trim() || null, qty: Number(f.qty), uom: f.uom.trim(), notes: f.notes.trim() || null,
      shelfLifeDays: f.shelfLifeDays ? Number(f.shelfLifeDays) : null,
      components: rows.filter((r) => r.from && r.qty).map((r) => (r.from.startsWith('c:') ? { containerId: r.from.slice(2), qty: Number(r.qty) } : { preparationId: r.from.slice(2), qty: Number(r.qty) })) });
    setF({ ...f, name: '', concentration: '', qty: '', shelfLifeDays: '', notes: '' }); setRows([{ from: '', qty: '' }]); onDone();
  });
  const ok = f.facilityId && f.name.trim().length >= 2 && Number(f.qty) > 0 && rows.some((r) => r.from && Number(r.qty) > 0);
  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); void make.run(); }}>
      <h2>Make a preparation</h2>
      <p className="muted">Record what went into a reagent or standard. Opening a sealed container to make it starts that container's beyond-use clock, and the quantities are taken off the container and the stock ledger. The new expiry is the earliest of the components' use-by dates and the shelf life you state.</p>
      <div className="form-grid">
        <label className="field">Site<select id="np-site" value={f.facilityId} onChange={(e) => { setF({ ...f, facilityId: e.target.value }); setRows([{ from: '', qty: '' }]); }} required>
          <option value="">Choose…</option>{sites.map(([id, code]) => <option key={id} value={id}>{code}</option>)}</select></label>
        <label className="field">Name<input id="np-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="e.g. 0.1 M HCl" /></label>
        <label className="field">Kind<select id="np-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="reagent">Reagent</option><option value="standard">Standard</option></select></label>
        <label className="field">Concentration<input id="np-conc" value={f.concentration} onChange={(e) => setF({ ...f, concentration: e.target.value })} placeholder="Optional" /></label>
        <label className="field">Quantity made<input id="np-qty" type="number" min="0" step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} required /></label>
        <label className="field">Unit<input id="np-uom" value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} required maxLength={10} /></label>
        <label className="field">Shelf life (days)<input id="np-shelf" type="number" min="1" step="1" value={f.shelfLifeDays} onChange={(e) => setF({ ...f, shelfLifeDays: e.target.value })} placeholder="Needed if no component has a date" /></label>
      </div>
      <h3>Components</h3>
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <select aria-label={`Component ${i + 1}`} value={r.from} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} style={{ flex: '2 1 280px' }}>
            <option value="">Choose a container or preparation…</option>
            <optgroup label="Containers">{(containers.data ?? []).filter((c) => c.status !== 'empty').map((c) => <option key={c.id} value={`c:${c.id}`}>{c.number} {c.part_number} lot {c.lot_number} ({fmtNum(c.qty, 3)} {c.uom})</option>)}</optgroup>
            <optgroup label="Preparations">{(preps.data ?? []).map((p) => <option key={p.id} value={`p:${p.id}`}>{p.number} {p.name} ({fmtNum(p.qty_remaining, 3)} {p.uom})</option>)}</optgroup>
          </select>
          <input aria-label={`Quantity of component ${i + 1}`} type="number" min="0" step="any" placeholder="Quantity" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} style={{ width: 120 }} />
          {rows.length > 1 && <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      <div><button type="button" onClick={() => setRows([...rows, { from: '', qty: '' }])}>Add a component</button></div>
      <ErrorNote message={make.error} />
      <div><button disabled={make.busy || !ok}>Record preparation</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Chemical parts and safety data sheets
// ---------------------------------------------------------------------------
function Parts({ manage, onChanged }: { manage: boolean; onChanged: () => void }) {
  const { can } = useAuth();
  const [q, setQ] = useState(''); const [problem, setProblem] = useState('');
  const [sel, setSel] = useState<any>(null);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(problem ? { problem } : {}) }).toString();
  const { data, loading, error, reload } = useApi<any[]>(`/api/chemicals/parts${qs ? `?${qs}` : ''}`);
  const [pq, setPq] = useState('');
  const found = useApi<any[]>(manage && can('parts.view') && pq.length >= 2 ? `/api/parts?q=${encodeURIComponent(pq)}&limit=20` : null);
  const changed = () => { void reload(); onChanged(); };
  return (
    <>
      <section className="card stack">
        <div className="form-grid">
          <label className="field">Search<input id="cp-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Part, description or CAS number" /></label>
          <label className="field">Show<select id="cp-problem" value={problem} onChange={(e) => setProblem(e.target.value)}>
            <option value="">All chemical parts</option><option value="no_sds">No safety data sheet</option><option value="old_sds">Sheet older than the limit</option><option value="no_group">No storage group</option></select></label>
        </div>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!} rowKey={(p) => p.part_id} onRow={setSel} exception={(p) => p.sdsMissing || p.sdsOld} empty="No chemical parts. Mark a part as a chemical below (it needs lot tracking first)."
            columns={[{ key: 'part_number', label: 'Part', render: (p) => <><strong>{p.part_number}</strong><div className="faint">{p.description}</div></> },
              { key: 'cas_number', label: 'CAS' }, { key: 'hazard_classes', label: 'Hazards', render: (p) => (p.hazard_classes ?? []).map(humanize).join(', ') || '—', value: (p) => (p.hazard_classes ?? []).join(' ') },
              { key: 'signal_word', label: 'Signal', render: (p) => (p.signal_word === 'none' ? '—' : humanize(p.signal_word)) },
              { key: 'group_code', label: 'Storage group', render: (p) => p.group_code ?? <Pill tone="watch" label="None" /> },
              { key: 'sds', label: 'Safety data sheet', render: (p) => (p.sdsMissing ? <Pill tone="bad" label="None" /> : <>{p.sds_doc_number}<div className="faint">rev. {fmtDate(p.sds_revision_on)} {p.sdsOld ? <Pill tone="watch" label="Old" /> : null}</div></>), value: (p) => (p.sdsMissing ? 'none' : p.sds_doc_number) },
              { key: 'containers', label: 'Containers', numeric: true }]} />
        )}</Async>
      </section>
      {sel && <PartPanel key={sel.part_id} part={sel} manage={manage} onClose={() => setSel(null)} onChanged={changed} />}
      {manage && !sel && (
        <section className="card stack">
          <h2>Mark a part as a chemical</h2>
          <label className="field">Find a part<input id="cp-find" value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Part number or description (at least 2 letters)" /></label>
          {!can('parts.view') && <p className="muted">Finding parts needs permission to see the parts list.</p>}
          {found.data && <Table rows={found.data} empty="No part matches." onRow={(p) => setSel({ part_id: p.id, part_number: p.part_number, description: p.description, uom: p.uom, tracking: p.tracking, is_chemical: false, hazard_classes: [], signal_word: 'none' })}
            columns={[{ key: 'part_number', label: 'Part' }, { key: 'description', label: 'Description' }, { key: 'tracking', label: 'Tracking', render: (p) => (p.tracking === 'lot' ? 'Lot' : <Pill tone="watch" label="Needs lot tracking" />) }]} />}
        </section>
      )}
    </>
  );
}

function PartPanel({ part, manage, onClose, onChanged }: { part: any; manage: boolean; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const settings = useApi<any>('/api/chemicals/settings');
  const groups = useApi<any>('/api/chemicals/storage-groups');
  const docs = useApi<any[]>(manage && can('documents.view') ? '/api/documents?limit=500' : null);
  const [f, setF] = useState({
    hazards: new Set<string>(part.hazard_classes ?? []), signal: part.signal_word ?? 'none', cas: part.cas_number ?? '', sds: part.sds_document_id ?? '', sdsOn: part.sds_revision_on ? String(part.sds_revision_on).slice(0, 10) : '',
    group: part.storage_group_id ?? '', days: part.in_use_days ?? '', cond: part.storage_conditions ?? '',
  });
  const save = useAction(async () => {
    await api.put(`/api/chemicals/parts/${part.part_id}`, { isChemical: true, hazardClasses: [...f.hazards], signalWord: f.signal, casNumber: f.cas.trim() || null, sdsDocumentId: f.sds || null, sdsRevisionOn: f.sds ? f.sdsOn || null : null,
      storageGroupId: f.group || null, inUseDays: f.days ? Number(f.days) : null, storageConditions: f.cond.trim() || null });
    onChanged(); onClose();
  });
  const unmark = useAction(async () => { await api.put(`/api/chemicals/parts/${part.part_id}`, { isChemical: false }); onChanged(); onClose(); });
  const toggle = (code: string) => setF((s) => { const h = new Set(s.hazards); if (h.has(code)) h.delete(code); else h.add(code); return { ...s, hazards: h }; });
  return (
    <form className="card form" aria-label={`${part.part_number} chemical attributes`} onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <div className="spread"><h2>{part.part_number} <span className="muted" style={{ fontWeight: 400 }}>{part.description}</span></h2><button type="button" onClick={onClose}>Close</button></div>
      {part.tracking !== 'lot' && <div className="notice warn">This part is not tracked by lot. Switch lot tracking on in Storerooms (the lot carries the expiry) before marking it as a chemical.</div>}
      <fieldset disabled={!manage} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="faint">GHS hazard classes</legend>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {(settings.data?.hazardClasses ?? []).map((h: any) => <label key={h.code} className="row"><input type="checkbox" checked={f.hazards.has(h.code)} onChange={() => toggle(h.code)} /> {h.label} <span className="faint">{h.pictogram}</span></label>)}
        </div>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label className="field">Signal word<select id="pp-signal" value={f.signal} onChange={(e) => setF({ ...f, signal: e.target.value })}><option value="none">None</option><option value="warning">Warning</option><option value="danger">Danger</option></select></label>
          <label className="field">CAS number<input id="pp-cas" value={f.cas} onChange={(e) => setF({ ...f, cas: e.target.value })} placeholder="e.g. 67-64-1" /></label>
          <label className="field">Storage group<select id="pp-group" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
            <option value="">None (storage compatibility is not checked)</option>{(groups.data?.groups ?? []).filter((g: any) => g.active).map((g: any) => <option key={g.id} value={g.id}>{g.code} {g.name}</option>)}</select></label>
          <label className="field">In-use days after opening<input id="pp-days" type="number" min="1" step="1" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} placeholder="Blank: only the expiry limits it" /></label>
          <label className="field">Safety data sheet (controlled document)<select id="pp-sds" value={f.sds} onChange={(e) => setF({ ...f, sds: e.target.value })}>
            <option value="">None</option>{(docs.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.doc_number} {d.title}</option>)}</select></label>
          <label className="field">Sheet revision date<input id="pp-sds-on" type="date" max={today()} value={f.sdsOn} onChange={(e) => setF({ ...f, sdsOn: e.target.value })} disabled={!f.sds} /></label>
          <label className="field">Storage conditions<input id="pp-cond" value={f.cond} onChange={(e) => setF({ ...f, cond: e.target.value })} placeholder="e.g. keep cool, below 25 °C" /></label>
        </div>
      </fieldset>
      {!can('documents.view') && manage && <p className="muted">Choosing a safety data sheet needs permission to see documents. Upload the sheet in Document control first.</p>}
      <ErrorNote message={save.error ?? unmark.error} />
      {manage && <div className="row"><button disabled={save.busy || part.tracking !== 'lot'}>Save</button>{part.is_chemical && <button type="button" className="danger" onClick={() => void unmark.run()} disabled={unmark.busy}>No longer a chemical</button>}</div>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Storage groups and the incompatible list
// ---------------------------------------------------------------------------
function Storage({ manage }: { manage: boolean }) {
  const { data, loading, error, reload } = useApi<any>('/api/chemicals/storage-groups');
  const [g, setG] = useState({ code: '', name: '', description: '' });
  const [pair, setPair] = useState({ a: '', b: '', reason: '' });
  const addGroup = useAction(async () => { await api.post('/api/chemicals/storage-groups', { code: g.code, name: g.name, description: g.description || null }); setG({ code: '', name: '', description: '' }); await reload(); });
  const addPair = useAction(async () => { await api.post('/api/chemicals/incompatible-pairs', { groupA: pair.a, groupB: pair.b, reason: pair.reason || null }); setPair({ a: '', b: '', reason: '' }); await reload(); });
  const removePair = useAction(async (id: string) => { await api.delete(`/api/chemicals/incompatible-pairs/${id}`); await reload(); });
  return (
    <Async loading={loading && !data} error={error}>{() => (
      <>
        <div className="notice warn"><strong>Not certified.</strong> {data.starterNote}</div>
        <section className="card stack">
          <h2>Storage groups</h2>
          <Table rows={data.groups} empty="None." columns={[{ key: 'code', label: 'Code', render: (x) => <strong>{x.code}</strong> }, { key: 'name', label: 'Name' }, { key: 'description', label: 'Description' },
            { key: 'parts', label: 'Chemical parts', numeric: true }, { key: 'starter', label: '', render: (x) => (x.starter ? <Pill tone="neutral" label="Starter" /> : null) }]} />
          {manage && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void addGroup.run(); }}>
              <div className="form-grid">
                <label className="field">Code<input id="sg-code" value={g.code} onChange={(e) => setG({ ...g, code: e.target.value })} required maxLength={20} /></label>
                <label className="field">Name<input id="sg-name" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} required /></label>
                <label className="field">Description<input id="sg-desc" value={g.description} onChange={(e) => setG({ ...g, description: e.target.value })} /></label>
              </div>
              <ErrorNote message={addGroup.error} /><div><button disabled={addGroup.busy || !g.code || !g.name}>Add storage group</button></div>
            </form>
          )}
        </section>
        <section className="card stack">
          <h2>Incompatible pairs</h2>
          <p className="muted">A container cannot be placed, received or moved into a location that already holds a container from an incompatible group. Someone holding the override permission can place it anyway with a reason, which is kept in the audit trail.</p>
          <Table rows={data.pairs} empty="No pairs: nothing is refused." columns={[{ key: 'a', label: 'Group', render: (p) => `${p.code_a} ${p.name_a}`, value: (p) => p.code_a }, { key: 'b', label: 'Not beside', render: (p) => `${p.code_b} ${p.name_b}`, value: (p) => p.code_b },
            { key: 'reason', label: 'Why' }, { key: 'rm', label: '', plain: true, render: (p) => (manage ? <button onClick={(e) => { e.stopPropagation(); void removePair.run(p.id); }} aria-label={`Remove the pair ${p.code_a} and ${p.code_b}`}>Remove</button> : null) }]} />
          <ErrorNote message={removePair.error} />
          {manage && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void addPair.run(); }}>
              <div className="form-grid">
                <label className="field">Group<select id="ip-a" value={pair.a} onChange={(e) => setPair({ ...pair, a: e.target.value })} required><option value="">Choose…</option>{data.groups.map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</select></label>
                <label className="field">Not beside<select id="ip-b" value={pair.b} onChange={(e) => setPair({ ...pair, b: e.target.value })} required><option value="">Choose…</option>{data.groups.map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</select></label>
                <label className="field">Why<input id="ip-reason" value={pair.reason} onChange={(e) => setPair({ ...pair, reason: e.target.value })} /></label>
              </div>
              <ErrorNote message={addPair.error} /><div><button disabled={addPair.busy || !pair.a || !pair.b}>Add pair</button></div>
            </form>
          )}
        </section>
      </>
    )}</Async>
  );
}

// ---------------------------------------------------------------------------
// Limits and settings
// ---------------------------------------------------------------------------
function Limits({ manage, onChanged }: { manage: boolean; onChanged: () => void }) {
  const settings = useApi<any>('/api/chemicals/settings');
  const limits = useApi<any[]>('/api/chemicals/limits');
  const locs = useLocations();
  const [years, setYears] = useState('');
  const [f, setF] = useState({ locationId: '', hazardClass: '', limitQty: '', uom: 'L', note: '' });
  const saveSettings = useAction(async (patch: object) => { await api.put('/api/chemicals/settings', patch); await settings.reload(); onChanged(); });
  const setLimit = useAction(async () => { await api.put('/api/chemicals/limits', { locationId: f.locationId, hazardClass: f.hazardClass, limitQty: Number(f.limitQty), uom: f.uom.trim(), note: f.note || null }); setF({ ...f, limitQty: '', note: '' }); await limits.reload(); });
  const del = useAction(async (id: string) => { await api.delete(`/api/chemicals/limits/${id}`); await limits.reload(); });
  const s = settings.data;
  return (
    <>
      <section className="card stack">
        <h2>Settings</h2>
        {s && (
          <div className="stack">
            <form className="row" onSubmit={(e) => { e.preventDefault(); void saveSettings.run({ sdsMaxAgeYears: Number(years || s.sdsMaxAgeYears) }); }}>
              <label className="field">Flag a safety data sheet older than (years)<input id="st-years" type="number" min="1" max="20" step="1" value={years || s.sdsMaxAgeYears} onChange={(e) => setYears(e.target.value)} disabled={!manage} style={{ width: 120 }} /></label>
              {manage && <button style={{ alignSelf: 'end' }} disabled={saveSettings.busy}>Save</button>}
            </form>
            <label className="row"><input type="checkbox" checked={s.receiptContainers} disabled={!manage || saveSettings.busy} onChange={(e) => void saveSettings.run({ receiptContainers: e.target.checked })} /> Receiving a chemical part makes its containers</label>
            <p className="muted">How far ahead expiry alerts warn (14 days to start) is set under Reminders, with the other reminders.</p>
            <ErrorNote message={saveSettings.error} />
          </div>
        )}
      </section>
      <section className="card stack">
        <h2>Quantity limits by location</h2>
        <p className="muted">The platform ships no regulatory limits. Enter the limit your fire plan, permit or policy sets for a hazard class in a location, and the Hazardous inventory report compares what is stored against it. Check your own limits against the rules that apply to your site.</p>
        <Async loading={limits.loading && !limits.data} error={limits.error}>{() => (
          <Table rows={limits.data!} empty="No limits set." columns={[{ key: 'location_code', label: 'Location', render: (l) => `${l.facility_code} ${l.location_code}` }, { key: 'hazard_label', label: 'Hazard class', render: (l) => l.hazard_label ?? humanize(l.hazard_class) },
            { key: 'limit_qty', label: 'Limit', numeric: true, render: (l) => `${fmtNum(l.limit_qty, 3)} ${l.uom}` }, { key: 'note', label: 'Note' },
            { key: 'rm', label: '', plain: true, render: (l) => (manage ? <button onClick={() => void del.run(l.id)} aria-label={`Remove the ${l.hazard_class} limit at ${l.location_code}`}>Remove</button> : null) }]} />
        )}</Async>
        <ErrorNote message={del.error} />
        {manage && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void setLimit.run(); }}>
            <div className="form-grid">
              <label className="field">Location<select id="lm-loc" value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })} required><option value="">Choose…</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.facility_code} {l.code}</option>)}</select></label>
              <label className="field">Hazard class<select id="lm-class" value={f.hazardClass} onChange={(e) => setF({ ...f, hazardClass: e.target.value })} required><option value="">Choose…</option>{(s?.hazardClasses ?? []).map((h: any) => <option key={h.code} value={h.code}>{h.label}</option>)}</select></label>
              <label className="field">Limit<input id="lm-qty" type="number" min="0" step="any" value={f.limitQty} onChange={(e) => setF({ ...f, limitQty: e.target.value })} required /></label>
              <label className="field">Unit<input id="lm-uom" value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} required maxLength={10} /></label>
              <label className="field">Note<input id="lm-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Where the limit comes from" /></label>
            </div>
            <ErrorNote message={setLimit.error} /><div><button disabled={setLimit.busy || !f.locationId || !f.hazardClass || !f.limitQty}>Set limit</button></div>
          </form>
        )}
      </section>
    </>
  );
}
