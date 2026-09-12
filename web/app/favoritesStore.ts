'use client';

import { create } from 'zustand';
import { addFavorite, listFavorites, removeFavorite, type FavoriteMutationResponse } from './apiClient';
import { useToastStore } from './Toast';

type FavoritesState = {
  ids: Set<number>;
  lastChange: number;
  refresh: (token: string) => Promise<void>;
  isFavorite: (trackId: number) => boolean;
  toggle: (token: string, trackId: number) => Promise<void>;
  addToSet: (trackId: number) => void;
  addManyToSet: (trackIds: number[]) => void;
  removeFromSet: (trackId: number) => void;
  clear: () => void;
};

// Merge live changes over the latest server snapshot, including removals of
// IDs not yet loaded. Older refreshes and cleared sessions cannot restore state.
let refreshGeneration = 0;
let sessionGeneration = 0;
const changesDuringRefresh = new Map<number, boolean>();

function reportLastfmFailure(result: FavoriteMutationResponse) {
  const reason = result.lastfm?.reason;
  if (!result.lastfm || result.lastfm.submitted || reason === 'not_connected') return;
  const message = reason === 'session_expired'
    ? 'Favourite saved in mvbar, but your Last.fm connection expired. Reconnect it in Settings.'
    : reason === 'missing_metadata'
      ? 'Favourite saved in mvbar, but Last.fm needs both a song title and artist.'
      : 'Favourite saved in mvbar, but Last.fm could not be updated. Please try again.';
  useToastStore.getState().show(message, 'error', 'top-right');
}

export const useFavorites = create<FavoritesState>((set, get) => ({
  ids: new Set<number>(),
  lastChange: 0,
  refresh: async (token: string) => {
    const request = ++refreshGeneration;
    changesDuringRefresh.clear();
    const ids = new Set<number>();
    for (let offset = 0; ; offset += 200) {
      const result = await listFavorites(token, 200, offset);
      if (request !== refreshGeneration) return;
      for (const track of result.tracks ?? []) ids.add(Number(track.id));
      if ((result.tracks ?? []).length < 200) break;
    }
    for (const [id, favorite] of changesDuringRefresh) {
      if (favorite) ids.add(id);
      else ids.delete(id);
    }
    changesDuringRefresh.clear();
    set({ ids, lastChange: Date.now() });
  },
  isFavorite: (trackId: number) => get().ids.has(trackId),
  toggle: async (token: string, trackId: number) => {
    const session = sessionGeneration;
    if (get().ids.has(trackId)) {
      const result = await removeFavorite(token, trackId);
      reportLastfmFailure(result);
      if (session === sessionGeneration) get().removeFromSet(trackId);
    } else {
      const result = await addFavorite(token, trackId);
      reportLastfmFailure(result);
      if (session === sessionGeneration) get().addToSet(trackId);
    }
  },
  addToSet: (trackId: number) => {
    changesDuringRefresh.set(trackId, true);
    const ids = new Set(get().ids);
    ids.add(trackId);
    set({ ids, lastChange: Date.now() });
  },
  addManyToSet: (trackIds: number[]) => {
    const ids = new Set(get().ids);
    for (const trackId of trackIds) {
      if (!Number.isSafeInteger(trackId) || trackId <= 0) continue;
      changesDuringRefresh.set(trackId, true);
      ids.add(trackId);
    }
    set({ ids, lastChange: Date.now() });
  },
  removeFromSet: (trackId: number) => {
    changesDuringRefresh.set(trackId, false);
    const ids = new Set(get().ids);
    ids.delete(trackId);
    set({ ids, lastChange: Date.now() });
  },
  clear: () => {
    ++refreshGeneration;
    ++sessionGeneration;
    changesDuringRefresh.clear();
    set({ ids: new Set<number>(), lastChange: 0 });
  }
}));
