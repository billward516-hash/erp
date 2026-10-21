import type { Actor } from '../../../platform/auth/actor.js';
import type { Tx } from '../../../platform/db/tx.js';

export type FieldType = 'string' | 'text' | 'number' | 'integer' | 'date' | 'datetime' | 'boolean' | 'enum';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  description?: string;
  /** Header names customers commonly use for this field (drives auto-mapping). */
  synonyms?: string[];
  /** For enums: allowed platform values. */
  values?: string[];
  /** For enums/booleans: common customer spellings per platform value. */
  valueSynonyms?: Record<string, string[]>;
  /** Enums only: unrecognized values pass through (upper-cased) with a warning instead of an error. */
  allowOther?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
}

export type Normalized = Record<string, unknown> & { custom_fields?: Record<string, unknown> };

export interface RowMessage {
  level: 'error' | 'warning';
  field?: string;
  message: string;
}

export interface TargetContext {
  tx: Tx;
  actor: Actor;
  sourceSystem: string;
  /** Default facility for rows that don't name one. */
  facilityId: string | null;
  facilityTimeZone: string;
  mode: 'upsert' | 'create_only' | 'update_only';
  batchId?: string;
}

export interface PlannedRow {
  rowNumber: number;
  sourceColumn?: string;
  values: Normalized;
  messages: RowMessage[];
  /** create/update determined during validation; re-checked at commit. */
  action?: 'create' | 'update' | 'unchanged';
}

export interface TargetDefinition {
  key: string;
  label: string;
  entityType: string;
  description: string;
  fields: FieldDef[];
  /** Field whose value identifies a record in the customer's world (asset tag, part number...). */
  naturalKey: string;
  /** Permission needed to commit (staging/preview requires imports.run). */
  commitPermission: import('../../../platform/auth/permissions.js').Permission;
  /** Whether unmapped columns can be preserved (target has a custom_fields column). */
  supportsCustomFields: boolean;
  /** Batch-level validation: references, duplicates, existence. Mutates row messages/action. */
  validate(ctx: TargetContext, rows: PlannedRow[]): Promise<void>;
  /** Optional ordering (e.g. parents before components). */
  order?(rows: PlannedRow[]): PlannedRow[];
  /** Writes one validated row through domain services. Returns the affected entity. */
  commitRow(ctx: TargetContext, row: PlannedRow): Promise<{ entityId: string; action: 'create' | 'update' | 'unchanged' }>;
}
