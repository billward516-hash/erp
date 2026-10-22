import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';
import { ActionList, MyActions } from './Quality';
import { Attachments } from '../components/Attachments';

const KIND: Record<string, string> = { near_miss: 'Near miss', first_aid: 'First aid', injury: 'Injury', illness: 'Illness', property_damage: 'Property damage', environmental: 'Environmental' };
const STATUS_TONE: Record<string, 'good' | 'watch' | 'bad' | 'info' | 'neutral'> = { reported: 'bad', investigating: 'watch', actions: 'info', closed: 'good' };
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function Safety() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const tab = params.get('tab') ?? (can('safety.view') ? 'incidents' : 'report');
  const tabs = [['report', 'Report something'], ['incidents', can('safety.view') ? 'Incidents' : 'My reports'], ['actions', 'My actions']] as const;
  return (
    <>
      <PageHead eyebrow="Safety" title="Safety"
        sub="Report near misses and incidents as soon as they happen; near misses are how problems get fixed before someone is hurt. Details about injured people are seen only by the safety team." />
      <div className="row" role="tablist" aria-label="Safety">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'report' && <ReportForm />}
      {tab === 'incidents' && <IncidentList />}
      {tab === 'actions' && <MyActions />}
    </>
  );
}

function ReportForm() {
  const nav = useNavigate();
  const { me } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const [f, setF] = useState({ facilityId: '', kind: 'near_miss', occurredAt: localNow(), location: '', assetId: '', description: '', immediateActions: '' });
  const assets = useApi<any[]>(f.facilityId ? `/api/assets?facilityId=${f.facilityId}&topLevel=true&limit=300` : null);
  const facilityId = f.facilityId || (facilities.data?.length === 1 ? facilities.data[0].id : '');
  const save = useAction(async () => {
    const r = await api.post('/api/incidents', { ...f, facilityId, occurredAt: new Date(f.occurredAt).toISOString(), assetId: f.assetId || null, location: f.location || null, immediateActions: f.immediateActions || null });
    nav(`/safety/${r.id}`);
  });
  return (
    <section className="card stack">
      <h2>What happened?</h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="row" role="radiogroup" aria-label="Kind">
          {Object.entries(KIND).map(([k, l]) => (
            <label key={k} className="row"><input type="radio" name="kind" value={k} checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} />{l}</label>
          ))}
        </div>
        <div className="row">
          {(facilities.data?.length ?? 0) > 1 && (
            <select id="inc-facility" aria-label="Site" value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, assetId: '' })} required>
              <option value="">Site…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
            </select>
          )}
          <label className="row">When<input id="inc-when" type="datetime-local" value={f.occurredAt} onChange={(e) => setF({ ...f, occurredAt: e.target.value })} required /></label>
          <input id="inc-location" aria-label="Where" placeholder="Where (area, line, dock…)" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} style={{ flex: '1 1 200px' }} />
          {(assets.data?.length ?? 0) > 0 && (
            <select id="inc-asset" aria-label="Equipment" value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })}>
              <option value="">Equipment (if any)…</option>{(assets.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.asset_tag} · {a.name}</option>)}
            </select>
          )}
        </div>
        <label className="field">What happened (facts, not blame)<textarea id="inc-description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /></label>
        <label className="field">What was done right away (optional)<textarea id="inc-immediate" rows={2} value={f.immediateActions} onChange={(e) => setF({ ...f, immediateActions: e.target.value })} /></label>
        {['injury', 'illness', 'first_aid'].includes(f.kind) && <p className="faint">The safety team records who was involved and the details of any injury; they are not shown to others.</p>}
        <div className="row"><button className="primary" disabled={save.busy || !facilityId}>Send report</button><span className="faint">Reported as {me?.displayName}.</span></div>
        <ErrorNote message={save.error} />
      </form>
    </section>
  );
}

