import { z } from 'zod';
import { many, one } from '../../platform/db/tx.js';
import { plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const SEVERITY: Record<string, string> = { minor: 'Minor', major: 'Major', critical: 'Critical' };
const STATUS: Record<string, string> = { open: 'Open', contained: 'Contained', dispositioned: 'Dispositioned', closed: 'Closed', cancelled: 'Cancelled' };

export const qualityStatusReport: ReportDefinition = {
  id: 'quality-status',
  name: 'Nonconformances and corrective actions',
  description: 'Open nonconformances by age and severity, the cost of poor quality (nonconformance dispositions and production scrap), repeat parts and suppliers, corrective actions overdue or waiting for their effectiveness check, instruments overdue for calibration, and unanswered audit findings.',
  permission: 'quality.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(7).max(730).default(90) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'quality.view', params.facilityId);
    const days = params.days;
    const ncrs = await many(tx, `SELECT n.id, n.number, f.code AS facility, n.source, n.severity, n.status, n.title, p.part_number, s.name AS supplier, n.qty::float AS qty, n.cost::float AS cost,
        n.disposition, ca.number AS capa, (current_date - n.created_at::date) AS age_days, n.created_at
      FROM nonconformance n JOIN facility f ON f.id = n.facility_id LEFT JOIN part p ON p.id = n.part_id LEFT JOIN supplier s ON s.id = n.supplier_id
      LEFT JOIN corrective_action ca ON ca.id = n.capa_id WHERE n.facility_id = ANY ($1) AND n.status <> 'cancelled'
        AND (n.status IN ('open', 'contained', 'dispositioned') OR n.created_at > now() - make_interval(days => $2)) ORDER BY n.created_at DESC`, [scope.ids, days]);
    const recent = ncrs.filter((n) => n.age_days <= days);
    const open = ncrs.filter((n) => ['open', 'contained', 'dispositioned'].includes(n.status));
    const ncrCost = recent.reduce((s, n) => s + (n.cost ?? 0), 0);
    // Production scrap not already costed on a nonconformance, at each order's standard material cost per unit.
    const scrap = await one(tx, `SELECT coalesce(sum(e.qty_scrap * (SELECT sum(m.qty_per * (1 + m.scrap_pct / 100) * coalesce(p.unit_cost, 0)) FROM production_material m JOIN part p ON p.id = m.part_id WHERE m.order_id = e.order_id)), 0)::float AS cost,
        coalesce(sum(e.qty_scrap), 0)::float AS units
      FROM production_entry e WHERE e.facility_id = ANY ($1) AND e.qty_scrap > 0 AND e.ended_at > now() - make_interval(days => $2)
        AND NOT EXISTS (SELECT 1 FROM nonconformance n WHERE n.production_entry_id = e.id AND n.cost IS NOT NULL AND n.status <> 'cancelled')`, [scope.ids, days]);
    const capas = await many(tx, `SELECT c.number, c.title, c.status, c.format, c.due_date, c.verify_after, c.effective, u.display_name AS owner,
        (c.status NOT IN ('closed', 'cancelled') AND c.due_date < current_date) AS overdue,
        (SELECT count(*)::int FROM action_item a WHERE a.subject_type = 'corrective_action' AND a.subject_id = c.id AND a.status = 'open' AND a.due_date < current_date) AS late_actions
      FROM corrective_action c JOIN app_user u ON u.id = c.owner_user_id WHERE c.facility_id = ANY ($1) AND c.status <> 'cancelled'`, [scope.ids]);
    const openCapas = capas.filter((c) => c.status !== 'closed');
    const overdue = openCapas.filter((c) => c.overdue);
    const verifyDue = openCapas.filter((c) => c.status === 'verification' && (!c.verify_after || c.verify_after <= new Date().toISOString().slice(0, 10)));
    const verified = capas.filter((c) => c.effective != null);
    const effective = verified.length ? verified.filter((c) => c.effective).length / verified.length : null;
    const lateActions = capas.reduce((s, c) => s + c.late_actions, 0);
    const count = (key: 'part_number' | 'supplier') => [...recent.reduce((m, n) => (n[key] ? m.set(n[key], (m.get(n[key]) ?? 0) + 1) : m), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    const topPart = count('part_number')[0]; const topSupplier = count('supplier')[0];
    const copq = ncrCost + scrap.cost;
    const cal = await many(tx, `SELECT a.asset_tag, p.next_due, (SELECT r.as_left FROM calibration_record r WHERE r.plan_id = p.id ORDER BY r.performed_on DESC, r.created_at DESC LIMIT 1) AS last_as_left
      FROM calibration_plan p JOIN asset a ON a.id = p.asset_id WHERE p.facility_id = ANY ($1) AND p.active`, [scope.ids]);
    const todayStr = new Date().toISOString().slice(0, 10);
    const calOverdue = cal.filter((c) => c.next_due < todayStr || c.last_as_left === 'failed');
    const findings = await many(tx, `SELECT q.number, i.seq FROM audit_item i JOIN quality_audit q ON q.id = i.audit_id
      WHERE q.facility_id = ANY ($1) AND q.status = 'reported' AND i.result IN ('minor_nc', 'major_nc') AND i.capa_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM action_item x WHERE x.audit_item_id = i.id AND x.status <> 'cancelled')`, [scope.ids]);
    const headline = !ncrs.length && !capas.length ? 'No nonconformances or corrective actions in scope'
      : `${plural(open.length, 'open nonconformance')}; ${usd(copq)} cost of poor quality in ${days} days${overdue.length ? `; ${plural(overdue.length, 'corrective action')} overdue` : ''}`;
    const insights: string[] = [];
    if (recent.length) insights.push(`${plural(recent.length, 'nonconformance')} raised in ${days} days: ${['production', 'receiving', 'customer', 'supplier', 'internal'].map((s) => [s, recent.filter((n) => n.source === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ')}.`);
    if (copq > 0) insights.push(`Cost of poor quality ${usd(copq)}: ${usd(ncrCost)} on nonconformance dispositions, ${usd(scrap.cost)} on ${Math.round(scrap.units)} production scrap units not written up (standard material cost).`);
    if (topPart && topPart[1] > 1) insights.push(`Repeat part: ${topPart[0]} on ${topPart[1]} nonconformances.`);
    if (topSupplier && topSupplier[1] > 1) insights.push(`Repeat supplier: ${topSupplier[0]} on ${topSupplier[1]} nonconformances.`);
    if (verifyDue.length) insights.push(`${plural(verifyDue.length, 'corrective action')} ready for the effectiveness check: ${verifyDue.slice(0, 3).map((c) => c.number).join(', ')}.`);
    const open8d = openCapas.filter((c) => c.format === 'eight_d');
    if (open8d.length) insights.push(`${plural(open8d.length, 'open 8D')}: ${open8d.slice(0, 4).map((c) => `${c.number} (${CAPA_STEP[c.status] ?? c.status})`).join(', ')}.`);
    if (lateActions) insights.push(`${plural(lateActions, 'corrective action task')} overdue.`);
    if (calOverdue.length) insights.push(`${plural(calOverdue.length, 'instrument')} overdue for calibration or failed: ${calOverdue.slice(0, 4).map((c) => c.asset_tag).join(', ')}; production runs on them are blocked.`);
    if (findings.length) insights.push(`${plural(findings.length, 'audit finding')} not yet answered with a corrective action or action (${[...new Set(findings.map((f) => f.number))].join(', ')}).`);
    const rows = open.map((n) => ({ ...n, severity: SEVERITY[n.severity], status: STATUS[n.status], source: n.source[0].toUpperCase() + n.source.slice(1) }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Open nonconformances', value: open.length, type: 'integer', status: open.some((n) => n.severity === 'critical') ? 'bad' : open.length ? 'watch' : 'good' },
        { label: `Cost of poor quality (${days} d)`, value: Math.round(copq), type: 'currency', status: copq ? 'watch' : 'good' },
        { label: 'Open corrective actions', value: openCapas.length, type: 'integer', status: 'neutral' },
        { label: 'Overdue corrective actions', value: overdue.length, type: 'integer', status: overdue.length ? 'bad' : 'good' },
        { label: 'Verified effective', value: effective, type: 'percent', status: effective == null ? 'neutral' : effective < 0.8 ? 'watch' : 'good' },
        { label: 'Instruments overdue for calibration', value: calOverdue.length, type: 'integer', note: cal.length ? `of ${cal.length} under control` : 'none under calibration control', status: calOverdue.length ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'NCR', type: 'text', width: 0.8 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'severity', label: 'Severity', type: 'text', width: 0.6 },
        { key: 'source', label: 'Source', type: 'text', width: 0.7 },
        { key: 'title', label: 'What', type: 'text', width: 2 },
        { key: 'part_number', label: 'Part', type: 'text', width: 0.9 },
        { key: 'supplier', label: 'Supplier', type: 'text', width: 1 },
        { key: 'qty', label: 'Qty', type: 'number', width: 0.5 },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
        { key: 'capa', label: 'CAPA', type: 'text', width: 0.7 },
        { key: 'age_days', label: 'Age (days)', type: 'integer', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.severity !== 'Minor' && !r.capa ? i : r.age_days > 30 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/nonconformances/{id}' },
      notes: [
        'Cost of poor quality = costs recorded on nonconformance dispositions (scrap at the part\'s unit cost unless entered) plus production scrap not written up as a nonconformance, valued at each order\'s standard material cost per unit (labor not included).',
        'Rows needing attention: major or critical nonconformances without a corrective action, and anything open more than 30 days.',
        'Verified effective = corrective actions whose effectiveness check found the fix worked ÷ all checked (a failed check sends the action back for more work).',
      ],
      source: 'Nonconformances, corrective actions, actions and production runs (live query)',
    };
  },
};

const CAPA_STEP: Record<string, string> = { open: 'D1–D3 team, problem, containment', root_cause: 'D4 root causes', actions: 'D5–D7 actions and prevention', verification: 'D6 effectiveness check' };

const KIND: Record<string, string> = { near_miss: 'Near miss', first_aid: 'First aid', injury: 'Injury', illness: 'Illness', property_damage: 'Property damage', environmental: 'Environmental' };

export const safetySummaryReport: ReportDefinition = {
  id: 'safety-summary',
  name: 'Safety incidents and near misses',
  description: 'Incidents and near misses over the period, recordable cases and the incident rate per 200,000 hours worked (from approved timesheets), days since the last recordable case, and open or overdue safety actions. No names of the people involved.',
  permission: 'safety.view',
  params: z.object({ facilityId: z.string().uuid().optional(), days: z.coerce.number().int().min(30).max(730).default(365) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'safety.view', params.facilityId);
    const days = params.days;
    const incidents = await many(tx, `SELECT i.id, i.number, f.code AS facility, i.kind, i.occurred_at, i.location, a.asset_tag, i.severity, i.status, i.recordable,
        (SELECT count(*)::int FROM action_item x WHERE x.subject_type = 'safety_incident' AND x.subject_id = i.id AND x.status = 'open') AS open_actions,
        (SELECT count(*)::int FROM action_item x WHERE x.subject_type = 'safety_incident' AND x.subject_id = i.id AND x.status = 'open' AND x.due_date < current_date) AS late_actions
      FROM safety_incident i JOIN facility f ON f.id = i.facility_id LEFT JOIN asset a ON a.id = i.asset_id
      WHERE i.facility_id = ANY ($1) AND (i.occurred_at > now() - make_interval(days => $2) OR i.status <> 'closed') ORDER BY i.occurred_at DESC`, [scope.ids, days]);
    const inPeriod = incidents.filter((i) => new Date(i.occurred_at).getTime() > Date.now() - days * 86_400_000);
    const recordables = inPeriod.filter((i) => i.recordable);
    const nearMisses = inPeriod.filter((i) => i.kind === 'near_miss').length;
    const injuries = inPeriod.filter((i) => ['injury', 'illness', 'first_aid'].includes(i.kind)).length;
    const hours = Number((await one(tx, `SELECT coalesce(sum(te.hours), 0)::float AS h FROM time_entry te JOIN timesheet t ON t.id = te.timesheet_id
        JOIN earning_code ec ON ec.code = te.earning_code AND ec.tenant_id = te.tenant_id
      WHERE t.facility_id = ANY ($1) AND t.status IN ('approved', 'exported') AND ec.kind = 'worked' AND te.work_date > current_date - $2::int`, [scope.ids, days])).h);
    const rate = hours > 0 ? Math.round(((recordables.length * 200_000) / hours) * 100) / 100 : null;
    const lastRecordable = await one(tx, `SELECT max(occurred_at) AS at FROM safety_incident WHERE facility_id = ANY ($1) AND recordable`, [scope.ids]);
    const daysSince = lastRecordable?.at ? Math.floor((Date.now() - new Date(lastRecordable.at).getTime()) / 86_400_000) : null;
    const lateActions = incidents.reduce((s, i) => s + i.late_actions, 0);
    const unclassified = incidents.filter((i) => i.status === 'reported');
    const byAsset = [...inPeriod.reduce((m, i) => (i.asset_tag ? m.set(i.asset_tag, (m.get(i.asset_tag) ?? 0) + 1) : m), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0];
    const headline = !incidents.length ? `No incidents or near misses reported in the last ${days} days`
      : `${plural(recordables.length, 'recordable case')} and ${plural(nearMisses, 'near miss')} in ${days} days${daysSince != null ? `; ${daysSince} days since the last recordable` : ''}`;
    const insights: string[] = [];
    if (inPeriod.length) insights.push(`${plural(inPeriod.length, 'report')} in ${days} days: ${Object.keys(KIND).map((k) => [KIND[k], inPeriod.filter((i) => i.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${k!.toLowerCase()}`).join(', ')}.`);
    if (injuries) insights.push(`${nearMisses} near misses reported for every ${injuries === 1 ? 'injury or first-aid case' : `${injuries} injury or first-aid cases`}; more near-miss reports usually means problems are caught earlier.`);
    else if (nearMisses) insights.push(`${plural(nearMisses, 'near miss')} reported and no injuries in the period.`);
    // 200,000 hours is roughly 100 people for a year; far fewer hours make the rate swing wildly on one case.
    if (rate != null) insights.push(`Incident rate ${rate} per 200,000 hours, from ${Math.round(hours).toLocaleString('en-US')} hours on approved timesheets${hours < 50_000 ? '; too few hours for a stable rate, so compare case counts until more time is recorded' : ''}.`);
    else insights.push('No approved timesheet hours in the period, so the incident rate cannot be computed.');
    if (unclassified.length) insights.push(`${plural(unclassified.length, 'report')} not yet classified by the safety team: ${unclassified.slice(0, 3).map((i) => i.number).join(', ')}.`);
    if (byAsset && byAsset[1] > 1) insights.push(`${byAsset[0]} is involved in ${byAsset[1]} reports.`);
    if (lateActions) insights.push(`${plural(lateActions, 'safety action')} overdue.`);
    const rows = incidents.map((i) => ({ ...i, kind: KIND[i.kind], severity: i.severity ? i.severity[0].toUpperCase() + i.severity.slice(1) : null,
      status: i.status[0].toUpperCase() + i.status.slice(1), recordable: i.recordable == null ? null : i.recordable ? 'Yes' : 'No' }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: `Recordable cases (${days} d)`, value: recordables.length, type: 'integer', status: recordables.length ? 'bad' : 'good' },
        { label: 'Incident rate (per 200k h)', value: rate, type: 'number', note: hours > 0 && hours < 50_000 ? `only ${Math.round(hours).toLocaleString('en-US')} h recorded` : undefined,
          status: rate == null || hours < 50_000 ? 'neutral' : rate > 3 ? 'bad' : 'watch' },
        { label: 'Days since last recordable', value: daysSince, type: 'integer', status: 'neutral' },
        { label: `Near misses (${days} d)`, value: nearMisses, type: 'integer', status: 'neutral' },
        { label: 'Overdue safety actions', value: lateActions, type: 'integer', status: lateActions ? 'bad' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'number', label: 'Report', type: 'text', width: 0.8 },
        { key: 'facility', label: 'Site', type: 'text', width: 0.5 },
        { key: 'occurred_at', label: 'When', type: 'datetime', width: 1 },
        { key: 'kind', label: 'Kind', type: 'text', width: 0.9 },
        { key: 'location', label: 'Where', type: 'text', width: 1.2 },
        { key: 'asset_tag', label: 'Equipment', type: 'text', width: 0.7 },
        { key: 'severity', label: 'Severity', type: 'text', width: 0.6 },
        { key: 'recordable', label: 'Recordable', type: 'text', width: 0.6 },
        { key: 'status', label: 'Status', type: 'text', width: 0.7 },
        { key: 'open_actions', label: 'Open actions', type: 'integer', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.status === 'Reported' || incidents[i]!.late_actions > 0 ? i : -1)).filter((i) => i >= 0),
      drillDown: { rowKey: 'id', path: '/api/incidents/{id}' },
      notes: [
        'Recordable is the safety team\'s determination on each case; the platform does not decide it. This is not an OSHA 300 log (that is part of the Quality & Compliance add-on).',
        'Incident rate = recordable cases × 200,000 ÷ hours worked. Hours are worked earning codes on approved or exported timesheets at the facilities in scope; contractors and employees without timesheets are not counted, which overstates the rate.',
        'Names and injury details are never shown in this report.',
      ],
      source: 'Safety incidents, actions and approved timesheets (live query)',
    };
  },
};
