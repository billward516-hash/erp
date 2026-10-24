import { createHash } from 'node:crypto';
import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission, scopeOf } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one, withTx } from '../../platform/db/tx.js';
import { AppError, conflict, invalid, notFound } from '../../platform/errors.js';
import type { Raw } from './mapping/coerce.js';
import { asText, inferDateFormat, isBlank, parseBoolean, parseDate, parseDateTime, parseNumber } from './mapping/coerce.js';
import type { FieldMapping, MappingSpec } from './mapping/spec.js';
import { applyTransforms, applyValueMap, customFieldKey, MappingSpecSchema, readSource, referencedColumns, rowMatchesFilter, unpivotTable } from './mapping/spec.js';
import type { MappingSuggestion } from './mapping/suggest.js';
import { matchEnum, suggestMapping, toBoolSyn } from './mapping/suggest.js';
import type { ParseOptions, ParsedTable, SourceRow } from './parsers/index.js';
import { parseFile } from './parsers/index.js';
import { getTarget } from './targets/registry.js';
import type { FieldDef, PlannedRow, RowMessage, TargetContext, TargetDefinition } from './targets/types.js';

const PREVIEW_ROWS = 25;

export interface ColumnPlan {
  dateFormats: Record<string, string[]>;
  warnings: string[];
}

/** Column-level inference that must be consistent across all rows (date order, etc.). */
export function planColumns(target: TargetDefinition, spec: MappingSpec, rows: SourceRow[]): ColumnPlan {
  const dateFormats: Record<string, string[]> = {};
  const warnings: string[] = [];
  for (const [key, fm] of Object.entries(spec.fields)) {
    const field = target.fields.find((f) => f.key === key);
    if (!field || (field.type !== 'date' && field.type !== 'datetime')) continue;
    if (fm.dateFormats) { dateFormats[key] = fm.dateFormats; continue; }
    if (typeof fm.source !== 'string') continue;
    const inf = inferDateFormat(rows.map((r) => r.values[fm.source as string]), spec.options.dateOrder);
    dateFormats[key] = inf.formats;
    if (inf.ambiguous) {
      warnings.push(`column "${fm.source}" (${field.label}): dates fit both ${inf.ambiguous.chosen} and ${inf.ambiguous.alternatives.join(', ')}; ` +
        `interpreted as ${inf.ambiguous.chosen}. Set dateFormats in the mapping if that is wrong.`);
    }
  }
  return { dateFormats, warnings };
}

function coerceField(field: FieldDef, fm: FieldMapping, raw: Raw, plan: ColumnPlan, spec: MappingSpec, timeZone: string):
  { value: unknown; message?: RowMessage } {
  const err = (message: string) => ({ value: null, message: { level: 'error' as const, field: field.key, message } });
  let v: Raw;
  try {
    v = applyTransforms(raw, fm.transforms);
  } catch (e) {
    return err(`transform failed: ${(e as Error).message}`);
  }
  v = applyValueMap(v, fm.valueMap);
  if (isBlank(v)) return { value: null };
  switch (field.type) {
    case 'string':
    case 'text': {
      const s = asText(v);
      if (s && field.maxLength && s.length > field.maxLength) return err(`longer than ${field.maxLength} characters`);
      return { value: s };
    }
    case 'number':
    case 'integer': {
      const n = parseNumber(v, { decimal: spec.options.decimal });
      if (!n.ok) return err(n.error);
      if (n.value === null) return { value: null };
      if (field.type === 'integer' && !Number.isInteger(n.value)) return err(`"${v}" is not a whole number`);
      if (field.min !== undefined && n.value < field.min) return err(`must be ≥ ${field.min}`);
      if (field.max !== undefined && n.value > field.max) return err(`must be ≤ ${field.max}`);
      return { value: n.value };
    }
    case 'date': {
      const d = parseDate(v, plan.dateFormats[field.key]);
      return d.ok ? { value: d.value } : err(d.error);
    }
    case 'datetime': {
      const d = parseDateTime(v, { formats: plan.dateFormats[field.key], timeZone });
      return d.ok ? { value: d.value } : err(d.error);
    }
    case 'boolean': {
      const b = parseBoolean(v, toBoolSyn(field));
      return b.ok ? { value: b.value } : err(`${b.error}; add it to the field's valueMap`);
    }
    case 'enum': {
      const e = matchEnum(v, field);
      if (e === null && field.allowOther) {
        const other = String(v).trim().toUpperCase();
        return { value: other, message: { level: 'warning', field: field.key, message: `"${v}" is not a standard value; kept as "${other}"` } };
      }
      if (e === null) return err(`"${v}" is not a recognized value (expected one of: ${field.values!.join(', ')}); add it to the field's valueMap`);
      return { value: e };
    }
  }
}

