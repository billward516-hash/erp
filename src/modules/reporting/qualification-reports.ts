import { z } from 'zod';
import { can } from '../../platform/auth/actor.js';
import { many, one } from '../../platform/db/tx.js';
import { notFound } from '../../platform/errors.js';
import { LOG_KINDS, logbook } from '../qualification/logbook.js';
import { getSettings, qualState, STATE_LABEL } from '../qualification/service.js';
import type { QualState } from '../qualification/service.js';
import { E10_GROUPS, E10_LABEL, computeToolStates } from '../qualification/tool-states.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Tool states in SEMI E10 style groups: hours and shares of the period per asset (D-184B). */
export const toolStatesReport: ReportDefinition = {
  id: 'tool-states',
  name: 'Tool states (SEMI E10 style)',
  description: 'Hours and shares of the period each tool spent productive, standby, engineering, in scheduled and unscheduled downtime and non-scheduled, from recorded state history.',
  permission: 'qualification.view',
  params: z.object({ facilityId: z.string().uuid().optional(), assetId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
    minCoverage: z.coerce.number().min(0).max(1).default(0.5) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'qualification.view', params.facilityId);
    const to = params.to ?? new Date();
    const from = params.from ?? new Date(to.getTime() - 30 * 86_400_000);
    const assets = await many(tx, `SELECT a.id, a.asset_tag, a.name, f.code AS facility FROM asset a JOIN facility f ON f.id = a.facility_id
      WHERE a.facility_id = ANY ($1) AND a.lifecycle_status = 'active' AND ($2::uuid IS NULL OR a.id = $2) AND ($2::uuid IS NOT NULL OR a.parent_asset_id IS NULL) ORDER BY f.code, a.asset_tag`, [scope.ids, params.assetId ?? null]);
    if (params.assetId && !assets.length) throw notFound('asset');
    const events = await many(tx, `SELECT asset_id, state, started_at, ended_at, engineering FROM asset_state_event WHERE facility_id = ANY ($1) AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2)`, [scope.ids, from, to]);
    const byAsset = new Map<string, any[]>();
    events.forEach((e) => byAsset.set(e.asset_id, [...(byAsset.get(e.asset_id) ?? []), { state: e.state, startedAt: e.started_at, endedAt: e.ended_at, engineering: e.engineering }]));
    const now = new Date();
    const rows = assets.map((a) => {
      const t = computeToolStates(byAsset.get(a.id) ?? [], from, to, { now });
      const sufficient = (t.coverage ?? 0) >= params.minCoverage;
      return {
        id: a.id, facility: a.facility, asset_tag: a.asset_tag, name: a.name,
        productive_h: t.hours.productive, standby_h: t.hours.standby, engineering_h: t.hours.engineering, scheduled_h: t.hours.scheduled_downtime, unscheduled_h: t.hours.unscheduled_downtime, non_scheduled_h: t.hours.non_scheduled,
        not_recorded_h: t.unrecordedHours,
        productive_pct: t.percentOfCalendar.productive, standby_pct: t.percentOfCalendar.standby, engineering_pct: t.percentOfCalendar.engineering, scheduled_pct: t.percentOfCalendar.scheduled_downtime,
        unscheduled_pct: t.percentOfCalendar.unscheduled_downtime, non_scheduled_pct: t.percentOfCalendar.non_scheduled, coverage: t.coverage,
        data_quality: sufficient ? 'ok' : t.recordedHours === 0 ? 'no state data' : 'partial', _t: t,
      };
    });
    const total = Object.fromEntries(E10_GROUPS.map((g) => [g, rows.reduce((s, r) => s + r._t.hours[g], 0)])) as Record<(typeof E10_GROUPS)[number], number>;
    const recorded = rows.reduce((s, r) => s + r._t.recordedHours, 0);
    const calendar = rows.reduce((s, r) => s + r._t.calendarHours, 0);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    const share = (g: (typeof E10_GROUPS)[number]) => (recorded > 0 ? total[g] / recorded : null);
    const measured = rows.filter((r) => r.data_quality !== 'no state data');
    const topUnsched = [...rows].sort((a, b) => b.unscheduled_h - a.unscheduled_h)[0];
    const headline = !measured.length ? 'No recorded state history in the period'
      : `${pct(share('productive'))} of recorded tool time was productive and ${pct(share('unscheduled_downtime'))} unscheduled downtime across ${plural(measured.length, 'tool')} over ${days} days`;
    const insights: string[] = [];
    if (measured.length) insights.push(`Of ${round1(recorded)} recorded hours: productive ${pct(share('productive'))}, standby ${pct(share('standby'))}, engineering ${pct(share('engineering'))}, scheduled downtime ${pct(share('scheduled_downtime'))}, unscheduled downtime ${pct(share('unscheduled_downtime'))}, non-scheduled ${pct(share('non_scheduled'))}.`);
    if (topUnsched && topUnsched.unscheduled_h > 0) insights.push(`${topUnsched.asset_tag} has the most unscheduled downtime: ${topUnsched.unscheduled_h.toFixed(1)} h (${pct(topUnsched.unscheduled_pct)} of the period).`);
    const gaps = rows.filter((r) => r.data_quality !== 'ok');
    if (gaps.length) insights.push(`${plural(gaps.length, 'tool')} with state records covering less than ${pct(params.minCoverage)} of the period (shown, not excluded; the time without a record is in "Not recorded").`);
    const eng = rows.filter((r) => r.engineering_h > 0);
    if (eng.length) insights.push(`Engineering use was flagged on ${plural(eng.length, 'tool')}: ${round1(total.engineering)} h in total.`);
    const out = rows.map(({ _t, ...r }) => r);
    const hcol = (key: string, label: string) => ({ key, label, type: 'hours' as const, unit: 'h', width: 0.8 });
    const pcol = (key: string, label: string) => ({ key, label, type: 'percent' as const, width: 0.7 });
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from: from.toISOString(), to: to.toISOString() },
      scope: { facilities: scope.codes, description: scope.description }, filters: { ...params, from: from.toISOString(), to: to.toISOString() },
      kpis: [
        { label: 'Productive', value: share('productive'), type: 'percent', note: 'of recorded time', status: 'neutral' },
        { label: 'Unscheduled downtime', value: round1(total.unscheduled_downtime), type: 'hours', note: `${pct(share('unscheduled_downtime'))} of recorded time`, status: total.unscheduled_downtime > 0 ? 'watch' : 'good' },
        { label: 'Engineering', value: round1(total.engineering), type: 'hours', status: 'neutral' },
        { label: 'Not recorded', value: round1(Math.max(calendar - recorded, 0)), type: 'hours', note: 'no state record', status: calendar - recorded > calendar * 0.5 ? 'watch' : 'neutral' },
      ],
      insights: insights.slice(0, 5),
      charts: (() => {
        const top = out.filter((r) => r.unscheduled_h > 0).sort((a, b) => b.unscheduled_h - a.unscheduled_h).slice(0, 10).map((r) => ({ asset: `${r.asset_tag} ${r.name ?? ''}`.trim(), unscheduled_h: r.unscheduled_h }));
        return top.length ? [{ kind: 'bars' as const, title: 'Unscheduled downtime by tool (largest first)', category: { key: 'asset', label: 'Tools' }, series: [{ key: 'unscheduled_h', label: 'Unscheduled downtime' }], valueType: 'hours' as const, unit: 'h', data: top }] : [];
      })(),
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.6 }, { key: 'asset_tag', label: 'Tool', type: 'text', width: 1 }, { key: 'name', label: 'Name', type: 'text', width: 1.6 },
        hcol('productive_h', 'Productive'), hcol('standby_h', 'Standby'), hcol('engineering_h', 'Engineering'), hcol('scheduled_h', 'Sched. down'), hcol('unscheduled_h', 'Unsched. down'), hcol('non_scheduled_h', 'Non-sched.'), hcol('not_recorded_h', 'Not recorded'),
        pcol('productive_pct', 'Productive'), pcol('standby_pct', 'Standby'), pcol('engineering_pct', 'Engineering'), pcol('scheduled_pct', 'Sched. down'), pcol('unscheduled_pct', 'Unsched. down'), pcol('non_scheduled_pct', 'Non-sched.'),
        { key: 'data_quality', label: 'Data', type: 'text', width: 0.8 },
      ],
      rows: out, exceptions: out.map((r, i) => (r.data_quality !== 'ok' ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Mapping from the platform states (a SEMI E10 style reading, not a certification): running = productive; available and idle = standby; available, running or idle flagged "engineering use" = engineering; planned downtime = scheduled downtime; unplanned downtime = unscheduled downtime; out of service = non-scheduled.',
        `Hours columns are hours in the period; percentage columns are shares of the whole period (${E10_GROUPS.map((g) => E10_LABEL[g]).join(', ')} and Not recorded add up to 100%).`,
        'Time with no state record is shown as Not recorded and is never counted as any group. An open state counts up to now.',
        'The company confirms the mapping against its own definitions; the platform does not certify conformance to SEMI E10.',
      ],
      source: 'Asset state history (operational records), live query', drillDown: { rowKey: 'id', path: '/api/assets/{id}' },
    };
  },
};

