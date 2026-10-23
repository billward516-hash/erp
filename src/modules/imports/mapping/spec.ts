import { z } from 'zod';
import type { Raw } from './coerce.js';
import { isBlank, parseNumber } from './coerce.js';
import { userRegex } from '../../../platform/safe-regex.js';

/** A user's regex pattern, refused when saving a profile if it is too long, invalid or uses an unsafe construct (D-152). */
const safePattern = z.string().superRefine((p, ctx) => {
  try { userRegex(p); } catch (e) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message }); }
});

/**
 * Declarative transform steps. Mapping profiles are data, never code: they are stored per tenant,
 * shared between imports, and safe to edit in a UI.
 */
export const TransformSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim') }),
  z.object({ op: z.literal('upper') }),
  z.object({ op: z.literal('lower') }),
  z.object({ op: z.literal('title') }),
  z.object({ op: z.literal('collapse_whitespace') }),
  z.object({ op: z.literal('replace'), pattern: safePattern, with: z.string().default(''), flags: z.string().regex(/^[gimsu]*$/).default('g') }),
  z.object({ op: z.literal('regex_extract'), pattern: safePattern, group: z.number().int().min(0).default(1) }),
  z.object({ op: z.literal('split'), separator: z.string(), index: z.number().int() }),
  z.object({ op: z.literal('prefix'), value: z.string() }),
  z.object({ op: z.literal('suffix'), value: z.string() }),
  z.object({ op: z.literal('null_if'), values: z.array(z.string()) }),
  z.object({ op: z.literal('default'), value: z.union([z.string(), z.number(), z.boolean()]) }),
  /** Unit conversion for numbers, e.g. minutes -> hours: { op: 'multiply', factor: 1/60 } */
  z.object({ op: z.literal('multiply'), factor: z.number() }),
]);
export type Transform = z.infer<typeof TransformSchema>;

export const FieldMappingSchema = z
  .object({
    /** Source column, or several (first non-blank wins). */
    source: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
    /** Combine columns: "{Building} > {Line}". */
    template: z.string().optional(),
    /** Fixed value for every row. */
    constant: z.union([z.string(), z.number(), z.boolean()]).optional(),
    transforms: z.array(TransformSchema).default([]),
    /** Customer value -> platform value (case/space-insensitive), e.g. { "A": "high" }. */
    valueMap: z.record(z.string()).optional(),
    /** Overrides date inference, e.g. ["DD.MM.YYYY"]. */
    dateFormats: z.array(z.string()).optional(),
  })
  .refine((f) => [f.source, f.template, f.constant].filter((x) => x !== undefined).length === 1, {
    message: 'exactly one of source, template or constant is required',
  });
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