/**
 * Source row -> canonical values for the target, with per-field messages. Pure; no database access.
 * Zone-less timestamps are wall-clock times at the row's facility: `timeZoneFor` receives the row's
 * other (already normalized) values so it can locate the facility via facility_code or asset_tag.
 */
export function normalizeRow(target: TargetDefinition, spec: MappingSpec, plan: ColumnPlan, src: SourceRow,
  timeZoneFor: (values: Record<string, unknown>) => string, columns: string[]): { row: PlannedRow; blank: boolean } {
  const values: Record<string, unknown> = {};
  const messages: RowMessage[] = [];
  let anyValue = false;
  const entries = Object.entries(spec.fields).map(([key, fm]) => ({ key, fm, field: target.fields.find((f) => f.key === key)! }));
  // Datetimes last, so the facility (and its time zone) is known when they are interpreted.
  entries.sort((a, b) => Number(a.field.type === 'datetime') - Number(b.field.type === 'datetime'));
  let timeZone: string | undefined;
  for (const { key, fm, field } of entries) {
    const raw = readSource(src.values, fm);
    if (!isBlank(raw) && fm.constant === undefined) anyValue = true;
    if (field.type === 'datetime') timeZone ??= timeZoneFor(values);
    const r = coerceField(field, fm, raw, plan, spec, timeZone ?? 'UTC');
    values[key] = r.value;
    if (r.message) messages.push(r.message);
  }
  for (const f of target.fields) {
    if (f.required && (values[f.key] === null || values[f.key] === undefined) && !messages.some((m) => m.field === f.key)) {
      messages.push({ level: 'error', field: f.key, message: spec.fields[f.key] ? `${f.label} is required` : `${f.label} is required but not mapped` });
    }
  }
  if (spec.options.unmappedColumns === 'custom_fields' && target.supportsCustomFields) {
    const used = referencedColumns(spec);
    const custom: Record<string, unknown> = {};
    for (const c of columns) {
      if (used.has(c)) continue;
      const v = src.values[c];
      if (!isBlank(v)) { custom[customFieldKey(c)] = typeof v === 'string' ? v.trim() : v; anyValue = true; }
    }
    if (Object.keys(custom).length) values.custom_fields = custom;
  }
  return { row: { rowNumber: src.rowNumber, sourceColumn: src.sourceColumn, values, messages }, blank: !anyValue };
}

function validateSpec(target: TargetDefinition, spec: unknown, table: { columns: string[]; rows: SourceRow[] }) {
  const parsed = MappingSpecSchema.safeParse(spec);
  if (!parsed.success) throw invalid('mapping is not valid', parsed.error.flatten());
  const problems: string[] = [];
  for (const key of Object.keys(parsed.data.fields)) {
    if (!target.fields.some((f) => f.key === key)) problems.push(`unknown field "${key}" for target ${target.key}`);
  }
  const view = unpivotTable(parsed.data, table);
  problems.push(...view.problems);
  const cols = new Set(view.columns);
  for (const c of referencedColumns(parsed.data)) if (!cols.has(c)) problems.push(`column "${c}" is not in the file`);
  if (problems.length) throw invalid('mapping does not match this file', { problems, columns: table.columns });
  return { spec: parsed.data, view };
}

async function facilityTimeZone(tx: Tx, facilityId: string | null): Promise<string> {
  if (!facilityId) return 'UTC';
  const f = await one(tx, 'SELECT timezone FROM facility WHERE id = $1', [facilityId]);
  if (!f) throw notFound('facility');
  return f.timezone;
}

