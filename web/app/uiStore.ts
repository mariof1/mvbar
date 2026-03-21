'use client';

import { create } from 'zustand';

/**
 * UI Store - manages UI state that is NOT navigation
 * Navigation is handled by router.ts
 * 
 * This store manages:
 * - Podcast episode playback (persists across navigation)
 * - Audiobook chapter playback (persists across navigation)
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

// Audiobook chapter type for the global player
export interface AudiobookChapter {
  id: number;
  audiobook_id: number;
  title: string;
  duration_ms: number | null;
  position_ms: number;
  audiobook_title: string;
  audiobook_cover_path: string | null;
  author: string | null;
}

type UiState = {
  // Podcast player state (persists across navigation)
  podcastEpisode: PodcastEpisode | null;
  setPodcastEpisode: (episode: PodcastEpisode | null) => void;
  closePodcastPlayer: () => void;
  // Audiobook player state (persists across navigation)
  audiobookChapter: AudiobookChapter | null;
  setAudiobookChapter: (chapter: AudiobookChapter | null) => void;
  closeAudiobookPlayer: () => void;
};

export const useUi = create<UiState>((set) => ({
  podcastEpisode: null,
  setPodcastEpisode: (episode) => {
    // Close music player and audiobook player when starting podcast
    if (episode) {
      import('./playerStore').then(({ usePlayer }) => {
        usePlayer.getState().close();
      });
      set({ audiobookChapter: null });
    }
    set({ podcastEpisode: episode });
  },
  closePodcastPlayer: () => set({ podcastEpisode: null }),
  audiobookChapter: null,
  setAudiobookChapter: (chapter) => {
    // Close music player and podcast player when starting audiobook
    if (chapter) {
      import('./playerStore').then(({ usePlayer }) => {
        usePlayer.getState().close();
      });
      set({ podcastEpisode: null });
    }
    set({ audiobookChapter: chapter });
  },
  closeAudiobookPlayer: () => set({ audiobookChapter: null }),
}));

// Helper to close podcast when music starts (called from playerStore)
export function closePodcastPlayer() {
  useUi.setState({ podcastEpisode: null });
}

// Helper to close audiobook when music starts (called from playerStore)
export function closeAudiobookPlayer() {
  useUi.setState({ audiobookChapter: null });
}
