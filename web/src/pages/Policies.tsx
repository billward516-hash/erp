import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Markdown } from '../components/Markdown';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const TABS = [['handbook', 'Employee handbook'], ['all', 'All policies'], ['expenses', 'Expense rules']] as const;
const CATEGORY: Record<string, string> = { handbook: 'Handbook', expense: 'Expenses', hr: 'HR', it: 'IT', safety: 'Safety', quality: 'Quality', finance: 'Finance', other: 'Other' };

export function Policies() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'handbook';
  return (
    <>
      <PageHead eyebrow="Company" title="Policies and handbook" sub="The rules we work by, in one place. Read what applies to you and acknowledge it; HR publishes changes here." />
      <div className="row" role="tablist" aria-label="Policies">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'handbook' && <Handbook />}
      {tab === 'all' && <PolicyList />}
      {tab === 'expenses' && <ExpenseRulesCard />}
    </>
  );
}

function Handbook() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>('/api/handbook');
  const ack = useAction(async () => { await api.post('/api/handbook/acknowledge', {}); await reload(); });
  const install = useAction(async () => { await api.post('/api/policies/templates', {}); await reload(); });
  return (
    <Async loading={loading && !data} error={error}>{() => (
      <div className="handbook">
        <nav className="card toc" aria-label="Handbook contents">
          <h2>Contents</h2>
          {data.sections.length ? <ol>{data.sections.map((s: any) => <li key={s.id}><a href={`#s-${s.id}`}>{s.title}</a>{s.requires_acknowledgement && !s.acknowledged && <> <Pill tone="watch" label="New" /></>}</li>)}</ol>
            : <p className="muted">Nothing published yet.</p>}
          {can('policies.manage') && data.drafts > 0 && <p className="muted">{data.drafts} section{data.drafts === 1 ? '' : 's'} still in draft. <Link to="/policies?tab=all">Finish them</Link></p>}
          {can('policies.manage') && !data.sections.length && data.drafts === 0 && (
            <div className="stack">
              <p className="muted">Start from the template sections: each marks what your company must fill in before it can be published.</p>
              <button className="primary" onClick={() => install.run()} disabled={install.busy}>Start from templates</button><ErrorNote message={install.error} />
            </div>
          )}
        </nav>
        <article className="card stack">
          <div className="spread">
            <h2 style={{ margin: 0 }}>{data.company} employee handbook</h2>
            {data.pending > 0 ? <button className="primary" onClick={() => ack.run()} disabled={ack.busy}>I have read the handbook</button>
              : data.sections.length ? <Pill tone="good" label="Acknowledged" /> : null}
          </div>
          <ErrorNote message={ack.error} />
          {data.pending > 0 && <p className="notice warn">{data.pending} section{data.pending === 1 ? ' is' : 's are'} new or changed since you last acknowledged.</p>}
          {data.sections.map((s: any) => (
            <section key={s.id} id={`s-${s.id}`} className="handbook-section">
              <div className="spread"><h2>{s.title}</h2><span className="faint">{s.number} · revision {s.revision} · effective {fmtDate(s.effective_on)}</span></div>
              <Markdown text={s.body} />
            </section>
          ))}
        </article>
      </div>
    )}</Async>
  );
}

