import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const STATUS: Record<string, { label: string; tone: 'good' | 'watch' | 'bad' | 'info' | 'neutral' }> = {
  captured: { label: 'Waiting for approval', tone: 'info' }, approved: { label: 'Approved', tone: 'watch' }, exported: { label: 'In accounting', tone: 'good' },
  paid: { label: 'Paid', tone: 'good' }, disputed: { label: 'Disputed', tone: 'bad' }, void: { label: 'Void', tone: 'neutral' },
};
export const InvoiceStatus = ({ v }: { v: string }) => <Pill tone={STATUS[v]?.tone} label={STATUS[v]?.label ?? v} />;
const ACCOUNT_LABEL: Record<string, string> = { inventory: 'Inventory', maintenance_expense: 'Repairs & maintenance', supplies_expense: 'Supplies', utilities_expense: 'Utilities',
  contract_services: 'Contract and professional services', telecom_expense: 'Phone and internet', travel_expense: 'Travel', other_expense: 'Other expenses', capital_projects: 'Capital', freight: 'Freight', sales_tax: 'Sales tax' };

export function Payables() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [open, setOpen] = useState(true);
  const { data, loading, error } = useApi<any[]>(open ? '/api/supplier-invoices?open=true' : '/api/supplier-invoices');
  const rows = data ?? [];
  const unpaid = rows.filter((r) => !['paid', 'void'].includes(r.status));
  return (
    <>
      <PageHead eyebrow="Accounts payable" title="Supplier invoices"
        sub="Capture invoices, compare them with the order and what was received, and approve them for payment. Approved invoices go to your accounting system, which pays them."
        actions={can('ap.manage') ? <button className="primary" onClick={() => nav('/ap/new')}>Capture invoice</button> : undefined} />
      <Kpis items={[
        { label: 'Open payables', value: fmtMoney(unpaid.reduce((s, r) => s + r.total, 0)) },
        { label: 'Overdue', value: fmtMoney(unpaid.filter((r) => r.overdue).reduce((s, r) => s + r.total, 0)), tone: unpaid.some((r) => r.overdue) ? 'bad' : 'good' },
        { label: 'Waiting for approval', value: unpaid.filter((r) => r.status === 'captured').length, tone: unpaid.some((r) => r.status === 'captured') ? 'watch' : 'good' },
        { label: 'Disputed', value: unpaid.filter((r) => r.status === 'disputed').length },
      ]} />
      <div className="card stack">
        <label className="row"><input id="ap-open" type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only unpaid</label>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} onRow={(r) => nav(`/ap/${r.id}`)} exception={(r) => r.overdue} empty="No supplier invoices."
            columns={[{ key: 'supplier_name', label: 'Supplier' }, { key: 'invoice_number', label: 'Invoice', render: (r) => <strong>{r.invoice_number}</strong> },
              { key: 'facility_code', label: 'Site' }, { key: 'po_number', label: 'PO' }, { key: 'invoice_date', label: 'Dated', render: (r) => fmtDate(r.invoice_date) },
              { key: 'due_date', label: 'Due', render: (r) => <>{fmtDate(r.due_date)}{r.overdue && <> <Pill tone="bad" label="Overdue" /></>}</> },
              { key: 'total', label: 'Amount', numeric: true, render: (r) => fmtMoney(r.total) }, { key: 'status', label: 'Status', render: (r) => <InvoiceStatus v={r.status} /> }]} />
        )}</Async>
      </div>
    </>
  );
}

interface Line { poLineId: string | null; description: string; qty: string; unitPrice: string; accountKey: string; note?: string }

