'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from './store';
import { apiFetch } from './apiClient';
import { useFavorites } from './favoritesStore';
import { useRouter } from './router';
import { useLibraryUpdates } from './useWebSocket';

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

type ArtistHit = {
  id: number;
  name: string;
  art_path: string | null;
  art_hash: string | null;
  track_count: number;
  album_count: number;
};

type AlbumHit = {
  album: string;
  display_artist: string | null;
  artist_id: number | null;
  art_track_id: number | null;
  art_path: string | null;
  art_hash: string | null;
  track_count: number;
};

type PlaylistHit = {
  id: number;
  name: string;
  kind?: 'playlist' | 'smart';
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (a + b).toUpperCase();
}

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlay?: (t: { id: number; title: string | null; artist: string | null }) => void;
  onAddToQueue?: (t: { id: number; title: string | null; artist: string | null }) => void;
}

export function SearchModal({ isOpen, onClose, onPlay, onAddToQueue }: SearchModalProps) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const navigate = useRouter((s) => s.navigate);
  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);
  const lastUpdate = useLibraryUpdates((s) => s.lastUpdate);

  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [artistHits, setArtistHits] = useState<ArtistHit[]>([]);
  const [albumHits, setAlbumHits] = useState<AlbumHit[]>([]);
  const [playlistHits, setPlaylistHits] = useState<PlaylistHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRefreshRef = useRef<number>(0);
  const prevLastUpdateRef = useRef(0);

  // Auto-focus input when opened
  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      const t = setTimeout(() => {
        setQ('');
        setHits([]);
        setArtistHits([]);
        setAlbumHits([]);
        setPlaylistHits([]);
        setError(null);
      }, 150);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  // Search API call (debounced)
  useEffect(() => {
    if (!isOpen || !token || q.trim().length === 0) {
      if (q.trim().length === 0) {
        setHits([]);
        setArtistHits([]);
        setAlbumHits([]);
        setPlaylistHits([]);
      }
      return;
    }

    // Only throttle searches triggered by library updates, not user typing
    const isLibraryUpdate = lastUpdate !== prevLastUpdateRef.current;
    if (isLibraryUpdate) {
      prevLastUpdateRef.current = lastUpdate;
      const now = Date.now();
      if (now - lastRefreshRef.current < 3000) return;
      lastRefreshRef.current = now;
    }

    const id = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await apiFetch(`/search?q=${encodeURIComponent(q)}&limit=20`, { method: 'GET' }, token);
        setHits((r.hits ?? []).map((h: any) => ({ ...h, id: Number(h.id) })));
        setArtistHits(r.artists ?? []);
        setAlbumHits((r.albums ?? []).map((a: any) => ({
          ...a,
          artist_id: a.artist_id == null ? null : Number(a.artist_id),
          art_track_id: a.art_track_id == null ? null : Number(a.art_track_id),
        })));
        setPlaylistHits((r.playlists ?? []).map((p: any) => ({ ...p, id: Number(p.id) })));
      } catch (e: any) {
        if (e?.status === 401) clear();
        setError(e?.message ?? 'Search failed');
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(id);
  }, [q, isOpen, token, clear, lastUpdate]);

  const handleNavigate = useCallback((route: Parameters<typeof navigate>[0]) => {
    navigate(route);
    onClose();
  }, [navigate, onClose]);

  const handlePlay = useCallback((t: Hit) => {
    onPlay?.({ id: t.id, title: t.title, artist: t.display_artist || t.artist });
    onClose();
  }, [onPlay, onClose]);

  const handleAddToQueue = useCallback((t: Hit) => {
    onAddToQueue?.({ id: t.id, title: t.title, artist: t.display_artist || t.artist });
  }, [onAddToQueue]);

  if (!isOpen || !token) return null;

  const hasResults = hits.length > 0 || artistHits.length > 0 || albumHits.length > 0 || playlistHits.length > 0;
  const hasQuery = q.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[150] flex items-start justify-center pt-[8vh] sm:pt-[12vh] px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-2xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="glass rounded-2xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden">
          {/* Search Input */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
            <svg className="w-5 h-5 text-cyan-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search songs, artists, albums..."
              className="flex-1 bg-transparent text-white text-lg placeholder-slate-500 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            {loading && (
              <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {q && !loading && (
              <button
                onClick={() => { setQ(''); inputRef.current?.focus(); }}
                className="p-1 hover:bg-white/10 rounded-md transition-colors flex-shrink-0"
              >
                <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            <kbd className="hidden sm:inline-flex items-center px-2 py-1 text-[11px] text-slate-500 bg-white/5 rounded border border-white/10 font-mono">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[60vh] overflow-y-auto overscroll-contain">
            {error && (
              <div className="px-5 py-3 text-red-400 text-sm border-b border-white/5">{error}</div>
            )}

            {/* Artists */}
            {artistHits.length > 0 && (
              <div className="px-5 py-3 border-b border-white/5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Artists</div>
                <div className="space-y-0.5">
                  {artistHits.slice(0, 4).map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleNavigate({ type: 'browse-artist', artistId: a.id, artistName: a.name })}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left"
                    >
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex-shrink-0 flex items-center justify-center text-xs font-bold text-white relative overflow-hidden">
                        {getInitials(a.name)}
                        {a.art_path && (
                          <img
                            src={`/api/art/${encodeURIComponent(a.art_path)}${a.art_hash ? `?h=${a.art_hash}` : ''}`}
                            alt=""
                            className="absolute inset-0 w-full h-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white truncate">{a.name}</div>
                        <div className="text-xs text-slate-400">{a.track_count} tracks · {a.album_count} albums</div>
                      </div>
                      <svg className="w-4 h-4 text-slate-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Albums */}
            {albumHits.length > 0 && (
              <div className="px-5 py-3 border-b border-white/5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Albums</div>
                <div className="space-y-0.5">
                  {albumHits.slice(0, 4).map((a, idx) => (
                    <button
                      key={`${a.album}-${idx}`}
                      onClick={() => handleNavigate({ type: 'browse-album', artist: a.display_artist || '', album: a.album, artistId: a.artist_id || undefined })}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left"
                    >
                      <div className="w-9 h-9 rounded-lg bg-slate-700 flex-shrink-0 relative overflow-hidden">
                        {a.art_track_id && (
                          <img
                            src={`/api/library/tracks/${a.art_track_id}/art`}
                            alt=""
                            className="absolute inset-0 w-full h-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white truncate">{a.album}</div>
                        <div className="text-xs text-slate-400 truncate">{a.display_artist || 'Unknown Artist'} · {a.track_count} tracks</div>
                      </div>
                      <svg className="w-4 h-4 text-slate-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Playlists */}
            {playlistHits.length > 0 && (
              <div className="px-5 py-3 border-b border-white/5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Playlists</div>
                <div className="space-y-0.5">
                  {playlistHits.slice(0, 4).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleNavigate(p.kind === 'smart' ? { type: 'playlists', sub: 'smart' } : { type: 'playlist', playlistId: String(p.id) })}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left"
                    >
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-cyan-600/20 to-blue-600/20 flex-shrink-0 flex items-center justify-center">
                        <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white truncate">{p.name}{p.kind === 'smart' ? ' (Smart)' : ''}</div>
                      </div>
                      <svg className="w-4 h-4 text-slate-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Songs */}
            {hits.length > 0 && (
              <div className="px-5 py-3">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Songs</div>
                <div className="space-y-0.5">
                  {hits.map((t) => (
                    <div
                      key={t.id}
                      className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors"
                    >
                      {/* Album art with play overlay */}
                      <button
                        onClick={() => handlePlay(t)}
                        className="relative w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 group/art"
                      >
                        <div className="w-full h-full bg-slate-700 flex items-center justify-center">
                          <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                          </svg>
                        </div>
                        <img
                          src={`/api/library/tracks/${t.id}/art`}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/art:opacity-100 transition-opacity flex items-center justify-center">
                          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                      </button>

                      {/* Track info */}
                      <button onClick={() => handlePlay(t)} className="flex-1 min-w-0 text-left">
                        <div className="text-sm font-medium text-white truncate">{t.title ?? t.path}</div>
                        <div className="text-xs text-slate-400 truncate">
                          {[t.display_artist || t.artist, t.album].filter(Boolean).join(' · ') || 'Unknown'}
                        </div>
                      </button>

                      {/* Actions */}
                      <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <button
                          onClick={() => handleAddToQueue(t)}
                          className="p-1.5 hover:bg-white/10 rounded-md transition-colors"
                          title="Add to queue"
                        >
                          <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                          </svg>
                        </button>
                        <button
                          onClick={async () => {
                            try { await toggleFav(token!, Number(t.id)); } catch (e: any) { if (e?.status === 401) clear(); }
                          }}
                          className={`p-1.5 hover:bg-white/10 rounded-md transition-colors ${favIds.has(Number(t.id)) ? 'text-pink-500' : 'text-slate-400'}`}
                          title={favIds.has(Number(t.id)) ? 'Remove from favorites' : 'Add to favorites'}
                        >
                          <svg className="w-4 h-4" fill={favIds.has(Number(t.id)) ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* No results */}
            {hasQuery && !loading && !hasResults && (
              <div className="px-5 py-12 text-center">
                <svg className="w-12 h-12 mx-auto mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-slate-400">No results found</p>
                <p className="text-sm text-slate-500 mt-1">Try a different search term</p>
              </div>
            )}

            {/* Initial state */}
            {!hasQuery && !error && (
              <div className="px-5 py-10 text-center text-slate-500">
                <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <p className="text-sm">Start typing to search your library</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
