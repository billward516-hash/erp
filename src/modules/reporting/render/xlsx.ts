import ExcelJS from 'exceljs';
import { config } from '../../../config.js';
import { rowLinks } from '../drill.js';
import type { ColumnType, ReportResult } from '../types.js';
import { exportValue, formatValue, TOKENS } from './format.js';

/**
 * Report as an Excel workbook (brief §15.4: the shared XLSX adapter). One structure, the same numbers as every other
 * format: a "Report" sheet with the finding, scope and KPIs above a real table (typed cells with number formats,
 * frozen header, filter, exceptions shaded, a link to each row's record), and a "Notes" sheet with insights,
 * definitions and source. Text cells are always written as text, never as formulas.
 */
const FORMATS: Partial<Record<ColumnType, string>> = {
  currency: '"$"#,##0.00;[Red]-"$"#,##0.00', percent: '0.0%', integer: '#,##0', number: '#,##0.0##', hours: '#,##0.0', date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm',
};
const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;

function cellValue(v: unknown, type: ColumnType): ExcelJS.CellValue {
  const x = exportValue(v, type);
  if (x === '') return null;
  if ((type === 'date' || type === 'datetime') && typeof x === 'string') {
    const d = new Date(type === 'date' ? `${x.slice(0, 10)}T00:00:00Z` : x);
    return Number.isNaN(d.getTime()) ? x : d;
  }
  return x;
}

export async function reportToXlsx(report: ReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ops Platform'; wb.created = new Date(report.generatedAt);
  const ws = wb.addWorksheet('Report', { views: [{ showGridLines: false }] });
  const width = Math.max(report.columns.length, 2);
  const put = (r: number, label: string, value: string, opts: { bold?: boolean; size?: number; color?: string } = {}) => {
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 1).font = { color: { argb: argb(TOKENS.muted) }, size: 9 };
    ws.getCell(r, 2).value = value;
    ws.getCell(r, 2).font = { bold: opts.bold, size: opts.size, color: { argb: argb(opts.color ?? TOKENS.ink) } };
    if (width > 2) ws.mergeCells(r, 2, r, width);
  };
  ws.getCell(1, 1).value = report.name;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: argb(TOKENS.accent) } };
  let r = 2;
  put(r++, 'Finding', report.headline, { bold: true });
  if (report.period) put(r++, 'Period', `${report.period.from} to ${report.period.to}`);
  put(r++, 'Scope', report.scope.description);
  put(r++, 'Generated', report.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC');
  const filters = Object.entries(report.filters).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${String(v)}`).join('; ');
  if (filters) put(r++, 'Filters', filters);
  r++;
  if (report.kpis.length) {
    for (const [i, k] of report.kpis.entries()) {
      const c = ws.getCell(r, i + 1); c.value = k.label; c.font = { size: 9, color: { argb: argb(TOKENS.muted) } };
      const v = ws.getCell(r + 1, i + 1);
      v.value = k.value == null ? null : cellValue(k.value, k.type);
      if (FORMATS[k.type]) v.numFmt = FORMATS[k.type]!;
      v.font = { bold: true, size: 12, color: { argb: argb(k.status === 'bad' ? TOKENS.bad : k.status === 'watch' ? TOKENS.watch : k.status === 'good' ? TOKENS.good : TOKENS.ink) } };
      if (k.value == null) { v.value = '—'; v.alignment = { horizontal: 'right' }; }
    }
    r += 3;
  }

  // The table.
  const links = rowLinks(report);
  const withLinks = links.some(Boolean);
  const header = [...report.columns.map((c) => (c.unit ? `${c.label} (${c.unit})` : c.label)), ...(withLinks ? ['Open'] : [])];
  const headRow = ws.getRow(r);
  header.forEach((h, i) => {
    const c = headRow.getCell(i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(TOKENS.accent) } };
    c.alignment = { vertical: 'middle', wrapText: true, horizontal: report.columns[i] && report.columns[i]!.type !== 'text' ? 'right' : 'left' };
  });
  const first = r + 1;
  const exceptions = new Set(report.exceptions ?? []);
  report.rows.forEach((row, i) => {
    const xr = ws.getRow(first + i);
    report.columns.forEach((col, j) => {
      const c = xr.getCell(j + 1);
      c.value = cellValue(row[col.key], col.type);
      if (FORMATS[col.type]) c.numFmt = FORMATS[col.type]!;
      if (exceptions.has(i)) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF1D8' } };
    });
    if (withLinks && links[i]) {
      const c = xr.getCell(report.columns.length + 1);
      c.value = { text: 'Open', hyperlink: `${config.appBaseUrl.replace(/\/$/, '')}${links[i]}` };
      c.font = { color: { argb: argb(TOKENS.accent) }, underline: true };
    }
  });
  if (!report.rows.length) ws.getCell(first, 1).value = 'No rows for these filters (blank is not zero).';
  ws.views = [{ state: 'frozen', ySplit: r, showGridLines: false }];
  if (report.rows.length) ws.autoFilter = { from: { row: r, column: 1 }, to: { row: r + report.rows.length, column: header.length } };
  report.columns.forEach((col, j) => {
    const longest = Math.max(header[j]!.length, ...report.rows.slice(0, 500).map((row) => formatValue(row[col.key], col.type).length));
    ws.getColumn(j + 1).width = Math.min(Math.max(longest + 2, col.type === 'text' ? 12 : 10), 60);
  });
  if (withLinks) ws.getColumn(header.length).width = 8;
  if (report.exceptions?.length) {
    const n = ws.getCell(first + Math.max(report.rows.length, 1) + 1, 1);
    n.value = `Shaded rows need attention (${report.exceptions.length}).`; n.font = { italic: true, size: 9, color: { argb: argb(TOKENS.muted) } };
  }

  const notes = wb.addWorksheet('Notes');
  notes.getColumn(1).width = 14; notes.getColumn(2).width = 110;
  let n = 1;
  const line = (label: string, text: string) => { notes.getCell(n, 1).value = label; notes.getCell(n, 1).font = { bold: true }; notes.getCell(n, 2).value = text; notes.getCell(n, 2).alignment = { wrapText: true }; n++; };
  report.insights.forEach((t, i) => line(i ? '' : 'Insights', t));
  report.notes.forEach((t, i) => line(i ? '' : 'Notes', t));
  line('Source', report.source);
  line('Blanks', 'A blank cell means no data, not zero.');
  return Buffer.from(await wb.xlsx.writeBuffer());
}
