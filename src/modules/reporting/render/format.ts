import type { ColumnType } from '../types.js';

/** Shown for missing values in every format; explained in report footnotes. Never rendered as 0. */
export const MISSING = '—';

/** Design tokens shared by HTML print and PDF output (restrained, accessible palette). */
export const TOKENS = {
  ink: '#1a1f2b', muted: '#5b6472', rule: '#d5d9e0', accent: '#1f4e79', surface: '#f5f7fa',
  good: '#2e6b3a', watch: '#8a5a00', bad: '#a32020',
  font: 'Helvetica', fontBold: 'Helvetica-Bold',
} as const;

export function formatValue(v: unknown, type: ColumnType): string {
  if (v === null || v === undefined || v === '') return MISSING;
  switch (type) {
    case 'percent': return `${(Number(v) * 100).toFixed(1)}%`;
    case 'currency': return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    case 'number': return Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
    case 'hours': return Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
    case 'integer': return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
    case 'date': return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
    case 'datetime': return (v instanceof Date ? v.toISOString() : String(v)).replace('T', ' ').slice(0, 16) + ' UTC';
    default: return String(v);
  }
}

/** Machine-readable cell value for CSV/XLSX: raw numbers, ISO dates, empty for missing. */
export function exportValue(v: unknown, type: ColumnType): string | number {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return type === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
  if (type === 'percent' || type === 'number' || type === 'hours' || type === 'integer' || type === 'currency') return Number(v);
  return String(v);
}
