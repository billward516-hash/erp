import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useServerDraft } from '../components/Autosave';
import { ReportChart } from '../components/ReportChart';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, fmtMoney, humanize } from '../format';
import { useAction, useApi } from '../hooks';
// The same engine the server uses, so the preview while editing matches what is saved and approved (D-162).
import { METHODS, project, sensitivity } from '../../../src/modules/proforma/engine';
import type { Line, Method, Scenario, ScenarioKey, Section } from '../../../src/modules/proforma/engine';

const KINDS: [string, string][] = [['new_site', 'New site or store'], ['product_line', 'New product or service'], ['customer_contract', 'Customer contract'],
  ['capital_project', 'Capital project'], ['other', 'Other opportunity']];
const SECTIONS: [Section, string][] = [['revenue', 'Revenue'], ['cost_of_sales', 'Cost of sales'], ['operating', 'Operating costs'], ['capital', 'Capital spending']];
const METHOD_LABEL: Record<Method, string> = { units_price: 'Units × price', fixed_monthly: 'Amount per month', pct_of_revenue: '% of revenue', headcount: 'People × annual cost', one_time: 'One-time amount' };
const AMOUNT_LABEL: Record<Method, string> = { units_price: 'Price per unit', fixed_monthly: 'Per month', pct_of_revenue: '% of revenue', headcount: 'Annual cost each', one_time: 'Amount' };
const SCEN: [ScenarioKey, string][] = [['low', 'Low'], ['base', 'Base'], ['high', 'High']];
const whole = (n: number) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const nextMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7); };
const payback = (m: number | null, years: number) => (m == null ? `Not within ${years} years` : m === 0 ? 'No funding needed' : `${m} months`);

/** Business cases (D-162): every opportunity pro forma with its base case, answer first. */
export function Proformas() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any>('/api/proformas');
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id].slice(-3));
  return (
    <>
      <PageHead eyebrow="Finance" title="Business cases"
        sub="A pro forma for each opportunity: a new site, product, customer contract or capital project. Compare scenarios, see when it pays back, and send it to finance for approval."
        actions={can('proforma.manage') ? <button className="primary" onClick={() => nav('/proforma/new')}>New business case</button> : undefined} />
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <p className="answer">{data.answer}</p>
          <Approver />
          <section className="card stack">
            <div className="spread"><p className="muted">Tick two or three cases to set them side by side.</p>
              <button disabled={picked.length < 2} onClick={() => nav(`/proforma/compare?plans=${picked.join(',')}`)}>Compare {picked.length >= 2 ? picked.length : ''} plans</button></div>
            <Table rows={data.rows} rowKey={(r) => r.id} onRow={(r) => nav(`/proforma/${r.id}`)} exception={(r) => r.npv < 0} empty="No business cases yet."
              columns={[{ key: 'pick', label: 'Compare', render: (r) => <input type="checkbox" aria-label={`Compare ${r.number}`} checked={picked.includes(r.id)}
                  onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} /> },
                { key: 'number', label: 'Case', render: (r) => <strong>{r.number}</strong> }, { key: 'title', label: 'Title' }, { key: 'kind_label', label: 'Kind' },
                { key: 'facility_code', label: 'Site', render: (r) => r.facility_code ?? 'Company' }, { key: 'status', label: 'Status', render: (r) => <Pill value={r.status} /> },
                { key: 'npv', label: 'NPV', numeric: true, render: (r) => whole(r.npv) }, { key: 'irrPct', label: 'IRR', numeric: true, render: (r) => (r.irrPct == null ? '—' : `${r.irrPct}%`) },
                { key: 'paybackMonths', label: 'Payback', render: (r) => payback(r.paybackMonths, r.years) }, { key: 'peakFunding', label: 'Funding needed', numeric: true, render: (r) => whole(r.peakFunding) },
                { key: 'owner_name', label: 'Owner' }]} />
          </section>
        </>
      )}</Async>
    </>
  );
}

