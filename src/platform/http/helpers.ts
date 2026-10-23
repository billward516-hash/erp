import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Actor } from '../auth/actor.js';
import { AppError, invalid } from '../errors.js';

export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid('request validation failed', r.error.flatten());
  return r.data;
}

/**
 * The request path as the router sees it: each segment percent-decoded (D-161). Gates that look at the path (sign-in,
 * edition, feature visibility, rate limits) must use this, not the raw URL, or `/%61pi/…` would reach an /api route
 * without passing them. Query strings are dropped; a malformed escape leaves its segment as it is.
 */
export function requestPath(url: string): string {
  return url.split('?')[0]!.split('/').map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } }).join('/');
}

export function actorOf(req: FastifyRequest): Actor {
  const a = (req as FastifyRequest & { actor?: Actor }).actor;
  if (!a) throw new AppError(401, 'unauthenticated', 'authentication required');
  return a;
}

export function sendFile(reply: FastifyReply, out: { contentType: string; fileName?: string; body: unknown }, inline = false) {
  reply.header('content-type', out.contentType);
  if (out.fileName) reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${out.fileName.replace(/["\r\n]/g, '')}"`);
  reply.header('cache-control', 'private, no-store');
  return reply.send(out.body);
}
