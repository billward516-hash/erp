import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid } from '../../platform/errors.js';
import { actorOf, parse, sendFile } from '../../platform/http/helpers.js';
import { toCsv } from '../reporting/render/csv.js';
import { cancelImport, commitImport, errorReportRows, getBatch, listProfiles, saveProfile, stageImport, suggestForFile } from './service.js';
import { describeTarget, TARGETS } from './targets/registry.js';
import { buildTemplate } from './templates.js';

const ParseOpts = z.object({
  format: z.enum(['csv', 'xlsx', 'json']).optional(), delimiter: z.string().length(1).optional(), encoding: z.string().optional(),
  sheet: z.union([z.string(), z.number().int().positive()]).optional(), headerRow: z.number().int().positive().optional(),
}).optional();
const FilePayload = { fileName: z.string().min(1).max(255), contentBase64: z.string().min(1) };
const Id = z.object({ id: z.string().uuid() });

function decode(b64: string): Buffer {
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw invalid('file content is empty or not base64');
  return buf;
}

export async function importRoutes(app: FastifyInstance) {
  app.get('/imports/targets', async () => TARGETS.map(describeTarget));
  /** A blank file for the target: headers the importer recognises, an example row and a data dictionary (xlsx). */
  app.get('/imports/targets/:key/template', async (req, reply) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-z_0-9]+$/) }), req.params);
    const { format } = parse(z.object({ format: z.enum(['csv', 'xlsx']).default('xlsx') }), req.query);
    return sendFile(reply, await buildTemplate(key, format));
  });
  app.post('/imports/suggest', async (req) => {
    const b = parse(z.object({ target: z.string(), ...FilePayload, parse: ParseOpts }), req.body);
    return suggestForFile(actorOf(req), { target: b.target, fileName: b.fileName, content: decode(b.contentBase64), parse: b.parse });
  });
  app.post('/imports/stage', async (req, reply) => {
    const b = parse(z.object({ target: z.string(), sourceSystem: z.string().min(1).max(64), facilityId: z.string().uuid().nullable().optional(),
      profileId: z.string().uuid().optional(), mapping: z.unknown().optional(), parse: ParseOpts, ...FilePayload }), req.body);
    reply.status(201);
    return stageImport(actorOf(req), { ...b, content: decode(b.contentBase64) });
  });
  app.get('/imports/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const q = parse(z.object({ status: z.enum(['valid', 'warning', 'error', 'committed', 'skipped']).optional(),
      limit: z.coerce.number().int().positive().optional(), offset: z.coerce.number().int().nonnegative().optional() }), req.query);
    return getBatch(actorOf(req), id, q);
  });
  app.post('/imports/:id/commit', async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(z.object({ allowPartial: z.boolean().optional() }).default({}), req.body ?? {});
    return commitImport(actorOf(req), id, b);
  });
  app.post('/imports/:id/cancel', async (req, reply) => {
    const { id } = parse(Id, req.params);
    await cancelImport(actorOf(req), id);
    reply.status(204);
  });
  app.get('/imports/:id/problems.csv', async (req, reply) => {
    const { id } = parse(Id, req.params);
    const r = await errorReportRows(actorOf(req), id);
    return sendFile(reply, { contentType: 'text/csv; charset=utf-8', fileName: r.fileName, body: toCsv(r.columns, r.rows) });
  });
  app.get('/import-profiles', async (req) => listProfiles(actorOf(req)));
  app.post('/import-profiles', async (req, reply) => {
    const b = parse(z.object({ name: z.string().min(1).max(100), target: z.string(), sourceSystem: z.string().min(1).max(64), mapping: z.unknown() }), req.body);
    reply.status(201);
    return saveProfile(actorOf(req), { ...b, mapping: b.mapping });
  });
}
