import { z } from 'zod';
import { addDays, weekStartOf } from '../staffing/capacity.js';
import { benchAndOver, forecast, getSettings, groupUtilization, isoToday, loadTargets, utilizationFor, visiblePeople } from '../staffing/service.js';
import type { GroupBy } from '../staffing/service.js';
import { pct, plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const date = z.string().date();
const scopeOf = (people: { facility_code: string }[]) => {
  const codes = [...new Set(people.map((p) => p.facility_code))].sort();
  return { facilities: codes, description: codes.length ? codes.join(', ') : 'No people in scope' };
};

export const utilizationReport: ReportDefinition = {
  id: 'utilization',
  name: 'Utilization',
  description: 'Billable hours over available hours by person, team, site or role for a period, against targets. Billable hours come from approved timesheets.',
  permission: 'reports.view',
  params: z.object({ facilityId: z.string().uuid().optional(), from: date.optional(), to: date.optional(), by: z.enum(['person', 'department', 'manager', 'site', 'role']).default('person') }),
  async run(tx, actor, params): Promise<ReportResult> {
    const today = isoToday();
    const to = params.to ?? today;
    const from = params.from ?? `${to.slice(0, 7)}-01`;
    const settings = await getSettings(tx);
    let people = (await visiblePeople(tx, actor)).filter((p) => !p.excluded);
    if (params.facilityId) people = people.filter((p) => p.facility_id === params.facilityId);
    const rows = await utilizationFor(tx, people, { from, to }, settings, await loadTargets(tx), today);
    const groups = groupUtilization(rows, params.by as GroupBy);
    const withData = rows.filter((r) => r.hasData);
    const all = groupUtilization(rows.map((r) => ({ ...r, facility_code: 'all' })), 'site')[0];
    const through = to < today ? to : addDays(today, -1);
    const pending = rows.filter((r) => r.pendingBillable > 0);
    const below = groups.filter((g) => g.gap != null && g.gap < 0);
    const headline = !people.length ? 'No people in scope'
      : !withData.length ? `No approved timesheets from ${from} to ${through}, so utilization cannot be calculated yet`
        : `Utilization ${pct(all?.utilization ?? null)} against a ${Math.round(all?.target ?? settings.targetPct)}% target (${from} to ${through})`;
    const insights: string[] = [];
    if (people.length && !withData.length) insights.push('Utilization needs approved timesheets with hours marked billable (time recorded against a project). None are approved in this period.');
    if (withData.length && withData.length < people.length) insights.push(`${plural(people.length - withData.length, 'person')} ${people.length - withData.length === 1 ? 'has' : 'have'} no approved timesheet in the period and ${people.length - withData.length === 1 ? 'is' : 'are'} left out of the team figures.`);
    if (below.length) insights.push(`${plural(below.length, params.by === 'person' ? 'person' : 'group')} below target: ${below.slice(0, 4).map((g) => `${g.label} ${pct(g.utilization)}`).join(', ')}${below.length > 4 ? '…' : ''}.`);
    if (pending.length) insights.push(`${Math.round(pending.reduce((s, r) => s + r.pendingBillable, 0))} billable hours sit on submitted timesheets that are not approved yet; they are not counted.`);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from, to: through < from ? from : through },
      scope: scopeOf(people), filters: params,
      kpis: [
        { label: 'Utilization', value: all?.utilization ?? null, type: 'percent', note: 'billable ÷ available, people with approved time', status: all?.gap == null ? 'neutral' : all.gap >= 0 ? 'good' : all.gap > -0.1 ? 'watch' : 'bad' },
        { label: 'Target', value: all?.target == null ? null : all.target / 100, type: 'percent', status: 'neutral', note: 'available-hours weighted' },
        { label: 'Billable hours', value: all?.billable ?? 0, type: 'hours', status: 'neutral' },
        { label: 'Available hours', value: all?.available ?? 0, type: 'hours', status: 'neutral' },
        { label: 'People with approved time', value: withData.length, type: 'integer', status: 'neutral', note: `of ${people.length}` },
      ],
      insights,
      columns: [
        { key: 'label', label: params.by === 'person' ? 'Person' : params.by === 'department' ? 'Department' : params.by === 'manager' ? 'Manager' : params.by === 'site' ? 'Site' : 'Job title', type: 'text', width: 1.6 },
        { key: 'people', label: 'People', type: 'integer', width: 0.5 },
        { key: 'peopleWithData', label: 'With approved time', type: 'integer', width: 0.7 },
        { key: 'available', label: 'Available', type: 'hours', unit: 'h', width: 0.7 },
        { key: 'billable', label: 'Billable', type: 'hours', unit: 'h', width: 0.7 },
        { key: 'otherWorked', label: 'Worked, not billable', type: 'hours', unit: 'h', width: 0.8 },
        { key: 'pendingBillable', label: 'Billable, not approved', type: 'hours', unit: 'h', width: 0.8 },
        { key: 'utilization', label: 'Utilization', type: 'percent', width: 0.7 },
        { key: 'target', label: 'Target %', type: 'number', width: 0.6 },
        { key: 'gap', label: 'Against target', type: 'percent', width: 0.7 },
      ],
      rows: groups.map((g) => ({ ...g, target: g.target == null ? null : Math.round(g.target * 10) / 10 })),
      exceptions: groups.map((g, i) => (g.gap != null && g.gap < 0 ? i : -1)).filter((i) => i >= 0),
      notes: [
        `Period ${from} to ${through}. Only whole days that have passed count.`,
        'Available hours = the person\'s working pattern (or the company default week) less company holidays and approved time off. Billable hours = hours marked billable on approved or exported timesheets. A person with no approved timesheet in the period has no utilization (shown empty, not 0%).',
        'Targets: a person\'s own, else their job title\'s, else the company target. A team\'s target is the available-hours weighted average of its people\'s targets.',
        'People marked as not staffed on projects are left out.',
      ],
      source: 'Timesheets and time entries, working patterns, holidays, time off, utilization targets (live query)',
    };
  },
};

