import { many, one } from '../../../platform/db/tx.js';
import { createBudget, saveBudgetLine } from '../../budgets/service.js';
import { saveOpportunity, STAGE_PROBABILITY } from '../../crm/service.js';
import { createQualification } from '../../learning/qualifications.js';
import { facilityLookup, findExternalRef, flagDuplicates, resolveFacility, saveExternalRef } from './common.js';
import type { FieldDef, TargetDefinition } from './types.js';

const siteField: FieldDef = { key: 'site_code', label: 'Site code', type: 'string', synonyms: ['site', 'site code', 'plant', 'facility', 'facility code', 'location', 'division'] };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function calendarMonth(raw: unknown): number | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 12) return Number(s);
  const i = MONTHS.indexOf(s.slice(0, 3));
  return i >= 0 && /^[a-z]+\.?$/.test(s) ? i + 1 : null;
}

/** Budget amounts by site, department, spend category and month (a sheet with a column per month works with the unpivot option). */
export const budgetLinesTarget: TargetDefinition = {
  key: 'budget_lines', label: 'Budget lines', entityType: 'budget_line', naturalKey: 'category', commitPermission: 'budgets.manage', supportsCustomFields: false,
  description: 'One row per site, department, spend category and month: the budget name and year, then the amount. A sheet with a column per month loads through the "wide to long" option. The budget is created as a draft when it does not exist; approved budgets are not changed.',
  fields: [
    { key: 'budget_name', label: 'Budget name', type: 'string', required: true, synonyms: ['budget', 'budget name', 'plan', 'version', 'scenario'] },
    { key: 'fiscal_year', label: 'Fiscal year', type: 'integer', required: true, min: 2000, max: 2100, synonyms: ['fiscal year', 'year', 'fy', 'budget year'] },
    siteField,
    { key: 'department', label: 'Department', type: 'string', synonyms: ['department', 'dept', 'dept code', 'cost center', 'cost centre', 'cc'] },
    { key: 'category', label: 'Spend category', type: 'string', required: true, synonyms: ['spend category', 'category', 'account group', 'expense type', 'line', 'account'] },
    { key: 'month', label: 'Month', type: 'string', required: true, description: 'January or Jan, or 1 to 12 (calendar month)', synonyms: ['month', 'period', 'month name', 'month number'] },
    { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0, synonyms: ['amount', 'budget', 'budget amount', 'value', 'total', 'plan'] },
  ],
  async validate(ctx, rows) {
    const fac = await facilityLookup(ctx);
    const depts = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM department')).flatMap((d) => [[d.code as string, d.id as string], [d.name as string, d.id as string]]));
    const cats = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM spend_category WHERE active')).flatMap((c) => [[c.code as string, c.id as string], [c.name as string, c.id as string]]));
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const f = resolveFacility(ctx, row, fac, 'site_code'); if (f) v._facility_id = f.id;
      if (v.department) { const d = depts.get(String(v.department).trim().toLowerCase()); if (!d) row.messages.push({ level: 'error', field: 'department', message: `department "${v.department}" not found; import departments first` }); else v._department_id = d; }
      const c = cats.get(String(v.category ?? '').trim().toLowerCase());
      if (!c) row.messages.push({ level: 'error', field: 'category', message: `spend category "${v.category}" not found (Budgets → categories)` }); else v._category_id = c;
      const m = calendarMonth(v.month);
      if (!m) row.messages.push({ level: 'error', field: 'month', message: `"${v.month}" is not a month (use January, Jan, or 1 to 12)` }); else v._month = m;
      const k = `${v.budget_name}|${v.fiscal_year}|${v._facility_id}|${v._department_id ?? ''}|${v._category_id}|${m}`.toLowerCase();
      if (seen.has(k)) row.messages.push({ level: 'error', message: `the same budget cell and month are on row ${seen.get(k)}` }); else seen.set(k, row.rowNumber);
      const b = await one(ctx.tx, 'SELECT status FROM budget WHERE lower(name) = lower($1) AND fiscal_year = $2', [v.budget_name, v.fiscal_year]);
      if (b && b.status !== 'draft') row.messages.push({ level: 'error', field: 'budget_name', message: `budget "${v.budget_name}" is ${b.status}; only drafts can be loaded into` });
      row.action = 'update';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    let b = await one(ctx.tx, 'SELECT id, start_month FROM budget WHERE lower(name) = lower($1) AND fiscal_year = $2', [v.budget_name, v.fiscal_year]);
    if (!b) b = await createBudget(ctx.tx, ctx.actor, { fiscalYear: Number(v.fiscal_year), name: String(v.budget_name) });
    const idx = (Number(v._month) - Number(b!.start_month) + 12) % 12;
    const cur = await one(ctx.tx, `SELECT amounts FROM budget_line WHERE budget_id = $1 AND facility_id = $2 AND coalesce(department_id, '00000000-0000-0000-0000-000000000000') = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000') AND spend_category_id = $4`,
      [b!.id, v._facility_id, v._department_id ?? null, v._category_id]);
    const amounts: number[] = (cur?.amounts as string[] | undefined)?.map(Number) ?? Array(12).fill(0);
    amounts[idx] = Number(v.amount);
    await saveBudgetLine(ctx.tx, ctx.actor, b!.id, { facilityId: v._facility_id as string, departmentId: (v._department_id as string) ?? null, categoryId: v._category_id as string, amounts });
    return { entityId: b!.id as string, action: cur ? 'update' : 'create' };
  },
};

