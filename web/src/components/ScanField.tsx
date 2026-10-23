import { useEffect, useRef, useState } from 'react';

/** Short tones so a scan can be heard from across a storeroom: one rising for accepted, one low double for refused. */
export function beep(ok: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (f: number, at: number, len: number) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.value = f; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + len); };
    if (ok) tone(1100, 0, 0.12); else { tone(220, 0, 0.18); tone(180, 0.22, 0.22); }
    setTimeout(() => void ctx.close(), 800);
  } catch { /* sound is a convenience */ }
}

/**
 * The one field every scan lands in. A USB or Bluetooth scanner types the code and presses Enter, so the field keeps focus and sends
 * on Enter; the code can also be typed. Where the browser has a barcode detector (Chrome on Android and some tablets), a camera
 * button reads one code at a time.
 */
export function ScanField({ onScan, label = 'Scan or type a code', busy }: { onScan: (code: string) => void; label?: string; busy?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const hasCamera = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => { if (!camera) ref.current?.focus(); });
  useEffect(() => {
    if (!camera) return;
    let stop = false; let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const detector = new (window as any).BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'itf'] });
        while (!stop && video.current) {
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { onScan(found[0].rawValue); setCamera(false); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { setCamera(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = () => { const v = value.trim(); if (v) { onScan(v); setValue(''); } };
  return (
    <div className="scan-field">
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input ref={ref} id="scan-input" aria-label={label} placeholder={label} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy} />
        <button type="submit" className="primary" disabled={busy || !value.trim()}>Enter</button>
        {hasCamera && <button type="button" onClick={() => setCamera((c) => !c)}>{camera ? 'Stop camera' : 'Camera'}</button>}
      </form>
      {camera && <video ref={video} className="scan-video" muted playsInline aria-label="Camera view for scanning" />}
    </div>
  );
}
