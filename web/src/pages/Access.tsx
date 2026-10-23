import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';

/**
 * Admin → People and access (D-183A): Users (who can sign in, what they hold, disable, single sign-on identity),
 * Roles (starter roles read-only, the company's own roles) and Tokens (API tokens shown once). Tenant administrators only.
 * Lite shows Users and Tokens; the server refuses the Roles area there.
 */
export function Access() {
  const { can, me } = useAuth();
  const [params, setParams] = useSearchParams();
  const lite = me?.edition === 'lite';
  const tabs: [string, string][] = [['users', 'Users'], ...(lite ? [] : [['roles', 'Roles'] as [string, string]]), ['tokens', 'Tokens']];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab')! : 'users';
  if (!can('tenant.admin')) {
    return (<><PageHead eyebrow="Admin" title="People and access" /><p className="notice warn">Only company administrators manage people, roles and tokens.</p></>);
  }
  return (
    <>
      <PageHead eyebrow="Admin" title="People and access" sub="Who can sign in, what each person can do and where, the roles that bundle permissions, and the tokens that let other systems act as a person." />
      <div className="row" role="tablist" aria-label="People and access">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'roles' && !lite && <RolesTab />}
      {tab === 'tokens' && <TokensTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const scopeText = (g: any) => (g.group ? `portfolio ${g.group}` : g.facility ? `site ${g.facility}` : 'all sites');

function UsersTab() {
  const { data, loading, error, reload } = useApi<any>('/api/admin-users');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const create = useAction(async (name: string, email: string) => { const u = await api.post('/api/admin-users', { displayName: name, email }); await reload(); setAdding(false); setOpen(u.id); });
  return (
    <Async loading={loading && !data} error={error}>{() => {
      const users: any[] = data.users;
      const active = users.filter((u) => u.status === 'active').length;
      const shown = users.filter((u) => !filter.trim() || `${u.displayName} ${u.email}`.toLowerCase().includes(filter.trim().toLowerCase()));
      const current = users.find((u) => u.id === open);
      return (
        <>
          <Kpis items={[{ label: 'Active users', value: data.licence.userCap ? `${active} of ${data.licence.userCap}` : active, tone: data.licence.userCap && active >= data.licence.userCap ? 'watch' : undefined, note: data.licence.userCap ? `${data.licence.edition} edition` : undefined },
            { label: 'Disabled', value: users.length - active }, { label: 'Without any role', value: users.filter((u) => u.status === 'active' && !u.grants.length).length, tone: users.some((u) => u.status === 'active' && !u.grants.length) ? 'watch' : undefined },
            ...(data.sso?.enabled ? [{ label: 'Not yet on single sign-on', value: users.filter((u) => u.status === 'active' && !u.sso).length }] : [])]} />
          <div className="card stack">
            <div className="row">
              <input aria-label="Find a person" placeholder="Find by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: '1 1 240px' }} />
              <button onClick={() => setAdding(!adding)} aria-expanded={adding}>Add a person</button>
            </div>
            {adding && <AddPerson busy={create.busy} error={create.error} onSave={(n, e) => create.run(n, e)} onCancel={() => setAdding(false)} />}
            <Table rows={shown} rowKey={(u) => u.id} empty="No one matches." exception={(u) => u.status !== 'active'}
              columns={[
                { key: 'displayName', label: 'Name', render: (u) => <strong>{u.displayName}</strong> },
                { key: 'email', label: 'Email' },
                { key: 'status', label: 'Status', render: (u) => <Pill value={u.status} label={u.status === 'active' ? 'Active' : 'Disabled'} tone={u.status === 'active' ? 'good' : 'bad'} /> },
                { key: 'access', label: 'Access', value: (u) => u.grants.map((g: any) => g.roleName).join(' '), render: (u) => u.grants.length ? u.grants.map((g: any) => `${g.roleName} (${scopeText(g)})`).join('; ') : <span className="faint">No role yet</span> },
                { key: 'sso', label: 'Single sign-on', value: (u) => (u.sso ? 'linked' : 'not linked'), render: (u) => (u.sso ? <Pill label="Linked" tone="info" /> : <span className="faint">Not linked</span>) },
                { key: 'lastSeen', label: 'Last used', value: (u) => u.lastSeen ?? '', render: (u) => (u.lastSeen ? fmtDateTime(u.lastSeen) : <span className="faint">Never</span>) },
                { key: 'act', label: '', plain: true, render: (u) => <button className="link" aria-label={`Manage ${u.displayName}`} onClick={() => setOpen(open === u.id ? null : u.id)}>{open === u.id ? 'Close' : 'Manage'}</button> },
              ]} />
          </div>
          {current && <ManageUser key={current.id} user={current} data={data} onChanged={reload} onClose={() => setOpen(null)} />}
          <p className="faint">Many people at once: Data import → "People who sign in, with roles". Changes here take effect on the person's next request, and every change is recorded in the audit trail.</p>
        </>
      );
    }}</Async>
  );
}

function AddPerson({ onSave, onCancel, busy, error }: { onSave: (name: string, email: string) => void; onCancel: () => void; busy: boolean; error: string | null }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave(name, email); }}>
      <div className="row">
        <input id="new-user-name" aria-label="Name" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required style={{ flex: '1 1 200px' }} />
        <input id="new-user-email" aria-label="Work email" type="email" placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ flex: '1 1 240px' }} />
        <button className="primary" disabled={busy}>Add person</button><button type="button" onClick={onCancel}>Cancel</button>
      </div>
      <ErrorNote message={error} />
      <p className="faint">The person has no access until you give them a role. They sign in through the company's identity provider using this email.</p>
    </form>
  );
}

