import type { ReportResult } from '../types.js';
import { formatValue, MISSING, TOKENS } from './format.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const STATUS_LABEL = { good: 'On track', watch: 'Watch', bad: 'Action needed', neutral: '' } as const;

/** Print-friendly HTML (also the basis for browser "Save as PDF"). Status uses text labels, not color alone. */
export function reportToHtml(r: ReportResult): string {
  const exceptions = new Set(r.exceptions ?? []);
  const numeric = (t: string) => !['text', 'date', 'datetime'].includes(t);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.name)}</title>
<style>
  :root { --ink:${TOKENS.ink}; --muted:${TOKENS.muted}; --rule:${TOKENS.rule}; --accent:${TOKENS.accent}; --surface:${TOKENS.surface};
          --good:${TOKENS.good}; --watch:${TOKENS.watch}; --bad:${TOKENS.bad}; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; color: var(--ink); background: #fff; font: 14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  .eyebrow { color: var(--accent); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
  h1 { font-size: 24px; line-height: 1.25; margin: 6px 0 8px; font-weight: 650; }
  .meta { color: var(--muted); font-size: 12.5px; margin-bottom: 24px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { border-top: 3px solid var(--accent); background: var(--surface); padding: 12px 14px; }
  .kpi .v { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .kpi .l { font-size: 12.5px; color: var(--muted); }
  .kpi .s { font-size: 11.5px; font-weight: 600; margin-top: 2px; }
  .kpi.good { border-color: var(--good); } .kpi.good .s { color: var(--good); }
  .kpi.watch { border-color: var(--watch); } .kpi.watch .s { color: var(--watch); }
  .kpi.bad { border-color: var(--bad); } .kpi.bad .s { color: var(--bad); }
  ul.insights { margin: 0 0 24px; padding-left: 18px; } ul.insights li { margin: 4px 0; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th { text-align: left; font-weight: 600; color: var(--muted); border-bottom: 1.5px solid var(--ink); padding: 6px 8px; white-space: nowrap; }
  td { border-bottom: 1px solid var(--rule); padding: 6px 8px; vertical-align: top; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tr.exception td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
  tr.exception td:first-child::after { content: " ▲"; color: var(--bad); font-size: 10px; }
  .notes { margin-top: 20px; color: var(--muted); font-size: 11.5px; border-top: 1px solid var(--rule); padding-top: 10px; }
  .notes p { margin: 3px 0; }
  .empty { padding: 24px; background: var(--surface); color: var(--muted); text-align: center; }
  @media print { body { padding: 0; font-size: 11px; } .kpi { break-inside: avoid; } tr { break-inside: avoid; } thead { display: table-header-group; }
                 .table-wrap { overflow: visible; } a { color: inherit; text-decoration: none; } }
  @page { size: letter landscape; margin: 14mm; }
</style></head>
<body><main>
  <div class="eyebrow">${esc(r.name)}</div>
  <h1>${esc(r.headline)}</h1>
  <div class="meta">${r.period ? `Period ${esc(r.period.from.slice(0, 10))} to ${esc(r.period.to.slice(0, 10))} · ` : ''}Scope: ${esc(r.scope.description)} · Generated ${esc(r.generatedAt.replace('T', ' ').slice(0, 16))} UTC</div>
  <section class="kpis" aria-label="Key figures">
    ${r.kpis.map((k) => `<div class="kpi ${k.status ?? 'neutral'}"><div class="v">${esc(formatValue(k.value, k.type))}${k.type === 'hours' && k.value !== null ? ' h' : ''}</div><div class="l">${esc(k.label)}${k.note ? ` · ${esc(k.note)}` : ''}</div>${k.status && k.status !== 'neutral' ? `<div class="s">${STATUS_LABEL[k.status]}</div>` : ''}</div>`).join('\n    ')}
  </section>
  ${r.insights.length ? `<ul class="insights">${r.insights.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
  ${r.rows.length ? `<div class="table-wrap"><table>
    <thead><tr>${r.columns.map((c) => `<th class="${numeric(c.type) ? 'n' : ''}" scope="col">${esc(c.label)}${c.unit ? ` (${esc(c.unit)})` : ''}</th>`).join('')}</tr></thead>
    <tbody>${r.rows.map((row, i) => `<tr class="${exceptions.has(i) ? 'exception' : ''}">${r.columns.map((c) => `<td class="${numeric(c.type) ? 'n' : ''}">${esc(formatValue(row[c.key], c.type))}</td>`).join('')}</tr>`).join('\n')}</tbody>
  </table></div>` : '<div class="empty">No records match the current scope and filters.</div>'}
  <div class="notes">
    ${r.exceptions?.length ? '<p>▲ marks rows needing attention.</p>' : ''}
    <p>${MISSING} = no data available (not zero).</p>
    ${r.notes.map((n) => `<p>${esc(n)}</p>`).join('')}
    <p>Source: ${esc(r.source)}.</p>
  </div>
</main></body></html>`;
}
