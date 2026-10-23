import { many } from '../../../platform/db/tx.js';
import { draftForecast, setForecastLines } from '../../planning/service.js';
import type { TargetDefinition } from './types.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Month headers as customers write them: 2026-11, 2026-11-15, 11/2026, 11/15/2026, Nov-26, Nov 2026, November 2026. */
export function parseMonth(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${pad(Number(m[2]))}`;
  m = /^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4}|\d{2})$/.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${year(m[2]!)}-${pad(Number(m[1]))}`;
  m = /^([a-z]{3})[a-z]*[\s\-'.]*(\d{4}|\d{2})$/.exec(s);
  if (m && MONTHS.includes(m[1]!)) return `${year(m[2]!)}-${pad(MONTHS.indexOf(m[1]!) + 1)}`;
  return null;
}

/**
 * Customer forecasts as customers send them: usually one row per part with a column per month (unpivot in the
 * profile), sometimes one row per part and month. Rows land in each customer's draft version at the batch's site;
 * a planner reviews the change from the version in force and activates it.
 */
export const customerForecastsTarget: TargetDefinition = {
  key: 'customer_forecasts',
  label: 'Customer forecasts',
  entityType: 'customer_forecast',
  description: 'Quantities per customer, part and month into the customer\'s draft forecast at the chosen site. Activate the draft after reviewing it.',
  naturalKey: 'part_number',
  commitPermission: 'planning.manage',
  supportsCustomFields: false,
  fields: [
    { key: 'customer_code', label: 'Customer code', type: 'string', required: true, synonyms: ['customer', 'customer code', 'customer number', 'account', 'ship to', 'sold to'] },
    { key: 'part_number', label: 'Our part number', type: 'string', required: true, synonyms: ['part', 'part number', 'item', 'our part', 'supplier part', 'vendor part', 'material'] },
    { key: 'month', label: 'Month', type: 'string', required: true, description: '2026-11, 2026-11-15, 11/2026, Nov-26, Nov 2026 or November 2026',
      synonyms: ['month', 'period', 'due', 'date', 'delivery month'] },
    { key: 'qty', label: 'Quantity', type: 'number', required: true, min: 0, synonyms: ['qty', 'quantity', 'forecast', 'demand', 'units', 'volume'] },
  ],
  async validate(ctx, rows) {
    if (!ctx.facilityId) for (const r of rows) r.messages.push({ level: 'error', message: 'choose the site the forecast is for (the import\'s facility)' });
    const customers = new Map((await many(ctx.tx, 'SELECT id, lower(code) AS code, lower(name) AS name FROM customer')).flatMap((c) => [[c.code, c.id], [c.name, c.id]]));
    const parts = new Map((await many(ctx.tx, 'SELECT id, lower(part_number) AS pn FROM part')).map((p) => [p.pn, p.id]));
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row.values;
      v._customer_id = customers.get(String(v.customer_code ?? '').trim().toLowerCase());
      v._part_id = parts.get(String(v.part_number ?? '').trim().toLowerCase());
      if (!v._customer_id) row.messages.push({ level: 'error', field: 'customer_code', message: `no customer ${v.customer_code}` });
      if (!v._part_id) row.messages.push({ level: 'error', field: 'part_number', message: `no part ${v.part_number}` });
      const m = parseMonth(v.month);
      if (v.month != null && !m) row.messages.push({ level: 'error', field: 'month', message: `"${v.month}" is not a month (use 2026-11, Nov-26, 11/2026…)` });
      v.month = m;
      const k = `${v._customer_id}|${v._part_id}|${v.month}`;
      if (seen.has(k)) row.messages.push({ level: 'error', field: 'month', message: 'same customer, part and month twice in the file; combine them into one row' });
      seen.add(k);
      row.action = 'create';
    }
  },
  async commitRow(ctx, row) {
    const v = row.values;
    const f = await draftForecast(ctx.tx, ctx.actor, { facilityId: ctx.facilityId!, customerId: v._customer_id as string, source: 'import' });
    await setForecastLines(ctx.tx, ctx.actor, f.id, [{ partId: v._part_id as string, month: String(v.month), qty: v.qty as number }]);
    return { entityId: f.id, action: 'create' };
  },
};
