import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ControlChart } from '../components/ControlChart';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, fmtNum } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, [string, 'good' | 'watch' | 'bad' | 'neutral' | 'info']> = {
  signal: ['Signal open', 'bad'], watch: ['Rule broken, answered', 'watch'], in_control: ['In control', 'good'], study: ['Initial study', 'info'], inactive: ['Not measured', 'neutral'],
};
export const RULE: Record<string, string> = {
  beyond_limits: 'Beyond a control limit', run_of_9: '9 in a row on one side', trend_of_6: '6 in a row rising or falling', two_of_three: '2 of 3 beyond 2σ',
  range_beyond: 'Range beyond its limit', out_of_spec: 'Out of tolerance', four_of_five: '4 of 5 beyond 1σ', eight_beyond_1: '8 in a row beyond 1σ',
  fifteen_in_c: '15 in a row within 1σ', alternating_14: '14 in a row alternating',
};
const CHART: Record<string, string> = { p: 'p chart · fraction defective', np: 'np chart · number defective', c: 'c chart · defects per inspection unit', u: 'u chart · defects per unit' };
/** "3.20% defective" for p/np, "0.84 defects per unit" for c/u. */
const rateText = (type: string, rate: number | null) => (rate == null ? '—' : type === 'p' || type === 'np' ? `${(rate * 100).toFixed(2)}% defective` : `${rate.toFixed(2)} per unit`);
const capTone = (c: number | null) => (c == null ? undefined : c >= 1.33 ? 'good' : c >= 1 ? 'watch' : 'bad') as 'good' | 'watch' | 'bad' | undefined;
const short = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function SpcList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/spc/characteristics');
  const rows = data ?? [];
  const [show, setShow] = useState(false);
  return (
    <>
      <AlarmSummary />
      <Kpis items={[
        { label: 'Characteristics measured', value: rows.filter((r) => r.active).length },
        { label: 'With open signals', value: rows.filter((r) => r.status === 'signal').length, tone: rows.some((r) => r.status === 'signal') ? 'bad' : 'good' },
        { label: 'Below Cpk 1.33', value: rows.filter((r) => r.cpk != null && r.cpk < 1.33).length, tone: rows.some((r) => r.cpk != null && r.cpk < 1) ? 'bad' : undefined },
      ]} />
      <div className="card stack">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} rowKey={(r) => r.id} onRow={(r) => nav(`/quality/spc/${r.id}`)} exception={(r) => r.status === 'signal'} empty="No characteristics yet. Set one up for each dimension or process value you chart."
            columns={[{ key: 'code', label: 'Code', render: (r) => <strong>{r.code}</strong> }, { key: 'name', label: 'Characteristic' },
              { key: 'partNumber', label: 'Part / op', render: (r) => (r.partNumber ? `${r.partNumber}${r.opNo != null ? ` op ${r.opNo}` : ''}` : '—') },
              { key: 'gaugeTag', label: 'Gauge', render: (r) => r.gaugeTag ?? '—' },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={STATUS[r.status]![1]} label={STATUS[r.status]![0]} /> },
              { key: 'cpk', label: 'Cpk / defect rate', numeric: true, render: (r) => (r.chartType !== 'variables' ? rateText(r.chartType, r.rate)
                : r.cpk == null ? '—' : <span className={r.cpk < 1 ? 'bad-text' : undefined}>{r.cpk.toFixed(2)}</span>) },
              { key: 'subgroups', label: 'Subgroups', numeric: true }, { key: 'lastMeasured', label: 'Last measured', render: (r) => fmtDateTime(r.lastMeasured) }]} />
        )}</Async>
        <p className="faint">Signals are raised against limits set from at least 20 subgroups; out-of-tolerance values always alert quality. Cpk ≥ 1.33 is the usual target.</p>
      </div>
      <RuleSettings />
      {can('quality.manage') && !show && <div><button onClick={() => setShow(true)}>Set up a characteristic</button></div>}
      {show && <NewCharacteristic onDone={async (id) => { setShow(false); await reload(); nav(`/quality/spc/${id}`); }} onCancel={() => setShow(false)} />}
    </>
  );
}

