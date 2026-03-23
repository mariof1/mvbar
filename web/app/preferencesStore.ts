'use client';

import { create } from 'zustand';
import { apiFetch } from './apiClient';

function applyTheme(theme: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('theme-norton', theme === 'norton');
}

export interface UserPreferences {
  auto_continue: boolean;
  prefer_hls: boolean;
  theme: string;
}

interface PreferencesState {
  preferences: UserPreferences;
  lastfmEnabled: boolean;
  loaded: boolean;
  loading: boolean;
  load: (token: string) => Promise<void>;
  update: (token: string, updates: Partial<UserPreferences>) => Promise<void>;
  reset: () => void;
}

const DEFAULT_PREFS: UserPreferences = {
  auto_continue: false,
  prefer_hls: false,
  theme: 'default',
};

export const usePreferences = create<PreferencesState>((set, get) => ({
  preferences: DEFAULT_PREFS,
  lastfmEnabled: false,
  loaded: false,
  loading: false,

  load: async (token: string) => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const r = await apiFetch('/preferences', { method: 'GET' }, token) as { ok: boolean; preferences: UserPreferences; lastfmEnabled?: boolean };
      if (r.ok && r.preferences) {
        set({ preferences: r.preferences, lastfmEnabled: !!r.lastfmEnabled, loaded: true });
        applyTheme(r.preferences.theme);
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
    if (updates.theme) applyTheme(updates.theme);
    
    try {
      const r = await apiFetch('/preferences', { 
        method: 'PATCH', 
        body: JSON.stringify(updates) 
      }, token) as { ok: boolean; preferences: UserPreferences };
      
      if (r.ok && r.preferences) {
        set({ preferences: r.preferences });
        applyTheme(r.preferences.theme);
      }
    } catch {
      // Revert on error
      set({ preferences: current });
      applyTheme(current.theme);
    }
  },

  reset: () => {
    set({ preferences: DEFAULT_PREFS, lastfmEnabled: false, loaded: false, loading: false });
    applyTheme('default');
  },
}));
