'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { scanNow, scanStatus } from './apiClient';
import { useAuth } from './store';
import { useScanProgress } from './useWebSocket';

export function ScanPanel(props: { onScanFinished?: () => void }) {
  const { onScanFinished } = props;
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousStateRef = useRef<string | null>(null);

  // Live updates from WebSocket
  const scanProgress = useScanProgress();

  const isAdmin = user?.role === 'admin';

  const refresh = useCallback(async () => {
    if (!token || !isAdmin) return;
    try {
      const r = await scanStatus(token);
      setJob(r.job);
      const nextState = r.job?.state ?? null;
      if (previousStateRef.current === 'running' && (nextState === 'done' || nextState === 'failed')) {
        onScanFinished?.();
      }
      previousStateRef.current = nextState;
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }, [clear, isAdmin, onScanFinished, token]);

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

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // WebSockets keep this responsive; polling while a job is active guarantees
  // convergence if a completion message is lost while the tab or network sleeps.
  useEffect(() => {
    if (job?.state !== 'running') return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [job?.state, refresh]);

  // Update job state from WebSocket scan progress
  useEffect(() => {
    if (!scanProgress.status) return;
    
    setJob((prev: any) => ({
      ...prev,
      state: scanProgress.scanning || scanProgress.status === 'indexing' ? 'running' : 'done',
      status: scanProgress.status,
      mountPath: scanProgress.mountPath,
      libraryIndex: scanProgress.libraryIndex,
      libraryTotal: scanProgress.libraryTotal,
      filesFound: scanProgress.filesFound,
      filesProcessed: scanProgress.filesProcessed,
      currentFile: scanProgress.currentFile,
    }));
    previousStateRef.current = scanProgress.scanning || scanProgress.status === 'indexing' ? 'running' : 'done';

    // Notify when scan finishes
    if (!scanProgress.scanning && scanProgress.status === 'idle') {
      onScanFinished?.();
    }
  }, [onScanFinished, scanProgress]);

  if (!token || !isAdmin) return null;

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
      <h2>Library scan</h2>
      <button onClick={handleScanNow} disabled={loading} style={{ padding: 10 }}>
        {loading ? 'Starting…' : 'Run scan now'}
      </button>
      {/* Status updates live via websocket */}
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
      {job ? (
        <pre style={{ margin: 0, padding: 10, background: '#0b0b0b', border: '1px solid #333', borderRadius: 8, overflow: 'auto' }}>
          {JSON.stringify({
            ...job,
            mountPath: scanProgress.mountPath || job?.mountPath,
            libraryIndex: scanProgress.libraryIndex || job?.libraryIndex,
            libraryTotal: scanProgress.libraryTotal || job?.libraryTotal,
          }, null, 2)}
        </pre>
      ) : (
        <p style={{ opacity: 0.8 }}>No scan job yet.</p>
      )}
    </div>
  );
}