function NewCharacteristic({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const facilities = useApi<any[]>('/api/facilities');
  const products = useApi<any[]>('/api/products');
  const [f, setF] = useState({ facilityId: '', code: '', name: '', partId: '', opNo: '', gaugeAssetId: '', unit: 'mm', nominal: '', lsl: '', usl: '', subgroupSize: '5', frequency: '', chartType: 'variables', sampleSize: '' });
  const attr = f.chartType !== 'variables';
  const assets = useApi<any[]>(f.facilityId ? `/api/assets?facilityId=${f.facilityId}&limit=500` : null);
  const n = (v: string) => (v === '' ? null : Number(v));
  const save = useAction(async () => {
    const c = await api.post('/api/spc/characteristics', { facilityId: f.facilityId, code: f.code, name: f.name, partId: f.partId || null, opNo: n(f.opNo), gaugeAssetId: f.gaugeAssetId || null,
      unit: attr ? undefined : f.unit, nominal: n(f.nominal), lsl: n(f.lsl), usl: n(f.usl), subgroupSize: attr ? 1 : Number(f.subgroupSize), frequency: f.frequency || null,
      chartType: f.chartType, sampleSize: attr ? n(f.sampleSize) : null });
    onDone(c.id);
  });
  return (
    <section className="card stack">
      <h2>Set up a characteristic</h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="row">
          <select id="spc-facility" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required style={{ width: 'auto' }}>
            <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </select>
          <input id="spc-code" aria-label="Code" placeholder="Code, e.g. HSG-BORE" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required style={{ width: 160 }} />
          <input id="spc-name" aria-label="Name" placeholder="Name, e.g. Bore diameter" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required style={{ flex: '1 1 200px' }} />
        </div>
        <div className="row">
          <select aria-label="Part" value={f.partId} onChange={(e) => setF({ ...f, partId: e.target.value })} style={{ width: 'auto' }}>
            <option value="">No part (process value)</option>{(products.data ?? []).map((p) => <option key={p.part_id} value={p.part_id}>{p.part_number}</option>)}
          </select>
          <input aria-label="Operation" type="number" placeholder="Op" value={f.opNo} onChange={(e) => setF({ ...f, opNo: e.target.value })} style={{ width: 80 }} />
          <select aria-label="Gauge" value={f.gaugeAssetId} onChange={(e) => setF({ ...f, gaugeAssetId: e.target.value })} style={{ width: 'auto' }}>
            <option value="">No gauge</option>{(assets.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.asset_tag} {a.name}</option>)}
          </select>
        </div>
        <div className="row">
          <select id="spc-type" aria-label="What is recorded" value={f.chartType} onChange={(e) => setF({ ...f, chartType: e.target.value })} style={{ width: 'auto' }}>
            <option value="variables">Measurements (X̄–R or individuals)</option><option value="p">Defective parts in a sample (p)</option><option value="np">Defective parts in a fixed sample (np)</option>
            <option value="c">Defects in a fixed inspection unit (c)</option><option value="u">Defects per unit, units vary (u)</option>
          </select>
          {(f.chartType === 'np' || f.chartType === 'c') && <input id="spc-sample" aria-label="Fixed sample size" type="number" min="1" step="any" placeholder={f.chartType === 'np' ? 'Parts per sample' : 'Unit size (optional)'}
            value={f.sampleSize} onChange={(e) => setF({ ...f, sampleSize: e.target.value })} required={f.chartType === 'np'} style={{ width: 150 }} />}
        </div>
        {!attr && <div className="row">
          <input aria-label="Unit" placeholder="Unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} style={{ width: 80 }} />
          <input aria-label="Nominal" type="number" step="any" placeholder="Nominal" value={f.nominal} onChange={(e) => setF({ ...f, nominal: e.target.value })} style={{ width: 110 }} />
          <input id="spc-lsl" aria-label="Lower tolerance" type="number" step="any" placeholder="Lower limit" value={f.lsl} onChange={(e) => setF({ ...f, lsl: e.target.value })} style={{ width: 110 }} />
          <input id="spc-usl" aria-label="Upper tolerance" type="number" step="any" placeholder="Upper limit" value={f.usl} onChange={(e) => setF({ ...f, usl: e.target.value })} style={{ width: 110 }} />
          <label className="row">Subgroup of <select id="spc-n" aria-label="Subgroup size" value={f.subgroupSize} onChange={(e) => setF({ ...f, subgroupSize: e.target.value })} style={{ width: 'auto' }}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((k) => <option key={k} value={k}>{k === 1 ? '1 (single readings)' : k}</option>)}</select></label>
        </div>}
        <div className="row">
          <input aria-label="Frequency" placeholder='How often, e.g. "5 parts every 2 h"' value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })} style={{ flex: '1 1 200px' }} />
        </div>
        <div className="row"><button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={onCancel}>Cancel</button><ErrorNote message={save.error} /></div>
      </form>
    </section>
  );
}

