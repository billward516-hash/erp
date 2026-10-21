import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const STAGE: Record<string, string> = {
  draft: 'Draft', review: 'In review', approved: 'Implementing', startup_review: 'Pre-startup review', in_service: 'In service, closeout pending',
};

export const mocRegisterReport: ReportDefinition = {
  id: 'moc-register',
  name: 'Management of change register',
  description: 'Open changes by stage and age, overdue actions, and temporary changes nearing or past their end date.',
  permission: 'moc.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'moc.view', params.facilityId);
    const rows = await many(
      tx,
      `SELECT c.id, c.number, f.code AS facility, c.title, c.change_type, c.status, c.risk_level, c.is_temporary, c.temporary_until, c.revision,
              u.display_name AS owner, round(extract(epoch FROM now() - c.created_at) / 86400.0)::int AS age_days,
              (SELECT count(*)::int FROM moc_action a WHERE a.change_id = c.id AND a.status = 'open') AS open_actions,
              (SELECT count(*)::int FROM moc_action a WHERE a.change_id = c.id AND a.status = 'open' AND a.due_on < current_date) AS overdue_actions,
              (c.is_temporary AND c.temporary_until < current_date) AS temp_expired,
              (c.is_temporary AND c.temporary_until BETWEEN current_date AND current_date + 14) AS temp_expiring,
              (SELECT string_agg(DISTINCT s.label, ', ') FROM approval_request r JOIN approval_step s ON s.request_id = r.id
                WHERE r.subject_id = c.id AND r.status = 'pending' AND s.status = 'pending'
                  AND s.stage = (SELECT min(x.stage) FROM approval_step x WHERE x.request_id = r.id AND x.status = 'pending')) AS waiting_on
       FROM moc_change c JOIN facility f ON f.id = c.facility_id JOIN app_user u ON u.id = c.owner_user_id
       WHERE c.facility_id = ANY ($1) AND c.status NOT IN ('closed', 'cancelled', 'rejected')
       ORDER BY (c.is_temporary AND c.temporary_until < current_date) DESC, c.risk_level = 'high' DESC, c.created_at`,
      [scope.ids],
    );
    const enriched = rows.map((r) => ({ ...r, stage: STAGE[r.status] ?? r.status, temporary: r.is_temporary ? `until ${r.temporary_until}` : 'No' }));
    const expired = rows.filter((r) => r.temp_expired);
    const expiring = rows.filter((r) => r.temp_expiring);
    const overdue = rows.reduce((s, r) => s + r.overdue_actions, 0);
    const inService = rows.filter((r) => r.status === 'in_service');
    const highOpen = rows.filter((r) => r.risk_level === 'high' && ['approved', 'startup_review'].includes(r.status));
    const headline = !rows.length ? 'No open changes in scope'
      : expired.length ? `${plural(expired.length, 'temporary change')} past ${expired.length === 1 ? 'its' : 'their'} end date; ${plural(rows.length, 'change')} open`
      : overdue ? `${plural(overdue, 'change action')} overdue across ${plural(rows.length, 'open change')}`
      : `${plural(rows.length, 'open change')}, no overdue actions`;
    const insights: string[] = [];
    if (expiring.length) insights.push(`${plural(expiring.length, 'temporary change')} ${expiring.length === 1 ? 'ends' : 'end'} within 14 days: ${expiring.map((r) => r.number).join(', ')}.`);
    if (highOpen.length) insights.push(`${plural(highOpen.length, 'high-risk change')} approved but not yet through pre-startup review.`);
    const waiting = rows.filter((r) => r.waiting_on);
    if (waiting.length) insights.push(`${plural(waiting.length, 'change')} waiting on sign-off: ${waiting.slice(0, 3).map((r) => `${r.number} (${r.waiting_on})`).join('; ')}.`);
    if (inService.length) insights.push(`${plural(inService.length, 'change')} in service with closeout actions still open.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Open changes', value: rows.length, type: 'integer' },
        { label: 'High risk open', value: rows.filter((r) => r.risk_level === 'high').length, type: 'integer', status: 'neutral' },
        { label: 'Overdue actions', value: overdue, type: 'integer', status: overdue ? 'bad' : 'good' },
        { label: 'Temporary past end date', value: expired.length, type: 'integer', status: expired.length ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'MOC', type: 'text', width: 1 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'title', label: 'Title', type: 'text', width: 2.6 },
        { key: 'risk_level', label: 'Risk', type: 'text', width: 0.6 },
        { key: 'stage', label: 'Stage', type: 'text', width: 1.4 },
        { key: 'waiting_on', label: 'Waiting on', type: 'text', width: 1.6 },
        { key: 'open_actions', label: 'Open actions', type: 'integer', width: 0.7 },
        { key: 'overdue_actions', label: 'Overdue', type: 'integer', width: 0.6 },
        { key: 'temporary', label: 'Temporary', type: 'text', width: 1 },
        { key: 'age_days', label: 'Age', type: 'integer', unit: 'days', width: 0.6 },
      ],
      rows: enriched,
      exceptions: enriched.map((r, i) => (r.temp_expired || r.overdue_actions > 0 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/moc/{id}' },
      notes: [
        'Open = not closed, cancelled or rejected. A change in service stays open until its closeout actions (e.g. restoring a temporary change) are done.',
        'Risk and required reviews come from the screening answers (rule set recorded on each change).',
        'This register supports the site\'s management-of-change procedure; it does not determine regulatory applicability.',
      ],
      source: 'Management of change records (live query)',
    };
  },
};
