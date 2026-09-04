'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from './store';
import {
  apiFetch,
  browseAlbum,
  browseArtistTracks,
  clearRecentSearches,
  getRecentSearches,
  removeRecentSearch,
  saveRecentSearch,
  type RecentSearch,
  type RecentSearchInput,
} from './apiClient';
import { useFavorites } from './favoritesStore';
import { useRouter } from './router';
import { useLibraryUpdates } from './useWebSocket';
import { AddMenu, type AddMenuTrack } from './AddMenu';
import { useUi, type PodcastEpisode } from './uiStore';
import { useBodyScrollLock } from './useBodyScrollLock';
import { formatArtistValue, trackArtistLabel } from './artistDisplay';
import { formatCount } from './format';

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
  art_track_id: number | null;
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
  return `/api/podcasts/${podcast.id}/art`;
}

function episodeArtUrl(episode: PodcastEpisodeHit) {
  return `/api/podcasts/episodes/${episode.id}/art`;
}

function recentItemId(item: Pick<RecentSearch, 'itemType' | 'itemKey'>) {
  return `${item.itemType}:${item.itemKey}`;
}

function artistArtUrl(artist: Pick<ArtistHit, 'art_path' | 'art_hash' | 'art_track_id'>) {
  if (artist.art_path) {
    return `/api/art/${encodeURIComponent(artist.art_path)}${artist.art_hash ? `?h=${artist.art_hash}` : ''}`;
  }
  return artist.art_track_id ? `/api/library/tracks/${artist.art_track_id}/art` : null;
}

function artistRecentItem(artist: ArtistHit): RecentSearchInput {
  return {
    itemType: 'artist',
    itemKey: String(artist.id),
    title: artist.name,
    subtitle: 'Artist',
    imageUrl: artistArtUrl(artist),
    payload: { artistId: artist.id, artistName: artist.name },
  };
}

function albumRecentItem(album: AlbumHit): RecentSearchInput {
  const artist = formatArtistValue(album.display_artist) ?? 'Unknown Artist';
  return {
    itemType: 'album',
    itemKey: JSON.stringify([album.artist_id ?? artist, album.album]),
    title: album.album,
    subtitle: `${artist} · Album`,
    imageUrl: album.art_track_id ? `/api/library/tracks/${album.art_track_id}/art` : null,
    payload: {
      artist: album.display_artist || '',
      album: album.album,
      artistId: album.artist_id,
    },
  };
}

function playlistRecentItem(playlist: PlaylistHit): RecentSearchInput {
  return {
    itemType: 'playlist',
    itemKey: `${playlist.kind ?? 'playlist'}:${playlist.id}`,
    title: playlist.name,
    subtitle: playlist.kind === 'smart' ? 'Smart playlist' : 'Playlist',
    imageUrl: null,
    payload: { id: playlist.id, kind: playlist.kind ?? 'playlist' },
  };
}

function podcastRecentItem(podcast: PodcastHit): RecentSearchInput {
  return {
    itemType: 'podcast',
    itemKey: String(podcast.id),
    title: podcast.title,
    subtitle: [podcast.author, 'Podcast'].filter(Boolean).join(' · '),
    imageUrl: podcastArtUrl(podcast),
    payload: { podcastId: podcast.id },
  };
}

function episodeRecentItem(episode: PodcastEpisodeHit): RecentSearchInput {
  return {
    itemType: 'podcast_episode',
    itemKey: String(episode.id),
    title: episode.title,
    subtitle: [episode.podcast_title, 'Podcast episode'].filter(Boolean).join(' · '),
    imageUrl: episodeArtUrl(episode),
    payload: {
      id: episode.id,
      podcast_id: episode.podcast_id,
      title: episode.title,
      description: null,
      audio_url: episode.audio_url,
      duration_ms: episode.duration_ms,
      image_url: episode.image_url,
      image_path: episode.image_path ?? null,
      published_at: episode.published_at,
      position_ms: episode.position_ms,
      played: episode.played,
      podcast_title: episode.podcast_title,
      podcast_image_url: episode.podcast_image_url,
      podcast_image_path: episode.podcast_image_path ?? null,
    },
  };
}

function trackRecentItem(track: Hit): RecentSearchInput {
  const artist = trackArtistLabel(track);
  return {
    itemType: 'track',
    itemKey: String(track.id),
    title: track.title ?? track.path,
    subtitle: [artist, 'Song'].filter(Boolean).join(' · '),
    imageUrl: `/api/library/tracks/${track.id}/art`,
    payload: { id: track.id, title: track.title, artist },
  };
}