export function SpcDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: c, loading, error, reload } = useApi<any>(`/api/spc/characteristics/${id}`);
  return (
    <Async loading={loading && !c} error={error}>{() => {
      if (c.chart_type !== 'variables') return <AttributeDetail c={c} reload={reload} />;
      const L = c.limits;
      const n = c.subgroup_size;
      const tipOf = (s: any) => [short(s.measuredAt), n > 1 ? `values ${s.values.join(', ')}` : null, s.lot ? `lot ${s.lot}` : null, s.orderNumber,
        ...s.rules.map((r: string) => RULE[r] ?? r), s.excluded ? `excluded: ${s.excludeReason}` : null, s.suspect].filter(Boolean) as string[];
      const flag = (s: any) => (s.excluded ? 'excluded' : s.rules.length || s.signals.length ? 'signal' : s.suspect ? 'suspect' : null) as any;
      const open = c.signals.filter((s: any) => s.status === 'open');
      const cap = c.capability;
      const spec = n === 1 ? [...(c.lsl != null ? [{ y: c.lsl, label: 'LSL', kind: 'spec' as const }] : []), ...(c.usl != null ? [{ y: c.usl, label: 'USL', kind: 'spec' as const }] : [])] : [];
      return (
        <>
          <PageHead eyebrow={`${c.facility_code} · SPC · ${n === 1 ? 'individuals and moving range' : `X̄ and R, subgroups of ${n}`}`} title={`${c.code} ${c.name}`}
            sub={[c.part_number && `${c.part_number}${c.op_no != null ? ` op ${c.op_no}` : ''}`, c.asset_tag && `machine ${c.asset_tag}`, c.gauge_tag && `gauge ${c.gauge_tag}`,
              `tolerance ${c.lsl ?? '—'} to ${c.usl ?? '—'} ${c.unit}`, c.frequency].filter(Boolean).join(' · ')}
            actions={<Pill tone={open.length ? 'bad' : L && !L.trial ? 'good' : 'info'} label={open.length ? `${open.length} open signal${open.length === 1 ? '' : 's'}` : L && !L.trial ? 'Limits set' : 'Initial study'} />} />
          <Kpis items={[
            { label: 'Cpk (within)', value: cap.cpk == null ? '—' : cap.cpk.toFixed(2), tone: capTone(cap.cpk), note: cap.cp != null ? `Cp ${cap.cp.toFixed(2)}` : undefined },
            { label: 'Ppk (overall)', value: cap.ppk == null ? '—' : cap.ppk.toFixed(2), tone: capTone(cap.ppk), note: cap.pp != null ? `Pp ${cap.pp.toFixed(2)}` : undefined },
            { label: 'Mean', value: cap.mean == null ? '—' : fmtNum(cap.mean, 4), note: c.nominal != null ? `nominal ${c.nominal}` : undefined },
            { label: 'Values out of tolerance', value: cap.outOfSpec, tone: cap.outOfSpec ? 'bad' : 'good', note: `of ${cap.values}` },
          ]} />
          {open.length > 0 && <Signals signals={open} canAnswer={can('quality.manage')} onDone={reload} />}
          <section className="card stack">
            {L ? <>
              <ControlChart title={`${n === 1 ? 'Individuals' : 'Subgroup means (X̄)'}${L.trial ? ' · trial limits' : ''}`} unit={c.unit}
                points={c.subgroups.map((s: any) => ({ id: s.id, y: s.x, label: short(s.measuredAt), flag: flag(s), tip: tipOf(s) }))}
                lines={[{ y: L.ucl, label: 'UCL', kind: 'limit' }, { y: L.center, label: n === 1 ? 'X̄' : 'X̄̄', kind: 'center' }, { y: L.lcl, label: 'LCL', kind: 'limit' }, ...spec]} />
              <ControlChart title={n === 1 ? 'Moving range' : 'Range (R)'} unit={c.unit}
                points={c.subgroups.map((s: any) => ({ id: s.id, y: s.r, label: short(s.measuredAt), flag: s.excluded ? 'excluded' : s.rules.includes('range_beyond') ? 'signal' : null, tip: tipOf(s) }))}
                lines={[{ y: L.rangeUcl, label: 'UCL', kind: 'limit' }, { y: L.rangeCenter, label: n === 1 ? 'MR̄' : 'R̄', kind: 'center' }, ...(L.rangeLcl > 0 ? [{ y: L.rangeLcl, label: 'LCL', kind: 'limit' as const }] : [])]} />
              <p className="faint">{L.trial ? 'Trial limits from the points shown.' : `Limits set ${fmtDateTime(L.setAt)} by ${L.setBy} from ${L.subgroups} subgroups: ${L.reason}.`} Diamonds break a rule; hollow points are excluded; σ within = {fmtNum(L.sigma, 6)} {c.unit}.</p>
            </> : <p className="muted">Record at least two {n === 1 ? 'readings' : 'subgroups'} to draw the chart.</p>}
            <ul className="faint" style={{ margin: 0, paddingLeft: 18 }}>{c.warnings.map((x: string) => <li key={x}>{x}</li>)}</ul>
            {can('quality.manage') && <SetLimits id={c.id} count={c.includedSubgroups} onDone={reload} />}
          </section>
          {can('quality.report') && c.active && <Record id={c.id} n={n} unit={c.unit} onDone={reload} />}
          <section className="card stack">
            <h2>Measurements</h2>
            <Table rows={[...c.subgroups].reverse()} rowKey={(s) => s.id} exception={(s) => s.rules.length > 0 || s.signals.length > 0} empty="No measurements yet."
              columns={[{ key: 'measuredAt', label: 'Measured', render: (s) => fmtDateTime(s.measuredAt) },
                { key: 'values', label: n === 1 ? 'Value' : 'Values', render: (s) => <span className={s.excluded ? 'faint' : undefined}>{s.values.join('  ')}</span> },
                ...(n > 1 ? [{ key: 'x', label: 'X̄', numeric: true, render: (s: any) => fmtNum(s.x, 4) }] : []), { key: 'r', label: n === 1 ? 'MR' : 'R', numeric: true, render: (s) => fmtNum(s.r, 4) },
                { key: 'lot', label: 'Lot / order', render: (s) => [s.lot, s.orderNumber].filter(Boolean).join(' · ') || '—' },
                { key: 'rules', label: 'Rules', render: (s) => [...new Set([...s.signals, ...s.rules])].map((r: any) => RULE[r]).join('; ') || '—' },
                { key: 'flags', label: '', render: (s) => <>{s.excluded && <Pill tone="neutral" label="excluded" />}{s.suspect && <Pill tone="watch" label="suspect gauge" />}</> }]} />
          </section>
          {c.signals.some((s: any) => s.status === 'closed') && (
            <section className="card stack">
              <h2>Answered signals</h2>
              <Table rows={c.signals.filter((s: any) => s.status === 'closed')} rowKey={(s) => s.id}
                columns={[{ key: 'measured_at', label: 'Measured', render: (s) => fmtDateTime(s.measured_at) }, { key: 'rule', label: 'Rule', render: (s) => RULE[s.rule] },
                  { key: 'cause', label: 'Cause' }, { key: 'response', label: 'Response' },
                  { key: 'ncr', label: 'NCR', render: (s) => (s.ncr_id ? <Link to={`/quality/ncr/${s.ncr_id}`}>{s.ncr_number}</Link> : '—') }, { key: 'responded_by', label: 'By' }]} />
            </section>
          )}
          <CharacteristicRules c={c} onDone={reload} />
        </>
      );
    }}</Async>
  );
}

