'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from './store';
import { apiFetch, browseAlbum, browseArtistTracks, sendAiSearch } from './apiClient';
import { useFavorites } from './favoritesStore';
import { usePreferences } from './preferencesStore';
import { useRouter } from './router';
import { useLibraryUpdates } from './useWebSocket';
import { AddMenu, type AddMenuTrack } from './AddMenu';
import { useUi, type PodcastEpisode } from './uiStore';

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

type PodcastHit = {
  id: number;
  title: string;
  author: string | null;
  description: string | null;
  image_url: string | null;
  image_path: string | null;
  unplayed_count: number;
};

type PodcastEpisodeHit = PodcastEpisode & {
  image_path?: string | null;
  podcast_image_path?: string | null;
};

type SearchMode = 'library' | 'ai';

type AiInterpretation = {
  originalQuery: string;
  searchQuery: string;
  explanation: string;
};

const AI_SEARCH_SUGGESTIONS = [
  'Polish rock from the 80s',
  'Something calm for a quiet evening',
  'Upbeat electronic music from the 2000s',
  'Jazz for a rainy afternoon',
];

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (a + b).toUpperCase();
}

function stripHtml(value?: string | null) {
  return (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function podcastArtUrl(podcast: Pick<PodcastHit, 'id' | 'image_url' | 'image_path'>) {
  return podcast.image_path ? `/api/podcast-art/${podcast.image_path}` : podcast.image_url || `/api/podcasts/${podcast.id}/art`;
}

function episodeArtUrl(episode: PodcastEpisodeHit) {
  return episode.image_path
    ? `/api/podcast-art/${episode.image_path}`
    : episode.podcast_image_path
      ? `/api/podcast-art/${episode.podcast_image_path}`
      : episode.image_url
        ? episode.image_url
        : episode.podcast_image_url
          ? episode.podcast_image_url
          : `/api/podcasts/episodes/${episode.id}/art`;
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
  const setPodcastEpisode = useUi((s) => s.setPodcastEpisode);
  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);
  const openrouterConfigured = usePreferences((s) => s.openrouterConfigured);
  const lastUpdate = useLibraryUpdates((s) => s.lastUpdate);

  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<SearchMode>('library');
  const [q, setQ] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiInterpretation, setAiInterpretation] = useState<AiInterpretation | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [artistHits, setArtistHits] = useState<ArtistHit[]>([]);
  const [albumHits, setAlbumHits] = useState<AlbumHit[]>([]);
  const [playlistHits, setPlaylistHits] = useState<PlaylistHit[]>([]);
  const [podcastHits, setPodcastHits] = useState<PodcastHit[]>([]);
  const [podcastEpisodeHits, setPodcastEpisodeHits] = useState<PodcastEpisodeHit[]>([]);
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
        setPodcastHits([]);
        setPodcastEpisodeHits([]);
        setError(null);
        setMode('library');
        setAiPrompt('');
        setAiLoading(false);
        setAiError(null);
        setAiInterpretation(null);
      }, 150);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

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
    if (!isOpen || mode !== 'library' || !token || q.trim().length === 0) {
      if (q.trim().length === 0) {
        setHits([]);
        setArtistHits([]);
        setAlbumHits([]);
        setPlaylistHits([]);
        setPodcastHits([]);
        setPodcastEpisodeHits([]);
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
        setPodcastHits((r.podcasts ?? []).map((p: any) => ({ ...p, id: Number(p.id), unplayed_count: Number(p.unplayed_count ?? 0) })));
        setPodcastEpisodeHits((r.podcastEpisodes ?? []).map((e: any) => ({
          ...e,
          id: Number(e.id),
          podcast_id: Number(e.podcast_id),
          position_ms: Number(e.position_ms ?? 0),
          played: Boolean(e.played),
        })));
      } catch (e: any) {
        if (e?.status === 401) clear();
        setError(e?.message ?? 'Search failed');
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(id);
  }, [q, mode, isOpen, token, clear, lastUpdate]);

  const handleAiSearch = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!token || !prompt || aiLoading) return;

    setAiLoading(true);
    setAiError(null);
    try {
      const result = await sendAiSearch(token, prompt);
      setAiInterpretation({
        originalQuery: result.originalQuery,
        searchQuery: result.searchQuery,
        explanation: result.explanation,
      });
      setQ(result.searchQuery);
      setMode('library');
    } catch (e: any) {
      if (e?.status === 401) clear();
      setAiError(e?.data?.error || e?.message || 'AI search failed');
    } finally {
      setAiLoading(false);
    }
  }, [aiPrompt, aiLoading, token, clear]);

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

  const handlePodcastEpisodePlay = useCallback((episode: PodcastEpisodeHit) => {
    setPodcastEpisode(episode);
    onClose();
  }, [setPodcastEpisode, onClose]);

  if (!isOpen || !token) return null;

  const hasResults = hits.length > 0 || artistHits.length > 0 || albumHits.length > 0 || playlistHits.length > 0 || podcastHits.length > 0 || podcastEpisodeHits.length > 0;
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
          <div className="flex items-center gap-2 sm:gap-3 px-4 sm:px-5 py-4 border-b border-white/10">
            {mode === 'ai' ? (
              <span className="w-5 text-lg leading-none text-center flex-shrink-0" aria-hidden="true">✨</span>
            ) : (
              <svg className="w-5 h-5 text-cyan-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
            <input
              ref={inputRef}
              value={mode === 'ai' ? aiPrompt : q}
              onChange={(e) => {
                if (mode === 'ai') {
                  setAiPrompt(e.target.value);
                  setAiError(null);
                } else {
                  setQ(e.target.value);
                  setAiInterpretation(null);
                }
              }}
              onKeyDown={(e) => {
                if (mode === 'ai' && e.key === 'Enter') {
                  e.preventDefault();
                  handleAiSearch();
                }
              }}
              placeholder={mode === 'ai'
                ? 'Describe what you want to find...'
                : 'Search songs, artists, albums, podcasts...'}
              maxLength={mode === 'ai' ? 500 : undefined}
              className="min-w-0 flex-1 bg-transparent text-white text-base sm:text-lg placeholder-slate-500 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            {(loading || aiLoading) && (
              <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {(mode === 'ai' ? aiPrompt : q) && !loading && !aiLoading && (
              <button
                onClick={() => {
                  if (mode === 'ai') {
                    setAiPrompt('');
                    setAiError(null);
                  } else {
                    setQ('');
                    setAiInterpretation(null);
                  }
                  inputRef.current?.focus();
                }}
                className="p-1 hover:bg-white/10 rounded-md transition-colors flex-shrink-0"
                aria-label="Clear search"
              >
                <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {mode === 'library' ? (
              <button
                onClick={() => {
                  setAiPrompt(q);
                  setAiError(null);
                  setMode('ai');
                  setTimeout(() => inputRef.current?.focus(), 0);
                }}
                className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 transition-colors text-xs font-medium"
                title="Search with natural language"
              >
                <span aria-hidden="true">✨</span>
                <span className="hidden sm:inline">Ask AI</span>
                <span className="sm:hidden">AI</span>
              </button>
            ) : (
              <>
                <button
                  onClick={() => {
                    setMode('library');
                    setAiError(null);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  className="flex-shrink-0 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors text-xs"
                >
                  Back
                </button>
                <button
                  onClick={handleAiSearch}
                  disabled={aiLoading || !aiPrompt.trim() || !openrouterConfigured}
                  className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors text-xs font-medium"
                >
                  Search
                </button>
              </>
            )}
          </div>

          {/* Results */}
          <div className="max-h-[60vh] overflow-y-auto overscroll-contain">
            {mode === 'ai' ? (
              <div className="min-h-[280px] px-6 py-8 flex flex-col items-center justify-center text-center">
                {!openrouterConfigured ? (
                  <>
                    <div className="w-12 h-12 rounded-2xl bg-violet-500/10 border border-violet-400/20 flex items-center justify-center text-2xl mb-4">
                      🔑
                    </div>
                    <h3 className="text-white font-semibold">Connect OpenRouter to use AI search</h3>
                    <p className="text-sm text-slate-400 max-w-md mt-2">
                      Add your own API key in Settings. MVBar sends only the words you type here—not your library or listening data.
                    </p>
                    <button
                      onClick={() => {
                        window.sessionStorage.setItem('mvbar_settings_tab', 'integrations');
                        handleNavigate({ type: 'settings' });
                      }}
                      className="mt-5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm transition-colors"
                    >
                      Open integration settings
                    </button>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-2xl bg-violet-500/10 border border-violet-400/20 flex items-center justify-center text-2xl mb-4">
                      ✨
                    </div>
                    <h3 className="text-white font-semibold">Describe the music you want</h3>
                    <p className="text-sm text-slate-400 max-w-md mt-2">
                      AI turns your request into a focused query, then MVBar searches your permitted libraries locally.
                    </p>
                    <div className="flex flex-wrap justify-center gap-2 mt-5">
                      {AI_SEARCH_SUGGESTIONS.map((suggestion) => (
                        <button
                          key={suggestion}
                          onClick={() => {
                            setAiPrompt(suggestion);
                            setAiError(null);
                            setTimeout(() => inputRef.current?.focus(), 0);
                          }}
                          className="px-3 py-1.5 rounded-full bg-white/5 hover:bg-violet-500/15 border border-white/10 hover:border-violet-400/30 text-xs text-slate-300 hover:text-violet-100 transition-colors"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-600 mt-6">
                      Your request is sent to OpenRouter. Library contents stay inside MVBar.
                    </p>
                  </>
                )}
                {aiError && (
                  <div className="mt-5 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
                    {aiError}
                  </div>
                )}
              </div>
            ) : (
              <>
            {aiInterpretation && (
              <div className="px-5 py-3 border-b border-violet-400/15 bg-violet-500/5 flex items-start gap-3">
                <span className="text-sm mt-0.5" aria-hidden="true">✨</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-violet-100">{aiInterpretation.explanation}</div>
                  <div className="text-xs text-slate-500 mt-1 truncate">
                    “{aiInterpretation.originalQuery}” → “{aiInterpretation.searchQuery}”
                  </div>
                </div>
                <button
                  onClick={() => setAiInterpretation(null)}
                  className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label="Dismiss AI interpretation"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            {error && (
              <div className="px-5 py-3 text-red-400 text-sm border-b border-white/5">{error}</div>
            )}

            {/* Artists */}
            {artistHits.length > 0 && (
              <div className="px-5 py-3 border-b border-white/5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Artists</div>
                <div className="space-y-0.5">
                  {artistHits.slice(0, 4).map((a) => (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleNavigate({ type: 'browse-artist', artistId: a.id, artistName: a.name })}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleNavigate({ type: 'browse-artist', artistId: a.id, artistName: a.name }); }}
                      className="group w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left cursor-pointer"
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
                      <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <AddMenu
                          label="artist"
                          title={`Add ${a.name}...`}
                          getTracks={async () => {
                            if (!token) return [];
                            const r = await browseArtistTracks(token, a.id);
                            return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album })) as AddMenuTrack[];
                          }}
                        />
                      </div>
                      <svg className="w-4 h-4 text-slate-600 flex-shrink-0 group-hover:opacity-0 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
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
                    <div
                      key={`${a.album}-${idx}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleNavigate({ type: 'browse-album', artist: a.display_artist || '', album: a.album, artistId: a.artist_id || undefined })}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleNavigate({ type: 'browse-album', artist: a.display_artist || '', album: a.album, artistId: a.artist_id || undefined }); }}
                      className="group w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left cursor-pointer"
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
                      <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <AddMenu
                          label="album"
                          title={`Add ${a.album}...`}
                          getTracks={async () => {
                            if (!token) return [];
                            const r = await browseAlbum(token, a.display_artist || '', a.album, a.artist_id ?? undefined);
                            return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album })) as AddMenuTrack[];
                          }}
                        />
                      </div>
                      <svg className="w-4 h-4 text-slate-600 flex-shrink-0 group-hover:opacity-0 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
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

            {/* Podcasts */}
            {podcastHits.length > 0 && (
              <div className="px-5 py-3 border-b border-white/5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Podcasts</div>
                <div className="space-y-0.5">
                  {podcastHits.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleNavigate({ type: 'podcast', podcastId: p.id })}
                      className="group w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left"
                    >
                      <div className="w-9 h-9 rounded-lg bg-cyan-500/10 flex-shrink-0 flex items-center justify-center text-xs font-bold text-cyan-200 relative overflow-hidden">
                        {getInitials(p.title)}
                        <img
                          src={podcastArtUrl(p)}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white truncate">{p.title}</div>
                        <div className="text-xs text-slate-400 truncate">
                          {[p.author, p.unplayed_count > 0 ? `${p.unplayed_count} unplayed` : null].filter(Boolean).join(' · ') || 'Podcast'}
                        </div>
                      </div>
                      <svg className="w-4 h-4 text-slate-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Podcast Episodes */}
            {podcastEpisodeHits.length > 0 && (
              <div className="px-5 py-3 border-b border-white/5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Podcast Episodes</div>
                <div className="space-y-0.5">
                  {podcastEpisodeHits.map((episode) => (
                    <button
                      key={episode.id}
                      onClick={() => handlePodcastEpisodePlay(episode)}
                      className="group w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left"
                    >
                      <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex-shrink-0 flex items-center justify-center relative overflow-hidden">
                        <svg className="w-4 h-4 text-cyan-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 6v12m-4-9v6m8-6v6M5 9v6m14-6v6" />
                        </svg>
                        <img
                          src={episodeArtUrl(episode)}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white truncate">{episode.title}</div>
                        <div className="text-xs text-slate-400 truncate">{episode.podcast_title || 'Podcast'}</div>
                        {episode.description && (
                          <div className="text-xs text-slate-500 truncate">{stripHtml(episode.description)}</div>
                        )}
                      </div>
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
                      <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <AddMenu
                          label="track"
                          title="Add to..."
                          getTracks={() => [{ id: Number(t.id), title: t.title, artist: t.display_artist || t.artist, album: t.album }]}
                        />
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
