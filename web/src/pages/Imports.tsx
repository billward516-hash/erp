import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { ErrorNote, Kpis, PageHead, Pill, Table } from '../components/ui';
import { humanize } from '../format';
import { useAction, useApi } from '../hooks';

type FieldMap = Record<string, { source?: string; valueMap?: Record<string, string>; transforms?: unknown[]; template?: string; constant?: unknown; dateFormats?: string[] }>;

/**
 * Import wizard: file → mapping (auto-suggested, editable) → dry run → commit.
 * Nothing touches live records until "Import" on the last step.
 */
export function Imports() {
  const { can } = useAuth();
  const targets = useApi<any[]>('/api/imports/targets');
  const facilities = useApi<any[]>('/api/facilities');
  const profiles = useApi<any[]>('/api/import-profiles');
  const [step, setStep] = useState<'setup' | 'map' | 'review' | 'done'>('setup');
  const [params] = useSearchParams();
  const [targetKey, setTargetKey] = useState(params.get('target') ?? '');
  const [sourceSystem, setSourceSystem] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [profileId, setProfileId] = useState('');
  const [suggestion, setSuggestion] = useState<any>(null);
  const [fields, setFields] = useState<FieldMap>({});
  const [options, setOptions] = useState<any>({ unmappedColumns: 'custom_fields', dateOrder: 'MDY' });
  const [staged, setStaged] = useState<any>(null);
  const [allowPartial, setAllowPartial] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [profileName, setProfileName] = useState('');
  const [savedProfile, setSavedProfile] = useState<string | null>(null);
  const target = targets.data?.find((t) => t.key === targetKey);

  const suggest = useAction(async () => {
    const s = await api.post('/api/imports/suggest', { target: targetKey, fileName: file!.name, contentBase64: await fileToBase64(file!) });
    setSuggestion(s);
    setFields(s.mapping.fields);
    setOptions({ ...s.mapping.options });
    setStep('map');
  });
  const stage = useAction(async (useProfile: boolean) => {
    const mapping = useProfile ? undefined : { fields: Object.fromEntries(Object.entries(fields).filter(([, m]) => m.source || m.template || m.constant !== undefined)), options };
    const s = await api.post('/api/imports/stage', { target: targetKey, sourceSystem: sourceSystem || 'manual-upload', facilityId: facilityId || null,
      fileName: file!.name, contentBase64: await fileToBase64(file!), ...(useProfile ? { profileId } : { mapping }) });
    setStaged(s); setResult(null); setStep('review');
  });
  const commit = useAction(async () => { setResult(await api.post(`/api/imports/${staged.batchId}/commit`, { allowPartial })); setStep('done'); });
  const save = useAction(async () => {
    await api.post('/api/import-profiles', { name: profileName, target: targetKey, sourceSystem: sourceSystem || 'manual-upload', mapping: staged.mapping });
    setSavedProfile(profileName); void profiles.reload();
  });
  const reset = () => { setStep('setup'); setSuggestion(null); setStaged(null); setResult(null); setFile(null); setSavedProfile(null); };

  return (
    <>
      <PageHead eyebrow="Data import" title="Bring in existing data" sub="CSV, Excel or JSON from any system. Columns are matched to platform fields; you review everything before it is saved."
        actions={step !== 'setup' ? <button onClick={reset}>Start over</button> : undefined} />
      <div className="steps" aria-label="Progress">
        {[['setup', 'Choose file'], ['map', 'Match columns'], ['review', 'Check'], ['done', 'Imported']].map(([s, l], i, all) => {
          const cur = all.findIndex(([x]) => x === step);
          return <span key={s} className={i < cur ? 'done' : i === cur ? 'now' : ''}>{l}</span>;
        })}
      </div>

      {step === 'setup' && (
        <section className="card form">
          <div className="form-grid">
            <label className="field">What are you importing?
              <select id="imp-target" value={targetKey} onChange={(e) => { setTargetKey(e.target.value); setProfileId(''); }} required>
                <option value="">Choose…</option>{(targets.data ?? []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select></label>
            <label className="field">Where does the file come from?<input id="imp-source" value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)} placeholder="e.g. old-cmms, payroll, hr-matrix" /></label>
            <label className="field">Default facility<select id="imp-fac" value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
              <option value="">None (rows name their facility)</option>{(facilities.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}</select></label>
          </div>
          {target && <p className="muted" style={{ margin: 0 }}>{target.description}</p>}
          <label className="field">File (.csv, .tsv, .xlsx, .json)<input id="imp-file" type="file" accept=".csv,.tsv,.txt,.xlsx,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>The source name lets re-imports from the same system update records instead of duplicating them.</p>
          <ErrorNote message={suggest.error ?? stage.error} />
          <div className="row">
            <button className="primary" disabled={!targetKey || !file || suggest.busy} onClick={() => suggest.run()}>{suggest.busy ? 'Reading file…' : 'Match columns'}</button>
            {(profiles.data ?? []).some((p) => p.target === targetKey) && (
              <>
                <span className="muted">or use a saved mapping</span>
                <select id="imp-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} style={{ width: 'auto' }}>
                  <option value="">Choose…</option>{(profiles.data ?? []).filter((p) => p.target === targetKey).map((p) => <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>)}
                </select>
                <button disabled={!profileId || !file || stage.busy} onClick={() => stage.run(true)}>Check with saved mapping</button>
              </>
            )}
          </div>
        </section>
      )}

      {step === 'map' && suggestion && target && (
        <MapStep target={target} suggestion={suggestion} fields={fields} setFields={setFields} options={options} setOptions={setOptions}
          busy={stage.busy} error={stage.error} onStage={() => stage.run(false)} />
      )}

      {step === 'review' && staged && (
        <>
          <Kpis items={[
            { label: 'Rows read', value: staged.stats.total },
            { label: 'New records', value: staged.stats.toCreate },
            { label: 'Updates', value: staged.stats.toUpdate },
            { label: 'With warnings', value: staged.stats.warnings, tone: staged.stats.warnings ? 'watch' : undefined },
            { label: 'With errors', value: staged.stats.errors, tone: staged.stats.errors ? 'bad' : 'good' },
          ]} />
          {staged.warnings.length > 0 && <section className="notice warn"><ul className="insights">{staged.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></section>}
          {staged.problems.length > 0 && (
            <section className="card stack">
              <div className="spread"><h2>Rows that will not import</h2><button onClick={() => api.download(`/api/imports/${staged.batchId}/problems.csv`, 'problems.csv')}>Download problems file</button></div>
              <p className="muted" style={{ margin: 0 }}>The problems file has the original values and the reason for each row, so the data can be fixed at the source and uploaded again.</p>
              <Table rows={staged.problems} rowKey={(p) => `${p.rowNumber}-${p.sourceColumn ?? ''}`}
                columns={[{ key: 'rowNumber', label: 'Row', numeric: true }, ...(staged.problems.some((p: any) => p.sourceColumn) ? [{ key: 'sourceColumn', label: 'Column' }] : []),
                  { key: 'messages', label: 'Problem', render: (p: any) => p.messages.map((m: any) => `${m.field ? `${m.field}: ` : ''}${m.message}`).join('; ') }]} />
            </section>
          )}
          <section className="card stack">
            <h2>Preview</h2>
            <Table rows={staged.preview} rowKey={(r) => `${r.rowNumber}-${r.sourceColumn ?? ''}`}
              columns={[{ key: 'rowNumber', label: 'Row', numeric: true }, { key: 'action', label: 'Will', render: (r) => (r.status === 'error' ? <Pill tone="bad" label="skip" /> : <Pill tone={r.action === 'create' ? 'info' : 'neutral'} label={r.action ?? '—'} />) },
                ...Object.keys(staged.mapping.fields).slice(0, 6).map((k) => ({ key: k, label: humanize(k), render: (r: any) => (r.values[k] == null ? <span className="faint">—</span> : String(r.values[k])) })),
                { key: 'messages', label: 'Notes', render: (r) => r.messages.map((m: any) => m.message).join('; ') }]} />
          </section>
          <section className="card stack">
            <ErrorNote message={commit.error} />
            {staged.stats.errors > 0 && <label className="row"><input id="imp-partial" type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} /> Import the good rows and skip the {staged.stats.errors} with errors</label>}
            <div className="row">
              <button className="primary" disabled={commit.busy || !can('imports.commit') || (staged.stats.errors > 0 && !allowPartial)} onClick={() => commit.run()}>
                {commit.busy ? 'Importing…' : `Import ${staged.stats.total - staged.stats.errors - staged.stats.skippedBlank} rows`}</button>
              {suggestion && <button onClick={() => setStep('map')}>Back to matching</button>}
            </div>
            {!can('imports.commit') && <p className="muted">You can check files, but someone with import rights must run the import.</p>}
          </section>
        </>
      )}

      {step === 'done' && result && (
        <section className="card stack">
          <div className="notice ok">Imported: {result.stats.created} created, {result.stats.updated} updated, {result.stats.unchanged} unchanged{result.stats.failed ? `, ${result.stats.failed} not imported` : ''}.</div>
          <h2>Save this mapping for next time</h2>
          <p className="muted" style={{ margin: 0 }}>The next export from the same system will import without matching columns again.</p>
          {savedProfile ? <div className="notice ok">Saved as “{savedProfile}”.</div> : (
            <div className="row"><input id="imp-profile-name" value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="e.g. Old CMMS work orders" style={{ maxWidth: 320 }} />
              <button disabled={!profileName.trim() || save.busy} onClick={() => save.run()}>Save mapping</button></div>
          )}
          <ErrorNote message={save.error} />
          <div><button onClick={reset}>Import another file</button></div>
        </section>
      )}
    </>
  );
}

function MapStep({ target, suggestion, fields, setFields, options, setOptions, busy, error, onStage }: {
  target: any; suggestion: any; fields: FieldMap; setFields: (f: FieldMap) => void; options: any; setOptions: (o: any) => void; busy: boolean; error: string | null; onStage: () => void;
}) {
  const confidence = useMemo(() => Object.fromEntries(suggestion.suggestions.map((s: any) => [s.field, s])), [suggestion]);
  const sample = suggestion.sample?.[0]?.values ?? {};
  const used = new Set(Object.values(fields).map((m) => m.source).filter(Boolean));
  const missing = target.fields.filter((f: any) => f.required && !fields[f.key]?.source && !fields[f.key]?.template && fields[f.key]?.constant === undefined);
  const setSource = (key: string, source: string) => {
    const next = { ...fields };
    if (source) next[key] = { ...(next[key]?.source === source ? next[key] : {}), source };
    else delete next[key];
    setFields(next);
  };
  const distinctValues = (col: string) => [...new Set((suggestion.sample ?? []).map((r: any) => r.values[col]).filter((v: any) => v !== null && v !== '' && v !== undefined).map(String))] as string[];
  return (
    <>
      <section className="card stack">
        <div className="spread">
          <h2>Match columns</h2>
          <span className="muted">{suggestion.parseInfo.format.toUpperCase()}{suggestion.parseInfo.delimiter ? ` · delimiter “${suggestion.parseInfo.delimiter === '\t' ? 'tab' : suggestion.parseInfo.delimiter}”` : ''}{suggestion.parseInfo.encoding ? ` · ${suggestion.parseInfo.encoding}` : ''} · header on row {suggestion.parseInfo.headerRow} · {suggestion.parseInfo.totalRows} rows</span>
        </div>
        {suggestion.parseInfo.warnings.length > 0 && <div className="notice warn">{suggestion.parseInfo.warnings.join(' ')}</div>}
        <Table rows={target.fields} rowKey={(f) => f.key}
          columns={[
            { key: 'label', label: 'Platform field', render: (f) => <><strong>{f.label}</strong>{f.required && <span className="faint"> (required)</span>}{f.description && <div className="faint" style={{ fontSize: 12 }}>{f.description}</div>}</> },
            { key: 'source', label: 'Column in your file', render: (f) => (
              fields[f.key]?.template ? <span className="mono">{fields[f.key]!.template}</span> : (
                <select aria-label={`Column for ${f.label}`} value={fields[f.key]?.source ?? ''} onChange={(e) => setSource(f.key, e.target.value)} style={{ minWidth: 180 }}>
                  <option value="">— not imported —</option>
                  {suggestion.columns.map((c: string) => <option key={c} value={c} disabled={used.has(c) && fields[f.key]?.source !== c}>{c}</option>)}
                </select>)) },
            { key: 'match', label: 'Match', render: (f) => (confidence[f.key] && fields[f.key]?.source === confidence[f.key].column
              ? <Pill tone={confidence[f.key].level === 'high' ? 'good' : confidence[f.key].level === 'medium' ? 'watch' : 'bad'} label={`${confidence[f.key].level}${confidence[f.key].note ? ' · check values' : ''}`} />
              : fields[f.key]?.source ? <Pill tone="info" label="manual" /> : null) },
            { key: 'example', label: 'Example value', render: (f) => (fields[f.key]?.source ? <span className="mono">{String(sample[fields[f.key]!.source!] ?? '—')}</span> : null) },
          ]} />
        {missing.length > 0 && <div className="notice error">Required fields not matched: {missing.map((f: any) => f.label).join(', ')}.</div>}
      </section>
      {target.fields.filter((f: any) => f.type === 'enum' && fields[f.key]?.source).map((f: any) => {
        const col = fields[f.key]!.source!;
        // The server knows each field's synonyms; for the column it suggested, show only values it could not recognize.
        const suggested = confidence[f.key]?.column === col;
        const unknown = suggested ? (suggestion.unmatchedValues?.[f.key] ?? []) as string[]
          : distinctValues(col).filter((v) => !f.values.some((x: string) => x.toLowerCase() === v.toLowerCase()));
        if (!unknown.length) return null;
        return (
          <section key={f.key} className="card stack">
            <h2>Translate “{col}” values to {f.label}</h2>
            <p className="muted" style={{ margin: 0 }}>Common spellings are recognized automatically. Choose a value only where you want to override or the value is not recognized.</p>
            <div className="form-grid">
              {unknown.map((v) => (
                <label key={v} className="field"><span className="mono">{v}</span>
                  <select value={fields[f.key]!.valueMap?.[v] ?? ''} onChange={(e) => {
                    const vm = { ...(fields[f.key]!.valueMap ?? {}) };
                    if (e.target.value) vm[v] = e.target.value; else delete vm[v];
                    setFields({ ...fields, [f.key]: { ...fields[f.key]!, valueMap: vm } });
                  }}>
                    <option value="">Recognize automatically</option>{f.values.map((x: string) => <option key={x} value={x}>{humanize(x)}</option>)}
                  </select></label>
              ))}
            </div>
          </section>
        );
      })}
      <section className="card stack">
        <h2>Options</h2>
        <div className="form-grid">
          <label className="field">Columns not matched above
            <select id="imp-unmapped" value={options.unmappedColumns} onChange={(e) => setOptions({ ...options, unmappedColumns: e.target.value })}>
              <option value="custom_fields">Keep as extra fields on the record</option><option value="ignore">Ignore</option></select></label>
          <label className="field">Dates like 03/04/2025 mean
            <select id="imp-dates" value={options.dateOrder} onChange={(e) => setOptions({ ...options, dateOrder: e.target.value })}>
              <option value="MDY">March 4 (US)</option><option value="DMY">3 April (day first)</option></select></label>
        </div>
        {suggestion.unmappedColumns.length > 0 && <p className="muted" style={{ margin: 0 }}>Not matched: {suggestion.unmappedColumns.join(', ')}.</p>}
        <ErrorNote message={error} />
        <div><button className="primary" disabled={busy || missing.length > 0} onClick={onStage}>{busy ? 'Checking every row…' : 'Check every row (nothing is saved yet)'}</button></div>
      </section>
    </>
  );
}
