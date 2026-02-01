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
    (async () => {
      try {
        const r = await me();
        if (!r.ok || !r.user) throw new Error('not signed in');
        setAuth(r.user);
      } catch {
        clear();
      }
    })();
  }, [token, setAuth, clear]);

  return null;
}
