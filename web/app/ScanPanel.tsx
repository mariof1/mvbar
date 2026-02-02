'use client';

import { useEffect, useState } from 'react';
import { scanNow, scanStatus } from './apiClient';
import { useAuth } from './store';

export function ScanPanel(props: { onScanFinished?: () => void }) {
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin';

  async function refresh() {
    if (!token || !isAdmin) return;
    try {
      const r = await scanStatus(token);
      setJob(r.job);
      if (r.job?.state === 'done' || r.job?.state === 'failed') props.onScanFinished?.();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }

  async function handleScanNow() {
    if (!token) return;
    setError(null);
    setLoading(true);
    try {
      await scanNow(token);
      await refresh();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!token || !isAdmin) return;
      // poll faster while active
      if (job?.state === 'running' || job?.state === 'queued') refresh();
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAdmin, job?.state]);

  if (!token || !isAdmin) return null;

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
      <h2>Library scan</h2>
      <button onClick={handleScanNow} disabled={loading} style={{ padding: 10 }}>
        {loading ? 'Starting…' : 'Run scan now'}
      </button>
      <button onClick={refresh} disabled={loading} style={{ padding: 10, opacity: 0.8 }}>
        Refresh status
      </button>
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
      {job ? (
        <pre style={{ margin: 0, padding: 10, background: '#0b0b0b', border: '1px solid #333', borderRadius: 8, overflow: 'auto' }}>
          {JSON.stringify(job, null, 2)}
        </pre>
      ) : (
        <p style={{ opacity: 0.8 }}>No scan job yet.</p>
      )}
    </div>
  );
}
