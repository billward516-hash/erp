import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Attachments } from '../components/Attachments';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS_TONE: Record<string, 'info' | 'watch' | 'good' | 'neutral'> = { draft: 'info', in_review: 'watch', approved: 'good', superseded: 'neutral' };
const CRIT_TONE: Record<string, 'bad' | 'watch' | 'neutral'> = { critical: 'bad', high: 'watch', medium: 'neutral' };
const OUTCOME_TONE: Record<string, 'good' | 'watch' | 'bad'> = { met: 'good', partly_met: 'watch', not_met: 'bad' };
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const hrs = (v?: number | null) => (v == null ? '—' : `${fmtNum(v)} h`);

export function Continuity() {
  const nav = useNavigate();
  const { can, me } = useAuth();
  const { data, loading, error } = useApi<any[]>('/api/continuity-plans');
  const [show, setShow] = useState(false);
  const facilities = useApi<any[]>(show ? '/api/facilities' : null);
  const [f, setF] = useState({ facilityId: '', process: '', title: '', criticality: 'high', rtoHours: '', rpoHours: '', alternateUserId: '' });
  const users = useApi<any[]>(show && f.facilityId ? `/api/assignable-users?facilityId=${f.facilityId}` : null);
  const save = useAction(async () => {
    const x = await api.post('/api/continuity-plans', { facilityId: f.facilityId, process: f.process, title: f.title, criticality: f.criticality, rtoHours: Number(f.rtoHours),
      rpoHours: f.rpoHours ? Number(f.rpoHours) : null, alternateUserId: f.alternateUserId || null });
    nav(`/continuity/${x.id}`);
  });
  const rows = data ?? [];
  return (
    <>
      <PageHead eyebrow="Quality & safety" title="Business continuity" sub="Plans for the processes the business cannot be without: what they depend on, how each disruption is recovered, who to call, and proof from exercises." />
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <Kpis items={[{ label: 'Plans', value: rows.length }, { label: 'Approved', value: rows.filter((r) => r.status === 'approved').length },
            { label: 'RTO demonstrated', value: rows.filter((r) => r.demonstratedHours != null).length, tone: rows.some((r) => r.status === 'approved' && r.demonstratedHours == null) ? 'watch' : 'good' },
            { label: 'Plans with high gaps', value: rows.filter((r) => r.high_gaps).length, tone: rows.some((r) => r.high_gaps) ? 'bad' : 'good' }]} />
          <div className="card">
            <Table rows={rows} onRow={(r) => nav(`/continuity/${r.id}`)} exception={(r) => r.high_gaps > 0} empty="No continuity plans yet."
              columns={[{ key: 'number', label: 'Plan', render: (r) => <strong>{r.number} <span className="faint">rev {r.revision}</span></strong> }, { key: 'facility_code', label: 'Site' },
                { key: 'process', label: 'Critical process', render: (r) => <>{r.process}<div className="faint">{r.title}</div></> },
                { key: 'criticality', label: 'Criticality', render: (r) => <Pill tone={CRIT_TONE[r.criticality]} label={humanize(r.criticality)} /> },
                { key: 'rto_hours', label: 'RTO', numeric: true, render: (r) => hrs(r.rto_hours) },
                { key: 'demonstratedHours', label: 'Recovered in', numeric: true, render: (r) => (r.demonstratedHours != null ? hrs(r.demonstratedHours) : <span className="faint">not shown</span>) },
                { key: 'lastExercise', label: 'Last exercise', render: (r) => fmtDate(r.lastExercise) },
                { key: 'review_due', label: 'Review due', render: (r) => fmtDate(r.review_due) },
                { key: 'high_gaps', label: 'High gaps', numeric: true }, { key: 'open_actions', label: 'Open actions', numeric: true },
                { key: 'status', label: 'Status', render: (r) => <Pill tone={STATUS_TONE[r.status]} label={humanize(r.status)} /> }]} />
          </div>
        </>
      )}</Async>
      {can('continuity.manage') && !show && <div><button onClick={() => setShow(true)}>New continuity plan</button></div>}
      {show && (
        <section className="card stack">
          <h2>New continuity plan</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <div className="row">
              <select id="bcp-facility" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })} required>
                <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </select>
              <select id="bcp-criticality" aria-label="Criticality" value={f.criticality} onChange={(e) => setF({ ...f, criticality: e.target.value })}>
                <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option>
              </select>
              <input id="bcp-rto" type="number" min="0.5" step="0.5" aria-label="RTO hours" placeholder="RTO (hours)" value={f.rtoHours} onChange={(e) => setF({ ...f, rtoHours: e.target.value })} required style={{ width: 130 }} />
              <input id="bcp-rpo" type="number" min="0" step="0.5" aria-label="RPO hours" placeholder="RPO (hours, optional)" value={f.rpoHours} onChange={(e) => setF({ ...f, rpoHours: e.target.value })} style={{ width: 170 }} />
              <select id="bcp-alternate" aria-label="Alternate owner" value={f.alternateUserId} onChange={(e) => setF({ ...f, alternateUserId: e.target.value })}>
                <option value="">Alternate owner…</option>{(users.data ?? []).filter((u) => u.id !== me?.userId).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
            </div>
            <input id="bcp-process" aria-label="Critical process" placeholder="Critical process (e.g. stamping of HSG-220 housings)" value={f.process} onChange={(e) => setF({ ...f, process: e.target.value })} required />
            <input id="bcp-title" aria-label="Title" placeholder="Plan title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
            <div className="row"><button className="primary" disabled={save.busy}>Create</button><button type="button" onClick={() => setShow(false)}>Cancel</button><ErrorNote message={save.error} /></div>
            <p className="faint">RTO: how long the process can be down before the damage is unacceptable. RPO: how much recent data or records may be lost, where that applies.</p>
          </form>
        </section>
      )}
    </>
  );
}

