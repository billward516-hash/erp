import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { serviceLevels, slaOf } from '../maintenance/vendors.js';
import { pct, plural, reportScope } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 10) / 10;
};

export const serviceLevelReport: ReportDefinition = {
  id: 'service-levels',
  name: 'Service levels by site and contractor',
  description: 'Work orders responded to and completed within the targets for their priority, by site or by contractor, with contractor spend over not-to-exceed.',
  permission: 'reports.view',
  params: z.object({
    facilityId: z.string().uuid().optional(),
    days: z.coerce.number().int().min(7).max(365).default(90),
    by: z.enum(['site', 'contractor']).default('site'),
  }),
  async run(tx, actor, params): Promise<ReportResult> {
    const scope = await reportScope(tx, actor, 'reports.view', params.facilityId);
    const from = new Date(Date.now() - params.days * 86_400_000);
    const levels = await serviceLevels(tx);
    const wos = await many(tx, `SELECT w.id, w.number, w.priority, w.status, w.created_at, w.responded_at, w.completed_at, w.nte_amount::float AS nte, w.wo_type,
        f.id AS facility_id, f.code AS facility, f.name AS facility_name, f.kind, s.id AS vendor_id, s.name AS vendor,
        (SELECT coalesce(sum((SELECT coalesce(sum(l.qty * l.unit_price), 0) FROM supplier_invoice_line l WHERE l.invoice_id = i.id) + i.tax_amount + i.freight_amount), 0)
           FROM supplier_invoice i WHERE i.work_order_id = w.id AND i.status <> 'void')::float AS spend
      FROM work_order w JOIN facility f ON f.id = w.facility_id LEFT JOIN supplier s ON s.id = w.vendor_supplier_id
      WHERE w.facility_id = ANY ($1) AND w.created_at >= $2 AND w.status <> 'cancelled' AND w.wo_type <> 'preventive'`, [scope.ids, from]);
    const now = new Date();
    const groups = new Map<string, any>();
    for (const w of wos) {
      if (params.by === 'contractor' && !w.vendor_id) continue;
      const key = params.by === 'site' ? w.facility_id : w.vendor_id;
      const g = groups.get(key) ?? { id: key, name: params.by === 'site' ? `${w.facility} ${w.facility_name}` : w.vendor, kind: params.by === 'site' ? w.kind : 'contractor',
        jobs: 0, respondTargeted: 0, respondMet: 0, completeTargeted: 0, completeMet: 0, missedOpen: 0, responses: [] as number[], spend: 0, overNte: 0, overNteAmount: 0 };
      const s = slaOf(w, levels, now);
      g.jobs++;
      if (s.respond.state !== 'none' && s.respond.state !== 'on_track' && s.respond.state !== 'at_risk') { g.respondTargeted++; if (s.respond.state === 'met') g.respondMet++; }
      if (s.complete.state !== 'none' && s.complete.state !== 'on_track' && s.complete.state !== 'at_risk') { g.completeTargeted++; if (s.complete.state === 'met') g.completeMet++; }
      if (!w.completed_at && (s.respond.state === 'missed' || s.complete.state === 'missed')) g.missedOpen++;
      if (w.responded_at) g.responses.push((new Date(w.responded_at).getTime() - new Date(w.created_at).getTime()) / 3_600_000);
      g.spend += w.spend;
      if (w.nte != null && w.spend > w.nte + 0.005) { g.overNte++; g.overNteAmount += w.spend - w.nte; }
      groups.set(key, g);
    }
    const rows = [...groups.values()].map((g) => ({
      id: g.id, name: g.name, kind: g.kind, jobs: g.jobs, respond_rate: rate(g.respondMet, g.respondTargeted), complete_rate: rate(g.completeMet, g.completeTargeted),
      median_response_h: median(g.responses), missed_open: g.missedOpen, spend: Math.round(g.spend * 100) / 100, over_nte: g.overNte, over_nte_amount: Math.round(g.overNteAmount * 100) / 100,
    })).sort((a, b) => (a.complete_rate ?? 2) - (b.complete_rate ?? 2) || b.missed_open - a.missed_open || b.jobs - a.jobs);
    const all = rows.reduce((t, r) => ({ jobs: t.jobs + r.jobs, missed: t.missed + r.missed_open, over: t.over + r.over_nte, overAmt: t.overAmt + r.over_nte_amount }), { jobs: 0, missed: 0, over: 0, overAmt: 0 });
    const g = [...groups.values()];
    const respond = rate(g.reduce((s, x) => s + x.respondMet, 0), g.reduce((s, x) => s + x.respondTargeted, 0));
    const complete = rate(g.reduce((s, x) => s + x.completeMet, 0), g.reduce((s, x) => s + x.completeTargeted, 0));
    const worst = rows.find((r) => r.complete_rate != null);
    const noun = params.by === 'site' ? 'site' : 'contractor';
    const headline = !rows.length ? `No ${params.by === 'contractor' ? 'contractor ' : ''}work orders in the last ${params.days} days`
      : `${pct(complete)} of work completed within target over ${params.days} days${worst && worst.complete_rate! < (complete ?? 1) ? `; ${worst.name} lowest at ${pct(worst.complete_rate)}` : ''}`;
    const insights: string[] = [];
    if (respond != null) insights.push(`${pct(respond)} of jobs got a first response within target (started, or the contractor accepted).`);
    if (all.missed) insights.push(`${plural(all.missed, 'open job')} already past a target: ${rows.filter((r) => r.missed_open).slice(0, 4).map((r) => `${r.name} ${r.missed_open}`).join(', ')}.`);
    if (all.over) insights.push(`${plural(all.over, 'job')} invoiced over the not-to-exceed, by $${all.overAmt.toFixed(2)} in total.`);
    const slow = [...rows].filter((r) => r.median_response_h != null).sort((a, b) => b.median_response_h! - a.median_response_h!)[0];
    if (slow && rows.length > 1) insights.push(`Slowest median response: ${slow.name} at ${slow.median_response_h} h.`);
    const t = [...levels.values()].filter((l) => l.respond_hours).map((l) => `P${l.priority} ${l.respond_hours} h / ${l.complete_hours} h`).join(', ');
    return {
      reportId: this.id, name: this.name, headline, generatedAt: now.toISOString(), period: { from: from.toISOString(), to: now.toISOString() },
      scope: { facilities: scope.codes, description: scope.description }, filters: params,
      kpis: [
        { label: 'Jobs', value: all.jobs, type: 'integer', status: 'neutral', note: `${params.days} days, PM excluded` },
        { label: 'Responded within target', value: respond, type: 'percent', status: respond == null ? 'neutral' : respond >= 0.9 ? 'good' : respond >= 0.75 ? 'watch' : 'bad' },
        { label: 'Completed within target', value: complete, type: 'percent', status: complete == null ? 'neutral' : complete >= 0.9 ? 'good' : complete >= 0.75 ? 'watch' : 'bad' },
        { label: 'Open jobs past target', value: all.missed, type: 'integer', status: all.missed ? 'bad' : 'good' },
        { label: 'Over not-to-exceed', value: all.over, type: 'integer', status: all.over ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'name', label: params.by === 'site' ? 'Site' : 'Contractor', type: 'text', width: 1.6 },
        ...(params.by === 'site' ? [{ key: 'kind', label: 'Kind', type: 'text' as const, width: 0.6 }] : []),
        { key: 'jobs', label: 'Jobs', type: 'integer', width: 0.5 },
        { key: 'respond_rate', label: 'Responded on time', type: 'percent', width: 0.7 },
        { key: 'complete_rate', label: 'Completed on time', type: 'percent', width: 0.7 },
        { key: 'median_response_h', label: 'Median response', type: 'hours', unit: 'h', width: 0.6 },
        { key: 'missed_open', label: 'Open past target', type: 'integer', width: 0.6 },
        { key: 'spend', label: 'Contractor spend', type: 'currency', width: 0.7 },
        { key: 'over_nte', label: 'Over NTE', type: 'integer', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.missed_open > 0 || r.over_nte > 0 ? i : -1)).filter((i) => i >= 0),
      notes: [
        `Targets by priority (respond / complete): ${t || 'none set'}. Measured on the clock from when the work order was raised; business hours and holidays are not modelled.`,
        'Response = work started or the contractor accepted, whichever came first. Rates count only jobs whose target has passed or that are finished; jobs still inside their target are not counted yet.',
        `Contractor spend = supplier invoices tied to the work order (not void). Preventive work is excluded. Grouped by ${noun}.`,
      ],
      source: 'Work orders, service-level targets and supplier invoices (live query)',
    };
  },
};
