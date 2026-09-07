'use client';

import { create } from 'zustand';
import { apiFetch } from './apiClient';

export interface UserPreferences {
  auto_continue: boolean;
  prefer_hls: boolean;
}

interface PreferencesState {
  preferences: UserPreferences;
  lastfmEnabled: boolean;
  openrouterConfigured: boolean;
  openrouterSource: 'personal' | 'server' | null;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: (token: string) => Promise<void>;
  update: (token: string, updates: Partial<UserPreferences> & { openrouter_api_key?: string }) => Promise<boolean>;
  reset: () => void;
}

const DEFAULT_PREFS: UserPreferences = {
  auto_continue: false,
  prefer_hls: false,
};

let sessionGeneration = 0;

export const usePreferences = create<PreferencesState>((set, get) => ({
  preferences: DEFAULT_PREFS,
  lastfmEnabled: false,
  openrouterConfigured: false,
  openrouterSource: null,
  loaded: false,
  loading: false,
  saving: false,
  error: null,

  load: async (token: string) => {
    if (get().loaded || get().loading || get().saving) return;
    const session = sessionGeneration;
    set({ loading: true });
    try {
      const r = await apiFetch('/preferences', { method: 'GET' }, token) as {
        ok: boolean;
        preferences: UserPreferences;
        lastfmEnabled?: boolean;
        openrouterConfigured?: boolean;
        openrouterSource?: 'personal' | 'server' | null;
      };
      if (session !== sessionGeneration) return;
      if (r.ok && r.preferences) {
        set({
          preferences: r.preferences,
          lastfmEnabled: !!r.lastfmEnabled,
          openrouterConfigured: !!r.openrouterConfigured,
          openrouterSource: r.openrouterSource ?? null,
          loaded: true,
        });
      }
    } catch {
      // Keep defaults
    } finally {
      if (session === sessionGeneration) set({ loading: false });
    }
  },

  update: async (token: string, updates: Partial<UserPreferences> & { openrouter_api_key?: string }) => {
    if (get().saving || get().loading) return false;
    const session = sessionGeneration;
    const current = get().preferences;
    const { openrouter_api_key, ...prefUpdates } = updates;
    const optimistic = { ...current, ...prefUpdates };
    set({ preferences: optimistic, saving: true, error: null });
    
    try {
      const r = await apiFetch('/preferences', { 
        method: 'PATCH', 
        body: JSON.stringify(updates) 
      }, token) as {
        ok: boolean;
        preferences: UserPreferences;
        openrouterConfigured?: boolean;
        openrouterSource?: 'personal' | 'server' | null;
      };
      
      if (session !== sessionGeneration) return false;
      if (r.ok && r.preferences) {
        set({
          preferences: r.preferences,
          ...(typeof r.openrouterConfigured === 'boolean' ? { openrouterConfigured: r.openrouterConfigured } : {}),
          ...(r.openrouterSource !== undefined ? { openrouterSource: r.openrouterSource } : {}),
        });
        return true;
      }
      throw new Error('Preference save was not accepted');
    } catch {
      if (session === sessionGeneration) set({ preferences: current, error: 'Could not save preferences. Please try again.' });
      return false;
    } finally {
      if (session === sessionGeneration) set({ saving: false });
    }
  },

  reset: () => {
    ++sessionGeneration;
    set({
      preferences: DEFAULT_PREFS,
      lastfmEnabled: false,
      openrouterConfigured: false,
      openrouterSource: null,
      loaded: false,
      loading: false,
      saving: false,
      error: null,
    });
  },
}));
