import { requirePermission } from '../../../platform/auth/actor.js';
import { many, one } from '../../../platform/db/tx.js';
import { recordMeter } from '../../pm/service.js';
import { saveExpenseCategory } from '../../policies/service.js';
import { saveItem } from '../../sales/service.js';
import { weekStartOf } from '../../time/service.js';
import { facilityLookup, flagDuplicates, resolveFacility } from './common.js';
import type { FieldDef, TargetDefinition } from './types.js';

const siteField: FieldDef = { key: 'site_code', label: 'Site code', type: 'string', synonyms: ['site', 'site code', 'plant', 'facility', 'facility code', 'location'] };

/** What is sold and at what list price. Matched by item code. */
export const salesItemsTarget: TargetDefinition = {
  key: 'sales_items', label: 'Sales items and price list', entityType: 'sales_item', naturalKey: 'code', commitPermission: 'sales.orders', supportsCustomFields: false,
  description: 'Products and services you quote and invoice: code, description, kind, unit, list price, cost, and the part it is made as. A part number links the item to stock and production.',
  fields: [
    { key: 'code', label: 'Item code', type: 'string', required: true, maxLength: 40, synonyms: ['item code', 'code', 'sku', 'item', 'item number', 'product code', 'product', 'service code', 'item no'] },
    { key: 'description', label: 'Description', type: 'string', required: true, maxLength: 200, synonyms: ['description', 'name', 'item description', 'product name', 'title'] },
    { key: 'kind', label: 'Product or service', type: 'enum', values: ['product', 'service'], valueSynonyms: { product: ['product', 'goods', 'part', 'inventory', 'stock'], service: ['service', 'labor', 'labour', 'non-inventory', 'repair'] }, synonyms: ['kind', 'type', 'item type', 'product or service'] },
    { key: 'uom', label: 'Unit', type: 'string', maxLength: 10, synonyms: ['unit', 'uom', 'unit of measure', 'sell unit'] },
    { key: 'list_price', label: 'List price', type: 'number', min: 0, synonyms: ['list price', 'price', 'unit price', 'sell price', 'selling price', 'rate', 'standard price'] },
    { key: 'unit_cost', label: 'Unit cost', type: 'number', min: 0, synonyms: ['unit cost', 'cost', 'standard cost', 'std cost'] },
    { key: 'part_number', label: 'Made as part number', type: 'string', synonyms: ['part number', 'part', 'our part number', 'made as', 'stock item'] },
    { key: 'active', label: 'Active', type: 'boolean', synonyms: ['active', 'status'], valueSynonyms: { true: ['active', 'yes', 'y', 'a', 'current'], false: ['inactive', 'no', 'n', 'i', 'obsolete', 'discontinued'] } },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'item code');
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS n FROM part')).map((p) => [p.n as string, p.id as string]));
    const have = new Set((await many(ctx.tx, 'SELECT lower(code) AS c FROM sales_item')).map((i) => i.c as string));
    for (const row of rows) {
      const v = row.values;
      if (v.part_number) { const p = parts.get(String(v.part_number).trim().toLowerCase()); if (!p) row.messages.push({ level: 'error', field: 'part_number', message: `part "${v.part_number}" not found; import parts first` }); else v._part_id = p; }
      row.action = have.has(String(v.code ?? '').toLowerCase()) ? 'update' : 'create';
      if (ctx.mode === 'create_only' && row.action === 'update') row.messages.push({ level: 'error', field: 'code', message: 'item already exists (mode is create only)' });
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT * FROM sales_item WHERE lower(code) = lower($1)', [v.code]);
    const it = await saveItem(ctx.tx, ctx.actor, { id: cur?.id, code: String(v.code), description: String(v.description), kind: (v.kind as 'product' | 'service') ?? cur?.kind ?? 'product', uom: (v.uom as string) ?? cur?.uom ?? 'EA',
      listPrice: v.list_price != null ? Number(v.list_price) : cur?.list_price != null ? Number(cur.list_price) : null, unitCost: v.unit_cost != null ? Number(v.unit_cost) : cur?.unit_cost != null ? Number(cur.unit_cost) : null,
      partId: (v._part_id as string) ?? cur?.part_id ?? null, active: (v.active as boolean | null) ?? cur?.active ?? true } as any);
    return { entityId: it.id as string, action: cur ? 'update' : 'create' };
  },
};

