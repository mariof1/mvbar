'use client';

import { create } from 'zustand';
import { closePodcastPlayer, closeAudiobookPlayer } from './uiStore';
import { useToastStore } from './Toast';
import {
  currentMusicPlaybackAttempt,
  reportMusicPlaybackFailure,
  startMusicPlayback,
  stopMusicPlayback,
} from './musicAudio';
import { formatArtistValue } from './artistDisplay';

export type QueueTrack = {
  id: number;
  title: string | null;
  artist: string | null;
  album?: string | null;
  art_path?: string | null;
  art_hash?: string | null;
  duration_ms?: number | null;
  recommendation_slate_id?: string;
  recommendation_bucket_key?: string;
  recommendation_position?: number;
};

type PlayerState = {
  queue: QueueTrack[];
  index: number;
  isOpen: boolean;
  setQueueAndPlay: (tracks: QueueTrack[], startIndex: number) => void;
  playTrackNow: (t: QueueTrack) => void;
  playIndex: (idx: number) => void;
  addToQueue: (t: QueueTrack) => void;
  addManyToQueue: (tracks: QueueTrack[]) => void;
  playNext: (t: QueueTrack) => void;
  playNextMany: (tracks: QueueTrack[]) => void;
  removeFromQueue: (idx: number) => void;
  reorderQueue: (fromIdx: number, toIdx: number) => void;
  clearQueue: () => void;
  next: () => void;
  prev: () => void;
  close: () => void;
  reset: () => void;
};

function playImmediately(track: QueueTrack | undefined): void {
  if (!track) return;
  const playPromise = startMusicPlayback(track.id);
  if (!playPromise) return;
  const attempt = currentMusicPlaybackAttempt();

  playPromise.catch((error: unknown) => {
    // A later track selection intentionally aborts the previous play promise.
    if (attempt !== currentMusicPlaybackAttempt()) return;
    reportMusicPlaybackFailure(error);
  });
}

