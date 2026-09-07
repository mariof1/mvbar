'use client';

import { create } from 'zustand';
import { usePreferences } from './preferencesStore';

type User = { id: string; email: string; role: string; avatar_path?: string | null };

type AuthState = {
  token: string | null;
  user: User | null;
  setAuth: (user: User) => void;
  updateAvatar: (avatar_path: string | null) => void;
  clear: () => void;
};

export const useAuth = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  setAuth: (user) => {
    if (get().user?.id !== user.id) usePreferences.getState().reset();
    set({ token: 'cookie', user });
  },
  updateAvatar: (avatar_path) => {
    set((state) => state.user ? { user: { ...state.user, avatar_path } } : {});
  },
  clear: () => {
    usePreferences.getState().reset();
    set({ token: null, user: null });
  }
}));