/** Row facility time zone: by facility code/name, else by the referenced asset's facility, else the batch default. */
async function timeZoneResolver(ctx: TargetContext): Promise<(values: Record<string, unknown>) => string> {
  const facilities = await many(ctx.tx, 'SELECT code, name, timezone FROM facility');
  const byFacility = new Map(facilities.flatMap((f) => [[String(f.code).toLowerCase(), f.timezone], [String(f.name).toLowerCase(), f.timezone]]));
  const assets = await many(ctx.tx, 'SELECT lower(a.asset_tag) AS tag, f.timezone FROM asset a JOIN facility f ON f.id = a.facility_id');
  const byAsset = new Map(assets.map((a) => [a.tag, a.timezone]));
  const rooms = await many(ctx.tx, 'SELECT lower(r.code) AS code, lower(r.name) AS name, f.timezone FROM cleanroom r JOIN facility f ON f.id = r.facility_id');
  const byRoom = new Map(rooms.flatMap((r) => [[r.code, r.timezone], [r.name, r.timezone]]));
  return (values) =>
    (values.room || values.point ? byRoom.get(String(values.room ?? String(values.point).split('/')[0]).trim().toLowerCase()) : undefined) ??
    (values.facility_code ? byFacility.get(String(values.facility_code).toLowerCase()) : undefined)
    ?? (values.asset_tag ? byAsset.get(String(values.asset_tag).toLowerCase()) : undefined)
    ?? ctx.facilityTimeZone;
}

interface RowKey { rowNumber: number; sourceColumn?: string; filtered?: boolean }

interface Evaluation {
  rows: PlannedRow[];
  skipped: RowKey[];
  warnings: string[];
}

/** Full pipeline minus writes: normalize every row, then target-level reference/duplicate checks. */
async function evaluate(ctx: TargetContext, target: TargetDefinition, spec: MappingSpec, table: { columns: string[]; rows: SourceRow[] }): Promise<Evaluation> {
  const plan = planColumns(target, spec, table.rows);
  const rows: PlannedRow[] = [];
  const skipped: RowKey[] = [];
  const timeZoneFor = await timeZoneResolver(ctx);
  for (const src of table.rows) {
    if (spec.options.skipRows.some((f) => rowMatchesFilter(src.values, f))) { skipped.push({ rowNumber: src.rowNumber, sourceColumn: src.sourceColumn, filtered: true }); continue; }
    const { row, blank } = normalizeRow(target, spec, plan, src, timeZoneFor, table.columns);
    if (blank && spec.options.skipBlankRows) { skipped.push({ rowNumber: src.rowNumber, sourceColumn: src.sourceColumn }); continue; }
    rows.push(row);
  }
  const ordered = target.order ? target.order(rows) : rows;
  await target.validate(ctx, ordered);
  return { rows: ordered, skipped, warnings: plan.warnings };
}

/**
 * Pre-check (SC-003): rows that name something not loaded yet (a machine, a supplier, a part), grouped by field with the distinct
 * missing values, so "312 of 340 asset tags are in your asset file" is one line instead of 28 scattered errors.
 */
export function referenceGaps(target: TargetDefinition, rows: { values: Record<string, unknown>; messages: RowMessage[] }[]) {
  const by = new Map<string, { rows: number; values: Map<string, number> }>();
  for (const r of rows) for (const m of r.messages) {
    if (m.level !== 'error' || !m.field || !/not found|unknown|does not exist|not loaded|import .* first/i.test(m.message)) continue;
    const g = by.get(m.field) ?? { rows: 0, values: new Map<string, number>() };
    g.rows++;
    const v = String(r.values[m.field] ?? '').trim();
    if (v) g.values.set(v, (g.values.get(v) ?? 0) + 1);
    by.set(m.field, g);
  }
  return [...by.entries()].map(([field, g]) => ({ field, label: target.fields.find((f) => f.key === field)?.label ?? field, rows: g.rows, distinct: g.values.size,
    examples: [...g.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, rows]) => ({ value, rows })) }));
}

const rowStatus = (r: PlannedRow) => (r.messages.some((m) => m.level === 'error') ? 'error' : r.messages.length ? 'warning' : 'valid');
const publicValues = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));

