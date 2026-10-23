/** Thin API client. The bearer token lives in sessionStorage (cleared when the tab closes). */
import { cacheGet, cachePut, cacheable, describe, enqueue, newKey, queueable } from './offline';
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

async function request(method: string, path: string, body?: unknown, raw?: { contentType: string; data: Blob | ArrayBuffer }, key?: string) {
  const headers: Record<string, string> = {};
  if (key) headers['idempotency-key'] = key;
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
      const text = await (await request('GET', path)).text(); // an empty answer is "nothing there" (a visit with no report draft yet)
      const data = text ? JSON.parse(text) : null;
      cachePut(path, data);
      return data;
    } catch (e) {
      const saved = e instanceof ApiError && e.code === 'offline' && cacheable(path) ? cacheGet(path) : null;
      if (saved) return saved.data as T;
      throw e;
    }
  },
  /**
   * POST; the offline-capable writes (work-order labor, parts and status, visit start and report) carry an Idempotency-Key from the first try, and
   * when there is no connection they go to the outbox with that same key and answer { queued: true }.
   */
  post: async <T = any>(path: string, body?: unknown): Promise<T> => {
    const can = queueable('POST', path);
    const key = can ? newKey() : undefined;
    const queue = () => { enqueue('POST', path, body ?? {}, describe(path, body), key); return { queued: true } as T; };
    if (can && typeof navigator !== 'undefined' && navigator.onLine === false) return queue();
    try {
      const r = await request('POST', path, body ?? {}, undefined, key);
      return r.status === 204 ? (undefined as T) : r.json();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'offline' && can) return queue();
      throw e;
    }
  },
  patch: async <T = any>(path: string, body: unknown): Promise<T> => { const r = await request('PATCH', path, body); return r.status === 204 ? (undefined as T) : r.json(); },
  /** PUT; the service report draft is kept in the outbox when there is no connection (the latest draft replaces an older unsent one). */
  put: async (path: string, body: unknown): Promise<{ queued: true } | undefined> => {
    const can = queueable('PUT', path);
    const key = can ? newKey() : undefined;
    const queue = () => { enqueue('PUT', path, body, describe(path, body), key); return { queued: true } as const; };
    if (can && typeof navigator !== 'undefined' && navigator.onLine === false) return queue();
    try { await request('PUT', path, body, undefined, key); return undefined; } catch (e) {
      if (e instanceof ApiError && e.code === 'offline' && can) return queue();
      throw e;
    }
  },
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
  /** POSTs a request whose answer is a PDF (label sheets) and opens it in a new tab. */
  openPost: async (path: string, body: unknown) => {
    const res = await request('POST', path, body);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
