import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Actor } from '../auth/actor.js';
import { AppError, invalid } from '../errors.js';

export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid('request validation failed', r.error.flatten());
  return r.data;
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
