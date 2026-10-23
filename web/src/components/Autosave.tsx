import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime } from '../format';

/**
 * Every form keeps its unsaved entries on the server (D-164). A second after typing stops, the values of each form on
 * the page are saved as a draft for this person, keyed by the page and the form's position. Opening the page again, on
 * any device, puts the values back and says so, with a way to discard them. The draft goes once the form's save
 * succeeds (any successful change request within 15 seconds of submitting or pressing one of its buttons) or its Cancel
 * button is pressed.
 *
 * Never kept: passwords, files, hidden fields, and anything inside [data-no-draft] (forms that keep their own draft).
 * Rows a person added to a list come back only where the row exists again; editors with growing lists use
 * `useServerDraft` instead.
 */
type Fields = Record<string, string | boolean>;
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const SKIP = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image']);

function fieldsOf(form: HTMLFormElement): Field[] {
  return [...form.querySelectorAll<Field>('input, textarea, select')].filter((el) => !SKIP.has((el as HTMLInputElement).type) && !el.closest('[data-no-draft]')
    && !/token|secret|password/i.test(el.id + (el as HTMLInputElement).name));
}
function nameOf(el: Field, i: number) {
  const base = el.id || (el as HTMLInputElement).name || el.getAttribute('aria-label') || `${el.tagName.toLowerCase()}${i}`;
  return (el as HTMLInputElement).type === 'radio' ? `${base}=${(el as HTMLInputElement).value}` : base;
}
function read(form: HTMLFormElement): Fields {
  const out: Fields = {};
  fieldsOf(form).forEach((el, i) => {
    const k = nameOf(el, i);
    out[k] = (el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio' ? (el as HTMLInputElement).checked : el.value;
  });
  return out;
}
/** Sets a value the way typing would, so React's own state follows. */
function setValue(el: Field, v: string | boolean): boolean {
  const input = el as HTMLInputElement;
  if (input.type === 'checkbox' || input.type === 'radio') {
    if (input.checked !== v) input.click();
    return true;
  }
  if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === v)) return false; // options not loaded yet
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  return true;
}
const same = (a: Fields, b: Fields) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);

interface Tracked { key: string; initial: Fields; timer?: number; submittedAt?: number; restoredAt?: string; banner?: HTMLElement }

