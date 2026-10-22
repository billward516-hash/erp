import { many, one } from '../../../platform/db/tx.js';
import { parseMonth } from './forecasts.js';
import type { TargetDefinition } from './types.js';

/**
 * Monthly spend from the previous accounting system (D-134): a GL detail or trial balance by month, often one row per
 * account with a column per month (unpivot in the profile). Each row is classified into a spend category by its
 * category column, or by the account mapping (their account number → platform account key → category). Re-importing
 * the same file updates the same rows.
 */
export const spendHistoryTarget: TargetDefinition = {
  key: 'spend_history',
  label: 'Spend history',
  entityType: 'spend_history',
  description: 'Monthly spend by account from the previous accounting system, for history analysis and budgets. Rows are classified into spend categories through the account mapping or a category column.',
  naturalKey: 'account_code',
  commitPermission: 'budgets.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'facility_code', label: 'Site', type: 'string', description: 'Site code; the import\'s site when blank', synonyms: ['site', 'plant', 'facility', 'location', 'cost center site', 'division'] },
    { key: 'department', label: 'Department', type: 'string', description: 'Department code or name (optional)', synonyms: ['department', 'dept', 'cost center', 'cost centre', 'cc'] },
    { key: 'account_code', label: 'Account', type: 'string', synonyms: ['account', 'account number', 'acct', 'gl account', 'gl', 'account no', 'account #'] },
    { key: 'account_name', label: 'Account name', type: 'string', synonyms: ['account name', 'description', 'account description', 'name'] },
    { key: 'category', label: 'Spend category', type: 'string', description: 'Spend category code or name; overrides the account mapping', synonyms: ['category', 'spend category', 'expense type', 'type'] },
    { key: 'month', label: 'Month', type: 'string', required: true, description: '2026-11, 11/2026, Nov-26, Nov 2026…', synonyms: ['month', 'period', 'posting period', 'date', 'fiscal period'] },
    { key: 'amount', label: 'Amount', type: 'number', required: true, synonyms: ['amount', 'actual', 'spend', 'net', 'debit', 'value', 'total'] },
  ],
  async validate(ctx, rows) {
    const sites = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code FROM facility')).map((f) => [f.code, f.id]));
    const depts = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM department')).flatMap((d) => [[d.code, d.id], [d.name, d.id]]));
    const cats = await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name, account_keys FROM spend_category WHERE active');
    const byCat = new Map(cats.flatMap((c) => [[c.code, c.id], [c.name, c.id]]));
    const byKey = new Map(cats.flatMap((c) => (c.account_keys as string[]).map((k) => [k, c.id])));
    const mapped = new Map((await many(ctx.tx, 'SELECT lower(external_code) AS code, account_key FROM account_mapping')).map((m) => [m.code, m.account_key]));
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      const site = v.facility_code ? sites.get(String(v.facility_code).trim().toLowerCase()) : ctx.facilityId;
      if (!site) row.messages.push({ level: 'error', field: 'facility_code', message: v.facility_code ? `no site ${v.facility_code}` : 'name the site in the file or choose one for the import' });
      v._facility_id = site;
      if (v.department) {
        v._department_id = depts.get(String(v.department).trim().toLowerCase());
        if (!v._department_id) row.messages.push({ level: 'warning', field: 'department', message: `no department ${v.department}; the spend counts for the site` });
      }
      const account = v.account_code != null ? String(v.account_code).trim() : '';
      if (v.category) {
        v._category_id = byCat.get(String(v.category).trim().toLowerCase());
        if (!v._category_id) row.messages.push({ level: 'error', field: 'category', message: `no spend category ${v.category}` });
      } else if (account) {
        const key = mapped.get(account.toLowerCase());
        v._category_id = key ? byKey.get(key) : undefined;
        if (!v._category_id) row.messages.push({ level: 'error', field: 'account_code', message: key ? `account ${account} maps to ${key}, which no spend category includes` : `account ${account} is not mapped; map it under Accounting, or add a category column` });
      } else row.messages.push({ level: 'error', field: 'account_code', message: 'each row needs an account or a spend category' });
      const m = parseMonth(v.month);
      if (v.month != null && !m) row.messages.push({ level: 'error', field: 'month', message: `"${v.month}" is not a month (use 2026-11, Nov-26, 11/2026…)` });
      v.month = m ? `${m}-01` : null;
      if (v.amount == null) row.messages.push({ level: 'error', field: 'amount', message: 'no amount' });
      v._ref = `${v.facility_code ?? ''}|${v.department ?? ''}|${account || v.category}|${m}`.toLowerCase();
      if (seen.has(String(v._ref))) row.messages.push({ level: 'error', message: 'the same site, department, account and month appear twice; combine them' });
      seen.add(String(v._ref));
    }
    for (const row of rows) {
      if (row.messages.some((x) => x.level === 'error')) continue;
      row.action = (await one(ctx.tx, 'SELECT 1 FROM spend_history WHERE source_system = $1 AND ref = $2', [ctx.sourceSystem, row.values._ref])) ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const r = await one(ctx.tx, `INSERT INTO spend_history (tenant_id, facility_id, department_id, spend_category_id, month, amount, account_code, description, source_system, ref)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, source_system, ref) DO UPDATE SET facility_id = EXCLUDED.facility_id, department_id = EXCLUDED.department_id, spend_category_id = EXCLUDED.spend_category_id,
        amount = EXCLUDED.amount, description = EXCLUDED.description RETURNING id, (xmax = 0) AS inserted`,
    [ctx.actor.tenantId, v._facility_id, v._department_id ?? null, v._category_id, v.month, v.amount, v.account_code ?? null, v.account_name ?? null, ctx.sourceSystem, v._ref]);
    return { entityId: r.id, action: r.inserted ? 'create' : 'update' };
  },
};
