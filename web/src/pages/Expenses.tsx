import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, 'good' | 'watch' | 'bad' | 'info' | 'neutral'> = { draft: 'neutral', submitted: 'info', approved: 'watch', rejected: 'bad', paid: 'good', cancelled: 'neutral' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', submitted: 'Waiting for approval', approved: 'Approved, to reimburse', rejected: 'Rejected', paid: 'Reimbursed', cancelled: 'Cancelled' };
const today = () => new Date().toISOString().slice(0, 10);

export function Expenses() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'mine';
  const tabs = [['mine', 'My reports'], ...(can('expenses.view_all') ? [['all', 'All reports']] : []), ...(can('expenses.manage') ? [['rules', 'Approval rules']] : [])];
  return (
    <>
      <PageHead eyebrow="My day" title="Expenses" sub={<>Claim business expenses with receipts. Reports are checked against the <Link to="/policies?tab=expenses">expense rules</Link> and approved by your manager and, above set amounts, finance.</>} />
      <div className="row" role="tablist" aria-label="Expenses">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k! })}>{l}</button>)}
      </div>
      {tab === 'mine' && <ReportList scope="mine" />}
      {tab === 'all' && <ReportList scope="all" />}
      {tab === 'rules' && <Rules />}
    </>
  );
}

function ReportList({ scope }: { scope: 'mine' | 'all' }) {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>(`/api/expenses?scope=${scope}`);
  const [f, setF] = useState({ title: '', purpose: '' });
  const create = useAction(async () => { const r = await api.post('/api/expenses', { title: f.title, purpose: f.purpose || null }); nav(`/expenses/${r.id}`); });
  const rows = data ?? [];
  return (
    <>
      <Kpis items={[{ label: 'Drafts', value: rows.filter((r) => r.status === 'draft').length },
        { label: 'Waiting for approval', value: rows.filter((r) => r.status === 'submitted').length },
        { label: 'To reimburse', value: fmtMoney(rows.filter((r) => r.status === 'approved').reduce((s, r) => s + r.total, 0)), tone: rows.some((r) => r.status === 'approved') ? 'watch' : undefined },
        { label: 'Reimbursed', value: fmtMoney(rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.total, 0)) }]} />
      {scope === 'mine' && (
        <section className="card stack">
          <h2>New expense report</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
            <input id="exp-title" aria-label="Report title" placeholder='Title, e.g. "Customer visit, Chicago"' value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required style={{ flex: '1 1 240px' }} />
            <input id="exp-purpose" aria-label="Business purpose" placeholder="Business purpose" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} style={{ flex: '2 1 280px' }} />
            <button className="primary" disabled={create.busy}>Start report</button>
          </form>
          <ErrorNote message={create.error} />
        </section>
      )}
      <section className="card">
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(r) => nav(`/expenses/${r.id}`)} empty="No expense reports yet."
            columns={[{ key: 'number', label: 'Report', render: (r) => <strong>{r.number}</strong> }, ...(scope === 'all' ? [{ key: 'claimant_name', label: 'Claimant' }, { key: 'department_name', label: 'Department', render: (r: any) => r.department_name ?? '—' }] : []),
              { key: 'title', label: 'Title' }, { key: 'lines', label: 'Lines', numeric: true }, { key: 'total', label: 'Total', numeric: true, render: (r) => fmtMoney(r.total) },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={STATUS[r.status]} label={STATUS_LABEL[r.status]} /> },
              { key: 'created_at', label: 'Started', render: (r) => fmtDate(r.created_at) }]} />
        )}</Async>
      </section>
    </>
  );
}

