import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const pct = (n: number | null) => (n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export const productionStatusReport: ReportDefinition = {
  id: 'production-status',
  name: 'Production status and yield',
  description: 'Open production orders and their progress, late orders, first-pass yield and scrap by reason, actual against standard hours by work center, material shortages, and machine throughput.',
  permission: 'production.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(365).default(30) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'production.view', params.facilityId);
    const days = params.days;
    const orders = await many(tx, `
      SELECT o.id, o.number, f.code AS facility, p.part_number, o.status, o.qty::float AS qty, o.due_date, o.qty_received::float AS received,
             so.number AS sales_order, c.name AS customer,
             (SELECT op.op_no || ' ' || w.code FROM production_operation op JOIN work_center w ON w.id = op.work_center_id WHERE op.order_id = o.id AND op.status <> 'done' ORDER BY op.op_no LIMIT 1) AS current_op,
             (SELECT qty_good::float FROM production_operation op WHERE op.order_id = o.id ORDER BY op.op_no DESC LIMIT 1) AS made,
             (SELECT count(*)::int FROM production_material m WHERE m.order_id = o.id AND m.qty_required - m.qty_issued >
                coalesce((SELECT sum(b.qty_on_hand) FROM inventory_balance b WHERE b.part_id = m.part_id AND b.facility_id = o.facility_id), 0)) AS short_lines,
             (current_date - o.due_date) AS days_late
      FROM production_order o JOIN facility f ON f.id = o.facility_id JOIN part p ON p.id = o.part_id
      LEFT JOIN sales_order_line sl ON sl.id = o.sales_order_line_id LEFT JOIN sales_order so ON so.id = sl.order_id LEFT JOIN customer c ON c.id = so.customer_id
      WHERE o.facility_id = ANY ($1) AND o.status IN ('planned', 'released', 'in_progress')
      ORDER BY o.due_date NULLS LAST, o.number`, [scope.ids]);
    // Quality and time from runs that ended in the period.
    const runs = await many(tx, `
      SELECT w.code AS work_center, e.asset_id, a.asset_tag, e.kind, e.qty_good::float AS good, e.qty_scrap::float AS scrap, e.qty_rework::float AS rework, e.scrap_reason, sr.label AS scrap_label,
             extract(epoch FROM (e.ended_at - e.started_at)) / 3600 AS hours, op.run_minutes_per_unit::float AS std_run, op.setup_minutes::float AS std_setup, op.op_no,
             (SELECT max(x.op_no) FROM production_operation x WHERE x.order_id = op.order_id) = op.op_no AS last_op
      FROM production_entry e JOIN production_operation op ON op.id = e.operation_id JOIN work_center w ON w.id = op.work_center_id
      LEFT JOIN asset a ON a.id = e.asset_id LEFT JOIN scrap_reason sr ON sr.code = e.scrap_reason
      WHERE e.facility_id = ANY ($1) AND e.ended_at IS NOT NULL AND e.ended_at > now() - make_interval(days => $2)`, [scope.ids, days]);
    const good = runs.reduce((s, r) => s + r.good, 0);
    const scrap = runs.reduce((s, r) => s + r.scrap, 0);
    const rework = runs.reduce((s, r) => s + r.rework, 0);
    const fpy = good + scrap > 0 ? (good - rework) / (good + scrap) : null;
    const scrapRate = good + scrap > 0 ? scrap / (good + scrap) : null;
    const finished = runs.filter((r) => r.last_op).reduce((s, r) => s + r.good, 0);
    const byReason = new Map<string, number>();
    for (const r of runs) if (r.scrap > 0) byReason.set(r.scrap_label ?? r.scrap_reason, (byReason.get(r.scrap_label ?? r.scrap_reason) ?? 0) + r.scrap);
    const topReason = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0];
    const byWc = new Map<string, { actual: number; std: number }>();
    for (const r of runs) {
      const w = byWc.get(r.work_center) ?? { actual: 0, std: 0 };
      w.actual += Number(r.hours);
      w.std += r.kind === 'setup' ? r.std_setup / 60 : (r.std_run * (r.good + r.scrap)) / 60;
      byWc.set(r.work_center, w);
    }
    const slowest = [...byWc.entries()].filter(([, v]) => v.std > 0).map(([k, v]) => [k, (v.actual / v.std) * 100] as const).sort((a, b) => b[1] - a[1])[0];
    const actualHours = [...byWc.values()].reduce((s, v) => s + v.actual, 0);
    const stdHours = [...byWc.values()].reduce((s, v) => s + v.std, 0);
    const byMachine = new Map<string, { units: number; hours: number }>();
    for (const r of runs) if (r.asset_tag && r.kind === 'run') { const m = byMachine.get(r.asset_tag) ?? { units: 0, hours: 0 }; m.units += r.good + r.scrap; m.hours += Number(r.hours); byMachine.set(r.asset_tag, m); }
    const late = orders.filter((o) => o.days_late > 0);
    const short = orders.filter((o) => o.short_lines > 0 && o.status !== 'planned');
    const STATUS: Record<string, string> = { planned: 'Planned', released: 'Released', in_progress: 'In progress' };
    const rows = orders.map((o) => ({ ...o, status: STATUS[o.status] ?? o.status, made: o.made ?? 0, progress: o.qty ? r3((o.made ?? 0) / o.qty) : 0,
      days_late: o.days_late > 0 ? o.days_late : null, materials: o.status === 'planned' ? 'Not released' : o.short_lines ? `${plural(o.short_lines, 'line')} short` : 'Covered' }));
    const headline = !orders.length && !runs.length ? 'No open production orders or production runs in scope'
      : late.length ? `${plural(late.length, 'production order')} late of ${orders.length} open; first-pass yield ${pct(fpy)} over ${days} days`
      : `${plural(orders.length, 'open production order')}, none late; first-pass yield ${pct(fpy)} over ${days} days`;
    const insights: string[] = [];
    if (runs.length) insights.push(`${Math.round(finished)} units finished in the last ${days} days; ${Math.round(scrap)} scrapped (${pct(scrapRate)}) and ${Math.round(rework)} reworked.`);
    if (topReason) insights.push(`Top scrap reason: ${topReason[0]} (${Math.round(topReason[1])} of ${Math.round(scrap)} scrapped units).`);
    if (slowest && slowest[1] > 110) insights.push(`${slowest[0]} ran at ${slowest[1].toFixed(0)}% of standard time; check the standard or the process.`);
    if (short.length) insights.push(`${plural(short.length, 'released order')} short of material: ${short.slice(0, 3).map((o) => o.number).join(', ')}.`);
    const machines = [...byMachine.entries()].filter(([, m]) => m.hours > 0).map(([t, m]) => `${t} ${(m.units / m.hours).toFixed(1)}/h`);
    if (machines.length) insights.push(`Demonstrated throughput (units per run hour): ${machines.slice(0, 4).join(', ')}.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Open orders', value: orders.length, type: 'integer', status: 'neutral' },
        { label: 'Late', value: late.length, type: 'integer', status: late.length ? 'bad' : 'good' },
        { label: `First-pass yield (${days} d)`, value: fpy == null ? null : r3(fpy), type: 'percent', status: fpy == null ? 'neutral' : fpy < 0.95 ? 'watch' : 'good' },
        { label: `Scrap rate (${days} d)`, value: scrapRate == null ? null : r3(scrapRate), type: 'percent', status: scrapRate == null ? 'neutral' : scrapRate > 0.03 ? 'bad' : 'good' },
        { label: 'Actual vs standard hours', value: stdHours > 0 ? r3(actualHours / stdHours) : null, type: 'percent', status: stdHours > 0 && actualHours / stdHours > 1.1 ? 'watch' : 'neutral' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'Order', type: 'text', width: 0.8 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'part_number', label: 'Part', type: 'text', width: 0.9 },
        { key: 'customer', label: 'For customer', type: 'text', width: 1.3 },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
        { key: 'qty', label: 'Ordered', type: 'number', width: 0.6 },
        { key: 'made', label: 'Finished', type: 'number', width: 0.6 },
        { key: 'progress', label: 'Progress', type: 'percent', width: 0.6 },
        { key: 'current_op', label: 'Current operation', type: 'text', width: 1 },
        { key: 'materials', label: 'Materials', type: 'text', width: 0.8 },
        { key: 'due_date', label: 'Due', type: 'date', width: 0.8 },
        { key: 'days_late', label: 'Days late', type: 'integer', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.days_late != null || (r.materials.endsWith('short')) ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/production-orders/{id}' },
      notes: [
        'First-pass yield = (good − reworked) ÷ (good + scrapped) across all operations in the period; scrap rate = scrapped ÷ (good + scrapped).',
        'Standard hours = setup minutes for setup runs, plus run minutes per unit × units processed, from the routing pinned on each order.',
        'Throughput counts units processed per hour of recorded run time on each machine (demonstrated, not nameplate). Recorded runs only; machines without production records are not shown.',
        'Material shortage = remaining need above on-hand stock at the site (open purchase orders not counted here; see the order page).',
      ],
      source: 'Production orders, shop-floor runs, routings and stock balances (live query)',
    };
  },
};
