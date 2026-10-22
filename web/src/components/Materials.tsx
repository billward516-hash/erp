import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';
import { Async, ErrorNote, Pill, Table } from './ui';

/** Part search used by the spares and template forms. */
function PartPicker({ onPick, exclude = [] }: { onPick: (p: any) => void; exclude?: string[] }) {
  const [q, setQ] = useState('');
  const parts = useApi<any[]>(q.length >= 2 ? `/api/parts?q=${encodeURIComponent(q)}&limit=8` : null);
  return (
    <div className="stack">
      <input aria-label="Find a part" placeholder="Find a part: number or description" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row">{(parts.data ?? []).filter((p) => !exclude.includes(p.id)).map((p) => (
        <button type="button" key={p.id} onClick={() => { onPick(p); setQ(''); }}>+ {p.part_number} <span className="faint">{p.description}</span></button>
      ))}</div>
    </div>
  );
}

export function AssetSpares({ assetId, facilityId }: { assetId: string; facilityId: string }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>(`/api/assets/${assetId}/parts`);
  const [f, setF] = useState<{ part: any; qty: string; position: string; critical: boolean; min: string } | null>(null);
  const save = useAction(async () => {
    await api.put(`/api/assets/${assetId}/parts/${f!.part.id}`, { qtyInstalled: Number(f!.qty) || 1, position: f!.position || null, critical: f!.critical, minOnHand: f!.min ? Number(f!.min) : null });
    setF(null); await reload();
  });
  const remove = useAction(async (partId: string) => { await api.delete(`/api/assets/${assetId}/parts/${partId}`); await reload(); });
  const manage = can('assets.manage', facilityId);
  return (
    <section className="card stack">
      <h2>Spare parts</h2>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(p) => p.part_id} empty="No parts list yet. Add parts, or import the OEM's recommended spares list." exception={(p) => p.below_min}
          columns={[{ key: 'part_number', label: 'Part', render: (p) => <>{p.part_number}{p.critical && <> <Pill tone="watch" label="Critical" /></>}</> }, { key: 'description', label: 'Description' },
            { key: 'position', label: 'Where' }, { key: 'qty_installed', label: 'Installed', numeric: true, render: (p) => fmtNum(p.qty_installed, 3) },
            { key: 'available', label: 'Available at site', numeric: true, render: (p) => <>{fmtNum(p.available, 3)}{p.below_min && <> <Pill tone="bad" label={`min ${p.min_on_hand ?? 1}`} /></>}</> },
            { key: 'also_used_on', label: 'Also on' },
            ...(manage ? [{ key: 'x', label: '', render: (p: any) => <button className="link" onClick={() => remove.run(p.part_id)} disabled={remove.busy}>Remove</button> }] : [])]} />
      )}</Async>
      {manage && (f ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <strong>{f.part.part_number}</strong>
          <input aria-label="Installed" type="number" min="0" step="any" placeholder="Installed" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} style={{ width: 90 }} />
          <input aria-label="Where on the machine" placeholder="Where on the machine" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />
          <label className="row"><input type="checkbox" checked={f.critical} onChange={(e) => setF({ ...f, critical: e.target.checked })} />Critical</label>
          {f.critical && <input aria-label="Keep on hand" type="number" min="0" step="any" placeholder="Keep on hand" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} style={{ width: 110 }} />}
          <button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={() => setF(null)}>Cancel</button><ErrorNote message={save.error} />
        </form>
      ) : <PartPicker exclude={(data ?? []).map((p) => p.part_id)} onPick={(p) => setF({ part: p, qty: '1', position: '', critical: false, min: '' })} />)}
    </section>
  );
}

