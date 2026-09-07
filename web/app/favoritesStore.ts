'use client';

import { create } from 'zustand';
import { addFavorite, listFavorites, removeFavorite } from './apiClient';

type FavoritesState = {
  ids: Set<number>;
  lastChange: number;
  refresh: (token: string) => Promise<void>;
  isFavorite: (trackId: number) => boolean;
  toggle: (token: string, trackId: number) => Promise<void>;
  addToSet: (trackId: number) => void;
  removeFromSet: (trackId: number) => void;
  clear: () => void;
};

// Merge live changes over the latest server snapshot, including removals of
// IDs not yet loaded. Older refreshes and cleared sessions cannot restore state.
let refreshGeneration = 0;
let sessionGeneration = 0;
const changesDuringRefresh = new Map<number, boolean>();

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
      await removeFavorite(token, trackId);
      if (session === sessionGeneration) get().removeFromSet(trackId);
    } else {
      await addFavorite(token, trackId);
      if (session === sessionGeneration) get().addToSet(trackId);
    }
  },
  addToSet: (trackId: number) => {
    changesDuringRefresh.set(trackId, true);
    const ids = new Set(get().ids);
    ids.add(trackId);
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
