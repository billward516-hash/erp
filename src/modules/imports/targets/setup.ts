import { many, one } from '../../../platform/db/tx.js';
import { saveDepartment } from '../../org/service.js';
import { createLocation } from '../../inventory/service.js';
import { saveWorkCenter } from '../../production/service.js';
import { saveWorkCenterCalendar } from '../../planning/service.js';
import { saveAccount, SUBTYPES } from '../../books/service.js';
import type { AccountType } from '../../books/chart.js';
import { facilityLookup, flagDuplicates, resolveFacility } from './common.js';
import type { FieldDef, TargetDefinition } from './types.js';

const facilityField: FieldDef = { key: 'facility_code', label: 'Site code', type: 'string',
  synonyms: ['site', 'site code', 'plant', 'plant code', 'facility', 'facility code', 'location code', 'warehouse', 'building'] };
const activeField: FieldDef = { key: 'active', label: 'Active', type: 'boolean', synonyms: ['active', 'status'],
  valueSynonyms: { true: ['active', 'open', 'yes', 'y', 'a', 'in use'], false: ['inactive', 'closed', 'no', 'n', 'i', 'retired'] } };

/** Departments / cost centers. Matched by code. */
export const departmentsTarget: TargetDefinition = {
  key: 'departments', label: 'Departments / cost centers', entityType: 'department', naturalKey: 'code', commitPermission: 'tenant.admin', supportsCustomFields: false,
  description: 'Department code and name, optionally the site it belongs to. Approval rules, budgets and expense reports use departments. Heads are chosen in the product after people have signed in.',
  fields: [
    { key: 'code', label: 'Department code', type: 'string', required: true, maxLength: 30, synonyms: ['code', 'dept', 'dept code', 'department code', 'department', 'cost center', 'cost centre', 'cost center code', 'cc', 'dept id'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 120, synonyms: ['name', 'department name', 'dept name', 'description', 'cost center name', 'title'] },
    facilityField,
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'department code');
    const fac = await facilityLookup(ctx);
    const existing = new Set((await many(ctx.tx, 'SELECT lower(code) AS c FROM department')).map((d) => d.c as string));
    for (const row of rows) {
      const v = row.values;
      if (v.facility_code) v._facility_id = resolveFacility(ctx, row, fac)?.id; 
      const has = existing.has(String(v.code ?? '').toLowerCase());
      row.action = has ? 'update' : 'create';
      if (ctx.mode === 'create_only' && has) row.messages.push({ level: 'error', field: 'code', message: 'department already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !has) row.messages.push({ level: 'error', field: 'code', message: 'department not found (mode is update only)' });
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id, facility_id FROM department WHERE lower(code) = lower($1)', [v.code]);
    const d = await saveDepartment(ctx.tx, ctx.actor, { id: cur?.id, code: String(v.code), name: String(v.name), facilityId: v.facility_code ? (v._facility_id as string) : cur?.facility_id ?? null });
    return { entityId: d.id, action: cur ? 'update' : 'create' };
  },
};

/** Storerooms and cribs. Matched by code. */
export const stockLocationsTarget: TargetDefinition = {
  key: 'stock_locations', label: 'Storerooms', entityType: 'stock_location', naturalKey: 'code', commitPermission: 'inventory.manage', supportsCustomFields: false,
  description: 'Each place stock is kept: code, name, site. Bins are a column on the stock balances, not locations of their own.',
  fields: [
    { key: 'code', label: 'Storeroom code', type: 'string', required: true, maxLength: 30, synonyms: ['code', 'storeroom', 'storeroom code', 'stockroom', 'crib', 'warehouse code', 'location', 'location code', 'store'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 120, synonyms: ['name', 'storeroom name', 'description', 'location name'] },
    { ...facilityField, required: false },
    { key: 'kind', label: 'Kind', type: 'enum', values: ['storeroom', 'staging'], valueSynonyms: { storeroom: ['storeroom', 'stockroom', 'crib', 'warehouse', 'mro'], staging: ['staging', 'kitting', 'line side', 'lineside'] }, synonyms: ['kind', 'type'] },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'storeroom code');
    const fac = await facilityLookup(ctx);
    const existing = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS c FROM stock_location')).map((d) => [d.c as string, d.id as string]));
    for (const row of rows) {
      const v = row.values;
      const f = resolveFacility(ctx, row, fac);
      if (f) v._facility_id = f.id;
      const has = existing.get(String(v.code ?? '').toLowerCase());
      row.action = has ? 'update' : 'create';
      if (ctx.mode === 'create_only' && has) row.messages.push({ level: 'error', field: 'code', message: 'storeroom already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !has) row.messages.push({ level: 'error', field: 'code', message: 'storeroom not found (mode is update only)' });
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id FROM stock_location WHERE lower(code) = lower($1)', [v.code]);
    if (cur) {
      await ctx.tx.query('UPDATE stock_location SET name = $2, kind = coalesce($3, kind) WHERE id = $1', [cur.id, v.name, v.kind ?? null]);
      return { entityId: cur.id, action: 'update' };
    }
    const l = await createLocation(ctx.tx, ctx.actor, { facilityId: v._facility_id as string, code: String(v.code), name: String(v.name), kind: (v.kind as 'storeroom' | 'staging') ?? 'storeroom' });
    return { entityId: l.id, action: 'create' };
  },
};

/** Work centers: where operations are done; machines are assets by tag. Matched by site and code. */
export const workCentersTarget: TargetDefinition = {
  key: 'work_centers', label: 'Work centers', entityType: 'work_center', naturalKey: 'code', commitPermission: 'production.manage', supportsCustomFields: false,
  description: 'A machine group, cell or station where operations are done: code, name, site, the machines in it (asset tags separated by semicolons), scheduled hours a week and the number of machines or crews. Machines must be loaded first.',
  fields: [
    { key: 'code', label: 'Work center code', type: 'string', required: true, maxLength: 30, synonyms: ['code', 'work center', 'work centre', 'work center code', 'wc', 'wc code', 'cell', 'cell code', 'department', 'resource', 'resource code', 'line'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 120, synonyms: ['name', 'work center name', 'description', 'cell name', 'resource name'] },
    facilityField,
    { key: 'machines', label: 'Machines (asset tags)', type: 'string', description: 'Asset tags separated by semicolons or commas', synonyms: ['machines', 'equipment', 'asset tags', 'assets', 'machine list', 'tags'] },
    { key: 'hours_per_week', label: 'Scheduled hours a week', type: 'number', min: 0, max: 168, synonyms: ['hours per week', 'hours a week', 'weekly hours', 'scheduled hours', 'capacity hours'] },
    { key: 'units', label: 'Machines or crews', type: 'integer', min: 1, max: 500, synonyms: ['units', 'machines', 'number of machines', 'crews', 'count', 'qty'] },
    activeField,
  ],
  async validate(ctx, rows) {
    const fac = await facilityLookup(ctx);
    const assets = new Map((await many(ctx.tx, 'SELECT id, facility_id, lower(asset_tag) AS tag FROM asset')).map((a) => [`${a.facility_id}:${a.tag}`, a.id as string]));
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const f = resolveFacility(ctx, row, fac);
      if (!f) continue;
      v._facility_id = f.id;
      const key = `${f.id}:${String(v.code ?? '').toLowerCase()}`;
      if (seen.has(key)) row.messages.push({ level: 'error', field: 'code', message: `duplicate work center "${v.code}" (first seen on row ${seen.get(key)})` }); else seen.set(key, row.rowNumber);
      const ids: string[] = [];
      for (const tag of String(v.machines ?? '').split(/[;,|]/).map((t) => t.trim()).filter(Boolean)) {
        const id = assets.get(`${f.id}:${tag.toLowerCase()}`);
        if (!id) row.messages.push({ level: 'error', field: 'machines', message: `machine "${tag}" not found at this site; import equipment first` }); else ids.push(id);
      }
      v._asset_ids = v.machines != null ? ids : undefined;
      const cur = await one(ctx.tx, 'SELECT id FROM work_center WHERE facility_id = $1 AND lower(code) = lower($2)', [f.id, v.code]);
      row.action = cur ? 'update' : 'create';
      if (ctx.mode === 'create_only' && cur) row.messages.push({ level: 'error', field: 'code', message: 'work center already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !cur) row.messages.push({ level: 'error', field: 'code', message: 'work center not found (mode is update only)' });
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id, active FROM work_center WHERE facility_id = $1 AND lower(code) = lower($2)', [v._facility_id, v.code]);
    const w = await saveWorkCenter(ctx.tx, ctx.actor, { id: cur?.id, facilityId: v._facility_id as string, code: String(v.code), name: String(v.name),
      active: (v.active as boolean | null) ?? undefined, assetIds: v._asset_ids as string[] | undefined });
    if (v.hours_per_week != null || v.units != null) {
      await saveWorkCenterCalendar(ctx.tx, ctx.actor, w.id, { hoursPerWeek: (v.hours_per_week as number) ?? null, units: (v.units as number) ?? null });
    }
    return { entityId: w.id, action: cur ? 'update' : 'create' };
  },
};

const TYPE_WORDS: Record<AccountType, string[]> = {
  asset: ['asset', 'assets', 'current asset', 'fixed asset', 'bank', 'cash', 'receivable', 'accounts receivable', 'inventory', 'other asset', 'ar', 'a'],
  liability: ['liability', 'liabilities', 'current liability', 'long term liability', 'payable', 'accounts payable', 'credit card', 'loan', 'other liability', 'ap', 'l'],
  equity: ['equity', 'capital', 'retained earnings', 'owner equity', 'owners equity', 'e'],
  income: ['income', 'revenue', 'sales', 'other income', 'i', 'r'],
  expense: ['expense', 'expenses', 'cost of goods sold', 'cogs', 'cost of sales', 'other expense', 'overhead', 'x'],
};
function subtypeFor(type: AccountType, name: string, given?: string | null): string {
  const g = given?.toLowerCase().replace(/[\s-]+/g, '_');
  if (g && SUBTYPES[type].includes(g)) return g;
  const n = name.toLowerCase();
  if (type === 'asset') return /\b(bank|checking|savings|cash|petty)\b/.test(n) ? 'bank' : /receivable/.test(n) ? 'accounts_receivable' : /inventory|stock/.test(n) ? 'inventory'
    : /equipment|vehicle|building|furniture|machinery|fixed|accumulated|land/.test(n) ? 'fixed_asset' : 'current_asset';
  if (type === 'liability') return /card/.test(n) ? 'credit_card' : /payable/.test(n) ? 'accounts_payable' : /loan|mortgage|note|long/.test(n) ? 'long_term_liability' : 'current_liability';
  if (type === 'equity') return /retained/.test(n) ? 'retained_earnings' : 'equity';
  if (type === 'income') return /other|interest|gain/.test(n) ? 'other_income' : 'income';
  return /cost of|cogs|materials|direct labor|freight in/.test(n) ? 'cost_of_goods' : /other|interest|loss/.test(n) ? 'other_expense' : 'expense';
}

/** Chart of accounts for the built-in books. Matched by account number; the books must be set up first. */
export const chartOfAccountsTarget: TargetDefinition = {
  key: 'chart_of_accounts', label: 'Chart of accounts', entityType: 'ledger_account', naturalKey: 'code', commitPermission: 'books.manage', supportsCustomFields: false,
  description: 'Account number, name and type from the accounting system. Adds to the starter chart; accounts that already have entries keep their type. Set the books up first (Books → Settings).',
  fields: [
    { key: 'code', label: 'Account number', type: 'string', required: true, maxLength: 20, synonyms: ['account number', 'account no', 'acct no', 'acct #', 'number', 'code', 'account code', 'gl account', 'gl code', 'account', 'acct'] },
    { key: 'name', label: 'Account name', type: 'string', required: true, maxLength: 120, synonyms: ['account name', 'name', 'description', 'title', 'account description', 'acct name'] },
    { key: 'type', label: 'Type', type: 'enum', required: true, values: Object.keys(TYPE_WORDS), valueSynonyms: TYPE_WORDS, synonyms: ['type', 'account type', 'class', 'category', 'classification', 'acct type'] },
    { key: 'subtype', label: 'Detail type', type: 'string', description: 'Optional: bank, accounts receivable, inventory, fixed asset, credit card, accounts payable, cost of goods and so on. Worked out from the name when blank.',
      synonyms: ['detail type', 'subtype', 'sub type', 'subcategory', 'sub-type', 'account subtype'] },
    { key: 'bank_last4', label: 'Account last four digits', type: 'string', maxLength: 4, synonyms: ['last4', 'last 4', 'last four', 'account last 4'] },
    activeField,
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'account number');
    if (!(await one(ctx.tx, 'SELECT 1 FROM books_settings'))) for (const row of rows) row.messages.push({ level: 'error', message: 'set the books up first (Books → Settings); the chart is added to the starter chart' });
    const existing = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS c, system, type FROM ledger_account')).map((a) => [a.c as string, a]));
    for (const row of rows) {
      const v = row.values;
      const cur = existing.get(String(v.code ?? '').toLowerCase());
      if (v.type) v.subtype = subtypeFor(v.type as AccountType, String(v.name ?? ''), v.subtype as string | null);
      row.action = cur ? 'update' : 'create';
      if (cur?.system && v.type && v.type !== cur.type) row.messages.push({ level: 'error', field: 'type', message: `${v.code} is a system account and keeps its type` });
      if (cur?.system && v.active === false) row.messages.push({ level: 'error', field: 'active', message: `${v.code} is a system account and stays active` });
      if (ctx.mode === 'create_only' && cur) row.messages.push({ level: 'error', field: 'code', message: 'account already exists (mode is create only)' });
      if (ctx.mode === 'update_only' && !cur) row.messages.push({ level: 'error', field: 'code', message: 'account not found (mode is update only)' });
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id, bank_last4, active FROM ledger_account WHERE lower(code) = lower($1)', [v.code]);
    await saveAccount(ctx.tx, ctx.actor, { id: cur?.id, code: String(v.code), name: String(v.name), type: v.type as AccountType, subtype: String(v.subtype),
      active: (v.active as boolean | null) ?? cur?.active ?? true, bankLast4: (v.bank_last4 as string) ?? cur?.bank_last4 ?? null });
    const id = cur?.id ?? (await one(ctx.tx, 'SELECT id FROM ledger_account WHERE lower(code) = lower($1)', [v.code]))!.id;
    return { entityId: id, action: cur ? 'update' : 'create' };
  },
};