function PolicyList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/api/policies');
  const [f, setF] = useState({ title: '', category: 'hr' });
  const add = useAction(async () => { const p = await api.post('/api/policies', f); nav(`/policies/${p.id}`); });
  const install = useAction(async () => { await api.post('/api/policies/templates', {}); await reload(); });
  const rows = data ?? [];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Kpis items={[{ label: 'Published', value: rows.filter((r) => r.revision != null).length },
        { label: 'To acknowledge', value: rows.filter((r) => r.pending).length, tone: rows.some((r) => r.pending) ? 'watch' : 'good' },
        ...(can('policies.manage') ? [{ label: 'Drafts with placeholders', value: rows.filter((r) => r.draft_placeholders).length, tone: rows.some((r) => r.draft_placeholders) ? ('watch' as const) : undefined }] : [])]} />
      <section className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(r) => nav(`/policies/${r.id}`)} empty="No policies yet."
            columns={[{ key: 'number', label: 'Policy', render: (r) => <strong>{r.number}</strong> }, { key: 'title', label: 'Title' }, { key: 'category', label: 'Kind', render: (r) => CATEGORY[r.category] },
              { key: 'facility_code', label: 'Applies to', render: (r) => r.facility_code ?? 'Everyone' },
              { key: 'revision', label: 'In force', render: (r) => (r.revision ? `Revision ${r.revision} from ${fmtDate(r.effective_on)}` : <span className="faint">Not published</span>) },
              { key: 'status', label: 'You', render: (r) => (r.revision == null ? '' : r.pending ? <Pill tone="watch" label="To acknowledge" /> : r.requires_acknowledgement ? <Pill tone="good" label="Acknowledged" /> : <span className="faint">For reference</span>) },
              ...(can('policies.manage') ? [{ key: 'draft', label: 'Draft', render: (r: any) => (r.draft_id ? (r.draft_placeholders ? <Pill tone="watch" label={`${r.draft_placeholders} to complete`} /> : <Pill tone="info" label="Ready to publish" />) : '') }] : [])]} />
        )}</Async>
      </section>
      {can('policies.manage') && (
        <section className="card stack">
          <h2>Add a policy</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            <input id="policy-title" aria-label="Title" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required style={{ flex: '1 1 260px' }} />
            <select id="policy-category" aria-label="Kind" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <button disabled={add.busy}>Add</button><ErrorNote message={add.error} />
          </form>
          <div className="row"><button onClick={() => install.run()} disabled={install.busy}>Add missing template sections</button>
            <span className="faint">Handbook sections and the expense and travel policy, as drafts with placeholders. Templates are not legal advice; have them reviewed.</span></div>
          <ErrorNote message={install.error} />
        </section>
      )}
    </div>
  );
}

/** The expense rules: the expense policy shows this table, and expense reports are checked against it. */
export function ExpenseRules({ rules }: { rules: any }) {
  const p = rules.policy;
  return (
    <div className="stack">
      <ul className="checklist">
        <li>Itemized receipt required for any expense over <strong>{fmtMoney(p.receipt_required_over)}</strong> unless a category says otherwise.</li>
        <li>Mileage is repaid at {p.mileage_rate ? <strong>{fmtMoney(p.mileage_rate)} a mile</strong> : <mark className="placeholder">a rate the company has not set yet</mark>}.</li>
        <li>{p.submit_within_days ? <>Submit expenses within <strong>{p.submit_within_days} days</strong>; older ones are flagged for the approver.</> : 'No submission deadline is set.'}</li>
      </ul>
      <Table rows={rules.categories.filter((c: any) => c.active)} rowKey={(c: any) => c.id}
        columns={[{ key: 'name', label: 'Category' },
          { key: 'limit_per_item', label: 'Limit per expense', numeric: true, render: (c: any) => (c.kind === 'mileage' ? 'Per mile rate' : c.limit_per_item ? fmtMoney(c.limit_per_item) : <span className="faint">No limit</span>) },
          { key: 'limit_per_day', label: 'Limit per day', numeric: true, render: (c: any) => (c.limit_per_day ? fmtMoney(c.limit_per_day) : <span className="faint">No limit</span>) },
          { key: 'receipt_required_over', label: 'Receipt over', numeric: true, render: (c: any) => (c.kind === 'mileage' ? 'Trip log' : fmtMoney(c.receipt_required_over ?? p.receipt_required_over)) },
          { key: 'needs_attendees', label: 'Also needs', render: (c: any) => (c.needs_attendees ? 'Who attended and why' : '') }]} />
    </div>
  );
}

