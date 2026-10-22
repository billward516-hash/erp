import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, ErrorNote, PageHead, Pill } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useApi } from '../hooks';

/** Where the identity provider sends people back (D-140): the session token arrives in the URL fragment. */
export function SignedIn() {
  const { signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, '', '/signed-in'); // the token leaves the address bar at once
    if (p.get('error')) { setError(p.get('error')); return; }
    const next = p.get('next') && /^\/[^/\\]/.test(p.get('next')!) ? p.get('next')! : '/';
    signIn(p.get('token') ?? '').then(() => window.location.replace(next)).catch((e) => setError((e as Error).message));
  }, []);
  return (
    <div className="login">
      <div className="card stack">
        <h1>{error ? 'Not signed in' : 'Signing you in…'}</h1>
        <ErrorNote message={error} />
        {error && <a className="btn" href="/">Back to sign-in</a>}
      </div>
    </div>
  );
}

/** Company single sign-on settings (administrators). */
export function SignInSettings() {
  const { data, loading, error, reload } = useApi<any>('/api/sso');
  return (
    <>
      <PageHead eyebrow="Admin" title="Sign-in" sub="Single sign-on through your company's identity provider (Microsoft Entra ID, Google Workspace, Okta, Auth0 and others that support OpenID Connect)." />
      <Async loading={loading && !data} error={error}>{() => <SsoForm d={data} onDone={reload} />}</Async>
    </>
  );
}

function SsoForm({ d, onDone }: { d: any; onDone: () => void }) {
  const s = d.settings;
  const [f, setF] = useState({ issuer: s?.issuer ?? '', clientId: s?.client_id ?? '', clientSecret: '', domains: (s?.email_domains ?? []).join(', '), linkByEmail: s?.link_by_email ?? true,
    enabled: s?.enabled ?? false, allowTokens: s?.allow_tokens ?? true });
  const save = useAction(async () => {
    await api.put('/api/sso', { issuer: f.issuer, clientId: f.clientId, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}), emailDomains: f.domains.split(/[\s,;]+/).filter(Boolean),
      linkByEmail: f.linkByEmail, enabled: f.enabled, allowTokens: f.allowTokens });
    setF({ ...f, clientSecret: '' }); onDone();
  });
  return (
    <section className="card stack">
      <div className="spread"><h2>Identity provider</h2>{s ? <Pill value={s.enabled ? 'on' : 'off'} label={s.enabled ? 'On' : 'Off'} tone={s.enabled ? 'good' : 'neutral'} /> : <Pill label="Not set up" tone="neutral" />}</div>
      <p className="muted">Register this platform as a web application in your identity provider with the sign-in redirect URL below, then copy its issuer, client id and secret here. People sign in with their work email; nobody is created by signing in, so add people under their roles first. The first sign-in links each person by their verified email.</p>
      <dl className="facts"><dt>Redirect URL</dt><dd className="mono">{d.callbackUrl}</dd></dl>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <label className="field">Issuer<input id="sso-issuer" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant id>/v2.0" required /></label>
        <label className="field">Client id<input id="sso-client" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} required /></label>
        <label className="field">Client secret<input id="sso-secret" type="password" autoComplete="new-password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })}
          placeholder={s?.has_secret ? 'Saved (leave blank to keep)' : 'From the provider'} /></label>
        <label className="field">Work-email domains<input id="sso-domains" value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} placeholder="example.com, example.co.uk" /></label>
        <label className="row"><input type="checkbox" checked={f.linkByEmail} onChange={(e) => setF({ ...f, linkByEmail: e.target.checked })} /> Link a person's first sign-in by their verified email</label>
        <label className="row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Single sign-on is on</label>
        <label className="row"><input type="checkbox" checked={f.allowTokens} onChange={(e) => setF({ ...f, allowTokens: e.target.checked })} /> API tokens keep working (integrations and scripts)</label>
        {!f.allowTokens && !d.youAreLinked && <p className="notice warn">Sign in once with single sign-on yourself before turning API tokens off.</p>}
        <ErrorNote message={save.error} />
        <div className="row"><button className="primary" disabled={save.busy}>Save</button>{s && <span className="faint">Last changed {fmtDateTime(s.updated_at)}</span>}</div>
      </form>
    </section>
  );
}
