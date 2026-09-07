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

export const useFavorites = create<FavoritesState>((set, get) => ({
  ids: new Set<number>(),
  lastChange: 0,
  refresh: async (token: string) => {
    const ids = new Set<number>();
    for (let offset = 0; ; offset += 200) {
      const result = await listFavorites(token, 200, offset);
      for (const track of result.tracks ?? []) ids.add(Number(track.id));
      if ((result.tracks ?? []).length < 200) break;
    }
    set({ ids, lastChange: Date.now() });
  },
  isFavorite: (trackId: number) => get().ids.has(trackId),
  toggle: async (token: string, trackId: number) => {
    if (get().ids.has(trackId)) {
      await removeFavorite(token, trackId);
      get().removeFromSet(trackId);
    } else {
      await addFavorite(token, trackId);
      get().addToSet(trackId);
    }
  },
  addToSet: (trackId: number) => {
    const ids = new Set(get().ids);
    ids.add(trackId);
    set({ ids, lastChange: Date.now() });
  },
  removeFromSet: (trackId: number) => {
    const ids = new Set(get().ids);
    ids.delete(trackId);
    set({ ids, lastChange: Date.now() });
  },
  clear: () => set({ ids: new Set<number>(), lastChange: 0 })
}));
