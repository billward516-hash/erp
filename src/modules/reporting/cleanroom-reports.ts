import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { CHANNEL_LABEL, isChannel } from '../cleanroom/limits.js';
import { overduePoints } from '../cleanroom/service.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const HOUR = 3_600_000;
const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : null);
const channelText = (cs: string[]) => cs.map((c) => (isChannel(c) ? CHANNEL_LABEL[c] : c)).join(', ');

/**
 * Environmental monitoring (SC-007 A): compliance by room and period, excursions, and overdue sampling. One table at a time (`view`);
 * the figures above it always cover all three so the headline is the same whichever table is open.
 */
export const cleanroomMonitoringReport: ReportDefinition = {
  id: 'cleanroom-monitoring',
  name: 'Cleanroom environmental monitoring',
  description: 'Per room and period: readings, how many went over an alert or action limit, and compliance. Switch the table to the excursions (with their nonconformances) or to sampling that is overdue. For audits.',
  permission: 'cleanroom.view',
  params: z.object({
    facilityId: z.string().uuid().optional(), roomId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(366).default(30),
    period: z.enum(['week', 'month']).default('week'), view: z.enum(['compliance', 'excursions', 'overdue']).default('compliance'),
  }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'cleanroom.view', params.facilityId);
    const from = new Date(Date.now() - params.days * 24 * HOUR);
    const rooms = await many(tx, `SELECT r.id, r.code, r.name, r.iso_class, r.occupancy, f.code AS site FROM cleanroom r JOIN facility f ON f.id = r.facility_id
      WHERE r.facility_id = ANY ($1) AND ($2::uuid IS NULL OR r.id = $2) AND (r.active OR EXISTS (SELECT 1 FROM cleanroom_point p JOIN cleanroom_reading x ON x.point_id = p.id WHERE p.room_id = r.id AND x.read_at >= $3)) ORDER BY f.code, r.code`,
    [scope.ids, params.roomId ?? null, from]);
    const roomIds = rooms.map((r) => r.id);
    const buckets = await many(tx, `SELECT p.room_id, date_trunc($3, x.read_at)::date::text AS period, count(*)::int AS readings,
        count(*) FILTER (WHERE x.status = 'alert')::int AS alerts, count(*) FILTER (WHERE x.status = 'action')::int AS actions
      FROM cleanroom_reading x JOIN cleanroom_point p ON p.id = x.point_id WHERE p.room_id = ANY ($1) AND x.read_at >= $2 GROUP BY 1, 2 ORDER BY 2, 1`, [roomIds, from, params.period]);
    const excursions = await many(tx, `SELECT e.id, e.room_id, p.label AS point, e.started_at, e.ended_at, e.readings, e.channels, n.number AS ncr, n.status AS ncr_status
      FROM cleanroom_excursion e JOIN cleanroom_point p ON p.id = e.point_id LEFT JOIN nonconformance n ON n.id = e.nonconformance_id
      WHERE e.room_id = ANY ($1) AND (e.ended_at IS NULL OR e.ended_at >= $2) ORDER BY e.started_at DESC`, [roomIds, from]);
    const points = await many(tx, `SELECT p.id, p.room_id, p.interval_hours, p.created_at, (SELECT count(*)::int FROM cleanroom_reading x WHERE x.point_id = p.id AND x.read_at >= $2) AS taken,
        (SELECT min(x.read_at) FROM cleanroom_reading x WHERE x.point_id = p.id) AS first_read FROM cleanroom_point p WHERE p.room_id = ANY ($1) AND p.active`, [roomIds, from]);
    const overdue = (await overduePoints(tx, scope.ids)).filter((o) => roomIds.includes(o.room_id));
    const byRoom = new Map(rooms.map((r) => [r.id as string, r]));
    const now = Date.now();

    const total = buckets.reduce((s, b) => s + b.readings, 0); const alerts = buckets.reduce((s, b) => s + b.alerts, 0); const actions = buckets.reduce((s, b) => s + b.actions, 0);
    const compliance = total ? (total - actions) / total : null;
    // Sampling on time: readings taken against readings expected from each point's frequency over the window (or since it was set up, if later).
    let expected = 0; let taken = 0;
    for (const p of points) {
      const start = Math.max(from.getTime(), Math.min(new Date(p.created_at).getTime(), p.first_read ? new Date(p.first_read).getTime() : Infinity));
      const due = Math.max(1, Math.floor((now - start) / (p.interval_hours * HOUR)));
      expected += due; taken += Math.min(p.taken, due);
    }
    const sampling = expected ? taken / expected : null;
    const open = excursions.filter((e) => !e.ended_at);

    const compRows = buckets.map((b) => {
      const r = byRoom.get(b.room_id)!;
      return { room: `${r.code} ${r.name}`, site: r.site, iso_class: `ISO ${r.iso_class}`, period: b.period, readings: b.readings, over_alert: b.alerts, over_action: b.actions,
        compliance: b.readings ? (b.readings - b.actions) / b.readings : null, within_alert: b.readings ? (b.readings - b.alerts - b.actions) / b.readings : null };
    }).sort((a, b) => a.room.localeCompare(b.room) || String(a.period).localeCompare(String(b.period)));
    const exRows = excursions.map((e) => {
      const r = byRoom.get(e.room_id)!;
      return { room: `${r.code} ${r.name}`, site: r.site, point: e.point, started: iso(e.started_at), ended: iso(e.ended_at), hours: Math.round((((e.ended_at ? new Date(e.ended_at).getTime() : now) - new Date(e.started_at).getTime()) / HOUR) * 10) / 10,
        readings: e.readings, measures: channelText(e.channels), nonconformance: e.ncr ? `${e.ncr} (${e.ncr_status})` : null, state: e.ended_at ? 'closed' : 'open' };
    });
    const lateRows = overdue.map((o) => ({ room: `${o.room_code} ${o.room_name}`, point: o.label, every_h: o.interval_hours, last_reading: iso(o.last_read_at), hours_overdue: o.hours_overdue, owner: o.owner_name }));

    const columns = params.view === 'excursions' ? [
      { key: 'room', label: 'Room', type: 'text' as const, width: 1.3 }, { key: 'point', label: 'Point', type: 'text' as const, width: 1.2 }, { key: 'started', label: 'Started', type: 'datetime' as const, width: 0.9 },
      { key: 'ended', label: 'Ended', type: 'datetime' as const, width: 0.9 }, { key: 'hours', label: 'Duration', type: 'hours' as const, unit: 'h', width: 0.5 }, { key: 'readings', label: 'Readings', type: 'integer' as const, width: 0.5 },
      { key: 'measures', label: 'Measures over action', type: 'text' as const, width: 1.2 }, { key: 'nonconformance', label: 'Nonconformance', type: 'text' as const, width: 1 }]
      : params.view === 'overdue' ? [
        { key: 'room', label: 'Room', type: 'text' as const, width: 1.4 }, { key: 'point', label: 'Point', type: 'text' as const, width: 1.4 }, { key: 'every_h', label: 'Every', type: 'integer' as const, unit: 'h', width: 0.5 },
        { key: 'last_reading', label: 'Last reading', type: 'datetime' as const, width: 1 }, { key: 'hours_overdue', label: 'Overdue', type: 'hours' as const, unit: 'h', width: 0.5 }, { key: 'owner', label: 'Room owner', type: 'text' as const, width: 1 }]
        : [
          { key: 'room', label: 'Room', type: 'text' as const, width: 1.5 }, { key: 'iso_class', label: 'Class', type: 'text' as const, width: 0.5 }, { key: 'period', label: params.period === 'week' ? 'Week starting' : 'Month starting', type: 'date' as const, width: 0.8 },
          { key: 'readings', label: 'Readings', type: 'integer' as const, width: 0.5 }, { key: 'over_alert', label: 'Over alert', type: 'integer' as const, width: 0.5 }, { key: 'over_action', label: 'Over action', type: 'integer' as const, width: 0.5 },
          { key: 'compliance', label: 'Compliance', type: 'percent' as const, width: 0.6 }];
    const rows = params.view === 'excursions' ? exRows : params.view === 'overdue' ? lateRows : compRows;
    const exceptions = rows.map((r: any, i) => ((params.view === 'compliance' ? r.over_action > 0 : params.view === 'excursions' ? r.state === 'open' : true) ? i : -1)).filter((i) => i >= 0);

    const insights: string[] = [];
    const worst = [...rooms.map((r) => { const bs = buckets.filter((b) => b.room_id === r.id); const t = bs.reduce((s, b) => s + b.readings, 0); const a = bs.reduce((s, b) => s + b.actions, 0); return { r, t, a }; })]
      .filter((x) => x.a > 0).sort((x, y) => y.a / y.t - x.a / x.t).slice(0, 3);
    if (worst.length) insights.push(`Most readings over an action limit: ${worst.map((x) => `${x.r.code} ${x.a} of ${x.t} (${pct(1 - x.a / x.t)} compliant)`).join('; ')}.`);
    if (open.length) insights.push(`Open excursions: ${open.slice(0, 4).map((e) => `${byRoom.get(e.room_id)!.code} / ${e.point}${e.ncr ? ` (${e.ncr})` : ''}`).join(', ')}.`);
    if (overdue.length) insights.push(`Sampling overdue: ${overdue.slice(0, 4).map((o) => `${o.room_code} / ${o.label} (${o.hours_overdue} h)`).join(', ')}${overdue.length > 4 ? ` and ${overdue.length - 4} more` : ''}.`);
    if (sampling != null && sampling < 0.9) insights.push(`Only ${pct(sampling)} of the expected readings were taken in the period.`);

    const periods = [...new Set(buckets.map((b) => b.period as string))].sort();
    const headline = !rooms.length ? 'No cleanrooms in scope'
      : !total ? `No readings in the last ${params.days} days${overdue.length ? `; ${plural(overdue.length, 'point')} overdue for sampling` : ''}`
        : `${pct(compliance)} of ${total.toLocaleString('en-US')} readings were within the action limits in ${params.days} days; ${plural(excursions.length, 'excursion')}${open.length ? ` (${open.length} still open)` : ''}, ${plural(overdue.length, 'point')} overdue for sampling`;
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from: from.toISOString(), to: new Date().toISOString() },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Compliance', value: compliance, type: 'percent', status: compliance == null ? 'neutral' : compliance >= 0.99 ? 'good' : compliance >= 0.95 ? 'watch' : 'bad', note: `${total} readings` },
        { label: 'Over alert limit', value: alerts, type: 'integer', status: alerts ? 'watch' : 'good' },
        { label: 'Over action limit', value: actions, type: 'integer', status: actions ? 'bad' : 'good' },
        { label: 'Open excursions', value: open.length, type: 'integer', status: open.length ? 'bad' : 'good' },
        { label: 'Sampling on time', value: sampling, type: 'percent', status: sampling == null ? 'neutral' : sampling >= 0.95 ? 'good' : 'watch' },
        { label: 'Points overdue', value: overdue.length, type: 'integer', status: overdue.length ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5), columns, rows, exceptions,
      charts: periods.length > 1 ? [{ kind: 'columns', title: 'Readings over the alert and action limits', category: { key: 'period', label: params.period === 'week' ? 'Week starting' : 'Month starting' },
        series: [{ key: 'alerts', label: 'Over alert' }, { key: 'actions', label: 'Over action' }], valueType: 'integer',
        data: periods.map((p) => ({ period: p, alerts: buckets.filter((b) => b.period === p).reduce((s, b) => s + b.alerts, 0), actions: buckets.filter((b) => b.period === p).reduce((s, b) => s + b.actions, 0) })) }] : undefined,
      notes: [
        'Compliance = readings not over an action limit / readings taken. A reading is judged against the limits in force when it was recorded; changing a limit later does not rewrite earlier readings.',
        'Default particle limits are generated from the ISO 14644-1 class formula for the room\'s class. They are not certified: confirm them against your own copy of the standard. Points may have their own limits, and pressure, temperature and humidity are limited only where a range is set.',
        'Sampling on time = readings taken / readings expected from each point\'s sampling frequency, counted from the start of the period or from when the point was set up, if later. A point is overdue when its next reading was due before now.',
        'An excursion runs from the first reading over an action limit to the first reading back under it at that point, and raises one nonconformance.',
      ],
      source: 'Cleanroom readings, excursions and nonconformances (live query)',
    };
  },
};