function Rules() {
  const { data, loading, error, reload } = useApi<any[]>('/api/expense-rules');
  const depts = useApi<any[]>('/api/departments');
  const sites = useApi<any[]>('/api/facilities');
  const users = useApi<any[]>('/api/users');
  const blank = { facilityId: '', departmentId: '', minAmount: '0', stage: '1', approver: 'role', roleKey: 'finance_approver', label: '' };
  const [f, setF] = useState(blank);
  const save = useAction(async () => {
    await api.post('/api/expense-rules', { facilityId: f.facilityId || null, departmentId: f.departmentId || null, minAmount: Number(f.minAmount), stage: Number(f.stage), approver: f.approver, roleKey: f.roleKey, label: f.label });
    setF(blank); await reload();
  });
  const toggle = useAction(async (r: any) => {
    await api.post('/api/expense-rules', { id: r.id, facilityId: r.facility_id, departmentId: r.department_id, minAmount: r.min_amount, stage: r.stage, approver: r.approver, roleKey: r.role_key, label: r.label, active: !r.active });
    await reload();
  });
  const head = useAction(async (deptId: string, userId: string) => { await api.put(`/api/departments/${deptId}/head`, { userId: userId || null }); await depts.reload(); });
  return (
    <>
      <section className="card stack">
        <h2>Approval rules</h2>
        <p className="muted">Every active rule whose site, department and amount match a report adds a step; stages are signed in order. A department-head step goes to the head of the claimant's department in person (or to the rule's role when there is no head, or the head is claiming).</p>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={data!} columns={[{ key: 'stage', label: 'Stage', numeric: true }, { key: 'label', label: 'Step' },
            { key: 'approver', label: 'Signed by', render: (r: any) => (r.approver === 'department_head' ? <>Department head <span className="faint">(else {humanize(r.role_key)})</span></> : humanize(r.role_key)) },
            { key: 'min_amount', label: 'From', numeric: true, render: (r: any) => fmtMoney(r.min_amount) },
            { key: 'facility_code', label: 'Site', render: (r: any) => r.facility_code ?? 'All' }, { key: 'department_name', label: 'Department', render: (r: any) => r.department_name ?? 'All' },
            { key: 'active', label: '', render: (r: any) => <button onClick={() => toggle.run(r)} disabled={toggle.busy}>{r.active ? 'Turn off' : 'Turn on'}</button> }]} />
        )}</Async>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <input id="rule-label" aria-label="Step name" placeholder="Step name" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required style={{ flex: '1 1 180px' }} />
          <select id="rule-approver" aria-label="Signed by" value={f.approver} onChange={(e) => setF({ ...f, approver: e.target.value })}><option value="role">A role</option><option value="department_head">The department head</option></select>
          <input id="rule-role" aria-label="Role key" placeholder="role key" value={f.roleKey} onChange={(e) => setF({ ...f, roleKey: e.target.value })} style={{ width: 160 }} />
          <label className="row">From $<input id="rule-min" type="number" min="0" value={f.minAmount} onChange={(e) => setF({ ...f, minAmount: e.target.value })} style={{ width: 90 }} /></label>
          <label className="row">Stage<input id="rule-stage" type="number" min="1" max="9" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} style={{ width: 60 }} /></label>
          <select id="rule-site" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}><option value="">All sites</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>
          <select id="rule-dept" aria-label="Department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">All departments</option>{(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <button disabled={save.busy}>Add rule</button>
        </form>
        <ErrorNote message={save.error ?? toggle.error} />
      </section>
      <section className="card stack">
        <h2>Department heads</h2>
        <Table rows={depts.data ?? []} empty="No departments yet." columns={[{ key: 'name', label: 'Department' }, { key: 'facility_code', label: 'Site', render: (d: any) => d.facility_code ?? 'All' },
          { key: 'people', label: 'People', numeric: true },
          { key: 'head', label: 'Head (signs expense reports)', render: (d: any) => (
            <select aria-label={`Head of ${d.name}`} value={d.head_user_id ?? ''} onChange={(e) => head.run(d.id, e.target.value)}>
              <option value="">No head</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>) }]} />
        <ErrorNote message={head.error} />
      </section>
    </>
  );
}

const blankLine = () => ({ id: '', spentOn: today(), categoryId: '', merchant: '', description: '', amount: '', miles: '', attendees: '', explanation: '' });

