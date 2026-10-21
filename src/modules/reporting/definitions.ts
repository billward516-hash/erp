import { z } from 'zod';
import { facilitiesWith } from '../../platform/auth/actor.js';
import type { Actor } from '../../platform/auth/actor.js';
import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { computeUtilization } from '../assets/utilization.js';
import { OPEN_STATUSES } from '../maintenance/service.js';
import type { ReportDefinition, ReportResult } from './types.js';

const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Facilities the actor may report on, honoring an optional filter; RLS enforces the same boundary. */
async function reportScope(tx: Tx, actor: Actor, permission: 'reports.view', facilityId?: string) {
  const allowed = facilitiesWith(actor, permission);
  const facilities = await many(tx, 'SELECT id, code, name FROM facility ORDER BY code');
  const visible = facilities.filter((f) => allowed.all || allowed.ids.includes(f.id)).filter((f) => !facilityId || f.id === facilityId);
  return {
    ids: visible.map((f) => f.id as string),
    codes: visible.map((f) => f.code as string),
    description: visible.length === facilities.length && !facilityId && visible.length > 1 ? `All facilities (${visible.length})` : visible.map((f) => `${f.code} — ${f.name}`).join(', ') || 'No accessible facilities',
  };
}

export const maintenanceBacklogReport: ReportDefinition = {
  id: 'maintenance-backlog',
  name: 'Maintenance backlog',
  description: 'Open work orders by priority and age, with overdue exceptions.',
  permission: 'reports.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'reports.view', params.facilityId);
    const now = new Date();
    const rows = await many(
      tx,
      `SELECT w.id, w.number, f.code AS facility, a.asset_tag, a.name AS asset_name, a.criticality, w.title, w.wo_type, w.priority, w.status,
              w.created_at, w.due_at, (w.due_at IS NOT NULL AND w.due_at < $2) AS overdue,
              round(extract(epoch FROM ($2 - w.created_at)) / 86400.0, 1)::float AS age_days,
              (SELECT string_agg(e.first_name || ' ' || e.last_name, ', ') FROM work_order_assignment x JOIN employee e ON e.id = x.employee_id WHERE x.work_order_id = w.id) AS assigned
       FROM work_order w JOIN asset a ON a.id = w.asset_id JOIN facility f ON f.id = w.facility_id
       WHERE w.status = ANY ($1) AND w.facility_id = ANY ($3)
       ORDER BY overdue DESC, w.priority, w.due_at NULLS LAST, w.created_at`,
      [OPEN_STATUSES, now, scope.ids],
    );
    const overdue = rows.filter((r) => r.overdue);
    const urgent = rows.filter((r) => r.priority <= 2);
    const unassigned = rows.filter((r) => !r.assigned && r.status !== 'completed');
    const awaitingVerification = rows.filter((r) => r.status === 'completed');
    const ages = rows.map((r) => r.age_days as number).sort((a, b) => a - b);
    const median = ages.length ? ages[Math.floor((ages.length - 1) / 2)]! : null;
    const byAsset = new Map<string, number>();
    overdue.forEach((r) => byAsset.set(r.asset_tag, (byAsset.get(r.asset_tag) ?? 0) + 1));
    const topAsset = [...byAsset].sort((a, b) => b[1] - a[1])[0];

    const headline = !rows.length
      ? 'No open maintenance work in scope'
      : overdue.length
        ? `${plural(overdue.length, 'work order')} overdue of ${rows.length} open${topAsset && topAsset[1] > 1 ? `; ${topAsset[0]} accounts for ${topAsset[1]}` : ''}`
        : `${plural(rows.length, 'open work order')}, none overdue`;
    const insights: string[] = [];
    if (urgent.length) insights.push(`${plural(urgent.length, 'emergency/high-priority order')} open (${urgent.filter((r) => r.overdue).length} overdue).`);
    if (unassigned.length) insights.push(`${plural(unassigned.length, 'open order')} have no technician assigned.`);
    if (awaitingVerification.length) insights.push(`${plural(awaitingVerification.length, 'order')} completed and awaiting return-to-service verification.`);
    const highCrit = rows.filter((r) => r.criticality === 'high');
    if (highCrit.length) insights.push(`${plural(highCrit.length, 'open order')} on high-criticality assets.`);
    if (median !== null && ages[ages.length - 1]! >= 1) insights.push(`Median open age is ${median} days; oldest is ${ages[ages.length - 1]} days.`);

    return {
      reportId: this.id, name: this.name, headline, generatedAt: now.toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Open work orders', value: rows.length, type: 'integer' },
        { label: 'Overdue', value: overdue.length, type: 'integer', status: overdue.length ? 'bad' : 'good', note: 'past due date' },
        { label: 'Priority 1–2 open', value: urgent.length, type: 'integer', status: urgent.length ? 'watch' : 'good' },
        { label: 'Median age', value: median, type: 'number', note: 'days since created' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'WO', type: 'text', width: 1.1 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.7 },
        { key: 'asset_tag', label: 'Asset', type: 'text', width: 1 },
        { key: 'title', label: 'Title', type: 'text', width: 3 },
        { key: 'priority', label: 'Pri', type: 'integer', width: 0.5 },
        { key: 'status', label: 'Status', type: 'text', width: 1.1 },
        { key: 'assigned', label: 'Assigned', type: 'text', width: 1.6 },
        { key: 'due_at', label: 'Due', type: 'date', width: 1 },
        { key: 'age_days', label: 'Age', type: 'number', unit: 'days', width: 0.7 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.overdue ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/work-orders/{id}' },
      notes: [
        'Open = planned, scheduled, in progress, on hold, or completed awaiting verification.',
        'Overdue = due date earlier than report time. Orders without a due date are never counted overdue.',
        'Priority: 1 emergency, 2 high, 3 normal, 4 low.',
      ],
      source: 'Work orders (operational records), live query',
    };
  },
};

