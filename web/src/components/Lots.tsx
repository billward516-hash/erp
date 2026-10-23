import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, fmtNum } from '../format';
import { useApi } from '../hooks';

/**
 * Lot and serial entry and choice (D-147). Into stock, a tracked part names its lots (with quantity and, optionally,
 * expiry; the part's shelf life fills it in otherwise) or lists its serial numbers one per line. Out of stock, the lot
 * defaults to the first to expire; a person may choose another.
 */
export interface LotSpec { lot: string; qty: number; expiresOn?: string | null; supplierLot?: string | null }

export function LotEntry({ tracking, qty, onChange, label }: { tracking: 'lot' | 'serial'; qty: number; onChange: (lots: LotSpec[] | null) => void; label: string }) {
  const [rows, setRows] = useState([{ lot: '', qty: '', expiresOn: '' }]);
  const [serials, setSerials] = useState('');
  useEffect(() => {
    if (tracking === 'serial') {
      const list = serials.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      onChange(list.length ? list.map((s) => ({ lot: s, qty: 1 })) : null);
    } else {
      const filled = rows.filter((r) => r.lot.trim());
      onChange(filled.length ? filled.map((r, i) => ({ lot: r.lot.trim(), qty: r.qty === '' && filled.length === 1 && i === 0 ? qty : Number(r.qty), expiresOn: r.expiresOn || null })) : null);
    }
  }, [rows, serials, qty, tracking]);
  if (tracking === 'serial') {
    const n = serials.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).length;
    return (
      <div className="stack" style={{ gap: 4 }}>
        <textarea aria-label={`Serial numbers for ${label}`} rows={Math.min(6, Math.max(2, qty))} value={serials} onChange={(e) => setSerials(e.target.value)} placeholder="One serial number per line" style={{ minWidth: 220 }} />
        <span className={n === qty ? 'faint' : 'watch-text'}>{n} of {fmtNum(qty, 0)} serial numbers</span>
      </div>
    );
  }
  const set = (i: number, k: 'lot' | 'qty' | 'expiresOn', v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="stack" style={{ gap: 4 }}>
      {rows.map((r, i) => (
        <div className="row" key={i} style={{ gap: 6 }}>
          <input aria-label={`Lot ${i + 1} for ${label}`} value={r.lot} onChange={(e) => set(i, 'lot', e.target.value)} placeholder="Lot" style={{ width: 120 }} />
          {rows.length > 1 && <input aria-label={`Lot ${i + 1} quantity for ${label}`} type="number" min="0" step="any" value={r.qty} onChange={(e) => set(i, 'qty', e.target.value)} placeholder="Qty" style={{ width: 80 }} />}
          <input aria-label={`Lot ${i + 1} expiry for ${label}`} type="date" value={r.expiresOn} onChange={(e) => set(i, 'expiresOn', e.target.value)} title="Expiry (blank: from the part's shelf life)" />
        </div>
      ))}
      <button type="button" className="link" onClick={() => setRows([...rows, { lot: '', qty: '', expiresOn: '' }])}>Split into another lot</button>
    </div>
  );
}

/** Choice of lot when taking stock out; blank means first to expire. */
export function LotPick({ partId, locationId, value, onChange, label }: { partId: string; locationId: string; value: string; onChange: (lot: string) => void; label: string }) {
  const { data } = useApi<any[]>(partId ? `/api/lots?partId=${partId}` : null);
  const today = new Date().toISOString().slice(0, 10);
  const here = (data ?? []).map((l) => ({ ...l, qty: l.locations.find((x: any) => x.location_id === locationId)?.qty ?? 0 }))
    .filter((l) => l.qty > 0 && l.status === 'available' && !(l.expires_on && String(l.expires_on).slice(0, 10) < today));
  return (
    <select aria-label={`Lot for ${label}`} value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 220 }}>
      <option value="">First to expire</option>
      {here.map((l) => <option key={l.id} value={l.number}>{l.number} ({fmtNum(l.qty, 3)}{l.expires_on ? `, exp ${fmtDate(l.expires_on)}` : ''})</option>)}
    </select>
  );
}

export const LotLink = ({ id, number }: { id: string; number: string }) => <Link to={`/inventory/lots/${id}`}>{number}</Link>;
