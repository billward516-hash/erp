import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { notFound } from '../../platform/errors.js';

/**
 * Repair or replace (docs/ARCHITECTURE.md §12s, D-125). `repairOrReplace` is pure and deterministic; the service below gathers its inputs.
 *
 * Keeping: the yearly cost of maintaining the asset (labor, parts, contractors) plus its unplanned downtime priced at
 * its cost per hour, fitted with a straight line over the years recorded (the trend is never allowed below the
 * average of the last two years: an asset does not get cheaper to keep as it ages). Replacing: the equivalent annual
 * cost of a new one, the replacement cost spread over its expected life at the discount rate (capital recovery
 * factor) plus the upkeep of a new unit. Replace when the cost of keeping it next year exceeds that; otherwise keep, and
 * look again in the first year the trend crosses it.
 */
export interface YearCost { year: number; maintenance: number; downtimeHours: number }
export interface LifecycleInput {
  today: string; commissionedOn: string | null; replacementCost: number | null; expectedLifeYears: number | null; downtimeCostPerHour: number | null;
  years: YearCost[]; discountRate: number; newAssetUpkeep?: number | null;
}

const r0 = (n: number) => Math.round(n);
/** Capital recovery factor: the level yearly payment that repays 1 over n years at rate r. */
export const crf = (r: number, n: number) => (r === 0 ? 1 / n : (r * (1 + r) ** n) / ((1 + r) ** n - 1));

export function repairOrReplace(input: LifecycleInput) {
  const notes: string[] = [];
  const thisYear = Number(input.today.slice(0, 4));
  // Only whole years count: the current year is partial.
  const years = input.years.filter((y) => y.year < thisYear).sort((a, b) => a.year - b.year);
  const dtRate = input.downtimeCostPerHour;
  if (dtRate == null) notes.push('No downtime cost per hour on the asset: downtime is shown but not priced');
  const rows = years.map((y) => ({ ...y, downtimeCost: dtRate == null ? 0 : r0(y.downtimeHours * dtRate), total: r0(y.maintenance + (dtRate == null ? 0 : y.downtimeHours * dtRate)) }));
  const age = input.commissionedOn ? Math.max(0, (Date.parse(input.today) - Date.parse(input.commissionedOn)) / (365.25 * 86_400_000)) : null;
  if (input.replacementCost == null) return { rows, age, verdict: 'unknown' as const, reason: 'Enter the replacement cost to compare keeping with replacing', notes };
  if (rows.length < 2) return { rows, age, verdict: 'unknown' as const, reason: `${rows.length} full year${rows.length === 1 ? '' : 's'} of cost history; at least 2 are needed`, notes };
  const life = input.expectedLifeYears ?? 15;
  if (input.expectedLifeYears == null) notes.push('No expected life on the asset: 15 years assumed for a new one');
  // Least-squares line through (year, total).
  const n = rows.length; const xs = rows.map((r) => r.year); const ys = rows.map((r) => r.total);
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((t, x) => t + (x - mx) ** 2, 0);
  const slope = sxx ? xs.reduce((t, x, i) => t + (x - mx) * (ys[i]! - my), 0) / sxx : 0;
  const floor = (ys[n - 1]! + ys[n - 2]!) / 2;
  const keepIn = (year: number) => Math.max(floor, my + slope * (year - mx));
  const upkeep = input.newAssetUpkeep ?? input.replacementCost * 0.02;
  if (input.newAssetUpkeep == null) notes.push('Upkeep of a new unit assumed at 2% of the replacement cost a year');
  const replaceEac = r0(input.replacementCost * crf(input.discountRate, life) + upkeep);
  const keepNext = r0(keepIn(thisYear));
  let crossover: number | null = null;
  for (let y = thisYear; y <= thisYear + 10; y++) if (keepIn(y) > replaceEac) { crossover = y; break; }
  const verdict = keepNext > replaceEac ? ('replace' as const) : ('keep' as const);
  const reason = verdict === 'replace'
    ? `Keeping it is expected to cost ${keepNext.toLocaleString('en-US')} this year, more than the ${replaceEac.toLocaleString('en-US')} a year a new one costs`
    : crossover ? `Keep: ${keepNext.toLocaleString('en-US')} this year against ${replaceEac.toLocaleString('en-US')} a year for a new one; on the current trend replacing pays from ${crossover}`
      : `Keep: ${keepNext.toLocaleString('en-US')} this year against ${replaceEac.toLocaleString('en-US')} a year for a new one, and the trend does not cross it within 10 years`;
  if (n < 3) notes.push('Only two full years of history: the trend is a straight line through two points');
  if (age != null && age > life) notes.push(`The asset is ${(Math.round(age * 10) / 10).toFixed(1)} years old, past the ${life}-year expected life of a new one`);
  return { rows, age: age == null ? null : Math.round(age * 10) / 10, verdict, reason, keepNext, replaceEac, crossover, slope: r0(slope), life, upkeep: r0(upkeep), discountRate: input.discountRate, notes };
}
export type Lifecycle = ReturnType<typeof repairOrReplace>;

// ---------------------------------------------------------------------------
// Gathering the history (service side)
// ---------------------------------------------------------------------------

