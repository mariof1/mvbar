'use client';

import { useEffect, useState, useCallback } from 'react';
import { createPlaylist, getPlaylistItems, listPlaylists, addTrackToPlaylist, removeTrackFromPlaylist, setPlaylistItemPosition } from './apiClient';
import { useAuth } from './store';
import { SmartPlaylists } from './SmartPlaylists';
import { useRouter } from './router';
import { usePlaylistUpdates, useLibraryUpdates } from './useWebSocket';

type PlaylistTab = 'regular' | 'smart';

type Playlist = { id: string; name: string; created_at: string };
type PlaylistItem = { id: string; track_id: string; position: number; title: string | null; artist: string | null; album: string | null; duration_ms: number | null };

function swap<T>(arr: T[], i: number, j: number) {
  const next = arr.slice();
  const tmp = next[i];
  next[i] = next[j];
  next[j] = tmp;
  return next;
}

export function Playlists(props: {
  onPlayTrack?: (t: { id: number; title: string | null; artist: string | null }) => void;
  onPlayAll?: (tracks: Array<{ id: number; title: string | null; artist: string | null }>) => void;
}) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  
  // Navigation using new router
  const route = useRouter((s) => s.route);
  const navigate = useRouter((s) => s.navigate);
  const back = useRouter((s) => s.back);
  
  // Derive state from route
  const tab = (route.type === 'playlists' && route.sub ? route.sub : 'regular') as PlaylistTab;
  const selectedId = route.type === 'playlist' ? route.playlistId : null;

  const [pls, setPls] = useState<Playlist[]>([]);
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [name, setName] = useState('');
  const [addTrackId, setAddTrackId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Live updates
  const playlistLastUpdate = usePlaylistUpdates((s) => s.lastUpdate);
  const playlistLastEvent = usePlaylistUpdates((s) => s.lastEvent);
  const lastLibraryUpdate = useLibraryUpdates((s) => s.lastUpdate);

  // Wrapper to select playlist with router
  const selectPlaylist = useCallback((id: string) => {
    navigate({ type: 'playlist', playlistId: id });
  }, [navigate]);

  // Wrapper to go back to list
  const goBackToList = useCallback(() => {
    back();
  }, [back]);

  // Switch tab with router
  const switchTab = useCallback((newTab: PlaylistTab) => {
    if (newTab === tab) return;
    navigate({ type: 'playlists', sub: newTab });
  }, [tab, navigate]);

  async function refreshPlaylists() {
    if (!token) return;
    try {
      const r = await listPlaylists(token);
      setPls(r.playlists ?? []);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }

  async function refreshItems(id: string) {
    if (!token) return;
    try {
      const r = await getPlaylistItems(token, id);
      setItems(r.items ?? []);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }

  useEffect(() => {
    if (!token) return;
    refreshPlaylists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!selectedId) return;
    refreshItems(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, token]);

  // Live updates: refresh playlists list when a playlist is created
  useEffect(() => {
    if (!playlistLastUpdate || !token) return;
    refreshPlaylists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistLastUpdate]);

  // Live updates: refresh items when current playlist is modified
  useEffect(() => {
    if (!playlistLastEvent || !selectedId || !token) return;
    const eventPlaylistId = playlistLastEvent.playlistId ?? playlistLastEvent.id;
    if (eventPlaylistId && String(eventPlaylistId) === selectedId) {
      refreshItems(selectedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistLastEvent, selectedId]);

  // Live updates: refresh items when library changes (track metadata updates)
  useEffect(() => {
    if (!lastLibraryUpdate || !selectedId || !token) return;
    refreshItems(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLibraryUpdate, selectedId]);

  async function handleCreate() {
    if (!token) return;
    setError(null);
    const n = name.trim();
    if (!n) return;
    try {
      await createPlaylist(token, n);
      setName('');
      await refreshPlaylists();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleAddTrack() {
    if (!token || !selectedId) return;
    setError(null);
    const tid = Number(addTrackId);
    if (!Number.isFinite(tid)) return;
    try {
      await addTrackToPlaylist(token, selectedId, tid);
      setAddTrackId('');
      await refreshItems(selectedId);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleRemove(trackId: number) {
    if (!token || !selectedId) return;
    setError(null);
    try {
      await removeTrackFromPlaylist(token, selectedId, trackId);
      await refreshItems(selectedId);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleMove(trackId: number, direction: -1 | 1) {
    if (!token || !selectedId) return;
    const idx = items.findIndex((it) => Number(it.track_id) === trackId);
    const j = idx + direction;
    if (idx < 0 || j < 0 || j >= items.length) return;

    // optimistic reorder
    const nextItems = swap(items, idx, j).map((it, k) => ({ ...it, position: k }));
    setItems(nextItems);

    try {
      // persist positions (two updates)
      await setPlaylistItemPosition(token, selectedId, Number(nextItems[idx].track_id), nextItems[idx].position);
      await setPlaylistItemPosition(token, selectedId, Number(nextItems[j].track_id), nextItems[j].position);
      await refreshItems(selectedId);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
      await refreshItems(selectedId);
    }
  }

  if (!token) return null;

  const selectedPlaylist = pls.find(p => p.id === selectedId);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => switchTab('regular')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors text-sm sm:text-base ${
            tab === 'regular'
              ? 'bg-cyan-500 text-white'
              : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          Playlists
        </button>
        <button
          onClick={() => switchTab('smart')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors text-sm sm:text-base ${
            tab === 'smart'
              ? 'bg-purple-500 text-white'
              : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          Smart Playlists
        </button>
      </div>

      {tab === 'smart' ? (
        <SmartPlaylists onPlayTrack={props.onPlayTrack} onPlayAll={props.onPlayAll} />
      ) : selectedId && selectedPlaylist ? (
        /* Playlist Detail View */
        <div className="space-y-4">
          {/* Back button and header */}
          <div className="flex items-center gap-3">
            <button
              onClick={goBackToList}
              className="p-2 rounded-lg hover:bg-slate-800/50 text-slate-400 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-white truncate">{selectedPlaylist.name}</h2>
              <p className="text-sm text-slate-400">{items.length} tracks</p>
            </div>
            <button
              onClick={() =>
                props.onPlayAll?.(
                  items.map((it) => ({ id: Number(it.track_id), title: it.title, artist: it.artist }))
                )
              }
              disabled={items.length === 0}
              className={`p-3 rounded-full transition-colors ${
                items.length > 0
                  ? 'bg-cyan-500 hover:bg-cyan-400 text-white'
                  : 'bg-slate-700 text-slate-500 cursor-not-allowed'
              }`}
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          </div>

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Track List */}
          <div className="space-y-1">
            {items.map((it, idx) => (
              <div
                key={it.track_id}
                className="group flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg hover:bg-slate-800/50 transition-colors"
              >
                {/* Play button - always visible on mobile */}
                <button
                  onClick={() => props.onPlayTrack?.({ id: Number(it.track_id), title: it.title, artist: it.artist })}
                  className="w-8 h-8 flex items-center justify-center flex-shrink-0 text-cyan-400"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>

                {/* Track Info */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white truncate text-sm sm:text-base">{it.title ?? `Track #${it.track_id}`}</div>
                  <div className="text-xs sm:text-sm text-slate-400 truncate">
                    {[it.artist, it.album].filter(Boolean).join(' • ') || 'Unknown'}
                  </div>
                </div>

                {/* Actions - always visible on mobile, hover on desktop */}
                <div className="flex items-center gap-0.5 sm:gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleMove(Number(it.track_id), -1)}
                    disabled={idx === 0}
                    className={`p-1.5 rounded-lg transition-colors ${
                      idx === 0 ? 'text-slate-600' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleMove(Number(it.track_id), 1)}
                    disabled={idx === items.length - 1}
                    className={`p-1.5 rounded-lg transition-colors ${
                      idx === items.length - 1 ? 'text-slate-600' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleRemove(Number(it.track_id))}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/20 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}

            {items.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                </svg>
                <p>Empty playlist</p>
                <p className="text-sm mt-1">Add tracks from search or browse</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Playlists List View */
        <div className="space-y-4">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Create Playlist - stacked on mobile */}
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="New playlist name..."
              className="flex-1 px-4 py-3 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-transparent transition-all"
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim()}
              className={`px-6 py-3 rounded-xl font-medium transition-colors flex items-center justify-center gap-2 ${
                name.trim()
                  ? 'bg-cyan-500 hover:bg-cyan-400 text-white'
                  : 'bg-slate-700 text-slate-400 cursor-not-allowed'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Create
            </button>
          </div>

          {/* Playlists Grid */}
          {pls.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {pls.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectPlaylist(p.id)}
                  className="text-left p-4 rounded-xl bg-slate-800/30 border border-slate-700/30 hover:bg-slate-800/50 hover:border-slate-600/50 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white truncate">{p.name}</div>
                      <div className="text-sm text-slate-400">
                        {new Date(p.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-16 text-slate-400">
              <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
              <p className="text-lg">No playlists yet</p>
              <p className="text-sm mt-1">Create your first playlist above</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
