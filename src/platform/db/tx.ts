import type pg from 'pg';
import { getPool } from './pool.js';

export interface DbScope {
  tenantId: string;
  userId: string | null;
  /** Facilities the caller may see; ignored when allFacilities is true. */
  facilityIds: string[];
  allFacilities: boolean;
}

export type Tx = pg.PoolClient;

/**
 * Runs fn in a transaction bound to a tenant + facility scope. The settings are
 * transaction-local, so a pooled connection never leaks scope to the next caller.
 * Every request handler and background job must go through here.
 */
export async function withTx<T>(scope: DbScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.facility_ids', $3, true), set_config('app.all_facilities', $4, true)`,
      [scope.tenantId, scope.userId ?? '', `{${scope.facilityIds.join(',')}}`, scope.allFacilities ? 'on' : 'off'],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await tx.query(sql, params);
  return r.rows[0] as T | undefined;
}

export async function many<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await tx.query(sql, params);
  return r.rows as T[];
}

export async function nextSequence(tx: Tx, tenantId: string, key: string): Promise<number> {
  const row = await one<{ value: number }>(
    tx,
    `INSERT INTO tenant_sequence (tenant_id, key, next_value) VALUES ($1, $2, 2)
     ON CONFLICT (tenant_id, key) DO UPDATE SET next_value = tenant_sequence.next_value + 1
     RETURNING next_value - 1 AS value`,
    [tenantId, key],
  );
  return row!.value;
}
