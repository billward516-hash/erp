import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const KINDS = ['property', 'store', 'plant', 'warehouse', 'office', 'other'];
const addressText = (a: any) => [a?.line1, a?.city, a?.region].filter(Boolean).join(', ');
interface SiteEdit { id?: string; code: string; name: string; kind: string; timezone: string; line1: string; city: string; region: string; postal: string; active: boolean }
const blank: SiteEdit = { code: '', name: '', kind: 'property', timezone: 'America/New_York', line1: '', city: '', region: '', postal: '', active: true };

/** Properties, stores and plants; groups (portfolio, region, district); per-site request links. */
export function Sites() {
  const { can } = useAuth();
  const admin = can('tenant.admin');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useApi<any[]>(`/api/sites?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(q ? { q } : {}) })}`);
  const groups = useApi<any[]>('/api/site-groups');
  const [edit, setEdit] = useState<SiteEdit | null>(null);
  const [links, setLinks] = useState<any | null>(null);
  const save = useAction(async () => {
    const e = edit!;
    const body = { code: e.code, name: e.name, kind: e.kind, timezone: e.timezone, active: e.active, address: { line1: e.line1 || null, city: e.city || null, region: e.region || null, postal: e.postal || null } };
    if (e.id) await api.put(`/api/sites/${e.id}`, body); else await api.post('/api/sites', body);
    setEdit(null); await reload();
  });
  const rows = data ?? [];
  return (
    <>
      <PageHead eyebrow="Sites" title="Properties, stores and plants" sub="Every site, its group, and the work at each. People see the sites their roles cover; a role granted on a group covers every site in it." />
      <Kpis items={[{ label: 'Sites', value: rows.length }, { label: 'Spaces (units, suites, areas)', value: rows.reduce((s, r) => s + (r.spaces ?? 0), 0) },
        { label: 'Open work', value: rows.reduce((s, r) => s + (r.open_work ?? 0), 0) }, { label: 'Open requests', value: rows.reduce((s, r) => s + (r.open_requests ?? 0), 0), tone: rows.some((r) => r.open_requests) ? 'watch' : undefined }]} />
      <div className="card stack">
        <div className="row">
          <select id="site-kind" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All kinds</option>{KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
          </select>
          <input id="site-q" aria-label="Search sites" placeholder="Search code, name or city" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} />
          {admin && <button onClick={() => setEdit({ ...blank })}>Add site</button>}
        </div>
        <Async loading={loading && !data} error={error}>{() => (
          <Table rows={rows} rowKey={(r) => r.id} empty="No sites match." exception={(r) => r.open_requests > 0}
            columns={[{ key: 'code', label: 'Code', render: (r) => <strong>{r.code}</strong> }, { key: 'name', label: 'Name', render: (r) => <>{r.name}{!r.active && <> <Pill label="inactive" /></>}</> },
              { key: 'kind', label: 'Kind', render: (r) => humanize(r.kind) }, { key: 'address', label: 'Address', render: (r) => addressText(r.address) || '—' },
              { key: 'groups', label: 'Group', render: (r) => r.groups.join(', ') || '—' }, { key: 'spaces', label: 'Spaces', numeric: true }, { key: 'assets', label: 'Equipment', numeric: true },
              { key: 'open_work', label: 'Open work', numeric: true }, { key: 'open_requests', label: 'Requests', numeric: true },
              { key: 'act', label: '', render: (r) => <span className="row">
                {can('work_orders.manage', r.id) && <button className="link" onClick={() => setLinks(r)}>Request links</button>}
                {admin && <button className="link" onClick={() => setEdit({ id: r.id, code: r.code, name: r.name, kind: r.kind, timezone: r.timezone, active: r.active, line1: r.address?.line1 ?? '', city: r.address?.city ?? '', region: r.address?.region ?? '', postal: r.address?.postal ?? '' })}>Edit</button>}
              </span> }]} />
        )}</Async>
      </div>
      {edit && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <h2>{edit.id ? `Edit ${edit.code}` : 'Add a site'}</h2>
          <div className="row">
            <input id="site-code" aria-label="Code" placeholder="Code" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} required style={{ width: 140 }} />
            <input id="site-name" aria-label="Name" placeholder="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required style={{ flex: '1 1 220px' }} />
            <select aria-label="Site kind" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} style={{ width: 'auto' }}>{KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select>
            <input aria-label="Time zone" value={edit.timezone} onChange={(e) => setEdit({ ...edit, timezone: e.target.value })} style={{ width: 190 }} />
          </div>
          <div className="row">
            <input aria-label="Street" placeholder="Street" value={edit.line1} onChange={(e) => setEdit({ ...edit, line1: e.target.value })} style={{ flex: '2 1 220px' }} />
            <input aria-label="City" placeholder="City" value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} style={{ flex: '1 1 140px' }} />
            <input aria-label="State" placeholder="State" value={edit.region} onChange={(e) => setEdit({ ...edit, region: e.target.value })} style={{ width: 90 }} />
            <input aria-label="Postal code" placeholder="ZIP" value={edit.postal} onChange={(e) => setEdit({ ...edit, postal: e.target.value })} style={{ width: 110 }} />
            {edit.id && <label className="row"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
          </div>
          <div className="row"><button className="primary" disabled={save.busy}>Save</button><button type="button" onClick={() => setEdit(null)}>Cancel</button><ErrorNote message={save.error} /></div>
          <p className="faint">Many sites at once: Data import → "Sites (properties, stores, plants)" takes a property or store list in the format you already have.</p>
        </form>
      )}
      {links && <RequestLinks site={links} onClose={() => setLinks(null)} />}
      {admin && <Groups groups={groups.data ?? []} sites={rows} onDone={() => { void groups.reload(); void reload(); }} />}
    </>
  );
}

