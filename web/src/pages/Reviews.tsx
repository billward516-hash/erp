import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Async, Empty, ErrorNote, PageHead, Pill } from '../components/ui';
import { useAction, useApi } from '../hooks';

/**
 * Reviews (D-154): records due for their periodic review that this person owns or manages. Confirm a record is still
 * current, or note what needs to change; the next review counts from today.
 */
export function Reviews() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const status = params.get('status') === 'all' ? 'all' : 'due';
  const { data, loading, error, reload } = useApi<any>(`/api/reviews?status=${status}${type ? `&type=${type}` : ''}`);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  return (
    <>
      <PageHead eyebrow="Work" title="Reviews"
        sub="Records that must be looked at again every so often: FMEAs, procedures, policies, course content, suppliers, PM plans, spares lists, control limits, user access and more. How often is set under Admin → Reminders." />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select aria-label="Kind of record" value={type} onChange={(e) => set('type', e.target.value)}>
          <option value="">All kinds</option>
          {(data?.kinds ?? []).map((k: any) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
        <select aria-label="Which reviews" value={status} onChange={(e) => set('status', e.target.value === 'all' ? 'all' : '')}>
          <option value="due">Due soon or overdue</option><option value="all">All, with their next date</option>
        </select>
      </div>
      <Async loading={loading && !data} error={error}>{() => (
        <>
          <p className="answer">{data.counts.overdue ? `${data.counts.overdue} review${data.counts.overdue === 1 ? ' is' : 's are'} overdue` : 'Nothing is overdue'}{data.counts.dueSoon ? `, and ${data.counts.dueSoon} ${data.counts.dueSoon === 1 ? 'is' : 'are'} due soon` : ''}.</p>
          {data.items.length ? (
            <section className="card stack">
              {data.items.map((i: any) => <ReviewRow key={`${i.type}-${i.id}`} i={i} onDone={reload} />)}
            </section>
          ) : <Empty>{status === 'all' ? 'No records of this kind to review.' : 'No reviews due. Choose “All” to see when each is next due.'}</Empty>}
        </>
      )}</Async>
    </>
  );
}

function ReviewRow({ i, onDone }: { i: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<'no_change' | 'changes_needed'>('no_change');
  const [note, setNote] = useState('');
  const [months, setMonths] = useState<string>(String(i.months));
  const save = useAction(async () => { await api.post(`/api/reviews/${i.type}/${i.id}`, { outcome, note: note || null }); setOpen(false); setNote(''); onDone(); });
  const freq = useAction(async () => { await api.put(`/api/reviews/${i.type}/${i.id}/interval`, { months: Number(months) }); onDone(); });
  const id = `rev-${i.type}-${i.id}`;
  return (
    <div className="stack review-row" style={{ gap: 6, borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
      <div className="spread">
        <div>
          <span className="faint">{i.typeLabel}</span>{' '}
          {i.status === 'overdue' ? <Pill tone="bad" label={`Overdue ${i.daysOverdue} day${i.daysOverdue === 1 ? '' : 's'}`} /> : i.status === 'due_soon' ? <Pill tone="watch" label="Due soon" /> : <Pill tone="good" label="Current" />}
          <div><Link to={i.link}><strong>{i.number}</strong> {i.title}</Link></div>
          <div className="faint">
            {i.dueOn ? `Due ${i.dueOn}` : 'No date yet'} · every {i.months} month{i.months === 1 ? '' : 's'}{i.ownMonths ? ' (its own frequency)' : ''}
            {i.lastReviewedOn ? ` · last reviewed ${i.lastReviewedOn}${i.lastOutcome === 'changes_needed' ? ', changes needed' : ''}` : ''}
          </div>
        </div>
        <button className={i.status === 'ok' ? '' : 'primary'} onClick={() => setOpen(!open)} aria-expanded={open}>Record review</button>
      </div>
      {open && (
        <div className="stack" style={{ gap: 6 }}>
          <fieldset className="row" style={{ gap: 12, border: 0, padding: 0, margin: 0, flexWrap: 'wrap' }}>
            <legend className="sr-only">Outcome of the review of {i.number}</legend>
            <label className="row" style={{ gap: 4 }}><input type="radio" name={`${id}-o`} checked={outcome === 'no_change'} onChange={() => setOutcome('no_change')} /> Still current, no change</label>
            <label className="row" style={{ gap: 4 }}><input type="radio" name={`${id}-o`} checked={outcome === 'changes_needed'} onChange={() => setOutcome('changes_needed')} /> Changes needed (revise it through its own approval)</label>
          </fieldset>
          <label htmlFor={`${id}-note`}>{outcome === 'changes_needed' ? 'What needs to change' : 'Note (optional)'}</label>
          <textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row"><button className="primary" disabled={save.busy || (outcome === 'changes_needed' && !note.trim())} onClick={() => save.run()}>Save review</button></div>
          <ErrorNote message={save.error} />
          {i.canManage && i.type !== 'continuity' && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <label htmlFor={`${id}-months`}>Review this record every</label>
              <input id={`${id}-months`} type="number" min={1} max={120} value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 70 }} /> <span>months</span>
              <button disabled={freq.busy || Number(months) === i.months} onClick={() => freq.run()}>Set its own frequency</button>
              <ErrorNote message={freq.error} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
