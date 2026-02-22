import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { TOKEN_KEY } from '../api/constants';

interface AuthContextValue {
  token: string | null;
  isAuthenticated: boolean;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  const login = useCallback(async (newToken: string): Promise<boolean> => {
    // Validate the token by calling an authenticated endpoint
    try {
      const res = await fetch('/api/conversations', {
        headers: { 'Authorization': `Bearer ${newToken}` },
      });
      if (res.status === 401) {
        return false;
      }
      if (!res.ok) {
        // Non-401 errors might mean auth is disabled (dev mode) — allow login
      }
      localStorage.setItem(TOKEN_KEY, newToken);
      setToken(newToken);
      return true;
    } catch {
      // Network error — do not store unvalidated token
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  // Listen for 401 responses globally to auto-logout
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.status === 401) {
        logout();
      }
    };
    window.addEventListener('bakerst:unauthorized', handler);
    return () => window.removeEventListener('bakerst:unauthorized', handler);
  }, [logout]);

  return (
    <AuthContext.Provider value={{ token, isAuthenticated: !!token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
