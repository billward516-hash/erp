import { useState } from 'react';
import { useAuth } from '../auth';
import { ErrorNote } from '../components/ui';

/**
 * Sign-in: single sign-on with a work email (D-140), and below it the development sign-in, which takes an API token
 * from .storage/dev-tokens.json (written by `npm run seed`).
 */
export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [token, setTokenValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = window.location.pathname === '/' ? '' : `&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  return (
    <div className="login">
      <div className="card stack">
        <h1>Sign in</h1>
        <form className="form" onSubmit={(e) => { e.preventDefault(); window.location.assign(`/auth/sso/start?email=${encodeURIComponent(email.trim())}${back}`); }}>
          <label className="field">Work email<input id="sso-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required /></label>
          <button className="primary" disabled={!email.includes('@')}>Continue with your company account</button>
        </form>
        <details>
          <summary className="muted">Development sign-in with an API token</summary>
          <p className="muted">Paste a token printed by <code>npm run seed</code> (also saved in <code>.storage/dev-tokens.json</code>). Each token signs you in as a different demo user and role.</p>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setError(null);
            try { await signIn(token); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
          }}>
            <label className="field">API token<input id="token" value={token} onChange={(e) => setTokenValue(e.target.value)} placeholder="erp_…" autoComplete="off" required /></label>
            <ErrorNote message={error} />
            <button disabled={busy || !token.trim()}>{busy ? 'Signing in…' : 'Sign in with token'}</button>
          </form>
        </details>
      </div>
    </div>
  );
}