export const benchOverbookingReport: ReportDefinition = {
  id: 'bench-and-overbooking',
  name: 'Bench and overbooking',
  description: 'People booked below the bench threshold, and the weeks where someone is booked over their capacity, for the next weeks.',
  permission: 'reports.view',
  params: z.object({ facilityId: z.string().uuid().optional(), from: date.optional(), weeks: z.coerce.number().int().min(1).max(26).default(4) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const settings = await getSettings(tx);
    const from = weekStartOf(params.from ?? isoToday());
    const last = addDays(from, 7 * params.weeks - 1);
    let people = await visiblePeople(tx, actor);
    if (params.facilityId) people = people.filter((p) => p.facility_id === params.facilityId);
    const { bench, over } = await benchAndOver(tx, people, from, params.weeks, settings);
    const staffed = people.filter((p) => !p.excluded).length;
    const rows = [
      ...over.map((o) => ({ kind: 'Over-allocated', person: o.person.name, site: o.person.facility_code, job_title: o.person.job_title, week: o.weekStart, available: o.available, booked: o.booked, difference: o.over, booked_pct: o.available > 0 ? o.booked / o.available : null })),
      ...bench.map((b) => ({ kind: 'Bench', person: b.person.name, site: b.person.facility_code, job_title: b.person.job_title, week: null, available: b.available, booked: b.booked, difference: -b.free, booked_pct: b.bookedPct })),
    ];
    const headline = !staffed ? 'No staffed people in scope'
      : `${plural(bench.length, 'person')} below the ${settings.benchPct}% bench threshold and ${plural(over.length, 'over-allocated week')} in the next ${plural(params.weeks, 'week')}`;
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from, to: last }, scope: scopeOf(people), filters: params,
      kpis: [
        { label: 'On the bench', value: bench.length, type: 'integer', status: bench.length ? 'watch' : 'good', note: `booked under ${settings.benchPct}% of capacity` },
        { label: 'Over-allocated weeks', value: over.length, type: 'integer', status: over.length ? 'bad' : 'good', note: `${new Set(over.map((o) => o.person.id)).size} people` },
        { label: 'Free hours', value: Math.round(bench.reduce((s, b) => s + b.free, 0)), type: 'hours', status: 'neutral', note: 'on the bench' },
        { label: 'Staffed people', value: staffed, type: 'integer', status: 'neutral' },
      ],
      insights: [
        ...(bench.length ? [`Most free capacity: ${bench.slice(0, 3).map((b) => `${b.person.name} (${Math.round(b.free)} h)`).join(', ')}.`] : []),
        ...(over.length ? [`Most over-booked: ${[...over].sort((a, b) => b.over - a.over).slice(0, 3).map((o) => `${o.person.name} week of ${o.weekStart} (+${o.over} h)`).join(', ')}.`] : []),
        ...(staffed && !bench.length && !over.length ? ['Nobody is on the bench and nobody is over-allocated in this window.'] : []),
      ],
      columns: [
        { key: 'kind', label: 'Finding', type: 'text', width: 0.9 }, { key: 'person', label: 'Person', type: 'text', width: 1.4 }, { key: 'site', label: 'Site', type: 'text', width: 0.5 },
        { key: 'job_title', label: 'Job title', type: 'text', width: 1.1 }, { key: 'week', label: 'Week of', type: 'date', width: 0.7 },
        { key: 'available', label: 'Available', type: 'hours', unit: 'h', width: 0.7 }, { key: 'booked', label: 'Booked', type: 'hours', unit: 'h', width: 0.7 },
        { key: 'difference', label: 'Over (+) or free (−)', type: 'hours', unit: 'h', width: 0.8 }, { key: 'booked_pct', label: 'Booked share', type: 'percent', width: 0.7 },
      ],
      rows, exceptions: rows.map((r, i) => (r.kind === 'Over-allocated' ? i : -1)).filter((i) => i >= 0),
      notes: [
        `Window: ${from} to ${last} (${plural(params.weeks, 'week')}, starting with the current week). Bench = booked hours below ${settings.benchPct}% of available hours over the whole window; bench rows cover the window, over-allocation rows are per week.`,
        `Booked hours include tentative bookings. A week is over-allocated when bookings exceed available hours by more than ${settings.toleranceH} h. Company holidays shrink a booking in proportion; personal time off does not, so it shows as a conflict.`,
        'People marked as not staffed on projects are left out.',
      ],
      source: 'Project assignments, working patterns, holidays, time off (live query)',
    };
  },
};

