import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import type { LaborEntry } from '../production/labor.js';
import { group } from '../production/labor.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const pct = (n: number | null) => (n == null ? 'n/a' : `${Math.round(n * 100)}%`);
const weekOf = (t: number) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };

/**
 * Labor productivity (D-166): output per direct labor hour by part, labor efficiency against standard by operator, work
 * center and week, and the direct share of paid time from timesheets. Answer first.
 */
export const laborProductivityReport: ReportDefinition = {
  id: 'labor-productivity',
  name: 'Labor productivity',
  description: 'Output per direct labor hour by part against its standard rate, labor efficiency (standard hours earned ÷ direct labor hours) by operator, work center and week, and how much paid time went to direct work.',
  permission: 'production.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(365).default(30) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'production.view', params.facilityId);
    const days = params.days;
    const raw = await many(tx, `SELECT e.id, e.employee_id, emp.first_name || ' ' || emp.last_name AS operator, p.part_number, w.code AS work_center, e.kind, e.operation_id,
        extract(epoch FROM e.started_at) * 1000 AS started, extract(epoch FROM e.ended_at) * 1000 AS ended, e.qty_good::float AS good,
        op.run_minutes_per_unit::float AS std_run, op.setup_minutes::float AS std_setup,
        (SELECT max(x.op_no) FROM production_operation x WHERE x.order_id = op.order_id) = op.op_no AS last_op
      FROM production_entry e JOIN production_operation op ON op.id = e.operation_id JOIN production_order o ON o.id = op.order_id JOIN part p ON p.id = o.part_id
      JOIN work_center w ON w.id = op.work_center_id JOIN employee emp ON emp.id = e.employee_id
      WHERE e.facility_id = ANY ($1) AND e.ended_at IS NOT NULL AND e.ended_at > now() - make_interval(days => $2)`, [scope.ids, days]);
    const entries: (LaborEntry & { operator: string })[] = raw.map((r) => ({ id: r.id, employee: r.employee_id, operator: r.operator, part: r.part_number, workCenter: r.work_center,
      kind: r.kind, operationId: r.operation_id, startedAt: Number(r.started), endedAt: Number(r.ended), good: r.good, stdRunMinutes: r.std_run, stdSetupMinutes: r.std_setup, lastOp: r.last_op }));
    const names = new Map(entries.map((e) => [e.employee, e.operator]));
    const total = group(entries, () => 'all')[0];
    const byPart = group(entries, (e) => e.part).filter((r) => r.finished > 0).sort((a, b) => b.directHours - a.directHours);
    const byOperator = group(entries, (e) => e.employee).sort((a, b) => b.directHours - a.directHours);
    const byCenter = group(entries, (e) => e.workCenter).sort((a, b) => b.directHours - a.directHours);
    const byWeek = group(entries, (e) => weekOf(e.endedAt)).sort((a, b) => a.key.localeCompare(b.key));
    // Paid time worked by the same people in the period (timesheets), for the direct share of it.
    const people = [...names.keys()];
    const paid = people.length ? await many(tx, `SELECT s.employee_id, sum(t.hours)::float AS hours FROM time_entry t JOIN timesheet s ON s.id = t.timesheet_id
      JOIN earning_code c ON c.tenant_id = t.tenant_id AND c.code = t.earning_code
      WHERE s.employee_id = ANY ($1) AND c.kind = 'worked' AND t.work_date > current_date - $2::int GROUP BY 1`, [people, days]) : [];
    const paidBy = new Map(paid.map((p) => [p.employee_id, p.hours as number]));
    const paidTotal = [...paidBy.values()].reduce((s, h) => s + h, 0);
    const directWithPaid = byOperator.filter((o) => paidBy.has(o.key)).reduce((s, o) => s + o.directHours, 0);
    const directShare = paidTotal > 0 ? directWithPaid / paidTotal : null;
    const base = { reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description },
      filters: { ...params, days }, period: { from: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } };
    if (!total) {
      return { ...base, headline: `No production time recorded in the last ${days} days`, kpis: [], insights: ['Operators record setup and run time on the shop floor; labor productivity follows from it.'],
        columns: [], rows: [], exceptions: [], notes: [], source: 'Production entries' } as unknown as ReportResult;
    }
    const top = byPart[0];
    const headline = `${pct(total.efficiency)} labor efficiency over ${total.directHours.toFixed(0)} direct labor hours in ${days} days`
      + (top?.unitsPerHour != null ? `; ${top.key} made ${top.unitsPerHour} an hour against ${top.standardUnitsPerHour} at standard` : '');
    const insights: string[] = [];
    const slow = byPart.filter((p) => p.efficiency != null && p.efficiency < 0.85);
    if (slow.length) insights.push(`Below 85% of standard: ${slow.slice(0, 4).map((p) => `${p.key} (${pct(p.efficiency)}, ${p.unitsPerHour}/h vs ${p.standardUnitsPerHour}/h)`).join('; ')}.`);
    const fast = byPart.filter((p) => p.efficiency != null && p.efficiency > 1.2);
    if (fast.length) insights.push(`Above 120% of standard, so the standard may be loose: ${fast.slice(0, 3).map((p) => `${p.key} (${pct(p.efficiency)})`).join(', ')}.`);
    if (directShare != null) insights.push(`${pct(directShare)} of paid hours worked by these operators went to direct production work; the rest is indirect time (meetings, training, waiting, cleaning).`);
    if (byWeek.length >= 2) { const [a, b] = [byWeek[0]!, byWeek[byWeek.length - 1]!]; insights.push(`Efficiency went from ${pct(a.efficiency)} (week of ${a.key}) to ${pct(b.efficiency)} (week of ${b.key}).`); }
    const rows = byPart.map((p) => ({ part: p.key, finished: p.finished, direct_hours: p.directHours, units_per_hour: p.unitsPerHour, standard_per_hour: p.standardUnitsPerHour, efficiency: p.efficiency }));
    return {
      ...base, headline,
      kpis: [
        { label: 'Labor efficiency', value: total.efficiency, type: 'percent', status: total.efficiency == null ? 'neutral' : total.efficiency < 0.85 ? 'bad' : total.efficiency < 0.95 ? 'watch' : 'good', note: 'standard ÷ actual hours' },
        { label: 'Direct labor hours', value: total.directHours, type: 'hours', status: 'neutral' },
        { label: 'Standard hours earned', value: total.earnedHours, type: 'hours', status: 'neutral' },
        { label: 'Direct share of paid hours', value: directShare == null ? null : Math.round(directShare * 1000) / 1000, type: 'percent', status: 'neutral', note: directShare == null ? 'no timesheets' : plural(paidBy.size, 'operator') },
        { label: 'Operators', value: byOperator.length, type: 'integer', status: 'neutral' },
      ],
      insights,
      charts: [
        ...(byWeek.length >= 2 ? [{ kind: 'line' as const, title: 'Labor efficiency by week', category: { key: 'week', label: 'Week of' }, series: [{ key: 'efficiency', label: 'Efficiency' }], valueType: 'percent' as const,
          data: byWeek.map((w) => ({ week: w.key, efficiency: w.efficiency })), reference: { value: 1, label: 'Standard' } }] : []),
        ...(byCenter.length ? [{ kind: 'bars' as const, title: 'Labor efficiency by work center', category: { key: 'center', label: 'Work center' }, series: [{ key: 'efficiency', label: 'Efficiency' }],
          valueType: 'percent' as const, data: byCenter.slice(0, 12).map((c) => ({ center: c.key, efficiency: c.efficiency })), reference: { value: 1, label: 'Standard' } }] : []),
      ],
      columns: [
        { key: 'part', label: 'Part', type: 'text', width: 1 }, { key: 'finished', label: 'Finished units', type: 'number', width: 0.7 },
        { key: 'direct_hours', label: 'Direct labor hours', type: 'hours', width: 0.8 }, { key: 'units_per_hour', label: 'Units per direct labor hour', type: 'number', width: 0.9 },
        { key: 'standard_per_hour', label: 'At standard', type: 'number', width: 0.7 }, { key: 'efficiency', label: 'Efficiency', type: 'percent', width: 0.6 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.efficiency != null && r.efficiency < 0.85 ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Direct labor hours: operators\' setup and run time on production entries that ended in the period; when one person runs two machines at once, the overlap is split between them.',
        'Standard hours earned: good units × standard run minutes, plus standard setup minutes shared among that operation\'s setups. Scrap earns nothing.',
        'Units per direct labor hour: good units at each part\'s last operation ÷ all direct hours on that part. "At standard" is the same at 100% efficiency.',
        `By operator: ${byOperator.slice(0, 8).map((o) => `${names.get(o.key)} ${pct(o.efficiency)} over ${o.directHours} h`).join('; ')}.`,
      ],
      source: 'Production entries, routings (standard times) and timesheets (live query)',
    } as unknown as ReportResult;
  },
};
