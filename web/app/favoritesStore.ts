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
    const r = await listFavorites(token, 500, 0);
    set({ ids: new Set((r.tracks ?? []).map((t: any) => Number(t.id))), lastChange: Date.now() });
  },
  isFavorite: (trackId: number) => get().ids.has(trackId),
  toggle: async (token: string, trackId: number) => {
    const ids = new Set(get().ids);
    if (ids.has(trackId)) {
      await removeFavorite(token, trackId);
      ids.delete(trackId);
    } else {
      await addFavorite(token, trackId);
      ids.add(trackId);
    }
    set({ ids, lastChange: Date.now() });
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
