/**
 * Licence switches (control plane, D-183A): a company's edition, and the field-service module per site. There is
 * deliberately no customer-facing screen for these. Changes take effect within a minute for the edition (it is cached
 * briefly by the server) and at once for field service.
 *
 *   npx tsx scripts/set-entitlement.ts --company ridge-works --list
 *   npx tsx scripts/set-entitlement.ts --company ridge-works --field-service on  --site NORTH --site SOUTH
 *   npx tsx scripts/set-entitlement.ts --company ridge-works --field-service off --all-sites
 *   npx tsx scripts/set-entitlement.ts --company ridge-works --edition lite
 *
 * Needs DATABASE_ADMIN_URL (the owner connection). Run `--help` for every option.
 */
import { parseArgs } from 'node:util';
import { LITE_LIMITS } from '../src/platform/auth/permissions.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';

const HELP = `Show or change a company's licence.

Usage:
  npx tsx scripts/set-entitlement.ts --company <slug> --list
  npx tsx scripts/set-entitlement.ts --company <slug> --field-service <on|off> (--site <code>... | --all-sites)
  npx tsx scripts/set-entitlement.ts --company <slug> --edition <lite|standard>

Options:
  --company <slug>           The company's slug (as given to create-company). Required.
  --list                     Show the edition, user and site counts, and which sites have field service. Changes nothing.
  --field-service <on|off>   Switch the field-service module on or off. Licensed PER SITE: name the sites with --site
                             (repeat it) or use --all-sites. Without the licence at a site the module answers HTTP 402 there.
                             Turning it off keeps all field-service records; they are hidden and refused until it is back on.
  --site <code>              A site code (for example NORTH). Repeatable.
  --all-sites                Every active site of the company.
  --edition <lite|standard>  Change the edition. Nothing is migrated (both editions use the same records). Going to
                             lite is refused while the company has more than ${LITE_LIMITS.siteCap} active site or ${LITE_LIMITS.userCap} active users; going to standard lifts the limits.
                             Expense approval routing is not rewritten; the company edits it under Expenses.
  --help                     Show this text.

Every change is recorded in the company's audit trail (action licence.changed). Nothing is changed if any step fails.
`;

