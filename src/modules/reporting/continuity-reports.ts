import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { assessPlan } from '../continuity/service.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

export const continuityReadinessReport: ReportDefinition = {
  id: 'continuity-readiness',
  name: 'Continuity readiness',
  description: 'Critical processes with an approved continuity plan, whether each has recovered within its RTO in a timed exercise, reviews and exercises overdue, and gaps found in live records (skills, people, suppliers, equipment).',
  permission: 'continuity.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'continuity.view', params.facilityId);
    const plans = await many(tx, `SELECT p.*, f.code AS facility, u.display_name AS owner_name,
        (SELECT count(*)::int FROM action_item x WHERE x.subject_type = 'continuity_plan' AND x.subject_id = p.id AND x.status = 'open') AS open_actions
      FROM continuity_plan p JOIN facility f ON f.id = p.facility_id JOIN app_user u ON u.id = p.owner_user_id
      WHERE p.facility_id = ANY ($1) AND p.status <> 'superseded'
      ORDER BY CASE p.criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, p.number`, [scope.ids]);
    const rows = [];
    for (const p of plans) {
      const a = await assessPlan(tx, p);
      const high = a.gaps.filter((g) => g.severity === 'high');
      rows.push({
        id: p.id, plan: `${p.number} rev ${p.revision}`, facility: p.facility, process: p.process, criticality: p.criticality[0].toUpperCase() + p.criticality.slice(1),
        status: p.status.replace(/_/g, ' '), owner: p.owner_name, rto_hours: Number(p.rto_hours), demonstrated_hours: a.readiness.demonstratedHours, best_hours: a.readiness.bestTimedHours,
        last_exercise: a.readiness.lastExercise, exercise_due: a.readiness.exerciseDue, review_due: p.review_due, high_gaps: high.length, gaps: a.gaps.length, open_actions: p.open_actions,
        top_gap: (high[0] ?? a.gaps[0])?.text ?? null, approved: p.status === 'approved', _gaps: a.gaps,
      });
    }
    const approved = rows.filter((r) => r.approved);
    const demonstrated = approved.filter((r) => r.demonstrated_hours != null);
    const withHigh = rows.filter((r) => r.high_gaps > 0);
    const today = new Date().toISOString().slice(0, 10);
    const reviewLate = approved.filter((r) => r.review_due && String(r.review_due) < today);
    const exerciseLate = approved.filter((r) => r.exercise_due && r.exercise_due < today);
    const headline = !rows.length ? 'No continuity plans in scope'
      : `Recovery within the RTO shown in a timed exercise for ${demonstrated.length} of ${plural(approved.length, 'approved plan')}; ${plural(withHigh.length, 'plan')} with high gaps`;
    const insights: string[] = [];
    const byArea = new Map<string, number>();
    for (const r of rows) for (const g of r._gaps.filter((x: any) => x.severity === 'high')) byArea.set(g.area, (byArea.get(g.area) ?? 0) + 1);
    if (byArea.size) insights.push(`High gaps by area: ${[...byArea].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
    for (const r of withHigh.slice(0, 2)) insights.push(`${r.plan} (${r.process}): ${r.top_gap}.`);
    const notDemo = approved.filter((r) => r.demonstrated_hours == null);
    if (notDemo.length) insights.push(`RTO not yet demonstrated: ${notDemo.slice(0, 4).map((r) => `${r.plan} (${r.rto_hours} h${r.best_hours != null ? `, best ${r.best_hours} h` : ''})`).join(', ')}.`);
    if (reviewLate.length || exerciseLate.length) insights.push(`${plural(reviewLate.length, 'review')} and ${plural(exerciseLate.length, 'exercise')} overdue.`);
    const drafts = rows.filter((r) => !r.approved);
    if (drafts.length) insights.push(`${plural(drafts.length, 'plan')} in draft or review: ${drafts.slice(0, 4).map((r) => r.plan).join(', ')}.`);
    const out = rows.map(({ _gaps, approved: _a, ...r }) => r);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Plans', value: rows.length, type: 'integer', status: 'neutral', note: `${approved.length} approved` },
        { label: 'RTO demonstrated', value: demonstrated.length, type: 'integer', status: demonstrated.length === approved.length ? 'good' : 'watch', note: `of ${approved.length} approved` },
        { label: 'Plans with high gaps', value: withHigh.length, type: 'integer', status: withHigh.length ? 'bad' : 'good' },
        { label: 'Reviews overdue', value: reviewLate.length, type: 'integer', status: reviewLate.length ? 'watch' : 'good' },
        { label: 'Exercises overdue', value: exerciseLate.length, type: 'integer', status: exerciseLate.length ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'plan', label: 'Plan', type: 'text', width: 0.8 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.4 },
        { key: 'process', label: 'Critical process', type: 'text', width: 1.3 },
        { key: 'criticality', label: 'Criticality', type: 'text', width: 0.6 },
        { key: 'status', label: 'Status', type: 'text', width: 0.6 },
        { key: 'rto_hours', label: 'RTO', type: 'hours', unit: 'h', width: 0.4 },
        { key: 'demonstrated_hours', label: 'Recovered in', type: 'hours', unit: 'h', width: 0.5 },
        { key: 'last_exercise', label: 'Last exercise', type: 'date', width: 0.6 },
        { key: 'exercise_due', label: 'Exercise due', type: 'date', width: 0.6 },
        { key: 'review_due', label: 'Review due', type: 'date', width: 0.6 },
        { key: 'high_gaps', label: 'High gaps', type: 'integer', width: 0.4 },
        { key: 'open_actions', label: 'Open actions', type: 'integer', width: 0.4 },
        { key: 'top_gap', label: 'Top gap', type: 'text', width: 2 },
      ],
      rows: out,
      exceptions: out.map((r, i) => (r.high_gaps > 0 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/continuity-plans/{id}' },
      notes: [
        'Recovered in = the most recent timed exercise (simulation or full test) that recovered within the RTO. Tabletop and walkthrough exercises check the plan but do not time a recovery.',
        'Gaps are checked against live records when the report runs: current qualification holders at the site, employee and supplier status, sole-source parts, and equipment state.',
        'Exercise due = last completed exercise (or approval, if never exercised) plus the plan\'s exercise interval.',
      ],
      source: 'Continuity plans, exercises, actions, qualifications, suppliers and asset state (live query)',
    };
  },
};
