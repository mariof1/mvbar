'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from './store';
import { usePlayer } from './playerStore';
import { apiFetch } from './apiClient';
import { useLibraryUpdates } from './useWebSocket';

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
  const { setQueueAndPlay, addToQueue: addToPlayerQueue } = usePlayer();

  // Live updates
  const libraryLastUpdate = useLibraryUpdates((s) => s.lastUpdate);
  const libraryLastEvent = useLibraryUpdates((s) => s.lastEvent);

  const loadAlbums = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiFetch('/browse/albums?sort=created&limit=100', {}, token);
      setAlbums(data.albums || []);
    } catch (err) {
      console.error('Failed to load albums:', err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadAlbums();
  }, [loadAlbums]);

  // Live updates: refresh when new tracks are added
  useEffect(() => {
    if (!libraryLastUpdate || !token) return;
    // Only refresh on track_added events to show new albums
    if (libraryLastEvent?.event === 'track_added') {
      loadAlbums();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryLastUpdate]);

  const loadAlbumTracks = useCallback(async (album: Album) => {
    if (!token) return;
    setTracksLoading(true);
    try {
      const data = await apiFetch(`/browse/album?album=${encodeURIComponent(album.album)}&artist=${encodeURIComponent(album.display_artist || '')}`, {}, token);
      setTracks(data.tracks || []);
    } catch (err) {
      console.error('Failed to load album tracks:', err);
    } finally {
      setTracksLoading(false);
    }
  }, [token]);

  const handleAlbumClick = (album: Album) => {
    setSelectedAlbum(album);
    loadAlbumTracks(album);
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
          artist: t.artist,
          album: t.album,
        }));
        if (albumTracks.length > 0) {
          setQueueAndPlay(albumTracks, 0);
        }
      });
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

        <div className="flex items-start gap-6">
          <ArtImage 
            path={selectedAlbum.art_path} 
            hash={selectedAlbum.art_hash} 
            className="w-40 h-40 rounded-xl" 
          />
          <div className="flex-1">
            <h2 className="text-2xl font-bold text-white">{selectedAlbum.album}</h2>
            <p className="text-slate-400 mt-1">{selectedAlbum.display_artist}</p>
            <p className="text-slate-500 text-sm mt-1">{selectedAlbum.track_count} tracks</p>
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

        {tracksLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cyan-500" />
          </div>
        ) : (
          <div className="space-y-1 mt-6">
            {tracks.map((track, idx) => (
              <div
                key={track.id}
                className="flex items-center gap-4 p-3 rounded-lg hover:bg-white/5 group cursor-pointer"
                onClick={() => onPlay(track)}
              >
                <span className="w-8 text-center text-slate-500 text-sm">
                  {track.track_num || idx + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-white truncate">{track.title}</div>
                  <div className="text-slate-400 text-sm truncate">{track.artist}</div>
                </div>
                <span className="text-slate-500 text-sm">{formatDuration(track.duration_ms)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddToQueue(track); }}
                  className="opacity-0 group-hover:opacity-100 p-2 text-slate-400 hover:text-white transition-all"
                  title="Add to queue"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Album grid view
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {albums.map((album) => (
        <div
          key={`${album.album}-${album.display_artist}`}
          className="group cursor-pointer"
          onClick={() => handleAlbumClick(album)}
        >
          <div className="relative aspect-square rounded-xl overflow-hidden mb-2">
            <ArtImage 
              path={album.art_path} 
              hash={album.art_hash} 
              className="w-full h-full" 
            />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <button
                onClick={(e) => handlePlayAlbum(album, e)}
                className="w-12 h-12 bg-cyan-500 rounded-full flex items-center justify-center transform scale-90 group-hover:scale-100 transition-transform"
              >
                <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            </div>
          </div>
          <h3 className="font-medium text-white truncate">{album.album}</h3>
          <p className="text-sm text-slate-400 truncate">{album.display_artist}</p>
        </div>
      ))}
    </div>
  );
}