export function ExpenseDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const { data: r, loading, error, reload } = useApi<any>(`/api/expenses/${id}`);
  const queue = useApi<any[]>('/api/approvals/queue');
  const [l, setL] = useState(blankLine());
  const [comment, setComment] = useState('');
  const [pay, setPay] = useState({ paidOn: today(), method: 'payroll', reference: '' });
  const saveLine = useAction(async () => {
    const n = (v: string) => (v === '' ? null : Number(v));
    await api.post(`/api/expenses/${id}/lines`, { ...(l.id ? { id: l.id } : {}), spentOn: l.spentOn, categoryId: l.categoryId, merchant: l.merchant || null, description: l.description || null,
      amount: n(l.amount), miles: n(l.miles), attendees: l.attendees || null, explanation: l.explanation || null });
    setL(blankLine()); await reload();
  });
  const del = useAction(async (lineId: string) => { await api.delete(`/api/expense-lines/${lineId}`); await reload(); });
  const receipt = useAction(async (lineId: string, file: File) => {
    await api.post(`/api/expense-lines/${lineId}/receipt`, { fileName: file.name, mime: file.type || 'application/octet-stream', contentBase64: await fileToBase64(file) }); await reload();
  });
  const act = useAction(async (what: 'submit' | 'withdraw' | 'revise') => { await api.post(`/api/expenses/${id}/${what}`, {}); await reload(); await queue.reload(); });
  const decide = useAction(async (stepId: string, decision: 'approve' | 'reject') => { await api.post(`/api/approvals/steps/${stepId}/decide`, { decision, comment: comment || null }); setComment(''); await reload(); await queue.reload(); });
  const paid = useAction(async () => { await api.post(`/api/expenses/${id}/paid`, { ...pay, reference: pay.reference || null }); await reload(); });
  return (
    <Async loading={loading && !r} error={error}>{() => {
      const cat = r.categories.find((c: any) => c.id === l.categoryId);
      const myStep = (queue.data ?? []).find((q) => q.subjectId === r.id);
      const edit = (x: any) => setL({ id: x.id, spentOn: x.spent_on, categoryId: x.category_id, merchant: x.merchant ?? '', description: x.description ?? '', amount: x.category_kind === 'mileage' ? '' : String(x.amount),
        miles: x.miles ? String(x.miles) : '', attendees: x.attendees ?? '', explanation: x.explanation ?? '' });
      return (
        <>
          <PageHead eyebrow={`${r.facility_code}${r.department_name ? ` · ${r.department_name}` : ''} · Expense report`} title={<>{r.number} <span className="muted" style={{ fontWeight: 400 }}>{r.title}</span></>}
            sub={<>{r.claimant_name}{r.purpose ? ` · ${r.purpose}` : ''} · {fmtMoney(r.total)}{r.revision > 1 ? ` · revision ${r.revision}` : ''}</>}
            actions={<Pill tone={STATUS[r.status]} label={STATUS_LABEL[r.status]} />} />
          {myStep && (
            <section className="card stack" style={{ borderColor: 'var(--accent)' }}>
              <h2>Waiting for you: {myStep.label}{myStep.onBehalfOf ? ` (for ${myStep.onBehalfOf.name})` : ''}</h2>
              {r.exceptions > 0 && <p className="notice warn">{r.exceptions} policy exception{r.exceptions === 1 ? '' : 's'} on this report, explained by the claimant below.</p>}
              <div className="row">
                <input id="exp-comment" aria-label="Comment" placeholder="Comment (required to reject)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: '1 1 260px' }} />
                <button className="primary" onClick={() => decide.run(myStep.stepId, 'approve')} disabled={decide.busy}>Approve</button>
                <button className="danger" onClick={() => decide.run(myStep.stepId, 'reject')} disabled={decide.busy}>Reject</button>
              </div>
              <ErrorNote message={decide.error} />
            </section>
          )}
          <section className="card stack">
            <h2>Expenses</h2>
            <Table rows={r.lines} empty="No expenses yet. Add the first one below."
              columns={[{ key: 'spent_on', label: 'Date', render: (x: any) => fmtDate(x.spent_on) }, { key: 'category_name', label: 'Category' },
                { key: 'what', label: 'Details', render: (x: any) => (
                  <div className="stack" style={{ gap: 2 }}>
                    <span>{[x.merchant, x.description].filter(Boolean).join(': ') || '—'}{x.miles ? <span className="faint"> · {x.miles} mi at {fmtMoney(x.rate)}</span> : null}</span>
                    {x.attendees && <span className="faint">Attendees: {x.attendees}</span>}
                    {x.findings.map((f: any, i: number) => <span key={i} className={f.severity === 'block' ? 'bad-text' : ''}><Pill tone={f.severity === 'block' ? 'bad' : 'watch'} label={f.severity === 'block' ? 'Fix' : 'Explain'} /> {f.message}</span>)}
                    {x.explanation && <span><strong>Explanation:</strong> {x.explanation}</span>}
                  </div>) },
                { key: 'amount', label: 'Amount', numeric: true, render: (x: any) => fmtMoney(x.amount) },
                { key: 'receipt', label: 'Receipt', render: (x: any) => (
                  <div className="stack" style={{ gap: 4 }}>
                    {x.has_receipt ? <button className="link" onClick={() => api.open(`/api/expense-lines/${x.id}/receipt`)}>{x.receipt_name}</button> : <span className="faint">None</span>}
                    {r.canEdit && <label className="btn" style={{ fontWeight: 500 }}>{x.has_receipt ? 'Replace' : 'Attach'}<input type="file" accept="image/*,application/pdf" aria-label={`Receipt for line ${x.line_no}`} style={{ display: 'none' }}
                      onChange={(e) => { const file = e.target.files?.[0]; if (file) void receipt.run(x.id, file); }} /></label>}
                  </div>) },
                ...(r.canEdit ? [{ key: 'x', label: '', render: (x: any) => <div className="row"><button onClick={() => edit(x)} aria-label={`Edit line ${x.line_no}`}>Edit</button><button className="link" onClick={() => del.run(x.id)} aria-label={`Delete line ${x.line_no}`}>Delete</button></div> }] : [])]} />
            <ErrorNote message={receipt.error ?? del.error} />
            <div className="spread"><strong>Total {fmtMoney(r.total)}</strong>{r.status === 'draft' && r.lines.length > 0 && (r.ready ? <Pill tone="good" label="Ready to submit" /> : <Pill tone="watch" label="Fix or explain the flagged lines" />)}</div>
            {r.canEdit && (
              <form className="stack line-form" onSubmit={(e) => { e.preventDefault(); void saveLine.run(); }}>
                <h3>{l.id ? 'Change expense' : 'Add an expense'}</h3>
                <div className="row">
                  <input id="line-date" type="date" aria-label="Date" value={l.spentOn} onChange={(e) => setL({ ...l, spentOn: e.target.value })} required style={{ width: 160 }} />
                  <select id="line-category" aria-label="Category" value={l.categoryId} onChange={(e) => setL({ ...l, categoryId: e.target.value })} required>
                    <option value="">Category…</option>{r.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  {cat?.kind === 'mileage'
                    ? <label className="row">Miles<input id="line-miles" type="number" min="0.1" step="0.1" value={l.miles} onChange={(e) => setL({ ...l, miles: e.target.value })} style={{ width: 100 }} />
                      <span className="faint">{r.policy.mileage_rate ? `at ${fmtMoney(r.policy.mileage_rate)} a mile` : 'no mileage rate set yet'}</span></label>
                    : <label className="row">$<input id="line-amount" type="number" min="0" step="0.01" value={l.amount} onChange={(e) => setL({ ...l, amount: e.target.value })} style={{ width: 120 }} /></label>}
                </div>
                <div className="row">
                  <input id="line-merchant" aria-label="Merchant" placeholder="Merchant" value={l.merchant} onChange={(e) => setL({ ...l, merchant: e.target.value })} style={{ flex: '1 1 180px' }} />
                  <input id="line-description" aria-label="Description" placeholder={cat?.kind === 'mileage' ? 'From, to and why' : 'Description'} value={l.description} onChange={(e) => setL({ ...l, description: e.target.value })} style={{ flex: '2 1 260px' }} />
                </div>
                {cat?.needs_attendees && <input id="line-attendees" aria-label="Attendees and business reason" placeholder="Who attended and the business reason" value={l.attendees} onChange={(e) => setL({ ...l, attendees: e.target.value })} />}
                <input id="line-explanation" aria-label="Explanation for policy exceptions" placeholder="Explanation, if the policy flags this expense (over a limit, no receipt, late)" value={l.explanation} onChange={(e) => setL({ ...l, explanation: e.target.value })} />
                <div className="row"><button className="primary" disabled={saveLine.busy}>{l.id ? 'Save change' : 'Add expense'}</button>{l.id && <button type="button" onClick={() => setL(blankLine())}>Cancel</button>}<ErrorNote message={saveLine.error} /></div>
              </form>
            )}
          </section>
          {r.status === 'draft' && r.route && (
            <section className="card stack">
              <h2>Approval route</h2>
              {r.route.length ? <ol className="checklist route">{r.route.map((s: any, i: number) => <li key={i}>Stage {i + 1}: {s.steps.map((x: any) => x.label).join(' and ')}</li>)}</ol>
                : <p className="notice warn">No approval rule matches this report yet; finance sets the rules.</p>}
              {r.canEdit && <div className="row"><button className="primary" onClick={() => act.run('submit')} disabled={act.busy || !r.lines.length}>Submit for approval</button><ErrorNote message={act.error} /></div>}
            </section>
          )}
          {r.status === 'submitted' && r.user_id === me?.userId && <div className="row"><button onClick={() => act.run('withdraw')} disabled={act.busy}>Withdraw to change it</button><ErrorNote message={act.error} /></div>}
          {r.status === 'rejected' && r.user_id === me?.userId && <div className="row"><button className="primary" onClick={() => act.run('revise')} disabled={act.busy}>Revise and resubmit</button><ErrorNote message={act.error} /></div>}
          {r.canPay && (
            <section className="card stack">
              <h2>Record the reimbursement</h2>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void paid.run(); }}>
                <input id="pay-date" type="date" aria-label="Paid on" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} style={{ width: 160 }} />
                <select id="pay-method" aria-label="Method" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  <option value="payroll">With payroll</option><option value="direct_deposit">Direct deposit</option><option value="check">Check</option><option value="other">Other</option></select>
                <input id="pay-ref" aria-label="Reference" placeholder="Reference (payroll run, check no.)" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                <button className="primary" disabled={paid.busy}>Mark reimbursed</button>
              </form>
              <ErrorNote message={paid.error} />
            </section>
          )}
          {r.status === 'paid' && <p className="notice ok">Reimbursed {fmtMoney(r.total)} on {fmtDate(r.paid_on)} by {humanize(r.payment_method)}{r.payment_reference ? ` (${r.payment_reference})` : ''}, recorded by {r.paid_by_name}.</p>}
          {r.approvals.length > 0 && (
            <section className="card stack">
              <h2>Approvals</h2>
              {r.approvals.map((q: any) => (
                <div key={q.id}>
                  <p className="muted">Revision {q.subject_revision}, {humanize(q.status)} · submitted {fmtDateTime(q.created_at)}</p>
                  <Table rows={q.steps} columns={[{ key: 'stage', label: 'Stage', numeric: true }, { key: 'label', label: 'Step' }, { key: 'status', label: 'Decision', render: (s: any) => <Pill value={s.status} /> },
                    { key: 'decided_by', label: 'By', render: (s: any) => (s.decided_by ? <>{s.decided_by}{s.on_behalf_of ? <span className="faint"> for {s.on_behalf_of}</span> : null}</> : '—') },
                    { key: 'comment', label: 'Comment', render: (s: any) => s.comment ?? '' }]} />
                </div>
              ))}
            </section>
          )}
        </>
      );
    }}</Async>
  );
}
