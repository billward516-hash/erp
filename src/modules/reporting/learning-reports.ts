import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const DAY = 86_400_000;

export const qualificationStatusReport: ReportDefinition = {
  id: 'qualification-status',
  name: 'Qualification status & expiries',
  description: 'Who holds which qualification, what expires soon, and where too few people are qualified.',
  permission: 'qualifications.view',
  params: z.object({ facilityId: z.string().uuid().optional(), horizonDays: z.coerce.number().int().min(1).max(365).default(60) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'qualifications.view', params.facilityId);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await many(
      tx,
      `SELECT DISTINCT ON (g.employee_id, g.qualification_id)
              g.id, e.id AS employee_id, f.code AS facility, e.first_name || ' ' || e.last_name AS employee, e.job_title,
              q.code, q.name AS qualification, q.safety_critical, g.effective_on, g.expires_on, g.revoked_at, g.origin
       FROM employee_qualification g JOIN employee e ON e.id = g.employee_id JOIN qualification q ON q.id = g.qualification_id
       LEFT JOIN facility f ON f.id = e.facility_id
       WHERE e.status = 'active' AND e.facility_id = ANY ($1)
       ORDER BY g.employee_id, g.qualification_id, g.granted_at DESC`,
      [scope.ids],
    );
    const enriched = rows.map((r) => {
      const days = r.expires_on ? Math.round((Date.parse(r.expires_on) - Date.parse(today)) / DAY) : null;
      const status = r.revoked_at ? 'revoked' : days !== null && days < 0 ? 'expired' : days !== null && days <= params.horizonDays ? 'expiring' : 'active';
      return { ...r, days_to_expiry: days, status, source: r.origin === 'import' ? 'legacy record' : 'platform' };
    }).sort((a, b) => ({ expired: 0, expiring: 1, revoked: 2, active: 3 } as Record<string, number>)[a.status]! - ({ expired: 0, expiring: 1, revoked: 2, active: 3 } as Record<string, number>)[b.status]!
      || (a.days_to_expiry ?? 1e9) - (b.days_to_expiry ?? 1e9));

    // Coverage: for each asset requirement, how many people at that asset's facility hold it today.
    const coverage = await many(
      tx,
      `SELECT a.asset_tag, f.code AS facility, q.code, r.scope,
              (SELECT count(DISTINCT g.employee_id)::int FROM employee_qualification g JOIN employee e ON e.id = g.employee_id
               WHERE g.qualification_id = q.id AND e.facility_id = a.facility_id AND e.status = 'active' AND g.revoked_at IS NULL
                 AND g.effective_on <= current_date AND (g.expires_on IS NULL OR g.expires_on >= current_date)
                 AND g.granted_at = (SELECT max(g2.granted_at) FROM employee_qualification g2 WHERE g2.employee_id = g.employee_id AND g2.qualification_id = q.id)) AS holders
       FROM asset_qualification_requirement r JOIN asset a ON a.id = r.asset_id JOIN qualification q ON q.id = r.qualification_id
       JOIN facility f ON f.id = a.facility_id WHERE a.facility_id = ANY ($1) ORDER BY holders, a.asset_tag`,
      [scope.ids],
    );
    const expired = enriched.filter((r) => r.status === 'expired');
    const expiring = enriched.filter((r) => r.status === 'expiring');
    const thin = coverage.filter((c) => c.holders <= 1);
    const headline = !enriched.length && !coverage.length
      ? 'No qualifications recorded yet'
      : expired.length || expiring.length
        ? `${plural(expiring.length, 'qualification')} expire within ${params.horizonDays} days and ${expired.length} already lapsed` + (thin.length ? `; ${plural(thin.length, 'equipment requirement')} ${thin.length === 1 ? 'rests' : 'rest'} on one person or none` : '')
        : thin.length
          ? `No lapses due, but ${plural(thin.length, 'equipment requirement')} ${thin.length === 1 ? 'rests' : 'rest'} on one qualified person or none`
          : `All ${plural(enriched.length, 'qualification')} current; every restricted asset has backup coverage`;
    const insights: string[] = [];
    for (const c of thin.slice(0, 3)) insights.push(`${c.asset_tag} (${c.facility}) needs ${c.code} to ${c.scope}: ${c.holders === 0 ? 'nobody' : 'only one person'} currently qualified.`);
    const sc = [...expired, ...expiring].filter((r) => r.safety_critical);
    if (sc.length) insights.push(`${plural(sc.length, 'safety-critical qualification')} lapsed or lapsing: ${sc.slice(0, 4).map((r) => `${r.employee} (${r.code})`).join(', ')}.`);
    const legacy = enriched.filter((r) => r.origin === 'import').length;
    if (legacy) insights.push(`${plural(legacy, 'record')} came from legacy imports; their supporting evidence lives in the source system.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Current qualifications', value: enriched.filter((r) => r.status === 'active' || r.status === 'expiring').length, type: 'integer' },
        { label: `Expiring ≤ ${params.horizonDays} days`, value: expiring.length, type: 'integer', status: expiring.length ? 'watch' : 'good' },
        { label: 'Expired', value: expired.length, type: 'integer', status: expired.length ? 'bad' : 'good' },
        { label: 'Requirements with ≤ 1 holder', value: thin.length, type: 'integer', status: thin.length ? 'watch' : 'good', note: `of ${coverage.length} equipment requirements` },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.6 },
        { key: 'employee', label: 'Employee', type: 'text', width: 1.5 },
        { key: 'code', label: 'Qualification', type: 'text', width: 1.1 },
        { key: 'qualification', label: 'Name', type: 'text', width: 2.2 },
        { key: 'status', label: 'Status', type: 'text', width: 0.9 },
        { key: 'effective_on', label: 'Effective', type: 'date', width: 0.9 },
        { key: 'expires_on', label: 'Expires', type: 'date', width: 0.9 },
        { key: 'days_to_expiry', label: 'Days left', type: 'integer', width: 0.7 },
        { key: 'source', label: 'Source', type: 'text', width: 1 },
      ],
      rows: enriched,
      exceptions: enriched.map((r, i) => (r.status === 'expired' || r.status === 'expiring' ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'employee_id', path: '/api/employees/{id}/qualifications' },
      notes: [
        'Status uses the most recent grant per person and qualification. A revoked latest grant counts as revoked even if an older grant is in date.',
        `Expiring = valid today and expiring within ${params.horizonDays} days. "—" in Expires means the qualification does not expire.`,
        'Coverage counts active employees at the asset\'s facility holding a current grant.',
        'Qualification records support compliance; they do not certify regulatory compliance.',
      ],
      source: 'Qualification grants, asset requirements (live query)',
    };
  },
};

export const trainingComplianceReport: ReportDefinition = {
  id: 'training-compliance',
  name: 'Training compliance',
  description: 'Assigned training by status and due date, with overdue exceptions and open content reviews.',
  permission: 'learning.view_records',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'learning.view_records', params.facilityId);
    const rows = await many(
      tx,
      `SELECT n.id, f.code AS facility, e.first_name || ' ' || e.last_name AS employee, c.code, c.title, v.version_no, n.source,
              n.status, n.assigned_at, n.due_on, n.completed_at,
              (n.due_on < current_date AND n.status IN ('assigned', 'in_progress')) AS overdue,
              (SELECT count(*)::int FROM learning_event le WHERE le.course_version_id = v.id) AS events,
              (SELECT count(DISTINCT ec.learning_event_id)::int FROM event_completion ec WHERE ec.enrollment_id = n.id) AS events_done
       FROM enrollment n JOIN employee e ON e.id = n.employee_id JOIN course_version v ON v.id = n.course_version_id JOIN course c ON c.id = v.course_id
       LEFT JOIN facility f ON f.id = e.facility_id
       WHERE n.status <> 'cancelled' AND e.facility_id = ANY ($1)
       ORDER BY overdue DESC, (n.status = 'completed'), n.due_on NULLS LAST, employee`,
      [scope.ids],
    );
    const reviews = await many(tx, `SELECT count(*)::int AS n FROM training_review WHERE status = 'open'`);
    const done = rows.filter((r) => r.status === 'completed').length;
    const overdue = rows.filter((r) => r.overdue);
    const rate = rows.length ? done / rows.length : null;
    const byCourse = new Map<string, number>();
    overdue.forEach((r) => byCourse.set(r.code, (byCourse.get(r.code) ?? 0) + 1));
    const worst = [...byCourse].sort((a, b) => b[1] - a[1])[0];
    const headline = !rows.length ? 'No training assigned in scope'
      : overdue.length ? `${plural(overdue.length, 'assignment')} overdue${worst ? `, most in ${worst[0]} (${worst[1]})` : ''}; ${Math.round(rate! * 100)}% of assigned training complete`
      : `${Math.round(rate! * 100)}% of assigned training complete, none overdue`;
    const insights: string[] = [];
    const retrain = rows.filter((r) => r.source === 'retraining' && r.status !== 'completed').length;
    if (retrain) insights.push(`${plural(retrain, 'retraining assignment')} from document revisions still open.`);
    if (reviews[0]!.n) insights.push(`${plural(reviews[0]!.n, 'training review')} waiting for a decision after procedure changes.`);
    const stalled = rows.filter((r) => r.status === 'in_progress' && r.events_done > 0 && r.events_done < r.events);
    if (stalled.length) insights.push(`${plural(stalled.length, 'person')} part-way through a course; most often waiting on instructor or evaluator sign-off.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Assignments', value: rows.length, type: 'integer' },
        { label: 'Completion rate', value: rate, type: 'percent', status: rate === null ? 'neutral' : rate >= 0.9 ? 'good' : 'watch' },
        { label: 'Overdue', value: overdue.length, type: 'integer', status: overdue.length ? 'bad' : 'good' },
        { label: 'Open content reviews', value: reviews[0]!.n, type: 'integer', status: reviews[0]!.n ? 'watch' : 'neutral' },
      ],
      insights,
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.6 },
        { key: 'employee', label: 'Employee', type: 'text', width: 1.5 },
        { key: 'code', label: 'Course', type: 'text', width: 1 },
        { key: 'title', label: 'Title', type: 'text', width: 2.2 },
        { key: 'version_no', label: 'Ver', type: 'integer', width: 0.4 },
        { key: 'status', label: 'Status', type: 'text', width: 0.9 },
        { key: 'events_done', label: 'Steps done', type: 'integer', width: 0.7 },
        { key: 'events', label: 'of', type: 'integer', width: 0.4 },
        { key: 'due_on', label: 'Due', type: 'date', width: 0.9 },
        { key: 'completed_at', label: 'Completed', type: 'date', width: 0.9 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.overdue ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/enrollments/{id}' },
      notes: [
        'Completed = every learning event satisfied (assessments and practical evaluations passed). Completion does not authorize anyone to work on equipment; see the qualification report.',
        'Overdue = past due date and not completed. Assignments without a due date are never overdue.',
      ],
      source: 'Enrollments and training records (live query)',
    };
  },
};
