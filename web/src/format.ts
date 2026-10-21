export const fmtDate = (v?: string | null) => (v ? String(v).slice(0, 10) : '—');
export const fmtDateTime = (v?: string | null) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtNum = (v?: number | null, dp = 1) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: dp }));
export const fmtPct = (v?: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
export const fmtMoney = (v?: number | null) => (v == null ? '—' : Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const ROLE_LABELS: Record<string, string> = {
  ehs_reviewer: 'EHS reviewer', quality_reviewer: 'Quality reviewer', maintenance_manager: 'Maintenance manager', operations_manager: 'Operations manager',
};
export const roleLabel = (key: string) => ROLE_LABELS[key] ?? humanize(key);
export const humanize = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');
