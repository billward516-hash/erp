import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Attachments, RFQ_ACCEPT } from '../components/Attachments';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate } from '../format';
import { useAction, useApi } from '../hooks';

const KINDS: [string, string][] = [['ecn', 'Engineering change notice'], ['pcn', 'Product change notice'], ['supplier_change', 'Supplier change'], ['deviation', 'Deviation'], ['waiver', 'Waiver'], ['bulletin', 'Bulletin'], ['other', 'Other notice']];
const kindLabel = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;
const TONE: Record<string, 'good' | 'watch' | 'bad' | 'info' | 'neutral'> = { draft: 'neutral', issued: 'info', closed: 'good', cancelled: 'neutral' };

/** The notices tab on the Changes page (SC-006 B). */
export function NoticeList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [mine, setMine] = useState(false);
  const { data, loading, error } = useApi<any[]>(`/api/change-notices${mine ? '?mine=true' : ''}`);
  const open = (data ?? []).filter((n) => n.status === 'issued');
  return (
    <section className="stack" aria-label="Change notices">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>Engineering change notices and similar notifications. Each lists who must be told and tracks who has acknowledged.</p>
        {can('moc.manage') && <button className="primary" onClick={() => nav('/changes/notices/new')}>New notice</button>}
      </div>
      <Kpis items={[{ label: 'Issued and open', value: open.length }, { label: 'Waiting for acknowledgements', value: open.filter((n) => n.outstanding > 0).length, tone: open.some((n) => n.overdue) ? 'bad' : undefined },
        { label: 'Past the acknowledgement date', value: open.filter((n) => n.overdue).length, tone: open.some((n) => n.overdue) ? 'bad' : 'good' }]} />
      <label className="row"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only notices I still need to acknowledge</label>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(n) => n.id} onRow={(n) => nav(`/changes/notices/${n.id}`)} exception={(n) => n.overdue} empty="No change notices yet."
          columns={[{ key: 'number', label: 'Notice', render: (n) => <strong>{n.number}</strong> }, { key: 'kind', label: 'Kind', render: (n) => kindLabel(n.kind), value: (n) => kindLabel(n.kind) }, { key: 'title', label: 'Title' },
            { key: 'effective_on', label: 'Effective', render: (n) => (n.effective_on ? fmtDate(n.effective_on) : '—') },
            { key: 'status', label: 'Status', render: (n) => <><Pill tone={TONE[n.status]} label={n.status} />{n.overdue && <> <Pill tone="bad" label="Acknowledgements late" /></>}</>, value: (n) => n.status },
            { key: 'acknowledged', label: 'Acknowledged', render: (n) => (n.status === 'draft' ? '—' : `${n.acknowledged} of ${n.acknowledged + n.outstanding}`), value: (n) => n.acknowledged },
            { key: 'ack_due_on', label: 'Acknowledge by', render: (n) => (n.ack_due_on ? fmtDate(n.ack_due_on) : '—') }, { key: 'owner_name', label: 'Owner' }]} />
      )}</Async>
    </section>
  );
}

