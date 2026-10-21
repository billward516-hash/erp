import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission, scopeOf } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import { withTx } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';
import { getReport, REPORTS } from './registry.js';
import { reportToCsv } from './render/csv.js';
import { reportToHtml } from './render/html.js';
import { reportToPdf } from './render/pdf.js';
import type { ReportResult } from './types.js';

export type ReportFormat = 'json' | 'csv' | 'html' | 'pdf';

export function listReports() {
  return REPORTS.map((r) => ({ id: r.id, name: r.name, description: r.description, formats: ['json', 'csv', 'html', 'pdf'] }));
}

/** Compute once, render to the requested format. Exports are audited with the filters used. */
export async function runReport(actor: Actor, id: string, rawParams: unknown, format: ReportFormat = 'json', opts: { raw?: boolean } = {}) {
  const def = getReport(id);
  if (!def) throw notFound('report');
  requirePermission(actor, def.permission);
  if (format !== 'json' && format !== 'html') requirePermission(actor, 'reports.export');
  const parsed = def.params.safeParse(rawParams ?? {});
  if (!parsed.success) throw invalid('invalid report parameters', parsed.error.flatten());
  const result: ReportResult = await withTx(scopeOf(actor), async (tx) => {
    const r = await def.run(tx, actor, parsed.data);
    if (format === 'csv' || format === 'pdf') {
      await audit(tx, actor, { action: 'report.exported', entityType: 'report', data: { reportId: id, format, filters: r.filters, rows: r.rows.length } });
    }
    return r;
  });
  const stamp = result.generatedAt.slice(0, 10);
  switch (format) {
    case 'csv': return { contentType: 'text/csv; charset=utf-8', fileName: `${id}-${stamp}.csv`, body: reportToCsv(result, opts) };
    case 'html': return { contentType: 'text/html; charset=utf-8', body: reportToHtml(result) };
    case 'pdf': return { contentType: 'application/pdf', fileName: `${id}-${stamp}.pdf`, body: await reportToPdf(result) };
    default: return { contentType: 'application/json', body: result };
  }
}
