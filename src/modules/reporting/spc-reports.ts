import { z } from 'zod';
import { listCharacteristics } from '../spc/service.js';
import { plural } from './definitions.js';
import type { ReportDefinition, ReportResult } from './types.js';

const STATUS: Record<string, string> = { signal: 'Signal open', watch: 'Rule broken (answered)', in_control: 'In control', study: 'Initial study', inactive: 'Not measured' };
/** Common acceptance levels: Cpk ≥ 1.33 capable, 1.0–1.33 marginal (customers' PPAP rules may ask for more). */
const capTone = (c: number | null) => (c == null ? 'neutral' : c >= 1.33 ? 'good' : c >= 1 ? 'watch' : 'bad');

export const spcSummaryReport: ReportDefinition = {
  id: 'spc-summary',
  name: 'Process control and capability',
  description: 'Each measured characteristic: whether its control chart signals, the open signals waiting for an investigation, and short- and long-term capability against the tolerance.',
  permission: 'quality.view',
  params: z.object({ facilityId: z.string().uuid().optional() }),
  async run(tx, actor, params): Promise<ReportResult> {
    const all = (await listCharacteristics(tx, actor, { facilityId: params.facilityId })).filter((c) => c.active);
    const signal = all.filter((c) => c.status === 'signal');
    const withCpk = all.filter((c) => c.cpk != null).sort((a, b) => a.cpk! - b.cpk!);
    const low = withCpk.filter((c) => c.cpk! < 1.33);
    const worst = withCpk[0];
    const headline = !all.length ? 'No characteristics are measured yet'
      : signal.length ? `${plural(signal.length, 'characteristic')} of ${all.length} ${signal.length === 1 ? 'has' : 'have'} open control-chart signals${worst ? `; lowest Cpk ${worst.cpk!.toFixed(2)} (${worst.code})` : ''}`
        : `All ${plural(all.length, 'characteristic')} without open signals${worst ? `; lowest Cpk ${worst.cpk!.toFixed(2)} (${worst.code})` : ''}`;
    const insights: string[] = [];
    if (signal.length) insights.push(`Waiting for an investigation: ${signal.map((c) => `${c.code} ${c.name} (${plural(c.openSignals, 'signal')})`).join('; ')}.`);
    if (low.length) insights.push(`Below Cpk 1.33: ${low.map((c) => `${c.code} ${c.cpk!.toFixed(2)}${c.ppk != null ? ` (Ppk ${c.ppk.toFixed(2)})` : ''}`).join(', ')}.`);
    const study = all.filter((c) => c.status === 'study');
    if (study.length) insights.push(`Still in an initial study, without set limits: ${study.map((c) => c.code).join(', ')}.`);
    const rows = all.map((c) => ({ code: c.code, name: c.name, part: c.partNumber ?? '', site: c.facilityCode, status: STATUS[c.status] ?? c.status, open_signals: c.openSignals,
      cpk: c.cpk, ppk: c.ppk, subgroups: c.subgroups, last_measured: c.lastMeasured }));
    return {
      reportId: this.id, name: this.name, headline, generatedAt: new Date().toISOString(),
      scope: { facilities: [...new Set(all.map((c) => c.facilityCode))], description: params.facilityId ? all[0]?.facilityCode ?? 'site' : 'All sites you can see' }, filters: params,
      kpis: [
        { label: 'Characteristics', value: all.length, type: 'integer', status: 'neutral' },
        { label: 'With open signals', value: signal.length, type: 'integer', status: signal.length ? 'bad' : 'good' },
        { label: 'Lowest Cpk', value: worst?.cpk ?? null, type: 'number', status: capTone(worst?.cpk ?? null) as any, note: worst?.code },
        { label: 'Below Cpk 1.33', value: low.length, type: 'integer', status: low.length ? 'watch' : 'good' },
      ],
      insights: insights.slice(0, 5),
      columns: [
        { key: 'code', label: 'Code', type: 'text', width: 0.6 }, { key: 'name', label: 'Characteristic', type: 'text', width: 1.2 }, { key: 'part', label: 'Part', type: 'text', width: 0.7 },
        { key: 'status', label: 'Status', type: 'text', width: 0.9 }, { key: 'open_signals', label: 'Open signals', type: 'integer', width: 0.5 },
        { key: 'cpk', label: 'Cpk', type: 'number', width: 0.4 }, { key: 'ppk', label: 'Ppk', type: 'number', width: 0.4 }, { key: 'subgroups', label: 'Subgroups', type: 'integer', width: 0.5 },
        { key: 'last_measured', label: 'Last measured', type: 'datetime', width: 0.8 },
      ],
      rows,
      exceptions: rows.map((r, i) => (r.open_signals > 0 || (r.cpk != null && r.cpk < 1) ? i : -1)).filter((i) => i >= 0),
      notes: [
        'Charts: X̄ and R for subgroups of 2–10 (A2, D3, D4, d2 constants), individuals and moving range for single readings. Rules: beyond a 3σ limit, 9 in a row on one side, 6 rising or falling, 2 of 3 beyond 2σ; ranges against their upper limit.',
        'Signals are raised only against limits set from a baseline of at least 20 subgroups, for points measured after it; out-of-tolerance values always alert.',
        'Capability over the last 50 included subgroups: Cp/Cpk from within-subgroup σ (R̄/d2 or MR̄/1.128), Pp/Ppk from the overall standard deviation. Normality is assumed, not tested; capability of a process with signals describes the past only.',
      ],
      source: 'SPC characteristics, measurements, control limits and signals',
    };
  },
};