/** Skip source rows whose column matches: "leave out inactive items", "ignore test rows". Case and surrounding space do not matter. */
export const RowFilterSchema = z.object({
  column: z.string().min(1),
  is: z.enum(['equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in', 'blank', 'not_blank', 'matches']),
  value: z.union([z.string(), z.array(z.string())]).optional(),
}).superRefine((f, ctx) => {
  if (!['blank', 'not_blank'].includes(f.is) && (f.value === undefined || f.value === '')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the filter on "${f.column}" needs a value` });
  if (f.is === 'matches' && typeof f.value === 'string') { try { userRegex(f.value); } catch (e) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message }); } }
});
export type RowFilter = z.infer<typeof RowFilterSchema>;

export function rowMatchesFilter(values: Record<string, Raw>, f: RowFilter): boolean {
  const raw = values[f.column];
  const blank = isBlank(raw);
  const s = blank ? '' : (raw instanceof Date ? raw.toISOString() : String(raw)).trim().toLowerCase();
  const list = (Array.isArray(f.value) ? f.value : String(f.value ?? '').split(/[;|]/)).map((x) => x.trim().toLowerCase());
  const one = (Array.isArray(f.value) ? f.value[0] ?? '' : String(f.value ?? '')).trim().toLowerCase();
  switch (f.is) {
    case 'blank': return blank;
    case 'not_blank': return !blank;
    case 'equals': return s === one;
    case 'not_equals': return s !== one;
    case 'contains': return s.includes(one);
    case 'not_contains': return !s.includes(one);
    case 'in': return list.includes(s);
    case 'not_in': return !list.includes(s);
    case 'matches': return !blank && userRegex(String(f.value), 'i').test(String(raw));
  }
}

export const MappingSpecSchema = z.object({
  fields: z.record(FieldMappingSchema),
  options: z
    .object({
      /** What to do with source columns not mapped to a field. */
      unmappedColumns: z.enum(['custom_fields', 'ignore']).default('custom_fields'),
      dateOrder: z.enum(['MDY', 'DMY']).default('MDY'),
      decimal: z.enum(['.', ',', 'auto']).default('auto'),
      /** Rows where every mapped value is blank are skipped instead of failing. */
      skipBlankRows: z.boolean().default(true),
      /** Rows to leave out, before anything is mapped. A row matching any filter is skipped. */
      skipRows: z.array(RowFilterSchema).max(10).default([]),
      mode: z.enum(['upsert', 'create_only', 'update_only']).default('upsert'),
      /**
       * Wide-to-long: turn one row with many value columns (a training matrix, a monthly meter sheet)
       * into one row per non-blank cell. The column header lands in `nameColumn`, the cell in `valueColumn`;
       * map fields from those two virtual columns like any other.
       */
      unpivot: z
        .object({
          columns: z.array(z.string()).min(1).optional(),
          allExcept: z.array(z.string()).optional(),
          nameColumn: z.string().min(1),
          valueColumn: z.string().min(1),
        })
        .refine((u) => !!u.columns !== !!u.allExcept, { message: 'give either columns or allExcept' })
        .optional(),
    })
    .default({}),
});
export type MappingSpec = z.infer<typeof MappingSpecSchema>;

/** Applies options.unpivot (if any). Rows keep their source row number plus the column they came from. */
export function unpivotTable(spec: MappingSpec, table: { columns: string[]; rows: { rowNumber: number; values: Record<string, Raw> }[] }) {
  const u = spec.options.unpivot;
  if (!u) return { columns: table.columns, rows: table.rows.map((r) => ({ ...r })), problems: [] as string[] };
  const pivot = u.columns ?? table.columns.filter((c) => !u.allExcept!.includes(c));
  const problems = [...(u.columns ?? []), ...(u.allExcept ?? [])].filter((c) => !table.columns.includes(c)).map((c) => `unpivot column "${c}" is not in the file`);
  if ([u.nameColumn, u.valueColumn].some((c) => table.columns.includes(c))) problems.push('unpivot nameColumn/valueColumn must not reuse an existing column name');
  const keep = table.columns.filter((c) => !pivot.includes(c));
  const rows = table.rows.flatMap((r) =>
    pivot.filter((c) => !isBlank(r.values[c])).map((c) => ({
      rowNumber: r.rowNumber,
      sourceColumn: c,
      values: { ...Object.fromEntries(keep.map((k) => [k, r.values[k]])), [u.nameColumn]: c, [u.valueColumn]: r.values[c] } as Record<string, Raw>,
    })));
  return { columns: [...keep, u.nameColumn, u.valueColumn], rows, problems };
}

export function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** snake_case key for preserving unmapped columns in custom_fields. */
export function customFieldKey(header: string): string {
  return header.trim().toLowerCase().replace(/#/g, ' number ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'column';
}


export function applyTransforms(value: Raw, transforms: Transform[]): Raw {
  let v: Raw = value;
  for (const t of transforms) {
    if (t.op === 'default') { if (isBlank(v)) v = t.value; continue; }
    if (t.op === 'null_if') { if (typeof v === 'string' && t.values.map((x) => x.toLowerCase()).includes(v.trim().toLowerCase())) v = null; continue; }
    if (isBlank(v)) continue;
    if (t.op === 'multiply') {
      const n = parseNumber(v);
      if (!n.ok) throw new Error(n.error);
      v = n.value === null ? null : Math.round(n.value * t.factor * 1e6) / 1e6;
      continue;
    }
    const s = v instanceof Date ? v.toISOString() : String(v);
    switch (t.op) {
      case 'trim': v = s.trim(); break;
      case 'upper': v = s.toUpperCase(); break;
      case 'lower': v = s.toLowerCase(); break;
      case 'title': v = s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()); break;
      case 'collapse_whitespace': v = s.replace(/\s+/g, ' ').trim(); break;
      case 'replace': v = s.replace(userRegex(t.pattern, t.flags), t.with); break;
      case 'regex_extract': { const m = userRegex(t.pattern).exec(s); v = m ? (m[t.group] ?? null) : null; break; }
      case 'split': { const parts = s.split(t.separator); v = parts.at(t.index)?.trim() ?? null; break; }
      case 'prefix': v = t.value + s; break;
      case 'suffix': v = s + t.value; break;
    }
  }
  return v;
}

/** Resolves a field's raw value from a source row before transforms. */
export function readSource(row: Record<string, Raw>, m: FieldMapping): Raw {
  if (m.constant !== undefined) return m.constant;
  if (m.template !== undefined) {
    let anyValue = false;
    const out = m.template.replace(/\{([^}]+)\}/g, (_, col: string) => {
      const v = row[col];
      if (isBlank(v)) return '';
      anyValue = true;
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
    });
    // Drop separators left dangling by blank parts: "Bldg 2 >  > " -> "Bldg 2"
    return anyValue ? out.replace(/(\s*[>/|,-]\s*)+$/g, '').replace(/^(\s*[>/|,-]\s*)+/g, '').trim() : null;
  }
  const sources = Array.isArray(m.source) ? m.source : [m.source!];
  for (const col of sources) {
    const v = row[col];
    if (!isBlank(v)) return v;
  }
  return null;
}

export function applyValueMap(v: Raw, valueMap?: Record<string, string>): Raw {
  if (!valueMap || isBlank(v)) return v;
  const key = normalizeKey(String(v));
  for (const [from, to] of Object.entries(valueMap)) {
    if (normalizeKey(from) === key) return to;
  }
  return v;
}

/** Source columns referenced by a mapping (used to decide which columns are "unmapped"). */
export function referencedColumns(spec: MappingSpec): Set<string> {
  const cols = new Set<string>();
  for (const m of Object.values(spec.fields)) {
    if (m.source) (Array.isArray(m.source) ? m.source : [m.source]).forEach((c) => cols.add(c));
    if (m.template) for (const [, c] of m.template.matchAll(/\{([^}]+)\}/g)) cols.add(c!);
  }
  return cols;
}
