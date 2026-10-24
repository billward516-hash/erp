import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { limitText } from '../lab/spec.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const STATUS: Record<string, string> = { received: 'Received', in_testing: 'In testing', in_review: 'In review', released: 'Released', on_hold: 'On hold', disposed: 'Disposed' };
const params = z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(730).default(90) });
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor((s.length - 1) / 2); return s.length % 2 ? s[m]! : (s[m]! + s[m + 1]!) / 2; };
const d = (v: unknown) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
const NOTE_RECORDS = 'These are records to support the laboratory’s own quality system; they do not show conformity with any accreditation standard.';

export const labTurnaroundReport: ReportDefinition = {
  id: 'lab-turnaround',
  name: 'Lab turnaround',
  description: 'Samples received in the period: days from receipt to release against each sample’s turnaround target, and samples still open past their target.',
  permission: 'lab.view',
  params,
  async run(tx, actor, p): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'lab.view', p.facilityId);
    const rows = await many(tx, `SELECT s.id, s.number, f.code AS facility, coalesce(c.name, CASE s.source WHEN 'internal' THEN 'Internal' ELSE 'Customer (not recorded)' END) AS customer, s.description, s.status,
        s.received_on, s.due_on, s.released_at::date AS released_on, (s.released_at::date - s.received_on) AS days_to_release,
        CASE WHEN s.status = 'released' THEN GREATEST(s.released_at::date - s.due_on, 0) WHEN s.status <> 'disposed' THEN GREATEST(current_date - s.due_on, 0) ELSE 0 END AS days_late,
        (s.status NOT IN ('released', 'disposed') AND s.due_on < current_date) AS overdue, (s.status = 'released' AND s.released_at::date > s.due_on) AS released_late
      FROM lab_sample s JOIN facility f ON f.id = s.facility_id LEFT JOIN customer c ON c.id = s.customer_id
      WHERE s.facility_id = ANY ($1) AND (s.received_on >= current_date - $2::int OR (s.status NOT IN ('released', 'disposed') AND s.due_on < current_date)) ORDER BY overdue DESC, s.due_on, s.number`, [scope.ids, p.days]);
    const released = rows.filter((r) => r.status === 'released');
    const onTime = released.filter((r) => !r.released_late).length;
    const overdue = rows.filter((r) => r.overdue);
    const med = median(released.map((r) => Number(r.days_to_release)));
    const open = rows.filter((r) => !['released', 'disposed'].includes(r.status));
    const out = rows.map((r) => ({ id: r.id, number: r.number, facility: r.facility, customer: r.customer, description: r.description, status: STATUS[r.status] ?? r.status, received_on: d(r.received_on), due_on: d(r.due_on),
      released_on: d(r.released_on), days_to_release: r.days_to_release == null ? null : Number(r.days_to_release), days_late: Number(r.days_late) }));
    const insights: string[] = [];
    if (released.length) insights.push(`${onTime} of ${plural(released.length, 'released sample')} were released on or before their target${med != null ? `; the median is ${med} days from receipt to release` : ''}.`);
    if (overdue.length) insights.push(`${plural(overdue.length, 'sample')} still open past the target, the oldest ${overdue[0]!.number} (${overdue[0]!.days_late} days late).`);
    const held = rows.filter((r) => r.status === 'on_hold').length;
    if (held) insights.push(`${plural(held, 'sample')} on hold.`);
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: p,
      period: { from: new Date(Date.now() - p.days * 86_400_000).toISOString(), to: new Date().toISOString() },
      headline: !rows.length ? 'No lab samples in scope' : `${plural(overdue.length, 'sample')} past the turnaround target; ${released.length ? `${Math.round((onTime / released.length) * 100)}% of released samples on time` : 'none released yet in the period'}`,
      kpis: [
        { label: 'Samples', value: rows.length, type: 'integer', status: 'neutral', note: `${open.length} open` },
        { label: 'Released', value: released.length, type: 'integer', status: 'neutral' },
        { label: 'Released on time', value: released.length ? onTime / released.length : null, type: 'percent', status: released.length && onTime / released.length < 0.9 ? 'watch' : 'good' },
        { label: 'Median days to release', value: med, type: 'number', status: 'neutral' },
        { label: 'Open past target', value: overdue.length, type: 'integer', status: overdue.length ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'Sample', type: 'text', width: 0.8 }, { key: 'facility', label: 'Site', type: 'text', width: 0.4 }, { key: 'customer', label: 'Customer', type: 'text', width: 1.1 },
        { key: 'description', label: 'Description', type: 'text', width: 1.6 }, { key: 'status', label: 'Status', type: 'text', width: 0.7 }, { key: 'received_on', label: 'Received', type: 'date', width: 0.7 },
        { key: 'due_on', label: 'Target', type: 'date', width: 0.7 }, { key: 'released_on', label: 'Released', type: 'date', width: 0.7 },
        { key: 'days_to_release', label: 'Days to release', type: 'integer', width: 0.5 }, { key: 'days_late', label: 'Days late', type: 'integer', width: 0.5 },
      ],
      rows: out, exceptions: out.map((r, i) => (r.days_late > 0 ? i : -1)).filter((i) => i >= 0), drillDown: { rowKey: 'id', path: '/api/lab/samples/{id}' },
      notes: ['Samples received in the period, plus any still open past their target. Days to release run from the received date to the release date.', 'Days late: for a released sample, days after the target it was released; for an open one, days past the target so far.', NOTE_RECORDS],
      source: 'Lab samples (live query)',
    };
  },
};

