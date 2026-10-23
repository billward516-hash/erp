/**
 * Backup and restore drill (brief §13.2 "backups and recovery testing"). Takes a consistent dump of a database,
 * restores it into a scratch database, and proves the copy is complete and still secure:
 *   - the same migrations, and the same row count in every table, as the source at the moment of the dump
 *   - every company's audit chain still verifies
 *   - row-level security is still on, with the same policies, and the runtime role still sees nothing without a
 *     company context (fail closed) and only that company's rows with one
 * Writes a report with timings (the restore time is the recovery-time evidence) and exits non-zero on any failure.
 *
 *   npx tsx scripts/backup-drill.ts [--source postgres://owner@host:port/db] [--keep]
 *
 * Production runs it against a restored snapshot of the managed database on a schedule; roles are cluster-level and
 * must exist on the target first (pg_dumpall --roles-only, or the provider's equivalent).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { config } from '../src/config.js';

const run = promisify(execFile);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const source = arg('--source') ?? process.env.DATABASE_ADMIN_URL ?? config.databaseAdminUrl;
const keep = process.argv.includes('--keep');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const dir = process.env.BACKUP_DIR ?? './.storage/backups';
const drillDb = `erp_drill_${stamp.toLowerCase()}`;
const target = (() => { const u = new URL(source); u.pathname = `/${drillDb}`; return u.toString(); })();
const runtimeUrl = (db: string) => { const u = new URL(process.env.DATABASE_URL ?? config.databaseUrl); u.pathname = `/${db}`; return u.toString(); };

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };
const ms = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)} s`;

async function counts(c: pg.Client) {
  const tables = (await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)).rows.map((r) => r.relname as string);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await c.query(`SELECT count(*) FROM "${t}"`)).rows[0].count);
  return out;
}
const security = (c: pg.Client) => c.query(`SELECT c.relname, c.relrowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`).then((r) => r.rows);
const migrations = (c: pg.Client) => c.query('SELECT name FROM schema_migration ORDER BY name').then((r) => r.rows.map((x) => x.name as string));

await mkdir(dir, { recursive: true });
const file = `${dir}/erp-${stamp}.dump`;

// 1. A consistent dump: pg_dump reads the snapshot that the counting transaction holds open.
const src = new pg.Client({ connectionString: source });
await src.connect();
await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
const snapshot = (await src.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
let t = Date.now();
await run('pg_dump', ['--format=custom', `--snapshot=${snapshot}`, `--file=${file}`, source]);
const dumpTime = ms(t);
const expected = { counts: await counts(src), security: await security(src), migrations: await migrations(src) };
await src.query('COMMIT');
await src.end();
const size = (await stat(file)).size;
const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
check('dump', size > 0, `${(size / 1024 / 1024).toFixed(1)} MB in ${dumpTime}, sha256 ${sha256.slice(0, 16)}…`);

// 2. Restore into a scratch database.
const admin = new pg.Client({ connectionString: source });
await admin.connect();
await admin.query(`CREATE DATABASE ${drillDb}`);
await admin.query(`GRANT CONNECT ON DATABASE ${drillDb} TO erp_app`);
t = Date.now();
let restoreTime = '';
try {
  await run('pg_restore', ['--exit-on-error', '--no-comments', `--dbname=${target}`, file]);
  restoreTime = ms(t);
  check('restore', true, `restored into ${drillDb} in ${restoreTime}`);

  // 3. Prove the copy.
  const dst = new pg.Client({ connectionString: target });
  await dst.connect();
  const got = { counts: await counts(dst), security: await security(dst), migrations: await migrations(dst) };
  check('migrations', JSON.stringify(got.migrations) === JSON.stringify(expected.migrations), `${got.migrations.length} applied, last ${got.migrations.at(-1)}`);
  const diff = Object.keys({ ...expected.counts, ...got.counts }).filter((k) => expected.counts[k] !== got.counts[k]);
  const rows = Object.values(got.counts).reduce((s, n) => s + n, 0);
  check('row counts', diff.length === 0, diff.length ? `differ in ${diff.slice(0, 5).map((k) => `${k} (${expected.counts[k]} → ${got.counts[k]})`).join(', ')}` : `${Object.keys(got.counts).length} tables, ${rows} rows, all equal`);
  const secDiff = expected.security.filter((e, i) => JSON.stringify(e) !== JSON.stringify(got.security[i]));
  const rls = got.security.filter((s) => s.relrowsecurity).length;
  check('row-level security', secDiff.length === 0, secDiff.length ? `changed on ${secDiff.map((s) => s.relname).slice(0, 5).join(', ')}` : `on for ${rls} tables with the same policies`);
  const tenants = (await dst.query('SELECT id, slug FROM tenant ORDER BY slug')).rows;
  const broken: string[] = [];
  for (const tn of tenants) {
    await dst.query('BEGIN');
    await dst.query(`SELECT set_config('app.tenant_id', $1, true)`, [tn.id]);
    const bad = (await dst.query('SELECT audit_verify_chain() AS bad')).rows[0].bad;
    await dst.query('COMMIT');
    if (bad != null) broken.push(`${tn.slug} (event ${bad})`);
  }
  check('audit chains', broken.length === 0, broken.length ? `broken for ${broken.join(', ')}` : `verified for all ${tenants.length} companies`);
  await dst.end();

  // The runtime role on the copy: nothing without a company, only that company's rows with one.
  const app = new pg.Client({ connectionString: runtimeUrl(drillDb) });
  await app.connect();
  const none = Number((await app.query('SELECT count(*) FROM audit_event')).rows[0].count);
  const first = tenants[0];
  let own = 0; let others = 0;
  if (first) {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.all_facilities', 'true', true)`, [first.id]);
    own = Number((await app.query('SELECT count(*) FROM audit_event')).rows[0].count);
    others = Number((await app.query('SELECT count(*) FROM audit_event WHERE tenant_id <> $1', [first.id])).rows[0].count);
    await app.query('COMMIT');
  }
  check('fail closed', none === 0 && others === 0 && (!first || own > 0), `runtime role sees ${none} audit rows without a company, ${own} for ${first?.slug ?? '—'}, ${others} of other companies`);
  await app.end();
} catch (e) {
  check('restore', false, (e as Error).message.split('\n')[0]!);
} finally {
  if (!keep) await admin.query(`DROP DATABASE IF EXISTS ${drillDb} WITH (FORCE)`);
  await admin.end();
}

const failed = checks.filter((c) => !c.ok);
const report = [`# Backup and restore drill ${new Date().toISOString()}`, '', `**${failed.length ? `FAILED (${failed.length} check${failed.length === 1 ? '' : 's'})` : 'Passed'}.** Source ${new URL(source).host}${new URL(source).pathname}; dump \`${file}\`; recovery time (restore) ${restoreTime || 'n/a'}.`, '',
  '| Check | Result | Detail |', '|---|---|---|', ...checks.map((c) => `| ${c.name} | ${c.ok ? 'ok' : '**FAIL**'} | ${c.detail} |`), '', keep ? `Restored database kept: ${drillDb}` : 'Restored database dropped.'].join('\n');
await writeFile(`${dir}/drill-${stamp}.md`, `${report}\n`);
console.log(`report: ${dir}/drill-${stamp}.md`);
process.exit(failed.length ? 1 : 0);
