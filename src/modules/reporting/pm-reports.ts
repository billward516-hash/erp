import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { addDays, dueState, latestMeter } from '../pm/schedule.js';
import { incomingByPart } from '../purchasing/service.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const OPEN = ['planned', 'scheduled', 'in_progress', 'on_hold', 'completed'];
const today = () => new Date().toISOString().slice(0, 10);
const num = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const unit = (meter: string) => meter.replace(/_/g, ' ');

export const pmComplianceReport: ReportDefinition = {
  id: 'pm-compliance',
  name: 'Preventive maintenance compliance',
  description: 'PM work due in the period done on time, late or still open; plans due next and plans short of parts.',
  permission: 'reports.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(366).default(90) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'reports.view', params.facilityId);
    const to = today();
    const from = addDays(to, -params.days);
    const plans = await many(
      tx,
      `SELECT p.id, p.code, p.title, p.trigger_type, p.interval_days, p.interval_meter, p.meter, p.schedule_basis, p.lead_days, p.lead_meter,
              p.next_due_on, p.next_due_meter, p.last_done_on, p.asset_id, a.asset_tag, f.code AS facility,
              (SELECT w.number FROM work_order w WHERE w.pm_plan_id = p.id AND w.status = ANY ($4) LIMIT 1) AS open_wo,
              (SELECT count(*)::int FROM work_order w WHERE w.pm_plan_id = p.id AND w.status <> 'cancelled' AND w.due_at::date BETWEEN $2 AND $3) AS due_in_period,
              (SELECT count(*)::int FROM work_order w WHERE w.pm_plan_id = p.id AND w.status <> 'cancelled' AND w.due_at::date BETWEEN $2 AND $3
                 AND w.completed_at IS NOT NULL AND w.completed_at::date <= w.due_at::date) AS on_time,
              (SELECT count(*)::int FROM work_order w WHERE w.pm_plan_id = p.id AND w.status <> 'cancelled' AND w.due_at::date BETWEEN $2 AND $3
                 AND w.completed_at IS NOT NULL AND w.completed_at::date > w.due_at::date) AS late,
              (SELECT count(*)::int FROM work_order w WHERE w.pm_plan_id = p.id AND w.status = ANY ($4) AND w.due_at::date < $3) AS open_past_due,
              (SELECT count(*)::int FROM pm_plan_part pp WHERE pp.plan_id = p.id AND EXISTS (SELECT 1 FROM inventory_balance b WHERE b.part_id = pp.part_id AND b.facility_id = p.facility_id)
                 AND (SELECT coalesce(sum(b.qty_on_hand), 0) FROM inventory_balance b WHERE b.part_id = pp.part_id AND b.facility_id = p.facility_id) < pp.qty) AS parts_short
       FROM pm_plan p JOIN asset a ON a.id = p.asset_id JOIN facility f ON f.id = p.facility_id
       WHERE p.active AND p.facility_id = ANY ($1) ORDER BY f.code, p.code`,
      [scope.ids, from, to, OPEN],
    );
    const rows = [];
    for (const p of plans) {
      const latest = p.trigger_type === 'meter' ? await latestMeter(tx, p.asset_id, p.meter) : null;
      const state = dueState(p, to, latest);
      const closedOrPast = p.on_time + p.late + p.open_past_due;
      rows.push({
        ...p, due_state: state === 'not_due' ? 'Not due' : state === 'due' ? 'Due' : 'Overdue',
        next_due: p.trigger_type === 'calendar' ? p.next_due_on : `${num(p.next_due_meter)} ${unit(p.meter)} (now ${latest == null ? 'no reading' : num(latest)})`,
        interval: p.trigger_type === 'calendar' ? `${p.interval_days} days` : `${num(p.interval_meter)} ${unit(p.meter)}`,
        compliance: closedOrPast ? p.on_time / closedOrPast : null,
        overdue: state === 'overdue',
      });
    }
    const onTime = rows.reduce((s, r) => s + r.on_time, 0);
    const late = rows.reduce((s, r) => s + r.late, 0);
    const openPast = rows.reduce((s, r) => s + r.open_past_due, 0);
    const measured = onTime + late + openPast;
    const compliance = measured ? onTime / measured : null;
    const overdue = rows.filter((r) => r.overdue);
    const dueSoon = rows.filter((r) => r.due_state === 'Due');
    const short = rows.filter((r) => r.parts_short > 0);
    const headline = !rows.length ? 'No active PM plans in scope'
      : compliance === null ? `${plural(rows.length, 'PM plan')} active; no PM work came due in the last ${params.days} days`
      : `PM compliance ${pct(compliance)} over ${params.days} days (${onTime} of ${measured} on time)${overdue.length ? `; ${plural(overdue.length, 'plan')} overdue now` : ''}`;
    const insights: string[] = [];
    if (overdue.length) insights.push(`Overdue: ${overdue.slice(0, 4).map((r) => `${r.code} on ${r.asset_tag}`).join(', ')}${overdue.length > 4 ? ` and ${overdue.length - 4} more` : ''}.`);
    if (late) insights.push(`${plural(late, 'PM')} completed after the due date in the period.`);
    if (dueSoon.length) insights.push(`${plural(dueSoon.length, 'plan')} inside the lead window now; ${dueSoon.filter((r) => !r.open_wo).length} without a work order yet (run PM generation).`);
    if (short.length) insights.push(`${plural(short.length, 'plan')} short of planned parts at the facility storerooms: ${short.slice(0, 3).map((r) => r.code).join(', ')}.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      period: { from, to }, scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'PM compliance', value: compliance, type: 'percent', note: `on time ÷ due in last ${params.days} days`, status: compliance === null ? 'neutral' : compliance >= 0.9 ? 'good' : compliance >= 0.75 ? 'watch' : 'bad' },
        { label: 'Plans overdue now', value: overdue.length, type: 'integer', status: overdue.length ? 'bad' : 'good' },
        { label: 'Due in lead window', value: dueSoon.length, type: 'integer', status: 'neutral' },
        { label: 'Plans short of parts', value: short.length, type: 'integer', status: short.length ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'code', label: 'Plan', type: 'text', width: 1 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'asset_tag', label: 'Asset', type: 'text', width: 0.8 },
        { key: 'title', label: 'Title', type: 'text', width: 2 },
        { key: 'interval', label: 'Interval', type: 'text', width: 0.9 },
        { key: 'next_due', label: 'Next due', type: 'text', width: 1.4 },
        { key: 'due_state', label: 'State', type: 'text', width: 0.7 },
        { key: 'open_wo', label: 'Open WO', type: 'text', width: 0.9 },
        { key: 'on_time', label: 'On time', type: 'integer', width: 0.6 },
        { key: 'late', label: 'Late', type: 'integer', width: 0.5 },
        { key: 'open_past_due', label: 'Open past due', type: 'integer', width: 0.7 },
        { key: 'compliance', label: 'Compliance', type: 'percent', width: 0.8 },
        { key: 'parts_short', label: 'Parts short', type: 'integer', width: 0.6 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.overdue || r.open_past_due > 0 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/pm/{id}' },
      notes: [
        'Compliance = PM work orders due in the period and completed on or before their due date, divided by all PM work orders due in the period that are completed or still open past due. Cancelled work orders are excluded.',
        'Completion date is when the technician completed the work; the plan moves to its next due point when the work is verified.',
        'Meter plans are due once the latest reading is within the lead allowance of the due reading; readings are only as current as the last entry.',
        'Parts short compares the plan\'s parts list with stock on hand across the facility\'s storerooms (unstocked parts are not counted).',
      ],
      source: 'PM plans, preventive work orders, meter readings and storeroom balances (live query)',
    };
  },
};

export const inventoryReorderReport: ReportDefinition = {
  id: 'inventory-reorder',
  name: 'Parts to reorder',
  description: 'Stocked parts at or below their reorder point, or short of preventive maintenance demand in the coming weeks, with a suggested order quantity.',
  permission: 'inventory.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(120).default(30) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'inventory.view', params.facilityId);
    const to = today();
    const horizon = addDays(to, params.days);
    // PM demand: parts lists of active plans due inside the horizon (calendar) or already inside their lead window (meter)
    // that have not had the parts issued yet (an open PM work order whose line is not used counts as demand).
    const plans = await many(
      tx,
      `SELECT p.id, p.facility_id, p.trigger_type, p.interval_days, p.interval_meter, p.meter, p.schedule_basis, p.lead_days, p.lead_meter,
              p.next_due_on, p.next_due_meter, p.asset_id, p.code
       FROM pm_plan p WHERE p.active AND p.facility_id = ANY ($1)`,
      [scope.ids],
    );
    const demand = new Map<string, { qty: number; plans: string[] }>();
    for (const p of plans) {
      const latest = p.trigger_type === 'meter' ? await latestMeter(tx, p.asset_id, p.meter) : null;
      const inHorizon = p.trigger_type === 'calendar' ? p.next_due_on <= horizon : dueState(p, to, latest) !== 'not_due';
      if (!inHorizon) continue;
      const parts = await many(
        tx,
        `SELECT pp.part_id, pp.qty - coalesce((SELECT sum(wp.qty_used) FROM work_order_part wp JOIN work_order w ON w.id = wp.work_order_id
                  WHERE w.pm_plan_id = pp.plan_id AND w.status = ANY ($2) AND wp.part_id = pp.part_id), 0) AS remaining
         FROM pm_plan_part pp WHERE pp.plan_id = $1`,
        [p.id, OPEN],
      );
      for (const x of parts) {
        if (Number(x.remaining) <= 0) continue;
        const key = `${p.facility_id}:${x.part_id}`;
        const d = demand.get(key) ?? { qty: 0, plans: [] };
        d.qty += Number(x.remaining);
        d.plans.push(p.code);
        demand.set(key, d);
      }
    }
    const stock = await many(
      tx,
      `SELECT b.facility_id, f.code AS facility, b.part_id, p.part_number, p.description, p.uom, p.unit_cost,
              sum(b.qty_on_hand)::float AS on_hand, sum(b.reorder_point)::float AS reorder_point, sum(b.reorder_qty)::float AS reorder_qty,
              string_agg(l.code || ' ' || b.qty_on_hand::float, ', ' ORDER BY l.code) AS locations
       FROM inventory_balance b JOIN stock_location l ON l.id = b.location_id JOIN part p ON p.id = b.part_id JOIN facility f ON f.id = b.facility_id
       WHERE b.facility_id = ANY ($1)
       GROUP BY b.facility_id, f.code, b.part_id, p.part_number, p.description, p.uom, p.unit_cost
       ORDER BY f.code, p.part_number`,
      [scope.ids],
    );
    const rows = [];
    const incoming = new Map<string, { onOrder: number; requested: number }>();
    for (const f of new Set(stock.map((s) => s.facility_id as string))) {
      const m = await incomingByPart(tx, f, stock.filter((s) => s.facility_id === f).map((s) => s.part_id));
      for (const [partId, v] of m) incoming.set(`${f}:${partId}`, v);
    }
    for (const s of stock) {
      const d = demand.get(`${s.facility_id}:${s.part_id}`);
      const pmDemand = d?.qty ?? 0;
      const inc = incoming.get(`${s.facility_id}:${s.part_id}`);
      const coming = (inc?.onOrder ?? 0) + (inc?.requested ?? 0);
      // Stock position = on hand + already ordered or requested; decisions use the position, not the shelf alone.
      const position = s.on_hand + coming;
      const belowReorder = s.reorder_point != null && position <= s.reorder_point;
      const shortForPm = pmDemand > position;
      if (!belowReorder && !shortForPm) continue;
      // Order enough to cover PM demand and get back above the reorder point; at least the standard reorder quantity.
      const need = Math.max(0, (s.reorder_point ?? 0) + pmDemand - position);
      const suggested = Math.ceil(Math.max(need, s.reorder_qty ?? 0, shortForPm ? pmDemand - position : 0));
      rows.push({
        ...s, on_order: inc?.onOrder ?? 0, requested: inc?.requested ?? 0, pm_demand: pmDemand, pm_plans: d ? [...new Set(d.plans)].join(', ') : null, suggested_qty: suggested,
        est_cost: s.unit_cost != null ? Math.round(suggested * s.unit_cost * 100) / 100 : null,
        reason: [belowReorder ? 'At/below reorder point' : null, shortForPm ? 'Short for PM' : null].filter(Boolean).join('; '),
        short_for_pm: shortForPm, stockout: s.on_hand === 0,
      });
    }
    const pmShort = rows.filter((r) => r.short_for_pm);
    const out = rows.filter((r) => r.stockout);
    const spend = rows.reduce((s, r) => s + (r.est_cost ?? 0), 0);
    const unpriced = rows.filter((r) => r.est_cost == null).length;
    const headline = !stock.length ? 'No stocked parts in scope'
      : !rows.length ? `No stocked parts need reordering; PM demand for the next ${params.days} days is covered`
      : `${plural(rows.length, 'part')} to reorder${pmShort.length ? `, ${pmShort.length} needed for PM in the next ${params.days} days` : ''}`;
    const insights: string[] = [];
    if (out.length) insights.push(`${plural(out.length, 'part')} out of stock: ${out.slice(0, 4).map((r) => `${r.part_number} (${r.facility})`).join(', ')}.`);
    if (pmShort.length) insights.push(`PM work at risk: ${pmShort.slice(0, 3).map((r) => `${r.part_number} for ${r.pm_plans}`).join('; ')}.`);
    if (rows.length) insights.push(`Suggested orders total about ${spend.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} at current average cost${unpriced ? ` (${unpriced} without a cost)` : ''}.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      period: { from: to, to: horizon }, scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Parts to reorder', value: rows.length, type: 'integer', status: rows.length ? 'watch' : 'good' },
        { label: 'Out of stock', value: out.length, type: 'integer', status: out.length ? 'bad' : 'good' },
        { label: 'Short for PM', value: pmShort.length, type: 'integer', note: `next ${params.days} days`, status: pmShort.length ? 'bad' : 'good' },
        { label: 'Suggested spend', value: Math.round(spend), type: 'currency', note: 'USD, average cost', status: 'neutral' },
      ],
      insights,
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'part_number', label: 'Part', type: 'text', width: 1 },
        { key: 'description', label: 'Description', type: 'text', width: 2 },
        { key: 'locations', label: 'On hand by storeroom', type: 'text', width: 1.3 },
        { key: 'on_hand', label: 'On hand', type: 'number', width: 0.6 },
        { key: 'reorder_point', label: 'Reorder point', type: 'number', width: 0.7 },
        { key: 'on_order', label: 'On order', type: 'number', width: 0.6 },
        { key: 'requested', label: 'Requested', type: 'number', width: 0.6 },
        { key: 'pm_demand', label: 'PM demand', type: 'number', width: 0.6 },
        { key: 'pm_plans', label: 'For plans', type: 'text', width: 1.1 },
        { key: 'suggested_qty', label: 'Suggested order', type: 'number', width: 0.7 },
        { key: 'uom', label: 'UOM', type: 'text', width: 0.4 },
        { key: 'est_cost', label: 'Est. cost', type: 'currency', unit: 'USD', width: 0.8 },
        { key: 'reason', label: 'Why', type: 'text', width: 1.3 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.stockout || r.short_for_pm ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Quantities are summed across each facility\'s storerooms; transfers between storerooms at a site are not suggested here.',
        `PM demand = parts lists of active plans due by ${horizon} (calendar) or inside their lead window now (meter), less parts already issued to the open PM work order.`,
        'Suggested order = enough to cover PM demand and return above the reorder point, and at least the reorder quantity. Stock position = on hand + open purchase-order quantity + purchase requests not yet ordered.',
        'Estimated cost uses the moving-average cost from receipts; it is not a quote.',
      ],
      source: 'Storeroom balances, PM plans and work-order part usage (live query)',
    };
  },
};
