import { useState } from 'react';
import { useAuth } from '../auth';
import { ErrorNote } from '../components/ui';

/**
 * Development sign-in: paste an API token from .storage/dev-tokens.json (written by `npm run seed`).
 * Production sign-in goes through the customer's identity provider (decision D-008, still open).
 */
export function Login() {
  const { signIn } = useAuth();
  const [token, setTokenValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <div className="card stack">
        <div className="eyebrow">Development sign-in</div>
        <h1>Sign in with an API token</h1>
        <p className="muted">Paste a token printed by <code>npm run seed</code> (also saved in <code>.storage/dev-tokens.json</code>). Each token signs you in as a different demo user and role.</p>
        <form className="form" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError(null);
          try { await signIn(token); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
        }}>
          <label className="field">API token<input id="token" value={token} onChange={(e) => setTokenValue(e.target.value)} placeholder="erp_…" autoComplete="off" required /></label>
          <ErrorNote message={error} />
          <button className="primary" disabled={busy || !token.trim()}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="faint" style={{ fontSize: 12 }}>Customer deployments use single sign-on through your identity provider instead of tokens.</p>
      </div>
    </div>
  );
}
