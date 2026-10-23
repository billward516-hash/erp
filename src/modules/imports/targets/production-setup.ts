import { requirePermission } from '../../../platform/auth/actor.js';
import { audit } from '../../../platform/audit/audit.js';
import { many, one } from '../../../platform/db/tx.js';
import { createPlan } from '../../pm/service.js';
import { draftFor } from './boms.js';
import { facilityLookup, resolveFacility } from './common.js';
import type { FieldDef, TargetDefinition } from './types.js';

/** "monthly", "every 6 months", "90", "2 weeks" → days. */
export function intervalDaysFrom(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const words: Record<string, number> = { daily: 1, day: 1, weekly: 7, week: 7, biweekly: 14, 'bi-weekly': 14, fortnightly: 14, monthly: 30, month: 30, bimonthly: 61, 'bi-monthly': 61, quarterly: 91, quarter: 91,
    semiannual: 182, 'semi-annual': 182, 'semi annual': 182, biannual: 182, annual: 365, annually: 365, yearly: 365, year: 365 };
  if (words[s]) return words[s]!;
  const m = /^(?:every\s+)?(\d+(?:\.\d+)?)\s*(day|days|d|week|weeks|wk|wks|w|month|months|mo|mos|year|years|yr|yrs|y)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]); const u = m[2]!;
  return Math.round(n * (/^d/.test(u) ? 1 : /^w/.test(u) ? 7 : /^(mo|month)/.test(u) ? 30.4375 : 365.25));
}

const siteField: FieldDef = { key: 'site_code', label: 'Site code', type: 'string', synonyms: ['site', 'site code', 'plant', 'facility', 'facility code', 'location'] };

