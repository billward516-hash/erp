import { clearOffline } from './offline';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';

export interface Me {
  userId: string;
  tenantId: string;
  tenantName: string | null;
  /** Lite (D-135) or Standard; limits are null when unlimited. */
  edition: 'lite' | 'standard';
  limits: { users: number | null; sites: number | null; usersActive: number; sitesActive: number };
  displayName: string;
  employeeId: string | null;
  grants: { facilityId: string | null; permissions: string[] }[];
  /** Features hidden from this user (D-149) and the pages they cover. */
  hiddenFeatures?: string[];
  hiddenNav?: string[];
  /** Whether this user may change any reminder (D-153). */
  remindersEditable?: boolean;
  /** Implementation steps (SC-003) assigned to this user and not finished. */
  implementationSteps?: number;
  /** Field service is licensed for at least one site (SC-002). */
  fieldService?: boolean;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
  /** Holds the permission anywhere (optionally at a facility). */
  can: (permission: string, facilityId?: string | null) => boolean;
  /** The feature is visible to this user (D-149). */
  feature: (key: string) => boolean;
  /** Display settings of this person (SC-004 E), applied to the page as they load or change. */
  prefs: Prefs;
  savePrefs: (patch: Partial<Prefs>) => Promise<void>;
}
export interface Prefs { density: 'roomy' | 'normal' | 'compact'; textSize: 'normal' | 'large' | 'larger'; highContrast: boolean; reducedMotion: boolean; defaultView: 'chart' | 'table'; suggestions: boolean }
const DEFAULT_PREFS: Prefs = { density: 'normal', textSize: 'normal', highContrast: false, reducedMotion: false, defaultView: 'chart', suggestions: true };
function applyPrefs(p: Prefs) {
  const h = document.documentElement;
  h.dataset.density = p.density; h.dataset.text = p.textSize; h.dataset.contrast = p.highContrast ? 'high' : 'normal'; h.dataset.motion = p.reducedMotion ? 'reduced' : 'normal';
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => { if (!me) { applyPrefs(DEFAULT_PREFS); return; } api.get<Prefs>('/api/my-preferences').then((p) => { setPrefs(p); applyPrefs(p); }).catch(() => undefined); }, [me?.userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const savePrefs = async (patch: Partial<Prefs>) => { const next = await api.put('/api/my-preferences', patch).then(() => ({ ...prefs, ...patch })); setPrefs(next); applyPrefs(next); };
  const [loading, setLoading] = useState(!!getToken());
  const signOut = useCallback(() => {
    // Ends a single sign-on session on the server too (API tokens are unaffected); best effort.
    if (getToken()) void api.post('/api/session/sign-out').catch(() => undefined);
    clearOffline(); setToken(null); setMe(null);
  }, []);
  useEffect(() => { setUnauthorizedHandler(signOut); }, [signOut]);
  useEffect(() => {
    if (!getToken()) return;
    api.get<Me>('/api/me').then(setMe).catch(() => setToken(null)).finally(() => setLoading(false));
  }, []);
  const signIn = async (token: string) => {
    setToken(token.trim());
    try { setMe(await api.get<Me>('/api/me')); } catch (e) { setToken(null); throw e; }
  };
  const can = (permission: string, facilityId?: string | null) =>
    !!me?.grants.some((g) => g.permissions.includes(permission) && (facilityId == null || g.facilityId === null || g.facilityId === facilityId));
  const feature = (key: string) => !me?.hiddenFeatures?.includes(key);
  return <Ctx.Provider value={{ me, loading, signIn, signOut, can, feature, prefs, savePrefs }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
