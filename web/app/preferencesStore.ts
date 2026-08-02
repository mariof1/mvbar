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
  audiomuseConfigured: boolean;
  audiomuseTokenConfigured: boolean;
  audiomuseUrl: string;
  loaded: boolean;
  loading: boolean;
  load: (token: string) => Promise<void>;
  update: (token: string, updates: Partial<UserPreferences> & { audiomuse_url?: string; audiomuse_api_token?: string }) => Promise<boolean>;
  reset: () => void;
}

const DEFAULT_PREFS: UserPreferences = {
  auto_continue: false,
  prefer_hls: false,
};

export const usePreferences = create<PreferencesState>((set, get) => ({
  preferences: DEFAULT_PREFS,
  lastfmEnabled: false,
  audiomuseConfigured: false,
  audiomuseTokenConfigured: false,
  audiomuseUrl: 'http://127.0.0.1:8000',
  loaded: false,
  loading: false,

  load: async (token: string) => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const r = await apiFetch('/preferences', { method: 'GET' }, token) as {
        ok: boolean;
        preferences: UserPreferences;
        lastfmEnabled?: boolean;
        audiomuseConfigured?: boolean;
        audiomuseTokenConfigured?: boolean;
        audiomuseUrl?: string;
      };
      if (r.ok && r.preferences) {
        set({
          preferences: r.preferences,
          lastfmEnabled: !!r.lastfmEnabled,
          audiomuseConfigured: !!r.audiomuseConfigured,
          audiomuseTokenConfigured: !!r.audiomuseTokenConfigured,
          audiomuseUrl: r.audiomuseUrl || 'http://127.0.0.1:8000',
          loaded: true,
        });
      }
    } catch {
      // Keep defaults
    } finally {
      set({ loading: false });
    }
  },

  update: async (token: string, updates: Partial<UserPreferences> & { audiomuse_url?: string; audiomuse_api_token?: string }) => {
    const current = get().preferences;
    const prefUpdates: Partial<UserPreferences> = {};
    if (typeof updates.auto_continue === 'boolean') prefUpdates.auto_continue = updates.auto_continue;
    if (typeof updates.prefer_hls === 'boolean') prefUpdates.prefer_hls = updates.prefer_hls;
    const optimistic = { ...current, ...prefUpdates };
    set({ preferences: optimistic });
    
    try {
      const r = await apiFetch('/preferences', { 
        method: 'PATCH', 
        body: JSON.stringify(updates) 
      }, token) as {
        ok: boolean;
        preferences: UserPreferences;
        audiomuseConfigured?: boolean;
        audiomuseTokenConfigured?: boolean;
        audiomuseUrl?: string;
      };
      
      if (r.ok && r.preferences) {
        set({
          preferences: r.preferences,
          ...(typeof r.audiomuseConfigured === 'boolean' ? { audiomuseConfigured: r.audiomuseConfigured } : {}),
          ...(typeof r.audiomuseTokenConfigured === 'boolean' ? { audiomuseTokenConfigured: r.audiomuseTokenConfigured } : {}),
          ...(typeof r.audiomuseUrl === 'string' ? { audiomuseUrl: r.audiomuseUrl } : {}),
        });
        return true;
      }
      return false;
    } catch {
      set({ preferences: current });
      return false;
    }
  },

  reset: () => set({
    preferences: DEFAULT_PREFS,
    lastfmEnabled: false,
    audiomuseConfigured: false,
    audiomuseTokenConfigured: false,
    audiomuseUrl: 'http://127.0.0.1:8000',
    loaded: false,
    loading: false,
  }),
}));
