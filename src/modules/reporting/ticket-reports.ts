import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const fraction = (a: number, b: number) => (b ? a / b : null);
const pctText = (f: number | null) => (f == null ? 'n/a' : `${Math.round(f * 100)}%`);
function period(p: { from?: string; to?: string }, days: number) {
  const to = p.to ?? isoDay(new Date());
  const from = p.from ?? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - days * 86_400_000));
  return { from, to };
}

/**
 * Service-level attainment for tickets raised in a period: of the tickets whose first response (or resolution) was judged, how many met
 * the target. Judged = answered or resolved, plus open tickets already past the target (missed). Tickets still inside their time, and
 * tickets with no target for their priority, are left out of the percentage. No attainment goal is assumed: the percentages are shown plainly.
 */
export const ticketServiceLevelsReport: ReportDefinition = {
  id: 'ticket-service-levels',
  name: 'Ticket service levels',
  description: 'First-response and resolution attainment for tickets raised in a period, by priority, assignee or customer.',
  permission: 'tickets.view',
  params: z.object({ facilityId: z.string().uuid().optional(), from: day.optional(), to: day.optional(), groupBy: z.enum(['priority', 'assignee', 'customer']).default('priority') }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'tickets.view', params.facilityId);
    const { from, to } = period(params, 90);
    const key = params.groupBy === 'assignee' ? `coalesce(u.display_name, 'Unassigned')` : params.groupBy === 'customer' ? 'c.name' : 't.priority';
    const outcome = (target: string, answered: string, missed: string, due: string) => `CASE WHEN ${target} IS NULL THEN NULL WHEN ${answered} IS NOT NULL THEN (CASE WHEN ${missed} THEN 'missed' ELSE 'met' END)
      WHEN t.status NOT IN ('resolved', 'closed') AND ${due} < now() THEN 'missed' ELSE 'pending' END`;
    const rows = await many(tx, `SELECT ${key} AS grp, count(*)::int AS tickets,
        count(*) FILTER (WHERE fr = 'met')::int AS fr_met, count(*) FILTER (WHERE fr = 'missed')::int AS fr_missed, count(*) FILTER (WHERE fr = 'pending')::int AS fr_pending,
        count(*) FILTER (WHERE rs = 'met')::int AS rs_met, count(*) FILTER (WHERE rs = 'missed')::int AS rs_missed, count(*) FILTER (WHERE rs = 'pending')::int AS rs_pending
      FROM (SELECT t.*, ${outcome('t.first_response_target_min', 't.first_responded_at', 't.first_response_missed', 't.first_response_due_at')} AS fr,
              ${outcome('t.resolution_target_min', 't.resolved_at', 't.resolution_missed', 't.resolution_due_at')} AS rs FROM ticket t
            WHERE t.facility_id = ANY ($1) AND t.created_at >= $2::date AND t.created_at < $3::date + 1) t
      JOIN customer c ON c.id = t.customer_id LEFT JOIN app_user u ON u.id = t.assignee_user_id
      GROUP BY 1 ORDER BY ${params.groupBy === 'priority' ? `CASE ${key} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END` : 'tickets DESC, 1'}`, [scope.ids, from, to]);
    const sum = (k: string) => rows.reduce((s, r) => s + r[k], 0);
    const frAll = fraction(sum('fr_met'), sum('fr_met') + sum('fr_missed')); const rsAll = fraction(sum('rs_met'), sum('rs_met') + sum('rs_missed'));
    const label = params.groupBy === 'priority' ? 'Priority' : params.groupBy === 'assignee' ? 'Assignee' : 'Customer';
    const out = rows.map((r) => ({ group: r.grp, tickets: r.tickets, fr_met: r.fr_met, fr_missed: r.fr_missed, fr_pct: fraction(r.fr_met, r.fr_met + r.fr_missed),
      rs_met: r.rs_met, rs_missed: r.rs_missed, rs_pct: fraction(r.rs_met, r.rs_met + r.rs_missed), pending: Math.max(r.fr_pending, r.rs_pending) }));
    const worst = out.filter((r) => r.fr_pct != null || r.rs_pct != null).sort((a, b) => Math.min(a.fr_pct ?? 1, a.rs_pct ?? 1) - Math.min(b.fr_pct ?? 1, b.rs_pct ?? 1))[0];
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from, to },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !sum('tickets') && !rows.length ? 'No tickets were raised in this period'
        : `${pctText(frAll)} of judged first responses and ${pctText(rsAll)} of judged resolutions met their target, across ${plural(rows.reduce((s, r) => s + r.tickets, 0), 'ticket')}`,
      kpis: [{ label: 'Tickets raised', value: rows.reduce((s, r) => s + r.tickets, 0), type: 'integer', status: 'neutral' },
        { label: 'First response met', value: frAll, type: 'percent', status: 'neutral', note: `${sum('fr_met')} of ${sum('fr_met') + sum('fr_missed')} judged` },
        { label: 'Resolution met', value: rsAll, type: 'percent', status: 'neutral', note: `${sum('rs_met')} of ${sum('rs_met') + sum('rs_missed')} judged` },
        { label: 'Targets missed', value: sum('fr_missed') + sum('rs_missed'), type: 'integer', status: sum('fr_missed') + sum('rs_missed') ? 'watch' : 'good' }],
      insights: [worst ? `Lowest attainment: ${worst.group} (first response ${pctText(worst.fr_pct)}, resolution ${pctText(worst.rs_pct)}).` : 'No ticket has been judged against a target yet.',
        ...(sum('fr_pending') + sum('rs_pending') ? [`${sum('fr_pending')} first responses and ${sum('rs_pending')} resolutions are still inside their time and not counted yet.`] : [])],
      columns: [{ key: 'group', label, type: 'text', width: 1.6 }, { key: 'tickets', label: 'Tickets', type: 'integer', width: 0.6 },
        { key: 'fr_met', label: 'First response met', type: 'integer', width: 0.8 }, { key: 'fr_missed', label: 'First response missed', type: 'integer', width: 0.8 }, { key: 'fr_pct', label: 'First response attainment', type: 'percent', width: 0.9 },
        { key: 'rs_met', label: 'Resolution met', type: 'integer', width: 0.8 }, { key: 'rs_missed', label: 'Resolution missed', type: 'integer', width: 0.8 }, { key: 'rs_pct', label: 'Resolution attainment', type: 'percent', width: 0.9 }],
      rows: out.map(({ pending, ...r }) => r), exceptions: out.flatMap((r, i) => (r.fr_missed + r.rs_missed ? [i] : [])),
      notes: ['Targets are in business hours (the site’s calendar), and the clock is paused while a ticket waits on the customer or a third party.',
        'Judged = answered or resolved, plus open tickets already past their target (counted as missed). Tickets still inside their time, and tickets whose priority had no target, are not in the percentages.',
        'Resolving a ticket with no reply counts as its first response. A reopened ticket gets a fresh resolution timer; the first-response result is not reopened.',
        'Tickets are counted by the date they were raised. No attainment goal is assumed.'],
      source: 'Tickets (live query)',
    };
  },
};

