import { parse as parseCsvSync } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import type { Raw } from '../mapping/coerce.js';
import { isBlank } from '../mapping/coerce.js';

export type SourceFormat = 'csv' | 'xlsx' | 'json';

export interface ParseOptions {
  format?: SourceFormat;
  /** CSV only. Detected when omitted. */
  delimiter?: string;
  /** CSV only: 'utf-8' | 'windows-1252' | 'utf-16le'. Detected when omitted. */
  encoding?: string;
  /** XLSX only: sheet name or 1-based index. Defaults to the sheet with the most data. */
  sheet?: string | number;
  /** 1-based row holding column headers. Detected when omitted (skips title/banner rows). */
  headerRow?: number;
  maxRows?: number;
}

export interface SourceRow { rowNumber: number; values: Record<string, Raw> }

export interface ParsedTable {
  columns: string[];
  rows: SourceRow[];
  info: {
    format: SourceFormat;
    encoding?: string;
    delimiter?: string;
    sheet?: string;
    availableSheets?: string[];
    headerRow: number;
    totalRows: number;
    skippedBlankRows: number;
    warnings: string[];
  };
}

export function detectFormat(fileName: string, content: Buffer): SourceFormat {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'json') return 'json';
  if (ext === 'xls') throw new Error('legacy .xls files are not supported; save as .xlsx or .csv');
  if (content[0] === 0x50 && content[1] === 0x4b) return 'xlsx'; // ZIP container
  const head = content.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  return 'csv';
}

export function decodeText(content: Buffer, encoding?: string): { text: string; encoding: string } {
  if (encoding) return { text: new TextDecoder(encoding).decode(content).replace(/^﻿/, ''), encoding };
  if (content[0] === 0xff && content[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(content.subarray(2)), encoding: 'utf-16le' };
  if (content[0] === 0xfe && content[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(content.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^﻿/, ''), encoding: 'utf-8' };
  } catch {
    // Excel "CSV" on Windows is typically cp1252.
    return { text: new TextDecoder('windows-1252').decode(content), encoding: 'windows-1252' };
  }
}

/** Picks the delimiter that yields the most consistent column count over the first lines. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => {
      let n = 0; let quoted = false;
      for (const ch of l) { if (ch === '"') quoted = !quoted; else if (ch === d && !quoted) n++; }
      return n;
    });
    const nonZero = counts.filter((c) => c > 0);
    if (!nonZero.length) continue;
    const mode = [...nonZero].sort((a, b) => nonZero.filter((x) => x === b).length - nonZero.filter((x) => x === a).length)[0]!;
    const consistency = counts.filter((c) => c === mode).length / counts.length;
    const score = consistency * 10 + Math.min(mode, 50) / 50;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const looksNumeric = (v: Raw) => typeof v === 'number' || v instanceof Date || (typeof v === 'string' && /^[\d\s.,:/$%()-]+$/.test(v.trim()));

/**
 * Header detection: first row (within the first 20) that is "wide" relative to the widest row and
 * mostly textual. Skips report titles, export banners and blank lines above the table.
 */
export function detectHeaderRow(grid: Raw[][]): number {
  const width = (r: Raw[]) => r.filter((v) => !isBlank(v)).length;
  const maxWidth = Math.max(...grid.slice(0, 50).map(width), 0);
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const row = grid[i]!;
    const w = width(row);
    if (w < Math.max(2, Math.ceil(maxWidth * 0.6))) continue;
    const textual = row.filter((v) => !isBlank(v) && !looksNumeric(v)).length;
    if (textual / w >= 0.8) return i;
  }
  return 0;
}

function uniqueHeaders(raw: Raw[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = isBlank(h) ? `Column ${i + 1}` : String(h).replace(/\s+/g, ' ').trim();
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
}

function gridToTable(grid: Raw[][], headerIndex: number, base: Omit<ParsedTable['info'], 'headerRow' | 'totalRows' | 'skippedBlankRows'>, maxRows: number): ParsedTable {
  const columns = uniqueHeaders(grid[headerIndex] ?? []);
  const rows: SourceRow[] = [];
  let skippedBlankRows = 0;
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const r = grid[i]!;
    if (r.every(isBlank)) { skippedBlankRows++; continue; }
    if (rows.length >= maxRows) throw new Error(`file has more than ${maxRows} rows; split it into smaller files`);
    const values: Record<string, Raw> = {};
    columns.forEach((c, j) => { values[c] = r[j] ?? null; });
    if (r.length > columns.length && r.slice(columns.length).some((v) => !isBlank(v))) {
      base.warnings.push(`row ${i + 1} has more values than there are headers; extra values ignored`);
    }
    rows.push({ rowNumber: i + 1, values });
  }
  if (headerIndex > 0) base.warnings.push(`skipped ${headerIndex} line(s) above the header row`);
  return { columns, rows, info: { ...base, headerRow: headerIndex + 1, totalRows: rows.length, skippedBlankRows } };
}

