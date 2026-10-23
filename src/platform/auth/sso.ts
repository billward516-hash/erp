import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { config } from '../../config.js';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors.js';
import { generateToken, hashToken } from './actor.js';

/**
 * Single sign-on through the company's own identity provider (D-140): OpenID Connect authorization code flow with
 * PKCE, provider-independent (Entra ID, Google Workspace, Okta, Auth0, Keycloak… anything with discovery). The ID
 * token is verified here: signature against the provider's published keys (RS256 or ES256 only), issuer, audience,
 * expiry and nonce. Users are never created by signing in; an administrator adds them, and the first sign-in links the
 * identity to the user with that verified email when the company allows it.
 */
const SESSION_HOURS = 12;
const SKEW = 60;

// ---------------------------------------------------------------------------
// Client secrets at rest
// ---------------------------------------------------------------------------

/** AES-256-GCM key from SSO_SECRET_KEY (32 bytes, base64). Development falls back to a fixed, labeled key. */
function secretKey() {
  const k = process.env.SSO_SECRET_KEY;
  if (k) {
    const b = Buffer.from(k, 'base64');
    if (b.length !== 32) throw new Error('SSO_SECRET_KEY must be 32 bytes, base64-encoded');
    return b;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('SSO_SECRET_KEY is required in production');
  return createHash('sha256').update('development-only sso key; set SSO_SECRET_KEY').digest();
}
export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function decryptSecret(enc: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', secretKey(), enc.subarray(0, 12));
  d.setAuthTag(enc.subarray(12, 28));
  return Buffer.concat([d.update(enc.subarray(28)), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Provider metadata and keys
// ---------------------------------------------------------------------------

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string }
const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, { keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[]; at: number }>();

async function getJson(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new AppError(502, 'sso_provider', `the identity provider answered ${r.status}${body?.error ? `: ${body.error}${body.error_description ? ` (${body.error_description})` : ''}` : ''}`);
  if (!body) throw new AppError(502, 'sso_provider', `the identity provider did not return JSON from ${url}`);
  return body;
}

export async function discover(issuer: string): Promise<Discovery> {
  const c = discoveryCache.get(issuer);
  if (c && Date.now() - c.at < 10 * 60_000) return c.doc;
  const doc = await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`) as Discovery;
  if (doc.issuer !== issuer) throw new AppError(502, 'sso_provider', `the provider says its issuer is "${doc.issuer}", not "${issuer}"`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (!doc[k]) throw new AppError(502, 'sso_provider', `the provider's discovery document has no ${k}`);
  discoveryCache.set(issuer, { doc, at: Date.now() });
  return doc;
}

async function keyFor(jwksUri: string, kid: string | undefined, alg: string) {
  for (const refresh of [false, true]) {
    let c = jwksCache.get(jwksUri);
    if (refresh || !c || Date.now() - c.at > 60 * 60_000) {
      c = { keys: (await getJson(jwksUri)).keys ?? [], at: Date.now() };
      jwksCache.set(jwksUri, c);
    }
    const k = c.keys.find((x) => (!kid || x.kid === kid) && (!x.use || x.use === 'sig') && (!x.alg || x.alg === alg) && x.kty === (alg === 'RS256' ? 'RSA' : 'EC'));
    if (k) return createPublicKey({ key: k, format: 'jwk' });
    if (refresh) break; // a key rotation shows up on the second fetch
  }
  throw new AppError(401, 'sso_token', 'the ID token is signed with a key the provider does not publish');
}

/** Verifies a compact JWS ID token and returns its claims. */
export async function verifyIdToken(idToken: string, expect: { issuer: string; clientId: string; nonce: string; jwksUri: string; now?: number }) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new AppError(401, 'sso_token', 'the ID token is not a signed JWT');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new AppError(401, 'sso_token', `ID tokens signed with ${header.alg} are not accepted`);
  const key = await keyFor(expect.jwksUri, header.kid, header.alg);
  const ok = verifySignature('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2]!, 'base64url'));
  if (!ok) throw new AppError(401, 'sso_token', 'the ID token signature does not verify');
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expect.issuer) throw new AppError(401, 'sso_token', 'the ID token is from a different issuer');
  if (!aud.includes(expect.clientId) || (aud.length > 1 && claims.azp && claims.azp !== expect.clientId)) throw new AppError(401, 'sso_token', 'the ID token is for a different application');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW < now) throw new AppError(401, 'sso_token', 'the ID token has expired');
  if (typeof claims.iat === 'number' && claims.iat - SKEW > now) throw new AppError(401, 'sso_token', 'the ID token is issued in the future');
  if (claims.nonce !== expect.nonce) throw new AppError(401, 'sso_token', 'the ID token does not belong to this sign-in');
  if (!claims.sub) throw new AppError(401, 'sso_token', 'the ID token has no subject');
  return claims as { sub: string; email?: string; email_verified?: boolean | string; name?: string; [k: string]: unknown };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export const callbackUrl = () => `${config.appBaseUrl.replace(/\/$/, '')}/auth/sso/callback`;
/** A path on this site only (D-161): one leading slash, then no slash or backslash, and no spaces or control characters anywhere (browsers drop tabs and newlines, so "/\t/evil.example" would leave the site). */
export const safeReturn = (p?: string | null) => (p && p.length <= 500 && /^\/(?![/\\])[^\s\\\x00-\x1f\x7f]*$/.test(p) ? p : '/');

/** The provider's sign-in page for a company, found by slug or by the domain of a work email. */
export async function startSignIn(input: { company?: string | null; email?: string | null; returnTo?: string | null }) {
  const domain = input.email?.includes('@') ? input.email.split('@').pop()!.trim().toLowerCase() : null;
  const cfg = (await getPool().query('SELECT * FROM sso_config($1, $2)', [input.company?.trim().toLowerCase() || null, domain])).rows[0];
  if (!cfg) throw new AppError(404, 'sso_not_configured', domain ? `single sign-on is not set up for ${domain}; ask your administrator, or sign in another way` : 'single sign-on is not set up for this company');
  const doc = await discover(cfg.issuer);
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  await getPool().query('SELECT sso_begin($1, $2, $3, $4, $5)', [hashToken(state), cfg.tenant_id, verifier, nonce, safeReturn(input.returnTo)]);
  const u = new URL(doc.authorization_endpoint);
  u.search = new URLSearchParams({ response_type: 'code', client_id: cfg.client_id, redirect_uri: callbackUrl(), scope: 'openid email profile', state, nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(input.email ? { login_hint: input.email } : {}) }).toString();
  return u.toString();
}

/** Completes a sign-in: exchanges the code, verifies the ID token, finds the user and issues a session token. */
export async function finishSignIn(input: { code?: string; state?: string; error?: string; error_description?: string }) {
  if (input.error) throw new AppError(401, 'sso_denied', `the identity provider did not sign you in: ${input.error_description ?? input.error}`);
  if (!input.code || !input.state) throw new AppError(400, 'sso_callback', 'the sign-in response is incomplete');
  const login = (await getPool().query('SELECT * FROM sso_take($1)', [hashToken(input.state)])).rows[0];
  if (!login) throw new AppError(401, 'sso_state', 'this sign-in has expired or was already used; start again');
  const cfg = (await getPool().query('SELECT * FROM sso_config(NULL, NULL, $1)', [login.tenant_id])).rows[0];
  if (!cfg) throw new AppError(401, 'sso_not_configured', 'single sign-on was turned off during the sign-in');
  const doc = await discover(cfg.issuer);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: callbackUrl(), code_verifier: login.verifier, client_id: cfg.client_id });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (cfg.client_secret_enc) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.client_id)}:${encodeURIComponent(decryptSecret(cfg.client_secret_enc))}`).toString('base64')}`;
  const tokens = await getJson(doc.token_endpoint, { method: 'POST', headers, body });
  if (!tokens.id_token) throw new AppError(502, 'sso_provider', 'the provider returned no ID token');
  const claims = await verifyIdToken(tokens.id_token, { issuer: cfg.issuer, clientId: cfg.client_id, nonce: login.nonce, jwksUri: doc.jwks_uri });
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  const user = (await getPool().query('SELECT * FROM sso_resolve_user($1, $2, $3, $4, $5)', [login.tenant_id, cfg.issuer, claims.sub, claims.email ?? null, verified])).rows[0];
  if (!user) {
    throw new AppError(403, 'sso_no_user', `${claims.email ?? 'This account'} is not a user of ${cfg.tenant_name}${claims.email && !verified ? ' (the provider did not confirm the email address)' : ''}; ask your administrator to add you`);
  }
  const token = generateToken();
  await getPool().query('SELECT sso_issue_session($1, $2, $3, $4)', [login.tenant_id, user.user_id, hashToken(token), SESSION_HOURS]);
  return { token, returnTo: login.return_to as string, tenantId: login.tenant_id as string, userId: user.user_id as string, linkedBy: user.how as 'subject' | 'email' };
}

export async function signOut(token: string) {
  await getPool().query('SELECT auth_revoke_token($1)', [hashToken(token)]);
}
