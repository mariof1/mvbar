'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from './store';
import { useConnectPlayer } from './connectPlayer';
import { apiFetch, browseAlbum } from './apiClient';
import { useLibraryUpdates } from './useWebSocket';
import { AddMenu, type AddMenuTrack } from './AddMenu';
import { formatArtistValue, trackArtistLabel } from './artistDisplay';
import { formatCount } from './format';
import { useToastStore } from './Toast';
import { useLatestRequest } from './useLatestRequest';

type Album = {
  album: string;
  display_artist: string;
  track_count: number;
  art_path: string | null;
  art_hash: string | null;
  first_track_id: number;
};

type Track = {
  id: number;
  title: string;
  artist: string;
  display_artist?: string | null;
  album: string;
  track_num: number | null;
  disc_num: number | null;
  duration_ms: number;
};

function ArtImage({ path, hash, className }: { path: string | null; hash: string | null; className?: string }) {
  const [error, setError] = useState(false);
  
  if (!path || error) {
    return (
      <div className={`bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center ${className}`}>
        <svg className="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
      </div>
    );
  }
  return (
    <img
      src={`/api/art/${encodeURIComponent(path)}${hash ? `?h=${hash}` : ''}`}
      alt=""
      className={`object-cover ${className}`}
      loading="lazy"
      onError={() => setError(true)}
    />
  );
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function RecentlyAdded({ 
  onPlay, 
  onAddToQueue 
}: { 
  onPlay: (t: Track) => void;
  onAddToQueue: (t: Track) => void;
}) {
  const token = useAuth((s) => s.token);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [albumsError, setAlbumsError] = useState(false);
  const [tracksError, setTracksError] = useState(false);
  const [tracksRetry, setTracksRetry] = useState(0);
  const showToast = useToastStore((state) => state.show);
  const beginAlbumsRequest = useLatestRequest('recent-albums', token);
  const { setQueueAndPlay, addToQueue: addToPlayerQueue } = useConnectPlayer();

  // Live updates
  const libraryLastUpdate = useLibraryUpdates((s) => s.lastUpdate);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAlbums = useCallback(async () => {
    if (!token) return;
    const isCurrent = beginAlbumsRequest();
    if (!isCurrent()) return;
    setAlbumsError(false);
    try {
      const data = await apiFetch('/browse/albums?sort=created&limit=100', {}, token);
      if (isCurrent()) setAlbums(data.albums || []);
    } catch (err) {
      if (isCurrent()) setAlbumsError(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [token, beginAlbumsRequest]);

  useEffect(() => {
    loadAlbums();
  }, [loadAlbums]);

  // Debounce the burst of scan events, retaining the final refresh instead of
  // dropping it. Scan completion and WebSocket reconnection also arrive here.
  useEffect(() => {
    if (!libraryLastUpdate || !token) return;

    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => void loadAlbums(), 750);

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [libraryLastUpdate, loadAlbums, token]);

  useEffect(() => {
    if (!token || !selectedAlbum) return;
    const controller = new AbortController();
    setTracksLoading(true);
    setTracksError(false);
    setTracks([]);
    const album = selectedAlbum;
    void apiFetch(`/browse/album?album=${encodeURIComponent(album.album)}&artist=${encodeURIComponent(album.display_artist || '')}`, { signal: controller.signal }, token)
      .then(data => {
        if (!controller.signal.aborted) setTracks(data.tracks || []);
      })
      .catch(err => {
        if (!controller.signal.aborted) setTracksError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setTracksLoading(false);
      });
    return () => controller.abort();
  }, [token, selectedAlbum, tracksRetry]);

  const handleAlbumClick = (album: Album) => {
    setSelectedAlbum(album);
  };

  const handlePlayAlbum = (album: Album, e: React.MouseEvent) => {
    e.stopPropagation();
    // Load and play all tracks from the album
    if (!token) return;
    apiFetch(`/browse/album?album=${encodeURIComponent(album.album)}&artist=${encodeURIComponent(album.display_artist || '')}`, {}, token)
      .then(data => {
        const albumTracks = (data.tracks || []).map((t: Track) => ({
          id: t.id,
          title: t.title,
          artist: trackArtistLabel(t),
          album: t.album,
        }));
        if (albumTracks.length > 0) {
          setQueueAndPlay(albumTracks, 0);
        } else {
          showToast('No tracks available in this album', 'error');
        }
      })
      .catch(() => showToast('Could not play album. Please try again.', 'error'));
  };

  const handleBack = () => {
    setSelectedAlbum(null);
    setTracks([]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500" />
      </div>
    );
  }

  // Album detail view
  if (selectedAlbum) {
    return (
      <div className="space-y-4">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="flex items-start gap-4 sm:gap-6">
          <ArtImage 
            path={selectedAlbum.art_path} 
            hash={selectedAlbum.art_hash} 
            className="w-24 h-24 sm:w-40 sm:h-40 shrink-0 rounded-xl"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-bold text-white [overflow-wrap:anywhere]">{selectedAlbum.album}</h2>
            <p className="text-slate-400 mt-1 [overflow-wrap:anywhere]">{formatArtistValue(selectedAlbum.display_artist) ?? 'Unknown Artist'}</p>
            <p className="text-slate-500 text-sm mt-1">{formatCount(selectedAlbum.track_count, 'track')}</p>
            <div className="flex gap-3 mt-4">
              <button
                onClick={(e) => handlePlayAlbum(selectedAlbum, e)}
                className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-full font-medium transition-colors"
              >
                Play All
              </button>
            </div>
          </div>
        </div>

        {tracksError ? (
          <div className="rounded-xl bg-red-500/10 p-4 text-red-400">
            <p role="alert">Could not load album tracks.</p>
            <button type="button" onClick={() => setTracksRetry(value => value + 1)} className="mt-2 rounded px-3 py-2 text-cyan-400 hover:bg-white/10">Retry</button>
          </div>
        ) : tracksLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cyan-500" />
          </div>
        ) : (
          <div className="space-y-1 mt-6">
            {tracks.map((track, idx) => (
              <div
                key={track.id}
                className="flex items-center gap-4 p-3 rounded-lg hover:bg-white/5 group"
              >
                <button type="button" onClick={() => onPlay(track)} aria-label={`Play ${track.title}`}
                  className="flex min-w-0 flex-1 items-center gap-4 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <span className="w-8 text-center text-slate-500 text-sm">
                  {track.track_num || idx + 1}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-white truncate">{track.title}</span>
                  <span className="block text-slate-400 text-sm truncate">{trackArtistLabel(track)}</span>
                </span>
                <span className="text-slate-500 text-sm">{formatDuration(track.duration_ms)}</span>
                </button>
                <div className="sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                  <AddMenu
                    label="track"
                    title="Add to..."
                    getTracks={() => [{ id: track.id, title: track.title, artist: trackArtistLabel(track), album: track.album }]}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Album grid view
  return (
    <>
    {albumsError && (
      <div className="mb-4 rounded-xl bg-red-500/10 p-4 text-red-400">
        <p role="alert">Could not load recently added albums.</p>
        <button type="button" onClick={() => { setLoading(true); void loadAlbums(); }} className="mt-2 rounded px-3 py-2 text-cyan-400 hover:bg-white/10">Retry</button>
      </div>
    )}
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {albums.map((album) => (
        <div
          key={`${album.album}-${album.display_artist}`}
          className="group relative"
        >
          <button type="button" aria-label={`Open album ${album.album}`} onClick={() => handleAlbumClick(album)}
            className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400" />
          <div className="relative aspect-square rounded-xl overflow-hidden mb-2">
            <ArtImage 
              path={album.art_path} 
              hash={album.art_hash} 
              className="w-full h-full" 
            />
            <div className="absolute inset-0 z-20 pointer-events-none bg-black/40 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex items-center justify-center">
              <button
                aria-label={`Play album ${album.album}`}
                onClick={(e) => handlePlayAlbum(album, e)}
                className="pointer-events-auto w-12 h-12 bg-cyan-500 rounded-full flex items-center justify-center transform scale-90 group-hover:scale-100 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            </div>
            <div className="absolute top-2 right-2 z-20 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
              <AddMenu
                variant="subtle"
                label="album"
                title={`Add ${album.album}...`}
                getTracks={async () => {
                  if (!token) return [];
                  const r = await browseAlbum(token, album.display_artist, album.album);
                  return r.tracks.map((t: any) => ({ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album })) as AddMenuTrack[];
                }}
              />
            </div>
          </div>
          <h3 className="font-medium text-white truncate">{album.album}</h3>
          <p className="text-sm text-slate-400 truncate">{formatArtistValue(album.display_artist) ?? 'Unknown Artist'}</p>
        </div>
      ))}
    </div>
    </>
  );
}