function ManageUser({ user, data, onChanged, onClose }: { user: any; data: any; onChanged: () => Promise<unknown> | void; onClose: () => void }) {
  const disabled = user.status !== 'active';
  const [name, setName] = useState<string>(user.displayName);
  const [roleKey, setRoleKey] = useState('');
  const [scope, setScope] = useState('all');
  const [issuer, setIssuer] = useState<string>(data.sso?.issuer ?? '');
  const [subject, setSubject] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const done = async (msg?: string) => { setNotice(msg ?? null); await onChanged(); };
  const rename = useAction(async () => { await api.patch(`/api/admin-users/${user.id}`, { displayName: name }); await done('Name saved.'); });
  const toggle = useAction(async () => {
    if (!disabled && !window.confirm(`Disable ${user.displayName}? They are signed out and cannot sign in or use any token until you enable the account again.`)) return;
    const r = await api.post(`/api/admin-users/${user.id}/${disabled ? 'enable' : 'disable'}`);
    await done(disabled ? 'Account enabled.' : `Account disabled${r.sessionsEnded ? `; ${r.sessionsEnded} signed-in session${r.sessionsEnded === 1 ? '' : 's'} ended` : ''}.`);
  });
  const grant = useAction(async () => {
    const [kind, id] = scope.split(':');
    await api.post('/api/user-grants', { userId: user.id, roleKey, ...(kind === 'site' ? { facilityId: id } : kind === 'group' ? { groupId: id } : {}) });
    setRoleKey(''); await done('Role given.');
  });
  const revoke = useAction(async (g: any) => {
    if (!window.confirm(`Remove ${g.roleName} (${scopeText(g)}) from ${user.displayName}?`)) return;
    await api.delete(`/api/user-grants/${g.id}`); await done('Role removed.');
  });
  const link = useAction(async () => { await api.post(`/api/admin-users/${user.id}/sso-link`, { issuer: issuer || undefined, subject }); setSubject(''); await done('Identity linked.'); });
  const unlink = useAction(async () => {
    if (!window.confirm(`Unlink ${user.displayName} from their identity? If your company allows it, they are matched again by email at their next sign-in.`)) return;
    await api.post(`/api/admin-users/${user.id}/sso-unlink`); await done('Identity unlinked.');
  });
  const isYou = user.id === data.you;
  return (
    <section className="card stack" aria-label={`Manage ${user.displayName}`}>
      <div className="spread">
        <h2>{user.displayName} <span className="faint">{user.email}</span></h2>
        <button onClick={onClose}>Close</button>
      </div>
      {notice && <div className="notice" role="status">{notice}</div>}
      {disabled && <p className="notice warn">This account is disabled: they cannot sign in and their tokens do not work. API tokens resume if you enable the account; signed-in sessions do not.</p>}

      <form className="row" onSubmit={(e) => { e.preventDefault(); void rename.run(); }}>
        <input aria-label="Display name" value={name} onChange={(e) => setName(e.target.value)} required style={{ flex: '1 1 240px' }} />
        <button disabled={rename.busy || name.trim() === user.displayName}>Save name</button>
        <button type="button" className={disabled ? 'primary' : ''} disabled={toggle.busy || (isYou && !disabled)} onClick={() => void toggle.run()} title={isYou ? 'You cannot disable your own account' : undefined}>{disabled ? 'Enable account' : 'Disable account'}</button>
      </form>
      <ErrorNote message={rename.error ?? toggle.error} />

      <h3>Roles</h3>
      {user.grants.length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
          {user.grants.map((g: any) => (
            <li key={g.id} className="spread"><span>{g.roleName} {g.custom && <Pill label="company role" tone="info" />} <span className="faint">at {scopeText(g)}</span></span>
              <button className="link" aria-label={`Remove ${g.roleName} at ${scopeText(g)}`} disabled={revoke.busy || isYou} onClick={() => void revoke.run(g)}>Remove</button></li>
          ))}
        </ul>
      ) : <p className="faint">No role yet: this person can sign in but sees almost nothing.</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void grant.run(); }}>
        <select aria-label="Role to give" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} required style={{ width: 'auto' }}>
          <option value="">Choose a role…</option>
          {data.roles.map((r: any) => <option key={r.key} value={r.key}>{r.name}{r.custom ? ' (company role)' : ''}</option>)}
        </select>
        <select aria-label="Where it applies" value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: 'auto' }}>
          <option value="all">All sites</option>
          {data.sites.map((s: any) => <option key={s.id} value={`site:${s.id}`}>Site {s.code} — {s.name}</option>)}
          {data.groups.map((g: any) => <option key={g.id} value={`group:${g.id}`}>Portfolio {g.code} — {g.name}</option>)}
        </select>
        <button className="primary" disabled={!roleKey || grant.busy}>Give role</button>
      </form>
      <ErrorNote message={grant.error ?? revoke.error} />
      <p className="faint">You can give only what you hold yourself, at the place you hold it. Removing your own roles is not allowed.</p>

      <h3>Single sign-on identity</h3>
      {user.sso ? (
        <div className="row"><span>Linked to <code>{user.sso.subject}</code> at <code>{user.sso.issuer}</code></span><button disabled={unlink.busy} onClick={() => void unlink.run()}>Unlink</button></div>
      ) : (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void link.run(); }}>
          <span className="faint">Not linked yet{data.sso?.enabled && data.sso.linkByEmail ? ': linked automatically by email at first sign-in.' : '.'}</span>
          <input aria-label="Identity provider address" placeholder="Provider address (issuer)" value={issuer} onChange={(e) => setIssuer(e.target.value)} style={{ flex: '1 1 240px' }} />
          <input aria-label="Subject" placeholder="Subject (the provider's id for the person)" value={subject} onChange={(e) => setSubject(e.target.value)} required style={{ flex: '1 1 240px' }} />
          <button disabled={link.busy || !subject.trim()}>Link identity</button>
        </form>
      )}
      <ErrorNote message={link.error ?? unlink.error} />
      <p className="faint">Changed identity provider? Unlink people, then change the provider under Sign-in; with "link by email" on they are matched again at their next sign-in.</p>
      <p className="faint">{user.activeTokens} active API token{user.activeTokens === 1 ? '' : 's'}. Manage them on the Tokens tab.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function RolesTab() {
  const { data, loading, error, reload } = useApi<any>('/api/admin-roles');
  const [edit, setEdit] = useState<{ id?: string; name: string; description: string; permissions: string[] } | null>(null);
  const [view, setView] = useState<string | null>(null);
  const save = useAction(async () => {
    const e = edit!;
    const body = { name: e.name, description: e.description || null, permissions: e.permissions };
    if (e.id) await api.put(`/api/admin-roles/${e.id}`, body); else await api.post('/api/admin-roles', body);
    setEdit(null); await reload();
  });
  const remove = useAction(async (r: any) => {
    if (!window.confirm(`Delete the role "${r.name}"? This cannot be undone.`)) return;
    await api.delete(`/api/admin-roles/${r.id}`); setView(null); await reload();
  });
  return (
    <Async loading={loading && !data} error={error}>{() => {
      const roles: any[] = data.roles;
      const areas = [...new Set<string>(data.permissions.map((p: any) => p.area))];
      const shown = roles.find((r) => r.id === view);
      return (
        <>
          <div className="card stack">
            <div className="spread"><h2>Roles</h2><button onClick={() => setEdit({ name: '', description: '', permissions: [] })}>New company role</button></div>
            <p className="faint">Starter roles come with the product and cannot be changed. A company role is a named set of permissions you choose; it can be given like any other role. To adjust a starter role, copy it into a new company role.</p>
            <Table rows={roles} rowKey={(r) => r.id} tools={false}
              columns={[{ key: 'name', label: 'Role', render: (r) => <strong>{r.name}</strong> },
                { key: 'custom', label: 'Kind', value: (r) => (r.custom ? 'Company role' : 'Starter'), render: (r) => <Pill label={r.custom ? 'Company role' : 'Starter'} tone={r.custom ? 'info' : 'neutral'} /> },
                { key: 'permissions', label: 'Permissions', numeric: true, value: (r) => r.permissions.length, render: (r) => r.permissions.length },
                { key: 'users', label: 'People', numeric: true },
                { key: 'act', label: '', plain: true, render: (r) => <button className="link" aria-label={`View ${r.name}`} onClick={() => setView(view === r.id ? null : r.id)}>{view === r.id ? 'Hide' : 'View'}</button> }]} />
          </div>
          {shown && (
            <section className="card stack" aria-label={`${shown.name} permissions`}>
              <div className="spread"><h2>{shown.name}</h2>
                <span className="row">
                  <button onClick={() => setEdit({ name: shown.custom ? shown.name : `${shown.name} (copy)`, description: shown.description ?? '', permissions: shown.permissions, ...(shown.custom ? { id: shown.id } : {}) })}>{shown.custom ? 'Edit' : 'Copy to a company role'}</button>
                  {shown.custom && <button disabled={remove.busy} onClick={() => void remove.run(shown)}>Delete</button>}
                </span></div>
              {shown.description && <p>{shown.description}</p>}
              <ErrorNote message={remove.error} />
              {areas.filter((a) => data.permissions.some((p: any) => p.area === a && shown.permissions.includes(p.key))).map((a) => (
                <p key={a}><strong>{humanize(a)}</strong>: {shown.permissions.filter((p: string) => p.split('.')[0] === a).map((p: string) => p.slice(a.length + 1)).join(', ')}</p>
              ))}
              <p className="faint">Permission names are explained in the guide's permissions table.</p>
            </section>
          )}
          {edit && (
            <form className="card stack" aria-label="Company role" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
              <h2>{edit.id ? `Edit ${edit.name}` : 'New company role'}</h2>
              <div className="row">
                <input id="role-name" aria-label="Role name" placeholder="Role name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required minLength={2} style={{ flex: '1 1 220px' }} />
                <input aria-label="What it is for" placeholder="What it is for (optional)" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} style={{ flex: '2 1 280px' }} />
                {!edit.id && (
                  <select aria-label="Start from" value="" onChange={(e) => { const r = roles.find((x) => x.key === e.target.value); if (r) setEdit({ ...edit, permissions: r.permissions.filter((p: string) => data.permissions.find((x: any) => x.key === p)?.held) }); }} style={{ width: 'auto' }}>
                    <option value="">Start from an existing role…</option>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                  </select>
                )}
              </div>
              <p className="faint">{edit.permissions.length} permission{edit.permissions.length === 1 ? '' : 's'} chosen. You can include only permissions you hold yourself (the others are greyed out); the exception is Administrator access.</p>
              {areas.map((a) => (
                <fieldset key={a} style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend><strong>{humanize(a)}</strong></legend>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
                    {data.permissions.filter((p: any) => p.area === a).map((p: any) => (
                      <label key={p.key} className="row" style={{ gap: 4 }}>
                        <input type="checkbox" disabled={!p.held} checked={edit.permissions.includes(p.key)}
                          onChange={(e) => setEdit({ ...edit, permissions: e.target.checked ? [...edit.permissions, p.key] : edit.permissions.filter((x) => x !== p.key) })} />
                        {p.key.slice(a.length + 1)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              {edit.permissions.includes('tenant.admin') && <p className="notice warn">Administrator access lets the people holding this role change everything on this page, including who else is an administrator.</p>}
              <div className="row"><button className="primary" disabled={save.busy || !edit.permissions.length}>Save role</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
              <ErrorNote message={save.error} />
            </form>
          )}
        </>
      );
    }}</Async>
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function TokensTab() {
  const [all, setAll] = useState(false);
  const { data, loading, error, reload } = useApi<any>(`/api/admin-tokens${all ? '?all=true' : ''}`);
  const users = useApi<any>('/api/admin-users');
  const [userId, setUserId] = useState('');
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('90');
  const [issued, setIssued] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const issue = useAction(async () => {
    const t = await api.post('/api/admin-tokens', { userId, label, expiresInDays: days === 'never' ? null : Number(days) });
    setIssued(t); setCopied(false); setLabel(''); await reload(); await users.reload();
  });
  const revoke = useAction(async (t: any) => {
    if (!window.confirm(`Revoke "${t.label}" (${t.userName})? Anything using it stops working immediately.`)) return;
    await api.post(`/api/admin-tokens/${t.id}/revoke`); await reload();
  });
  const copy = async () => { try { await navigator.clipboard.writeText(issued.token); setCopied(true); } catch { setCopied(false); } };
  const active = (users.data?.users ?? []).filter((u: any) => u.status === 'active');
  return (
    <>
      <form className="card stack" aria-label="Issue a token" onSubmit={(e) => { e.preventDefault(); void issue.run(); }}>
        <h2>Issue a token</h2>
        <p className="faint">A token lets a script or another system act as one person, with all of that person's access. Issue it to a dedicated user with only the roles the job needs, not to a named employee.</p>
        <div className="row">
          <select id="token-user" aria-label="Acts as" value={userId} onChange={(e) => setUserId(e.target.value)} required style={{ width: 'auto' }}>
            <option value="">Acts as…</option>{active.map((u: any) => <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>)}
          </select>
          <input id="token-label" aria-label="What it is for" placeholder="What it is for (e.g. Payroll export)" value={label} onChange={(e) => setLabel(e.target.value)} required style={{ flex: '1 1 240px' }} />
          <select aria-label="Expires" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 'auto' }}>
            <option value="30">Expires in 30 days</option><option value="90">Expires in 90 days</option><option value="365">Expires in a year</option><option value="never">Never expires</option>
          </select>
          <button className="primary" disabled={issue.busy || !userId || !label.trim()}>Issue token</button>
        </div>
        <ErrorNote message={issue.error} />
      </form>
      {issued && (
        <section className="notice ok stack" role="status" aria-label="New token">
          <strong>Copy this token now. It is shown once and cannot be shown again; only a fingerprint is kept.</strong>
          <div className="row"><code id="new-token" style={{ wordBreak: 'break-all' }}>{issued.token}</code><button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button><button type="button" onClick={() => setIssued(null)}>I have stored it</button></div>
          <span className="faint">“{issued.label}”{issued.expiresAt ? `, expires ${fmtDateTime(issued.expiresAt)}` : ', does not expire'}.</span>
        </section>
      )}
      <div className="card stack">
        <div className="spread"><h2>Tokens</h2><label className="row"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show revoked and expired</label></div>
        <Async loading={loading && !data} error={error}>{() => (
          <>
            {!data.tokensAllowed && <p className="notice warn">Single sign-on is set to refuse API tokens, so none of these work at the moment. Change it under Sign-in if integrations need them.</p>}
            <Table rows={data.tokens} rowKey={(t) => t.id} empty="No tokens yet." tools={false}
              columns={[{ key: 'label', label: 'Used for', render: (t) => <strong>{t.label}</strong> },
                { key: 'userName', label: 'Acts as', render: (t) => <>{t.userName}{t.userStatus !== 'active' && <> <Pill label="disabled" tone="bad" /></>}</> },
                { key: 'createdAt', label: 'Created', value: (t) => t.createdAt, render: (t) => <>{fmtDateTime(t.createdAt)}{t.createdBy ? <span className="faint"> by {t.createdBy}</span> : null}</> },
                { key: 'lastUsedAt', label: 'Last used', value: (t) => t.lastUsedAt ?? '', render: (t) => (t.lastUsedAt ? fmtDateTime(t.lastUsedAt) : <span className="faint">Never</span>) },
                { key: 'expiresAt', label: 'Expires', value: (t) => t.expiresAt ?? '', render: (t) => (t.expiresAt ? fmtDateTime(t.expiresAt) : <span className="faint">Never</span>) },
                { key: 'state', label: 'Status', render: (t) => <Pill value={t.state} tone={t.state === 'active' ? 'good' : 'bad'} /> },
                { key: 'act', label: '', plain: true, render: (t) => t.state === 'active' ? <button className="link" aria-label={`Revoke ${t.label}`} disabled={revoke.busy} onClick={() => void revoke.run(t)}>Revoke</button> : null }]} />
            {data.hidden > 0 && !all && <p className="faint">{data.hidden} revoked or expired token{data.hidden === 1 ? ' is' : 's are'} hidden.</p>}
            <ErrorNote message={revoke.error} />
          </>
        )}</Async>
        <h3>Rotating a token</h3>
        <ol>
          <li>Issue a new token for the same person with the same label.</li>
          <li>Put it into the system that uses the old one.</li>
          <li>Check that the new token's <em>Last used</em> shows a recent time (it updates about once a minute).</li>
          <li>Revoke the old token. Revoked tokens stop working at once.</li>
        </ol>
      </div>
    </>
  );
}