/** Meter readings (run hours, cycles, miles) so meter-based PM continues from where it was. */
export const meterReadingsTarget: TargetDefinition = {
  key: 'meter_readings', label: 'Meter readings', entityType: 'asset', naturalKey: 'asset_tag', commitPermission: 'assets.record_state', supportsCustomFields: false,
  description: 'Readings of hour, cycle or mileage meters per machine: asset tag, meter name, reading, date. Applied oldest first; a reading below an earlier one is refused. The last reading per meter is what meter-based preventive maintenance counts from.',
  fields: [
    { key: 'asset_tag', label: 'Asset tag', type: 'string', required: true, synonyms: ['asset tag', 'asset', 'equipment', 'machine', 'asset id', 'tag', 'unit'] },
    { key: 'meter', label: 'Meter', type: 'string', required: true, maxLength: 40, synonyms: ['meter', 'meter name', 'counter', 'type', 'measure', 'reading type'] },
    { key: 'value', label: 'Reading', type: 'number', required: true, min: 0, synonyms: ['reading', 'value', 'hours', 'meter reading', 'current reading', 'miles', 'cycles', 'count', 'odometer'] },
    { key: 'read_at', label: 'Read on', type: 'datetime', required: true, synonyms: ['date', 'read on', 'date read', 'reading date', 'read at', 'as of', 'timestamp'] },
  ],
  order(rows) { return [...rows].sort((a, b) => String(a.values.asset_tag).localeCompare(String(b.values.asset_tag)) || String(a.values.meter).localeCompare(String(b.values.meter)) || String(a.values.read_at).localeCompare(String(b.values.read_at))); },
  async validate(ctx, rows) {
    const assets = new Map((await many(ctx.tx, 'SELECT id, lower(asset_tag) AS tag FROM asset')).map((a) => [a.tag as string, a.id as string]));
    const last = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const a = assets.get(String(v.asset_tag ?? '').trim().toLowerCase());
      if (!a) { row.messages.push({ level: 'error', field: 'asset_tag', message: `machine "${v.asset_tag}" not found; import equipment first` }); continue; }
      v._asset_id = a;
      const k = `${a}|${String(v.meter).toLowerCase()}`;
      let prev = last.get(k);
      if (prev === undefined) prev = Number((await one(ctx.tx, 'SELECT value FROM asset_meter_reading WHERE asset_id = $1 AND lower(meter) = lower($2) ORDER BY read_at DESC, id DESC LIMIT 1', [a, v.meter]))?.value ?? 0);
      if (Number(v.value) < prev) row.messages.push({ level: 'error', field: 'value', message: `${v.value} is lower than the earlier reading ${prev}` }); else last.set(k, Number(v.value));
      if (new Date(String(v.read_at)).getTime() > Date.now() + 5 * 60_000) row.messages.push({ level: 'error', field: 'read_at', message: 'in the future' });
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    await recordMeter(ctx.tx, ctx.actor, v._asset_id as string, { meter: String(v.meter), value: Number(v.value), readAt: new Date(String(v.read_at)) });
    return { entityId: v._asset_id as string, action: 'create' };
  },
};

