'use client';

import { create } from 'zustand';
import { closePodcastPlayer } from './uiStore';

export type QueueTrack = { id: number; title: string | null; artist: string | null; album?: string | null };

type PlayerState = {
  queue: QueueTrack[];
  index: number;
  isOpen: boolean;
  setQueueAndPlay: (tracks: QueueTrack[], startIndex: number) => void;
  playTrackNow: (t: QueueTrack) => void;
  playIndex: (idx: number) => void;
  addToQueue: (t: QueueTrack) => void;
  removeFromQueue: (idx: number) => void;
  reorderQueue: (fromIdx: number, toIdx: number) => void;
  clearQueue: () => void;
  next: () => void;
  prev: () => void;
  close: () => void;
  reset: () => void;
};

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  index: 0,
  isOpen: false,
  setQueueAndPlay: (tracks, startIndex) => {
    closePodcastPlayer(); // Close podcast when music starts
    const idx = Math.max(0, Math.min(startIndex, tracks.length - 1));
    set({ queue: tracks, index: idx, isOpen: tracks.length > 0 });
  },
  playTrackNow: (t) => {
    closePodcastPlayer(); // Close podcast when music starts
    set({ queue: [t], index: 0, isOpen: true });
  },
  playIndex: (idx) => {
    const s = get();
    if (idx >= 0 && idx < s.queue.length) {
      closePodcastPlayer(); // Close podcast when music starts
      set({ index: idx, isOpen: true });
    }
  },
  addToQueue: (t) => {
    const s = get();
    const nextQueue = [...s.queue, t];
    set({ queue: nextQueue, isOpen: true });
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
    } else {
      set({ queue: newQueue, index: newIndex });
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
  },
  prev: () => {
    const s = get();
    if (s.index <= 0) return;
    set({ index: s.index - 1, isOpen: true });
  },
  close: () => set({ isOpen: false }),
  reset: () => set({ queue: [], index: 0, isOpen: false }),
}));