/** The equipment logbook of one tool as a report, so it exports to PDF, CSV, Excel and print like any other. */
export const equipmentLogbookReport: ReportDefinition = {
  id: 'equipment-logbook',
  name: 'Equipment logbook',
  description: 'One tool in time order: state changes, work orders, calibrations, qualification events, changes affecting it and manual notes.',
  permission: 'qualification.view',
  params: z.object({ assetId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), order: z.enum(['asc', 'desc']).default('asc'), kind: z.enum(LOG_KINDS).optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    if (!params.assetId) {
      // The logbook is of one tool; opened from the list of reports there is nothing to show yet, and it says so.
      const scope = await reportScope(tx, actor, 'qualification.view');
      return {
        reportId: this.id, name: this.name, headline: 'Choose a tool: the equipment logbook is of one tool', generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: params,
        kpis: [], insights: ['Open a tool from Maintenance → Qualification and use the logbook there, or add assetId=<the tool’s id> to this report.'],
        columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'kind', label: 'Type', type: 'text' }, { key: 'entry', label: 'Entry', type: 'text' }, { key: 'detail', label: 'Detail', type: 'text' }, { key: 'actor', label: 'By', type: 'text' }],
        rows: [], notes: ['No tool chosen, so no entries are shown.'], source: 'Asset records (operational), live query',
      };
    }
    const book = await logbook(tx, actor, params.assetId, { from: params.from, to: params.to, order: params.order, kinds: params.kind ? [params.kind] : undefined, limit: 5000 });
    const f = await one(tx, 'SELECT f.code, f.name FROM facility f WHERE f.id = $1', [book.asset.facility_id]);
    const q = await one(tx, 'SELECT q.status, q.enabled, q.requal_due_on FROM asset_qualification q WHERE q.asset_id = $1', [params.assetId]);
    const settings = await getSettings(tx, actor);
    const st = qualState(q, settings.dueLeadDays);
    const counts = Object.fromEntries(LOG_KINDS.map((k) => [k, book.entries.filter((e) => e.kind === k).length])) as Record<(typeof LOG_KINDS)[number], number>;
    const rows = book.entries.map((e) => ({ at: e.at, kind: e.kind.replace('_', ' '), entry: e.title, detail: e.detail, actor: e.actor }));
    const first = book.entries.length ? [...book.entries].sort((a, b) => (a.at < b.at ? -1 : 1))[0]!.at : null;
    const headline = `${book.asset.asset_tag} ${book.asset.name}: ${plural(book.total, 'logbook entry')}${first ? ` since ${first.slice(0, 10)}` : ''}; qualification: ${STATE_LABEL[st.state].toLowerCase()}`;
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      ...(params.from || params.to ? { period: { from: (params.from ?? new Date(0)).toISOString(), to: (params.to ?? new Date()).toISOString() } } : {}),
      scope: { facilities: [f.code], description: `${f.code} — ${f.name}, ${book.asset.asset_tag} ${book.asset.name}` }, filters: params,
      kpis: [
        { label: 'Entries', value: book.total, type: 'integer', status: 'neutral' },
        { label: 'State changes', value: counts.state, type: 'integer', status: 'neutral' },
        { label: 'Work order events', value: counts.work_order, type: 'integer', status: 'neutral' },
        { label: 'Qualification events', value: counts.qualification, type: 'integer', status: 'neutral' },
        { label: 'Notes', value: counts.note, type: 'integer', status: 'neutral' },
      ],
      insights: [
        ...(book.omitted.length ? [`Left out because you may not see them: ${book.omitted.join(', ')}. This logbook is not complete.`] : []),
        ...(book.truncated ? ['The logbook is longer than this export; narrow the dates.'] : []),
      ],
      columns: [
        { key: 'at', label: 'When', type: 'datetime', width: 1.3 }, { key: 'kind', label: 'Type', type: 'text', width: 1 }, { key: 'entry', label: 'Entry', type: 'text', width: 3 },
        { key: 'detail', label: 'Detail', type: 'text', width: 3 }, { key: 'actor', label: 'By', type: 'text', width: 1.2 },
      ],
      rows,
      notes: ['Read from the records that own each entry (state history, work orders, calibration records, qualification history, changes). Manual notes are append-only: who and when are kept and a correction is a new note.', 'Times are shown in UTC.'],
      source: 'Asset records (operational), live query',
    };
  },
};

