import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../format';
import { useAction, useApi } from '../hooks';

const VIEWABLE = (t: string) => t === 'application/pdf' || t.startsWith('image/') || t.startsWith('text/');

/** A link to read a controlled document in the browser (the version in force unless one is named). */
export function DocLink({ id, versionId, children }: { id: string; versionId?: string | null; children: React.ReactNode }) {
  return <Link to={`/documents/${id}${versionId ? `?version=${versionId}` : ''}`}>{children}</Link>;
}

/**
 * Controlled document viewer. Shows the approved version in force (or the version asked for, with a banner when it is
 * not the one in force), in the browser where the format allows: PDF, images, text. Every view and print carries
 * the controlled-copy notice; printed copies are stamped uncontrolled with the print date (print stylesheet).
 */
export function DocumentView() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { data: d, loading, error, reload } = useApi<any>(`/api/documents/${id}`);
  const versionId = params.get('version') ?? d?.current_version_id ?? d?.versions?.[0]?.id ?? null;
  const v = d?.versions?.find((x: any) => x.id === versionId);
  const [file, setFile] = useState<{ url: string; type: string; text?: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  useEffect(() => {
    if (!v || !VIEWABLE(v.mime_type)) { setFile(null); return; }
    let url: string | null = null; let live = true;
    setFile(null); setFileError(null);
    api.blob(`/api/document-versions/${v.id}/download`).then((f) => { url = f.url; if (live) setFile(f); else URL.revokeObjectURL(f.url); }).catch((e) => live && setFileError(e.message));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [v?.id]);
  const printed = new Date().toLocaleDateString(undefined, { dateStyle: 'medium' });
  return (
    <Async loading={loading && !d} error={error}>{() => {
      const inForce = v && v.id === d.current_version_id;
      return (
        <>
          <PageHead eyebrow={`Document · ${humanize(d.doc_type)}${d.safety_critical ? ' · safety-critical' : ''}`} title={<>{d.doc_number} <span className="muted" style={{ fontWeight: 400 }}>{d.title}</span></>}
            sub={v ? <>Revision {v.revision} ({v.version_label}){v.approved_at ? <> · approved {fmtDate(v.approved_at)}{v.approved_by ? ` by ${v.approved_by}` : ''}</> : null}</> : 'No version you can see'}
            actions={<>{v && <Pill tone={inForce ? 'good' : v.status === 'draft' || v.status === 'in_review' ? 'info' : 'bad'} label={inForce ? 'In force' : humanize(v.status)} />}
              {v && <button onClick={() => api.download(`/api/document-versions/${v.id}/download`, v.file_name)}>Download</button>}
              {v && VIEWABLE(v.mime_type) && <button onClick={() => window.print()}>Print</button>}</>} />
          {d.pending_version_id && <div className="card" role="status">Revision {d.versions.find((x: any) => x.id === d.pending_version_id)?.version_label} is approved and takes effect on {fmtDate(d.versions.find((x: any) => x.id === d.pending_version_id)?.effective_on)}; until then the revision in force applies.</div>}
          {v && !inForce && (
            <div className="card" role="alert" style={{ borderLeft: '3px solid var(--bad)' }}>
              <strong>{v.status === 'draft' || v.status === 'in_review' ? 'Draft: not approved for use.' : v.id === d.pending_version_id ? `Approved, effective ${fmtDate(v.effective_on)}: not in force yet.` : v.status === 'obsolete' ? 'Obsolete: do not use.' : 'Superseded: do not work to this revision.'}</strong>{' '}
              {d.current_version_id && <button className="link" onClick={() => setParams({})}>Show the revision in force</button>}
            </div>
          )}
          <div className="controlled-notice" aria-label="Controlled copy notice">
            <span className="screen-only">Controlled copy online. Printed copies are uncontrolled: check the revision here before use.</span>
            <span className="print-only">UNCONTROLLED WHEN PRINTED · {d.doc_number} rev {v?.revision} · printed {printed}</span>
          </div>
          {v && (
            <section className="card doc-view">
              {!VIEWABLE(v.mime_type) ? <p className="muted">{v.file_name} ({v.mime_type}) cannot be shown in the browser. Use Download.</p>
                : fileError ? <ErrorNote message={fileError} />
                  : !file ? <p className="muted">Loading {v.file_name}…</p>
                    : file.type === 'application/pdf' ? <iframe title={`${d.doc_number} rev ${v.revision}`} src={file.url} style={{ width: '100%', height: '80vh', border: 0 }} />
                      : file.type.startsWith('image/') ? <img src={file.url} alt={`${d.doc_number} ${d.title}, revision ${v.revision}`} style={{ maxWidth: '100%' }} />
                        : <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{file.text}</pre>}
            </section>
          )}
          <section className="card stack screen-only">
            <h2>About this document</h2>
            <p className="muted">{d.type_label} · {d.facility_code ?? 'Company-wide'}{d.folder_name ? ` · folder ${d.folder_name}` : ''} · owner {d.owner_name ?? '—'} · read by {d.restricted ? 'restricted readers' : d.readRolesInForce.length ? d.readRolesInForce.map(humanize).join(', ') : 'everyone who sees documents at its site'}
              {d.origin === 'external' && <> · issued by <strong>{d.issuer}</strong>{d.issuer_doc_number ? ` as ${d.issuer_doc_number}` : ''}</>}{d.status === 'obsolete' && <> · <strong>obsolete</strong> ({d.obsolete_reason})</>}</p>
            {d.description && <p>{d.description}</p>}
          </section>
          {d.canManage && <Manage d={d} reload={reload} />}
          {d.versions.length > 1 && (
            <section className="card stack screen-only">
              <h2>Revisions</h2>
              <Table rows={d.versions} rowKey={(x) => x.id} onRow={(x) => setParams({ version: x.id })}
                columns={[{ key: 'revision', label: 'Rev', numeric: true, render: (x) => <strong>{x.revision}</strong> }, { key: 'version_label', label: 'Label' },
                  { key: 'status', label: 'Status', render: (x) => <Pill tone={x.id === d.current_version_id ? 'good' : 'neutral'} label={x.id === d.current_version_id ? 'In force' : humanize(x.status)} /> },
                  ...(d.origin === 'external' ? [{ key: 'issuer_revision', label: 'Issuer rev' }, { key: 'received_on', label: 'Received', render: (x: any) => fmtDate(x.received_on) }] : []),
                  { key: 'change_summary', label: 'What changed and why' }, { key: 'created_by', label: 'Author', render: (x) => x.created_by ?? '' },
                  { key: 'approved_at', label: 'Approved', render: (x) => x.approved_at ? `${fmtDateTime(x.approved_at)}${x.approved_by ? ` by ${x.approved_by}` : ''}` : '' },
                  { key: 'effective_on', label: 'Effective', render: (x) => fmtDate(x.effective_on) }, { key: 'sha256', label: 'Checksum', render: (x) => <code title={x.sha256}>{x.sha256.slice(0, 10)}…</code> }]} />
            </section>
          )}
        </>
      );
    }}</Async>
  );
}

const ORIGIN_TYPES = new Set(['customer_spec', 'industry_standard']);

/** The document server's master list (D-168): answer first, filters, folders, and a way to start a document. */
export function Repository() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [f, setF] = useState({ q: '', docType: '', origin: '', status: '', folderId: '' });
  const [q, setQ] = useState(f);
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  const overview = useApi<any>('/api/document-repository');
  const list = useApi<any[]>(`/api/documents?limit=500${qs ? `&${qs}` : ''}`);
  return (
    <>
      <PageHead eyebrow="Documents" title="Document control"
        sub="SOPs, work instructions, procedures, methods, technical requirements, customer specifications and standards: each revision approved by someone other than its author, effective on its date, and every opening logged."
        actions={<>{can('reports.view') && <Link to="/reports/document-master-list">Master list</Link>}{can('documents.manage') && <button className="primary" onClick={() => nav('/documents/new')}>New document</button>}</>} />
      <Async loading={overview.loading && !overview.data} error={overview.error}>{() => {
        const o = overview.data; const c = o.counts;
        return (
          <>
            <p className="answer">{o.answer}</p>
            <Kpis items={[{ label: 'Controlled documents', value: c.total }, { label: 'External', value: c.external, note: 'customer specs, standards' },
              { label: 'In review', value: c.inReview, tone: c.inReview ? 'watch' : undefined }, { label: 'Waiting for effective date', value: c.pending },
              { label: 'Waiting on me', value: c.waitingOnMe, tone: c.waitingOnMe ? 'watch' : undefined, note: c.waitingOnMe ? 'see Approvals' : undefined }]} />
            <section className="card stack">
              <form className="row" style={{ flexWrap: 'wrap', alignItems: 'end', gap: 8 }} onSubmit={(e) => { e.preventDefault(); setQ(f); }} data-no-draft>
                <label className="field" style={{ flex: '2 1 220px' }}>Find<input id="doc-q" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Number, title, issuer number or text" /></label>
                <label className="field">Kind<select id="doc-kind" value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })}><option value="">All kinds</option>
                  {o.types.map((t: any) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
                <label className="field">Origin<select value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })}><option value="">Internal and external</option><option value="internal">Internal</option><option value="external">External</option></select></label>
                <label className="field">Folder<select value={f.folderId} onChange={(e) => setF({ ...f, folderId: e.target.value })}><option value="">All folders</option>
                  {o.folders.map((x: any) => <option key={x.id} value={x.id}>{x.name} ({x.documents})</option>)}</select></label>
                <label className="field">Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Active</option><option value="in_review">In review</option>
                  <option value="pending">Waiting for effective date</option><option value="obsolete">Obsolete</option></select></label>
                <button>Search</button>
              </form>
              <Async loading={list.loading && !list.data} error={list.error}>{() => (
                <Table rows={list.data!} rowKey={(r) => r.id} onRow={(r) => nav(`/documents/${r.id}`)} empty="No documents match."
                  exception={(r) => !r.current_version_id}
                  columns={[{ key: 'doc_number', label: 'Number', render: (r) => <strong>{r.doc_number}</strong> }, { key: 'title', label: 'Title' }, { key: 'type_label', label: 'Kind' },
                    { key: 'issuer', label: 'Issuer', render: (r) => r.origin === 'external' ? `${r.issuer}${r.issuer_doc_number ? ` ${r.issuer_doc_number}` : ''}${r.current_issuer_revision ? ` rev ${r.current_issuer_revision}` : ''}` : '' },
                    { key: 'facility_code', label: 'Site', render: (r) => r.facility_code ?? 'Company' }, { key: 'current_version_label', label: 'Rev', render: (r) => r.current_version_label ?? '—' },
                    { key: 'current_effective_on', label: 'Effective', render: (r) => fmtDate(r.current_effective_on ?? r.current_approved_at) },
                    { key: 'next', label: 'Next', render: (r) => r.pending_version_label ? <Pill tone="info" label={`Rev ${r.pending_version_label} from ${fmtDate(r.pending_effective_on)}`} />
                      : r.open_version_status ? <Pill tone={r.open_version_status === 'in_review' ? 'watch' : undefined} label={humanize(r.open_version_status)} /> : '' },
                    { key: 'owner_name', label: 'Owner' }]} />
              )}</Async>
            </section>
            {can('documents.manage') && <Folders folders={o.folders} reload={overview.reload} />}
          </>
        );
      }}</Async>
    </>
  );
}

