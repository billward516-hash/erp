import PDFDocument from 'pdfkit';
import type { ReportResult } from '../types.js';
import { formatValue, MISSING, TOKENS } from './format.js';
import { drawChartPdf, layoutChart } from './chart.js';

const STATUS_LABEL = { good: 'On track', watch: 'Watch', bad: 'Action needed', neutral: '' } as const;

/** Standard PDF fonts are WinAnsi-encoded; map symbols they lack to plain equivalents. */
export const pdfText = (s: string) => s.replace(/−/g, '-').replace(/÷/g, '/').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->').replace(/[▲]/g, '*');

/** Polished, printable PDF (US Letter landscape) from the same computed report used by every format. */
export function reportToPdf(r: ReportResult): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margins: { top: 40, bottom: 48, left: 40, right: 40 }, bufferPages: true,
    info: { Title: r.name, Subject: r.headline, Creator: 'ERP platform reporting service' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  doc.fillColor(TOKENS.accent).font(TOKENS.fontBold).fontSize(9).text(r.name.toUpperCase(), left, 40, { characterSpacing: 0.8 });
  doc.moveDown(0.3).fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(17).text(pdfText(r.headline), { width });
  const meta = [r.period ? `Period ${r.period.from.slice(0, 10)} to ${r.period.to.slice(0, 10)}` : null, `Scope: ${r.scope.description}`,
    `Generated ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC`].filter(Boolean).join('  ·  ');
  doc.moveDown(0.3).fillColor(TOKENS.muted).font(TOKENS.font).fontSize(8.5).text(pdfText(meta), { width });

  // KPI band
  const kpiTop = doc.y + 12;
  const kpiW = (width - 10 * (r.kpis.length - 1)) / Math.max(r.kpis.length, 1);
  r.kpis.forEach((k, i) => {
    const x = left + i * (kpiW + 10);
    const color = k.status === 'good' ? TOKENS.good : k.status === 'watch' ? TOKENS.watch : k.status === 'bad' ? TOKENS.bad : TOKENS.accent;
    doc.rect(x, kpiTop, kpiW, 52).fill(TOKENS.surface);
    doc.rect(x, kpiTop, kpiW, 2.5).fill(color);
    doc.fillColor(TOKENS.ink).font(TOKENS.fontBold).fontSize(16).text(formatValue(k.value, k.type) + (k.type === 'hours' && k.value !== null ? ' h' : ''), x + 8, kpiTop + 9, { width: kpiW - 16 });
    doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(7.5).text(pdfText(`${k.label}${k.note ? ` · ${k.note}` : ''}`), x + 8, kpiTop + 30, { width: kpiW - 16, height: 10, ellipsis: true });
    if (k.status && k.status !== 'neutral') doc.fillColor(color).font(TOKENS.fontBold).fontSize(7).text(STATUS_LABEL[k.status], x + 8, kpiTop + 41, { width: kpiW - 16 });
  });
  doc.y = kpiTop + 64;

  if (r.insights.length) {
    doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(9.5);
    for (const i of r.insights) doc.text(`•  ${pdfText(i)}`, left, doc.y, { width, paragraphGap: 2 });
    doc.moveDown(0.6);
  }

  // Charts, each kept whole on a page.
  for (const c of r.charts ?? []) {
    const chartW = Math.min(width, 640);
    const need = 16 + layoutChart(c, chartW).height + 12;
    if (doc.y + need > bottom()) doc.addPage();
    doc.y += drawChartPdf(doc, c, left, doc.y, chartW, pdfText) + 12;
  }

  // Table with repeated header on each page
  const totalW = r.columns.reduce((s, c) => s + (c.width ?? 1), 0);
  const colW = r.columns.map((c) => ((c.width ?? 1) / totalW) * width);
  const numeric = (t: string) => !['text', 'date', 'datetime'].includes(t);
  const exceptions = new Set(r.exceptions ?? []);
  const header = () => {
    let x = left;
    const y = doc.y;
    doc.font(TOKENS.fontBold).fontSize(7.5).fillColor(TOKENS.muted);
    const labels = r.columns.map((c) => pdfText(`${c.label}${c.unit ? ` (${c.unit})` : ''}`));
    const h = Math.max(...labels.map((t, i) => doc.heightOfString(t, { width: colW[i]! - 6 })));
    labels.forEach((t, i) => {
      // Bottom-align wrapped labels so all headers sit on the rule.
      const th = doc.heightOfString(t, { width: colW[i]! - 6 });
      doc.text(t, x + 3, y + h - th, { width: colW[i]! - 6, align: numeric(r.columns[i]!.type) ? 'right' : 'left' });
      x += colW[i]!;
    });
    doc.moveTo(left, y + h + 2).lineTo(left + width, y + h + 2).lineWidth(1).strokeColor(TOKENS.ink).stroke();
    doc.y = y + h + 6;
  };
  if (!r.rows.length) {
    doc.rect(left, doc.y, width, 30).fill(TOKENS.surface);
    doc.fillColor(TOKENS.muted).font(TOKENS.font).fontSize(9).text('No records match the current scope and filters.', left, doc.y + 10, { width, align: 'center' });
    doc.moveDown(2);
  } else {
    // Keep the header with its first rows: start a new page when fewer than three rows would fit.
    if (doc.y + 70 > bottom() - 40) { doc.addPage(); doc.y = doc.page.margins.top; }
    header();
    r.rows.forEach((row, ri) => {
      doc.font(TOKENS.font).fontSize(7.5);
      const cells = r.columns.map((c) => pdfText(formatValue(row[c.key], c.type)));
      const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: colW[i]! - 6 }))) + 6;
      if (doc.y + h > bottom() - 40) { doc.addPage(); doc.y = doc.page.margins.top; header(); }
      const y = doc.y;
      if (exceptions.has(ri)) doc.rect(left, y - 2, 2.5, h - 2).fill(TOKENS.bad);
      let x = left;
      doc.fillColor(TOKENS.ink).font(TOKENS.font).fontSize(7.5);
      cells.forEach((t, i) => { doc.text(t, x + 3, y, { width: colW[i]! - 6, align: numeric(r.columns[i]!.type) ? 'right' : 'left' }); x += colW[i]!; });
      doc.moveTo(left, y + h - 3).lineTo(left + width, y + h - 3).lineWidth(0.4).strokeColor(TOKENS.rule).stroke();
      doc.y = y + h;
    });
  }

  // Notes
  const notes = [...(r.exceptions?.length ? ['Red bar marks rows needing attention.'] : []), `${MISSING} = no data available (not zero).`, ...r.notes, `Source: ${r.source}.`];
  doc.font(TOKENS.font).fontSize(7).fillColor(TOKENS.muted);
  const notesH = notes.reduce((s, n) => s + doc.heightOfString(n, { width }) + 2, 10);
  if (doc.y + notesH > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; }
  doc.moveDown(0.8);
  for (const n of notes) doc.text(pdfText(n), left, doc.y, { width, paragraphGap: 2 });

  // Footer: page numbers + finding on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would otherwise make pdfkit start a new page.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 30;
    doc.font(TOKENS.font).fontSize(7).fillColor(TOKENS.muted)
      .text(pdfText(`${r.name} · ${r.scope.description}`), left, y, { width: width - 80, lineBreak: false, ellipsis: true })
      .text(`Page ${i + 1} of ${range.count}`, left + width - 80, y, { width: 80, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
