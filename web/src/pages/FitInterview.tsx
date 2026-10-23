import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote, PageHead, Pill } from '../components/ui';
import { useAction, useApi } from '../hooks';

/** The fit interview: what the business does, and which features that means (SC-004 A). */
export function FitInterview() {
  const { data, reload } = useApi<any>('/api/fit-interview');
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [applied, setApplied] = useState<string | null>(null);
  const answers = { ...(data?.answers ?? {}), ...draft };
  const save = useAction(async () => { await api.put('/api/fit-interview', draft); setDraft({}); await reload(); });
  const apply = useAction(async () => { const r = await api.post('/api/fit-interview/apply'); setApplied(`${r.hidden} feature${r.hidden === 1 ? '' : 's'} hidden. They come back from the Features page.`); });
  if (!data) return null;
  const toggle = (id: string, v: string) => { const cur: string[] = answers[id] ?? []; setDraft({ ...draft, [id]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }); };
  const r = data.result;
  return (
    <>
      <PageHead eyebrow="Admin" title="Fit interview" sub="Tell us what the business does and we will suggest which features to show, how deep an implementation plan to follow, and what is not a fit yet. You can retake it any time." />
      <section className="card stack">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} data-no-draft>
          {data.questions.map((q: any) => (
            <fieldset key={q.id} className="stack"><legend><h2 style={{ marginBottom: 0 }}>{q.text}</h2></legend>
              {q.kind === 'yesno' && <div className="row">{[true, false].map((v) => <label key={String(v)} className="row"><input type="radio" name={q.id} checked={answers[q.id] === v} onChange={() => setDraft({ ...draft, [q.id]: v })} /> {v ? 'Yes' : 'No'}</label>)}</div>}
              {q.kind === 'single' && <div className="row" style={{ flexWrap: 'wrap' }}>{q.options.map((o: any) => <label key={o.value} className="row"><input type="radio" name={q.id} checked={answers[q.id] === o.value} onChange={() => setDraft({ ...draft, [q.id]: o.value })} /> {o.label}</label>)}</div>}
              {q.kind === 'multi' && <div className="row" style={{ flexWrap: 'wrap' }}>{q.options.map((o: any) => <label key={o.value} className="row"><input type="checkbox" checked={(answers[q.id] ?? []).includes(o.value)} onChange={() => toggle(q.id, o.value)} /> {o.label}</label>)}</div>}
            </fieldset>))}
          <ErrorNote message={save.error} />
          <div><button className="primary" disabled={save.busy || !Object.keys(draft).length}>Save answers and show the recommendation</button></div>
        </form>
      </section>
      {r && (
        <section className="card stack" aria-label="Recommendation">
          <h2>What we suggest</h2>
          <p style={{ margin: 0 }}><strong>Implementation plan: {r.depth}.</strong> {r.depthWhy} <Link to="/implementation">Open the implementation plan</Link></p>
          <h3>Show these features</h3>
          <ul>{r.show.map((x: any) => <li key={x.feature}><strong>{x.label}</strong>: {x.why}</li>)}</ul>
          {r.maybe.length > 0 && <><h3>Worth considering</h3><ul>{r.maybe.map((x: any) => <li key={x.feature}><strong>{x.label}</strong>: {x.why}</li>)}</ul></>}
          {r.hide.length > 0 && <><h3>Probably not needed yet</h3><p className="muted">{r.hide.map((x: any) => x.label).join(', ')}</p></>}
          {r.notFit.length > 0 && <><h3>Not a fit yet</h3><ul>{r.notFit.map((x: string) => <li key={x}>{x}</li>)}</ul></>}
          <p className="muted">Data steps that apply: {r.steps.length}. They are marked in the implementation plan.</p>
          <div className="row"><button disabled={apply.busy} onClick={() => apply.run()}>Hide the features we did not recommend</button><span className="muted">Optional and reversible from the Features page.</span></div>
          {applied && <p role="status"><Pill tone="good" label="Done" /> {applied}</p>}
          <ErrorNote message={apply.error} />
        </section>
      )}
    </>
  );
}