function Folders({ folders, reload }: { folders: any[]; reload: () => Promise<void> }) {
  const people = useApi<any>('/api/document-people');
  const [f, setF] = useState<{ name: string; parentId: string; readRoles: string[] } | null>(null);
  const save = useAction(async () => { await api.post('/api/document-folders', { name: f!.name, parentId: f!.parentId || null, readRoles: f!.readRoles }); setF(null); await reload(); });
  return (
    <section className="card stack">
      <div className="spread"><h2>Folders</h2>{!f && <button onClick={() => setF({ name: '', parentId: '', readRoles: [] })}>New folder</button>}</div>
      <Table rows={folders} rowKey={(x) => x.id} empty="No folders yet; documents can live outside folders."
        columns={[{ key: 'name', label: 'Folder' }, { key: 'parent', label: 'Inside', render: (x) => folders.find((p) => p.id === x.parent_id)?.name ?? '' },
          { key: 'read_roles', label: 'Read by', render: (x) => x.read_roles.length ? x.read_roles.map(humanize).join(', ') : 'Everyone (or its parent\'s roles)' }, { key: 'documents', label: 'Documents', numeric: true }]} />
      {f && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="form-grid">
            <label className="field">Name<input id="folder-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label className="field">Inside<select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}><option value="">Top level</option>{folders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          </div>
          <fieldset className="row" style={{ flexWrap: 'wrap', gap: 10, border: 0, padding: 0 }}><legend className="muted">Only these roles may read its documents (none ticked: everyone)</legend>
            {(people.data?.roles ?? []).map((r: any) => <label key={r.key} className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.readRoles.includes(r.key)}
              onChange={(e) => setF({ ...f, readRoles: e.target.checked ? [...f.readRoles, r.key] : f.readRoles.filter((k) => k !== r.key) })} /> {r.name}</label>)}</fieldset>
          <div className="row"><button className="primary" disabled={save.busy}>Save folder</button><button type="button" onClick={() => setF(null)}>Cancel</button></div>
          <ErrorNote message={save.error} />
        </form>
      )}
    </section>
  );
}

