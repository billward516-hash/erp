import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtMoney } from '../format';
import { useAction, useApi } from '../hooks';

const tone = (s: string) => (s === 'awarded' ? 'good' : s === 'cancelled' ? 'neutral' : s === 'sent' ? 'info' : 'neutral');

/** The list of quote requests, shown on the Purchasing page (SC-005 A). */
export function RfqList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/api/rfqs');
  return (
    <section className="stack" aria-label="Quote requests">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>Ask several suppliers for a price on the same lines, compare their answers side by side and award. The award becomes a purchase request at the awarded prices.</p>
        {can('purchasing.manage') && <button className="primary" onClick={() => nav('/purchasing/rfq/new')}>New quote request</button>}
      </div>
      <Async loading={loading && !data} error={error}>{() => (
        <Table rows={data ?? []} rowKey={(r) => r.id} onRow={(r) => nav(`/purchasing/rfq/${r.id}`)} empty="No quote requests yet."
          columns={[{ key: 'number', label: 'Request' }, { key: 'title', label: 'Title' }, { key: 'facility_code', label: 'Site' },
            { key: 'status', label: 'Status', render: (r) => <Pill tone={r.overdue ? 'bad' : tone(r.status)} label={r.overdue ? 'Replies late' : r.status === 'sent' ? 'Out for quotes' : r.status[0].toUpperCase() + r.status.slice(1)} />, value: (r) => r.status },
            { key: 'answered', label: 'Replies', render: (r) => (r.status === 'draft' ? '—' : `${r.answered} of ${r.invited}`), value: (r) => r.answered },
            { key: 'respond_by', label: 'Reply by', render: (r) => (r.respond_by ? fmtDate(r.respond_by) : '—') }, { key: 'needed_by', label: 'Needed by', render: (r) => (r.needed_by ? fmtDate(r.needed_by) : '—') }]} />
      )}</Async>
    </section>
  );
}

export function NewRfq() {
  const nav = useNavigate();
  const { can } = useAuth();
  const facilities = useApi<any[]>('/api/facilities');
  const suppliers = useApi<any[]>('/api/suppliers');
  const parts = useApi<any[]>('/api/parts');
  const allowed = (facilities.data ?? []).filter((f) => can('purchasing.manage', f.id));
  const [f, setF] = useState({ facilityId: '', title: '', neededBy: '', respondBy: '', notes: '' });
  const [lines, setLines] = useState([{ partId: '', description: '', qty: '1', targetPrice: '' }]);
  const [chosen, setChosen] = useState<string[]>([]);
  const facilityId = f.facilityId || allowed[0]?.id || '';
  const act = useAction(async () => {
    const r = await api.post('/api/rfqs', { facilityId, title: f.title, neededBy: f.neededBy || null, respondBy: f.respondBy || null, notes: f.notes || null, supplierIds: chosen,
      lines: lines.map((l) => ({ partId: l.partId || null, description: l.partId ? null : l.description, qty: Number(l.qty), targetPrice: l.targetPrice ? Number(l.targetPrice) : null })) });
    nav(`/purchasing/rfq/${r.id}`);
  });
  const set = (i: number, k: string, v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <>
      <PageHead eyebrow="Purchasing" title="New quote request" sub="Saved as a draft. Choose the suppliers, set the date they must reply by, then send." />
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Site<select id="rfq-fac" value={facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>{allowed.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
            <label className="field">Title<input id="rfq-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={2} /></label>
            <label className="field">Suppliers reply by<input id="rfq-respond" type="date" value={f.respondBy} onChange={(e) => setF({ ...f, respondBy: e.target.value })} /></label>
            <label className="field">Goods needed by<input id="rfq-needed" type="date" value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} /></label>
          </div>
          <label className="field">Notes for the suppliers<textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <h3>Lines</h3>
          {lines.map((l, i) => (
            <div className="line-editor" key={i}>
              <select aria-label={`Line ${i + 1} part`} value={l.partId} onChange={(e) => set(i, 'partId', e.target.value)}><option value="">Not a catalog part (describe it)</option>
                {(parts.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.part_number} · {p.description}</option>)}</select>
              {!l.partId && <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => set(i, 'description', e.target.value)} placeholder="What to quote" />}
              <input aria-label={`Line ${i + 1} quantity`} type="number" min="0.001" step="any" value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} style={{ width: 90 }} />
              <input aria-label={`Line ${i + 1} target price`} type="number" min="0" step="any" value={l.targetPrice} onChange={(e) => set(i, 'targetPrice', e.target.value)} placeholder="Target price" style={{ width: 130 }} />
              <button type="button" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>
            </div>))}
          <div><button type="button" onClick={() => setLines([...lines, { partId: '', description: '', qty: '1', targetPrice: '' }])}>Add a line</button></div>
          <h3>Suppliers to ask</h3>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {(suppliers.data ?? []).filter((s) => s.active).map((s) => (
              <label key={s.id} className="row"><input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))} /> {s.name}</label>))}
          </div>
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy || !facilityId}>Save draft</button></div>
        </form>
      </section>
    </>
  );
}

