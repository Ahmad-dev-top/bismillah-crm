import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setAccessToken, setUnauthorizedHandler } from "./api.ts";

export interface Session {
  token: string;
  role: string;
  permissions: string[];
  email?: string;
  fullName?: string;
}

interface AuthState {
  session: Session | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: (partial: { email?: string; fullName?: string }) => void;
  has: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

const SESSION_KEY = "bi.session";

function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed?.token || !Array.isArray(parsed.permissions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStoredSession(session: Session | null): void {
  if (!session) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    const stored = loadStoredSession();
    if (stored?.token) setAccessToken(stored.token);
    return stored;
  });

  const logout = useCallback(() => {
    setAccessToken(null);
    saveStoredSession(null);
    setSession(null);
  }, []);

  const applySession = useCallback((next: Session) => {
    setAccessToken(next.token);
    saveStoredSession(next);
    setSession(next);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api<{ token: string; role: string; permissions: string[] }>(
      "/api/auth/login",
      { method: "POST", body: { email, password } },
    );
    setAccessToken(result.token);
    let emailOut = email;
    let fullName: string | undefined;
    try {
      const me = await api<{ email: string; full_name: string }>("/api/auth/me");
      emailOut = me.email;
      fullName = me.full_name;
    } catch {
      /* token is enough to proceed */
    }
    applySession({
      token: result.token,
      role: result.role,
      permissions: result.permissions,
      email: emailOut,
      fullName,
    });
  }, [applySession]);

  const refreshMe = useCallback((partial: { email?: string; fullName?: string }) => {
    setSession((s) => {
      if (!s) return s;
      const next = {
        ...s,
        email: partial.email ?? s.email,
        fullName: partial.fullName ?? s.fullName,
      };
      saveStoredSession(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!session?.token) return;
    api<{ email: string; full_name: string; role: string; permissions: string[] }>("/api/auth/me")
      .then((me) => {
        setSession((s) => {
          if (!s) return s;
          const next = {
            ...s,
            email: me.email,
            fullName: me.full_name,
            role: me.role ?? s.role,
            permissions: me.permissions ?? s.permissions,
          };
          saveStoredSession(next);
          return next;
        });
      })
      .catch(() => {
        /* 401 already signs out */
      });
    // Restore once on boot; login/logout replace the session object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      login,
      logout,
      refreshMe,
      has: (permission) => session?.permissions.includes(permission) ?? false,
    }),
    [session, login, logout, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
