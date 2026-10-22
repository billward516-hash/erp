import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const HOUR = 3_600_000;

export const storeStandardsReport: ReportDefinition = {
  id: 'store-standards',
  name: 'Store standards and conditions',
  description: 'Per site: the latest visit score against the one before, critical misses, open fixes, condition readings taken on time, and excursions out of limits with how long they lasted.',
  permission: 'visits.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(365).default(30), target: z.coerce.number().min(0).max(1).default(0.85) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'visits.view', params.facilityId);
    const from = new Date(Date.now() - params.days * 86_400_000);
    const sites = await many(tx, `SELECT id, code, name, kind FROM facility WHERE id = ANY ($1) AND active ORDER BY code`, [scope.ids]);
    const visits = await many(tx, `SELECT facility_id, number, visited_on, score::float AS score, critical_fails FROM site_visit WHERE facility_id = ANY ($1) AND status = 'completed' ORDER BY visited_on DESC, completed_at DESC`, [scope.ids]);
    const actions = await many(tx, `SELECT facility_id, count(*)::int AS n, count(*) FILTER (WHERE due_date < current_date)::int AS late FROM action_item WHERE subject_type = 'site_visit' AND status = 'open' AND facility_id = ANY ($1) GROUP BY facility_id`, [scope.ids]);
    const points = await many(tx, `SELECT p.id, p.facility_id, p.interval_hours, p.created_at, a.asset_tag FROM condition_point p JOIN asset a ON a.id = p.asset_id WHERE p.active AND p.facility_id = ANY ($1)`, [scope.ids]);
    const readings = await many(tx, `SELECT point_id, read_at FROM condition_reading WHERE facility_id = ANY ($1) AND read_at >= $2 ORDER BY point_id, read_at`, [scope.ids, from]);
    const excursions = await many(tx, `SELECT e.facility_id, e.started_at, e.ended_at, a.asset_tag FROM condition_excursion e JOIN condition_point p ON p.id = e.point_id JOIN asset a ON a.id = p.asset_id
      WHERE e.facility_id = ANY ($1) AND (e.ended_at IS NULL OR e.ended_at >= $2)`, [scope.ids, from]);
    const now = Date.now();
    const rows = sites.map((s) => {
      const vs = visits.filter((v) => v.facility_id === s.id);
      const last = vs[0]; const prev = vs[1];
      // Readings on time: for each point with an interval, the share of expected readings actually taken in the period.
      let expected = 0; let taken = 0;
      for (const p of points.filter((x) => x.facility_id === s.id && x.interval_hours)) {
        const got = readings.filter((r) => r.point_id === p.id);
        // Logging starts when the point was set up (or at its first reading, for logs imported from before that).
        const start = Math.max(from.getTime(), Math.min(new Date(p.created_at).getTime(), got.length ? new Date(got[0].read_at).getTime() : Infinity));
        const due = Math.max(1, Math.floor((now - start) / (p.interval_hours * HOUR)));
        expected += due; taken += Math.min(got.length, due);
      }
      const ex = excursions.filter((e) => e.facility_id === s.id);
      const exHours = ex.map((e) => ((e.ended_at ? new Date(e.ended_at).getTime() : now) - new Date(e.started_at).getTime()) / HOUR);
      const a = actions.find((x) => x.facility_id === s.id);
      return { id: s.id, site: `${s.code} ${s.name}`, last_visit: last?.visited_on ?? null, score: last?.score ?? null, previous: prev?.score ?? null, change: last && prev ? Math.round((last.score - prev.score) * 1000) / 1000 : null,
        critical: last?.critical_fails ?? null, open_fixes: a?.n ?? 0, late_fixes: a?.late ?? 0, readings_on_time: expected ? Math.round((taken / expected) * 1000) / 1000 : null,
        excursions: ex.length, open_excursions: ex.filter((e) => !e.ended_at).length, longest_excursion_h: exHours.length ? Math.round(Math.max(...exHours) * 10) / 10 : null,
        worst_asset: ex.length ? ex.sort((x, y) => (new Date(y.ended_at ?? now).getTime() - new Date(y.started_at).getTime()) - (new Date(x.ended_at ?? now).getTime() - new Date(x.started_at).getTime()))[0]!.asset_tag : null };
    }).filter((r) => r.last_visit || r.readings_on_time != null || r.excursions);
    const below = rows.filter((r) => r.score != null && r.score < params.target);
    const exTotal = rows.reduce((s, r) => s + r.excursions, 0);
    const openEx = rows.reduce((s, r) => s + r.open_excursions, 0);
    const visited = rows.filter((r) => r.score != null);
    const headline = !rows.length ? 'No visits or condition logs in scope'
      : `${plural(below.length, 'site')} below the ${pct(params.target)} standard on the latest visit; ${plural(exTotal, 'excursion')} out of limits in ${params.days} days${openEx ? ` (${openEx} still open)` : ''}`;
    const insights: string[] = [];
    if (below.length) insights.push(`Below standard: ${below.sort((a, b) => a.score! - b.score!).slice(0, 4).map((r) => `${r.site} ${pct(r.score)}${r.critical ? ` (${r.critical} critical)` : ''}`).join('; ')}.`);
    const dropped = rows.filter((r) => r.change != null && r.change <= -0.1);
    if (dropped.length) insights.push(`Down 10 points or more since the previous visit: ${dropped.map((r) => `${r.site} (${pct(r.previous)} → ${pct(r.score)})`).join(', ')}.`);
    const lateReads = rows.filter((r) => r.readings_on_time != null && r.readings_on_time < 0.9);
    if (lateReads.length) insights.push(`Readings missed: ${lateReads.map((r) => `${r.site} ${pct(r.readings_on_time)} on time`).join(', ')}. A missed reading is how a slow cooler failure goes unnoticed.`);
    const longest = [...rows].filter((r) => r.longest_excursion_h != null).sort((a, b) => b.longest_excursion_h! - a.longest_excursion_h!)[0];
    if (longest) insights.push(`Longest time out of limits: ${longest.worst_asset} at ${longest.site}, ${longest.longest_excursion_h} h.`);
    const late = rows.reduce((s, r) => s + r.late_fixes, 0);
    if (late) insights.push(`${plural(late, 'fix')} from visits past due.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from: from.toISOString(), to: new Date().toISOString() },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Average latest score', value: visited.length ? Math.round((visited.reduce((s, r) => s + r.score!, 0) / visited.length) * 1000) / 1000 : null, type: 'percent', status: 'neutral', note: `${visited.length} sites visited` },
        { label: 'Below standard', value: below.length, type: 'integer', status: below.length ? 'bad' : 'good', note: `target ${pct(params.target)}` },
        { label: 'Excursions', value: exTotal, type: 'integer', status: exTotal ? 'watch' : 'good', note: `${params.days} days` },
        { label: 'Open now', value: openEx, type: 'integer', status: openEx ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'site', label: 'Site', type: 'text', width: 1.4 },
        { key: 'last_visit', label: 'Last visit', type: 'date', width: 0.6 },
        { key: 'score', label: 'Score', type: 'percent', width: 0.5 },
        { key: 'previous', label: 'Previous', type: 'percent', width: 0.5 },
        { key: 'critical', label: 'Critical misses', type: 'integer', width: 0.5 },
        { key: 'open_fixes', label: 'Open fixes', type: 'integer', width: 0.5 },
        { key: 'readings_on_time', label: 'Readings on time', type: 'percent', width: 0.6 },
        { key: 'excursions', label: 'Excursions', type: 'integer', width: 0.5 },
        { key: 'longest_excursion_h', label: 'Longest', type: 'hours', unit: 'h', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => ((r.score != null && r.score < params.target) || r.open_excursions > 0 ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Score = passed items / (passed + failed) on the latest completed visit; not-applicable items are left out. Critical items are marked on the checklist.',
        'Readings on time = readings taken / readings expected from each point\'s interval, counted from the start of the period or from when logging began if later (extra readings do not make up for missed ones elsewhere).',
        'An excursion runs from the first reading outside the limits to the first reading back inside; it raises one maintenance request.',
      ],
      source: 'Site visits, actions, condition readings and excursions (live query)',
    };
  },
};