export const DEFAULT_LABOR_RATE = 45;
export const DEFAULT_DISCOUNT_RATE = 0.08;

/**
 * Yearly cost of an asset and the components under it: labor (hours × the rate recorded on the entry, else the default
 * rate, stated), parts used at their cost, contractor invoices on its work orders, costs of work orders brought over from
 * the previous system, and hours of unplanned downtime (by the year the stop started). Completed work only.
 */
export async function assetCostHistory(tx: Tx, assetId: string, laborRate = DEFAULT_LABOR_RATE) {
  const rows = await many(tx, `WITH RECURSIVE tree AS (SELECT id FROM asset WHERE id = $1 UNION ALL SELECT a.id FROM asset a JOIN tree t ON a.parent_asset_id = t.id),
    wo AS (SELECT w.id, extract(year FROM coalesce(w.completed_at, w.created_at))::int AS yr, coalesce(w.legacy_cost, 0) AS legacy FROM work_order w
      WHERE w.asset_id IN (SELECT id FROM tree) AND w.status IN ('completed', 'verified', 'closed')),
    labor AS (SELECT wo.yr, sum(l.hours * coalesce(l.hourly_rate, $2))::float AS cost, count(*) FILTER (WHERE l.hourly_rate IS NULL)::int AS unrated FROM wo JOIN work_order_labor l ON l.work_order_id = wo.id GROUP BY 1),
    parts AS (SELECT wo.yr, sum(p.qty_used * coalesce(p.unit_cost, 0))::float AS cost FROM wo JOIN work_order_part p ON p.work_order_id = wo.id GROUP BY 1),
    vendors AS (SELECT wo.yr, sum(il.qty * il.unit_price)::float AS cost FROM wo JOIN supplier_invoice i ON i.work_order_id = wo.id AND i.status NOT IN ('void', 'disputed')
      JOIN supplier_invoice_line il ON il.invoice_id = i.id GROUP BY 1),
    legacy AS (SELECT yr, sum(legacy)::float AS cost FROM wo GROUP BY 1),
    down AS (SELECT extract(year FROM e.started_at)::int AS yr, sum(extract(epoch FROM coalesce(e.ended_at, now()) - e.started_at) / 3600)::float AS hours
      FROM asset_state_event e WHERE e.asset_id IN (SELECT id FROM tree) AND e.state = 'unplanned_downtime' GROUP BY 1),
    yrs AS (SELECT yr FROM labor UNION SELECT yr FROM parts UNION SELECT yr FROM vendors UNION SELECT yr FROM legacy WHERE cost > 0 UNION SELECT yr FROM down)
    SELECT y.yr AS year, coalesce(l.cost, 0) AS labor, coalesce(l.unrated, 0) AS unrated, coalesce(p.cost, 0) AS parts, coalesce(v.cost, 0) AS vendors, coalesce(g.cost, 0) AS legacy, coalesce(d.hours, 0) AS downtime_hours
    FROM yrs y LEFT JOIN labor l ON l.yr = y.yr LEFT JOIN parts p ON p.yr = y.yr LEFT JOIN vendors v ON v.yr = y.yr LEFT JOIN legacy g ON g.yr = y.yr LEFT JOIN down d ON d.yr = y.yr ORDER BY 1`, [assetId, laborRate]);
  return rows.map((r) => ({ year: r.year as number, labor: Math.round(r.labor), parts: Math.round(r.parts), vendors: Math.round(r.vendors), legacy: Math.round(r.legacy), unrated: r.unrated as number,
    maintenance: Math.round(r.labor + r.parts + r.vendors + r.legacy), downtimeHours: Math.round(r.downtime_hours * 10) / 10 }));
}

export async function assetLifecycle(tx: Tx, actor: Actor, assetId: string, q: { discountRate?: number; laborRate?: number; today?: string } = {}) {
  const a = await one(tx, 'SELECT id, facility_id, asset_tag, name, commissioned_on, replacement_cost, expected_life_years, downtime_cost_per_hour FROM asset WHERE id = $1', [assetId]);
  if (!a) throw notFound('asset');
  requirePermission(actor, 'assets.view', a.facility_id);
  const laborRate = q.laborRate ?? DEFAULT_LABOR_RATE;
  const history = await assetCostHistory(tx, assetId, laborRate);
  const result = repairOrReplace({ today: q.today ?? new Date().toISOString().slice(0, 10), commissionedOn: a.commissioned_on ? new Date(a.commissioned_on).toISOString().slice(0, 10) : null,
    replacementCost: a.replacement_cost == null ? null : Number(a.replacement_cost), expectedLifeYears: a.expected_life_years, downtimeCostPerHour: a.downtime_cost_per_hour == null ? null : Number(a.downtime_cost_per_hour),
    years: history, discountRate: q.discountRate ?? DEFAULT_DISCOUNT_RATE });
  const notes = [...result.notes];
  if (history.some((h) => h.unrated)) notes.push(`Labor without a recorded rate is costed at ${laborRate} an hour`);
  return { asset: { id: a.id, tag: a.asset_tag, name: a.name }, history, ...result, notes, laborRate };
}