export function RfqDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<any>(`/api/rfqs/${id}`);
  const [reply, setReply] = useState<string | null>(null);
  const act = useAction(async (what: string, body?: unknown) => { await api.post(`/api/rfqs/${id}/${what}`, body ?? {}); await reload(); });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pick, setPick] = useState<Record<string, string>>({});
  const { can } = useAuth();
  const award = useAction(async () => {
    await api.post(`/api/rfqs/${id}/award`, { awards: Object.entries(pick).map(([rfqLineId, inviteId]) => ({ rfqLineId, inviteId, reason: reasons[rfqLineId] || null })) });
    setPick({}); await reload(); // stay here: the new purchase request is a draft until it is submitted (below)
  });
  const submitReq = useAction(async (requestId: string) => { await api.post(`/api/purchase-requests/${requestId}/submit`, {}); await reload(); });
  return (
    <Async loading={loading && !data} error={error}>{() => {
      const g = data;
      const sent = g.status === 'sent';
      return (
        <>
          <PageHead eyebrow={`${g.facility_code} · Quote request`} title={<>{g.number} <span className="muted" style={{ fontWeight: 400 }}>{g.title}</span></>}
            actions={<>
              <button onClick={() => void api.open(`/api/rfqs/${id}/pdf`)}>Request letter (PDF)</button>
              {g.canManage && g.status === 'draft' && <button className="primary" disabled={act.busy} onClick={() => act.run('send')}>Mark as sent</button>}
              {g.canManage && ['draft', 'sent'].includes(g.status) && <button className="link" onClick={() => { const r = window.prompt('Why is this cancelled?'); if (r) void act.run('cancel', { reason: r }); }}>Cancel</button>}
            </>} />
          <p className="answer">{g.answer}</p>
          <ErrorNote message={act.error} />
          <Kpis items={[{ label: 'Reply by', value: g.respond_by ? fmtDate(g.respond_by) : '—', tone: g.overdue ? 'bad' : undefined }, { label: 'Needed by', value: g.needed_by ? fmtDate(g.needed_by) : '—' },
            { label: 'Suppliers asked', value: g.invites.length }, { label: 'Replies', value: g.invites.filter((i: any) => i.status !== 'invited').length }]} />
          <section className="card stack" aria-label="Suppliers">
            <h2>Suppliers</h2>
            <Table rows={g.invites} rowKey={(i) => i.id} tools={false} columns={[{ key: 'supplier_name', label: 'Supplier' },
              { key: 'status', label: 'Status', render: (i: any) => <Pill tone={i.status === 'responded' ? 'good' : i.status === 'declined' ? 'neutral' : 'watch'} label={i.status === 'responded' ? 'Replied' : i.status === 'declined' ? `Declined${i.decline_reason ? `: ${i.decline_reason}` : ''}` : 'Waiting'} /> },
              { key: 'x', label: '', render: (i: any) => (sent && g.canManage ? <button onClick={() => setReply(reply === i.id ? null : i.id)}>{i.status === 'invited' ? 'Enter their reply' : 'Change reply'}</button> : null) }]} />
            {reply && <ReplyForm g={g} invite={g.invites.find((i: any) => i.id === reply)} onDone={async () => { setReply(null); await reload(); }} />}
          </section>
          {g.invites.some((i: any) => i.status === 'responded') && (
            <section className="card stack" aria-label="Comparison">
              <h2>Comparison</h2>
              <div className="table-wrap"><table>
                <thead><tr><th scope="col">Line</th><th scope="col" className="n">Qty</th>{g.invites.map((i: any) => <th key={i.id} scope="col" className="n">{i.supplier_name}</th>)}{sent && g.canManage && <th scope="col">Award to</th>}</tr></thead>
                <tbody>
                  {g.lines.map((l: any) => {
                    const c = g.cells.find((x: any) => x.lineId === l.id);
                    const chosen = pick[l.id]; const chosenOffer = c.offers.find((o: any) => o.inviteId === chosen);
                    const notLowest = chosenOffer && chosenOffer.unitPrice > c.lowest + 1e-9;
                    return (
                      <tr key={l.id}>
                        <td>{l.description}{l.target_price != null && <span className="faint"> (target {fmtMoney(l.target_price)})</span>}</td><td className="n">{Number(l.qty)}</td>
                        {c.offers.map((o: any) => (
                          <td key={o.inviteId} className="n" style={o.isLowest ? { fontWeight: 700 } : undefined}>
                            {o.unitPrice == null ? <span className="faint">—</span> : <>{fmtMoney(o.unitPrice)}{o.isLowest && <span className="faint"> lowest</span>}<br /><span className="faint">{o.leadTimeDays != null ? `${o.leadTimeDays} d` : ''}{o.isFastest ? ' fastest' : ''}{o.minQty != null ? ` · min ${o.minQty}` : ''}{o.belowMin ? ' (below minimum)' : ''}{o.expired ? ' · price expired' : ''}</span></>}
                          </td>))}
                        {sent && g.canManage && (
                          <td>{l.awarded_invite_id ? <Pill tone="good" label="Awarded" /> : (
                            <div className="stack" style={{ gap: 4 }}>
                              <select aria-label={`Award line ${l.line_no} to`} value={chosen ?? ''} onChange={(e) => setPick({ ...pick, [l.id]: e.target.value })}>
                                <option value="">Not yet</option>{c.offers.filter((o: any) => o.unitPrice != null).map((o: any) => <option key={o.inviteId} value={o.inviteId}>{g.invites.find((i: any) => i.id === o.inviteId).supplier_name}</option>)}</select>
                              {notLowest && <input aria-label={`Why line ${l.line_no} is not the lowest price`} placeholder="Why not the lowest price?" value={reasons[l.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [l.id]: e.target.value })} />}
                            </div>)}</td>)}
                      </tr>);
                  })}
                  <tr><th scope="row" colSpan={2}>Goods</th>{g.totals.map((t: any) => <td key={t.inviteId} className="n">{t.quotedLines ? fmtMoney(t.goods) : '—'}</td>)}{sent && g.canManage && <td />}</tr>
                  <tr><th scope="row" colSpan={2}>Freight</th>{g.totals.map((t: any) => <td key={t.inviteId} className="n">{t.quotedLines ? fmtMoney(t.freight) : '—'}</td>)}{sent && g.canManage && <td />}</tr>
                  <tr><th scope="row" colSpan={2}>Landed total</th>{g.totals.map((t: any) => <td key={t.inviteId} className="n" style={t.best ? { fontWeight: 700 } : undefined}>{t.quotedLines ? <>{fmtMoney(t.landed)}{t.best && <span className="faint"> best</span>}{!t.allLines && <div className="faint">not every line</div>}</> : '—'}</td>)}{sent && g.canManage && <td />}</tr>
                  <tr><th scope="row" colSpan={2}>Slowest line</th>{g.totals.map((t: any) => <td key={t.inviteId} className="n">{t.slowest != null ? `${t.slowest} d` : '—'}</td>)}{sent && g.canManage && <td />}</tr>
                </tbody></table></div>
              <ErrorNote message={award.error} />
              {sent && g.canManage && <div><button className="primary" disabled={award.busy || !Object.values(pick).some(Boolean)} onClick={() => { for (const k of Object.keys(pick)) if (!pick[k]) delete pick[k]; void award.run(); }}>Award the chosen lines</button>
                <span className="muted"> Creates a purchase request at those prices; it goes to approval as usual.</span></div>}
              {g.award_request_number && (
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span>Awarded on <Link to={`/purchasing/requests/${g.award_request_id}`}>{g.award_request_number}</Link> <Pill value={g.award_request_status} />.</span>
                  {g.award_request_status === 'draft' && can('purchasing.request', g.facility_id) && <button className="primary" disabled={submitReq.busy} onClick={() => submitReq.run(g.award_request_id)}>Submit for approval</button>}
                  {g.award_request_status === 'draft' && <span className="muted">The award is a draft purchase request until it is submitted; nothing is ordered before it is approved.</span>}
                  <ErrorNote message={submitReq.error} />
                </div>)}
            </section>)}
        </>
      );
    }}</Async>
  );
}