export const staffingForecastReport: ReportDefinition = {
  id: 'staffing-forecast',
  name: 'Staffing forecast',
  description: 'Booked hours against capacity for the next 13 weeks, confirmed and tentative.',
  permission: 'reports.view',
  params: z.object({ facilityId: z.string().uuid().optional(), from: date.optional(), weeks: z.coerce.number().int().min(1).max(26).default(13) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const settings = await getSettings(tx);
    const from = weekStartOf(params.from ?? isoToday());
    const last = addDays(from, 7 * params.weeks - 1);
    let people = await visiblePeople(tx, actor);
    if (params.facilityId) people = people.filter((p) => p.facility_id === params.facilityId);
    const weeks = await forecast(tx, people, from, params.weeks, settings);
    const capacity = weeks.reduce((s, w) => s + w.capacity, 0);
    const booked = weeks.reduce((s, w) => s + w.booked, 0);
    const confirmed = weeks.reduce((s, w) => s + w.confirmed, 0);
    const staffed = people.filter((p) => !p.excluded).length;
    const headline = !staffed ? 'No staffed people in scope'
      : capacity <= 0 ? 'No capacity in the window (no working hours scheduled)'
        : `${pct(booked / capacity)} of capacity booked over the next ${plural(params.weeks, 'week')} (${pct(confirmed / capacity)} confirmed)`;
    const tight = weeks.filter((w) => w.overPeople > 0);
    const slack = weeks.filter((w) => w.plannedUtilization != null && w.plannedUtilization < settings.benchPct / 100);
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from, to: last }, scope: scopeOf(people), filters: params,
      kpis: [
        { label: 'Booked share of capacity', value: capacity > 0 ? booked / capacity : null, type: 'percent', status: 'neutral' },
        { label: 'Confirmed share', value: capacity > 0 ? confirmed / capacity : null, type: 'percent', status: 'neutral' },
        { label: 'Free hours', value: Math.round(weeks.reduce((s, w) => s + w.free, 0)), type: 'hours', status: 'neutral' },
        { label: 'Weeks with over-allocation', value: tight.length, type: 'integer', status: tight.length ? 'bad' : 'good' },
      ],
      insights: [
        ...(tight.length ? [`Over-allocation in ${plural(tight.length, 'week')}, first the week of ${tight[0]!.weekStart} (${tight[0]!.overPeople} ${tight[0]!.overPeople === 1 ? 'person' : 'people'}).`] : []),
        ...(slack.length ? [`${plural(slack.length, 'week')} booked below ${settings.benchPct}% of capacity, first the week of ${slack[0]!.weekStart}.`] : []),
        ...(booked === 0 && capacity > 0 ? ['Nothing is booked yet. Assign people to projects on the Staffing page.'] : []),
      ],
      charts: capacity > 0 ? [{ kind: 'columns' as const, title: 'Capacity and booked hours by week', category: { key: 'week', label: 'Week of' },
        series: [{ key: 'capacity', label: 'Capacity' }, { key: 'confirmed', label: 'Confirmed' }, { key: 'tentative', label: 'Tentative' }], valueType: 'hours' as const, unit: 'h',
        data: weeks.map((w) => ({ week: w.weekStart, capacity: w.capacity, confirmed: w.confirmed, tentative: w.tentative })) }] : undefined,
      columns: [
        { key: 'weekStart', label: 'Week of', type: 'date', width: 0.8 }, { key: 'people', label: 'People working', type: 'integer', width: 0.6 },
        { key: 'capacity', label: 'Capacity', type: 'hours', unit: 'h', width: 0.7 }, { key: 'confirmed', label: 'Confirmed', type: 'hours', unit: 'h', width: 0.7 },
        { key: 'tentative', label: 'Tentative', type: 'hours', unit: 'h', width: 0.7 }, { key: 'free', label: 'Free', type: 'hours', unit: 'h', width: 0.6 },
        { key: 'over', label: 'Over', type: 'hours', unit: 'h', width: 0.6 }, { key: 'overPeople', label: 'People over', type: 'integer', width: 0.6 },
        { key: 'plannedUtilization', label: 'Booked share', type: 'percent', width: 0.7 },
      ],
      rows: weeks, exceptions: weeks.map((w, i) => (w.overPeople > 0 ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Capacity = working pattern less company holidays and approved time off, for staffed people. Booked = planned hours per week from assignments (tentative and confirmed), prorated for partial weeks.',
        'Free and over are added person by person, so one person\'s spare hours do not cancel out another\'s over-allocation.',
        'The forecast shows what has been planned, not what will be sold: work not yet assigned does not appear.',
      ],
      source: 'Project assignments, working patterns, holidays, time off (live query)',
    };
  },
};