function Signals({ signals, canAnswer, onDone }: { signals: any[]; canAnswer: boolean; onDone: () => Promise<void> | void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState({ cause: '', response: '', ncr: false, severity: 'minor', qty: '', exclude: false });
  const answer = useAction(async (id: string) => {
    await api.post(`/api/spc/signals/${id}/respond`, { cause: f.cause, response: f.response, excludeSubgroup: f.exclude,
      raiseNcr: f.ncr ? { severity: f.severity, qty: f.qty ? Number(f.qty) : null } : null });
    setOpen(null); setF({ cause: '', response: '', ncr: false, severity: 'minor', qty: '', exclude: false }); await onDone();
  });
  return (
    <section className="card stack" style={{ borderLeft: '3px solid var(--bad)' }}>
      <h2>Signals waiting for an investigation</h2>
      {signals.map((s) => (
        <div key={s.id} className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span><Pill tone="bad" label={RULE[s.rule] ?? s.rule} /> {s.detail} <span className="faint">· measured {fmtDateTime(s.measured_at)}</span></span>
            <span className="row" style={{ gap: 8 }}>
              {canAnswer && <Link to={`/capa/new?source=spc&origin=spc_signal:${s.id}&facility=${s.facility_id}&title=${encodeURIComponent(`${RULE[s.rule] ?? s.rule}: ${s.detail}`.slice(0, 190))}`}>Open a CAPA</Link>}
              {canAnswer && open !== s.id && <button onClick={() => setOpen(s.id)}>Answer</button>}
            </span>
          </div>
          {open === s.id && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void answer.run(s.id); }}>
              <input id="sig-cause" aria-label="Cause found" placeholder='Cause found (or "none found")' value={f.cause} onChange={(e) => setF({ ...f, cause: e.target.value })} required />
              <input id="sig-response" aria-label="What was done" placeholder="What was done (adjusted, sorted, tool changed…)" value={f.response} onChange={(e) => setF({ ...f, response: e.target.value })} required />
              <div className="row">
                <label className="row"><input id="sig-ncr" type="checkbox" checked={f.ncr} onChange={(e) => setF({ ...f, ncr: e.target.checked })} /> Raise a nonconformance</label>
                {f.ncr && <>
                  <select aria-label="Severity" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} style={{ width: 'auto' }}>{['minor', 'major', 'critical'].map((x) => <option key={x}>{x}</option>)}</select>
                  <input aria-label="Parts affected" type="number" min="0" placeholder="Parts affected" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} style={{ width: 130 }} />
                </>}
                <label className="row"><input type="checkbox" checked={f.exclude} onChange={(e) => setF({ ...f, exclude: e.target.checked })} /> Exclude the subgroup from calculations (assignable cause)</label>
              </div>
              <div className="row"><button className="primary" disabled={answer.busy}>Close the signal</button><button type="button" onClick={() => setOpen(null)}>Cancel</button><ErrorNote message={answer.error} /></div>
            </form>
          )}
        </div>
      ))}
    </section>
  );
}

