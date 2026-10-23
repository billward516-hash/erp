import type { z } from 'zod';

/**
 * Report filters described from each report's parameter schema, so the screen offers exactly the filters the report
 * accepts (and validates) without a second definition to keep in step. Unknown shapes come out as text.
 */
export interface FilterDef {
  key: string; label: string;
  type: 'facility' | 'date' | 'integer' | 'number' | 'choice' | 'boolean' | 'id' | 'text';
  min?: number; max?: number; default?: unknown; values?: string[]; ratio?: boolean;
}

const LABELS: Record<string, string> = {
  facilityId: 'Site', from: 'From', to: 'To', asOf: 'As of', days: 'Days back', weeks: 'Weeks', horizon: 'Months ahead', horizonDays: 'Days ahead', year: 'Year',
  fiscalYear: 'Fiscal year', minCoverage: 'Minimum data coverage', target: 'Target', discountRate: 'Discount rate', laborRate: 'Labor rate ($/h)', by: 'Group by', basis: 'Basis',
};
const humanize = (k: string) => LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/ Id$/, '');

export function describeParams(schema: z.ZodTypeAny): FilterDef[] {
  const shape = (schema as any)._def?.shape?.() ?? (schema as any).shape ?? {};
  return Object.entries(shape).map(([key, field]) => {
    let f: any = field; let def: unknown;
    for (;;) {
      const t = f?._def?.typeName;
      if (t === 'ZodOptional' || t === 'ZodNullable') f = f._def.innerType;
      else if (t === 'ZodDefault') { def = f._def.defaultValue(); f = f._def.innerType; }
      else if (t === 'ZodEffects') f = f._def.schema;
      else break;
    }
    const t = f?._def?.typeName;
    const checks: any[] = f?._def?.checks ?? [];
    const out: FilterDef = { key, label: humanize(key), type: 'text', ...(def !== undefined ? { default: def } : {}) };
    if (t === 'ZodString') {
      if (checks.some((c) => c.kind === 'uuid')) out.type = key === 'facilityId' ? 'facility' : 'id';
      else if (checks.some((c) => c.kind === 'date' || (c.kind === 'regex' && String(c.regex).includes('\\d{4}-\\d{2}-\\d{2}')))) out.type = 'date';
    } else if (t === 'ZodDate') out.type = 'date';
    else if (t === 'ZodNumber') {
      out.type = checks.some((c) => c.kind === 'int') ? 'integer' : 'number';
      const min = checks.find((c) => c.kind === 'min'); const max = checks.find((c) => c.kind === 'max');
      if (min) out.min = min.value; if (max) out.max = max.value;
      if (out.type === 'number' && max?.value <= 1 && (min?.value ?? 0) >= 0) out.ratio = true;
    } else if (t === 'ZodEnum') { out.type = 'choice'; out.values = f._def.values; }
    else if (t === 'ZodBoolean') out.type = 'boolean';
    return out;
  });
}