/** Expense categories with their limits and accounts. Matched by code. */
export const expenseCategoriesTarget: TargetDefinition = {
  key: 'expense_categories', label: 'Expense categories', entityType: 'expense_category', naturalKey: 'code', commitPermission: 'policies.manage', supportsCustomFields: false,
  description: 'Categories people claim against (meals, lodging, mileage): code, name, per-item and per-day limits, the amount over which a receipt is required.',
  fields: [
    { key: 'code', label: 'Category code', type: 'string', required: true, maxLength: 20, synonyms: ['code', 'category code', 'category', 'expense code', 'type code'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 80, synonyms: ['name', 'category name', 'description', 'expense type'] },
    { key: 'kind', label: 'Kind', type: 'enum', values: ['amount', 'mileage'], valueSynonyms: { amount: ['amount', 'money', 'expense'], mileage: ['mileage', 'miles', 'distance', 'km', 'per mile'] }, synonyms: ['kind', 'type', 'unit'] },
    { key: 'limit_per_item', label: 'Limit per item', type: 'number', min: 0, synonyms: ['limit per item', 'item limit', 'max per item', 'per item', 'limit'] },
    { key: 'limit_per_day', label: 'Limit per day', type: 'number', min: 0, synonyms: ['limit per day', 'daily limit', 'max per day', 'per day', 'per diem'] },
    { key: 'receipt_required_over', label: 'Receipt required over', type: 'number', min: 0, synonyms: ['receipt required over', 'receipt over', 'receipt threshold', 'receipt required', 'receipt limit'] },
    { key: 'needs_attendees', label: 'Needs attendees', type: 'boolean', synonyms: ['needs attendees', 'attendees', 'attendees required'], valueSynonyms: { true: ['yes', 'y', 'true', 'x', '1'], false: ['no', 'n', 'false', '0'] } },
    { key: 'active', label: 'Active', type: 'boolean', synonyms: ['active', 'status'], valueSynonyms: { true: ['active', 'yes', 'y'], false: ['inactive', 'no', 'n'] } },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'category code');
    const have = new Set((await many(ctx.tx, 'SELECT lower(code) AS c FROM expense_category')).map((c) => c.c as string));
    for (const row of rows) {
      const v = row.values;
      if (v.limit_per_item != null && v.limit_per_day != null && Number(v.limit_per_item) > Number(v.limit_per_day)) row.messages.push({ level: 'error', field: 'limit_per_item', message: 'the per-item limit is above the daily limit' });
      for (const k of ['limit_per_item', 'limit_per_day']) if (v[k] != null && !(Number(v[k]) > 0)) v[k] = null;
      row.action = have.has(String(v.code ?? '').toLowerCase()) ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id, account_key, sort_order FROM expense_category WHERE lower(code) = lower($1)', [v.code]);
    const c = await saveExpenseCategory(ctx.tx, ctx.actor, { id: cur?.id, code: String(v.code), name: String(v.name), kind: (v.kind as 'amount' | 'mileage') ?? 'amount', limitPerItem: (v.limit_per_item as number) ?? null,
      limitPerDay: (v.limit_per_day as number) ?? null, receiptRequiredOver: (v.receipt_required_over as number) ?? null, needsAttendees: (v.needs_attendees as boolean) ?? false,
      accountKey: cur?.account_key, active: (v.active as boolean | null) ?? true, sortOrder: cur?.sort_order });
    return { entityId: c.id as string, action: cur ? 'update' : 'create' };
  },
};

/** Earning codes, with the payroll provider's own codes. Matched by code. */
export const earningCodesTarget: TargetDefinition = {
  key: 'earning_codes', label: 'Earning codes (payroll)', entityType: 'earning_code', naturalKey: 'code', commitPermission: 'time.export', supportsCustomFields: false,
  description: 'What hours are called on a timesheet (regular, overtime, holiday, sick) and the code your payroll provider uses for each in its import file.',
  fields: [
    { key: 'code', label: 'Code', type: 'string', required: true, maxLength: 12, synonyms: ['code', 'earning code', 'pay code', 'earnings code', 'hours type', 'type code'] },
    { key: 'label', label: 'Name', type: 'string', required: true, maxLength: 60, synonyms: ['name', 'label', 'description', 'pay type', 'earning', 'earning name'] },
    { key: 'kind', label: 'Kind', type: 'enum', required: true, values: ['worked', 'paid_leave', 'unpaid'], valueSynonyms: { worked: ['worked', 'regular', 'overtime', 'work', 'hours worked', 'premium'], paid_leave: ['paid leave', 'pto', 'vacation', 'holiday', 'sick', 'paid time off', 'leave'], unpaid: ['unpaid', 'unpaid leave', 'leave without pay'] }, synonyms: ['kind', 'type', 'category', 'class'] },
    { key: 'external_code', label: 'Payroll provider\'s code', type: 'string', maxLength: 20, synonyms: ['payroll code', 'external code', 'provider code', 'adp code', 'paychex code', 'export code', 'pay code in payroll'] },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'earning code');
    const have = new Set((await many(ctx.tx, 'SELECT upper(code) AS c FROM earning_code')).map((c) => c.c as string));
    for (const row of rows) { row.values.code = String(row.values.code ?? '').trim().toUpperCase(); row.action = have.has(String(row.values.code)) ? 'update' : 'create'; }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'time.export');
    const cur = await one(ctx.tx, 'SELECT code FROM earning_code WHERE upper(code) = $1', [v.code]);
    if (cur) await ctx.tx.query('UPDATE earning_code SET label = $2, kind = $3, external_code = $4, active = true WHERE tenant_id = $5 AND code = $1', [cur.code, v.label, v.kind, v.external_code ?? null, ctx.actor.tenantId]);
    else await ctx.tx.query('INSERT INTO earning_code (tenant_id, code, label, kind, external_code) VALUES ($1, $2, $3, $4, $5)', [ctx.actor.tenantId, v.code, v.label, v.kind, v.external_code ?? null]);
    // Earning codes have no id of their own; the batch record keeps a stable one derived from the code.
    return { entityId: (await one(ctx.tx, `SELECT md5($1)::uuid AS id`, [`earning_code:${ctx.actor.tenantId}:${v.code}`]))!.id as string, action: cur ? 'update' : 'create' };
  },
};

