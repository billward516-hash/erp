import pg from 'pg';
import { config } from '../../config.js';

// numeric -> JS number is lossy for very large values; operational quantities/costs here are
// well inside double precision. Revisit (decimal library) before financial postings.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// date columns stay as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

let appPool: pg.Pool | undefined;
let adminPool: pg.Pool | undefined;

/** Runtime pool: connects as erp_app, which is subject to row-level security. */
export function getPool(): pg.Pool {
  appPool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  return appPool;
}

/** Owner pool: migrations and tenant provisioning only. Never used to serve requests. */
export function getAdminPool(): pg.Pool {
  adminPool ??= new pg.Pool({ connectionString: config.databaseAdminUrl, max: 2 });
  return adminPool;
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool?.end(), adminPool?.end()]);
  appPool = undefined;
  adminPool = undefined;
}