export function NewProforma() {
  const nav = useNavigate();
  const { can } = useAuth();
  const sites = useApi<any[]>('/api/facilities');
  const [f, setF] = useState({ title: '', kind: 'new_site', facilityId: '', startMonth: nextMonth(), years: '5', start: 'examples' });
  const save = useAction(async () => {
    let lines: Line[] | undefined;
    if (f.start === 'books' && f.facilityId) lines = (await api.get(`/api/proformas/baseline?facilityId=${f.facilityId}`)).lines;
    const p = await api.post('/api/proformas', { title: f.title, kind: f.kind, facilityId: f.facilityId || null, startMonth: f.startMonth, years: Number(f.years),
      ...(lines ? { lines } : { useStarter: f.start === 'examples' }) });
    nav(`/proforma/${p.id}`);
  });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const books = !!f.facilityId && can('books.view', f.facilityId);
  return (
    <>
      <PageHead eyebrow="Business cases" title="New business case" sub="Start from example drivers for the kind of opportunity, from a site's last 12 months in the books, or from nothing." />
      <form className="card form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <label className="field">Title<input id="pf-title" value={f.title} onChange={set('title')} required minLength={3} placeholder="Second store in Fort Worth" /></label>
        <div className="form-grid">
          <label className="field">Kind<select id="pf-kind" value={f.kind} onChange={set('kind')}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">Site<select id="pf-site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, start: f.start === 'books' && !e.target.value ? 'examples' : f.start })}>
            <option value="">Company-wide (no site yet)</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label>
          <label className="field">First month<input id="pf-start" type="month" value={f.startMonth} onChange={set('startMonth')} required /></label>
          <label className="field">Years<input id="pf-years" type="number" min="1" max="10" value={f.years} onChange={set('years')} required /></label>
        </div>
        <fieldset className="row" style={{ gap: 12, border: 0, padding: 0, margin: 0, flexWrap: 'wrap' }}>
          <legend className="muted">Start from</legend>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="pf-start" checked={f.start === 'examples'} onChange={() => setF({ ...f, start: 'examples' })} /> Example drivers to replace</label>
          {books && <label className="row" style={{ gap: 4 }}><input type="radio" name="pf-start" checked={f.start === 'books'} onChange={() => setF({ ...f, start: 'books' })} /> This site's last 12 months</label>}
          <label className="row" style={{ gap: 4 }}><input type="radio" name="pf-start" checked={f.start === 'blank'} onChange={() => setF({ ...f, start: 'blank' })} /> Nothing</label>
        </fieldset>
        <div><button className="primary" disabled={save.busy}>Create</button></div>
        <ErrorNote message={save.error} />
      </form>
    </>
  );
}

interface Draft { title: string; kind: string; description: string; startMonth: string; years: number; discountRatePct: number; taxRatePct: number; workingCapitalDays: number;
  scenarios: Record<ScenarioKey, Scenario>; lines: (Line & { note?: string | null })[] }

