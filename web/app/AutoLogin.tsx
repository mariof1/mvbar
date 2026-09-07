'use client';

import { useEffect } from 'react';
import { me } from './apiClient';
import { useAuth } from './store';

export function AutoLogin() {
  const token = useAuth((s) => s.token);
  const setAuth = useAuth((s) => s.setAuth);
  const clear = useAuth((s) => s.clear);

  useEffect(() => {
    if (token) return;
    let active = true;
    (async () => {
      try {
        const r = await me();
        if (!active || useAuth.getState().token) return;
        if (!r.ok || !r.user) throw new Error('not signed in');
        setAuth(r.user);
      } catch {
        if (active && !useAuth.getState().token) clear();
      }
    })();
    return () => { active = false; };
  }, [token, setAuth, clear]);

  return null;
}