function summarize(rows: PlannedRow[], skipped: RowKey[]) {
  const by = (s: string) => rows.filter((r) => rowStatus(r) === s).length;
  const errorsByField: Record<string, number> = {};
  for (const r of rows) for (const m of r.messages) if (m.level === 'error') errorsByField[m.field ?? '(row)'] = (errorsByField[m.field ?? '(row)'] ?? 0) + 1;
  return {
    total: rows.length + skipped.length, valid: by('valid'), warnings: by('warning'), errors: by('error'), skippedBlank: skipped.filter((k) => !k.filtered).length, skippedByFilter: skipped.filter((k) => k.filtered).length,
    toCreate: rows.filter((r) => rowStatus(r) !== 'error' && r.action === 'create').length,
    toUpdate: rows.filter((r) => rowStatus(r) !== 'error' && r.action === 'update').length,
    errorsByField,
  };
}

export interface StageInput {
  target: string;
  sourceSystem: string;
  fileName: string;
  content: Buffer;
  facilityId?: string | null;
  profileId?: string;
  mapping?: unknown;
  parse?: ParseOptions;
}

/**
 * Parses, maps (explicit mapping → saved profile → auto-suggestion), validates every row and stages
 * the result. Nothing touches operational tables; the response is the dry-run report.
 */
export async function stageImport(actor: Actor, input: StageInput) {
  const target = getTarget(input.target);
  if (!target) throw invalid(`unknown import target "${input.target}"`);
  requirePermission(actor, 'imports.run', input.facilityId);
  let table: ParsedTable;
  try {
    table = await parseFile(input.content, input.fileName, input.parse);
  } catch (e) {
    throw invalid(`could not read file: ${(e as Error).message}`);
  }
  if (!table.rows.length) throw invalid('no data rows found in file', { parseInfo: table.info });

  return withTx(scopeOf(actor), async (tx) => {
    let suggestion: MappingSuggestion | undefined;
    let rawSpec: unknown = input.mapping;
    let profile: any;
    if (!rawSpec && input.profileId) {
      profile = await one(tx, 'SELECT * FROM import_profile WHERE id = $1', [input.profileId]);
      if (!profile) throw notFound('import profile');
      if (profile.target !== target.key) throw invalid(`profile is for target ${profile.target}`);
      rawSpec = profile.mapping;
    }
    if (!rawSpec) {
      suggestion = suggestMapping(target, table.columns, table.rows.slice(0, 200).map((r) => r.values));
      rawSpec = suggestion.mapping;
    }
    const { spec, view } = validateSpec(target, rawSpec, table);
    const ctx: TargetContext = { tx, actor, sourceSystem: input.sourceSystem, facilityId: input.facilityId ?? null,
      facilityTimeZone: await facilityTimeZone(tx, input.facilityId ?? null), mode: spec.options.mode };
    const ev = await evaluate(ctx, target, spec, view);
    const stats = summarize(ev.rows, ev.skipped);
    const sha = createHash('sha256').update(input.content).digest('hex');
    const previous = await one(tx, `SELECT id, created_at FROM import_batch WHERE file_sha256 = $1 AND target = $2 AND status = 'committed' ORDER BY created_at DESC LIMIT 1`, [sha, target.key]);
    const warnings = [...table.info.warnings, ...ev.warnings];
    const mapsDatetime = Object.keys(spec.fields).some((k) => target.fields.find((f) => f.key === k)?.type === 'datetime');
    if (mapsDatetime && !input.facilityId) {
      warnings.push('times without a UTC offset are read in each row\'s facility time zone; rows whose facility cannot be determined are read as UTC — choose a default facility to avoid this');
    }
    if (previous) warnings.push(`this exact file was already committed on ${new Date(previous.created_at).toISOString().slice(0, 10)} (batch ${previous.id}); re-importing updates matching records instead of duplicating them`);

    const batch = await one(
      tx,
      `INSERT INTO import_batch (tenant_id, facility_id, target, source_system, profile_id, file_name, file_sha256, format, parse_info,
         source_columns, mapping, stats, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, created_at`,
      [actor.tenantId, input.facilityId ?? null, target.key, input.sourceSystem, profile?.id ?? null, input.fileName, sha, table.info.format,
        { ...table.info, warnings, parse: input.parse ?? {} }, table.columns, spec, stats, actor.userId],
    );
    const rawByRow = new Map(table.rows.map((r) => [r.rowNumber, r.values]));
    const records = [
      ...ev.rows.map((r) => ({ row_number: r.rowNumber, source_column: r.sourceColumn ?? '', raw: rawByRow.get(r.rowNumber), normalized: publicValues(r.values), status: rowStatus(r), messages: r.messages, action: r.action ?? null })),
      ...ev.skipped.map((k) => ({ row_number: k.rowNumber, source_column: k.sourceColumn ?? '', raw: rawByRow.get(k.rowNumber), normalized: null, status: 'skipped', messages: [], action: null })),
    ];
    // Source rows that produced nothing after unpivoting are still stored so the batch can be re-evaluated.
    const covered = new Set(records.map((r) => r.row_number));
    for (const r of table.rows) if (!covered.has(r.rowNumber)) records.push({ row_number: r.rowNumber, source_column: '', raw: r.values, normalized: null, status: 'skipped', messages: [], action: null });
    for (let i = 0; i < records.length; i += 1000) {
      await tx.query(
        `INSERT INTO import_row (tenant_id, batch_id, row_number, source_column, raw, normalized, status, messages, action)
         SELECT $1, $2, r.row_number, r.source_column, r.raw, r.normalized, r.status, r.messages, r.action
         FROM jsonb_to_recordset($3::jsonb) AS r(row_number int, source_column text, raw jsonb, normalized jsonb, status text, messages jsonb, action text)`,
        [actor.tenantId, batch.id, JSON.stringify(records.slice(i, i + 1000))],
      );
    }
    await audit(tx, actor, { action: 'import.staged', entityType: 'import_batch', entityId: batch.id, facilityId: input.facilityId ?? null,
      data: { target: target.key, fileName: input.fileName, sha256: sha, stats } });
    return {
      batchId: batch.id as string,
      target: target.key,
      parseInfo: { ...table.info, warnings },
      columns: view.columns,
      mapping: spec,
      suggestion: suggestion && { suggestions: suggestion.suggestions, unmappedColumns: suggestion.unmappedColumns,
        missingRequired: suggestion.missingRequired, unmatchedValues: suggestion.unmatchedValues },
      stats,
      gaps: referenceGaps(target, ev.rows),
      warnings,
      preview: ev.rows.slice(0, PREVIEW_ROWS).map((r) => ({ rowNumber: r.rowNumber, sourceColumn: r.sourceColumn, status: rowStatus(r), action: r.action, values: publicValues(r.values), messages: r.messages })),
      problems: ev.rows.filter((r) => rowStatus(r) === 'error').slice(0, 100).map((r) => ({ rowNumber: r.rowNumber, ...(r.sourceColumn ? { sourceColumn: r.sourceColumn } : {}), messages: r.messages })),
    };
  });
}

