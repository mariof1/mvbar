'use client';

import { create } from 'zustand';
import { apiFetch } from './apiClient';

export interface UserPreferences {
  auto_continue: boolean;
  prefer_hls: boolean;
}

interface PreferencesState {
  preferences: UserPreferences;
  loaded: boolean;
  loading: boolean;
  load: (token: string) => Promise<void>;
  update: (token: string, updates: Partial<UserPreferences>) => Promise<void>;
  reset: () => void;
}

const DEFAULT_PREFS: UserPreferences = {
  auto_continue: false,
  prefer_hls: false,
};

export const usePreferences = create<PreferencesState>((set, get) => ({
  preferences: DEFAULT_PREFS,
  loaded: false,
  loading: false,

  load: async (token: string) => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const r = await apiFetch('/preferences', { method: 'GET' }, token) as { ok: boolean; preferences: UserPreferences };
      if (r.ok && r.preferences) {
        set({ preferences: r.preferences, loaded: true });
      }
    } catch {
      // Keep defaults
    } finally {
      set({ loading: false });
    }
  },

  update: async (token: string, updates: Partial<UserPreferences>) => {
    const current = get().preferences;
    const optimistic = { ...current, ...updates };
    set({ preferences: optimistic });
    
    try {
      const r = await apiFetch('/preferences', { 
        method: 'PATCH', 
        body: JSON.stringify(updates) 
      }, token) as { ok: boolean; preferences: UserPreferences };
      
      if (r.ok && r.preferences) {
        set({ preferences: r.preferences });
      }
    } catch {
      // Revert on error
      set({ preferences: current });
    }
  },

  reset: () => set({ preferences: DEFAULT_PREFS, loaded: false, loading: false }),
}));
