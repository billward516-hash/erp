import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, parse, sendFile } from '../../platform/http/helpers.js';
import { asActor } from '../../platform/auth/actor.js';
import { deleteView, listReports, listViews, runReport, saveView } from './service.js';
import { editionOf, LITE_REPORTS } from '../../platform/edition.js';

export async function reportRoutes(app: FastifyInstance) {
  app.get('/reports', async (req) => ((await editionOf(actorOf(req))) === 'lite' ? listReports().filter((x) => LITE_REPORTS.has(x.id)) : listReports()));
  /** /api/reports/asset-availability?format=pdf&facilityId=...&from=...&to=... */
  app.get('/reports/:id/views', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    return asActor(actorOf(req), (tx) => listViews(tx, actorOf(req), id));
  });
  app.post('/reports/:id/views', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = parse(z.object({ name: z.string().min(2).max(80), params: z.record(z.unknown()), shared: z.boolean().optional() }), req.body);
    reply.status(201);
    return asActor(actorOf(req), (tx) => saveView(tx, actorOf(req), id, b));
  });
  app.delete('/report-views/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await asActor(actorOf(req), (tx) => deleteView(tx, actorOf(req), id));
    reply.status(204);
  });
  app.get('/reports/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { format = 'json', raw, ...params } = req.query as Record<string, string>;
    const f = parse(z.enum(['json', 'csv', 'xlsx', 'html', 'pdf']), format);
    const out = await runReport(actorOf(req), id, params, f, { raw: raw === '1' || raw === 'true' });
    if (f === 'json') return out.body;
    return sendFile(reply, out, f === 'html' || f === 'pdf');
  });
}