/**
 * Commits a staged batch. The batch is re-evaluated against current data inside the commit
 * transaction (records may have changed since staging). By default any error blocks the whole
 * batch; with allowPartial, error rows are skipped and each good row is written under a savepoint.
 */
export async function commitImport(actor: Actor, batchId: string, opts: { allowPartial?: boolean } = {}) {
  requirePermission(actor, 'imports.commit');
  try {
    return await withTx(scopeOf(actor), async (tx) => {
      const batch = await one(tx, 'SELECT * FROM import_batch WHERE id = $1 FOR UPDATE', [batchId]);
      if (!batch) throw notFound('import batch');
      if (batch.status !== 'validated') throw conflict(`batch is ${batch.status}`);
      const target = getTarget(batch.target)!;
      requirePermission(actor, 'imports.commit', batch.facility_id);
      requirePermission(actor, target.commitPermission, batch.facility_id);
      const spec = MappingSpecSchema.parse(batch.mapping);
      const stored = await many(tx, `SELECT DISTINCT ON (row_number) row_number, raw FROM import_row WHERE batch_id = $1 ORDER BY row_number`, [batchId]);
      const table = unpivotTable(spec, { columns: batch.source_columns as string[], rows: stored.map((r) => ({ rowNumber: r.row_number, values: r.raw })) });
      const ctx: TargetContext = { tx, actor, sourceSystem: batch.source_system, facilityId: batch.facility_id,
        facilityTimeZone: await facilityTimeZone(tx, batch.facility_id), mode: spec.options.mode, batchId };
      const ev = await evaluate(ctx, target, spec, table);
      const errorRows = ev.rows.filter((r) => rowStatus(r) === 'error');
      if (errorRows.length && !opts.allowPartial) {
        throw new AppError(409, 'import_has_errors', `${errorRows.length} row(s) have errors; fix and re-stage, or commit with allowPartial`,
          { stats: summarize(ev.rows, ev.skipped), problems: errorRows.slice(0, 100).map((r) => ({ rowNumber: r.rowNumber, sourceColumn: r.sourceColumn, messages: r.messages })) });
      }
      const results: { row_number: number; source_column: string; status: string; action: string | null; entity_id: string | null; messages: RowMessage[]; normalized: unknown }[] = [];
      const counts = { created: 0, updated: 0, unchanged: 0, failed: errorRows.length };
      for (const row of ev.rows) {
        if (rowStatus(row) === 'error') {
          results.push({ row_number: row.rowNumber, source_column: row.sourceColumn ?? '', status: 'error', action: null, entity_id: null, messages: row.messages, normalized: publicValues(row.values) });
          continue;
        }
        await tx.query('SAVEPOINT import_row');
        try {
          const r = await target.commitRow(ctx, row);
          await tx.query('RELEASE SAVEPOINT import_row');
          counts[r.action === 'create' ? 'created' : r.action === 'update' ? 'updated' : 'unchanged']++;
          results.push({ row_number: row.rowNumber, source_column: row.sourceColumn ?? '', status: 'committed', action: r.action, entity_id: r.entityId, messages: row.messages, normalized: publicValues(row.values) });
        } catch (e) {
          await tx.query('ROLLBACK TO SAVEPOINT import_row');
          if (!opts.allowPartial) throw new AppError(409, 'import_row_failed', `row ${row.rowNumber} failed: ${(e as Error).message}`, { rowNumber: row.rowNumber });
          counts.failed++;
          results.push({ row_number: row.rowNumber, source_column: row.sourceColumn ?? '', status: 'error', action: null, entity_id: null,
            messages: [...row.messages, { level: 'error', message: (e as Error).message }], normalized: publicValues(row.values) });
        }
      }
      await tx.query(
        `UPDATE import_row r SET status = x.status, action = x.action, entity_id = x.entity_id, messages = x.messages, normalized = x.normalized
         FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, source_column text, status text, action text, entity_id uuid, messages jsonb, normalized jsonb)
         WHERE r.batch_id = $1 AND r.row_number = x.row_number AND r.source_column = x.source_column`,
        [batchId, JSON.stringify(results)],
      );
      const stats = { ...summarize(ev.rows, ev.skipped), ...counts };
      await tx.query(`UPDATE import_batch SET status = 'committed', stats = $2, committed_by = $3, committed_at = now() WHERE id = $1`, [batchId, stats, actor.userId]);
      await audit(tx, actor, { action: 'import.committed', entityType: 'import_batch', entityId: batchId, facilityId: batch.facility_id,
        data: { target: target.key, ...counts, allowPartial: !!opts.allowPartial } });
      return { batchId, status: 'committed', stats };
    });
  } catch (e) {
    if (e instanceof AppError && (e.code === 'import_has_errors' || e.code === 'import_row_failed')) {
      await withTx(scopeOf(actor), (tx) => audit(tx, actor, { action: 'import.commit_rejected', entityType: 'import_batch', entityId: batchId, data: { reason: e.message } }));
    }
    throw e;
  }
}