export function NewNotice() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const facilities = useApi<any[]>('/api/facilities');
  const people = useApi<any[]>('/api/users');
  const customers = useApi<any[]>('/api/customers');
  const suppliers = useApi<any[]>('/api/suppliers');
  const allowed = (facilities.data ?? []).filter((f) => can('moc.manage', f.id));
  const [f, setF] = useState({ facilityId: '', kind: params.get('kind') ?? 'ecn', title: '', summary: '', whatChanged: '', effectiveOn: '', ackDueOn: '' });
  const [users, setUsers] = useState<string[]>([]); const [custs, setCusts] = useState<string[]>([]); const [sups, setSups] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const facilityId = f.facilityId || allowed[0]?.id || '';
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const act = useAction(async () => {
    const recipients = [...users.map((userId) => ({ partyType: 'user', userId })), ...custs.map((customerId) => ({ partyType: 'customer', customerId })), ...sups.map((supplierId) => ({ partyType: 'supplier', supplierId })),
      ...other.split('\n').map((x) => x.trim()).filter(Boolean).map((name) => ({ partyType: 'other', name }))];
    const n = await api.post('/api/change-notices', { facilityId, kind: f.kind, title: f.title, summary: f.summary, whatChanged: f.whatChanged || null, effectiveOn: f.effectiveOn || null, ackDueOn: f.ackDueOn || null,
      changeId: params.get('change'), recipients });
    nav(`/changes/notices/${n.id}`);
  });
  const Pick = ({ legend, rows, label, chosen, set }: { legend: string; rows: any[]; label: (r: any) => string; chosen: string[]; set: (v: string[]) => void }) => (
    <fieldset className="stack"><legend>{legend}</legend><div className="row" style={{ flexWrap: 'wrap' }}>{rows.map((r) => <label key={r.id} className="row"><input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(chosen, set, r.id)} />{label(r)}</label>)}</div></fieldset>
  );
  return (
    <>
      <PageHead eyebrow="Management of change" title="New change notice" sub="Saved as a draft. Choose who must be told, then issue it." />
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Kind<select id="cn-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="field">Site<select id="cn-fac" value={facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>{allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
            <label className="field">Effective on<input id="cn-eff" type="date" value={f.effectiveOn} onChange={(e) => setF({ ...f, effectiveOn: e.target.value })} /></label>
            <label className="field">Acknowledge by<input id="cn-ack" type="date" value={f.ackDueOn} onChange={(e) => setF({ ...f, ackDueOn: e.target.value })} /></label>
          </div>
          <label className="field">Title<input id="cn-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /></label>
          <label className="field">Summary<textarea id="cn-summary" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} required /></label>
          <label className="field">What is changing (from, to, drawings affected)<textarea id="cn-what" value={f.whatChanged} onChange={(e) => setF({ ...f, whatChanged: e.target.value })} /></label>
          <Pick legend="Colleagues to notify" rows={people.data ?? []} label={(u) => u.display_name} chosen={users} set={setUsers} />
          <Pick legend="Customers to notify" rows={customers.data ?? []} label={(c) => c.name} chosen={custs} set={setCusts} />
          <Pick legend="Suppliers to notify" rows={suppliers.data ?? []} label={(s) => s.name} chosen={sups} set={setSups} />
          <label className="field">Others (one per line)<textarea id="cn-other" value={other} onChange={(e) => setOther(e.target.value)} /></label>
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy}>Save draft</button></div>
        </form>
      </section>
    </>
  );
}

