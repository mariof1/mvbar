'use client';

import { create } from 'zustand';

/**
 * UI Store - manages UI state that is NOT navigation
 * Navigation is now handled by router.ts
 * 
 * This store manages:
 * - Podcast episode playback (persists across navigation)
 * - UI preferences
 */

// Podcast episode type for the global player
export interface PodcastEpisode {
  id: number;
  podcast_id: number;
  title: string;
  description: string | null;
  audio_url: string;
  duration_ms: number | null;
  image_url: string | null;
  image_path?: string | null;
  published_at: string | null;
  position_ms: number;
  played: boolean;
  podcast_title?: string;
  podcast_image_url?: string | null;
  podcast_image_path?: string | null;
}

// Legacy NavState type for backward compatibility
export interface NavState {
  browseTab?: 'artists' | 'albums' | 'genres' | 'countries' | 'languages';
  browseArtist?: { id: number; name: string };
  browseAlbum?: { artist: string; album: string; artistId?: number };
  browseGenre?: string;
  browseCountry?: string;
  browseLanguage?: string;
  playlistTab?: 'regular' | 'smart';
  playlistId?: string;
  podcastView?: 'subscriptions' | 'new';
  podcastId?: number;
}

export type Tab = 'for-you' | 'search' | 'library' | 'browse' | 'playlists' | 'favorites' | 'history' | 'podcasts' | 'settings' | 'admin';

type UiState = {
  // Podcast player state (persists across navigation - never closes unless explicit)
  podcastEpisode: PodcastEpisode | null;
  setPodcastEpisode: (episode: PodcastEpisode | null) => void;
  closePodcastPlayer: () => void;
  
  // Legacy navigation stubs (for AppShell.tsx compatibility - not used in main app)
  tab: Tab;
  setTab: (tab: Tab) => void;
  nav: NavState;
  pushNav: (patch: Partial<NavState>) => void;
  clearNav: () => void;
};

export const useUi = create<UiState>((set) => ({
  podcastEpisode: null,
  setPodcastEpisode: (episode) => {
    // Close music player when starting podcast (import dynamically to avoid circular deps)
    if (episode) {
      import('./playerStore').then(({ usePlayer }) => {
        usePlayer.getState().close();
      });
    }
    set({ podcastEpisode: episode });
  },
  closePodcastPlayer: () => set({ podcastEpisode: null }),
  
  // Legacy stubs - navigation is now handled by router.ts
  tab: 'search',
  setTab: () => {},
  nav: {},
  pushNav: () => {},
  clearNav: () => {},
}));

// Helper to close podcast when music starts (called from playerStore)
export function closePodcastPlayer() {
  useUi.setState({ podcastEpisode: null });
}

// Legacy init function - now handled by router.ts
export function initUiFromStorage() {
  // No-op - navigation is now handled by router.ts
}

