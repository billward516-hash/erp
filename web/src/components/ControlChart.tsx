import { useState } from 'react';

export interface ChartPoint { id: string; y: number | null; label: string; flag?: 'signal' | 'excluded' | 'suspect' | null; tip: string[] }
interface Line { y: number; label: string; kind: 'center' | 'limit' | 'spec' }

const W = 760; const H = 220; const PAD = { l: 64, r: 92, t: 12, b: 26 };

/**
 * One control chart (X̄, individuals, R or moving range): the statistic as a 2px line with markers, the center line,
 * dashed control limits and, when given, the tolerance, each labelled at the right edge. Signals are larger diamonds
 * in the bad tone with a label in the tooltip; excluded points are hollow. The subgroup table is the table view.
 */
export function ControlChart({ title, points, lines, unit, digits = 4 }: { title: string; points: ChartPoint[]; lines: Line[]; unit: string; digits?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const ys = [...points.map((p) => p.y).filter((y): y is number => y != null), ...lines.map((l) => l.y)];
  if (!ys.length) return null;
  let lo = Math.min(...ys); let hi = Math.max(...ys);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08; lo -= pad; hi += pad;
  const x = (i: number) => PAD.l + (points.length <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (points.length - 1));
  const y = (v: number) => PAD.t + ((hi - v) * (H - PAD.t - PAD.b)) / (hi - lo);
  const fmt = (v: number) => v.toFixed(digits);
  const path = points.map((p, i) => (p.y == null || p.flag === 'excluded' ? null : `${x(i)},${y(p.y)}`)).filter(Boolean);
  const step = (W - PAD.l - PAD.r) / Math.max(1, points.length - 1);
  const signals = points.filter((p) => p.flag === 'signal').length;
  const h = hover != null ? points[hover] : null;
  return (
    <figure className="chart" style={{ margin: 0, position: 'relative' }}>
      <figcaption className="muted" style={{ fontSize: 13, marginBottom: 4 }}>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" style={{ width: '100%', height: 'auto', display: 'block' }}
        aria-label={`${title}: ${points.length} points, ${signals} signalling. ${lines.map((l) => `${l.label} ${fmt(l.y)}`).join(', ')}`}
        onMouseLeave={() => setHover(null)}>
        {lines.map((l) => (
          <g key={l.label}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(l.y)} y2={y(l.y)} stroke={l.kind === 'spec' ? 'var(--watch)' : l.kind === 'limit' ? 'var(--muted)' : 'var(--faint)'}
              strokeWidth={1} strokeDasharray={l.kind === 'center' ? undefined : l.kind === 'spec' ? '2 3' : '6 4'} />
            <text x={W - PAD.r + 6} y={y(l.y) + 4} fontSize={11} fill="var(--muted)">{l.label} {fmt(l.y)}</text>
          </g>
        ))}
        <text x={PAD.l - 8} y={PAD.t + 4} fontSize={11} fill="var(--faint)" textAnchor="end">{unit}</text>
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={H - PAD.b} stroke="var(--rule)" />
        {points.length > 0 && <>
          <text x={PAD.l} y={H - 8} fontSize={11} fill="var(--faint)">{points[0]!.label}</text>
          <text x={W - PAD.r} y={H - 8} fontSize={11} fill="var(--faint)" textAnchor="end">{points[points.length - 1]!.label}</text>
        </>}
        {path.length > 1 && <polyline points={path.join(' ')} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--rule)" />}
        {points.map((p, i) => p.y == null ? null : (
          <g key={p.id}>
            {p.flag === 'signal'
              ? <path d={`M${x(i)},${y(p.y) - 7} l7,7 l-7,7 l-7,-7 z`} fill="var(--bad)" stroke="var(--panel)" strokeWidth={2} />
              : <circle cx={x(i)} cy={y(p.y)} r={p.flag === 'excluded' ? 4 : 4} fill={p.flag === 'excluded' ? 'var(--panel)' : 'var(--accent)'}
                stroke={p.flag === 'excluded' ? 'var(--faint)' : p.flag === 'suspect' ? 'var(--watch)' : 'var(--panel)'} strokeWidth={2} />}
            <rect x={x(i) - step / 2} y={PAD.t} width={Math.max(step, 8)} height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} />
          </g>
        ))}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
          <strong>{h.y != null ? fmt(h.y) : '—'} {unit}</strong>
          {h.tip.map((t) => <div key={t}>{t}</div>)}
        </div>
      )}
    </figure>
  );
}
