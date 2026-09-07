'use client';

import { useEffect, useState } from 'react';
import { listHistory } from './apiClient';
import { useAuth } from './store';
import { useHistoryUpdates } from './useWebSocket';
import { AddMenu } from './AddMenu';
import { trackArtistLabel } from './artistDisplay';
import { formatCalendarDate } from './format';
import { useLatestRequest } from './useLatestRequest';

export function History(props: {
  onPlay?: (t: { id: number; title: string | null; artist: string | null }) => void;
  onAddToQueue?: (t: { id: number; title: string | null; artist: string | null }) => void;
}) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const [tracks, setTracks] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const beginRequest = useLatestRequest('history', token);

  // Live updates
  const historyLastUpdate = useHistoryUpdates((s) => s.lastUpdate);

  async function refresh() {
    if (!token) return;
    const isCurrent = beginRequest();
    if (!isCurrent()) return;
    setError(null);
    setLoading(true);
    try {
      const r = await listHistory(token, 100, 0);
      if (isCurrent()) setTracks(r.tracks ?? []);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
      setError('Could not load recently played songs. Please try again.');
    } finally {
      if (isCurrent()) setLoading(false);
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
    return formatCalendarDate(date);
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
      {loading && <p role="status" className="text-sm text-slate-400">Loading recently played songs...</p>}
      <div className="space-y-1">
        {tracks.map((t, idx) => (
          <div
            key={`${t.played_at}-${t.id}`}
            className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 rounded-xl hover:bg-slate-800/50 transition-colors"
          >
            <button type="button"
              onClick={() => props.onPlay?.({ id: t.id, title: t.title, artist: trackArtistLabel(t) })}
              aria-label={`Play ${t.title ?? t.path}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/70 sm:gap-4">
              <span className="w-6 flex-shrink-0 text-center text-xs text-slate-500 sm:w-8 sm:text-sm">{idx + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-white sm:text-base">{t.title ?? t.path}</span>
                <span className="block truncate text-xs text-slate-400 sm:text-sm">{[trackArtistLabel(t), t.album].filter(Boolean).join(' • ')}</span>
              </span>
            </button>

            {/* Time Ago */}
            <div className="text-xs sm:text-sm text-slate-500 whitespace-nowrap flex-shrink-0">
              {formatTimeAgo(t.played_at)}
            </div>

            {/* Actions - hidden on small screens */}
            <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
              <AddMenu
                label="track"
                title="Add to..."
                getTracks={() => [{ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album }]}
              />
            </div>
          </div>
        ))}

        {!loading && !error && tracks.length === 0 && (
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
