/**
 * Clickable preview (no server). In a preview build the app replays answers recorded from a seeded server (scripts/record-demo.ts)
 * and refuses every change. Nothing here is loaded in the real app.
 */
export const DEMO = import.meta.env.VITE_DEMO === '1';
export const GUIDE_URL = 'https://claude.ai/artifact/NyLdw5yN6kkTyH7GDcUHvu';

type Recorded = Record<string, { label: string; blurb: string; data: Record<string, { s: number; b: unknown }> }>;
const PERSONA_KEY = 'erp.demo.persona';

function currentPersona(recorded: Recorded): string {
  try { const p = sessionStorage.getItem(PERSONA_KEY); if (p && recorded[p]) return p; } catch { /* storage blocked */ }
  return 'admin';
}

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The recorded answers arrive as window.__DEMO_DATA__, set by an inline script that scripts/build-demo-page.ts puts ahead of the app. */
export function installDemo() {
  const recorded = (window as unknown as { __DEMO_DATA__: Recorded }).__DEMO_DATA__;
  const persona = currentPersona(recorded);
  const answers = recorded[persona]!.data;
  try { sessionStorage.setItem('erp.token', 'preview'); } catch { /* storage blocked */ }
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const url = new URL(raw, window.location.href);
    const path = raw.startsWith('/') ? raw : url.pathname + url.search;
    if (!path.startsWith('/api/') && !path.startsWith('/public/')) return real(input, init);
    if (method === 'GET') {
      const hit = answers[path] ?? answers[path.split('?')[0]!];
      if (hit) return json(hit.s, hit.b);
      return json(404, { error: { code: 'not_in_preview', message: 'This part was not recorded for the preview. The full system shows it.' } });
    }
    if (path === '/api/session/sign-out') return json(204, null);
    return json(409, { error: { code: 'preview_read_only', message: 'This is a read-only preview with sample data. Changes are not saved.' } });
  };

  const bar = document.createElement('div');
  bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Preview controls');
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 16px;background:#14202e;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.25)';
  const label = document.createElement('span');
  label.innerHTML = '<strong>Preview</strong> with sample data, read-only. View as:';
  bar.appendChild(label);
  for (const [id, p] of Object.entries(recorded)) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = p.label; b.title = p.blurb;
    const on = id === persona;
    b.style.cssText = `font:inherit;padding:3px 10px;border-radius:14px;border:1px solid #6b8cae;cursor:pointer;background:${on ? '#fff' : 'transparent'};color:${on ? '#14202e' : '#fff'}`;
    b.setAttribute('aria-pressed', String(on));
    b.onclick = () => { try { sessionStorage.setItem(PERSONA_KEY, id); } catch { /* storage blocked */ } window.location.reload(); };
    bar.appendChild(b);
  }
  const who = document.createElement('span');
  who.style.cssText = 'margin-left:auto;opacity:.8'; who.textContent = recorded[persona]!.blurb;
  bar.appendChild(who);
  document.body.appendChild(bar);
  document.body.style.paddingBottom = '48px';
}
