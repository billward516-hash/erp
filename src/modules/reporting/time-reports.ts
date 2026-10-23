import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { addDays, OVERTIME_REVIEW_HOURS, weekStartOf } from '../time/service.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

export const laborTimeReport: ReportDefinition = {
  id: 'labor-time',
  name: 'Time and labor',
  description: 'Timesheet completion for recent weeks, hours by type, wrench time (work-order hours as a share of worked hours) and weeks flagged for overtime review.',
  permission: 'reports.view',
  params: z.object({ facilityId: z.string().uuid().optional(), weeks: z.coerce.number().int().min(1).max(26).default(4) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'reports.view', params.facilityId);
    // The last N complete weeks (the current week is still being worked).
    const to = addDays(weekStartOf(new Date().toISOString().slice(0, 10)), -7);
    const from = addDays(to, -7 * (params.weeks - 1));
    const rows = await many(tx, `
      WITH e AS (SELECT id, employee_number, first_name || ' ' || last_name AS name, job_title, facility_id FROM employee WHERE status = 'active' AND facility_id = ANY ($1)),
      s AS (SELECT t.employee_id, t.week_start, t.status,
              coalesce(sum(x.hours) FILTER (WHERE c.kind = 'worked'), 0) AS worked,
              coalesce(sum(x.hours) FILTER (WHERE c.kind = 'paid_leave'), 0) AS leave,
              coalesce(sum(x.hours) FILTER (WHERE x.source = 'work_order'), 0) AS wo,
              coalesce(sum(x.hours) FILTER (WHERE x.earning_code = 'OT'), 0) AS ot
            FROM timesheet t LEFT JOIN time_entry x ON x.timesheet_id = t.id LEFT JOIN earning_code c ON c.code = x.earning_code AND c.tenant_id = x.tenant_id
            WHERE t.week_start BETWEEN $2 AND $3 GROUP BY t.employee_id, t.week_start, t.status)
      SELECT e.id, e.employee_number, e.name, e.job_title, f.code AS facility,
             count(s.week_start) FILTER (WHERE s.status IN ('approved', 'exported'))::int AS approved_weeks,
             count(s.week_start) FILTER (WHERE s.status = 'submitted')::int AS waiting_weeks,
             coalesce(sum(s.worked) FILTER (WHERE s.status IN ('submitted', 'approved', 'exported')), 0)::float AS worked,
             coalesce(sum(s.leave) FILTER (WHERE s.status IN ('submitted', 'approved', 'exported')), 0)::float AS leave,
             coalesce(sum(s.wo) FILTER (WHERE s.status IN ('submitted', 'approved', 'exported')), 0)::float AS wo_hours,
             count(*) FILTER (WHERE s.worked > $4 AND s.ot = 0)::int AS ot_review_weeks
      FROM e JOIN facility f ON f.id = e.facility_id LEFT JOIN s ON s.employee_id = e.id
      GROUP BY e.id, e.employee_number, e.name, e.job_title, f.code ORDER BY f.code, e.name`, [scope.ids, from, to, OVERTIME_REVIEW_HOURS]);
    const enriched = rows.map((r) => ({ ...r, missing_weeks: params.weeks - r.approved_weeks - r.waiting_weeks, wrench_time: r.worked ? r.wo_hours / r.worked : null }));
    const expected = rows.length * params.weeks;
    const approved = rows.reduce((s, r) => s + r.approved_weeks, 0);
    const waiting = rows.reduce((s, r) => s + r.waiting_weeks, 0);
    const completion = expected ? approved / expected : null;
    // Wrench time is a craft measure: only people who booked work-order hours in the period count.
    const craft = rows.filter((r) => r.wo_hours > 0);
    const worked = craft.reduce((s, r) => s + r.worked, 0);
    const wo = craft.reduce((s, r) => s + r.wo_hours, 0);
    const wrench = worked ? wo / worked : null;
    const otWeeks = rows.reduce((s, r) => s + r.ot_review_weeks, 0);
    const missing = enriched.filter((r) => r.missing_weeks > 0);
    const headline = !rows.length ? 'No active employees in scope'
      : `${pct(completion)} of timesheets approved for the last ${plural(params.weeks, 'week')}${waiting ? `; ${waiting} waiting for a supervisor` : ''}`;
    const insights: string[] = [];
    if (missing.length) insights.push(`${missing.length} ${missing.length === 1 ? 'person' : 'people'} with weeks not submitted: ${missing.slice(0, 4).map((r) => r.name).join(', ')}${missing.length > 4 ? '…' : ''}.`);
    if (wrench !== null) insights.push(`Technicians booked ${pct(wrench)} of their worked hours to work orders (${Math.round(wo)} of ${Math.round(worked)} h, ${craft.length} ${craft.length === 1 ? 'person' : 'people'} with work-order time).`);
    if (otWeeks) insights.push(`${plural(otWeeks, 'week')} over ${OVERTIME_REVIEW_HOURS} worked hours without overtime coded; review before payroll.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      period: { from, to: addDays(to, 6) }, scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Timesheets approved', value: completion, type: 'percent', note: `${approved} of ${expected}`, status: completion === null ? 'neutral' : completion >= 0.95 ? 'good' : completion >= 0.8 ? 'watch' : 'bad' },
        { label: 'Waiting for a supervisor', value: waiting, type: 'integer', status: waiting ? 'watch' : 'good' },
        { label: 'Wrench time', value: wrench, type: 'percent', note: 'technicians: work-order ÷ worked hours', status: 'neutral' },
        { label: 'Overtime review', value: otWeeks, type: 'integer', note: `weeks over ${OVERTIME_REVIEW_HOURS} h`, status: otWeeks ? 'watch' : 'good' },
      ],
      insights,
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'employee_number', label: 'Employee', type: 'text', width: 0.7 },
        { key: 'name', label: 'Name', type: 'text', width: 1.4 },
        { key: 'job_title', label: 'Job', type: 'text', width: 1.3 },
        { key: 'approved_weeks', label: 'Weeks approved', type: 'integer', width: 0.7 },
        { key: 'waiting_weeks', label: 'Waiting', type: 'integer', width: 0.6 },
        { key: 'missing_weeks', label: 'Not submitted', type: 'integer', width: 0.7 },
        { key: 'worked', label: 'Worked', type: 'hours', unit: 'h', width: 0.6 },
        { key: 'leave', label: 'Paid leave', type: 'hours', unit: 'h', width: 0.6 },
        { key: 'wo_hours', label: 'Work orders', type: 'hours', unit: 'h', width: 0.7 },
        { key: 'wrench_time', label: 'Wrench time', type: 'percent', width: 0.7 },
        { key: 'ot_review_weeks', label: 'OT review', type: 'integer', width: 0.6 },
      ],
      rows: enriched,
      exceptions: enriched.map((r, i) => (r.missing_weeks > 0 || r.ot_review_weeks > 0 ? i : -1)).filter((i) => i >= 0),
      notes: [
        `Weeks: ${from} to ${addDays(to, 6)} (Monday to Sunday). The current week is excluded.`,
        'Hours count from submitted, approved and exported timesheets. Wrench time = hours booked to work orders ÷ worked hours, for people who booked any work-order time in the period; it is only as complete as technicians\' labor entries.',
        `Overtime is not calculated: weeks over ${OVERTIME_REVIEW_HOURS} worked hours without overtime coded are flagged for review under your pay policy. The payroll provider calculates pay.`,
      ],
      source: 'Timesheets, time entries and work-order labor (live query)',
    };
  },
};
