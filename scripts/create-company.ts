/**
 * Creates a company (control plane, D-183A). There is deliberately no customer-facing screen for this: a company is
 * created by whoever operates the platform. It wraps provisionTenant (the same function the seed scripts and tests use),
 * adds the first administrator, and prints that person's first API token ONCE. Only the token's hash is stored.
 *
 *   npx tsx scripts/create-company.ts --slug ridge-works --name "Ridge Works Inc" --admin-email ada@ridgeworks.example
 *
 * Needs DATABASE_ADMIN_URL (the owner connection), like npm run db:migrate. Run `--help` for every option.
 */
import { parseArgs } from 'node:util';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken, provisionTenant } from '../src/platform/tenancy/provision.js';

const HELP = `Create a company and its first administrator.

Usage:
  npx tsx scripts/create-company.ts --slug <slug> --name <company name> --admin-email <email> [options]

Required:
  --slug <slug>            Short unique id for the company: 2 to 63 characters, lower-case letters, digits and hyphens.
                           It is what people type on the sign-in page ("ridge-works").
  --name <name>            The company's name as people see it.
  --admin-email <email>    Work email of the first administrator (they hold the Administrator role at every site).

Options:
  --edition <lite|standard>  Default standard. Lite is one site, five users, books and the intranet (see docs/EDITIONS.md).
  --admin-name <name>        The administrator's display name. Default: "Administrator".
  --site-code <code>         Code of the first site. Default HQ.
  --site-name <name>         Name of the first site. Default "Head office".
  --timezone <iana zone>     Time zone of the first site. Default America/New_York.
  --legal-entity <name>      Legal entity name. Default: the company name.
  --token-days <n>           Days until the first token expires. Default 14; 0 means it never expires.
                             Short is better: the administrator signs in with it, sets up single sign-on, then issues
                             longer-lived tokens under People and access -> Tokens and revokes this one.
  --help                     Show this text.

What it prints: the company id and the first token. The token is shown ONCE and cannot be recovered; if it is lost,
create another administrator the same way, or issue a token from a screen when another administrator can sign in.
Nothing is created if any step fails. The creation is recorded in the company's audit trail.
`;

const { values: v } = parseArgs({
  options: {
    slug: { type: 'string' }, name: { type: 'string' }, 'admin-email': { type: 'string' }, 'admin-name': { type: 'string' }, edition: { type: 'string' },
    'site-code': { type: 'string' }, 'site-name': { type: 'string' }, timezone: { type: 'string' }, 'legal-entity': { type: 'string' }, 'token-days': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

function fail(message: string): never {
  console.error(`create-company: ${message}\n\nRun with --help for usage.`);
  process.exit(2);
}

if (v.help) { console.log(HELP); process.exit(0); }
if (!v.slug || !v.name || !v['admin-email']) fail('--slug, --name and --admin-email are required');
if (!/^[a-z0-9-]{2,63}$/.test(v.slug)) fail('--slug must be 2 to 63 characters: lower-case letters, digits and hyphens');
const email = v['admin-email'].trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${v['admin-email']}" does not look like an email address`);
const edition = (v.edition ?? 'standard') as 'lite' | 'standard';
if (edition !== 'lite' && edition !== 'standard') fail('--edition must be lite or standard');
const days = v['token-days'] === undefined ? 14 : Number(v['token-days']);
if (!Number.isInteger(days) || days < 0 || days > 3660) fail('--token-days must be a whole number of days from 0 to 3660');
const timezone = v.timezone ?? 'America/New_York';
try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { fail(`"${timezone}" is not a time zone (try America/Chicago)`); }

const db = getAdminPool();
try {
  if ((await db.query('SELECT 1 FROM tenant WHERE slug = $1', [v.slug])).rowCount) fail(`a company with the slug "${v.slug}" already exists`);
  const t = await provisionTenant(db, {
    slug: v.slug, name: v.name, legalEntity: v['legal-entity'] ?? v.name, edition,
    facilities: [{ code: (v['site-code'] ?? 'HQ').toUpperCase(), name: v['site-name'] ?? 'Head office', timezone }],
  });
  const admin = await createUserWithToken(db, t.tenantId, {
    email, displayName: v['admin-name'] ?? 'Administrator', roles: [{ role: 'admin', facility: null }], tokenLabel: 'First administrator (setup)',
  });
  if (days > 0) await db.query(`UPDATE api_token SET expires_at = now() + make_interval(days => $2) WHERE user_id = $1`, [admin.userId, days]);
  await db.query(`INSERT INTO audit_event (tenant_id, actor_user_id, action, entity_type, entity_id, data) VALUES ($1, NULL, 'company.created', 'tenant', $1, $2)`,
    [t.tenantId, { slug: v.slug, edition, firstAdmin: email, via: 'scripts/create-company.ts' }]);
  console.log(`Company created: ${v.name} (${v.slug}), ${edition} edition`);
  console.log(`  company id:  ${t.tenantId}`);
  console.log(`  first site:  ${(v['site-code'] ?? 'HQ').toUpperCase()} (${timezone})`);
  console.log(`  administrator: ${email}  (user id ${admin.userId})`);
  console.log(`  token expires: ${days > 0 ? `in ${days} days` : 'never'}`);
  console.log('');
  console.log('  FIRST ADMINISTRATOR TOKEN (shown once; store it now, only its hash is kept):');
  console.log(`  ${admin.token}`);
  console.log('');
  console.log('Next: sign in with the token, add people under People and access, set up Sign-in (single sign-on), then revoke this token.');
  console.log('Field service is licensed per site: npx tsx scripts/set-entitlement.ts --help');
} catch (e) {
  console.error(`create-company failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePools();
}
