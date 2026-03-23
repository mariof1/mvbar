'use client';

import { useEffect, useState } from 'react';
import { AppShellNew } from './AppShellNew';
import { NortonShell } from './NortonShell';
import { usePreferences } from './preferencesStore';
import { useAuth } from './store';

export default function Home() {
  const token = useAuth((s) => s.token);
  const theme = usePreferences((s) => s.preferences.theme);
  const loaded = usePreferences((s) => s.loaded);
  const loadPreferences = usePreferences((s) => s.load);
  const [ready, setReady] = useState(false);

  // Load preferences early so we pick the right shell before first paint
  useEffect(() => {
    if (token && !loaded) {
      loadPreferences(token).finally(() => setReady(true));
    } else {
      setReady(true);
    }
  }, [token, loaded, loadPreferences]);

  // Show nothing briefly while preferences load (prevents flash)
  if (token && !ready && !loaded) return null;

  if (theme === 'norton') return <NortonShell />;
  return <AppShellNew />;
}
