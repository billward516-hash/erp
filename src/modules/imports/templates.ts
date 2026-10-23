import ExcelJS from 'exceljs';
import { toCsv } from '../reporting/render/csv.js';
import { notFound } from '../../platform/errors.js';
import { getTarget } from './targets/registry.js';
import type { FieldDef, TargetDefinition } from './targets/types.js';

/**
 * Templates and data dictionaries (SC-003). Every import target can hand out a file with the headers the product
 * understands, one example row, and a dictionary of what each column means, so a customer who has no export to start
 * from (or whose export needs tidying) begins from something that maps by itself. Headers are the field labels, which
 * the auto-mapper recognises, so a filled-in template stages with no mapping work.
 */
function example(f: FieldDef): string {
  if (f.values?.length) return f.values[0]!;
  switch (f.type) {
    case 'integer': return '1';
    case 'number': return f.min != null && f.min > 0 ? String(f.min) : '12.5';
    case 'date': return '2026-01-31';
    case 'datetime': return '2026-01-31 08:00';
    case 'boolean': return 'yes';
    default: return f.synonyms?.[0] ? `e.g. ${f.synonyms[0]}` : `sample ${f.label.toLowerCase()}`;
  }
}

function dictionary(t: TargetDefinition) {
  return t.fields.map((f) => ({
    field: f.label, required: f.required ? 'yes' : '', type: f.type + (f.maxLength ? ` (up to ${f.maxLength} characters)` : ''),
    allowed: f.values?.join(', ') ?? '', meaning: f.description ?? '', alsoRecognised: (f.synonyms ?? []).slice(0, 8).join('; '),
  }));
}

export async function buildTemplate(key: string, format: 'csv' | 'xlsx') {
  const t = getTarget(key);
  if (!t) throw notFound('import target');
  const headers = t.fields.map((f) => f.label);
  const row = t.fields.map((f) => example(f));
  if (format === 'csv') {
    return { contentType: 'text/csv; charset=utf-8', fileName: `${key}-template.csv`,
      body: toCsv(headers, [Object.fromEntries(headers.map((h, i) => [h, row[i]]))]) };
  }
  const wb = new ExcelJS.Workbook();
  const data = wb.addWorksheet('Data');
  data.addRow(headers); data.addRow(row);
  data.getRow(1).font = { bold: true };
  t.fields.forEach((f, i) => { data.getColumn(i + 1).width = Math.max(14, f.label.length + 4); if (f.required) data.getCell(1, i + 1).font = { bold: true, color: { argb: 'FFB00020' } }; });
  data.views = [{ state: 'frozen', ySplit: 1 }];
  const dict = wb.addWorksheet('Dictionary');
  dict.addRow(['Column', 'Required', 'Type', 'Allowed values', 'Meaning', 'Other headers recognised']);
  dict.getRow(1).font = { bold: true };
  for (const d of dictionary(t)) dict.addRow([d.field, d.required, d.type, d.allowed, d.meaning, d.alsoRecognised]);
  [28, 10, 24, 36, 60, 50].forEach((w, i) => { dict.getColumn(i + 1).width = w; });
  const read = wb.addWorksheet('Read me');
  for (const line of [t.label, '', t.description, '', `Records are matched on: ${t.fields.find((f) => f.key === t.naturalKey)?.label ?? t.naturalKey}. Loading the same file again updates records instead of duplicating them.`,
    'Red headers are required. Delete the example row before loading. Extra columns you keep are stored with the record when the target supports it, or ignored.',
    'Columns can be in any order and your own header names are fine: the importer suggests a mapping and you confirm it.']) read.addRow([line]);
  read.getColumn(1).width = 110; read.getRow(1).font = { bold: true, size: 14 };
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: `${key}-template.xlsx`, body: buf };
}
