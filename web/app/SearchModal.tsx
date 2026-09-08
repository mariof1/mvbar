'use client';

import { useDialogFocus } from './useDialogFocus';
import { useLatestRequest } from './useLatestRequest';

import { useEffect, useState, useRef, useCallback } from 'react';
import { MissingSongSearch } from './MissingSongSearch';
import { useAuth } from './store';
import {
  apiFetch,
  browseAlbum,
  browseArtistTracks,
  clearRecentSearches,
  getRecentSearches,
  removeRecentSearch,
  saveRecentSearch,
  sendAiIntent,
  type AiIntentResponse,
  type AiIntentTrack,
  type RecentSearch,
  type RecentSearchInput,
} from './apiClient';
import { useFavorites } from './favoritesStore';
import { usePreferences } from './preferencesStore';
import { useRouter } from './router';
import { useLibraryUpdates } from './useWebSocket';
import { AddMenu, type AddMenuTrack } from './AddMenu';
import { useUi, type PodcastEpisode } from './uiStore';
import { useBodyScrollLock } from './useBodyScrollLock';
import { formatArtistValue, trackArtistLabel } from './artistDisplay';
import { formatCount } from './format';
import { useToastStore } from './Toast';

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

type SearchMode = 'library' | 'ai';

const AI_SEARCH_SUGGESTIONS = [
  'Soft music for a late-night flight',
  'Play British grunge and similar',
  'Play 10 songs, each 10 minutes or longer',
  'Queue upbeat electronic music',
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
  onPlayAll?: (tracks: AiIntentTrack[]) => void;
  onQueueAll?: (tracks: AiIntentTrack[]) => void;
}