function ExpenseRulesCard() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>('/api/expense-policy');
  const [p, setP] = useState<any>(null);
  const [edit, setEdit] = useState<Record<string, any>>({});
  const savePolicy = useAction(async () => {
    await api.put('/api/expense-policy', { receiptRequiredOver: Number(p.receipt), mileageRate: p.mileage ? Number(p.mileage) : null, submitWithinDays: p.days ? Number(p.days) : null, notes: data.policy.notes });
    setP(null); await reload();
  });
  const saveCat = useAction(async (c: any) => {
    const e = edit[c.id]!; const n = (v: string) => (v === '' || v == null ? null : Number(v));
    await api.post('/api/expense-categories', { id: c.id, code: c.code, name: c.name, kind: c.kind, needsAttendees: c.needs_attendees, accountKey: c.account_key, active: c.active, sortOrder: c.sort_order,
      limitPerItem: n(e.item), limitPerDay: n(e.day), receiptRequiredOver: n(e.receipt) });
    const { [c.id]: _x, ...rest } = edit; setEdit(rest); await reload();
  });
  return (
    <Async loading={loading && !data} error={error}>{() => (
      <section className="card stack">
        <h2>Expense rules</h2>
        <p className="muted">Expense reports are checked against these rules when they are submitted, and the expense and travel policy shows them as they are here.</p>
        <ExpenseRules rules={data} />
        {can('policies.manage') && (
          <>
            <h3>Change the rules</h3>
            {p ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void savePolicy.run(); }}>
                <label className="row">Receipt over $<input id="xp-receipt" type="number" min="0" step="0.01" value={p.receipt} onChange={(e) => setP({ ...p, receipt: e.target.value })} style={{ width: 90 }} /></label>
                <label className="row">Mileage $/mile<input id="xp-mileage" type="number" min="0" step="0.001" value={p.mileage} onChange={(e) => setP({ ...p, mileage: e.target.value })} style={{ width: 90 }} /></label>
                <label className="row">Submit within (days)<input id="xp-days" type="number" min="1" value={p.days} onChange={(e) => setP({ ...p, days: e.target.value })} style={{ width: 80 }} /></label>
                <button className="primary" disabled={savePolicy.busy}>Save</button><button type="button" onClick={() => setP(null)}>Cancel</button><ErrorNote message={savePolicy.error} />
              </form>
            ) : <div><button onClick={() => setP({ receipt: String(data.policy.receipt_required_over), mileage: data.policy.mileage_rate ?? '', days: data.policy.submit_within_days ?? '' })}>Edit receipts, mileage and deadline</button></div>}
            <Table rows={data.categories} rowKey={(c: any) => c.id}
              columns={[{ key: 'name', label: 'Category', render: (c: any) => <>{c.name}{!c.active && <span className="faint"> (inactive)</span>}</> },
                ...(['item', 'day', 'receipt'] as const).map((k) => ({ key: k, label: { item: 'Per expense $', day: 'Per day $', receipt: 'Receipt over $' }[k],
                  render: (c: any) => (c.kind === 'mileage' && k !== 'day' ? '—' : edit[c.id] ? (
                    <input aria-label={`${c.name}: ${{ item: 'limit per expense', day: 'limit per day', receipt: 'receipt over' }[k]}`} type="number" min="0" step="0.01" value={edit[c.id][k] ?? ''}
                      onChange={(e) => setEdit({ ...edit, [c.id]: { ...edit[c.id], [k]: e.target.value } })} style={{ width: 90 }} />)
                    : (({ item: c.limit_per_item, day: c.limit_per_day, receipt: c.receipt_required_over } as any)[k] ?? <span className="faint">—</span>)) })),
                { key: 'x', label: '', render: (c: any) => (edit[c.id] ? <button onClick={() => saveCat.run(c)} disabled={saveCat.busy}>Save</button>
                  : <button onClick={() => setEdit({ ...edit, [c.id]: { item: c.limit_per_item ?? '', day: c.limit_per_day ?? '', receipt: c.receipt_required_over ?? '' } })} aria-label={`Edit ${c.name}`}>Edit</button>) }]} />
            <ErrorNote message={saveCat.error} />
          </>
        )}
      </section>
    )}</Async>
  );
}

