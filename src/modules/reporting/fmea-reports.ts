import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

export const fmeaRiskReport: ReportDefinition = {
  id: 'fmea-risk',
  name: 'FMEA risk register',
  description: 'High-priority failure modes still open across approved and draft FMEAs, recommended actions overdue, FMEAs past their review date, and equipment failure modes that happened more often than rated.',
  permission: 'quality.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'quality.view', params.facilityId);
    const fmeas = await many(tx, `SELECT f.id, f.number, f.revision, f.kind, f.status, f.review_due, f.asset_id, (f.status = 'approved' AND f.review_due < current_date) AS review_overdue
      FROM fmea f WHERE f.facility_id = ANY ($1) AND f.status <> 'superseded'`, [scope.ids]);
    const rows = await many(tx, `
      SELECT r.id, f.id AS fmea_id, f.number, f.revision, f.kind, f.status AS fmea_status, fc.code AS facility, coalesce(a.asset_tag, p.part_number) AS subject, r.seq, r.item, r.failure_mode,
             r.severity, r.occurrence, r.detection, r.priority, r.post_priority, coalesce(r.post_priority, r.priority) AS current_priority, r.failure_code,
             (SELECT count(*)::int FROM action_item x WHERE x.fmea_row_id = r.id AND x.status = 'open') AS open_actions,
             (SELECT count(*)::int FROM action_item x WHERE x.fmea_row_id = r.id AND x.status = 'open' AND x.due_date < current_date) AS late_actions,
             (SELECT count(*)::int FROM work_order w WHERE w.asset_id = f.asset_id AND w.wo_type = 'corrective' AND w.failure_code = r.failure_code AND w.created_at > now() - interval '365 days') AS observed
      FROM fmea_row r JOIN fmea f ON f.id = r.fmea_id JOIN facility fc ON fc.id = f.facility_id LEFT JOIN asset a ON a.id = f.asset_id LEFT JOIN part p ON p.id = f.part_id
      WHERE f.facility_id = ANY ($1) AND f.status <> 'superseded'
      ORDER BY CASE coalesce(r.post_priority, r.priority) WHEN 'H' THEN 0 WHEN 'M' THEN 1 ELSE 2 END, r.severity DESC, f.number, r.seq`, [scope.ids]);
    const high = rows.filter((r) => r.current_priority === 'H');
    const reduced = rows.filter((r) => r.post_priority && r.post_priority !== r.priority);
    const late = rows.reduce((s, r) => s + r.late_actions, 0);
    const reviewLate = fmeas.filter((f) => f.review_overdue);
    const underrated = rows.filter((r) => r.failure_code && r.observed >= 2 && r.occurrence <= 3);
    const headline = !fmeas.length ? 'No FMEAs in scope'
      : `${plural(high.length, 'high-priority failure mode')} open across ${plural(fmeas.length, 'FMEA')}${late ? `; ${plural(late, 'recommended action')} overdue` : ''}`;
    const insights: string[] = [];
    if (rows.length) insights.push(`${rows.filter((r) => r.priority === 'H').length} rated high at analysis; ${reduced.length} reduced after their actions were evaluated.`);
    if (underrated.length) insights.push(`Happening more than rated: ${underrated.slice(0, 3).map((r) => `${r.subject} "${r.failure_mode}" (${r.observed} failures in 12 months, occurrence ${r.occurrence})`).join('; ')}. Revise the FMEA.`);
    if (reviewLate.length) insights.push(`${plural(reviewLate.length, 'FMEA')} past the review date: ${reviewLate.slice(0, 4).map((f) => f.number).join(', ')}.`);
    const drafts = fmeas.filter((f) => ['draft', 'in_review'].includes(f.status));
    if (drafts.length) insights.push(`${plural(drafts.length, 'FMEA')} in draft or review: ${drafts.slice(0, 4).map((f) => `${f.number} rev ${f.revision}`).join(', ')}.`);
    const out = rows.map((r) => ({ ...r, rpn: r.severity * r.occurrence * r.detection, fmea: `${r.number} rev ${r.revision}`, kind: r.kind[0].toUpperCase() + r.kind.slice(1),
      observed: r.failure_code ? r.observed : null }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'FMEAs', value: fmeas.length, type: 'integer', status: 'neutral' },
        { label: 'High priority open', value: high.length, type: 'integer', status: high.length ? 'bad' : 'good' },
        { label: 'Reduced by actions', value: reduced.length, type: 'integer', status: 'neutral' },
        { label: 'Actions overdue', value: late, type: 'integer', status: late ? 'bad' : 'good' },
        { label: 'Past review date', value: reviewLate.length, type: 'integer', status: reviewLate.length ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'fmea', label: 'FMEA', type: 'text', width: 0.9 },
        { key: 'kind', label: 'Kind', type: 'text', width: 0.6 },
        { key: 'subject', label: 'Asset / part', type: 'text', width: 0.8 },
        { key: 'item', label: 'Item', type: 'text', width: 1.1 },
        { key: 'failure_mode', label: 'Failure mode', type: 'text', width: 1.6 },
        { key: 'severity', label: 'S', type: 'integer', width: 0.3 },
        { key: 'occurrence', label: 'O', type: 'integer', width: 0.3 },
        { key: 'detection', label: 'D', type: 'integer', width: 0.3 },
        { key: 'priority', label: 'Priority', type: 'text', width: 0.5 },
        { key: 'post_priority', label: 'After actions', type: 'text', width: 0.6 },
        { key: 'open_actions', label: 'Open actions', type: 'integer', width: 0.5 },
        { key: 'observed', label: 'Failures (12 m)', type: 'integer', width: 0.6 },
      ],
      rows: out,
      exceptions: out.map((r, i) => (r.current_priority === 'H' || r.late_actions > 0 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'fmea_id', path: '/api/fmeas/{fmea_id}' },
      notes: [
        'Priority is the action priority (AIAG-VDA 2019 table) or, for FMEAs set to RPN, high at or above the FMEA\'s threshold and medium at half of it. RPN is shown for reference only.',
        'After actions = the priority from the scores recorded once the row\'s recommended actions were completed.',
        'Failures (12 m) counts corrective work orders on the FMEA\'s asset with the row\'s failure code; equipment FMEAs only.',
      ],
      source: 'FMEAs, actions and work order failure history (live query)',
    };
  },
};
