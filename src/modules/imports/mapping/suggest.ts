import type { Raw } from './coerce.js';
import { isBlank, parseBoolean, parseDate, parseDateTime, parseNumber } from './coerce.js';
import type { FieldDef, TargetDefinition } from '../targets/types.js';
import type { MappingSpec } from './spec.js';
import { normalizeKey } from './spec.js';

/** Abbreviations seen in real-world headers, expanded before matching. */
const ABBREVIATIONS: Record<string, string> = {
  no: 'number', num: 'number', nbr: 'number', nr: 'number', desc: 'description', descr: 'description', mfr: 'manufacturer', mfg: 'manufacturer',
  manuf: 'manufacturer', sn: 'serial number', dt: 'date', qty: 'quantity', uom: 'uom', loc: 'location', dept: 'department', equip: 'equipment',
  eq: 'equipment', pn: 'part number', crit: 'criticality', pri: 'priority', prio: 'priority', emp: 'employee', tech: 'technician', hrs: 'hours',
  hr: 'hours', mins: 'minutes', wo: 'wo', est: 'estimated', amt: 'amount', bldg: 'building', yr: 'year', inst: 'install', svc: 'service',
  mdl: 'model', mach: 'machine', stat: 'status', cat: 'category', ref: 'reference', id: 'id', addr: 'address', compl: 'completed',
  rptd: 'reported', rpt: 'reported', maint: 'maintenance', warr: 'warranty', exp: 'expiration', dur: 'duration', fac: 'facility',
};

/** Normalizes a header: "Equip #" -> "equipment number", "S/N" -> "serial number", "InstallDate" -> "install date". */
export function normalizeHeader(h: string): string {
  const s = h
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bs\s*\/\s*n\b/gi, ' serial number ')
    .replace(/\bp\s*\/\s*n\b/gi, ' part number ')
    .replace(/\bw\s*\/\s*o\b/gi, ' wo ')
    .replace(/\bu\s*\/\s*m\b/gi, ' uom ')
    .replace(/#/g, ' number ')
    .replace(/&/g, ' and ');
  return normalizeKey(s).split(' ').filter(Boolean).map((t) => ABBREVIATIONS[t] ?? t).join(' ');
}

function bigrams(s: string): string[] {
  const x = s.replace(/\s+/g, '');
  return Array.from({ length: Math.max(x.length - 1, 0) }, (_, i) => x.slice(i, i + 2));
}

function dice(a: string, b: string): number {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.length || !B.length) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  A.forEach((g) => counts.set(g, (counts.get(g) ?? 0) + 1));
  let inter = 0;
  for (const g of B) { const c = counts.get(g) ?? 0; if (c > 0) { inter++; counts.set(g, c - 1); } }
  return (2 * inter) / (A.length + B.length);
}

function tokenJaccard(a: string, b: string): number {
  const A = new Set(a.split(' ')); const B = new Set(b.split(' '));
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / new Set([...A, ...B]).size;
}

export function headerScore(header: string, field: FieldDef): number {
  // "Crit (A/B/C)" and "Cost [USD]" are scored with and without the bracketed hint.
  const variants = [...new Set([header, header.replace(/[([{].*?[)\]}]/g, ' ')].map(normalizeHeader).filter(Boolean))];
  const candidates = [field.key.replace(/_/g, ' '), field.label, ...(field.synonyms ?? [])].map(normalizeHeader);
  let best = 0;
  for (const [i, h] of variants.entries()) {
    const penalty = i === 0 ? 1 : 0.95;
    for (const c of candidates) {
      if (h === c) return penalty;
      best = Math.max(best, (0.6 * tokenJaccard(h, c) + 0.4 * dice(h, c)) * 0.95 * penalty);
    }
  }
  return best;
}

