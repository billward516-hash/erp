import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { callbackUrl, discover, encryptSecret } from '../../platform/auth/sso.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { one } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';

/** Single sign-on settings for the company (D-140). The client secret is write-only and stored encrypted. */
export async function getSso(tx: Tx, actor: Actor) {
  requirePermission(actor, 'tenant.admin');
  const s = await one(tx, `SELECT issuer, client_id, client_secret_enc IS NOT NULL AS has_secret, email_domains, link_by_email, enabled, allow_tokens, updated_at FROM tenant_sso`);
  const me = await one(tx, 'SELECT sso_subject IS NOT NULL AS linked FROM app_user WHERE id = $1', [actor.userId]);
  return { settings: s, callbackUrl: callbackUrl(), youAreLinked: !!me?.linked };
}

export async function saveSso(tx: Tx, actor: Actor, input: { issuer: string; clientId: string; clientSecret?: string | null; emailDomains: string[]; linkByEmail?: boolean; enabled: boolean; allowTokens?: boolean }) {
  requirePermission(actor, 'tenant.admin');
  const issuer = input.issuer.trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer)) throw invalid('the issuer must be an https address');
  const domains = [...new Set(input.emailDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  if (domains.some((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) throw invalid('email domains look like example.com');
  if (input.enabled && !domains.length) throw invalid('give at least one work-email domain so people can find the company at sign-in');
  if (input.enabled) await discover(issuer); // fails clearly if the provider cannot be reached or misreports its issuer
  if (input.enabled && input.allowTokens === false && !(await one(tx, 'SELECT 1 FROM app_user WHERE id = $1 AND sso_subject IS NOT NULL', [actor.userId]))) {
    throw invalid('sign in once with single sign-on yourself before turning API tokens off, so you cannot lock yourself out');
  }
  const prior = await one(tx, 'SELECT client_secret_enc FROM tenant_sso');
  const secret = input.clientSecret === undefined ? prior?.client_secret_enc ?? null : input.clientSecret ? encryptSecret(input.clientSecret) : null;
  await tx.query(`INSERT INTO tenant_sso (tenant_id, issuer, client_id, client_secret_enc, email_domains, link_by_email, enabled, allow_tokens, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (tenant_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, email_domains = EXCLUDED.email_domains,
      link_by_email = EXCLUDED.link_by_email, enabled = EXCLUDED.enabled, allow_tokens = EXCLUDED.allow_tokens, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [actor.tenantId, issuer, input.clientId.trim(), secret, domains, input.linkByEmail ?? true, input.enabled, input.allowTokens ?? true, actor.userId]);
  await audit(tx, actor, { action: 'sso.configured', entityType: 'tenant_sso', entityId: actor.tenantId,
    data: { issuer, clientId: input.clientId, secretChanged: input.clientSecret !== undefined, emailDomains: domains, linkByEmail: input.linkByEmail ?? true, enabled: input.enabled, allowTokens: input.allowTokens ?? true } });
  return getSso(tx, actor);
}
