/**
 * Offline support for technicians (D-121). Two pieces, both in this browser only:
 *  - a read cache: the last answer for "my work orders" and the work orders opened, shown when the network is gone
 *    (marked as a saved copy);
 *  - an outbox: labor, parts used and status changes made offline are kept in order and sent when the connection
 *    returns, each with an Idempotency-Key so a replay after a lost response cannot post twice.
 * Storage is per signed-in person and cleared on a deliberate sign-out (not when a session simply expires). Anything the server refuses on sync stays in the outbox with
 * its reason for the technician to fix or discard; nothing is dropped silently.
 */

export const OFFLINE_WRITES = [/^\/api\/work-orders\/[0-9a-f-]{36}\/(labor|parts|transition)$/];
export const CACHED_READS = [/^\/api\/work-orders\?/, /^\/api\/work-orders\/[0-9a-f-]{36}$/, /^\/api\/me$/, /^\/api\/home(\?|$)/];

export interface Queued { id: string; method: string; path: string; body: unknown; label: string; createdAt: string; error?: string }

/** Saved copies and the outbox belong to the person, not the token, so a session that expired mid-shift does not orphan unsent changes. */
let scopeUser: string | null = null;
export const setScopeUser = (id: string | null) => { scopeUser = id; };
const scope = () => {
  if (scopeUser) return `p${scopeUser.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  let t = '';
  try { t = sessionStorage.getItem('erp.token') ?? ''; } catch { /* storage blocked */ }
  let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return `u${(h >>> 0).toString(36)}`;
};
const read = <T>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: offline copy is a convenience */ } };

// ---------------------------------------------------------------------------
// Read cache
// ---------------------------------------------------------------------------

const servedFromCache = new Map<string, string>();
export const cacheable = (path: string) => CACHED_READS.some((r) => r.test(path));
export function cachePut(path: string, data: unknown) {
  if (!cacheable(path)) return;
  write(`erp.cache:${scope()}:${path}`, { at: new Date().toISOString(), data });
  servedFromCache.delete(path);
}
export function cacheGet(path: string): { at: string; data: unknown } | null {
  const v = read<{ at: string; data: unknown } | null>(`erp.cache:${scope()}:${path}`, null);
  if (v) servedFromCache.set(path, v.at);
  return v;
}
/** When the last answer for the path came from the saved copy, its time; null when it came from the server. */
export const offlineCopyAt = (path: string) => servedFromCache.get(path) ?? null;

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

const outboxKey = () => `erp.outbox:${scope()}`;
const changed = () => window.dispatchEvent(new Event('erp-outbox'));
export const outbox = (): Queued[] => read<Queued[]>(outboxKey(), []);
export const queueable = (method: string, path: string) => method === 'POST' && OFFLINE_WRITES.some((r) => r.test(path));
export function enqueue(method: string, path: string, body: unknown, label: string): Queued {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const q = { id, method, path, body, label, createdAt: new Date().toISOString() };
  write(outboxKey(), [...outbox(), q]); changed();
  return q;
}
export function discard(id: string) { write(outboxKey(), outbox().filter((q) => q.id !== id)); changed(); }
export function clearOffline() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`erp.cache:${scope()}:`) || k === outboxKey()) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
  servedFromCache.clear(); changed();
}

/** What a queued request does, for people: "1.5 h labor", "Start work", "Part used". */
export function describe(path: string, body: any) {
  if (path.endsWith('/labor')) return `${body?.hours ?? '?'} h labor on ${body?.workDate ?? ''}`;
  if (path.endsWith('/parts')) return `Part used × ${body?.qtyUsed ?? '?'}`;
  if (path.endsWith('/transition')) return ({ in_progress: 'Start work', on_hold: 'Put on hold', completed: 'Mark complete' } as Record<string, string>)[body?.to] ?? `Status → ${body?.to}`;
  return `${path}`;
}

let syncing = false;
/**
 * Sends the outbox in order. A network failure stops the run (try again later); a refusal by the server marks that
 * item with the reason and carries on, so one bad entry does not block the rest.
 */
export async function syncOutbox(): Promise<{ sent: number; failed: number }> {
  if (syncing || (typeof navigator !== 'undefined' && navigator.onLine === false)) return { sent: 0, failed: 0 };
  syncing = true; changed();
  let sent = 0; let failed = 0;
  try {
    for (const q of outbox()) {
      if (q.error) { failed++; continue; }
      let token = '';
      try { token = sessionStorage.getItem('erp.token') ?? ''; } catch { /* storage blocked */ }
      let res: Response;
      try {
        res = await fetch(q.path, { method: q.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': q.id }, body: JSON.stringify(q.body ?? {}) });
      } catch { break; } // still offline
      if (res.ok) { discard(q.id); sent++; continue; }
      if (res.status === 401) break; // signed out: keep for the next sign-in
      const e = await res.json().catch(() => ({}));
      write(outboxKey(), outbox().map((x) => (x.id === q.id ? { ...x, error: e.error?.message ?? `refused (${res.status})` } : x))); failed++;
    }
  } finally { syncing = false; changed(); }
  return { sent, failed };
}
export const isSyncing = () => syncing;
export function retry(id: string) { write(outboxKey(), outbox().map((x) => (x.id === id ? { ...x, error: undefined } : x))); changed(); void syncOutbox(); }