/** Share of sample values compatible with the field type (used to break ties / demote bad matches). */
export function valueCompatibility(values: Raw[], field: FieldDef): number {
  const vs = values.filter((v) => !isBlank(v)).slice(0, 50);
  if (!vs.length) return 1;
  const okCount = vs.filter((v) => {
    switch (field.type) {
      case 'number': case 'integer': return parseNumber(v).ok;
      case 'date': return parseDate(v).ok;
      case 'datetime': return parseDateTime(v, { timeZone: 'UTC' }).ok;
      case 'boolean': return parseBoolean(v, toBoolSyn(field)).ok;
      case 'enum': return field.allowOther || matchEnum(v, field) !== null;
      default: return true;
    }
  }).length;
  return okCount / vs.length;
}

export function toBoolSyn(field: FieldDef) {
  return field.valueSynonyms ? { true: field.valueSynonyms.true, false: field.valueSynonyms.false } : undefined;
}

export function matchEnum(v: Raw, field: FieldDef): string | null {
  if (isBlank(v)) return null;
  const k = normalizeKey(String(v));
  for (const value of field.values ?? []) {
    if (normalizeKey(value) === k) return value;
    if ((field.valueSynonyms?.[value] ?? []).some((s) => normalizeKey(s) === k)) return value;
  }
  return null;
}

export interface FieldSuggestion { field: string; column: string; confidence: number; level: 'high' | 'medium' | 'low'; note?: string }

export interface MappingSuggestion {
  mapping: MappingSpec;
  suggestions: FieldSuggestion[];
  unmappedColumns: string[];
  missingRequired: string[];
  /** Distinct source values for mapped enum fields that need a valueMap decision. */
  unmatchedValues: Record<string, string[]>;
}

/**
 * Proposes a mapping from source headers + sample values. One column per field, greedy by score.
 * Low-confidence matches are included but flagged; the user confirms before anything is committed.
 */
export function suggestMapping(target: TargetDefinition, columns: string[], sampleRows: Record<string, Raw>[], threshold = 0.55): MappingSuggestion {
  const scored: { field: FieldDef; column: string; score: number; note?: string }[] = [];
  for (const field of target.fields) {
    for (const column of columns) {
      let score = headerScore(column, field);
      if (score < 0.35) continue;
      const compat = valueCompatibility(sampleRows.map((r) => r[column]), field);
      let note: string | undefined;
      if (compat < 0.5) { score -= 0.35; note = `most sample values are not valid ${field.type} values`; }
      else if (compat > 0.9 && field.type !== 'string' && field.type !== 'text') score += 0.05;
      scored.push({ field, column, score: Math.min(score, 1), note });
    }
  }
  scored.sort((a, b) => b.score - a.score || Number(!!b.field.required) - Number(!!a.field.required));
  const usedFields = new Set<string>();
  const usedCols = new Set<string>();
  const suggestions: FieldSuggestion[] = [];
  for (const s of scored) {
    if (s.score < threshold || usedFields.has(s.field.key) || usedCols.has(s.column)) continue;
    usedFields.add(s.field.key); usedCols.add(s.column);
    const confidence = Math.round(s.score * 100) / 100;
    suggestions.push({ field: s.field.key, column: s.column, confidence, level: confidence >= 0.85 ? 'high' : confidence >= 0.68 ? 'medium' : 'low', note: s.note });
  }
  const mapping: MappingSpec = { fields: {}, options: { unmappedColumns: 'custom_fields', dateOrder: 'MDY', decimal: 'auto', skipBlankRows: true, skipRows: [], mode: 'upsert' } };
  const unmatchedValues: Record<string, string[]> = {};
  for (const s of suggestions) {
    mapping.fields[s.field] = { source: s.column, transforms: [] };
    const field = target.fields.find((f) => f.key === s.field)!;
    if (field.type === 'enum') {
      const distinct = [...new Set(sampleRows.map((r) => r[s.column]).filter((v) => !isBlank(v)).map((v) => String(v).trim()))];
      const misses = distinct.filter((v) => matchEnum(v, field) === null);
      if (misses.length) unmatchedValues[s.field] = misses.slice(0, 50);
    }
  }
  return {
    mapping,
    suggestions,
    unmappedColumns: columns.filter((c) => !usedCols.has(c)),
    missingRequired: target.fields.filter((f) => f.required && !usedFields.has(f.key)).map((f) => f.key),
    unmatchedValues,
  };
}
