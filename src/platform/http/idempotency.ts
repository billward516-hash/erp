import type { FastifyInstance } from 'fastify';
import { getAdminPool } from '../db/pool.js';
import { AppError } from '../errors.js';

/**
 * Idempotency-Key support for writes (D-121). A request carrying the header is answered once: the first successful
 * (2xx) response is stored per user and key and replayed, with `Idempotent-Replay: true`, for any repeat of the same
 * method and path. Reusing a key for a different request is refused. Errors are not stored, so a request that failed
 * (for example while a work order was on hold) can succeed when retried after the cause is fixed.
 */
export function registerIdempotency(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !req.actor || req.method === 'GET' || req.method === 'HEAD') return;
    if (key.length < 8 || key.length > 100) throw new AppError(400, 'bad_request', 'Idempotency-Key must be 8 to 100 characters');
    const r = (await getAdminPool().query('SELECT method, path, status, content_type, body FROM idempotency_record WHERE tenant_id = $1 AND user_id = $2 AND key = $3',
      [req.actor.tenantId, req.actor.userId, key])).rows[0];
    if (r) {
      if (r.method !== req.method || r.path !== req.url) throw new AppError(422, 'idempotency_key_reused', 'this Idempotency-Key was used for a different request');
      reply.header('idempotent-replay', 'true').status(r.status);
      if (r.content_type) reply.type(r.content_type);
      return reply.send(r.body);
    }
    (req as { idempotencyKey?: string }).idempotencyKey = key;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const key = (req as { idempotencyKey?: string }).idempotencyKey;
    if (!key || !req.actor || reply.statusCode < 200 || reply.statusCode >= 300 || reply.getHeader('idempotent-replay')) return payload;
    await getAdminPool().query(`INSERT INTO idempotency_record (tenant_id, user_id, key, method, path, status, content_type, body) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT DO NOTHING`, [req.actor.tenantId, req.actor.userId, key, req.method, req.url, reply.statusCode, String(reply.getHeader('content-type') ?? '') || null,
      typeof payload === 'string' ? payload : payload == null ? '' : Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)]);
    return payload;
  });
}

/** Removes records older than 7 days (daily sweep). */
export async function purgeIdempotency(tenantId: string) {
  return (await getAdminPool().query(`DELETE FROM idempotency_record WHERE tenant_id = $1 AND created_at < now() - interval '7 days'`, [tenantId])).rowCount ?? 0;
}