const { values: v } = parseArgs({
  options: { company: { type: 'string' }, list: { type: 'boolean' }, 'field-service': { type: 'string' }, site: { type: 'string', multiple: true }, 'all-sites': { type: 'boolean' }, edition: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  strict: true,
});

function fail(message: string): never {
  console.error(`set-entitlement: ${message}\n\nRun with --help for usage.`);
  process.exit(2);
}
if (v.help) { console.log(HELP); process.exit(0); }
if (!v.company) fail('--company is required');
const wantsFs = v['field-service'];
if (wantsFs !== undefined && wantsFs !== 'on' && wantsFs !== 'off') fail('--field-service must be on or off');
if (v.edition !== undefined && v.edition !== 'lite' && v.edition !== 'standard') fail('--edition must be lite or standard');
if (!v.list && wantsFs === undefined && v.edition === undefined) fail('say what to do: --list, --field-service or --edition');
if (wantsFs !== undefined && !v['all-sites'] && !v.site?.length) fail('--field-service needs --site <code> (repeatable) or --all-sites');
if (v['all-sites'] && v.site?.length) fail('use --all-sites or --site, not both');

const db = getAdminPool();
const client = await db.connect();
try {
  await client.query('BEGIN');
  const t = (await client.query('SELECT id, name FROM tenant WHERE slug = $1', [v.company])).rows[0];
  if (!t) fail(`no company with the slug "${v.company}"`);
  const audit = (data: Record<string, unknown>) => client.query(
    `INSERT INTO audit_event (tenant_id, actor_user_id, action, entity_type, entity_id, data) VALUES ($1, NULL, 'licence.changed', 'tenant', $1, $2)`, [t.id, { ...data, via: 'scripts/set-entitlement.ts' }]);

  if (v.edition !== undefined) {
    const lic = (await client.query('SELECT edition FROM tenant_license WHERE tenant_id = $1 FOR UPDATE', [t.id])).rows[0];
    const users = (await client.query(`SELECT count(*)::int AS n FROM app_user WHERE tenant_id = $1 AND status = 'active'`, [t.id])).rows[0].n;
    const sites = (await client.query('SELECT count(*)::int AS n FROM facility WHERE tenant_id = $1 AND active', [t.id])).rows[0].n;
    if (v.edition === 'lite' && (users > LITE_LIMITS.userCap || sites > LITE_LIMITS.siteCap)) {
      fail(`${t.name} has ${users} active users and ${sites} active sites; Lite allows ${LITE_LIMITS.userCap} users and ${LITE_LIMITS.siteCap} site. Disable users or deactivate sites first.`);
    }
    const lite = v.edition === 'lite';
    await client.query('UPDATE tenant_license SET edition = $2, user_cap = $3, site_cap = $4, single_person_approval = $5 WHERE tenant_id = $1',
      [t.id, v.edition, lite ? LITE_LIMITS.userCap : null, lite ? LITE_LIMITS.siteCap : null, lite]);
    await audit({ edition: { from: lic?.edition ?? 'standard', to: v.edition } });
    console.log(`edition: ${lic?.edition ?? 'standard'} -> ${v.edition}`);
  }

  if (wantsFs !== undefined) {
    const sites = (await client.query('SELECT id, code, active FROM facility WHERE tenant_id = $1 ORDER BY code', [t.id])).rows;
    const chosen = v['all-sites'] ? sites.filter((s) => s.active) : (v.site ?? []).map((code) => sites.find((s) => s.code.toLowerCase() === code.toLowerCase()) ?? fail(`${t.name} has no site with the code "${code}" (sites: ${sites.map((s) => s.code).join(', ')})`));
    if (!chosen.length) fail('the company has no active sites');
    for (const s of chosen) {
      if (wantsFs === 'on') {
        await client.query(`INSERT INTO facility_entitlement (tenant_id, facility_id, module_key, active_from, active_to) VALUES ($1, $2, 'field_service', current_date, NULL)
          ON CONFLICT (facility_id, module_key) DO UPDATE SET active_from = LEAST(facility_entitlement.active_from, current_date), active_to = NULL`, [t.id, s.id]);
      } else {
        await client.query(`DELETE FROM facility_entitlement WHERE facility_id = $1 AND module_key = 'field_service'`, [s.id]);
      }
    }
    await audit({ module: 'field_service', set: wantsFs, sites: chosen.map((s) => s.code) });
    console.log(`field service ${wantsFs} at: ${chosen.map((s) => s.code).join(', ')}`);
  }

  if (v.list || wantsFs !== undefined || v.edition !== undefined) {
    const lic = (await client.query('SELECT edition, user_cap, site_cap FROM tenant_license WHERE tenant_id = $1', [t.id])).rows[0];
    const users = (await client.query(`SELECT count(*)::int AS n FROM app_user WHERE tenant_id = $1 AND status = 'active'`, [t.id])).rows[0].n;
    const sites = (await client.query(`SELECT f.code, f.name, f.active, EXISTS (SELECT 1 FROM facility_entitlement e WHERE e.facility_id = f.id AND e.module_key = 'field_service'
      AND e.active_from <= current_date AND (e.active_to IS NULL OR e.active_to >= current_date)) AS fs FROM facility f WHERE f.tenant_id = $1 ORDER BY f.code`, [t.id])).rows;
    console.log(`${t.name} (${v.company}): ${lic?.edition ?? 'standard'} edition, ${users} active users${lic?.user_cap ? ` of ${lic.user_cap}` : ''}, ${sites.filter((s) => s.active).length} active sites${lic?.site_cap ? ` of ${lic.site_cap}` : ''}`);
    for (const s of sites) console.log(`  ${s.code.padEnd(10)} ${s.name}${s.active ? '' : ' (inactive)'}  field service: ${s.fs ? 'ON' : 'off'}`);
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`set-entitlement failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await closePools();
}