/** Qualification status of every tool under qualification control, with the dates that matter. */
export const equipmentQualificationReport: ReportDefinition = {
  id: 'equipment-qualification',
  name: 'Equipment qualification status',
  description: 'Tools under qualification control: qualified, requalification due, requalification required or not qualified, with due dates and open protocols.',
  permission: 'qualification.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'qualification.view', params.facilityId);
    const settings = await getSettings(tx, actor);
    const raw = await many(tx, `SELECT a.id, f.code AS facility, a.asset_tag, a.name, a.operational_state, a.facility_id, x.enabled, x.status, x.qualified_on, x.requal_due_on, x.required_since, x.required_reason,
        (SELECT count(*)::int FROM qualification_protocol p WHERE p.asset_id = a.id AND p.status IN ('draft', 'executed')) AS open_protocols,
        (SELECT p.number || ' ' || p.protocol_type FROM qualification_protocol p WHERE p.asset_id = a.id AND p.status = 'approved' ORDER BY p.decided_at DESC LIMIT 1) AS last_approved
      FROM asset_qualification x JOIN asset a ON a.id = x.asset_id JOIN facility f ON f.id = a.facility_id WHERE x.enabled AND a.facility_id = ANY ($1) ORDER BY f.code, a.asset_tag`, [scope.ids]);
    const rank: Record<string, number> = { requalification_required: 0, requalification_due: 1, not_qualified: 2, qualified: 3 };
    const rows = raw.map((r) => { const s = qualState(r, settings.dueLeadDays); return { ...r, _s: s } as any; }).sort((a, b) => rank[a._s.state]! - rank[b._s.state]! || String(a.asset_tag).localeCompare(String(b.asset_tag)));
    const count = (s: string) => rows.filter((r) => r._s.state === s).length;
    const blocked = rows.filter((r) => r._s.state === 'requalification_required' || r._s.state === 'not_qualified').length;
    const overdue = rows.filter((r) => r._s.overdue).length;
    const headline = !rows.length ? 'No tools under qualification control in scope'
      : `${count('qualified')} of ${plural(rows.length, 'tool')} qualified; ${count('requalification_required')} need requalification and ${count('requalification_due')} are due`;
    const insights: string[] = [];
    const req = rows.filter((r) => r._s.state === 'requalification_required');
    if (req.length) insights.push(`Cannot return to service until requalified: ${req.slice(0, 5).map((r) => `${r.asset_tag} (${r.required_reason ?? 'required'})`).join('; ')}.`);
    if (overdue) insights.push(`${plural(overdue, 'tool')} past the requalification due date.`);
    const nq = rows.filter((r) => r._s.state === 'not_qualified');
    if (nq.length) insights.push(`Under control but not yet qualified: ${nq.slice(0, 5).map((r) => r.asset_tag).join(', ')}.`);
    const out = rows.map(({ _s, enabled, facility_id, status, ...r }: any) => ({ ...r, state: STATE_LABEL[_s.state as QualState], days_to_due: _s.dueInDays, overdue: _s.overdue ? 'yes' : 'no' }));
    const showable = rows.filter((r) => can(actor, 'qualification.view', r.facility_id));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Under control', value: showable.length, type: 'integer', status: 'neutral' }, { label: 'Qualified', value: count('qualified'), type: 'integer', status: 'good' },
        { label: 'Requalification due', value: count('requalification_due'), type: 'integer', status: count('requalification_due') ? 'watch' : 'good' },
        { label: 'Requalification required', value: count('requalification_required'), type: 'integer', status: count('requalification_required') ? 'bad' : 'good' },
        { label: 'Not qualified', value: count('not_qualified'), type: 'integer', status: count('not_qualified') ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'facility', label: 'Site', type: 'text', width: 0.6 }, { key: 'asset_tag', label: 'Tool', type: 'text', width: 1 }, { key: 'name', label: 'Name', type: 'text', width: 2 },
        { key: 'operational_state', label: 'Tool state', type: 'text', width: 1.2 }, { key: 'state', label: 'Qualification', type: 'text', width: 1.6 }, { key: 'qualified_on', label: 'Qualified on', type: 'date', width: 1 },
        { key: 'requal_due_on', label: 'Requal. due', type: 'date', width: 1 }, { key: 'days_to_due', label: 'Days to due', type: 'integer', width: 0.8 }, { key: 'required_reason', label: 'Required because', type: 'text', width: 2.6 },
        { key: 'open_protocols', label: 'Open protocols', type: 'integer', width: 0.8 }, { key: 'last_approved', label: 'Last approved', type: 'text', width: 1.2 },
      ],
      rows: out, exceptions: out.map((r, i) => (['Requalification required', 'Not qualified'].includes(r.state) || r.overdue === 'yes' ? i : -1)).filter((i) => i >= 0),
      notes: [`Requalification due: the due date is within ${settings.dueLeadDays} days or past. A tool that is not qualified or needs requalification cannot return to service from downtime or out of service (${blocked} now).`,
        'A date is set when a protocol with a requalification interval is approved; the interval for each protocol type is set under Qualification.', 'The platform records the protocols; the company owns its qualification approach and validation.'],
      source: 'Qualification records (operational), live query', drillDown: { rowKey: 'id', path: '/api/qualification/assets/{id}' },
    };
  },
};