function Record({ id, n, unit, onDone }: { id: string; n: number; unit: string; onDone: () => Promise<void> | void }) {
  const empty = () => ({ values: Array(n).fill(''), lot: '', note: '' });
  const [f, setF] = useState(empty);
  const [result, setResult] = useState<any>(null);
  const save = useAction(async () => {
    const r = await api.post(`/api/spc/characteristics/${id}/subgroups`, { values: f.values.map(Number), lot: f.lot || null, note: f.note || null });
    setResult(r); setF(empty()); await onDone();
  });
  return (
    <section className="card stack">
      <h2>Record {n === 1 ? 'a reading' : `a subgroup of ${n}`}</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        {f.values.map((v, i) => <input key={i} id={`spc-v${i + 1}`} aria-label={`Value ${i + 1}`} type="number" step="any" inputMode="decimal" placeholder={`${i + 1} (${unit})`} value={v} required
          onChange={(e) => { const values = [...f.values]; values[i] = e.target.value; setF({ ...f, values }); }} style={{ width: 110 }} />)}
        <input aria-label="Lot" placeholder="Lot" value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} style={{ width: 110 }} />
        <input aria-label="Note" placeholder="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ flex: '1 1 160px' }} />
        <button className="primary" disabled={save.busy}>Record</button>
      </form>
      <ErrorNote message={save.error} />
      {result && (result.signals.length ? <p className="bad-text">Recorded. {result.signals.map((s: any) => RULE[s.rule]).join(', ')}: quality has been told. Stop and check the process.</p>
        : <p className="good-text">Recorded; no signal.</p>)}
    </section>
  );
}

function SetLimits({ id, count, onDone, noun = 'subgroups' }: { id: string; count: number; onDone: () => Promise<void> | void; noun?: string }) {
  const [reason, setReason] = useState('');
  const [show, setShow] = useState(false);
  const save = useAction(async () => { await api.post(`/api/spc/characteristics/${id}/limits`, { reason }); setShow(false); setReason(''); await onDone(); });
  if (!show) return <div><button onClick={() => setShow(true)} disabled={count < 20} title={count < 20 ? `At least 20 included ${noun} are needed` : undefined}>Set limits from all {count} included {noun}</button></div>;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <input id="spc-limits-reason" aria-label="Why" placeholder="Why (initial study, new tooling, process change…)" value={reason} onChange={(e) => setReason(e.target.value)} required style={{ flex: '1 1 260px' }} />
      <button className="primary" disabled={save.busy}>Set limits</button><button type="button" onClick={() => setShow(false)}>Cancel</button><ErrorNote message={save.error} />
    </form>
  );
}