function RecentSearchArtwork({ item }: { item: RecentSearch }) {
  const rounded = item.itemType === 'artist' ? 'rounded-full' : 'rounded-lg';
  return (
    <span className={`relative flex h-11 w-11 flex-none items-center justify-center overflow-hidden bg-white/[0.07] text-slate-400 ${rounded}`}>
      {item.itemType === 'artist' ? (
        <span className="text-xs font-bold text-slate-300">{getInitials(item.title)}</span>
      ) : (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 18V5l11-2v13M9 18c0 1.1-1.34 2-3 2s-3-.9-3-2 1.34-2 3-2 3 .9 3 2zm11-2c0 1.1-1.34 2-3 2s-3-.9-3-2 1.34-2 3-2 3 .9 3 2zM9 9l11-2" />
        </svg>
      )}
      {item.imageUrl && (
        <img
          src={item.imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      )}
    </span>
  );
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
  const lastUpdate = useLibraryUpdates((s) => s.lastUpdate);

  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [artistHits, setArtistHits] = useState<ArtistHit[]>([]);
  const [albumHits, setAlbumHits] = useState<AlbumHit[]>([]);
  const [playlistHits, setPlaylistHits] = useState<PlaylistHit[]>([]);
  const [podcastHits, setPodcastHits] = useState<PodcastHit[]>([]);
  const [podcastEpisodeHits, setPodcastEpisodeHits] = useState<PodcastEpisodeHit[]>([]);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRefreshRef = useRef<number>(0);
  const prevLastUpdateRef = useRef(0);
  useBodyScrollLock(isOpen);

  const persistRecentSearch = useCallback(async (item: RecentSearchInput) => {
    if (!token) return;
    try {
      const saved = await saveRecentSearch(token, item);
      setRecentSearches((current) => [
        saved,
        ...current.filter((recent) => recentItemId(recent) !== recentItemId(saved)),
      ].slice(0, 10));
    } catch (reason: any) {
      if (reason?.status === 401) clear();
    }
  }, [token, clear]);

  // Auto-focus input when opened
  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Recent searches are account-scoped so they follow the user across devices.
  useEffect(() => {
    if (!isOpen || !token) return;
    let active = true;
    setRecentLoading(true);
    getRecentSearches(token)
      .then((response) => { if (active) setRecentSearches(response.searches); })
      .catch((reason: any) => {
        if (reason?.status === 401) clear();
      })
      .finally(() => { if (active) setRecentLoading(false); });
    return () => { active = false; };
  }, [isOpen, token, clear]);

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      setQ('');
      setHits([]);
      setArtistHits([]);
      setAlbumHits([]);
      setPlaylistHits([]);
      setPodcastHits([]);
      setPodcastEpisodeHits([]);
      setLoading(false);
      setError(null);
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

  // Search API call (debounced)
  useEffect(() => {
    if (!isOpen || !token || q.trim().length === 0) {
      if (q.trim().length === 0) {
        setLoading(false);
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

    let active = true;
    let controller: AbortController | null = null;
    const query = q.trim().replace(/\s+/g, ' ');
    const id = setTimeout(async () => {
      controller = new AbortController();
      setLoading(true);
      setError(null);
      try {
        const r = await apiFetch(`/search?q=${encodeURIComponent(query)}&limit=20`, { method: 'GET', signal: controller.signal }, token);
        if (!active) return;
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
        if (!active || e?.name === 'AbortError') return;
        if (e?.status === 401) clear();
        setError(e?.message ?? 'Search failed');
      } finally {
        if (active) setLoading(false);
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(id);
      controller?.abort();
    };
  }, [q, isOpen, token, clear, lastUpdate]);

  const dismissRecentSearch = useCallback(async (item: RecentSearch) => {
    if (!token) return;
    const previous = recentSearches;
    setRecentSearches((current) => current.filter((recent) => recentItemId(recent) !== recentItemId(item)));
    try {
      await removeRecentSearch(token, item.itemType, item.itemKey);
    } catch (reason: any) {
      if (reason?.status === 401) clear();
      else {
        setRecentSearches(previous);
        setError('Could not remove that recent search.');
      }
    }
  }, [token, recentSearches, clear]);

  const dismissAllRecentSearches = useCallback(async () => {
    if (!token || recentSearches.length === 0) return;
    const previous = recentSearches;
    setRecentSearches([]);
    try {
      await clearRecentSearches(token);
    } catch (reason: any) {
      if (reason?.status === 401) clear();
      else {
        setRecentSearches(previous);
        setError('Could not clear recent searches.');
      }
    }
  }, [token, recentSearches, clear]);

  const handleNavigate = useCallback((route: Parameters<typeof navigate>[0], recent: RecentSearchInput) => {
    void persistRecentSearch(recent);
    navigate(route);
    onClose();
  }, [persistRecentSearch, navigate, onClose]);

  const handlePlay = useCallback((t: Hit) => {
    void persistRecentSearch(trackRecentItem(t));
    onPlay?.({ id: t.id, title: t.title, artist: trackArtistLabel(t) });
    onClose();
  }, [persistRecentSearch, onPlay, onClose]);

  const handleAddToQueue = useCallback((t: Hit) => {
    onAddToQueue?.({ id: t.id, title: t.title, artist: trackArtistLabel(t) });
  }, [onAddToQueue]);

  const handlePodcastEpisodePlay = useCallback((episode: PodcastEpisodeHit) => {
    void persistRecentSearch(episodeRecentItem(episode));
    setPodcastEpisode(episode);
    onClose();
  }, [persistRecentSearch, setPodcastEpisode, onClose]);

  const activateRecentSearch = useCallback((item: RecentSearch) => {
    const payload = item.payload;
    const id = Number(payload.id ?? payload.artistId ?? payload.podcastId);
    if (item.itemType === 'track' && Number.isFinite(id)) {
      void persistRecentSearch(item);
      onPlay?.({ id, title: typeof payload.title === 'string' ? payload.title : item.title, artist: typeof payload.artist === 'string' ? payload.artist : null });
      onClose();
      return;
    }
    if (item.itemType === 'artist' && Number.isFinite(id)) {
      void persistRecentSearch(item);
      navigate({ type: 'browse-artist', artistId: id, artistName: typeof payload.artistName === 'string' ? payload.artistName : item.title });
      onClose();
      return;
    }
    if (item.itemType === 'album' && typeof payload.album === 'string') {
      void persistRecentSearch(item);
      const artistId = Number(payload.artistId);
      navigate({
        type: 'browse-album',
        artist: typeof payload.artist === 'string' ? payload.artist : '',
        album: payload.album,
        artistId: Number.isFinite(artistId) ? artistId : undefined,
      });
      onClose();
      return;
    }
    if (item.itemType === 'playlist' && Number.isFinite(id)) {
      void persistRecentSearch(item);
      navigate(payload.kind === 'smart' ? { type: 'playlists', sub: 'smart' } : { type: 'playlist', playlistId: String(id) });
      onClose();
      return;
    }
    if (item.itemType === 'podcast' && Number.isFinite(id)) {
      void persistRecentSearch(item);
      navigate({ type: 'podcast', podcastId: id });
      onClose();
      return;
    }
    if (
      item.itemType === 'podcast_episode'
      && Number.isFinite(id)
      && Number.isFinite(Number(payload.podcast_id))
      && typeof payload.audio_url === 'string'
    ) {
      void persistRecentSearch(item);
      setPodcastEpisode(payload as unknown as PodcastEpisode);
      onClose();
      return;
    }
    setError('This recent item is no longer available.');
  }, [navigate, onClose, onPlay, persistRecentSearch, setPodcastEpisode]);

  if (!isOpen || !token) return null;

  const hasResults = hits.length > 0 || artistHits.length > 0 || albumHits.length > 0 || playlistHits.length > 0 || podcastHits.length > 0 || podcastEpisodeHits.length > 0;
  const hasQuery = q.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[150] flex items-start justify-center pt-[8vh] sm:pt-[12vh] px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-2xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search library"
      >
        <div className="glass rounded-2xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden">
          {/* Search Input */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
            <svg className="w-5 h-5 text-cyan-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              aria-label="Search library"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search songs, artists, albums, podcasts..."
              className="flex-1 bg-transparent text-white text-lg placeholder-slate-500 focus:outline-none"
              autoComplete="off"
              maxLength={200}
              spellCheck={false}
            />
            {loading && (
              <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {q && !loading && (
              <button
                onClick={() => { setQ(''); inputRef.current?.focus(); }}
                className="p-1 hover:bg-white/10 rounded-md transition-colors flex-shrink-0"
                aria-label="Clear search"
                title="Clear search"
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
                    <div
                      key={a.id}
                      className="group w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left cursor-pointer"
                    >
                      <button
                        type="button"
                        onClick={() => handleNavigate(
                          { type: 'browse-artist', artistId: a.id, artistName: a.name },
                          artistRecentItem(a),
                        )}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                      >
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex-shrink-0 flex items-center justify-center text-xs font-bold text-white relative overflow-hidden">
                          {getInitials(a.name)}
                          {artistArtUrl(a) && (
                            <img
                              src={artistArtUrl(a)!}
                              alt=""
                              className="absolute inset-0 w-full h-full object-cover"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                            />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-white truncate">{a.name}</div>
                          <div className="text-xs text-slate-400">{formatCount(a.track_count, 'track')} · {formatCount(a.album_count, 'album')}</div>
                        </div>
                        <svg className="w-4 h-4 text-slate-600 flex-shrink-0 group-hover:opacity-0 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <AddMenu
                          label="artist"
                          title={`Add ${a.name}...`}
                          getTracks={async () => {
                            if (!token) return [];
                            const r = await browseArtistTracks(token, a.id);
                            return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                          }}
                        />
                      </div>
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
                      className="group w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left cursor-pointer"
                    >
                      <button
                        type="button"
                        onClick={() => handleNavigate(
                          { type: 'browse-album', artist: a.display_artist || '', album: a.album, artistId: a.artist_id || undefined },
                          albumRecentItem(a),
                        )}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
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
                          <div className="text-xs text-slate-400 truncate">{formatArtistValue(a.display_artist) ?? 'Unknown Artist'} · {formatCount(a.track_count, 'track')}</div>
                        </div>
                        <svg className="w-4 h-4 text-slate-600 flex-shrink-0 group-hover:opacity-0 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <AddMenu
                          label="album"
                          title={`Add ${a.album}...`}
                          getTracks={async () => {
                            if (!token) return [];
                            const r = await browseAlbum(token, a.display_artist || '', a.album, a.artist_id ?? undefined);
                            return r.tracks.map((t) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                          }}
                        />
                      </div>
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
                      onClick={() => handleNavigate(
                        p.kind === 'smart' ? { type: 'playlists', sub: 'smart' } : { type: 'playlist', playlistId: String(p.id) },
                        playlistRecentItem(p),
                      )}
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
                      onClick={() => handleNavigate({ type: 'podcast', podcastId: p.id }, podcastRecentItem(p))}
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
                          {[trackArtistLabel(t), t.album].filter(Boolean).join(' · ')}
                        </div>
                      </button>

                      {/* Actions */}
                      <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <AddMenu
                          label="track"
                          title="Add to..."
                          getTracks={() => [{ id: Number(t.id), title: t.title, artist: trackArtistLabel(t), album: t.album }]}
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

            {/* Spotify-style recently selected results */}
            {!hasQuery && !error && (
              recentLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" aria-label="Loading recent searches" />
                </div>
              ) : recentSearches.length > 0 ? (
                <section className="px-3 py-3 sm:px-5 sm:py-4" aria-labelledby="recent-searches-title">
                  <div className="mb-2 flex items-center justify-between gap-4 px-2">
                    <h2 id="recent-searches-title" className="text-sm font-semibold text-white">Recent searches</h2>
                    <button
                      type="button"
                      onClick={() => void dismissAllRecentSearches()}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="space-y-0.5">
                    {recentSearches.map((recent) => (
                      <div
                        key={recentItemId(recent)}
                        className="group flex items-center gap-2 rounded-xl transition hover:bg-white/[0.06]"
                      >
                        <button
                          type="button"
                          onClick={() => activateRecentSearch(recent)}
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                        >
                          <RecentSearchArtwork item={recent} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-white">{recent.title}</span>
                            {recent.subtitle && <span className="block truncate text-xs text-slate-500">{recent.subtitle}</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void dismissRecentSearch(recent)}
                          className="mr-2 rounded-full p-2 text-slate-500 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                          aria-label={`Remove ${recent.title} from recent searches`}
                          title="Remove"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : (
                <div className="px-5 py-10 text-center text-slate-500">
                  <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <p className="text-sm">Search your library</p>
                  <p className="mt-1 text-xs text-slate-600">Artists, albums, songs, and more that you open will appear here.</p>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
