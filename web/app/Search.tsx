'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from './store';
import { addTrackToPlaylist, apiFetch, listPlaylists } from './apiClient';
import { useFavorites } from './favoritesStore';

type Hit = {
  id: number;
  title: string | null;
  artist: string | null;
  album_artist: string | null;
  display_artist: string | null;
  album: string | null;
  path: string;
  ext: string;
  duration_ms: number | null;
};

export function Search(props: { onPlay?: (t: Hit) => void; onAddToQueue?: (t: Hit) => void }) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const [q, setQ] = useState('');
  const favIds = useFavorites((s) => s.ids);
  const refreshFavs = useFavorites((s) => s.refresh);
  const toggleFav = useFavorites((s) => s.toggle);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pls, setPls] = useState<Array<{ id: string; name: string }>>([]);
  const [playlistId, setPlaylistId] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem('mvbar_playlist_id') ?? '' : ''));

  const canSearch = useMemo(() => Boolean(token), [token]);

  useEffect(() => {
    if (!canSearch) return;
    const id = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await apiFetch(`/search?q=${encodeURIComponent(q)}&limit=20`, { method: 'GET' }, token!);
        setHits(r.hits ?? []);
      } catch (e: any) {
        if (e?.status === 401) clear();
        setError(e?.message ?? 'error');
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q, canSearch, token, clear]);

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

  return (
    <div className="space-y-6">
      {/* Search Header */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
          <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search songs, artists, albums..."
          className="w-full pl-12 pr-4 py-4 bg-slate-800/50 border border-slate-700/50 rounded-2xl text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-transparent text-lg transition-all"
        />
        {loading && (
          <div className="absolute inset-y-0 right-0 pr-4 flex items-center">
            <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400">
          {error}
        </div>
      )}

      {/* Quick Playlist Add */}
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

      {/* Results */}
      <div className="space-y-2">
        {hits.map((t) => (
          <div
            key={t.id}
            className="group p-3 sm:p-4 bg-slate-800/30 hover:bg-slate-800/50 border border-slate-700/30 hover:border-slate-600/50 rounded-xl transition-all duration-200"
          >
            <div className="flex items-center gap-3 sm:gap-4">
              {/* Album Art with Play Button Overlay */}
              <button
                onClick={() => props.onPlay?.({ ...t, artist: t.display_artist || t.artist })}
                className="relative flex-shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-lg overflow-hidden group/art"
              >
                <img
                  src={`/api/art/${t.id}`}
                  alt=""
                  className="w-full h-full object-cover bg-slate-700"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    e.currentTarget.nextElementSibling?.classList.remove('hidden');
                  }}
                />
                <div className="hidden w-full h-full bg-slate-700 items-center justify-center">
                  <svg className="w-6 h-6 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                </div>
                {/* Play overlay */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/art:opacity-100 transition-opacity flex items-center justify-center">
                  <div className="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center shadow-lg">
                    <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>
              </button>

              {/* Track Info */}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-white truncate text-sm sm:text-base">{t.title ?? t.path}</div>
                <div className="text-xs sm:text-sm text-slate-400 truncate">
                  {[t.display_artist || t.artist, t.album].filter(Boolean).join(' • ') || 'Unknown'}
                </div>
              </div>

              {/* Actions - hidden on small screens */}
              <div className="hidden sm:flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => props.onAddToQueue?.({ ...t, artist: t.display_artist || t.artist })}
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
          </div>
        ))}

        {/* Empty state */}
        {!loading && q && hits.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-lg">No results found</p>
            <p className="text-sm mt-1">Try a different search term</p>
          </div>
        )}

        {/* Initial state */}
        {!q && (
          <div className="text-center py-12 text-slate-400">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <p className="text-lg">Search your library</p>
            <p className="text-sm mt-1">Find songs, artists, and albums</p>
          </div>
        )}
      </div>
    </div>
  );
}
