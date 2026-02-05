'use client';

import { useEffect, useState } from 'react';
import { listHistory } from './apiClient';
import { useAuth } from './store';
import { useHistoryUpdates } from './useWebSocket';

export function History(props: {
  onPlay?: (t: { id: number; title: string | null; artist: string | null }) => void;
  onAddToQueue?: (t: { id: number; title: string | null; artist: string | null }) => void;
}) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const [tracks, setTracks] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Live updates
  const historyLastUpdate = useHistoryUpdates((s) => s.lastUpdate);

  async function refresh() {
    if (!token) return;
    try {
      const r = await listHistory(token, 100, 0);
      setTracks(r.tracks ?? []);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Live updates: refresh when new track is played
  useEffect(() => {
    if (!historyLastUpdate || !token) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLastUpdate]);

  if (!token) return null;

  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/20">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Recently Played</h2>
            <p className="text-sm text-slate-400">Your listening history</p>
          </div>
        </div>
        <button
          onClick={refresh}
          className="p-2 hover:bg-slate-800/50 rounded-lg transition-colors text-slate-400 hover:text-white"
          title="Refresh"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400">
          {error}
        </div>
      )}

      {/* Track List */}
      <div className="space-y-1">
        {tracks.map((t, idx) => (
          <div
            key={`${t.played_at}-${t.id}`}
            className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 rounded-xl hover:bg-slate-800/50 transition-colors"
          >
            {/* Track Number / Play */}
            <div className="w-6 sm:w-8 flex-shrink-0 text-center">
              <span className="text-xs sm:text-sm text-slate-500 group-hover:hidden">{idx + 1}</span>
              <button
                onClick={() => props.onPlay?.({ id: t.id, title: t.title, artist: t.artist })}
                className="hidden group-hover:block text-cyan-400"
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5 mx-auto" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            </div>

            {/* Track Info */}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-white truncate text-sm sm:text-base">{t.title ?? t.path}</div>
              <div className="text-xs sm:text-sm text-slate-400 truncate">
                {[t.artist, t.album].filter(Boolean).join(' • ') || 'Unknown'}
              </div>
            </div>

            {/* Time Ago */}
            <div className="text-xs sm:text-sm text-slate-500 whitespace-nowrap flex-shrink-0">
              {formatTimeAgo(t.played_at)}
            </div>

            {/* Actions - hidden on small screens */}
            <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => props.onAddToQueue?.({ id: t.id, title: t.title, artist: t.artist })}
                className="p-2 hover:bg-slate-700/50 rounded-lg transition-colors"
                title="Add to queue"
              >
                <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {tracks.length === 0 && (
          <div className="text-center py-16 text-slate-400">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-lg">No history yet</p>
            <p className="text-sm mt-1">Start playing music to see your history</p>
          </div>
        )}
      </div>
    </div>
  );
}
