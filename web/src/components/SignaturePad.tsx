import { useEffect, useRef, useState } from 'react';

/** A finger or stylus signature on a tablet. Reports a PNG data URL (or null when cleared). */
/** `initial` is a signature drawn earlier (restored from this device), shown until the person clears or redraws it. */
export function SignaturePad({ onChange, label = 'Customer signature', initial }: { onChange: (png: string | null) => void; label?: string; initial?: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = ref.current!; const ctx = c.getContext('2d')!;
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    if (initial) { const img = new Image(); img.onload = () => { ctx.drawImage(img, 0, 0, c.width, c.height); setEmpty(false); }; img.src = initial; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * ref.current!.width, y: ((e.clientY - r.top) / r.height) * ref.current!.height }; };
  const down = (e: React.PointerEvent) => { drawing.current = true; ref.current!.setPointerCapture(e.pointerId); const ctx = ref.current!.getContext('2d')!; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const ctx = ref.current!.getContext('2d')!; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); if (empty) setEmpty(false); };
  const up = () => { if (!drawing.current) return; drawing.current = false; onChange(ref.current!.toDataURL('image/png')); };
  const clear = () => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setEmpty(true); onChange(null); };
  return (
    <div className="stack">
      <canvas ref={ref} width={640} height={200} role="img" aria-label={`${label}: draw with a finger or stylus`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        style={{ width: '100%', maxWidth: 640, height: 200, border: '2px dashed var(--rule)', borderRadius: 8, background: '#fff', touchAction: 'none' }} />
      <div className="row"><button type="button" onClick={clear} disabled={empty}>Clear signature</button><span className="muted">{empty ? 'Sign above.' : 'Signed.'}</span></div>
    </div>
  );
}
