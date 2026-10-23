import { useState } from 'react';
import { api } from '../api';
import { Async, ErrorNote, PageHead, Pill } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';
import { ReviewSettings } from '../components/ReviewSettings';

const REPEAT: Record<string, string> = { daily: 'Every day', weekly: 'Once a week', once: 'Once only' };

/**
 * Admin → Reminders (D-153): every reminder the system sends, with the company's settings. Administrators see all of
 * them and choose who else may change each one; other people see the ones they may change.
 */
export function Reminders() {
  const { data, loading, error, reload } = useApi<any>('/api/reminder-settings');
  return (
    <>
      <PageHead eyebrow="Admin" title="Reminders"
        sub="Every reminder the system sends, who gets it, how far ahead it warns and how often it repeats. Reminders arrive in the notification bell and the daily email digest." />
      <Async loading={loading && !data} error={error}>{() => {
        const groups = [...new Set<string>(data.reminders.map((r: any) => r.group))];
        const off = data.reminders.filter((r: any) => !r.enabled).length;
        return (
          <>
            <p className="answer">{data.reminders.length} reminder{data.reminders.length === 1 ? '' : 's'}{data.admin ? '' : ' you can change'}; {off ? `${off} turned off` : 'all on'}.</p>
            <ReviewSettings admin={data.admin} roles={data.roles} />
            {groups.map((g) => (
              <section key={g} className="card stack">
                <h2>{g}</h2>
                {data.reminders.filter((r: any) => r.group === g).map((r: any) => <ReminderRow key={r.key} r={r} admin={data.admin} roles={data.roles} onDone={reload} />)}
              </section>
            ))}
            <p className="faint">Changes apply from the next daily run. Each person can also mute kinds of notification for themselves under Notifications.</p>
          </>
        );
      }}</Async>
    </>
  );
}

function ReminderRow({ r, admin, roles, onDone }: { r: any; admin: boolean; roles: any[]; onDone: () => void }) {
  const [enabled, setEnabled] = useState<boolean>(r.enabled);
  const [lead, setLead] = useState<string>(r.leadDays === null ? '' : String(r.leadDays));
  const [repeat, setRepeat] = useState<string>(r.repeat);
  const n = Number(lead);
  const leadOk = !r.lead || (Number.isInteger(n) && n >= r.lead.min && n <= r.lead.max);
  const dirty = enabled !== r.enabled || repeat !== r.repeat || (r.lead && n !== r.leadDays);
  const save = useAction(async () => { await api.put(`/api/reminder-settings/${r.key}`, { enabled, repeat, leadDays: r.lead ? n : null }); onDone(); });
  const id = `rem-${r.key}`;
  const when = String(r.when).replace('{lead}', lead || String(r.leadDays ?? ''));
  return (
    <div className="stack reminder-row" style={{ gap: 6, borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
      <div>
        <strong>{r.label}</strong>{' '}
        {!r.enabled ? <Pill tone="bad" label="Off" /> : <Pill tone="good" label="On" />}
        {r.added && <> <Pill tone="watch" label="New" /></>}
        <div className="faint">{when}. To: {r.recipients}.</div>
        {r.featureOff && <div className="notice warn">Not sent while its feature is turned off for everyone (Admin → Features).</div>}
      </div>
      {r.canEdit ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Send this reminder</label>
          {r.lead && (
            <span className="row" style={{ gap: 4 }}>
              <label htmlFor={`${id}-lead`}>{r.leadKind === 'every' ? 'Every' : r.leadKind === 'after' ? 'After' : 'Warn'}</label>
              <input id={`${id}-lead`} type="number" inputMode="numeric" min={r.lead.min} max={r.lead.max} value={lead} onChange={(e) => setLead(e.target.value)} style={{ width: 80 }} />
              <span>{r.leadKind === 'every' ? 'days' : r.leadKind === 'after' ? 'days overdue' : 'days ahead'}</span>
            </span>
          )}
          {r.repeats.length > 1 ? (
            <select aria-label={`How often to repeat ${r.label}`} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
              {r.repeats.map((x: string) => <option key={x} value={x}>{REPEAT[x]}</option>)}
            </select>
          ) : <span className="faint">{REPEAT[r.repeat]}</span>}
          <button className={dirty && leadOk ? 'primary' : ''} disabled={!dirty || !leadOk || save.busy} onClick={() => save.run()}>Save</button>
        </div>
      ) : <span className="faint">{REPEAT[r.repeat]}{r.lead ? `, ${r.leadDays} days` : ''}. You cannot change this one.</span>}
      {r.canEdit && <span className="faint">Default: {r.lead ? `${r.lead.default} days, ` : ''}{(REPEAT[r.defaultRepeat] ?? '').toLowerCase()}{r.lead ? `; ${r.lead.min} to ${r.lead.max} days allowed` : ''}.</span>}
      {admin && <Editors r={r} roles={roles} onDone={onDone} />}
      {r.updatedAt && <span className="faint">Changed {fmtDateTime(r.updatedAt)} by {r.updatedBy}</span>}
      <ErrorNote message={save.error} />
    </div>
  );
}

/** Administrators choose who else may change a reminder: holders of the area's manage permission, or named roles. */
export function Editors({ r, roles, onDone, settingKey }: { r: any; roles: any[]; onDone: () => void; settingKey?: string }) {
  const [mode, setMode] = useState<'default' | 'roles'>(r.editorRoles ? 'roles' : 'default');
  const [chosen, setChosen] = useState<string[]>(r.editorRoles ?? []);
  const dirty = mode !== (r.editorRoles ? 'roles' : 'default') || (mode === 'roles' && [...chosen].sort().join() !== [...(r.editorRoles ?? [])].sort().join());
  const save = useAction(async () => { await api.put(`/api/reminder-settings/${encodeURIComponent(settingKey ?? r.key)}/editors`, { roleKeys: mode === 'roles' ? chosen : null }); onDone(); });
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select aria-label={`Who may change ${r.label}`} value={mode} onChange={(e) => setMode(e.target.value as 'default' | 'roles')}>
          <option value="default">Changed by administrators and managers of the area</option>
          <option value="roles">Changed by administrators and chosen roles</option>
        </select>
        {dirty && <button disabled={save.busy || (mode === 'roles' && !chosen.length)} onClick={() => save.run()}>Save who may change it</button>}
      </div>
      {mode === 'roles' && (
        <fieldset className="row" style={{ flexWrap: 'wrap', gap: 12, border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Roles that may change {r.label}</legend>
          {roles.map((x) => (
            <label key={x.key} className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={chosen.includes(x.key)} onChange={(e) => setChosen(e.target.checked ? [...chosen, x.key] : chosen.filter((k) => k !== x.key))} /> {x.name}
            </label>
          ))}
        </fieldset>
      )}
      <ErrorNote message={save.error} />
    </div>
  );
}
