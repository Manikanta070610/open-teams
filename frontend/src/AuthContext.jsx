import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './adminApi.js';

const AuthCtx = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// Central auth state: silent auto-login via the refresh cookie on load,
// JWE access token in memory, verify on every mount.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [mustChange, setMustChange] = useState(false);
  const [policyDays, setPolicyDays] = useState(7);
  const [status, setStatus] = useState('checking'); // checking | authed | anon
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api('/api/auth/policy').catch(() => null);
        if (!cancelled && p) setPolicyDays(p.inactivityDays);
      } catch { /* keep default */ }
      // Silent auto-login: rotation happens server-side if the refresh
      // cookie is still within the inactivity window.
      try {
        const r = await api('/api/auth/refresh', { method: 'POST' }).catch(() => null);
        if (cancelled) return;
        if (r?.token) {
          setToken(r.token);
          setUser(r.user);
          setMustChange(!!r.mustChange);
          setStatus('authed');
          return;
        }
      } catch { /* fall through to verify / anon */ }
      if (cancelled) return;
      if (getToken()) {
        try {
          const v = await api('/api/auth/verify');
          if (!cancelled) {
            setUser(v.user);
            setMustChange(!!v.user.must_change_password);
            setStatus('authed');
            return;
          }
        } catch { /* expired JWE */ }
      }
      if (!cancelled) setStatus('anon');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password, remember = true) => {
    setNotice('');
    const r = await api('/api/auth/login', { method: 'POST', body: { email, password, remember } });
    setToken(r.token);
    setUser(r.user);
    setMustChange(!!r.mustChange);
    setStatus('authed');
    return r;
  }, []);

  const logout = useCallback(async (everywhere = false) => {
    try {
      if (everywhere && user) await api('/api/auth/sessions', { method: 'DELETE' });
      else await api('/api/auth/logout', { method: 'POST' });
    } catch { /* still clear locally */ }
    try {
      await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    } catch { /* legacy session may not exist */ }
    setToken(null);
    setUser(null);
    setMustChange(false);
    setStatus('anon');
  }, [user]);

  // Re-verify after password change (server returns a fresh JWE).
  const passwordChanged = useCallback((freshToken) => {
    if (freshToken) setToken(freshToken);
    setMustChange(false);
  }, []);

  const sessionExpired = useCallback((days) => {
    setToken(null);
    setUser(null);
    setMustChange(false);
    setStatus('anon');
    setNotice(
      `You've been signed out after ${days ?? policyDays} days of inactivity — please sign in again.`
    );
  }, [policyDays]);

  return (
    <AuthCtx.Provider
      value={{ user, mustChange, setMustChange, policyDays, status, notice, setNotice, login, logout, passwordChanged, sessionExpired }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
