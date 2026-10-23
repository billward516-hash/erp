import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Queued } from './offline';
import { isSyncing, offlineCopyAt, outbox } from './offline';

/** Fetches JSON for a path; refetches when the path changes. `reload()` re-runs it after a mutation. */
export function useApi<T = any>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: Error; loading: boolean }>({ path: null, loading: false });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const d = await api.get<T>(path);
      if (n === seq.current) setState({ path, data: d, loading: false });
    } catch (e) {
      if (n === seq.current) setState({ path, error: e as Error, loading: false });
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  // Until the current path has answered, report loading (never stale data from a previous path).
  const fresh = state.path === path;
  return {
    data: fresh ? state.data : undefined,
    /** When the data shown is the copy saved on this device (no connection), when it was saved. */
    offlineAt: fresh && path && state.data !== undefined ? offlineCopyAt(path) : null,
    error: fresh ? state.error : undefined,
    loading: !!path && (!fresh || state.loading),
    reload: load,
  };
}

/** Wraps an async action with busy/error state for buttons and forms. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...args: A): Promise<R | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(...args); } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); }
  };
  return { run, busy, error, setError };
}

/** The offline outbox, live: queued changes waiting to be sent, and whether a sync is running. */
export function useOutbox() {
  const [state, setState] = useState<{ items: Queued[]; syncing: boolean; online: boolean }>(() => ({ items: outbox(), syncing: isSyncing(), online: typeof navigator === 'undefined' || navigator.onLine }));
  useEffect(() => {
    const update = () => setState({ items: outbox(), syncing: isSyncing(), online: navigator.onLine });
    window.addEventListener('erp-outbox', update); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('erp-outbox', update); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return state;
}
