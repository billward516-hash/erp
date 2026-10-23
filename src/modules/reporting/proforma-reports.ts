import { z } from 'zod';
import { listProformas } from '../proforma/service.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Every business case on one page (D-162): what has been approved, what waits, and what each is worth in its base case. */
export const proformaPortfolioReport: ReportDefinition = {
  id: 'proforma-portfolio',
  name: 'Business cases',
  description: 'Opportunity pro formas with their base case: NPV, IRR, payback, funding needed and status, approved and waiting first.',
  permission: 'proforma.view',
  params: z.object({ status: z.enum(['draft', 'submitted', 'approved', 'archived']).optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const { rows: list } = await listProformas(tx, actor, params);
    const order: Record<string, number> = { approved: 0, submitted: 1, draft: 2, archived: 3 };
    const sorted = [...list].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.npv - a.npv);
    const approved = list.filter((p) => p.status === 'approved'); const waiting = list.filter((p) => p.status === 'submitted');
    const negative = list.filter((p) => p.npv < 0 && p.status !== 'archived');
    const noPayback = list.filter((p) => p.paybackMonths == null && p.status !== 'archived');
    const base = { reportId: this.id, name: this.name, generatedAt: new Date().toISOString(), scope: { facilities: [], description: 'All business cases you can see' }, filters: params };
    const headline = !list.length ? 'No business cases yet'
      : `${plural(approved.length, 'approved business case')} worth ${money(approved.reduce((s, p) => s + p.npv, 0))} NPV; ${plural(waiting.length, 'case')} waiting for approval`;
    const insights: string[] = [];
    if (waiting.length) insights.push(`Waiting for finance: ${waiting.slice(0, 4).map((p) => `${p.number} ${p.title} (${money(p.npv)} NPV)`).join('; ')}.`);
    if (negative.length) insights.push(`${plural(negative.length, 'case')} with a negative NPV in the base case: ${negative.slice(0, 4).map((p) => p.number).join(', ')}.`);
    if (noPayback.length) insights.push(`${plural(noPayback.length, 'case')} not paying back within the horizon: ${noPayback.slice(0, 4).map((p) => p.number).join(', ')}.`);
    const rows = sorted.map((p) => ({ number: p.number, title: p.title, kind: p.kind_label, site: p.facility_code ?? 'Company', status: p.status, owner: p.owner_name, npv: p.npv,
      irr: p.irrPct == null ? null : p.irrPct / 100, payback: p.paybackMonths, funding: p.peakFunding, capital: p.capital, revenue: p.revenue }));
    return {
      ...base, headline,
      kpis: [
        { label: 'Approved NPV', value: Math.round(approved.reduce((s, p) => s + p.npv, 0)), type: 'currency', status: 'neutral', note: plural(approved.length, 'case') },
        { label: 'Waiting for approval', value: waiting.length, type: 'integer', status: waiting.length ? 'watch' : 'good' },
        { label: 'Capital in approved cases', value: Math.round(approved.reduce((s, p) => s + p.capital, 0)), type: 'currency', status: 'neutral' },
        { label: 'Negative NPV', value: negative.length, type: 'integer', status: negative.length ? 'watch' : 'good' },
      ],
      insights,
      charts: rows.length ? [{ kind: 'bars' as const, title: 'Base-case NPV by business case', category: { key: 'number', label: 'Business case' }, series: [{ key: 'npv', label: 'NPV' }],
        valueType: 'currency' as const, data: rows.slice(0, 12).map((r) => ({ number: r.number, npv: Math.round(r.npv) })) }] : [],
      columns: [
        { key: 'number', label: 'Case', type: 'text', width: 0.5 }, { key: 'title', label: 'Title', type: 'text', width: 1.6 }, { key: 'kind', label: 'Kind', type: 'text', width: 0.9 },
        { key: 'site', label: 'Site', type: 'text', width: 0.5 }, { key: 'status', label: 'Status', type: 'text', width: 0.6 }, { key: 'owner', label: 'Owner', type: 'text', width: 0.8 },
        { key: 'npv', label: 'NPV', type: 'currency', width: 0.7 }, { key: 'irr', label: 'IRR', type: 'percent', width: 0.5 }, { key: 'payback', label: 'Payback (months)', type: 'integer', width: 0.6 },
        { key: 'funding', label: 'Peak funding', type: 'currency', width: 0.7 }, { key: 'capital', label: 'Capital', type: 'currency', width: 0.7 }, { key: 'revenue', label: 'Revenue (horizon)', type: 'currency', width: 0.8 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.npv < 0 && r.status !== 'archived' ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Each case is shown in its base scenario at its own discount rate and horizon. Payback is the month cumulative cash returns to zero; blank means not within the horizon.',
        'The projection is a model of the owner\'s assumptions, not a forecast from the books. Straight-line depreciation, tax after losses carried forward, working capital as days of revenue.',
      ],
      source: 'Opportunity pro formas (live calculation)',
    } as ReportResult;
  },
};
