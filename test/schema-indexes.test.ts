import { afterAll, describe, expect, it } from 'vitest';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';

/** S45: row-level security on child tables tests the parent row; every foreign key to a business record needs an index or the planner scans the child per parent. */
afterAll(async () => { await closePools(); });
describe('foreign key indexes', () => {
  it('every single-column foreign key to a business record is the leading column of an index', async () => {
    const rows = (await getAdminPool().query(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.connamespace = 'public'::regnamespace AND c.confrelid::regclass::text NOT IN ('app_user', 'tenant')
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]) ORDER BY 1, 2`)).rows;
    expect(rows.map((r) => `${r.tbl}.${r.col}`)).toEqual([]);
  });
});
