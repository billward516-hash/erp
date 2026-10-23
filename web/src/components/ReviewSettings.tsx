import { useState } from 'react';
import { api } from '../api';
import { ErrorNote, Pill } from './ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';
import { Editors } from '../pages/Reminders';

const REPEAT: Record<string, string> = { daily: 'Every day', weekly: 'Once a week', once: 'Once only' };

/** Periodic reviews (D-154) on Admin → Reminders: how often each kind of record is reviewed, and its reminder. */
export function ReviewSettings({ admin, roles }: { admin: boolean; roles: any[] }) {
  const { data, reload } = useApi<any[]>('/api/review-settings');
  const rows = (data ?? []).filter((r) => admin || r.canEdit);
  if (!rows.length) return null;
  return (
    <section className="card stack">
      <h2>Periodic reviews</h2>
      <p className="muted" style={{ margin: 0 }}>How often each kind of record must be reviewed. Owners are reminded ahead of the date and again while it is overdue; past the escalation, their managers (or administrators) are told too. A record can also be given its own frequency from the Reviews page.</p>
      {rows.map((r) => <ReviewSettingRow key={r.key} r={r} admin={admin} roles={roles} onDone={reload} />)}
    </section>
  );
}

function ReviewSettingRow({ r, admin, roles, onDone }: { r: any; admin: boolean; roles: any[]; onDone: () => void }) {
  const s = r.setting;
  const [enabled, setEnabled] = useState<boolean>(s.enabled);
  const [months, setMonths] = useState(String(s.months));
  const [lead, setLead] = useState(String(s.leadDays));
  const [repeat, setRepeat] = useState<string>(s.repeat);
  const [esc, setEsc] = useState(String(s.escalateDays));
  const dirty = enabled !== s.enabled || Number(months) !== s.months || Number(lead) !== s.leadDays || repeat !== s.repeat || Number(esc) !== s.escalateDays;
  const save = useAction(async () => { await api.put(`/api/review-settings/${r.key}`, { enabled, months: Number(months), leadDays: Number(lead), repeat, escalateDays: Number(esc) }); onDone(); });
  const id = `revset-${r.key}`;
  return (
    <div className="stack review-setting-row" style={{ gap: 6, borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
      <div>
        <strong>{r.label}</strong> {s.enabled ? <Pill tone="good" label={`Every ${s.months} month${s.months === 1 ? '' : 's'}`} /> : <Pill tone="bad" label="Off" />}
        <div className="faint">{r.description} Reminded: {r.recipients}.</div>
      </div>
      {r.canEdit ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Track reviews</label>
          <span className="row" style={{ gap: 4 }}><label htmlFor={`${id}-m`}>Every</label><input id={`${id}-m`} type="number" min={r.months.min} max={r.months.max} value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 64 }} /><span>months</span></span>
          {!r.own && <>
            <span className="row" style={{ gap: 4 }}><label htmlFor={`${id}-l`}>Warn</label><input id={`${id}-l`} type="number" min={0} max={180} value={lead} onChange={(e) => setLead(e.target.value)} style={{ width: 64 }} /><span>days ahead</span></span>
            <select aria-label={`How often to repeat the ${r.label} reminder`} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
              {Object.entries(REPEAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="row" style={{ gap: 4 }}><label htmlFor={`${id}-e`}>Escalate after</label><input id={`${id}-e`} type="number" min={1} max={365} value={esc} onChange={(e) => setEsc(e.target.value)} style={{ width: 64 }} /><span>days overdue</span></span>
          </>}
          <button className={dirty ? 'primary' : ''} disabled={!dirty || save.busy} onClick={() => save.run()}>Save</button>
        </div>
      ) : <span className="faint">You cannot change this one.</span>}
      <span className="faint">{r.months.min} to {r.months.max} months allowed; default {r.months.default}.{s.updatedAt ? ` Changed ${fmtDateTime(s.updatedAt)} by ${s.updatedBy}.` : ''}</span>
      {admin && <Editors r={{ ...r, editorRoles: s.editorRoles }} roles={roles} onDone={onDone} settingKey={`review:${r.key}`} />}
      <ErrorNote message={save.error} />
    </div>
  );
}
