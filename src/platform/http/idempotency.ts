import type { FastifyInstance } from 'fastify';
import { getAdminPool } from '../db/pool.js';
import { AppError } from '../errors.js';

/**
 * Idempotency-Key support for writes (D-121). A request carrying the header is answered once: the first successful
 * (2xx) response is stored per user and key and replayed, with `Idempotent-Replay: true`, for any repeat of the same
 * method and path. Reusing a key for a different request is refused. Errors are not stored, so a request that failed
 * (for example while a work order was on hold) can succeed when retried after the cause is fixed.
 *
 * The key is reserved (status 0) while the first request runs, so a repeat sent before it finishes (a double tap, a
 * retry on a slow network) is refused as in progress instead of running twice (D-161). A reservation left by a request
 * that never finished expires after five minutes.
 */
type Marked = { idempotencyKey?: string; idempotencyDone?: boolean };
export function registerIdempotency(app: FastifyInstance) {
  const pool = () => getAdminPool();
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !req.actor || req.method === 'GET' || req.method === 'HEAD') return;
    if (key.length < 8 || key.length > 100) throw new AppError(400, 'bad_request', 'Idempotency-Key must be 8 to 100 characters');
    const ids = [req.actor.tenantId, req.actor.userId, key];
    await pool().query(`DELETE FROM idempotency_record WHERE tenant_id = $1 AND user_id = $2 AND key = $3 AND status = 0 AND created_at < now() - interval '5 minutes'`, ids);
    const reserved = await pool().query(`INSERT INTO idempotency_record (tenant_id, user_id, key, method, path, status, body) VALUES ($1, $2, $3, $4, $5, 0, '')
      ON CONFLICT DO NOTHING RETURNING 1`, [...ids, req.method, req.url]);
    if (!reserved.rowCount) {
      const r = (await pool().query('SELECT method, path, status, content_type, body FROM idempotency_record WHERE tenant_id = $1 AND user_id = $2 AND key = $3', ids)).rows[0];
      if (!r) throw new AppError(409, 'idempotency_in_progress', 'a request with this Idempotency-Key just finished; retry it');
      if (r.method !== req.method || r.path !== req.url) throw new AppError(422, 'idempotency_key_reused', 'this Idempotency-Key was used for a different request');
      if (r.status === 0) throw new AppError(409, 'idempotency_in_progress', 'a request with this Idempotency-Key is still being processed; retry shortly');
      reply.header('idempotent-replay', 'true').status(r.status);
      if (r.content_type) reply.type(r.content_type);
      return reply.send(r.body);
    }
    (req as Marked).idempotencyKey = key;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const m = req as Marked;
    if (!m.idempotencyKey || !req.actor || m.idempotencyDone) return payload;
    m.idempotencyDone = true;
    const ids = [req.actor.tenantId, req.actor.userId, m.idempotencyKey];
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      await pool().query('DELETE FROM idempotency_record WHERE tenant_id = $1 AND user_id = $2 AND key = $3 AND status = 0', ids);
      return payload;
    }
    await pool().query(`UPDATE idempotency_record SET status = $4, content_type = $5, body = $6 WHERE tenant_id = $1 AND user_id = $2 AND key = $3 AND status = 0`,
      [...ids, reply.statusCode, String(reply.getHeader('content-type') ?? '') || null,
        typeof payload === 'string' ? payload : payload == null ? '' : Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)]);
    return payload;
  });
  // A request that ended without sending (the client went away) releases its key.
  app.addHook('onResponse', async (req) => {
    const m = req as Marked;
    if (m.idempotencyKey && req.actor && !m.idempotencyDone) {
      await pool().query('DELETE FROM idempotency_record WHERE tenant_id = $1 AND user_id = $2 AND key = $3 AND status = 0', [req.actor.tenantId, req.actor.userId, m.idempotencyKey]);
    }
  });
}

/** Removes records older than 7 days (daily sweep). */
export async function purgeIdempotency(tenantId: string) {
  return (await getAdminPool().query(`DELETE FROM idempotency_record WHERE tenant_id = $1 AND created_at < now() - interval '7 days'`, [tenantId])).rowCount ?? 0;
}
