import { useState } from 'react';
import { api, fileToBase64 } from '../api';
import { useAction, useApi } from '../hooks';
import { fmtDateTime } from '../format';
import { ErrorNote, Pill, Table } from './ui';

export const RFQ_ACCEPT = 'application/pdf,image/*,text/plain,text/csv,.docx,.doc,.xlsx,.xls,.pptx,.zip,.dwg,.dxf,.step,.stp';
const ACCEPT = 'application/pdf,image/png,image/jpeg,image/heic,image/webp,text/plain,text/csv';

/** Files on a quality or safety record: list, open, and add (photos, certificates, reports). */
export function Attachments({ subjectType, subjectId, title = 'Files', restrictable = false, accept = ACCEPT }: { subjectType: string; subjectId: string; title?: string; restrictable?: boolean; accept?: string }) {
  const { data, reload } = useApi<any[]>(`/api/attachments?subjectType=${subjectType}&subjectId=${subjectId}`);
  const [file, setFile] = useState<File | null>(null);
  const [restricted, setRestricted] = useState(true);
  const upload = useAction(async () => {
    await api.post('/api/attachments', { subjectType, subjectId, fileName: file!.name, mime: file!.type || 'application/octet-stream', contentBase64: await fileToBase64(file!),
      restricted: restrictable ? restricted : undefined });
    setFile(null); await reload();
  });
  return (
    <section className="card stack">
      <h2>{title}</h2>
      <Table rows={data ?? []} empty="No files yet."
        columns={[{ key: 'file_name', label: 'File', render: (f) => <button className="link" onClick={() => api.open(`/api/attachments/${f.id}`)}>{f.file_name}</button> },
          { key: 'size_bytes', label: 'Size', numeric: true, render: (f) => `${Math.max(1, Math.round(f.size_bytes / 1024))} KB` },
          { key: 'uploaded_by_name', label: 'Added by' }, { key: 'created_at', label: 'When', render: (f) => fmtDateTime(f.created_at) },
          { key: 'restricted', label: '', render: (f) => (f.restricted ? <Pill tone="watch" label="Safety team only" /> : null) }]} />
      <form className="row" onSubmit={(e) => { e.preventDefault(); void upload.run(); }}>
        <input type="file" aria-label="Add a file" accept={accept} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {restrictable && <label className="row"><input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />Safety team only (photos showing people)</label>}
        <button disabled={!file || upload.busy}>Add file</button>
        <ErrorNote message={upload.error} />
      </form>
    </section>
  );
}
