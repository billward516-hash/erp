import { requirePermission } from '../../../platform/auth/actor.js';
import { audit } from '../../../platform/audit/audit.js';
import { nextSequence, many, one } from '../../../platform/db/tx.js';
import { savePlan } from '../../quality/calibration.js';
import { saveCharacteristic } from '../../spc/service.js';
import { facilityLookup, findExternalRef, flagDuplicates, resolveFacility, saveExternalRef } from './common.js';
import { intervalDaysFrom } from './production-setup.js';
import type { FieldDef, TargetDefinition } from './types.js';

const siteField: FieldDef = { key: 'site_code', label: 'Site code', type: 'string', synonyms: ['site', 'site code', 'plant', 'facility', 'facility code', 'location'] };
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** What gets measured and charted: the set-up that must exist before SPC measurements can be loaded. */
export const spcCharacteristicsTarget: TargetDefinition = {
  key: 'spc_characteristics', label: 'SPC characteristics', entityType: 'spc_characteristic', naturalKey: 'code', commitPermission: 'quality.manage', supportsCustomFields: false,
  description: 'One row per measured characteristic: code, name, unit, nominal and limits, subgroup size, how often, and optionally the part and the gauge. Load these before the measurements.',
  fields: [
    { key: 'code', label: 'Characteristic code', type: 'string', required: true, maxLength: 30, synonyms: ['characteristic', 'characteristic code', 'char', 'code', 'feature', 'dimension', 'balloon', 'key characteristic', 'kpc'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 120, synonyms: ['name', 'description', 'characteristic name', 'feature name', 'dimension name'] },
    siteField,
    { key: 'part_number', label: 'Part number', type: 'string', synonyms: ['part number', 'part', 'item', 'pn', 'product'] },
    { key: 'gauge_tag', label: 'Gauge (asset tag)', type: 'string', synonyms: ['gauge', 'gauge tag', 'instrument', 'gage', 'gage id', 'instrument id', 'measuring device'] },
    { key: 'unit', label: 'Unit', type: 'string', maxLength: 12, synonyms: ['unit', 'units', 'uom', 'unit of measure'] },
    { key: 'nominal', label: 'Nominal', type: 'number', synonyms: ['nominal', 'target', 'nominal value', 'basic'] },
    { key: 'lsl', label: 'Lower limit', type: 'number', synonyms: ['lsl', 'lower limit', 'lower spec', 'min', 'minimum', 'lower tolerance', 'lower spec limit'] },
    { key: 'usl', label: 'Upper limit', type: 'number', synonyms: ['usl', 'upper limit', 'upper spec', 'max', 'maximum', 'upper tolerance', 'upper spec limit'] },
    { key: 'subgroup_size', label: 'Subgroup size', type: 'integer', min: 1, max: 10, synonyms: ['subgroup size', 'sample size', 'subgroup', 'n', 'readings per sample', 'samples'] },
    { key: 'frequency', label: 'How often', type: 'string', synonyms: ['frequency', 'how often', 'sampling', 'sample frequency', 'check frequency', 'interval'] },
    { key: 'chart_type', label: 'Chart type', type: 'enum', values: ['variables', 'p', 'np', 'c', 'u'], valueSynonyms: { variables: ['variables', 'x-bar', 'xbar', 'xbar-r', 'x bar r', 'measurement', 'continuous', 'imr'] },
      description: 'variables (measurements) or p, np, c, u (counts)', synonyms: ['chart type', 'chart', 'type', 'data type'] },
    { key: 'attribute_sample', label: 'Fixed sample (np charts)', type: 'number', min: 1, synonyms: ['fixed sample', 'np sample', 'inspected each time'] },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'characteristic code');
    const fac = await facilityLookup(ctx);
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS n FROM part')).map((p) => [p.n as string, p.id as string]));
    const assets = await many(ctx.tx, 'SELECT id, facility_id, lower(asset_tag) AS tag FROM asset');
    for (const row of rows) {
      const v = row.values;
      const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id;
      if (v.part_number) { const p = parts.get(String(v.part_number).trim().toLowerCase()); if (!p) row.messages.push({ level: 'error', field: 'part_number', message: `part "${v.part_number}" not found; import parts first` }); else v._part_id = p; }
      if (v.gauge_tag && f) { const a = assets.find((x) => x.facility_id === f.id && x.tag === String(v.gauge_tag).trim().toLowerCase()); if (!a) row.messages.push({ level: 'error', field: 'gauge_tag', message: `gauge "${v.gauge_tag}" not found at this site; import equipment first` }); else v._gauge_id = a.id; }
      v.chart_type ??= 'variables';
      if (v.chart_type === 'variables' && v.lsl != null && v.usl != null && Number(v.lsl) >= Number(v.usl)) row.messages.push({ level: 'error', field: 'lsl', message: 'the lower limit must be below the upper limit' });
      if (v.chart_type === 'np' && !(Number(v.attribute_sample) > 0)) row.messages.push({ level: 'error', field: 'attribute_sample', message: 'an np chart needs the fixed number inspected each time' });
      v.subgroup_size = v.chart_type === 'variables' ? Number(v.subgroup_size ?? 5) : 1;
      const cur = f ? await one(ctx.tx, 'SELECT id FROM spc_characteristic WHERE facility_id = $1 AND lower(code) = lower($2)', [f.id, v.code]) : null;
      row.action = cur ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id FROM spc_characteristic WHERE facility_id = $1 AND lower(code) = lower($2)', [v._facility_id, v.code]);
    const c = await saveCharacteristic(ctx.tx, ctx.actor, { id: cur?.id, facilityId: v._facility_id as string, code: String(v.code), name: String(v.name), partId: (v._part_id as string) ?? null,
      gaugeAssetId: (v._gauge_id as string) ?? null, unit: (v.unit as string) ?? undefined, nominal: (v.nominal as number) ?? null, lsl: (v.lsl as number) ?? null, usl: (v.usl as number) ?? null,
      subgroupSize: Number(v.subgroup_size), frequency: (v.frequency as string) ?? null, chartType: v.chart_type as any, sampleSize: (v.attribute_sample as number) ?? null });
    return { entityId: c.id as string, action: cur ? 'update' : 'create' };
  },
};

/** Calibration plans from a gauge register, with each instrument's last calibration as history. */
export const calibrationTarget: TargetDefinition = {
  key: 'calibration', label: 'Calibration plans and last calibration', entityType: 'calibration_plan', naturalKey: 'asset_tag', commitPermission: 'quality.manage', supportsCustomFields: false,
  description: 'One row per instrument (already loaded as equipment): how often it is calibrated, the tolerance, and when it was last calibrated, by whom, with the certificate. The next due date continues from the last calibration. Past results are recorded as history: they do not raise nonconformances or take instruments out of service.',
  fields: [
    { key: 'asset_tag', label: 'Instrument (asset tag)', type: 'string', required: true, synonyms: ['asset tag', 'instrument', 'instrument id', 'gauge', 'gauge id', 'gage', 'gage id', 'equipment', 'id', 'tag', 'device'] },
    { key: 'interval', label: 'Calibrate every', type: 'string', required: true, description: 'Days, or words: annual, every 6 months', synonyms: ['interval', 'calibration interval', 'frequency', 'cal interval', 'cycle', 'calibrate every', 'days', 'period'] },
    { key: 'tolerance', label: 'Tolerance', type: 'string', required: true, synonyms: ['tolerance', 'accuracy', 'range', 'acceptance', 'allowable error', 'spec'] },
    { key: 'method', label: 'Method', type: 'string', synonyms: ['method', 'procedure', 'standard', 'calibration method'] },
    { key: 'last_calibrated_on', label: 'Last calibrated', type: 'date', synonyms: ['last calibrated', 'last calibration', 'last cal', 'last cal date', 'calibrated on', 'date calibrated', 'cal date', 'last date'] },
    { key: 'performed_by', label: 'Calibrated by', type: 'string', synonyms: ['calibrated by', 'performed by', 'technician', 'lab', 'vendor', 'calibration lab', 'by'] },
    { key: 'certificate_no', label: 'Certificate number', type: 'string', synonyms: ['certificate', 'certificate number', 'cert no', 'cert #', 'certificate no', 'report number'] },
    { key: 'as_found', label: 'As found', type: 'enum', values: ['in_tolerance', 'out_of_tolerance'], valueSynonyms: { in_tolerance: ['in tolerance', 'pass', 'passed', 'ok', 'good', 'in', 'yes'], out_of_tolerance: ['out of tolerance', 'fail', 'failed', 'out', 'ot', 'no', 'oot'] },
      synonyms: ['as found', 'as-found', 'found', 'result as found'] },
    { key: 'as_left', label: 'As left', type: 'enum', values: ['in_tolerance', 'adjusted', 'failed'], valueSynonyms: { in_tolerance: ['in tolerance', 'pass', 'passed', 'ok', 'good', 'in'], adjusted: ['adjusted', 'calibrated', 'reset', 'corrected'], failed: ['failed', 'fail', 'rejected', 'scrapped'] },
      synonyms: ['as left', 'as-left', 'left', 'result', 'result as left', 'final'] },
    { key: 'next_due', label: 'Next due', type: 'date', synonyms: ['next due', 'due', 'due date', 'next cal', 'next calibration', 'cal due', 'recal date'] },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'asset_tag', 'instrument');
    const assets = new Map((await many(ctx.tx, 'SELECT id, facility_id, lower(asset_tag) AS tag FROM asset')).map((a) => [a.tag as string, a]));
    const today = new Date().toISOString().slice(0, 10);
    for (const row of rows) {
      const v = row.values;
      const a = assets.get(String(v.asset_tag ?? '').trim().toLowerCase());
      if (!a) { row.messages.push({ level: 'error', field: 'asset_tag', message: `instrument "${v.asset_tag}" not found; import equipment first` }); continue; }
      v._asset_id = a.id; v._facility_id = a.facility_id;
      const days = intervalDaysFrom(v.interval);
      if (!days || days < 1) row.messages.push({ level: 'error', field: 'interval', message: `cannot read "${v.interval}" as an interval (try days, annual, or "every 6 months")` }); else v._days = days;
      if (v.last_calibrated_on) {
        if (String(v.last_calibrated_on) > today) row.messages.push({ level: 'error', field: 'last_calibrated_on', message: 'the calibration date cannot be in the future' });
        if (!v.performed_by) row.messages.push({ level: 'error', field: 'performed_by', message: 'say who calibrated it (person or lab)' });
        v.as_found ??= 'in_tolerance'; v.as_left ??= 'in_tolerance';
      }
      row.action = (await one(ctx.tx, 'SELECT 1 FROM calibration_plan WHERE asset_id = $1', [a.id])) ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const nextDue = (v.next_due as string) ?? (v.last_calibrated_on && v.as_left !== 'failed' ? addDays(String(v.last_calibrated_on), Number(v._days)) : null);
    const plan = await savePlan(ctx.tx, ctx.actor, { assetId: v._asset_id as string, intervalDays: Number(v._days), tolerance: String(v.tolerance), method: (v.method as string) ?? null, nextDue });
    if (v.last_calibrated_on && !(await one(ctx.tx, 'SELECT 1 FROM calibration_record WHERE plan_id = $1 AND performed_on = $2', [plan.id, v.last_calibrated_on]))) {
      await ctx.tx.query(`INSERT INTO calibration_record (tenant_id, facility_id, plan_id, asset_id, performed_on, performed_by, as_found, as_left, certificate_no, notes, next_due, recorded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [ctx.actor.tenantId, v._facility_id, plan.id, v._asset_id, v.last_calibrated_on, v.performed_by, v.as_found, v.as_left, v.certificate_no ?? null,
        `Brought over from ${ctx.sourceSystem}`, nextDue, ctx.actor.userId]);
    }
    return { entityId: plan.id as string, action: row.action === 'update' ? 'update' : 'create' };
  },
};

const SEVERITY_WORDS = { minor: ['minor', 'low', 'm', 'observation'], major: ['major', 'high', 'serious', 'significant'], critical: ['critical', 'severe', 'safety', 'crit'] };

/** Nonconformance history, closed or open, for trend reports; no workflow runs. */
export const ncrHistoryTarget: TargetDefinition = {
  key: 'nonconformance_history', label: 'Nonconformance history', entityType: 'nonconformance', naturalKey: 'legacy_number', commitPermission: 'quality.manage', supportsCustomFields: false,
  description: 'Past nonconformance reports (NCR, reject, deviation logs): your number, date, what happened, severity, the part and quantity, the disposition and cost, and when it was closed. Brought in as records for trends and audits; the workflow does not run.',
  fields: [
    { key: 'legacy_number', label: 'Your NCR number', type: 'string', required: true, synonyms: ['ncr', 'ncr number', 'ncr no', 'ncr #', 'report number', 'number', 'id', 'reject number', 'deviation number', 'car number'] },
    { key: 'reported_on', label: 'Date reported', type: 'date', required: true, synonyms: ['date', 'date reported', 'reported', 'opened', 'date opened', 'found on', 'created'] },
    { key: 'title', label: 'Title', type: 'string', required: true, maxLength: 200, synonyms: ['title', 'subject', 'summary', 'problem', 'short description', 'issue'] },
    { key: 'description', label: 'Description', type: 'text', synonyms: ['description', 'details', 'problem description', 'nonconformance', 'what happened', 'comments'] },
    { key: 'source', label: 'Where found', type: 'enum', values: ['production', 'receiving', 'customer', 'supplier', 'internal'],
      valueSynonyms: { production: ['production', 'in process', 'in-process', 'floor', 'manufacturing', 'process'], receiving: ['receiving', 'incoming', 'receipt', 'incoming inspection'], customer: ['customer', 'complaint', 'return', 'rma', 'field'],
        supplier: ['supplier', 'vendor'], internal: ['internal', 'audit', 'other'] }, synonyms: ['source', 'where found', 'origin', 'type', 'found at', 'category'] },
    { key: 'severity', label: 'Severity', type: 'enum', values: ['minor', 'major', 'critical'], valueSynonyms: SEVERITY_WORDS, synonyms: ['severity', 'class', 'classification', 'priority', 'grade'] },
    { key: 'part_number', label: 'Part number', type: 'string', synonyms: ['part number', 'part', 'item', 'pn', 'product'] },
    { key: 'qty', label: 'Quantity', type: 'number', min: 0, synonyms: ['quantity', 'qty', 'quantity affected', 'qty rejected', 'pieces', 'count'] },
    { key: 'disposition', label: 'Disposition', type: 'enum', values: ['use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier'],
      valueSynonyms: { use_as_is: ['use as is', 'uai', 'accept', 'accepted', 'concession', 'waiver'], rework: ['rework', 're-work', 'reprocess'], repair: ['repair'], scrap: ['scrap', 'scrapped', 'reject', 'rejected', 'destroy'], return_to_supplier: ['return to supplier', 'rts', 'return', 'rtv', 'return to vendor'] },
      synonyms: ['disposition', 'decision', 'resolution', 'action taken', 'outcome'] },
    { key: 'cost', label: 'Cost', type: 'number', min: 0, synonyms: ['cost', 'cost of poor quality', 'copq', 'scrap cost', 'amount', 'value'] },
    { key: 'closed_on', label: 'Date closed', type: 'date', synonyms: ['closed', 'date closed', 'closed on', 'closure date', 'completed'] },
    siteField,
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'legacy_number', 'NCR number');
    const fac = await facilityLookup(ctx);
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS n FROM part')).map((p) => [p.n as string, p.id as string]));
    for (const row of rows) {
      const v = row.values;
      const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id;
      if (v.part_number) { const p = parts.get(String(v.part_number).trim().toLowerCase()); if (!p) row.messages.push({ level: 'warning', field: 'part_number', message: `part "${v.part_number}" not found; recorded without it` }); else v._part_id = p; }
      if (v.qty != null && !(Number(v.qty) > 0)) { v.qty = null; row.messages.push({ level: 'warning', field: 'qty', message: 'quantity must be more than zero; left blank' }); }
      if (v.closed_on && String(v.closed_on) < String(v.reported_on)) row.messages.push({ level: 'error', field: 'closed_on', message: 'closed before it was reported' });
      row.action = (await findExternalRef(ctx, 'nonconformance', v.legacy_number)) ? 'unchanged' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'quality.manage', v._facility_id as string);
    const have = await findExternalRef(ctx, 'nonconformance', v.legacy_number);
    if (have) return { entityId: have, action: 'unchanged' };
    const number = `NCR-${String(await nextSequence(ctx.tx, ctx.actor.tenantId, 'ncr')).padStart(6, '0')}`;
    const closed = !!v.closed_on; const dispo = (v.disposition as string) ?? null;
    const status = closed ? 'closed' : dispo ? 'dispositioned' : 'open';
    const at = `${v.reported_on}T12:00:00Z`;
    const n = await one(ctx.tx, `INSERT INTO nonconformance (tenant_id, facility_id, number, source, title, description, severity, status, part_id, qty, disposition, disposition_reason, cost, dispositioned_by, dispositioned_at, reported_by, created_at, closed_by, closed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
    [ctx.actor.tenantId, v._facility_id, number, v.source ?? 'internal', String(v.title).trim(), String(v.description ?? v.title).trim(), v.severity ?? 'minor', status, v._part_id ?? null, v.qty ?? null,
      dispo, dispo ? `Brought over from ${ctx.sourceSystem} (${v.legacy_number})` : null, v.cost ?? null, dispo || closed ? ctx.actor.userId : null, dispo || closed ? `${v.closed_on ?? v.reported_on}T12:00:00Z` : null,
      ctx.actor.userId, at, closed ? ctx.actor.userId : null, closed ? `${v.closed_on}T12:00:00Z` : null]);
    await saveExternalRef(ctx, 'nonconformance', v.legacy_number, n.id);
    await audit(ctx.tx, ctx.actor, { action: 'ncr.history_imported', entityType: 'nonconformance', entityId: n.id, facilityId: v._facility_id as string, data: { legacy: v.legacy_number, number } });
    return { entityId: n.id as string, action: 'create' };
  },
};

/** Safety incident history, for rates and trends. */
export const safetyHistoryTarget: TargetDefinition = {
  key: 'safety_history', label: 'Safety incident history', entityType: 'safety_incident', naturalKey: 'legacy_number', commitPermission: 'safety.manage', supportsCustomFields: false,
  description: 'Past incident and near-miss logs: your number, date, what kind, what happened, severity, whether it was recordable, days away or restricted. Brought in as closed records so incident rates and trends cover the earlier years. Personal injury detail is not needed.',
  fields: [
    { key: 'legacy_number', label: 'Your incident number', type: 'string', required: true, synonyms: ['incident', 'incident number', 'incident no', 'incident #', 'report number', 'number', 'id', 'case number', 'log number'] },
    { key: 'occurred_on', label: 'Date', type: 'date', required: true, synonyms: ['date', 'date of incident', 'incident date', 'occurred', 'occurred on', 'date occurred', 'event date'] },
    { key: 'kind', label: 'Kind', type: 'enum', required: true, values: ['near_miss', 'first_aid', 'injury', 'illness', 'property_damage', 'environmental'],
      valueSynonyms: { near_miss: ['near miss', 'near-miss', 'close call', 'hazard', 'unsafe condition', 'observation'], first_aid: ['first aid', 'first-aid', 'fa', 'minor injury'], injury: ['injury', 'lost time', 'lti', 'recordable', 'medical treatment', 'restricted', 'accident'],
        illness: ['illness', 'occupational illness', 'exposure'], property_damage: ['property damage', 'damage', 'equipment damage', 'collision', 'spill'], environmental: ['environmental', 'release', 'environment', 'emission'] },
      synonyms: ['kind', 'type', 'incident type', 'category', 'classification', 'event type'] },
    { key: 'description', label: 'What happened', type: 'text', required: true, synonyms: ['description', 'what happened', 'details', 'narrative', 'summary', 'event description'] },
    { key: 'severity', label: 'Severity', type: 'enum', values: ['low', 'medium', 'high', 'serious'], valueSynonyms: { low: ['low', 'minor', 'negligible'], medium: ['medium', 'moderate'], high: ['high', 'major'], serious: ['serious', 'severe', 'critical', 'fatal'] }, synonyms: ['severity', 'seriousness', 'level', 'rating'] },
    { key: 'recordable', label: 'Recordable', type: 'boolean', synonyms: ['recordable', 'osha recordable', 'osha', 'is recordable'], valueSynonyms: { true: ['yes', 'y', 'true', 'recordable', '1', 'x'], false: ['no', 'n', 'false', '0'] } },
    { key: 'days_away', label: 'Days away', type: 'integer', min: 0, synonyms: ['days away', 'days lost', 'lost days', 'days away from work', 'daw'] },
    { key: 'days_restricted', label: 'Days restricted', type: 'integer', min: 0, synonyms: ['days restricted', 'restricted days', 'days transferred', 'job transfer', 'djtr'] },
    { key: 'location', label: 'Where', type: 'string', synonyms: ['location', 'where', 'area', 'department', 'place'] },
    { key: 'employee_number', label: 'Employee number', type: 'string', synonyms: ['employee number', 'employee id', 'emp no', 'involved employee', 'person'] },
    { key: 'closed_on', label: 'Date closed', type: 'date', synonyms: ['closed', 'date closed', 'closed on', 'closure date'] },
    siteField,
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'legacy_number', 'incident number');
    const fac = await facilityLookup(ctx);
    const emps = new Map((await many(ctx.tx, 'SELECT id, lower(employee_number) AS n FROM employee')).map((e) => [e.n as string, e.id as string]));
    for (const row of rows) {
      const v = row.values;
      const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id;
      if (v.employee_number) { const e = emps.get(String(v.employee_number).trim().toLowerCase()); if (!e) row.messages.push({ level: 'warning', field: 'employee_number', message: `employee ${v.employee_number} not found; recorded without the person` }); else v._employee_id = e; }
      if (String(v.occurred_on) > new Date().toISOString().slice(0, 10)) row.messages.push({ level: 'error', field: 'occurred_on', message: 'in the future' });
      v.recordable ??= (v.kind === 'injury' || Number(v.days_away ?? 0) > 0 || Number(v.days_restricted ?? 0) > 0);
      row.action = (await findExternalRef(ctx, 'safety_incident', v.legacy_number)) ? 'unchanged' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'safety.manage', v._facility_id as string);
    const have = await findExternalRef(ctx, 'safety_incident', v.legacy_number);
    if (have) return { entityId: have, action: 'unchanged' };
    const number = `INC-${String(await nextSequence(ctx.tx, ctx.actor.tenantId, 'incident')).padStart(6, '0')}`;
    const closedOn = (v.closed_on as string) ?? v.occurred_on;
    const i = await one(ctx.tx, `INSERT INTO safety_incident (tenant_id, facility_id, number, kind, occurred_at, location, description, status, severity, involved_employee_id, medical_treatment, days_away, days_restricted, recordable, reported_by, created_at, classified_by, closed_by, closed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'closed', $8, $9, $10, $11, $12, $13, $14, $5, $14, $14, $15) RETURNING id`,
    [ctx.actor.tenantId, v._facility_id, number, v.kind, `${v.occurred_on}T12:00:00Z`, v.location ?? null, String(v.description).trim(), v.severity ?? 'low', v._employee_id ?? null, v.kind === 'injury' || v.kind === 'illness',
      Number(v.days_away ?? 0), Number(v.days_restricted ?? 0), !!v.recordable, ctx.actor.userId, `${closedOn}T12:00:00Z`]);
    await saveExternalRef(ctx, 'safety_incident', v.legacy_number, i.id);
    await audit(ctx.tx, ctx.actor, { action: 'incident.history_imported', entityType: 'safety_incident', entityId: i.id, facilityId: v._facility_id as string, data: { legacy: v.legacy_number, number } });
    return { entityId: i.id as string, action: 'create' };
  },
};