interface DepEdit { kind: string; ref: string; description: string; workaround: string; minHolders: string }
interface ScenEdit { scenario: string; impact: string; recoverySteps: string; recoveryOwnerUserId: string; estRecoveryHours: string; documentId: string }
interface ContactEdit { name: string; role: string; phone: string; email: string }
const REF_KEY: Record<string, string> = { asset: 'assetId', supplier: 'supplierId', skill: 'qualificationId', person: 'employeeId' };
const REF_COL: Record<string, string> = { asset: 'asset_id', supplier: 'supplier_id', skill: 'qualification_id', person: 'employee_id' };

export function ContinuityDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const { data: p, loading, error, reload } = useApi<any>(`/api/continuity-plans/${id}`);
  const [body, setBody] = useState<{ deps: DepEdit[]; scens: ScenEdit[] } | null>(null);
  const [contacts, setContacts] = useState<ContactEdit[] | null>(null);
  const opts = useApi<any>(p?.canEdit && (body || contacts) ? `/api/continuity-plans/${id}/options` : null);
  const users = useApi<any[]>(p ? `/api/assignable-users?facilityId=${p.facility_id}` : null);
  const [ex, setEx] = useState<{ kind: string; scheduledOn: string; facilitatorUserId: string; scenarioId: string } | null>(null);
  const [rec, setRec] = useState<{ id: string; kind: string; conductedOn: string; participants: string; outcome: string; hours: string; findings: string } | null>(null);
  const [act, setAct] = useState<{ exerciseId: string; title: string; ownerUserId: string; dueDate: string } | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<string | null>(null);

  const saveBody = useAction(async () => {
    await api.put(`/api/continuity-plans/${id}/body`, {
      dependencies: body!.deps.map((d) => ({ kind: d.kind, ...(REF_KEY[d.kind] ? { [REF_KEY[d.kind]!]: d.ref } : {}), description: d.description, workaround: d.workaround || null,
        minHolders: d.kind === 'skill' && d.minHolders ? Number(d.minHolders) : null })),
      scenarios: body!.scens.map((s) => ({ scenario: s.scenario, impact: s.impact || null, recoverySteps: s.recoverySteps, recoveryOwnerUserId: s.recoveryOwnerUserId,
        estRecoveryHours: s.estRecoveryHours ? Number(s.estRecoveryHours) : null, documentId: s.documentId || null })),
    });
    setBody(null); await reload();
  });
  const saveContacts = useAction(async () => {
    await api.put(`/api/continuity-plans/${id}/contacts`, { contacts: contacts!.map((c) => ({ name: c.name, role: c.role, phone: c.phone || null, email: c.email || null })) });
    setContacts(null); await reload();
  });
  const submit = useAction(async () => { await api.post(`/api/continuity-plans/${id}/submit`, {}); await reload(); });
  const schedule = useAction(async () => { await api.post(`/api/continuity-plans/${id}/exercises`, { ...ex, scenarioId: ex!.scenarioId || null }); setEx(null); await reload(); });
  const record = useAction(async () => {
    await api.post(`/api/continuity-exercises/${rec!.id}/record`, { conductedOn: rec!.conductedOn, participants: rec!.participants, outcome: rec!.outcome,
      achievedRecoveryHours: rec!.hours ? Number(rec!.hours) : null, findings: rec!.findings || null });
    setRec(null); await reload();
  });
  const addAct = useAction(async () => {
    await api.post('/api/actions', { subjectType: 'continuity_plan', subjectId: id, continuityExerciseId: act!.exerciseId || null, title: act!.title, ownerUserId: act!.ownerUserId, dueDate: act!.dueDate });
    setAct(null); await reload();
  });
  const done = useAction(async (actionId: string, n: string) => { await api.post(`/api/actions/${actionId}/complete`, { note: n }); await reload(); });
  const review = useAction(async () => { await api.post(`/api/continuity-plans/${id}/review`, { note }); setNote(''); await reload(); });
  const revise = useAction(async () => { const n = await api.post(`/api/continuity-plans/${id}/revise`, { reason }); setReason(''); nav(`/continuity/${n.id}`); });

  return (
    <Async loading={loading && !p} error={error}>{() => {
      const draft = p.status === 'draft' && p.canEdit;
      const high = p.gaps.filter((g: any) => g.severity === 'high');
      const refOptions = (kind: string) => {
        const o = opts.data;
        if (!o) return [];
        return kind === 'asset' ? o.assets.map((a: any) => [a.id, `${a.asset_tag} · ${a.name}`]) : kind === 'supplier' ? o.suppliers.map((s: any) => [s.id, `${s.code} · ${s.name}`])
          : kind === 'skill' ? o.qualifications.map((q: any) => [q.id, q.name]) : kind === 'person' ? o.employees.map((e: any) => [e.id, `${e.name} (${e.employee_number})`]) : [];
      };
      const startBody = () => setBody({
        deps: p.dependencies.map((d: any) => ({ kind: d.kind, ref: d[REF_COL[d.kind]!] ?? '', description: d.description, workaround: d.workaround ?? '', minHolders: d.min_holders ? String(d.min_holders) : '' })),
        scens: p.scenarios.length ? p.scenarios.map((s: any) => ({ scenario: s.scenario, impact: s.impact ?? '', recoverySteps: s.recovery_steps, recoveryOwnerUserId: s.recovery_owner_user_id,
          estRecoveryHours: s.est_recovery_hours != null ? String(Number(s.est_recovery_hours)) : '', documentId: s.document_id ?? '' }))
          : [{ scenario: '', impact: '', recoverySteps: '', recoveryOwnerUserId: '', estRecoveryHours: '', documentId: '' }],
      });
      const setDep = (i: number, v: Partial<DepEdit>) => setBody({ ...body!, deps: body!.deps.map((d, j) => (j === i ? { ...d, ...v } : d)) });
      const setScen = (i: number, v: Partial<ScenEdit>) => setBody({ ...body!, scens: body!.scens.map((s, j) => (j === i ? { ...s, ...v } : s)) });
      return (
        <>
          <PageHead eyebrow={`${p.facility_code} · Business continuity · ${humanize(p.criticality)}`}
            title={<>{p.number} <span className="muted" style={{ fontWeight: 400 }}>rev {p.revision} · {p.title}</span></>}
            sub={<>{p.process} · owner {p.owner_name}{p.alternate_name ? `, alternate ${p.alternate_name}` : ''}{p.revision_reason ? ` · revised: ${p.revision_reason}` : ''}</>}
            actions={<><Pill tone={STATUS_TONE[p.status]} label={humanize(p.status)} />{p.review_due && <> <Pill tone={p.review_due < today() ? 'bad' : 'neutral'} label={`Review ${fmtDate(p.review_due)}`} /></>}</>} />
          <Kpis items={[{ label: 'RTO', value: hrs(p.rto_hours) }, { label: 'RPO', value: hrs(p.rpo_hours) },
            { label: 'Recovered in (timed exercise)', value: p.readiness.demonstratedHours != null ? hrs(p.readiness.demonstratedHours) : 'Not shown', tone: p.readiness.demonstratedHours != null ? 'good' : 'watch',
              note: p.readiness.bestTimedHours != null && p.readiness.demonstratedHours == null ? `best ${hrs(p.readiness.bestTimedHours)}` : undefined },
            { label: 'Next exercise due', value: fmtDate(p.readiness.exerciseDue), tone: p.readiness.exerciseDue && p.readiness.exerciseDue < today() ? 'bad' : undefined },
            { label: 'High gaps', value: high.length, tone: high.length ? 'bad' : 'good' }]} />

          <section className="card stack">
            <h2>Gaps</h2>
            {p.gaps.length ? (
              <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
                {p.gaps.map((g: any, i: number) => <li key={i}><Pill tone={g.severity === 'high' ? 'bad' : 'watch'} label={g.area} /> {g.text}</li>)}
              </ul>
            ) : <p className="muted">No gaps found against current records.</p>}
            <p className="faint">Checked live: qualification holders at the site, employee and supplier status, sole-source parts, equipment state, reviews and exercises.</p>
          </section>

          {body ? (
            <form className="card stack" onSubmit={(e) => { e.preventDefault(); void saveBody.run(); }}>
              <h2>Dependencies</h2>
              {body.deps.map((d, i) => (
                <div key={i} className="row" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
                  <strong>{i + 1}</strong>
                  <select aria-label={`Dependency ${i + 1} kind`} value={d.kind} onChange={(e) => setDep(i, { kind: e.target.value, ref: '' })}>
                    <option value="asset">Equipment</option><option value="supplier">Supplier</option><option value="skill">Skill (qualification)</option><option value="person">Person</option><option value="other">Other (utility, IT, building)</option>
                  </select>
                  {d.kind !== 'other' && (
                    <select aria-label={`Dependency ${i + 1} reference`} value={d.ref} onChange={(e) => setDep(i, { ref: e.target.value })} required>
                      <option value="">Choose…</option>{refOptions(d.kind).map(([v, l]: string[]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  )}
                  <input aria-label={`Dependency ${i + 1} description`} placeholder="What the process needs from it" value={d.description} onChange={(e) => setDep(i, { description: e.target.value })} required style={{ flex: '1 1 220px' }} />
                  <input aria-label={`Dependency ${i + 1} workaround`} placeholder="Workaround without it" value={d.workaround} onChange={(e) => setDep(i, { workaround: e.target.value })} style={{ flex: '1 1 220px' }} />
                  {d.kind === 'skill' && <input aria-label={`Dependency ${i + 1} holders needed`} type="number" min="1" placeholder="Holders needed (2)" value={d.minHolders} onChange={(e) => setDep(i, { minHolders: e.target.value })} style={{ width: 150 }} />}
                  <button type="button" className="link" onClick={() => setBody({ ...body, deps: body.deps.filter((_, j) => j !== i) })}>Remove</button>
                </div>
              ))}
              <div><button type="button" onClick={() => setBody({ ...body, deps: [...body.deps, { kind: 'asset', ref: '', description: '', workaround: '', minHolders: '' }] })}>Add dependency</button></div>
              <h2>Scenarios and recovery</h2>
              {body.scens.map((s, i) => (
                <div key={i} className="stack" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
                  <div className="row"><strong>{i + 1}</strong>
                    <input aria-label={`Scenario ${i + 1}`} placeholder="Disruption (e.g. press breakdown, supplier fails, site inaccessible)" value={s.scenario} onChange={(e) => setScen(i, { scenario: e.target.value })} required style={{ flex: '1 1 280px' }} />
                    <input aria-label={`Scenario ${i + 1} impact`} placeholder="Impact" value={s.impact} onChange={(e) => setScen(i, { impact: e.target.value })} style={{ flex: '1 1 200px' }} />
                    <select aria-label={`Scenario ${i + 1} recovery owner`} value={s.recoveryOwnerUserId} onChange={(e) => setScen(i, { recoveryOwnerUserId: e.target.value })} required>
                      <option value="">Recovery owner…</option>{(opts.data?.users ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                    </select>
                    <input aria-label={`Scenario ${i + 1} estimated recovery hours`} type="number" min="0.5" step="0.5" placeholder="Est. recovery (h)" value={s.estRecoveryHours} onChange={(e) => setScen(i, { estRecoveryHours: e.target.value })} style={{ width: 140 }} />
                    <select aria-label={`Scenario ${i + 1} procedure`} value={s.documentId} onChange={(e) => setScen(i, { documentId: e.target.value })}>
                      <option value="">Procedure (optional)…</option>{(opts.data?.documents ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.doc_number} · {d.title}</option>)}
                    </select>
                    <button type="button" className="link" onClick={() => setBody({ ...body, scens: body.scens.filter((_, j) => j !== i) })}>Remove</button>
                  </div>
                  <textarea aria-label={`Scenario ${i + 1} recovery steps`} placeholder="Recovery steps, in order" value={s.recoverySteps} onChange={(e) => setScen(i, { recoverySteps: e.target.value })} required rows={3} />
                </div>
              ))}
              <div className="row">
                <button type="button" onClick={() => setBody({ ...body, scens: [...body.scens, { scenario: '', impact: '', recoverySteps: '', recoveryOwnerUserId: '', estRecoveryHours: '', documentId: '' }] })}>Add scenario</button>
                <button className="primary" disabled={saveBody.busy}>Save plan</button><button type="button" onClick={() => setBody(null)}>Cancel</button><ErrorNote message={saveBody.error} />
              </div>
            </form>
          ) : (
            <>
              <section className="card stack">
                <div className="spread"><h2>Dependencies</h2>{draft && <button onClick={startBody}>Edit plan</button>}</div>
                <Table rows={p.dependencies} empty="No dependencies recorded." rowKey={(d) => d.id}
                  columns={[{ key: 'seq', label: '#', numeric: true }, { key: 'kind', label: 'Kind', render: (d) => humanize(d.kind === 'asset' ? 'equipment' : d.kind) },
                    { key: 'label', label: 'Depends on', render: (d) => <>{d.asset_id ? <Link to={`/assets/${d.asset_id}`}>{d.label}</Link> : <strong>{d.label}</strong>}{d.kind !== 'other' && <div className="faint">{d.description}</div>}</> },
                    { key: 'live_status', label: 'Now', render: (d) => d.live_status ?? '—' }, { key: 'workaround', label: 'Workaround', render: (d) => d.workaround ?? <span className="faint">none</span> }]} />
              </section>
              <section className="card stack">
                <h2>Scenarios and recovery</h2>
                {!p.scenarios.length && <p className="muted">No scenarios yet.</p>}
                {p.scenarios.map((s: any) => (
                  <div key={s.id} className="stack" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
                    <div className="spread"><strong>{s.seq}. {s.scenario}</strong>
                      <span>{s.recovery_owner_name} · est. {hrs(s.est_recovery_hours == null ? null : Number(s.est_recovery_hours))}
                        {s.est_recovery_hours != null && Number(s.est_recovery_hours) > p.rto_hours && <> <Pill tone="bad" label="Over RTO" /></>}</span></div>
                    {s.impact && <div className="muted">{s.impact}</div>}
                    <div style={{ whiteSpace: 'pre-wrap' }}>{s.recovery_steps}</div>
                    {s.document_id && <div className="faint">Procedure: {s.document_number} {s.document_title}</div>}
                  </div>
                ))}
              </section>
            </>
          )}

          <section className="card stack">
            <div className="spread"><h2>Call list</h2>{p.canEdit && ['draft', 'approved'].includes(p.status) && !contacts &&
              <button onClick={() => setContacts(p.contacts.length ? p.contacts.map((c: any) => ({ name: c.name, role: c.role, phone: c.phone ?? '', email: c.email ?? '' })) : [{ name: '', role: '', phone: '', email: '' }])}>Edit call list</button>}</div>
            {contacts ? (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void saveContacts.run(); }}>
                {contacts.map((c, i) => (
                  <div key={i} className="row">
                    {(['name', 'role', 'phone', 'email'] as const).map((k) => <input key={k} aria-label={`Contact ${i + 1} ${k}`} placeholder={humanize(k)} value={c[k]} required={k === 'name' || k === 'role'}
                      onChange={(e) => setContacts(contacts.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />)}
                    <button type="button" className="link" onClick={() => setContacts(contacts.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                ))}
                <div className="row"><button type="button" onClick={() => setContacts([...contacts, { name: '', role: '', phone: '', email: '' }])}>Add contact</button>
                  <button className="primary" disabled={saveContacts.busy}>Save call list</button><button type="button" onClick={() => setContacts(null)}>Cancel</button><ErrorNote message={saveContacts.error} /></div>
                {p.status === 'approved' && <p className="faint">Call-list changes apply to the approved plan straight away and are recorded in the audit log.</p>}
              </form>
            ) : (
              <Table rows={p.contacts} empty="No contacts yet." rowKey={(c) => c.id}
                columns={[{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'phone', label: 'Phone', render: (c) => (c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—') },
                  { key: 'email', label: 'Email', render: (c) => (c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—') }]} />
            )}
          </section>

          {draft && !body && <div className="row"><button className="primary" onClick={() => submit.run()} disabled={submit.busy}>Send for plant manager approval</button>
            <span className="faint">Needs at least one scenario with recovery steps and a call list. Gaps do not block approval; they stay visible.</span><ErrorNote message={submit.error} /></div>}

          <section className="card stack">
            <div className="spread"><h2>Exercises</h2>{p.status === 'approved' && p.canEdit && !ex &&
              <button onClick={() => setEx({ kind: 'tabletop', scheduledOn: inDays(30), facilitatorUserId: me?.userId ?? '', scenarioId: '' })}>Schedule exercise</button>}</div>
            <Table rows={p.exercises} empty={p.status === 'approved' ? 'Not exercised yet.' : 'Exercises are scheduled once the plan is approved.'} rowKey={(e) => e.id}
              exception={(e) => e.status === 'completed' && e.outcome !== 'met' && !e.actions}
              columns={[{ key: 'date', label: 'Date', render: (e) => fmtDate(e.conducted_on ?? e.scheduled_on) }, { key: 'kind', label: 'Kind', render: (e) => humanize(e.kind) },
                { key: 'revision', label: 'Rev', numeric: true }, { key: 'scenario', label: 'Scenario', render: (e) => (e.scenario_seq ? `${e.scenario_seq}. ${e.scenario}` : 'Whole plan') },
                { key: 'facilitator_name', label: 'Facilitator' },
                { key: 'result', label: 'Result', render: (e) => (e.status === 'completed' ? <><Pill tone={OUTCOME_TONE[e.outcome]} label={humanize(e.outcome)} />{e.achieved_recovery_hours != null && ` ${hrs(Number(e.achieved_recovery_hours))}`}
                  {e.findings && <div className="faint">{e.findings}</div>}</> : e.status === 'cancelled' ? <span className="faint">Cancelled: {e.cancel_reason}</span>
                  : (e.facilitator_user_id === me?.userId || p.canEdit) ? <button className="link" onClick={() => setRec({ id: e.id, kind: e.kind, conductedOn: today(), participants: '', outcome: 'met', hours: '', findings: '' })}>Record result</button> : 'Scheduled') },
                { key: 'actions', label: 'Actions', numeric: true },
                { key: 'evidence', label: '', render: (e) => <>{e.status === 'completed' && <button className="link" onClick={() => setEvidence(evidence === e.id ? null : e.id)}>Evidence</button>}
                  {e.status === 'completed' && e.outcome !== 'met' && p.canEdit && p.status !== 'superseded' && <> <button className="link" onClick={() => setAct({ exerciseId: e.id, title: '', ownerUserId: '', dueDate: inDays(30) })}>+ action</button></>}</> }]} />
            {ex && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void schedule.run(); }}>
                <select id="bcp-ex-kind" aria-label="Exercise kind" value={ex.kind} onChange={(e) => setEx({ ...ex, kind: e.target.value })}>
                  <option value="tabletop">Tabletop</option><option value="walkthrough">Walkthrough</option><option value="simulation">Simulation (timed)</option><option value="full_test">Full test (timed)</option>
                </select>
                <select aria-label="Scenario" value={ex.scenarioId} onChange={(e) => setEx({ ...ex, scenarioId: e.target.value })}>
                  <option value="">Whole plan</option>{p.scenarios.map((s: any) => <option key={s.id} value={s.id}>{s.seq}. {s.scenario}</option>)}
                </select>
                <input type="date" aria-label="Exercise date" value={ex.scheduledOn} onChange={(e) => setEx({ ...ex, scheduledOn: e.target.value })} required />
                <select aria-label="Facilitator" value={ex.facilitatorUserId} onChange={(e) => setEx({ ...ex, facilitatorUserId: e.target.value })} required>
                  <option value="">Facilitator…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
                <button className="primary" disabled={schedule.busy}>Schedule</button><button type="button" onClick={() => setEx(null)}>Cancel</button><ErrorNote message={schedule.error} />
              </form>
            )}
            {rec && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void record.run(); }}>
                <div className="row">
                  <input type="date" aria-label="Conducted on" value={rec.conductedOn} max={today()} onChange={(e) => setRec({ ...rec, conductedOn: e.target.value })} required />
                  <select id="bcp-outcome" aria-label="Outcome" value={rec.outcome} onChange={(e) => setRec({ ...rec, outcome: e.target.value })}>
                    <option value="met">Objectives met</option><option value="partly_met">Partly met</option><option value="not_met">Not met</option>
                  </select>
                  {['simulation', 'full_test'].includes(rec.kind) && <input id="bcp-hours" type="number" min="0.1" step="0.1" aria-label="Recovery took (hours)" placeholder={`Recovery took (h), RTO ${p.rto_hours}`} value={rec.hours} onChange={(e) => setRec({ ...rec, hours: e.target.value })} required style={{ width: 190 }} />}
                  <input id="bcp-participants" aria-label="Participants" placeholder="Who took part" value={rec.participants} onChange={(e) => setRec({ ...rec, participants: e.target.value })} required style={{ flex: '1 1 240px' }} />
                </div>
                <textarea id="bcp-findings" aria-label="Findings" placeholder="Findings: what worked, what fell short" value={rec.findings} onChange={(e) => setRec({ ...rec, findings: e.target.value })} rows={3} required={rec.outcome !== 'met'} />
                <div className="row"><button className="primary" disabled={record.busy}>Record result</button><button type="button" onClick={() => setRec(null)}>Cancel</button><ErrorNote message={record.error} />
                  <span className="faint">Results are final once recorded. A timed recovery longer than the RTO cannot count as met.</span></div>
              </form>
            )}
            {evidence && <Attachments subjectType="continuity_exercise" subjectId={evidence} title="Exercise evidence (sign-in sheets, timings, photos)" />}
          </section>

          <section className="card stack">
            <div className="spread"><h2>Actions</h2>{p.canEdit && p.status !== 'superseded' && !act && <button onClick={() => setAct({ exerciseId: '', title: '', ownerUserId: '', dueDate: inDays(30) })}>Add action</button>}</div>
            <Table rows={p.actions} empty="No actions." rowKey={(a) => a.id} exception={(a) => a.overdue}
              columns={[{ key: 'title', label: 'Action', render: (a) => <>{a.title}{a.continuity_exercise_id && <span className="faint"> (exercise finding)</span>}</> }, { key: 'owner_name', label: 'Owner' },
                { key: 'due_date', label: 'Due', render: (a) => <>{fmtDate(a.due_date)}{a.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> },
                { key: 'status', label: 'Status', render: (a) => (a.status === 'open' && (a.owner_user_id === me?.userId || p.canEdit)
                  ? <button className="link" onClick={() => { const n = prompt('What was done?'); if (n) void done.run(a.id, n); }}>Mark done</button> : <>{humanize(a.status)}{a.completion_note && <div className="faint">{a.completion_note}</div>}</>) }]} />
            <ErrorNote message={done.error} />
            {act && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void addAct.run(); }}>
                <input id="bcp-action" aria-label="Action" placeholder="Action" value={act.title} onChange={(e) => setAct({ ...act, title: e.target.value })} required style={{ flex: '1 1 280px' }} />
                <select aria-label="Action owner" value={act.ownerUserId} onChange={(e) => setAct({ ...act, ownerUserId: e.target.value })} required>
                  <option value="">Owner…</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
                <input type="date" aria-label="Due" value={act.dueDate} onChange={(e) => setAct({ ...act, dueDate: e.target.value })} required />
                <button className="primary" disabled={addAct.busy}>Add</button><button type="button" onClick={() => setAct(null)}>Cancel</button><ErrorNote message={addAct.error} />
              </form>
            )}
          </section>

          {p.status === 'approved' && p.canEdit && (
            <section className="card stack">
              <h2>Review and revision</h2>
              <p className="muted">Last reviewed {fmtDate(p.last_reviewed_at)}{p.last_review_note ? `: ${p.last_review_note}` : ''}. Reviews every {p.review_interval_months} months; exercises every {p.exercise_interval_months} months.</p>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void review.run(); }}>
                <input id="bcp-review" aria-label="Review note" placeholder="Reviewed, no change needed: what was checked" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 320px' }} />
                <button disabled={review.busy || note.trim().length < 3}>Confirm review</button><ErrorNote message={review.error} />
              </form>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void revise.run(); }}>
                <input id="bcp-revise" aria-label="Why revise" placeholder="Why revise (exercise findings, new equipment, supplier change)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 320px' }} />
                <button disabled={revise.busy || reason.trim().length < 3}>Start revision {p.revision + 1}</button><ErrorNote message={revise.error} />
              </form>
            </section>
          )}

          <section className="card">
            <h2>Revisions</h2>
            <Table rows={p.revisions} onRow={(r) => nav(`/continuity/${r.id}`)} rowKey={(r) => r.id}
              columns={[{ key: 'revision', label: 'Rev', numeric: true }, { key: 'status', label: 'Status', render: (r) => humanize(r.status) }, { key: 'approved_at', label: 'Approved', render: (r) => fmtDate(r.approved_at) },
                { key: 'revision_reason', label: 'Why', render: (r) => r.revision_reason ?? '—' }]} />
          </section>
          <Attachments subjectType="continuity_plan" subjectId={p.id} title="Plan files (site maps, recovery procedures, agreements)" />
        </>
      );
    }}</Async>
  );
}