export function FormAutosave() {
  const loc = useLocation();
  const path = loc.pathname + loc.search;
  const tracked = useRef(new Map<HTMLFormElement, Tracked>());
  const [, force] = useState(0);
  useEffect(() => {
    let alive = true;
    const forms = tracked.current;
    forms.clear();
    let drafts: any[] | null = null;
    const label = () => document.querySelector('main h1')?.textContent?.trim().slice(0, 200) ?? path;
    const keyOf = (form: HTMLFormElement) => `${path}#${[...document.querySelectorAll('main form')].filter((f) => !(f as HTMLElement).closest('[data-no-draft]')).indexOf(form)}`;
    const save = (form: HTMLFormElement) => {
      const t = forms.get(form); if (!t) return;
      const now = read(form);
      if (same(now, t.initial)) { void api.delete(`/api/drafts/${encodeURIComponent(t.key)}`).catch(() => undefined); return; }
      void api.put(`/api/drafts/${encodeURIComponent(t.key)}`, { path, label: label(), data: now }).catch(() => undefined);
    };
    const discard = (form: HTMLFormElement) => {
      const t = forms.get(form); if (!t) return;
      void api.delete(`/api/drafts/${encodeURIComponent(t.key)}`).catch(() => undefined);
      t.banner?.remove(); t.banner = undefined;
    };
    const restore = async (form: HTMLFormElement, t: Tracked, data: Fields, at: string) => {
      // Selects fill in as their options load: try for a few seconds.
      for (let attempt = 0; attempt < 12 && alive; attempt++) {
        let pending = 0;
        fieldsOf(form).forEach((el, i) => { const k = nameOf(el, i); if (k in data && !setValue(el, data[k]!)) pending++; });
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      t.restoredAt = at;
      const b = document.createElement('div');
      b.className = 'draft-note';
      b.setAttribute('role', 'status');
      form.prepend(b);
      t.banner = b;
      force((n) => n + 1);
    };
    // Forms are tracked the moment they appear (so the first keystroke counts); a saved draft is fetched afterwards and
    // put back only if the person has not started typing meanwhile.
    const adopt = () => {
      const found = [...document.querySelectorAll<HTMLFormElement>('main form')].filter((f) => !f.closest('[data-no-draft]') && !forms.has(f));
      if (!found.length) return;
      const fresh = found.map((form) => { const t: Tracked = { key: keyOf(form), initial: read(form) }; forms.set(form, t); return [form, t] as const; });
      void (async () => {
        if (drafts == null) drafts = await api.get<any[]>(`/api/drafts?path=${encodeURIComponent(path)}`).catch(() => []);
        for (const [form, t] of fresh) {
          const d = drafts!.find((x) => x.key === t.key);
          if (alive && d && form.isConnected && same(read(form), t.initial) && !same(d.data, t.initial)) void restore(form, t, d.data, d.updated_at);
        }
      })();
    };
    const onInput = (e: Event) => {
      const form = (e.target as HTMLElement).closest?.('form') as HTMLFormElement | null;
      const t = form && forms.get(form);
      if (!t || !(e as any).isTrusted) return;
      window.clearTimeout(t.timer);
      t.timer = window.setTimeout(() => save(form!), 1000);
    };
    const onSubmit = (e: Event) => { const t = forms.get(e.target as HTMLFormElement); if (t) { window.clearTimeout(t.timer); t.submittedAt = Date.now(); } };
    const onSaved = () => {
      for (const [form, t] of forms) if (t.submittedAt && Date.now() - t.submittedAt < 15_000) { t.submittedAt = undefined; discard(form); t.initial = read(form); }
    };
    const onClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest?.('button');
      const form = btn?.closest('form') as HTMLFormElement | null;
      if (!btn || !form || !forms.has(form)) return;
      if (btn.type === 'button' && /^cancel$/i.test(btn.textContent?.trim() ?? '')) { discard(form); return; }
      // Some forms save from a plain button rather than a submit: a successful save soon after a press clears the draft too.
      const t = forms.get(form)!; window.clearTimeout(t.timer); t.submittedAt = Date.now();
    };
    const observer = new MutationObserver(() => adopt());
    observer.observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true });
    document.addEventListener('input', onInput, true); document.addEventListener('change', onInput, true);
    document.addEventListener('submit', onSubmit, true); document.addEventListener('click', onClick, true);
    window.addEventListener('erp:saved', onSaved);
    adopt();
    const first = window.setTimeout(adopt, 300);
    return () => {
      alive = false; window.clearTimeout(first); observer.disconnect();
      // Leaving the page saves what was typed and not yet sent.
      for (const [form, t] of forms) if (t.timer) { window.clearTimeout(t.timer); if (form.isConnected) save(form); }
      document.removeEventListener('input', onInput, true); document.removeEventListener('change', onInput, true);
      document.removeEventListener('submit', onSubmit, true); document.removeEventListener('click', onClick, true);
      window.removeEventListener('erp:saved', onSaved);
    };
  }, [path]);
  return <>{[...tracked.current.entries()].filter(([, t]) => t.banner && t.restoredAt).map(([form, t]) => createPortal(
    <span>Your unsaved entries from {fmtDateTime(t.restoredAt)} are back. <button type="button" className="link" onClick={() => {
      void api.delete(`/api/drafts/${encodeURIComponent(t.key)}`).catch(() => undefined);
      // Outside React's click handler: inside it, React puts a controlled field's old value back after the event.
      const initial = t.initial;
      window.setTimeout(() => fieldsOf(form).forEach((el, i) => { const k = nameOf(el, i); if (k in initial) setValue(el, initial[k]!); }), 0);
      t.banner?.remove(); t.banner = undefined; t.restoredAt = undefined; force((n) => n + 1);
    }}>Discard them</button></span>, t.banner!, t.key))}</>;
}

/**
 * An explicit server draft for editors whose state is a model rather than a fixed form (a list that grows): the whole
 * value is saved a second after it changes and offered back when the editor opens again.
 */
export function useServerDraft<T>(key: string | null, value: T | null, label: string) {
  const [saved, setSaved] = useState<{ data: T; updated_at: string } | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (!key) return;
    first.current = true;
    void api.get<any[]>(`/api/drafts?path=${encodeURIComponent(location.pathname)}`).then((ds) => setSaved(ds.find((d) => d.key === key) ?? null)).catch(() => undefined);
  }, [key]);
  useEffect(() => {
    if (!key || value == null) return;
    if (first.current) { first.current = false; return; }
    const t = window.setTimeout(() => { void api.put(`/api/drafts/${encodeURIComponent(key)}`, { path: location.pathname, label, data: value }).catch(() => undefined); }, 1000);
    return () => window.clearTimeout(t);
  }, [key, value, label]);
  return {
    saved,
    clear: () => { setSaved(null); if (key) void api.delete(`/api/drafts/${encodeURIComponent(key)}`).catch(() => undefined); },
  };
}
