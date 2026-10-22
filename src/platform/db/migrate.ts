import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../../config.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(connectionString = config.databaseAdminUrl, opts: { reset?: boolean } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (opts.reset) {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return ran;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate(undefined, { reset: process.argv.includes('--reset') })
    .then((ran) => console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