function IncidentList() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const { data, loading, error } = useApi<any[]>(open ? '/api/incidents?open=true' : '/api/incidents');
  const rows = data ?? [];
  return (
    <>
      <Kpis items={[
        { label: 'Not yet classified', value: rows.filter((r) => r.status === 'reported').length, tone: rows.some((r) => r.status === 'reported') ? 'bad' : 'good' },
        { label: 'Open', value: rows.filter((r) => r.status !== 'closed').length },
        { label: 'Near misses', value: rows.filter((r) => r.kind === 'near_miss').length },
      ]} />
      <div className="card stack">
        <label className="row"><input id="inc-open" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only open</label>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(r) => nav(`/safety/${r.id}`)} exception={(r) => r.status === 'reported'} empty="No reports."
            columns={[{ key: 'number', label: 'Report', render: (r) => <strong>{r.number}</strong> }, { key: 'facility_code', label: 'Site' },
              { key: 'occurred_at', label: 'When', render: (r) => fmtDateTime(r.occurred_at) }, { key: 'kind', label: 'Kind', render: (r) => KIND[r.kind] },
              { key: 'location', label: 'Where' }, { key: 'asset_tag', label: 'Equipment' }, { key: 'severity', label: 'Severity', render: (r) => humanize(r.severity) },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={STATUS_TONE[r.status]} label={humanize(r.status)} /> }, { key: 'open_actions', label: 'Open actions', numeric: true }]} />
        )}</Async>
      </div>
    </>
  );
}

