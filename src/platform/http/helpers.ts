import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../auth/actor.js';
import { AppError, invalid } from '../errors.js';

/**
 * A yes/no query parameter (D-161): "true"/"1" are yes, "false"/"0"/"" are no, anything else is refused. Not
 * z.coerce.boolean(), which reads any non-empty string, "false" included, as yes.
 */
export const qbool = z.union([z.boolean(), z.enum(['true', '1', 'false', '0', '']).transform((v) => v === 'true' || v === '1')]);

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

/** A file name safe inside a quoted Content-Disposition parameter: printable ASCII only, no quotes, backslashes or path separators. */
export const safeFileName = (name: string) => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/:*?<>|]/g, '_').trim().slice(0, 150) || 'file';
/** Types a browser would run or render as a page if opened from our origin; never served inline. */
const ACTIVE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-javascript|text\/css)/i;

/**
 * Sends a file. Files people uploaded are untrusted: active types (HTML, SVG, scripts) are sent as an opaque download, the response is
 * sandboxed by a content-security-policy, the name cannot break out of the header, and nothing is cached.
 */
export function sendFile(reply: FastifyReply, out: { contentType: string; fileName?: string; body: unknown }, inline = false) {
  const active = ACTIVE.test(out.contentType);
  reply.header('content-type', active ? 'application/octet-stream' : out.contentType);
  if (out.fileName) reply.header('content-disposition', `${inline && !active ? 'inline' : 'attachment'}; filename="${safeFileName(out.fileName)}"`);
  reply.header('content-security-policy', "sandbox; default-src 'none'");
  reply.header('cache-control', 'private, no-store');
  return reply.send(out.body);
}
