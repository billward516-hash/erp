import type { ReportResult } from './types.js';

/**
 * Drill-down (brief §15.4 e): the screen that shows a report row's source record. Reports name the record by its API
 * path (`drillDown`); this maps it to the page in the web app, so every format (screen, XLSX, HTML print) links to
 * the same place. Rows whose record has no page of its own get no link.
 */
const SCREENS: [RegExp, string][] = [
  [/^\/api\/assets\/([^/]+)(\/reliability)?$/, '/assets/$1'],
  [/^\/api\/work-orders\/([^/]+)$/, '/work-orders/$1'],
  [/^\/api\/pm\/([^/]+)$/, '/pm/$1'],
  [/^\/api\/continuity-plans\/([^/]+)$/, '/continuity/$1'],
  [/^\/api\/customer-invoices\/([^/]+)$/, '/receivables/$1'],
  [/^\/api\/supplier-invoices\/([^/]+)$/, '/ap/$1'],
  [/^\/api\/enrollments\/([^/]+)$/, '/training/enrollments/$1'],
  [/^\/api\/expenses\/([^/]+)$/, '/expenses/$1'],
  [/^\/api\/fmeas\/([^/]+)$/, '/quality/fmea/$1'],
  [/^\/api\/incidents\/([^/]+)$/, '/safety/$1'],
  [/^\/api\/moc\/([^/]+)$/, '/changes/$1'],
  [/^\/api\/nonconformances\/([^/]+)$/, '/quality/ncr/$1'],
  [/^\/api\/production-orders\/([^/]+)$/, '/production/orders/$1'],
  [/^\/api\/purchase-requests\/([^/]+)$/, '/purchasing/requests/$1'],
  [/^\/api\/purchase-orders\/([^/]+)$/, '/purchasing/orders/$1'],
];

export function screenFor(apiPath: string): string | null {
  for (const [re, to] of SCREENS) if (re.test(apiPath)) return apiPath.replace(re, to);
  return null;
}

/** The API path of a row's record, from the report's drill-down template (`{key}` placeholders). */
export function recordPath(report: Pick<ReportResult, 'drillDown'>, row: Record<string, unknown>): string | null {
  const d = report.drillDown;
  if (!d || row[d.rowKey] == null) return null;
  let missing = false;
  const p = d.path.replace(/\{(\w+)\}/g, (_m, k) => { const v = row[k]; if (v == null) missing = true; return encodeURIComponent(String(v)).replace(/%2F/g, '/'); });
  return missing ? null : p;
}

/** Screen links for every row (null where there is none). */
export function rowLinks(report: ReportResult): (string | null)[] {
  return report.rows.map((r) => { const p = recordPath(report, r); return p ? screenFor(p) : null; });
}