function Groups({ groups, sites, onDone }: { groups: any[]; sites: any[]; onDone: () => void }) {
  const [g, setG] = useState<{ id?: string; code: string; name: string; kind: string; facilityIds: string[] } | null>(null);
  const save = useAction(async () => {
    const body = { code: g!.code, name: g!.name, kind: g!.kind, facilityIds: g!.facilityIds };
    if (g!.id) await api.put(`/api/site-groups/${g!.id}`, body); else await api.post('/api/site-groups', body);
    setG(null); onDone();
  });
  return (
    <section className="card stack">
      <div className="spread"><h2>Groups</h2>{!g && <button onClick={() => setG({ code: '', name: '', kind: 'portfolio', facilityIds: [] })}>Add group</button>}</div>
      <Table rows={groups} rowKey={(x) => x.id} empty="No groups. Group sites into portfolios, regions or districts to grant a manager all of them at once."
        columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind', render: (x) => humanize(x.kind) }, { key: 'sites', label: 'Sites', render: (x) => x.sites.join(', ') || '—' },
          { key: 'e', label: '', render: (x) => <button className="link" onClick={() => setG({ id: x.id, code: x.code, name: x.name, kind: x.kind, facilityIds: x.facility_ids })}>Edit</button> }]} />
      {g && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="row">
            <input id="group-code" aria-label="Group code" placeholder="Code" value={g.code} onChange={(e) => setG({ ...g, code: e.target.value })} required style={{ width: 140 }} />
            <input id="group-name" aria-label="Group name" placeholder="Name" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} required style={{ flex: '1 1 200px' }} />
            <select aria-label="Group kind" value={g.kind} onChange={(e) => setG({ ...g, kind: e.target.value })} style={{ width: 'auto' }}>
              <option value="portfolio">Portfolio</option><option value="region">Region</option><option value="district">District</option><option value="other">Other</option>
            </select>
          </div>
          <div className="row">{sites.map((s) => <label key={s.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={g.facilityIds.includes(s.id)}
            onChange={(e) => setG({ ...g, facilityIds: e.target.checked ? [...g.facilityIds, s.id] : g.facilityIds.filter((x) => x !== s.id) })} />{s.code}</label>)}</div>
          <div className="row"><button className="primary" disabled={save.busy}>Save group</button><button type="button" onClick={() => setG(null)}>Cancel</button><ErrorNote message={save.error} /></div>
          <p className="faint">People with a role granted on the group get the new member sites at their next sign-in.</p>
        </form>
      )}
    </section>
  );
}

