'use client';

import { useEffect, useState } from 'react';
import { addTrackToPlaylist, listPlaylists, listTracks } from './apiClient';
import { useFavorites } from './favoritesStore';
import { useAuth } from './store';

export function Tracks(props: {
  refreshNonce?: number;
  onPlay?: (t: { id: number; title: string | null; artist: string | null }) => void;
  onAddToQueue?: (t: { id: number; title: string | null; artist: string | null }) => void;
}) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const [tracks, setTracks] = useState<Array<{ id: number; path: string; title: string | null; artist: string | null; album: string | null; duration_ms: number | null }>>([]);
  const [error, setError] = useState<string | null>(null);

  const favIds = useFavorites((s) => s.ids);
  const refreshFavs = useFavorites((s) => s.refresh);
  const toggleFav = useFavorites((s) => s.toggle);

  const [pls, setPls] = useState<Array<{ id: string; name: string }>>([]);
  const [playlistId, setPlaylistId] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem('mvbar_playlist_id') ?? '' : ''));

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const r = await listTracks(token, 100, 0);
        setTracks(r.tracks);
      } catch (e: any) {
        if (e?.status === 401) clear();
        setError(e?.message ?? 'error');
      }
    })();
  }, [token, clear, props.refreshNonce]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const r = await listPlaylists(token);
        setPls((r.playlists ?? []).map((p) => ({ id: String(p.id), name: p.name })));
      } catch (e: any) {
        if (e?.status === 401) clear();
      }
    })();
  }, [token, clear]);

  useEffect(() => {
    if (!token) return;
    refreshFavs(token).catch((e: any) => {
      if (e?.status === 401) clear();
    });
  }, [token, clear, refreshFavs]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('mvbar_playlist_id', playlistId);
  }, [playlistId]);

  if (!token) return null;

  const formatDuration = (ms: number | null) => {
    if (!ms) return '--:--';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Library</h2>
          <p className="text-sm text-slate-400 mt-1">Showing first 100 tracks</p>
        </div>
        {pls.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-400">Quick add to:</span>
            <select
              value={playlistId}
              onChange={(e) => setPlaylistId(e.target.value)}
              className="px-3 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            >
              <option value="">Select playlist</option>
              {pls.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
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
            key={t.id}
            className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 rounded-xl hover:bg-slate-800/50 transition-colors"
          >
            {/* Track Number / Play */}
            <div className="w-6 sm:w-8 flex-shrink-0 text-center">
              <span className="text-xs sm:text-sm text-slate-500 group-hover:hidden">{idx + 1}</span>
              <button
                onClick={() => props.onPlay?.(t)}
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

            {/* Duration */}
            <div className="text-xs sm:text-sm text-slate-500 w-10 sm:w-12 text-right flex-shrink-0">
              {formatDuration(t.duration_ms)}
            </div>

            {/* Actions - hidden on small screens */}
            <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => props.onAddToQueue?.(t)}
                className="p-2 hover:bg-slate-700/50 rounded-lg transition-colors"
                title="Add to queue"
              >
                <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </button>
              <button
                onClick={async () => {
                  try {
                    await toggleFav(token!, t.id);
                  } catch (e: any) {
                    if (e?.status === 401) clear();
                  }
                }}
                className={`p-2 hover:bg-slate-700/50 rounded-lg transition-colors ${favIds.has(t.id) ? 'text-pink-500' : 'text-slate-300'}`}
                title={favIds.has(t.id) ? 'Remove from favorites' : 'Add to favorites'}
              >
                <svg className="w-5 h-5" fill={favIds.has(t.id) ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
              </button>
              {playlistId && (
                <button
                  onClick={async () => {
                    try {
                      await addTrackToPlaylist(token!, playlistId, t.id);
                    } catch (e: any) {
                      if (e?.status === 401) clear();
                    }
                  }}
                  className="p-2 hover:bg-slate-700/50 rounded-lg transition-colors text-slate-300"
                  title="Add to playlist"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ))}

        {tracks.length === 0 && (
          <div className="text-center py-16 text-slate-400">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
            <p className="text-lg">No tracks yet</p>
            <p className="text-sm mt-1">Add music files to your library folder</p>
          </div>
        )}
      </div>
    </div>
  );
}
