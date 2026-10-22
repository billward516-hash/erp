import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { computeReliability } from '../assets/reliability.js';
import { reliabilityInputs } from '../assets/service.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const trendOf = (now: number | null, before: number | null) => {
  if (now == null || before == null || before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 1000;
};

export const reliabilityReport: ReportDefinition = {
  id: 'reliability',
  name: 'Equipment reliability (MTBF / MTTR)',
  description: 'Failures, mean time between failures and mean time to repair per asset, against the previous period, with bad actors and repeat failure codes.',
  permission: 'reports.view',
  params: z.object({
    facilityId: z.string().uuid().optional(),
    days: z.coerce.number().int().min(30).max(730).default(90),
  }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'reports.view', params.facilityId);
    const to = new Date();
    const from = new Date(to.getTime() - params.days * 86_400_000);
    const prevFrom = new Date(from.getTime() - params.days * 86_400_000);
    const assets = await many(tx, `SELECT a.id, a.asset_tag, a.name, a.criticality, f.code AS facility FROM asset a JOIN facility f ON f.id = a.facility_id
      WHERE a.facility_id = ANY ($1) AND a.lifecycle_status = 'active' AND a.parent_asset_id IS NULL ORDER BY f.code, a.asset_tag`, [scope.ids]);
    const inp = await reliabilityInputs(tx, assets.map((a) => a.id), prevFrom, to);
    const all = assets.map((a) => {
      const c = computeReliability(inp.intervals(a.id), inp.failures(a.id), from, to, {});
      const p = computeReliability(inp.intervals(a.id), inp.failures(a.id), prevFrom, from, {});
      // Compare like with like: a trend across different bases would mostly measure the change of method.
      const comparable = c.basis === p.basis && c.basis !== 'none';
      return {
        id: a.id, facility: a.facility, asset_tag: a.asset_tag, name: a.name, criticality: a.criticality ?? '—',
        basis: c.basis === 'state' ? 'State history' : c.basis === 'work_orders' ? 'Work orders (estimate)' : 'No data',
        failures: c.failures, prev_failures: p.basis === 'none' ? null : p.failures,
        mtbf_h: c.mtbfHours, prev_mtbf_h: comparable ? p.mtbfHours : null, mtbf_trend: comparable ? trendOf(c.mtbfHours, p.mtbfHours) : null,
        coverage: c.basis === 'state' ? c.coverage : null, mttr_h: c.mttrHours, downtime_h: c.downtimeHours, availability: c.availability,
        top_code: c.failureCodes[0] ? `${c.failureCodes[0].code} (${c.failureCodes[0].count})` : null,
        repeats: c.repeats.reduce((s, x) => s + x.count, 0), repeat_codes: c.repeats.map((x) => x.code).join(', ') || null, _basis: c.basis,
      };
    });
    const rows = all.filter((r) => r._basis !== 'none' || r.failures > 0)
      .sort((a, b) => b.failures - a.failures || (b.downtime_h ?? 0) - (a.downtime_h ?? 0) || a.asset_tag.localeCompare(b.asset_tag));
    const failing = rows.filter((r) => r.failures > 0);
    const total = failing.reduce((s, r) => s + r.failures, 0);
    const worst = failing[0];
    // Fewer than 3 failures is too few to call a trend.
    const worse = rows.filter((r) => r.mtbf_trend != null && r.mtbf_trend <= -0.25 && r.failures >= 3);
    const repeat = rows.filter((r) => r.repeats > 0);
    const noData = all.filter((r) => r._basis === 'none').length;
    const estimated = rows.filter((r) => r._basis === 'work_orders').length;
    const headline = !rows.length ? `No failure data for the last ${params.days} days`
      : !failing.length ? `No failures recorded in the last ${params.days} days across ${plural(rows.length, 'asset')}`
        : `${worst!.asset_tag} is the worst actor: ${plural(worst!.failures, 'failure')} in ${params.days} days${worst!.mtbf_h != null ? `, MTBF ${worst!.mtbf_h} h` : ''}${worst!.prev_mtbf_h != null ? ` (was ${worst!.prev_mtbf_h} h)` : ''}; ${plural(total, 'failure')} across ${plural(failing.length, 'asset')}`;
    const insights: string[] = [];
    if (failing.length > 1) {
      const top3 = failing.slice(0, 3);
      insights.push(`The top ${top3.length} assets account for ${Math.round((top3.reduce((s, r) => s + r.failures, 0) / total) * 100)}% of failures: ${top3.map((r) => `${r.asset_tag} ${r.failures}`).join(', ')}.`);
    }
    if (worse.length) insights.push(`MTBF fell by a quarter or more on ${worse.slice(0, 4).map((r) => `${r.asset_tag} (${r.prev_mtbf_h} → ${r.mtbf_h} h)`).join(', ')}.`);
    if (repeat.length) insights.push(`Repeat failures (same failure code within 30 days): ${repeat.slice(0, 4).map((r) => `${r.asset_tag} ${r.repeat_codes}`).join('; ')}. Repeats point at the root cause not being fixed.`);
    const longRepair = [...failing].filter((r) => r.mttr_h).sort((a, b) => b.mttr_h! - a.mttr_h!)[0];
    if (longRepair) insights.push(`Longest mean repair: ${longRepair.asset_tag} at ${longRepair.mttr_h} h${longRepair.availability != null ? ` (availability ${pct(longRepair.availability)})` : ''}.`);
    const thin = rows.filter((r) => r.coverage != null && r.coverage < 0.5);
    if (thin.length) insights.push(`${plural(thin.length, 'asset')} measured over less than half the period of state records; treat their figures as indicative.`);
    const gaps = [estimated ? `${plural(estimated, 'asset')} estimated from work orders (under 7 days of state records)` : '', noData ? `${plural(noData, 'asset')} with no state records or corrective work in the period` : ''].filter(Boolean);
    if (gaps.length) insights.push(`${gaps.join('; ')}.`);
    const out = all.length ? rows.map(({ _basis, ...r }) => r) : [];
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      period: { from: from.toISOString(), to: to.toISOString() },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Failures', value: total, type: 'integer', status: 'neutral', note: `${params.days} days` },
        { label: 'Assets with failures', value: failing.length, type: 'integer', status: 'neutral' },
        { label: 'MTBF worse by 25%+', value: worse.length, type: 'integer', status: worse.length ? 'bad' : 'good' },
        { label: 'Assets with repeat failures', value: repeat.length, type: 'integer', status: repeat.length ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'asset_tag', label: 'Asset', type: 'text', width: 0.7 },
        { key: 'name', label: 'Name', type: 'text', width: 1.2 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.4 },
        { key: 'criticality', label: 'Criticality', type: 'text', width: 0.5 },
        { key: 'failures', label: 'Failures', type: 'integer', width: 0.5 },
        { key: 'prev_failures', label: 'Previous', type: 'integer', width: 0.5 },
        { key: 'mtbf_h', label: 'MTBF', type: 'hours', unit: 'h', width: 0.5 },
        { key: 'prev_mtbf_h', label: 'Previous MTBF', type: 'hours', unit: 'h', width: 0.6 },
        { key: 'mtbf_trend', label: 'MTBF change', type: 'percent', width: 0.5 },
        { key: 'mttr_h', label: 'MTTR', type: 'hours', unit: 'h', width: 0.5 },
        { key: 'availability', label: 'Availability', type: 'percent', width: 0.5 },
        { key: 'top_code', label: 'Top failure code', type: 'text', width: 0.8 },
        { key: 'repeat_codes', label: 'Repeats', type: 'text', width: 0.7 },
        { key: 'basis', label: 'Basis', type: 'text', width: 0.8 },
        { key: 'coverage', label: 'State coverage', type: 'percent', width: 0.5 },
      ],
      rows: out,
      exceptions: out.map((r, i) => (worse.some((x) => x.id === r.id) || r.repeats > 0 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/assets/{id}/reliability' },
      notes: [
        'A failure is an unplanned stop: consecutive unplanned-downtime records within 5 minutes count as one. MTBF = uptime (scheduled time minus unplanned downtime) / failures; MTTR = unplanned downtime / failures.',
        'MTBF and MTTR are measured over the time with state records (State coverage); an asset needs at least 7 days of records. Otherwise failures are corrective work orders, MTTR is work start to completion, and MTBF uses calendar hours (basis "Work orders (estimate)").',
        'Previous = the same number of days immediately before; the MTBF change is shown only when both periods use the same basis, and flagged only with 3 or more failures in the period. A blank MTBF means no failures (not infinite reliability).',
      ],
      source: 'Asset state history and corrective work orders (live query)',
    };
  },
};