export function RepairTemplates({ assetId, category }: { assetId: string; category: string | null }) {
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>(`/api/repair-templates?assetId=${assetId}`);
  const [f, setF] = useState<{ code: string; title: string; scope: 'asset' | 'category'; hours: string; parts: { part: any; qty: string }[] } | null>(null);
  const save = useAction(async () => {
    await api.post('/api/repair-templates', { code: f!.code, title: f!.title, assetId: f!.scope === 'asset' ? assetId : null, assetCategory: f!.scope === 'category' ? category : null,
      estLaborHours: f!.hours ? Number(f!.hours) : null, parts: f!.parts.map((p) => ({ partId: p.part.id, qty: Number(p.qty) })) });
    setF(null); await reload();
  });
  return (
    <section className="card stack">
      <h2>Repair templates</h2>
      <Table rows={data ?? []} empty="No repair templates for this machine."
        columns={[{ key: 'code', label: 'Code' }, { key: 'title', label: 'Job' }, { key: 'scope', label: 'Applies to', render: (t) => (t.asset_id ? 'This machine' : `All ${t.asset_category}`) },
          { key: 'est_labor_hours', label: 'Labor', numeric: true, render: (t) => (t.est_labor_hours != null ? `${t.est_labor_hours} h` : '—') },
          { key: 'parts', label: 'Parts (repair BOM)', render: (t) => t.parts.map((p: any) => `${p.qty} × ${p.part_number}`).join(', ') || '—' },
          { key: 'cost', label: 'Parts cost', numeric: true, render: (t) => fmtMoney(t.parts.reduce((s: number, p: any) => s + p.qty * (p.unit_cost ?? 0), 0)) }]} />
      {can('work_orders.manage') && (f ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="row">
            <input aria-label="Code" placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required style={{ width: 160 }} />
            <input aria-label="Job" placeholder="Job, e.g. Replace spindle drawbar seals" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required style={{ flex: '1 1 260px' }} />
            <select aria-label="Applies to" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as 'asset' | 'category' })}>
              <option value="asset">This machine</option>{category && <option value="category">All {category}</option>}
            </select>
            <input aria-label="Labor hours" type="number" min="0" step="any" placeholder="Labor h" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} style={{ width: 90 }} />
          </div>
          {f.parts.map((p, i) => (
            <div className="row" key={p.part.id}><strong>{p.part.part_number}</strong>
              <input aria-label={`Qty ${p.part.part_number}`} type="number" min="0" step="any" value={p.qty} onChange={(e) => setF({ ...f, parts: f.parts.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })} style={{ width: 90 }} />
              <button type="button" className="link" onClick={() => setF({ ...f, parts: f.parts.filter((_, j) => j !== i) })}>Remove</button></div>
          ))}
          <PartPicker exclude={f.parts.map((p) => p.part.id)} onPick={(p) => setF({ ...f, parts: [...f.parts, { part: p, qty: '1' }] })} />
          <div className="row"><button className="primary" disabled={save.busy}>Save template</button><button type="button" onClick={() => setF(null)}>Cancel</button><ErrorNote message={save.error} /></div>
        </form>
      ) : <div><button onClick={() => setF({ code: '', title: '', scope: 'asset', hours: '', parts: [] })}>New repair template</button></div>)}
    </section>
  );
}

const KIT_TONE: Record<string, 'good' | 'watch' | 'bad' | 'info' | 'neutral'> = { reserved: 'info', staged: 'good', issued: 'good', closed: 'neutral', cancelled: 'neutral' };