/** Preventive maintenance plans from a PM schedule: one row per machine and task. */
export const pmPlansTarget: TargetDefinition = {
  key: 'pm_plans', label: 'Preventive maintenance plans', entityType: 'pm_plan', naturalKey: 'code', commitPermission: 'work_orders.manage', supportsCustomFields: false,
  description: 'One row per machine and task: asset tag, task, how often (days, or a word like monthly or "every 6 months"; or a meter and its interval), hours, and when it was last done so the next due date continues the schedule. Machines must be loaded first. A plan that already exists is left as it is.',
  fields: [
    { key: 'code', label: 'Plan code', type: 'string', maxLength: 40, description: 'Optional; made from the asset tag and task when blank', synonyms: ['plan code', 'pm code', 'pm number', 'pm id', 'code', 'schedule id', 'pm #'] },
    { key: 'asset_tag', label: 'Asset tag', type: 'string', required: true, synonyms: ['asset tag', 'asset', 'asset id', 'equipment', 'equipment id', 'machine', 'tag', 'asset number', 'equipment number'] },
    { key: 'title', label: 'Task', type: 'string', required: true, maxLength: 200, synonyms: ['task', 'title', 'description', 'pm description', 'job', 'work', 'task description', 'name', 'pm name'] },
    { key: 'frequency', label: 'How often', type: 'string', description: 'Days (90), or words: weekly, monthly, quarterly, annual, "every 6 months"',
      synonyms: ['frequency', 'how often', 'interval', 'interval days', 'days', 'period', 'schedule', 'cycle', 'freq'] },
    { key: 'meter', label: 'Meter', type: 'string', description: 'For meter-based plans: the meter name, for example hours', synonyms: ['meter', 'meter name', 'counter', 'usage meter'] },
    { key: 'interval_meter', label: 'Meter interval', type: 'number', min: 0, synonyms: ['meter interval', 'every hours', 'run hours interval', 'interval hours', 'hours interval', 'usage interval'] },
    { key: 'last_done_on', label: 'Last done', type: 'date', synonyms: ['last done', 'last performed', 'last completed', 'last pm', 'last pm date', 'last service', 'last service date', 'last date'] },
    { key: 'next_due_on', label: 'Next due', type: 'date', synonyms: ['next due', 'next due date', 'due date', 'next pm', 'next date'] },
    { key: 'estimated_hours', label: 'Estimated hours', type: 'number', min: 0, synonyms: ['estimated hours', 'est hours', 'hours', 'labor hours', 'duration hours'] },
    { key: 'priority', label: 'Priority', type: 'integer', min: 1, max: 4, synonyms: ['priority'] },
    { key: 'instructions', label: 'Instructions', type: 'text', synonyms: ['instructions', 'procedure', 'notes', 'steps', 'checklist'] },
    siteField,
  ],
  async validate(ctx, rows) {
    const assets = new Map((await many(ctx.tx, 'SELECT id, facility_id, lower(asset_tag) AS tag FROM asset')).map((a) => [a.tag as string, a]));
    const codes = new Set((await many(ctx.tx, 'SELECT lower(code) AS c FROM pm_plan')).map((p) => p.c as string));
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      const a = assets.get(String(v.asset_tag ?? '').trim().toLowerCase());
      if (!a) { row.messages.push({ level: 'error', field: 'asset_tag', message: `machine "${v.asset_tag}" not found; import equipment first` }); continue; }
      v._asset_id = a.id;
      const days = intervalDaysFrom(v.frequency);
      if (v.meter || v.interval_meter) {
        if (!v.meter || !(Number(v.interval_meter) > 0)) row.messages.push({ level: 'error', field: 'interval_meter', message: 'a meter plan needs the meter name and its interval' }); else v._trigger = 'meter';
      } else if (days && days > 0) { v._trigger = 'calendar'; v._days = days; }
      else row.messages.push({ level: 'error', field: 'frequency', message: v.frequency ? `cannot read "${v.frequency}" as a frequency (try days, monthly, or "every 6 months")` : 'say how often, or give a meter and interval' });
      v._code = String(v.code ?? '').trim() || `${String(v.asset_tag).trim()}-${String(v.title ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)}`;
      const k = String(v._code).toLowerCase();
      if (seen.has(k)) row.messages.push({ level: 'error', field: 'code', message: `plan "${v._code}" appears twice in the file` }); seen.add(k);
      if (codes.has(k)) { row.action = 'unchanged'; row.messages.push({ level: 'warning', message: `plan "${v._code}" already exists and is left as it is` }); } else row.action = 'create';
      if (v.last_done_on && v._days) { const d = new Date(`${v.last_done_on}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(v._days)); v._first_due = d.toISOString().slice(0, 10); }
      if (v.next_due_on) v._first_due = v.next_due_on;
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id FROM pm_plan WHERE lower(code) = lower($1)', [v._code]);
    if (cur) return { entityId: cur.id, action: 'unchanged' };
    const p = await createPlan(ctx.tx, ctx.actor, { assetId: v._asset_id as string, code: String(v._code), title: String(v.title), instructions: (v.instructions as string) ?? null,
      triggerType: v._trigger as 'calendar' | 'meter', intervalDays: (v._days as number) ?? null, meter: (v.meter as string) ?? null, intervalMeter: (v.interval_meter as number) ?? null,
      firstDueOn: (v._first_due as string) ?? null, estimatedHours: (v.estimated_hours as number) ?? null, priority: (v.priority as 1 | 2 | 3 | 4) ?? 3 });
    return { entityId: p.id as string, action: 'create' };
  },
};

/** Routings: operations per finished part, added to its DRAFT revision (never released by an import). */
export const routingsTarget: TargetDefinition = {
  key: 'routings', label: 'Routings (operations)', entityType: 'product_operation', naturalKey: 'part_number', commitPermission: 'production.manage', supportsCustomFields: false,
  description: 'One row per operation: the part made, operation number, work center, description, setup minutes and run minutes per unit. Parts and work centers must exist first. Operations go on the part\'s draft revision, alongside its bill of material, for a person to review and release.',
  fields: [
    { key: 'part_number', label: 'Part number', type: 'string', required: true, synonyms: ['part number', 'item', 'item number', 'parent part', 'product', 'part', 'finished good', 'pn', 'item code', 'assembly'] },
    { key: 'op_no', label: 'Operation number', type: 'integer', required: true, min: 1, synonyms: ['operation number', 'op', 'op no', 'op #', 'operation', 'op number', 'seq', 'sequence', 'step', 'oper'] },
    { key: 'work_center', label: 'Work center', type: 'string', required: true, synonyms: ['work center', 'work centre', 'wc', 'work center code', 'department', 'resource', 'machine group', 'cell', 'workcenter'] },
    { key: 'description', label: 'Operation description', type: 'string', required: true, maxLength: 200, synonyms: ['description', 'operation description', 'operation name', 'op description', 'work', 'task'] },
    { key: 'setup_minutes', label: 'Setup minutes', type: 'number', min: 0, synonyms: ['setup minutes', 'setup time', 'setup', 'setup min', 'set up'] },
    { key: 'run_minutes_per_unit', label: 'Run minutes per unit', type: 'number', min: 0, synonyms: ['run minutes per unit', 'run time', 'run min', 'run minutes', 'cycle time', 'minutes per unit', 'run', 'min/unit'] },
    siteField,
  ],
  async validate(ctx, rows) {
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS n FROM part')).map((p) => [p.n as string, p.id as string]));
    const wcs = await many(ctx.tx, `SELECT w.id, w.facility_id, lower(w.code) AS code, lower(w.name) AS name FROM work_center w WHERE w.active`);
    const fac = await facilityLookup(ctx);
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const p = parts.get(String(v.part_number ?? '').trim().toLowerCase());
      if (!p) row.messages.push({ level: 'error', field: 'part_number', message: `part "${v.part_number}" not found; import parts first` }); else v._part_id = p;
      const f = v.site_code ? resolveFacility(ctx, row, fac, 'site_code') : ctx.facilityId ? [...fac.values()].find((x) => x.id === ctx.facilityId) ?? null : null;
      const word = String(v.work_center ?? '').trim().toLowerCase();
      const match = wcs.filter((w) => (w.code === word || w.name === word) && (!f || w.facility_id === f.id));
      if (match.length === 0) row.messages.push({ level: 'error', field: 'work_center', message: `work center "${v.work_center}" not found${f ? ' at this site' : ''}; import work centers first` });
      else if (match.length > 1) row.messages.push({ level: 'error', field: 'work_center', message: `"${v.work_center}" exists at more than one site; give the site code` });
      else v._wc_id = match[0]!.id;
      const k = `${String(v.part_number).toLowerCase()}|${v.op_no}`;
      if (seen.has(k)) row.messages.push({ level: 'error', field: 'op_no', message: `operation ${v.op_no} of ${v.part_number} also on row ${seen.get(k)}` }); else seen.set(k, row.rowNumber);
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'production.manage');
    const draft = await draftFor(ctx, v._part_id as string);
    const cur = await one(ctx.tx, 'SELECT id FROM product_operation WHERE revision_id = $1 AND op_no = $2', [draft, v.op_no]);
    if (cur) {
      await ctx.tx.query('UPDATE product_operation SET work_center_id = $2, description = $3, setup_minutes = $4, run_minutes_per_unit = $5 WHERE id = $1', [cur.id, v._wc_id, v.description, v.setup_minutes ?? 0, v.run_minutes_per_unit ?? 0]);
      return { entityId: cur.id, action: 'update' };
    }
    const o = await one(ctx.tx, `INSERT INTO product_operation (tenant_id, revision_id, op_no, work_center_id, description, setup_minutes, run_minutes_per_unit) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [ctx.actor.tenantId, draft, v.op_no, v._wc_id, v.description, v.setup_minutes ?? 0, v.run_minutes_per_unit ?? 0]);
    await audit(ctx.tx, ctx.actor, { action: 'product_operation.imported', entityType: 'product_revision', entityId: draft, data: { opNo: v.op_no, import: ctx.batchId } });
    return { entityId: o.id as string, action: 'create' };
  },
};
