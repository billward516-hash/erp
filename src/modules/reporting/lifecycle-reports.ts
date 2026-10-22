import { z } from 'zod';
import { many } from '../../platform/db/tx.js';
import { can } from '../../platform/auth/actor.js';
import { DEFAULT_DISCOUNT_RATE, DEFAULT_LABOR_RATE, assetLifecycle } from '../assets/lifecycle.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const repairOrReplaceReport: ReportDefinition = {
  id: 'repair-or-replace',
  name: 'Repair or replace',
  description: 'For each asset with a replacement cost: what keeping it is expected to cost this year (maintenance and priced downtime, on its trend) against the equivalent annual cost of a new one.',
  permission: 'assets.view',
  params: z.object({ facilityId: z.string().uuid().optional(), discountRate: z.coerce.number().min(0).max(0.5).default(DEFAULT_DISCOUNT_RATE), laborRate: z.coerce.number().min(0).max(1000).default(DEFAULT_LABOR_RATE) }),
  async run(tx, actor, params): Promise<ReportResult> {
    const assets = (await many(tx, `SELECT a.id, a.facility_id, a.asset_tag, a.name, f.code AS facility_code FROM asset a JOIN facility f ON f.id = a.facility_id
      WHERE a.replacement_cost IS NOT NULL AND a.lifecycle_status = 'active' AND a.parent_asset_id IS NULL AND ($1::uuid IS NULL OR a.facility_id = $1) ORDER BY a.asset_tag`, [params.facilityId ?? null]))
      .filter((a) => can(actor, 'assets.view', a.facility_id));
    const results = [];
    for (const a of assets) results.push({ a, r: await assetLifecycle(tx, actor, a.id, { discountRate: params.discountRate, laborRate: params.laborRate }) });
    const replace = results.filter((x) => x.r.verdict === 'replace');
    const soon = results.filter((x) => x.r.verdict === 'keep' && 'crossover' in x.r && x.r.crossover != null && x.r.crossover <= new Date().getUTCFullYear() + 2);
    const unknown = results.filter((x) => x.r.verdict === 'unknown');
    const headline = !results.length ? 'No active assets have a replacement cost to compare against'
      : replace.length ? `${plural(replace.length, 'asset')} cost${replace.length === 1 ? 's' : ''} more to keep than to replace: ${replace.slice(0, 3).map((x) => x.a.asset_tag).join(', ')}`
        : `No asset costs more to keep than to replace${soon.length ? `; ${plural(soon.length, 'asset')} cross${soon.length === 1 ? 'es' : ''} over within two years` : ''}`;
    const insights: string[] = [];
    for (const x of replace.slice(0, 3)) insights.push(`${x.a.asset_tag} ${x.a.name}: ${x.r.reason}.`);
    if (soon.length) insights.push(`Plan for replacement: ${soon.map((x) => `${x.a.asset_tag} (from ${(x.r as any).crossover})`).join(', ')}.`);
    if (unknown.length) insights.push(`Not enough history to judge: ${unknown.slice(0, 6).map((x) => x.a.asset_tag).join(', ')}${unknown.length > 6 ? '…' : ''}.`);
    const rows = results.map(({ a, r }) => ({ asset: `${a.asset_tag} ${a.name}`, site: a.facility_code, age: r.age, verdict: r.verdict === 'unknown' ? 'Not enough data' : r.verdict === 'replace' ? 'Replace' : 'Keep',
      keep: (r as any).keepNext ?? null, replace: (r as any).replaceEac ?? null, crossover: (r as any).crossover ?? null, years: r.rows.length,
      last_year: r.rows.length ? r.rows[r.rows.length - 1]!.total : null }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: [...new Set(assets.map((a) => a.facility_code))], description: params.facilityId ? 'One site' : 'All sites you can see' }, filters: params,
      kpis: [
        { label: 'Assets compared', value: results.length - unknown.length, type: 'integer', status: 'neutral' },
        { label: 'Replace now', value: replace.length, type: 'integer', status: replace.length ? 'bad' : 'good' },
        { label: 'Cross over within 2 years', value: soon.length, type: 'integer', status: soon.length ? 'watch' : 'neutral' },
        { label: 'Not enough data', value: unknown.length, type: 'integer', status: 'neutral' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'asset', label: 'Asset', type: 'text', width: 1.4 }, { key: 'site', label: 'Site', type: 'text', width: 0.4 }, { key: 'age', label: 'Age (yr)', type: 'number', width: 0.4 },
        { key: 'verdict', label: 'Verdict', type: 'text', width: 0.6 }, { key: 'last_year', label: 'Cost last year', type: 'currency', width: 0.6 }, { key: 'keep', label: 'Keep this year', type: 'currency', width: 0.6 },
        { key: 'replace', label: 'New, per year', type: 'currency', width: 0.6 }, { key: 'crossover', label: 'Replace from', type: 'integer', width: 0.5 }, { key: 'years', label: 'Years of history', type: 'integer', width: 0.5 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.verdict === 'Replace' ? i : -1)).filter((i) => i >= 0),
      notes: [
        `Keeping = maintenance (labor, parts, contractors, imported job costs) + unplanned downtime × the asset's downtime cost per hour, a straight-line trend over the full years recorded, never below the average of the last two years.`,
        `New, per year = replacement cost × capital recovery factor at ${(params.discountRate * 100).toFixed(1)}% over the expected life (15 years when not set) + upkeep of a new unit (2% of replacement cost a year). Labor without a rate at ${money(params.laborRate)} an hour.`,
        'A guide for a capital decision, not the decision: residual value, energy use, safety and parts availability are not in the numbers.',
      ],
      source: 'Work orders (labor, parts, contractor invoices, imported costs), asset state history and asset replacement data',
    };
  },
};