/** Repair template and kit controls on a work order. */
export function WorkOrderMaterials({ w, onDone }: { w: any; onDone: () => void }) {
  const { can } = useAuth();
  const f = w.facility_id;
  const open = ['planned', 'scheduled', 'in_progress', 'on_hold'].includes(w.status);
  const templates = useApi<any[]>(can('work_orders.manage', f) && open ? `/api/repair-templates?assetId=${w.asset_id}` : null);
  const kit = useApi<any>(`/api/work-orders/${w.id}/kit`);
  const [tpl, setTpl] = useState('');
  const [staging, setStaging] = useState('');
  const [ret, setRet] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const after = async () => { await kit.reload(); onDone(); };
  const apply = useAction(async () => { await api.post(`/api/work-orders/${w.id}/apply-template`, { templateId: tpl }); setTpl(''); await after(); });
  const create = useAction(async () => { await api.post(`/api/work-orders/${w.id}/kit`, {}); await after(); });
  const refresh = useAction(async () => { await api.post(`/api/kits/${kit.data.id}/refresh`, {}); await after(); });
  const stage = useAction(async () => { await api.post(`/api/kits/${kit.data.id}/stage`, { stagingLocationId: staging || kit.data.stagingLocations[0]?.id }); await after(); });
  const issue = useAction(async () => { await api.post(`/api/kits/${kit.data.id}/issue`, {}); await after(); });
  const close = useAction(async () => { await api.post(`/api/kits/${kit.data.id}/close`, { returns: Object.entries(ret).map(([kitLineId, q]) => ({ kitLineId, qty: Number(q) || 0 })) }); setRet({}); await after(); });
  const cancel = useAction(async () => { await api.post(`/api/kits/${kit.data.id}/cancel`, { reason }); setReason(''); await after(); });
  const k = kit.data;
  const active = k && !['closed', 'cancelled'].includes(k.status);
  const hasPlanned = w.parts.some((p: any) => p.qty_planned > p.qty_used);
  return (
    <section className="card stack">
      <div className="spread"><h2>Kit</h2>{k && <span><Pill tone={KIT_TONE[k.status]} label={`${k.number} · ${humanize(k.status)}`} />{k.short > 0 && k.status === 'reserved' && <> <Pill tone="bad" label={`${k.short} short`} /></>}</span>}</div>
      {(templates.data?.length ?? 0) > 0 && (
        <div className="row">
          <select aria-label="Repair template" value={tpl} onChange={(e) => setTpl(e.target.value)}>
            <option value="">Apply a repair template…</option>{templates.data!.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.title}</option>)}
          </select>
          <button onClick={() => apply.run()} disabled={!tpl || apply.busy}>Apply</button><ErrorNote message={apply.error} />
        </div>
      )}
      {!active && (open && hasPlanned && can('work_orders.manage', f)
        ? <div className="row"><button className="primary" onClick={() => create.run()} disabled={create.busy}>Build kit from planned parts</button>
          <span className="faint">Reserves the parts in the storeroom so they are there when the job starts.</span><ErrorNote message={create.error} /></div>
        : !k && <p className="muted">{hasPlanned ? 'No kit.' : 'Plan parts (or apply a repair template) to build a kit.'}</p>)}
      {k && (
        <>
          <Table rows={k.lines}
            columns={[{ key: 'part_number', label: 'Part', render: (l) => <>{l.part_number} <span className="faint">{l.description}</span></> },
              { key: 'from_location', label: 'From', render: (l) => <>{l.from_location ?? '—'}{l.bin ? <span className="faint"> {l.bin}</span> : null}</> },
              { key: 'qty_needed', label: 'Needed', numeric: true, render: (l) => fmtNum(l.qty_needed, 3) },
              { key: 'qty_reserved', label: 'Reserved', numeric: true, render: (l) => (l.qty_reserved < l.qty_needed ? <span className="bad-text">{fmtNum(l.qty_reserved, 3)}</span> : fmtNum(l.qty_reserved, 3)) },
              { key: 'qty_staged', label: 'Staged', numeric: true, render: (l) => fmtNum(l.qty_staged, 3) }, { key: 'qty_issued', label: 'Issued', numeric: true, render: (l) => fmtNum(l.qty_issued, 3) },
              { key: 'qty_returned', label: 'Returned', numeric: true, render: (l) => fmtNum(l.qty_returned, 3) },
              ...(k.status === 'issued' && can('work_orders.execute', f) ? [{ key: 'ret', label: 'Return unused', render: (l: any) => (
                <input aria-label={`Return ${l.part_number}`} type="number" min="0" max={l.qty_issued - l.qty_returned} step="any" value={ret[l.id] ?? ''} onChange={(e) => setRet({ ...ret, [l.id]: e.target.value })} style={{ width: 80 }} />) }] : [])]} />
          <p className="faint">Needed by {fmtDateTime(k.needed_by)}{k.staging_location ? ` · staged in ${k.staging_location}` : ''}</p>
          <div className="row">
            {k.status === 'reserved' && k.short > 0 && can('work_orders.manage', f) && <button onClick={() => refresh.run()} disabled={refresh.busy}>Refresh from stock</button>}
            {k.status === 'reserved' && k.stagingLocations.length > 0 && (
              <>
                {k.stagingLocations.length > 1 && <select aria-label="Staging location" value={staging} onChange={(e) => setStaging(e.target.value)}>{k.stagingLocations.map((s: any) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>}
                <button onClick={() => stage.run()} disabled={stage.busy || k.short > 0}>Stage kit{k.stagingLocations.length === 1 ? ` in ${k.stagingLocations[0].code}` : ''}</button>
              </>
            )}
            {['reserved', 'staged'].includes(k.status) && open && can('work_orders.execute', f) && <button className="primary" onClick={() => issue.run()} disabled={issue.busy}>Issue kit to this job</button>}
            {k.status === 'issued' && can('work_orders.execute', f) && <button onClick={() => close.run()} disabled={close.busy}>Return unused and close kit</button>}
          </div>
          <ErrorNote message={refresh.error ?? stage.error ?? issue.error ?? close.error} />
          {['reserved', 'staged'].includes(k.status) && can('work_orders.manage', f) && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void cancel.run(); }}>
              <input aria-label="Cancel reason" placeholder="Why the kit is not needed" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 260px' }} />
              <button className="danger" disabled={cancel.busy || reason.trim().length < 3}>Cancel kit</button><ErrorNote message={cancel.error} />
            </form>
          )}
        </>
      )}
    </section>
  );
}

/** Kits to pick and stage, for the storeroom. */
export function KitList() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/api/kits?open=true');
  return (
    <div className="card">
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} onRow={(k) => nav(`/work-orders/${k.work_order_id}`)} exception={(k) => k.short > 0} empty="No open kits."
          columns={[{ key: 'number', label: 'Kit', render: (k) => <strong>{k.number}</strong> }, { key: 'facility_code', label: 'Site' },
            { key: 'wo_number', label: 'Work order', render: (k) => <Link to={`/work-orders/${k.work_order_id}`}>{k.wo_number}</Link> }, { key: 'asset_tag', label: 'Asset' },
            { key: 'wo_title', label: 'Job' }, { key: 'needed_by', label: 'Needed by', render: (k) => fmtDate(k.needed_by) }, { key: 'lines', label: 'Lines', numeric: true },
            { key: 'status', label: 'Status', render: (k) => <><Pill tone={KIT_TONE[k.status]} label={humanize(k.status)} />{k.short > 0 && <> <Pill tone="bad" label={`${k.short} short`} /></>}</> }]} />
      )}</Async>
    </div>
  );
}
