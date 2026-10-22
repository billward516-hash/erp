import type PDFKit from 'pdfkit';
import type { ColumnType, ReportChart } from '../types.js';
import { formatValue } from './format.js';

/**
 * The shared chart library (brief §15.4): one layout for a report chart, drawn as SVG (print HTML) or with PDFKit,
 * from the same numbers as the table. The web app draws the same specification interactively (web/src/components/
 * ReportChart.tsx). Conventions: one value axis starting at zero, thin marks with 4px rounded data ends and 2px gaps,
 * recessive grid, at most three series in a validated order (legend whenever there are two or more), selective labels
 * (the extremes only), and the table below as the full-precision view.
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'] as const; // light-surface steps; validated (CVD ΔE ≥ 9.2)
const INK = '#1a1f2b'; const MUTED = '#5b6472'; const RULE = '#e3e6eb'; const REF = '#8a5a00';

type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill: string; round?: 'right' | 'top' | 'left' | 'bottom' }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number; dash?: boolean }
  | { t: 'poly'; points: [number, number][]; stroke: string; width: number }
  | { t: 'dot'; x: number; y: number; r: number; fill: string }
  | { t: 'text'; x: number; y: number; text: string; size: number; fill: string; anchor: 'start' | 'middle' | 'end'; bold?: boolean };

export interface ChartLayout { width: number; height: number; shapes: Shape[]; summary: string }

/** "Nice" axis ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5) {
  if (lo === hi) { hi = lo === 0 ? 1 : lo * 1.1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const start = Math.floor(lo / step) * step; const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

/** Compact axis label: $12k, 1.2M, 85%. */
export function axisLabel(v: number, type: ColumnType) {
  if (type === 'percent') return `${Math.round(v * 1000) / 10}%`;
  const a = Math.abs(v);
  const body = a >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${+(v / 1e3).toFixed(0)}k` : a >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`;
  return type === 'currency' ? (v < 0 ? `-$${body.replace('-', '')}` : `$${body}`) : body;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function layoutChart(c: ReportChart, width = 720): ChartLayout {
  const series = c.series.slice(0, 3);
  const values = c.data.flatMap((d) => series.map((s) => num(d[s.key]))).filter((v): v is number => v != null);
  const shapes: Shape[] = [];
  const legendH = series.length > 1 ? 18 : 0;
  if (series.length > 1) {
    let x = 0;
    for (const [i, s] of series.entries()) {
      shapes.push({ t: 'rect', x, y: 3, w: 10, h: 10, fill: SERIES[i]! });
      shapes.push({ t: 'text', x: x + 14, y: 12, text: s.label, size: 10, fill: MUTED, anchor: 'start' });
      x += 24 + s.label.length * 5.6;
    }
  }
  const lo = Math.min(0, ...values, c.reference?.value ?? 0); const hi = Math.max(0, ...values, c.reference?.value ?? 0);
  const ticks = niceTicks(lo, hi);
  const t0 = ticks[0]!; const t1 = ticks[ticks.length - 1]!;
  const fmt = (v: number) => formatValue(v, c.valueType) + (c.unit && c.valueType !== 'currency' ? ` ${c.unit}` : '');
  const extremes = (() => {
    if (series.length !== 1 || values.length < 2) return new Set<number>();
    // The largest value and the smallest non-zero one (a zero bar needs no label).
    const vs = c.data.map((d) => num(d[series[0]!.key]));
    const present = vs.filter((v) => v != null) as number[]; const nonzero = present.filter((v) => v !== 0);
    if (!nonzero.length) return new Set<number>();
    return new Set([vs.indexOf(Math.max(...present)), vs.indexOf(nonzero.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)))]);
  })();

  if (c.kind === 'bars') {
    // Horizontal bars: a ranking of named things (assets, categories).
    const labelW = 170; const rowH = series.length === 1 ? 20 : 8 + series.length * 10; const top = legendH + 18;
    const plotW = width - labelW - 56;
    const x = (v: number) => labelW + ((v - t0) / (t1 - t0)) * plotW;
    const height = top + c.data.length * rowH + 6;
    for (const tk of ticks) {
      shapes.push({ t: 'line', x1: x(tk), y1: top - 4, x2: x(tk), y2: height - 6, stroke: tk === 0 ? MUTED : RULE, width: tk === 0 ? 1 : 0.75 });
      shapes.push({ t: 'text', x: x(tk), y: top - 8, text: axisLabel(tk, c.valueType), size: 9, fill: MUTED, anchor: 'middle' });
    }
    c.data.forEach((d, i) => {
      const y0 = top + i * rowH;
      shapes.push({ t: 'text', x: labelW - 8, y: y0 + rowH / 2 + 3.5, text: clip(String(d[c.category.key] ?? '—'), 28), size: 10, fill: INK, anchor: 'end' });
      series.forEach((s, j) => {
        const v = num(d[s.key]); if (v == null) return;
        const bh = series.length === 1 ? rowH - 6 : 8; const by = y0 + 3 + j * (bh + 2);
        const a = x(Math.min(0, v)); const b = x(Math.max(0, v));
        shapes.push({ t: 'rect', x: a, y: by, w: Math.max(b - a, 1), h: bh, fill: SERIES[j]!, round: v < 0 ? 'left' : 'right' });
        if (extremes.has(i)) shapes.push({ t: 'text', x: v < 0 ? a - 4 : b + 4, y: by + bh / 2 + 3.5, text: fmt(v), size: 9, fill: INK, anchor: v < 0 ? 'end' : 'start' });
      });
    });
    if (c.reference) {
      shapes.push({ t: 'line', x1: x(c.reference.value), y1: top - 4, x2: x(c.reference.value), y2: height - 6, stroke: REF, width: 1.25, dash: true });
      shapes.push({ t: 'text', x: x(c.reference.value) + 4, y: height + 6, text: c.reference.label, size: 9, fill: REF, anchor: 'start' });
    }
    return { width, height: height + (c.reference ? 12 : 0), shapes, summary: summarize(c) };
  }

  // Columns and lines: ordered categories along the bottom (aging buckets, months).
  const left = 52; const top = legendH + 8; const plotH = 150; const bottomLabels = 30;
  const plotW = width - left - 10;
  const y = (v: number) => top + ((t1 - v) / (t1 - t0)) * plotH;
  const n = Math.max(c.data.length, 1); const slot = plotW / n;
  for (const tk of ticks) {
    shapes.push({ t: 'line', x1: left, y1: y(tk), x2: width - 10, y2: y(tk), stroke: tk === 0 ? MUTED : RULE, width: tk === 0 ? 1 : 0.75 });
    shapes.push({ t: 'text', x: left - 6, y: y(tk) + 3, text: axisLabel(tk, c.valueType), size: 9, fill: MUTED, anchor: 'end' });
  }
  const every = Math.ceil(n / 14);
  c.data.forEach((d, i) => {
    if (i % every === 0) shapes.push({ t: 'text', x: left + slot * (i + 0.5), y: top + plotH + 14, text: clip(String(d[c.category.key] ?? ''), Math.max(6, Math.floor(slot * every / 5.5))), size: 9, fill: MUTED, anchor: 'middle' });
  });
  if (c.kind === 'columns') {
    const gw = Math.min(slot * 0.7, 28 * series.length); const bw = (gw - 2 * (series.length - 1)) / series.length;
    c.data.forEach((d, i) => series.forEach((s, j) => {
      const v = num(d[s.key]); if (v == null) return;
      const bx = left + slot * i + (slot - gw) / 2 + j * (bw + 2);
      const a = y(Math.max(0, v)); const b = y(Math.min(0, v));
      shapes.push({ t: 'rect', x: bx, y: a, w: bw, h: Math.max(b - a, 1), fill: SERIES[j]!, round: v < 0 ? 'bottom' : 'top' });
      if (extremes.has(i)) shapes.push({ t: 'text', x: bx + bw / 2, y: v < 0 ? b + 11 : a - 4, text: fmt(v), size: 9, fill: INK, anchor: 'middle' });
    }));
  } else {
    series.forEach((s, j) => {
      const pts = c.data.map((d, i) => [left + slot * (i + 0.5), num(d[s.key])] as const).filter((p) => p[1] != null).map(([px, v]) => [px, y(v!)] as [number, number]);
      if (pts.length > 1) shapes.push({ t: 'poly', points: pts, stroke: SERIES[j]!, width: 2 });
      if (c.data.length <= 24) for (const [px, py] of pts) shapes.push({ t: 'dot', x: px, y: py, r: 4, fill: SERIES[j]! });
    });
    if (series.length === 1) c.data.forEach((d, i) => {
      const v = num(d[series[0]!.key]);
      if (v != null && extremes.has(i)) shapes.push({ t: 'text', x: left + slot * (i + 0.5), y: y(v) - 8, text: fmt(v), size: 9, fill: INK, anchor: 'middle' });
    });
  }
  if (c.reference) {
    shapes.push({ t: 'line', x1: left, y1: y(c.reference.value), x2: width - 10, y2: y(c.reference.value), stroke: REF, width: 1.25, dash: true });
    shapes.push({ t: 'text', x: width - 12, y: y(c.reference.value) - 4, text: c.reference.label, size: 9, fill: REF, anchor: 'end' });
  }
  return { width, height: top + plotH + bottomLabels, shapes, summary: summarize(c) };
}

