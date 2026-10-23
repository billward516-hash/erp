import { audit } from '../../../platform/audit/audit.js';
import { requirePermission } from '../../../platform/auth/actor.js';
import { many, nextSequence, one } from '../../../platform/db/tx.js';
import { findExternalRef, flagDuplicates, saveExternalRef } from './common.js';
import { splitFullName } from './employees.js';
import type { PlannedRow, TargetContext, TargetDefinition } from './types.js';

async function assetIndex(ctx: TargetContext) {
  const rows = await many(ctx.tx, 'SELECT id, asset_tag, facility_id FROM asset');
  return new Map(rows.map((a) => [String(a.asset_tag).toLowerCase(), a]));
}

async function resolveAsset(ctx: TargetContext, row: PlannedRow, assets: Map<string, any>) {
  const v = row.values;
  const tag = v.asset_tag ? String(v.asset_tag).toLowerCase() : null;
  const byRef = v.asset_external_id ? await findExternalRef(ctx, 'asset', v.asset_external_id) : null;
  const asset = byRef ? [...assets.values()].find((a) => a.id === byRef) : tag ? assets.get(tag) : undefined;
  if (!asset) {
    row.messages.push({ level: 'error', field: 'asset_tag', message: `asset "${v.asset_tag ?? v.asset_external_id ?? ''}" not found — import the asset register first` });
    return null;
  }
  v._asset_id = asset.id;
  v._facility_id = asset.facility_id;
  return asset;
}

/** Matches a technician by employee number, then by exact "first last" / "last, first" name. */
async function employeeMatcher(ctx: TargetContext) {
  const emps = await many(ctx.tx, 'SELECT id, employee_number, first_name, last_name FROM employee');
  const byNumber = new Map(emps.map((e) => [String(e.employee_number).toLowerCase(), e.id]));
  const byName = new Map<string, string[]>();
  for (const e of emps) {
    const k = `${e.first_name} ${e.last_name}`.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), e.id]);
  }
  return (value: unknown): { id: string | null; note?: string } => {
    if (!value) return { id: null };
    const s = String(value).trim();
    const n = byNumber.get(s.toLowerCase());
    if (n) return { id: n };
    const split = splitFullName(s);
    const matches = split ? byName.get(`${split.first} ${split.last}`.toLowerCase()) ?? [] : [];
    if (matches.length === 1) return { id: matches[0]! };
    return { id: null, note: matches.length > 1 ? `technician "${s}" matches several employees` : `technician "${s}" not found` };
  };
}

