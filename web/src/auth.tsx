import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';

export interface Me {
  userId: string;
  tenantId: string;
  displayName: string;
  employeeId: string | null;
  grants: { facilityId: string | null; permissions: string[] }[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
  /** Holds the permission anywhere (optionally at a facility). */
  can: (permission: string, facilityId?: string | null) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const signOut = useCallback(() => { setToken(null); setMe(null); }, []);
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
  return <Ctx.Provider value={{ me, loading, signIn, signOut, can }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