export const labOosReport: ReportDefinition = {
  id: 'lab-oos',
  name: 'Lab out-of-specification investigations',
  description: 'Out-of-specification results opened in the period with their cause, decision and any nonconformance or corrective action, counted by method and analyte.',
  permission: 'lab.view',
  params,
  async run(tx, actor, p): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'lab.view', p.facilityId);
    const inv = await many(tx, `SELECT i.id, i.number, i.status, i.decision, i.cause, i.opened_at, i.closed_at, s.id AS sample_id, s.number AS sample, f.code AS facility, m.code || ' v' || m.version AS method, m.code AS method_code,
        r.analyte_name AS analyte, r.value::float AS value, r.unit, r.spec_low, r.spec_high, n.number AS ncr, ca.number AS capa
      FROM lab_investigation i JOIN lab_sample s ON s.id = i.sample_id JOIN facility f ON f.id = i.facility_id JOIN lab_test t ON t.id = i.test_id JOIN lab_method m ON m.id = t.method_id
      JOIN lab_result r ON r.id = i.result_id LEFT JOIN nonconformance n ON n.id = i.ncr_id LEFT JOIN corrective_action ca ON ca.id = i.capa_id
      WHERE i.facility_id = ANY ($1) AND (i.opened_at >= now() - make_interval(days => $2) OR i.status = 'open') ORDER BY (i.status = 'closed'), i.opened_at DESC`, [scope.ids, p.days]);
    const open = inv.filter((i) => i.status === 'open');
    const confirmed = inv.filter((i) => i.decision === 'confirmed_oos');
    const invalidated = inv.filter((i) => i.decision === 'invalidated');
    const tally = (key: (i: any) => string) => [...inv.reduce((m, i) => m.set(key(i), (m.get(key(i)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    const byMethod = tally((i) => i.method_code), byAnalyte = tally((i) => `${i.method_code} · ${i.analyte}`);
    const out = inv.map((i) => ({ id: i.sample_id, number: i.number, sample: i.sample, facility: i.facility, method: i.method, analyte: i.analyte, result: `${i.value} ${i.unit}`, limits: `${limitText(i.spec_low, i.spec_high)} ${i.unit}`,
      status: i.status === 'open' ? 'Open' : 'Closed', decision: i.decision === 'confirmed_oos' ? 'Confirmed OOS' : i.decision === 'invalidated' ? 'Invalidated' : null, cause: i.cause, opened: d(i.opened_at), closed: d(i.closed_at), quality_record: i.ncr ?? i.capa ?? null }));
    const insights: string[] = [];
    if (byMethod[0]) insights.push(`Most investigations: ${byMethod[0][0]} (${byMethod[0][1]}).`);
    if (byAnalyte[0] && byAnalyte[0][1] > 1) insights.push(`Repeat analyte: ${byAnalyte[0][0]} on ${byAnalyte[0][1]} investigations.`);
    if (invalidated.length) insights.push(`${plural(invalidated.length, 'result')} invalidated; ${plural(confirmed.length, 'result')} confirmed out of specification.`);
    const unraised = confirmed.filter((i) => !i.ncr && !i.capa);
    if (unraised.length) insights.push(`${plural(unraised.length, 'confirmed result')} with no nonconformance or corrective action raised: ${unraised.slice(0, 4).map((i) => i.number).join(', ')}.`);
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: p,
      period: { from: new Date(Date.now() - p.days * 86_400_000).toISOString(), to: new Date().toISOString() },
      headline: !inv.length ? 'No out-of-specification investigations in scope' : `${plural(open.length, 'investigation')} open; ${confirmed.length} confirmed and ${invalidated.length} invalidated`,
      kpis: [
        { label: 'Investigations', value: inv.length, type: 'integer', status: 'neutral' }, { label: 'Open', value: open.length, type: 'integer', status: open.length ? 'bad' : 'good' },
        { label: 'Confirmed OOS', value: confirmed.length, type: 'integer', status: confirmed.length ? 'watch' : 'good' }, { label: 'Invalidated', value: invalidated.length, type: 'integer', status: 'neutral' },
        { label: 'Raised in Quality', value: confirmed.length - unraised.length, type: 'integer', status: unraised.length ? 'watch' : 'good', note: `of ${confirmed.length} confirmed` },
      ],
      insights: insights.slice(0, 5),
      charts: byMethod.length ? [{ kind: 'bars', title: 'Investigations by method', category: { key: 'method', label: 'Method' }, series: [{ key: 'investigations', label: 'Investigations' }], valueType: 'integer',
        data: byMethod.slice(0, 10).map(([method, investigations]) => ({ method, investigations })) }] : undefined,
      columns: [
        { key: 'number', label: 'Investigation', type: 'text', width: 0.8 }, { key: 'sample', label: 'Sample', type: 'text', width: 0.8 }, { key: 'facility', label: 'Site', type: 'text', width: 0.4 },
        { key: 'method', label: 'Method', type: 'text', width: 0.8 }, { key: 'analyte', label: 'Analyte', type: 'text', width: 0.9 }, { key: 'result', label: 'Result', type: 'text', width: 0.7 },
        { key: 'limits', label: 'Specification', type: 'text', width: 0.9 }, { key: 'status', label: 'Status', type: 'text', width: 0.5 }, { key: 'decision', label: 'Decision', type: 'text', width: 0.8 },
        { key: 'cause', label: 'Cause', type: 'text', width: 1.6 }, { key: 'quality_record', label: 'Quality record', type: 'text', width: 0.7 },
      ],
      rows: out, exceptions: out.map((r, i) => (r.status === 'Open' ? i : -1)).filter((i) => i >= 0), drillDown: { rowKey: 'id', path: '/api/lab/samples/{id}' },
      notes: ['Investigations opened in the period, plus any still open. An investigation is opened automatically when a result is outside its specification and must be closed before the sample is released.',
        'Quality record: the nonconformance or corrective action raised from a confirmed result, one per investigation.', NOTE_RECORDS],
      source: 'Lab investigations, results, methods and Quality records (live query)',
    };
  },
};

export const labWorkloadReport: ReportDefinition = {
  id: 'lab-workload',
  name: 'Lab workload',
  description: 'Tests by analyst and method in the period: results entered, tests reviewed, results out of specification, and tests still waiting.',
  permission: 'lab.view',
  params,
  async run(tx, actor, p): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'lab.view', p.facilityId);
    const rows = await many(tx, `SELECT coalesce(u.display_name, 'Unassigned') AS analyst, m.code || ' v' || m.version AS method, f.code AS facility,
        count(*) FILTER (WHERE t.status <> 'cancelled')::int AS tests, count(*) FILTER (WHERE t.status = 'assigned')::int AS waiting_results,
        count(*) FILTER (WHERE t.status = 'entered')::int AS waiting_review, count(*) FILTER (WHERE t.status = 'reviewed')::int AS reviewed,
        coalesce(sum((SELECT count(*) FROM lab_result r WHERE r.test_id = t.id AND r.superseded_at IS NULL)), 0)::int AS results,
        coalesce(sum((SELECT count(*) FROM lab_result r WHERE r.test_id = t.id AND r.superseded_at IS NULL AND r.outcome = 'fail')), 0)::int AS out_of_spec
      FROM lab_test t JOIN lab_method m ON m.id = t.method_id JOIN facility f ON f.id = t.facility_id LEFT JOIN app_user u ON u.id = coalesce(t.entered_by, t.assigned_user_id)
      WHERE t.facility_id = ANY ($1) AND (t.created_at >= now() - make_interval(days => $2) OR t.status IN ('assigned', 'entered')) AND t.status <> 'cancelled'
      GROUP BY u.display_name, m.code, m.version, f.code ORDER BY u.display_name NULLS LAST, m.code`, [scope.ids, p.days]);
    const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k]), 0);
    const byAnalyst = [...rows.reduce((m, r) => m.set(r.analyst, (m.get(r.analyst) ?? 0) + Number(r.tests)), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    const insights: string[] = [];
    if (byAnalyst[0]) insights.push(`Busiest: ${byAnalyst[0][0]} with ${plural(byAnalyst[0][1], 'test')}.`);
    if (sum('waiting_review')) insights.push(`${plural(sum('waiting_review'), 'test')} waiting for a reviewer.`);
    if (sum('out_of_spec')) insights.push(`${plural(sum('out_of_spec'), 'result')} out of specification.`);
    return {
      reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: p,
      period: { from: new Date(Date.now() - p.days * 86_400_000).toISOString(), to: new Date().toISOString() },
      headline: !rows.length ? 'No lab tests in scope' : `${plural(sum('tests'), 'test')} across ${plural(byAnalyst.length, 'analyst')}; ${sum('waiting_results') + sum('waiting_review')} still waiting`,
      kpis: [
        { label: 'Tests', value: sum('tests'), type: 'integer', status: 'neutral' }, { label: 'Waiting for results', value: sum('waiting_results'), type: 'integer', status: sum('waiting_results') ? 'watch' : 'good' },
        { label: 'Waiting for review', value: sum('waiting_review'), type: 'integer', status: sum('waiting_review') ? 'watch' : 'good' }, { label: 'Reviewed', value: sum('reviewed'), type: 'integer', status: 'neutral' },
        { label: 'Results out of specification', value: sum('out_of_spec'), type: 'integer', status: sum('out_of_spec') ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'analyst', label: 'Analyst', type: 'text', width: 1.2 }, { key: 'method', label: 'Method', type: 'text', width: 1 }, { key: 'facility', label: 'Site', type: 'text', width: 0.4 },
        { key: 'tests', label: 'Tests', type: 'integer', width: 0.5 }, { key: 'results', label: 'Results', type: 'integer', width: 0.5 }, { key: 'waiting_results', label: 'Waiting for results', type: 'integer', width: 0.6 },
        { key: 'waiting_review', label: 'Waiting for review', type: 'integer', width: 0.6 }, { key: 'reviewed', label: 'Reviewed', type: 'integer', width: 0.5 }, { key: 'out_of_spec', label: 'Out of spec', type: 'integer', width: 0.5 },
      ],
      rows, exceptions: rows.map((r, i) => (Number(r.out_of_spec) > 0 ? i : -1)).filter((i) => i >= 0),
      notes: ['Tests created in the period, plus any still waiting. A test is counted under the person who entered its results, or its assigned analyst until then; "Unassigned" has neither.', NOTE_RECORDS],
      source: 'Lab tests, results and methods (live query)',
    };
  },
};