function AttributeDetail({ c, reload }: { c: any; reload: () => Promise<void> | void }) {
  const { can } = useAuth();
  const L = c.limits; const t = c.chart_type as string; const cap = c.capability;
  const open = c.signals.filter((s: any) => s.status === 'open');
  const varying = (t === 'p' || t === 'u') && new Set(c.subgroups.map((s: any) => s.n)).size > 1;
  const fmtX = (x: number | null) => (x == null ? '—' : t === 'p' ? `${(x * 100).toFixed(1)}%` : t === 'u' ? x.toFixed(2) : String(x));
  const tipOf = (s: any) => [short(s.measuredAt), `${s.count} ${t === 'p' || t === 'np' ? 'defective' : 'defects'} in ${s.n}`, s.lot ? `lot ${s.lot}` : null,
    ...s.rules.map((r: string) => RULE[r] ?? r), s.excluded ? `excluded: ${s.excludeReason}` : null].filter(Boolean) as string[];
  return (
    <>
      <PageHead eyebrow={`${c.facility_code} · SPC · ${CHART[t]}`} title={`${c.code} ${c.name}`}
        sub={[c.part_number && `${c.part_number}${c.op_no != null ? ` op ${c.op_no}` : ''}`, c.asset_tag && `machine ${c.asset_tag}`, c.gauge_tag && `gauge ${c.gauge_tag}`,
          c.sample_size ? `sample of ${Number(c.sample_size)}` : null, c.frequency].filter(Boolean).join(' · ')}
        actions={<Pill tone={open.length ? 'bad' : L && !L.trial ? 'good' : 'info'} label={open.length ? `${open.length} open signal${open.length === 1 ? '' : 's'}` : L && !L.trial ? 'Limits set' : 'Initial study'} />} />
      <Kpis items={[
        { label: t === 'p' || t === 'np' ? 'Average defective' : 'Average defects', value: rateText(t, cap.rate) },
        ...(cap.ppm != null ? [{ label: 'Parts per million', value: fmtNum(cap.ppm, 0) }] : []),
        { label: t === 'p' || t === 'np' ? 'Defective / inspected' : 'Defects / units', value: `${fmtNum(cap.defects, 0)} / ${fmtNum(cap.inspected, 0)}` },
        { label: 'Samples', value: cap.values },
      ]} />
      {open.length > 0 && <Signals signals={open} canAnswer={can('quality.manage')} onDone={reload} />}
      <section className="card stack">
        {L ? <>
          <ControlChart title={`${CHART[t]}${L.trial ? ' · trial limits' : ''}`} unit={t === 'p' ? 'fraction' : t === 'u' ? 'per unit' : 'count'} digits={t === 'p' || t === 'u' ? 3 : 1}
            points={c.subgroups.map((s: any) => ({ id: s.id, y: s.x, label: short(s.measuredAt), flag: s.excluded ? 'excluded' : s.rules.length || s.signals.length ? 'signal' : null, tip: tipOf(s) }))}
            lines={[{ y: L.center, label: t === 'p' ? 'p̄' : t === 'np' ? 'np̄' : t === 'c' ? 'c̄' : 'ū', kind: 'center' }, ...(varying ? [] : [{ y: L.ucl, label: 'UCL', kind: 'limit' as const }, ...(L.lcl > 0 ? [{ y: L.lcl, label: 'LCL', kind: 'limit' as const }] : [])])]}
            bands={varying ? { ucl: c.subgroups.map((s: any) => s.ucl), lcl: c.subgroups.map((s: any) => (s.lcl > 0 ? s.lcl : null)) } : undefined} />
          <p className="faint">{L.trial ? 'Trial limits from the samples shown.' : `Limits set ${fmtDateTime(L.setAt)} by ${L.setBy} from ${L.subgroups} samples: ${L.reason}.`}{varying ? ' Limits step with each sample size: smaller samples get wider limits.' : ''}</p>
        </> : <p className="muted">Record at least two samples to draw the chart.</p>}
        <ul className="faint" style={{ margin: 0, paddingLeft: 18 }}>{c.warnings.map((x: string) => <li key={x}>{x}</li>)}</ul>
        {can('quality.manage') && <SetLimits id={c.id} count={c.includedSubgroups} onDone={reload} noun="samples" />}
      </section>
      {can('quality.report') && c.active && <AttributeRecord c={c} onDone={reload} />}
      <section className="card stack">
        <h2>Samples</h2>
        <Table rows={[...c.subgroups].reverse()} rowKey={(s) => s.id} exception={(s) => s.rules.length > 0 || s.signals.length > 0} empty="No samples yet."
          columns={[{ key: 'measuredAt', label: 'Inspected', render: (s) => fmtDateTime(s.measuredAt) },
            { key: 'count', label: t === 'p' || t === 'np' ? 'Defective' : 'Defects', numeric: true }, { key: 'n', label: t === 'c' ? 'Unit' : 'Inspected', numeric: true, render: (s) => fmtNum(s.n, 2) },
            { key: 'x', label: t === 'p' ? 'Fraction' : t === 'u' ? 'Per unit' : 'Plotted', numeric: true, render: (s) => fmtX(s.x) },
            { key: 'ucl', label: 'UCL', numeric: true, render: (s) => fmtX(s.ucl) }, { key: 'lot', label: 'Lot / order', render: (s) => [s.lot, s.orderNumber].filter(Boolean).join(' · ') || '—' },
            { key: 'rules', label: 'Rules', render: (s) => [...new Set([...s.signals, ...s.rules])].map((r: any) => RULE[r]).join('; ') || '—' },
            { key: 'flags', label: '', render: (s) => (s.excluded ? <Pill tone="neutral" label="excluded" /> : null) }]} />
      </section>
      <CharacteristicRules c={c} onDone={reload} />
    </>
  );
}

