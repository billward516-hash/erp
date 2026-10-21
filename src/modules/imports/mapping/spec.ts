import { z } from 'zod';
import type { Raw } from './coerce.js';
import { isBlank, parseNumber } from './coerce.js';

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
  z.object({ op: z.literal('replace'), pattern: z.string(), with: z.string().default(''), flags: z.string().regex(/^[gimsu]*$/).default('g') }),
  z.object({ op: z.literal('regex_extract'), pattern: z.string(), group: z.number().int().min(0).default(1) }),
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
      mode: z.enum(['upsert', 'create_only', 'update_only']).default('upsert'),
    })
    .default({}),
});
export type MappingSpec = z.infer<typeof MappingSpecSchema>;

export function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** snake_case key for preserving unmapped columns in custom_fields. */
export function customFieldKey(header: string): string {
  return header.trim().toLowerCase().replace(/#/g, ' number ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'column';
}

function compileRegex(pattern: string, flags = ''): RegExp {
  if (pattern.length > 200) throw new Error('regex pattern too long');
  return new RegExp(pattern, flags);
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
      case 'replace': v = s.replace(compileRegex(t.pattern, t.flags), t.with); break;
      case 'regex_extract': { const m = compileRegex(t.pattern).exec(s); v = m ? (m[t.group] ?? null) : null; break; }
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
