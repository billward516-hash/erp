import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, parse, sendFile } from '../../platform/http/helpers.js';
import { listReports, runReport } from './service.js';
import { editionOf, LITE_REPORTS } from '../../platform/edition.js';

export async function reportRoutes(app: FastifyInstance) {
  app.get('/reports', async (req) => ((await editionOf(actorOf(req))) === 'lite' ? listReports().filter((x) => LITE_REPORTS.has(x.id)) : listReports()));
  /** /api/reports/asset-availability?format=pdf&facilityId=...&from=...&to=... */
  app.get('/reports/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { format = 'json', raw, ...params } = req.query as Record<string, string>;
    const f = parse(z.enum(['json', 'csv', 'html', 'pdf']), format);
    const out = await runReport(actorOf(req), id, params, f, { raw: raw === '1' || raw === 'true' });
    if (f === 'json') return out.body;
    return sendFile(reply, out, f === 'html' || f === 'pdf');
  });
}
