import type { z } from 'zod';
import type { Actor } from '../../platform/auth/actor.js';
import type { Permission } from '../../platform/auth/permissions.js';
import type { Tx } from '../../platform/db/tx.js';

export type ColumnType = 'text' | 'integer' | 'number' | 'percent' | 'currency' | 'date' | 'datetime' | 'hours';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** Unit shown in headers (e.g. "h", "USD"). */
  unit?: string;
  align?: 'left' | 'right';
  /** Relative width hint for PDF/print layouts. */
  width?: number;
}

export interface Kpi {
  label: string;
  value: number | null;
  type: ColumnType;
  /** Context such as target, denominator, or period. */
  note?: string;
  status?: 'good' | 'watch' | 'bad' | 'neutral';
}

/**
 * A chart of the report (brief §15.4 shared chart library). `bars`: a ranking of named things (horizontal);
 * `columns`: ordered categories such as aging buckets or months; `line`: a trend over ordered categories. At most
 * three series; the value axis starts at zero. The table remains the full-precision view.
 */
export interface ReportChart {
  kind: 'bars' | 'columns' | 'line';
  title: string;
  category: { key: string; label: string };
  series: { key: string; label: string }[];
  valueType: ColumnType;
  unit?: string;
  data: Record<string, unknown>[];
  /** A target or threshold drawn as a dashed line. */
  reference?: { value: number; label: string };
}

/**
 * Computed report — independent of any output format. Renderers (JSON, CSV, HTML print, PDF; XLSX next)
 * consume this one structure so every format shows identical numbers for identical filters.
 */
export interface ReportResult {
  reportId: string;
  /** Answer-first headline stating the principal finding. */
  headline: string;
  /** Neutral report name. */
  name: string;
  generatedAt: string;
  period?: { from: string; to: string };
  scope: { facilities: string[]; description: string };
  filters: Record<string, unknown>;
  kpis: Kpi[];
  /** 3–5 evidence-backed supporting points. */
  insights: string[];
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  /** Definitions, data caveats, assumptions. */
  notes: string[];
  source: string;
  /** Rows flagged for attention; values are row indexes. */
  exceptions?: number[];
  /** Charts shown above the table, in every format. */
  charts?: ReportChart[];
  /** Per-row link to the source record, for drill-down. */
  drillDown?: { rowKey: string; path: string };
}

export interface ReportDefinition<P extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  name: string;
  description: string;
  permission: Permission;
  params: P;
  run(tx: Tx, actor: Actor, params: z.infer<P>): Promise<ReportResult>;
}
