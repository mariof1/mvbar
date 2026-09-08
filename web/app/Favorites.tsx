'use client';

import { useEffect, useState, useRef } from 'react';
import { listFavorites, removeFavorite, moveFavorite } from './apiClient';
import { FavoriteDragHandle } from './FavoriteDragHandle';
import { useFavorites } from './favoritesStore';
import { useAuth } from './store';
import { useLibraryUpdates } from './useWebSocket';
import { useToastStore } from './Toast';
import { AddMenu } from './AddMenu';
import { trackArtistLabel } from './artistDisplay';

export function Favorites(props: {
  onPlay?: (t: { id: number; title: string | null; artist: string | null }) => void;
  onAddToQueue?: (t: { id: number; title: string | null; artist: string | null }) => void;
}) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const [tracks, setTracks] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const removeFromSet = useFavorites((s) => s.removeFromSet);
  const showToast = useToastStore((s) => s.show);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  const pendingRemovals = useRef(new Set<number>());
  const pages = useRef(1);
  const requestId = useRef(0);
  const loadingRef = useRef(false);
  const lastChange = useFavorites((s) => s.lastChange);
  const lastLibraryUpdate = useLibraryUpdates((s) => s.lastUpdate);
  const lastRefreshRef = useRef<number>(0);
  const previousChange = useRef(lastChange);
  const [savingOrder, setSavingOrder] = useState(false);
  const reorderBusy = useRef(false);
  const orderDraft = useRef<any[] | null>(null);
  const orderOriginal = useRef<any[] | null>(null);

  function hoverTrack(id: number, target: number, after: boolean) {
    if (id === target || reorderBusy.current) return;
    const current = orderDraft.current ?? tracks;
    const from = current.findIndex(t => t.id === id);
    if (from < 0 || !current.some(t => t.id === target)) return;
    const next = [...current];
    const [track] = next.splice(from, 1);
    next.splice(next.findIndex(t => t.id === target) + (after ? 1 : 0), 0, track);
    if (next.every((t, i) => t.id === current[i].id)) return;
    orderOriginal.current ??= tracks;
    orderDraft.current = next;
    setTracks(next);
  }

  function cancelOrder() {
    if (orderOriginal.current) setTracks(orderOriginal.current);
    orderOriginal.current = orderDraft.current = null;
  }

  async function saveOrder(id: number) {
    const next = orderDraft.current;
    if (!next || !token || reorderBusy.current) return;
    reorderBusy.current = true;
    setSavingOrder(true);
    ++requestId.current;
    try {
      const index = next.findIndex(t => t.id === id);
      let before = next[index + 1]?.id ?? null;
      if (before === null && hasMore) before = (await listFavorites(token, 1, next.length)).tracks[0]?.id ?? null;
      await moveFavorite(token, id, before);
    } catch (e: any) {
      if (e?.status === 401) clear();
      showToast('Could not save favorites order. Please try again.', 'error');
      if (orderOriginal.current) setTracks(orderOriginal.current);
    } finally {
      orderOriginal.current = orderDraft.current = null;
      reorderBusy.current = false;
      setSavingOrder(false);
      await refresh();
    }
  }

  async function refresh(pageCount = pages.current) {
    if (!token || reorderBusy.current || orderDraft.current) return;
    const request = ++requestId.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const next: any[] = [];
      let more = false;
      let loadedPages = 0;
      for (let page = 0; page < pageCount; page++) {
        const result = await listFavorites(token, 200, page * 200);
        if (request !== requestId.current) return;
        next.push(...result.tracks);
        loadedPages++;
        more = result.tracks.length === 200;
        if (!more) break;
      }
      pages.current = loadedPages;
      if (!orderDraft.current) setTracks(Array.from(new Map(next.map(track => [track.id, track])).values()));
      setHasMore(more);
    } catch (e: any) {
      if (request !== requestId.current) return;
      if (e?.status === 401) clear();
      setError('Could not load favorites. Please try again.');
    } finally {
      if (request === requestId.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }

  useEffect(() => () => { requestId.current++; }, []);

  useEffect(() => {
    // Throttle library updates to once per 2 seconds during scans
    const favoriteChanged = previousChange.current !== lastChange;
    previousChange.current = lastChange;
    if (lastLibraryUpdate && !favoriteChanged) {
      const now = Date.now();
      if (now - lastRefreshRef.current < 2000) return;
      lastRefreshRef.current = now;
    }
    
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, lastChange, lastLibraryUpdate]);

  if (!token) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-pink-500 to-rose-600 rounded-xl flex items-center justify-center shadow-lg shadow-pink-500/20">
            <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Favorites</h2>
            <p className="text-sm text-slate-400">{tracks.length} liked songs{hasMore ? " loaded" : ""}</p>
            <p className="text-xs text-slate-400" role="status">{savingOrder ? 'Saving order…' : 'Hold the grip and drag to reorder'}</p>
          </div>
        </div>
        <button
          onClick={() => refresh()}
          className="p-2 hover:bg-slate-800/50 rounded-lg transition-colors text-slate-400 hover:text-white"
          title="Refresh"
          disabled={loading}
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
      <div className="space-y-1" data-favorites-list>
        {tracks.map((t, idx) => (
          <div
            key={t.id}
            data-favorite-id={t.id}
            className="group flex items-center gap-2 sm:gap-4 p-2 sm:p-3 rounded-xl hover:bg-slate-800/50 transition-colors"
          >
            <FavoriteDragHandle label={t.title ?? t.path} disabled={savingOrder || loading || removing.size > 0}
              onHover={(target, after) => hoverTrack(t.id, target, after)}
              onDrop={() => void saveOrder(t.id)} onCancel={cancelOrder}
              onStep={direction => {
                const target = tracks[idx + direction];
                if (target) { hoverTrack(t.id, target.id, direction === 1); void saveOrder(t.id); }
              }} />
            <button
              type="button"
              onClick={() => props.onPlay?.({ id: t.id, title: t.title, artist: trackArtistLabel(t) })}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/70 sm:gap-4"
              aria-label={`Play ${t.title ?? t.path}`}
            >
              {/* Track Number */}
              <div className="w-6 flex-shrink-0 text-center sm:w-8">
                <span className="text-xs text-slate-500 sm:text-sm">{idx + 1}</span>
              </div>

              {/* Track Info */}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white sm:text-base">{t.title ?? t.path}</div>
                <div className="truncate text-xs text-slate-400 sm:text-sm">
                  {[trackArtistLabel(t), t.album].filter(Boolean).join(' • ')}
                </div>
              </div>
            </button>

            {/* Actions - always show remove button on mobile */}
            <div className="flex items-center gap-1">
              <div className="block sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                <AddMenu
                  label="track"
                  title="Add to..."
                  getTracks={() => [{ id: t.id, title: t.title, artist: trackArtistLabel(t), album: t.album }]}
                />
              </div>
              <button
                disabled={savingOrder || removing.has(t.id)}
                aria-label={`Remove ${t.title ?? t.path} from favorites`}
                onClick={async () => {
                  if (pendingRemovals.current.has(t.id)) return;
                  pendingRemovals.current.add(t.id);
                  setRemoving(new Set(pendingRemovals.current));
                  setError(null);
                  try {
                    await removeFavorite(token, t.id);
                    removeFromSet(t.id);
                  } catch (e: any) {
                    if (e?.status === 401) clear();
                    const message = 'Could not remove this song from favorites. Please try again.';
                    setError(message);
                    showToast(message, 'error');
                  } finally {
                    pendingRemovals.current.delete(t.id);
                    setRemoving(new Set(pendingRemovals.current));
                  }
                }}
                className="p-1.5 sm:p-2 hover:bg-slate-700/50 rounded-lg transition-colors text-pink-500"
                title="Remove from favorites"
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {loading && <p role="status" className="py-4 text-center text-slate-400">Loading favorites...</p>}
        {hasMore && <button type="button" disabled={loading} onClick={() => {
          if (!loadingRef.current) void refresh(pages.current + 1);
        }} className="w-full rounded-xl bg-slate-800 p-3 text-cyan-400 disabled:opacity-50">Load more favorites</button>}
        {tracks.length === 0 && !loading && !error && (
          <div className="text-center py-16 text-slate-400">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            <p className="text-lg">No favorites yet</p>
            <p className="text-sm mt-1">Like songs to add them here</p>
          </div>
        )}
      </div>
    </div>
  );
}