export function PolicyDetail() {
  const { id } = useParams();
  const { data: p, loading, error, reload } = useApi<any>(`/api/policies/${id}`);
  const [d, setD] = useState<{ body: string; changeSummary: string; minor: boolean } | null>(null);
  const [effective, setEffective] = useState('');
  const ack = useAction(async () => { await api.post(`/api/policies/${id}/acknowledge`, {}); await reload(); });
  const save = useAction(async () => { await api.put(`/api/policies/${id}/draft`, { body: d!.body, changeSummary: d!.changeSummary || null, requiresReack: !d!.minor }); setD(null); await reload(); });
  const startDraft = useAction(async () => { await api.put(`/api/policies/${id}/draft`, {}); await reload(); });
  const publish = useAction(async () => { await api.post(`/api/policies/${id}/publish`, { effectiveOn: effective || null }); await reload(); });
  const discard = useAction(async () => { await api.delete(`/api/policies/${id}/draft`); await reload(); });
  return (
    <Async loading={loading && !p} error={error}>{() => {
      const tokens = p.expenseRules ? { expense_rules: <ExpenseRules rules={p.expenseRules} /> } : {};
      return (
        <>
          <PageHead eyebrow={`${CATEGORY[p.category]} · ${p.facility_code ?? 'Everyone'}`} title={<>{p.number} <span className="muted" style={{ fontWeight: 400 }}>{p.title}</span></>}
            sub={p.current ? <>Revision {p.current.revision}, effective {fmtDate(p.current.effective_on)}{p.owner_name ? ` · owner ${p.owner_name}` : ''}</> : 'Not published yet'}
            actions={p.current && p.requires_acknowledgement ? (p.acknowledged ? <Pill tone="good" label={`Acknowledged ${fmtDate(p.acknowledgedAt)}`} />
              : <button className="primary" onClick={() => ack.run()} disabled={ack.busy}>I have read this policy</button>) : undefined} />
          <ErrorNote message={ack.error} />
          {p.current && <article className="card"><Markdown text={p.current.body} tokens={tokens} /></article>}
          {p.canManage && (
            <section className="card stack">
              <div className="spread"><h2>{p.draft ? `Draft revision ${p.draft.revision}` : 'Change this policy'}</h2>
                {p.draft && !d && <div className="row"><button onClick={() => setD({ body: p.draft.body, changeSummary: p.draft.change_summary ?? '', minor: !p.draft.requires_reack })}>Edit draft</button>
                  {p.current && <button className="danger" onClick={() => discard.run()} disabled={discard.busy}>Discard draft</button>}</div>}
              </div>
              {!p.draft && <div><button onClick={() => startDraft.run()} disabled={startDraft.busy}>Start a new revision</button><ErrorNote message={startDraft.error} /></div>}
              {p.draft && d && (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
                  <label className="field">Text (## for headings, - for lists, **bold**; [[brackets]] mark what is still to complete)
                    <textarea id="policy-body" rows={18} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} className="mono" /></label>
                  {p.draft.revision > 1 && <>
                    <input id="policy-summary" aria-label="What changed" placeholder="What changed in this revision" value={d.changeSummary} onChange={(e) => setD({ ...d, changeSummary: e.target.value })} />
                    <label className="row"><input id="policy-minor" type="checkbox" checked={d.minor} onChange={(e) => setD({ ...d, minor: e.target.checked })} /> Minor change (wording only): keep earlier acknowledgements</label>
                  </>}
                  <div className="row"><button className="primary" disabled={save.busy}>Save draft</button><button type="button" onClick={() => setD(null)}>Cancel</button><ErrorNote message={save.error} /></div>
                </form>
              )}
              {p.draft && !d && (
                <>
                  {p.draft.placeholders.length > 0
                    ? <p className="notice warn">{p.draft.placeholders.length} placeholder{p.draft.placeholders.length === 1 ? '' : 's'} to complete before publishing: {p.draft.placeholders.slice(0, 6).join(', ')}{p.draft.placeholders.length > 6 ? ', …' : ''}</p>
                    : <p className="notice ok">Ready to publish.</p>}
                  <div className="card" style={{ background: 'var(--bg)' }}><Markdown text={p.draft.body} tokens={tokens} /></div>
                  <div className="row">
                    <label className="row">Effective<input id="policy-effective" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} /></label>
                    <button className="primary" onClick={() => publish.run()} disabled={publish.busy || p.draft.placeholders.length > 0}>Publish</button><ErrorNote message={publish.error} />
                  </div>
                </>
              )}
            </section>
          )}
          {p.status && (
            <section className="card stack">
              <h2>Acknowledgements</h2>
              <p>{p.status.acknowledged} of {p.status.total} people have acknowledged the version in force.</p>
              {p.status.outstanding.length > 0 && <p className="muted">Still to acknowledge: {p.status.outstanding.slice(0, 30).map((x: any) => x.name).join(', ')}{p.status.outstanding.length > 30 ? ', …' : ''}</p>}
            </section>
          )}
          {p.history.length > 0 && (
            <section className="card">
              <h2>History</h2>
              <Table rows={p.history} columns={[{ key: 'revision', label: 'Revision', numeric: true }, { key: 'status', label: 'Status', render: (v: any) => humanize(v.status) },
                { key: 'effective_on', label: 'Effective', render: (v: any) => fmtDate(v.effective_on) }, { key: 'published_by_name', label: 'Published by', render: (v: any) => <>{v.published_by_name} <span className="faint">{fmtDateTime(v.published_at)}</span></> },
                { key: 'change_summary', label: 'What changed', render: (v: any) => <>{v.change_summary ?? (v.revision === 1 ? 'First version' : '—')}{!v.requires_reack && <span className="faint"> (minor)</span>}</> }]} />
            </section>
          )}
        </>
      );
    }}</Async>
  );
}