export function ProformaDetail() {
  const { id } = useParams();
  const { data: p, loading, error, reload } = useApi<any>(`/api/proformas/${id}`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [scen, setScen] = useState<ScenarioKey>('base');
  const [reason, setReason] = useState('');
  const nav = useNavigate();
  const edit = () => setDraft({ title: p.title, kind: p.kind, description: p.description ?? '', startMonth: p.startMonth, years: p.years, discountRatePct: p.assumptions.discountRatePct,
    taxRatePct: p.assumptions.taxRatePct, workingCapitalDays: p.assumptions.workingCapitalDays, scenarios: p.scenarios, lines: p.lines });
  // The editor's whole model is kept on the server while it is open (D-164), so a closed tab loses nothing.
  const kept = useServerDraft<Draft>(p ? `proforma:${id}:r${p.revision}` : null, draft, p ? `${p.number} ${p.title}` : '');
  const save = useAction(async () => { await api.put(`/api/proformas/${id}`, { ...draft, facilityId: p.facility_id }); kept.clear(); setDraft(null); await reload(); });
  const act = useAction(async (path: string, body?: unknown) => { const r = await api.post(`/api/proformas/${id}/${path}`, body ?? {}); setReason(''); if (path === 'copy') nav(`/proforma/${r.id}`); else await reload(); });
  // While editing, the figures are recalculated in the browser with the same engine; otherwise they are the saved ones.
  const live = useMemo(() => {
    if (!draft) return null;
    const a = { years: draft.years, discountRatePct: draft.discountRatePct, taxRatePct: draft.taxRatePct, workingCapitalDays: draft.workingCapitalDays };
    const results = { low: project(draft.lines, a, draft.scenarios.low), base: project(draft.lines, a, draft.scenarios.base), high: project(draft.lines, a, draft.scenarios.high) };
    return { results, sensitivity: sensitivity(draft.lines, a, draft.scenarios.base), years: draft.years, discount: draft.discountRatePct };
  }, [draft]);
  return (
    <Async loading={loading && !p} error={error}>{() => {
      const results = live?.results ?? p.results; const r = results[scen]; const years = live?.years ?? p.years;
      const sens = live?.sensitivity ?? p.sensitivity; const discount = live?.discount ?? p.assumptions.discountRatePct;
      let cum = 0;
      const cash = r.months.map((m: any, i: number) => { cum += m.cash; return { month: `M${i + 1}`, cash: Math.round(cum) }; });
      return (
        <>
          <PageHead eyebrow={`Business case · ${KINDS.find(([k]) => k === p.kind)?.[1]}${p.facility_code ? ` · ${p.facility_code}` : ' · Company-wide'}`}
            title={<>{p.number} {p.title} <Pill value={p.status} /></>}
            sub={`Revision ${p.revision} · owner ${p.owner_name} · from ${p.startMonth} over ${p.years} years`}
            actions={<div className="row">
              {p.canEdit && !draft && <button onClick={edit}>Edit</button>}
              {p.canEdit && !draft && <button className="primary" disabled={act.busy} onClick={() => void act.run('submit')}>Submit for approval</button>}
              {p.canManage && <button disabled={act.busy} onClick={() => void act.run('copy')}>Copy</button>}
            </div>} />
          {kept.saved && !draft && p.canEdit && <p className="draft-note" role="status">You have unsaved changes from {fmtDateTime(kept.saved.updated_at)}.{' '}
            <button type="button" className="link" onClick={() => setDraft(kept.saved!.data)}>Continue editing</button> · <button type="button" className="link" onClick={kept.clear}>Discard them</button></p>}
          <p className="answer">{live ? `Preview, not saved: ${scen} case NPV ${whole(r.npv)}, ${payback(r.paybackMonths, years).toLowerCase()}.` : p.answer}</p>
          <div className="row" role="tablist" aria-label="Scenario">
            {SCEN.map(([k, l]) => <button key={k} role="tab" aria-selected={scen === k} className={scen === k ? 'primary' : ''} onClick={() => setScen(k)}>{l} case</button>)}
          </div>
          <Kpis items={[
            { label: 'NPV', value: whole(r.npv), tone: r.npv >= 0 ? 'good' : 'bad', note: `at ${discount}%` },
            { label: 'IRR', value: r.irrPct == null ? '—' : `${r.irrPct}%` },
            { label: 'Payback', value: payback(r.paybackMonths, years), tone: r.paybackMonths == null ? 'bad' : undefined },
            { label: 'Funding needed', value: whole(r.peakFunding), note: 'lowest cumulative cash' },
            { label: 'First profitable month', value: r.breakevenMonth ? `Month ${r.breakevenMonth}` : '—', note: 'EBITDA' },
            { label: 'Gross margin', value: r.grossMarginPct == null ? '—' : `${r.grossMarginPct}%` },
          ]} />
          {p.approved_summary && p.status !== 'approved' && <p className="muted">Last approved (revision {p.approved_summary.revision}): NPV {whole(p.approved_summary.npv)}, payback {payback(p.approved_summary.paybackMonths, p.years).toLowerCase()}.</p>}
          <div className="grid two">
            <section className="card"><ReportChart spec={{ kind: 'line', title: 'Cumulative cash', category: { key: 'month', label: 'Month' }, series: [{ key: 'cash', label: 'Cumulative cash' }],
              valueType: 'currency', data: cash, reference: { value: 0, label: 'Break-even' } }} /></section>
            <section className="card"><ReportChart spec={{ kind: 'columns', title: 'Profit by year', category: { key: 'label', label: 'Year' },
              series: [{ key: 'revenue', label: 'Revenue' }, { key: 'ebitda', label: 'EBITDA' }, { key: 'netIncome', label: 'Net income' }], valueType: 'currency',
              data: r.years.map((y: any) => ({ label: `Year ${y.year}`, revenue: Math.round(y.revenue), ebitda: Math.round(y.ebitda), netIncome: Math.round(y.netIncome) })) }} /></section>
          </div>
          <section className="card stack">
            <h2>Profit and cash by year ({scen} case)</h2>
            <PnL years={r.years} />
          </section>
          <section className="card stack">
            <h2>What moves the result</h2>
            <p className="muted">Base-case NPV with each driver pushed down and up on its own, largest effect first.</p>
            {sens.length > 0 && <ReportChart spec={{ kind: 'bars', title: 'Spread of NPV by driver', category: { key: 'label', label: 'Driver' }, series: [{ key: 'swing', label: 'NPV spread' }],
              valueType: 'currency', data: sens.map((d: any) => ({ label: d.label, swing: Math.round(d.swing) })) }} />}
            <Table rows={sens} rowKey={(d) => d.label} empty="Add revenue or costs to see what matters most."
              columns={[{ key: 'label', label: 'Driver' }, { key: 'low', label: 'NPV, worse', numeric: true, render: (d) => whole(d.low) }, { key: 'high', label: 'NPV, better', numeric: true, render: (d) => whole(d.high) },
                { key: 'swing', label: 'Spread', numeric: true, render: (d) => whole(d.swing) }]} />
          </section>
          {!draft && (p.status === 'approved' || p.revisions.some((r: any) => r.status === 'approved')) && <Actuals id={p.id} />}
          {draft ? <Editor facilityId={p.facility_id} draft={draft} setDraft={setDraft} onSave={() => void save.run()} onCancel={() => { kept.clear(); setDraft(null); }} busy={save.busy} error={save.error} />
            : <Drivers p={p} />}
          {p.canManage && ['submitted', 'approved'].includes(p.status) && (
            <section className="card stack">
              <h2>Reopen</h2>
              <p className="muted">{p.status === 'submitted' ? 'Withdraws it from approval.' : 'Starts revision ' + (p.revision + 1) + '; it needs approval again. The approved figures are kept for comparison.'}</p>
              <div className="row"><input aria-label="Why it is being reopened" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why" style={{ flex: 1 }} />
                <button disabled={act.busy || reason.trim().length < 3} onClick={() => void act.run('reopen', { reason })}>Reopen</button></div>
            </section>
          )}
          <ErrorNote message={act.error} />
          {p.approvals.length > 0 && (
            <section className="card stack">
              <h2>Approvals</h2>
              {p.approvals.map((q: any) => (
                <div key={q.id}>
                  <p className="muted">Revision {q.subject_revision}, {humanize(q.status)} · submitted {fmtDateTime(q.created_at)}</p>
                  <Table rows={q.steps} columns={[{ key: 'label', label: 'Step' }, { key: 'status', label: 'Decision', render: (s: any) => <Pill value={s.status} /> },
                    { key: 'decided_by', label: 'By', render: (s: any) => s.decided_by ?? '—' }, { key: 'comment', label: 'Comment', render: (s: any) => s.comment ?? '' }]} />
                </div>
              ))}
            </section>
          )}
          {p.revisions.length > 0 && (
            <section className="card stack">
              <h2>Earlier revisions</h2>
              <Table rows={p.revisions} rowKey={(r) => String(r.revision)} columns={[{ key: 'revision', label: 'Revision', numeric: true }, { key: 'status', label: 'Reached', render: (r) => <Pill value={r.status} /> },
                { key: 'npv', label: 'NPV', numeric: true, render: (r) => whole(r.summary.npv) }, { key: 'payback', label: 'Payback', render: (r) => payback(r.summary.paybackMonths, p.years) },
                { key: 'reason', label: 'Reopened because' }, { key: 'closed_at', label: 'Closed', render: (r) => `${fmtDateTime(r.closed_at)} by ${r.closed_by}` },
                { key: 'cmp', label: '', render: (r) => <Link to={`/proforma/compare?plans=${p.id}:${r.revision},${p.id}:${p.revision}`}>Compare with revision {p.revision}</Link> }]} />
            </section>
          )}
          <p className="faint">A model of the owner's assumptions, not a forecast from the books: straight-line depreciation, tax on profit after losses carried forward, working capital as days of revenue (not released at the end), cash discounted monthly.</p>
        </>
      );
    }}</Async>
  );
}

function PnL({ years }: { years: any[] }) {
  const rows: [string, string, boolean?][] = [['revenue', 'Revenue'], ['costOfSales', 'Cost of sales'], ['grossProfit', 'Gross profit', true], ['operating', 'Operating costs'],
    ['ebitda', 'EBITDA', true], ['depreciation', 'Depreciation'], ['tax', 'Tax'], ['netIncome', 'Net income', true], ['capital', 'Capital spending'], ['workingCapital', 'Working capital'],
    ['cashFlow', 'Cash flow', true], ['endingCash', 'Cumulative cash', true]];
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th scope="col">USD</th>{years.map((y) => <th key={y.year} scope="col" className="n">Year {y.year}</th>)}</tr></thead>
        <tbody>{rows.map(([k, l, bold]) => (
          <tr key={k}><th scope="row" style={{ fontWeight: bold ? 600 : 400 }}>{l}</th>{years.map((y) => <td key={y.year} className="n" style={{ fontWeight: bold ? 600 : 400 }}>{whole(y[k])}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function describe(l: Line) {
  const when = `${l.startMonth ? `from month ${l.startMonth + 1}` : ''}${l.endMonth ? ` to month ${l.endMonth}` : ''}`;
  const base = l.method === 'units_price' ? `${l.qty} a month × ${fmtMoney(l.amount)}` : l.method === 'headcount' ? `${l.qty} × ${fmtMoney(l.amount)} a year`
    : l.method === 'pct_of_revenue' ? `${l.amount}% of revenue` : l.method === 'one_time' ? `${fmtMoney(l.amount)} once` : `${fmtMoney(l.amount)} a month`;
  return [base, l.growthPct ? `+${l.growthPct}% a year` : '', l.rampMonths ? `${l.rampMonths}-month ramp` : '', l.section === 'capital' ? `over ${l.lifeYears ?? 5} years` : '', when].filter(Boolean).join(', ');
}

function Drivers({ p }: { p: any }) {
  return (
    <section className="card stack">
      <h2>Drivers</h2>
      {SECTIONS.map(([s, label]) => {
        const ls = p.lines.filter((l: Line) => l.section === s);
        return ls.length ? <div key={s}><h3>{label}</h3><ul>{ls.map((l: any, i: number) => <li key={i}><strong>{l.label}</strong>: {describe(l)}{l.source && <span className="faint"> · from {l.source}</span>}</li>)}</ul></div> : null;
      })}
      <p className="muted">Discount rate {p.assumptions.discountRatePct}% · tax {p.assumptions.taxRatePct}% · working capital {p.assumptions.workingCapitalDays} days of revenue.
        Low case: revenue {p.scenarios.low.revenuePct}%, costs {p.scenarios.low.costPct > 0 ? '+' : ''}{p.scenarios.low.costPct}%, capital {p.scenarios.low.capitalPct > 0 ? '+' : ''}{p.scenarios.low.capitalPct}%, {p.scenarios.low.delayMonths} months late.
        High case: revenue {p.scenarios.high.revenuePct > 0 ? '+' : ''}{p.scenarios.high.revenuePct}%, costs {p.scenarios.high.costPct}%.</p>
    </section>
  );
}

function Editor({ facilityId, draft, setDraft, onSave, onCancel, busy, error }: { facilityId: string | null; draft: Draft; setDraft: (d: Draft) => void; onSave: () => void; onCancel: () => void; busy: boolean; error: string | null }) {
  const setLine = (i: number, patch: Partial<Line>) => setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const n = (v: string) => (v === '' ? null : Number(v));
  const add = (section: Section) => setDraft({ ...draft, lines: [...draft.lines, { section, label: '', method: METHODS[section][0]!, amount: 0, qty: METHODS[section][0] === 'units_price' ? 0 : null, lifeYears: section === 'capital' ? 5 : null }] });
  const setScen = (k: ScenarioKey, f: keyof Scenario, v: string) => setDraft({ ...draft, scenarios: { ...draft.scenarios, [k]: { ...draft.scenarios[k], [f]: Number(v) || 0 } } });
  return (
    <form className="card stack" data-no-draft onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <h2>Edit drivers</h2>
      <p className="muted">The figures above update as you type. Months count from the first month of the case (month 1).</p>
      <PullIn facilityId={facilityId} startMonth={draft.startMonth} onLines={(lines) => setDraft({ ...draft, lines: [...draft.lines, ...lines] })} />
      <div className="form-grid">
        <label className="field">Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required minLength={3} /></label>
        <label className="field">First month<input type="month" value={draft.startMonth} onChange={(e) => setDraft({ ...draft, startMonth: e.target.value })} required /></label>
        <label className="field">Years<input type="number" min="1" max="10" value={draft.years} onChange={(e) => setDraft({ ...draft, years: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} /></label>
        <label className="field">Discount rate %<input type="number" min="0" max="100" step="0.1" value={draft.discountRatePct} onChange={(e) => setDraft({ ...draft, discountRatePct: Number(e.target.value) || 0 })} /></label>
        <label className="field">Tax rate %<input type="number" min="0" max="100" step="0.1" value={draft.taxRatePct} onChange={(e) => setDraft({ ...draft, taxRatePct: Number(e.target.value) || 0 })} /></label>
        <label className="field">Working capital (days of revenue)<input type="number" min="0" max="365" value={draft.workingCapitalDays} onChange={(e) => setDraft({ ...draft, workingCapitalDays: Number(e.target.value) || 0 })} /></label>
      </div>
      {SECTIONS.map(([s, label]) => (
        <fieldset key={s} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend><h3>{label}</h3></legend>
          {draft.lines.map((l, i) => l.section !== s ? null : (
            <div key={i} className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'end' }}>
              <label className="field" style={{ flex: '2 1 180px' }}>Label{(l as any).source && <span className="faint"> · from {(l as any).source}</span>}<input value={l.label} onChange={(e) => setLine(i, { label: e.target.value })} required /></label>
              <label className="field">How<select value={l.method} onChange={(e) => setLine(i, { method: e.target.value as Method, qty: ['units_price', 'headcount'].includes(e.target.value) ? l.qty ?? 0 : null })}>
                {METHODS[s].map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></label>
              {(l.method === 'units_price' || l.method === 'headcount') && <label className="field" style={{ width: 100 }}>{l.method === 'headcount' ? 'People' : 'Units a month'}
                <input type="number" min="0" step="any" value={l.qty ?? ''} onChange={(e) => setLine(i, { qty: n(e.target.value) })} required /></label>}
              <label className="field" style={{ width: 120 }}>{AMOUNT_LABEL[l.method]}<input type="number" min="0" step="any" value={l.amount} onChange={(e) => setLine(i, { amount: Number(e.target.value) || 0 })} /></label>
              {l.method !== 'one_time' && l.method !== 'pct_of_revenue' && <label className="field" style={{ width: 90 }}>Growth %/yr<input type="number" step="any" value={l.growthPct ?? ''} onChange={(e) => setLine(i, { growthPct: n(e.target.value) })} /></label>}
              <label className="field" style={{ width: 90 }}>{l.method === 'one_time' ? 'In month' : 'From month'}<input type="number" min="1" value={(l.startMonth ?? 0) + 1} onChange={(e) => setLine(i, { startMonth: Math.max(0, (Number(e.target.value) || 1) - 1) })} /></label>
              {l.method !== 'one_time' && <label className="field" style={{ width: 90 }}>Until month<input type="number" min="1" value={l.endMonth ?? ''} onChange={(e) => setLine(i, { endMonth: n(e.target.value) })} placeholder="end" /></label>}
              {s === 'revenue' && <label className="field" style={{ width: 90 }}>Ramp months<input type="number" min="0" max="120" value={l.rampMonths ?? ''} onChange={(e) => setLine(i, { rampMonths: n(e.target.value) })} /></label>}
              {s === 'capital' && <label className="field" style={{ width: 90 }}>Life (years)<input type="number" min="1" max="100" step="any" value={l.lifeYears ?? 5} onChange={(e) => setLine(i, { lifeYears: n(e.target.value) })} /></label>}
              <button type="button" className="link" aria-label={`Remove ${l.label || 'line'}`} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <div><button type="button" onClick={() => add(s)}>Add {label.toLowerCase()} line</button></div>
        </fieldset>
      ))}
      <h3>Scenarios</h3>
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Case</th><th scope="col">Revenue %</th><th scope="col">Costs %</th><th scope="col">Capital %</th><th scope="col">Launch delay (months)</th></tr></thead>
        <tbody>{SCEN.map(([k, l]) => (
          <tr key={k}><th scope="row">{l}</th>{(['revenuePct', 'costPct', 'capitalPct', 'delayMonths'] as const).map((f) => (
            <td key={f}><input aria-label={`${l} case ${f}`} type="number" step={f === 'delayMonths' ? 1 : 'any'} min={f === 'delayMonths' ? 0 : -100} value={draft.scenarios[k][f]} onChange={(e) => setScen(k, f, e.target.value)} style={{ width: 90 }} /></td>
          ))}</tr>
        ))}</tbody>
      </table></div>
      <div className="row"><button className="primary" disabled={busy}>Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
      <ErrorNote message={error} />
    </form>
  );
}

const SOURCE_LABEL: Record<string, string> = { books: "This site's books, last 12 months", budget: 'A budget', opportunity: 'A CRM opportunity', rent_roll: "This property's rent roll", asset: 'An asset (replace it)', labor: 'Labor rate from work orders' };

/** Lines drawn from the rest of the platform (D-163), added to the draft for the owner to adjust. */
function PullIn({ facilityId, startMonth, onLines }: { facilityId: string | null; startMonth: string; onLines: (lines: Line[]) => void }) {
  const src = useApi<any>(`/api/proformas/sources${facilityId ? `?facilityId=${facilityId}` : ''}`);
  const [source, setSource] = useState(''); const [refId, setRefId] = useState(''); const [note, setNote] = useState<string | null>(null);
  const pull = useAction(async () => {
    const r = await api.post('/api/proformas/import-lines', { source, facilityId, refId: refId || null, startMonth });
    onLines(r.lines); setNote(r.answer); setSource(''); setRefId('');
  });
  const d = src.data;
  if (!d) return null;
  const options = [d.books && 'books', d.budgets.length && 'budget', d.opportunities.length && 'opportunity', d.rentRoll && 'rent_roll', d.assets.length && 'asset', d.laborRate && 'labor'].filter(Boolean) as string[];
  if (!options.length) return null;
  const refs: [string, string][] = source === 'budget' ? d.budgets.map((b: any) => [b.id, `${b.name} (${b.status})`]) : source === 'opportunity'
    ? d.opportunities.map((o: any) => [o.id, `${o.customer}: ${o.title} · ${whole(o.amount)}${o.probability != null ? ` · ${o.probability}%` : ''}`])
    : source === 'asset' ? d.assets.map((a: any) => [a.id, `${a.asset_tag} ${a.name}${a.replacement_cost ? ` · ${whole(a.replacement_cost)}` : ''}`]) : [];
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'end' }}>
      <label className="field">Pull in from<select value={source} onChange={(e) => { setSource(e.target.value); setRefId(''); setNote(null); }}>
        <option value="">Choose…</option>{options.map((o) => <option key={o} value={o}>{SOURCE_LABEL[o]}</option>)}</select></label>
      {refs.length > 0 && <label className="field" style={{ flex: '1 1 240px' }}>Which<select value={refId} onChange={(e) => setRefId(e.target.value)}>
        <option value="">Choose…</option>{refs.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
      <button type="button" disabled={!source || (refs.length > 0 && !refId) || pull.busy} onClick={() => void pull.run()}>Add lines</button>
      {note && <span className="muted">{note}</span>}
      <ErrorNote message={pull.error} />
    </div>
  );
}

/** Two or three plans or revisions side by side (D-163): figures, profit and cash by year, and what differs. */
export function CompareProformas() {
  const [params] = useSearchParams();
  const { data, loading, error } = useApi<any>(`/api/proformas/compare?plans=${encodeURIComponent(params.get('plans') ?? '')}`);
  return (
    <>
      <PageHead eyebrow="Business cases" title="Compare plans" sub="Each plan in its base case with its own assumptions." />
      <Async loading={loading && !data} error={error}>{() => {
        const ps = data.plans as any[];
        const metric = (label: string, f: (x: any) => string) => ({ label, ...Object.fromEntries(ps.map((x, i) => [`p${i}`, f(x)])) });
        const rows = [
          metric('Title', (x) => x.header.title), metric('Status', (x) => humanize(x.status)), metric('NPV', (x) => whole(x.summary.npv)),
          metric('IRR', (x) => (x.summary.irrPct == null ? '—' : `${x.summary.irrPct}%`)), metric('Payback', (x) => payback(x.summary.paybackMonths, x.header.years)),
          metric('Funding needed', (x) => whole(x.summary.peakFunding)), metric('Revenue over the horizon', (x) => whole(x.summary.revenue)),
          metric('Capital', (x) => whole(x.summary.capital)), metric('Net income over the horizon', (x) => whole(x.summary.netIncome)),
        ];
        const maxYears = Math.max(...ps.map((x) => x.years.length));
        const cash = Array.from({ length: maxYears }, (_, y) => ({ label: `Year ${y + 1}`, ...Object.fromEntries(ps.map((x, i) => [`p${i}`, x.years[y] ? Math.round(x.years[y].endingCash) : null])) }));
        return (
          <>
            <p className="answer">{data.answer}</p>
            <section className="card stack">
              <Table rows={rows} rowKey={(r) => r.label} columns={[{ key: 'label', label: '' }, ...ps.map((x, i) => ({ key: `p${i}`, label: x.label, render: (r: any) => r[`p${i}`] }))]} />
              <div className="row">{ps.map((x) => <Link key={x.label} to={`/proforma/${x.id}`}>Open {x.number}</Link>)}</div>
            </section>
            <section className="card"><ReportChart spec={{ kind: 'line', title: 'Cumulative cash at the end of each year', category: { key: 'label', label: 'Year' },
              series: ps.map((x, i) => ({ key: `p${i}`, label: x.label })), valueType: 'currency', data: cash, reference: { value: 0, label: 'Break-even' } }} /></section>
            <section className="card stack">
              <h2>What differs</h2>
              <Table rows={data.differences} rowKey={(d) => d.what} empty="The plans have the same assumptions and lines."
                columns={[{ key: 'what', label: 'Assumption or line' }, ...ps.map((x, i) => ({ key: `v${i}`, label: x.label, render: (d: any) => d.values[i] }))]} />
            </section>
          </>
        );
      }}</Async>
    </>
  );
}

/** Who approves business cases (D-167): the owner (administrators) unless an administrator names someone. */
function Approver() {
  const { data, reload } = useApi<any>('/api/proformas/settings');
  const [pick, setPick] = useState<string | null>(null);
  const save = useAction(async () => { await api.put('/api/proformas/settings', { approverUserId: pick || null }); setPick(null); await reload(); });
  if (!data) return null;
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'end' }}>
      <span className="muted">Approved by: <strong>{data.approver}</strong></span>
      {data.canChange && pick == null && <button className="link" onClick={() => setPick(data.approverUserId ?? '')}>Change</button>}
      {pick != null && (
        <>
          <label className="field">Approver<select id="pf-approver" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">The owner (administrators)</option>{data.candidates.map((u: any) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
          <button className="primary" disabled={save.busy} onClick={() => void save.run()}>Save</button><button onClick={() => setPick(null)}>Cancel</button>
        </>
      )}
      <ErrorNote message={save.error} />
    </div>
  );
}

/** The approved plan against the site's posted books, month by month (D-172). */
function Actuals({ id }: { id: string }) {
  const { can } = useAuth();
  const { data, error } = useApi<any>(can('books.view') ? `/api/proformas/${id}/actuals` : null);
  if (!data || error) return null;
  const tone = data.status === 'on_track' ? 'good' : data.status === 'behind' ? 'watch' : data.status === 'well_behind' ? 'bad' : undefined;
  let cp = 0; let ca = 0;
  const cum = (data.rows ?? []).map((r: any) => { cp += r.plan.ebitda; ca += r.actual.ebitda; return { month: r.month, plan: Math.round(cp), actual: Math.round(ca) }; });
  const t = data.totals;
  return (
    <section className="card stack">
      <h2>Plan against actual</h2>
      <p className="answer">{data.answer}</p>
      {data.started && (
        <>
          <Kpis items={[
            { label: 'Revenue to date', value: whole(t.actual.revenue), tone, note: `plan ${whole(t.plan.revenue)}` },
            { label: 'Operating profit', value: whole(t.actual.ebitda), note: `plan ${whole(t.plan.ebitda)}`, tone: t.actual.ebitda >= t.plan.ebitda ? 'good' : 'watch' },
            { label: 'Capital spent', value: whole(t.actual.capital), note: `plan ${whole(t.plan.capital)}`, tone: t.actual.capital > t.plan.capital * 1.05 ? 'watch' : undefined },
            { label: 'Months completed', value: `${data.monthsElapsed} of ${data.horizonMonths}` },
          ]} />
          {cum.length >= 2 && <ReportChart spec={{ kind: 'line', title: 'Cumulative operating profit, plan and actual', category: { key: 'month', label: 'Month' }, series: [{ key: 'plan', label: 'Plan' }, { key: 'actual', label: 'Actual' }], valueType: 'currency', data: cum }} />}
          <Table rows={[...data.rows].reverse().slice(0, 12)} rowKey={(r: any) => r.month} columns={[{ key: 'month', label: 'Month' },
            { key: 'rev', label: 'Revenue: actual (plan)', numeric: true, render: (r: any) => `${whole(r.actual.revenue)} (${whole(r.plan.revenue)})` },
            { key: 'cos', label: 'Cost of sales', numeric: true, render: (r: any) => `${whole(r.actual.costOfSales)} (${whole(r.plan.costOfSales)})` },
            { key: 'op', label: 'Operating costs', numeric: true, render: (r: any) => `${whole(r.actual.operating)} (${whole(r.plan.operating)})` },
            { key: 'ebitda', label: 'Operating profit', numeric: true, render: (r: any) => `${whole(r.actual.ebitda)} (${whole(r.plan.ebitda)})` },
            { key: 'cap', label: 'Capital', numeric: true, render: (r: any) => `${whole(r.actual.capital)} (${whole(r.plan.capital)})` }]} />
          <p className="faint">{data.note}</p>
        </>
      )}
    </section>
  );
}
