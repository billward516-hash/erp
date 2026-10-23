/** Thin API client. The bearer token lives in sessionStorage (cleared when the tab closes). */
import { cacheGet, cachePut, cacheable, describe, enqueue, queueable } from './offline';
const TOKEN_KEY = 'erp.token';

export function getToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null) {
  try { token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function request(method: string, path: string, body?: unknown, raw?: { contentType: string; data: Blob | ArrayBuffer }) {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (raw) { headers['content-type'] = raw.contentType; payload = raw.data; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch(path, { method, headers, body: payload }); } catch { throw new ApiError(0, 'offline', 'No connection. Try again when you are back online.'); }
  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, 'unauthenticated', 'Your session has ended. Sign in again.'); }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new ApiError(res.status, e.error?.code ?? 'error', e.error?.message ?? `Request failed (${res.status})`, e.error?.details);
  }
  // A successful save tells the form autosave (D-164) that the entries it was keeping are now saved.
  if (method !== 'GET' && !path.startsWith('/api/drafts') && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('erp:saved', { detail: { method, path } }));
  return res;
}

export const api = {
  /** GET; for the paths technicians need offline, the last answer is saved and served when the network is gone. */
  get: async <T = any>(path: string): Promise<T> => {
    try {
      const data = await (await request('GET', path)).json();
      cachePut(path, data);
      return data;
    } catch (e) {
      const saved = e instanceof ApiError && e.code === 'offline' && cacheable(path) ? cacheGet(path) : null;
      if (saved) return saved.data as T;
      throw e;
    }
  },
  /** POST; work-order labor, parts used and status changes made offline go to the outbox and answer { queued: true }. */
  post: async <T = any>(path: string, body?: unknown): Promise<T> => {
    const queue = () => { enqueue('POST', path, body ?? {}, describe(path, body)); return { queued: true } as T; };
    if (queueable('POST', path) && typeof navigator !== 'undefined' && navigator.onLine === false) return queue();
    try {
      const r = await request('POST', path, body ?? {});
      return r.status === 204 ? (undefined as T) : r.json();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'offline' && queueable('POST', path)) return queue();
      throw e;
    }
  },
  patch: async <T = any>(path: string, body: unknown): Promise<T> => { const r = await request('PATCH', path, body); return r.status === 204 ? (undefined as T) : r.json(); },
  put: async (path: string, body: unknown): Promise<void> => { await request('PUT', path, body); },
  delete: async (path: string): Promise<void> => { await request('DELETE', path); },
  upload: async <T = any>(path: string, file: File): Promise<T> =>
    (await request('POST', path, undefined, { contentType: file.type || 'application/octet-stream', data: file })).json(),
  /** Downloads a protected file and hands it to the browser with its server-provided name. */
  download: async (path: string, fallbackName = 'download') => {
    const res = await request('GET', path);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  /** Fetches a protected file as an object URL for in-page viewing; the caller revokes it. */
  blob: async (path: string): Promise<{ url: string; type: string; text?: string }> => {
    const res = await request('GET', path);
    const blob = await res.blob();
    const type = blob.type || res.headers.get('content-type') || 'application/octet-stream';
    return { url: URL.createObjectURL(blob), type, text: type.startsWith('text/') || type.includes('+json') ? await blob.text() : undefined };
  },
  /** Opens a protected PDF/HTML in a new tab. */
  open: async (path: string) => {
    const res = await request('GET', path);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