function ReplyForm({ g, invite, onDone }: { g: any; invite: any; onDone: () => Promise<void> }) {
  const had = (lineId: string) => g.cells.find((c: any) => c.lineId === lineId)?.offers.find((o: any) => o.inviteId === invite.id);
  const [rows, setRows] = useState<Record<string, { price: string; lead: string; min: string; valid: string }>>(Object.fromEntries(g.lines.map((l: any) => { const o = had(l.id); return [l.id, { price: o?.unitPrice != null ? String(o.unitPrice) : '', lead: o?.leadTimeDays != null ? String(o.leadTimeDays) : '', min: o?.minQty != null ? String(o.minQty) : '', valid: o?.validUntil ? String(o.validUntil).slice(0, 10) : '' }]; })));
  const [freight, setFreight] = useState(String(Number(invite.freight ?? 0) || ''));
  const [terms, setTerms] = useState(invite.payment_terms ?? '');
  const save = useAction(async () => {
    await api.post(`/api/rfqs/${g.id}/invites/${invite.id}/response`, { freight: freight ? Number(freight) : 0, paymentTerms: terms || null,
      lines: g.lines.filter((l: any) => rows[l.id]!.price !== '').map((l: any) => ({ rfqLineId: l.id, unitPrice: Number(rows[l.id]!.price), leadTimeDays: rows[l.id]!.lead ? Number(rows[l.id]!.lead) : null, minQty: rows[l.id]!.min ? Number(rows[l.id]!.min) : null, validUntil: rows[l.id]!.valid || null })) });
    await onDone();
  });
  const decline = useAction(async () => { const r = window.prompt('Why did they decline? (optional)') ?? ''; await api.post(`/api/rfqs/${g.id}/invites/${invite.id}/response`, { declined: true, declineReason: r || null }); await onDone(); });
  const set = (id: string, k: string, v: string) => setRows({ ...rows, [id]: { ...rows[id]!, [k]: v } });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} aria-label={`Reply from ${invite.supplier_name}`}>
      <strong>{invite.supplier_name}'s reply</strong>
      {g.lines.map((l: any) => (
        <div key={l.id} className="row" style={{ flexWrap: 'wrap' }}>
          <span style={{ minWidth: 220 }}>{l.description} × {Number(l.qty)}</span>
          <input aria-label={`Price for line ${l.line_no}`} type="number" min="0" step="any" placeholder="Unit price" value={rows[l.id]!.price} onChange={(e) => set(l.id, 'price', e.target.value)} style={{ width: 110 }} />
          <input aria-label={`Lead time days for line ${l.line_no}`} type="number" min="0" placeholder="Days" value={rows[l.id]!.lead} onChange={(e) => set(l.id, 'lead', e.target.value)} style={{ width: 80 }} />
          <input aria-label={`Minimum quantity for line ${l.line_no}`} type="number" min="0" step="any" placeholder="Min qty" value={rows[l.id]!.min} onChange={(e) => set(l.id, 'min', e.target.value)} style={{ width: 90 }} />
          <input aria-label={`Price valid until for line ${l.line_no}`} type="date" value={rows[l.id]!.valid} onChange={(e) => set(l.id, 'valid', e.target.value)} />
        </div>))}
      <div className="row"><input aria-label="Freight to us" type="number" min="0" step="any" placeholder="Freight" value={freight} onChange={(e) => setFreight(e.target.value)} style={{ width: 110 }} />
        <input aria-label="Payment terms" placeholder="Payment terms" value={terms} onChange={(e) => setTerms(e.target.value)} /></div>
      <ErrorNote message={save.error ?? decline.error} />
      <div className="row"><button className="primary" disabled={save.busy}>Save the reply</button><button type="button" disabled={decline.busy} onClick={() => decline.run()}>They declined</button></div>
    </form>
  );
}
