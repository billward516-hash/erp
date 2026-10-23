import type { ReportResult } from '../types.js';
import { exportValue } from './format.js';

/** Neutralizes spreadsheet formula injection (=, +, -, @ at cell start) and quotes as RFC 4180 requires. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Report CSV. Default output starts with a short metadata block (report, period, scope, filters) so a
 * forwarded file is self-describing; `raw` returns the table only for loading into other tools.
 */
export function reportToCsv(report: ReportResult, opts: { raw?: boolean } = {}): string {
  const header = report.columns.map((c) => (c.unit ? `${c.label} (${c.unit})` : c.type === 'percent' ? `${c.label} (ratio 0-1)` : c.label));
  const body = report.rows.map((r) => report.columns.map((c) => csvCell(exportValue(r[c.key], c.type))).join(','));
  const table = [header.map(csvCell).join(','), ...body];
  if (opts.raw) return '﻿' + table.join('\r\n') + '\r\n';
  const meta = [
    ['Report', report.name], ['Finding', report.headline], ['Generated', report.generatedAt],
    ...(report.period ? [['Period', `${report.period.from} to ${report.period.to}`]] : []),
    ['Scope', report.scope.description], ['Filters', JSON.stringify(report.filters)], ['Source', report.source],
    ['Note', 'Blank cells mean no data, not zero.'],
  ].map((r) => r.map(csvCell).join(','));
  return '﻿' + [...meta, '', ...table].join('\r\n') + '\r\n';
}