export function SearchModal({ isOpen, onClose, onPlay, onAddToQueue, onPlayAll, onQueueAll }: SearchModalProps) {
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
  const [aiResult, setAiResult] = useState<AiIntentResponse | null>(null);
  const beginAiRequest = useLatestRequest(`${isOpen}:${mode}`, token);
  const pendingAiRequest = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    setAiLoading(false);
  }, [isOpen, mode, token]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [artistHits, setArtistHits] = useState<ArtistHit[]>([]);
  const [albumHits, setAlbumHits] = useState<AlbumHit[]>([]);
  const [audiobookHits, setAudiobookHits] = useState<Array<{ id: number; title: string; author: string | null; has_cover: boolean }>>([]);
  const [playlistHits, setPlaylistHits] = useState<PlaylistHit[]>([]);
  const [podcastHits, setPodcastHits] = useState<PodcastHit[]>([]);
  const [podcastEpisodeHits, setPodcastEpisodeHits] = useState<PodcastEpisodeHit[]>([]);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentSaving, setRecentSaving] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const beginRecentMutation = useLatestRequest(isOpen, token);
  const pendingRecentMutation = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    setRecentSaving(false);
    setRecentError(null);
  }, [isOpen, token]);
  const [loading, setLoading] = useState(false);
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const [scanInProgress, setScanInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRefreshRef = useRef<number>(0);
  const prevLastUpdateRef = useRef(0);
  useBodyScrollLock(isOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose, isOpen && !!token);

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
      setSearchedQuery(null);
      setHits([]);
      setArtistHits([]);
      setAlbumHits([]);
      setPlaylistHits([]);
      setAudiobookHits([]);
      setPodcastHits([]);
      setPodcastEpisodeHits([]);
      setLoading(false);
      setError(null);
      setMode('library');
      setAiPrompt('');
      setAiLoading(false);
      setAiError(null);
      setAiResult(null);
    }
  }, [isOpen]);

  // Existing authenticated endpoint also covers users who joined mid-scan.
  useEffect(() => {
    if (!isOpen || mode !== 'library' || !token) return;
    const controller = new AbortController();
    let active = true;
    const refresh = async () => {
      try {
        const progress = await apiFetch('/scan/progress', { signal: controller.signal }, token);
        if (active) setScanInProgress(['scanning', 'indexing'].includes(progress.status));
      } catch { /* Search remains usable when progress is unavailable. */ }
    };
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => { active = false; controller.abort(); clearInterval(interval); };
  }, [isOpen, mode, token]);

  // Search API call (debounced)
  useEffect(() => {
    if (!isOpen || mode !== 'library' || !token || q.trim().length === 0) {
      if (q.trim().length === 0) {
        setLoading(false);
        setHits([]);
        setArtistHits([]);
        setAlbumHits([]);
        setPlaylistHits([]);
        setAudiobookHits([]);
        setPodcastHits([]);
        setPodcastEpisodeHits([]);
      }
      return;
    }

    // Only throttle searches triggered by library updates, not user typing
    let delay = 200;
    const isLibraryUpdate = lastUpdate !== prevLastUpdateRef.current;
    if (isLibraryUpdate) {
      prevLastUpdateRef.current = lastUpdate;
      const now = Date.now();
      delay = Math.max(delay, 3000 - (now - lastRefreshRef.current));
      lastRefreshRef.current = now;
    }

    let active = true;
    let controller: AbortController | null = null;
    const query = q.trim().replace(/\s+/g, ' ');
    setLoading(true);
    setError(null);
    const id = setTimeout(async () => {
      controller = new AbortController();
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
        setAudiobookHits(r.audiobooks ?? []);
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
        if (active) { setSearchedQuery(query); setLoading(false); }
      }
    }, delay);
    return () => {
      active = false;
      clearTimeout(id);
      controller?.abort();
    };
  }, [q, mode, isOpen, token, clear, lastUpdate, scanInProgress]);

  const handleAiSearch = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!token || !isOpen || mode !== 'ai' || !openrouterConfigured || !prompt || pendingAiRequest.current?.()) return;
    const isCurrent = beginAiRequest();
    pendingAiRequest.current = isCurrent;

    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    try {
      const result = await sendAiIntent(token, prompt);
      if (!isCurrent()) return;

      if (result.tracks.length === 0) {
        setAiError(`No matching tracks were found in your permitted libraries. ${result.explanation}`);
        return;
      }

      if (result.action === 'play' || result.action === 'queue') {
        if (result.action === 'play') {
          if (onPlayAll) onPlayAll(result.tracks);
          else {
            const first = result.tracks[0];
            onPlay?.({ id: first.id, title: first.title, artist: first.displayArtist || first.artist });
          }
          useToastStore.getState().show(
            result.tracks.length < result.requestedTrackCount
              ? `Playing ${result.tracks.length} of ${result.requestedTrackCount} matching tracks`
              : `Playing ${result.tracks.length} matching tracks`,
            'success'
          );
        } else if (onQueueAll) {
          onQueueAll(result.tracks);
        } else {
          result.tracks.forEach((track) => {
            onAddToQueue?.({ id: track.id, title: track.title, artist: track.displayArtist || track.artist });
          });
        }
        onClose();
        return;
      }

      setAiResult(result);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 401) clear();
      setAiError(e?.data?.error || e?.message || 'AI music request failed');
    } finally {
      if (isCurrent()) {
        pendingAiRequest.current = null;
        setAiLoading(false);
      }
    }
  }, [aiPrompt, token, isOpen, mode, openrouterConfigured, beginAiRequest, clear, onPlayAll, onQueueAll, onPlay, onAddToQueue, onClose]);

  const dismissRecentSearch = useCallback(async (item?: RecentSearch) => {
    if (!token || !isOpen || mode !== 'library' || !recentSearches.length || pendingRecentMutation.current?.()) return;
    const isCurrent = beginRecentMutation();
    pendingRecentMutation.current = isCurrent;
    const previous = recentSearches;
    setRecentSaving(true);
    setRecentError(null);
    setRecentSearches((current) => item ? current.filter((recent) => recentItemId(recent) !== recentItemId(item)) : []);
    try {
      if (item) await removeRecentSearch(token, item.itemType, item.itemKey);
      else await clearRecentSearches(token);
    } catch (reason: any) {
      if (!isCurrent()) return;
      if (reason?.status === 401) clear();
      else {
        setRecentSearches(previous);
        setRecentError(item ? 'Could not remove that recent search.' : 'Could not clear recent searches.');
      }
    } finally {
      if (isCurrent()) {
        pendingRecentMutation.current = null;
        setRecentSaving(false);
      }
    }
  }, [token, isOpen, mode, beginRecentMutation, recentSearches, clear]);

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
      navigate(payload.kind === 'smart' ? { type: 'playlists', sub: 'smart', smartPlaylistId: id } : { type: 'playlist', playlistId: String(id) });
      onClose();
      return;
    }
    if (item.itemType === 'audiobook' && Number.isFinite(id)) {
      void persistRecentSearch(item);
      navigate({ type: 'audiobook', audiobookId: id });
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

  const hasResults = audiobookHits.length > 0 || hits.length > 0 || artistHits.length > 0 || albumHits.length > 0 || playlistHits.length > 0 || podcastHits.length > 0 || podcastEpisodeHits.length > 0;
  const normalizedQuery = q.trim().replace(/\s+/g, ' ');
  const hasQuery = normalizedQuery.length > 0;
  const searchPending = hasQuery && (loading || searchedQuery !== normalizedQuery);

  return (
    <div className="fixed inset-0 z-[150] flex items-start justify-center p-2 sm:px-4 sm:pt-[min(8dvh,4rem)] sm:pb-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="relative flex min-h-0 max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col animate-slide-up sm:max-h-[calc(100dvh-5rem)]"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Search library"
      >
        <div className="glass flex min-h-0 flex-col rounded-2xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-1">
            <h2 className="text-sm font-medium text-slate-300">{mode === 'ai' ? 'Ask AI for music' : 'Search library'}</h2>
            <button type="button" onClick={onClose} aria-label="Close search"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* Search Input */}
          <div className="flex shrink-0 items-center gap-2 sm:gap-3 px-3 sm:px-5 py-3 border-b border-white/10">
            {mode === 'ai' ? (
              <span className="w-5 text-lg leading-none text-center flex-shrink-0" aria-hidden="true">✨</span>
            ) : (
              <svg className="w-5 h-5 text-cyan-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
            <input
              ref={inputRef}
              aria-label={mode === 'ai' ? 'Ask AI for music' : 'Search library'}
              value={mode === 'ai' ? aiPrompt : q}
              onChange={(e) => {
                if (mode === 'ai') {
                  setAiPrompt(e.target.value);
                  setAiError(null);
                } else {
                  setQ(e.target.value);
                  setAiResult(null);
                }
              }}
              onKeyDown={(e) => {
                if (mode === 'ai' && e.key === 'Enter') {
                  e.preventDefault();
                  handleAiSearch();
                }
              }}
              placeholder={mode === 'ai'
                ? 'Try “play soft music” or describe a mood...'
                : 'Artists, albums, songs...'}
              maxLength={mode === 'ai' ? 500 : 200}
              className="min-w-0 flex-1 bg-transparent text-white text-base sm:text-lg placeholder-slate-500 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            {((mode === 'library' && searchPending) || aiLoading) && (
              <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {(mode === 'ai' ? aiPrompt : q) && !loading && !aiLoading && (
              <button
                onClick={() => {
                  if (mode === 'ai') {
                    setAiPrompt('');
                    setAiError(null);
                    setAiResult(null);
                  } else {
                    setQ('');
                    setSearchedQuery(null);
                  }
                  inputRef.current?.focus();
                }}
                className="flex h-11 w-11 items-center justify-center hover:bg-white/10 rounded-md transition-colors flex-shrink-0"
                aria-label="Clear search"
                title="Clear search"
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
                  setAiResult(null);
                  setMode('ai');
                  setTimeout(() => inputRef.current?.focus(), 0);
                }}
                className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 transition-colors text-xs font-medium"
                title="Play or search with natural language"
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
                    setAiResult(null);
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
                  Go
                </button>
              </>
            )}
          </div>

          {/* Results */}
          <div className="min-h-0 max-h-[60dvh] overflow-y-auto overscroll-contain">
            {mode === 'ai' ? (
              <div className={`min-h-[280px] px-4 py-6 sm:px-6 sm:py-8 flex flex-col ${aiResult ? 'items-stretch text-left' : 'items-center justify-center text-center'}`}>
                {!openrouterConfigured ? (
                  <>
                    <div className="w-12 h-12 rounded-2xl bg-violet-500/10 border border-violet-400/20 flex items-center justify-center text-2xl mb-4">
                      🔑
                    </div>
                    <h3 className="text-white font-semibold">Connect OpenRouter to use AI music</h3>
                    <p className="text-sm text-slate-400 max-w-md mt-2">
                      Add your own API key in Settings, or ask the server administrator to configure one. MVBar sends only the words you type here—not your library or listening data.
                    </p>
                    <button
                      onClick={() => {
                        window.sessionStorage.setItem('mvbar_settings_tab', 'integrations');
                        navigate({ type: 'settings' });
                        onClose();
                      }}
                      className="mt-5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm transition-colors"
                    >
                      Open integration settings
                    </button>
                  </>
                ) : aiResult ? (
                  <>
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-violet-400/20 bg-violet-500/10 text-xl" aria-hidden="true">✨</div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-semibold text-white">Your AI mix</h3>
                        <p className="mt-1 text-sm text-slate-300">{aiResult.explanation}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {aiResult.tracks.length < aiResult.requestedTrackCount
                            ? `${aiResult.tracks.length} of ${aiResult.requestedTrackCount} matching tracks`
                            : `${aiResult.tracks.length} matching tracks`}
                          {' · '}{aiResult.model}
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (onPlayAll) onPlayAll(aiResult.tracks);
                          else {
                            const first = aiResult.tracks[0];
                            onPlay?.({ id: first.id, title: first.title, artist: first.displayArtist || first.artist });
                          }
                          useToastStore.getState().show(`Playing ${aiResult.tracks.length}-track AI mix`, 'success');
                          onClose();
                        }}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                        Play mix
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (onQueueAll) onQueueAll(aiResult.tracks);
                          else aiResult.tracks.forEach((track) => onAddToQueue?.({ id: track.id, title: track.title, artist: track.displayArtist || track.artist }));
                          useToastStore.getState().show(`${aiResult.tracks.length} AI mix tracks added to the queue`, 'success');
                          onClose();
                        }}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" d="M4 6h10M4 12h10M4 18h7" /><path strokeLinecap="round" strokeLinejoin="round" d="M18 11v6m-3-3h6" /></svg>
                        Add to queue
                      </button>
                    </div>

                    <div className="mt-4 space-y-1" aria-label="AI mix preview">
                      {aiResult.tracks.slice(0, 10).map((track, index) => (
                        <button
                          key={track.id}
                          type="button"
                          onClick={() => {
                            onPlay?.({ id: track.id, title: track.title, artist: track.displayArtist || track.artist });
                            onClose();
                          }}
                          className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                        >
                          <span className="w-5 flex-none text-center text-xs tabular-nums text-slate-600">{index + 1}</span>
                          <span className="relative h-10 w-10 flex-none overflow-hidden rounded-lg bg-white/[0.06]">
                            <img
                              src={`/api/library/tracks/${track.id}/art`}
                              alt=""
                              className="h-full w-full object-cover"
                              onError={(event) => { event.currentTarget.style.display = 'none'; }}
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-white">{track.title || track.path}</span>
                            <span className="block truncate text-xs text-slate-500">{[track.displayArtist || track.artist, track.album].filter(Boolean).join(' · ') || 'Unknown artist'}</span>
                          </span>
                          <svg className="h-4 w-4 flex-none text-slate-600 transition group-hover:text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                        </button>
                      ))}
                    </div>
                    {aiResult.tracks.length > 10 && (
                      <p className="mt-2 text-center text-xs text-slate-500">and {aiResult.tracks.length - 10} more in the mix</p>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setAiResult(null);
                        setTimeout(() => inputRef.current?.focus(), 0);
                      }}
                      className="mx-auto mt-5 rounded-lg px-3 py-2 text-xs font-medium text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
                    >
                      Refine prompt
                    </button>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-2xl bg-violet-500/10 border border-violet-400/20 flex items-center justify-center text-2xl mb-4">
                      ✨
                    </div>
                    <h3 className="text-white font-semibold">Describe your mix</h3>
                    <p className="text-sm text-slate-400 max-w-md mt-2">
                      MVBar understands mood, tempo, style, era, origin and length. A description creates a preview; say “play” or “queue” to act immediately.
                    </p>
                    <div className="flex flex-wrap justify-center gap-2 mt-5">
                      {AI_SEARCH_SUGGESTIONS.map((suggestion) => (
                        <button
                          key={suggestion}
                          onClick={() => {
                            setAiPrompt(suggestion);
                            setAiError(null);
                            setAiResult(null);
                            setTimeout(() => inputRef.current?.focus(), 0);
                          }}
                          className="px-3 py-1.5 rounded-full bg-white/5 hover:bg-violet-500/15 border border-white/10 hover:border-violet-400/30 text-xs text-slate-300 hover:text-violet-100 transition-colors"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-600 mt-6">
                      Your request is sent to OpenRouter. The default free model provider may log the prompt. For “similar” requests, seed artist names may also use the server&apos;s Last.fm integration. Library contents stay inside MVBar.
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
                        p.kind === 'smart' ? { type: 'playlists', sub: 'smart', smartPlaylistId: p.id } : { type: 'playlist', playlistId: String(p.id) },
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

            {audiobookHits.length > 0 && (
              <div className="px-3 py-2 border-b border-white/5">
                <h3 className="px-2 py-1 text-xs font-semibold text-slate-500 uppercase tracking-wider">Audiobooks</h3>
                {audiobookHits.map((book) => (
                  <button key={book.id} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5"
                    onClick={() => handleNavigate({ type: 'audiobook', audiobookId: Number(book.id) }, {
                      itemType: 'audiobook', itemKey: String(book.id), title: book.title, subtitle: book.author ? `Audiobook · ${book.author}` : 'Audiobook',
                      imageUrl: book.has_cover ? `/api/audiobook-art/${book.id}` : null, payload: { id: Number(book.id) },
                    })}>
                    <div className="w-9 h-9 flex-shrink-0 rounded-lg bg-cyan-500/10 overflow-hidden flex items-center justify-center" aria-hidden="true">
                      {book.has_cover ? <img src={`/api/audiobook-art/${book.id}`} alt="" className="w-full h-full object-cover" /> : '📖'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white truncate">{book.title}</div>
                      <div className="text-xs text-slate-400 truncate">{book.author || 'Audiobook'}</div>
                    </div>
                  </button>
                ))}
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
                        aria-label={`Play ${t.title ?? "track"}`}
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

            {scanInProgress && hasResults && (
              <p role="status" className="px-5 py-3 text-sm text-slate-400">Library indexing is in progress. Search results may be incomplete.</p>
            )}
            {searchPending && !hasResults && <p role="status" className="px-5 py-12 text-center text-slate-400">Searching…</p>}
            {/* No results */}
            {hasQuery && !searchPending && !hasResults && !error && (
              <div className="px-5 py-12 text-center">
                <svg className="w-12 h-12 mx-auto mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-slate-400">{scanInProgress ? "Library indexing is in progress" : "No results found"}</p>
                <p className="text-sm text-slate-500 mt-1">{scanInProgress ? "Search results will appear as indexing finishes. You can browse your library now." : "Try a different search term"}</p>
              </div>
            )}

            {/* Spotify-style recently selected results */}
            {isOpen && <MissingSongSearch query={q} />}
            {!hasQuery && recentError && (
              <p role="alert" className="px-5 pt-3 text-sm text-red-400">{recentError}</p>
            )}
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
                      onClick={() => void dismissRecentSearch()}
                      disabled={recentSaving}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
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
                          disabled={recentSaving}
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
