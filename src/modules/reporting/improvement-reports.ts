import { z } from 'zod';
import { listImprovements } from '../improve/service.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const improvementReport: ReportDefinition = {
  id: 'improvement-pipeline',
  name: 'Continuous improvement',
  description: 'Ideas and improvements by stage, results measured against their baseline, and savings: estimated by owners, validated by someone else.',
  permission: 'improve.submit',
  params: z.object({ facilityId: z.string().uuid().optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const year = params.year ?? new Date().getUTCFullYear();
    const all = await listImprovements(tx, actor, { facilityId: params.facilityId });
    const closedYear = all.filter((m) => m.stage === 'closed' && new Date(m.closed_at).getUTCFullYear() === year);
    const validated = closedYear.reduce((t, m) => t + (m.validated_savings ?? 0), 0);
    const estimated = closedYear.reduce((t, m) => t + (m.est_annual_savings ?? 0), 0);
    const open = all.filter((m) => !['closed', 'rejected'].includes(m.stage));
    const ideas = all.filter((m) => m.stage === 'idea');
    const headline = `${plural(closedYear.length, 'improvement')} closed in ${year} with ${money(validated)} validated annual savings; ${plural(open.length, 'improvement')} open${ideas.length ? `, ${plural(ideas.length, 'idea')} waiting for a decision` : ''}`;
    const insights: string[] = [];
    if (closedYear.length && estimated) insights.push(`Validated savings are ${Math.round((validated / estimated) * 100)}% of what owners estimated for the same improvements.`);
    const measured = all.filter((m) => m.outcome);
    const worse = measured.filter((m) => !m.outcome!.better);
    if (measured.length) insights.push(`${measured.filter((m) => m.outcome!.better).length} of ${measured.length} measured results improved on their baseline${worse.length ? `; no improvement: ${worse.map((m) => m.number).join(', ')}` : ''}.`);
    const stuck = open.filter((m) => m.stage === 'idea' && Date.now() - new Date(m.created_at).getTime() > 14 * 86_400_000);
    if (stuck.length) insights.push(`Ideas waiting more than two weeks for a decision: ${stuck.map((m) => m.number).join(', ')}.`);
    const rows = all.map((m) => ({ number: m.number, title: m.title, category: m.category, stage: m.stage.replace('_', ' '), owner: m.owner_name ?? '', metric: m.metric_name ? `${m.metric_name} (${m.metric_unit ?? ''})` : '',
      baseline: m.baseline_value, result: m.result_value, change: m.outcome?.pct ?? null, estimated: m.est_annual_savings, validated: m.validated_savings }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(), period: { from: `${year}-01-01`, to: `${year}-12-31` },
      scope: { facilities: [...new Set(all.map((m) => m.facility_code))], description: params.facilityId ? 'One site' : 'All sites you can see' }, filters: { ...params, year },
      kpis: [
        { label: 'Closed this year', value: closedYear.length, type: 'integer', status: 'neutral' },
        { label: 'Validated savings', value: validated, type: 'currency', status: validated ? 'good' : 'neutral' },
        { label: 'Open', value: open.length, type: 'integer', status: 'neutral' },
        { label: 'Ideas waiting', value: ideas.length, type: 'integer', status: stuck.length ? 'watch' : 'neutral' },
      ],
      insights,
      columns: [
        { key: 'number', label: 'No.', type: 'text', width: 0.6 }, { key: 'title', label: 'Improvement', type: 'text', width: 1.5 }, { key: 'category', label: 'Category', type: 'text', width: 0.6 },
        { key: 'stage', label: 'Stage', type: 'text', width: 0.6 }, { key: 'owner', label: 'Owner', type: 'text', width: 0.8 }, { key: 'metric', label: 'Metric', type: 'text', width: 0.9 },
        { key: 'baseline', label: 'Before', type: 'number', width: 0.5 }, { key: 'result', label: 'After', type: 'number', width: 0.5 }, { key: 'change', label: 'Change', type: 'percent', width: 0.5 },
        { key: 'estimated', label: 'Estimated / yr', type: 'currency', width: 0.6 }, { key: 'validated', label: 'Validated / yr', type: 'currency', width: 0.6 },
      ],
      rows,
      exceptions: rows.map((r, i) => (all[i]!.outcome && !all[i]!.outcome!.better ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Metrics from the records are measured the same way before and after: unplanned downtime from the asset\'s state history (hours a week), scrap rate from production runs at the work center. Results are measured at least 28 days after the change.',
        'Savings are estimated by the owner and validated by someone else (a lead, typically with finance); only validated savings count in the total.',
      ],
      source: 'Improvements, their actions, asset state history and production runs',
    };
  },
};