function normalizeQueueTrack(track: QueueTrack): QueueTrack {
  return {
    ...track,
    artist: formatArtistValue(track.artist) ?? 'Unknown Artist',
  };
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  index: 0,
  isOpen: false,
  setQueueAndPlay: (tracks, startIndex) => {
    closePodcastPlayer();
    closeAudiobookPlayer();
    if (tracks.length === 0) {
      stopMusicPlayback(true);
      set({ queue: [], index: 0, isOpen: false });
      return;
    }
    const normalizedTracks = tracks.map(normalizeQueueTrack);
    const idx = Math.max(0, Math.min(startIndex, normalizedTracks.length - 1));
    set({ queue: normalizedTracks, index: idx, isOpen: true });
    playImmediately(normalizedTracks[idx]);
  },
  playTrackNow: (t) => {
    closePodcastPlayer();
    closeAudiobookPlayer();
    const track = normalizeQueueTrack(t);
    set({ queue: [track], index: 0, isOpen: true });
    playImmediately(track);
  },
  playIndex: (idx) => {
    const s = get();
    if (idx >= 0 && idx < s.queue.length) {
      closePodcastPlayer();
      closeAudiobookPlayer();
      set({ index: idx, isOpen: true });
      playImmediately(s.queue[idx]);
    }
  },
  addToQueue: (t) => {
    const s = get();
    const track = normalizeQueueTrack(t);
    const nextQueue = [...s.queue, track];
    set({ queue: nextQueue, isOpen: true });
    if (s.queue.length === 0) {
      closePodcastPlayer();
      closeAudiobookPlayer();
      playImmediately(track);
    }
    useToastStore.getState().show(
      `Added "${t.title || 'Track'}" to queue`,
      'queue'
    );
  },
  addManyToQueue: (tracks) => {
    if (tracks.length === 0) return;
    const s = get();
    const normalizedTracks = tracks.map(normalizeQueueTrack);
    const nextQueue = [...s.queue, ...normalizedTracks];
    set({ queue: nextQueue, isOpen: true });
    if (s.queue.length === 0) {
      closePodcastPlayer();
      closeAudiobookPlayer();
      playImmediately(normalizedTracks[0]);
    }
    useToastStore.getState().show(
      `Added ${tracks.length} track${tracks.length === 1 ? '' : 's'} to queue`,
      'queue'
    );
  },
  playNext: (t) => {
    const s = get();
    const track = normalizeQueueTrack(t);
    if (s.queue.length === 0) {
      closePodcastPlayer();
      closeAudiobookPlayer();
      set({ queue: [track], index: 0, isOpen: true });
      playImmediately(track);
    } else {
      const insertAt = s.index + 1;
      const newQueue = [...s.queue.slice(0, insertAt), track, ...s.queue.slice(insertAt)];
      set({ queue: newQueue, isOpen: true });
    }
    useToastStore.getState().show(
      `"${t.title || 'Track'}" will play next`,
      'queue'
    );
  },
  playNextMany: (tracks) => {
    if (tracks.length === 0) return;
    const s = get();
    const normalizedTracks = tracks.map(normalizeQueueTrack);
    if (s.queue.length === 0) {
      closePodcastPlayer();
      closeAudiobookPlayer();
      set({ queue: normalizedTracks, index: 0, isOpen: true });
      playImmediately(normalizedTracks[0]);
    } else {
      const insertAt = s.index + 1;
      const newQueue = [...s.queue.slice(0, insertAt), ...normalizedTracks, ...s.queue.slice(insertAt)];
      set({ queue: newQueue, isOpen: true });
    }
    useToastStore.getState().show(
      `${tracks.length} track${tracks.length === 1 ? '' : 's'} will play next`,
      'queue'
    );
  },
  removeFromQueue: (idx) => {
    const s = get();
    if (idx < 0 || idx >= s.queue.length) return;
    const newQueue = s.queue.filter((_, i) => i !== idx);
    let newIndex = s.index;
    if (idx < s.index) {
      newIndex = s.index - 1;
    } else if (idx === s.index && s.index >= newQueue.length) {
      newIndex = Math.max(0, newQueue.length - 1);
    }
    if (newQueue.length === 0) {
      set({ queue: [], index: 0, isOpen: false });
      stopMusicPlayback(true);
    } else {
      set({ queue: newQueue, index: newIndex });
      if (idx === s.index) playImmediately(newQueue[newIndex]);
    }
  },
  reorderQueue: (fromIdx, toIdx) => {
    const s = get();
    if (fromIdx < 0 || fromIdx >= s.queue.length) return;
    if (toIdx < 0 || toIdx >= s.queue.length) return;
    if (fromIdx === toIdx) return;
    
    const newQueue = [...s.queue];
    const [moved] = newQueue.splice(fromIdx, 1);
    newQueue.splice(toIdx, 0, moved);
    
    // Adjust current index if needed
    let newIndex = s.index;
    if (fromIdx === s.index) {
      newIndex = toIdx;
    } else if (fromIdx < s.index && toIdx >= s.index) {
      newIndex = s.index - 1;
    } else if (fromIdx > s.index && toIdx <= s.index) {
      newIndex = s.index + 1;
    }
    
    set({ queue: newQueue, index: newIndex });
  },
  clearQueue: () => {
    const s = get();
    // Keep only the current track
    if (s.queue.length > 0 && s.index < s.queue.length) {
      set({ queue: [s.queue[s.index]], index: 0 });
    }
  },
  next: () => {
    const s = get();
    if (s.index + 1 >= s.queue.length) return;
    set({ index: s.index + 1, isOpen: true });
    playImmediately(s.queue[s.index + 1]);
  },
  prev: () => {
    const s = get();
    if (s.index <= 0) return;
    set({ index: s.index - 1, isOpen: true });
    playImmediately(s.queue[s.index - 1]);
  },
  close: () => {
    stopMusicPlayback(true);
    set({ isOpen: false });
  },
  reset: () => {
    stopMusicPlayback(true);
    set({ queue: [], index: 0, isOpen: false });
  },
}));