function AttributeRecord({ c, onDone }: { c: any; onDone: () => Promise<void> | void }) {
  const t = c.chart_type as string;
  const fixed = t === 'np' || t === 'c';
  const [f, setF] = useState({ count: '', n: '', lot: '' });
  const [result, setResult] = useState<any>(null);
  const save = useAction(async () => {
    const r = await api.post(`/api/spc/characteristics/${c.id}/subgroups`, { values: [Number(f.count)], sampleSize: fixed ? null : Number(f.n), lot: f.lot || null });
    setResult(r); setF({ count: '', n: '', lot: '' }); await onDone();
  });
  return (
    <section className="card stack">
      <h2>Record a sample</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <input id="attr-count" aria-label={t === 'p' || t === 'np' ? 'Defective parts' : 'Defects found'} type="number" min="0" step="1" required value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })}
          placeholder={t === 'p' || t === 'np' ? 'Defective parts' : 'Defects found'} style={{ width: 150 }} />
        {fixed ? <span className="muted">{t === 'np' ? `in a sample of ${Number(c.sample_size)}` : 'in one inspection unit'}</span>
          : <input id="attr-n" aria-label={t === 'p' ? 'Parts inspected' : 'Units inspected'} type="number" min="0" step="any" required value={f.n} onChange={(e) => setF({ ...f, n: e.target.value })}
            placeholder={t === 'p' ? 'Parts inspected' : 'Units inspected'} style={{ width: 150 }} />}
        <input aria-label="Lot" placeholder="Lot" value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} style={{ width: 120 }} />
        <button className="primary" disabled={save.busy}>Record</button>
      </form>
      <ErrorNote message={save.error} />
      {result && (result.signals.length ? <p className="bad-text">Recorded. {result.signals.map((x: any) => RULE[x.rule]).join(', ')}: quality has been told.</p> : <p className="good-text">Recorded; no signal.</p>)}
    </section>
  );
}

/** Alarms per site over the last day or week, answer first (D-156); the same summary the daily reminder sends. */
function AlarmSummary() {
  const [days, setDays] = useState(1);
  const { data } = useApi<any[]>(`/api/spc/summary?days=${days}`);
  if (!data?.length) return null;
  return (
    <section className="card stack spc-summary">
      <div className="spread">
        <h2>Alarm summary</h2>
        <select aria-label="Summary period" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>Last day</option><option value={7}>Last 7 days</option></select>
      </div>
      {data.map((s) => (
        <div key={s.facilityId} className="stack" style={{ gap: 4 }}>
          <p className="answer" style={{ margin: 0 }}>{s.facilityCode}: {s.sentence}.</p>
          {s.byRule.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{s.byRule.map((r: any) => <Pill key={r.rule} tone="bad" label={`${r.label} ×${r.n}`} />)}</div>}
          {s.byCharacteristic.length > 0 && <span className="faint">{s.byCharacteristic.slice(0, 8).map((c: any) => `${c.code} (${c.rule} ×${c.n})`).join(' · ')}</span>}
          {s.silent.length > 0 && <span className="faint">Not measured in 7 days: {s.silent.map((c: any) => c.code).join(', ')}</span>}
        </div>
      ))}
    </section>
  );
}

