import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission, scopeOf } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import { withTx } from '../../platform/db/tx.js';
import { invalid, notFound } from '../../platform/errors.js';
import { getReport, REPORTS } from './registry.js';
import { reportToCsv } from './render/csv.js';
import { reportToHtml } from './render/html.js';
import { reportToPdf } from './render/pdf.js';
import { reportToXlsx } from './render/xlsx.js';
import type { ReportResult } from './types.js';
import { rowLinks } from './drill.js';
import { describeParams } from './filters.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';


export type ReportFormat = 'json' | 'csv' | 'html' | 'pdf' | 'xlsx';

export function listReports() {
  return REPORTS.map((r) => ({ id: r.id, name: r.name, description: r.description, formats: ['json', 'csv', 'xlsx', 'html', 'pdf'], filters: describeParams(r.params) }));
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
    if (format === 'csv' || format === 'pdf' || format === 'xlsx') {
      await audit(tx, actor, { action: 'report.exported', entityType: 'report', data: { reportId: id, format, filters: r.filters, rows: r.rows.length } });
    }
    return r;
  });
  const stamp = result.generatedAt.slice(0, 10);
  switch (format) {
    case 'csv': return { contentType: 'text/csv; charset=utf-8', fileName: `${id}-${stamp}.csv`, body: reportToCsv(result, opts) };
    case 'html': return { contentType: 'text/html; charset=utf-8', body: reportToHtml(result) };
    case 'pdf': return { contentType: 'application/pdf', fileName: `${id}-${stamp}.pdf`, body: await reportToPdf(result) };
    case 'xlsx': return { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: `${id}-${stamp}.xlsx`, body: await reportToXlsx(result) };
    // On screen each row links to its source record (brief §15.4 e), using the same map as the workbook.
    default: return { contentType: 'application/json', body: { ...result, filterDefs: describeParams(def.params), links: rowLinks(result) } };
  }
}

// ---------------------------------------------------------------------------
// Saved views (D-144)
// ---------------------------------------------------------------------------

function cleanParams(id: string, params: Record<string, unknown>) {
  const def = getReport(id);
  if (!def) throw notFound('report');
  const kept = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  const parsed = def.params.safeParse(kept);
  if (!parsed.success) throw invalid('these filters are not valid for this report', parsed.error.flatten());
  return { def, kept };
}

/** My views and the company's shared views of a report. */
export async function listViews(tx: Tx, actor: Actor, reportId: string) {
  const def = getReport(reportId);
  if (!def) throw notFound('report');
  requirePermission(actor, def.permission);
  return many(tx, `SELECT v.id, v.name, v.params, v.shared, v.owner_id = $2 AS mine, u.display_name AS owner, v.updated_at
    FROM report_view v JOIN app_user u ON u.id = v.owner_id WHERE v.report_id = $1 AND (v.owner_id = $2 OR v.shared) ORDER BY v.shared, lower(v.name)`, [reportId, actor.userId]);
}

export async function saveView(tx: Tx, actor: Actor, reportId: string, input: { name: string; params: Record<string, unknown>; shared?: boolean }) {
  const { def, kept } = cleanParams(reportId, input.params);
  requirePermission(actor, def.permission);
  // Sharing publishes a view to everyone who may run the report: the same people who may export it.
  if (input.shared) requirePermission(actor, 'reports.export');
  const name = input.name.trim();
  const prior = await one(tx, 'SELECT id FROM report_view WHERE report_id = $1 AND owner_id = $2 AND lower(name) = lower($3)', [reportId, actor.userId, name]);
  const v = prior
    ? await one(tx, 'UPDATE report_view SET params = $2, shared = $3, updated_at = now() WHERE id = $1 RETURNING id', [prior.id, kept, input.shared ?? false])
    : await one(tx, 'INSERT INTO report_view (tenant_id, report_id, name, params, owner_id, shared) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [actor.tenantId, reportId, name, kept, actor.userId, input.shared ?? false]);
  await audit(tx, actor, { action: prior ? 'report_view.updated' : 'report_view.saved', entityType: 'report_view', entityId: v.id, data: { reportId, name, params: kept, shared: input.shared ?? false } });
  return { id: v.id as string };
}

export async function deleteView(tx: Tx, actor: Actor, id: string) {
  const v = await one(tx, 'SELECT * FROM report_view WHERE id = $1', [id]);
  if (!v || (!v.shared && v.owner_id !== actor.userId)) throw notFound('saved view');
  if (v.owner_id !== actor.userId) {
    requirePermission(actor, 'tenant.admin');
  }
  await tx.query('DELETE FROM report_view WHERE id = $1', [id]);
  await audit(tx, actor, { action: 'report_view.deleted', entityType: 'report_view', entityId: id, data: { reportId: v.report_id, name: v.name } });
}
