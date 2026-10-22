import { useState } from 'react';
import { api } from '../api';
import { Async, ErrorNote, PageHead, Pill } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';

/**
 * Admin → Features (D-149): who sees each feature. Hidden features leave navigation, pages, reports, search and the
 * API for those users; this screen is the only place they still appear.
 */
export function Features() {
  const { data, loading, error, reload } = useApi<any>('/api/features');
  return (
    <>
      <PageHead eyebrow="Admin" title="Features"
        sub="Choose who sees each part of the platform. A hidden feature disappears from menus, pages, reports and search for those people, and the system refuses it; it stays listed here so it can be turned back on. Nothing is deleted." />
      <Async loading={loading && !data} error={error}>{() => {
        const groups = [...new Set<string>(data.features.map((f: any) => f.group))];
        const off = data.features.filter((f: any) => f.mode !== 'all').length;
        return (
          <>
            <p className="answer">{off ? `${off} of ${data.features.length} features are limited or turned off.` : `All ${data.features.length} features are on for everyone.`}</p>
            {groups.map((g) => (
              <section key={g} className="card stack">
                <h2>{g}</h2>
                {data.features.filter((f: any) => f.group === g).map((f: any) => <FeatureRow key={f.key} f={f} roles={data.roles} onDone={reload} />)}
              </section>
            ))}
            <p className="faint">Home, approvals, notifications, reports and the administration screens are always available. Settings apply the next time each person's page loads.</p>
          </>
        );
      }}</Async>
    </>
  );
}

function FeatureRow({ f, roles, onDone }: { f: any; roles: any[]; onDone: () => void }) {
  const [mode, setMode] = useState<string>(f.mode);
  const [chosen, setChosen] = useState<string[]>(f.roleKeys);
  const dirty = mode !== f.mode || (mode === 'roles' && [...chosen].sort().join() !== [...f.roleKeys].sort().join());
  const save = useAction(async () => { await api.put(`/api/features/${f.key}`, { mode, roleKeys: mode === 'roles' ? chosen : [] }); onDone(); });
  const id = `feat-${f.key}`;
  return (
    <div className="stack feature-row" style={{ gap: 6, borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
      <div className="spread">
        <div>
          <strong id={`${id}-label`}>{f.label}</strong>{' '}
          {f.mode === 'off' ? <Pill tone="bad" label="Off for everyone" /> : f.mode === 'roles' ? <Pill tone="watch" label={`${f.roleKeys.length} role${f.roleKeys.length === 1 ? '' : 's'}`} /> : <Pill tone="good" label="Everyone" />}
          <div className="faint">{f.description}</div>
        </div>
        <div className="row">
          <select aria-label={`Who sees ${f.label}`} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="all">Everyone</option><option value="roles">Only some roles</option><option value="off">Nobody (hidden)</option>
          </select>
          <button className={dirty ? 'primary' : ''} disabled={!dirty || save.busy || (mode === 'roles' && !chosen.length)} onClick={() => save.run()}>Save</button>
        </div>
      </div>
      {mode === 'roles' && (
        <fieldset className="row" style={{ flexWrap: 'wrap', gap: 12, border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Roles that see {f.label}</legend>
          {roles.map((r) => (
            <label key={r.key} className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={chosen.includes(r.key)} onChange={(e) => setChosen(e.target.checked ? [...chosen, r.key] : chosen.filter((x) => x !== r.key))} />
              {r.name} <span className="faint">({r.users})</span>
            </label>
          ))}
        </fieldset>
      )}
      {mode !== 'all' && f.affects && <p className="notice warn">{f.affects}</p>}
      {f.updatedAt && <span className="faint">Changed {fmtDateTime(f.updatedAt)} by {f.updatedBy}</span>}
      <ErrorNote message={save.error} />
    </div>
  );
}