function RequestLinks({ site, onClose }: { site: any; onClose: () => void }) {
  const { data, reload } = useApi<any[]>(`/api/sites/${site.id}/request-links`);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction(async () => { const l = await api.post(`/api/sites/${site.id}/request-links`, { label }); setCreated(`${window.location.origin}/r/${l.token}`); setLabel(''); await reload(); });
  const revoke = useAction(async (id: string) => { await api.post(`/api/request-links/${id}/revoke`, {}); await reload(); });
  return (
    <section className="card stack">
      <div className="spread"><h2>Request links for {site.code} {site.name}</h2><button onClick={onClose}>Close</button></div>
      <p className="muted">Anyone with the link can report a problem at this site without signing in (residents, store staff). Post it in a lobby or print it as a QR code. Requests land in Work orders → Requests.</p>
      {created && <div className="notice"><strong>Copy this link now</strong> (it is not shown again): <span className="mono" id="request-link-url">{created}</span></div>}
      <Table rows={data ?? []} rowKey={(l) => l.id} empty="No links yet."
        columns={[{ key: 'label', label: 'Label' }, { key: 'created_at', label: 'Created', render: (l) => `${fmtDateTime(l.created_at)} by ${l.created_by}` }, { key: 'requests', label: 'Requests', numeric: true },
          { key: 'active', label: '', render: (l) => (l.active ? <button className="link" onClick={() => revoke.run(l.id)}>Revoke</button> : <Pill label="revoked" />) }]} />
      <form className="row" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
        <input id="link-label" aria-label="Link label" placeholder='Label, e.g. "Residents, lobby poster"' value={label} onChange={(e) => setLabel(e.target.value)} required style={{ flex: '1 1 260px' }} />
        <button disabled={create.busy}>Create link</button><ErrorNote message={create.error ?? revoke.error} />
      </form>
    </section>
  );
}

/** The no-sign-in form behind a request link. Talks only to /public/requests/:token. */
export function PublicRequest() {
  const { token } = useParams();
  const [form, setForm] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ placeId: '', description: '', name: '', contact: '', entryPermission: '', urgent: false });
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!form && !err) {
    fetch(`/public/requests/${encodeURIComponent(token ?? '')}`).then(async (r) => (r.ok ? setForm(await r.json()) : setErr('This link is not active. Please contact the office.'))).catch(() => setErr('Could not load the form.'));
  }
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/public/requests/${encodeURIComponent(token ?? '')}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ placeId: f.placeId, description: f.description, name: f.name, contact: f.contact, urgent: f.urgent, entryPermission: f.entryPermission === '' ? undefined : f.entryPermission === 'yes' }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error?.message ?? 'Could not send the request.');
      setDone(b.reference);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <main className="public-page" style={{ maxWidth: 560, margin: '0 auto', padding: 16 }}>
      {done ? (
        <section className="card stack">
          <h1 style={{ margin: 0 }}>Thank you</h1>
          <p>Your request has been sent to the maintenance team. Your reference is <strong className="mono">{done}</strong>.</p>
          <p className="muted">If it is an emergency (fire, gas, flooding), call the emergency number posted at the site.</p>
        </section>
      ) : !form ? <section className="card">{err ?? 'Loading…'}</section> : (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="eyebrow">{form.site}</div>
          <h1 style={{ margin: 0 }}>Report a problem</h1>
          <label className="field">Where is the problem?
            <select id="pub-place" value={f.placeId} onChange={(e) => setF({ ...f, placeId: e.target.value })} required>
              <option value="">Choose…</option>{form.places.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select></label>
          <label className="field">What is wrong?<textarea id="pub-description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required minLength={5} rows={4} /></label>
          <label className="field">Your name<input id="pub-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="field">Phone or email<input id="pub-contact" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} required /></label>
          {form.kind === 'property' && (
            <label className="field">May we enter if you are not home?
              <select id="pub-entry" value={f.entryPermission} onChange={(e) => setF({ ...f, entryPermission: e.target.value })}>
                <option value="">Not sure</option><option value="yes">Yes</option><option value="no">No, call me first</option>
              </select></label>
          )}
          <label className="row"><input id="pub-urgent" type="checkbox" checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })} /> Urgent (water leaking, no heat, a door that will not lock)</label>
          <div className="row"><button className="primary" disabled={busy}>Send request</button><ErrorNote message={err} /></div>
        </form>
      )}
    </main>
  );
}
