import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Async, ErrorNote, PageHead, Pill, Table } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../format';
import { useApi } from '../hooks';

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
  const { data: d, loading, error } = useApi<any>(`/api/documents/${id}`);
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
          {v && !inForce && (
            <div className="card" role="alert" style={{ borderLeft: '3px solid var(--bad)' }}>
              <strong>{v.status === 'draft' || v.status === 'in_review' ? 'Draft: not approved for use.' : 'Superseded: do not work to this revision.'}</strong>{' '}
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
          {d.versions.length > 1 && (
            <section className="card stack screen-only">
              <h2>Revisions</h2>
              <Table rows={d.versions} rowKey={(x) => x.id} onRow={(x) => setParams({ version: x.id })}
                columns={[{ key: 'revision', label: 'Rev', numeric: true, render: (x) => <strong>{x.revision}</strong> }, { key: 'version_label', label: 'Label' },
                  { key: 'status', label: 'Status', render: (x) => <Pill tone={x.id === d.current_version_id ? 'good' : 'neutral'} label={x.id === d.current_version_id ? 'In force' : humanize(x.status)} /> },
                  { key: 'change_summary', label: 'What changed' }, { key: 'approved_at', label: 'Approved', render: (x) => fmtDateTime(x.approved_at) }]} />
            </section>
          )}
        </>
      );
    }}</Async>
  );
}