export function NoticeDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: n, loading, error, reload } = useApi<any>(`/api/change-notices/${id}`);
  const [note, setNote] = useState('');
  const [who, setWho] = useState<Record<string, { by: string; method: string; note: string }>>({});
  const issue = useAction(async () => { await api.post(`/api/change-notices/${id}/issue`); await reload(); });
  const close = useAction(async () => { await api.post(`/api/change-notices/${id}/close`, { note: note || null }); setNote(''); await reload(); });
  const cancel = useAction(async () => { await api.post(`/api/change-notices/${id}/cancel`, { reason: note }); setNote(''); await reload(); });
  const sent = useAction(async (rid: string) => { await api.post(`/api/change-notices/${id}/recipients/${rid}/sent`, {}); await reload(); });
  const ack = useAction(async (rid: string, own: boolean) => { const w = who[rid]; await api.post(`/api/change-notices/${id}/recipients/${rid}/acknowledge`, own ? {} : { byName: w?.by, method: w?.method ?? 'email', note: w?.note || null }); await reload(); });
  return (
    <Async loading={loading && !n} error={error}>{() => {
      const manage = can('moc.manage', n.facility_id);
      const err = issue.error ?? close.error ?? cancel.error ?? sent.error ?? ack.error;
      return (
        <>
          <PageHead eyebrow={`${n.kindLabel} · ${n.facility_code}`} title={`${n.number} · ${n.title}`} sub={<><Pill tone={TONE[n.status]} label={n.status} />{n.overdue && <> <Pill tone="bad" label="Acknowledgements late" /></>} · owner {n.owner_name}{n.change_number ? ` · change ${n.change_number}` : ''}</>}
            actions={<button onClick={() => api.open(`/api/change-notices/${id}/pdf`)}>PDF to send</button>} />
          <Kpis items={[{ label: 'Effective', value: n.effective_on ? fmtDate(n.effective_on) : '—' }, { label: 'Acknowledge by', value: n.ack_due_on ? fmtDate(n.ack_due_on) : '—', tone: n.overdue ? 'bad' : undefined },
            { label: 'Acknowledged', value: `${n.acknowledged} of ${n.acknowledged + n.outstanding}`, tone: n.outstanding === 0 && n.status !== 'draft' ? 'good' : undefined }]} />
          <section className="card stack"><h2>Summary</h2><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.summary}</p>{n.what_changed && <><h3>What is changing</h3><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.what_changed}</p></>}
            {n.close_note && <p className="muted">Closed: {n.close_note}</p>}</section>
          <section className="card stack">
            <h2>Distribution and acknowledgement</h2>
            <Table tools={false} rows={n.recipientList} rowKey={(r) => r.id} empty="Nobody listed."
              columns={[{ key: 'name', label: 'Recipient' }, { key: 'party_type', label: 'Who', render: (r) => (r.party_type === 'user' ? 'Colleague' : r.party_type) },
                { key: 'sent_on', label: 'Sent', render: (r) => (r.sent_on ? fmtDate(r.sent_on) : n.status === 'draft' ? '—' : (manage && n.status === 'issued' ? <button onClick={() => sent.run(r.id)}>Mark sent</button> : 'Not yet')), value: (r) => r.sent_on },
                { key: 'ack_on', label: 'Acknowledged', render: (r) => (r.ack_on ? `${fmtDate(r.ack_on)} by ${r.ack_by_name} (${r.ack_method?.replace('_', ' ')})` : r.requires_ack ? <Pill tone={r.overdue ? 'bad' : 'watch'} label={r.overdue ? 'Late' : 'Waiting'} /> : 'Not required'), value: (r) => r.ack_on },
                { key: 'do', label: '', plain: true, render: (r) => {
                  if (n.status !== 'issued' || r.ack_on || !r.requires_ack) return null;
                  if (r.user_id && n.mineToAcknowledge === r.id) return <button className="primary" onClick={() => ack.run(r.id, true)}>I have read this</button>;
                  if (!manage) return null;
                  const w = who[r.id] ?? { by: '', method: 'email', note: '' };
                  return (<span className="row"><input aria-label={`Who at ${r.name} confirmed`} placeholder="Who confirmed" value={w.by} onChange={(e) => setWho({ ...who, [r.id]: { ...w, by: e.target.value } })} />
                    <select aria-label={`How ${r.name} confirmed`} value={w.method} onChange={(e) => setWho({ ...who, [r.id]: { ...w, method: e.target.value } })}><option value="email">Email</option><option value="phone">Phone</option><option value="signed">Signed</option><option value="other">Other</option></select>
                    <button disabled={!w.by.trim()} onClick={() => ack.run(r.id, false)}>Record</button></span>);
                } }]} />
          </section>
          {manage && ['draft', 'issued'].includes(n.status) && (
            <section className="card stack">
              <h2>Next step</h2>
              {n.status === 'draft' && <div><button className="primary" disabled={issue.busy} onClick={() => issue.run()}>Issue the notice</button> <span className="muted">Colleagues are notified now; for outside parties, download the PDF, send it, then mark each one sent.</span></div>}
              <div className="row"><input id="cn-note" aria-label="Note" placeholder={n.status === 'issued' ? 'Closing note (needed while acknowledgements are outstanding)' : 'Reason for cancelling'} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 320px' }} />
                {n.status === 'issued' && <button disabled={close.busy} onClick={() => close.run()}>Close notice</button>}
                <button className="danger" disabled={cancel.busy || note.trim().length < 3} onClick={() => cancel.run()}>Cancel notice</button></div>
            </section>
          )}
          <ErrorNote message={err} />
          <Attachments subjectType="change_notice" subjectId={n.id} title="Files (drawings, marked-up documents, replies)" accept={RFQ_ACCEPT} />
        </>
      );
    }}</Async>
  );
}