export const assetAvailabilityReport: ReportDefinition = {
  id: 'asset-availability',
  name: 'Asset availability & utilization',
  description: 'Availability, utilization and unplanned downtime per asset from recorded state history.',
  permission: 'reports.view',
  params: z.object({
    facilityId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    basis: z.enum(['calendar', 'scheduled']).default('scheduled'),
    minCoverage: z.coerce.number().min(0).max(1).default(0.5),
  }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'reports.view', params.facilityId);
    const to = params.to ?? new Date();
    const from = params.from ?? new Date(to.getTime() - 30 * 86_400_000);
    const assets = await many(
      tx,
      `SELECT a.id, a.asset_tag, a.name, a.criticality, f.code AS facility FROM asset a JOIN facility f ON f.id = a.facility_id
       WHERE a.facility_id = ANY ($1) AND a.lifecycle_status = 'active' AND a.parent_asset_id IS NULL ORDER BY f.code, a.asset_tag`,
      [scope.ids],
    );
    const events = await many(
      tx,
      `SELECT asset_id, state, started_at, ended_at FROM asset_state_event
       WHERE facility_id = ANY ($1) AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2)`,
      [scope.ids, from, to],
    );
    const byAsset = new Map<string, any[]>();
    events.forEach((e) => byAsset.set(e.asset_id, [...(byAsset.get(e.asset_id) ?? []), { state: e.state, startedAt: e.started_at, endedAt: e.ended_at }]));
    const rows = assets.map((a) => {
      const u = computeUtilization(byAsset.get(a.id) ?? [], from, to, { basis: params.basis, now: new Date() });
      const sufficient = (u.coverage ?? 0) >= params.minCoverage;
      return {
        id: a.id, facility: a.facility, asset_tag: a.asset_tag, name: a.name, criticality: a.criticality,
        coverage: u.coverage, running_h: u.hoursByState.running, unplanned_h: u.hoursByState.unplanned_downtime,
        planned_h: u.hoursByState.planned_downtime + u.hoursByState.out_of_service, stops: u.unplannedStops,
        mttr_h: u.unplannedStops ? Math.round((u.hoursByState.unplanned_downtime / u.unplannedStops) * 100) / 100 : null,
        availability: sufficient ? u.availability : null, utilization: sufficient ? u.utilization : null,
        data_quality: sufficient ? 'ok' : u.recordedHours === 0 ? 'no state data' : 'partial',
      };
    });
    const rated = rows.filter((r) => r.availability !== null).sort((a, b) => a.availability! - b.availability!);
    const worst = rated[0];
    const below90 = rated.filter((r) => r.availability! < 0.9);
    const totalUnplanned = rows.reduce((s, r) => s + r.unplanned_h, 0);
    const topLoss = [...rows].sort((a, b) => b.unplanned_h - a.unplanned_h)[0];
    const insufficient = rows.filter((r) => r.data_quality !== 'ok').length;
    const avgAvail = rated.length ? rated.reduce((s, r) => s + r.availability!, 0) / rated.length : null;
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);

    const headline = !rated.length
      ? 'Not enough recorded state history to assess availability'
      : worst && worst.availability! < 0.9
        ? `${worst.asset_tag} has the lowest availability at ${pct(worst.availability)}; ${plural(below90.length, 'asset')} below 90% over ${days} days`
        : `All ${plural(rated.length, 'measured asset')} at or above 90% availability over ${days} days` +
          (topLoss && totalUnplanned > 0 ? `; ${topLoss.asset_tag} accounts for ${Math.round((topLoss.unplanned_h / totalUnplanned) * 100)}% of unplanned downtime` : '');
    const insights: string[] = [];
    if (topLoss && topLoss.unplanned_h > 0) insights.push(`${topLoss.asset_tag} lost ${topLoss.unplanned_h.toFixed(1)} h to unplanned downtime (${Math.round((topLoss.unplanned_h / Math.max(totalUnplanned, 1e-9)) * 100)}% of the total ${Math.round(totalUnplanned * 10) / 10} h).`);
    if (avgAvail !== null) insights.push(`Average availability across measured assets: ${pct(avgAvail)} (simple mean, not weighted).`);
    const highCritBelow = below90.filter((r) => r.criticality === 'high');
    if (highCritBelow.length) insights.push(`${plural(highCritBelow.length, 'high-criticality asset')} below 90%: ${highCritBelow.map((r) => r.asset_tag).join(', ')}.`);
    const mostStops = [...rows].sort((a, b) => b.stops - a.stops)[0];
    if (mostStops && mostStops.stops > 1) insights.push(`${mostStops.asset_tag} had the most unplanned stops (${mostStops.stops}); mean time to restore ${mostStops.mttr_h?.toFixed(1)} h.`);
    if (insufficient) insights.push(`${plural(insufficient, 'asset')} excluded from ratios: state coverage below ${pct(params.minCoverage)} of the period.`);

    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      period: { from: from.toISOString(), to: to.toISOString() },
      scope: { facilities: scope.codes, description: scope.description },
      filters: { ...params, from: from.toISOString(), to: to.toISOString() },
      kpis: [
        { label: 'Average availability', value: avgAvail, type: 'percent', note: `${rated.length} measured assets`, status: avgAvail === null ? 'neutral' : avgAvail >= 0.9 ? 'good' : 'watch' },
        { label: 'Unplanned downtime', value: Math.round(totalUnplanned * 10) / 10, type: 'hours', note: `${days}-day period` },
        { label: 'Assets below 90%', value: below90.length, type: 'integer', status: below90.length ? 'bad' : 'good' },
        { label: 'Insufficient data', value: insufficient, type: 'integer', note: `coverage < ${pct(params.minCoverage)}`, status: insufficient ? 'watch' : 'neutral' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.6 },
        { key: 'asset_tag', label: 'Asset', type: 'text', width: 1 },
        { key: 'name', label: 'Name', type: 'text', width: 2.4 },
        { key: 'criticality', label: 'Crit.', type: 'text', width: 0.7 },
        { key: 'availability', label: 'Availability', type: 'percent', width: 1 },
        { key: 'utilization', label: `Utilization (${params.basis})`, type: 'percent', width: 1.1 },
        { key: 'running_h', label: 'Running', type: 'hours', unit: 'h', width: 0.8 },
        { key: 'unplanned_h', label: 'Unplanned', type: 'hours', unit: 'h', width: 0.9 },
        { key: 'planned_h', label: 'Planned/OOS', type: 'hours', unit: 'h', width: 0.9 },
        { key: 'stops', label: 'Stops', type: 'integer', width: 0.6 },
        { key: 'mttr_h', label: 'MTTR', type: 'hours', unit: 'h', width: 0.7 },
        { key: 'coverage', label: 'Coverage', type: 'percent', width: 0.9 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.availability !== null && r.availability < 0.9 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/assets/{id}' },
      notes: [
        'Availability = (scheduled − unplanned downtime) ÷ scheduled, where scheduled = recorded time − planned downtime − out-of-service time.',
        params.basis === 'calendar' ? 'Utilization = running hours ÷ calendar hours in the period.' : 'Utilization = running hours ÷ scheduled hours.',
        'Coverage = share of the period with a recorded state. Unrecorded time is never assumed to be running or idle.',
        'MTTR = unplanned downtime ÷ unplanned stops starting in the period (mean time to restore, from state history).',
        'OEE is not reported: it requires validated performance-rate and quality data.',
        'Top-level assets only; components roll up to their parent equipment.',
      ],
      source: 'Asset state history (manual entry, work-order events, imports)',
    };
  },
};

export const REPORTS: ReportDefinition[] = [maintenanceBacklogReport, assetAvailabilityReport];
export const getReport = (id: string) => REPORTS.find((r) => r.id === id);