/** Past hours by person, day and earning code, for labor reports and trend; frozen like exported payroll. */
export const timesheetHistoryTarget: TargetDefinition = {
  key: 'timesheet_history', label: 'Timesheet history', entityType: 'timesheet', naturalKey: 'employee_number', commitPermission: 'time.export', supportsCustomFields: false,
  description: 'Past hours: employee number, date, earning code, hours (one row per person, day and code). Brought in as already paid: frozen, never exported to payroll again. Employees and earning codes must exist first.',
  fields: [
    { key: 'employee_number', label: 'Employee number', type: 'string', required: true, synonyms: ['employee number', 'employee id', 'emp no', 'emp #', 'badge', 'payroll id', 'employee'] },
    { key: 'work_date', label: 'Date', type: 'date', required: true, synonyms: ['date', 'work date', 'day', 'worked on', 'pay date', 'date worked'] },
    { key: 'earning_code', label: 'Earning code', type: 'string', required: true, synonyms: ['earning code', 'pay code', 'code', 'hours type', 'type', 'earning', 'pay type'] },
    { key: 'hours', label: 'Hours', type: 'number', required: true, min: 0, synonyms: ['hours', 'hrs', 'qty', 'quantity', 'time'] },
    { key: 'note', label: 'Note', type: 'string', synonyms: ['note', 'memo', 'comment'] },
    siteField,
  ],
  async validate(ctx, rows) {
    const emps = new Map((await many(ctx.tx, 'SELECT id, facility_id, lower(employee_number) AS n FROM employee')).map((e) => [e.n as string, e]));
    const codes = new Set((await many(ctx.tx, 'SELECT upper(code) AS c FROM earning_code')).map((c) => c.c as string));
    const fac = await facilityLookup(ctx);
    for (const row of rows) {
      const v = row.values;
      const e = emps.get(String(v.employee_number ?? '').trim().toLowerCase());
      if (!e) row.messages.push({ level: 'error', field: 'employee_number', message: `employee "${v.employee_number}" not found; import employees first` }); else { v._employee_id = e.id; v._facility_id = e.facility_id; }
      if (v.site_code) { const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id; }
      if (!v._facility_id && ctx.facilityId) v._facility_id = ctx.facilityId;
      if (!v._facility_id) row.messages.push({ level: 'error', field: 'site_code', message: 'this employee has no site; give a site code or choose a default site' });
      v.earning_code = String(v.earning_code ?? '').trim().toUpperCase();
      if (!codes.has(String(v.earning_code))) row.messages.push({ level: 'error', field: 'earning_code', message: `earning code "${v.earning_code}" not found; import earning codes first` });
      if (!(Number(v.hours) > 0 && Number(v.hours) <= 24)) row.messages.push({ level: 'error', field: 'hours', message: 'hours must be more than zero and at most 24 a day' });
      if (String(v.work_date) > new Date().toISOString().slice(0, 10)) row.messages.push({ level: 'error', field: 'work_date', message: 'in the future' });
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const week = weekStartOf(String(v.work_date));
    let ts = await one(ctx.tx, 'SELECT id, status FROM timesheet WHERE employee_id = $1 AND week_start = $2 FOR UPDATE', [v._employee_id, week]);
    if (!ts) ts = await one(ctx.tx, `INSERT INTO timesheet (tenant_id, facility_id, employee_id, week_start, status, submitted_by, submitted_at, decided_by, decided_at) VALUES ($1, $2, $3, $4, 'draft', $5, now(), $5, now()) RETURNING id, status`,
      [ctx.actor.tenantId, v._facility_id, v._employee_id, week, ctx.actor.userId]);
    if (ts.status !== 'exported' && ts.status !== 'draft') throw new Error(`the week of ${week} for this employee is ${ts.status} here; history is only added to weeks it created`);
    const note = `Brought over from ${ctx.sourceSystem}`;
    const dup = await one(ctx.tx, `SELECT id FROM time_entry WHERE timesheet_id = $1 AND work_date = $2 AND earning_code = $3 AND note = $4`, [ts.id, v.work_date, v.earning_code, note]);
    if (!dup) {
      await ctx.tx.query(`UPDATE timesheet SET status = 'draft' WHERE id = $1`, [ts.id]);
      await ctx.tx.query(`INSERT INTO time_entry (tenant_id, timesheet_id, work_date, earning_code, hours, source, note, created_by) VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)`,
        [ctx.actor.tenantId, ts.id, v.work_date, v.earning_code, v.hours, note, ctx.actor.userId]);
    }
    await ctx.tx.query(`UPDATE timesheet SET status = 'exported' WHERE id = $1`, [ts.id]);
    return { entityId: ts.id as string, action: dup ? 'unchanged' : 'create' };
  },
};