const BUCKETS: [string, number, number][] = [['Under 2 days', 0, 2], ['2 to 3 days', 2, 4], ['4 to 7 days', 4, 8], ['8 to 14 days', 8, 15], ['15 days or more', 15, 100_000]];

/** Tickets opened and closed per week or month, and how old the open backlog is today. */
export const ticketVolumeReport: ReportDefinition = {
  id: 'ticket-volume',
  name: 'Ticket volume',
  description: 'Tickets opened, resolved and closed per week or month, the backlog at each period end, and the age of tickets open today.',
  permission: 'tickets.view',
  params: z.object({ facilityId: z.string().uuid().optional(), from: day.optional(), to: day.optional(), interval: z.enum(['week', 'month']).default('week') }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'tickets.view', params.facilityId);
    const { from, to } = period(params, params.interval === 'week' ? 84 : 365);
    const step = params.interval === 'week' ? '1 week' : '1 month';
    const rows = await many(tx, `SELECT b.start::date::text AS period,
        (SELECT count(*)::int FROM ticket t WHERE t.facility_id = ANY ($1) AND t.created_at >= b.start AND t.created_at < b.start + $4::interval) AS opened,
        (SELECT count(*)::int FROM ticket t WHERE t.facility_id = ANY ($1) AND t.resolved_at >= b.start AND t.resolved_at < b.start + $4::interval) AS resolved,
        (SELECT count(*)::int FROM ticket t WHERE t.facility_id = ANY ($1) AND t.closed_at >= b.start AND t.closed_at < b.start + $4::interval) AS closed,
        (SELECT count(*)::int FROM ticket t WHERE t.facility_id = ANY ($1) AND t.created_at < b.start + $4::interval AND (t.resolved_at IS NULL OR t.resolved_at >= b.start + $4::interval)) AS backlog
      FROM generate_series(date_trunc('${params.interval}', $2::date), date_trunc('${params.interval}', $3::date), $4::interval) AS b(start) ORDER BY 1`, [scope.ids, from, to, step]);
    const open = await many(tx, `SELECT extract(epoch FROM (now() - t.created_at)) / 86400.0 AS age FROM ticket t WHERE t.facility_id = ANY ($1) AND t.status NOT IN ('resolved', 'closed') ORDER BY 1`, [scope.ids]);
    const ages = open.map((o) => Number(o.age));
    const median = ages.length ? ages[Math.floor((ages.length - 1) / 2)]! : null;
    const aged = BUCKETS.map(([label, lo, hi]) => ({ age: label, tickets: ages.filter((a) => a >= lo && a < hi).length }));
    const opened = rows.reduce((s, r) => s + r.opened, 0); const resolved = rows.reduce((s, r) => s + r.resolved, 0);
    const over7 = ages.filter((a) => a >= 8).length;
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), period: { from, to },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      headline: !rows.length || (!opened && !open.length) ? 'No tickets in this period' : `${plural(opened, 'ticket')} opened and ${resolved} resolved in the period; ${plural(open.length, 'ticket')} open today${over7 ? `, ${over7} of them more than a week old` : ''}`,
      kpis: [{ label: 'Opened', value: opened, type: 'integer', status: 'neutral' }, { label: 'Resolved', value: resolved, type: 'integer', status: 'neutral' },
        { label: 'Open today', value: open.length, type: 'integer', status: 'neutral' }, { label: 'Open more than a week', value: over7, type: 'integer', status: over7 ? 'watch' : 'good' },
        { label: 'Median age of open tickets', value: median == null ? null : Math.round(median * 10) / 10, type: 'number', note: 'days', status: 'neutral' }],
      insights: [`Backlog by age today: ${aged.map((a) => `${a.age} ${a.tickets}`).join('; ')}.`, ...(open.length ? [`The oldest open ticket is ${Math.floor(ages[ages.length - 1]!)} days old.`] : [])],
      columns: [{ key: 'period', label: params.interval === 'week' ? 'Week starting' : 'Month starting', type: 'date', width: 1 }, { key: 'opened', label: 'Opened', type: 'integer', width: 0.7 },
        { key: 'resolved', label: 'Resolved', type: 'integer', width: 0.7 }, { key: 'closed', label: 'Closed', type: 'integer', width: 0.7 }, { key: 'backlog', label: 'Backlog at period end', type: 'integer', width: 0.9 }],
      rows, exceptions: [],
      charts: [{ kind: 'columns', title: 'Open tickets by age today', category: { key: 'age', label: 'Age' }, series: [{ key: 'tickets', label: 'Tickets' }], valueType: 'integer', data: aged }],
      notes: ['Backlog at period end counts tickets raised before that date and not resolved by it. A ticket that was resolved and later reopened is counted by its latest resolution, so older backlogs can read slightly low.',
        'Age is calendar time since the ticket was raised, not business hours.'],
      source: 'Tickets (live query)',
    };
  },
};

export const ticketReports: ReportDefinition[] = [ticketServiceLevelsReport, ticketVolumeReport];