/** A sentence for screen readers and the PDF alt text. */
function summarize(c: ReportChart) {
  const s = c.series[0]!;
  const vals = c.data.map((d) => ({ k: String(d[c.category.key]), v: num(d[s.key]) })).filter((x) => x.v != null) as { k: string; v: number }[];
  if (!vals.length) return `${c.title}: no data.`;
  const max = vals.reduce((a, b) => (b.v > a.v ? b : a)); const min = vals.reduce((a, b) => (b.v < a.v ? b : a));
  return `${c.title}. ${vals.length} ${c.category.label.toLowerCase()}; highest ${max.k} ${formatValue(max.v, c.valueType)}, lowest ${min.k} ${formatValue(min.v, c.valueType)}.`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function roundedPath(r: Extract<Shape, { t: 'rect' }>) {
  const rr = Math.min(4, r.w / 2, r.h / 2);
  const { x, y, w, h } = r;
  if (!r.round || rr < 1) return `M${x},${y}h${w}v${h}h${-w}z`;
  switch (r.round) {
    case 'right': return `M${x},${y}h${w - rr}q${rr},0 ${rr},${rr}v${h - 2 * rr}q0,${rr} ${-rr},${rr}h${-(w - rr)}z`;
    case 'left': return `M${x + w},${y}v${h}h${-(w - rr)}q${-rr},0 ${-rr},${-rr}v${-(h - 2 * rr)}q0,${-rr} ${rr},${-rr}z`;
    case 'top': return `M${x},${y + h}v${-(h - rr)}q0,${-rr} ${rr},${-rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}v${h - rr}z`;
    default: return `M${x},${y}h${w}v${h - rr}q0,${rr} ${-rr},${rr}h${-(w - 2 * rr)}q${-rr},0 ${-rr},${-rr}z`;
  }
}

export function chartSvg(c: ReportChart, width = 720) {
  const l = layoutChart(c, width);
  const body = l.shapes.map((s) => {
    switch (s.t) {
      case 'rect': return `<path d="${roundedPath(s)}" fill="${s.fill}"/>`;
      case 'line': return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.stroke}" stroke-width="${s.width}"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`;
      case 'poly': return `<polyline points="${s.points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}" stroke-linejoin="round"/>`;
      case 'dot': return `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${s.fill}" stroke="#ffffff" stroke-width="2"/>`;
      default: return `<text x="${s.x}" y="${s.y}" font-size="${s.size}" fill="${s.fill}" text-anchor="${s.anchor}"${s.bold ? ' font-weight="600"' : ''}>${esc(s.text)}</text>`;
    }
  }).join('');
  return `<figure class="chart"><figcaption>${esc(c.title)}</figcaption><svg viewBox="0 0 ${l.width} ${l.height}" width="100%" role="img" aria-label="${esc(l.summary)}" font-family="system-ui, sans-serif">${body}</svg></figure>`;
}

