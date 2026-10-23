/**
 * Start command for a hosted TEST site (render.yaml). On every start:
 *   1. creates the application database login (erp_app) with a generated password, or updates its password;
 *   2. applies any new migrations;
 *   3. on the very first start only (no company exists yet) and when SEED_DEMO is not "0", loads the fictional sample companies
 *      and prints the sign-in tokens once, also saved on the persistent disk (STORAGE_DIR/dev-tokens.json);
 *   4. starts the server.
 * Needs: DATABASE_ADMIN_URL (the database owner's connection string), APP_SECRET (a long random value), STORAGE_DIR on a persistent disk.
 * RENDER_EXTERNAL_URL (or APP_BASE_URL) gives the public https address. This is for sample data and testing; a real customer deployment
 * signs in through its identity provider and never runs the demo seed (docs/HOSTING.md).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';

const env = process.env;
const need = (k: string) => { const v = env[k]; if (!v) { console.error(`${k} is not set`); process.exit(1); } return v; };
const adminUrl = need('DATABASE_ADMIN_URL');
const secret = need('APP_SECRET');
if (secret.length < 24) { console.error('APP_SECRET must be at least 24 characters'); process.exit(1); }

const derive = (label: string) => createHash('sha256').update(`${label}:${secret}`).digest();
const appPassword = derive('db').toString('hex').slice(0, 40);
const u = new URL(adminUrl);
const appUrl = new URL(adminUrl); appUrl.username = 'erp_app'; appUrl.password = appPassword;

env.DATABASE_URL = appUrl.toString();
env.APP_BASE_URL ??= env.RENDER_EXTERNAL_URL ?? '';
env.SSO_SECRET_KEY = derive('sso').toString('base64');
env.TRUST_PROXY ??= '1';
env.NODE_ENV = 'production';

// 1. The application login. Migration 0001 creates it with a development password when it is missing, so it is created here first.
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const has = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'erp_app'`)).rowCount;
try {
  await admin.query(has ? `ALTER ROLE erp_app PASSWORD ${q(appPassword)}` : `CREATE ROLE erp_app LOGIN PASSWORD ${q(appPassword)} NOSUPERUSER NOBYPASSRLS`);
} catch (e) {
  console.error(`Could not create or update the database login erp_app: ${(e as Error).message}
The database owner needs permission to create roles. Ask the database host to allow it, or create the login once by hand:
  CREATE ROLE erp_app LOGIN PASSWORD '<any long random value>' NOSUPERUSER NOBYPASSRLS;
and set DATABASE_URL to that login's connection string (see docs/HOSTING.md).`);
  process.exit(1);
}
await admin.end();
console.log(`database login ready on ${u.hostname}`);

// 2 and 3. Migrations, then the sample companies on a database that has none. Imported late: they read the environment when loaded.
const { migrate } = await import('../src/platform/db/migrate.js');
const ran = await migrate(adminUrl);
console.log(ran.length ? `applied ${ran.length} migration(s)` : 'database up to date');

const probe = new pg.Client({ connectionString: adminUrl });
await probe.connect();
const companies = Number((await probe.query('SELECT count(*) FROM tenant')).rows[0].count);
await probe.end();
if (companies === 0 && env.SEED_DEMO !== '0') {
  console.log('first start: loading the sample companies (about a minute)');
  const r = spawnSync('npx', ['tsx', 'scripts/seed.ts'], { stdio: 'inherit', env: { ...env, NODE_ENV: 'development', DATABASE_URL: appUrl.toString(), DATABASE_ADMIN_URL: adminUrl } });
  if (r.status !== 0) { console.error('loading the sample companies failed'); process.exit(1); }
  console.log('The sign-in tokens above are also saved in STORAGE_DIR/dev-tokens.json');
}

// 4. The server.
await import('../src/server.js');