export async function cancelImport(actor: Actor, batchId: string) {
  requirePermission(actor, 'imports.run');
  return withTx(scopeOf(actor), async (tx) => {
    const b = await one(tx, `UPDATE import_batch SET status = 'cancelled' WHERE id = $1 AND status = 'validated' RETURNING id, facility_id`, [batchId]);
    if (!b) throw conflict('batch not found or no longer pending');
    await audit(tx, actor, { action: 'import.cancelled', entityType: 'import_batch', entityId: batchId, facilityId: b.facility_id });
  });
}

export async function getBatch(actor: Actor, batchId: string, q: { status?: string; limit?: number; offset?: number } = {}) {
  requirePermission(actor, 'imports.run');
  return withTx(scopeOf(actor), async (tx) => {
    const batch = await one(tx, 'SELECT * FROM import_batch WHERE id = $1', [batchId]);
    if (!batch) throw notFound('import batch');
    const rows = await many(
      tx,
      `SELECT row_number, source_column, status, action, entity_id, normalized, messages, raw FROM import_row
       WHERE batch_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY row_number, source_column LIMIT $3 OFFSET $4`,
      [batchId, q.status ?? null, Math.min(q.limit ?? 100, 1000), q.offset ?? 0],
    );
    return { ...batch, rows };
  });
}