export function IncidentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: i, loading, error, reload } = useApi<any>(`/api/incidents/${id}`);
  const [c, setC] = useState<any>(null);
  const [inv, setInv] = useState<{ rootCause: string; contributingFactors: string } | null>(null);
  const classify = useAction(async () => {
    await api.post(`/api/incidents/${id}/classify`, { severity: c.severity, kind: c.kind, involvedEmployeeId: c.involvedEmployeeId || null, injuryDescription: c.injuryDescription || null,
      medicalTreatment: c.medicalTreatment === '' ? null : c.medicalTreatment === 'yes', daysAway: c.daysAway === '' ? null : Number(c.daysAway), daysRestricted: c.daysRestricted === '' ? null : Number(c.daysRestricted),
      recordable: c.recordable === '' ? null : c.recordable === 'yes' });
    setC(null); await reload();
  });
  const investigate = useAction(async () => { await api.post(`/api/incidents/${id}/investigate`, inv); setInv(null); await reload(); });
  const close = useAction(async () => { await api.post(`/api/incidents/${id}/close`, {}); await reload(); });
  const yn = (b: boolean | null | undefined) => (b == null ? '' : b ? 'yes' : 'no');
  return (
    <Async loading={loading && !i} error={error}>{() => {
      const open = i.status !== 'closed';
      const startClassify = () => setC({ severity: i.severity ?? 'low', kind: i.kind, involvedEmployeeId: i.involved_employee_id ?? '', injuryDescription: i.injury_description ?? '',
        medicalTreatment: yn(i.medical_treatment), daysAway: i.days_away ?? '', daysRestricted: i.days_restricted ?? '', recordable: yn(i.recordable) });
      return (
        <>
          <PageHead eyebrow={`${i.facility_code} · ${KIND[i.kind]}`} title={<>{i.number} <span className="muted" style={{ fontWeight: 400 }}>{i.location ?? ''}</span></>}
            sub={<>Occurred {fmtDateTime(i.occurred_at)} · reported by {i.reported_by_name}{i.asset_tag && <> · <Link to={`/assets/${i.asset_id}`}>{i.asset_tag}</Link></>}</>}
            actions={<>{i.severity && <Pill tone={i.severity === 'serious' || i.severity === 'high' ? 'bad' : 'watch'} label={humanize(i.severity)} />} <Pill tone={STATUS_TONE[i.status]} label={humanize(i.status)} /></>} />
          <section className="card stack">
            <h2>What happened</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{i.description}</p>
            {i.immediate_actions && <p><strong>Done right away:</strong> {i.immediate_actions}</p>}
          </section>
          <section className="card stack">
            <div className="spread"><h2>Classification</h2>{i.canManage && open && !c && <button onClick={startClassify}>{i.severity ? 'Edit' : 'Classify'}</button>}</div>
            {i.restricted ? <p className="muted">Details about the people involved are visible to the safety team only.</p> : (
              <dl className="facts">
                <dt>Person involved</dt><dd>{i.involved_name ?? '—'}</dd>
                <dt>Injury</dt><dd>{i.injury_description ?? '—'}</dd>
                <dt>Treatment beyond first aid</dt><dd>{i.medical_treatment == null ? '—' : i.medical_treatment ? 'Yes' : 'No'}</dd>
                <dt>Days away / restricted</dt><dd>{i.days_away ?? '—'} / {i.days_restricted ?? '—'}</dd>
                <dt>Recordable</dt><dd>{i.recordable == null ? <Pill tone="watch" label="Not decided" /> : i.recordable ? 'Yes' : 'No'}</dd>
              </dl>
            )}
            {c && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void classify.run(); }}>
                <div className="row">
                  <select id="cls-severity" aria-label="Severity" value={c.severity} onChange={(e) => setC({ ...c, severity: e.target.value })}>{['low', 'medium', 'high', 'serious'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
                  <select id="cls-kind" aria-label="Kind" value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  <select id="cls-person" aria-label="Person involved" value={c.involvedEmployeeId} onChange={(e) => setC({ ...c, involvedEmployeeId: e.target.value })}>
                    <option value="">Person involved (none)</option>{i.employees.map((e: any) => <option key={e.id} value={e.id}>{e.name} ({e.employee_number})</option>)}
                  </select>
                </div>
                <input id="cls-injury" aria-label="Injury" placeholder="Injury or illness (nature, body part)" value={c.injuryDescription} onChange={(e) => setC({ ...c, injuryDescription: e.target.value })} />
                <div className="row">
                  <label className="row">Treatment beyond first aid<select id="cls-medical" value={c.medicalTreatment} onChange={(e) => setC({ ...c, medicalTreatment: e.target.value })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>
                  <label className="row">Days away<input id="cls-away" type="number" min="0" value={c.daysAway} onChange={(e) => setC({ ...c, daysAway: e.target.value })} style={{ width: 70 }} /></label>
                  <label className="row">Days restricted<input id="cls-restricted" type="number" min="0" value={c.daysRestricted} onChange={(e) => setC({ ...c, daysRestricted: e.target.value })} style={{ width: 70 }} /></label>
                  <label className="row">Recordable<select id="cls-recordable" value={c.recordable} onChange={(e) => setC({ ...c, recordable: e.target.value })}><option value="">Not decided</option><option value="yes">Yes</option><option value="no">No</option></select></label>
                </div>
                <div className="row"><button className="primary" disabled={classify.busy}>Save classification</button><button type="button" onClick={() => setC(null)}>Cancel</button></div>
                <ErrorNote message={classify.error} />
              </form>
            )}
          </section>
          <section className="card stack">
            <div className="spread"><h2>Investigation</h2>{i.canManage && open && !inv && i.severity && <button onClick={() => setInv({ rootCause: i.root_cause ?? '', contributingFactors: i.contributing_factors ?? '' })}>{i.root_cause ? 'Edit' : 'Record root cause'}</button>}</div>
            {i.root_cause ? <><p><strong>Root cause:</strong> {i.root_cause}</p>{i.contributing_factors && <p><strong>Contributing factors:</strong> {i.contributing_factors}</p>}</> : <p className="muted">Not investigated yet.</p>}
            {inv && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void investigate.run(); }}>
                <label className="field">Root cause<textarea id="inv-root" value={inv.rootCause} onChange={(e) => setInv({ ...inv, rootCause: e.target.value })} required /></label>
                <label className="field">Contributing factors<textarea id="inv-factors" rows={2} value={inv.contributingFactors} onChange={(e) => setInv({ ...inv, contributingFactors: e.target.value })} /></label>
                <div className="row"><button className="primary" disabled={investigate.busy}>Save</button><button type="button" onClick={() => setInv(null)}>Cancel</button></div>
                <ErrorNote message={investigate.error} />
              </form>
            )}
            {i.capa_number ? <p>Corrective action: <Link to={`/quality/capa/${i.capa_id}`}>{i.capa_number}</Link></p>
              : i.canManage && open && <div><button onClick={() => nav(`/quality/capa/new?incident=${i.id}&facility=${i.facility_id}`)}>Open a corrective action</button></div>}
          </section>
          <ActionList subjectType="safety_incident" subjectId={i.id} facilityId={i.facility_id} actions={i.actions} canPlan={i.canManage} open={open} onChange={reload} />
          <Attachments subjectType="safety_incident" subjectId={i.id} title="Photos and files" restrictable />
          {i.canManage && open && <div className="row"><button className="primary" onClick={() => close.run()} disabled={close.busy}>Close incident</button><ErrorNote message={close.error} /></div>}
          {!can('safety.view') && <p className="faint">Thank you for reporting. The safety team will follow up.</p>}
        </>
      );
    }}</Async>
  );
}
