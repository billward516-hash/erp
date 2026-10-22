import { z } from 'zod';
import { invalid } from '../../platform/errors.js';
import { many } from '../../platform/db/tx.js';
import { getPlan } from '../planning/service.js';
import { pct, plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export const capacityPlanReport: ReportDefinition = {
  id: 'capacity-plan',
  name: 'Capacity and material plan',
  description: 'Customer forecasts and firm orders turned into work-center load against demonstrated capacity, month by month, with the bottleneck, material shortfalls and the assumptions made.',
  permission: 'planning.view',
  params: z.object({ facilityId: z.string().uuid().optional(), horizon: z.coerce.number().int().min(1).max(18).default(6), scenarioId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    // The plan is per site: default to the first site the reader can plan.
    const facilityId = params.facilityId ?? (await many(tx, `SELECT f.id FROM facility f WHERE EXISTS (SELECT 1 FROM work_center w WHERE w.facility_id = f.id) ORDER BY f.code`)).map((f) => f.id)[0];
    if (!facilityId) throw invalid('no site with work centers');
    const p = await getPlan(tx, actor, { facilityId, horizon: params.horizon, scenarioId: params.scenarioId });
    const site = (await many(tx, 'SELECT code, name FROM facility WHERE id = $1', [facilityId]))[0];
    const over = p.workCenters.flatMap((w) => w.cells.filter((c) => (c.utilization ?? 0) > 1).map((c) => ({ w, c })));
    const short = p.materials.filter((m) => m.shortQty > 0);
    const late = short.filter((m) => m.late);
    const b = p.bottleneck;
    const headline = !p.demand.some((d) => d.total > 0) ? `No forecast or open orders for ${site.code} in the next ${params.horizon} months`
      : over.length ? `${b!.code} is loaded to ${pct(b!.utilization)} in ${mon(b!.month)}; ${plural(over.length, 'work-center month')} over capacity${short.length ? `, ${plural(short.length, 'material')} short` : ''}`
        : `Demand fits capacity for ${params.horizon} months (peak ${b ? `${b.code} ${pct(b.utilization)} in ${mon(b.month)}` : 'n/a'})${short.length ? `; ${plural(short.length, 'material')} short` : ''}`;
    const insights: string[] = [];
    const firm = p.demand.reduce((s, d) => s + d.firm, 0); const total = p.demand.reduce((s, d) => s + d.total, 0);
    if (total) insights.push(`Demand over the horizon: ${Math.round(total).toLocaleString('en-US')} units, ${pct(firm / total)} on firm orders and the rest forecast.`);
    if (over.length) insights.push(`Over capacity: ${over.slice(0, 4).map(({ w, c }) => `${w.code} ${mon(c.month)} (${c.shortfall} h short)`).join(', ')}. Load on ${b!.code} over the horizon: ${p.workCenters.find((w) => w.code === b!.code)!.topParts.map((t) => `${t.part} ${Math.round(t.hours)} h`).join(', ')}.`);
    if (short.length) insights.push(`Materials short: ${short.slice(0, 4).map((m) => `${m.partNumber} ${Math.ceil(m.shortQty).toLocaleString('en-US')} from ${m.needBy}${m.late ? ' (past its order-by date)' : `, order by ${m.orderBy}`}`).join('; ')}.`);
    if (late.length) insights.push(`${plural(late.length, 'material')} cannot arrive in time at the supplier's lead time: expedite or find a second source.`);
    const cc = p.consumablesCost.consumables.reduce((t, x) => t + x, 0); const mc = p.consumablesCost.maintenance.reduce((t, x) => t + x, 0);
    if (cc || mc) insights.push(`Consumables and chemicals ${money(cc)}, PM parts ${money(mc)} over the horizon at standard cost${short.some((m) => m.bySource.consumables || m.bySource.maintenance) ? `; short: ${short.filter((m) => m.bySource.consumables || m.bySource.maintenance).map((m) => m.partNumber).slice(0, 4).join(', ')}` : ''}.`);
    if (p.labor) {
      const shortL = p.labor.workCenters.flatMap((w) => w.cells.filter((c) => c.short > 0).map((c) => `${w.code} ${mon(c.month)} (${c.short} h)`));
      const single = p.labor.workCenters.filter((w) => w.singlePoint).map((w) => `${w.code} (${w.qualifiedNow === 0 ? 'nobody' : 'one person'})`);
      if (shortL.length) insights.push(`Short of qualified operators: ${shortL.slice(0, 4).join(', ')}. Train or qualify more people, or move work.`);
      if (single.length) insights.push(`Only one qualified operator or none: ${single.join(', ')}.${p.labor.lapses.length ? ` Lapsing: ${p.labor.lapses.slice(0, 3).map((l) => `${l.person}'s ${l.qualification} on ${l.expiresOn}`).join('; ')}.` : ''}`);
    }
    if (p.scenario && p.base) insights.push(`Scenario "${p.scenario.name}": bottleneck ${p.base.bottleneck ? `${p.base.bottleneck.code} ${pct(p.base.bottleneck.utilization)}` : 'n/a'} → ${b ? `${b.code} ${pct(b.utilization)}` : 'n/a'}; materials short ${p.base.materialsShort} → ${short.length}.`);
    const rows = p.workCenters.flatMap((w) => w.cells.map((c) => ({ work_center: `${w.code} ${w.name}`, month: mon(c.month), capacity: c.capacity, committed: c.committed, firm: c.firm, forecast: c.forecast, required: c.required, utilization: c.utilization, shortfall: c.shortfall })));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from: `${p.months[0]}-01`, to: `${p.months[p.months.length - 1]}-28` },
      scope: { facilities: [site.code], description: `${site.code} — ${site.name}${p.scenario ? ` · scenario ${p.scenario.name}` : ''}` }, filters: { ...params, facilityId },
      kpis: [
        { label: 'Peak load', value: b?.utilization ?? null, type: 'percent', status: !b ? 'neutral' : b.utilization! > 1 ? 'bad' : b.utilization! > 0.85 ? 'watch' : 'good', note: b ? `${b.code}, ${mon(b.month)}` : undefined },
        { label: 'Work-center months over', value: over.length, type: 'integer', status: over.length ? 'bad' : 'good' },
        { label: 'Materials short', value: short.length, type: 'integer', status: short.length ? 'bad' : 'good', note: late.length ? `${late.length} past order date` : undefined },
        { label: 'Firm share of demand', value: total ? firm / total : null, type: 'percent', status: 'neutral' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'work_center', label: 'Work center', type: 'text', width: 1.2 }, { key: 'month', label: 'Month', type: 'text', width: 0.6 },
        { key: 'capacity', label: 'Capacity', type: 'hours', unit: 'h', width: 0.6 }, { key: 'committed', label: 'Open orders', type: 'hours', unit: 'h', width: 0.6 },
        { key: 'firm', label: 'Firm', type: 'hours', unit: 'h', width: 0.5 }, { key: 'forecast', label: 'Forecast', type: 'hours', unit: 'h', width: 0.5 },
        { key: 'utilization', label: 'Load', type: 'percent', width: 0.5 }, { key: 'shortfall', label: 'Short', type: 'hours', unit: 'h', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => ((r.utilization ?? 0) > 1 ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Demand: per customer and month, firm orders consume the forecast (the larger counts). Netted against finished stock and open production orders; components through released revisions, level by level.',
        'Capacity = hours per week × machines or crews × weeks in the month × demonstrated availability of the work center\'s machines (last 90 days). Run time is demonstrated (≥ 20 good units in 180 days) or standard ÷ yield; one setup per part, operation and month.',
        'Qualified labor: a person counts for a work center when they hold every qualification its machines require to operate; their hours (approved timesheets, else 40 a week) are shared across the centers they can run (maximum flow).',
        `Assumptions this plan had to make: ${p.assumptions.length ? p.assumptions.join(' · ') : 'none'}.`,
      ],
      source: 'Customer forecasts, sales orders, stock, production and purchase orders, routings, BOMs, calendars, machine state and production history (computed on request)',
    };
  },
};
