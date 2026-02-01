'use client';

import { useEffect, useState } from 'react';
import { listLibraries } from './apiClient';
import { useAuth } from './store';

export function LibraryManagementPanel() {
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const isAdmin = user?.role === 'admin';

  const [libraries, setLibraries] = useState<Array<{ id: number; mount_path: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!token || !isAdmin) return;
    setError(null);
    try {
      const r = await listLibraries(token);
      setLibraries(r.libraries);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAdmin]);

  if (!token || !isAdmin) return null;

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
      <h2>Libraries</h2>
      <div style={{ opacity: 0.8, fontSize: 13 }}>
        These are discovered from scan roots (<code>MUSIC_DIRS</code>). To add a library, mount another folder (e.g. <code>/music3</code>)
        in docker-compose and include it in <code>MUSIC_DIRS</code>, then run a scan.
      </div>

      <div style={{ display: 'grid', gap: 6, padding: 12, border: '1px solid #333', borderRadius: 10, background: '#0d0d0d' }}>
        {libraries.map((l) => (
          <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13 }}>
            <div style={{ fontFamily: 'monospace' }}>{l.mount_path}</div>
            <div style={{ opacity: 0.75 }}>id {l.id}</div>
          </div>
        ))}
        {libraries.length === 0 ? <div style={{ opacity: 0.75, fontSize: 13 }}>No libraries yet.</div> : null}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={refresh} style={{ padding: 10 }}>
          Refresh
        </button>
      </div>

      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
    </div>
  );
}