/** Rows with problems plus their original values — the customer fixes them in their own spreadsheet and re-uploads. */
export async function errorReportRows(actor: Actor, batchId: string) {
  const batch = await getBatch(actor, batchId, { limit: 1000 });
  if (batch.rows_purged_at) throw new AppError(410, 'rows_removed', `the rows of this import were removed on ${new Date(batch.rows_purged_at).toISOString().slice(0, 10)} under the company's data retention setting; its summary is kept`);
  const all = await withTx(scopeOf(actor), (tx) =>
    many(tx, `SELECT row_number, source_column, status, messages, raw FROM import_row WHERE batch_id = $1 AND status IN ('error', 'warning') ORDER BY row_number, source_column`, [batchId]));
  const wide = all.some((r) => r.source_column);
  const columns = ['Source row', ...(wide ? ['Source column'] : []), 'Status', 'Problems', ...(batch.source_columns as string[])];
  const rows = all.map((r) => ({
    'Source row': r.row_number, ...(wide ? { 'Source column': r.source_column } : {}), Status: r.status,
    Problems: (r.messages as RowMessage[]).map((m) => `${m.level === 'error' ? 'ERROR' : 'warning'}${m.field ? ` [${m.field}]` : ''}: ${m.message}`).join(' | '),
    ...r.raw,
  }));
  return { columns, rows, fileName: `${String(batch.file_name).replace(/\.[^.]+$/, '')}-problems.csv` };
}

export async function saveProfile(actor: Actor, input: { name: string; target: string; sourceSystem: string; mapping: unknown }) {
  requirePermission(actor, 'imports.run');
  const target = getTarget(input.target);
  if (!target) throw invalid(`unknown import target "${input.target}"`);
  const parsed = MappingSpecSchema.safeParse(input.mapping);
  if (!parsed.success) throw invalid('mapping is not valid', parsed.error.flatten());
  const unknown = Object.keys(parsed.data.fields).filter((k) => !target.fields.some((f) => f.key === k));
  if (unknown.length) throw invalid(`unknown fields for ${target.key}: ${unknown.join(', ')}`);
  return withTx(scopeOf(actor), async (tx) => {
    const row = await one(
      tx,
      `INSERT INTO import_profile (tenant_id, name, target, source_system, mapping, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, name) DO UPDATE SET mapping = excluded.mapping, target = excluded.target,
         source_system = excluded.source_system, version = import_profile.version + 1
       RETURNING id, name, target, source_system, version`,
      [actor.tenantId, input.name, target.key, input.sourceSystem, parsed.data, actor.userId],
    );
    await audit(tx, actor, { action: 'import.profile_saved', entityType: 'import_profile', entityId: row.id, data: { name: row.name, version: row.version } });
    return row;
  });
}

export async function listProfiles(actor: Actor) {
  requirePermission(actor, 'imports.run');
  return withTx(scopeOf(actor), (tx) => many(tx, 'SELECT id, name, target, source_system, version, updated_at FROM import_profile ORDER BY name'));
}

/** Mapping suggestion without staging (for an interactive mapping screen). */
export async function suggestForFile(actor: Actor, input: { target: string; fileName: string; content: Buffer; parse?: ParseOptions }) {
  requirePermission(actor, 'imports.run');
  const target = getTarget(input.target);
  if (!target) throw invalid(`unknown import target "${input.target}"`);
  const table = await parseFile(input.content, input.fileName, input.parse).catch((e) => { throw invalid(`could not read file: ${e.message}`); });
  return { parseInfo: table.info, columns: table.columns, sample: table.rows.slice(0, 10), ...suggestMapping(target, table.columns, table.rows.slice(0, 200).map((r) => r.values)) };
}
