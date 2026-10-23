/**
 * MOCK OpenID Connect identity provider, for tests and local demos only (never a real sign-in). It publishes discovery
 * and keys, shows a page to pick a demo person, and issues RS256 ID tokens after checking the client, redirect URL and
 * PKCE verifier like a real provider would.
 *
 *   npx tsx scripts/mock-oidc.ts          # http://localhost:3999, people from MOCK_IDP_USERS or the Ridgeline demo
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export interface MockPerson { sub: string; email: string; name: string; emailVerified?: boolean }
export interface MockIdp { issuer: string; clientId: string; clientSecret: string; close: () => Promise<void>; sign: (claims: Record<string, unknown>, opts?: { alg?: string; kid?: string }) => string; codes: number }

export async function startMockIdp(opts: { port?: number; clientId?: string; clientSecret?: string; people: MockPerson[]; tokenLifetime?: number }): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(6).toString('hex');
  const clientId = opts.clientId ?? 'erp-demo';
  const clientSecret = opts.clientSecret ?? 'mock-secret';
  const codes = new Map<string, { person: MockPerson; nonce: string; challenge: string; redirectUri: string }>();
  let issuer = '';
  const state = { codes: 0 };
  const sign = (claims: Record<string, unknown>, o: { alg?: string; kid?: string } = {}) => jwt(privateKey, { alg: o.alg ?? 'RS256', kid: o.kid ?? kid, typ: 'JWT' }, claims);

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256'] });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [{ ...(publicKey as KeyObject).export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId) return send(400, '<p>MOCK provider: unknown client</p>');
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(400, '<p>MOCK provider: PKCE S256 is required</p>');
      const pick = q.get('user') ?? q.get('login_hint');
      const person = opts.people.find((p) => p.email.toLowerCase() === pick?.toLowerCase() || p.sub === pick);
      if (!person) {
        const links = opts.people.map((p) => `<li><a href="${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(q), user: p.sub })}">${p.name}</a> &lt;${p.email}&gt;</li>`).join('');
        return send(200, `<!doctype html><title>MOCK identity provider</title><body style="font-family:sans-serif;max-width:560px;margin:40px auto"><p style="background:#fde68a;padding:8px"><b>MOCK identity provider</b> for local demos. Not a real sign-in.</p><h1>Sign in as</h1><ul>${links}</ul></body>`);
      }
      const code = randomBytes(16).toString('base64url');
      codes.set(code, { person, nonce: q.get('nonce') ?? '', challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')! });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code); back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }));
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent) : null;
      if (!basic || basic[0] !== clientId || basic[1] !== clientSecret) return send(401, { error: 'invalid_client' });
      const c = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      if (!c) return send(400, { error: 'invalid_grant', error_description: 'unknown or used code' });
      if (c.redirectUri !== body.get('redirect_uri')) return send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      state.codes++;
      const now = Math.floor(Date.now() / 1000);
      const idToken = sign({ iss: issuer, aud: clientId, sub: c.person.sub, email: c.person.email, email_verified: c.person.emailVerified ?? true, name: c.person.name, nonce: c.nonce,
        iat: now, exp: now + (opts.tokenLifetime ?? 300) });
      return send(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  issuer = `http://localhost:${addr.port}`;
  return { issuer, clientId, clientSecret, sign, get codes() { return state.codes; }, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function jwt(key: KeyObject, header: Record<string, unknown>, claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(header)}.${enc(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const people: MockPerson[] = process.env.MOCK_IDP_USERS ? JSON.parse(process.env.MOCK_IDP_USERS) : [
    { sub: 'mock-dana', email: 'dana.walsh@ridgeline.example', name: 'Dana Walsh' },
    { sub: 'mock-marcus', email: 'marcus.kowalski@ridgeline.example', name: 'Marcus Kowalski' },
  ];
  const idp = await startMockIdp({ port: Number(process.env.MOCK_IDP_PORT ?? 3999), people });
  console.log(`MOCK identity provider at ${idp.issuer} (client id ${idp.clientId}, secret ${idp.clientSecret}). Not for real sign-in.`);
}