/** The sales pipeline: open and closed opportunities with their stage, amount and expected close. */
export const opportunitiesTarget: TargetDefinition = {
  key: 'opportunities', label: 'Sales opportunities', entityType: 'opportunity', naturalKey: 'title', commitPermission: 'crm.manage', supportsCustomFields: false,
  description: 'Your pipeline from the CRM or a spreadsheet: customer, title, stage, amount, expected close and the person who owns it. Customers must exist first. A deal that was lost needs the reason.',
  fields: [
    { key: 'external_id', label: 'Your opportunity ID', type: 'string', synonyms: ['opportunity id', 'deal id', 'id', 'record id', 'opp id', 'legacy id'] },
    { key: 'customer_code', label: 'Customer code', type: 'string', required: true, synonyms: ['customer code', 'customer', 'account', 'company', 'account name', 'customer id', 'account id'] },
    { key: 'title', label: 'Title', type: 'string', required: true, maxLength: 200, synonyms: ['title', 'opportunity', 'deal', 'deal name', 'name', 'opportunity name', 'project'] },
    { key: 'stage', label: 'Stage', type: 'enum', values: Object.keys(STAGE_PROBABILITY),
      valueSynonyms: { lead: ['lead', 'new', 'prospect', 'open', 'prospecting', 'identified'], qualified: ['qualified', 'qualification', 'discovery', 'contacted', 'meeting'], proposal: ['proposal', 'quoted', 'quote sent', 'proposal sent', 'rfq', 'bid'],
        negotiation: ['negotiation', 'negotiating', 'contract', 'verbal', 'closing', 'commit'], won: ['won', 'closed won', 'closed-won', 'awarded', 'order received', 'booked'], lost: ['lost', 'closed lost', 'closed-lost', 'declined', 'no decision', 'dead'] },
      synonyms: ['stage', 'status', 'pipeline stage', 'sales stage', 'phase'] },
    { key: 'amount', label: 'Amount', type: 'number', min: 0, synonyms: ['amount', 'value', 'deal value', 'estimated value', 'revenue', 'expected revenue', 'size'] },
    { key: 'probability', label: 'Probability %', type: 'number', min: 0, max: 100, synonyms: ['probability', 'win probability', 'chance', 'likelihood', 'prob'] },
    { key: 'expected_close', label: 'Expected close', type: 'date', synonyms: ['expected close', 'close date', 'expected close date', 'closing date', 'target date', 'due'] },
    { key: 'source', label: 'Source', type: 'string', synonyms: ['source', 'lead source', 'origin', 'channel'] },
    { key: 'owner_email', label: 'Owner (work email)', type: 'string', synonyms: ['owner', 'owner email', 'sales rep', 'rep email', 'assigned to', 'account owner'] },
    { key: 'lost_reason', label: 'Reason lost', type: 'string', synonyms: ['lost reason', 'reason lost', 'loss reason', 'reason', 'closed lost reason'] },
  ],
  async validate(ctx, rows) {
    const customers = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM customer')).flatMap((c) => [[c.code as string, c.id as string], [c.name as string, c.id as string]]));
    const users = new Map((await many(ctx.tx, 'SELECT id, lower(email) AS email FROM app_user')).map((u) => [u.email as string, u.id as string]));
    flagDuplicates(rows, 'external_id', 'opportunity ID');
    for (const row of rows) {
      const v = row.values;
      const c = customers.get(String(v.customer_code ?? '').trim().toLowerCase());
      if (!c) row.messages.push({ level: 'error', field: 'customer_code', message: `customer "${v.customer_code}" not found; import customers first` }); else v._customer_id = c;
      v.stage ??= 'lead';
      if (v.stage === 'lost' && !String(v.lost_reason ?? '').trim()) row.messages.push({ level: 'error', field: 'lost_reason', message: 'say why the opportunity was lost' });
      if (v.owner_email) { const u = users.get(String(v.owner_email).trim().toLowerCase()); if (!u) row.messages.push({ level: 'warning', field: 'owner_email', message: `${v.owner_email} is not a user here; you become the owner` }); else v._owner_id = u; }
      row.action = (await findExternalRef(ctx, 'opportunity', v.external_id)) ? 'update' : 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const id = await findExternalRef(ctx, 'opportunity', v.external_id);
    const o = await saveOpportunity(ctx.tx, ctx.actor, { id: id ?? undefined, customerId: v._customer_id as string, title: String(v.title), stage: v.stage as string, amount: (v.amount as number) ?? null,
      probability: (v.probability as number) ?? null, expectedClose: (v.expected_close as string) ?? null, source: (v.source as string) ?? null, ownerUserId: (v._owner_id as string) ?? null, lostReason: (v.lost_reason as string) ?? null });
    await saveExternalRef(ctx, 'opportunity', v.external_id, o.id);
    return { entityId: o.id as string, action: id ? 'update' : 'create' };
  },
};

/** The qualifications a company recognises, before anyone's records are loaded. Matched by code. */
export const qualificationsTarget: TargetDefinition = {
  key: 'qualifications', label: 'Qualifications (definitions)', entityType: 'qualification', naturalKey: 'code', commitPermission: 'learning.manage', supportsCustomFields: false,
  description: 'The skills and certificates you track: code, name, how long each stays valid, and whether it is safety critical or needs a practical sign-off. Load these before qualification records.',
  fields: [
    { key: 'code', label: 'Code', type: 'string', required: true, maxLength: 30, synonyms: ['code', 'qualification code', 'cert code', 'skill code', 'id', 'qualification id'] },
    { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 120, synonyms: ['name', 'qualification', 'qualification name', 'certification', 'skill', 'competency', 'title'] },
    { key: 'description', label: 'Description', type: 'text', synonyms: ['description', 'details', 'what it covers'] },
    { key: 'validity_months', label: 'Valid for (months)', type: 'integer', min: 1, max: 240, synonyms: ['valid for', 'validity', 'validity months', 'months valid', 'expires after', 'recert months', 'renewal months', 'recertification'] },
    { key: 'safety_critical', label: 'Safety critical', type: 'boolean', synonyms: ['safety critical', 'safety', 'critical'], valueSynonyms: { true: ['yes', 'y', 'true', 'x', '1'], false: ['no', 'n', 'false', '0'] } },
    { key: 'requires_practical', label: 'Needs practical sign-off', type: 'boolean', synonyms: ['practical', 'requires practical', 'needs practical', 'hands on', 'ojt'], valueSynonyms: { true: ['yes', 'y', 'true', 'x', '1'], false: ['no', 'n', 'false', '0'] } },
  ],
  async validate(ctx, rows) {
    flagDuplicates(rows, 'code', 'qualification code');
    const have = new Set((await many(ctx.tx, 'SELECT lower(code) AS c FROM qualification')).map((q) => q.c as string));
    for (const row of rows) { row.action = have.has(String(row.values.code ?? '').toLowerCase()) ? 'unchanged' : 'create'; if (row.action === 'unchanged') row.messages.push({ level: 'warning', message: 'already defined; left as it is' }); }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const cur = await one(ctx.tx, 'SELECT id FROM qualification WHERE lower(code) = lower($1)', [v.code]);
    if (cur) return { entityId: cur.id as string, action: 'unchanged' };
    const q = await createQualification(ctx.tx, ctx.actor, { code: String(v.code), name: String(v.name), description: (v.description as string) ?? null, validityMonths: (v.validity_months as number) ?? null,
      safetyCritical: (v.safety_critical as boolean) ?? false, requiresPractical: (v.requires_practical as boolean) ?? false });
    return { entityId: q.id as string, action: 'create' };
  },
};