/** Starts a controlled document and uploads its first version. */
export function NewDocument() {
  const nav = useNavigate();
  const sites = useApi<any[]>('/api/facilities');
  const overview = useApi<any>('/api/document-repository');
  const [f, setF] = useState({ docType: 'sop', title: '', facilityId: '', folderId: '', docNumber: '', description: '', issuer: '', issuerDocNumber: '', versionLabel: 'A', issuerRevision: '', receivedOn: '', restricted: false, safetyCritical: false });
  const [file, setFile] = useState<File | null>(null);
  const external = ORIGIN_TYPES.has(f.docType);
  const save = useAction(async () => {
    const d = await api.post('/api/documents', { docType: f.docType, title: f.title, facilityId: f.facilityId || null, folderId: f.folderId || null, docNumber: f.docNumber || null,
      description: f.description || null, issuer: external ? f.issuer : null, issuerDocNumber: external ? f.issuerDocNumber || null : null, restricted: f.restricted, safetyCritical: f.safetyCritical });
    if (file) {
      const qs = new URLSearchParams({ versionLabel: f.versionLabel, fileName: file.name, ...(external ? { issuerRevision: f.issuerRevision, ...(f.receivedOn ? { receivedOn: f.receivedOn } : {}) } : {}) });
      await api.upload(`/api/documents/${d.id}/versions?${qs}`, file);
    }
    nav(`/documents/${d.id}`);
  });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <>
      <PageHead eyebrow="Document control" title="New document" sub="The first version is a draft until someone other than you approves it." />
      <form className="card form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="form-grid">
          <label className="field">Kind<select id="nd-kind" value={f.docType} onChange={set('docType')}>{(overview.data?.types ?? []).map((t: any) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
          <label className="field">Number<input id="nd-number" value={f.docNumber} onChange={set('docNumber')} placeholder="Leave empty to number it automatically" /></label>
          <label className="field">Site<select id="nd-site" value={f.facilityId} onChange={set('facilityId')}><option value="">Company-wide</option>{(sites.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
          <label className="field">Folder<select id="nd-folder" value={f.folderId} onChange={set('folderId')}><option value="">No folder</option>{(overview.data?.folders ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        </div>
        <label className="field">Title<input id="nd-title" value={f.title} onChange={set('title')} required /></label>
        {external && <div className="form-grid">
          <label className="field">Issued by<input id="nd-issuer" value={f.issuer} onChange={set('issuer')} required placeholder="Customer, supplier or standards body" /></label>
          <label className="field">Their number<input id="nd-issuer-number" value={f.issuerDocNumber} onChange={set('issuerDocNumber')} /></label>
          <label className="field">Their revision<input id="nd-issuer-rev" value={f.issuerRevision} onChange={set('issuerRevision')} required={!!file} /></label>
          <label className="field">Received<input id="nd-received" type="date" value={f.receivedOn} onChange={set('receivedOn')} /></label>
        </div>}
        <label className="field">Purpose and scope<textarea id="nd-description" value={f.description} onChange={set('description')} /></label>
        <div className="form-grid">
          <label className="field">First version file<input id="nd-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <label className="field">Our revision label<input id="nd-label" value={f.versionLabel} onChange={set('versionLabel')} required /></label>
        </div>
        <div className="row" style={{ gap: 12 }}><label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.restricted} onChange={set('restricted')} /> Restricted readers only</label>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.safetyCritical} onChange={set('safetyCritical')} /> Safety-critical</label></div>
        <div><button className="primary" disabled={save.busy}>Create document</button></div>
        <ErrorNote message={save.error} />
      </form>
    </>
  );
}

/** New revisions, review and approval, withdrawal and obsolescence, and the document's history (D-168). */
function Manage({ d, reload }: { d: any; reload: () => Promise<void> }) {
  const { me } = useAuth();
  const people = useApi<any>(`/api/document-people${d.facility_id ? `?facilityId=${d.facility_id}` : ''}`);
  const open = d.versions.find((x: any) => x.status === 'draft' || x.status === 'in_review');
  const [rev, setRev] = useState({ label: '', reason: '', issuerRevision: '', receivedOn: '' }); const [file, setFile] = useState<File | null>(null);
  const [sub, setSub] = useState({ reviewers: [] as string[], approverId: '', effectiveOn: '' });
  const [reason, setReason] = useState('');
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); await reload(); });
  const upload = () => act.run(async () => {
    const qs = new URLSearchParams({ versionLabel: rev.label, fileName: file!.name, changeSummary: rev.reason, ...(d.origin === 'external' ? { issuerRevision: rev.issuerRevision, ...(rev.receivedOn ? { receivedOn: rev.receivedOn } : {}) } : {}) });
    await api.upload(`/api/documents/${d.id}/versions?${qs}`, file!); setRev({ label: '', reason: '', issuerRevision: '', receivedOn: '' }); setFile(null);
  });
  const users = people.data?.users ?? [];
  const approvers = users.filter((u: any) => u.can_approve && u.id !== open?.created_by_id);
  return (
    <section className="card stack screen-only">
      <h2>Control</h2>
      {d.status === 'obsolete' ? <p className="muted">Obsolete since {fmtDate(d.obsoleted_at)}: {d.obsolete_reason}</p> : !open ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void upload(); }}>
          <h3>New revision</h3>
          <div className="form-grid">
            <label className="field">File<input id="rev-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></label>
            <label className="field">Revision label<input id="rev-label" value={rev.label} onChange={(e) => setRev({ ...rev, label: e.target.value })} required /></label>
            {d.origin === 'external' && <><label className="field">Issuer's revision<input value={rev.issuerRevision} onChange={(e) => setRev({ ...rev, issuerRevision: e.target.value })} required /></label>
              <label className="field">Received<input type="date" value={rev.receivedOn} onChange={(e) => setRev({ ...rev, receivedOn: e.target.value })} /></label></>}
          </div>
          <label className="field">What changed and why<textarea id="rev-reason" value={rev.reason} onChange={(e) => setRev({ ...rev, reason: e.target.value })} required={d.versions.length > 0} /></label>
          <div><button className="primary" disabled={act.busy || !file}>Upload as a draft</button></div>
        </form>
      ) : open.status === 'draft' ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(() => api.post(`/api/document-versions/${open.id}/submit`, { reviewerIds: sub.reviewers, approverId: sub.approverId, effectiveOn: sub.effectiveOn || null })); }}>
          <h3>Revision {open.version_label} is a draft: send it for review</h3>
          <fieldset className="row" style={{ flexWrap: 'wrap', gap: 10, border: 0, padding: 0 }}><legend className="muted">Reviewers (optional; they sign first)</legend>
            {users.filter((u: any) => u.id !== me?.userId).slice(0, 40).map((u: any) => <label key={u.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={sub.reviewers.includes(u.id)}
              onChange={(e) => setSub({ ...sub, reviewers: e.target.checked ? [...sub.reviewers, u.id] : sub.reviewers.filter((x) => x !== u.id) })} /> {u.display_name}</label>)}</fieldset>
          <div className="form-grid">
            <label className="field">Approver<select id="sub-approver" value={sub.approverId} onChange={(e) => setSub({ ...sub, approverId: e.target.value })} required>
              <option value="">Choose…</option>{approvers.map((u: any) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
            <label className="field">Effective from<input id="sub-effective" type="date" value={sub.effectiveOn} onChange={(e) => setSub({ ...sub, effectiveOn: e.target.value })} /></label>
          </div>
          <p className="faint">Leave the effective date empty to put it in force as soon as it is approved; set a later date to train people first.</p>
          <div className="row"><button className="primary" disabled={act.busy}>Send for review</button>
            {d.canApprove && <button type="button" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/document-versions/${open.id}/approve`, { effectiveOn: sub.effectiveOn || null }))}>Approve now (one step)</button>}
            <button type="button" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/document-versions/${open.id}/discard`))}>Discard the draft</button></div>
        </form>
      ) : (
        <div className="stack">
          <h3>Revision {open.version_label} is in review</h3>
          {d.approvals.map((q: any) => <Table key={q.id} rows={q.steps} rowKey={(x: any) => x.id} columns={[{ key: 'label', label: 'Step' }, { key: 'status', label: 'Decision', render: (x: any) => <Pill value={x.status} /> },
            { key: 'decided_by', label: 'By', render: (x: any) => x.decided_by ?? '—' }, { key: 'comment', label: 'Comment', render: (x: any) => x.comment ?? '' }]} />)}
          <div className="row"><input aria-label="Why it is withdrawn" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why" style={{ flex: 1 }} />
            <button disabled={act.busy || !reason.trim()} onClick={() => void act.run(() => api.post(`/api/document-versions/${open.id}/withdraw`, { reason }))}>Withdraw from review</button></div>
        </div>
      )}
      {d.status !== 'obsolete' && d.canApprove && !open && d.current_version_id && (
        <div className="row"><input aria-label="Why the document is withdrawn" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is no longer used" style={{ flex: 1 }} />
          <button disabled={act.busy || reason.trim().length < 5} onClick={() => void act.run(() => api.post(`/api/documents/${d.id}/obsolete`, { reason }))}>Make obsolete</button></div>
      )}
      <ErrorNote message={act.error} />
      {d.history.length > 0 && <details><summary>History ({d.history.length} events)</summary>
        <Table rows={d.history} rowKey={(x: any) => String(x.id)} columns={[{ key: 'occurred_at', label: 'When', render: (x: any) => fmtDateTime(x.occurred_at) }, { key: 'actor', label: 'Who' },
          { key: 'action', label: 'What', render: (x: any) => humanize(String(x.action).replace('document.', '')) }, { key: 'hash', label: 'Chain', render: (x: any) => <code>{String(x.hash).slice(0, 8)}</code> }]} /></details>}
    </section>
  );
}

/** Links from approvals point at a version; this opens its document. */
export function DocumentVersionRedirect() {
  const { id } = useParams(); const nav = useNavigate();
  const { data, error } = useApi<any>(`/api/document-versions/${id}`);
  useEffect(() => { if (data) nav(`/documents/${data.document_id}?version=${data.id}`, { replace: true }); }, [data]);
  return <Async loading={!data && !error} error={error}>{() => null}</Async>;
}
