'use client';

import { create } from 'zustand';

/**
 * UI Store - manages UI state that is NOT navigation
 * Navigation is handled by router.ts
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

type UiState = {
  // Podcast player state (persists across navigation)
  podcastEpisode: PodcastEpisode | null;
  setPodcastEpisode: (episode: PodcastEpisode | null) => void;
  closePodcastPlayer: () => void;
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
}));

// Helper to close podcast when music starts (called from playerStore)
export function closePodcastPlayer() {
  useUi.setState({ podcastEpisode: null });
}