export function CaptureInvoice() {
  const nav = useNavigate();
  const { me } = useAuth();
  const [params] = useSearchParams();
  const suppliers = useApi<any[]>('/api/suppliers');
  const facilities = useApi<any[]>('/api/facilities');
  const [f, setF] = useState({ supplierId: '', purchaseOrderId: params.get('po') ?? '', facilityId: '', invoiceNumber: '', invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: '', taxAmount: '', freightAmount: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const orders = useApi<any[]>(f.supplierId && me?.edition !== 'lite' ? `/api/purchase-orders?supplierId=${f.supplierId}` : null);
  const draft = useApi<any>(f.purchaseOrderId ? `/api/purchase-orders/${f.purchaseOrderId}/invoice-draft` : null);
  useEffect(() => {
    if (!draft.data) return;
    setF((x) => ({ ...x, supplierId: draft.data.supplier_id }));
    setLines(draft.data.lines.map((l: any) => ({ poLineId: l.po_line_id, description: l.description, qty: String(l.toInvoice), unitPrice: String(l.unit_price), accountKey: '',
      note: `ordered at ${fmtMoney(l.unit_price)}; received ${fmtNum(l.received, 3)}, invoiced so far ${fmtNum(l.invoiced, 3)}` })));
  }, [draft.data]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const setLine = (i: number, k: keyof Line, v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const act = useAction(async () => {
    const inv = await api.post('/api/supplier-invoices', {
      supplierId: f.supplierId, purchaseOrderId: f.purchaseOrderId || null, facilityId: f.purchaseOrderId ? null : f.facilityId || null, invoiceNumber: f.invoiceNumber,
      invoiceDate: f.invoiceDate, dueDate: f.dueDate || null, taxAmount: f.taxAmount ? Number(f.taxAmount) : 0, freightAmount: f.freightAmount ? Number(f.freightAmount) : 0,
      lines: lines.filter((l) => Number(l.qty) > 0).map((l) => ({ poLineId: l.poLineId, description: l.description, qty: Number(l.qty), unitPrice: Number(l.unitPrice), accountKey: l.accountKey || null })),
      file: file ? { name: file.name, mime: file.type, contentBase64: await fileToBase64(file) } : null,
    });
    nav(`/ap/${inv.id}`);
  });
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.unitPrice || 0), 0) + Number(f.taxAmount || 0) + Number(f.freightAmount || 0);
  const lite = me?.edition === 'lite';
  const [sup, setSup] = useState({ code: '', name: '' });
  const addSupplier = useAction(async () => {
    const s = await api.post('/api/suppliers', { code: sup.code, name: sup.name });
    await suppliers.reload(); setF((x) => ({ ...x, supplierId: s.id })); setSup({ code: '', name: '' });
  });
  return (
    <>
      <PageHead eyebrow="Accounts payable" title={lite ? 'Enter a bill' : 'Capture a supplier invoice'}
        sub={lite ? 'Enter the supplier\'s bill line by line; it posts to your books when approved.' : 'Choose the purchase order to fill the lines from what was received. Invoices without an order can be entered line by line.'} />
      {lite && (
        <section className="card stack">
          <h2>New supplier</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void addSupplier.run(); }}>
            <input id="sup-code" aria-label="Supplier code" placeholder="Code" value={sup.code} onChange={(e) => setSup({ ...sup, code: e.target.value })} required style={{ width: 120 }} />
            <input id="sup-name" aria-label="Supplier name" placeholder="Name" value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} required style={{ flex: '1 1 220px' }} />
            <button disabled={addSupplier.busy}>Add supplier</button><ErrorNote message={addSupplier.error} />
          </form>
        </section>
      )}
      <section className="card">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(); }}>
          <div className="form-grid">
            <label className="field">Supplier<select id="inv-supplier" value={f.supplierId} onChange={(e) => { setF({ ...f, supplierId: e.target.value, purchaseOrderId: '' }); setLines([]); }} required>
              <option value="">Choose…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label>
            {!lite && <label className="field">Purchase order<select id="inv-po" value={f.purchaseOrderId} onChange={(e) => { setF({ ...f, purchaseOrderId: e.target.value }); setLines(lines.filter((l) => !l.poLineId)); }}>
              <option value="">No purchase order</option>{(orders.data ?? []).filter((o) => o.status !== 'cancelled').map((o) => <option key={o.id} value={o.id}>{o.number} · {fmtMoney(o.total)} · {humanize(o.status)}</option>)}</select></label>}
            {!f.purchaseOrderId && <label className="field">Facility<select id="inv-fac" value={f.facilityId} onChange={set('facilityId')} required>
              <option value="">Choose…</option>{(facilities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>}
            <label className="field">Invoice number<input id="inv-number" value={f.invoiceNumber} onChange={set('invoiceNumber')} required /></label>
            <label className="field">Invoice date<input id="inv-date" type="date" value={f.invoiceDate} onChange={set('invoiceDate')} required /></label>
            <label className="field">Due date<input id="inv-due" type="date" value={f.dueDate} onChange={set('dueDate')} title="Leave empty to use the supplier's payment terms" /></label>
            <label className="field">Freight<input id="inv-freight" type="number" min="0" step="0.01" value={f.freightAmount} onChange={set('freightAmount')} /></label>
            <label className="field">Sales tax<input id="inv-tax" type="number" min="0" step="0.01" value={f.taxAmount} onChange={set('taxAmount')} /></label>
            <label className="field">Invoice file (PDF or image)<input id="inv-file" type="file" accept="application/pdf,image/png,image/jpeg,image/tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          </div>
          <h3>Lines</h3>
          {lines.map((l, i) => (
            <div className="line-editor" key={i}>
              <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} readOnly={!!l.poLineId} placeholder="Description" />
              <input aria-label={`Line ${i + 1} quantity`} type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} style={{ width: 80 }} />
              <input aria-label={`Line ${i + 1} unit price`} type="number" min="0" step="any" value={l.unitPrice} onChange={(e) => setLine(i, 'unitPrice', e.target.value)} style={{ width: 110 }} />
              <select aria-label={`Line ${i + 1} account`} value={l.accountKey} onChange={(e) => setLine(i, 'accountKey', e.target.value)} style={{ maxWidth: 200 }}>
                <option value="">{l.poLineId ? 'Account from the order' : 'Repairs & maintenance'}</option>
                {Object.entries(ACCOUNT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {l.note && <span className="faint">{l.note}</span>}
              {!l.poLineId && <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          ))}
          <div><button type="button" onClick={() => setLines([...lines, { poLineId: null, description: '', qty: '1', unitPrice: '', accountKey: '' }])}>{lite ? 'Add a line' : 'Add a line not on the order'}</button></div>
          <p><strong>Invoice total {fmtMoney(total)}</strong></p>
          <ErrorNote message={act.error} />
          <div><button className="primary" disabled={act.busy || !lines.length}>Save invoice</button></div>
        </form>
      </section>
    </>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const { can, me } = useAuth();
  const { data: i, loading, error, reload } = useApi<any>(`/api/supplier-invoices/${id}`);
  const conns = useApi<any[]>('/api/integrations');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [pay, setPay] = useState({ paidOn: new Date().toISOString().slice(0, 10), reference: '' });
  const approve = useAction(async () => { await api.post(`/api/supplier-invoices/${id}/approve`, { varianceNote: note || null }); await reload(); });
  const dispute = useAction(async () => { await api.post(`/api/supplier-invoices/${id}/dispute`, { reason }); setReason(''); await reload(); });
  const voidIt = useAction(async () => { await api.post(`/api/supplier-invoices/${id}/void`, { reason }); setReason(''); await reload(); });
  const paid = useAction(async () => { await api.post(`/api/supplier-invoices/${id}/payment`, { paidOn: pay.paidOn, amount: i.total, reference: pay.reference || null }); await reload(); });
  return (
    <Async loading={loading && !i} error={error}>{() => {
      const manage = can('ap.manage', i.facility_id);
      const active = (conns.data ?? []).find((c) => c.active);
      const manualPayment = manage && ['approved', 'exported'].includes(i.status) && (!active || ['file_export', 'native_books'].includes(active.provider));
      return (
        <>
          <PageHead eyebrow={`${i.facility_code} · Supplier invoice${i.po_number ? ` · ${i.po_number}` : ''}`} title={<>{i.invoice_number} <span className="muted" style={{ fontWeight: 400 }}>{i.supplier_name}</span></>}
            sub={<>Dated {fmtDate(i.invoice_date)} · due {fmtDate(i.due_date)} ({i.payment_terms ?? 'no terms on file'}) · captured by {i.captured_by_name}{i.approved_by_name ? `, approved by ${i.approved_by_name}` : ''}</>}
            actions={<><InvoiceStatus v={i.status} />{i.has_file && <button onClick={() => api.open(`/api/supplier-invoices/${i.id}/file`)}>Invoice file</button>}</>} />
          {i.issues.length > 0 && !['void', 'paid'].includes(i.status) && (
            <div className="notice warn"><strong>Does not match the order:</strong> {i.issues.join('; ')}.{i.variance_note && <> Approved with note: “{i.variance_note}”</>}</div>
          )}
          {i.dispute_reason && <div className="notice error">{i.status === 'void' ? 'Voided' : 'Disputed'}: {i.dispute_reason}</div>}
          <section className="card stack">
            <div className="spread"><h2>Lines</h2><strong>{fmtMoney(i.total)}</strong></div>
            <Table rows={i.lines} rowKey={(l) => String(l.line_no)} exception={(l) => l.flags.length > 0}
              columns={[{ key: 'line_no', label: '#', numeric: true }, { key: 'description', label: 'Description' }, { key: 'qty', label: 'Qty', numeric: true, render: (l) => fmtNum(l.qty, 3) },
                { key: 'unit_price', label: 'Price', numeric: true, render: (l) => fmtMoney(l.unit_price) }, { key: 'amount', label: 'Amount', numeric: true, render: (l) => fmtMoney(l.amount) },
                { key: 'po', label: 'Order / received', render: (l) => (l.po_line_id ? `${fmtMoney(l.po_price)} · received ${fmtNum(l.received, 3)}` : <span className="faint">not on the order</span>) },
                { key: 'account_key', label: 'Account', render: (l) => ACCOUNT_LABEL[l.account_key] ?? l.account_key },
                { key: 'flags', label: '', render: (l) => (l.flags.length ? <Pill tone="watch" label="Check" /> : <Pill tone="good" label="Matches" />) }]} />
            <p className="muted">Freight {fmtMoney(Number(i.freight_amount))} · Sales tax {fmtMoney(Number(i.tax_amount))}</p>
          </section>
          {manage && ['captured', 'disputed'].includes(i.status) && (
            <section className="card stack">
              <h2>Approve for payment</h2>
              {i.captured_by === me?.userId ? <p className="muted">You captured this invoice, so someone else must approve it.</p> : (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); void approve.run(); }}>
                  {!i.matched && <label className="field">Why should it be paid anyway? (required)<textarea id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} /></label>}
                  <ErrorNote message={approve.error} />
                  <div><button className="primary" disabled={approve.busy || (!i.matched && !note.trim())}>Approve {fmtMoney(i.total)}</button></div>
                </form>
              )}
            </section>
          )}
          {manualPayment && (
            <section className="card">
              <h2>Record payment</h2>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void paid.run(); }}>
                <input id="pay-date" type="date" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} aria-label="Paid on" />
                <input id="pay-ref" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="Check / ACH reference" aria-label="Reference" />
                <button disabled={paid.busy}>Mark paid {fmtMoney(i.total)}</button>
                <ErrorNote message={paid.error} />
              </form>
            </section>
          )}
          {i.status === 'paid' && <div className="notice ok">Paid {fmtMoney(Number(i.paid_amount))} on {fmtDate(i.paid_at)}{i.payment_reference ? ` (${i.payment_reference})` : ''}.</div>}
          <section className="card">
            <h2>Accounting</h2>
            <Table rows={i.sync} empty={i.status === 'captured' ? 'Sent to accounting after approval.' : 'Not sent yet: no accounting connection, or the next sync has not run.'}
              columns={[{ key: 'topic', label: 'What', render: (s) => (s.topic === 'ap.bill.voided' ? 'Void bill' : 'Create bill') },
                { key: 'connection', label: 'Connection', render: (s) => <>{s.connection}{s.is_mock && <> <Pill tone="watch" label="MOCK" /></>}</> },
                { key: 'status', label: 'Status', render: (s) => <Pill tone={s.status === 'delivered' ? 'good' : s.status === 'dead' ? 'bad' : 'info'} label={humanize(s.status)} /> },
                { key: 'external_id', label: 'Accounting reference' }, { key: 'last_error', label: 'Last error' }, { key: 'delivered_at', label: 'When', render: (s) => fmtDateTime(s.delivered_at) }]} />
          </section>
          {manage && !['paid', 'void'].includes(i.status) && (
            <section className="card">
              <form className="row" onSubmit={(e) => e.preventDefault()}>
                <input id="inv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (what the supplier must correct, or why it is void)" aria-label="Reason" style={{ flex: '1 1 320px' }} />
                {i.status === 'captured' && <button disabled={dispute.busy || reason.trim().length < 3} onClick={() => dispute.run()}>Dispute</button>}
                <button className="danger" disabled={voidIt.busy || reason.trim().length < 3} onClick={() => voidIt.run()}>Void</button>
                <ErrorNote message={dispute.error ?? voidIt.error} />
              </form>
            </section>
          )}
          {i.purchase_order_id && <p><Link to={`/purchasing/orders/${i.purchase_order_id}`}>Open {i.po_number}</Link></p>}
        </>
      );
    }}</Async>
  );
}