function parseCsv(content: Buffer, opts: ParseOptions, maxRows: number): ParsedTable {
  const { text, encoding } = decodeText(content, opts.encoding);
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const grid: Raw[][] = parseCsvSync(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false, bom: true, trim: false });
  const warnings: string[] = [];
  if (encoding === 'windows-1252') warnings.push('file is not UTF-8; decoded as Windows-1252 (check accented characters)');
  const headerIndex = opts.headerRow ? opts.headerRow - 1 : detectHeaderRow(grid);
  return gridToTable(grid, headerIndex, { format: 'csv', encoding, delimiter, warnings }, maxRows);
}

/**
 * Spreadsheet date cells hold wall-clock values (exceljs exposes them as UTC Dates). Convert to a
 * zone-less string so they are interpreted in the facility's time zone like any other text date.
 */
export function wallClock(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function cellValue(v: ExcelJS.CellValue): Raw {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : wallClock(v);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return null;
    return null;
  }
  return v as Raw;
}

async function parseXlsx(content: Buffer, opts: ParseOptions, maxRows: number): Promise<ParsedTable> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(content as unknown as ArrayBuffer);
  const sheets = wb.worksheets;
  if (!sheets.length) throw new Error('workbook has no sheets');
  let ws: ExcelJS.Worksheet | undefined;
  if (typeof opts.sheet === 'number') ws = sheets[opts.sheet - 1];
  else if (opts.sheet) ws = sheets.find((s) => s.name.toLowerCase() === String(opts.sheet).toLowerCase());
  else ws = [...sheets].sort((a, b) => b.actualRowCount - a.actualRowCount)[0];
  if (!ws) throw new Error(`sheet "${opts.sheet}" not found; available: ${sheets.map((s) => s.name).join(', ')}`);
  const grid: Raw[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cellValue);
    grid[n - 1] = vals;
  });
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  const headerIndex = opts.headerRow ? opts.headerRow - 1 : detectHeaderRow(grid);
  const warnings: string[] = [];
  if (sheets.length > 1 && !opts.sheet) warnings.push(`workbook has ${sheets.length} sheets; using "${ws.name}" (largest). Choose another with the sheet option.`);
  return gridToTable(grid, headerIndex, { format: 'xlsx', sheet: ws.name, availableSheets: sheets.map((s) => s.name), warnings }, maxRows);
}

function flatten(obj: unknown, prefix = '', out: Record<string, Raw> = {}): Record<string, Raw> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(obj)) {
    out[prefix] = obj.every((x) => typeof x !== 'object') ? obj.join('; ') : JSON.stringify(obj);
  } else {
    out[prefix] = (obj as Raw) ?? null;
  }
  return out;
}

function parseJson(content: Buffer, maxRows: number): ParsedTable {
  const data = JSON.parse(decodeText(content).text);
  const warnings: string[] = [];
  let records: unknown[];
  if (Array.isArray(data)) records = data;
  else {
    const key = Object.keys(data).find((k) => Array.isArray(data[k]));
    if (!key) throw new Error('JSON must be an array of records or an object containing one');
    records = data[key];
    warnings.push(`using records from "${key}"`);
  }
  if (records.length > maxRows) throw new Error(`file has more than ${maxRows} rows; split it into smaller files`);
  const flat = records.map((r) => flatten(r));
  const columns = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  return {
    columns,
    rows: flat.map((values, i) => ({ rowNumber: i + 1, values })),
    info: { format: 'json', headerRow: 0, totalRows: flat.length, skippedBlankRows: 0, warnings },
  };
}

export async function parseFile(content: Buffer, fileName: string, opts: ParseOptions = {}): Promise<ParsedTable> {
  const format = opts.format ?? detectFormat(fileName, content);
  const maxRows = opts.maxRows ?? 50_000;
  if (format === 'xlsx') return parseXlsx(content, opts, maxRows);
  if (format === 'json') return parseJson(content, maxRows);
  return parseCsv(content, opts, maxRows);
}