export const maintenanceHistoryTarget: TargetDefinition = {
  key: 'work_order_history',
  label: 'Maintenance history (legacy work orders)',
  entityType: 'work_order',
  description: 'Closed or open work orders from a previous CMMS, spreadsheet or paper log. Legacy numbers are kept; labor is attached when the technician can be matched.',
  naturalKey: 'external_id',
  commitPermission: 'work_orders.manage',
  supportsCustomFields: true,
  fields: [
    { key: 'external_id', label: 'Legacy WO number', type: 'string', required: true,
      synonyms: ['wo number', 'wo no', 'work order', 'work order number', 'work order no', 'wo', 'ticket', 'ticket number', 'job number', 'job no', 'request number', 'id'] },
    { key: 'asset_tag', label: 'Asset tag', type: 'string',
      synonyms: ['asset', 'asset number', 'asset tag', 'equipment', 'equipment number', 'equipment id', 'equipment tag', 'machine', 'machine number', 'unit', 'tag'] },
    { key: 'asset_external_id', label: 'Asset legacy ID', type: 'string', synonyms: ['asset legacy id', 'asset record id', 'equipment record id'] },
    { key: 'title', label: 'Problem / summary', type: 'string', required: true, maxLength: 300,
      synonyms: ['description', 'problem', 'summary', 'issue', 'work requested', 'request', 'complaint', 'symptom', 'title', 'problem description', 'task'] },
    { key: 'wo_type', label: 'Work type', type: 'enum', values: ['corrective', 'preventive', 'inspection', 'other'],
      synonyms: ['type', 'work type', 'wo type', 'maintenance type', 'job type', 'category'],
      valueSynonyms: { corrective: ['cm', 'repair', 'breakdown', 'emergency', 'corrective', 'reactive', 'unplanned', 'bd', 'fix'],
        preventive: ['pm', 'preventive', 'preventative', 'scheduled', 'planned', 'routine', 'pdm'], inspection: ['insp', 'inspection', 'check', 'audit', 'survey'], other: ['project', 'improvement', 'safety', 'misc', 'other'] } },
    { key: 'priority', label: 'Priority (1 = emergency … 4 = low)', type: 'enum', values: ['1', '2', '3', '4'], synonyms: ['priority', 'pri', 'urgency', 'severity'],
      valueSynonyms: { '1': ['emergency', 'urgent', 'critical', 'p1', 'e', 'immediate'], '2': ['high', 'p2', 'h', 'asap'], '3': ['medium', 'normal', 'p3', 'routine', 'm', 'standard'], '4': ['low', 'p4', 'l', 'when possible'] } },
    { key: 'status', label: 'Status', type: 'enum', values: ['planned', 'scheduled', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled'],
      synonyms: ['status', 'wo status', 'state'],
      valueSynonyms: { closed: ['closed', 'complete', 'completed', 'done', 'finished', 'c', 'resolved'], cancelled: ['cancelled', 'canceled', 'void', 'voided', 'rejected', 'x'],
        planned: ['open', 'new', 'requested', 'pending', 'waiting', 'o', 'backlog'], scheduled: ['scheduled', 'assigned'], in_progress: ['in progress', 'wip', 'working', 'started', 'active'],
        on_hold: ['hold', 'on hold', 'waiting parts', 'awaiting parts', 'deferred'], completed: ['awaiting verification', 'work complete', 'pending review'] } },
    { key: 'reported_at', label: 'Reported / opened', type: 'datetime', required: true,
      synonyms: ['date', 'opened', 'created', 'reported', 'date reported', 'request date', 'open date', 'date opened', 'created date', 'start date', 'reported date'] },
    { key: 'completed_at', label: 'Completed / closed', type: 'datetime',
      synonyms: ['completed', 'closed', 'date completed', 'completion date', 'closed date', 'finish date', 'date closed', 'end date', 'completed date'] },
    { key: 'technician', label: 'Technician (employee # or name)', type: 'string',
      synonyms: ['technician', 'tech', 'assigned to', 'performed by', 'mechanic', 'completed by', 'worker', 'craftsman', 'employee', 'assignee'] },
    { key: 'labor_hours', label: 'Labor hours', type: 'number', min: 0, max: 1000,
      synonyms: ['hours', 'labor', 'labor hours', 'total hours', 'actual hours', 'labour hours', 'man hours', 'time spent', 'hrs'] },
    { key: 'labor_rate', label: 'Labor rate (per hour)', type: 'number', min: 0, synonyms: ['rate', 'labor rate', 'hourly rate', 'cost per hour'] },
    { key: 'other_cost', label: 'Parts and contractor cost', type: 'number', min: 0, description: 'Cost of the job other than in-house labor (parts, outside services); used for repair-or-replace',
      synonyms: ['parts cost', 'material cost', 'materials', 'parts', 'outside cost', 'contractor cost', 'vendor cost', 'other cost', 'cost'] },
    { key: 'remedy', label: 'Action taken', type: 'text', synonyms: ['action taken', 'resolution', 'corrective action', 'work performed', 'repair', 'remedy', 'work done', 'fix', 'solution'] },
    { key: 'findings', label: 'Findings / notes', type: 'text', synonyms: ['notes', 'comments', 'findings', 'remarks', 'technician notes', 'observations'] },
    { key: 'failure_code', label: 'Failure code', type: 'string', synonyms: ['failure code', 'failure', 'problem code', 'failure mode'] },
    { key: 'cause_code', label: 'Cause code', type: 'string', synonyms: ['cause code', 'cause', 'root cause', 'reason'] },
    { key: 'downtime_hours', label: 'Downtime hours (reference only)', type: 'number', min: 0,
      description: 'Kept as reference on the work order. Import a downtime log to build utilization history.',
      synonyms: ['downtime', 'down time', 'downtime hours', 'hours down', 'outage hours'] },
  ],

  async validate(ctx, rows) {
    flagDuplicates(rows, 'external_id', 'legacy work order number');
    const assets = await assetIndex(ctx);
    const matchEmployee = await employeeMatcher(ctx);
    for (const row of rows) {
      const v = row.values;
      if (!v.asset_tag && !v.asset_external_id) row.messages.push({ level: 'error', field: 'asset_tag', message: 'asset tag (or asset legacy ID) is required' });
      else await resolveAsset(ctx, row, assets);
      v.status ??= v.completed_at ? 'closed' : 'planned';
      if (v.completed_at && v.reported_at && String(v.completed_at) < String(v.reported_at)) {
        row.messages.push({ level: 'error', field: 'completed_at', message: 'completed date is before reported date' });
      }
      if (['closed', 'completed'].includes(String(v.status)) && !v.completed_at) {
        row.messages.push({ level: 'warning', field: 'completed_at', message: 'closed without a completion date; reported date will be used' });
      }
      const tech = matchEmployee(v.technician);
      v._employee_id = tech.id;
      if (tech.note) row.messages.push({ level: 'warning', field: 'technician', message: `${tech.note}; name kept on the record, labor not attached` });
      else if (v.labor_hours && !tech.id) row.messages.push({ level: 'warning', field: 'labor_hours', message: 'labor hours kept as reference (no technician to attach them to)' });
      const existing = await findExternalRef(ctx, 'work_order', v.external_id);
      row.action = existing ? 'unchanged' : 'create';
      if (existing) row.messages.push({ level: 'warning', field: 'external_id', message: 'already imported; row will be skipped (history is not overwritten)' });
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'work_orders.manage', v._facility_id as string);
    const existing = await findExternalRef(ctx, 'work_order', v.external_id);
    if (existing) return { entityId: existing, action: 'unchanged' };
    const number = `WO-${String(await nextSequence(ctx.tx, ctx.actor.tenantId, 'work_order')).padStart(6, '0')}`;
    const status = String(v.status);
    const completedAt = (v.completed_at as string) ?? (['closed', 'completed'].includes(status) ? (v.reported_at as string) : null);
    const custom: Record<string, unknown> = { ...(v.custom_fields ?? {}) };
    if (v.technician && !v._employee_id) custom.legacy_technician = v.technician;
    if (v.labor_hours != null && !v._employee_id) custom.legacy_labor_hours = v.labor_hours;
    if (v.downtime_hours != null) custom.legacy_downtime_hours = v.downtime_hours;
    const wo = await one(
      ctx.tx,
      `INSERT INTO work_order (tenant_id, facility_id, number, asset_id, wo_type, priority, title, status, started_at, completed_at,
         closed_at, remedy, findings, failure_code, cause_code, origin, legacy_number, custom_fields, created_by, created_at, legacy_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'import', $16, $17, $18, $19, $20) RETURNING id`,
      [ctx.actor.tenantId, v._facility_id, number, v._asset_id, v.wo_type ?? 'corrective', Number(v.priority ?? 3), v.title, status,
        completedAt ? v.reported_at : null, completedAt, status === 'closed' ? completedAt : null, v.remedy ?? null, v.findings ?? null,
        v.failure_code ?? null, v.cause_code ?? null, v.external_id, custom, ctx.actor.userId, v.reported_at, v.other_cost ?? null],
    );
    if (v._employee_id) {
      await ctx.tx.query(`INSERT INTO work_order_assignment (tenant_id, work_order_id, employee_id) VALUES ($1, $2, $3)`,
        [ctx.actor.tenantId, wo.id, v._employee_id]);
      if (v.labor_hours) {
        // Multi-day jobs are recorded as one entry dated at completion, split into ≤24h lines.
        let remaining = Number(v.labor_hours);
        const workDate = String(completedAt ?? v.reported_at).slice(0, 10);
        while (remaining > 0) {
          const h = Math.min(remaining, 24);
          await ctx.tx.query(
            `INSERT INTO work_order_labor (tenant_id, work_order_id, employee_id, work_date, hours, hourly_rate, note, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, 'imported from legacy history', $7)`,
            [ctx.actor.tenantId, wo.id, v._employee_id, workDate, h, v.labor_rate ?? null, ctx.actor.userId],
          );
          remaining = Math.round((remaining - h) * 100) / 100;
        }
      }
    }
    await saveExternalRef(ctx, 'work_order', v.external_id, wo.id);
    await audit(ctx.tx, ctx.actor, { action: 'work_order.imported', entityType: 'work_order', entityId: wo.id, facilityId: v._facility_id as string,
      data: { number, legacyNumber: v.external_id, sourceSystem: ctx.sourceSystem, batchId: ctx.batchId } });
    return { entityId: wo.id, action: 'create' };
  },
};
