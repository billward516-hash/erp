import type { Actor } from '../../platform/auth/actor.js';
import { requirePermission } from '../../platform/auth/actor.js';
import { audit } from '../../platform/audit/audit.js';
import type { Tx } from '../../platform/db/tx.js';
import { many, one } from '../../platform/db/tx.js';
import { conflict, invalid, notFound } from '../../platform/errors.js';
import { computeUtilization } from '../assets/utilization.js';
import { availableAtSite } from '../materials/service.js';
import type { Item, PlanInput, Scenario } from './engine.js';
import { computePlan } from './engine.js';

const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const monthOf = (d: any) => iso(d)?.slice(0, 7) ?? null;
const today = () => new Date().toISOString().slice(0, 10);
export const horizonMonths = (n: number, from = today()) => {
  const y = Number(from.slice(0, 4)); const m = Number(from.slice(5, 7)) - 1;
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m + i, 1)).toISOString().slice(0, 7));
};

// ---------------------------------------------------------------------------
// Customer forecasts (versioned; firm orders consume them in the plan)
// ---------------------------------------------------------------------------

/** The customer's draft forecast at the site, created as the next version when there is none. */
export async function draftForecast(tx: Tx, actor: Actor, input: { facilityId: string; customerId: string; notes?: string | null; source?: 'manual' | 'import' }) {
  requirePermission(actor, 'planning.manage', input.facilityId);
  const existing = await one(tx, `SELECT * FROM customer_forecast WHERE facility_id = $1 AND customer_id = $2 AND status = 'draft'`, [input.facilityId, input.customerId]);
  if (existing) return existing;
  if (!(await one(tx, 'SELECT 1 FROM customer WHERE id = $1', [input.customerId]))) throw notFound('customer');
  const v = await one(tx, 'SELECT coalesce(max(version), 0) + 1 AS v FROM customer_forecast WHERE facility_id = $1 AND customer_id = $2', [input.facilityId, input.customerId]);
  const f = await one(tx, `INSERT INTO customer_forecast (tenant_id, facility_id, customer_id, version, notes, source, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.tenantId, input.facilityId, input.customerId, v.v, input.notes ?? null, input.source ?? 'manual', actor.userId]);
  await audit(tx, actor, { action: 'planning.forecast_drafted', entityType: 'customer_forecast', entityId: f.id, facilityId: input.facilityId, data: { version: v.v } });
  return f;
}

/** Sets quantities on a draft forecast (one per part and month; 0 clears the month). */
export async function setForecastLines(tx: Tx, actor: Actor, forecastId: string, lines: { partId: string; month: string; qty: number }[]) {
  const f = await one(tx, 'SELECT * FROM customer_forecast WHERE id = $1', [forecastId]);
  if (!f) throw notFound('forecast');
  requirePermission(actor, 'planning.manage', f.facility_id);
  if (f.status !== 'draft') throw conflict('only a draft forecast can change; load a new version');
  for (const l of lines) {
    if (!/^\d{4}-\d{2}$/.test(l.month)) throw invalid(`month ${l.month}: use YYYY-MM`);
    if (!(l.qty >= 0)) throw invalid('quantities cannot be negative');
    if (l.qty === 0) await tx.query('DELETE FROM customer_forecast_line WHERE forecast_id = $1 AND part_id = $2 AND period = $3', [forecastId, l.partId, `${l.month}-01`]);
    else await tx.query(`INSERT INTO customer_forecast_line (tenant_id, forecast_id, part_id, period, qty) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (forecast_id, part_id, period) DO UPDATE SET qty = EXCLUDED.qty`, [actor.tenantId, forecastId, l.partId, `${l.month}-01`, l.qty]);
  }
}

/** The draft becomes the customer's forecast in force; the previous version is kept, superseded. */
export async function activateForecast(tx: Tx, actor: Actor, forecastId: string) {
  const f = await one(tx, 'SELECT * FROM customer_forecast WHERE id = $1 FOR UPDATE', [forecastId]);
  if (!f) throw notFound('forecast');
  requirePermission(actor, 'planning.manage', f.facility_id);
  if (f.status !== 'draft') throw conflict(`forecast is ${f.status}`);
  if (!(await one(tx, 'SELECT 1 FROM customer_forecast_line WHERE forecast_id = $1', [forecastId]))) throw invalid('the forecast has no quantities');
  await tx.query(`UPDATE customer_forecast SET status = 'superseded' WHERE facility_id = $1 AND customer_id = $2 AND status = 'active'`, [f.facility_id, f.customer_id]);
  await tx.query(`UPDATE customer_forecast SET status = 'active', activated_at = now() WHERE id = $1`, [forecastId]);
  await audit(tx, actor, { action: 'planning.forecast_activated', entityType: 'customer_forecast', entityId: forecastId, facilityId: f.facility_id, data: { version: f.version } });
}

export async function listForecasts(tx: Tx, actor: Actor, q: { facilityId?: string } = {}) {
  requirePermission(actor, 'planning.view', q.facilityId);
  return many(tx, `SELECT f.id, f.facility_id, fc.code AS facility_code, f.customer_id, c.name AS customer, f.version, f.status, f.received_on, f.source, f.activated_at,
      (SELECT coalesce(sum(qty), 0)::float FROM customer_forecast_line l WHERE l.forecast_id = f.id) AS total,
      (SELECT min(period) FROM customer_forecast_line l WHERE l.forecast_id = f.id) AS first_month, (SELECT max(period) FROM customer_forecast_line l WHERE l.forecast_id = f.id) AS last_month
    FROM customer_forecast f JOIN customer c ON c.id = f.customer_id JOIN facility fc ON fc.id = f.facility_id
    WHERE ($1::uuid IS NULL OR f.facility_id = $1) ORDER BY c.name, f.version DESC`, [q.facilityId ?? null]);
}

/**
 * A forecast version by part and month, with the change from the version in force before it and the firm orders
 * already received for the same customer, part and month (forecast vs firm reconciliation).
 */
export async function getForecast(tx: Tx, actor: Actor, id: string) {
  const f = await one(tx, `SELECT f.*, c.name AS customer, fc.code AS facility_code FROM customer_forecast f JOIN customer c ON c.id = f.customer_id JOIN facility fc ON fc.id = f.facility_id WHERE f.id = $1`, [id]);
  if (!f) throw notFound('forecast');
  requirePermission(actor, 'planning.view', f.facility_id);
  const prev = await one(tx, `SELECT id, version FROM customer_forecast WHERE facility_id = $1 AND customer_id = $2 AND version < $3 AND status IN ('active', 'superseded') ORDER BY version DESC LIMIT 1`,
    [f.facility_id, f.customer_id, f.version]);
  const lines = await many(tx, `SELECT l.part_id, p.part_number, p.description, to_char(l.period, 'YYYY-MM') AS month, l.qty::float AS qty FROM customer_forecast_line l JOIN part p ON p.id = l.part_id
    WHERE l.forecast_id = $1 ORDER BY p.part_number, l.period`, [id]);
  const before = prev ? await many(tx, `SELECT part_id, to_char(period, 'YYYY-MM') AS month, qty::float AS qty FROM customer_forecast_line WHERE forecast_id = $1`, [prev.id]) : [];
  const firm = await many(tx, `SELECT it.part_id, to_char(coalesce(o.promised_date, o.requested_date, o.created_at::date), 'YYYY-MM') AS month, sum(l.qty - l.qty_shipped)::float AS qty
    FROM sales_order_line l JOIN sales_order o ON o.id = l.order_id JOIN sales_item it ON it.id = l.item_id
    WHERE o.customer_id = $1 AND o.facility_id = $2 AND o.status IN ('open', 'partially_shipped') AND l.qty > l.qty_shipped AND it.part_id IS NOT NULL GROUP BY 1, 2`, [f.customer_id, f.facility_id]);
  const key = (p: string, m: string) => `${p}|${m}`;
  const b = new Map(before.map((x) => [key(x.part_id, x.month), x.qty]));
  const fm = new Map(firm.map((x) => [key(x.part_id, x.month), x.qty]));
  const months = [...new Set([...lines.map((l) => l.month), ...before.map((l) => l.month)])].sort();
  const parts = [...new Map(lines.map((l) => [l.part_id, { partId: l.part_id, partNumber: l.part_number, description: l.description }])).values()];
  return { ...f, previousVersion: prev?.version ?? null, months,
    rows: parts.map((p) => ({ ...p, cells: months.map((m) => {
      const qty = lines.find((l) => l.part_id === p.partId && l.month === m)?.qty ?? 0;
      const was = prev ? b.get(key(p.partId, m)) ?? 0 : null;
      const firmQty = fm.get(key(p.partId, m)) ?? 0;
      return { month: m, qty, was, change: was == null ? null : qty - was, firm: firmQty, firmOver: firmQty > qty };
    }) })),
    total: lines.reduce((s, l) => s + l.qty, 0), previousTotal: prev ? before.reduce((s, l) => s + l.qty, 0) : null };
}

// ---------------------------------------------------------------------------
// Work-center calendars and scenarios
// ---------------------------------------------------------------------------

export async function saveWorkCenterCalendar(tx: Tx, actor: Actor, workCenterId: string, input: { hoursPerWeek: number | null; units: number | null }) {
  const w = await one(tx, 'SELECT * FROM work_center WHERE id = $1', [workCenterId]);
  if (!w) throw notFound('work center');
  requirePermission(actor, 'planning.manage', w.facility_id);
  if (input.hoursPerWeek != null && !(input.hoursPerWeek > 0 && input.hoursPerWeek <= 168)) throw invalid('hours per week must be between 0 and 168');
  await tx.query('UPDATE work_center SET hours_per_week = $2, units = $3 WHERE id = $1', [workCenterId, input.hoursPerWeek, input.units]);
  await audit(tx, actor, { action: 'planning.calendar_saved', entityType: 'work_center', entityId: workCenterId, facilityId: w.facility_id, data: input });
}

export async function saveScenario(tx: Tx, actor: Actor, input: { id?: string; facilityId: string; name: string; demandPct?: number; adjustments?: Scenario['adjustments']; notes?: string | null }) {
  requirePermission(actor, 'planning.manage', input.facilityId);
  if (!input.name?.trim()) throw invalid('name the scenario (e.g. "Second shift on lathes")');
  const wcs = new Set((await many(tx, 'SELECT id FROM work_center WHERE facility_id = $1', [input.facilityId])).map((w) => w.id));
  for (const a of input.adjustments ?? []) {
    if (!wcs.has(a.workCenterId)) throw invalid('a scenario adjustment names a work center at another site');
    if ((a.extraHoursPerWeek ?? 0) < -168 || (a.extraUnits ?? 0) < -50) throw invalid('adjustments out of range');
  }
  const vals = [input.name.trim(), input.demandPct ?? 0, JSON.stringify(input.adjustments ?? []), input.notes ?? null];
  const s = input.id
    ? await one(tx, 'UPDATE planning_scenario SET name = $2, demand_pct = $3, adjustments = $4, notes = $5 WHERE id = $1 RETURNING *', [input.id, ...vals])
    : await one(tx, 'INSERT INTO planning_scenario (tenant_id, facility_id, name, demand_pct, adjustments, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [actor.tenantId, input.facilityId, ...vals, actor.userId]);
  if (!s) throw notFound('scenario');
  await audit(tx, actor, { action: 'planning.scenario_saved', entityType: 'planning_scenario', entityId: s.id, facilityId: input.facilityId, data: { name: s.name, demandPct: input.demandPct ?? 0, adjustments: input.adjustments ?? [] } });
  return s;
}

export async function listScenarios(tx: Tx, actor: Actor, facilityId: string) {
  requirePermission(actor, 'planning.view', facilityId);
  return many(tx, `SELECT s.id, s.name, s.demand_pct::float AS demand_pct, s.adjustments, s.notes, s.created_at, u.display_name AS created_by
    FROM planning_scenario s JOIN app_user u ON u.id = s.created_by WHERE s.facility_id = $1 ORDER BY s.created_at`, [facilityId]);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Gathers the engine's inputs for one site: demand, the part tree through released revisions, supply and capacity. */
export async function planInput(tx: Tx, facilityId: string, horizon: number, asOf = today()): Promise<PlanInput> {
  const months = horizonMonths(horizon, asOf);
  // Demand: forecasts in force, and open firm orders (by promised, requested or order date).
  const fc = await many(tx, `SELECT f.customer_id, c.name AS customer, l.part_id, to_char(l.period, 'YYYY-MM') AS month, l.qty::float AS qty
    FROM customer_forecast f JOIN customer_forecast_line l ON l.forecast_id = f.id JOIN customer c ON c.id = f.customer_id WHERE f.facility_id = $1 AND f.status = 'active'`, [facilityId]);
  const firm = await many(tx, `SELECT o.customer_id, c.name AS customer, it.part_id, to_char(coalesce(o.promised_date, o.requested_date, o.created_at::date), 'YYYY-MM') AS month, sum(l.qty - l.qty_shipped)::float AS qty
    FROM sales_order_line l JOIN sales_order o ON o.id = l.order_id JOIN sales_item it ON it.id = l.item_id JOIN customer c ON c.id = o.customer_id
    WHERE o.facility_id = $1 AND o.status IN ('open', 'partially_shipped') AND l.qty > l.qty_shipped AND it.part_id IS NOT NULL GROUP BY 1, 2, 3, 4`, [facilityId]);
  const dm = new Map<string, { partId: string; customerId: string; customer: string; month: string; forecast: number; firm: number }>();
  for (const r of [...fc.map((x) => ({ ...x, kind: 'forecast' })), ...firm.map((x) => ({ ...x, kind: 'firm' }))]) {
    const k = `${r.part_id}|${r.customer_id}|${r.month}`;
    const d = dm.get(k) ?? { partId: r.part_id, customerId: r.customer_id, customer: r.customer, month: r.month, forecast: 0, firm: 0 };
    if (r.kind === 'forecast') d.forecast += r.qty; else d.firm += r.qty;
    dm.set(k, d);
  }
  // The part tree: demand parts and, through released revisions, everything they are made from.
  const items = new Map<string, Item>();
  let frontier = [...new Set([...dm.values()].map((d) => d.partId))];
  while (frontier.length) {
    const parts = await many(tx, `SELECT p.id, p.part_number, p.description, r.id AS revision_id FROM part p LEFT JOIN product_revision r ON r.part_id = p.id AND r.status = 'released' WHERE p.id = ANY ($1)`, [frontier]);
    const revIds = parts.filter((p) => p.revision_id).map((p) => p.revision_id);
    const ops = await many(tx, `SELECT o.revision_id, o.op_no, o.work_center_id, o.setup_minutes::float AS setup, o.run_minutes_per_unit::float AS run FROM product_operation o WHERE o.revision_id = ANY ($1) ORDER BY o.op_no`, [revIds]);
    const mats = await many(tx, `SELECT revision_id, part_id, qty_per::float AS qty_per, scrap_pct::float AS scrap_pct FROM product_material WHERE revision_id = ANY ($1)`, [revIds]);
    const next: string[] = [];
    for (const p of parts) {
      items.set(p.id, { partId: p.id, partNumber: p.part_number, description: p.description, made: !!p.revision_id,
        operations: ops.filter((o) => o.revision_id === p.revision_id).map((o) => ({ opNo: o.op_no, workCenterId: o.work_center_id, setupMinutes: o.setup, runMinutesPerUnit: o.run })),
        materials: mats.filter((m) => m.revision_id === p.revision_id).map((m) => ({ partId: m.part_id, qtyPer: m.qty_per, scrapPct: m.scrap_pct })),
        available: 0, leadTimeDays: null, openProduction: [], openPurchases: [] });
      for (const m of mats.filter((x) => x.revision_id === p.revision_id)) if (!items.has(m.part_id) && !frontier.includes(m.part_id)) next.push(m.part_id);
    }
    frontier = [...new Set(next)];
  }
  const ids = [...items.keys()];
  const avail = await availableAtSite(tx, facilityId, ids);
  const prod = await many(tx, `SELECT part_id, to_char(coalesce(due_date, current_date), 'YYYY-MM') AS month, sum(qty - qty_received)::float AS qty FROM production_order
    WHERE facility_id = $1 AND part_id = ANY ($2) AND status IN ('planned', 'released', 'in_progress') AND qty > qty_received GROUP BY 1, 2`, [facilityId, ids]);
  const pos = await many(tx, `SELECT l.part_id, to_char(o.expected_on, 'YYYY-MM') AS month, sum(l.qty_ordered - l.qty_received)::float AS qty FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
    WHERE o.facility_id = $1 AND l.part_id = ANY ($2) AND o.status IN ('open', 'partially_received') AND l.qty_ordered > l.qty_received GROUP BY 1, 2`, [facilityId, ids]);
  const lead = new Map((await many(tx, `SELECT DISTINCT ON (part_id) part_id, lead_time_days FROM supplier_part WHERE part_id = ANY ($1) AND lead_time_days IS NOT NULL ORDER BY part_id, preferred DESC, lead_time_days`, [ids]))
    .map((r) => [r.part_id as string, r.lead_time_days as number]));
  for (const it of items.values()) {
    it.available = Math.max(0, avail.get(it.partId)?.available ?? 0);
    it.openProduction = prod.filter((p) => p.part_id === it.partId).map((p) => ({ month: p.month, qty: p.qty }));
    it.openPurchases = pos.filter((p) => p.part_id === it.partId).map((p) => ({ month: p.month, qty: p.qty }));
    it.leadTimeDays = lead.get(it.partId) ?? null;
  }
  // Capacity: calendars, machines, and their demonstrated availability over the last 90 days.
  const wcs = await many(tx, `SELECT w.id, w.code, w.name, w.hours_per_week::float AS hours_per_week, w.units, array_remove(array_agg(x.asset_id), NULL) AS assets
    FROM work_center w LEFT JOIN work_center_asset x ON x.work_center_id = w.id WHERE w.facility_id = $1 AND w.active GROUP BY w.id ORDER BY w.code`, [facilityId]);
  const to = new Date(`${asOf}T00:00:00Z`); const from = new Date(to.getTime() - 90 * 86_400_000);
  const allAssets = wcs.flatMap((w) => w.assets);
  const events = await many(tx, `SELECT asset_id, state, started_at, ended_at FROM asset_state_event WHERE asset_id = ANY ($1) AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2)`, [allAssets, from, to]);
  const workCenters = wcs.map((w) => {
    const av = (w.assets as string[]).map((a) => computeUtilization(events.filter((e) => e.asset_id === a).map((e) => ({ state: e.state, startedAt: e.started_at, endedAt: e.ended_at })), from, to, { now: to }))
      .filter((u) => (u.coverage ?? 0) >= 0.3 && u.availability != null).map((u) => u.availability!);
    return { id: w.id, code: w.code, name: w.name, hoursPerWeek: w.hours_per_week, units: w.units, machines: w.assets.length, availability: av.length ? Math.round((av.reduce((s, x) => s + x, 0) / av.length) * 1000) / 1000 : null };
  });
  // Demonstrated performance: good, scrap and run minutes per part and operation over the last 180 days.
  const performance = (await many(tx, `SELECT o.part_id, po.op_no, sum(e.qty_good)::float AS good, sum(e.qty_scrap)::float AS scrap,
      sum(extract(epoch FROM e.ended_at - e.started_at) / 60)::float AS minutes
    FROM production_entry e JOIN production_operation po ON po.id = e.operation_id JOIN production_order o ON o.id = e.order_id
    WHERE e.facility_id = $1 AND e.kind = 'run' AND e.ended_at IS NOT NULL AND e.started_at > now() - interval '180 days' GROUP BY 1, 2`, [facilityId]))
    .map((p) => ({ partId: p.part_id, opNo: p.op_no, goodUnits: p.good, scrapUnits: p.scrap, runMinutes: p.minutes }));
  return { months, today: asOf, demand: [...dm.values()], items: [...items.values()], workCenters, performance };
}

export async function getPlan(tx: Tx, actor: Actor, q: { facilityId: string; horizon?: number; scenarioId?: string | null }) {
  requirePermission(actor, 'planning.view', q.facilityId);
  const input = await planInput(tx, q.facilityId, q.horizon ?? 6);
  let scenario = null;
  if (q.scenarioId) {
    scenario = await one(tx, 'SELECT id, name, demand_pct::float AS demand_pct, adjustments FROM planning_scenario WHERE id = $1 AND facility_id = $2', [q.scenarioId, q.facilityId]);
    if (!scenario) throw notFound('scenario');
  }
  const plan = computePlan({ ...input, scenario: scenario ? { demandPct: scenario.demand_pct, adjustments: scenario.adjustments } : undefined });
  const base = scenario ? computePlan(input) : null;
  return { ...plan, scenario, base: base ? { bottleneck: base.bottleneck, workCenters: base.workCenters.map((w) => ({ code: w.code, cells: w.cells.map((c) => ({ month: c.month, utilization: c.utilization, shortfall: c.shortfall })) })),
    materialsShort: base.materials.filter((m) => m.shortQty > 0).length } : null };
}
