import { useState } from 'react';
import { useAuth } from '../auth';
import { ErrorNote, PageHead } from '../components/ui';

/** "How I like to work": display settings for this person only. */
export function MySettings() {
  const { prefs, savePrefs, can } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const set = async (patch: any) => { setErr(null); try { await savePrefs(patch); } catch (e: any) { setErr(e.message); } };
  const radio = (name: string, value: string, current: string, label: string) => (
    <label className="row"><input type="radio" name={name} checked={current === value} onChange={() => set({ [name]: value })} /> {label}</label>);
  return (
    <>
      <PageHead eyebrow="My day" title="How I like to work" sub="These change how the screens look for you only, and take effect at once." />
      <section className="card stack">
        <fieldset className="stack"><legend><h2>How much room</h2></legend>
          {radio('density', 'roomy', prefs.density, 'Roomy: more space between things')}{radio('density', 'normal', prefs.density, 'Normal')}{radio('density', 'compact', prefs.density, 'Compact: more on the screen')}</fieldset>
        <fieldset className="stack"><legend><h2>Text size</h2></legend>
          {radio('textSize', 'normal', prefs.textSize, 'Normal')}{radio('textSize', 'large', prefs.textSize, 'Large')}{radio('textSize', 'larger', prefs.textSize, 'Larger')}</fieldset>
        <fieldset className="stack"><legend><h2>Reports open as</h2></legend>
          {radio('defaultView', 'chart', prefs.defaultView, 'Charts first, then the table')}{radio('defaultView', 'table', prefs.defaultView, 'The table first, charts folded away')}</fieldset>
        <fieldset className="stack"><legend><h2>Seeing and moving</h2></legend>
          <label className="row"><input type="checkbox" checked={prefs.highContrast} onChange={(e) => set({ highContrast: e.target.checked })} /> Stronger contrast</label>
          <label className="row"><input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => set({ reducedMotion: e.target.checked })} /> Reduce motion and animation</label></fieldset>
        {can('tenant.admin') && <fieldset className="stack"><legend><h2>Suggestions</h2></legend>
          <label className="row"><input type="checkbox" checked={prefs.suggestions} onChange={(e) => set({ suggestions: e.target.checked })} /> Show me a “worth a look” idea now and then (at most one a week)</label></fieldset>}
        <ErrorNote message={err} />
      </section>
    </>
  );
}
