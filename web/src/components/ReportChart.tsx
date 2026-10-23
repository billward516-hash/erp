import { useRef, useState } from 'react';
import { fmtMoney, fmtNum, fmtPct } from '../format';

/**
 * A report chart drawn from the report's chart specification, the same one the PDF and print views use
 * (src/modules/reporting/render/chart.ts): bars (a ranking), columns (ordered buckets) or a line (a trend). One value
 * axis from zero, thin marks with rounded data ends, at most three series in the validated order (--series-1..3,
 * stepped for light and dark), a legend for two or more, labels on the extremes only, a tooltip on hover, a screen-reader summary,
 * and the table below as the full-precision view.
 */
interface Spec { kind: 'bars' | 'columns' | 'line'; title: string; category: { key: string; label: string }; series: { key: string; label: string }[];
  valueType: string; unit?: string; data: Record<string, unknown>[]; reference?: { value: number; label: string } }

const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
function ticks(lo: number, hi: number, count = 5) {
  if (lo === hi) hi = lo === 0 ? 1 : lo * 1.1;
  const raw = (hi - lo) / count; const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}
function axis(v: number, type: string) {
  if (type === 'percent') return `${Math.round(v * 1000) / 10}%`;
  const a = Math.abs(v);
  const b = a >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${+(v / 1e3).toFixed(0)}k` : a >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`;
  return type === 'currency' ? (v < 0 ? `-$${b.replace('-', '')}` : `$${b}`) : b;
}
function value(v: number, type: string, unit?: string) {
  const s = type === 'currency' ? fmtMoney(v) : type === 'percent' ? fmtPct(v) : type === 'integer' ? fmtNum(v, 0) : fmtNum(v);
  return unit && type !== 'currency' ? `${s} ${unit}` : s;
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bar = (x: number, y: number, w: number, h: number, round: 'right' | 'left' | 'top' | 'bottom') => {
  const r = Math.min(4, w / 2, h / 2);
  if (r < 1) return `M${x},${y}h${w}v${h}h${-w}z`;
  if (round === 'right') return `M${x},${y}h${w - r}q${r},0 ${r},${r}v${h - 2 * r}q0,${r} ${-r},${r}h${-(w - r)}z`;
  if (round === 'left') return `M${x + w},${y}v${h}h${-(w - r)}q${-r},0 ${-r},${-r}v${-(h - 2 * r)}q0,${-r} ${r},${-r}z`;
  if (round === 'top') return `M${x},${y + h}v${-(h - r)}q0,${-r} ${r},${-r}h${w - 2 * r}q${r},0 ${r},${r}v${h - r}z`;
  return `M${x},${y}h${w}v${h - r}q0,${r} ${-r},${r}h${-(w - 2 * r)}q${-r},0 ${-r},${-r}z`;
};

export function ReportChart({ spec }: { spec: Spec }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const series = spec.series.slice(0, 3);
  const vals = spec.data.flatMap((d) => series.map((s) => num(d[s.key]))).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const tk = ticks(Math.min(0, ...vals, spec.reference?.value ?? 0), Math.max(0, ...vals, spec.reference?.value ?? 0));
  const t0 = tk[0]!; const t1 = tk[tk.length - 1]!;
  const single = series.length === 1 ? spec.data.map((d) => num(d[series[0]!.key])) : [];
  const present = single.filter((v): v is number => v != null);
  // Label the largest and the smallest non-zero value (a zero bar needs no label).
  const nonzero = present.filter((v) => v !== 0);
  const extremes = new Set(present.length > 1 && nonzero.length ? [single.indexOf(Math.max(...present)), single.indexOf(nonzero.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)))] : []);
  const W = 760; const color = (j: number) => `var(--series-${j + 1})`;
  let body: (JSX.Element | null)[] = []; let H: number;
  const hit: JSX.Element[] = [];

  if (spec.kind === 'bars') {
    const labelW = 180; const rowH = series.length === 1 ? 22 : 8 + series.length * 10; const top = 20; const plotW = W - labelW - 64;
    const x = (v: number) => labelW + ((v - t0) / (t1 - t0)) * plotW;
    H = top + spec.data.length * rowH + 8 + (spec.reference ? 14 : 0);
    body = [
      ...tk.map((t) => <g key={`t${t}`}><line x1={x(t)} x2={x(t)} y1={top - 4} y2={top + spec.data.length * rowH} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
        <text x={x(t)} y={top - 8} textAnchor="middle" className="chart-axis">{axis(t, spec.valueType)}</text></g>),
      ...spec.data.flatMap((d, i) => {
        const y0 = top + i * rowH;
        return [<text key={`l${i}`} x={labelW - 8} y={y0 + rowH / 2 + 4} textAnchor="end" className="chart-label">{clip(String(d[spec.category.key] ?? '—'), 28)}</text>,
          ...series.map((s, j) => {
            const v = num(d[s.key]); if (v == null) return null;
            const bh = series.length === 1 ? rowH - 6 : 8; const by = y0 + 3 + j * (bh + 2);
            const a = x(Math.min(0, v)); const b = x(Math.max(0, v));
            return <g key={`b${i}${j}`}><path d={bar(a, by, Math.max(b - a, 1), bh, v < 0 ? 'left' : 'right')} fill={color(j)} opacity={hover == null || hover === i ? 1 : 0.45} />
              {extremes.has(i) && <text x={v < 0 ? a - 4 : b + 4} y={by + bh / 2 + 4} textAnchor={v < 0 ? 'end' : 'start'} className="chart-value">{value(v, spec.valueType, spec.unit)}</text>}</g>;
          })];
      }),
      ...(spec.reference ? [<g key="ref"><line x1={x(spec.reference.value)} x2={x(spec.reference.value)} y1={top - 4} y2={top + spec.data.length * rowH} className="chart-ref" />
        <text x={x(spec.reference.value) + 4} y={H - 2} className="chart-ref-label">{spec.reference.label}</text></g>] : []),
    ];
    spec.data.forEach((_, i) => hit.push(<rect key={`h${i}`} x={0} y={top + i * rowH} width={W} height={rowH} fill="transparent" onMouseEnter={() => setHover(i)} />));
  } else {
    const left = 56; const top = 10; const plotH = 160; const plotW = W - left - 10; const n = spec.data.length; const slot = plotW / n;
    const y = (v: number) => top + ((t1 - v) / (t1 - t0)) * plotH;
    H = top + plotH + 30;
    const every = Math.ceil(n / 14);
    body = [
      ...tk.map((t) => <g key={`t${t}`}><line x1={left} x2={W - 10} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
        <text x={left - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">{axis(t, spec.valueType)}</text></g>),
      ...spec.data.map((d, i) => (i % every === 0 ? <text key={`c${i}`} x={left + slot * (i + 0.5)} y={top + plotH + 16} textAnchor="middle" className="chart-axis">{clip(String(d[spec.category.key] ?? ''), Math.max(6, Math.floor((slot * every) / 6)))}</text> : null)).filter(Boolean) as JSX.Element[],
    ];
    if (spec.kind === 'columns') {
      const gw = Math.min(slot * 0.7, 30 * series.length); const bw = (gw - 2 * (series.length - 1)) / series.length;
      spec.data.forEach((d, i) => series.forEach((s, j) => {
        const v = num(d[s.key]); if (v == null) return;
        const bx = left + slot * i + (slot - gw) / 2 + j * (bw + 2); const a = y(Math.max(0, v)); const b = y(Math.min(0, v));
        body.push(<g key={`b${i}${j}`}><path d={bar(bx, a, bw, Math.max(b - a, 1), v < 0 ? 'bottom' : 'top')} fill={color(j)} opacity={hover == null || hover === i ? 1 : 0.45} />
          {extremes.has(i) && <text x={bx + bw / 2} y={v < 0 ? b + 12 : a - 5} textAnchor="middle" className="chart-value">{value(v, spec.valueType, spec.unit)}</text>}</g>);
      }));
    } else {
      series.forEach((s, j) => {
        const pts = spec.data.map((d, i) => [left + slot * (i + 0.5), num(d[s.key])] as const).filter((p) => p[1] != null).map(([px, v]) => [px, y(v!)]);
        body.push(<polyline key={`p${j}`} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={color(j)} strokeWidth={2} strokeLinejoin="round" />);
        if (n <= 24) pts.forEach(([px, py], i) => body.push(<circle key={`d${j}${i}`} cx={px} cy={py} r={4} fill={color(j)} className="chart-dot" />));
      });
    }
    if (spec.reference) body.push(<g key="ref"><line x1={left} x2={W - 10} y1={y(spec.reference.value)} y2={y(spec.reference.value)} className="chart-ref" />
      <text x={W - 12} y={y(spec.reference.value) - 4} textAnchor="end" className="chart-ref-label">{spec.reference.label}</text></g>);
    if (hover != null) body.push(<line key="cross" x1={left + slot * (hover + 0.5)} x2={left + slot * (hover + 0.5)} y1={top} y2={top + plotH} className="chart-cross" />);
    spec.data.forEach((_, i) => hit.push(<rect key={`h${i}`} x={left + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />));
  }

  const d = hover != null ? spec.data[hover] : null;
  const download = () => {
    const svg = ref.current; if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const cs = getComputedStyle(svg);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('style', [1, 2, 3].map((k) => `--series-${k}:${cs.getPropertyValue(`--series-${k}`)}`).join(';') + `;font-family:${cs.fontFamily};color:${cs.color}`);
    const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${spec.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.svg`; a.click(); URL.revokeObjectURL(a.href);
  };
  const summary = (() => {
    if (!present.length) return `${spec.title}: ${spec.data.length} ${spec.category.label.toLowerCase()}.`;
    const mi = single.indexOf(Math.max(...present)); const ni = single.indexOf(Math.min(...present));
    return `${spec.title}. Highest ${spec.data[mi]![spec.category.key]} ${value(present[present.indexOf(single[mi]!)]!, spec.valueType, spec.unit)}; lowest ${spec.data[ni]![spec.category.key]} ${value(single[ni]!, spec.valueType, spec.unit)}. The table below lists every value.`;
  })();
  return (
    <figure className="report-chart" onMouseLeave={() => setHover(null)}>
      <div className="spread"><figcaption>{spec.title}</figcaption><button className="link" onClick={download}>Download image</button></div>
      {series.length > 1 && <div className="chart-legend">{series.map((s, j) => <span key={s.key}><i style={{ background: color(j) }} />{s.label}</span>)}</div>}
      <div style={{ position: 'relative' }}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} style={{ width: '100%', height: 'auto', display: 'block' }}>{body}{hit}</svg>
        {d && (
          <div className="chart-tip" role="status">
            <strong>{String(d[spec.category.key] ?? '')}</strong>
            {series.map((s, j) => { const v = num(d[s.key]); return <div key={s.key}>{series.length > 1 && <i style={{ background: color(j) }} />}{s.label}: {v == null ? '—' : value(v, spec.valueType, spec.unit)}</div>; })}
          </div>
        )}
      </div>
    </figure>
  );
}
