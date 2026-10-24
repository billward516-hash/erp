import { Fragment, useState } from 'react';
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
        <p className="muted" aria-live="polite">{Object.keys(answers).length} answered. Only the questions that apply to your business are shown, so the list may grow as you answer. Answer what you can; you can come back.</p>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }} data-no-draft>
          {data.questions.map((q: any, i: number) => (
            <Fragment key={q.id}>
              {(i === 0 || data.questions[i - 1].section !== q.section) && <h2 className="section-head" style={{ marginTop: i === 0 ? 0 : 16, paddingTop: i === 0 ? 0 : 12, borderTop: i === 0 ? 'none' : '1px solid var(--line, #d9dee7)' }}>{q.section}</h2>}
              <fieldset className="stack"><legend><h3 style={{ marginBottom: 0 }}>{q.text}</h3></legend>
                {q.help && <p className="muted" style={{ margin: 0 }}>{q.help}</p>}
                {q.kind === 'yesno' && <div className="row">{[true, false].map((v) => <label key={String(v)} className="row"><input type="radio" name={q.id} checked={answers[q.id] === v} onChange={() => setDraft({ ...draft, [q.id]: v })} /> {v ? 'Yes' : 'No'}</label>)}</div>}
                {q.kind === 'single' && <div className="row" style={{ flexWrap: 'wrap' }}>{q.options.map((o: any) => <label key={o.value} className="row"><input type="radio" name={q.id} checked={answers[q.id] === o.value} onChange={() => setDraft({ ...draft, [q.id]: o.value })} /> {o.label}</label>)}</div>}
                {q.kind === 'multi' && <div className="row" style={{ flexWrap: 'wrap' }}>{q.options.map((o: any) => <label key={o.value} className="row"><input type="checkbox" checked={(answers[q.id] ?? []).includes(o.value)} onChange={() => toggle(q.id, o.value)} /> {o.label}</label>)}</div>}
                {q.kind === 'number' && <label className="field" style={{ maxWidth: 320 }}><span className="muted">{q.unit}</span>
                  <input id={`q-${q.id}`} type="number" inputMode="decimal" min={q.min ?? 0} max={q.max} step="any" value={answers[q.id] ?? ''} onChange={(e) => { const v = e.target.value; const next = { ...draft }; if (v === '') delete next[q.id]; else next[q.id] = Number(v); setDraft(next); }} /></label>}
                {q.kind === 'text' && <textarea id={`q-${q.id}`} rows={2} maxLength={500} aria-label={q.text} value={answers[q.id] ?? ''} onChange={(e) => setDraft({ ...draft, [q.id]: e.target.value })} />}
              </fieldset>
            </Fragment>))}
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
          {r.businessCase && (<>
            <h3>What your own numbers say</h3>
            <table><thead><tr><th scope="col">What</th><th scope="col">Amount</th><th scope="col">How it is worked out</th></tr></thead><tbody>
              {r.businessCase.lines.map((l: any) => <tr key={l.key}><td>{l.label} <span className="muted">({l.kind})</span></td><td className="n">${Math.round(l.amount).toLocaleString()}</td><td className="muted">{l.how}</td></tr>)}
            </tbody></table>
            <p style={{ margin: 0 }}>Yearly cost named: <strong>${Math.round(r.businessCase.yearlyTotal).toLocaleString()}</strong>. Each 10% of that is ${r.businessCase.tenPercent.toLocaleString()} a year. Cash tied up: <strong>${Math.round(r.businessCase.cashTotal).toLocaleString()}</strong>.</p>
            <p className="muted" style={{ margin: 0 }}>{r.businessCase.note}</p></>)}
          {r.measures?.length > 0 && <><h3>Measure these before you start</h3><ul>{r.measures.map((m: any) => <li key={m.metric}><strong>{m.metric}</strong>. <span className="muted">{m.where}</span></li>)}</ul></>}
          {r.goals?.length > 0 && <p style={{ margin: 0 }}><strong>Your goals:</strong> {r.goals.join(', ')}.{r.success ? <> In your words: “{r.success}”</> : null}</p>}
          {r.readiness?.flags?.length > 0 && <><h3>How ready you are: {r.readiness.level}</h3><ul>{r.readiness.flags.map((f: any, i: number) => <li key={i}>{f.ok ? 'Ready: ' : 'Needs attention: '}{f.text}</li>)}</ul></>}
          {r.unmet?.length > 0 && <><h3>You asked for things we have not built (held on purpose)</h3><ul>{r.unmet.map((u: any) => <li key={u.key}><strong>{u.label}</strong>: {u.note}</li>)}</ul><p className="muted">Your answers are recorded as demand for these.</p></>}
          <p className="muted">Data steps that apply: {r.steps.length}. They are marked in the implementation plan.</p>
          <div className="row"><button disabled={apply.busy} onClick={() => apply.run()}>Hide the features we did not recommend</button><span className="muted">Optional and reversible from the Features page.</span></div>
          {applied && <p role="status"><Pill tone="good" label="Done" /> {applied}</p>}
          <ErrorNote message={apply.error} />
        </section>
      )}
    </>
  );
}