/** Which rules raise alarms, for the whole company (D-156); quality managers change them. */
function RuleSettings() {
  const { data, reload } = useApi<any>('/api/spc/settings');
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<string[] | null>(null);
  const [each, setEach] = useState<boolean | null>(null);
  const save = useAction(async () => { await api.put('/api/spc/settings', { rules: rules ?? data.rules, notifyEachAlarm: each ?? data.notifyEachAlarm }); setRules(null); setEach(null); setOpen(false); await reload(); });
  if (!data) return null;
  const on: string[] = rules ?? data.rules;
  return (
    <section className="card stack spc-rules">
      <div className="spread">
        <div><h2>Rules</h2><span className="faint">{data.rules.length} of {data.catalogue.length} on for every characteristic that does not set its own{data.notifyEachAlarm ? '; quality staff are told of each alarm' : '; alarms are reported in the daily summary only'}.</span></div>
        <button aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : data.canEdit ? 'Choose rules' : 'Show rules'}</button>
      </div>
      {open && (
        <>
          <RuleChecklist catalogue={data.catalogue} on={on} disabled={!data.canEdit} onChange={setRules} legend="Rules on for the company" />
          <label className="row" style={{ gap: 4 }}><input type="checkbox" disabled={!data.canEdit} checked={each ?? data.notifyEachAlarm} onChange={(e) => setEach(e.target.checked)} /> Tell quality staff of each alarm as it happens (otherwise only in the daily summary, set under Admin → Reminders)</label>
          {data.canEdit && <div className="row"><button className="primary" disabled={save.busy || !on.length || (rules == null && each == null)} onClick={() => save.run()}>Save rules</button></div>}
          <ErrorNote message={save.error} />
        </>
      )}
    </section>
  );
}

function RuleChecklist({ catalogue, on, disabled, onChange, legend, chart }: { catalogue: any[]; on: string[]; disabled: boolean; onChange: (r: string[]) => void; legend: string; chart?: 'variables' | 'attribute' }) {
  return (
    <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only">{legend}</legend>
      {catalogue.filter((r) => !chart || r.charts.includes(chart)).map((r) => (
        <label key={r.key} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
          <input type="checkbox" disabled={disabled} checked={on.includes(r.key)} onChange={(e) => onChange(e.target.checked ? [...on, r.key] : on.filter((k) => k !== r.key))} />
          <span><strong>{r.label}</strong>{r.onByDefault ? '' : ' (optional)'}<br /><span className="faint">{r.description}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

/** A characteristic's rules: the company's, or its own set (D-156). */
function CharacteristicRules({ c, onDone }: { c: any; onDone: () => Promise<void> | void }) {
  const { can } = useAuth();
  const settings = useApi<any>('/api/spc/settings');
  const [own, setOwn] = useState<string[] | null>(c.ownRules);
  const save = useAction(async (rules: string[] | null) => { await api.put(`/api/spc/characteristics/${c.id}/rules`, { rules }); await onDone(); });
  if (!settings.data) return null;
  const edit = can('quality.manage');
  const chart = c.chart_type === 'variables' ? 'variables' : 'attribute';
  return (
    <section className="card stack">
      <h2>Rules for this characteristic</h2>
      <p className="muted" style={{ margin: 0 }}>{c.ownRules ? 'Its own rules' : 'The company’s rules'}: {c.rulesInForce.map((r: string) => RULE[r] ?? r).join(', ')}.</p>
      {edit && (
        <>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={own != null} onChange={(e) => setOwn(e.target.checked ? [...c.rulesInForce] : null)} /> Use its own rules</label>
          {own != null && <RuleChecklist catalogue={settings.data.catalogue} on={own} disabled={false} onChange={setOwn} legend={`Rules on for ${c.code}`} chart={chart} />}
          <div className="row"><button disabled={save.busy || (own != null && !own.length) || JSON.stringify(own) === JSON.stringify(c.ownRules)} onClick={() => save.run(own)}>Save rules</button></div>
          <ErrorNote message={save.error} />
        </>
      )}
    </section>
  );
}