/** Draws the chart at the current position; returns the height used. */
export function drawChartPdf(doc: PDFKit.PDFDocument, c: ReportChart, x0: number, y0: number, width: number, pdfText: (s: string) => string) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(pdfText(c.title), x0, y0, { width });
  const top = y0 + 16;
  const l = layoutChart(c, width);
  for (const s of l.shapes) {
    if (s.t === 'rect') doc.path(roundedPath({ ...s, x: s.x + x0, y: s.y + top })).fill(s.fill);
    else if (s.t === 'line') {
      doc.moveTo(s.x1 + x0, s.y1 + top).lineTo(s.x2 + x0, s.y2 + top).lineWidth(s.width).strokeColor(s.stroke);
      if (s.dash) doc.dash(4, { space: 3 }); doc.stroke(); doc.undash();
    } else if (s.t === 'poly') {
      doc.moveTo(s.points[0]![0] + x0, s.points[0]![1] + top);
      for (const [px, py] of s.points.slice(1)) doc.lineTo(px + x0, py + top);
      doc.lineWidth(s.width).strokeColor(s.stroke).lineJoin('round').stroke();
    } else if (s.t === 'dot') doc.circle(s.x + x0, s.y + top, s.r).lineWidth(1.5).fillAndStroke(s.fill, '#ffffff');
    else {
      doc.font(s.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(s.size * 0.85).fillColor(s.fill);
      const t = pdfText(s.text); const w = doc.widthOfString(t);
      const tx = s.anchor === 'end' ? s.x - w : s.anchor === 'middle' ? s.x - w / 2 : s.x;
      doc.text(t, tx + x0, s.y + top - s.size * 0.75, { lineBreak: false });
    }
  }
  return 16 + l.height;
}
